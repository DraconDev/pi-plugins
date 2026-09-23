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

function parseModelVersion(id) {
  const parts = id.split("-");
  if (parts.length < 2) return null;

  const isNumSeg = (s) => /^\d+$/.test(s) || /^\d+(\.\d+)+$/.test(s);

  let end = parts.length;
  while (end > 0 && !isNumSeg(parts[end - 1])) end--;
  if (end === 0) return null;

  let start = end;
  while (start > 0 && isNumSeg(parts[start - 1])) start--;

  const base = [...parts.slice(0, start), ...parts.slice(end)].join("-");
  if (!base) return null;
  const version = parts.slice(start, end).join(".");
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

function filterSuperseded(models, provider, keepSet, disabled) {
  if (disabled) return models;
  if (models.length === 0) return models;

  const groups = new Map();

  for (const m of models) {
    const pv = parseModelVersion(m.id);
    const groupKey = pv
      ? `${provider}:${pv.base}`
      : `${provider}:${m.id}::__singleton__`;

    let g = groups.get(groupKey);
    if (!g) {
      g = { key: groupKey, winner: m, winnerVersion: pv?.version ?? null, members: [] };
      groups.set(groupKey, g);
    }
    g.members.push(m);

    if (pv) {
      const cmp = g.winnerVersion === null ? 1 : compareVersions(pv.version, g.winnerVersion);
      if (cmp > 0) {
        g.winner = m;
        g.winnerVersion = pv.version;
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

test("parseModelVersion: 'llama3-8b-instruct' → null (no numeric suffix)", () => {
  assert.equal(parseModelVersion("llama3-8b-instruct"), null);
});

test("parseModelVersion: 'my-model' → null", () => {
  assert.equal(parseModelVersion("my-model"), null);
});

test("parseModelVersion: 'agnes-3' → base 'agnes', version '3'", () => {
  assert.deepEqual(parseModelVersion("agnes-3"), { base: "agnes", version: "3" });
});

test("parseModelVersion: 'qwen-2.5-coder' → null (trailing non-numeric qualifier)", () => {
  assert.equal(parseModelVersion("qwen-2.5-coder"), null);
});

// ─── compareVersions tests ──────────────────────────────────────────────────

test("compareVersions: 3.0 > 2.0", () => {
  assert.ok(compareVersions("3.0", "2.0") > 0);
});

test("compareVersions: 5 == 5", () => {
  assert.equal(compareVersions("5", "5"), 0);
});

test("compareVersions: 4.5 < 5", () => {
  assert.ok(compareVersions("4.5", "5") < 0);
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
