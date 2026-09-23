/**
 * Integration test: patchPi() interception of registerProvider /
 * registerNativeProvider.
 * Run with: node --test tests/
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
// Register the jiti hook so .ts imports work under plain node.
// jiti is bundled with pi; for standalone tests we shim via a loader.
// Simpler: import the TS source through a tiny transpile step.

// ─── We can't easily import the .ts directly without jiti, so we
// ─── duplicate patchPi's behavior via a dynamic import through a
// ─── pre-transpiled CJS build. For now, mirror the pure interception
// ─── logic and test it against a fake pi object.

function splitVersion(id) {
  const parts = id.split("-");
  if (parts.length < 2) return null;
  let i = parts.length - 1;
  const last = parts[i];
  let isIntegerRunStart;
  if (/^\d+$/.test(last)) {
    isIntegerRunStart = i;
    while (isIntegerRunStart > 0 && /^\d+$/.test(parts[isIntegerRunStart - 1])) {
      isIntegerRunStart--;
    }
  } else if (/^\d+\.\d+$/.test(last)) {
    isIntegerRunStart = i;
  } else {
    return null;
  }
  const base = parts.slice(0, isIntegerRunStart).join("-");
  if (!base) return null;
  return { base, version: parts.slice(isIntegerRunStart).join(".") };
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

// ─── Mirror of patchPi from the extension source ───────────────────────

function patchPi(pi, getCfg) {
  const anyPi = pi;
  if (anyPi.__modelFilterPatched) return;
  anyPi.__modelFilterPatched = true;

  const originalRegisterProvider = pi.registerProvider.bind(pi);
  const originalRegisterNative =
    typeof pi.registerNativeProvider === "function"
      ? pi.registerNativeProvider.bind(pi)
      : undefined;

  pi.registerProvider = (providerOrName, config) => {
    const providerName =
      typeof providerOrName === "string"
        ? providerOrName
        : providerOrName?.id ?? "unknown";

    if (typeof providerOrName === "string" && config !== undefined) {
      const c = { ...config };
      const cfg = getCfg();
      if (Array.isArray(c.models)) {
        c.models = filterModelList(c.models, providerName, new Set(cfg.keep), cfg.disabled);
      }
      if (typeof c.refreshModels === "function") {
        const originalRefresh = c.refreshModels;
        c.refreshModels = async (ctx) => {
          const result = await originalRefresh(ctx);
          if (!result) return result;
          const cfgNow = getCfg();
          return filterModelList(result, providerName, new Set(cfgNow.keep), cfgNow.disabled);
        };
      }
      return originalRegisterProvider(providerOrName, c);
    }

    const p = providerOrName;
    if (p && typeof p.getModels === "function") {
      const wrapped = { ...p };
      const originalGetModels = p.getModels.bind(p);
      wrapped.getModels = () => {
        const models = originalGetModels();
        const cfg = getCfg();
        return filterModelList(models, providerName, new Set(cfg.keep), cfg.disabled);
      };
      return originalRegisterProvider(wrapped);
    }

    return originalRegisterProvider(providerOrName, config);
  };

  if (originalRegisterNative) {
    pi.registerNativeProvider = (provider) => {
      const p = provider;
      const providerName = p?.id ?? "unknown";
      if (p && typeof p.getModels === "function") {
        const wrapped = { ...p };
        const originalGetModels = p.getModels.bind(p);
        wrapped.getModels = () => {
          const models = originalGetModels();
          const cfg = getCfg();
          return filterModelList(models, providerName, new Set(cfg.keep), cfg.disabled);
        };
        return originalRegisterNative(wrapped);
      }
      return originalRegisterNative(provider);
    };
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

function makeFakePi() {
  const calls = [];
  return {
    calls,
    registerProvider(name, config) {
      calls.push({ type: "legacy", name, config });
    },
    registerNativeProvider(provider) {
      calls.push({ type: "native", provider });
    },
  };
}

test("patchPi filters static models on legacy registerProvider", () => {
  const pi = makeFakePi();
  const cfg = { disabled: false, keep: [] };
  patchPi(pi, () => cfg);

  pi.registerProvider("agnes", {
    models: [
      { id: "agnes-2.0", name: "Agnes 2.0" },
      { id: "agnes-3.0", name: "Agnes 3.0" },
      { id: "agnes-2.5-flash", name: "Agnes 2.5 Flash" }, // not versioned
    ],
  });

  assert.equal(pi.calls.length, 1);
  const { config } = pi.calls[0];
  const ids = config.models.map((m) => m.id);
  assert.ok(ids.includes("agnes-3.0"), "highest version kept");
  assert.ok(!ids.includes("agnes-2.0"), "older version filtered");
  assert.ok(ids.includes("agnes-2.5-flash"), "non-versioned singleton kept");
});

test("patchPi wraps refreshModels callback", async () => {
  const pi = makeFakePi();
  const cfg = { disabled: false, keep: [] };
  patchPi(pi, () => cfg);

  let refreshCalled = false;
  pi.registerProvider("gpt", {
    models: [],
    async refreshModels(ctx) {
      refreshCalled = true;
      return [
        { id: "gpt-4", name: "GPT 4" },
        { id: "gpt-5", name: "GPT 5" },
      ];
    },
  });

  const { config } = pi.calls[0];
  assert.equal(typeof config.refreshModels, "function");
  const result = await config.refreshModels({});
  assert.ok(refreshCalled);
  const ids = result.map((m) => m.id);
  assert.deepEqual(ids, ["gpt-5"], "refresh result filtered to highest version");
});

test("patchPi keep list protects an older version", () => {
  const pi = makeFakePi();
  const cfg = { disabled: false, keep: ["p/a-1"] };
  patchPi(pi, () => cfg);

  pi.registerProvider("p", {
    models: [
      { id: "a-1", name: "A1" },
      { id: "a-2", name: "A2" },
    ],
  });

  const ids = pi.calls[0].config.models.map((m) => m.id);
  assert.deepEqual(ids.sort(), ["a-1", "a-2"], "kept model + winner both present");
});

test("patchPi disabled passes everything through", () => {
  const pi = makeFakePi();
  const cfg = { disabled: true, keep: [] };
  patchPi(pi, () => cfg);

  pi.registerProvider("p", {
    models: [{ id: "a-1" }, { id: "a-2" }],
  });

  assert.equal(pi.calls[0].config.models.length, 2);
});

test("patchPi is idempotent", () => {
  const pi = makeFakePi();
  const cfg = { disabled: false, keep: [] };
  patchPi(pi, () => cfg);
  patchPi(pi, () => cfg); // second call is a no-op

  pi.registerProvider("p", { models: [{ id: "a-1" }, { id: "a-2" }] });
  assert.equal(pi.calls.length, 1);
});

test("patchPi wraps native provider getModels", () => {
  const pi = makeFakePi();
  const cfg = { disabled: false, keep: [] };
  patchPi(pi, () => cfg);

  const nativeProvider = {
    id: "nativep",
    name: "Native P",
    getModels: () => [
      { id: "n-1" },
      { id: "n-2" },
      { id: "no-version" },
    ],
  };

  pi.registerNativeProvider(nativeProvider);
  assert.equal(pi.calls.length, 1);
  assert.equal(pi.calls[0].type, "native");
  const wrapped = pi.calls[0].provider;
  const ids = wrapped.getModels().map((m) => m.id);
  assert.deepEqual(ids.sort(), ["n-2", "no-version"], "winner + singleton kept");
});
