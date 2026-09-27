import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getImageDimensions, getCapabilities, setCapabilities, type ImageDimensions } from "@earendil-works/pi-tui";
import type { ImageReference } from "./schema.ts";

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
  const bytes = Buffer.from(await response.arrayBuffer());
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
    const path = reference.path.startsWith("file:")
      ? fileURLToPath(reference.path)
      : reference.path.startsWith("~")
        ? resolve(process.env.HOME ?? cwd, reference.path.slice(2))
        : resolve(cwd, reference.path);
    bytes = await readFile(path);
    source = path;
  } else if (reference.url) {
    if (/^file:\/\//i.test(reference.url)) {
      const path = fileURLToPath(reference.url);
      bytes = await readFile(path);
      source = path;
    } else if (/^https?:\/\//i.test(reference.url)) {
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

/** Terminals that speak the Kitty graphics protocol, as tmux names its clients. */
export function isGraphicsCapableTerminal(name: string | null | undefined): boolean {
  return /kitty|ghostty|wezterm|warp/i.test(String(name ?? ""));
}

let probedOuterTerminal: string | null | undefined;

/**
 * The terminal *behind* the multiplexer, once.
 *
 * pi-tui refuses to emit graphics whenever `TMUX` is set, so a review inside
 * tmux silently loses its pictures even when the terminal underneath is Ghostty
 * and perfectly capable. Asking tmux costs one cheap call, is cached, and turns
 * "no images" into "images, through the passthrough envelope the package already
 * wraps them in".
 */
export function outerTerminalKind({ probe = defaultProbe }: { probe?: () => string | null } = {}): string | null {
  if (probedOuterTerminal !== undefined) return probedOuterTerminal;
  probedOuterTerminal = null;
  if (process.env.TMUX) {
    try {
      probedOuterTerminal = probe();
    } catch {
      probedOuterTerminal = null;
    }
  }
  return probedOuterTerminal;
}

function defaultProbe(): string | null {
  const out = execFileSync("tmux", ["display-message", "-p", "#{client_termname}"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
  return out.trim() || null;
}

/**
 * Turn inline images on when the terminal underneath the multiplexer can draw
 * them, and report whether it did.
 *
 * It never turns them *off*: a host that cannot draw images keeps the honest
 * fallback. Enabling is strictly an improvement over rendering a review with no
 * picture in it, and if the picture is erased anyway the user is no worse off
 * than the text fallback, with the bytes on the wire either way.
 */
export function enableImagesThroughMultiplexer({ probe = defaultProbe } = {}): { enabled: boolean; terminal: string | null } {
  const alreadyOn = getCapabilities().images !== null;
  if (alreadyOn) return { enabled: true, terminal: null };
  const terminal = outerTerminalKind({ probe });
  if (!isGraphicsCapableTerminal(terminal)) return { enabled: false, terminal };
  setCapabilities({ ...getCapabilities(), images: "kitty" });
  return { enabled: getCapabilities().images !== null, terminal };
}

/**
 * Forget the cached probe.
 *
 * The answer is cached for the process because it costs a subprocess; a `/reload`
 * or a test that changes the host needs to ask again.
 */
export function resetMultiplexerProbe(): void {
  probedOuterTerminal = undefined;
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
