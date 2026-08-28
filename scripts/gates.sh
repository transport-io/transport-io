#!/usr/bin/env bash
#
# Every gate, each one judged by its exit code.
#
# This exists because remembering did not work. Twice in one session a verification was
# assembled by hand as `npm run something | tail -1 && git commit`, and `tail` exits 0
# whatever the gate printed, so the commit went out over a failure printed one line above.
# D101 recorded the rule; the rule was broken again in the next commit. So the shape is a
# file now rather than something to reassemble correctly under time pressure.
#
# Nothing here pipes. Each gate runs, its status is captured, and the script exits non-zero
# if any of them failed. Output is one line per gate so a failure is visible without
# scrolling.
#
#   npm run gates              # the fast set, what you run before every commit
#   npm run gates -- --full    # adds the integration tests and the packaging checks
#
set -uo pipefail
cd "$(dirname "$0")/.."

FAST=(lint typecheck test:unit docs:check check:norms check:boundaries check:workflows
      deadcode check:gate-inputs)
FULL=(test:node check:hover verify:pack check:install)

GATES=("${FAST[@]}")
if [ "${1:-}" = "--full" ]; then GATES+=("${FULL[@]}"); fi

failed=0
for gate in "${GATES[@]}"; do
  start=$SECONDS
  if npm run --silent "$gate" >/tmp/gate-$$.log 2>&1; then
    printf '  %-20s ok    %ss\n' "$gate" "$((SECONDS - start))"
  else
    printf '  %-20s FAIL  %ss\n' "$gate" "$((SECONDS - start))"
    # The failing gate's output, indented, so the reason is here rather than in a rerun.
    sed 's/^/      /' /tmp/gate-$$.log | tail -25
    failed=1
  fi
  rm -f /tmp/gate-$$.log
done

if [ "$failed" -ne 0 ]; then
  echo ""
  echo "  at least one gate failed. Nothing is committable until this line says otherwise." >&2
  exit 1
fi
echo ""
echo "  all ${#GATES[@]} gates green"
