/**
 * pi-opencode-go-credit-hider
 *
 * Hides "bad deal" models from OpenCode Go by parsing the credit-allocation
 * table on the OpenCode Go docs page at startup and overriding pi's built-in
 * `opencode-go` provider with a filtered model list.
 *
 * Why:
 *   OpenCode Go charges credits per request. Each model has an effective
 *   monthly credit allocation (currently $15 or $60). Models in the $15
 *   tier burn your monthly allotment much faster, so they show up as
 *   attractive defaults in /model or Ctrl+P cycling but are almost never
 *   the right pick.
 *
 *   This extension keeps the $60-tier models front-and-center and hides
 *   the $15-tier models by default. The `allow` and `deny` config lists
 *   let you override the rule for specific models, but there is no
 *   current use case: the docs page only publishes the effective credit
 *   allocation (no per-model promo data), and every model currently on
 *   the page either belongs cleanly to the $60 tier or the $15 tier.
 *   Exact match only; one model id per entry.
 *
 * Data source:
 *   The OpenCode Go docs page at https://opencode.ai/docs/go/ is fetched
 *   on every pi startup. The "Usage" column in the pricing table is the
 *   authoritative source for per-model credit allocation. If the page is
 *   unreachable, behavior is controlled by `onFetchError`:
 *     - "fail" (default): register an empty model list so the user notices
 *       immediately and can either fix the network or set onFetchError to
 *       "passthrough" in the config.
 *     - "passthrough": don't override the built-in list at all. You get the
 *       full unfiltered catalog but the extension effectively does nothing
 *       this session.
 *
 *   The fetch is skipped entirely when PI_OFFLINE=1 (the extension
 *   registers an empty model list, matching the "fail" policy).
 *
 * Configuration file: ~/.pi/agent/opencode-go-credit-hider.json
 *   {
 *     "thresholdUsd": 60,           // hide models whose effective credit < this
 *     "allow": [],                   // always keep these (hypothetical — see README)
 *     "deny":  [],                   // always hide these (hypothetical — see README)
 *     "onFetchError": "fail",        // "fail" | "passthrough"
 *     "docsUrl": "https://opencode.ai/docs/go/",
 *     "fetchTimeoutMs": 5000
 *   }
 *
 * Inspecting the filter at runtime:
 *   /opencode-go-credits   — show what was kept, what was hidden, and why
 *
 * Interaction with other customization:
 *   This extension overrides pi's built-in `opencode-go` provider by
 *   re-registering it with a filtered model list. The override REPLACES
 *   the model list entirely; custom models the user has added for the
 *   `opencode-go` provider in `~/.pi/agent/models.json` are NOT preserved.
 *   Use `allow` to keep those model ids in the filtered list.
 *
 *   Per-model `modelOverrides` in `models.json` (name, reasoning,
 *   thinkingLevelMap, input, cost, contextWindow, maxTokens, headers,
 *   compat) are still applied on top of the filtered list, because they
 *   run after the extension registration in pi's provider composition.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { Model } from "@earendil-works/pi-ai";

// =============================================================================
// Configuration
// =============================================================================

interface HiderConfig {
	/** Hide a model whose effective monthly credit allocation is below this. */
	thresholdUsd: number;
	/** Always keep these model ids, even if they are below the threshold. */
	allow: string[];
	/** Always hide these model ids, even if they are at or above the threshold. */
	deny: string[];
	/** What to do if fetching the docs page fails. */
	onFetchError: "fail" | "passthrough";
	/** URL of the docs page that holds the pricing/usage table. */
	docsUrl: string;
	/** Abort the fetch after this many ms. */
	fetchTimeoutMs: number;
}

const DEFAULT_CONFIG: HiderConfig = {
	thresholdUsd: 60,
	allow: [],
	deny: [],
	onFetchError: "fail",
	docsUrl: "https://opencode.ai/docs/go/",
	fetchTimeoutMs: 5000,
};

