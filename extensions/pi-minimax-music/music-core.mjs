/**
 * pi-minimax-music — pure helpers for the MiniMax music endpoints.
 *
 * Kept as plain ESM with zero dependencies so `node --test` can exercise the
 * validation logic without pi's loader or typebox. index.ts imports from here.
 *
 * Official contract (verified against https://platform.minimax.io/docs):
 *   POST {base}/v1/music_generation          model: music-3.0 | music-3.0-free | music-2.6 | music-2.6-free | music-cover | music-cover-free
 *   POST {base}/v1/lyrics_generation         mode:  write_full_song | edit
 *   POST {base}/v1/music_cover_preprocess    model: music-cover
 * Auth: `Authorization: Bearer <api_key>` (same key mmx stores in ~/.mmx/config.json).
 * Response: { data: { audio?, audio_url?, status? }, extra_info?, trace_id?, base_resp: { status_code, status_msg } }
 */

export const MINIMAX_ENDPOINTS = {
  global: { baseUrl: "https://api.minimax.io", label: "Global" },
  cn: { baseUrl: "https://api.minimax.cn", label: "China" },
};

export const GENERATE_MODELS = ["music-3.0", "music-3.0-free", "music-2.6", "music-2.6-free"];
export const COVER_MODELS = ["music-cover", "music-cover-free"];
export const ALL_MODELS = [...GENERATE_MODELS, ...COVER_MODELS];
export const DEFAULT_MODEL = "music-3.0";
export const DEFAULT_COVER_MODEL = "music-cover";

export const AUDIO_FORMATS = ["mp3", "wav", "pcm"];
export const SAMPLE_RATES = [16000, 24000, 32000, 44100];
export const BITRATES = [32000, 64000, 128000, 256000];

export const MAX_PROMPT_CHARS = 2000;
export const MAX_LYRICS_CHARS = 3500;
export const COVER_PROMPT_MIN = 10;
export const COVER_PROMPT_MAX = 300;
export const COVER_LYRICS_MIN = 10;
export const COVER_LYRICS_MAX = 1000;
export const MAX_AUDIO_FILE_BYTES = 50 * 1024 * 1024; // 50 MB reference audio

export const BASE_RESP_HINTS = {
  1002: "Rate limit triggered. Free tier is 3 RPM; paid models are 120 RPM. Retry later.",
  1004: "Authentication failed. Check the API key (MINIMAX_API_KEY or ~/.mmx/config.json).",
  1008: "Insufficient balance. Top up the MiniMax account or switch to a free model (music-3.0-free) if your plan allows it.",
  1026: "Content flagged for sensitive material. Rephrase the prompt/lyrics.",
  2013: "Invalid parameters. Check the request fields.",
  2049: "Invalid API key. Check MINIMAX_API_KEY or ~/.mmx/config.json.",
};

