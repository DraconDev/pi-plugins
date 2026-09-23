/**
 * Pure model-version filtering logic — no pi or node:fs dependencies.
 * Provider-owning extensions import from here so they can be tested
 * under a bare-node harness with no pi installation.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface FilterConfig {
  version: 1;
  disabled: boolean;
  /** "provider/model-id" entries that must survive filtering. */
  keep: string[];
}

export const DEFAULT_CONFIG: FilterConfig = { version: 1, disabled: false, keep: [] };

export type ModelDef = Record<string, unknown> & { id: string; name?: string };
export type RefreshModelsFn = (ctx: unknown) => Promise<ModelDef[] | undefined | null>;

// ─── Version parsing ────────────────────────────────────────────────────────

/**
 * Extract the version token from a model id.
 *
 *   "agnes-2.0"         → base "agnes",         version "2.0"
 *   "claude-sonnet-4-5" → base "claude-sonnet", version "4.5"
 *   "gpt-5.5"           → base "gpt",           version "5.5"
 *   "my-model"          → null
 *
 * A model is versioned when its id ends in a run of purely numeric
 * hyphen-separated segments (plain integers) or a trailing dotted
 * numeric token. The base is everything before that run; the version
 * is the run joined with ".".
 */
export function splitVersion(
  id: string,
): { base: string; version: string } | null {
  const parts = id.split("-");
  if (parts.length < 2) return null;

  let i = parts.length - 1;
  const last = parts[i];
  let isIntegerRunStart: number;

  if (/^\d+$/.test(last)) {
    isIntegerRunStart = i;
    while (isIntegerRunStart > 0 && /^\d+$/.test(parts[isIntegerRunStart - 1])) {
      isIntegerRunStart--;
    }
  } else if (/^\d+\.\d+$/.test(last)) {
    isIntegerRunStart = i;
  } else {
    return null; // trailing non-numeric qualifier → not a version token
  }

  const base = parts.slice(0, isIntegerRunStart).join("-");
  if (!base) return null;
  const version = parts.slice(isIntegerRunStart).join(".");
  return { base, version };
}

/** Compare two dot-separated version strings numerically. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number(s) || 0);
  const pb = b.split(".").map((s) => Number(s) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

// ─── Core filter ────────────────────────────────────────────────────────────

/**
 * Filter a flat array of model definitions. Within each
 * provider:base group only the numerically highest version survives.
 * `keepSet` contains fully-qualified "provider/id" strings that must
 * always survive. Returns the input array unchanged when `disabled`.
 */
export function filterModelList(
  models: ModelDef[],
  provider: string,
  keepSet: ReadonlySet<string>,
  disabled: boolean,
): ModelDef[] {
  if (disabled) return models;
  if (models.length === 0) return models;

  interface Group {
    key: string;
    winner: ModelDef;
    winnerVersion: string | null;
    members: ModelDef[];
  }

  const groups = new Map<string, Group>();

  for (const m of models) {
    const sv = splitVersion(m.id);
    const groupKey = sv ? `${provider}:${sv.base}` : `${provider}:${m.id}::__singleton__`;

    let g = groups.get(groupKey);
    if (!g) {
      g = { key: groupKey, winner: m, winnerVersion: sv?.version ?? null, members: [] };
      groups.set(groupKey, g);
    }
    g.members.push(m);

    if (sv) {
      const cmp = g.winnerVersion === null ? 1 : compareVersions(sv.version, g.winnerVersion);
      if (cmp > 0) {
        g.winner = m;
        g.winnerVersion = sv.version;
      }
    }
  }

  const result: ModelDef[] = [];
  const included = new Set<ModelDef>();

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
