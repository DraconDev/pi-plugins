import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { gitEnvironment } from '../client.js';
const exec = promisify(execFile);
for (const holdMs of [0, 6500]) {
  // Same meaningful full-content/inode/mode contract for quick abort AND a
  // write still blocked after the former helper's five-second SIGKILL grace.
  test(`loaded ordinary write settles before abort releases fence (hold ${holdMs}ms)`, { timeout: 30000 }, async t => {
    const warden = process.env.PI_CANONICAL_TEST_WARDEN;
    assert.ok(warden && process.env.PI_CANONICAL_TEST_SDK && process.env.PI_CANONICAL_NATIVE_BINDING, 'qualified artifacts required');
    const root = await fs.mkdtemp(join(tmpdir(), 'canonical-ordinary-cancel-'));
    let child, closed;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      }
      await closed;
      await fs.rm(root, { recursive: true, force: true });
    });
    const repo = join(root, 'repo'), other = join(root, 'other');
    for (const path of [repo, other]) await exec('git', ['init', '-q', '--template=', path], { env: gitEnvironment() });
    const target = join(repo, 'note.txt');
    await fs.writeFile(target, 'original-ordinary-content\n', { mode: 0o640 });
    const before = await fs.stat(target, { bigint: true });
    const candidate = 'candidate-ordinary-content-'.repeat(200) + '\n';
    const library = join(root, 'gate-ordinary-write.so');
    await exec('cc', ['-shared', '-fPIC', '-Wall', '-Wextra', '-Werror', '-o', library,
      fileURLToPath(new URL('./fixtures/gate-ordinary-write.c', import.meta.url)), '-ldl'], { timeout: 10000 });
    const ready = join(root, 'ready'), release = join(root, 'release'), abort = join(root, 'abort'), ack = join(root, 'ack'), progress = join(root, 'progress');
    const env = { ...gitEnvironment(), LD_PRELOAD: library,
      PI_CANONICAL_GATE_TARGET: target, PI_CANONICAL_GATE_READY: ready, PI_CANONICAL_GATE_RELEASE: release,
      PI_CANONICAL_GATE_REPO: repo, PI_CANONICAL_GATE_AGENT: join(root, 'agent'),
      PI_CANONICAL_GATE_ABORT: abort, PI_CANONICAL_GATE_ACK: ack,
      PI_CANONICAL_GATE_OTHER: other, PI_CANONICAL_GATE_PROGRESS: progress };
    child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/loaded-ordinary-write.mjs', import.meta.url))], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    closed = new Promise(resolve => { child.once('close', (code, signal) => resolve({ code, signal })); child.once('error', error => resolve({ error })); });
    async function waitFor(path) {
      for (let i = 0; i < 600; i++) {
        try { await fs.access(path); return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (child.exitCode !== null || child.signalCode !== null) assert.fail(`runtime ended early: ${stderr}`);
        await delay(10);
      }
      assert.fail(`runtime did not reach boundary: ${path}; ${stderr}`);
    }
    await waitFor(ready);
    assert.equal(await fs.readFile(target, 'utf8'), '', 'exercise actual post-truncation pending I/O');
    const started = performance.now();
    await fs.writeFile(abort, 'abort'); await waitFor(ack); await waitFor(progress);
    assert.equal(await fs.readFile(join(other, '.gitignore'), 'utf8'), 'independent\n', 'same Pi process must still publish another repository');
    await assert.rejects(exec(warden, ['write-fence', '--repo', repo, '--wait-secs', '1', '--run-secs', '1', '--', 'true'], { timeout: 4000, env: gitEnvironment() }), 'pending SDK I/O must retain the actual native fence');
    if (holdMs) await delay(Math.max(0, holdMs - (performance.now() - started)));
    assert.equal(child.exitCode, null, 'caller abort must not kill the SDK-writing process');
    await fs.writeFile(release, 'go');
    const outcome = await closed;
    assert.equal(outcome.code, 0, stderr); assert.equal(JSON.parse(stdout).cancelled, true);
    assert.equal(await fs.readFile(target, 'utf8'), candidate, 'retain full content assertion; no truncated partial or silent original');
    const after = await fs.stat(target, { bigint: true });
    assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode);
    await exec(warden, ['write-fence', '--repo', repo, '--wait-secs', '1', '--run-secs', '1', '--', 'true'], { timeout: 4000, env: gitEnvironment() });
    const scratch = await fs.readdir(join(repo, '.git/dracon-canonical-writes-v1')).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    assert.deepEqual(scratch, []);
  });
}
