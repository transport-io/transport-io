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

## Publishing — a thing a human does, deliberately, from their own machine

Nothing in `.github/workflows/` publishes: there is no publish job, no `NPM_TOKEN`, no
`changesets/action`, no `registry-url`. That is the design, not an omission.

Preflight, all verified before the first release:

| check | state |
|---|---|
| `transport-io` on npm | **404 — unclaimed** |
| root `package.json` | `private: true` (never publishes) |
| `examples/chat` | `private: true` |
| `packages/core` | not private — the one package that publishes |
| tarball | `dist` (minus `bench`), `LICENSE`, `README.md` |
| CI | publishes nothing |

The sequence:

```bash
npx changeset version        # consumes the changesets; lands on 0.1.0 from 0.0.0
npm run verify:pack          # attw + publint + the consumer TypeScript floor
npm -w packages/core publish # deliberate, from your machine
```

**One thing must change in the same commit as the first publish.** README.md and
`packages/core/README.md` both say the package is not on npm and give a
`github:v0id-user/transport-io` install line. That is true until it is not. Swap both to
`npm install transport-io` when the name exists, and not before — an install line that
points at a name nobody owns is how a reader ends up installing a stranger's package on this
project's authority.

## `check-gate-inputs.ts` — the gates we do not own must have something to look at

`knip` reports no dead code when it finds no code, and `attw` reports no problems for an
empty `dist`. Both are truthful answers to "look at nothing" and both exit 0. This asserts
every knip workspace exists and holds source, and every `exports` target is present in the
packed tarball. See D87.

## `check-install-line.ts` — run the install command, do not reason about it

Executes every `npm install` line the READMEs give a reader, in a temporary directory, and
checks that what lands is the library. The line has been wrong twice — once naming an
unpublished package, once naming a git URL that resolves to the private monorepo root — and
the second was written in the commit fixing the first. Part of `npm run preflight`.

## `check-norms.ts` — normative prose names the test that proves it

Every `MUST` in `PROTOCOL.md` and every bold guarantee in `API.md` carries an identifier
naming a test file, and that file must mention the identifier back. Checked from both ends,
so a marker cannot name an unrelated file.

Deliberately shallow: it does not verify the test is any good. It makes an unimplemented
promise impossible to write down *silently*, which is the failure that recurred five times
in one day. `-> UNPROVEN: <reason>` records an honest gap and is counted against a ceiling
that may only go down. See D82.

## `check-boundaries.ts` — D14's runtime split

Fails if a module that is not `*.node.ts` reaches the transport, by package name **or by a
relative import**. The Biome rule it replaces matched three package specifiers, so
`from './transport/fails.node.ts'` inside a plain `*.test.ts` passed cleanly — measured, 0
diagnostics.

## `run-node-tests.sh` — the integration job must actually run something

Asserts the reported test count. `node --test` exits 0 when its glob matches nothing, and CI
wrapped it in `--if-present`, which exits 0 when the script is missing: two ways for the only
required check that loads the native transport to be green while testing nothing.

## `check-node.test.sh` — the version guard, against stub versions

The guard compares `major.minor`. It used to compare majors while its own error text named
22.18, so every Node 22.0–22.17 passed and then died with the exact error it exists to
convert. Tested with stub `node` binaries, because the versions under test cannot run a
TypeScript test.

## `soak-churn.node.ts` — what a dead session leaves behind

`npm run soak:churn`. Connects and disconnects over the in-memory loopback transport and
fits a line through heap-after-GC, bounded at 2048 bytes retained per session churned.

It exists because `soak.node.ts` opens 500 sessions and closes none, so every
per-disconnect defect is invisible to it — three were found by inspection while it was
green. Warmup is in **seconds**, not cycles, because `ORIGIN_QUARANTINE_MS` is 120 s and a
shorter run measures deliberate quarantine retention as though it were a leak. See D76.

## `docs-freshness.ts` — source changed without documentation

Run by the pre-commit hook against staged files and by CI against the PR diff. Set
`DOCS_ACK=1` to record a judgement that no document needed updating.
