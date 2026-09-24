/**
 * pi-stale-model-filter
 *
 * Hides superseded model versions from pi's /model selector, Ctrl+P model
 * cycling, and --models CLI scoping, without any per-provider wiring.
 *
 * How it works
 * ────────────
 * On every pi session start (or /reload) the extension:
 *
 *   1. Reads the live model registry, including built-in, models.json,
 *      and extension-registered providers.
 *   2. Filters Pi's availability snapshots without replacing or mutating
 *      any provider registration.
 *   3. Groups models by provider + base name (everything around the
 *      rightmost numeric version token, e.g. "tool-2.0-flash" → base
 *      "tool-flash", version "2.0").
 *   4. Within each group, keeps only the numerically highest version.
 *      Older versions are removed from availability, so they disappear
 *      from /model, Ctrl+P cycling, /scoped-models, and RPC model lists.
 *   5. Rewrites the already-resolved --models scope to available models,
 *      replacing a filtered entry with its newest relative when possible.
 *
 * The runtime filter remains attached when Pi refreshes provider catalogs,
 * so live discovery cannot reintroduce stale entries.
 *
 * Design boundary
 * ────────────────
 * Version detection is based purely on numeric suffixes. A model ID like
 * "tool-2.0-flash" is parsed as base "tool-flash", version "2.0".
 * "tool-3.0-flash" → base "tool-flash", version "3.0". So the two group
 * together and only 3.0 survives.
 *
 * Models without a numeric version suffix are singletons and are never
 * filtered — no false positives on e.g. "llama3-8b-instruct".
 *
 * Commands
 * ────────
 *   /stale-model-filter status     – show what's being filtered and why
 *   /stale-model-filter enable     – re-enable filtering
 *   /stale-model-filter disable    – turn it off
 *   /stale-model-filter keep <id>  – protect a model from filtering
 *   /stale-model-filter unkeep <id>
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FilterConfig {
  version: 1;
  disabled: boolean;
  /** "provider/model-id" strings that must survive filtering. */
  keep: string[];
}

export const DEFAULT_CONFIG: FilterConfig = { version: 1, disabled: false, keep: [] };

const PROVIDER_FILTER_MARKER = Symbol.for("pi-stale-model-filter/provider");
const SCOPED_MODELS_BACKUP = Symbol.for("pi-stale-model-filter/scoped-backup");
const SCOPED_MODELS_STATE = Symbol.for("pi-stale-model-filter/scoped-state");
const RUNTIME_AVAILABILITY_STATE = Symbol.for("pi-stale-model-filter/runtime-state");

function debugLog(message: string): void {
  if (process.env.PI_STALE_MODEL_FILTER_DEBUG) {
    console.error(`[pi-stale-model-filter] ${message}`);
  }
}

// ─── Pure version logic ───────────────────────────────────────────────────

/**
 * Parse a model id into { base, version }.
 *
 * The parser normalizes every version expression in the id (for example
 * 2.5, M2.7, K2, o3, V4.1, qwen3.5, or Fireworks' M2P7). Version tokens
 * are removed from the family key; every remaining qualifier (size, mode,
 * speed, region, batch/free suffix, and so on) must match exactly.
 *
 *   "tool-2.0-flash"      → base "tool-flash",     version "2.0"
 *   "tool-3.0-flash"      → base "tool-flash",     version "3.0"
 *   "gpt-5.5"            → base "gpt",             version "5.5"
 *   "claude-sonnet-4-5"  → base "claude-sonnet",   version "4.5"
 *   "my-model"           → null
 *
 * Plain integers, dotted numbers, single-letter markers, and compact MxPy
 * forms are recognized. Sizes such as 8b, 70b, and 120b are rejected as
 * version tokens. Different marker families remain independent (R1 and V3.2,
 * for example), while matching markers compare normally (M2.7 versus M3).
 */
type VersionExpression = {
  kind: "semantic" | "date";
  values: number[];
  partTexts: string[];
  marked: boolean;
  yearless: boolean;
};

