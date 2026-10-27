// Called after the in-process v1 fence is acquired, before SDK queue lookup.
import * as fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { atomicWrite, observe } from './atomic.js';
import { metadataNames, findOwningRepo } from './client.js';
export function fencedOperations({ tool, repo, gitdir, verify, signal }) {
  async function resolveTarget(path) {
    await verify();
    const leaf = await fs.lstat(path).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (metadataNames.has(basename(path)) && leaf?.isSymbolicLink()) throw Error('canonical metadata leaf symlink is unsupported');
    const physical = leaf ? await fs.realpath(path) : join(await fs.realpath(dirname(path)), basename(path));
    if (await findOwningRepo(physical) !== repo) throw Error('cross-repository or unowned alias is unsupported');
    return { path: physical, metadata: metadataNames.has(basename(path)) || metadataNames.has(basename(physical)), before: await observe(physical) };
  }
  let baseline;
  return {
    access: async path => { await verify(); await fs.access(path); },
    mkdir: async path => { await verify(); await fs.mkdir(path, { recursive: true }); },
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
        await atomicWrite(current.path, content, { gitdir, before: current.before, signal,
          beforePublish: async () => {
            if ((await resolveTarget(path)).path !== current.path) throw Error('canonical alias changed before publication');
          } });
      } else {
        if (signal?.aborted) throw Error('canonical mutation aborted');
        // No child timeout or forced termination of this write. The native SDK
        // and outer fence both await final close, including on cancellation.
        await fs.writeFile(current.path, content, 'utf8');
      }
    },
  };
}
