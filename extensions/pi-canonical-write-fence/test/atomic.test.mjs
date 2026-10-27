import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, observe } from '../atomic.js';
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'canonical-atomic-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const gitdir = join(root, '.git'); await fs.mkdir(gitdir);
  const path = join(root, '.gitignore'); await fs.writeFile(path, 'old\n', { mode: 0o640 });
  return { root, gitdir, path, before: await observe(path) };
}
test('complete atomic publication preserves original mode and removes private scratch', async t => {
  const f = await fixture(t);
  await atomicWrite(f.path, 'new λ\n', f);
  assert.equal(await fs.readFile(f.path, 'utf8'), 'new λ\n');
  assert.equal((await fs.stat(f.path)).mode & 0o777, 0o640);
  const scratch = join(f.gitdir, 'dracon-canonical-writes-v1');
  assert.equal((await fs.stat(scratch)).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(scratch), []);
});
test('cancellation after full scratch write does not truncate or replace canonical bytes', async t => {
  const f = await fixture(t); const controller = new AbortController();
  await assert.rejects(atomicWrite(f.path, 'candidate\n', { ...f, signal: controller.signal, beforePublish: () => controller.abort() }), /aborted/);
  assert.equal(await fs.readFile(f.path, 'utf8'), 'old\n');
  assert.equal((await observe(f.path)).stamp, f.before.stamp);
  assert.deepEqual(await fs.readdir(join(f.gitdir, 'dracon-canonical-writes-v1')), []);
});
test('stale canonical content is refused, not adopted as the old baseline', async t => {
  const f = await fixture(t);
  await assert.rejects(atomicWrite(f.path, 'stale render\n', { ...f, beforePublish: () => fs.writeFile(f.path, 'other writer\n') }), /changed/);
  assert.equal(await fs.readFile(f.path, 'utf8'), 'other writer\n');
});
test('symlink and shared-hardlink targets refuse without touching their contents', async t => {
  const f = await fixture(t); const alias = join(f.root, 'alias');
  await fs.symlink(f.path, alias); await assert.rejects(observe(alias), /single-link regular/);
  await fs.unlink(alias); await fs.link(f.path, alias);
  await assert.rejects(observe(f.path), /single-link regular/);
  assert.equal(await fs.readFile(f.path, 'utf8'), 'old\n');
});
test('owned recovery inode budget refuses without deleting recovery or changing target', async t => {
  const f = await fixture(t); const scratch = join(f.gitdir, 'dracon-canonical-writes-v1');
  await fs.mkdir(scratch, { mode: 0o700 });
  for (let i = 0; i < 64; i++) await fs.writeFile(join(scratch, 'dracon-canonical-write-v1-' + i), 'recovery');
  await assert.rejects(atomicWrite(f.path, 'new\n', f), /budget exhausted/);
  assert.equal((await fs.readdir(scratch)).length, 64);
  assert.equal(await fs.readFile(f.path, 'utf8'), 'old\n');
});
test('a substituted scratch namespace refuses without publishing into the worktree', async t => {
  const f = await fixture(t); const scratch = join(f.gitdir, 'dracon-canonical-writes-v1');
  await fs.symlink(f.root, scratch);
  await assert.rejects(atomicWrite(f.path, 'new\n', f), /unsafe canonical scratch/);
  assert.equal(await fs.readFile(f.path, 'utf8'), 'old\n');
});
