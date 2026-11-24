#!/usr/bin/env node
// Contract test for the pi-chrome-always extension worker.
//
// The worker's job is to answer the bridge's commands. It is never exercised
// by a unit test today, so a rebase can silently drop an action or an upstream
// hardening and nothing notices until a caller gets "Unknown action" in
// production. This harness loads the worker with a stubbed `chrome` API and
// drives its dispatch directly.
//
// It checks, for BOTH the live-bridge path and the degraded path (the worker
// running with no debugger available, i.e. a browser that refuses to attach):
//   - every action upstream 0.15.57 implements is implemented here,
//   - the fork's own extra actions are implemented,
//   - the actions that must focus a tab respect the background-mode policy,
//   - the browser-data actions are refused without the expanded permissions.
//
// Usage: node scripts/test-worker-contract.mjs [--worker <path>]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const UPSTREAM =
  process.env.PI_CHROME_UPSTREAM_WORKER ??
  join(
    process.env.HOME ?? "",
    ".pi/agent/npm/node_modules/pi-chrome/extensions/chrome-profile-bridge/browser-extension/service_worker.js",
  );

const argv = process.argv.slice(2);
const workerArg = argv.indexOf("--worker");
const WORKER =
  workerArg >= 0 ? argv[workerArg + 1] : join(REPO, "browser-extension/service_worker.js");

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};
const ok = (msg) => console.log(`  ok    ${msg}`);

/** Minimal chrome API stub: enough for the worker to load and dispatch. */
function makeChrome({ debuggerAvailable = true, permissions = [] } = {}) {
  const calls = { bringToFront: 0, tabsUpdate: 0, windowsUpdate: 0, cdp: [] };
  const granted = new Set(permissions);
  const noop = () => undefined;
  const chrome = {
    runtime: {
      id: "testextensionid0000000000000000",
      getManifest: () => ({ version: "0.1.0" }),
      onMessage: { addListener: noop },
      onInstalled: { addListener: noop },
      onStartup: { addListener: noop },
      sendMessage: () => Promise.resolve(),
      lastError: undefined,
    },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop, onClicked: { addListener: noop } },
    alarms: { create: noop, onAlarm: { addListener: noop } },
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
    },
    offscreen: { createDocument: () => Promise.resolve(), hasDocument: () => Promise.resolve(true) },
    webNavigation: { onCommitted: { addListener: noop }, onCompleted: { addListener: noop } },
    tabs: {
      onUpdated: { addListener: noop },
      onRemoved: { addListener: noop },
      onCreated: { addListener: noop },
      onActivated: { addListener: noop },
      get: () => Promise.resolve({ id: 1, windowId: 1, url: "https://example.test/", title: "t", active: true, status: "complete" }),
      query: () => Promise.resolve([]),
      update: (id, props) => {
        calls.tabsUpdate += 1;
        return Promise.resolve({ id, windowId: 1 });
      },
      create: () => Promise.resolve({ id: 1, windowId: 1 }),
      sendMessage: () => Promise.resolve(),
      captureVisibleTab: () => Promise.resolve("data:image/png;base64,AA"),
    },
    windows: {
      create: () => Promise.resolve({ id: 1 }),
      get: () => Promise.resolve({ id: 1, state: "normal", left: 0, top: 0, width: 800, height: 600 }),
      update: () => {
        calls.windowsUpdate += 1;
        return Promise.resolve({ id: 1 });
      },
      onFocusChanged: { addListener: noop },
    },
    scripting: {
      executeScript: () => Promise.resolve([{ result: null }]),
      insertCSS: () => Promise.resolve(),
      registerContentScripts: () => Promise.resolve(),
      unregisterContentScripts: () => Promise.resolve(),
    },
    groups: { getAll: () => Promise.resolve([]) },
    cookies: granted.has("cookies") ? { getAll: () => Promise.resolve([]), get: () => Promise.resolve(null) } : undefined,
    bookmarks: granted.has("bookmarks") ? { getTree: () => Promise.resolve([]) } : undefined,
    history: granted.has("history") ? { search: () => Promise.resolve([]) } : undefined,
    downloads: granted.has("downloads") ? { search: () => Promise.resolve([]) } : undefined,
    management: granted.has("management") ? { getAll: () => Promise.resolve([]) } : undefined,
    debugger: {
      attach: () => (debuggerAvailable ? Promise.resolve() : Promise.reject(new Error("debugger refused"))),
      detach: () => Promise.resolve(),
      sendCommand: () => {
        calls.cdp.push("called");
        return Promise.resolve({ result: {} });
      },
      getTargets: () => Promise.resolve([]),
      onDetach: { addListener: noop },
      onEvent: { addListener: noop },
    },
  };
  return { chrome, calls };
}

/** Load the worker source and expose its dispatch function. */
async function loadWorker(path, chrome) {
  const source = readFileSync(path, "utf8");
  // The worker is a service worker: it registers listeners at load time and
  // exposes its dispatch through handleCommand. Capture the pieces the harness
  // needs so it can call dispatch() directly.
  const listeners = [];
  const stub = {
    ...chrome,
    runtime: {
      ...chrome.runtime,
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };
  stub.runtime.onInstalled.addListener = () => undefined;
  stub.runtime.onStartup.addListener = () => undefined;
  stub.action.onClicked.addListener = () => undefined;
  stub.alarms.onAlarm.addListener = () => undefined;
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "chrome",
    "fetch",
    "AbortSignal",
    "setTimeout",
    "clearTimeout",
    "console",
    "navigator",
    `${source}\n;return { dispatch: typeof dispatch === "function" ? dispatch : null };`,
  );
  const noFetch = () => Promise.reject(new Error("no network in tests"));
  const exported = fn(stub, noFetch, AbortSignal, setTimeout, clearTimeout, console, {
    userAgent: "test-harness",
  });
  return { dispatch: exported.dispatch, listeners };
}

