import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEditToolDefinition, createWriteToolDefinition, getPackageDir } from '@earendil-works/pi-coding-agent';
import { metadataNames, runFencedMutation } from './client.js';

// Source integration only. Direct named metadata scope is deliberately explicit:
// registering it does NOT establish shell/editor/alias or all-producer coverage.
export default async function canonicalWriteFence(pi) {
  const sdkUrl = pathToFileURL(join(getPackageDir(), 'dist', 'index.js')).href;
  const { resolveToCwd } = await import(new URL('./core/tools/path-utils.js', sdkUrl).href);
  if (typeof resolveToCwd !== 'function') throw Error('canonical fence requires the qualified host path resolver');
  const counts = { succeeded: 0, refused: 0 };
  for (const create of [createEditToolDefinition, createWriteToolDefinition]) {
    const original = create(process.cwd());
    pi.registerTool({
      ...original,
      async execute(id, params, signal, onUpdate, ctx) {
        const cwd = ctx?.cwd || process.cwd();
        // This is lexical normalization only; canonical lookup and the native
        // mutation queue belong INSIDE the actual held-fence worker.
        const target = resolveToCwd(params.path, cwd);
        if (!metadataNames.has(basename(target))) return original.execute(id, params, signal, onUpdate, ctx);
        try {
          const result = await runFencedMutation({ tool: original.name, params, cwd, target, sdkUrl,
            warden: process.env.DRACON_CANONICAL_WARDEN_HELPER || 'dracon-warden', signal });
          counts.succeeded++;
          // JSON transport omits undefined, but the native tool result contract
          // still includes details for a write without structured diff output.
          return { ...result, details: result.details };
        } catch (error) { counts.refused++; throw error; }
      },
    });
  }
  pi.registerCommand('canonical-write-fence-status', {
    description: 'Show the loaded direct-metadata fence scope and operation counters',
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Canonical fence: direct regular .gitignore/.gitattributes only; ${counts.succeeded} succeeded, ${counts.refused} refused. Shell, aliases and other editors are NOT covered.`, 'info');
    },
  });
}
