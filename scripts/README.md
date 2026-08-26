# Repository scripts

## `protect-branch.sh` — run this immediately after creating the remote

Branch protection cannot be expressed in a workflow file, so until it is applied the
pairing rule in D61 (no hook may be the only place a check exists) is asserted but not
enforced. This script closes that window in one command.

```bash
gh repo create v0id-user/transport-io --private --source=. --push
./scripts/protect-branch.sh
```

It sets the seven required status checks, requires linear history, blocks force-pushes and
deletions, and configures squash-merge-only with **`squash_merge_commit_message=BLANK`** —
that last flag is the one people miss. GitHub otherwise puts the PR description into the
commit body, which would break the subject-only rule (D29) on the only commit that survives
a squash.

Re-running is safe.

## `check-docs.ts` — the documentation gates

Compiles every ` ```ts ` block in API.md and README.md, and compares every normative
constant and error code in PROTOCOL.md against `packages/core/src/protocol.ts`. Blocks
tagged ` ```ts ignore ` are counted against a ceiling that may only go down.

## `docs-freshness.ts` — source changed without documentation

Run by the pre-commit hook against staged files and by CI against the PR diff. Set
`DOCS_ACK=1` to record a judgement that no document needed updating.
