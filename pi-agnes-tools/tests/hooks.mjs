/** Redirect pi's virtual modules to the local test stubs. */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const stubs = join(dir, "stubs.mjs");
const repoRoot = join(dir, "..", "..");
const modelFilter = join(repoRoot, "pi-model-filter", "extensions", "model-filter.ts");
const modelFilterCore = join(repoRoot, "pi-model-filter", "extensions", "model-filter-core.ts");

/**
 * Resolve pi-model-filter source files to their .ts paths even when the
 * importing module uses a .js extension in the import specifier (the
 * standard ESM-TS convention jiti follows at runtime).
 */
function resolveModelFilter(specifier) {
  const m = specifier.match(/pi-model-filter\/extensions\/(model-filter(-core)?)\.js$/);
  if (m) return m[2] ? modelFilterCore : modelFilter;
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier === "typebox" || specifier === "@earendil-works/pi-ai") {
    return { url: "file://" + stubs, shortCircuit: true };
  }
  // pi-model-filter's entry point imports @earendil-works/pi-coding-agent
  // (for getAgentDir). Redirect it to a minimal stub in test mode.
  if (specifier === "@earendil-works/pi-coding-agent") {
    return { url: "file://" + join(dir, "pi-coding-agent-stub.mjs"), shortCircuit: true };
  }
  const mf = resolveModelFilter(specifier);
  if (mf) return { url: "file://" + mf, shortCircuit: true };
  return next(specifier, context);
}
