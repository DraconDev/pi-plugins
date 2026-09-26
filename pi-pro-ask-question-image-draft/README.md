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

### Composed previews: structure from the package, character from the art

An option may carry a `mockup` spec, a `generate` request, or both. When it
carries both, the package **composes** them into one preview
(`src/preview-composer.ts`): the deterministic cell-grid structure is drawn
first and the generated art is scaled to fill the frame, washed back by a
bounded scrim, and the structure's ink is keyed on top of it.

That split is not cosmetic, and it came out of measurement rather than taste. An
option preview is 31 x 16 character cells - about 248 x 256 device pixels. A
generated image judged on that raster can carry a *shape* and an *emphasis*; it
cannot carry a sentence, and every question a visual review asks is answered by
information (which route is late, which release is blocked, which bin is under
its threshold). Left to stand alone, the generated preview was charged as a
severe failure in 34.5% of blinded comparisons, with the judge's own words
naming the same defect each time - "abstract placeholder-like symbols", "contain
no identifiable route, delay, or action information". Neither a longer prompt nor
a larger preview changed that: the display budget, not the model, is the
constraint.

So the information-bearing layer is drawn by the package, from the option's own
content, on the exact cell grid the terminal shows - and the art supplies the
visual character of the treatment inside it. The composition is a pure function
of `(spec, art bytes)`, so the same inputs produce the same preview on every
machine, and a preview is never less informative than the text presentation.
`npm run benchmark:compose` runs that same product path over the whole visual
stratum; the raw generated image is still generated, still judged, and still
reported beside it as a non-gating diagnostic.

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

# At most 600 cached Agnes images, plus the canonical contract aliases
npm run benchmark:images -- --max 600

# Two real executions per case, head-to-head against RPiV on shared capability
npm run benchmark:compare -- --blind --passes 2 --out .pi/benchmark/results.json

# Deterministic structures, then the shipped composed previews (no provider calls)
npm run benchmark:mockups
npm run benchmark:compose

# Blinded judging: two independent passes, a third adjudicating any disagreement.
# The gated arm is the preview the package renders; the raw generated image is
# judged on the same cases as a non-gating diagnostic.
npm run benchmark:judge -- --images .pi/benchmark/composed-manifest.json --limit 200 --out .pi/benchmark/judge.json
npm run benchmark:judge -- --images .pi/benchmark/image-manifest.json --limit 200 --out .pi/benchmark/judge-raw-image.json
npm run benchmark:images:report -- --out .pi/benchmark/image-report.json

# Real-TTY live gate (self-provisioning pseudo-terminal)
npm run smoke:live -- --image .pi/benchmark/images/visual-001-option-1.png

# Generated defect ledger, aggregate report, release gate, activation
npm run benchmark:ledger
npm run benchmark:report -- --out .pi/benchmark/report.json
npm run benchmark:report -- --verify .pi/benchmark/report.json
node scripts/activate.mjs --confirm-gates   # only when the gate passes
node scripts/activate.mjs --revert          # and again the moment it does not

# Mirror the evidence into the tracked repository and re-check it
npm run benchmark:publish
npm run benchmark:verify-evidence
```

`scripts/benchmark/SCHEMAS.md` documents every emitted JSON shape and every gate
threshold. The properties that matter for an audit:

- **The corpus ships with the repository.** `benchmark/corpus/space-bunny-alpha.json`
  is the 1,000-scenario corpus with its shard provenance, and `benchmark:corpus`
  re-emits it byte-identically on any machine. `--source fixture` still produces
  the deterministic fixture used by the tests.
- **Nothing is trusted, including the report.** `--passes N` executes the corpus N
  times; the aggregate report recomputes accuracy, visual uplift and every gate
  from the artifacts; and `--verify` re-derives them again from the artifacts the
  report names, failing if any claim disagrees with them. Verifying a report that
  is not release-ready exits nonzero and lists the unmet gates.
- **The visual gate is measured at the condition the objective states.** Images
  are attached as the raster a terminal actually displays - resampled onto the
  cell grid `src/tui.ts` gives an option preview (31 x 16 cells on a
  110-column terminal) - not as the untouched 1024x1024 source, and those renders
  are kept as artifacts. The baseline arm is the text the package prints today
  (`scripts/benchmark/text-arm.mjs` reproduces `renderRows` and
  `fallbackPreview`), not a summary written for the judge.
- **The gates are hard to satisfy by construction.** Ties and undecided cases are
  never credit and stay in the denominator. A verdict wrapped in prose is
  recovered but still validated against the same strict schema. A disagreement,
  of winner or of severity, is settled by a third independent pass, and an
  unbreakable split is charged to both arms. Severe failure is attributed
  through each case's own blinding labels, so the 2% ceiling is a measurement
  and not a formatting artefact. The image prompt never names the option, so the
  judged comparison stays blinded, and the arm letters follow the seeded blinding
  so a candidate win cannot be recorded as a reference win.
- **The oracle is explicit.** A scenario either asserts exact recorded answers or
  is marked `terminal-only`; every one of the 1,000 must carry a terminal
  outcome in the results or the report is rejected.
- **Shared scope is honest.** RPiV is compared only on legacy question reviews it
  implements, driven through its real RPC dialog protocol. A candidate failure is
  reported separately and never charged to the reference. Envelope *text* still
  differs on 53 of 333 shared cases; that rate is reported per classification and
  is deliberately not a gate, because the tools document different response
  contracts while the answers and status - what the tool contract does promise -
  match on all of them.
- **The ledger is generated.** `npm run benchmark:ledger` writes it from its
  definitions plus the run's own artifacts, so a resolved defect must name a test
  that exists and mentions its id, and a measured claim cannot drift from the
  numbers the report recomputes.
- **The evidence is in the repository.** `benchmark/evidence/` mirrors the
  corpus, results, image manifest, judging, live smoke, report, ledger,
  activation and generation account, with a `SHA256SUMS` index and a sample of
  real generated images.

### What this measurement cannot establish

These are recorded in the report itself (`measurementLimits`), not only in prose:

- **The judge and the corpus author are the same model family.** The visual
  verdict is a self-consistency measurement, not an independent third-party
  opinion.
- **The visual stratum's options mostly carry no preview text** (75 of 600 do),
  so the baseline arm is a label and one sentence for most of them. That is
  faithful to what the package renders today, and it is also the main reason the
  image arm is easy to prefer.
- **The 600-image budget is enforced per manifest, and the manifest is keyed by
  prompt hash**, so revising the image prompt retires a whole set. The cumulative
  provider consumption for this benchmark is recorded in
  `benchmark/evidence/generations.json` rather than implied by the current set.
- **No secrets, no settings writes.** The benchmark never reads or writes Pi
  settings or auth storage, and every emitted artifact is scanned for
  credential-shaped keys and values. `npm test` never uses the network. Activation
  is a separate, explicitly confirmed step that refuses to run until the release
  gate has passed, and `--revert` restores the superseded package when a gate
  fails.

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
