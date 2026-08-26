# Repository scripts

## `protect-branch.sh` — run this immediately after creating the remote

Branch protection cannot be expressed in a workflow file, so until it is applied the
pairing rule in D61 (no hook may be the only place a check exists) is asserted but not
enforced. This script closes that window in one command.

```bash
gh repo create <your-account>/transport-io --private --source=. --push
./scripts/protect-branch.sh
```

It sets the eight required status checks, requires linear history, blocks force-pushes and
deletions, and configures squash-merge-only with **`squash_merge_commit_message=BLANK`** —
that last flag is the one people miss. GitHub otherwise puts the PR description into the
commit body, which would break the subject-only rule (D29) on the only commit that survives
a squash.

Re-running is safe.

## `check-docs.ts` — the documentation gates

Compiles every ` ```ts ` block in API.md and README.md, and compares every normative
constant and error code in PROTOCOL.md against `packages/core/src/protocol.ts`. Blocks
tagged ` ```ts ignore ` are counted against a ceiling that may only go down.

## `check-workflows.ts` — no outsider-controlled text reaches a shell

Fails on any `${{ ... }}` inside a `run:` block and on any workflow without a top-level
`permissions:` block. `${{ }}` is substituted into the script *text*, so a pull request
title — written by whoever opens the PR — is arbitrary code on the runner unless it is
bound through `env:` and read as `"$NAME"`. See D74; the repository shipped exactly that
defect. Line-based, no YAML dependency.

## `docs-freshness.ts` — source changed without documentation

Run by the pre-commit hook against staged files and by CI against the PR diff. Set
`DOCS_ACK=1` to record a judgement that no document needed updating.
