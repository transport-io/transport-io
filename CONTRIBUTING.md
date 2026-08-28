# Contributing

Thank you for looking. This file is short and specific, because the setup here is not the
usual one and finding that out by trial is a waste of your evening.

## What you need before anything works

| | why |
|---|---|
| **Node 22.18 or newer** | 22.18 strips TypeScript types without a flag, which is how the server and the integration tests run `.ts` files directly. `./scripts/check-node.sh` refuses anything older and says so. |
| **[Bun](https://bun.sh)** | Runs the unit tests, the documentation gates and the example build. `npm install` succeeds without it and then your first `git commit` fails, because the hooks shell out to it. |
| **`openssl` on `PATH`** | Mints the short lived certificate the browser needs. WebTransport will not accept an arbitrary self signed certificate, so the example generates one pinned by hash. |
| **macOS or Linux** | Windows is not supported for *development*: the scripts are POSIX shell, `gates.sh` and `check-ts-floor.sh` among them. Use WSL. Running the library on Windows is a separate question and is not blocked. |

The native QUIC transport is a **separate, deliberate install** and is only needed if you
are working on the transport itself or running the end to end suite:

```bash
npm install @fails-components/webtransport-transport-http3-quiche
```

Its prebuilt binaries come from GitHub Releases rather than npm, and the Linux prebuild
needs glibc 2.38. No default Node `-slim` image has it. Use a `trixie` variant or Ubuntu
24.04. There is no musl build, so Alpine falls back to a source compile.

## Getting set up

```bash
git clone https://github.com/transport-io/transport-io
cd transport-io && npm install && npm run build
```

`npm install` runs `lefthook install`, which is what puts the git hooks in place.

## Running things

```bash
npm run typecheck     # tsc, library and tests
npm run lint          # biome
npm run test:unit     # bun, never loads the native transport
npm run test:node     # node, loads the native transport
npm run e2e           # playwright, real Chromium over real QUIC
```

The last one starts its own server and mints its own certificate. If port 8080 is taken,
set `E2E_PORT`.

Two soaks exist and are run by hand rather than in CI, because they take an hour:

```bash
npm run soak:lanes    # emit and unreliable lanes, 500 sessions, 60 minutes
npm run soak:churn    # connect and disconnect, measures what a dead session leaves behind
```

## The runtime split, which will surprise you

Anything that loads the QUIC transport runs on **Node**. Everything else runs on **Bun**.
This is not a preference. The native addon segfaults Bun on exit, measured 3 out of 3 runs,
and a segfault *after* a test reporter has printed its summary looks exactly like a pass.

A module that loads the transport is named `*.node.ts` or `*.node.test.ts`. A module that is
not named that way may not import one, by package name or by relative path.
`scripts/check-boundaries.ts` enforces it.

## Gates

Every gate must be able to fail. Several here were found reporting success while examining
nothing, because an aggregate over an empty collection is inside every bound. If you add a
check that reduces a collection to a verdict, give it a minimum size and make it fail when
it finds nothing.

Two gates are unusual and worth knowing about:

- **`scripts/check-norms.ts`** requires every normative statement in `PROTOCOL.md` and
  `API.md` to carry an identifier naming a test file, and that file must mention the
  identifier back. Writing a `MUST` costs either a test or an explicit, counted admission
  that there is none. This exists because four normative promises once lived in three
  documents and no code.
- **`scripts/check-docs.ts`** compiles every TypeScript block in the documentation against
  the built package. If you change the API, the docs stop compiling.

## Commits

Conventional Commits. The scope is required and derived from the workspaces at commit time,
plus four that describe a kind of change rather than a package: `chat`, `ci`, `core`, `deps`,
`docs`, `repo`, `site`. Adding a workspace adds its scope with no second list to update,
which is why `commitlint.config.ts` derives them rather than listing them.

**Subject only, never a body.** commitlint enforces an empty body and an empty footer, and
the merge settings discard the body anyway. Breaking changes use the `!` marker, because a
`BREAKING CHANGE:` footer would require a body. Rationale belongs in the changeset, in an
ADR, or in `DECISIONS.md`, which are read. Commit bodies are not.

One logical change per commit. If the subject needs the word "and", it is two commits. Every
commit passes typecheck, lint and unit tests on its own, because bisect is the payoff for
small commits and it only works if each one is green.

## Tests

Every fix lands with a test that fails without it.

Two rules, both of which cost real defects here:

1. **A test that checks the initiator of a two sided interaction is not a test of the
   interaction.** Caller and responder, startup and shutdown, one process and two. Assert
   both sides or you have asserted neither.
2. **Assert what the test name says.** If the name states a guarantee, the body has to check
   that guarantee rather than something cheaper to reach nearby.

## Documentation

Documentation updates ship in the same commit as the change, not in a follow up. A pre
commit hook refuses a source change with no documentation change. If none is needed, re run
with `DOCS_ACK=1` to record that judgement.

Every external constant in a document is computed or fetched in the same change that writes
it, and the command that produced it goes next to it. A hash, a version, a size limit: if it
cannot be produced by a command, it does not go in the document.

Dependencies are added with the package manager, never by hand editing `package.json`.

## Changesets

A change to `packages/*/src` needs a changeset:

```bash
npx changeset
```

Tooling and CI changes take an empty one: `npx changeset --empty`.

## Decisions

`DECISIONS.md` is the ledger. Every question this project has raised is answered there,
numbered D1 onward, including the answers that turned out to be wrong and what changed them.
If you are about to make a decision that a future contributor would want to reverse, write
it down there or as an ADR.

There is no `OPEN-QUESTIONS.md` and there never will be. It is where a design flaw goes to
be forgotten.

## Reporting a bug

Include the Node version, the platform, whether the native transport is installed, and a
reproduction. If it involves the transport, say which browser: Chrome and Firefox are
supported, Safari cannot talk to a quiche backed server and is not.

Known limitations have their own page, [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md). Please check
there first: some of what looks like a bug is deliberate, and that page says which.
