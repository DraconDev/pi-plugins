// pi-chrome — v0.16.0 (unreleased)
// extensions/chrome-profile-bridge/evaluate-cap.mjs
//
// Pure, dependency-free cap logic for the chrome_evaluate tool (steal-list
// #13 / bug class #1.2 in pi-goal-loop-audit's OPEN-ISSUES doc): a single
// evaluate result that returns a scraped page can blow the model's
// max-output-token budget and force a compaction. Instead of returning the
// full payload inline, results over the cap are replaced with a STRUCTURED
// DIGEST and the raw payload is written to a SIDECAR file the model can
// `read` on demand.
//
// This module is deliberately pure (no fs, no pi imports): the tool decides
// where the sidecar goes and does the write; the unit tests pin the digest
// + sidecar contract with plain node.

export const EVALUATE_CAP_DEFAULT_BYTES = 8 * 1024;

/** Serialize an evaluate result the way the tool surfaces it: strings
 * verbatim, everything else pretty-printed JSON (falling back to String()
 * for values JSON cannot represent, e.g. BigInt). Undefined → "undefined",
 * matching the pre-cap tool behavior. */
export function evaluateText(value) {
	if (value === undefined) return "undefined";
	if (typeof value === "string") return value;
	try {
		const json = JSON.stringify(value, null, 2);
		return json ?? "undefined";
	} catch {
		return String(value);
	}
}

function typeLabel(value) {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return "array";
	if (typeof value === "object") return "object";
	return typeof value;
}

/** Cheap structural sketch of an entry — no serialization of big subtrees,
 * so sketching a 100 MB nested object costs O(1). */
function sketch(entry) {
	if (entry === null) return "null";
	if (Array.isArray(entry)) return `array (${entry.length} items)`;
	if (typeof entry === "object") return `object (${Object.keys(entry).length} keys)`;
	if (typeof entry === "string") return `string (${Buffer.byteLength(entry, "utf8")} B)`;
	return typeof entry;
}

const DIGEST_SKETCH_LIMIT = 15;
const DIGEST_HEAD_CHARS = 400;

function sidecarFileName(value, now) {
	const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
	const rand = Math.random().toString(36).slice(2, 6);
	const ext = typeof value === "string" ? "txt" : "json";
	return `evaluate-${stamp}-${rand}.${ext}`;
}

function digestLines(value, bytes, capBytes, sidecarPath, text) {
	const lines = [
		`chrome_evaluate output capped at ${capBytes} bytes — full payload saved to a sidecar`,
		`type: ${typeLabel(value)}`,
		`bytes: ${bytes} (cap ${capBytes})`,
		`sidecar: ${sidecarPath}`,
		`read: load the sidecar with the read tool when you need the raw payload`,
	];
	if (typeof value === "string") {
		lines.push(`chars: ${value.length}`);
		lines.push(`head: ${JSON.stringify(value.slice(0, DIGEST_HEAD_CHARS))}${value.length > DIGEST_HEAD_CHARS ? "…" : ""}`);
	} else if (Array.isArray(value)) {
		lines.push(`items: ${value.length}`);
		const first = value.slice(0, DIGEST_SKETCH_LIMIT);
		lines.push(`items: ${first.map((entry, i) => `[${i}] ${sketch(entry)}`).join(", ")}${value.length > DIGEST_SKETCH_LIMIT ? `, … (${value.length - DIGEST_SKETCH_LIMIT} more)` : ""}`);
	} else if (value !== null && typeof value === "object") {
		const keys = Object.keys(value);
		lines.push(`keys: ${keys.length}`);
		const first = keys.slice(0, DIGEST_SKETCH_LIMIT);
		lines.push(`keys: ${first.map((key) => `${key}: ${sketch(value[key])}`).join(", ")}${keys.length > DIGEST_SKETCH_LIMIT ? `, … (${keys.length - DIGEST_SKETCH_LIMIT} more)` : ""}`);
	} else {
		lines.push(`value: ${text.slice(0, DIGEST_HEAD_CHARS)}`);
	}
	return lines;
}

/**
 * Decide how a chrome_evaluate result should be returned.
 *
 * Returns:
 *   { kind: "inline", text, details }                    — within the cap,
 *     unchanged behavior (details carries the raw value, like before).
 *   { kind: "sidecar", text, details, sidecarPath, sidecarPayload }
 *     — over the cap: text is the structured digest, details carries
 *     { capped, type, bytes, capBytes, sidecar }, and the caller must write
 *     sidecarPayload to sidecarPath (the digest names the absolute path so
 *     the model can `read` it on demand).
 *   { kind: "inline", text, details }                    — over the cap but
 *     no sidecarDir was provided: falls back to truncation so the tool
 *     still returns something bounded.
 *
 * @param {unknown} value
 * @param {{ capBytes?: number, sidecarDir?: string | null, now?: number }} [opts]
 */
export function capEvaluateOutput(value, { capBytes = EVALUATE_CAP_DEFAULT_BYTES, sidecarDir = null, now = Date.now() } = {}) {
	const text = evaluateText(value);
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= capBytes) {
		return { kind: "inline", text, details: { value } };
	}
	if (!sidecarDir) {
		// No place to park the raw payload — bounded truncation is the
		// fallback (mirrors the old MAX_TEXT_CHARS behavior).
		return { kind: "inline", text: `${text.slice(0, capBytes)}\n\n[truncated ${bytes - capBytes} bytes — set a sidecar directory to keep the full payload]`, details: { value: null } };
	}
	const sidecarPath = `${sidecarDir.replace(/[\\/]+$/, "")}/${sidecarFileName(value, now)}`;
	const sidecarPayload = typeof value === "string" ? value : text;
	return {
		kind: "sidecar",
		text: digestLines(value, bytes, capBytes, sidecarPath, text).join("\n"),
		details: { capped: true, type: typeLabel(value), bytes, capBytes, sidecar: sidecarPath },
		sidecarPath,
		sidecarPayload,
	};
}
