import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withFence } from '../lease.js';
import { gitEnvironment } from '../client.js';
const exec = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'canonical-lease-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q', '--template=', root], { env: gitEnvironment() });
  return root;
}
test('in-process lease interoperates with actual Warden and independent repository', async t => {
  const a = await fixture(t), b = await fixture(t), warden = process.env.PI_CANONICAL_TEST_WARDEN;
  assert.ok(warden, 'qualified native peer required');
  await withFence(a, undefined, async () => {
    await assert.rejects(exec(warden, ['write-fence', '--repo', a, '--wait-secs', '1', '--run-secs', '1', '--', 'true'], { timeout: 4000, env: gitEnvironment() }));
    await withFence(b, undefined, async ({ verify }) => verify());
  });
  const inode = (await fs.stat(join(a, '.git/dracon-canonical-writer-v1.lock'))).ino;
  await exec(warden, ['write-fence', '--repo', a, '--wait-secs', '1', '--run-secs', '1', '--', 'true'], { timeout: 4000, env: gitEnvironment() });
  assert.equal((await fs.stat(join(a, '.git/dracon-canonical-writer-v1.lock'))).ino, inode);
});
test('bounded acquisition and cancelled waiter close their descriptors without releasing current owner', async t => {
  const repo = await fixture(t), path = join(repo, '.git/dracon-canonical-writer-v1.lock');
  async function descriptors() {
    const list = await fs.readdir('/proc/self/fd');
    return (await Promise.all(list.map(fd => fs.readlink('/proc/self/fd/' + fd).catch(e => { if (e.code !== 'ENOENT') throw e; return ''; })))).filter(p => p === path).length;
  }
  await withFence(repo, undefined, async () => {
    await assert.rejects(withFence(repo, undefined, () => assert.fail('must not enter'), { waitMs: 100 }), /deadline/);
    await assert.rejects(withFence(repo, AbortSignal.timeout(100), () => assert.fail('must not enter')), /abort/i);
    assert.equal(await descriptors(), 1, 'no waiter descriptor leak or stolen lock');
  });
  assert.equal(await descriptors(), 0);
});
test('unsafe symlink, hardlink and permissive lock files refuse without truncation', async t => {
  for (const kind of ['symlink', 'hardlink', 'permissive']) {
    const repo = await fixture(t), outside = join(repo, 'outside'), lock = join(repo, '.git/dracon-canonical-writer-v1.lock');
    await fs.writeFile(outside, 'preserve');
    if (kind === 'symlink') await fs.symlink(outside, lock);
    else if (kind === 'hardlink') await fs.link(outside, lock);
    else await fs.writeFile(lock, 'preserve', { mode: 0o666 });
    if (kind === 'permissive') await fs.chmod(lock, 0o666);
    await assert.rejects(withFence(repo, undefined, () => assert.fail('unsafe lease')));
    assert.equal(await fs.readFile(outside, 'utf8'), 'preserve');
  }
});
test('inherited native OFD is reentrant, cross-repo reuse refuses, and duplicate close never unlocks outer owner', { timeout: 10000 }, async t => {
  const a = await fixture(t), b = await fixture(t), warden = process.env.PI_CANONICAL_TEST_WARDEN;
  assert.ok(warden, 'qualified native peer required');
  const script = `import assert from 'node:assert/strict';
    import {execFile} from 'node:child_process'; import {promisify} from 'node:util';
    import {withFence} from ${JSON.stringify(new URL('../lease.js', import.meta.url).href)};
    await withFence(${JSON.stringify(a)}, undefined, async ({verify}) => verify());
    await assert.rejects(withFence(${JSON.stringify(b)}, undefined, () => assert.fail('foreign inherited OFD')));
    const env = {...process.env}; delete env.DRACON_CANONICAL_WRITER_FD_V1;
    await assert.rejects(promisify(execFile)(${JSON.stringify(warden)}, ['write-fence','--repo',${JSON.stringify(a)},'--wait-secs','1','--run-secs','1','--','true'], {env, timeout:4000}));`;
  await exec(warden, ['write-fence', '--repo', a, '--wait-secs', '1', '--run-secs', '6', '--', process.execPath, '--input-type=module', '-e', script], { timeout: 8000, env: gitEnvironment() });
});
test('replaced fence namespace refuses through its held verifier', async t => {
  const repo = await fixture(t), lock = join(repo, '.git/dracon-canonical-writer-v1.lock');
  await withFence(repo, undefined, async ({ verify }) => {
    await fs.rename(lock, lock + '.displaced'); await fs.writeFile(lock, '', { mode: 0o600 });
    await assert.rejects(verify(), /replaced/);
  });
});
