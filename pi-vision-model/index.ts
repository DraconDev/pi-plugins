/**
 * pi-vision-model — mmx CLI (MiniMax VLM) vision backend for pi.
 *
 * Adds a capability-aware `describe_image_mmx` tool plus a `/mmx-vision`
 * command that analyze images through the `mmx vision describe` CLI
 * (MiniMax VLM). The tool is visible to the LLM only when the active
 * primary model is text-only (cannot process images natively); on a
 * multimodal primary it is hidden — native image pass-through wins, so
 * delegation is never wasted (same pattern as @getpipher/vision).
 *
 * Companion to @getpipher/vision (which delegates via pi's model runtime,
 * e.g. opencode-go/mimo-v2.5). This extension covers the independent mmx
 * CLI backend. Both can be installed together: the two tools are separate
 * and visibility is merged read-merge-write.
 *
 * Config: ~/.pi/agent/vision-model.json
 *   { "enabled": true }
 *   enabled=false hides the tool from the LLM entirely (/mmx-vision still works).
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TOOL_NAME = "describe_image_mmx";
const COMMAND_NAME = "mmx-vision";
const MMX_TIMEOUT_MS = 60_000;

const DEFAULT_PROMPT =
  "Describe the image in full technical detail: visible text, UI elements, layout, colors, charts, code, and anything else notable. Be precise and exhaustive — the primary model cannot see the image.";

interface VisionModelConfig {
  /** Master switch for the LLM-visible tool. false hides it (command still works). */
  enabled?: boolean;
}

function loadConfig(): VisionModelConfig {
  try {
    const raw = readFileSync(join(getAgentDir(), "vision-model.json"), "utf8");
    return JSON.parse(raw) as VisionModelConfig;
  } catch {
    return {};
  }
}

/** Whether the model can process images natively (safe default: no). */
function isMultimodal(model: ExtensionContext["model"]): boolean {
  return !!model?.input?.includes("image");
}

/** Read-merge-write tool visibility so other extensions' tools survive. */
function syncToolAvailability(pi: ExtensionAPI, model: ExtensionContext["model"], enabled: boolean): void {
  const active = pi.getActiveTools();
  const show = enabled && !isMultimodal(model);
  const has = active.includes(TOOL_NAME);
  if (show && !has) {
    pi.setActiveTools([...active, TOOL_NAME]);
  } else if (!show && has) {
    pi.setActiveTools(active.filter((n) => n !== TOOL_NAME));
  }
}

/**
 * Extract description text from `mmx vision describe --output json` responses.
 * Defensive: the response schema can vary by mmx version; try the common
 * shapes and fall back to raw stdout.
 */
