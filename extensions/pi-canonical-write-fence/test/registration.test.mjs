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
test('real Pi loader registers native contracts and executes fenced metadata with dynamic cwd', async t => {
  assert.ok(process.env.PI_CANONICAL_TEST_SDK && process.env.PI_CANONICAL_TEST_WARDEN, 'qualified artifacts required');
  const sdk = await import(process.env.PI_CANONICAL_TEST_SDK);
  const root = await fs.mkdtemp(join(tmpdir(), 'canonical-registration-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo'); const agentDir = join(root, 'agent');
  await fs.mkdir(cwd); await fs.mkdir(agentDir);
  await exec('git', ['init', '-q', '--template=', cwd], { env: gitEnvironment() });
  const prior = process.env.DRACON_CANONICAL_WARDEN_HELPER;
  process.env.DRACON_CANONICAL_WARDEN_HELPER = process.env.PI_CANONICAL_TEST_WARDEN;
  t.after(() => { if (prior === undefined) delete process.env.DRACON_CANONICAL_WARDEN_HELPER; else process.env.DRACON_CANONICAL_WARDEN_HELPER = prior; });
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir,
    settingsManager: sdk.SettingsManager.inMemory({ packages: [], extensions: [] }),
    additionalExtensionPaths: [fileURLToPath(new URL('../index.js', import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  const write = extension.tools.get('write').definition;
  const edit = extension.tools.get('edit').definition;
  const bash = extension.tools.get('bash').definition;
  assert.deepEqual(write.parameters, sdk.createWriteToolDefinition(cwd).parameters);
  assert.deepEqual(edit.parameters, sdk.createEditToolDefinition(cwd).parameters);
  assert.deepEqual(bash.parameters, sdk.createBashTool(cwd).parameters);
  assert.equal(extension.handlers.get('user_bash')?.length, 1);
  const ctx = { cwd };
  const written = await write.execute('loaded-write', { path: '@sub/.gitattributes', content: '*.env filter=dracon\n' }, undefined, undefined, ctx);
  assert.ok(Object.hasOwn(written, 'details'));
  assert.equal(written.details, undefined);
  const input = edit.prepareArguments({ path: '@sub/.gitattributes', oldText: '*.env', newText: '*.secret' });
  const edited = await edit.execute('loaded-edit', input, undefined, undefined, ctx);
  assert.match(edited.details.patch, /\*\.secret/);
  assert.equal(await fs.readFile(join(cwd, 'sub/.gitattributes'), 'utf8'), '*.secret filter=dracon\n');
  // Ordinary files retain native in-place semantics and dynamic cwd inside
  // the same pre-open worktree boundary (not a basename-only bypass).
  await write.execute('ordinary-write', { path: 'note.txt', content: 'ordinary\n' }, undefined, undefined, ctx);
  assert.equal(await fs.readFile(join(cwd, 'note.txt'), 'utf8'), 'ordinary\n');
  const shellCtx = { ...ctx, sessionManager: { getSessionId: () => 'canonical-test', getSessionFile: () => undefined } };
  const bashResult = await bash.execute('loaded-bash', { command: 'printf loaded-bash-fenced' }, undefined, undefined, shellCtx);
  assert.ok(bashResult.content.some(item => item.type === 'text' && item.text.includes('loaded-bash-fenced')));
  const userBash = await extension.handlers.get('user_bash')[0]({
    type: 'user_bash', command: 'printf user-bash-fenced', excludeFromContext: false, cwd,
  }, shellCtx);
  let userBashOutput = '';
  const userBashResult = await userBash.operations.exec('printf user-bash-fenced', cwd, {
    onData: chunk => { userBashOutput += chunk.toString(); },
    env: process.env,
  });
  assert.equal(userBashResult.exitCode, 0);
  assert.match(userBashOutput, /user-bash-fenced/);
  const notifications = [];
  await extension.commands.get('canonical-write-fence-status').handler('', { ui: { notify: text => notifications.push(text) } });
  assert.match(notifications[0], /3 succeeded, 0 refused/);
  assert.match(notifications[0], /NOT covered/);
});
