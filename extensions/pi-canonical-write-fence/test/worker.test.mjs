import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { runFencedMutation, gitEnvironment } from '../client.js';
const exec = promisify(execFile);
const warden = process.env.PI_CANONICAL_TEST_WARDEN;
const sdkUrl = process.env.PI_CANONICAL_TEST_SDK;
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'canonical-worker-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await exec('git', ['init', '-q', '--template=', root], { env: gitEnvironment() });
  const target = join(root, '.gitignore');
  await fs.writeFile(target, '\ufeff# λ\r\ncache/\r\n');
  return { cwd: root, target, repo: root, warden, sdkUrl };
}
test('actual fenced SDK edit preserves BOM, CRLF, Unicode and native diff contract', async t => {
  assert.ok(warden && sdkUrl, 'set PI_CANONICAL_TEST_WARDEN and PI_CANONICAL_TEST_SDK to qualified artifacts');
  const f = await fixture(t);
  const result = await runFencedMutation({ ...f, tool: 'edit', params: { path: f.target, edits: [{ oldText: 'cache/', newText: 'assets/' }] } });
  assert.equal(await fs.readFile(f.target, 'utf8'), '\ufeff# λ\r\nassets/\r\n');
  assert.match(result.content[0].text, /Successfully replaced 1 block/);
  assert.match(result.details.patch, /assets\//);
});
test('actual SDK write completes atomically and ambiguous edits preserve prior bytes', async t => {
  assert.ok(warden && sdkUrl, 'qualified worker artifacts required');
  const f = await fixture(t);
  const result = await runFencedMutation({ ...f, tool: 'write', params: { path: f.target, content: 'same\nsame\n' } });
  assert.match(result.content[0].text, /Successfully wrote/);
  await assert.rejects(runFencedMutation({ ...f, tool: 'edit', params: { path: f.target, edits: [{ oldText: 'same', newText: 'replacement' }] } }));
  assert.equal(await fs.readFile(f.target, 'utf8'), 'same\nsame\n');
});
test('worker launched without a held descriptor refuses before target mutation', async t => {
  assert.ok(sdkUrl, 'qualified SDK required');
  const f = await fixture(t); const original = await fs.readFile(f.target);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../worker.js', import.meta.url)), sdkUrl], { env: { ...gitEnvironment(), DRACON_CANONICAL_WRITER_FD_V1: '' }, stdio: ['pipe', 'ignore', 'pipe'] });
  let error = ''; child.stderr.on('data', b => { error += b; });
  child.stdin.end(JSON.stringify({ ...f, tool: 'write', params: { path: f.target, content: 'must not publish' } }));
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  assert.equal(code, 1); assert.match(error, /missing inherited canonical fence/);
  assert.deepEqual(await fs.readFile(f.target), original);
});
