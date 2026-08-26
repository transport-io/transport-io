#!/usr/bin/env bash
# Fail loudly on a Node older than the engines field, rather than mysteriously.
#
# Shell rather than TypeScript on purpose: the Node this exists to catch cannot run a .ts
# file, so a TypeScript guard dies with ERR_UNKNOWN_FILE_EXTENSION and says nothing useful.
set -euo pipefail
REQUIRED=22
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt "$REQUIRED" ]; then
  cat >&2 <<MSG

  Node $(node -v) is on PATH and this repository needs >= ${REQUIRED}.

    nvm use            # honours .nvmrc
    nvm install ${REQUIRED}     # if you do not have it

  Node 22.18+ strips TypeScript types without a flag, which is how the server
  and the integration tests run .ts directly.

MSG
  exit 1
fi
