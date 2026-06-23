/**
 * Auto Review Extension for Pi
 *
 * Event-driven project review: scans for problems after work completes,
 * writes findings to TODO.md, and optionally auto-fixes them in bounded
 * loops until the project is clean.
 *
 * Invisible to the agent — no commands, no skills, no markers, no branding.
 * Reviews trigger automatically when configured conditions are met.
 * The agent just receives a follow-up message and does the work.
 *
 * Settings (in .pi/settings.json or ~/.pi/agent/settings.json):
 *   autoReview.enabled          - master toggle (default: true)
 *   autoReview.todoPath         - path to todo file (default: "TODO.md")
 *   autoReview.autoFix          - after writing todos, go fix them (default: false)
 *   autoReview.maxFixRounds     - max review→fix→re-review loops (default: 3)
 *   autoReview.onRalphDone      - auto-review when Ralph loop completes (default: true)
 *   autoReview.onAgentEnd       - auto-review after any agent_end (default: false)
 *   autoReview.onSessionStart   - auto-review on session start (default: false)
 *   autoReview.minTurns         - minimum turns before agent_end triggers review (default: 3)
 *   autoReview.scope            - "full" | "staged" | "diff" (default: "full")
 *   autoReview.excludePatterns  - dirs to exclude (default: ["node_modules", ...])
 *   autoReview.cooldownMs       - minimum ms between auto-reviews (default: 120000)
 *
 *   Custom prompts (all optional, override defaults):
 *   autoReview.prompt            - custom first-review prompt
 *   autoReview.rereviewPrompt    - custom re-review prompt (in fix loop)
 *   autoReview.fixInstruction    - custom instruction appended when autoFix is on
 *   autoReview.focusAreas        - override the default list of things to look for
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	REVIEW_SENTINEL,
	REREVIEW_SENTINEL,
	getSettings,
	resetSettingsCache,
	buildReviewPrompt,
	buildRereviewPrompt,
	isRalphCompletion,
	countUnfixedItems,
} from "./auto-review-lib.js";
import type { AutoReviewSettings, ReviewScope } from "./auto-review-lib.js";

type CycleState = "idle" | "reviewing";

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let cycleState: CycleState = "idle";
	let lastAutoReviewTime = 0;
	let turnCount = 0;
	let cycleAutoFix = false;
	let fixRound = 0;
	let previousItemCount = -1;

	function shouldTrigger(settings: Required<AutoReviewSettings>): boolean {
		if (!settings.enabled) return false;
		if (cycleState !== "idle") return false;
		const now = Date.now();
		if (now - lastAutoReviewTime < settings.cooldownMs) return false;
		return true;
	}

	function startReview(
		settings: Required<AutoReviewSettings>,
		scope: ReviewScope,
		autoFix: boolean,
		reason: string,
	) {
		if (!shouldTrigger(settings)) return;

		cycleState = "reviewing";
		cycleAutoFix = autoFix;
		fixRound = 0;
		previousItemCount = -1;
		lastAutoReviewTime = Date.now();

		const prompt = buildReviewPrompt(settings, scope, autoFix, reason);
		try {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		} catch (err) {
			console.warn(`[auto-review] sendUserMessage failed: ${err instanceof Error ? err.message : err}`);
			cycleState = "idle";
		}
	}

	function handleFixRoundComplete(
		settings: Required<AutoReviewSettings>,
		cwd: string,
		_hasUI: boolean,
	) {
		const currentItemCount = countUnfixedItems(settings.todoPath, cwd);

		if (currentItemCount === 0) {
			cycleState = "idle";
			console.log("[auto-review] project is clean");
			return;
		}

		fixRound++;

		if (fixRound >= settings.maxFixRounds) {
			cycleState = "idle";
			console.log(`[auto-review] max fix rounds reached (${settings.maxFixRounds}), ${currentItemCount} items remain`);
			return;
		}

		if (previousItemCount >= 0 && currentItemCount > previousItemCount) {
			cycleState = "idle";
			console.log(`[auto-review] diverging (${currentItemCount} items now vs ${previousItemCount} before), stopping`);
			return;
		}

		previousItemCount = currentItemCount;
		cycleState = "reviewing";

		const rereviewPrompt = buildRereviewPrompt(settings, fixRound, settings.maxFixRounds, currentItemCount, cycleAutoFix);
		try {
			pi.sendUserMessage(rereviewPrompt, { deliverAs: "followUp" });
		} catch (err) {
			console.warn(`[auto-review] sendUserMessage failed: ${err instanceof Error ? err.message : err}`);
			cycleState = "idle";
		}

		console.log(`[auto-review] fix loop round ${fixRound}/${settings.maxFixRounds} — ${currentItemCount} items remaining`);
	}

	// ── Session Start ────────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		turnCount = 0;
		cycleState = "idle";
		cycleAutoFix = false;
		fixRound = 0;
		previousItemCount = -1;
		resetSettingsCache();
		const settings = getSettings(ctx.cwd);

		if (settings.onSessionStart && shouldTrigger(settings)) {
			if (ctx.hasUI) {
				ctx.ui.notify("Review triggered (session start)", "info");
			}
			startReview(settings, settings.scope, settings.autoFix, "session start");
		}
	});

	// ── Turn Counting ────────────────────────────────────────────────────

	pi.on("turn_end", () => {
		turnCount++;
	});

	// ── Agent End ────────────────────────────────────────────────────────

	pi.on("agent_end", (event, ctx) => {
		const settings = getSettings(ctx.cwd);
		const messages = event.messages as Array<{
			role: string;
			content?: string;
			toolName?: string;
		}>;

		// If we're in a review cycle, handle completion
		if (cycleState === "reviewing") {
			if (cycleAutoFix) {
				handleFixRoundComplete(settings, ctx.cwd, ctx.hasUI);
			} else {
				cycleState = "idle";
				console.log("[auto-review] review complete");
			}
			return;
		}

		// Skip if any recent message is from our review cycle
		const isOurCycle = messages.slice(-10).some((m) => {
			const text = typeof m.content === "string" ? m.content : "";
			return text.includes(REVIEW_SENTINEL) || text.includes(REREVIEW_SENTINEL);
		});
		if (isOurCycle) return;

		// Real work triggers
		if (settings.onRalphDone && isRalphCompletion(messages)) {
			if (ctx.hasUI) {
				ctx.ui.notify("Review triggered (Ralph loop done)", "info");
			}
			startReview(settings, settings.scope, settings.autoFix, "Ralph loop completion");
			return;
		}

		if (settings.onAgentEnd && turnCount >= settings.minTurns) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Review triggered (agent finished, ${turnCount} turns)`, "info");
			}
			startReview(settings, settings.scope, settings.autoFix, `agent end (${turnCount} turns)`);
		}
	});

	// ── System prompt hints (sentinel-detected, no branding) ────────────

	pi.on("before_agent_start", (event, ctx) => {
		const text = event.prompt || "";
		if (!text.includes(REVIEW_SENTINEL) && !text.includes(REREVIEW_SENTINEL)) return;

		const settings = getSettings(ctx.cwd);
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\nThis is a fix-only review — do NOT propose features or improvements. Methodology: build check, test suite, grep for FIXME/HACK/console.log/explicit any types, security scan (hardcoded secrets, eval), check dependency health. Write findings to: ${settings.todoPath}. Use <!-- auto-review-start --> and <!-- auto-review-end --> markers. Organize as 🔴 Critical / 🟡 Warning / 🟢 Info. At the end of ${settings.todoPath}, include: _Items found: N_ with the total count of unfixed [ ] items.`,
		};
	});
}