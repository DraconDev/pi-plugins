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

echo "==> 1/9 corpus (durable Space Bunny Alpha, reproduced from benchmark/corpus/)"
npm run --silent benchmark:corpus -- --count "$COUNT" --seed "$SEED" --out .pi/benchmark/corpus.json

echo "==> 2/9 images (at most 600 Agnes generations, cached by prompt hash)"
npm run --silent benchmark:images -- --max 600 --concurrency "${CONCURRENCY:-6}" --quiet

echo "==> 3/9 deterministic comparison (2 passes x 1,000 cases, RPiV on the shared cases)"
npm run --silent benchmark:compare -- --blind --passes 2 --out .pi/benchmark/results.json

echo "==> 4/9 deterministic structures (the package's own cell-grid renderer, no provider)"
npm run --silent benchmark:mockups

echo "==> 5/9 composed previews (the shipped path: structure with the art inside it)"
npm run --silent benchmark:compose

echo "==> 6/9 blinded visual judging of the shipped preview (2 independent passes + adjudication)"
npm run --silent benchmark:judge -- --images .pi/benchmark/composed-manifest.json --limit 200 \
  --concurrency "${JUDGE_CONCURRENCY:-6}" --out .pi/benchmark/judge.json --render-dir .pi/benchmark/terminal-renders

echo "==> 7/9 blinded visual judging of the raw image (non-gating diagnostic: what the art alone is worth)"
npm run --silent benchmark:judge -- --images .pi/benchmark/image-manifest.json --limit 200 \
  --concurrency "${JUDGE_CONCURRENCY:-6}" --out .pi/benchmark/judge-raw-image.json --render-dir .pi/benchmark/terminal-renders-raw

echo "==> 8/9 image decision-utility report"
npm run --silent benchmark:images:report -- --out .pi/benchmark/image-report.json

echo "==> 9/9 defect ledger, live real-TTY smoke, aggregate report + release gate"
npm run --silent benchmark:report -- --out .pi/benchmark/report.json

# Publishing mirrors the evidence into the tracked repository; verification is
# deliberately NOT part of the release gate: it fails whenever the report is not
# ready, and a not-ready report is a legitimate, informative result.
npm run --silent smoke:live -- --image .pi/benchmark/images/visual-001-option-1.png

npm run --silent benchmark:ledger

npm run --silent benchmark:publish

echo
echo "== release gate =="
if npm run --silent benchmark:report -- --verify .pi/benchmark/report.json; then
  echo "releaseReady: true - every gate passed. The package may now be activated."
else
  echo "releaseReady: false - the gate above lists the unmet gates. The package stays inactive."
fi
