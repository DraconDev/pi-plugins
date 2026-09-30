/**
 * The regression shield: seven items, one verdict.
 *
 * Every round of this project has ended with a completion claim that lists the
 * same handful of gates and pastes their output into it. That is a habit, not a
 * gate: nothing runs them, nothing fails when one is skipped, and a claim can
 * quietly drop one and still read as a clean sweep. This runs them.
 *
 *   node scripts/benchmark/regression-shield.mjs
 *   node scripts/benchmark/regression-shield.mjs --only=panel    # one item
 *
 * Exit code 0 when all seven pass, 1 otherwise, naming the item that failed.
 * `--only` prints that the run was partial and is deliberately not a shield:
 * a verdict that can be narrowed to the part that happens to be green is not
 * one.
 *
 * Each item is a separate process with its own deadline, so one that hangs costs
 * its own timeout rather than the run. The deadlines are the point of "bounded":
 * a gate that waits on a terminal that is never going to answer must fail on a
 * clock, not on the operator's patience.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../..");
const FIXTURE = ".pi/benchmark/images/visual-001-option-1.png";

const only = process.argv.find((argument) => argument.startsWith("--only="))?.slice("--only=".length) ?? null;

/**
 * The seven. Order is cheapest-and-most-likely-to-fail first, because a shield
 * that reports the last item and stops has told the reader nothing.
 */
const items = [
  {
    name: "check",
    what: "typecheck and the hermetic smokes",
    timeoutMs: 300_000,
    run: () => npm("run", "check"),
  },
  {
    name: "panel",
    what: "the panel's tail, height, marker and artwork invariants",
    timeoutMs: 900_000,
    run: () => npm("run", "verify:panel"),
  },
  {
    name: "unit",
    what: "the unit and regression suite",
    timeoutMs: 300_000,
    run: () => npm("test"),
  },
  {
    name: "image",
    // This is the round trip and nothing more: the bytes the terminal receives
    // are parsed back out of the frame and compared with the file by hash. A
    // truncated *file* still round-trips faithfully, so this item does not catch
    // one - the panel item's artwork check does. Saying so here keeps the two
    // from being read as interchangeable.
    what: "the image protocol round-trip: render, parse the escapes back, compare by hash",
    timeoutMs: 180_000,
    run: () => node("scripts/benchmark/verify-image-protocol.mjs"),
  },
  {
    name: "live",
    what: "five sessions in a real TTY against a real host",
    timeoutMs: 600_000,
    run: () => npm("run", "smoke:live", "--", "--image", FIXTURE),
  },
  {
    name: "hygiene",
    what: "no whitespace damage, and no terminal graphics settings introduced",
    timeoutMs: 60_000,
    run: () => hygiene(),
  },
  {
    name: "state",
    what: "the generation account and the host's package list are untouched",
    timeoutMs: 60_000,
    run: () => machineState(),
  },
];

/**
 * The deadline for the item being run. Every child inherits it, so a gate that
 * waits on a terminal that is never going to answer fails on a clock rather than
 * on the operator's patience - and an item cannot quietly opt out of it by
 * forgetting to pass one.
 */
let deadlineMs = 120_000;

