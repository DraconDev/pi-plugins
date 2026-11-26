import test from "node:test";
import assert from "node:assert/strict";

import {
  ALL_MODELS,
  CONNECTOR_MAX_LYRICS_CHARS,
  CONNECTOR_MAX_PROMPT_CHARS,
  buildConnectorRequests,
  buildCoverPreprocessBody,
  buildCrossfadeFilter,
  buildLyricsBody,
  buildMusicBody,
  checkBaseResp,
  extensionForFormat,
  extractAudio,
  formatExtraInfo,
  isAccountBlocked,
  movementDirection,
  normalizeAudioSetting,
  planMovements,
  resolveApiKey,
  resolveBaseUrl,
} from "../music-core.mjs";

// ---------------------------------------------------------------- auth ----

test("resolveBaseUrl defaults to global and honors MINIMAX_BASE_URL", () => {
  assert.equal(resolveBaseUrl({ env: {} }), "https://api.minimax.io");
  assert.equal(resolveBaseUrl({ env: { MINIMAX_REGION: "cn" } }), "https://api.minimax.cn");
  assert.equal(resolveBaseUrl({ env: {}, mmxConfig: { region: "cn" } }), "https://api.minimax.cn");
  assert.equal(resolveBaseUrl({ env: { MINIMAX_BASE_URL: "https://example.test/" } }), "https://example.test");
  assert.throws(() => resolveBaseUrl({ env: { MINIMAX_REGION: "moon" } }), /Unknown MiniMax region/);
});

test("resolveApiKey prefers env over mmx config", () => {
  assert.equal(resolveApiKey({ env: { MINIMAX_API_KEY: "sk-env" }, mmxConfig: { api_key: "sk-cfg" } }), "sk-env");
  assert.equal(resolveApiKey({ env: {}, mmxConfig: { api_key: "sk-cfg" } }), "sk-cfg");
  assert.throws(() => resolveApiKey({ env: {}, mmxConfig: null }), /No MiniMax API key/);
});

// ---------------------------------------------------------- generate ----

test("text-to-music: lyrics required unless instrumental/optimizer", () => {
  assert.throws(() => buildMusicBody({ model: "music-3.0", prompt: "pop" }), /lyrics is required/);
  const body = buildMusicBody({ model: "music-3.0", prompt: "upbeat pop", lyrics: "[Verse]\nLa la" });
  assert.equal(body.model, "music-3.0");
  assert.equal(body.lyrics, "[Verse]\nLa la");
  assert.equal(body.output_format, "url");
  assert.deepEqual(body.audio_setting, { format: "mp3", sample_rate: 44100, bitrate: 256000 });
});

test("text-to-music: instrumental requires prompt, forbids lyrics", () => {
  assert.throws(() => buildMusicBody({ is_instrumental: true }), /prompt is required/);
  assert.throws(
    () => buildMusicBody({ is_instrumental: true, prompt: "epic orchestral", lyrics: "[Verse]\nx" }),
    /Cannot use is_instrumental with lyrics/,
  );
  const body = buildMusicBody({ is_instrumental: true, prompt: "epic orchestral" });
  assert.equal(body.is_instrumental, true);
  assert.equal(body.lyrics, undefined);
});

test("text-to-music: lyrics_optimizer requires prompt, forbids lyrics/instrumental", () => {
  assert.throws(() => buildMusicBody({ lyrics_optimizer: true }), /prompt is required/);
  assert.throws(() => buildMusicBody({ lyrics_optimizer: true, prompt: "p", lyrics: "l" }), /Cannot use lyrics_optimizer/);
  assert.throws(() => buildMusicBody({ lyrics_optimizer: true, prompt: "p", is_instrumental: true }), /Cannot use lyrics_optimizer/);
  const body = buildMusicBody({ lyrics_optimizer: true, prompt: "synthwave about rain" });
  assert.equal(body.lyrics_optimizer, true);
});

test("text-to-music: nothing at all is an error; prompt-only non-instrumental is an error", () => {
  assert.throws(() => buildMusicBody({}), /At least one of/);
  assert.throws(() => buildMusicBody({ prompt: "just a style" }), /lyrics is required/);
});

test("text-to-music: length limits enforced", () => {
  assert.throws(() => buildMusicBody({ is_instrumental: true, prompt: "x".repeat(2001) }), /prompt must be at most 2000/);
  assert.throws(() => buildMusicBody({ prompt: "p", lyrics: "y".repeat(3501) }), /lyrics must be at most 3500/);
});