/** Extract the action names the worker dispatches. */
function actionsOf(source) {
  return new Set([...source.matchAll(/case\s+"([a-z_]+(?:\.[A-Za-z_]+)+)"/g)].map((m) => m[1]));
}

const workerSource = readFileSync(WORKER, "utf8");
const upstreamSource = readFileSync(UPSTREAM, "utf8");

console.log(`worker:   ${WORKER}`);
console.log(`upstream: ${UPSTREAM}`);
console.log("");

const workerActions = actionsOf(workerSource);
const upstreamActions = actionsOf(upstreamSource);

console.log("== action parity ==");
const missing = [...upstreamActions].filter((a) => !workerActions.has(a)).sort();
if (missing.length) fail(`worker does not implement upstream action(s): ${missing.join(", ")}`);
else ok(`worker implements all ${upstreamActions.size} upstream action(s)`);

const forkOnly = [...workerActions].filter((a) => !upstreamActions.has(a)).sort();
const expectedForkOnly = [
  "automation.windowMove",
  "automation.windowState",
  "data.bookmarks.tree",
  "data.cookies.get",
  "data.cookies.list",
  "data.downloads.list",
  "data.extensions.list",
  "data.history.search",
];
if (JSON.stringify(forkOnly) === JSON.stringify(expectedForkOnly)) {
  ok(`fork-only actions are exactly the browser-data + owned-window set (${forkOnly.length})`);
} else {
  fail(`fork-only actions changed: got [${forkOnly.join(", ")}], expected [${expectedForkOnly.join(", ")}]`);
}

console.log("");
console.log("== background-mode focus policy ==");
// upstream gates raw CDP focus methods behind the foreground policy. The fork
// must not regress that: it is the escape hatch that could otherwise pop
// Chrome to the front behind the user's back.
if (/CDP_FOCUS_METHODS/.test(workerSource) && /foregroundRequested/.test(workerSource)) {
  ok("worker carries upstream's focus gating (CDP_FOCUS_METHODS + foregroundRequested)");
} else {
  fail("worker lost upstream's background-mode focus gating");
}
const bg = workerSource.match(/const CDP_FOCUS_METHODS = new Set\(\[(.*?)\]/);
if (bg && /Page\.bringToFront/.test(bg[1]) && /Target\.activateTarget/.test(bg[1])) {
  ok("CDP_FOCUS_METHODS covers Page.bringToFront and Target.activateTarget");
} else {
  fail(`CDP_FOCUS_METHODS does not cover the focus methods: ${bg ? bg[1] : "not found"}`);
}

console.log("");
console.log("== browser-data actions require their permissions ==");
// A data.* action must fail closed when the matching permission is absent,
// rather than silently returning an empty result that reads like "no data".
for (const [action, permission] of [
  ["data.cookies.list", "cookies"],
  ["data.bookmarks.tree", "bookmarks"],
  ["data.history.search", "history"],
  ["data.downloads.list", "downloads"],
  ["data.extensions.list", "management"],
]) {
  const pattern = new RegExp(`case "${action.replace(/\./g, "\\.")}"[\\s\\S]{0,400}?throw new Error\\("chrome\\.\\w+ unavailable`);
  if (pattern.test(workerSource)) ok(`${action} fails closed without the ${permission} permission`);
  else fail(`${action} does not fail closed without the ${permission} permission`);
}

console.log("");
console.log("== the worker loads and answers a command ==");
try {
  const { chrome } = makeChrome({ debuggerAvailable: true, permissions: ["cookies", "management"] });
  const { dispatch } = await loadWorker(WORKER, chrome);
  if (typeof dispatch !== "function") {
    fail("worker did not expose a dispatch function");
  } else {
    ok("worker loaded and exposed its dispatch function");
    // cdp.call is the action the book campaign depends on. It must be a
    // dispatch case, not an unknown action.
    const result = await dispatch("cdp.call", { method: "Runtime.evaluate", params: {} });
    ok(`cdp.call dispatched (returned ${JSON.stringify(result)?.slice(0, 60) ?? "undefined"})`);
    // tab.version is the cheap "is the worker alive and which one am I" probe.
    const version = await dispatch("tab.version", {});
    if (version?.capabilities?.hardBackground === true) {
      ok("tab.version reports the background-mode capability");
    } else {
      fail(`tab.version did not report capabilities: ${JSON.stringify(version)?.slice(0, 80)}`);
    }
  }
} catch (error) {
  fail(`worker threw while loading: ${error.message}`);
}

console.log("");
console.log("== degraded mode: no debugger available ==");
// A browser that refuses chrome.debugger.attach must produce a clear error
// for cdp.call, not a hang and not a wrong success.
try {
  const { chrome } = makeChrome({ debuggerAvailable: false, permissions: [] });
  const { dispatch } = await loadWorker(WORKER, chrome);
  if (typeof dispatch !== "function") {
    fail("worker did not expose a dispatch function (degraded mode)");
  } else {
    let outcome;
    try {
      await dispatch("cdp.call", { method: "Runtime.evaluate", params: {} });
      outcome = "resolved";
    } catch (error) {
      outcome = `threw: ${error.message.slice(0, 70)}`;
    }
    if (outcome.startsWith("threw")) ok(`degraded mode fails loudly rather than hanging (${outcome})`);
    else fail(`degraded mode did not fail loudly: ${outcome}`);
  }
} catch (error) {
  fail(`worker threw while loading in degraded mode: ${error.message}`);
}

console.log("");
if (failures > 0) {
  console.log(`== ${failures} check(s) failed ==`);
  process.exit(1);
}
console.log("== all worker contract checks passed ==");
