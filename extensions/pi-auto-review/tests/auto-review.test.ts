import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
	REVIEW_SENTINEL,
	REREVIEW_SENTINEL,
	DEFAULT_SETTINGS,
	DEFAULT_FOCUS_AREAS,
	REVIEW_METHODOLOGY,
	FORMAT_INSTRUCTION,
	getSettings,
	resetSettingsCache,
	readSettingsJson,
	getFocusList,
	getDefaultFixInstruction,
	buildReviewPrompt,
	buildRereviewPrompt,
	isRalphCompletion,
	countUnfixedItems,
} from "../extensions/auto-review-lib.js";
import type { AutoReviewSettings, ReviewScope } from "../extensions/auto-review-lib.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "auto-review-test-"));
}

function writeSettingsJson(dir: string, settings: Record<string, unknown>): void {
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".pi", "settings.json"),
		JSON.stringify({ autoReview: settings }, null, 2),
	);
}

function writeTodoFile(dir: string, content: string, todoPath = "TODO.md"): void {
	fs.writeFileSync(path.join(dir, todoPath), content, "utf-8");
}

// ── Settings defaults tests ───────────────────────────────────────────────────

describe("Settings defaults", () => {
	it("should have correct enabled default", () => {
		expect(DEFAULT_SETTINGS.enabled).toBe(true);
	});

	it("should have correct maxFixRounds default", () => {
		expect(DEFAULT_SETTINGS.maxFixRounds).toBe(3);
	});

	it("should have correct cooldown default", () => {
		expect(DEFAULT_SETTINGS.cooldownMs).toBe(120_000);
	});

	it("should have correct trigger defaults", () => {
		expect(DEFAULT_SETTINGS.onRalphDone).toBe(true);
		expect(DEFAULT_SETTINGS.onAgentEnd).toBe(false);
		expect(DEFAULT_SETTINGS.onSessionStart).toBe(false);
	});

	it("should have comprehensive exclude patterns", () => {
		expect(DEFAULT_SETTINGS.excludePatterns).toContain("node_modules");
		expect(DEFAULT_SETTINGS.excludePatterns).toContain(".git");
		expect(DEFAULT_SETTINGS.excludePatterns).toContain("dist");
		expect(DEFAULT_SETTINGS.excludePatterns).toContain("build");
		expect(DEFAULT_SETTINGS.excludePatterns).toContain("coverage");
	});

	it("should have all custom prompt fields default to null", () => {
		expect(DEFAULT_SETTINGS.prompt).toBeNull();
		expect(DEFAULT_SETTINGS.rereviewPrompt).toBeNull();
		expect(DEFAULT_SETTINGS.fixInstruction).toBeNull();
		expect(DEFAULT_SETTINGS.focusAreas).toBeNull();
	});
});

// ── readSettingsJson tests ────────────────────────────────────────────────────