type ModelVersionInfo = {
  base: string;
  version: string;
  semantic: number[];
  dateKeys: string[];
  versionClass:
    | "semantic"
    | "semantic-date"
    | "semantic-yearless-date"
    | "date-only"
    | "yearless-date-only";
  markerKey: string;
};

function dateKey(values: number[], yearless: boolean): string {
  if (yearless) {
    return values.map((value) => String(value).padStart(2, "0")).join("");
  }
  return values
    .map((value, index) =>
      index === 0 ? String(value).padStart(4, "0") : String(value).padStart(2, "0"),
    )
    .join("");
}

function analyzeModelVersion(id: string): ModelVersionInfo | null {
  const expressions: VersionExpression[] = [];
  const baseSegments: string[] = [];
  const markers: string[] = [];

  for (const segment of id.split("-")) {
    // Quantization labels such as q4_k_m/q5_k_m are immutable qualifiers,
    // not model generations, even though q4/q5 look like marked versions.
    if (/^q\d+(?:_[a-z0-9]+)*$/i.test(segment)) {
      baseSegments.push(segment);
      continue;
    }

    let baseSegment = "";
    let cursor = 0;
    const matches = segment.matchAll(
      /\d+(?:\.\d+)*(?:[pP]\d+(?:\.\d+)*)?/g,
    );

    for (const match of matches) {
      const raw = match[0];
      const matchStart = match.index ?? cursor;
      const after = segment[matchStart + raw.length] ?? "";
      const before = segment[matchStart - 1] ?? "";
      const prefix = segment.slice(0, matchStart);
      const standaloneMarker =
        prefix.length === 1 && /^[A-Za-z]$/.test(prefix) ? prefix : "";

      // Sizes such as 8b, 70b, and 120b are qualifiers, not versions.
      if (/[A-Za-z]/.test(after) && after.toLowerCase() !== "o") continue;
      // The numeric deployment suffix in v1:0 is not an independent model
      // version; v1 is already captured above.
      if (!standaloneMarker && before === ":") continue;

      const compact = /^(\d+(?:\.\d+)*)[pP](\d+(?:\.\d+)*)$/.exec(raw);
      const numericText = compact ? compact[1] : raw;
      const numericParts = numericText.split(".");
      const values = compact
        ? [
            ...numericParts.map(Number),
            ...compact[2].split(".").map(Number),
          ]
        : numericParts.map(Number);
      const marked = Boolean(standaloneMarker || compact);
      const kind: VersionExpression["kind"] =
        !marked && numericParts.some((part) => part.length >= 4)
          ? "date"
          : "semantic";

      const previous = expressions.at(-1);
      if (
        kind === "semantic" &&
        !marked &&
        previous?.kind === "date" &&
        numericParts.every((part) => part.length <= 2)
      ) {
        previous.values.push(...values);
      } else {
        expressions.push({
          kind,
          values,
          partTexts: numericParts,
          marked,
          yearless: false,
        });
      }
      if (standaloneMarker) markers.push(standaloneMarker.toLowerCase());

      baseSegment += segment.slice(cursor, matchStart - standaloneMarker.length);
      cursor = matchStart + raw.length;
    }
    baseSegment += segment.slice(cursor);
    baseSegments.push(baseSegment);
  }

  if (expressions.length === 0) return null;

  // A leading-zero month/day pair following a semantic generation is a compact
  // date suffix (for example qwen3.5-plus-02-15), not extra version numbers.
  for (let index = 1; index < expressions.length - 1; index++) {
    const month = expressions[index];
    const day = expressions[index + 1];
    if (
      month.kind === "semantic" &&
      !month.marked &&
      day?.kind === "semantic" &&
      !day.marked &&
      month.values.length === 1 &&
      day.values.length === 1 &&
      month.partTexts[0]?.length === 2 &&
      month.partTexts[0]?.startsWith("0") &&
      day.partTexts[0]?.length === 2
    ) {
      expressions.splice(index, 2, {
        kind: "date",
        values: [...month.values, ...day.values],
        partTexts: [month.partTexts[0], day.partTexts[0]],
        marked: false,
        yearless: true,
      });
    }
  }

  let base = baseSegments
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  if (!base) base = markers[0] ?? "version";

  const semantic = expressions
    .filter((expression) => expression.kind === "semantic")
    .flatMap((expression) => expression.values);
  const dateExpressions = expressions.filter(
    (expression) => expression.kind === "date",
  );
  const dateKeys = dateExpressions.map((expression) =>
    dateKey(expression.values, expression.yearless),
  );
  const hasDate = dateKeys.length > 0;
  const hasYearlessDate = dateExpressions.some((expression) => expression.yearless);
  const versionClass =
    semantic.length > 0
      ? hasDate
        ? hasYearlessDate
          ? "semantic-yearless-date"
          : "semantic-date"
        : "semantic"
      : hasYearlessDate
        ? "yearless-date-only"
        : "date-only";
  const semanticText = semantic.join(".");
  const version = [semanticText, ...dateKeys].filter(Boolean).join("+");

  const markerKey = [...new Set(markers)].sort().join("+");
  return { base, version, semantic, dateKeys, versionClass, markerKey };
}