function str(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Resolve the API base URL from (in priority order): MINIMAX_BASE_URL, MINIMAX_REGION, ~/.mmx/config.json region, default global. */
export function resolveBaseUrl({ env = {}, mmxConfig = null } = {}) {
  const explicit = str(env.MINIMAX_BASE_URL).trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const region = (str(env.MINIMAX_REGION).trim() || str(mmxConfig?.region).trim() || "global").toLowerCase();
  const entry = MINIMAX_ENDPOINTS[region];
  if (!entry) {
    throw new Error(`Unknown MiniMax region "${region}". Use "global" or "cn", or set MINIMAX_BASE_URL explicitly.`);
  }
  return entry.baseUrl;
}

/** Resolve the API key from (in priority order): MINIMAX_API_KEY, ~/.mmx/config.json. */
export function resolveApiKey({ env = {}, mmxConfig = null } = {}) {
  const key = str(env.MINIMAX_API_KEY).trim() || str(mmxConfig?.api_key).trim() || str(mmxConfig?.apiKey).trim();
  if (key) return key;
  throw new Error(
    "No MiniMax API key found. Set MINIMAX_API_KEY, or run `mmx auth login --api-key <key>` to persist one in ~/.mmx/config.json.",
  );
}

export function isCoverModel(model) {
  return COVER_MODELS.includes(model);
}

export function normalizeAudioSetting(input) {
  const raw = input ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("audio_setting must be an object: { sample_rate, bitrate, format }.");
  }
  const out = {
    format: str(raw.format).trim().toLowerCase() || "mp3",
    sample_rate: raw.sample_rate === undefined || raw.sample_rate === null ? 44100 : Number(raw.sample_rate),
    bitrate: raw.bitrate === undefined || raw.bitrate === null ? 256000 : Number(raw.bitrate),
  };
  if (!AUDIO_FORMATS.includes(out.format)) {
    throw new Error(`audio_setting.format must be one of ${AUDIO_FORMATS.join(", ")} (got "${out.format}").`);
  }
  if (!SAMPLE_RATES.includes(out.sample_rate)) {
    throw new Error(`audio_setting.sample_rate must be one of ${SAMPLE_RATES.join(", ")} (got ${out.sample_rate}).`);
  }
  if (!BITRATES.includes(out.bitrate)) {
    throw new Error(`audio_setting.bitrate must be one of ${BITRATES.join(", ")} (got ${out.bitrate}).`);
  }
  return out;
}

function normalizeSeed(seed) {
  if (seed === undefined || seed === null) return undefined;
  const n = Number(seed);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
    throw new Error(`seed must be an integer between 0 and 1,000,000 (got ${seed}).`);
  }
  return n;
}

function checkOutputFormat(format) {
  const of = str(format).trim().toLowerCase() || "url";
  if (of !== "url" && of !== "hex") {
    throw new Error(`output_format must be "url" or "hex" (got "${of}").`);
  }
  return of;
}

/**
 * Validate a music_generation request and return the wire body.
 * Throws Error with an actionable message on any violation.
 */
