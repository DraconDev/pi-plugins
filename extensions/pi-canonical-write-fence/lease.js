// Hold the v1 flock in the ACTUAL SDK-writing process through its final close.
// Cancellation never closes this descriptor while an awaited I/O can still run.
import * as fs from 'node:fs/promises';
import { constants, fstat, close } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { gitEnvironment } from './client.js';
const native = createRequire(import.meta.url)(process.env.PI_CANONICAL_NATIVE_BINDING || './build/fence.node');
const statFd = promisify(fstat), closeFd = promisify(close), exec = promisify(execFile);
export async function withFence(repo, signal, operation, { waitMs = 30000 } = {}) {
  if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs > 300000) throw Error('invalid canonical acquisition deadline');
  const deadline = performance.now() + waitMs;
  const check = () => {
    if (signal?.aborted) throw Error('canonical operation aborted');
    if (performance.now() >= deadline) throw Error('canonical writer fence deadline expired');
  };
  check();
  const { stdout } = await exec('git', ['-C', repo, 'rev-parse', '--absolute-git-dir'], { env: gitEnvironment(), timeout: Math.min(waitMs, 3000), maxBuffer: 8192 });
  const gitdir = stdout.replace(/\n$/, '');
  if (!gitdir || gitdir.includes('\n')) throw Error('ambiguous canonical Git directory');
  check();
  const path = join(gitdir, 'dracon-canonical-writer-v1.lock');
  const inherited = process.env.DRACON_CANONICAL_WRITER_FD_V1;
  let fd, file;
  if (inherited !== undefined) {
    const value = Number(inherited);
    if (!/^\d+$/.test(inherited) || !Number.isInteger(value) || value < 3 || value > 2147483647) throw Error('invalid inherited canonical fence');
    fd = native.duplicate(value);
  } else {
    file = await fs.open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    fd = file.fd;
  }
  try {
    const verify = async () => {
      const held = await statFd(fd, { bigint: true }), named = await fs.lstat(path, { bigint: true });
      if (!held.isFile() || !named.isFile() || held.dev !== named.dev || held.ino !== named.ino ||
          held.uid !== BigInt(process.geteuid()) || held.nlink !== 1n || (held.mode & 0o077n) !== 0n) throw Error('unsafe or replaced canonical fence');
    };
    await verify();
    for (;;) {
      check();
      if (native.tryLock(fd)) break;
      await delay(Math.min(5, Math.max(1, deadline - performance.now())), undefined, { signal });
    }
    await verify(); check();
    // Deliberately await the original SDK operation even after abort: it keeps
    // its mutation queue until pending filesystem operations have settled.
    return await operation({ gitdir, verify });
  } finally {
    // NEVER LOCK_UN: a duplicated inherited OFD may still belong to its caller.
    if (file) await file.close(); else await closeFd(fd);
  }
}
