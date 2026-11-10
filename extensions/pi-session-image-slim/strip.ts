/**
 * Remove inline base64 image payloads from Pi session transcripts.
 *
 * Pi stores tool results verbatim in the session JSONL. Reading an image file
 * with the `read` tool embeds the whole image as base64 in the transcript, so a
 * single session can grow to hundreds of megabytes of binary noise. The payload
 * is also loaded back into memory on every resume, because Pi keeps the whole
 * transcript as parsed objects.
 *
 * This module replaces every image content item with a short text marker that
 * records the size and the file the image came from, so the transcript stays
 * readable and the original can still be re-read from disk.
 *
 * Files are processed as a stream, line by line. A session transcript can be
 * hundreds of megabytes and this runs unattended on a memory-constrained box,
 * so the whole file is never held in memory at once.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";

/** One image content item inside a tool result. */
const IMAGE_ITEM = /{"type":"image","data":"([A-Za-z0-9+/=]{200,})"(?:,"mimeType":"([^"]*)")?}/g;

export interface StripResult {
	/** Transcript with every image payload replaced by a marker. */
	text: string;
	/** Number of image payloads that were replaced. */
	removed: number;
	/** Bytes of base64 that were removed. */
	bytes: number;
	/** True when the transcript actually changed. */
	changed: boolean;
}

