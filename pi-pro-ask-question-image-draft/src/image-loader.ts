import { readFile, realpath, stat } from "node:fs/promises";
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
 * `relative(root, target)` is the whole test: it resolves `..` for us, so
 * `../../.ssh/id_rsa` and an absolute `/etc/shadow` are both caught, and a path
 * that lands inside - however it was spelled - is allowed. The error names the
 * path and the directory, because a model that gets this back needs to know
 * where to put the file, not just that it was refused.
 *
 * Both sides are resolved through `realpath` first. The lexical test sees the
 * path as it was spelled, and `readFile` then follows a symlink: a link inside
 * the review directory pointing at `/etc/shadow` passed the check and was read
 * whole, which is exactly the read primitive the check exists to remove.
 */
async function assertInsideRoot(target: string, root: string): Promise<void> {
  // A target that does not exist is reported by the read that follows, so a
  // missing file falls back to its spelled path rather than to a second error.
  const [realRoot, realTarget] = await Promise.all([
    realpath(root).catch(() => resolve(root)),
    realpath(target).catch(() => resolve(target)),
  ]);
  const inside = relative(realRoot, realTarget);
  if (inside === "" || (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside))) return;
  throw new Error(
    `Image path is outside the review's directory: ${target}. `
    + `Only files under ${realRoot} can be read; put the image there or pass a relative path.`,
  );
}

/**
 * The addresses that name this machine, the LAN, or a cloud metadata service.
 *
 * `100.64/10` is not exotic: it is the block Alibaba Cloud's metadata service
 * answers on. `198.18/15` is the benchmarking range, which is routed nowhere a
 * fetch should reach.
 */
function isPrivateOctets(a: number, b: number): boolean {
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

/** Hostnames that address this machine rather than somewhere else. */
function isLocalHost(hostname: string): boolean {
  // The URL parser has already normalised what it will, so the spellings that
  // matter are not the ones a person would type. `[::ffff:127.0.0.1]` comes
  // back as `[::ffff:7f00:1]` - hex groups, not dotted octets - and a trailing
  // dot survives on `localhost.`. Both reached a live loopback server while
  // this function reported the host was fine.
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host === "ip6-localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "::" ) return true;
  // 127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10 and
  // 198.18/15. Parsed as numbers rather than by string so 2130706433 and
  // 0177.0.0.1 do not slip past.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return isPrivateOctets(a, b);
  }
  // The same address in the form the parser hands back: two hex groups holding
  // the high and low halves of the 32 bits. `7f00:1` is 127.0.0.1.
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16);
    return isPrivateOctets(high >> 8, high & 0xff);
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  return /^fc|^fd/i.test(host);
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

/**
 * What the bytes actually are, with the declared type as a fallback.
 *
 * The declared type used to win outright, so `mimeType: "image/png"` on a
 * forty-megabyte text file sent it to the dimension probe and then to the
 * terminal's graphics protocol. The generator requires the signature to match,
 * so the two loaders disagreed about the same invariant; the bytes decide here
 * too, and a declared type is only believed when the signature says nothing.
 */
function inferMimeType(reference: ImageReference, bytes?: Buffer): string {
  const declared = reference.mimeType?.startsWith("image/") ? reference.mimeType : undefined;
  if (bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  }
  // We have the bytes and none of the four signatures matched, so these are not
  // an image. A declared `image/png` and a `.png` extension are both claims
  // about a file, and a file whose contents are words is neither - taking either
  // as evidence is how a text file reached the terminal's graphics protocol.
  if (bytes) {
    throw new Error(
      `Image bytes are not a recognised image format${declared ? ` (declared ${declared})` : ""}. `
      + "Only PNG, JPEG, WebP and GIF are recognised.",
    );
  }
  if (declared) return declared;
  return MIME_BY_EXTENSION[extname(reference.path ?? "").toLowerCase()] ?? "image/png";
}

function parseDataUri(dataUri: string): { mimeType: string; base64: string } {
  const match = /^data:([^;,]+);base64,(.*)$/is.exec(dataUri);
  if (!match) throw new Error("image.dataUri must be a base64 image data URI");
  return { mimeType: match[1].toLowerCase(), base64: match[2].replace(/\s+/g, "") };
}

/** How many hops a reference may take before it is treated as a loop. */
const MAX_REDIRECTS = 5;

async function fetchRemote(url: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType?: string; remoteUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Every hop is checked, not only the first. `fetch` follows redirects by
    // default, so the host guard ran on the URL the model wrote and any
    // permitted public address could 302 into 169.254.169.254 or anything on
    // the LAN. Two throwaway loopback servers showed it end to end: the first
    // answered 302, the second - a target the guard would have refused - served
    // the bytes. The hop is followed by hand so each one is checked, and the URL
    // that actually answered is what gets recorded as provenance.
    assertFetchableUrl(current);
    const response = await fetch(current, { signal, redirect: "manual" });
    const location = response.status >= 300 && response.status < 400
      ? response.headers.get("location")
      : null;
    if (location) {
      if (hop === MAX_REDIRECTS) throw new Error(`Image at ${url} redirects more than ${MAX_REDIRECTS} times.`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`Unable to download image (HTTP ${response.status})`);
    // Refuse a body we have already been told is too large, rather than reading
    // it and finding out. `arrayBuffer` has no cap of its own.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new Error(`Image at ${url} is ${declared} bytes; the limit is ${MAX_IMAGE_BYTES}.`);
    }
    const bytes = await readCapped(response, url);
    return { bytes, mimeType: response.headers.get("content-type") ?? undefined, remoteUrl: response.url || current };
  }
  throw new Error(`Image at ${url} redirects more than ${MAX_REDIRECTS} times.`);
}

/**
 * Read a body, refusing it the moment it passes the limit.
 *
 * Checking `bytes.length` after `arrayBuffer()` is a check that has already
 * lost: a chunked response with no `content-length` skips the header guard and
 * is buffered whole first. 64 MB measured, 242 MB of RSS moved, and the
 * refusal arrived afterwards - a 2 GB body would be held in full before the
 * same line fired. The stream is counted as it arrives and abandoned mid-flight.
 */
async function readCapped(response: Response, url: string): Promise<Buffer> {
  const body = response.body;
  if (!body) return Buffer.from(await response.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await body.cancel().catch(() => undefined);
      throw new Error(`Image at ${url} is more than ${MAX_IMAGE_BYTES} bytes; the limit is ${MAX_IMAGE_BYTES}.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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
    await assertInsideRoot(path, cwd);
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
      await assertInsideRoot(path, cwd);
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
