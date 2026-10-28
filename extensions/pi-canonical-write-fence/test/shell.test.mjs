import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { gitEnvironment } from '../client.js';
import { createFencedBashOperations } from '../shell.js';

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'canonical-shell-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['init', '--template=', '-q', '-b', 'main', root], { env: gitEnvironment() });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(`git init exited ${code}`)));
  });
  return root;
}

async function qualifiedOperations() {
  assert.ok(process.env.PI_CANONICAL_TEST_SDK, 'qualified Pi SDK artifact required');
  assert.ok(process.env.PI_CANONICAL_TEST_WARDEN, 'qualified Warden artifact required');
  const sdkUrl = new URL(process.env.PI_CANONICAL_TEST_SDK);
  const [{ waitForChildProcess }, { getShellConfig }] = await Promise.all([
    import(new URL('./utils/child-process.js', sdkUrl).href),
    import(new URL('./utils/shell.js', sdkUrl).href),
  ]);
  return createFencedBashOperations({
    warden: process.env.PI_CANONICAL_TEST_WARDEN,
    shellConfig: getShellConfig(),
    waitForChildProcess,
  });
}

function waitForText(chunks, text, promise, timeoutMs = 5000) {
  return Promise.race([
    new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (chunks.join('').includes(text)) return resolve();
        if (Date.now() - started >= timeoutMs) return reject(Error(`timed out waiting for ${text}`));
        setTimeout(poll, 10).unref?.();
      };
      poll();
    }),
    promise.then(() => { throw Error(`command exited before ${text}`); }),
  ]);
}

test('fenced Pi shell serializes same-worktree native Git and preserves cross-repo concurrency', async t => {
  const operations = await qualifiedOperations();
  const repo = await fixture(t);
  const otherRepo = await fixture(t);
  const firstChunks = [];
  let firstSettled = false;
  const first = operations.exec('printf first-ready; sleep 0.7; git checkout -q -b fenced-branch; printf first-done', repo, {
    timeout: 8,
    onData: chunk => firstChunks.push(chunk.toString()),
  }).finally(() => { firstSettled = true; });
  await waitForText(firstChunks, 'first-ready', first);

  const secondChunks = [];
  const second = operations.exec('printf second-done', repo, {
    timeout: 8,
    onData: chunk => secondChunks.push(chunk.toString()),
  });
  let otherOutput = '';
  const other = await operations.exec('printf other-repo-done', otherRepo, {
    timeout: 5,
    onData: chunk => { otherOutput += chunk.toString(); },
  });
  assert.equal(other.exitCode, 0);
  assert.match(otherOutput, /other-repo-done/);
  assert.equal(firstSettled, false, 'unrelated worktree should not wait on the first worktree fence');
  assert.equal(secondChunks.join(''), '', 'same-worktree command must not start before the first fence releases');

  assert.equal((await first).exitCode, 0);
  assert.equal((await second).exitCode, 0);
  assert.match(firstChunks.join(''), /first-done/);
  assert.match(secondChunks.join(''), /second-done/);
  const branch = await new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, 'branch', '--show-current'], { env: gitEnvironment() });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output.trim()) : reject(Error(`git branch exited ${code}`)));
  });
  assert.equal(branch, 'fenced-branch');
});

test('shell cancellation terminates the writer family and releases the fence', async t => {
  const operations = await qualifiedOperations();
  const repo = await fixture(t);
  const controller = new AbortController();
  const chunks = [];
  const started = operations.exec('printf cancellation-ready; sleep 30', repo, {
    signal: controller.signal,
    timeout: 12,
    onData: chunk => chunks.push(chunk.toString()),
  });
  await waitForText(chunks, 'cancellation-ready', started);
  const began = Date.now();
  controller.abort();
  await assert.rejects(started, /aborted/);
  assert.ok(Date.now() - began < 8000, 'owned shell process family should terminate within the bounded cancellation window');
  const followup = await operations.exec('printf recovered', repo, { timeout: 5, onData: () => {} });
  assert.equal(followup.exitCode, 0, 'a later independent shell writer must acquire the released worktree fence');
});

test('shell outside a Git worktree refuses before command execution', async t => {
  const operations = await qualifiedOperations();
  const cwd = await fs.mkdtemp(join(tmpdir(), 'canonical-shell-outside-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  let output = '';
  await assert.rejects(
    operations.exec('printf unsafe', cwd, { onData: chunk => { output += chunk.toString(); } }),
    /fail-closed outside a Git worktree/,
  );
  assert.equal(output, '', 'unowned shell command must not start');
});

test('nested Pi shell wrapper propagates the inherited Warden fence descriptor', async t => {
  const repo = await fixture(t);
  assert.ok(process.env.PI_CANONICAL_TEST_SDK, 'qualified Pi SDK artifact required');
  assert.ok(process.env.PI_CANONICAL_TEST_WARDEN, 'qualified Warden artifact required');
  assert.equal(process.env.DRACON_CANONICAL_WRITER_FD_V1, undefined, 'qualification driver must not inherit a parent writer fence');
  const shellUrl = new URL('../shell.js', import.meta.url).href;
  const script = `
    const { createFencedBashOperations } = await import(${JSON.stringify(shellUrl)});
    const [{ waitForChildProcess }, { getShellConfig }] = await Promise.all([
      import(new URL('./utils/child-process.js', process.env.PI_CANONICAL_TEST_SDK)),
      import(new URL('./utils/shell.js', process.env.PI_CANONICAL_TEST_SDK)),
    ]);
    const ops = createFencedBashOperations({ warden: process.env.PI_CANONICAL_TEST_WARDEN, shellConfig: getShellConfig(), waitForChildProcess });
    let output = '';
    const result = await ops.exec('printf nested-inherited-fence', process.cwd(), { env: process.env, onData: chunk => { output += chunk.toString(); } });
    if (result.exitCode !== 0 || !output.includes('nested-inherited-fence')) process.exit(7);
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.env.PI_CANONICAL_TEST_WARDEN, [
      'write-fence', '--repo', repo, '--wait-secs', '5', '--run-secs', '15', '--',
      process.execPath, '--input-type=module', '-e', script,
    ], {
      cwd: repo,
      env: {
        ...process.env,
        DRACON_CANONICAL_WARDEN_HELPER: process.env.PI_CANONICAL_TEST_WARDEN,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
});
