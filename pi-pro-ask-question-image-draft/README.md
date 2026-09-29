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

The review is a full-screen dashboard: it takes the whole screen, because a
paragraph-long prompt plus real options plus a preview needs the rows, and a
half-height drawer both truncated the list and covered the transcript the user
needed to check the answer against. `Ctrl+]` still collapses the whole thing to
a single dim line, so the conversation underneath is readable and the panel can
be toggled on and off without losing a thing.

- `↑`/`↓`: move within the current stage.
- `Enter`: select/confirm; in a multi-select option row it toggles the option, while the `Done selecting` row commits the current checked set.
- `Space`: toggle a multi-select option or activate a visible control.
- `Tab`, `→`/`←`: move between stages; approval still checks the complete review.
- `Esc`: cancel the current input, or cancel the review when no input editor is active.
- `Ctrl+]`: hide or bring back the whole dashboard. Answers are kept, and the
  hidden line says how many stages are answered.
- `Ctrl+R`: read a clamped stage prompt in full. A prompt longer than three
  lines is shown short with the rest one keypress away, because a wall of model
  prose pushed the options off the screen.
- `Ctrl+A`: turn **auto-resolve** on and off. It is **off by default** and says
  so in the footer. On, the cursor lands on the option the model marked
  `recommended` (or the first one) for every stage, so `Enter` takes it. It
  never submits by itself: a review that answers itself is a review nobody
  read. A review can also set `autoResolve: true` up front.
- `Ctrl+D`: switch row density. **Comfortable** (the default) prints a reason
  under every choice; **compact** lists the choices alone and shows the
  highlighted option's reason once, leading the list, so roughly twice as many
  options fit in the same fixed block. A review may ask for either with
  `density: "comfortable" | "compact"`, and this key overrides it for the
  session. The current mode is stated in the footer, because a switch nobody can
  see is one nobody trusts.
- `n` or the `Add note` row: attach a note to this stage. The review tab carries
  an `Add global note` row for the whole review. Neither marks anything answered.
- `Ctrl+G`: edit a custom-answer draft in Pi's configured external editor.
- Mouse wheel: scroll long review content, leaving the frame where you put it;
  the next cursor move brings the cursor back into view. Click a visible option
  row to focus it.

Answers are numbered so they can be talked about ("take 2"); the action rows -
note, custom answer, skip, revision, approve, reject - sit behind a rule and
are deliberately **not** numbered, because "press 3" should never be a way to
skip the question. A multi-select stage renders real checkboxes (`[ ]` / `[x]`),
and an option the model marked `recommended` says so on its row.

Image previews are inline when the terminal supports them and otherwise use a safe path/URL/alt/preview text fallback. A failed or loading image never prevents answering the review, and a host that cannot draw inline images is told so, with the switch that fixes it. Explicit generation happens before the review opens, so the user sees the generated artifact in the same decision flow.

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

## Seeing the images (tmux, and terminals without a graphics protocol)

An option's image is drawn inline, through the Kitty graphics protocol, in a
pane beside the list. Two things silently stop that, and both are properties of
the *host*, not of the option:

- **tmux is the big one.** pi-tui writes the image escape straight to the pty,
  and tmux does not forward an escape it does not understand: measured on tmux
  3.6a, a frame carrying a 527,315-byte PNG reached the terminal with **zero**
  of its payload bytes. This package now wraps graphics in tmux's passthrough
  envelope (`allow-passthrough on`), which does get the whole image to the
  terminal - but a full-screen TUI under tmux still repaints over pictures tmux
  does not own. **The configuration that reliably shows images is to run Pi
  outside tmux:**

  ```sh
  env -u TMUX pi          # or just launch pi directly in Ghostty/kitty/WezTerm
  ```

  `~/.tmux.conf` cannot fix this; it is a property of how tmux composites.
- **Terminals with no graphics protocol** (Windows Terminal, plain `screen`)
  fall back to text, and the review says so in the preview pane rather than
  printing a bare file path.

If you want to try the passthrough path anyway, in tmux 3.3+:

```sh
tmux set -g allow-passthrough all
# and start Pi with PI_IMAGE_PROTOCOL=kitty so the escape is emitted at all
```

To look at the dialog without using a terminal at all - the real wizard frame
with the real image, rasterised to a PNG:

```sh
npm run shot:review -- --image .pi/benchmark/images/visual-001-option-1.png --out .pi/benchmark/shots/review.png
npm run shot:review -- --honour-host --out .pi/benchmark/shots/tmux-fallback.png   # what tmux shows today
npm run shot:review -- --emit --hold 60                                            # paint it into a real terminal
```

## The panel: a fixed block, not a full-screen takeover

