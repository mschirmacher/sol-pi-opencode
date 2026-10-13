#!/usr/bin/env bash
# P6d long-session A/B matrix driver: 3 arms x 3 tasks x 2 repeats = 18 runs,
# strictly sequential (proxy is sequential), resumable (skips existing result JSONs).
set -u
cd "$(dirname "$0")/../.." || exit 1
RESULTS=docs/plan/ab-results-long
for arm in off on op-only; do
  for task in L1 L2 L3; do
    for run in 1 2; do
      f="$RESULTS/$arm-$task-r$run.json"
      if [ -f "$f" ]; then
        echo "[matrix] SKIP $arm-$task-r$run (result exists) $(date -Is)"
        continue
      fi
      echo "[matrix] START $arm-$task-r$run $(date -Is)"
      node scripts/ab/run-arm.mjs --arm "$arm" --task "$task" --tasks-dir tasks-long --run "$run"
      echo "[matrix] END $arm-$task-r$run rc=$? $(date -Is)"
    done
  done
done
echo "[matrix] ALL-DONE $(date -Is)"
