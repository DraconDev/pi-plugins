/** Redirect pi's virtual modules to the local test stubs. */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const stubs = join(dir, "stubs.mjs");

export async function resolve(specifier, context, next) {
  if (specifier === "typebox" || specifier === "@earendil-works/pi-ai") {
    return { url: "file://" + stubs, shortCircuit: true };
  }
  return next(specifier, context);
}
