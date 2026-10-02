import { setCapabilities } from "@earendil-works/pi-tui";
import { loadImage } from "./src/image-loader.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
const cwd = resolve("/tmp/review-root");
mkdirSync(cwd, { recursive: true });
// A one-pixel PNG, so the loader gets past the MIME check on the accepted paths.
writeFileSync(resolve(cwd, "inside.png"), Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
));

const attempt = async (path) => {
  try {
    await loadImage({ path }, cwd);
    return "read";
  } catch (error) {
    return String(error.message).slice(0, 72);
  }
};

for (const path of [
  "inside.png",
  "./inside.png",
  "/tmp/review-root/inside.png",
  "../escape.png",
  "../../.ssh/id_rsa",
  "/etc/shadow",
  "sub/../inside.png",
]) {
  console.log(`  ${path.padEnd(32)} -> ${await attempt(path)}`);
}
