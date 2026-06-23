/**
 * Internal pure functions for auto-review.
 *
 * Exported for testability — NOT part of the Pi extension API.
 * The agent never sees these; they're used by auto-review.ts
 * and imported by tests.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

// ── Internal sentinels (never shown to agent) ──────────────────────────────

export const REVIEW_SENTINEL = "\x00AR1\x00";
export const REREVIEW_SENTINEL = "\x00AR2\x00";

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_FOCUS_AREAS = [
	"Lint errors, type errors, build failures",
	"Failing or missing tests",
	"Security vulnerabilities",
	"Broken imports or missing dependencies",
	"Dead code, unreachable branches",
	"TODO/FIXME/HACK comments that indicate known BUGS (not feature ideas)",
	"Inconsistencies between code and config",
	"Performance problems that are bugs (N+1 queries, memory leaks)",
];

export const DEFAULT_SETTINGS: Required<AutoReviewSettings> = {
	enabled: true,
	todoPath: "TODO.md",
	autoFix: false,
	maxFixRounds: 3,
	onRalphDone: true,
	onAgentEnd: false,
	onSessionStart: false,
	minTurns: 3,
	scope: "full",
	excludePatterns: [
		"node_modules",
		".git",
		"dist",
		"build",
		"coverage",
		".next",
		".nuxt",
		"vendor",
		"__pycache__",
		".venv",
		"target",
	],
	cooldownMs: 120_000,
	prompt: null,
	rereviewPrompt: null,
	fixInstruction: null,
	focusAreas: null,
};

// ── Types ───────────────────────────────────────────────────────────────────

export interface AutoReviewSettings {
	enabled?: boolean;
	todoPath?: string;
	autoFix?: boolean;
	maxFixRounds?: number;
	onRalphDone?: boolean;
	onAgentEnd?: boolean;
	onSessionStart?: boolean;
	minTurns?: number;
	scope?: "full" | "staged" | "diff";
	excludePatterns?: string[];
	cooldownMs?: number;
	prompt?: string | null;
	rereviewPrompt?: string | null;
	fixInstruction?: string | null;
	focusAreas?: string[] | null;
}

export type ReviewScope = "full" | "staged" | "diff";

// ── Settings (cached per session, safe mtime) ──────────────────────────────

let _cachedSettings: Required<AutoReviewSettings> | null = null;
let _cachedSettingsPath = "";
let _cachedMtimeKey = "";

/** Reset settings cache — for testing. */
export function resetSettingsCache(): void {
	_cachedSettings = null;
	_cachedSettingsPath = "";
	_cachedMtimeKey = "";
}

function safeStatMtime(filePath: string): string {
	try {
		return `${fs.statSync(filePath).mtimeMs}`;
	} catch {
		return "none";
	}
}

export function readSettingsJson(filePath: string): Record<string, unknown> | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		console.warn(`[auto-review] Warning: ${filePath} can't be read — ${detail}`);
		return null;
	}
}

export function getSettings(cwd: string): Required<AutoReviewSettings> {
	const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
	const globalSettingsPath = path.join(homedir(), ".pi", "agent", "settings.json");

	const mtimeKey = [projectSettingsPath, globalSettingsPath]
		.map((p) => `${p}:${safeStatMtime(p)}`)
		.join("|");

	if (_cachedSettings && _cachedSettingsPath === cwd && mtimeKey === _cachedMtimeKey) {
		return _cachedSettings;
	}

	for (const settingsPath of [projectSettingsPath, globalSettingsPath]) {
		const data = readSettingsJson(settingsPath);
		if (data) {
			const raw = data.autoReview ?? data["auto-review"];
			if (raw && typeof raw === "object") {
				_cachedSettings = { ...DEFAULT_SETTINGS, ...(raw as AutoReviewSettings) };
				_cachedSettingsPath = cwd;
				_cachedMtimeKey = mtimeKey;
				return _cachedSettings;
			}
		}
	}
	_cachedSettings = { ...DEFAULT_SETTINGS };
	_cachedSettingsPath = cwd;
	_cachedMtimeKey = mtimeKey;
	return _cachedSettings;
}

// ── Review methodology (inline, language-agnostic) ─────────────────────────

export const REVIEW_METHODOLOGY = `Use this FIX-ONLY review methodology:
1. **Build check** — run the project's build command and type checker (e.g., npm run build / cargo check / go build)
2. **Test suite** — run the project's test command (e.g., npm test / cargo test / go test)
3. **Bug markers** — grep for FIXME, HACK, XXX, console.log, print(), explicit any types (: any, as any) in source files
4. **Security** — grep for hardcoded secrets (password=, api_key=, secret=), eval(), unsafe patterns
5. **Dependency health** — check for missing or broken dependencies (npm ls / cargo check / go mod verify)`;

export const FORMAT_INSTRUCTION = (todoPath: string) => `
Write your findings to ${todoPath}. Organize by priority:
- 🔴 Critical — broken build, security issues, data loss risk
- 🟡 Warning — failing tests, dead code, deprecation issues
- 🟢 Info — minor fixes, cleanup of accidental issues

Wrap the auto-generated section with <!-- auto-review-start --> and <!-- auto-review-end --> HTML comments.
At the very end of ${todoPath}, add a line: _Items found: N_ where N is the total count of unfixed [ ] items.
Keep each item actionable and specific. Include file paths and line numbers where possible.
Do NOT add feature requests, architecture proposals, or "nice to have" items.`;

// ── Prompt Builders ─────────────────────────────────────────────────────────

