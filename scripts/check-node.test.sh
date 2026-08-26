#!/usr/bin/env bash
# The guard must fail on the versions it names. Runs the real script against stub `node`
# binaries, because the versions being tested cannot run the test suite that would test it.
set -uo pipefail
cd "$(dirname "$0")/.."
pass=0; fail=0
probe() { # version, expected exit
  local dir; dir="$(mktemp -d)"
  printf '#!/bin/sh\nif [ "$1" = "-p" ]; then\n  echo "%s" | awk -F. -v e="$2" "{print}" >/dev/null\nfi\ncase "$*" in\n  *"slice(0,2)"*) echo "%s" ;;\n  *"[0]"*) echo "%s" ;;\n  -v) echo "v%s" ;;\n  *) echo "v%s" ;;\nesac\n' \
    "$1" "$(echo "$1" | cut -d. -f1,2)" "$(echo "$1" | cut -d. -f1)" "$1" "$1" > "$dir/node"
  chmod +x "$dir/node"
  PATH="$dir:$PATH" ./scripts/check-node.sh >/dev/null 2>&1
  local got=$?
  if [ "$got" = "$2" ]; then pass=$((pass+1)); echo "  ok    node $1 -> exit $got"
  else fail=$((fail+1)); echo "  FAIL  node $1 -> exit $got, expected $2"; fi
  rm -rf "$dir"
}
probe 20.19.0 1
probe 22.11.0 1   # the one that used to pass silently and then die on a .ts file
probe 22.17.9 1
probe 22.18.0 0
probe 24.5.0  0
echo "  ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