export function parseModelVersion(
  id: string,
): { base: string; version: string } | null {
  const info = analyzeModelVersion(id);
  return info ? { base: info.base, version: info.version } : null;
}

function compareModelVersionInfo(
  a: ModelVersionInfo,
  b: ModelVersionInfo,
): number {
  const semanticLength = Math.max(a.semantic.length, b.semantic.length);
  for (let index = 0; index < semanticLength; index++) {
    const av = a.semantic[index] ?? 0;
    const bv = b.semantic[index] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }

  const dateLength = Math.max(a.dateKeys.length, b.dateKeys.length);
  for (let index = 0; index < dateLength; index++) {
    const av = a.dateKeys[index] ?? "";
    const bv = b.dateKeys[index] ?? "";
    if (av === bv) continue;
    const width = Math.max(av.length, bv.length);
    const ap = av.padEnd(width, "0");
    const bp = bv.padEnd(width, "0");
    return ap < bp ? -1 : 1;
  }
  return 0;
}

/**
 * Filter a flat array of model definitions.
 * Returns a new array with superseded versions removed.
 *
 * @param models     – model array (each entry must have an `id` field)
 * @param provider   – provider id (e.g. "openrouter", "anthropic")
 * @param keepSet    – fully-qualified "provider/id" strings to always keep
 * @param disabled   – when true, returns the input array unchanged
 */
export function filterSuperseded<T extends { id: string }>(
  models: T[],
  provider: string,
  keepSet: ReadonlySet<string>,
  disabled: boolean,
): T[] {
  if (disabled) return models;
  if (models.length === 0) return models;

  interface Group {
    key: string;
    winner: T;
    winnerVersion: ModelVersionInfo | null;
    members: T[];
  }

  const groups = new Map<string, Group>();

  for (const m of models) {
    const pv = analyzeModelVersion(m.id);
    // Use the provider-qualified normalized family so same-named models from
    // different providers never compete.
    const groupKey = pv
      ? `${provider}:${pv.base}:${pv.versionClass}:${pv.markerKey}`
      : `${provider}:${m.id}::__singleton__`;

    let g = groups.get(groupKey);
    if (!g) {
      g = { key: groupKey, winner: m, winnerVersion: pv, members: [] };
      groups.set(groupKey, g);
    }
    g.members.push(m);

    if (pv) {
      const cmp =
        g.winnerVersion === null
          ? 1
          : compareModelVersionInfo(pv, g.winnerVersion);
      if (cmp > 0) {
        g.winner = m;
        g.winnerVersion = pv;
      }
    }
  }

  const result: T[] = [];
  const included = new Set<T>();

  for (const g of groups.values()) {
    for (const m of g.members) {
      const fq = `${provider}/${m.id}`;
      if (keepSet.has(fq) && !included.has(m)) {
        result.push(m);
        included.add(m);
      }
    }
    if (!included.has(g.winner)) {
      result.push(g.winner);
      included.add(g.winner);
    }
  }

  const orderMap = new Map(models.map((m, i) => [m, i]));
  result.sort((a, b) => (orderMap.get(a) ?? 0) - (orderMap.get(b) ?? 0));
  return result;
}

