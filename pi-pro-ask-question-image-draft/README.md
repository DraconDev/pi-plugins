# pi-visual-review

`pi-visual-review` is a drop-in Pi package for staged, image-aware user review. It registers the existing `ask_user_question` tool name, so existing model workflows do not need a tool-name migration.

## Scope and image generation

The package supports both existing image references and explicit, opt-in image generation. To generate an option's visual as part of the review, set `options[].generate.prompt`; the built-in adapter supports Agnes (`agnes` and `agnes-cn`) and saves a local copy under `.pi/generated-images/`. Generation is never implicit, so ordinary questions do not spend provider quota. Existing `options[].image` references remain supported for images produced by any other tool (for example `codex_generate_image` or `agnes_image`).

The built-in generator currently supports the `agnes` and `agnes-cn` providers and Agnes image model ids. Other providers can supply image references through `options[].image`; unsupported generation providers fail before any UI opens. The provider and model can be set per option, or once at review level through `provider`, `model`, and `generation`:

```json
{
  "provider": "agnes",
  "model": "agnes-image-2.5-flash",
  "stages": [{
    "id": "direction",
    "header": "Direction",
    "prompt": "Compare the two visual directions.",
    "options": [
      { "id": "warm", "label": "Warm", "generate": { "prompt": "A warm editorial dashboard mockup" } },
      { "id": "cool", "label": "Cool", "generate": { "prompt": "A cool technical dashboard mockup" } }
    ]
  }]
}
```

The generator uses `AGNES_API_KEY`/`AGNES_CN_API_KEY` or Pi's stored credential, validates the returned image signature and size, and never retries failed quota/connection requests automatically. Generated image paths are included in the tool result details and persisted review state.

## Review input

The preferred shape is ordered `stages`:

```json
{
  "reviewId": "checkout-visual-1",
  "round": 1,
  "title": "Choose a checkout treatment",
  "stages": [
    {
      "id": "layout",
      "header": "Layout",
      "prompt": "Which layout should ship?",
      "options": [
        { "id": "grid", "label": "Grid", "image": { "path": "./art/grid.png", "alt": "Grid checkout" } },
        { "id": "stack", "label": "Stack", "image": { "path": "./art/stack.png", "alt": "Stack checkout" } }
      ]
    },
    {
      "id": "notes",
      "header": "Notes",
      "prompt": "Any final notes?",
      "required": false,
      "allowOther": true,
      "options": [
        { "id": "none", "label": "No notes" },
        { "id": "later", "label": "Decide later" }
      ]
    }
  ]
}
```

Stages default to `required: true`, `multiSelect: false`, `allowOther: true`, and (for the staged shape) `allowRevision: true`. Optional stages expose an explicit **Skip stage** action. A required stage cannot be skipped. Approval is gated on every stage having either a valid answer or an explicit optional skip; selecting an approval control while a stage is unresolved navigates to that stage in the TUI and cannot bypass it in the portable dialog path. Image generation is opt-in per option through `generate.prompt`; review-level `provider`, `model`, and `generation` values provide defaults.

`multiSelect: true` stages use Space or Enter to toggle options and a `Done selecting` action to commit them. The TUI and fallback paths use the same normalized answer and gate rules. Custom answers, explicit rejection, cancellation, revision requests, and host-unavailable fallback are distinct outcomes; fallback is not treated as a decline.

The legacy `{ "questions": [{ "question": "...", "options": [...] }] }` shape remains supported. Legacy questions receive stable `question-N` stage IDs and do not unexpectedly add a revision action.

## Rounds and persistence

Keep `reviewId` stable across rounds. After a revision result, regenerate only the affected images and call the tool again with the next integer `round`; list affected stage IDs in `resetStageIds`. The extension appends a `pi-visual-review-state` custom entry through Pi's public `appendEntry` API. On the next call, valid answers are repaired by stable stage ID when stage order changes, and reset stages are cleared. A completed state cannot be persisted with unresolved answers.

Cancellation and rejection return their own result envelopes. If TUI/RPC interaction is unavailable, the result is `fallback` with a plain-chat question list, never a synthetic approval or decline. The extension emits `pi-visual-review:prompt` when a validated review is ready and brackets the human wait with `pi-visual-review:blocked` (`{ active: true|false }`). A `before_agent_start` reconciler removes the tool in non-interactive runs and restores it when UI returns.