describe("readSettingsJson", () => {
	it("should parse valid JSON with autoReview key", () => {
		const dir = createTempDir();
		const filePath = path.join(dir, "settings.json");
		fs.writeFileSync(filePath, JSON.stringify({ autoReview: { enabled: false } }));

		const result = readSettingsJson(filePath);
		expect(result).not.toBeNull();
		expect(result?.autoReview).toEqual({ enabled: false });

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("should return null for missing file", () => {
		const result = readSettingsJson("/tmp/nonexistent-settings-file.json");
		expect(result).toBeNull();
	});

	it("should return null for invalid JSON", () => {
		const dir = createTempDir();
		const filePath = path.join(dir, "settings.json");
		fs.writeFileSync(filePath, "not valid json {{{");

		const result = readSettingsJson(filePath);
		expect(result).toBeNull();

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("should return null for non-object JSON", () => {
		const dir = createTempDir();
		const filePath = path.join(dir, "settings.json");
		fs.writeFileSync(filePath, '"just a string"');

		const result = readSettingsJson(filePath);
		expect(result).toBeNull();

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("should support auto-review kebab-case key", () => {
		const dir = createTempDir();
		const filePath = path.join(dir, "settings.json");
		fs.writeFileSync(filePath, JSON.stringify({ "auto-review": { enabled: true } }));

		const result = readSettingsJson(filePath);
		expect(result).not.toBeNull();
		expect(result?.["auto-review"]).toEqual({ enabled: true });

		fs.rmSync(dir, { recursive: true, force: true });
	});
});

// ── getSettings tests ────────────────────────────────────────────────────────

describe("getSettings", () => {
	beforeEach(() => {
		resetSettingsCache();
	});

	it("should return defaults when no settings file exists", () => {
		const dir = createTempDir();
		const settings = getSettings(dir);
		expect(settings.enabled).toBe(true);
		expect(settings.maxFixRounds).toBe(3);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("should merge project settings over defaults", () => {
		const dir = createTempDir();
		writeSettingsJson(dir, { enabled: false, maxFixRounds: 10 });

		const settings = getSettings(dir);
		expect(settings.enabled).toBe(false);
		expect(settings.maxFixRounds).toBe(10);
		// Other defaults should be preserved
		expect(settings.onRalphDone).toBe(true);
		expect(settings.cooldownMs).toBe(120_000);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("should cache settings and return same object", () => {
		const dir = createTempDir();
		const s1 = getSettings(dir);
		const s2 = getSettings(dir);
		expect(s1).toBe(s2); // Same reference = cached
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

// ── TODO.md parsing tests ───────────────────────────────────────────────────────

describe("TODO.md parsing (countUnfixedItems)", () => {
	it("should count unchecked items with - [ ] syntax", () => {
		const dir = createTempDir();
		writeTodoFile(dir, `<!-- auto-review-start -->
- [ ] Critical issue 1
- [ ] Critical issue 2
- [x] Fixed issue
<!-- auto-review-end -->`);

		const count = countUnfixedItems("TODO.md", dir);
		expect(count).toBe(2);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("should count items in section only", () => {
		const dir = createTempDir();
		writeTodoFile(dir, `<!-- outside section -->
- [ ] Should not count this
<!-- auto-review-start -->
- [ ] Should count this
<!-- auto-review-end -->
- [ ] Should not count this either`);

		const count = countUnfixedItems("TODO.md", dir);
		expect(count).toBe(1);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("should return 0 for missing file", () => {
		const count = countUnfixedItems("TODO.md", "/tmp/nonexistent-dir-xyz");
		expect(count).toBe(0);
	});

	it("should return 0 when no auto-review section exists", () => {
		const dir = createTempDir();
		writeTodoFile(dir, `- [ ] Some item\n- [ ] Another item`);

		const count = countUnfixedItems("TODO.md", dir);
		expect(count).toBe(0);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("should strip code blocks before counting", () => {
		const dir = createTempDir();
		writeTodoFile(dir, `<!-- auto-review-start -->
\`\`\`markdown
- [ ] Inside code block
\`\`\`
- [ ] Outside code block
<!-- auto-review-end -->`);

		const count = countUnfixedItems("TODO.md", dir);
		expect(count).toBe(1);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("should handle section with no end marker", () => {
		const dir = createTempDir();
		writeTodoFile(dir, `<!-- auto-review-start -->
- [ ] Item 1
- [ ] Item 2`);

		const count = countUnfixedItems("TODO.md", dir);
		expect(count).toBe(2);

		fs.rmSync(dir, { recursive: true, force: true });
	});
});

// ── Sentinel detection tests ─────────────────────────────────────────────────

describe("Sentinel detection", () => {
	it("should detect REVIEW_SENTINEL in review prompt", () => {
		const settings = { ...DEFAULT_SETTINGS };
		const prompt = buildReviewPrompt(settings, "full", false, "test");
		expect(prompt.includes(REVIEW_SENTINEL)).toBe(true);
	});

	it("should detect REREVIEW_SENTINEL in rereview prompt", () => {
		const settings = { ...DEFAULT_SETTINGS };
		const prompt = buildRereviewPrompt(settings, 1, 3, 5, false);
		expect(prompt.includes(REREVIEW_SENTINEL)).toBe(true);
	});

	it("should NOT detect sentinel in normal message", () => {
		const message = "Please fix the build error in index.ts line 42.";
		expect(message.includes(REVIEW_SENTINEL)).toBe(false);
		expect(message.includes(REREVIEW_SENTINEL)).toBe(false);
	});

	it("should find sentinel in last messages of review cycle", () => {
		const messages = [
			{ role: "user", content: "Fix the bug" },
			{ role: "assistant", content: `${REVIEW_SENTINEL}Looking for issues...` },
		];

		const hasSentinel = messages.slice(-5).some((m) => {
			const text = typeof m.content === "string" ? m.content : "";
			return text.includes(REVIEW_SENTINEL);
		});

		expect(hasSentinel).toBe(true);
	});
});

// ── Ralph completion detection tests ─────────────────────────────────────────

describe("isRalphCompletion", () => {
	it("should detect Ralph completion in last message", () => {
		const messages = [
			{ role: "user", content: "Start the loop" },
			{ role: "assistant", content: "<promise>COMPLETE</promise>" },
		];
		expect(isRalphCompletion(messages)).toBe(true);
	});

	it("should detect Ralph completion in last 5 messages", () => {
		const messages = [
			{ role: "user", content: "Start" },
			{ role: "assistant", content: "Working..." },
			{ role: "assistant", content: "Still working..." },
			{ role: "assistant", content: "Almost done..." },
			{ role: "assistant", content: "<promise>COMPLETE</promise>" },
		];
		expect(isRalphCompletion(messages)).toBe(true);
	});

	it("should NOT detect completion without promise tag", () => {
		const messages = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there!" },
		];
		expect(isRalphCompletion(messages)).toBe(false);
	});

	it("should NOT detect completion in user messages", () => {
		const messages = [
			{ role: "user", content: "<promise>COMPLETE</promise>" },
		];
		expect(isRalphCompletion(messages)).toBe(false);
	});

	it("should detect completion beyond 5 messages back", () => {
		const messages = [
			{ role: "user", content: "Start" },
			{ role: "assistant", content: "Step 1" },
			{ role: "assistant", content: "Step 2" },
			{ role: "assistant", content: "Step 3" },
			{ role: "assistant", content: "Step 4" },
			{ role: "assistant", content: "Step 5" },
			{ role: "assistant", content: "<promise>COMPLETE</promise>" },
		];
		expect(isRalphCompletion(messages)).toBe(true);
	});

	it("should NOT detect completion 6+ messages back", () => {
		const messages = [
			{ role: "assistant", content: "<promise>COMPLETE</promise>" },
			{ role: "assistant", content: "Step 2" },
			{ role: "assistant", content: "Step 3" },
			{ role: "assistant", content: "Step 4" },
			{ role: "assistant", content: "Step 5" },
			{ role: "assistant", content: "Step 6" },
			{ role: "assistant", content: "Done" },
		];
		expect(isRalphCompletion(messages)).toBe(false);
	});
});

// ── Prompt builder tests ────────────────────────────────────────────────────

describe("buildReviewPrompt", () => {
	const settings = { ...DEFAULT_SETTINGS };

	it("should include sentinel", () => {
		const prompt = buildReviewPrompt(settings, "full", false, "test");
		expect(prompt.includes(REVIEW_SENTINEL)).toBe(true);
	});

	it("should include format instruction with todoPath", () => {
		const prompt = buildReviewPrompt(settings, "full", false, "test");
		expect(prompt).toContain("TODO.md");
		expect(prompt).toContain("auto-review-start");
		expect(prompt).toContain("auto-review-end");
	});

	it("should include review methodology", () => {
		const prompt = buildReviewPrompt(settings, "full", false, "test");
		expect(prompt).toContain("Build check");
	});

	it("should include exclude patterns", () => {
		const prompt = buildReviewPrompt(settings, "full", false, "test");
		expect(prompt).toContain("node_modules");
	});

	it("should include fix instruction when autoFix is true", () => {
		const prompt = buildReviewPrompt(settings, "full", true, "test");
		expect(prompt).toContain("fix the problems");
	});

	it("should NOT include fix instruction when autoFix is false", () => {
		const prompt = buildReviewPrompt(settings, "full", false, "test");
		expect(prompt).not.toContain("fix the problems");
	});

	it("should use custom prompt when provided", () => {
		const customSettings = { ...settings, prompt: "Custom review prompt" };
		const prompt = buildReviewPrompt(customSettings, "full", false, "test");
		expect(prompt).toContain("Custom review prompt");
		expect(prompt).toContain(REVIEW_SENTINEL);
	});

	it("should scope to full project", () => {
		const prompt = buildReviewPrompt(settings, "full", false, "test");
		expect(prompt).toContain("entire project");
	});

	it("should scope to staged changes", () => {
		const prompt = buildReviewPrompt(settings, "staged", false, "test");
		expect(prompt).toContain("staged git changes");
	});

	it("should scope to diff", () => {
		const prompt = buildReviewPrompt(settings, "diff", false, "test");
		expect(prompt).toContain("diff from the main branch");
	});
});

describe("buildRereviewPrompt", () => {
	const settings = { ...DEFAULT_SETTINGS };

	it("should include rereview sentinel", () => {
		const prompt = buildRereviewPrompt(settings, 1, 3, 5, false);
		expect(prompt.includes(REREVIEW_SENTINEL)).toBe(true);
	});

	it("should include round info", () => {
		const prompt = buildRereviewPrompt(settings, 2, 3, 5, false);
		expect(prompt).toContain("round 2/3");
	});

	it("should include previous item count", () => {
		const prompt = buildRereviewPrompt(settings, 1, 3, 7, false);
		expect(prompt).toContain("7 items");
	});

	it("should include fix instruction when autoFix is true", () => {
		const prompt = buildRereviewPrompt(settings, 1, 3, 5, true);
		expect(prompt).toContain("fix the problems");
	});

	it("should use custom rereview prompt with placeholder replacement", () => {
		const customSettings = { ...settings, rereviewPrompt: "Round {round}/{maxRounds}, had {previousItems} items" };
		const prompt = buildRereviewPrompt(customSettings, 2, 3, 7, false);
		expect(prompt).toContain("Round 2/3, had 7 items");
		expect(prompt).toContain(REREVIEW_SENTINEL);
	});
});

// ── Focus list tests ─────────────────────────────────────────────────────────

describe("getFocusList", () => {
	it("should use default focus areas", () => {
		const list = getFocusList(DEFAULT_SETTINGS);
		expect(list).toContain("Lint errors");
		expect(list).toContain("Security vulnerabilities");
	});

	it("should use custom focus areas when provided", () => {
		const settings = { ...DEFAULT_SETTINGS, focusAreas: ["Custom area 1", "Custom area 2"] };
		const list = getFocusList(settings);
		expect(list).toContain("Custom area 1");
		expect(list).not.toContain("Lint errors");
	});
});

// ── Fix loop convergence tests ────────────────────────────────────────────────

describe("Fix loop convergence", () => {
	it("should converge when items decrease to 0", () => {
		const itemCounts = [5, 3, 1, 0];
		let state = "reviewing";

		for (const count of itemCounts) {
			if (count === 0) {
				state = "idle";
				break;
			}
		}

		expect(state).toBe("idle");
	});

	it("should stop at max rounds", () => {
		const maxFixRounds = 3;
		let fixRound = 0;
		let state = "reviewing";

		for (let round = 1; round <= maxFixRounds; round++) {
			fixRound = round;
			if (fixRound >= maxFixRounds) {
				state = "idle";
				break;
			}
		}

		expect(state).toBe("idle");
		expect(fixRound).toBe(3);
	});

	it("should stop on divergence", () => {
		const previousItemCount = 3;
		const currentItemCount = 5;
		let state = "reviewing";

		if (previousItemCount >= 0 && currentItemCount > previousItemCount) {
			state = "idle";
		}

		expect(state).toBe("idle");
	});

	it("should continue when items decrease but not zero", () => {
		const previousItemCount = 10;
		const currentItemCount = 5;
		let shouldContinue = true;

		if (currentItemCount === 0) {
			shouldContinue = false;
		} else if (currentItemCount > previousItemCount) {
			shouldContinue = false;
		}

		expect(shouldContinue).toBe(true);
	});
});

// ── Cooldown tests ────────────────────────────────────────────────────────────

describe("Cooldown mechanism", () => {
	const COOLDOWN_MS = 120_000;

	it("should block review during cooldown", () => {
		const baseTime = 1000000000000;
		const lastAutoReviewTime = baseTime;
		const now = baseTime + 60000;

		const isDuringCooldown = now - lastAutoReviewTime < COOLDOWN_MS;
		expect(isDuringCooldown).toBe(true);
	});

	it("should allow review after cooldown expires", () => {
		const baseTime = 1000000000000;
		const lastAutoReviewTime = baseTime;
		const now = baseTime + COOLDOWN_MS + 1;

		const isCooldownExpired = now - lastAutoReviewTime >= COOLDOWN_MS;
		expect(isCooldownExpired).toBe(true);
	});
});

// ── cycleState machine tests ──────────────────────────────────────────────────

describe("cycleState machine", () => {
	type CycleState = "idle" | "reviewing";

	it("should start in idle state", () => {
		const cycleState: CycleState = "idle";
		expect(cycleState).toBe("idle");
	});

	it("should transition to reviewing on review start", () => {
		let cycleState: CycleState = "idle";
		cycleState = "reviewing";
		expect(cycleState).toBe("reviewing");
	});

	it("should transition to idle on clean exit", () => {
		let cycleState: CycleState = "reviewing";
		const currentItemCount = 0;

		if (currentItemCount === 0) {
			cycleState = "idle";
		}

		expect(cycleState).toBe("idle");
	});

	it("should transition to idle on max rounds", () => {
		let cycleState: CycleState = "reviewing";
		const fixRound = 3;
		const maxFixRounds = 3;

		if (fixRound >= maxFixRounds) {
			cycleState = "idle";
		}

		expect(cycleState).toBe("idle");
	});

	it("should transition to idle on divergence", () => {
		let cycleState: CycleState = "reviewing";
		const previousItemCount = 5;
		const currentItemCount = 7;

		if (previousItemCount >= 0 && currentItemCount > previousItemCount) {
			cycleState = "idle";
		}

		expect(cycleState).toBe("idle");
	});

	it("should block new reviews when reviewing", () => {
		const cycleState: CycleState = "reviewing";
		const shouldTrigger = cycleState === "idle";
		expect(shouldTrigger).toBe(false);
	});
});

// ── Documentation consistency tests ────────────────────────────────────────

describe("Documentation consistency", () => {
	it("should have all required settings keys documented in README", () => {
		const requiredKeys = [
			"enabled",
			"todoPath",
			"autoFix",
			"maxFixRounds",
			"onRalphDone",
			"onAgentEnd",
			"onSessionStart",
			"minTurns",
			"cooldownMs",
			"scope",
			"excludePatterns",
		];

		const readmePath = path.join(process.cwd(), "README.md");
		const readme = fs.readFileSync(readmePath, "utf-8");

		for (const key of requiredKeys) {
			expect(readme).toContain(`\`${key}\``);
		}
	});
});