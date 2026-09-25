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

The benchmark answers one question: **is this package ready to replace
`npm:@juicesharp/rpiv-ask-user-question`, and may it be activated?** It is built
so that an independent auditor can re-run every number without trusting this
repository's claims.

```sh
# The whole gate, in order. See scripts/benchmark/run-all.sh for the exact commands.
npm run benchmark:run
```

Individually:

```sh
# The durable Space Bunny Alpha corpus, reproduced from benchmark/corpus/
npm run benchmark:corpus -- --count 1000 --seed 20260925 --out .pi/benchmark/corpus.json
npm run benchmark:corpus:validate -- --corpus .pi/benchmark/corpus.json

# At most 600 cached Agnes images for the visual stratum, plus the canonical
# contract aliases .pi/benchmark/images/visual-001-option-{1,2,3}.png
npm run benchmark:images -- --max 600

# Two real executions per case, head-to-head against RPiV on shared capability
npm run benchmark:compare -- --blind --passes 2 --out .pi/benchmark/results.json

# Blinded judging: two independent passes, a third adjudicating any disagreement
npm run benchmark:judge -- --limit 200 --out .pi/benchmark/judge.json
npm run benchmark:images:report -- --out .pi/benchmark/image-report.json

# Real-TTY live gate (self-provisioning pseudo-terminal)
npm run smoke:live -- --image .pi/benchmark/images/visual-001-option-1.png

# Generated defect ledger, aggregate report, release gate
npm run benchmark:ledger
npm run benchmark:report -- --out .pi/benchmark/report.json
npm run benchmark:report -- --verify .pi/benchmark/report.json

# Mirror the evidence into the tracked repository and re-check it
npm run benchmark:publish
npm run benchmark:verify-evidence
```

`scripts/benchmark/SCHEMAS.md` documents every emitted JSON shape and every gate
threshold. The properties that matter for an audit:

- **The corpus ships with the repository.** `benchmark/corpus/space-bunny-alpha.json`
  is the 1,000-scenario corpus with its shard provenance, and `benchmark:corpus`
  re-emits it through the same validation gate on any machine. Regeneration is not
  a fresh synthetic fixture; `--source fixture` still produces one for tests.
- **Nothing is trusted.** `--passes N` executes the corpus N times and requires
  identical results; the aggregate report recomputes accuracy, visual uplift, and
  every gate from the artifacts on disk instead of reading a summary. Verifying a
  report that is not release-ready **exits nonzero** and names the unmet gates.
- **The oracle is explicit.** A scenario either asserts exact recorded answers or
  is marked `terminal-only` when the source recorded no answer action. The report
  counts both instead of blending them into one number, and every one of the
  1,000 scenarios must carry a terminal outcome in the results.
- **Shared scope is honest.** RPiV is compared only on legacy question reviews it
  actually implements, driven through its real RPC dialog protocol (option rows,
  the `Type something.` row, comma-separated multi-select, dismissal). A candidate
  failure is reported separately and is never charged to the reference.
- **Negatives are real.** A scenario marked `inputValid: false` passes only when
  the tool actually rejects it before any UI interaction.
- **The visual gate is measured, not asserted.** Images are generated from a
  prompt that names the surface and the concrete layout of each treatment
  (`scripts/benchmark/image-prompt.mjs`) and never names the option itself, so the
  judged comparison stays blinded. Arm letters follow the seeded blinding, so a
  candidate win cannot be recorded as a reference win. Ties and undecided cases are
  never credit and stay in the denominator. The gate needs a strict win rate of at
  least 60% with a two-sided 95% lower bound above 50%, and severe failures at or
  below 2%.
- **The image budget is bounded.** Generation is cached by prompt hash, capped at
  600 successes, and every failure is recorded instead of silently retried.
- **Live evidence is live.** `npm run smoke:live` loads the real extension through
  Pi's own loader, renders it on a real pi-tui screen inside a pseudo-terminal,
  drives it with real keypresses through the documented controls, and launches the
  external editor Pi itself resolves - the editor and its source are recorded, and
  the quit keys are derived from that editor rather than hard-coded. Without a TTY
  or a readable image it exits nonzero rather than fabricating a pass, and a named
  image path is never silently substituted.
- **The ledger is generated.** `npm run benchmark:ledger` writes the defect ledger
  from its definitions plus the run's own artifacts, so a resolved defect must name
  a test that exists and mentions its id, and a measured claim cannot drift from
  the numbers the report recomputes.
- **The evidence is in the repository.** `benchmark/evidence/` mirrors the corpus,
  results, image manifest, judging, live smoke, report, ledger and activation
  evidence, with a `SHA256SUMS` index and a sample of real generated images, so
  the verdict is auditable without a machine that still has `.pi/`.
- **No secrets, no settings writes.** The benchmark never reads or writes Pi
  settings or auth storage, and every emitted artifact is scanned for
  credential-shaped keys and values. `npm test` never uses the network. Activation
  is a separate, explicitly confirmed step (`node scripts/activate.mjs
  --confirm-gates`) that refuses to run until the release gate has passed.

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
