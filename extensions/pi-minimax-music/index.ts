/**
 * pi-minimax-music
 *
 * Exposes the MiniMax music API to pi as three tools — the endpoints the
 * mmx CLI no longer ships (mmx 1.0.x dropped the `music` command even
 * though paid plans keep access to the music API):
 *
 *   - minimax_music_generate        POST /v1/music_generation
 *                                   (music-3.0 / music-3.0-free / music-2.6 / music-2.6-free
 *                                    text-to-music, plus music-cover one-step / two-step)
 *   - minimax_lyrics_generate       POST /v1/lyrics_generation (write_full_song | edit)
 *   - minimax_music_cover_preprocess  POST /v1/music_cover_preprocess
 *                                   (two-step cover: extract cover_feature_id + lyrics)
 *
 * Why this exists:
 * `mmx music ...` was removed from mmx-cli (verified: mmx 1.0.29 has no
 * music resource at all). The public HTTP API is alive and is what mmx
 * used to call, so this extension speaks it directly.
 *
 * Auth (same key mmx uses):
 *   1. MINIMAX_API_KEY environment variable
 *   2. ~/.mmx/config.json (`api_key`, as written by `mmx auth login --api-key`)
 * Base URL:
 *   1. MINIMAX_BASE_URL environment variable
 *   2. MINIMAX_REGION=global|cn, else ~/.mmx/config.json `region` (default: global → https://api.minimax.io)
 *
 * Output:
 *   Audio is saved under .pi/generated-music/ of the current working
 *   directory (override with the `out` parameter). output_format=url files
 *   are downloaded immediately — the links expire after 24h.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

// typebox is provided to extensions by pi itself (bundled/virtual module).
import * as _typebox from "typebox";
const Type = (_typebox as any).Type;

import {
  ALL_MODELS,
  AUDIO_FORMATS,
  BITRATES,
  COVER_MODELS,
  DEFAULT_MODEL,
  GENERATE_MODELS,
  SAMPLE_RATES,
  MAX_AUDIO_FILE_BYTES,
  buildCoverPreprocessBody,
  buildLyricsBody,
  buildMusicBody,
  checkBaseResp,
  extensionForFormat,
  extractAudio,
  formatExtraInfo,
  resolveApiKey,
  resolveBaseUrl,
} from "./music-core.mjs";

const REQUEST_TIMEOUT_MS = 600_000; // music generation is synchronous; allow up to 10 min

// ---------------------------------------------------------------------------
// Auth / HTTP
// ---------------------------------------------------------------------------

function readMmxConfig(): any | null {
  try {
    const raw = readFileSync(join(homedir(), ".mmx", "config.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveAuth(): { baseUrl: string; apiKey: string } {
  const env = process.env as Record<string, string | undefined>;
  const mmxConfig = readMmxConfig();
  return { baseUrl: resolveBaseUrl({ env, mmxConfig }), apiKey: resolveApiKey({ env, mmxConfig }) };
}

async function postJson(baseUrl: string, path: string, body: unknown, apiKey: string, signal?: AbortSignal): Promise<any> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  let combinedSignal = signal;
  // Node ≥20.3 supports AbortSignal.any; fall back to the tool signal alone.
  try {
    if (typeof (AbortSignal as any).any === "function") {
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      combinedSignal = signal ? (AbortSignal as any).any([signal, timeoutSignal]) : timeoutSignal;
    }
  } catch {
    combinedSignal = signal;
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`MiniMax API request to ${path} failed: ${message}`);
  }
  const text = await response.text();
  let payload: any = null;
  try {
    payload = JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 500);
    throw new Error(`MiniMax API returned non-JSON response (HTTP ${response.status}): ${snippet}`);
  }
  if (!response.ok) {
    const code = payload?.base_resp?.status_code;
    const msg = payload?.base_resp?.status_msg ?? text.slice(0, 300);
    throw new Error(`MiniMax API HTTP ${response.status}${code !== undefined ? ` (base_resp ${code})` : ""}: ${msg}`);
  }
  return checkBaseResp(payload);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function fileLink(p: string, label: string = p): string {
  return `[${label}](${pathToFileURL(p).href})`;
}

function defaultOutPath(prefix: string, ext: string): string {
  const dir = join(process.cwd(), ".pi", "generated-music");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join(dir, `${prefix}_${stamp}.${ext}`);
}

function resolveOutPath(out: string | undefined, fallbackExt: string): string {
  if (!out || !out.trim()) return defaultOutPath("music", fallbackExt);
  const resolved = resolve(out.trim());
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

function readLocalTextFile(path: string, what: string, maxChars: number): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`${what} file not found: ${resolved}`);
  const content = readFileSync(resolved, "utf8");
  if (content.length > maxChars) {
    throw new Error(`${what} file is ${content.length} characters; the API limit is ${maxChars}.`);
  }
  return content;
}

function readLocalAudioAsBase64(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Audio file not found: ${resolved}`);
  const size = statSync(resolved).size;
  if (size > MAX_AUDIO_FILE_BYTES) {
    throw new Error(`Audio file is ${(size / (1024 * 1024)).toFixed(1)} MB; the maximum reference audio is 50 MB.`);
  }
  return readFileSync(resolved).toString("base64");
}

async function downloadToFile(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    throw new Error(`Unable to download generated audio: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Unable to download generated audio: HTTP ${response.status}`);
  }
  writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// minimax_music_generate
// ---------------------------------------------------------------------------

const musicParams = Type.Object({
  prompt: Type.Optional(Type.String({
    description:
      "Music description: style, mood, scenario, vocals, instrumentation (e.g. 'Indie folk, melancholic, introspective'). " +
      "Required for instrumental / lyrics_optimizer and for cover models (10–300 chars). Max 2000 chars.",
  })),
  model: Type.Optional(Type.Union(
    [
      Type.Literal("music-3.0"),
      Type.Literal("music-3.0-free"),
      Type.Literal("music-2.6"),
      Type.Literal("music-2.6-free"),
      Type.Literal("music-cover"),
      Type.Literal("music-cover-free"),
    ],
    { description: `Model. Default: ${DEFAULT_MODEL}. Text-to-music: ${GENERATE_MODELS.join(", ")}. Cover: ${COVER_MODELS.join(", ")}. Free tiers are 3 RPM; paid models 120 RPM.` },
  )),
  lyrics: Type.Optional(Type.String({
    description:
      "Song lyrics, \\n-separated, with structure tags ([Intro], [Verse], [Pre Chorus], [Chorus], [Bridge], [Outro], [Hook], [Build Up], ...). " +
      "Required for text-to-music unless is_instrumental or lyrics_optimizer is set. 1–3500 chars. For two-step covers: 10–1000 chars, required when using cover_feature_id.",
  })),
  lyrics_file: Type.Optional(Type.String({
    description: "Local path to a lyrics file (≤3500 chars) — read and used as `lyrics` when `lyrics` is not set.",
  })),
  is_instrumental: Type.Optional(Type.Boolean({
    description: "Generate instrumental music (no vocals). Requires prompt; mutually exclusive with lyrics. Text-to-music models only.",
  })),
  lyrics_optimizer: Type.Optional(Type.Boolean({
    description: "Auto-generate lyrics from the prompt. Requires prompt; mutually exclusive with lyrics and is_instrumental. Text-to-music models only.",
  })),
  output_format: Type.Optional(Type.Union([Type.Literal("url"), Type.Literal("hex")], {
    description: "Response audio format. Default: \"url\" (downloaded immediately; links expire after 24h). \"hex\" returns hex audio in the response.",
  })),
  audio_setting: Type.Optional(Type.Object({
    sample_rate: Type.Optional(Type.Union([Type.Literal(16000), Type.Literal(24000), Type.Literal(32000), Type.Literal(44100)], {
      description: `Sample rate in Hz. One of ${SAMPLE_RATES.join(", ")}. Default: 44100.`,
    })),
    bitrate: Type.Optional(Type.Union([Type.Literal(32000), Type.Literal(64000), Type.Literal(128000), Type.Literal(256000)], {
      description: `Bitrate in bps. One of ${BITRATES.join(", ")}. Default: 256000.`,
    })),
    format: Type.Optional(Type.Union([Type.Literal("mp3"), Type.Literal("wav"), Type.Literal("pcm")], {
      description: `Container/codec. One of ${AUDIO_FORMATS.join(", ")}. Default: mp3.`,
    })),
  }, { description: "Audio output settings. Default: { sample_rate: 44100, bitrate: 256000, format: 'mp3' }." })),
  audio_url: Type.Optional(Type.String({
    description: "Cover models only: URL of the reference audio (mp3/wav/flac, 6s–6min, ≤50MB). Exactly one of audio_url / audio_base64 / audio_file / cover_feature_id required.",
  })),
  audio_file: Type.Optional(Type.String({
    description: "Cover models only: local path to the reference audio (≤50 MB). Read and sent as base64 (auto-encoded).",
  })),
  audio_base64: Type.Optional(Type.String({
    description: "Cover models only: base64-encoded reference audio (≤50 MB decoded). Prefer audio_file for local files.",
  })),
  cover_feature_id: Type.Optional(Type.String({
    description: "Cover models only: feature ID from minimax_music_cover_preprocess (valid 24h). Requires lyrics (10–1000 chars). Mutually exclusive with audio_url/audio_base64/audio_file.",
  })),
  seed: Type.Optional(Type.Integer({
    description: "Random seed 0–1000000 for reproducible covers.",
    minimum: 0,
    maximum: 1000000,
  })),
  aigc_watermark: Type.Optional(Type.Boolean({ description: "Embed an AI-generated-content watermark." })),
  out: Type.Optional(Type.String({
    description: "Output file path. Default: .pi/generated-music/music_<timestamp>.<ext> under the current working directory.",
  })),
});

async function executeMusicGenerate(_toolCallId: string, params: any, signal?: AbortSignal) {
  const { baseUrl, apiKey } = resolveAuth();

  // Resolve file-based conveniences into wire fields before validation.
  const lyricsFromFile = params.lyrics_file && !params.lyrics
    ? readLocalTextFile(params.lyrics_file, "Lyrics", 3500)
    : params.lyrics;
  const audioBase64 = params.audio_file
    ? readLocalAudioAsBase64(params.audio_file)
    : params.audio_base64;

  const body = buildMusicBody({ ...params, lyrics: lyricsFromFile, audio_base64: audioBase64 });
  const payload = await postJson(baseUrl, "/v1/music_generation", body, apiKey, signal);
  const audio = extractAudio(payload);

  const format = body.audio_setting.format as string;
  const outPath = resolveOutPath(params.out, extensionForFormat(format));
  if (audio.kind === "url") {
    await downloadToFile(audio.value, outPath, signal);
  } else {
    writeFileSync(outPath, Buffer.from(audio.value, "hex"));
  }

  const info = formatExtraInfo(payload?.extra_info);
  const lines = [
    `Generated ${body.model} audio saved to: ${fileLink(outPath)}`,
    info ? `Format: ${info}` : "",
    audio.kind === "url" ? `Remote URL (expires after 24h): ${audio.value}` : "",
    payload?.trace_id ? `trace_id: ${payload.trace_id}` : "",
  ].filter(Boolean);

  return {
    content: [{ type: "text", text: lines.join("\n\n") }],
    details: {
      filePath: outPath,
      model: body.model,
      outputFormat: audio.kind,
      remoteUrl: audio.kind === "url" ? audio.value : null,
      trace_id: payload?.trace_id ?? null,
      extra_info: payload?.extra_info ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// minimax_lyrics_generate
// ---------------------------------------------------------------------------

const lyricsParams = Type.Object({
  mode: Type.Optional(Type.Union([Type.Literal("write_full_song"), Type.Literal("edit")], {
    description: 'Generation mode: "write_full_song" (default) writes a complete song; "edit" edits/continues existing lyrics (requires lyrics).',
  })),
  prompt: Type.Optional(Type.String({
    description: "Song theme, style, or editing direction (e.g. 'A cheerful love song about a summer day at the beach'). Empty = random song. Max 2000 chars.",
  })),
  lyrics: Type.Optional(Type.String({
    description: "Existing lyrics to edit/continue. Only effective in edit mode. Max 3500 chars.",
  })),
  title: Type.Optional(Type.String({
    description: "Song title. If provided, the output keeps this title unchanged.",
  })),
});

async function executeLyricsGenerate(_toolCallId: string, params: any, signal?: AbortSignal) {
  const { baseUrl, apiKey } = resolveAuth();
  const body = buildLyricsBody(params);
  const payload = await postJson(baseUrl, "/v1/lyrics_generation", body, apiKey, signal);

  const title = payload?.song_title ?? "(no title returned)";
  const tags = payload?.style_tags ? `Style tags: ${payload.style_tags}` : "";
  const lyrics = payload?.lyrics ?? "";
  const text = [
    `Song title: ${title}`,
    tags,
    "",
    lyrics,
    payload?.base_resp?.status_msg ? `\nbase_resp: ${payload.base_resp.status_msg}` : "",
  ].filter((line) => line !== undefined).join("\n");

  return {
    content: [{ type: "text", text }],
    details: {
      song_title: payload?.song_title ?? null,
      style_tags: payload?.style_tags ?? null,
      lyrics: payload?.lyrics ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// minimax_music_cover_preprocess
// ---------------------------------------------------------------------------

const coverParams = Type.Object({
  audio_url: Type.Optional(Type.String({
    description: "URL of the reference audio (mp3/wav/flac, 6s–6min, ≤50MB). Exactly one of audio_url / audio_file required.",
  })),
  audio_file: Type.Optional(Type.String({
    description: "Local path to the reference audio (≤50 MB). Read and sent as base64 (auto-encoded).",
  })),
});

async function executeCoverPreprocess(_toolCallId: string, params: any, signal?: AbortSignal) {
  const { baseUrl, apiKey } = resolveAuth();
  const audioBase64 = params.audio_file ? readLocalAudioAsBase64(params.audio_file) : undefined;
  const body = buildCoverPreprocessBody({ audio_url: params.audio_url, audio_base64: audioBase64 });
  const payload = await postJson(baseUrl, "/v1/music_cover_preprocess", body, apiKey, signal);

  let structure: string = payload?.structure_result ?? "";
  if (typeof structure === "string" && structure.trim()) {
    try {
      structure = JSON.stringify(JSON.parse(structure), null, 2);
    } catch {
      /* keep the raw string */
    }
  }

  const text = [
    `cover_feature_id: ${payload?.cover_feature_id ?? "(none returned)"}  (valid 24h)`,
    payload?.audio_duration != null ? `Audio duration: ${payload.audio_duration}s` : "",
    "",
    "Extracted lyrics (edit freely, then pass as `lyrics` together with `cover_feature_id` to minimax_music_generate):",
    payload?.formatted_lyrics ?? "(none returned)",
    "",
    "Structure analysis:",
    structure || "(none returned)",
    payload?.trace_id ? `\ntrace_id: ${payload.trace_id}` : "",
  ].filter((line) => line !== "").join("\n");

  return {
    content: [{ type: "text", text }],
    details: {
      cover_feature_id: payload?.cover_feature_id ?? null,
      formatted_lyrics: payload?.formatted_lyrics ?? null,
      structure_result: payload?.structure_result ?? null,
      audio_duration: payload?.audio_duration ?? null,
      trace_id: payload?.trace_id ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: any) {
  pi.registerTool({
    name: "minimax_music_generate",
    label: "MiniMax Music Generate",
    description:
      "Generate a complete song via the MiniMax music API (POST /v1/music_generation) — the endpoint mmx no longer ships. " +
      "Modes: (1) text-to-music with your own lyrics, (2) is_instrumental: true for vocal-less tracks, (3) lyrics_optimizer: true to auto-write lyrics from the prompt, " +
      "(4) cover models with a reference audio (one-step) or a cover_feature_id from minimax_music_cover_preprocess (two-step, with lyrics edit). " +
      "Models: music-3.0 (default, paid plan), music-3.0-free, music-2.6, music-2.6-free, music-cover, music-cover-free. " +
      "Saves the audio to .pi/generated-music/ and returns the local path. " +
      "Auth: MINIMAX_API_KEY env, else the api_key in ~/.mmx/config.json (mmx auth login). Region: global (default) or cn via MINIMAX_REGION / mmx config.",
    parameters: musicParams,
    executionMode: "sequential",
    execute: executeMusicGenerate,
  });

  pi.registerTool({
    name: "minimax_lyrics_generate",
    label: "MiniMax Lyrics Generate",
    description:
      "Generate or edit song lyrics via the MiniMax lyrics API (POST /v1/lyrics_generation) — the endpoint mmx no longer ships. " +
      'mode "write_full_song" (default) writes a complete song from a theme; mode "edit" edits/continues existing lyrics. ' +
      "Returns song_title, style_tags and lyrics with structure tags that can be fed straight into minimax_music_generate. " +
      "Auth: MINIMAX_API_KEY env, else the api_key in ~/.mmx/config.json.",
    parameters: lyricsParams,
    executionMode: "sequential",
    execute: executeLyricsGenerate,
  });

  pi.registerTool({
    name: "minimax_music_cover_preprocess",
    label: "MiniMax Music Cover Preprocess",
    description:
      "Preprocess a reference audio for two-step cover generation (POST /v1/music_cover_preprocess). " +
      "Returns cover_feature_id (valid 24h), ASR-extracted formatted_lyrics (editable), a song-structure analysis, and audio_duration. " +
      "Then call minimax_music_generate with model=music-cover, cover_feature_id and the (edited) lyrics. Free to call. " +
      "Reference audio: 6s–6min, ≤50MB, mp3/wav/flac. Pass audio_url or audio_file (local path). " +
      "Auth: MINIMAX_API_KEY env, else the api_key in ~/.mmx/config.json.",
    parameters: coverParams,
    executionMode: "sequential",
    execute: executeCoverPreprocess,
  });
}
