import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBashTool, createEditToolDefinition, createWriteToolDefinition, getPackageDir } from '@earendil-works/pi-coding-agent';
import { metadataNames, findOwningRepo, owningRepo } from './client.js';
import { withFence } from './lease.js';
import { fencedOperations } from './operations.js';
import { outsideOperations } from './outside.js';
import { createFencedBashOperations } from './shell.js';

// Fence every typed mutation in a known worktree, not just metadata basenames:
// otherwise a differently named alias could bypass the canonical boundary.
export default async function canonicalWriteFence(pi) {
  const sdkUrl = pathToFileURL(join(getPackageDir(), 'dist', 'index.js')).href;
  const [{ resolveToCwd }, { getShellConfig }, { waitForChildProcess }] = await Promise.all([
    import(new URL('./core/tools/path-utils.js', sdkUrl).href),
    import(new URL('./utils/shell.js', sdkUrl).href),
    import(new URL('./utils/child-process.js', sdkUrl).href),
  ]);
  if (typeof resolveToCwd !== 'function' || typeof getShellConfig !== 'function' || typeof waitForChildProcess !== 'function') {
    throw Error('canonical fence requires the qualified host path and shell-process helpers');
  }
  const counts = { succeeded: 0, refused: 0 };
  const shellCounts = { completed: 0, commandFailed: 0, refused: 0 };
  // Settings actions are unavailable during extension loading. Resolve the
  // effective shell path only when a command executes, after runtime init.
  const shellOperations = createFencedBashOperations({
    resolveShellConfig: () => getShellConfig(pi.getSettings().shellPath),
    waitForChildProcess,
    onOutcome: kind => {
      if (kind === 'completed') shellCounts.completed++;
      else if (kind === 'command-failed') shellCounts.commandFailed++;
      else shellCounts.refused++;
    },
  });
  const bashTool = createBashTool(process.cwd(), { operations: shellOperations });
  pi.registerTool({
    ...bashTool,
    execute: (id, params, signal, onUpdate, ctx) => bashTool.execute(id, params, signal, onUpdate, ctx),
  });
  // `user_bash` is a separate core path from the model-facing bash tool; both
  // must share the same pre-execution worktree fence.
  pi.on('user_bash', () => ({ operations: shellOperations }));
  for (const create of [createEditToolDefinition, createWriteToolDefinition]) {
    const original = create(process.cwd());
    const outside = create(process.cwd(), { operations: outsideOperations });
    pi.registerTool({
      ...original,
      async execute(id, params, signal, onUpdate, ctx) {
        const cwd = ctx?.cwd || process.cwd();
        // Only parent-directory discovery precedes acquisition. Target lookup
        // and the actual host SDK queue/transaction stay inside the held fence.
        try {
          const target = resolveToCwd(params.path, cwd);
          const repo = await findOwningRepo(target);
          if (!repo && !metadataNames.has(basename(target))) return await outside.execute(id, params, signal, onUpdate, ctx);
          const owner = repo ?? await owningRepo(target);
          const result = await withFence(owner, signal, async lease => {
            if (await owningRepo(target) !== owner) throw Error('canonical repository changed');
            const operations = fencedOperations({ ...lease, tool: original.name, repo: owner, signal });
            return create(cwd, { operations }).execute(id, params, signal, onUpdate, ctx);
          });
          counts.succeeded++;
          return result;
        } catch (error) { counts.refused++; throw error; }
      },
    });
  }
  pi.registerCommand('canonical-write-fence-status', {
    description: 'Show the loaded Git-worktree mutation fence scope and operation counters',
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Canonical fence prototype: Pi edit/write plus Pi bash/user-bash process families; ${counts.succeeded} typed edits/writes succeeded, ${counts.refused} refused; ${shellCounts.completed} shell commands succeeded, ${shellCounts.commandFailed} returned nonzero, ${shellCounts.refused} refused. Bash requires a Git worktree and holds its cwd worktree fence for the whole command (native Git in that process family is covered); timeout is capped at 3595s, Warden run at 3600s. This is source-only, not deployed. Explicit cross-worktree or absolute-path writes, external editors, and other unmanaged writers remain unsupported; do not use them for canonical paths. Cancellation may leave a completed ordinary write.`, 'info');
    },
  });
}
