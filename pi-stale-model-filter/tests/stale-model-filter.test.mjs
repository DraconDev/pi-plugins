/**
 * Unit tests for pi-stale-model-filter pure logic.
 * Run: node --test tests/*.test.mjs
 *
 * The version-parsing and filtering logic is mirrored here so the suite
 * runs under a bare node harness with no TypeScript tooling or pi
 * installation. Keep in sync with extensions/stale-model-filter.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Mirrored from extensions/stale-model-filter.ts ───────────────────────

function dateKey(values, yearless) {
  if (yearless) return values.map((value) => String(value).padStart(2, "0")).join("");
  return values
    .map((value, index) =>
      index === 0 ? String(value).padStart(4, "0") : String(value).padStart(2, "0"),
    )
    .join("");
}

function analyzeModelVersion(id) {
  const expressions = [];
  const baseSegments = [];
  const markers = [];

  for (const segment of id.split("-")) {
    if (/^q\d+(?:_[a-z0-9]+)*$/i.test(segment)) {
      baseSegments.push(segment);
      continue;
    }
    let baseSegment = "";
    let cursor = 0;
    const matches = segment.matchAll(/\d+(?:\.\d+)*(?:[pP]\d+(?:\.\d+)*)?/g);
    for (const match of matches) {
      const raw = match[0];
      const matchStart = match.index ?? cursor;
      const after = segment[matchStart + raw.length] ?? "";
      const before = segment[matchStart - 1] ?? "";
      const prefix = segment.slice(0, matchStart);
      const standaloneMarker = prefix.length === 1 && /^[A-Za-z]$/.test(prefix) ? prefix : "";
      if (/[A-Za-z]/.test(after) && after.toLowerCase() !== "o") continue;
      if (!standaloneMarker && before === ":") continue;
      const compact = /^(\d+(?:\.\d+)*)[pP](\d+(?:\.\d+)*)$/.exec(raw);
      const numericText = compact ? compact[1] : raw;
      const numericParts = numericText.split(".");
      const values = compact
        ? [...numericParts.map(Number), ...compact[2].split(".").map(Number)]
        : numericParts.map(Number);
      const marked = Boolean(standaloneMarker || compact);
      const kind = !marked && numericParts.some((part) => part.length >= 4) ? "date" : "semantic";
      const previous = expressions.at(-1);
      if (kind === "semantic" && !marked && previous?.kind === "date" && numericParts.every((part) => part.length <= 2)) {
        previous.values.push(...values);
      } else {
        expressions.push({ kind, values, partTexts: numericParts, marked, yearless: false });
      }
      if (standaloneMarker) markers.push(standaloneMarker.toLowerCase());
      baseSegment += segment.slice(cursor, matchStart - standaloneMarker.length);
      cursor = matchStart + raw.length;
    }
    baseSegment += segment.slice(cursor);
    baseSegments.push(baseSegment);
  }

  if (expressions.length === 0) return null;
  for (let index = 1; index < expressions.length - 1; index++) {
    const month = expressions[index];
    const day = expressions[index + 1];
    if (month.kind === "semantic" && !month.marked && day?.kind === "semantic" && !day.marked && month.values.length === 1 && day.values.length === 1 && month.partTexts[0]?.length === 2 && month.partTexts[0]?.startsWith("0") && day.partTexts[0]?.length === 2) {
      expressions.splice(index, 2, {
        kind: "date",
        values: [...month.values, ...day.values],
        partTexts: [month.partTexts[0], day.partTexts[0]],
        marked: false,
        yearless: true,
      });
    }
  }
  let base = baseSegments.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  if (!base) base = markers[0] ?? "version";
  const semantic = expressions.filter((expression) => expression.kind === "semantic").flatMap((expression) => expression.values);
  const dateExpressions = expressions.filter((expression) => expression.kind === "date");
  const dateKeys = dateExpressions.map((expression) => dateKey(expression.values, expression.yearless));
  const hasDate = dateKeys.length > 0;
  const hasYearlessDate = dateExpressions.some((expression) => expression.yearless);
  const versionClass = semantic.length > 0
    ? hasDate
      ? hasYearlessDate ? "semantic-yearless-date" : "semantic-date"
      : "semantic"
    : hasYearlessDate ? "yearless-date-only" : "date-only";
  const semanticText = semantic.join(".");
  const version = [semanticText, ...dateKeys].filter(Boolean).join("+");
  const markerKey = [...new Set(markers)].sort().join("+");
  return { base, version, semantic, dateKeys, versionClass, markerKey };
}

function parseModelVersion(id) {
  const info = analyzeModelVersion(id);
  return info ? { base: info.base, version: info.version } : null;
}

function compareModelVersionInfo(a, b) {
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

function filterSuperseded(models, provider, keepSet, disabled) {
  if (disabled) return models;
  if (models.length === 0) return models;

  const groups = new Map();

  for (const m of models) {
    const pv = analyzeModelVersion(m.id);
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
      const cmp = g.winnerVersion === null ? 1 : compareModelVersionInfo(pv, g.winnerVersion);
      if (cmp > 0) {
        g.winner = m;
        g.winnerVersion = pv;
      }
    }
  }

  const result = [];
  const included = new Set();

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

// ─── parseModelVersion tests ────────────────────────────────────────────────

test("parseModelVersion: 'agnes-2.0-flash' → base 'agnes-flash', version '2.0'", () => {
  assert.deepEqual(parseModelVersion("agnes-2.0-flash"), { base: "agnes-flash", version: "2.0" });
});

test("parseModelVersion: 'agnes-3.0-flash' → base 'agnes-flash', version '3.0'", () => {
  assert.deepEqual(parseModelVersion("agnes-3.0-flash"), { base: "agnes-flash", version: "3.0" });
});

test("parseModelVersion: 'gpt-5.5' → base 'gpt', version '5.5'", () => {
  assert.deepEqual(parseModelVersion("gpt-5.5"), { base: "gpt", version: "5.5" });
});

test("parseModelVersion: 'claude-sonnet-4-5' → base 'claude-sonnet', version '4.5'", () => {
  assert.deepEqual(parseModelVersion("claude-sonnet-4-5"), { base: "claude-sonnet", version: "4.5" });
});

test("parseModelVersion: embedded generations and size suffixes stay separated", () => {
  assert.deepEqual(parseModelVersion("llama3-8b-instruct"), {
    base: "llama-8b-instruct",
    version: "3",
  });
});

test("parseModelVersion: size suffixes stay in the family base", () => {
  assert.deepEqual(parseModelVersion("llama-3-8b"), { base: "llama-8b", version: "3" });
  assert.deepEqual(parseModelVersion("llama-3-70b"), { base: "llama-70b", version: "3" });
});

test("parseModelVersion: 'my-model' → null", () => {
  assert.equal(parseModelVersion("my-model"), null);
});

test("parseModelVersion: 'agnes-3' → base 'agnes', version '3'", () => {
  assert.deepEqual(parseModelVersion("agnes-3"), { base: "agnes", version: "3" });
});

test("parseModelVersion: 'qwen-2.5-coder' → base 'qwen-coder', version '2.5'", () => {
  assert.deepEqual(parseModelVersion("qwen-2.5-coder"), { base: "qwen-coder", version: "2.5" });
});

test("parseModelVersion: marked MiniMax versions normalize to numeric versions", () => {
  assert.deepEqual(parseModelVersion("MiniMax-M2.7"), { base: "minimax", version: "2.7" });
  assert.deepEqual(parseModelVersion("accounts/fireworks/models/minimax-m2p7"), {
    base: "accounts/fireworks/models/minimax",
    version: "2.7",
  });
});

test("parseModelVersion: K, o, and V version markers remain in the family name", () => {
  assert.deepEqual(parseModelVersion("kimi-k2.7-code"), { base: "kimi-code", version: "2.7" });
  assert.deepEqual(parseModelVersion("o1"), { base: "o", version: "1" });
  assert.deepEqual(parseModelVersion("o3-mini"), { base: "mini", version: "3" });
  assert.deepEqual(parseModelVersion("DeepSeek-V4.1-Flash"), { base: "deepseek-flash", version: "4.1" });
});

test("parseModelVersion: compact month/day suffixes remain dates after product versions", () => {
  assert.deepEqual(parseModelVersion("qwen/qwen3.5-plus-02-15"), {
    base: "qwen/qwen-plus",
    version: "3.5+0215",
  });
});

test("parseModelVersion: quantization suffixes are immutable qualifiers", () => {
  assert.deepEqual(parseModelVersion("qwen2.5-7b-q4_k_m"), {
    base: "qwen-7b-q4_k_m",
    version: "2.5",
  });
  assert.deepEqual(parseModelVersion("qwen2.5-7b-q5_k_m"), {
    base: "qwen-7b-q5_k_m",
    version: "2.5",
  });
});

test("parseModelVersion: dated snapshots share a family and ordered date version", () => {
  assert.deepEqual(parseModelVersion("openai/gpt-4o-2024-05-13"), {
    base: "openai/gpt-o",
    version: "4+20240513",
  });
});

// ─── filterSuperseded tests ────────────────────────────────────────────────

test("filterSuperseded: agnes flash group keeps only 3.0", () => {
  const models = [
    { id: "agnes-2.0-flash" },
    { id: "agnes-3.0-flash" },
    { id: "agnes-2.5-pro" },
  ];
  const result = filterSuperseded(models, "agnes", new Set(), false);
  const ids = result.map((m) => m.id);
  assert.ok(ids.includes("agnes-3.0-flash"), "3.0-flash survives");
  assert.ok(!ids.includes("agnes-2.0-flash"), "2.0-flash is filtered");
  assert.ok(ids.includes("agnes-2.5-pro"), "singleton (no competing version) survives");
});

test("filterSuperseded: flash and pro are separate variant families", () => {
  const models = [
    { id: "agnes-3.0-flash" },
    { id: "agnes-2.0-pro" },
  ];
  const ids = filterSuperseded(models, "agnes", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["agnes-3.0-flash", "agnes-2.0-pro"]);
});

test("filterSuperseded: embedded product generations share a normalized family", () => {
  const models = [
    { id: "qwen/qwen3.5-plus" },
    { id: "qwen/qwen3.6-plus" },
    { id: "qwen/qwen3.6-flash" },
  ];
  const ids = filterSuperseded(models, "openrouter", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["qwen/qwen3.6-plus", "qwen/qwen3.6-flash"]);
});

test("filterSuperseded: bare marked families such as o1/o3 are filtered", () => {
  const models = [{ id: "o1" }, { id: "o3" }, { id: "o4-mini" }];
  const ids = filterSuperseded(models, "openai", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["o3", "o4-mini"]);
});

test("filterSuperseded: multiple markers compare as an ordered version vector", () => {
  const models = [
    { id: "writer.palmyra-x4-v1:0" },
    { id: "writer.palmyra-x5-v1:0" },
    { id: "writer.palmyra-x5-v2:0" },
  ];
  const ids = filterSuperseded(models, "amazon-bedrock", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["writer.palmyra-x5-v2:0"]);
});

test("filterSuperseded: different version marker families are independent", () => {
  const models = [
    { id: "deepseek-r1" },
    { id: "deepseek-v3.1" },
    { id: "deepseek-v3.2" },
  ];
  const ids = filterSuperseded(models, "openrouter", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["deepseek-r1", "deepseek-v3.2"]);
});

test("filterSuperseded: quantization variants are not treated as generations", () => {
  const models = [
    { id: "qwen2.5-7b-q4_k_m" },
    { id: "qwen2.5-7b-q5_k_m" },
  ];
  const ids = filterSuperseded(models, "openrouter", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["qwen2.5-7b-q4_k_m", "qwen2.5-7b-q5_k_m"]);
});

test("filterSuperseded: compact dated aliases do not hide newer semantic products", () => {
  const models = [
    { id: "qwen3.5-flash-02-23" },
    { id: "qwen3.6-flash" },
    { id: "qwen3.8-flash" },
  ];
  const ids = filterSuperseded(models, "openrouter", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["qwen3.5-flash-02-23", "qwen3.8-flash"]);
});

test("filterSuperseded: only older versions of the same MiniMax family are removed", () => {
  const models = [
    { id: "minimax/minimax-m1" },
    { id: "minimax/minimax-m2" },
    { id: "minimax/minimax-m2.1" },
    { id: "minimax/minimax-m2.5" },
    { id: "minimax/minimax-m2.7" },
    { id: "minimax/minimax-m3" },
    { id: "minimax/minimax-m2.7-highspeed" },
  ];
  const ids = filterSuperseded(models, "openrouter", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["minimax/minimax-m3", "minimax/minimax-m2.7-highspeed"]);
});

test("filterSuperseded: compact MxPy MiniMax versions compare with M3", () => {
  const models = [
    { id: "accounts/fireworks/models/minimax-m2p7" },
    { id: "accounts/fireworks/models/minimax-m3" },
  ];
  const ids = filterSuperseded(models, "fireworks", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["accounts/fireworks/models/minimax-m3"]);
});

test("filterSuperseded: compact multi-digit versions compare numerically", () => {
  const models = [
    { id: "model-m2p9" },
    { id: "model-m2p11" },
  ];
  const ids = filterSuperseded(models, "generic", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["model-m2p11"]);
});

test("filterSuperseded: version comparison stays inside the pro family", () => {
  const models = [
    { id: "agnes-3.0-flash" },
    { id: "agnes-1.0-pro" },
    { id: "agnes-2.0-pro" },
  ];
  const ids = filterSuperseded(models, "agnes", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["agnes-3.0-flash", "agnes-2.0-pro"]);
});

test("filterSuperseded: model sizes remain separate families", () => {
  const models = [
    { id: "llama-3-8b" },
    { id: "llama-4-8b" },
    { id: "llama-3-70b" },
  ];
  const ids = filterSuperseded(models, "meta", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["llama-4-8b", "llama-3-70b"]);
});

test("filterSuperseded: disabled passes everything through", () => {
  const models = [{ id: "a-1.0" }, { id: "a-2.0" }];
  assert.equal(filterSuperseded(models, "p", new Set(), true).length, 2);
});

test("filterSuperseded: keep list protects an older version", () => {
  const models = [{ id: "a-1.0" }, { id: "a-2.0" }];
  const keep = new Set(["p/a-1.0"]);
  const result = filterSuperseded(models, "p", keep, false);
  const ids = result.map((m) => m.id);
  assert.ok(ids.includes("a-1.0"), "kept model survives");
  assert.ok(ids.includes("a-2.0"), "winner also survives");
  assert.equal(result.length, 2);
});

test("filterSuperseded: single-version group keeps the model", () => {
  const models = [{ id: "agnes-3.0" }];
  const result = filterSuperseded(models, "agnes", new Set(), false);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "agnes-3.0");
});

test("filterSuperseded: preserves original relative order", () => {
  const models = [{ id: "b-1" }, { id: "a-2" }, { id: "a-1" }];
  const result = filterSuperseded(models, "p", new Set(), false);
  assert.deepEqual(result.map((m) => m.id), ["b-1", "a-2"]);
});

test("filterSuperseded: empty input returns empty output", () => {
  assert.deepEqual(filterSuperseded([], "p", new Set(), false), []);
});

test("filterSuperseded: stable aliases remain beside the latest dated snapshot", () => {
  const models = [
    { id: "gpt-4o" },
    { id: "gpt-4o-2024-05-13" },
    { id: "gpt-4o-2024-08-06" },
    { id: "gpt-4o-2024-11-20" },
  ];
  const ids = filterSuperseded(models, "openrouter", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["gpt-4o", "gpt-4o-2024-11-20"]);
});

test("filterSuperseded: dated snapshots keep only the latest date", () => {
  const models = [
    { id: "openai/gpt-4o-2024-05-13" },
    { id: "openai/gpt-4o-2024-08-06" },
    { id: "openai/gpt-4o-2024-11-20" },
  ];
  const ids = filterSuperseded(models, "openrouter", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["openai/gpt-4o-2024-11-20"]);
});

test("filterSuperseded: checkpoint versions compare semantic version before date", () => {
  const models = [
    { id: "anthropic.claude-sonnet-4-20250514-v1:0" },
    { id: "anthropic.claude-sonnet-4-5-20250929-v1:0" },
  ];
  const ids = filterSuperseded(models, "amazon-bedrock", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["anthropic.claude-sonnet-4-5-20250929-v1:0"]);
});

test("filterSuperseded: semantic aliases and dated snapshots remain separate", () => {
  const models = [
    { id: "mistral-medium-3.5" },
    { id: "mistral-medium-2505" },
    { id: "mistral-medium-2604" },
  ];
  const ids = filterSuperseded(models, "mistral", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["mistral-medium-3.5", "mistral-medium-2604"]);
});

test("filterSuperseded: compact and semantic date forms are not guessed together", () => {
  const models = [
    { id: "qwen/qwen3.5-plus-02-15" },
    { id: "qwen/qwen3.5-plus-20260420" },
  ];
  const ids = filterSuperseded(models, "openrouter", new Set(), false).map((m) => m.id);
  assert.deepEqual(ids, ["qwen/qwen3.5-plus-02-15", "qwen/qwen3.5-plus-20260420"]);
});

test("filterSuperseded: identical ids in separate providers do not compete", () => {
  const models = [{ id: "shared-1.0" }, { id: "shared-2.0" }];
  assert.deepEqual(
    filterSuperseded(models, "provider-a", new Set(), false).map((m) => m.id),
    ["shared-2.0"],
  );
  assert.deepEqual(
    filterSuperseded(models, "provider-b", new Set(), false).map((m) => m.id),
    ["shared-2.0"],
  );
});

test("filterSuperseded: openrouter-style ids with slashes in base", () => {
  // openrouter ids use slashes: "anthropic/claude-opus-4.7"
  const models = [
    { id: "anthropic/claude-opus-4.7" },
    { id: "anthropic/claude-opus-4.8" },
  ];
  // These have no hyphen-dotted-suffix at the end of the *id*, so the
  // splitter sees "anthropic/claude-opus-4.7" → parts ["anthropic/claude", "opus", "4.7"]
  // base = "anthropic/claude-opus", version "4.7"
  const pv = parseModelVersion("anthropic/claude-opus-4.7");
  assert.equal(pv?.base, "anthropic/claude-opus");
  assert.equal(pv?.version, "4.7");

  const result = filterSuperseded(models, "openrouter", new Set(), false);
  const ids = result.map((m) => m.id);
  assert.ok(ids.includes("anthropic/claude-opus-4.8"));
  assert.ok(!ids.includes("anthropic/claude-opus-4.7"));
});
