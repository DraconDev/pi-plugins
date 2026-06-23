import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { REVIEW_SENTINEL, REREVIEW_SENTINEL, resetSettingsCache } from "../extensions/auto-review-lib.js";

// ── Mock ExtensionAPI setup ────────────────────────────────────────────────

interface CapturedHandler {
	eventName: string;
	handler: (...args: unknown[]) => unknown;
}

function createMockPi() {
	const handlers: CapturedHandler[] = [];
	const sendUserMessage = vi.fn();

	const pi = {
		on: vi.fn((eventName: string, handler: (...args: unknown[]) => unknown) => {
			handlers.push({ eventName, handler });
		}),
		sendUserMessage,
		_handlers: handlers,
	};

	return pi;
}

function getHandler(pi: ReturnType<typeof createMockPi>, eventName: string) {
	const captured = pi._handlers.find((h) => h.eventName === eventName);
	if (!captured) throw new Error(`No handler for event: ${eventName}`);
	return captured.handler;
}

function createMockCtx(overrides: Record<string, unknown> = {}) {
	return {
		cwd: "/tmp/test-project",
		hasUI: false,
		ui: { notify: vi.fn() },
		...overrides,
	};
}

// ── Test helper: write settings ─────────────────────────────────────────────

function writeSettingsJson(dir: string, settings: Record<string, unknown>): void {
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".pi", "settings.json"),
		JSON.stringify({ autoReview: settings }, null, 2),
	);
}

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "auto-review-event-test-"));
}

// ── Load extension (dynamic import) ─────────────────────────────────────────

async function loadExtension(pi: ReturnType<typeof createMockPi>) {
	// We need to call the default export function with our mock pi
	const mod = await import("../extensions/auto-review.js?t=" + Date.now());
	mod.default(pi);
}

// ── Event handler tests ────────────────────────────────────────────────────