test("cover: requires 10–300 char prompt and exactly one audio source", () => {
  assert.throws(() => buildMusicBody({ model: "music-cover", prompt: "short", audio_url: "https://a/b.mp3" }), /10–300/);
  assert.throws(() => buildMusicBody({ model: "music-cover", prompt: "a perfectly fine style prompt" }), /Exactly one of/);
  assert.throws(
    () => buildMusicBody({ model: "music-cover", prompt: "a perfectly fine style prompt", audio_url: "https://a/b.mp3", cover_feature_id: "id" }),
    /Exactly one of/,
  );
  const body = buildMusicBody({ model: "music-cover", prompt: "Jazz, smooth, late night lounge, saxophone", audio_url: "https://a/b.mp3" });
  assert.equal(body.audio_url, "https://a/b.mp3");
});

test("cover: cover_feature_id requires lyrics 10–1000 chars", () => {
  assert.throws(
    () => buildMusicBody({ model: "music-cover", prompt: "Jazz, smooth, late night lounge, saxophone", cover_feature_id: "fid" }),
    /lyrics is required with cover_feature_id/,
  );
  assert.throws(
    () => buildMusicBody({ model: "music-cover", prompt: "Jazz, smooth, late night lounge, saxophone", cover_feature_id: "fid", lyrics: "too short" }),
    /lyrics must be 10–1000/,
  );
  const body = buildMusicBody({
    model: "music-cover",
    prompt: "Jazz, smooth, late night lounge, saxophone",
    cover_feature_id: "fid",
    lyrics: "[Verse]\nThis is long enough to be accepted by the API.",
  });
  assert.equal(body.cover_feature_id, "fid");
});

test("cover models reject text-to-music only flags and unknown sources", () => {
  assert.throws(
    () => buildMusicBody({ model: "music-cover", prompt: "Jazz, smooth, late night lounge, saxophone", audio_url: "u", is_instrumental: true }),
    /is_instrumental is only supported/,
  );
  assert.throws(
    () => buildMusicBody({ model: "music-cover", prompt: "Jazz, smooth, late night lounge, saxophone", audio_url: "u", lyrics_optimizer: true }),
    /lyrics_optimizer is only supported/,
  );
});

test("unknown models rejected; all documented models accepted", () => {
  assert.throws(() => buildMusicBody({ model: "music-9.9", prompt: "p", lyrics: "l" }), /Unknown model/);
  for (const model of ALL_MODELS) {
    if (model.startsWith("music-cover")) continue; // cover needs audio source
    const body = buildMusicBody({ model, prompt: "p", lyrics: "[Verse]\nlong enough lyrics" });
    assert.equal(body.model, model);
  }
});

test("seed bounds, cover-only, and audio_setting validation", () => {
  assert.throws(
    () => buildMusicBody({ model: "music-cover", prompt: "Jazz, smooth, late night lounge, saxophone", audio_url: "u", seed: 1000001 }),
    /seed must be/,
  );
  assert.throws(
    () => buildMusicBody({ model: "music-cover", prompt: "Jazz, smooth, late night lounge, saxophone", audio_url: "u", seed: 1.5 }),
    /seed must be/,
  );
  assert.throws(
    () => buildMusicBody({ model: "music-3.0", prompt: "p", lyrics: "l", seed: 42 }),
    /seed is only supported for cover/,
  );
  assert.equal(
    buildMusicBody({ model: "music-cover", prompt: "Jazz, smooth, late night lounge, saxophone", audio_url: "u", seed: 42 }).seed,
    42,
  );
  assert.throws(
    () => buildMusicBody({ model: "music-3.0", prompt: "p", lyrics: "l", audio_setting: { format: "ogg" } }),
    /audio_setting.format/,
  );
  assert.throws(
    () => buildMusicBody({ model: "music-3.0", prompt: "p", lyrics: "l", audio_setting: { sample_rate: 22050 } }),
    /audio_setting.sample_rate/,
  );
  assert.throws(
    () => buildMusicBody({ model: "music-3.0", prompt: "p", lyrics: "l", audio_setting: { bitrate: 320 } }),
    /audio_setting.bitrate/,
  );
  assert.deepEqual(
    buildMusicBody({ model: "music-3.0", prompt: "p", lyrics: "l", audio_setting: { format: "wav", sample_rate: 32000, bitrate: 128000 } }).audio_setting,
    { format: "wav", sample_rate: 32000, bitrate: 128000 },
  );
});

