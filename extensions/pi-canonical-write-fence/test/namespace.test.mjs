import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, observe } from '../atomic.js';
test('namespace replacement does not make cleanup delete a foreign replacement entry', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'canonical-namespace-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const gitdir = join(root, '.git'); await fs.mkdir(gitdir);
  const path = join(root, '.gitignore'); await fs.writeFile(path, 'canonical old\n');
  const before = await observe(path); const scratch = join(gitdir, 'dracon-canonical-writes-v1');
  const displaced = join(gitdir, 'displaced-test-owned-scratch'); let name;
  await assert.rejects(atomicWrite(path, 'owned candidate\n', { gitdir, before, beforePublish: async () => {
    [name] = await fs.readdir(scratch);
    await fs.rename(scratch, displaced);
    await fs.mkdir(scratch, { mode: 0o700 });
    await fs.writeFile(join(scratch, name), 'foreign replacement\n');
  } }), /namespace changed/);
  assert.equal(await fs.readFile(join(scratch, name), 'utf8'), 'foreign replacement\n');
  await assert.rejects(fs.access(join(displaced, name)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path, 'utf8'), 'canonical old\n');
});
