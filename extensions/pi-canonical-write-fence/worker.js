// Private worker: reuse the host SDK's complete edit/write transaction and
// mutation queue, but publish regular metadata atomically inside the fence.
import * as fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWrite, observe } from './atomic.js';
import { gitEnvironment, metadataNames, owningRepo, findOwningRepo } from './client.js';
const exec = promisify(execFile);
const abort = new AbortController();
process.on('SIGTERM', () => abort.abort());
process.on('SIGINT', () => abort.abort());
try {
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) throw Error('canonical request exceeds bound');
    chunks.push(chunk);
  }
  const { tool, params, cwd, target, repo } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!['edit', 'write'].includes(tool)) throw Error('unsupported canonical mutation');
  const { stdout } = await exec('git', ['-C', repo, 'rev-parse', '--absolute-git-dir'], { env: gitEnvironment(), timeout: 3000, maxBuffer: 8192 });
  const gitdir = stdout.replace(/\n$/, '');
  if (!gitdir || gitdir.includes('\n')) throw Error('ambiguous canonical Git directory');
  const fd = Number(process.env.DRACON_CANONICAL_WRITER_FD_V1);
  if (!Number.isInteger(fd) || fd < 3) throw Error('missing inherited canonical fence');
  const held = await fs.stat(`/proc/self/fd/${fd}`, { bigint: true });
  const named = await fs.lstat(join(gitdir, 'dracon-canonical-writer-v1.lock'), { bigint: true });
  const fdinfo = await fs.readFile(`/proc/self/fdinfo/${fd}`, 'utf8');
  if (!held.isFile() || !named.isFile() || held.dev !== named.dev || held.ino !== named.ino ||
      held.uid !== BigInt(process.geteuid()) || held.nlink !== 1n || (held.mode & 0o077n) !== 0n ||
      !/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s/m.test(fdinfo)) throw Error('invalid or unheld canonical fence');
  // No canonical target lookup or SDK queue registration before fence proof.
  if (await owningRepo(target) !== repo) throw Error('canonical repository changed');
  const sdkUrl = new URL(process.argv[2]);
  if (sdkUrl.protocol !== 'file:') throw Error('worker requires the local host SDK');
  const sdk = await import(sdkUrl.href);
  const { resolveToCwd } = await import(new URL('./core/tools/path-utils.js', sdkUrl).href);
  if (resolveToCwd(params.path, cwd) !== target) throw Error('canonical target mismatch');
  async function resolveTarget(path) {
    const leaf = await fs.lstat(path).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (metadataNames.has(basename(path)) && leaf?.isSymbolicLink()) throw Error('canonical metadata leaf symlink is unsupported');
    let physical;
    if (leaf) physical = await fs.realpath(path);
    else physical = join(await fs.realpath(dirname(path)), basename(path));
    if (await findOwningRepo(physical) !== repo) throw Error('cross-repository or unowned alias is unsupported');
    return { path: physical, metadata: metadataNames.has(basename(path)) || metadataNames.has(basename(physical)), before: await observe(physical) };
  }
  let baseline;
  const operations = {
    access: path => fs.access(path),
    mkdir: path => fs.mkdir(path, { recursive: true }).then(() => {}),
    readFile: async path => {
      baseline = await resolveTarget(path);
      const data = await fs.readFile(baseline.path);
      if ((await observe(baseline.path))?.stamp !== baseline.before?.stamp) throw Error('canonical file changed during read');
      return data;
    },
    writeFile: async (path, content) => {
      const current = await resolveTarget(path);
      if (tool === 'edit' && (current.path !== baseline.path || current.before?.stamp !== baseline.before?.stamp)) throw Error('canonical file or alias changed after read');
      if (current.metadata) {
        await atomicWrite(current.path, content, { gitdir, before: current.before, signal: abort.signal,
          beforePublish: async () => {
            if ((await resolveTarget(path)).path !== current.path) throw Error('canonical alias changed before publication');
          } });
      } else {
        // Ordinary worktree files retain in-place SDK write semantics (including
        // inode/mode/ACL fidelity), but their complete operation holds the fence.
        if (abort.signal.aborted) throw Error('canonical mutation aborted');
        await fs.writeFile(current.path, content, 'utf8');
      }
    },
  };
  const definition = tool === 'edit' ? sdk.createEditToolDefinition(cwd, { operations }) : sdk.createWriteToolDefinition(cwd, { operations });
  const result = await definition.execute('canonical-worker', params, abort.signal, undefined, { cwd });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`canonical writer failed: ${error.message}\n`);
  process.exitCode = 1;
}