function configPath(): string {
	return join(getAgentDir(), "opencode-go-credit-hider.json");
}

async function loadConfig(): Promise<{ config: HiderConfig; parseError?: string }> {
	const path = configPath();
	if (!existsSync(path)) return { config: { ...DEFAULT_CONFIG } };
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<HiderConfig>;
		return { config: { ...DEFAULT_CONFIG, ...parsed } };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			config: { ...DEFAULT_CONFIG },
			parseError: `Could not parse ${path}: ${message}. Using built-in defaults.`,
		};
	}
}

// =============================================================================
// Docs page parsing
//
// The OpenCode Go docs page is a static Starlight (Astro) site. The two
// tables we care about have very predictable structure:
//
//   Pricing table:  <thead><tr><th>Model</th><th>Input</th>...
//                   <th>Cached Write</th><th>Usage</th></tr></thead>
//                   <tbody><tr><td>Display Name</td>...<td>$XX</td></tr>...
//                   </tbody>
//
//   Endpoints table: <thead><tr><th>Model</th><th>Model ID</th>...
//                    <th>AI SDK Package</th></tr></thead>
//                    <tbody><tr><td>Display Name</td><td>model-id</td>...
//                    </tbody>
//
// The display names do not always line up: the pricing table uses spaces
// ("MiMo V2.5") and may have parenthetical variants ("GPT 5.6 Luna
// (≤ 272K tokens)"); the endpoints table uses hyphens ("MiMo-V2.5") and
// has no variants. We strip parentheticals and normalize on both sides
// to match. If multiple pricing rows collapse to the same normalized
// name (variants of one model), we keep the MINIMUM usage — any row
// below threshold hides the model.
// =============================================================================

function stripHtml(s: string): string {
	return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function stripParenthetical(s: string): string {
	return s.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function normalizeName(s: string): string {
	return s.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]/g, "");
}

function parseUsageByNormalizedName(html: string): Map<string, number> {
	// Match the pricing table by its exact header sequence.
	const re =
		/<thead>\s*<tr>\s*<th>Model<\/th>\s*<th>Input<\/th>\s*<th>Output<\/th>\s*<th>Cached Read<\/th>\s*<th>Cached Write<\/th>\s*<th>Usage<\/th>\s*<\/tr>\s*<\/thead>\s*<tbody>([\s\S]*?)<\/tbody>/;
	const m = html.match(re);
	if (!m) {
		throw new Error(
			"Pricing table with 'Usage' column not found on the OpenCode Go docs page. " +
				"The page layout may have changed.",
		);
	}
	const usageByNorm = new Map<string, number>();
	const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
	let rowMatch: RegExpExecArray | null;
	while ((rowMatch = rowRe.exec(m[1])) !== null) {
		const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => stripHtml(c[1]));
		if (cells.length < 6) continue;
		const usageMatch = cells[5].match(/\$?\s*(\d+(?:\.\d+)?)/);
		if (!usageMatch) continue;
		const usage = parseFloat(usageMatch[1]);
		if (!Number.isFinite(usage) || usage <= 0) continue;
		const key = normalizeName(stripParenthetical(cells[0]));
		if (!key) continue;
		const existing = usageByNorm.get(key);
		if (existing === undefined || usage < existing) {
			usageByNorm.set(key, usage);
		}
	}
	return usageByNorm;
}

function parseIdByNormalizedName(html: string): Map<string, string> {
	// Match the endpoints table by its "Model ID" column.
	const re =
		/<thead>\s*<tr>\s*<th>Model<\/th>\s*<th>Model ID<\/th>[\s\S]*?<\/thead>\s*<tbody>([\s\S]*?)<\/tbody>/;
	const m = html.match(re);
	if (!m) {
		throw new Error(
			"Endpoints table with 'Model ID' column not found on the OpenCode Go docs page. " +
				"The page layout may have changed.",
		);
	}
	const idByNorm = new Map<string, string>();
	const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
	let rowMatch: RegExpExecArray | null;
	while ((rowMatch = rowRe.exec(m[1])) !== null) {
		const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => stripHtml(c[1]));
		if (cells.length < 2) continue;
		const id = cells[1].trim();
		if (!id) continue;
		const key = normalizeName(stripParenthetical(cells[0]));
		if (!key || idByNorm.has(key)) continue;
		idByNorm.set(key, id);
	}
	return idByNorm;
}