## TUI controls

- `↑`/`↓`: move within the current stage.
- `Enter`: select/confirm; in a multi-select option row it toggles the option, while the `Done selecting` row commits the current checked set.
- `Space`: toggle a multi-select option or activate a visible control.
- `Tab`, `→`/`←`: move between stages; approval still checks the complete review.
- `Esc`: cancel the current input, or cancel the review when no input editor is active.
- `Ctrl+]`: collapse or reopen the review overlay while preserving the current answers.
- `Ctrl+G`: edit a custom-answer draft in Pi's configured external editor.
- Mouse wheel: scroll long review content; click a visible option row to focus it.

Image previews are inline when the terminal supports them and otherwise use a safe path/URL/alt/preview text fallback. A failed or loading image never prevents answering the review. Explicit generation happens before the review opens, so the user sees the generated artifact in the same decision flow.

## Benchmark infrastructure

Benchmark artifacts are generated at caller-supplied paths and are intentionally not checked in. The canonical corpus is deterministic for a count/seed pair and uses a 70%/20%/10% ordinary, visual, and adversarial split (700/200/100 by default):

```sh
npm run benchmark:corpus -- --count 1000 --seed 20260925 --out .pi/benchmark/corpus.json
npm run benchmark:corpus:validate -- --corpus .pi/benchmark/corpus.json
npm run benchmark:compare -- --blind --passes 2 --out .pi/benchmark/results.json
```

`scripts/benchmark/SCHEMAS.md` documents every emitted JSON shape. The comparison loads legacy RPiV TypeScript only inside an isolated child through Pi's jiti extension loader. Shared legacy cases compare normalized answers, validation, and envelopes. Staged/visual features are absolute-scored against local source behavior and never counted as RPiV losses. No settings or credential files are written. The optional judge adapter in `scripts/benchmark/judge.mjs` is side-effect free on import; it uses `ModelRuntime` only when explicitly invoked, requires strict JSON, low/medium reasoning, two independent passes, and adjudication metadata for disagreement. `npm test` never uses the network.

Image artifacts must come from an explicitly authorized Agnes run. This implementation pass deliberately disables provider calls: `benchmark:images` without `--manifest` fails with `provider_calls_disabled`, and report generation fails with `manifest_missing` if no real manifest exists. Ingestion validates local PNG/JPEG/GIF/WebP signatures, dimensions, byte counts, provider/model, prompt hashes, duplicates, secrets, and the 600-image ceiling. It never creates empty success placeholders. Supply the same real manifest to both commands to ingest and report it:

```sh
npm run benchmark:images -- --manifest path/to/images.json --max 600 --out .pi/benchmark/images.json
npm run benchmark:images:report -- --manifest path/to/images.json --judges path/to/judges.json --out .pi/benchmark/image-report.json
```

The aggregate verifier requires the 700/200/100 counts, deterministic accuracy and Wilson confidence gate, resolved P0/P1 defects, visual uplift and severe-failure gates, real live-smoke evidence, and activation evidence timestamped after the gates. It refuses activation claims not explicitly evidenced:

```sh
npm run benchmark:report -- --verify .pi/benchmark/report.json
npm run smoke:live -- --image path/to/real.png
```

Live smoke requires real stdin/stdout TTYs, a configured Pi external editor, and a readable signed image. It exits nonzero instead of fabricating a pass when those conditions or an interactive driver are unavailable.

## Development and verification

From this directory:

```sh
npm test
npm run check
npm pack --dry-run
node scripts/smoke-runtime.mjs
node scripts/verify-tui.mjs
node scripts/verify-activation.mjs
```

`npm run check` runs hermetic source/tests/smokes. Activation is a separate machine-state gate; run `PI_VERIFY_ACTIVATION=1 npm run check` when the authorized local settings change is expected to be present. In this workspace, the equivalent interim TypeScript check is:

```sh
/home/dracon/Dev/pi-plugins/pi-goal-list-loop-audit/node_modules/typescript/bin/tsc --noEmit
```

The activation verifier requires a backup of the pre-activation settings file and checks that only the superseded package entry is replaced. It is intentionally not part of the default hermetic check because global settings are machine state, not package source. Keep the old package out of `packages`; the package intentionally owns the global `ask_user_question` name and Pi must load one registration for that name.
