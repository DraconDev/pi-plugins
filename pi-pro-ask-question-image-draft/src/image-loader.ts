import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getImageDimensions, getCapabilities, type ImageDimensions } from "@earendil-works/pi-tui";
import type { ImageReference } from "./schema.ts";

/**
 * The largest image this will read, and then base64.
 *
 * Every image is base64-encoded on the way to the terminal, so the process ends
 * up holding the file plus roughly a third more as text - and the loader runs
 * for every option at once. A reference to a large file, or a URL that serves
 * one, would otherwise be read whole before anything noticed.
 *
 * The generator's own provider path is capped at 32 MB, so this is deliberately
 * stricter for a reference the model handed us directly.
 */
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

/**
 * Refuse a path that leaves the review's own directory.
 *
 * `relative(cwd, target)` is the whole test: it resolves `..` for us, so
 * `../../.ssh/id_rsa` and an absolute `/etc/shadow` are both caught, and a path
 * that lands inside - however it was spelled - is allowed. The error names the
 * path and the directory, because a model that gets this back needs to know
 * where to put the file, not just that it was refused.
 */
/** Hostnames that address this machine rather than somewhere else. */
function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "ip6-localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "::" ) return true;
  // 127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16, and the IPv6
  // unique-local range. Parsed as numbers rather than by string so 2130706433
  // and 0177.0.0.1 do not slip past.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  const v6 = host.replace(/^::ffff:/i, "");
  if (/^f[cd][0-9a-f]{2}:/i.test(v6)) return true;
  return /^fc|^fd/i.test(v6);
}

/** Refuse a URL that addresses this machine rather than the network. */
function assertFetchableUrl(reference: string): void {
  let parsed: URL;
  try {
    parsed = new URL(reference);
  } catch {
    throw new Error(`Image URL is not a URL: ${reference}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Image URL must be http or https, not ${parsed.protocol}`);
  }
  if (isLocalHost(parsed.hostname)) {
    throw new Error(
      `Image URL points at this machine: ${parsed.hostname}. `
      + "A review may not fetch from the loopback interface or a private network; pass a file path inside the review's directory instead.",
    );
  }
}

function assertInsideRoot(target: string, root: string): void {
  const inside = relative(resolve(root), resolve(target));
  if (inside === "" || (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside))) return;
  throw new Error(
    `Image path is outside the review's directory: ${target}. `
    + `Only files under ${resolve(root)} can be read; put the image there or pass a relative path.`,
  );
}