/** Build the final map of model id → effective credit allocation (USD). */
function buildUsageById(html: string): Map<string, number> {
	const usageByNorm = parseUsageByNormalizedName(html);
	const idByNorm = parseIdByNormalizedName(html);
	const usageById = new Map<string, number>();
	for (const [norm, id] of idByNorm) {
		const usage = usageByNorm.get(norm);
		if (usage !== undefined) usageById.set(id, usage);
	}
	if (usageById.size === 0) {
		throw new Error(
			"Could not match any pricing-table usage value to an endpoints-table model id. " +
				"The two tables may have drifted out of sync on the docs page.",
		);
	}
	return usageById;
}

// =============================================================================
// Filtering
// =============================================================================

type OpencodeGoModel = Model<
	"anthropic-messages" | "openai-completions" | "openai-responses"
>;

interface FilterSummary {
	total: number;
	kept: number;
	hidden: number;
	hiddenByThreshold: Array<{ id: string; usage: number }>;
	hiddenByDeny: string[];
	keptWithoutUsageInfo: number;
}

function filterModels(
	allModels: readonly OpencodeGoModel[],
	usageById: Map<string, number>,
	config: HiderConfig,
): { kept: OpencodeGoModel[]; summary: FilterSummary } {
	const allow = new Set(config.allow);
	const deny = new Set(config.deny);
	const kept: OpencodeGoModel[] = [];
	const hiddenByThreshold: Array<{ id: string; usage: number }> = [];
	const hiddenByDeny: string[] = [];
	let keptWithoutUsageInfo = 0;

	for (const m of allModels) {
		if (deny.has(m.id)) {
			hiddenByDeny.push(m.id);
			continue;
		}
		if (allow.has(m.id)) {
			kept.push(m);
			continue;
		}
		const usage = usageById.get(m.id);
		if (usage === undefined) {
			// No info for this model on the docs page — keep it. New or
			// re-priced models default to visible until proven otherwise.
			keptWithoutUsageInfo += 1;
			kept.push(m);
			continue;
		}
		if (usage < config.thresholdUsd) {
			hiddenByThreshold.push({ id: m.id, usage });
			continue;
		}
		kept.push(m);
	}

	return {
		kept,
		summary: {
			total: allModels.length,
			kept: kept.length,
			hidden: allModels.length - kept.length,
			hiddenByThreshold,
			hiddenByDeny,
			keptWithoutUsageInfo,
		},
	};
}

// =============================================================================
// Slash command: /opencode-go-credits
// =============================================================================

function formatSummary(
	summary: FilterSummary,
	config: HiderConfig,
	fetchStatus: { url: string; ok: boolean; error?: string; modelCount: number },
): string {
	const lines: string[] = [];
	lines.push(
		`opencode-go credit filter — ${fetchStatus.ok ? "active" : fetchStatus.error ? "inactive (fetch failed)" : "inactive"}`,
	);
	lines.push(`Source: ${fetchStatus.url}`);
	lines.push(
		`Models: ${summary.kept}/${summary.total} kept, ${summary.hidden} hidden (threshold < $${config.thresholdUsd})`,
	);
	lines.push("");

	if (fetchStatus.ok) {
		lines.push(`Hidden (below $${config.thresholdUsd} effective credit):`);
		if (summary.hiddenByThreshold.length === 0) {
			lines.push("  (none)");
		} else {
			for (const { id, usage } of summary.hiddenByThreshold) {
				lines.push(`  - ${id}: $${usage}`);
			}
		}
		if (summary.hiddenByDeny.length > 0) {
			lines.push("");
			lines.push("Hidden (denylist):");
			for (const id of summary.hiddenByDeny) {
				lines.push(`  - ${id}`);
			}
		}
		if (summary.keptWithoutUsageInfo > 0) {
			lines.push("");
			lines.push(`${summary.keptWithoutUsageInfo} model(s) kept (no usage info found in docs page).`);
		}
	} else {
		lines.push(`Error: ${fetchStatus.error ?? "unknown"}`);
		lines.push(
			`Set onFetchError=passthrough in ${configPath()} to fall back to the unfiltered list.`,
		);
	}
	return lines.join("\n");
}

