import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { runFencedMutation, gitEnvironment } from '../client.js';
const exec = promisify(execFile);
test('actual cancellation before rename preserves canonical bytes, reaps owned writer and permits independent repo progress', { timeout: 30000 }, async t => {
  const warden = process.env.PI_CANONICAL_TEST_WARDEN, sdkUrl = process.env.PI_CANONICAL_TEST_SDK;
  assert.ok(warden && sdkUrl, 'qualified artifacts required');
  const root = await fs.mkdtemp(join(tmpdir(), 'canonical-cancel-test-'));
  const a = join(root, 'a'), b = join(root, 'b');
  const ready = join(root, 'sync-ready'), release = join(root, 'sync-release');
  const controller = new AbortController();
  let result;
  const keys = ['LD_PRELOAD', 'DRACON_TEST_SCRATCH_IO_FAILURE', 'DRACON_TEST_SCRATCH_IO_SCOPE',
    'DRACON_TEST_SCRATCH_IO_READY', 'DRACON_TEST_SCRATCH_IO_RELEASE'];
  const oldEnv = new Map(keys.map(key => [key, process.env[key]]));
  t.after(async () => {
    controller.abort();
    await fs.writeFile(release, 'release\n').catch(() => {});
    if (result) await Promise.race([result, delay(6000)]);
    for (const key of keys) {
      const value = oldEnv.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  for (const repo of [a, b]) await exec('git', ['init', '-q', '--template=', repo], { env: gitEnvironment() });
  const target = join(a, '.gitignore'); await fs.writeFile(target, 'original\n');
  const original = await fs.stat(target, { bigint: true });
  const library = join(root, 'hold-scratch-sync.so');
  await exec('cc', ['-shared', '-fPIC', '-Wall', '-Wextra', '-Werror', '-o', library,
    fileURLToPath(new URL('./fixtures/fail-scratch-io.c', import.meta.url)), '-ldl'], { timeout: 10000 });
  process.env.LD_PRELOAD = library + (oldEnv.get('LD_PRELOAD') ? ':' + oldEnv.get('LD_PRELOAD') : '');
  process.env.DRACON_TEST_SCRATCH_IO_FAILURE = 'hold-sync';
  process.env.DRACON_TEST_SCRATCH_IO_SCOPE = join(a, '.git/dracon-canonical-writes-v1');
  process.env.DRACON_TEST_SCRATCH_IO_READY = ready;
  process.env.DRACON_TEST_SCRATCH_IO_RELEASE = release;

  const scratch = join(a, '.git/dracon-canonical-writes-v1');
  const run = runFencedMutation({ tool: 'write', params: { path: target, content: 'candidate\n' }, cwd: a, target, sdkUrl, warden, signal: controller.signal });
  result = run.then(value => ({ value }), error => ({ error }));
  let pid;
  for (let i = 0; i < 400; i++) {
    try { pid = Number.parseInt(await fs.readFile(ready, 'utf8'), 10); break; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await delay(20);
  }
  assert.ok(Number.isInteger(pid) && pid > 0, 'actual writer must reach the held scratch-fsync boundary');
  const entries = await fs.readdir(scratch); assert.equal(entries.length, 1);
  assert.equal(await fs.readFile(join(scratch, entries[0]), 'utf8'), 'candidate\n');
  assert.equal(await fs.readFile(target, 'utf8'), 'original\n');
  assert.doesNotThrow(() => process.kill(pid, 0), 'writer must remain alive while scratch fsync is held');

  // A separate repository must complete a real metadata transaction while A
  // is paused inside its private scratch fsync and still owns its own fence.
  const other = join(b, '.gitignore');
  const independent = await runFencedMutation({ tool: 'write', params: { path: other, content: 'independent\n' }, cwd: b, target: other, sdkUrl, warden, signal: AbortSignal.timeout(15000) });
  assert.match(independent.content[0].text, /Successfully wrote/);
  assert.equal(await fs.readFile(other, 'utf8'), 'independent\n');
  assert.doesNotThrow(() => process.kill(pid, 0), 'A must still own its fence while B publishes');
  assert.equal(await fs.readFile(target, 'utf8'), 'original\n');

  controller.abort();
  await fs.writeFile(release, 'release\n');
  const outcome = await result; assert.ok(outcome.error); assert.match(outcome.error.message, /cancelled/);
  const after = await fs.stat(target, { bigint: true });
  assert.equal(after.ino, original.ino); assert.equal(after.size, original.size);
  assert.equal(await fs.readFile(target, 'utf8'), 'original\n');
  assert.deepEqual(await fs.readdir(scratch), []);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  // A new native participant acquiring A's fence proves the cancelled writer
  // did not retain its inherited OFD after client settlement.
  await exec(warden, ['write-fence', '--repo', a, '--wait-secs', '1', '--run-secs', '1', '--', 'true'], { timeout: 3000, env: gitEnvironment() });
});
