// Standalone disposable runtime, NOT another test runner. Its actual host SDK
// operation receives cancellation while a scoped native write is gated.
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const sdk = await import(process.env.PI_CANONICAL_TEST_SDK);
const cwd = process.env.PI_CANONICAL_GATE_REPO, agentDir = process.env.PI_CANONICAL_GATE_AGENT;
await fs.mkdir(agentDir);
const loader = new sdk.DefaultResourceLoader({ cwd, agentDir,
  settingsManager: sdk.SettingsManager.inMemory({ packages: [], extensions: [] }),
  additionalExtensionPaths: [fileURLToPath(new URL('../../index.js', import.meta.url))],
  noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload(); const loaded = loader.getExtensions();
if (loaded.errors.length) throw Error(JSON.stringify(loaded.errors));
const controller = new AbortController();
let acknowledging = false;
const timer = setInterval(async () => {
  if (acknowledging) return;
  try { await fs.access(process.env.PI_CANONICAL_GATE_ABORT); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  acknowledging = true; controller.abort();
  await fs.writeFile(process.env.PI_CANONICAL_GATE_ACK, 'aborted\n');
  const other = process.env.PI_CANONICAL_GATE_OTHER;
  await loaded.extensions[0].tools.get('write').definition.execute('independent', {
    path: other + '/.gitignore', content: 'independent\n',
  }, undefined, undefined, { cwd: other });
  await fs.writeFile(process.env.PI_CANONICAL_GATE_PROGRESS, 'published\n');
}, 10);
try {
  await loaded.extensions[0].tools.get('write').definition.execute('ordinary-write', {
    path: process.env.PI_CANONICAL_GATE_TARGET, content: 'candidate-ordinary-content-'.repeat(200) + '\n',
  }, controller.signal, undefined, { cwd });
  throw Error('expected operation to report cancellation');
} catch (error) {
  if (!controller.signal.aborted || !/abort/i.test(error.message)) throw error;
  process.stdout.write(JSON.stringify({ cancelled: true, error: error.message }));
} finally { clearInterval(timer); }