// ─── Config I/O ─────────────────────────────────────────────────────────────

export function configPathFor(agentDir: string): string {
  return join(agentDir, "stale-model-filter.json");
}

function storedModelIds(agentDir: string, provider: string): string[] {
  try {
    const data = JSON.parse(
      readFileSync(join(agentDir, "models-store.json"), "utf8"),
    ) as Record<string, { models?: Array<{ id?: unknown }> } | undefined>;
    const models = data[provider]?.models;
    return Array.isArray(models)
      ? models
          .map((model) =>
            model && typeof model.id === "string" ? model.id : null
          )
          .filter((id): id is string => id !== null)
      : [];
  } catch {
    return [];
  }
}

function formatModelIds(ids: readonly string[], limit = 40): string {
  if (ids.length === 0) return "none";
  const shown = ids.slice(0, limit).join(", ");
  return `${shown}${ids.length > limit ? `, +${ids.length - limit} more` : ""}`;
}

export function loadConfig(agentDir: string): FilterConfig {
  try {
    const p = configPathFor(agentDir);
    if (!existsSync(p)) return { ...DEFAULT_CONFIG, keep: [] };
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<FilterConfig>;
    return {
      version: 1,
      disabled: raw.disabled ?? false,
      keep: Array.isArray(raw.keep) ? raw.keep : [],
    };
  } catch {
    return { ...DEFAULT_CONFIG, keep: [] };
  }
}

export function saveConfig(agentDir: string, cfg: FilterConfig): void {
  try {
    const p = configPathFor(agentDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cfg, null, 2));
  } catch {
    // non-fatal
  }
}

// ─── Legacy provider-wrapper cleanup ───────────────────────────────────────

type LegacyMarkedProvider = Provider & {
  [PROVIDER_FILTER_MARKER]?: true;
};

function isLegacyMarkedProvider(
  provider: Provider | undefined,
): provider is LegacyMarkedProvider {
  return Boolean(
    (provider as LegacyMarkedProvider | undefined)?.[PROVIDER_FILTER_MARKER],
  );
}

/**
 * Remove native provider wrappers created by v0.2.0-v0.2.4. Those wrappers
 * could interfere with dynamic extension catalogs in long-lived sessions.
 * Current versions filter only the runtime availability methods and never
 * replace provider registrations.
 */
