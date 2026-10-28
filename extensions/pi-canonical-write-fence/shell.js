import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { stat } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';
import { findOwningRepo } from './client.js';

const FENCE_FD_ENV = 'DRACON_CANONICAL_WRITER_FD_V1';
const WAIT_SECS = 30;
const MAX_RUN_SECS = 3600;
const MAX_CLIENT_TIMEOUT_SECS = MAX_RUN_SECS - 5;
const KILL_GRACE_MS = 5000;

function resolvedTimeout(timeout) {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) throw Error('Invalid timeout: must be a finite positive number of seconds');
  if (timeout > MAX_CLIENT_TIMEOUT_SECS) throw Error(`Fenced shell timeout exceeds ${MAX_CLIENT_TIMEOUT_SECS} seconds`);
  return timeout * 1000;
}

function inheritedFenceFd(env) {
  const raw = env[FENCE_FD_ENV];
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) throw Error('Invalid inherited canonical writer descriptor');
  const fd = Number(raw);
  if (!Number.isSafeInteger(fd) || fd < 3) throw Error('Invalid inherited canonical writer descriptor');
  return fd;
}

function signalGroup(pid, sig) {
  if (!pid) return;
  try { process.kill(-pid, sig); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function notify(callback, kind) {
  try { callback?.(kind); } catch { /* telemetry cannot change a writer result */ }
}

/**
 * Run every Pi bash/user-bash command as one bounded Warden writer family.
 * The worktree fence is acquired before starting the shell and inherited by
 * its descendants, including native Git and Warden/dracon-sync subprocesses.
 */
export function createFencedBashOperations({
  warden = process.env.DRACON_CANONICAL_WARDEN_HELPER || 'dracon-warden',
  shellConfig,
  resolveShellConfig,
  waitForChildProcess,
  onOutcome,
} = {}) {
  if (process.platform !== 'linux') throw Error('canonical shell fencing is supported only on Linux');
  if (typeof warden !== 'string' || !warden) throw Error('canonical shell fencing requires dracon-warden');
  if (shellConfig === undefined && typeof resolveShellConfig !== 'function') {
    throw Error('canonical shell fencing requires the host Pi shell configuration');
  }
  if (typeof waitForChildProcess !== 'function') throw Error('canonical shell fencing requires the host Pi child-process waiter');

  return {
    async exec(command, cwd, { onData, signal, timeout, env: providedEnv } = {}) {
      try {
        const timeoutMs = resolvedTimeout(timeout);
        if (signal?.aborted) throw Error('aborted');
        const cwdMeta = await stat(cwd);
        if (!cwdMeta.isDirectory()) throw Error(`Working directory is not a directory: ${cwd}`);
        // findOwningRepo only examines parent directories; this synthetic leaf
        // makes cwd itself the first candidate without opening any repo file.
        const repo = await findOwningRepo(join(cwd, '.pi-canonical-write-fence-anchor'));
        if (!repo) throw Error('Bash is fail-closed outside a Git worktree');

        const currentShell = resolveShellConfig ? resolveShellConfig() : shellConfig;
        if (!currentShell || typeof currentShell.shell !== 'string' || !Array.isArray(currentShell.args)) {
          throw Error('canonical shell fencing requires the host Pi shell configuration');
        }
        if (currentShell.commandTransport === 'stdin') {
          throw Error('canonical shell fencing does not support stdin-transport shells');
        }
        const env = { ...(providedEnv ?? process.env) };
        const inheritedFd = inheritedFenceFd(env);
        const stdio = ['ignore', 'pipe', 'pipe'];
        if (inheritedFd !== null) {
          // Warden duplicates fd 3, verifies it names this worktree's lock,
          // then makes its own duplicate inheritable to the shell family.
          stdio[3] = inheritedFd;
          env[FENCE_FD_ENV] = '3';
        }
        const runSecs = timeout === undefined ? MAX_RUN_SECS : Math.min(MAX_RUN_SECS, Math.ceil(timeout) + 5);
        const args = [
          'write-fence', '--repo', repo,
          '--wait-secs', String(WAIT_SECS),
          '--run-secs', String(runSecs), '--',
          currentShell.shell, ...currentShell.args, command,
        ];
        const child = spawn(warden, args, {
          cwd,
          env,
          detached: true,
          stdio,
          windowsHide: true,
        });
        const consume = typeof onData === 'function' ? onData : () => {};
        child.stdout?.on('data', consume);
        child.stderr?.on('data', consume);

        let stopReason;
        let killTimer;
        let timeoutHandle;
        const stop = reason => {
          if (stopReason) return;
          stopReason = reason;
          try { signalGroup(child.pid, 'SIGTERM'); }
          catch (error) { stopReason = `${reason}; signal failed: ${error.message}`; }
          killTimer = setTimeout(() => {
            try { signalGroup(child.pid, 'SIGKILL'); } catch { /* child already exited */ }
          }, KILL_GRACE_MS);
          killTimer.unref?.();
        };
        const abort = () => stop('aborted');
        if (timeoutMs !== undefined) timeoutHandle = setTimeout(() => stop('timeout'), timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();

        let exitCode;
        try {
          exitCode = await waitForChildProcess(child);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (killTimer) clearTimeout(killTimer);
          signal?.removeEventListener('abort', abort);
        }
        if (signal?.aborted || stopReason === 'aborted') throw Error('aborted');
        if (stopReason === 'timeout') throw Error(`timeout:${timeout}`);
        if (stopReason) throw Error(`fenced shell termination failed: ${stopReason}`);
        const signalCode = child.signalCode;
        const result = { exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) };
        notify(onOutcome, result.exitCode === 0 ? 'completed' : 'command-failed');
        return result;
      } catch (error) {
        notify(onOutcome, 'refused');
        throw error;
      }
    },
  };
}
