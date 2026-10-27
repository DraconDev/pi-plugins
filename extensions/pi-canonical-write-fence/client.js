import { spawn, execFile } from 'node:child_process';
import { stat, lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const metadataNames = new Set(['.gitignore', '.gitattributes']);
export function gitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}
async function existingParent(target) {
  let dir = dirname(target);
  for (;;) {
    try { if ((await stat(dir)).isDirectory()) break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = dirname(dir); if (next === dir) throw Error('metadata writer requires an existing owning repository'); dir = next;
  }
  return realpath(dir);
}
// Inspect parent directories/Git markers only, never the target leaf. A broken
// or unreadable repository is an error, NOT permission for an unfenced fallback.
export async function findOwningRepo(target) {
  let dir = await existingParent(target);
  for (;;) {
    try { await lstat(join(dir, '.git')); return owningRepo(target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = dirname(dir); if (next === dir) return null; dir = next;
  }
}
export async function owningRepo(target) {
  const dir = await existingParent(target);
  const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--show-toplevel'],
    { env: gitEnvironment(), timeout: 3000, maxBuffer: 8192 });
  const value = stdout.replace(/\n$/, '');
  if (!value || value.includes('\n')) throw Error('cannot unambiguously resolve metadata owner');
  return realpath(value);
}

// Metadata payloads travel over stdin, never command-line arguments or logs.
export async function runFencedMutation({ tool, params, cwd, target, sdkUrl, repo: requestedRepo, warden = 'dracon-warden', signal }) {
  if (signal?.aborted) throw Error('metadata mutation aborted before acquisition');
  const repo = requestedRepo ?? await owningRepo(target);
  const worker = fileURLToPath(new URL('./worker.js', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(warden, ['write-fence', '--repo', repo, '--wait-secs', '30', '--run-secs', '60', '--',
      process.execPath, worker, sdkUrl], { cwd, env: gitEnvironment(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = []; let bytes = 0, failure, closed = false, killTimer;
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch (e) { if (e.code !== 'ESRCH') failure ||= e; } };
    const stop = (why) => {
      failure ||= Error(why); kill('SIGTERM');
      killTimer ||= setTimeout(() => kill('SIGKILL'), 5000);
    };
    const abort = () => stop('metadata mutation cancelled; owned writer family terminated');
    const deadline = setTimeout(() => stop('metadata writer exceeded its finite client deadline'), 95000);
    const finish = () => {
      clearTimeout(deadline); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
    };
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 16 * 1024 * 1024) stop('metadata result exceeds bound'); else out.push(data); });
    child.stderr.on('data', data => { if (Buffer.concat(err).length < 65536) err.push(data.subarray(0, 65536)); });
    child.once('error', error => { failure ||= error; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error.message); });
    child.once('close', code => {
      closed = true; finish();
      if (failure) return reject(failure);
      if (code) return reject(Error(`fenced metadata writer exited ${code}: ${Buffer.concat(err).toString('utf8').slice(-4096)}`));
      try { resolve(JSON.parse(Buffer.concat(out).toString('utf8'))); } catch (error) { reject(Error(`invalid fenced writer result: ${error.message}`)); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted && !closed) abort();
    const input = JSON.stringify({ tool, params, cwd, target, repo });
    if (Buffer.byteLength(input) > 16 * 1024 * 1024) stop('metadata request exceeds bound');
    else child.stdin.end(input);
  });
}
