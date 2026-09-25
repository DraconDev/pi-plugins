# Benchmark JSON schemas

All schemas are versioned with top-level `schemaVersion: 1`. Paths and generated images are local; credentials and credential-shaped fields are forbidden.

## Corpus (`benchmark-corpus`)

- `seed`: non-negative 32-bit integer.
- `count`: positive safe integer; default 1000.
- `strata`: exact generated/validated counts for `ordinary`, `visual`, and `adversarial`.
- `scenarios[]`: `id`, `stratum`, `classification`, `comparisonScope`, `canonicalInput`, `expected`, `terminalConstraints`, and `visualPrompt`.
- `canonicalInput`: the staged `stages` or legacy `questions` review shape. Reserved option labels, duplicate IDs, invalid shapes, missing fields, secrets, and count/stratum mismatches fail validation.
- `expected`: `outcome`, `classification`, and scripted expected answers. The answer may be option, multi, custom, cancel, skip, revision, or reject intent.
- `terminalConstraints`: `requiresRealTTY`, `requiresConfiguredEditor`, `maxStages` (1–6), and `explicitApproval`.
- `visualPrompt`: `required`, nullable `prompt`, and `comparisonRubric`; every visual scenario requires a prompt.

## Comparison (`benchmark-comparison`)

- `passes`: requested independent deterministic passes (1–5).
- `blind`: whether seeded per-case A/B labels are recorded.
- `reference`: isolated adapter identity and `sharedOnly: true`; local-only cases cannot be RPiV losses.
- `summary`: total/passed/failed, deterministic accuracy, Wilson 95% lower bound, shared/local-only totals, and stratum accuracy.
- `cases[]`: stable scenario ID, stratum, scope, classification, pass/reason, scoring method, and optional seeded blind label mapping.

## Image manifest (`benchmark-image-manifest`)

- `images[]`: `id`, `prompt`, SHA-256 `hash`, local `path`, `provider` (`agnes`), `model`, `mimeType`, `byteCount`, `width`, and `height`.
- Duplicate prompt hashes are cache hits only when their local path is identical. Every file is read and checked against its signature, dimensions, and byte count. At most 600 successful unique generations are accepted.

## Image report (`benchmark-image-report`)

- Ingestion counts: `requestedLimit`, `generated`, `cached`, and typed `severeFailures`.
- `images[]`: validated metadata without an absolute path.
- `decisionUtility`: optional supplied judge results summarized as mean text/image utility, uplift, and severe-failure counts. Missing judge data stays `null`; it is never fabricated.

## Aggregate report (`benchmark-aggregate-report`)

Required evidence:

- Corpus `count: 1000` and strata `700/200/100`.
- Comparison deterministic accuracy, Wilson lower bound, and passing accuracy/confidence gates.
- Defect ledger with no unresolved P0/P1.
- Image visual uplift, severe-failure rate, and both passing gates.
- `liveSmoke.status: passed` with timestamp/details from a real TTY/editor run.
- `activation.claimed: true`, `status: passed`, `afterGates: true`, and activation timestamp at or after `gatesVerifiedAt`.

The verifier only returns `activationClaim: "evidenced"`; it never infers or performs activation.

## Defect ledger

Defect entries minimally contain `id`, `severity` (`P0`, `P1`, `P2`, or `P3`), `status` (`open`, `mitigated`, or `resolved`), summary/evidence, owner, and timestamps. Any P0/P1 not marked `resolved` blocks the aggregate report.