function run(bin, args, timeoutMs = deadlineMs) {
  return spawnSync(bin, args, {
    cwd: ROOT,
    timeout: timeoutMs ?? deadlineMs,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // A PTY-less child is fine for every item here except the live smoke, which
    // provisions its own; nothing needs our stdin.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const npm = (...args) => guard(run("npm", args));
const node = (script, ...rest) => guard(run(process.execPath, [script, ...rest]));

/**
 * Turn a child result into the same `{ ok, output }` shape the in-process items
 * return.
 *
 * This is the bug the shield shipped with the first time it ran: `spawnSync`
 * has no `ok` property - it returns `status`, `signal` and `error` - so a
 * success test written against `.ok` was never true, and five of the seven
 * items were reported as failures while their own output said `status: passed`.
 * A verdict has to be derived from the child's exit code, and nothing else.
 */
function guard(result) {
  // A child killed by its deadline arrives as ETIMEDOUT, and that is the only
  // thing that may be called a timeout. An in-process item that returns a
  // failure verdict has not timed out, and saying so would be a false label on
  // a real failure.
  if (result?.error) {
    const timedOut = result.error.code === "ETIMEDOUT";
    return { ok: false, timedOut, output: timedOut ? `no answer within the deadline: ${result.error.message ?? result.error}` : String(result.error.message ?? result.error) };
  }
  if (result?.signal) return { ok: false, timedOut: false, output: `killed by ${result.signal}` };
  const output = String(result?.stdout ?? "") + String(result?.stderr ?? "");
  return { ok: result?.status === 0, status: result?.status, timedOut: false, output };
}

/**
 * The whitespace and graphics-hygiene item, in process: it is a handful of
 * greps, and shelling out for each would be slower than the check itself.
 */
function hygiene() {
  const problems = [];
  const diffCheck = run("git", ["diff", "--check"]);
  if (diffCheck.status !== 0) problems.push(`git diff --check reported whitespace damage:\n${tail(diffCheck)}`);
  if (diffCheck.error) problems.push(`git diff --check could not run: ${diffCheck.error.message ?? diffCheck.error}`);

  // The three tokens that would mean the fix was to change how the terminal
  // draws rather than to change what the panel renders.
  const diff = run("git", ["diff", "HEAD"]);
  if (diff.error) problems.push(`git diff HEAD could not run: ${diff.error.message ?? diff.error}`);
  const added = String(diff.stdout ?? "").split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const banned = added.filter((line) => /PI_IMAGE_PROTOCOL|allow-passthrough|terminal-features/.test(line));
  if (banned.length > 0) problems.push(`added lines introduce terminal graphics settings:\n${banned.join("\n")}`);
  if (problems.length === 0) return { ok: true, output: `diff --check clean; ${added.length} added lines, none matching the banned tokens` };
  return { ok: false, output: problems.join("\n") };
}

/**
 * The generation account and the host's activation. Both are machine state
 * rather than source, so neither has a command that checks it - they are read,
 * and the numbers a round is expected to leave alone are named here.
 */
function machineState() {
  const problems = [];
  const notes = [];
  const generations = resolve(ROOT, ".pi/benchmark/generations.json");
  if (!existsSync(generations)) {
    problems.push(".pi/benchmark/generations.json is missing - the generation account cannot be read");
  } else {
    const account = JSON.parse(readFileSync(generations, "utf8"));
    const { cumulativeSuccessfulGenerations, generationsSinceBoundary } = account;
    notes.push(`generations ${cumulativeSuccessfulGenerations} cumulative, ${generationsSinceBoundary} since boundary`);
    // The boundary this project's work is not allowed to move.
    if (cumulativeSuccessfulGenerations !== 2023) problems.push(`cumulativeSuccessfulGenerations is ${cumulativeSuccessfulGenerations}, expected 2023`);
    if (generationsSinceBoundary !== 3) problems.push(`generationsSinceBoundary is ${generationsSinceBoundary}, expected 3`);
  }
  const settings = "/home/dracon/.pi/agent/settings.json";
  if (!existsSync(settings)) {
    problems.push(`${settings} is missing - activation cannot be read`);
  } else {
    const text = readFileSync(settings, "utf8");
    const local = (text.match(/pi-pro-ask-question-image-draft/g) ?? []).length;
    const rival = (text.match(/rpiv/gi) ?? []).length;
    notes.push(`host packages: ${local} local entry, ${rival} RPiV`);
    if (local !== 1) problems.push(`the local package appears ${local} times in the host's package list, expected exactly 1`);
    if (rival !== 0) problems.push(`the host's package list has ${rival} RPiV entries, expected 0`);
  }
  return problems.length === 0 ? { ok: true, output: notes.join("; ") } : { ok: false, output: problems.join("\n") };
}

const tail = (result) => String(result.stdout ?? result.stderr ?? "").trim().split("\n").slice(-12).join("\n");

const results = [];
for (const item of items) {
  if (only && item.name !== only) continue;
  const started = Date.now();
  deadlineMs = item.timeoutMs;
  process.stdout.write(`… ${item.name.padEnd(8)} ${item.what}\n`);
  let outcome;
  try {
    outcome = item.run(item.timeoutMs);
  } catch (error) {
    outcome = { ok: false, output: `threw: ${error?.message ?? error}` };
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (outcome?.ok === true) {
    results.push({ ...item, ok: true, detail: outcome.output ?? "" });
    // The last non-empty line, which is where each gate states its own verdict.
    const evidence = String(outcome.output ?? "").trim().split("\n").filter((line) => line.trim().length > 0).pop() ?? "";
    results[results.length - 1].evidence = evidence.slice(0, 110);
    process.stdout.write(`  ${item.name.padEnd(8)} pass  ${seconds}s  ${evidence.slice(0, 110)}\n`);
  } else {
    const status = outcome?.timedOut === true
      ? "timed out"
      : outcome?.status === undefined
        ? "reported a failure"
        : `exit ${outcome.status}`;
    results.push({ ...item, ok: false, detail: outcome?.output ?? "" });
    process.stdout.write(`  ${item.name.padEnd(8)} FAIL  ${seconds}s  ${status}\n`);
    for (const line of String(outcome?.output ?? "").trim().split("\n").slice(-14)) {
      process.stdout.write(`      ${line}\n`);
    }
  }
}

const failed = results.filter((result) => !result.ok);
const names = results.map((result) => result.name);
process.stdout.write(`\nregression-shield: ${results.length - failed.length}/${results.length} passed`);
if (only) process.stdout.write(` (PARTIAL — only=${only}; this is not a shield verdict)`);
process.stdout.write(`\n  ${names.map((name) => `${name}: ${results.find((r) => r.name === name)?.ok ? "pass" : "FAIL"}`).join("  ")}\n`);
if (failed.length > 0) process.stdout.write(`  failed: ${failed.map((result) => result.name).join(", ")}\n`);
process.exit(failed.length === 0 ? 0 : 1);
