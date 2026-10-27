import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runFencedMutation, gitEnvironment } from '../client.js';
const exec = promisify(execFile);
test('actual scratch write and fsync ENOSPC refuse without replacing canonical content or leaking scratch/fence', { timeout: 20000 }, async t => {
  const warden = process.env.PI_CANONICAL_TEST_WARDEN, sdkUrl = process.env.PI_CANONICAL_TEST_SDK;
  assert.ok(warden && sdkUrl, 'qualified artifacts required');
  const root = await fs.mkdtemp(join(tmpdir(), 'canonical-io-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await exec('git', ['init', '-q', '--template=', repo], { env: gitEnvironment() });
  const target = join(repo, '.gitignore'); await fs.writeFile(target, 'original\n');
  const original = await fs.stat(target, { bigint: true });
  const library = join(root, 'fail-scratch-io.so');
  await exec('cc', ['-shared', '-fPIC', '-Wall', '-Wextra', '-Werror', '-o', library,
    fileURLToPath(new URL('./fixtures/fail-scratch-io.c', import.meta.url)), '-ldl'], { timeout: 10000 });
  const oldPreload = process.env.LD_PRELOAD, oldMode = process.env.DRACON_TEST_SCRATCH_IO_FAILURE;
  t.after(() => {
    if (oldPreload === undefined) delete process.env.LD_PRELOAD; else process.env.LD_PRELOAD = oldPreload;
    if (oldMode === undefined) delete process.env.DRACON_TEST_SCRATCH_IO_FAILURE; else process.env.DRACON_TEST_SCRATCH_IO_FAILURE = oldMode;
  });
  process.env.LD_PRELOAD = library + (oldPreload ? ':' + oldPreload : '');
  for (const stage of ['write', 'sync']) {
    process.env.DRACON_TEST_SCRATCH_IO_FAILURE = stage;
    await assert.rejects(runFencedMutation({ tool: 'write', params: { path: target, content: 'candidate\n' }, cwd: repo, target, sdkUrl, warden }), /ENOSPC/);
    const after = await fs.stat(target, { bigint: true });
    assert.equal(after.ino, original.ino); assert.equal(after.size, original.size);
    assert.equal(await fs.readFile(target, 'utf8'), 'original\n');
    assert.deepEqual(await fs.readdir(join(repo, '.git/dracon-canonical-writes-v1')), []);
    await exec(warden, ['write-fence', '--repo', repo, '--wait-secs', '1', '--run-secs', '1', '--', 'true'], { timeout: 3000, env: gitEnvironment() });
  }
});