function cleanupLegacyProviderWrappers(
  pi: ExtensionAPI,
  registry: ExtensionContext["modelRegistry"],
): number {
  let removed = 0;
  for (const providerId of registry.getRegisteredProviderIds()) {
    const nativeProvider = registry.getRegisteredNativeProvider(providerId);
    if (!isLegacyMarkedProvider(nativeProvider)) continue;
    try {
      pi.unregisterProvider(providerId);
      removed++;
    } catch (error) {
      console.warn(
        `[pi-stale-model-filter] Could not remove legacy wrapper for "${providerId}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return removed;
}

type ScopedModelEntry = {
  model: { provider: string; id: string };
  thinkingLevel?: string;
};

type ScopedModelState = {
  authoritative: ScopedModelEntry[];
  projection: ScopedModelEntry[] | null;
};

type ScopedModelList = ScopedModelEntry[] & {
  [SCOPED_MODELS_BACKUP]?: ScopedModelEntry[];
  [SCOPED_MODELS_STATE]?: ScopedModelState;
};

function cloneScope(entries: readonly ScopedModelEntry[]): ScopedModelEntry[] {
  return entries.map((entry) => ({ ...entry, model: { ...entry.model } }));
}

function scopeSignature(entries: readonly ScopedModelEntry[]): string {
  return entries
    .map(
      (entry) =>
        `${modelKey(entry.model)}\0${entry.thinkingLevel ?? ""}`,
    )
    .join("\u0001");
}

function readScopeState(scoped: ScopedModelList): ScopedModelState {
  let state = scoped[SCOPED_MODELS_STATE];
  if (!state) {
    const legacyBackup = scoped[SCOPED_MODELS_BACKUP];
    state = {
      authoritative: cloneScope(legacyBackup ?? scoped),
      projection: null,
    };
    Object.defineProperty(scoped, SCOPED_MODELS_STATE, {
      value: state,
      configurable: true,
    });
  }

  // A user scope change replaces or mutates the live list. Once it differs
  // from the last projection, treat the user's current list as authoritative
  // instead of restoring an obsolete startup snapshot.
  if (
    state.projection &&
    scopeSignature(scoped) !== scopeSignature(state.projection)
  ) {
    state.authoritative = cloneScope(scoped);
  }
  return state;
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}\0${model.id}`;
}

function findLatestReplacement(
  current: { provider: string; id: string },
  available: readonly Model<Api>[],
): Model<Api> | undefined {
  const parsed = analyzeModelVersion(current.id);
  if (!parsed) return undefined;

  let winner: Model<Api> | undefined;
  let winnerVersion: ModelVersionInfo | undefined;
  for (const candidate of available) {
    if (candidate.provider !== current.provider) continue;
    const candidateVersion = analyzeModelVersion(candidate.id);
    if (!candidateVersion || candidateVersion.base !== parsed.base) continue;
    if (
      candidateVersion.versionClass !== parsed.versionClass ||
      candidateVersion.markerKey !== parsed.markerKey
    ) {
      continue;
    }
    if (compareModelVersionInfo(candidateVersion, parsed) <= 0) continue;
    if (
      !winnerVersion ||
      compareModelVersionInfo(candidateVersion, winnerVersion) > 0
    ) {
      winner = candidate;
      winnerVersion = candidateVersion;
    }
  }
  return winner;
}

/**
 * Project the current user scope through the availability filter. The state
 * symbol lets us distinguish our own last projection from a later user scope
 * change, so status/inspect/config commands cannot restore an obsolete scope.
 */
export function syncScopedModels(ctx: any, disabled: boolean): void {
  const scoped = ctx.scopedModels as ScopedModelList | undefined;
  if (!scoped) return;

  const state = readScopeState(scoped);
  if (disabled) {
    scoped.splice(0, scoped.length, ...state.authoritative);
    state.projection = cloneScope(scoped);
    return;
  }

  const available = ctx.modelRegistry.getAvailable() as Model<Api>[];
  const availableByKey = new Map(available.map((model) => [modelKey(model), model]));
  const next: ScopedModelEntry[] = [];
  const included = new Set<string>();
  for (const entry of state.authoritative) {
    const originalModel = entry.model;
    const model =
      availableByKey.get(modelKey(originalModel)) ??
      findLatestReplacement(originalModel, available);
    if (!model) continue;
    const key = modelKey(model);
    if (included.has(key)) continue;
    included.add(key);
    next.push({ ...entry, model });
  }
  scoped.splice(0, scoped.length, ...next);
  state.projection = cloneScope(scoped);
}

async function useLatestIfCurrentIsFiltered(
  pi: ExtensionAPI,
  ctx: any,
): Promise<void> {
  const current = ctx.model as Model<Api> | undefined;
  debugLog(`current model at session_start=${current ? `${current.provider}/${current.id}` : "undefined"}`);
  if (!current) return;
  const available = ctx.modelRegistry.getAvailable() as Model<Api>[];
  if (available.some((model) => modelKey(model) === modelKey(current))) return;

  const replacement = findLatestReplacement(current, available);
  debugLog(
    `current ${current.provider}/${current.id} is filtered; replacement=${
      replacement ? `${replacement.provider}/${replacement.id}` : "none"
    }`,
  );
  if (replacement) {
    const changed = await pi.setModel(replacement);
    debugLog(`setModel(${replacement.id}) returned ${changed}`);
  }
}

type AvailabilityModel = { provider: string; id: string };

type RuntimeAvailabilityState = {
  agentDir: string;
  filter: (models: readonly AvailabilityModel[]) => readonly AvailabilityModel[];
  snapshotWrapper: (this: unknown) => readonly AvailabilityModel[];
  availableWrapper: (
    this: unknown,
    providerId?: string,
    options?: unknown,
  ) => Promise<readonly AvailabilityModel[]>;
};

type RuntimeWithAvailability = {
  getAvailableSnapshot(): readonly AvailabilityModel[];
  getAvailable(
    providerId?: string,
    options?: unknown,
  ): Promise<readonly AvailabilityModel[]>;
  [RUNTIME_AVAILABILITY_STATE]?: RuntimeAvailabilityState;
};

function filterAvailableCatalog<T extends AvailabilityModel>(
  models: readonly T[],
  agentDir: string,
): readonly T[] {
  const cfg = loadConfig(agentDir);
  if (cfg.disabled || models.length === 0) return models;

  const grouped = new Map<string, T[]>();
  for (const model of models) {
    const group = grouped.get(model.provider) ?? [];
    group.push(model);
    grouped.set(model.provider, group);
  }

  const included = new Set<T>();
  for (const [provider, providerModels] of grouped) {
    for (const model of filterSuperseded(
      providerModels,
      provider,
      new Set(cfg.keep),
      false,
    )) {
      included.add(model);
    }
  }
  return models.filter((model) => included.has(model));
}

/**
 * Pi's public provider filter works in new runtimes, but some long-lived
 * sessions can retain a pre-reload provider composition. This runtime-level
 * safety net filters the exact availability arrays consumed by /model and
 * Ctrl+P. Access is feature-detected and remains harmless if Pi changes it.
 */
function installRuntimeAvailabilityFilter(
  registry: ExtensionContext["modelRegistry"],
  agentDir: string,
): boolean {
  const runtime = (registry as unknown as { runtime?: RuntimeWithAvailability }).runtime;
  if (
    !runtime ||
    typeof runtime.getAvailableSnapshot !== "function" ||
    typeof runtime.getAvailable !== "function"
  ) {
    return false;
  }

  let state = runtime[RUNTIME_AVAILABILITY_STATE];
  if (!state) {
    const originalSnapshot = runtime.getAvailableSnapshot.bind(runtime);
    const originalAvailable = runtime.getAvailable.bind(runtime);
    const newState = {} as RuntimeAvailabilityState;
    newState.agentDir = agentDir;
    newState.filter = (models) =>
      filterAvailableCatalog(models, newState.agentDir);
    newState.snapshotWrapper = function (this: unknown) {
      return newState.filter(originalSnapshot());
    };
    newState.availableWrapper = async function (
      this: unknown,
      providerId?: string,
      options?: unknown,
    ) {
      return newState.filter(await originalAvailable(providerId, options));
    };
    state = newState;
    runtime.getAvailableSnapshot = newState.snapshotWrapper;
    runtime.getAvailable = newState.availableWrapper;
    Object.defineProperty(runtime, RUNTIME_AVAILABILITY_STATE, {
      value: state,
      configurable: true,
    });
  } else {
    state.agentDir = agentDir;
    // Re-apply if another extension replaced either patched method.
    if (runtime.getAvailableSnapshot !== state.snapshotWrapper) {
      const currentSnapshot = runtime.getAvailableSnapshot.bind(runtime);
      state.snapshotWrapper = function (this: unknown) {
        return state!.filter(currentSnapshot());
      };
      runtime.getAvailableSnapshot = state.snapshotWrapper;
    }
    if (runtime.getAvailable !== state.availableWrapper) {
      const currentAvailable = runtime.getAvailable.bind(runtime);
      state.availableWrapper = async function (
        this: unknown,
        providerId?: string,
        options?: unknown,
      ) {
        return state!.filter(await currentAvailable(providerId, options));
      };
      runtime.getAvailable = state.availableWrapper;
    }
  }
  return true;
}

function catalogStats(
  registry: ExtensionContext["modelRegistry"],
  agentDir: string,
): {
  hidden: number;
  providers: number;
  byProvider: Array<{ provider: string; hidden: number }>;
} {
  const grouped = new Map<string, Model<Api>[]>();
  for (const model of registry.getAll()) {
    const models = grouped.get(model.provider) ?? [];
    models.push(model);
    grouped.set(model.provider, models);
  }

  const cfg = loadConfig(agentDir);
  if (cfg.disabled) return { hidden: 0, providers: 0, byProvider: [] };

  let hidden = 0;
  let providers = 0;
  const byProvider: Array<{ provider: string; hidden: number }> = [];
  for (const [provider, models] of grouped) {
    const filtered = filterSuperseded(
      models,
      provider,
      new Set(cfg.keep),
      false,
    );
    const count = models.length - filtered.length;
    if (count > 0) {
      hidden += count;
      providers++;
      byProvider.push({ provider, hidden: count });
    }
  }
  byProvider.sort(
    (a, b) => b.hidden - a.hidden || a.provider.localeCompare(b.provider),
  );
  return { hidden, providers, byProvider };
}

// ─── Extension entry ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  let cfg: FilterConfig = loadConfig(agentDir);

  const reloadConfig = () => {
    cfg = loadConfig(agentDir);
  };

  const refreshSnapshot = async (ctx: any) => {
    reloadConfig();
    installRuntimeAvailabilityFilter(ctx.modelRegistry, agentDir);
    await ctx.modelRegistry.refresh({ allowNetwork: false });
    syncScopedModels(ctx, cfg.disabled);
    if (!cfg.disabled) await useLatestIfCurrentIsFiltered(pi, ctx);
  };

  // Install after all extensions have registered their providers, then rebuild
  // the available-model snapshot. Provider refreshes continue to flow through
  // filterModels, so stale entries cannot reappear after a catalog refresh.
  pi.on("session_start", async (_event, ctx) => {
    reloadConfig();
    const removedLegacyWrappers = cleanupLegacyProviderWrappers(
      pi,
      ctx.modelRegistry,
    );
    const runtimeFilterInstalled = installRuntimeAvailabilityFilter(
      ctx.modelRegistry,
      agentDir,
    );
    debugLog(
      `session_start removed ${removedLegacyWrappers} legacy provider wrapper(s); runtime filter=${
        runtimeFilterInstalled ? "installed" : "unavailable"
      }`,
    );
    await ctx.modelRegistry.refresh({ allowNetwork: false });
    syncScopedModels(ctx, cfg.disabled);
    if (!cfg.disabled) await useLatestIfCurrentIsFiltered(pi, ctx);
  });

  pi.registerCommand("stale-model-filter", {
    description:
      "Configure stale-model filtering (hide superseded version suffixes from /model)",
    handler: async (args: string, ctx: any) => {
      reloadConfig();
      const action = args.trim();
      const notify = (msg: string, type = "info") => ctx.ui.notify?.(msg, type);

      switch (action.split(/\s+/)[0]) {
        case "":
        case "status": {
          // Status is also a self-healing checkpoint: install/refresh the
          // runtime safety net before reporting what the picker can see.
          const runtimeFilterInstalled = installRuntimeAvailabilityFilter(
            ctx.modelRegistry,
            agentDir,
          );
          await ctx.modelRegistry.refresh({ allowNetwork: false });
          syncScopedModels(ctx, cfg.disabled);
          const available = ctx.modelRegistry.getAvailable() as Model<Api>[];
          const availableProviders = new Set(
            available.map((model) => model.provider),
          ).size;
          const stats = catalogStats(ctx.modelRegistry, agentDir);
          const providerSummary = stats.byProvider.length === 0
            ? "none"
            : stats.byProvider
                .slice(0, 10)
                .map((entry) => `${entry.provider} ${entry.hidden}`)
                .join(", ");
          const keep = cfg.keep.length === 0
            ? "No models explicitly kept."
            : `Kept: ${cfg.keep.slice(0, 12).join(", ")}${
                cfg.keep.length > 12 ? `, +${cfg.keep.length - 12} more` : ""
              }`;
          const hidden = cfg.disabled
            ? "Version filtering is disabled."
            : `Hiding ${stats.hidden} catalog ${stats.hidden === 1 ? "entry" : "entries"} across ${stats.providers} providers.`;
          notify([
            `Stale-model filter v0.3.0: ${cfg.disabled ? "DISABLED" : "active"}`,
            `Runtime safety net: ${runtimeFilterInstalled ? "active" : "unavailable"}`,
            `Available now: ${available.length} models across ${availableProviders} providers.`,
            `Hidden by provider: ${providerSummary}`,
            hidden,
            keep,
          ].join("\n"));
          break;
        }
        case "inspect": {
          const provider = action.slice("inspect".length).trim();
          if (!provider) {
            notify("Usage: /stale-model-filter inspect <provider>", "warn");
            break;
          }
          installRuntimeAvailabilityFilter(ctx.modelRegistry, agentDir);
          await ctx.modelRegistry.refresh({
            providers: [provider],
            allowNetwork: false,
          });
          syncScopedModels(ctx, cfg.disabled);

          const stored = storedModelIds(agentDir, provider);
          const catalog = ctx.modelRegistry
            .getAll()
            .filter((model: Model<Api>) => model.provider === provider)
            .map((model: Model<Api>) => model.id);
          const available = (ctx.modelRegistry.getAvailable() as Model<Api>[])
            .filter((model) => model.provider === provider)
            .map((model) => model.id);
          const availableSet = new Set(available);
          const filtered = catalog.filter((id: string) => !availableSet.has(id));
          const catalogSet = new Set(catalog);
          const missingAtRuntime = stored.filter((id: string) => !catalogSet.has(id));

          notify([
            `Provider: ${provider}`,
            `Store (${stored.length}): ${formatModelIds(stored)}`,
            `Runtime catalog (${catalog.length}): ${formatModelIds(catalog)}`,
            `Available (${available.length}): ${formatModelIds(available)}`,
            `Filtered as stale (${filtered.length}): ${formatModelIds(filtered)}`,
            `Stored but absent from runtime (${missingAtRuntime.length}): ${formatModelIds(missingAtRuntime)}`,
          ].join("\n"));
          break;
        }
        case "enable": {
          cfg.disabled = false;
          saveConfig(agentDir, cfg);
          await refreshSnapshot(ctx);
          notify("stale-model-filter: enabled and applied.");
          break;
        }
        case "disable": {
          cfg.disabled = true;
          saveConfig(agentDir, cfg);
          await refreshSnapshot(ctx);
          notify("stale-model-filter: disabled and applied.");
          break;
        }
        case "keep": {
          const id = action.slice(5).trim();
          if (!id) {
            notify("Usage: /stale-model-filter keep <provider/model-id>", "warn");
            break;
          }
          if (!cfg.keep.includes(id)) cfg.keep.push(id);
          saveConfig(agentDir, cfg);
          await refreshSnapshot(ctx);
          notify(`stale-model-filter: keeping ${id} and applied.`);
          break;
        }
        case "unkeep": {
          const id = action.slice(7).trim();
          if (!id) {
            notify("Usage: /stale-model-filter unkeep <provider/model-id>", "warn");
            break;
          }
          cfg.keep = cfg.keep.filter((k) => k !== id);
          saveConfig(agentDir, cfg);
          await refreshSnapshot(ctx);
          notify(`stale-model-filter: released ${id} and applied.`);
          break;
        }
        default:
          notify(
            [
              "Usage:",
              "  /stale-model-filter status",
              "  /stale-model-filter inspect <provider>",
              "  /stale-model-filter enable | disable",
              "  /stale-model-filter keep <provider/model-id>",
              "  /stale-model-filter unkeep <provider/model-id>",
            ].join("\n"),
            "warn",
          );
      }
    },
  });
}

