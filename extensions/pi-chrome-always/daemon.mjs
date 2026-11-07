#!/usr/bin/env node
// pi-chrome-always — standalone always-on Chrome profile bridge.
//
// Wire-compatible with upstream pi-chrome's ChromeProfileBridge so the
// existing "Pi Chrome Connector" (and this package's fork) connects
// unchanged, and so every Pi session's pi-chrome instance can run as a
// client forwarding via POST /command to this daemon.
//
// Protocol (loopback only, default 127.0.0.1:17318):
//   GET  /status            -> bridge status (+ bridgeVersion, upstream version)
//   GET  /healthz           -> same as /status (for systemd / doctor probes)
//   POST /command           -> {action,params,timeoutMs} (LOCAL processes only)
//   GET  /next              -> companion extension long-poll
//   POST /result            -> {id,ok,result?,error?} from the extension
//
// Lifetime: unlike pi-chrome's in-Pi server, this daemon is designed to run
// under systemd (user service, Restart=on-failure) and outlive Pi sessions.
// If the port is taken at start (e.g. a Pi session currently owns it), the
// daemon stays alive and retries every 5s until it claims the port, so
// `systemctl --user start` is safe to run at any time.
//
// Security: loopback only + Origin/Sec-Fetch-Site gate (browser-origin
// requests are rejected for /command, loopback callers accepted for /next
// only from chrome-extension://). No token by default to stay compatible
// with pi-chrome client mode; set PI_CHROME_ALWAYS_TOKEN=<secret> (and
// write the same value to ~/.local/share/pi-chrome-always/token for the
// Pi-side extension) to require X-Pi-Chrome-Token on /command.
//
// Honest limits (see README.md): this cannot run while Chrome is closed,
// cannot drive chrome:// pages, native dialogs, password-manager prompts,
// or CAPTCHA/passkeys — those are Chrome sandbox boundaries, not bridge gaps.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DEFAULT_HOST = process.env.PI_CHROME_BRIDGE_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PI_CHROME_BRIDGE_PORT ?? "17318");
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 25_000;
const RETRY_MS = 5_000;

function readJsonVersion(paths) {
  for (const p of paths) {
    try {
      const v = JSON.parse(readFileSync(p, "utf8")).version;
      if (v) return v;
    } catch {}
  }
  return undefined;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_VERSION = readJsonVersion([join(HERE, "package.json")]) ?? "0.1.0";
// Upstream pi-chrome version (for /status / doctor only; extension tolerates drift).
const UPSTREAM_VERSION = readJsonVersion([
  "/home/dracon/.pi/agent/npm/node_modules/pi-chrome/package.json",
  join(HERE, "..", "pi-chrome", "package.json"),
]) ?? "unknown";

// Optional token auth for /command (opt-in; default off for client compat).
// Enforced ONLY when PI_CHROME_ALWAYS_TOKEN is set on the daemon process.
// The token FILE (~/.local/share/pi-chrome-always/token) alone never
// enforces — it is a distribution path for the same value; Pi-side tools
// send X-Pi-Chrome-Token when the file exists, so setting the env on the
// daemon completes the opt-in without breaking unauthenticated local callers.
const REQUIRED_TOKEN = (process.env.PI_CHROME_ALWAYS_TOKEN ?? "").trim() || undefined;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function corsHeaders(req) {
  const origin = String(req.headers.origin ?? "");
  if (!origin.startsWith("chrome-extension://")) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-pi-chrome-token",
    "access-control-expose-headers": "x-pi-chrome-version",
    "vary": "origin",
  };
}

function isBrowserOriginAllowed(req) {
  const origin = String(req.headers.origin ?? "");
  if (origin) return origin.startsWith("chrome-extension://");
  const sec = String(req.headers["sec-fetch-site"] ?? "");
  return !sec || sec === "none" || sec === "same-origin";
}

function isLocalProcessRequest(req) {
  return !req.headers.origin && !req.headers["sec-fetch-site"];
}

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function log(...args) {
  console.log(`[${new Date().toISOString()}] [pi-chrome-always]`, ...args);
}

