#!/usr/bin/env bash
# The integration job is the only required check that exercises the native QUIC transport,
# and it reported success on its own absence: `node --test` with a glob exits 0 when the
# glob matches nothing, and CI wrapped it in `--if-present`, which exits 0 when the script
# is missing too. Two independent ways to be green while testing nothing.
#
# So the count is asserted rather than assumed. `node --test` prints `# tests N`; anything
# other than a positive N here is a failure, whatever the exit code says.
set -uo pipefail
cd "$(dirname "$0")/.."
./scripts/check-node.sh

OUT="$(mktemp)"
node --test "packages/*/src/**/*.node.test.ts" 2>&1 | tee "$OUT"
STATUS=${PIPESTATUS[0]}

COUNT="$(grep -Eo '^# tests [0-9]+' "$OUT" | tail -1 | grep -Eo '[0-9]+' || echo 0)"
rm -f "$OUT"

if [ "$COUNT" -lt 1 ]; then
  echo "" >&2
  echo "  node --test matched no tests. The glob is wrong, or the files were renamed." >&2
  echo "  A green integration job that ran nothing is worse than a red one." >&2
  exit 1
fi
echo "  integration: ${COUNT} test(s) ran"
exit "$STATUS"