// =============================================================================
// Extension entry point
// =============================================================================

export default async function (pi: ExtensionAPI) {
	const { config, parseError } = await loadConfig();
	if (parseError) {
		console.warn(`[opencode-go-credit-hider] ${parseError}`);
	}

	const offline = process.env.PI_OFFLINE === "1" || process.env.PI_OFFLINE === "true";
	const builtIn = opencodeGoProvider();
	const allModels = builtIn.getModels();

	let usageById: Map<string, number>;
	let fetchError: string | undefined;
	let fetchOk = false;

	if (offline) {
		fetchError = "PI_OFFLINE=1 is set; skipping docs fetch";
		usageById = new Map();
	} else {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
			let res: Response;
			try {
				res = await fetch(config.docsUrl, { signal: controller.signal });
			} finally {
				clearTimeout(timer);
			}
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} ${res.statusText}`);
			}
			const html = await res.text();
			usageById = buildUsageById(html);
			fetchOk = true;
		} catch (err) {
			fetchError = err instanceof Error ? err.message : String(err);
			usageById = new Map();
		}
	}

	// Compute the filter regardless of fetch outcome, so the slash command can
	// report something useful even on a fetch failure.
	const { kept, summary } = filterModels(allModels, usageById, config);

	if (!fetchOk) {
		const reason = `${fetchError ?? "unknown error"} (source: ${config.docsUrl})`;
		if (config.onFetchError === "passthrough") {
			// Don't override the built-in list. Just notify and bail.
			console.warn(
				`[opencode-go-credit-hider] Fetch failed; passthrough mode leaves the built-in opencode-go list unfiltered. Reason: ${reason}`,
			);
			registerCreditsCommand(pi, config, summary, {
				url: config.docsUrl,
				ok: false,
				error: fetchError ?? "unknown error",
				modelCount: usageById.size,
			});
			return;
		}
		// "fail" (default): register an empty model list so the user notices.
		console.error(
			`[opencode-go-credit-hider] Fetch failed; registering opencode-go with NO models. Reason: ${reason}. ` +
				`To silently fall back to the unfiltered list, set onFetchError=passthrough in ${configPath()}.`,
		);
		pi.registerProvider("opencode-go", {
			apiKey: "$OPENCODE_API_KEY",
			models: [],
		});
		registerCreditsCommand(pi, config, summary, {
			url: config.docsUrl,
			ok: false,
			error: fetchError ?? "unknown error",
			modelCount: usageById.size,
		});
		return;
	}

	// Success path: register the override with the filtered list.
	pi.registerProvider("opencode-go", {
		apiKey: "$OPENCODE_API_KEY",
		models: kept,
	});

	registerCreditsCommand(pi, config, summary, {
		url: config.docsUrl,
		ok: true,
		modelCount: usageById.size,
	});
}

function registerCreditsCommand(
	pi: ExtensionAPI,
	config: HiderConfig,
	summary: FilterSummary,
	fetchStatus: { url: string; ok: boolean; error?: string; modelCount: number },
) {
	pi.registerCommand("opencode-go-credits", {
		description:
			"Show the opencode-go credit filter: which models are hidden, why, and whether the docs fetch succeeded.",
		handler: async (_args, ctx) => {
			const text = formatSummary(summary, config, fetchStatus);
			const level = fetchStatus.ok ? "info" : "warning";
			ctx.ui.notify(text, level);
		},
	});
}