test("output_format validation", () => {
  assert.throws(() => buildMusicBody({ model: "music-3.0", prompt: "p", lyrics: "l", output_format: "mp3" }), /output_format/);
  assert.equal(buildMusicBody({ model: "music-3.0", prompt: "p", lyrics: "l", output_format: "hex" }).output_format, "hex");
});

// ---------------------------------------------------------------- lyrics —

test("lyrics body: defaults, modes, limits", () => {
  assert.deepEqual(buildLyricsBody({ prompt: "a song about rain" }), { mode: "write_full_song", prompt: "a song about rain" });
  assert.throws(() => buildLyricsBody({ mode: "freestyle" }), /mode must be/);
  assert.throws(() => buildLyricsBody({ mode: "edit" }), /requires lyrics/);
  assert.throws(() => buildLyricsBody({ prompt: "x".repeat(2001) }), /at most 2000/);
  assert.throws(() => buildLyricsBody({ mode: "edit", lyrics: "y".repeat(3501) }), /at most 3500/);
  const edit = buildLyricsBody({ mode: "edit", lyrics: "[Verse]\nold", title: "Keep Me" });
  assert.equal(edit.mode, "edit");
  assert.equal(edit.title, "Keep Me");
});

// ----------------------------------------------------------- preprocess —

test("cover preprocess body: exactly one audio source", () => {
  assert.throws(() => buildCoverPreprocessBody({}), /Exactly one of/);
  assert.throws(() => buildCoverPreprocessBody({ audio_url: "u", audio_base64: "b" }), /Exactly one of/);
  assert.deepEqual(buildCoverPreprocessBody({ audio_url: "https://a/b.mp3" }), { model: "music-cover", audio_url: "https://a/b.mp3" });
  assert.deepEqual(buildCoverPreprocessBody({ audio_base64: "QUJD" }), { model: "music-cover", audio_base64: "QUJD" });
});

// ------------------------------------------------------------- responses —

test("checkBaseResp maps known codes and passes 0", () => {
  assert.equal(checkBaseResp({ base_resp: { status_code: 0, status_msg: "success" } }).base_resp.status_code, 0);
  assert.throws(
    () => checkBaseResp({ base_resp: { status_code: 1002, status_msg: "rate limit" } }),
    /1002.*Rate limit/s,
  );
  assert.throws(() => checkBaseResp({ base_resp: { status_code: 1008, status_msg: "no balance" }, trace_id: "abc" }), /1008.*abc/s);
  assert.throws(() => checkBaseResp({ base_resp: { status_code: 2049, status_msg: "bad key" } }), /2049/);
});

test("extractAudio handles url and hex, rejects garbage", () => {
  assert.deepEqual(extractAudio({ data: { audio_url: "https://cdn/x.mp3" } }), { kind: "url", value: "https://cdn/x.mp3" });
  assert.deepEqual(extractAudio({ data: { audio: "deadbeef" } }), { kind: "hex", value: "deadbeef" });
  assert.throws(() => extractAudio({ data: { audio: "zz" } }), /invalid audio data/);
  assert.throws(() => extractAudio({ data: {} }), /no audio/);
});

test("formatExtraInfo tolerates both field namings; extensionForFormat", () => {
  const s = formatExtraInfo({ music_duration: 25364, music_sample_rate: 44100, music_channel: 2, bitrate: 256000, music_size: 813651 });
  assert.match(s, /25\.4s/);
  assert.match(s, /44100 Hz/);
  assert.equal(formatExtraInfo(null), "");
  assert.equal(extensionForFormat("mp3"), "mp3");
  assert.equal(extensionForFormat("wav"), "wav");
  assert.equal(extensionForFormat("pcm"), "pcm");
});

test("normalizeAudioSetting defaults", () => {
  assert.deepEqual(normalizeAudioSetting(undefined), { format: "mp3", sample_rate: 44100, bitrate: 256000 });
});

// ------------------------------------------------------- mcode connector ----

test("isAccountBlocked only matches account-level refusals", () => {
  assert.equal(isAccountBlocked(1008), true); // insufficient balance
  assert.equal(isAccountBlocked(2153), true); // not entitled
  assert.equal(isAccountBlocked(2013), false); // invalid params - a request problem
  assert.equal(isAccountBlocked(1026), false); // content flagged
});

