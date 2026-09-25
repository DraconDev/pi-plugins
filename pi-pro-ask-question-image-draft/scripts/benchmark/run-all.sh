#!/usr/bin/env bash
# The whole release gate, in order, exactly as the contract states it.
#
# Every step is independently runnable and re-runnable; the expensive ones are
# cached (images by prompt hash, judging by nothing - it always re-judges), so a
# second run costs no provider calls. Read this file to know what `npm run
# benchmark:run` actually does.
set -euo pipefail

cd "$(dirname "$0")/.."
SEED="${SEED:-20260925}"
COUNT="${COUNT:-1000}"

echo "==> 1/8 corpus (durable Space Bunny Alpha, reproduced from benchmark/corpus/)"
npm run --silent benchmark:corpus -- --count "$COUNT" --seed "$SEED" --out .pi/benchmark/corpus.json

echo "==> 2/8 images (at most 600 Agnes generations, cached by prompt hash)"
npm run --silent benchmark:images -- --max 600 --concurrency "${CONCURRENCY:-6}" --quiet

echo "==> 3/8 deterministic comparison (2 passes x 1,000 cases, RPiV on the shared cases)"
npm run --silent benchmark:compare -- --blind --passes 2 --out .pi/benchmark/results.json

echo "==> 4/8 blinded visual judging (2 independent passes + adjudication)"
npm run --silent benchmark:judge -- --limit 200 --concurrency "${JUDGE_CONCURRENCY:-6}" --out .pi/benchmark/judge.json

echo "==> 5/8 image decision-utility report"
npm run --silent benchmark:images:report -- --out .pi/benchmark/image-report.json

echo "==> 6/8 live real-TTY smoke (self-provisioning pseudo-terminal)"
npm run --silent smoke:live -- --image .pi/benchmark/images/visual-001-option-1.png

echo "==> 7/8 defect ledger (generated from the run, every claim checked)"
npm run --silent benchmark:ledger

echo "==> 8/8 aggregate report + release gate"
npm run --silent benchmark:report -- --out .pi/benchmark/report.json

# Publishing mirrors the evidence into the tracked repository; verification is
# deliberately NOT part of the release gate: it fails whenever the report is not
# ready, and a not-ready report is a legitimate, informative result.
npm run --silent benchmark:publish

echo
echo "== release gate =="
if npm run --silent benchmark:report -- --verify .pi/benchmark/report.json; then
  echo "releaseReady: true - every gate passed. The package may now be activated."
else
  echo "releaseReady: false - the gate above lists the unmet gates. The package stays inactive."
fi