export function getFocusList(settings: Required<AutoReviewSettings>): string {
	const areas = settings.focusAreas ?? DEFAULT_FOCUS_AREAS;
	return areas.map((a) => `- ${a}`).join("\n");
}

export function getDefaultFixInstruction(todoPath: string): string {
	return `After updating ${todoPath}, go ahead and fix the problems you found. Work through items in priority order. Cross off items in ${todoPath} as you fix them.`;
}

export function buildReviewPrompt(
	settings: Required<AutoReviewSettings>,
	scope: ReviewScope,
	autoFix: boolean,
	_triggerReason: string,
): string {
	// Custom prompt: prepend sentinel, always append format instruction
	if (settings.prompt) {
		let prompt = `${REVIEW_SENTINEL}${settings.prompt}`;
		prompt += FORMAT_INSTRUCTION(settings.todoPath);
		if (autoFix) {
			prompt += `\n\n${settings.fixInstruction ?? getDefaultFixInstruction(settings.todoPath)}`;
		}
		return prompt;
	}

	const scopeInstruction: Record<ReviewScope, string> = {
		full: "Review the entire project for problems.",
		staged: "Review only the staged git changes for problems.",
		diff: "Review the diff from the main branch (or trunk/develop if main doesn't exist) for problems.",
	};

	const excludeNote = settings.excludePatterns.length > 0
		? `\nExclude these directories: ${settings.excludePatterns.join(", ")}.`
		: "";

	const fixInstruction = autoFix
		? `\n\n${settings.fixInstruction ?? getDefaultFixInstruction(settings.todoPath)}`
		: "";

	return `${REVIEW_SENTINEL}${scopeInstruction[scope]}${excludeNote}

${REVIEW_METHODOLOGY}

This is a FIX-ONLY review. Do NOT propose features or improvements. ONLY find problems that need fixing:
${getFocusList(settings)}
${FORMAT_INSTRUCTION(settings.todoPath)}${fixInstruction}`;
}

export function buildRereviewPrompt(
	settings: Required<AutoReviewSettings>,
	round: number,
	maxRounds: number,
	previousItemCount: number,
	autoFix: boolean,
): string {
	if (settings.rereviewPrompt) {
		let prompt = `${REREVIEW_SENTINEL}${settings.rereviewPrompt}`
			.replaceAll("{round}", String(round))
			.replaceAll("{maxRounds}", String(maxRounds))
			.replaceAll("{previousItems}", String(previousItemCount));
		if (prompt.includes("{focusAreas}")) {
			prompt = prompt.replaceAll("{focusAreas}", getFocusList(settings));
		}
		prompt += FORMAT_INSTRUCTION(settings.todoPath);
		if (autoFix) {
			prompt += `\n\n${settings.fixInstruction ?? getDefaultFixInstruction(settings.todoPath)}`;
		}
		return prompt;
	}

	const fixAppend = autoFix
		? `\n\n${settings.fixInstruction ?? getDefaultFixInstruction(settings.todoPath)}`
		: "";

	return `${REREVIEW_SENTINEL}Re-review after fixes (round ${round}/${maxRounds}). The previous review found ${previousItemCount} items and fixes were applied.

Re-scan the project for remaining problems.

${REVIEW_METHODOLOGY}

ONLY find problems that need fixing:
${getFocusList(settings)}

IMPORTANT:
- Check if the fixes from the previous round actually resolved the claimed issues
- Look for NEW problems that the fixes may have introduced
- If a previous fix didn't work, mark it clearly in ${settings.todoPath}
${FORMAT_INSTRUCTION(settings.todoPath)}

If you find ZERO problems, write an empty ${settings.todoPath} with just a header saying "Project is clean ✅".

Do NOT propose features. Only problems that need fixing.${fixAppend}`;
}

// ── Detection helpers ───────────────────────────────────────────────────────

/**
 * Detects Ralph loop completion by looking for <promise>COMPLETE</promise>
 * in the last 5 messages (assistant role with string content).
 *
 * @param messages - The message history array
 * @returns true if Ralph loop completion is detected
 * @requires Ralph loop output format: <promise>COMPLETE</promise>
 */
export function isRalphCompletion(messages: Array<{ role: string; content?: string; toolName?: string }>): boolean {
	for (let i = messages.length - 1; i >= Math.max(0, messages.length - 5); i--) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role === "assistant" && typeof msg.content === "string") {
			if (msg.content.includes("<promise>COMPLETE</promise>")) return true;
		}
	}
	return false;
}

/**
 * Count unfixed [ ] items ONLY within the auto-generated section.
 * Returns 0 for missing files (not an error — just means no items yet).
 *
 * @param todoPath - Path to the TODO.md file
 * @param cwd - Current working directory for path resolution
 * @returns Count of unchecked items in the auto-review section
 * @note Supports only `- [ ]` syntax (GitHub Flavored Markdown)
 */
export function countUnfixedItems(todoPath: string, cwd: string): number {
	const fullPath = path.resolve(cwd, todoPath);
	try {
		const content = fs.readFileSync(fullPath, "utf-8");
		const startMatch = content.search(/<!--\s*auto-review-start\s*-->/i);
		if (startMatch === -1) return 0;
		const endMatch = content.search(/<!--\s*auto-review-end\s*-->/i);
		const section = endMatch === -1
			? content.slice(startMatch)
			: content.slice(startMatch, endMatch);
		const stripped = section.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
		const matches = stripped.match(/^- \[ \]/gm);
		return matches ? matches.length : 0;
	} catch {
		return 0;
	}
}