test("checkBaseResp attaches the status code to the error", () => {
  try {
    checkBaseResp({ base_resp: { status_code: 1008, status_msg: "insufficient balance" } });
    assert.fail("expected a throw");
  } catch (error) {
    assert.equal(error.statusCode, 1008);
    assert.match(error.message, /insufficient balance/);
  }
});

test("planMovements keeps a short lyric sheet in one movement", () => {
  const movements = planMovements("[Verse]\nOne line\n\n[Chorus]\nAnother line");
  assert.equal(movements.length, 1);
  assert.equal(movements[0].total, 1);
  assert.match(movements[0].lyrics, /\[Verse\]/);
  assert.match(movements[0].lyrics, /\[Chorus\]/);
});

test("planMovements splits a long lyric sheet at section boundaries", () => {
  const section = (tag, line) => `[${tag}]\n${line}\n${"word ".repeat(30).trim()}\n`;
  const lyrics = ["Intro", "Verse", "Chorus", "Bridge", "Outro"].map((tag) => section(tag, tag)).join("\n\n");
  assert.ok(lyrics.length > CONNECTOR_MAX_LYRICS_CHARS);

  const movements = planMovements(lyrics);
  assert.ok(movements.length > 1, "a long lyric sheet must become several movements");
  assert.ok(movements.length <= 5, "the connector accepts at most 5 requests per call");
  for (const movement of movements) {
    assert.ok(movement.lyrics.length <= CONNECTOR_MAX_LYRICS_CHARS);
    assert.equal(movement.total, movements.length);
  }
  assert.match(movements[0].direction, /intro/);
  assert.match(movements[movements.length - 1].direction, /outro/);
});

test("movementDirection names the first, middle and last movement", () => {
  assert.match(movementDirection(0, 3), /intro/);
  assert.match(movementDirection(1, 3), /develop/);
  assert.match(movementDirection(2, 3), /outro/);
});

test("buildConnectorRequests sends one request per movement, inside the wire limits", () => {
  const section = (tag) => `[${tag}]\n${"la ".repeat(120).trim()}\n`;
  const lyrics = ["Verse", "Chorus", "Bridge", "Outro"].map(section).join("\n\n");
  const { requests } = buildConnectorRequests({
    prompt: "cinematic downtempo electronic vocal, soulful female lead",
    lyrics,
    audio_setting: { format: "mp3", sample_rate: 44100, bitrate: 256000 },
  });

  assert.ok(requests.length >= 2);
  assert.ok(requests.length <= 5);
  for (const request of requests) {
    assert.ok(request.prompt.length <= CONNECTOR_MAX_PROMPT_CHARS);
    assert.ok(request.lyrics.length <= CONNECTOR_MAX_LYRICS_CHARS);
    assert.equal(request.format, "mp3");
    assert.equal(request.sample_rate, 44100);
    assert.equal(request.bitrate, 256000);
    assert.match(request.output_file, /^part-\d+\.mp3$/);
  }
});

test("buildConnectorRequests honours an explicit parts count", () => {
  const { requests } = buildConnectorRequests({
    prompt: "dark ambient instrumental",
    is_instrumental: true,
    parts: 3,
  });
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.lyrics, undefined);
    assert.ok(request.prompt.length <= CONNECTOR_MAX_PROMPT_CHARS);
  }
});

test("buildConnectorRequests refuses an instrumental without a prompt and a vocal without lyrics", () => {
  assert.throws(() => buildConnectorRequests({ is_instrumental: true }), /prompt is required/);
  assert.throws(() => buildConnectorRequests({ prompt: "pop" }), /lyrics is required/);
});

test("buildConnectorRequests refuses pcm, which cannot carry the AIGC metadata", () => {
  assert.throws(
    () => buildConnectorRequests({ prompt: "pop", is_instrumental: true, audio_setting: { format: "pcm" } }),
    /mp3, wav/,
  );
});

test("buildCrossfadeFilter chains the movements into one output", () => {
  assert.equal(buildCrossfadeFilter(1), "anull");
  const two = buildCrossfadeFilter(2);
  assert.match(two, /\[0:a\]\[1:a\]acrossfade=d=0\.5:c1=tri:c2=tri\[joined\]/);
  const three = buildCrossfadeFilter(3);
  assert.match(three, /\[a1\]\[2:a\]acrossfade=d=0\.5:c1=tri:c2=tri\[joined\]/);
});