export interface StripFileResult extends StripResult {
	file: string;
	/** False when the file was left untouched (not changed, or changed under us). */
	rewritten: boolean;
	/** Set when the file was skipped, with the reason. */
	skipped?: string;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Map tool call ids to the file path the `read` tool was reading, so the marker
 * can point back at the original image.
 */
function toolCallPaths(line: string): Map<string, string> {
	const paths = new Map<string, string>();
	try {
		const entry = JSON.parse(line) as {
			message?: { role?: string; content?: unknown };
		};
		const message = entry.message;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return paths;
		for (const part of message.content) {
			if (!part || typeof part !== "object") continue;
			const call = part as { type?: string; id?: string; arguments?: unknown };
			if (call.type !== "toolCall" || typeof call.id !== "string") continue;
			const args = call.arguments as { path?: unknown } | undefined;
			if (args && typeof args.path === "string") paths.set(call.id, args.path);
		}
	} catch {
		// A malformed line is left untouched.
	}
	return paths;
}

function toolCallIdOf(line: string): string | undefined {
	try {
		const entry = JSON.parse(line) as { message?: { toolCallId?: unknown } };
		const id = entry.message?.toolCallId;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

/** Replace every inline image payload in a single line. */
function stripLine(
	line: string,
	paths: Map<string, string>,
	state: { removed: number; bytes: number },
): string {
	if (!line.includes('"image"')) return line;
	const source = paths.get(toolCallIdOf(line) ?? "");
	return line.replace(IMAGE_ITEM, (_match, base64: string, mimeType?: string) => {
		state.removed++;
		state.bytes += base64.length;
		const mime = mimeType ?? "image";
		const origin = source ? ` - re-read ${source}` : "";
		return JSON.stringify({
			type: "text",
			text: `[image stripped from transcript: ${formatBytes(base64.length)} base64 ${mime}${origin}]`,
		});
	});
}

/** Replace every inline image payload in a transcript. */
export function stripTranscript(text: string): StripResult {
	const lines = text.split("\n");
	const paths = new Map<string, string>();
	for (const line of lines) {
		if (!line.includes('"toolCall"')) continue;
		for (const [id, path] of toolCallPaths(line)) paths.set(id, path);
	}
	const state = { removed: 0, bytes: 0 };
	const out = lines.map((line) => stripLine(line, paths, state));
	return { text: out.join("\n"), removed: state.removed, bytes: state.bytes, changed: state.removed > 0 };
}

/** Call `onLine` for every newline-delimited line of a file, streaming. */
async function forEachLine(file: string, onLine: (line: string) => void): Promise<void> {
	const stream = createReadStream(file, { encoding: "utf8" });
	let pending = "";
	for await (const chunk of stream) {
		pending += chunk;
		let index = pending.indexOf("\n");
		while (index !== -1) {
			onLine(pending.slice(0, index));
			pending = pending.slice(index + 1);
			index = pending.indexOf("\n");
		}
	}
	if (pending.length > 0) onLine(pending);
}

/**
 * Strip one session file in place.
 *
 * The original mtime is preserved so the retention policy keeps seeing the real
 * age of the session instead of restarting the clock.
 */
export async function stripSessionFile(file: string, options: { minAgeMs?: number } = {}): Promise<StripFileResult> {
	const before = await stat(file);
	if (options.minAgeMs && Date.now() - before.mtimeMs < options.minAgeMs) {
		return {
			file,
			text: "",
			removed: 0,
			bytes: 0,
			changed: false,
			rewritten: false,
			skipped: "modified too recently",
		};
	}

	// Pass 1: collect the tool call -> path map. Only the ids are kept, so
	// memory stays flat regardless of transcript size.
	const paths = new Map<string, string>();
	await forEachLine(file, (line) => {
		if (!line.includes('"toolCall"')) return;
		for (const [id, path] of toolCallPaths(line)) paths.set(id, path);
	});

	// Pass 2: write the stripped transcript out line by line.
	const temp = join(dirname(file), `.${file.split("/").pop()}.slim-tmp`);
	const state = { removed: 0, bytes: 0 };
	const writer = createWriteStream(temp, { encoding: "utf8" });
	let pending = "";
	try {
		await pipeline(
			createReadStream(file, { encoding: "utf8" }),
			new Writable({
				write(chunk, _encoding, callback) {
					pending += chunk;
					let index = pending.indexOf("\n");
					while (index !== -1) {
						writer.write(`${stripLine(pending.slice(0, index), paths, state)}\n`);
						pending = pending.slice(index + 1);
						index = pending.indexOf("\n");
					}
					callback();
				},
				final(callback) {
					if (pending.length > 0) writer.write(stripLine(pending, paths, state));
					callback();
				},
			}),
			writer,
			{ end: true },
		);
	} catch (error) {
		await rm(temp, { force: true }).catch(() => undefined);
		return {
			file,
			text: "",
			removed: state.removed,
			bytes: state.bytes,
			changed: state.removed > 0,
			rewritten: false,
			skipped: error instanceof Error ? error.message : String(error),
		};
	}

	if (state.removed === 0) {
		await rm(temp, { force: true }).catch(() => undefined);
		return { file, text: "", removed: 0, bytes: 0, changed: false, rewritten: false };
	}

	// If the session grew while we were reading it, leave it for the next pass
	// instead of overwriting entries that were appended in the meantime.
	const after = await stat(file);
	if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
		await rm(temp, { force: true }).catch(() => undefined);
		return {
			file,
			text: "",
			removed: state.removed,
			bytes: state.bytes,
			changed: true,
			rewritten: false,
			skipped: "file changed during rewrite",
		};
	}

	const now = new Date();
	await utimes(temp, now, before.mtime);
	await rename(temp, file);

	return { file, text: "", removed: state.removed, bytes: state.bytes, changed: true, rewritten: true };
}

/** Strip every session transcript below a root directory. */
export async function stripStore(root: string, options: { minAgeMs?: number } = {}): Promise<StripFileResult[]> {
	const results: StripFileResult[] = [];

	const walk = async (dir: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			if (!entry.name.endsWith(".jsonl")) continue;
			try {
				results.push(await stripSessionFile(full, options));
			} catch (error) {
				results.push({
					file: full,
					text: "",
					removed: 0,
					bytes: 0,
					changed: false,
					rewritten: false,
					skipped: error instanceof Error ? error.message : String(error),
				});
			}
		}
	};

	await walk(root);
	return results;
}

// CLI: `bun strip.ts <session-root>` strips every transcript below the given root.
if (import.meta.main) {
	const root = process.argv[2] ?? join(process.env.HOME ?? "", ".pi", "agent", "sessions");
	const results = await stripStore(root, { minAgeMs: 30_000 });
	const rewritten = results.filter((r) => r.rewritten);
	const skipped = results.filter((r) => r.skipped);
	const removed = rewritten.reduce((sum, r) => sum + r.removed, 0);
	const bytes = rewritten.reduce((sum, r) => sum + r.bytes, 0);
	console.log(`Scanned ${results.length} session file(s) under ${root}`);
	console.log(`Rewrote ${rewritten.length} file(s): removed ${removed} image payload(s), ${formatBytes(bytes)}`);
	if (skipped.length > 0) console.log(`Skipped ${skipped.length} file(s): ${skipped[0]?.skipped}`);
}
