#!/usr/bin/env node
/**
 * Thin alias: `benchmark:images:generate` and `benchmark:images` are the same
 * command surface. The implementation lives in images.mjs so the contract
 * command `benchmark:images -- --max 600` generates real, bounded images.
 */
import { main } from "./images.mjs";

main().catch((error) => {
  process.stderr.write(`benchmark:images:generate: ${error.code ? `${error.code}: ` : ""}${error.message}\n`);
  process.exitCode = 1;
});
