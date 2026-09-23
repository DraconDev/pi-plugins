/**
 * Unit tests for pi-model-filter version-parsing and list-filtering logic.
 * Run with: node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Inline the same functions under test (extracted as pure JS so the
// test suite has no runtime dependency on pi or TypeScript tooling).

function splitVersion(id) {
  const parts = id.split("-");
  if (parts.length < 2) return null;

  const last = parts[parts.length - 1];
  let start;

  if (/^\d+(\.\d+)*$/.test(last)) {
    start = parts.length - 1;
    if (start > 0) {
      const prev = parts[start - 1];
      if (/^\d$/.test(prev) && /^\d$/.test(last)) {
        start = parts.length - 2;
      }
    }
  } else {
    return null;
  }

  if (start === parts.length) return null;
  const base = parts.slice(0, start).join("-");
  const version = parts.slice(start).join(".");
  if (!base) return null;
  return { base, version };
}

function compareVersions(a, b) {
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

function filterModelList(models, provider, keepSet, disabled) {
  if (disabled) return models;
  if (models.length === 0) return models;

  const groups = new Map();

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

// ─── splitVersion tests ──────────────────────────────────────────────────

test("splitVersion: 'agnes-2.0' → base 'agnes', version '2.0'", () => {
  assert.deepEqual(splitVersion("agnes-2.0"), { base: "agnes", version: "2.0" });
});

test("splitVersion: 'gpt-5.5' → base 'gpt', version '5.5'", () => {
  assert.deepEqual(splitVersion("gpt-5.5"), { base: "gpt", version: "5.5" });
});

test("splitVersion: 'claude-sonnet-4-5' → base 'claude-sonnet', version '4.5'", () => {
  assert.deepEqual(splitVersion("claude-sonnet-4-5"), { base: "claude-sonnet", version: "4.5" });
});

test("splitVersion: 'my-model' (no version) → null", () => {
  assert.equal(splitVersion("my-model"), null);
});

test("splitVersion: 'gpt' (single segment) → null", () => {
  assert.equal(splitVersion("gpt"), null);
});

test("splitVersion: 'agnes-3' → base 'agnes', version '3'", () => {
  assert.deepEqual(splitVersion("agnes-3"), { base: "agnes", version: "3" });
});

test("splitVersion: 'agnes-2.5-flash' → null (trailing non-numeric segment)", () => {
  // The version regex requires the LAST segment to be numeric.
  // "flash" is not numeric → no version detected → null.
  assert.equal(splitVersion("agnes-2.5-flash"), null);
});

test("compareVersions: 2.5 > 2.0", () => {
  assert.ok(compareVersions("2.5", "2.0") > 0);
});

test("compareVersions: 3 > 2.9", () => {
  assert.ok(compareVersions("3", "2.9") > 0);
});

test("compareVersions: 4.5 == 4.5", () => {
  assert.equal(compareVersions("4.5", "4.5"), 0);
});

test("compareVersions: 4.5 < 5", () => {
  assert.ok(compareVersions("4.5", "5") < 0);
});

// ─── filterModelList tests ───────────────────────────────────────────────

test("filterModelList: keeps highest version per base group", () => {
  const models = [
    { id: "agnes-2.0" },
    { id: "agnes-2.5" },
    { id: "agnes-3.0" },
    { id: "other-model" },
  ];
  const result = filterModelList(models, "agnes", new Set(), false);
  const ids = result.map((m) => m.id);
  assert.ok(ids.includes("agnes-3.0"), "should keep highest version");
  assert.ok(!ids.includes("agnes-2.0"), "should drop older version");
  assert.ok(!ids.includes("agnes-2.5"), "should drop middle version");
  assert.ok(ids.includes("other-model"), "models without versions are kept");
});

test("filterModelList: disabled passes everything through", () => {
  const models = [{ id: "a-1" }, { id: "a-2" }];
  const result = filterModelList(models, "p", new Set(), true);
  assert.equal(result.length, 2);
});

test("filterModelList: keep list protects an older version", () => {
  const models = [{ id: "a-1" }, { id: "a-2" }];
  const keep = new Set(["p/a-1"]);
  const result = filterModelList(models, "p", keep, false);
  const ids = result.map((m) => m.id);
  assert.ok(ids.includes("a-1"), "kept model survives");
  assert.ok(ids.includes("a-2"), "winner also survives");
  assert.equal(result.length, 2);
});

test("filterModelList: single-version group keeps the model", () => {
  const models = [{ id: "agnes-2.5" }];
  const result = filterModelList(models, "agnes", new Set(), false);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "agnes-2.5");
});

test("filterModelList: preserves original relative order", () => {
  const models = [{ id: "b-1" }, { id: "a-2" }, { id: "a-1" }];
  const result = filterModelList(models, "p", new Set(), false);
  const ids = result.map((m) => m.id);
  assert.deepEqual(ids, ["b-1", "a-2"]);
});

test("filterModelList: empty input returns empty output", () => {
  assert.deepEqual(filterModelList([], "p", new Set(), false), []);
});