export function buildMusicBody(params = {}) {
  const model = str(params.model).trim() || DEFAULT_MODEL;
  if (!ALL_MODELS.includes(model)) {
    throw new Error(`Unknown model "${model}". Valid models: ${ALL_MODELS.join(", ")}.`);
  }
  const cover = isCoverModel(model);
  const prompt = str(params.prompt).trim();
  const lyrics = str(params.lyrics);
  const lyricsTrimmed = lyrics.trim();

  const body = { model };

  if (cover) {
    if (params.is_instrumental) throw new Error("is_instrumental is only supported by text-to-music models (music-3.0 / music-2.6), not cover models.");
    if (params.lyrics_optimizer) throw new Error("lyrics_optimizer is only supported by text-to-music models (music-3.0 / music-2.6), not cover models.");
    if (!prompt) throw new Error(`prompt is required for cover models (${COVER_PROMPT_MIN}–${COVER_PROMPT_MAX} characters describing the target cover style).`);
    if (prompt.length < COVER_PROMPT_MIN || prompt.length > COVER_PROMPT_MAX) {
      throw new Error(`prompt must be ${COVER_PROMPT_MIN}–${COVER_PROMPT_MAX} characters for cover models (got ${prompt.length}).`);
    }
    const hasUrl = Boolean(str(params.audio_url).trim());
    const hasBase64 = Boolean(str(params.audio_base64).trim());
    const hasFeatureId = Boolean(str(params.cover_feature_id).trim());
    const sourceCount = [hasUrl, hasBase64, hasFeatureId].filter(Boolean).length;
    if (sourceCount !== 1) {
      throw new Error("Exactly one of audio_url, audio_file (→ audio_base64) or cover_feature_id is required for cover models.");
    }
    if (hasFeatureId && !lyricsTrimmed) {
      throw new Error(`lyrics is required with cover_feature_id (${COVER_LYRICS_MIN}–${COVER_LYRICS_MAX} characters — modify the formatted_lyrics returned by the preprocess step).`);
    }
    if (lyricsTrimmed && (lyricsTrimmed.length < COVER_LYRICS_MIN || lyricsTrimmed.length > COVER_LYRICS_MAX)) {
      throw new Error(`lyrics must be ${COVER_LYRICS_MIN}–${COVER_LYRICS_MAX} characters for cover models (got ${lyricsTrimmed.length}).`);
    }
    body.prompt = prompt;
    if (lyricsTrimmed) body.lyrics = lyricsTrimmed;
    if (hasUrl) body.audio_url = str(params.audio_url).trim();
    if (hasBase64) body.audio_base64 = str(params.audio_base64).trim();
    if (hasFeatureId) body.cover_feature_id = str(params.cover_feature_id).trim();
  } else {
    const instrumental = Boolean(params.is_instrumental);
    const lyricsOptimizer = Boolean(params.lyrics_optimizer);
    if (instrumental && lyricsTrimmed) throw new Error("Cannot use is_instrumental with lyrics.");
    if (lyricsOptimizer && (lyricsTrimmed || instrumental)) throw new Error("Cannot use lyrics_optimizer with lyrics or is_instrumental.");
    if (!prompt && !lyricsTrimmed && !instrumental && !lyricsOptimizer) {
      throw new Error("At least one of prompt, lyrics, is_instrumental, or lyrics_optimizer is required.");
    }
    if ((instrumental || lyricsOptimizer) && !prompt) {
      throw new Error("prompt is required with is_instrumental or lyrics_optimizer.");
    }
    if (!instrumental && !lyricsOptimizer && !lyricsTrimmed) {
      throw new Error("lyrics is required (or set is_instrumental: true, or lyrics_optimizer: true).");
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`prompt must be at most ${MAX_PROMPT_CHARS} characters (got ${prompt.length}).`);
    }
    if (lyricsTrimmed.length > MAX_LYRICS_CHARS) {
      throw new Error(`lyrics must be at most ${MAX_LYRICS_CHARS} characters (got ${lyricsTrimmed.length}).`);
    }
    if (prompt) body.prompt = prompt;
    if (lyricsTrimmed) body.lyrics = lyrics.trim();
    if (instrumental) body.is_instrumental = true;
    if (lyricsOptimizer) body.lyrics_optimizer = true;
  }

  const seed = normalizeSeed(params.seed);
  if (seed !== undefined) {
    if (!cover) throw new Error("seed is only supported for cover models (music-cover / music-cover-free).");
    body.seed = seed;
  }
  if (params.aigc_watermark) body.aigc_watermark = true;

  body.audio_setting = normalizeAudioSetting(params.audio_setting);
  body.output_format = checkOutputFormat(params.output_format);
  return body;
}

/** Validate a lyrics_generation request and return the wire body. */
export function buildLyricsBody(params = {}) {
  const mode = str(params.mode).trim().toLowerCase() || "write_full_song";
  if (mode !== "write_full_song" && mode !== "edit") {
    throw new Error(`mode must be "write_full_song" or "edit" (got "${mode}").`);
  }
  const prompt = str(params.prompt).trim();
  const lyrics = str(params.lyrics);
  const title = str(params.title).trim();
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`prompt must be at most ${MAX_PROMPT_CHARS} characters (got ${prompt.length}).`);
  }
  if (lyrics.length > MAX_LYRICS_CHARS) {
    throw new Error(`lyrics must be at most ${MAX_LYRICS_CHARS} characters (got ${lyrics.length}).`);
  }
  if (mode === "edit" && !lyrics.trim()) {
    // The API allows an empty prompt with edit mode (act on lyrics alone), but
    // empty lyrics in edit mode is certainly a mistake — nudge the caller.
    throw new Error('mode "edit" requires lyrics to edit/continue. Pass lyrics, or use mode "write_full_song".');
  }
  const body = { mode };
  if (prompt) body.prompt = prompt;
  if (lyrics.trim()) body.lyrics = lyrics;
  if (title) body.title = title;
  return body;
}

