# Repository scripts

## `protect-branch.sh` - the branch protection, as one command

Branch protection cannot be expressed in a workflow file, so until it is applied the
pairing rule in D61 (no hook may be the only place a check exists) is asserted but not
enforced. This script closes that window.

It is already applied to `transport-io/transport-io`. Re-run it whenever a job name in
`ci.yml` changes: a required check is matched by name, so a renamed job silently stops
gating the merge button.

```bash
./scripts/protect-branch.sh              # the current repository
./scripts/protect-branch.sh owner/repo   # or a fork
gh api repos/transport-io/transport-io/branches/main/protection \
  --jq '.required_status_checks.contexts'   # what is actually applied
```

It sets the eight required status checks, requires linear history, blocks force-pushes and
deletions, and configures squash-merge-only with **`squash_merge_commit_message=BLANK`** -
that last flag is the one people miss. GitHub otherwise puts the PR description into the
commit body, which would break the subject-only rule (D29) on the only commit that survives
a squash.

Re-running is safe.

## `check-docs.ts` - the documentation gates

Compiles every ` ```ts ` block in API.md, README.md and AGENTS.md, and compares every normative
constant and error code in PROTOCOL.md against `packages/core/src/protocol.ts`. Blocks
tagged ` ```ts ignore ` are counted against a ceiling that may only go down.

## `check-workflows.ts` - no outsider-controlled text reaches a shell

Fails on any `${{ ... }}` inside a `run:` block and on any workflow without a top-level
`permissions:` block. `${{ }}` is substituted into the script *text*, so a pull request
title - written by whoever opens the PR - is arbitrary code on the runner unless it is
bound through `env:` and read as `"$NAME"`. See D74; the repository shipped exactly that
defect. Line-based, no YAML dependency.

## Publishing

Publishing is a human running a command on their own machine. Nothing in
`.github/workflows/` publishes: there is no publish job, no `NPM_TOKEN`, no
`changesets/action` and no `registry-url`. That is deliberate.

| check | state |
|---|---|
| `transport-io` on npm | published, latest `0.4.0` |
| root `package.json` | `private: true` (never publishes) |
| `examples/chat` | `private: true` |
| `packages/core` | not private - the one package that publishes |
| tarball | `dist` (minus `bench`), `LICENSE`, `README.md` |
| CI | publishes nothing |

The sequence:

```bash
npx changeset                # describe the change
npx changeset version        # consumes them: bumps the version and writes the changelog
npm run preflight            # gate inputs, install lines, attw, publint, the TS floor
npm -w packages/core publish # deliberate, from your machine
```

`VERSION` in `packages/core/src/index.ts` must match the manifest after a version bump. A
unit test enforces it.

Both READMEs say `npm install transport-io`. `check-install-line.ts` runs that command on
every preflight and checks what lands.

## `check-ts-floor.sh` - the published types, at the version we claim

Packs the tarball, installs it into a temporary directory with `typescript@5.0.4`, and type
checks a consumer probe against it under both `bundler` and `node16` resolution, with
`types: []` and no `--skipLibCheck`. A negative probe asserts that a wrong event name is
still rejected, so the gate fails if the checking stops happening.

The isolation is the whole design. This check has been wrong twice: once with
`--skipLibCheck`, which skips the file named on the command line and so could never fail,
and once without it but running in the repository root, where it type checked the entire dev
tree's ambient declarations under a five-year-old compiler and turned main red for three
commits. See D91.

## `check-gate-inputs.ts` - the gates we do not own must have something to look at

`knip` reports no dead code when it finds no code, and `attw` reports no problems for an
empty `dist`. Both are truthful answers to "look at nothing" and both exit 0. This asserts
every knip workspace exists and holds source, and every `exports` target is present in the
packed tarball. See D87.

## `check-install-line.ts` - run the install command, do not reason about it

Executes every `npm install` line the READMEs give a reader, in a temporary directory, and
checks that what lands is the library. The line has been wrong twice - once naming an
unpublished package, once naming a git URL that resolves to the private monorepo root - and
the second was written in the commit fixing the first. Part of `npm run preflight`.

## `check-norms.ts` - normative prose names the test that proves it

Every `MUST` in `PROTOCOL.md` and every bold guarantee in `API.md` carries an identifier
naming a test file, and that file must mention the identifier back. Checked from both ends,
so a marker cannot name an unrelated file.

Deliberately shallow: it does not verify the test is any good. It makes an unimplemented
promise impossible to write down *silently*, which is the failure that recurred five times
in one day. `-> UNPROVEN: <reason>` records an honest gap and is counted against a ceiling
that may only go down. See D82.

## `check-boundaries.ts` - D14's runtime split

Fails if a module that is not `*.node.ts` reaches the transport, by package name **or by a
relative import**. The Biome rule it replaces matched three package specifiers, so
`from './transport/fails.node.ts'` inside a plain `*.test.ts` passed cleanly - measured, 0
diagnostics.

## `run-node-tests.sh` - the integration job must actually run something

Asserts the reported test count. `node --test` exits 0 when its glob matches nothing, and CI
wrapped it in `--if-present`, which exits 0 when the script is missing: two ways for the only
required check that loads the native transport to be green while testing nothing.

## `check-node.test.sh` - the version guard, against stub versions

The guard compares `major.minor`. It used to compare majors while its own error text named
22.18, so every Node 22.0–22.17 passed and then died with the exact error it exists to
convert. Tested with stub `node` binaries, because the versions under test cannot run a
TypeScript test.

## `soak-churn.node.ts` - what a dead session leaves behind

`npm run soak:churn`. Connects and disconnects over the in-memory loopback transport and
fits a line through heap-after-GC, bounded at 2048 bytes retained per session churned.

It exists because `soak.node.ts` opens 500 sessions and closes none, so every
per-disconnect defect is invisible to it - three were found by inspection while it was
green. Warmup is in **seconds**, not cycles, because `ORIGIN_QUARANTINE_MS` is 120 s and a
shorter run measures deliberate quarantine retention as though it were a leak. See D76.

## `docs-freshness.ts` - source changed without documentation

Run by the pre-commit hook against staged files and by CI against the PR diff. Set
`DOCS_ACK=1` to record a judgement that no document needed updating.