The review is a **fixed-height block anchored at the bottom of the
conversation**, not a takeover of the screen. It leaves five rows of the host's
own furniture alone - the input line, its blank, the cwd/status line and a
multiplexer bar - because you still have to read the conversation and see what
you are typing into while a question is open. A big screen gets a big panel
(32 rows), a small one keeps at least 14, and either way **the height does not
depend on the content**: the detail area absorbs the slack, so the frame does not
resize when the cursor moves between options or when a picture finishes loading.

Inside the block, from the top down: the **picture or the reason there is none**,
the **information** (the highlighted option's own sentence), the **question**,
then the **answers** - one line per choice, pinned to the bottom - and the
actions and key hints under them. `Ctrl+]` collapses the whole thing to one dim
line.

On a short screen the panel gives things up in a fixed order: the hints first,
then the highlighted sentence, then picture space - but never the picture itself
and never the choices. A review that carries an image never silently loses it.

## Notes

Every review carries notes, and all three paths are covered by tests
(`tests/tui.test.mjs`, "notes: a row, a key, a global"):

- **`Add note`** is a row in the option list — press it, type, `Enter`.
- **`n`** opens the same editor from any row, for a user who knows the key.
- **`Add global note`** on the review tab annotates the whole review.

A note never answers the stage it is attached to, and it rides the answer that
belongs to it. Both kinds reach the model in the returned envelope
(`user notes: …` per stage, `global note: …` for the review) — asserted against
`buildResponse`, not just the screen.

## The panel's invariants: what is actually measured

`npm run verify:panel` renders the real wizard across 384 configurations - four
terminal heights, three render widths, text and image layouts, both densities,
single- and multi-select, four to twenty options - and checks every frame,
walking each list down and back up rather than measuring it at rest:

| Check | What it rules out |
|---|---|
| `tail` | The key hints, the auto-resolve line, the density line and the closing rule, as one block in that order |
| `height` | The frame never outgrows the terminal, and with artwork the panel stays a fixed block rather than becoming the screen |
| `marker` | Exactly one row carries the cursor marker - none means the cursor is off screen, more than one means it is painted by position rather than by the cursor |
| `artwork` | An image configuration whose picture did not arrive whole - the fixture is untracked, and a matrix that reports clean while measuring frames with nothing to draw is worse than no matrix. The bar is a complete payload, not a loaded file: an unreadable file, a file that is not an image, and a PNG cut to 2000 of its 512,739 bytes each break the run, because `getImageDimensions` reads the header and a header survives almost any truncation |

The width is the width the frame is *rendered* at, not `terminal.columns`: the
panel never reads that, so varying it alone measures one frame three times and
the counts look like coverage. At 60 columns an eight-option text review is 40
rows and at 80 it is 32, so the dimension is real.

It is written to be run on two checkouts and diffed, which is how a round gets
compared against a baseline with the same harness. A clean line only means
something because each check has been shown to fail: removing the frame's
reservation for the tail reports 4,422 configurations broken, rebuilding the
footer band from the array it had just emptied reports 3,178, and making the
scroll stop following the cursor reports 1,154.

## The regression shield: seven items, one command

`npm run verify:shield` runs the seven gates that have guarded this project and
reports a single verdict, naming the one that failed. It exists because every
round of work used to end by pasting the same seven commands into a completion
claim — a habit, not a gate. Nothing ran them, nothing failed when one was
skipped, and a claim could quietly drop one and still read as a clean sweep.

| # | Item | Command | What it rules out |
|---|---|---|---|
| 1 | `check` | `npm run check` | A type error or a broken hermetic smoke |
| 2 | `panel` | `npm run verify:panel` | Losing the footer tail, the panel's fixed height, the cursor marker, or the artwork |
| 3 | `unit` | `npm test` | Any behaviour the suite pins |
| 4 | `image` | `node scripts/benchmark/verify-image-protocol.mjs` | An image that gets to the terminal as bytes but not as a picture |
| 5 | `live` | `npm run smoke:live -- --image .pi/benchmark/images/visual-001-option-1.png` | A review that only works outside a real terminal |
| 6 | `hygiene` | `git diff --check` + the banned-token grep | Whitespace damage, and "fixes" that change how the terminal draws rather than what the panel renders |
| 7 | `state` | `generations.json` and the host's package list | Work that moved the generation account or the activation without saying so |

Each item runs as its own process with its own deadline, cheapest-and-most-likely-
to-fail first. `--only=<item>` runs one and prints that the verdict is **partial**,
because a shield that can be narrowed to the part that happens to be green is not
one.

What it does not cover: anything about a *review's content* — whether the
questions are any good, whether the treatments look alike — because that is the
judge's job (`npm run benchmark:judge`), and it is not automatable. A green
shield means the panel behaves, not that the panel is worth reading.

## Images: what is actually verified

`npm run verify:image` renders the real wizard frame and parses the image escapes
back out, reassembling each payload and comparing it to the source file byte for
byte. It is deliberately separate from the live smoke, which can only prove that
bytes were *written*:

| Protocol | Status |
|---|---|
| Kitty APC (`kitty`, Ghostty, WezTerm, Warp) | complete PNG, `a=T` transmit+display, cell box, quiet — payload byte-identical. A 527 KB image arrives as **172 chunks** that reassemble to 527,315 bytes, byte for byte |
| iTerm2 OSC 1337 | encoded by this package, full payload, BEL-terminated — pi-tui's own encoder emitted **62 bytes of 527,315** and no terminator, so this path was broken and now is not |
| tmux passthrough | the same payload, one escape per image, inside `DCS tmux; … ST` — the chunks are collapsed because the envelope ends at the first ST inside it |

A run from a shell **with no `TMUX` in the environment** (the case that matters:
it is the raw chunked path a terminal outside tmux receives):

```json
{"kitty":{"escapes":1,"chunks":172,"controlCommands":0,"payloadBytes":[527315],
          "identical":true,"multichunk":{"chunks":172,"payloadBytes":527315}},
 "iterm2":{"escapes":1,"payloadBytes":[527315],"identical":true},
 "tmux":{"escapes":1,"wrapped":1,"payloadBytes":[527315],"identical":true},
 "ok":true,"failures":[]}
```

The chunk boundary is worth its own note, because getting it wrong makes a
working package look broken: a parser that starts a new image on the final
chunk reports one 527 KB picture as 525,312 + 2,003 bytes. `parseKitty` in
`scripts/benchmark/image-protocol.mjs` merges until the transmission ends, keeps
payload-free control commands (`a=d,d=I,i=…`) out of the image list, and
`tests/tui.test.mjs` pins both behaviours against the 71 KB fixture.

What no automated check can answer is whether *your* terminal draws it. To see a
real image, from a shell **outside tmux**:

```sh
npm run shot:review -- --emit --hold 60 \
  --images .pi/benchmark/images/visual-001-option-{1,2,3}.png --option 1
```

**tmux 3.6a cannot carry inline images, and that was measured, not guessed.**
With a hand-made sequence and a client recording exactly what tmux sent it:

- the raw Kitty escape arrives at the terminal with the introducer's `ESC`
  stripped - `_Ga=T,f=100,...` with no escape in front of it;
- the passthrough envelope (`DCS tmux; … ST`) is not forwarded at all.

So the payload can be perfect and the picture still cannot appear, which no
check on our own bytes would ever catch - the check and the screen disagree for
a reason outside the process. This package therefore does **not** try to smuggle
graphics through a multiplexer: a review inside tmux says so, names what it
detected, and tells you to run Pi outside it.

```sh
env -u TMUX pi        # the configuration that shows images
```

The iTerm2 path is the one fix that survived the measurement: closing the
`OSC 1337` sequence that pi-tui leaves open. That is a plain OSC string, which
is the part of the protocol a multiplexer *does* pass.

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
# Both arms are judged on the same cases; which one the release gate reads is
# recorded in the report's `sources` and reused by later runs.
npm run benchmark:judge -- --images .pi/benchmark/composed-manifest.json --limit 200 --out .pi/benchmark/judge.json
npm run benchmark:judge -- --images .pi/benchmark/image-manifest.json --limit 200 --out .pi/benchmark/judge-raw-image.json
npm run benchmark:images:report -- --out .pi/benchmark/image-report.json

# Real-TTY live gate (self-provisioning pseudo-terminal; five sessions)
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
  reported separately and never charged to the reference. Envelope *text* differs
  on 53 of 333 shared cases, and every one of them is now recorded by name -
  case id, classification, reason and both texts - rather than counted: all 53
  are `adapter-wording` (52 of them a block one envelope discloses and the other
  does not), none is a `capability` difference, and only the latter is a gate.
- **The live gate proves the decisions, not just the happy path.** `smoke:live`
  runs five sessions, one per review, each on its own pseudo-terminal: the happy
  path (inline image, keyboard, stage advance, Ctrl+] collapse/reopen, custom
  answer, external editor, final review) plus note, revision, reject and cancel.
  The revision session requests a change and then drives the round that change
  asked for, so a revision is proven as a round rather than as a request. A
  session that did not run fails the gate instead of being left out.
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

`@earendil-works/pi-tui` is pinned to `^0.99.1`, the range
`@earendil-works/pi-coding-agent` declares for it, and that pin is load-bearing.
The host hands the extension a `TUI` built from *its* copy, and the panel
constructs components from *this* package's copy; when the two resolve to
different versions the only symptom is a type error in `tsc` at the point where
the host's object is passed to the panel's constructor, with no runtime error at
all. A wildcard range, or a `node_modules` entry hand-linked to an older global
install, reproduces it exactly. Install it; do not link it.

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