/** Validate a music_cover_preprocess request and return the wire body. */
export function buildCoverPreprocessBody(params = {}) {
  const hasUrl = Boolean(str(params.audio_url).trim());
  const hasBase64 = Boolean(str(params.audio_base64).trim());
  const n = [hasUrl, hasBase64].filter(Boolean).length;
  if (n !== 1) {
    throw new Error("Exactly one of audio_url or audio_file (→ audio_base64) is required for cover preprocess.");
  }
  const body = { model: DEFAULT_COVER_MODEL };
  if (hasUrl) body.audio_url = str(params.audio_url).trim();
  if (hasBase64) body.audio_base64 = str(params.audio_base64).trim();
  return body;
}

/**
 * Inspect a JSON payload's base_resp. Throws a mapped Error when the API
 * reports a non-zero status_code; returns the payload otherwise.
 */
export function checkBaseResp(payload) {
  const baseResp = payload?.base_resp;
  const code = baseResp?.status_code;
  if (code === undefined || code === null) return payload; // undocumented shape — let the caller inspect
  if (code === 0) return payload;
  const msg = baseResp?.status_msg || "unknown error";
  const hint = BASE_RESP_HINTS[code];
  const trace = payload?.trace_id ? ` (trace_id: ${payload.trace_id})` : "";
  throw new Error(`MiniMax API error ${code}: ${msg}${trace}${hint ? `\nHint: ${hint}` : ""}`);
}

/** Pull the audio out of a music_generation response. Returns { kind: 'url'|'hex', value }. */
export function extractAudio(payload) {
  const data = payload?.data ?? {};
  if (typeof data.audio_url === "string" && data.audio_url) return { kind: "url", value: data.audio_url };
  if (typeof data.audio === "string" && data.audio) {
    if (!/^[0-9a-fA-F]+$/.test(data.audio) || data.audio.length % 2 !== 0) {
      throw new Error("MiniMax API returned invalid audio data (expected an even-length hex string).");
    }
    return { kind: "hex", value: data.audio };
  }
  const status = data.status;
  const extraInfo = payload?.extra_info ? ` extra_info=${JSON.stringify(payload.extra_info)}` : "";
  throw new Error(`MiniMax API returned no audio (data keys: ${Object.keys(data).join(", ") || "none"}; status: ${status ?? "n/a"}).${extraInfo}`);
}

/** Human-readable summary of extra_info (field names differ between API revisions — handle both). */
export function formatExtraInfo(extraInfo) {
  if (!extraInfo || typeof extraInfo !== "object") return "";
  const lines = [];
  const durationMs = extraInfo.music_duration ?? extraInfo.audio_length;
  if (typeof durationMs === "number") lines.push(`Duration: ${(durationMs / 1000).toFixed(1)}s (${durationMs} ms)`);
  const sampleRate = extraInfo.music_sample_rate ?? extraInfo.audio_sample_rate;
  if (sampleRate) lines.push(`Sample rate: ${sampleRate} Hz`);
  if (extraInfo.music_channel) lines.push(`Channels: ${extraInfo.music_channel}`);
  if (extraInfo.bitrate) lines.push(`Bitrate: ${extraInfo.bitrate}`);
  const size = extraInfo.music_size ?? extraInfo.audio_size;
  if (size) lines.push(`Size: ${(size / (1024 * 1024)).toFixed(2)} MB`);
  return lines.join(" · ");
}

/** Extension for the audio format ('pcm' files get .pcm). */
export function extensionForFormat(format) {
  const f = str(format).trim().toLowerCase();
  if (f === "wav") return "wav";
  if (f === "pcm") return "pcm";
  return "mp3";
}
