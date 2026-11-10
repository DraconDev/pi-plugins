/**
 * Keep Pi session transcripts free of inline base64 image payloads.
 *
 * The `read` tool embeds images as base64 in the tool result, and Pi persists
 * tool results verbatim. A session that reads a few hundred images grows to
 * hundreds of megabytes, which is then loaded back into memory on every resume.
 *
 * This extension rewrites the current session file after the agent settles and
 * replaces every image content item with a short marker that names the file the
 * image came from. The running process keeps the image in its in-memory context
 * (the model still sees it during the turn); only the stored transcript is
 * slimmed, so the next resume loads a fraction of the data.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripSessionFile } from "./strip.ts";

/** Only re-strip once the file has grown by at least this much since the last pass. */
const MIN_GROWTH_BYTES = 2 * 1024 * 1024;

/** Last size we stripped per session file. */
const strippedSizes = new Map<string, number>();

async function slimCurrentSession(ctx: ExtensionContext): Promise<void> {
	const file = ctx.sessionManager.getSessionFile();
	if (!file) return;

	const result = await stripSessionFile(file);
	if (result.rewritten) {
		strippedSizes.set(file, result.text.length);
		ctx.ui.notify(
			`Session slim: removed ${result.removed} inline image payload(s) (${Math.round(result.bytes / 1024)} KB) from the transcript.`,
			"info",
		);
	}
}

export default function sessionImageSlim(pi: ExtensionAPI): void {
	pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;

		// Cheap guard: skip the rewrite unless the file grew meaningfully since
		// the last pass, so settling a turn does not re-read the whole transcript.
		const { stat } = await import("node:fs/promises");
		let size: number;
		try {
			size = (await stat(file)).size;
		} catch {
			return;
		}
		const last = strippedSizes.get(file);
		if (last !== undefined && size - last < MIN_GROWTH_BYTES) return;

		try {
			await slimCurrentSession(ctx);
		} catch {
			// Never let transcript maintenance break the session.
		}
	});
}
