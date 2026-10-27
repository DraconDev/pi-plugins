import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitEnvironment } from '../client.js';
const exec = promisify(execFile);
async function fixture(t) {
  assert.ok(process.env.PI_CANONICAL_TEST_SDK && process.env.PI_CANONICAL_TEST_WARDEN, 'qualified artifacts required');
  const sdk = await import(process.env.PI_CANONICAL_TEST_SDK);
  const root = await fs.mkdtemp(join(tmpdir(), 'canonical-alias-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo'), agentDir = join(root, 'agent'); await fs.mkdir(agentDir);
  await exec('git', ['init', '-q', '--template=', cwd], { env: gitEnvironment() });
  const prior = process.env.DRACON_CANONICAL_WARDEN_HELPER;
  process.env.DRACON_CANONICAL_WARDEN_HELPER = process.env.PI_CANONICAL_TEST_WARDEN;
  t.after(() => { if (prior === undefined) delete process.env.DRACON_CANONICAL_WARDEN_HELPER; else process.env.DRACON_CANONICAL_WARDEN_HELPER = prior; });
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir,
    settingsManager: sdk.SettingsManager.inMemory({ packages: [], extensions: [] }),
    additionalExtensionPaths: [fileURLToPath(new URL('../index.js', import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload(); const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []);
  const tools = loaded.extensions[0].tools, ctx = { cwd };
  return { root, cwd, write: p => tools.get('write').definition.execute('alias-write', p, undefined, undefined, ctx),
    edit: p => tools.get('edit').definition.execute('alias-edit', p, undefined, undefined, ctx) };
}
test('differently named same-repo metadata alias uses atomic canonical publication and preserves alias', async t => {
  const f = await fixture(t), target = join(f.cwd, '.gitignore'), alias = join(f.cwd, 'ignore-link');
  await fs.writeFile(target, 'cache/\n'); const old = await fs.stat(target);
  await fs.symlink('.gitignore', alias);
  await f.write({ path: 'ignore-link', content: 'assets/\n' });
  assert.equal(await fs.readFile(target, 'utf8'), 'assets/\n');
  assert.notEqual((await fs.stat(target)).ino, old.ino, 'must not use an unfenced in-place fallback');
  assert.equal(await fs.readlink(alias), '.gitignore');
  await f.edit({ path: 'ignore-link', edits: [{ oldText: 'assets/', newText: 'images/' }] });
  assert.equal(await fs.readFile(target, 'utf8'), 'images/\n');
  assert.equal(await fs.readlink(alias), '.gitignore');
});
test('cross-repo metadata alias refuses instead of mutating under the wrong repository fence', async t => {
  const f = await fixture(t), other = join(f.root, 'other');
  await exec('git', ['init', '-q', '--template=', other], { env: gitEnvironment() });
  const target = join(other, '.gitignore'); await fs.writeFile(target, 'preserve\n');
  const alias = join(f.cwd, 'cross-link'); await fs.symlink(target, alias);
  await assert.rejects(f.write({ path: 'cross-link', content: 'must not publish' }), /cross-repository/);
  assert.equal(await fs.readFile(target, 'utf8'), 'preserve\n'); assert.equal(await fs.readlink(alias), target);
});
test('ordinary regular worktree writes/edits preserve inode and mode rather than metadata replacement semantics', async t => {
  const f = await fixture(t), path = join(f.cwd, 'note.txt');
  await fs.writeFile(path, 'old\n', { mode: 0o640 }); const before = await fs.stat(path);
  await f.write({ path: 'note.txt', content: 'new\n' });
  await f.edit({ path: 'note.txt', edits: [{ oldText: 'new', newText: 'edited' }] });
  const after = await fs.stat(path); assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode);
  assert.equal(await fs.readFile(path, 'utf8'), 'edited\n');
});
test('unowned plain files stay usable but outside symlink/hardlink aliases cannot bypass metadata fencing', async t => {
  const f = await fixture(t), outside = join(f.root, 'note.txt');
  await fs.writeFile(outside, 'outside old\n'); const old = await fs.stat(outside);
  await f.write({ path: outside, content: 'outside new\n' });
  await f.edit({ path: outside, edits: [{ oldText: 'new', newText: 'edited' }] });
  assert.equal((await fs.stat(outside)).ino, old.ino);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside edited\n');
  const target = join(f.cwd, '.gitignore'); await fs.writeFile(target, 'preserve\n');
  const alias = join(f.root, 'outside-link'); await fs.symlink(target, alias);
  await assert.rejects(f.write({ path: alias, content: 'must not publish' }), /ELOOP|symbolic/);
  await fs.unlink(alias); await fs.link(target, alias);
  await assert.rejects(f.write({ path: alias, content: 'must not publish' }), /unsupported/);
  assert.equal(await fs.readFile(target, 'utf8'), 'preserve\n');
});
test('broken Git ownership metadata is an error, never an ordinary unfenced fallback', async t => {
  const f = await fixture(t), path = join(f.root, 'outside-note'); await fs.writeFile(path, 'preserve\n');
  await fs.writeFile(join(f.root, '.git'), 'gitdir: /nonexistent-canonical-fixture\n');
  await assert.rejects(f.write({ path, content: 'must not publish' }));
  assert.equal(await fs.readFile(path, 'utf8'), 'preserve\n');
});