function extractText(obj: unknown): string | undefined {
  if (typeof obj === "string") return obj;
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;

  const choice = (o.choices as Array<Record<string, unknown>> | undefined)?.[0];
  if (choice) {
    const msg = choice.message as Record<string, unknown> | undefined;
    if (msg) {
      if (typeof msg.content === "string" && msg.content.trim()) return msg.content;
      if (Array.isArray(msg.content)) {
        const text = (msg.content as Array<Record<string, unknown>>)
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n");
        if (text.trim()) return text;
      }
    }
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }

  for (const key of ["output_text", "reply", "content", "text", "description", "result"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v;
    if (Array.isArray(v)) {
      const text = (v as Array<Record<string, unknown>>)
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n");
      if (text.trim()) return text;
    }
  }
  return undefined;
}

/** Run `mmx vision describe` and return { ok, text }. */
async function runMmxVision(
  ctx: ExtensionContext,
  imagePath: string,
  prompt: string,
): Promise<{ ok: boolean; text: string }> {
  let res;
  try {
    res = await ctx.exec(
      "mmx",
      ["vision", "describe", "--image", imagePath, "--prompt", prompt, "--output", "json", "--quiet", "--non-interactive"],
      { timeout: MMX_TIMEOUT_MS },
    );
  } catch (error) {
    return { ok: false, text: `mmx vision error: failed to run the mmx CLI (${error instanceof Error ? error.message : String(error)}). Is mmx-cli installed and authenticated (\`mmx auth status\`)?` };
  }

  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || "").trim();
    return { ok: false, text: `mmx vision failed (exit ${res.code}): ${detail || "no output"}` };
  }

  const stdout = res.stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not JSON — treat raw stdout as the description (text mode output).
    return stdout ? { ok: true, text: stdout } : { ok: false, text: "mmx vision returned empty output." };
  }

  if (parsed && typeof parsed === "object") {
    const err = (parsed as Record<string, unknown>).error;
    if (err) {
      const message =
        typeof err === "string" ? err : typeof (err as Record<string, unknown>).message === "string" ? ((err as Record<string, unknown>).message as string) : JSON.stringify(err);
      return { ok: false, text: `mmx vision error: ${message}` };
    }
  }

  const text = extractText(parsed);
  if (!text) {
    return { ok: false, text: `mmx vision returned an unrecognized response: ${stdout.slice(0, 300)}` };
  }
  return { ok: true, text };
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const enabled = config.enabled !== false;

  // Keep tool visibility in sync with the active model's modality.
  const sync = (ctx: ExtensionContext) => syncToolAvailability(pi, ctx.model, enabled);
  pi.on("session_start", (_event, ctx) => sync(ctx));
  pi.on("model_select", (_event, ctx) => sync(ctx));

  // ── describe_image_mmx tool ────────────────────────────────────────────
  pi.registerTool({
    name: TOOL_NAME,
    label: "Describe Image (mmx / MiniMax VLM)",
    description:
      "Analyze an image file with the MiniMax VLM through the mmx CLI and return its text description or an answer about the image. Use when the active primary model cannot process images natively and you want the mmx backend (or describe_image is unavailable). Accepts a local file path or an image URL.",
    promptSnippet: "Analyze an image file with the mmx CLI (MiniMax VLM)",
    promptGuidelines: [
      "When you need to analyze an image and the active model cannot see images natively, prefer describe_image. If it errors (e.g. vision model unavailable) or the user asks for mmx specifically, use describe_image_mmx with a local file path.",
    ],
    parameters: Type.Object({
      image_path: Type.String({
        description: "Path to a local image file, or an image URL.",
      }),
      prompt: Type.Optional(
        Type.String({
          description: "What to analyze or ask about the image. Defaults to a detailed technical description.",
        }),
      ),
    }),
    async execute(_toolCallId, params: Static<typeof parameters>, _signal, _onUpdate, ctx) {
      // Defense-in-depth: the tool should be hidden on multimodal primaries.
      if (isMultimodal(ctx.model)) {
        const id = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
        return {
          content: [
            {
              type: "text" as const,
              text: `The active primary model (${id}) can process images natively — use the \`read\` tool to view the image and respond directly; no delegation needed.`,
            },
          ],
          details: { mode: "passthrough_redirect" },
        };
      }

      if (!/^(https?:|data:)/.test(params.image_path) && !existsSync(params.image_path)) {
        return {
          content: [{ type: "text" as const, text: `describe_image_mmx error: image not found at ${params.image_path}.` }],
          details: { mode: "delegate", error: "not_found" },
          isError: true,
        };
      }

      const result = await runMmxVision(ctx, params.image_path, params.prompt?.trim() || DEFAULT_PROMPT);
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: { backend: "mmx-cli", ok: result.ok },
        isError: !result.ok,
      };
    },
  });

  // ── /mmx-vision command ────────────────────────────────────────────────
  pi.registerCommand(COMMAND_NAME, {
    description: "Describe an image with the mmx CLI (MiniMax VLM) and inject the description into the conversation",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const imagePath = parts.shift();
      if (!imagePath) {
        ctx.ui.notify("Usage: /mmx-vision <image-path> [prompt...]", "warning");
        return;
      }
      const prompt = parts.join(" ") || DEFAULT_PROMPT;
      ctx.ui.notify("Describing image via mmx (MiniMax VLM)…", "info");
      const result = await runMmxVision(ctx, imagePath, prompt);
      if (!result.ok) {
        ctx.ui.notify(result.text.slice(0, 300), "error");
        return;
      }
      pi.sendUserMessage(`[Image described via mmx (MiniMax VLM)]\n${result.text}`, { deliverAs: "followUp" });
      ctx.ui.notify("Description sent to the model.", "info");
    },
  });
}