describe("Event handlers", () => {
	let pi: ReturnType<typeof createMockPi>;
	let tempDir: string;

	beforeEach(() => {
		pi = createMockPi();
		tempDir = createTempDir();
		resetSettingsCache();
		vi.clearAllMocks();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("should register 4 event handlers", async () => {
		await loadExtension(pi);
		expect(pi.on).toHaveBeenCalledTimes(4);
		const events = pi._handlers.map((h) => h.eventName);
		expect(events).toContain("session_start");
		expect(events).toContain("turn_end");
		expect(events).toContain("agent_end");
		expect(events).toContain("before_agent_start");
	});

	describe("session_start handler", () => {
		it("should NOT trigger review when onSessionStart is false (default)", async () => {
			await loadExtension(pi);
			const handler = getHandler(pi, "session_start");

			handler({}, createMockCtx({ cwd: tempDir }));

			expect(pi.sendUserMessage).not.toHaveBeenCalled();
		});

		it("should trigger review when onSessionStart is true", async () => {
			writeSettingsJson(tempDir, { onSessionStart: true });
			await loadExtension(pi);
			const handler = getHandler(pi, "session_start");

			handler({}, createMockCtx({ cwd: tempDir }));

			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
			const prompt = pi.sendUserMessage.mock.calls[0][0] as string;
			expect(prompt).toContain(REVIEW_SENTINEL);
		});

		it("should reset state on session_start", async () => {
			await loadExtension(pi);
			const handler = getHandler(pi, "session_start");

			// Call it — should reset all internal state
			handler({}, createMockCtx({ cwd: tempDir }));
			// No crash = state was reset successfully
			expect(pi.sendUserMessage).not.toHaveBeenCalled(); // Default: onSessionStart=false
		});
	});

	describe("turn_end handler", () => {
		it("should increment turn count", async () => {
			writeSettingsJson(tempDir, { onAgentEnd: true, minTurns: 2 });
			await loadExtension(pi);
			const turnEnd = getHandler(pi, "turn_end");
			const agentEnd = getHandler(pi, "agent_end");

			// 0 turns — should NOT trigger
			agentEnd(
				{ messages: [{ role: "assistant", content: "Done" }] },
				createMockCtx({ cwd: tempDir }),
			);
			expect(pi.sendUserMessage).not.toHaveBeenCalled();

			// 1 turn — still not enough
			turnEnd();
			agentEnd(
				{ messages: [{ role: "assistant", content: "Done" }] },
				createMockCtx({ cwd: tempDir }),
			);
			expect(pi.sendUserMessage).not.toHaveBeenCalled();

			// 2 turns — should trigger now
			turnEnd();
			agentEnd(
				{ messages: [{ role: "assistant", content: "Done" }] },
				createMockCtx({ cwd: tempDir }),
			);
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		});
	});

	describe("agent_end handler", () => {
		it("should trigger review on Ralph completion when onRalphDone is true (default)", async () => {
			await loadExtension(pi);
			const handler = getHandler(pi, "agent_end");

			handler(
				{ messages: [{ role: "assistant", content: "<promise>COMPLETE</promise>" }] },
				createMockCtx({ cwd: tempDir }),
			);

			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
			const prompt = pi.sendUserMessage.mock.calls[0][0] as string;
			expect(prompt).toContain(REVIEW_SENTINEL);
		});

		it("should NOT trigger review on Ralph completion when onRalphDone is false", async () => {
			writeSettingsJson(tempDir, { onRalphDone: false });
			await loadExtension(pi);
			const handler = getHandler(pi, "agent_end");

			handler(
				{ messages: [{ role: "assistant", content: "<promise>COMPLETE</promise>" }] },
				createMockCtx({ cwd: tempDir }),
			);

			expect(pi.sendUserMessage).not.toHaveBeenCalled();
		});

		it("should NOT trigger review for normal agent completion", async () => {
			await loadExtension(pi);
			const handler = getHandler(pi, "agent_end");

			handler(
				{ messages: [{ role: "assistant", content: "Task done, no Ralph" }] },
				createMockCtx({ cwd: tempDir }),
			);

			expect(pi.sendUserMessage).not.toHaveBeenCalled();
		});

		it("should skip review if message contains review sentinel (own cycle)", async () => {
			await loadExtension(pi);
			const handler = getHandler(pi, "agent_end");

			// Simulate a message from our own review cycle
			handler(
				{ messages: [{ role: "assistant", content: `${REVIEW_SENTINEL}Reviewing...` }] },
				createMockCtx({ cwd: tempDir }),
			);

			expect(pi.sendUserMessage).not.toHaveBeenCalled();
		});

		it("should trigger review on agent_end when onAgentEnd is true and minTurns met", async () => {
			writeSettingsJson(tempDir, { onAgentEnd: true, minTurns: 1 });
			await loadExtension(pi);
			const turnEnd = getHandler(pi, "turn_end");
			const agentEnd = getHandler(pi, "agent_end");

			// Simulate enough turns
			turnEnd();
			turnEnd();
			turnEnd();

			agentEnd(
				{ messages: [{ role: "assistant", content: "Regular work done" }] },
				createMockCtx({ cwd: tempDir }),
			);

			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		});

		it("should NOT trigger review on agent_end when onAgentEnd is false (default)", async () => {
			await loadExtension(pi);
			const turnEnd = getHandler(pi, "turn_end");
			const agentEnd = getHandler(pi, "agent_end");

			turnEnd();
			turnEnd();
			turnEnd();

			agentEnd(
				{ messages: [{ role: "assistant", content: "Regular work done" }] },
				createMockCtx({ cwd: tempDir }),
			);

			expect(pi.sendUserMessage).not.toHaveBeenCalled();
		});

		it("should complete review cycle when in reviewing state without autoFix", async () => {
			await loadExtension(pi);
			const agentEnd = getHandler(pi, "agent_end");

			// First: trigger a review (Ralph completion)
			agentEnd(
				{ messages: [{ role: "assistant", content: "<promise>COMPLETE</promise>" }] },
				createMockCtx({ cwd: tempDir }),
			);
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

			// Second: the review agent finishes (cycleState is "reviewing", no autoFix)
			agentEnd(
				{ messages: [{ role: "assistant", content: "Review done" }] },
				createMockCtx({ cwd: tempDir }),
			);
			// Should NOT start another review — it's completing the cycle
			// The second call is handled by the "in reviewing state" branch
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		});

		it("should call ui.notify when hasUI is true and review triggers", async () => {
			const ctx = createMockCtx({ cwd: tempDir, hasUI: true });
			await loadExtension(pi);
			const handler = getHandler(pi, "agent_end");

			handler(
				{ messages: [{ role: "assistant", content: "<promise>COMPLETE</promise>" }] },
				ctx,
			);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				"Review triggered (Ralph loop done)",
				"info",
			);
		});
	});

	describe("before_agent_start handler", () => {
		it("should inject system prompt when REVIEW_SENTINEL is present", async () => {
			await loadExtension(pi);
			const handler = getHandler(pi, "before_agent_start");

			const result = handler(
				{ prompt: `${REVIEW_SENTINEL}Review prompt...`, systemPrompt: "You are helpful." },
				createMockCtx({ cwd: tempDir }),
			);

			expect(result).toBeDefined();
			expect(result.systemPrompt).toContain("fix-only review");
			expect(result.systemPrompt).toContain("TODO.md");
		});

		it("should inject system prompt when REREVIEW_SENTINEL is present", async () => {
			await loadExtension(pi);
			const handler = getHandler(pi, "before_agent_start");

			const result = handler(
				{ prompt: `${REREVIEW_SENTINEL}Re-review prompt...`, systemPrompt: "Base prompt." },
				createMockCtx({ cwd: tempDir }),
			);

			expect(result).toBeDefined();
			expect(result.systemPrompt).toContain("fix-only review");
		});

		it("should NOT inject system prompt when no sentinel is present", async () => {
			await loadExtension(pi);
			const handler = getHandler(pi, "before_agent_start");

			const result = handler(
				{ prompt: "Normal user request", systemPrompt: "You are helpful." },
				createMockCtx({ cwd: tempDir }),
			);

			expect(result).toBeUndefined();
		});
	});

	describe("cooldown blocking", () => {
		it("should block second review during cooldown", async () => {
			await loadExtension(pi);
			const handler = getHandler(pi, "agent_end");

			// First: trigger a review
			handler(
				{ messages: [{ role: "assistant", content: "<promise>COMPLETE</promise>" }] },
				createMockCtx({ cwd: tempDir }),
			);
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

			// Second: the review cycle completes (reviewing state → idle)
			handler(
				{ messages: [{ role: "assistant", content: "Review result" }] },
				createMockCtx({ cwd: tempDir }),
			);
			// Still 1 — the reviewing-state branch handled it, didn't re-trigger

			// Third: try to trigger another review immediately
			// This should be blocked by cooldown (120s default)
			handler(
				{ messages: [{ role: "assistant", content: "<promise>COMPLETE</promise>" }] },
				createMockCtx({ cwd: tempDir }),
			);
			// Still 1 — cooldown blocked it
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		});
	});

	describe("cycleState blocking", () => {
		it("should block new review when already reviewing", async () => {
			await loadExtension(pi);
			const handler = getHandler(pi, "agent_end");

			// First: trigger a review
			handler(
				{ messages: [{ role: "assistant", content: "<promise>COMPLETE</promise>" }] },
				createMockCtx({ cwd: tempDir }),
			);
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

			// While reviewing, try another trigger with sentinel-less message
			// (sentinel messages are filtered by isOurCycle check, so use a non-sentinel one)
			// But since cycleState is "reviewing", the handler enters the review-cycle branch
			handler(
				{ messages: [{ role: "assistant", content: "More work" }] },
				createMockCtx({ cwd: tempDir }),
			);
			// Should still be 1 — in reviewing state, it doesn't start new reviews
			expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		});
	});

	describe("disabled extension", () => {
		it("should NOT trigger review when enabled is false", async () => {
			writeSettingsJson(tempDir, { enabled: false, onRalphDone: true });
			await loadExtension(pi);
			const handler = getHandler(pi, "agent_end");

			handler(
				{ messages: [{ role: "assistant", content: "<promise>COMPLETE</promise>" }] },
				createMockCtx({ cwd: tempDir }),
			);

			expect(pi.sendUserMessage).not.toHaveBeenCalled();
		});
	});
});