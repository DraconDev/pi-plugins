// Called only inside the inherited, verified per-worktree fence. Scratch bytes
// live in Git's private directory, never in the daemon's eligible worktree.
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 16 * 1024 * 1024;
const RECOVERY_BYTES = 32 * 1024 * 1024;
const PREFIX = 'dracon-canonical-write-v1-';
const stamp = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.nlink, s.uid].map(String).join(':');
export async function observe(path) {
  try {
    const s = await fs.lstat(path, { bigint: true });
    if (!s.isFile() || s.nlink !== 1n || s.uid !== BigInt(process.geteuid())) {
      throw Error('canonical mutation requires an owned, single-link regular file');
    }
    return { stamp: stamp(s), mode: Number(s.mode & 0o777n) };
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function atomicWrite(path, content, { gitdir, before, signal, beforePublish }) {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_BYTES) throw Error('canonical mutation exceeds byte bound');
  if (signal?.aborted) throw Error('canonical mutation aborted');
  const scratch = join(gitdir, 'dracon-canonical-writes-v1');
  await fs.mkdir(scratch, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  const directory = await fs.lstat(scratch);
  if (!directory.isDirectory() || directory.uid !== process.geteuid() || (directory.mode & 0o077) !== 0) throw Error('unsafe canonical scratch directory');
  // SIGKILL can leave private scratch. Bound both bytes and inode growth;
  // never delete another request's recovery or treat it as user approval.
  let total = 0, count = 0;
  for (const name of await fs.readdir(scratch)) {
    if (!name.startsWith(PREFIX)) continue;
    const s = await fs.lstat(join(scratch, name));
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.geteuid()) throw Error('unsafe canonical recovery entry');
    total += s.size; count++;
  }
  if (total + bytes.length > RECOVERY_BYTES || count >= 64) throw Error('canonical recovery budget exhausted; inspect private recovery');
  const temp = join(scratch, PREFIX + randomUUID());
  let file;
  try {
    file = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(bytes);
    await file.chmod(before?.mode ?? 0o644);
    await file.sync();
    await file.close(); file = undefined;
    // Revalidate repository authority, and allow deterministic cancellation
    // controls at the actual fully-written-but-not-published boundary.
    await beforePublish?.();
    const currentDirectory = await fs.lstat(scratch);
    if (currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino || !currentDirectory.isDirectory()) throw Error('canonical scratch namespace changed');
    if (signal?.aborted) throw Error('canonical mutation aborted before publication');
    const now = await observe(path);
    if (now?.stamp !== before?.stamp) throw Error('canonical file changed; refusing stale mutation');
    // A cross-device Git directory fails closed with EXDEV, not a copy/truncate.
    await fs.rename(temp, path);
  } finally {
    await file?.close();
    await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
}