class ChromeProfileBridge {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.server = undefined;
    this.pending = new Map();
    this.queue = [];
    this.waiters = [];
    this.lastSeenAt = undefined;
    this.clientName = undefined;
  }
  get url() {
    return `http://${this.host}:${this.port}`;
  }
  get connected() {
    return this.lastSeenAt !== undefined && Date.now() - this.lastSeenAt < 5 * 60_000;
  }
  status() {
    return {
      url: this.url,
      mode: "server",
      daemon: "pi-chrome-always",
      bridgeVersion: BRIDGE_VERSION,
      upstreamPiChromeVersion: UPSTREAM_VERSION,
      connected: this.connected,
      lastSeenAt: this.lastSeenAt,
      clientName: this.clientName,
      queuedCommands: this.queue.length,
      pendingCommands: this.pending.size,
      tokenRequired: Boolean(REQUIRED_TOKEN),
    };
  }
  start() {
    return new Promise((resolve, reject) => {
      const tryListen = () => {
        const server = createServer((req, res) => {
          this.handle(req, res).catch((e) => sendJson(res, 500, { error: e.message }));
        });
        server.once("error", (e) => {
          if (e.code === "EADDRINUSE") {
            log(
              `${this.url} already in use (a Pi session likely owns the bridge right now). ` +
                `Retrying every ${RETRY_MS / 1000}s until it is free…`,
            );
            server.close();
            setTimeout(tryListen, RETRY_MS);
          } else {
            reject(e);
          }
        });
        server.listen(this.port, this.host, () => {
          this.server = server;
          log(`listening on ${this.url} (companion-extension protocol, always v${BRIDGE_VERSION} / upstream ${UPSTREAM_VERSION})`);
          resolve();
        });
      };
      tryListen();
    });
  }
  sendLocal(action, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const command = { id, action, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.queue = this.queue.filter((c) => c.id !== id);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms: no response from Chrome companion extension. ` +
              `Ensure 'Pi Chrome Connector — Always' (or upstream 'Pi Chrome Connector') is loaded at chrome://extensions and Chrome is running.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.enqueue(command);
    });
  }
  enqueue(command) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(command);
    else this.queue.push(command);
  }
  waitForCommand(timeoutMs, registerWaiter) {
    return new Promise((resolveWait) => {
      let settled = false;
      const waiter = (command) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolveWait(command);
      };
      const timer = setTimeout(() => waiter(undefined), timeoutMs);
      this.waiters.push(waiter);
      registerWaiter?.(waiter);
    });
  }
  async handle(req, res) {
    const url = new URL(req.url ?? "/", this.url);
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") {
      if (!isBrowserOriginAllowed(req)) return sendJson(res, 403, { ok: false, error: "browser origin not allowed" });
      return sendJson(res, 200, { ok: true }, cors);
    }
    if (req.method === "GET" && (url.pathname === "/status" || url.pathname === "/healthz")) {
      return sendJson(res, 200, this.status());
    }
    if (req.method === "POST" && url.pathname === "/command") {
      if (!isLocalProcessRequest(req)) {
        return sendJson(res, 403, { ok: false, error: "Chrome commands accepted only from local processes" });
      }
      if (REQUIRED_TOKEN && req.headers["x-pi-chrome-token"] !== REQUIRED_TOKEN) {
        return sendJson(res, 403, { ok: false, error: "invalid or missing X-Pi-Chrome-Token" });
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { ok: false, error: "invalid JSON" });
      }
      if (!body.action) return sendJson(res, 400, { ok: false, error: "Missing command action" });
      try {
        const result = await this.sendLocal(body.action, body.params ?? {}, body.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        return sendJson(res, 200, { ok: true, result });
      } catch (e) {
        return sendJson(res, 504, { ok: false, error: e.message });
      }
    }
    if (req.method === "GET" && url.pathname === "/next") {
      if (!isBrowserOriginAllowed(req)) return sendJson(res, 403, { ok: false, error: "browser origin not allowed" });
      this.lastSeenAt = Date.now();
      this.clientName = url.searchParams.get("name") ?? undefined;
      let aborted = false;
      let activeWaiter;
      req.once("close", () => {
        aborted = true;
        if (activeWaiter) this.waiters = this.waiters.filter((w) => w !== activeWaiter);
      });
      let command = this.queue.shift();
      if (!command) command = await this.waitForCommand(POLL_TIMEOUT_MS, (w) => { activeWaiter = w; });
      if (aborted) {
        if (command) this.queue.unshift(command);
        return;
      }
      if (command) {
        const entry = this.pending.get(command.id);
        if (entry) entry.deliveredAt = Date.now();
      }
      return sendJson(
        res,
        200,
        command
          ? { type: "command", command, expectedExtensionVersion: BRIDGE_VERSION }
          : { type: "none", expectedExtensionVersion: BRIDGE_VERSION },
        { ...cors, "x-pi-chrome-version": BRIDGE_VERSION },
      );
    }
    if (req.method === "POST" && url.pathname === "/result") {
      if (!isBrowserOriginAllowed(req)) return sendJson(res, 403, { ok: false, error: "browser origin not allowed" });
      this.lastSeenAt = Date.now();
      let result;
      try {
        result = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, { ok: false, error: "invalid JSON" }, cors);
      }
      const pending = this.pending.get(result.id);
      if (!pending) return sendJson(res, 404, { ok: false, error: "unknown command id" }, cors);
      clearTimeout(pending.timer);
      this.pending.delete(result.id);
      if (result.ok) pending.resolve(result.result);
      else pending.reject(new Error(result.error ?? "Chrome extension command failed"));
      return sendJson(res, 200, { ok: true }, cors);
    }
    return sendJson(res, 404, { error: "not found" });
  }
}

const bridge = new ChromeProfileBridge(DEFAULT_HOST, DEFAULT_PORT);

function shutdown() {
  log("shutting down");
  try {
    bridge.server?.close();
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

bridge.start().catch((e) => {
  console.error("[pi-chrome-always] failed to start:", e);
  process.exit(1);
});
