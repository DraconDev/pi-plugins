import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { runFencedMutation, gitEnvironment } from '../client.js';
const exec = promisify(execFile);
test('actual cancellation before rename preserves canonical bytes, reaps owned writer and permits independent repo progress', { timeout: 20000 }, async t => {
  const warden = process.env.PI_CANONICAL_TEST_WARDEN, sdkUrl = process.env.PI_CANONICAL_TEST_SDK;
  assert.ok(warden && sdkUrl, 'qualified artifacts required');
  const root = await fs.mkdtemp(join(tmpdir(), 'canonical-cancel-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = join(root, 'a'), b = join(root, 'b');
  for (const repo of [a, b]) await exec('git', ['init', '-q', '--template=', repo], { env: gitEnvironment() });
  const target = join(a, '.gitignore'); await fs.writeFile(target, 'original\n');
  const original = await fs.stat(target, { bigint: true });
  const { stdout } = await exec('which', ['git']); const realGit = stdout.trim();
  const shimdir = join(root, 'bin'); await fs.mkdir(shimdir);
  const ready = join(root, 'ready');
  // Synchronize on the real beforePublish authority lookup AFTER scratch
  // exists, rather than a brittle ordinal count of discovery subprocesses.
  const scratch = join(a, '.git/dracon-canonical-writes-v1');
  const script = `#!/usr/bin/env python3\nimport os,sys,pathlib,time,json\nready=pathlib.Path(${JSON.stringify(ready)})\nscratch=pathlib.Path(${JSON.stringify(scratch)})\nif 'rev-parse' in sys.argv and ${JSON.stringify(a)} in sys.argv and scratch.exists() and any(scratch.iterdir()) and not ready.exists():\n temp=ready.with_suffix('.new')\n temp.write_text(json.dumps({'pid':os.getpid(),'writer':os.getppid()}))\n temp.replace(ready)\n while True: time.sleep(1)\nos.execv(${JSON.stringify(realGit)},[${JSON.stringify(realGit)},*sys.argv[1:]])\n`;
  await fs.writeFile(join(shimdir, 'git'), script, { mode: 0o700 });
  const oldPath = process.env.PATH; process.env.PATH = shimdir + ':' + oldPath;
  t.after(() => { process.env.PATH = oldPath; });
  const controller = new AbortController(); t.after(() => controller.abort());
  const run = runFencedMutation({ tool: 'write', params: { path: target, content: 'candidate\n' }, cwd: a, target, sdkUrl, warden, signal: controller.signal });
  // Attach immediately: an early producer error is evidence, not an unhandled
  // rejection hidden by the synchronization wait.
  const result = run.then(value => ({ value }), error => ({ error }));
  let state;
  for (let i = 0; i < 400; i++) {
    try { state = JSON.parse(await fs.readFile(ready, 'utf8')); break; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await delay(20);
  }
  assert.ok(state?.pid, 'actual writer must reach the instrumented pre-publication boundary');
  const pid = state.pid;
  const entries = await fs.readdir(scratch); assert.equal(entries.length, 1);
  const handles = await fs.readdir(`/proc/${state.writer}/fd`);
  const destinations = await Promise.all(handles.map(fd => fs.readlink(`/proc/${state.writer}/fd/${fd}`).catch(e => { if (e.code !== 'ENOENT') throw e; return ''; })));
  assert.ok(!destinations.some(path => path.endsWith('/' + entries[0])), 'scratch file must already be closed before the publication boundary');
  assert.equal(await fs.readFile(join(scratch, entries[0]), 'utf8'), 'candidate\n');
  assert.equal(await fs.readFile(target, 'utf8'), 'original\n');
  // Independent repository must publish while A still owns its fence.
  const other = join(b, '.gitignore');
  const independent = await runFencedMutation({ tool: 'write', params: { path: other, content: 'independent\n' }, cwd: b, target: other, sdkUrl, warden, signal: AbortSignal.timeout(5000) });
  assert.match(independent.content[0].text, /Successfully wrote/);
  assert.equal(await fs.readFile(other, 'utf8'), 'independent\n');
  controller.abort();
  const outcome = await result; assert.ok(outcome.error); assert.match(outcome.error.message, /cancelled/);
  const after = await fs.stat(target, { bigint: true });
  assert.equal(after.ino, original.ino); assert.equal(after.size, original.size);
  assert.equal(await fs.readFile(target, 'utf8'), 'original\n');
  assert.deepEqual(await fs.readdir(scratch), []);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  // A new actual native participant acquiring the same fence proves the
  // cancelled worker did not retain its inherited OFD after client settlement.
  await exec(warden, ['write-fence', '--repo', a, '--wait-secs', '1', '--run-secs', '1', '--', 'true'], { timeout: 3000, env: gitEnvironment() });
});