export interface LoadedImage {
  base64: string;
  mimeType: string;
  filename: string;
  dimensions?: ImageDimensions;
  source: string;
  remoteUrl?: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function inferMimeType(reference: ImageReference, bytes?: Buffer): string {
  if (reference.mimeType?.startsWith("image/")) return reference.mimeType;
  if (bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  }
  return MIME_BY_EXTENSION[extname(reference.path ?? "").toLowerCase()] ?? "image/png";
}

function parseDataUri(dataUri: string): { mimeType: string; base64: string } {
  const match = /^data:([^;,]+);base64,(.*)$/is.exec(dataUri);
  if (!match) throw new Error("image.dataUri must be a base64 image data URI");
  return { mimeType: match[1].toLowerCase(), base64: match[2].replace(/\s+/g, "") };
}

async function fetchRemote(url: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType?: string; remoteUrl: string }> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Unable to download image (HTTP ${response.status})`);
  // Refuse a body we have already been told is too large, rather than reading
  // it and finding out. `arrayBuffer` has no cap of its own.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error(`Image at ${url} is ${declared} bytes; the limit is ${MAX_IMAGE_BYTES}.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image at ${url} is ${bytes.length} bytes; the limit is ${MAX_IMAGE_BYTES}.`);
  }
  return { bytes, mimeType: response.headers.get("content-type") ?? undefined, remoteUrl: url };
}

export async function loadImage(reference: ImageReference, cwd: string, signal?: AbortSignal): Promise<LoadedImage> {
  let bytes: Buffer;
  let mimeType = reference.mimeType;
  let source: string;
  let remoteUrl: string | undefined;

  if (reference.dataUri) {
    const parsed = parseDataUri(reference.dataUri);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.base64) || parsed.base64.length % 4 === 1) {
      throw new Error("image.dataUri contains invalid base64 data");
    }
    bytes = Buffer.from(parsed.base64, "base64");
    mimeType = parsed.mimeType;
    source = "data URI";
  } else if (reference.path) {
    // `~` is the home directory and `~/x` a path inside it. Slicing two
    // characters off unconditionally turned `~` into nothing (fine, by luck) and
    // `~name/x` into `ame/x`, which resolved against the home directory and
    // silently read the wrong file. Written without a regular expression because
    // an escaped slash inside a character class is more than one parser here
    // will take.
    const expandHome = (value: string): string => {
      const rest = value.slice(1);
      const trimmed = rest.startsWith("/") || rest.startsWith("\\") ? rest.slice(1) : rest;
      return resolve(process.env.HOME ?? cwd, trimmed.length > 0 ? trimmed : ".");
    };
    const path = reference.path.startsWith("file:")
      ? fileURLToPath(reference.path)
      : reference.path.startsWith("~")
        ? expandHome(reference.path)
        : resolve(cwd, reference.path);
    // Confined to the review's own directory. A review is a JSON file the model
    // writes, so an unrestricted path is a read primitive for anything this
    // process can read - `../../.ssh/id_rsa` and `/etc/shadow` both arrive here
    // and were both base64-encoded into the panel. An absolute path is allowed
    // when it lands inside the directory, because that is the same thing written
    // the long way round.
    assertInsideRoot(path, cwd);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile() && info.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image at ${path} is ${info.size} bytes; the limit is ${MAX_IMAGE_BYTES}.`);
    }
    bytes = await readFile(path);
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(`Image at ${path} is ${bytes.length} bytes; the limit is ${MAX_IMAGE_BYTES}.`);
    }
    source = path;
  } else if (reference.url) {
    if (/^file:\/\//i.test(reference.url)) {
      const path = fileURLToPath(reference.url);
      assertInsideRoot(path, cwd);
      bytes = await readFile(path);
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw new Error(`Image at ${path} is ${bytes.length} bytes; the limit is ${MAX_IMAGE_BYTES}.`);
      }
      source = path;
    } else if (/^https?:\/\//i.test(reference.url)) {
      // Host restriction. A review is a JSON file the model writes, so an
      // `image.url` is a fetch the model chose: without this, a link to a cloud
      // metadata endpoint (169.254.169.254) or anything on the loopback
      // interface is fetched and its response drawn into the panel. The same
      // confinement the file paths get, applied to the network.
      assertFetchableUrl(reference.url);
      const downloaded = await fetchRemote(reference.url, signal);
      bytes = downloaded.bytes;
      mimeType = downloaded.mimeType;
      source = downloaded.remoteUrl;
      remoteUrl = downloaded.remoteUrl;
    } else {
      throw new Error(`Unsupported image URL protocol: ${reference.url}`);
    }
  } else {
    throw new Error("Image reference has no path, url, or dataUri");
  }

  const base64 = bytes.toString("base64");
  const resolvedMime = inferMimeType({ ...reference, mimeType }, bytes);
  if (!resolvedMime.startsWith("image/")) throw new Error(`Unsupported image MIME type: ${resolvedMime}`);
  let dimensions: ImageDimensions | undefined;
  try {
    dimensions = getImageDimensions(base64, resolvedMime) ?? undefined;
  } catch {
    dimensions = undefined;
  }
  return {
    base64,
    mimeType: resolvedMime,
    filename: reference.path
      ? basename(reference.path)
      : remoteUrl
        ? basename(new URL(remoteUrl).pathname) || "generated-image"
        : "generated-image",
    dimensions,
    source,
    remoteUrl,
  };
}

export function canRenderImages(): boolean {
  return getCapabilities().images !== null;
}

export function imageFileLink(pathOrUrl: string, label = pathOrUrl): string {
  try {
    if (/^https?:\/\//i.test(pathOrUrl)) return `[${label}](${pathOrUrl})`;
    return `[${label}](${pathToFileURL(pathOrUrl).href})`;
  } catch {
    return label;
  }
}
