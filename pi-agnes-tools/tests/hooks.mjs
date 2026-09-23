/** Redirect pi's virtual modules to the local test stubs. */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const stubs = join(dir, "stubs.mjs");
const modelFilter = join(dir, "..", "..", "pi-model-filter", "extensions", "model-filter.ts");

export async function resolve(specifier, context, next) {
  if (specifier === "typebox" || specifier === "@earendil-works/pi-ai") {
    return { url: "file://" + stubs, shortCircuit: true };
  }
  // Cross-extension import: resolve the pi-model-filter TS source directly
  // (jiti is not available in the bare-node test harness).
  if (specifier.endsWith("pi-model-filter/extensions/model-filter") ||
      specifier.endsWith("pi-model-filter/extensions/model-filter.ts")) {
    return { url: "file://" + modelFilter, shortCircuit: true };
  }
  if (specifier.endsWith("pi-model-filter/extensions/model-filter-core") ||
      specifier.endsWith("pi-model-filter/extensions/model-filter-core.ts")) {
    return { url: "file://" + join(dir, "..", "..", "pi-model-filter", "extensions", "model-filter-core.ts"), shortCircuit: true };
  }
  return next(specifier, context);
}
