# Benchmark JSON schemas

All schemas are versioned with top-level `schemaVersion: 1`. Paths and generated images are local; credentials and credential-shaped fields are forbidden.

Every gate in this benchmark is recomputed from the artifacts on disk. A summary
field is never trusted as evidence: `scripts/benchmark/report.mjs` rebuilds the
numbers from the per-case results, the image manifest, the judged visual report,
the live TTY smoke record, and the defect ledger.

## Corpus (`benchmark-corpus`)

- `seed`: non-negative 32-bit integer.
- `count`: positive safe integer; default 1000.
- `strata`: exact counts for `ordinary`, `visual`, and `adversarial`.
- `scenarios[]`: `id`, `stratum`, `classification`, `comparisonScope`, `inputValid`, `canonicalInput`, `expected`, `terminalConstraints`, `visualPrompt`, and `provenance`.
- `canonicalInput`: the staged `stages` or legacy `questions` review shape.
  - **Valid scenarios** (`inputValid !== false`) must normalize: reserved option labels, duplicate IDs, bad shapes, and missing fields fail validation.
  - **Negative scenarios** (`inputValid: false`) exist to probe a rejection. Shape and reserved-label rules are skipped for them, and the comparison run must observe a real rejection *before any UI interaction*. They are always `local-only`.
  - Canonical inputs must be unique across the corpus; a duplicate fails validation.
- `expected`: the oracle.
  - `outcome`: one of `completed`, `rejected`, `cancelled`, `revision`, `fallback`, `invalid`.
  - `oracle`: `exact` (recorded answers are asserted) or `terminal-only` (the source recorded no answer action, so only the terminal status and an explicit approval are asserted). The aggregate report counts both.
  - `classification`: free-form provenance label.
  - `answers`: `option`, `multi`, `custom`, `cancel`, `skip`, `revision`, or `reject` intent. Multi answers are compared as sets.
  - `revision`: required when `outcome` is `revision` — `stageId`, `feedback`, and `requestedRound`. The comparison asserts the returned payload, not just the status.
- `terminalConstraints`: `requiresRealTTY`, `requiresConfiguredEditor`, `maxStages` (1–6), and `explicitApproval`.
- `visualPrompt`: `required`, nullable `prompt`, and `comparisonRubric`; every visual scenario requires a prompt.
- `provenance` (optional): source shard, source outcome, and any reconciliation note, so an imported corpus stays auditable.

`node scripts/benchmark/corpus.mjs --import <file>` re-validates an externally
assembled corpus (for example the Space Bunny Alpha shards) through the same gate
before it is used.

## Comparison (`benchmark-comparison`)

- `passes`: `{ requested, executedPerCase, independentPassesExecuted }`. `--passes N` really executes the corpus N times; a case only passes when every pass produced the same answer **and** matched the oracle. `summary.unstableCases` lists any disagreement.
- `images`: how many generated images were bound to cases.
- `reference`: the isolated RPiV adapter identity, `sharedCases`, `referenceRejections`, the informational `envelopeMatchRate`, and two separate lists:
  - `losses`: cases where **RPiV** missed the shared contract.
  - `candidateFailures`: cases where the local package missed its own oracle.
  A candidate failure is never charged to the reference.
- `summary`: total/passed/failed, deterministic accuracy, Wilson 95% lower bound, `exactOracle`/`terminalOnly` split, shared/local-only totals, and per-stratum accuracy.
- `cases[]`: scenario id, stratum, scope, classification, oracle kind, passes executed, stability, pass/reason, scoring method, validation message, and seeded blind labels when `--blind` is set.

Shared scope is limited to what RPiV actually implements: a legacy `questions`
review that completes or declines. Staged reviews, image options, revision
rounds, and the no-UI fallback are scored against the local absolute oracle only
and can never be reported as an RPiV loss.

## Image manifest (`benchmark-image-manifest`)

- `images[]`: `id`/`optionIds` (`<scenario>:<optionKey>`), `scenarioId`, `prompt`, SHA-256 `hash`, local `path`, `provider` (`agnes`), `model`, `mimeType`, `byteCount`, `width`, and `height`.
- `failures[]`: `{ optionId, scenarioId, code, message, at }` for every failed generation. Quota, connection, and upstream failures are recorded and **never retried silently**.
- Duplicate prompt hashes are cache hits only when their local path is identical. Every file is read and checked against its signature, dimensions, and byte count.
- The whole benchmark is capped at 600 successful generations; `generate-images.mjs` records a `generation_limit` failure instead of exceeding it.

## Image report (`benchmark-image-report`)

- Ingestion counts: `requestedLimit`, `generated`, `cached`, and `severeFailures`.
- `generated` is `0` for a manifest with no images — an unrun generation is never reported as a pass.
- `decisionUtility` stays `null` without judge results; it is never fabricated.

## Visual judging (`benchmark-visual-judging`)

- `model`: the judge model actually used.
- `blinded: true` and `tieIsNotCredit: true`.
- `summary`: `judgedCases`, `candidateWins`, `ties`, `undecided`, `candidateWinRate`, `wilson95LowerBound`, and `severeImageFailureRate`.
- Two independent passes run per case. A candidate win is credited only when both passes agree on the candidate; a disagreement is `undecided` and is reported separately.
- `skipped` lists visual scenarios that could not be judged (for example, fewer than two generated images bound to the case).

## Live smoke (`benchmark-live-smoke`)

- `status`, `observedAt`, `details`, `preconditions`, `assertions`, `steps`, and `pty`.
- Produced by running the real extension through Pi's own loader on a real pi-tui
  screen inside a pseudo-terminal, with real raw keypresses and Pi's configured
  external editor. `preconditions` fails without a TTY, without a readable
  generated image, or without a configured editor; `pty.usedPseudoTerminal` must
  be true for a pass.

## Aggregate report (`benchmark-aggregate-report`)

Rebuilt from artifacts, with every number recomputed:

- `corpus`: count 1000, strata `700/200/100`, seed, and provenance.
- `comparison`: recomputed accuracy, Wilson lower bound, oracle split, per-stratum accuracy, unstable cases, and the failing cases themselves.
- `images`: generated/cached/failed counts, `withinBudget`, judged cases, `visualUplift`, `visualUpliftLowerBound`, `severeFailureRate`, ties, and undecided.
- `gates`: `accuracy`, `confidenceBound`, `stability`, `visualUplift`, `visualConfidence`, `severeFailures`, `imageBudget`, `liveSmoke`, `noUnresolvedCriticalDefects`.
- `releaseReady`: true only when every gate is true.
- `liveSmoke` and `activation` evidence.

Gate thresholds: 100% deterministic accuracy, Wilson 95% lower bound ≥ 0.95,
zero unstable cases, ≥ 200 judged visual cases with ≥ 60% candidate wins and a
lower bound above 50%, severe image failure rate ≤ 2%, at most 600 images, a
passed live TTY smoke, and no unresolved P0/P1.

The verifier never infers or performs activation. An activation claim only
verifies when the recomputed `releaseReady` is true.

## Defect ledger

Defect entries minimally contain `id`, `severity` (`P0`, `P1`, `P2`, or `P3`), `status` (`open`, `mitigated`, or `resolved`), summary/evidence, owner, and timestamps. Any P0/P1 not marked `resolved` blocks the aggregate report.
