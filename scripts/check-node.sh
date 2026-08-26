#!/usr/bin/env bash
# Fail loudly on a Node older than the engines field, rather than mysteriously.
#
# Shell rather than TypeScript on purpose: the Node this exists to catch cannot run a .ts
# file, so a TypeScript guard dies with ERR_UNKNOWN_FILE_EXTENSION and says nothing useful.
set -euo pipefail
# 22.18 is the floor, not 22. Comparing majors only meant every Node 22.0-22.17 passed
# this guard silently and then died with ERR_UNKNOWN_FILE_EXTENSION — the exact error the
# header above says this script exists to convert into something readable.
REQUIRED=22.18
CURRENT="$(node -p 'process.versions.node.split(".").slice(0,2).join(".")')"
LOWEST="$(printf '%s\n%s\n' "$CURRENT" "$REQUIRED" | sort -V | head -1)"
if [ "$LOWEST" != "$REQUIRED" ] && [ "$CURRENT" != "$REQUIRED" ]; then
  cat >&2 <<MSG

  Node $(node -v) is on PATH and this repository needs >= ${REQUIRED}.

    nvm use            # honours .nvmrc
    nvm install 22     # if you do not have it

  Node 22.18+ strips TypeScript types without a flag, which is how the server
  and the integration tests run .ts directly.

MSG
  exit 1
fi
