# pi-visual-review

`pi-visual-review` is a drop-in Pi package for staged, image-aware user review. It registers the existing `ask_user_question` tool name, so existing model workflows do not need a tool-name migration.

## Scope and image generation

The package supports both existing image references and explicit, opt-in image generation. To generate an option's visual as part of the review, set `options[].generate.prompt`; the built-in adapter supports Agnes (`agnes` and `agnes-cn`) and saves a local copy under `.pi/generated-images/`. Generation is never implicit, so ordinary questions do not spend provider quota. Existing `options[].image` references remain supported for images produced by any other tool (for example `codex_generate_image` or `agnes_image`).

The provider and model can be set per option, or once at review level through `provider`, `model`, and `generation`:

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

`multiSelect: true` stages use Space to toggle options and a `Done selecting` action to commit them. The TUI and fallback paths use the same normalized answer and gate rules. Custom answers, explicit rejection, cancellation, revision requests, and host-unavailable fallback are distinct outcomes; fallback is not treated as a decline.

The legacy `{ "questions": [{ "question": "...", "options": [...] }] }` shape remains supported. Legacy questions receive stable `question-N` stage IDs and do not unexpectedly add a revision action.

## Rounds and persistence

Keep `reviewId` stable across rounds. After a revision result, regenerate only the affected images and call the tool again with the next integer `round`; list affected stage IDs in `resetStageIds`. The extension appends a `pi-visual-review-state` custom entry through Pi's public `appendEntry` API. On the next call, valid answers are repaired by stable stage ID when stage order changes, and reset stages are cleared. A completed state cannot be persisted with unresolved answers.

Cancellation and rejection return their own result envelopes. If TUI/RPC interaction is unavailable, the result is `fallback` with a plain-chat question list, never a synthetic approval or decline.

## TUI controls

- `↑`/`↓`: move within the current stage.
- `Enter`: select/confirm; in a multi-select option row it commits the current checked set (the `Done selecting` row is also available).
- `Space`: toggle a multi-select option or activate a visible control.
- `Tab`, `→`/`←`: move between stages; approval still checks the complete review.
- `Esc`: cancel the current input, or cancel the review when no input editor is active.

Image previews are inline when the terminal supports them and otherwise use a safe path/URL/alt/preview text fallback. A failed or loading image never prevents answering the review. Explicit generation happens before the review opens, so the user sees the generated artifact in the same decision flow.

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

`npm run check` expects a local TypeScript executable. In this workspace, the equivalent interim check is:

```sh
/home/dracon/Dev/pi-plugins/pi-goal-list-loop-audit/node_modules/typescript/bin/tsc --noEmit
```

The activation verifier requires a backup of the pre-activation settings file and checks that only the superseded package entry is replaced. Keep the old package out of `packages`; the package intentionally owns the global `ask_user_question` name and Pi must load one registration for that name.
