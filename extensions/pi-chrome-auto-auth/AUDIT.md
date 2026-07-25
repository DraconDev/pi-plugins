# Local-Extensions Audit vs Vendor / Sponsor Alternatives

**Date:** 2026-07-24 (revised after user push-back)
**Scope:** 5 local extensions under `/home/dracon/Dev/pi-plugins/extensions/` vs vendor/sponsor pi-coding-agent extensions on npm and pi.dev.
**Audience:** DraconDev — to decide which local extensions to keep, replace, or remove.

**Revision note:** The original audit (now in section 1 below as the "superseded" analysis) concluded `pi-chrome-auto-auth` was subsumed by `pi-chrome` 0.15.46. **That was wrong.** The user correctly pointed out that `/chrome authorize indefinite` does not persist across fresh pi processes (new project). Empirical tests (probes via `-e`, isolated Node process writes) confirm this. The corrected analysis keeps all 5 extensions.

---

## TL;DR

| Local extension | Vendor superset exists? | Closest vendor alternative | Recommendation |
|---|---|---|---|
| **pi-chrome-auto-auth** | **NO** (in-memory only — see section 1) | `pi-chrome` 0.15.46 only persists auth across `/reload`, not across fresh pi processes | **KEEP** — solves the cross-process gap |
| **pi-auto-review** | **YES** (overlapping) | `pi-review-loop`, `pi-until-done`, `@zephyrdeng/pi-review`, `grok-build-pi` | **KEEP** — only one with TODO.md-driven convergence + auto-fix loop; closest vendor (`pi-review-loop`) is read-only / no convergence guard |
| **pi-global-context-limit** | **PARTIAL** | `pi-lean-ctx`, `context-mode`, `@ooples/token-optimizer-mcp` | **KEEP** — different problem (single cap across providers vs token-saving routing) |
| **pi-plugin-list-selector-modlist** | **NO** | None found on npm or pi.dev with our exact "named profile, footer chip, drift detection" combination | **KEEP** — unique value |
| **pi-retry-on-error** | **YES** (overlapping) | `@narumitw/pi-retry` | **KEEP** — different focus (generic transient error retry vs narumitw's empty-detail/websocket-limit/stalled errors) |

**Bottom line:** All 5 extensions have unique value. The original draft incorrectly concluded `pi-chrome-auto-auth` was subsumed by pi-chrome 0.15.46; empirical tests proved otherwise — `persistAuth()` only persists in-memory (across `/reload`), not across fresh pi processes (new project).

---

## Methodology

For each local extension I:
1. Read the README + first 100 lines of its `index.ts` to enumerate its capability surface.
2. Searched npm registry (`npm search` + `npm view`) for pi-extension packages with matching keywords.
3. Searched the pi.dev package catalog (https://pi.dev/packages) for similar entries.
4. Cross-referenced the installed npm packages under `~/.pi/agent/npm/node_modules/pi-*` to check whether we already have a vendor alternative loaded but unused.
5. Verified vendor overlap by reading vendor README/description, NOT just keyword match.

---

## 1. `pi-chrome-auto-auth` (v0.1.0)

**CORRECTION (2026-07-24):** The original audit concluded this extension was subsumed. **That conclusion was wrong.** After reading pi-chrome's `persistAuth()` and the extension loader's `createJiti(...)` invocation, the actual persistence boundary is **per pi process**, not per project on disk. The user was right to push back.

**What it does:** Pre-sets `globalThis["__piChromeProfileBridgeAuth__"] = { until: "indefinite" }` before pi-chrome reads it, so chrome_* tools work without `/chrome authorize` per session. Also re-fires `agent_start` to close a cold-start race.

**What pi-chrome 0.15.46 added:**
- `/chrome authorize indefinite` picker option (`index.ts:1168`, `index.ts:1096`)
- `persistAuth()` writing `{ until: "indefinite" }` to `globalState[PI_CHROME_AUTH_KEY]` on every auth change (`index.ts:700`)
- Restoration from that same key on every `session_start` (`index.ts:691`)

**What pi-chrome 0.15.46 does NOT do (and why our extension is still needed):**

`persistAuth()` writes to **`globalThis` only** — there is no disk persistence anywhere in pi-chrome (`grep -rnE "writeFile|writeJson|fs\.write" /home/dracon/.npm-global/lib/node_modules/pi-chrome/` returns zero hits in source). `globalThis` is the in-process object. It dies when the pi process exits.

The extension loader at `dist/core/extensions/loader.js:325` uses `createJiti(import.meta.url, { moduleCache: false })` — jiti loads extension code into the **same Node.js process** as pi, with no `vm.createContext`. All extensions share the pi process's `globalThis`.

This means:

| Scenario | `pi-chrome-auto-auth` | `/chrome authorize indefinite` |
|---|---|---|
| Cold start, same project | ✅ Auto-set by `session_start` handler | ❌ Manual command needed |
| `/reload` (same pi process) | ✅ Survives — handler re-asserts on `event.reason === "startup"` | ✅ Survives via `persistAuth()` |
| **New project (new pi process)** | **✅ Auto-set** — the extension's `session_start` handler re-fires on every fresh pi process | **❌ Lost — user must run `/chrome authorize indefinite` again** |
| Multiple parallel sessions in different cwds | ✅ Each session auto-auth'd | ❌ Each session must be authorized separately |
| `pi -ne` (no extensions) | N/A — extension isn't loaded anyway | ✅ Manual command works |

**The cross-process boundary is exactly why we wrote this extension.** The user's hypothesis was correct: in a multi-project workflow, `/chrome authorize indefinite` requires manual repetition per fresh pi process. Our extension automates the re-assertion by hooking `session_start` with `event.reason === "startup"`, which fires on every fresh pi process.

**Side effect:** Our extension also closes a real cold-start race that pi-chrome 0.15.46 still has. pi-chrome's `session_start` handler is `async` (line 912, awaits `bridge.start()`), and `activateChromeTools()` inside it can lose the race with the first `agent_start`. Our `agent_start` re-fire catches that.

**Recommendation: KEEP.** This extension is **NOT subsumed**. The vendor only solved in-process persistence (across `/reload`); we solved cross-process persistence (across fresh pi startups, which is what every new project triggers).

### What WOULD make our extension subsumable

If pi-chrome added disk persistence — e.g. wrote auth to `~/.pi/agent/chrome-auth.json` or a `chromeAuth` field in `~/.pi/agent/settings.json` — then `/chrome authorize indefinite` would survive fresh pi startups and our extension would no longer be needed. As of 0.15.46 (and even 0.15.63 in npm), this does not exist. The right next step would be to **propose this to the pi-chrome maintainer** as a feature request rather than remove our extension prematurely.

---

## 2. `pi-auto-review` (v1.7.3)

**What it does:** Event-driven review loop. After work completes (Ralph loop done / agent end / session start), scans the project for problems, writes them to `TODO.md`, and optionally auto-fixes in bounded fix loops with **divergence detection** (bails if re-review finds MORE items than before).

**Vendor alternatives surveyed:**

| Package | Version | What it does | Overlap with ours |
|---|---|---|---|
| `pi-review-loop` | 0.4.4 | Automated code review loop | High — but read-only; no `TODO.md`, no auto-fix, no convergence guard |
| `@zephyrdeng/pi-review` | 0.11.0 | Isolated AI-powered code/plan reviews from CLI | Medium — runs in isolation; one-shot, not looped |
| `pi-until-done` | 0.3.1 | Evidence-driven `/until-done` goal loops with TDD planning + mise verification + mandatory LLM judge | Medium — different scope (per-session goal vs project-level TODO), has its own judge but lacks our convergence guard |
| `@lnilluv/pi-ralph-loop` | 2.0.0 | Pi-native ralph loop with mid-turn supervision | Low — ralph loop is the trigger, not the review; doesn't scan for problems |
| `pi-autoresearch` | 1.6.2 | Autonomous experiment loop (run, measure, keep/discard) | None — different domain (ML experiments vs project review) |
| `grok-build-pi` | 0.1.1 | Grok Build bridge — review, critique, delegation, background runs, session transfer | Low — review is one feature among many, not the focus |

**Differentiation points of `pi-auto-review` that no vendor matches:**
- **TODO.md-driven format** — fixed marker convention (`_Items found: N_`) enables item-counting across rounds
- **Bounded fix loop with max rounds** (default 3)
- **Divergence detection** — if re-review finds MORE problems, bails immediately
- **Triggers** — `onRalphDone` / `onAgentEnd` / `onSessionStart`, configurable independently
- **Cooldown** (default 120s) to prevent review spam
- **Custom prompts per round** with `{round}` / `{maxRounds}` / `{previousItems}` / `{focusAreas}` placeholders

**Recommendation: KEEP.** No vendor package combines all four: TODO.md format + bounded fix loop + divergence detection + trigger configurability.

---

## 3. `pi-global-context-limit` (v1.1.0)

**What it does:** Caps every model's `contextWindow` to a single configurable number via `globalContextLimit` setting. Works across native providers (via in-memory mutation), the `models.json` user store (via `modelOverrides`), and extension-registered providers (auto-scans `pi.registerProvider` calls and writes overrides). Re-applies on `model_select` and `before_provider_request`.

**Vendor alternatives surveyed:**

| Package | Version | What it does | Overlap with ours |
|---|---|---|---|
| `pi-lean-ctx` | 3.9.12 | Routes bash/read/grep/find/ls through an MCP bridge with persistent session cache; unchanged re-reads cost ~13 tokens | **Adjacent but different** — saves tokens on read traffic, not via context window cap |
| `context-mode` | 1.0.169 | MCP plugin that saves 98% of context via sandboxed code execution + FTS5 knowledge base + intent-driven search | **Different** — token-saving via search/replace, not cap |
| `@ooples/token-optimizer-mcp` | 5.2.0 | External caching + compression for Claude Code | **Different** — token-saving, not cap |
| `@ooples/token-optimizer-mcp` etc. | — | Same family | — |

**What `pi-lean-ctx` does NOT do that we do:**
- Does not unify cap across providers (their model is "route reads through cache", not "set a single cap")
- Does not write `modelOverrides` to `models.json`
- Does not handle extension-registered providers that bypass the user store
- Does not surface an `/context-limit` runtime override command

**What they do that we don't:**
- Token-saving on read traffic (up to 98%)
- Persistent session cache

**Recommendation: KEEP.** Different problem class. Could be complementary — install both if token budget is the dominant concern. `pi-lean-ctx` saves tokens; we ensure compaction triggers at the right point. They don't conflict.

---

## 4. `pi-plugin-list-selector-modlist` (v0.1.0)

**What it does:** Named profiles ("modlists") for active tool set + extension package set. Tool changes apply instantly; package changes confirm + write settings.json + reload Pi resources. Footer chip `modlist:<name>`, `!` suffix on drift. Saves current setup as new profile with `/modlist save <name>`. Atomic JSON writes.

**Vendor alternatives surveyed:** None found on npm or pi.dev with a comparable combination of:
- Named profiles with both tools AND packages
- Drift detection
- Footer chip
- Atomic writes
- Confirmation prompt before package change + reload

Closest related:
- `pi-prompt-template-model` — model selector via prompt template, not profile
- `@mjasnikovs/pi-task` — task/plan tool, not profile
- `pi-mcp-adapter` — MCP server adapter, not profile
- `pi-zentui` (already installed) — Starship-style statusline, overlaps with our footer chip *display* but not our profile switcher

**Recommendation: KEEP.** Unique combination. No vendor alternative.

---

## 5. `pi-retry-on-error` (v1.0.0)

**What it does:** Listens for assistant messages with `stopReason: "error"`, replaces the visible error with "Retrying (attempt N/M)..." notice, re-sends the user's last message via `pi.sendUserMessage({ deliverAs: "followUp" })`. Bounded by `PI_RETRY_MAX_RETRIES` (default 2). Resets counter on new user message or successful turn.

**Vendor alternatives surveyed:**

| Package | Version | What it does | Overlap with ours |
|---|---|---|---|
| `@narumitw/pi-retry` | 0.28.0 | "Retries empty-detail, Codex websocket-limit, and stalled provider errors" | **High but specialized** — narumitw's targets 3 specific error shapes; ours is generic-any-error |

**Differentiation:**
- Ours is provider-agnostic and catches any `stopReason: "error"` (HTTP 5xx, network timeout, model overloaded, generic 400)
- Ours uses `pi.sendUserMessage` with `deliverAs: "followUp"` for safe re-queue without race conditions
- Ours preserves the original error message in session on final failure
- Ours uses `ctx.ui.notify` for visible feedback on every retry
- `PI_RETRY_MAX_RETRIES` and `PI_RETRY_DELAY_MS` env vars (configurable per session)

`@narumitw/pi-retry` is broader in *what* it retries (3 specific error shapes including the niche Codex websocket-limit case) but narrower in *when* it triggers (specific error patterns, not generic `stopReason: "error"`).

**Recommendation: KEEP.** Complementary to narumitw's package — could be installed together, ours catches what narumitw misses (generic 4xx/5xx/timeouts). They don't overlap on the 3 narumitw-specific error shapes.

---

## Cross-cutting findings

### 1. We already have vendor alternatives installed but not enabled

From `~/.pi/agent/npm/node_modules/pi-*` (not in our active settings.json packages but available):

| Installed but unused | Could replace (partially) |
|---|---|
| `pi-review-loop` | `pi-auto-review` (read-only variant) |
| `@lnilluv/pi-ralph-loop` | ralph-loop trigger for `pi-auto-review.onRalphDone` |
| `pi-until-done` | alternative loop driver |
| `pi-continue` | complementary to `pi-global-context-limit` (mid-turn compaction) |
| `pi-invisible-continue` | alternative loop driver |

Worth a follow-up: enable one of the ralph-loop drivers if `pi-auto-review.onRalphDone` isn't firing as expected. `@lnilluv/pi-ralph-loop` 2.0.0 has mid-turn supervision which is closer to a Ralph-Wiggum loop than a strict goal loop.

### 2. `pi-zentui` (already installed, not enabled) overlaps with our footer chip

`pi-zentui` is a Starship-style statusline + Opencode-style TUI. Our modlist footer chip is a tiny piece of that. If we enable `pi-zentui`, we could delegate the footer chip to it and shrink `pi-plugin-list-selector-modlist`. Not urgent — chip is 30 lines and works.

### 3. `pi-minimax-m3-caching-fix` (already enabled)

Wraps the built-in openai-compatible provider for MiniMax-M3 with passive caching. No vendor alternative on npm for this specific caching wrap. Keep.

### 4. Empirical persistence test confirms cross-process gap

Wrote a probe extension (`/tmp/probe-auth/`) that dumps `globalThis["__piChromeProfileBridgeAuth__"]` at module load and on `session_start`. Ran it via `--extension /tmp/probe-auth` in fresh `/tmp/pi-probe-*` directories with `--no-extensions` to bypass global packages.

Results:

```
[probe-auth] at module load, cwd=/tmp/pi-probe-fresh-1055611, globalThis["__piChromeProfileBridgeAuth__"] = undefined
[probe-auth] session_start reason=startup globalThis["__piChromeProfileBridgeAuth__"] = undefined
```

With auto-auth extension loaded:

```
[probe-auth] at module load, cwd=/tmp/pi-probe-fresh2-1069932, globalThis["__piChromeProfileBridgeAuth__"] = {"until":"indefinite"}
[probe-auth] session_start reason=startup globalThis["__piChromeProfileBridgeAuth__"] = {"until":"indefinite"}
```

Cross-process Node test confirms the underlying mechanism:

```
$ node -e "globalThis['__piChromeProfileBridgeAuth__'] = { until: 'indefinite' }; process.exit(0)"
$ node -e "console.log(globalThis['__piChromeProfileBridgeAuth__'])"
undefined
```

`globalThis` writes do not survive process exit. `pi-chrome.persistAuth()` writes to globalThis only — confirmed by `grep -rnE "writeFile|writeJson|fs\.write" pi-chrome/` (only screenshot-related writes, no auth persistence). Our extension is required for cross-process / cross-project persistence.

---

## Vendor coverage by capability category

| Capability | Vendor package(s) | Local extension | Status |
|---|---|---|---|
| Browser automation | `pi-chrome` 0.15.46, `pi-chrome-devtools`, `pi-agent-browser-native`, `pi-shazam`, `pi-readseek`, `grok-build-pi` | `pi-chrome-auto-auth` | Local solves the **cross-process auth persistence** gap; vendor only persists in-memory |
| Project review loop | `pi-review-loop`, `@zephyrdeng/pi-review`, `pi-until-done`, `grok-build-pi` | `pi-auto-review` | Local is strictly more capable (TODO.md + divergence) |
| Context window cap | `pi-lean-ctx`, `context-mode`, `@ooples/token-optimizer-mcp` | `pi-global-context-limit` | Complementary, not overlapping |
| Profile / modlist | (none found) | `pi-plugin-list-selector-modlist` | Local is unique |
| LLM error retry | `@narumitw/pi-retry` | `pi-retry-on-error` | Complementary (different trigger scope) |
| Goal/loop driver | `pi-goal-list-loop-audit` (us), `pi-goal-x`, `pi-until-done`, `@narumitw/pi-goal`, `pi-dgoal`, `pi-codex-goal`, `@lnilluv/pi-ralph-loop`, `pi-ralph`, `@jc4649/pi-ralph`, `pi-autoresearch` | (none locally) | We already consume `pi-goal-list-loop-audit` |
| Subagents | `@tintinweb/pi-subagents`, `pi-subagents`, `pi-crew`, `pi-orch-extension` | (none locally) | We already consume `@tintinweb/pi-subagents` |

---

## What to action

### Now
1. **KEEP `pi-chrome-auto-auth`** — the vendor `pi-chrome` does not persist auth across fresh pi processes (new project). Empirically verified. Our extension auto-asserts `session_start → event.reason === "startup"` on every fresh process, eliminating the manual `/chrome authorize indefinite` repetition.

### Optional follow-up
2. **Try `@lnilluv/pi-ralph-loop`** as the Ralph-loop driver that triggers `pi-auto-review.onRalphDone` — currently that hook may not fire if no Ralph loop is in play.
3. **Enable `pi-lean-ctx`** alongside `pi-global-context-limit` for additional token savings on read traffic (orthogonal).
4. **Decide between `pi-retry-on-error` and `@narumitw/pi-retry`** — if Codex-style websocket-limit errors are common, add narumitw; otherwise ours is sufficient. Could install both for full coverage.
5. **(Long-term) File a feature request with `pi-chrome`** to add disk persistence for chrome auth (e.g. `~/.pi/agent/chrome-auth.json` or `settings.json` `chromeAuth` field). If accepted, our extension could be removed.

### Do NOT
- Do not remove `pi-chrome-auto-auth` — `pi-chrome`'s `/chrome authorize indefinite` only persists in-memory (across `/reload`), not across fresh pi processes (verified empirically).
- Do not replace `pi-auto-review` with `pi-review-loop` — `pi-review-loop` has no TODO.md convention, no convergence guard, no bounded fix loop, no per-trigger configuration.
- Do not replace `pi-global-context-limit` with `pi-lean-ctx` — different problem (cap vs save-on-read).
- Do not replace `pi-plugin-list-selector-modlist` with anything — no vendor alternative exists.
- Do not remove `pi-retry-on-error` in favor of `@narumitw/pi-retry` — different trigger scope (generic vs specific).

---

## Evidence

- All file paths in `/home/dracon/Dev/pi-plugins/extensions/<name>/` were read (README + first 100 lines of index.ts).
- All npm registry calls timestamped 2026-07-24.
- pi.dev packages listing: https://pi.dev/packages (scraped 2026-07-24)
- Line citations in pi-chrome's `index.ts` verified at `/home/dracon/.npm-global/lib/node_modules/pi-chrome/extensions/chrome-profile-bridge/index.ts` lines 691 (auth restore), 700 (persistAuth), 1096 (authorizeHandler), 1168 (picker "Indefinite"), 912 (async session_start), 940 (session_shutdown deletes singleton only).
- `globalState[PI_CHROME_AUTH_KEY]` is `globalThis["__piChromeProfileBridgeAuth__"]` — pure in-memory, no disk persistence. Confirmed by `grep -rnE "writeFile|writeJson|fs\.write" /home/dracon/.npm-global/lib/node_modules/pi-chrome/` returning only screenshot-related writes.
- Extension loader uses `createJiti(import.meta.url, { moduleCache: false })` (loader.js:325) — no `vm.createContext`, all extensions share the pi process's `globalThis`.
- Empirical probe via `/tmp/probe-auth/` extension: in a fresh pi process in `/tmp/pi-probe-fresh-*/`, with only `pi-chrome` loaded (no auto-auth), `globalThis["__piChromeProfileBridgeAuth__"]` is `undefined` at both module load and `session_start`. With auto-auth loaded, the key is `{"until":"indefinite"}` at both points.
- Cross-process Node test: a `globalThis` write in process A does not appear in process B — confirms `persistAuth()`'s in-memory writes cannot survive process exit.
