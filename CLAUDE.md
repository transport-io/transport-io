STAGE 0: UNPUBLISHED. Break anything. No backward compatibility.
No deprecation shims. Protocol is v0 and unstable.

# transport-io

A TypeScript library for real-time apps over WebTransport. Socket.IO's shape, on a
transport with multiple streams and datagrams, without Socket.IO's mistakes.

**Read this file at the start of every session.** If you are about to write a deprecation
path, a compatibility shim, a migration guide, or a version check against an older release
of this library, stop and check the stage above. There is no older release.

## Thesis

**Hide the mechanism, expose the guarantee.**

Framing, length prefixes, buffer accumulation and stream lifecycle are hidden. Nobody
should ever write framing code. Bounds are not hidden: the credit window is documented
because an application can reach it.

Reliability semantics are always visible. "This message may be dropped" is a property of
the app's data, not an implementation detail, and it belongs in the type system.

## Where the decisions live

`DECISIONS.md` is the ledger. Every question this project has raised is answered there,
numbered D1 onward. **There is no `OPEN-QUESTIONS.md` and there never will be** - it is
where a design flaw goes to be forgotten. Resolved does not mean certain: where something
cannot be known before implementation, the entry records a decided default plus the
specific observable trigger that would make us revisit it.

**Append to `DECISIONS.md` as decisions are approved, not at the end of a phase.** The
ledger survives a session ending; the conversation does not.

`ADR/` holds the records a future contributor would want to reverse. `PROTOCOL.md` is the
wire format, written to be implementable by someone writing a Go server with no access to
this source. `API.md` is the TypeScript surface. `AGENTS.md` is the whole API in one pass
for a coding agent.

## Fixed decisions, in brief

Full text in `DECISIONS.md`; this is the summary a fresh session needs so it cannot drift.

- **D1 lane-in-contract.** Events declare `reliable` or `unreliable` at contract-definition
  time. The lane is a property of the message type, never of the call site.
- **D2 streams-as-acks.** Each `call` opens its own bidirectional stream. No correlation
  IDs, no pending map. A stalled call cannot block another call.
- **D3 no-fallback.** WebTransport only. A WebSocket fallback would silently make the
  unreliable lane reliable and ordered - a lie about the user's data.
- **D4 new-session-on-reconnect.** Reconnect is a new session. Room membership does not
  survive it.
- **D5 adapter-boundary.** Frames cross as bytes. Every method async. `MemoryAdapter` is
  the default; core never references Redis.
- **D6 abort-via-stream-reset.** `AbortSignal` maps to a QUIC stream reset.
- **D7 multi-frame-response.** A call response is a sequence of frames terminated by
  stream close. `stream()` shipped on it in 0.2.0 with no protocol break, as D7 predicted.
- **D92 lanes name guarantees**, `reliable` and `unreliable`, never `stream` and `datagram`.
  The rename touched the wire: 0.1.0 and 0.2.0 peers refuse each other.
- **D93 streaming backpressure is ours, not the transport's.** A responder runs at most 32
  frames ahead of what its consumer has taken. `writer.ready` resolves unconditionally on the
  reference binding, so anything relying on it is buffering without a bound.
- **D10 the fallback is disabled server-side.** Construct only `Http3Server`. The
  dependency ships an HTTP/2 fallback that is on by default; we refuse it. The client
  check is defence in depth, because Chrome supports neither `requireUnreliable` nor
  `session.reliability`.
- **D14 runtime split.** Node runs anything loading the quiche transport. Bun runs
  everything else. Enforced by an import-boundary lint rule, not a convention.
- **D32 emit is one stream per direction**, and its head-of-line blocking is cross-room.
- **D33 the handshake is frame 0 of the emit stream**, which removes the early-traffic
  race by construction.

## Environment facts that bite

Verified on this machine, not relayed from documentation. Full detail in `DECISIONS.md`
Part 2.

- The native transport is a **separate manual install**
  (`@fails-components/webtransport-transport-http3-quiche`). It is not a dependency of the
  main package, only a dynamic import, so npm will never pull it in.
- Prebuilt binaries come from **GitHub Releases, not npm**. Pin the version exactly and
  cache the download in CI.
- The linux prebuild needs **glibc 2.38**. `node:24-slim`, `node:22-slim` and
  `node:lts-slim` are byte-identical to their bookworm variants (glibc 2.36) and will not
  load it. Use `node:22-trixie-slim` or `node:24-trixie-slim`. Alpine has no prebuild at
  all.
- **Oversized and blocked datagrams are silently swallowed** by the transport. We own both
  size checking and backpressure accounting.
- **`WebTransportError` has no `streamErrorCode`.** The reset code is recoverable only by
  parsing the message string, and that parsing lives in exactly one function.
- **Stream reads do not preserve write boundaries.** 50 small writes plus one large write
  arrived as 217 reads. Length-prefix everything.
- **Bun segfaults on exit** when the native addon is loaded, 3/3 runs. Node, 0/3.
- **Safari cannot talk to a quiche-backed server** and is unsupported in v1. Chrome and
  Firefox only.
- **The reference transport applies no write backpressure.** `writer.ready` resolves
  unconditionally, measured: a producer ran 136,523 frames ahead of a consumer that had taken
  40, growing with the run. `stream()` carries its own credit window because of it.
- **The reference transport leaks per bidirectional stream**, unbounded, upstream: 5.95 KB
  on the server half and 5.88 KB on the client half. Not ours - our own path over a
  loopback costs 0.045 KB. The soak fails and Stage 1 is blocked. See D65.
- **`@moq/web-transport` is flat** on the identical probe: 0.01 KB per stream over 16,000,
  with a real plateau. The transport seam in ADR 0007 is the way out. See D66.

## Rules that exist because something nearly shipped

**Never reproduce an external interface from memory.** Depend on the published source, or
read it. Never retype an external type declaration, constant, hash, or protocol value from
recollection.

This has failed three times: a hand-vendored `StandardSchemaV1` that silently broke every
validator, a fabricated contract fingerprint in a document promising every snippet runs, and
five of twelve invented dependency versions. Twice it was caught by luck - an install
failure and a variance error. The fingerprint would have shipped.

So the rule is mechanical, not a thing to remember at the moment you are not thinking about
it:

- **Dependencies are added with the package manager**, never by hand-editing
  `package.json`. `npm i -D <pkg>` writes the version, so there is nothing to invent. A
  hand-written version string in a diff is a defect regardless of whether it happens to be
  correct.
- **Any external constant appearing in a document is computed or fetched in the same turn
  it is written**, and the command that produced it goes next to it. A hash, an ID, a size
  limit, a browser version: if it cannot be produced by a command in the transcript, it does
  not go in the document.

**A threshold is an absolute quantity, or a proportion of something this library counts.**
Never a proportion of a baseline established at measurement time. The memory-soak criterion
was originally "5% growth" and would have certified the exact leak it was written to catch.

**Documentation updates ship in the same commit as the change, never in a follow-up.** A
follow-up commit is a promise, and promises are how documentation goes stale. This applies
to humans and agents equally: an agent committing is subject to the same gate as a person.

**Two point samples are not a slope.** Fit a line.

## Toolchain facts

- **TypeScript 7.** `tsc` works; the classic compiler API does not exist until 7.1.
  No tool in this repository may depend on the compiler API. `expect-type`, never `tsd`.
  The doc harness and the instantiation count call `tsc` as a CLI.
- Editor support is fine: TS 7 speaks LSP via `tsc --lsp --stdio`.
- `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` under `nodenext`.
  Source writes `./util.ts`, output emits `./util.js`. No `.js` in any specifier in source,
  and no `.js`/`.mjs`/`.cjs` file anywhere outside `node_modules` and build output.
- `isolatedDeclarations` on `packages/core` only. It is incompatible with the contract
  pattern by design.
- Consumer floor is TypeScript 5.0, gated by `const` type parameters. CI checks it.

## The contract pattern is two lines, always

```ts
export const contract = defineContract({ /* ... */ })
export interface AppMap extends MapOf<typeof contract> {}
```

The second line is what keeps hover readable - 107 characters instead of 353, with no
validator internals. It is opt-in by nature, so it is canonical by convention: it appears
in the README, in every API.md example, in `examples/chat`, and in `AGENTS.md`. The inline
form appears nowhere.

## Platform support

Development is supported on **macOS and Linux**. Windows is not, and this is a statement
rather than an oversight: hook commands invoke `./node_modules/.bin/` paths directly, which
are `.cmd` shims on Windows, and the scripts assume a POSIX shell. Windows contributors
should use WSL. Note this is about *developing* the library - the transport itself publishes
a `win32-x64` prebuild, so running it on Windows is a separate question that is not blocked.

## Hooks vs CI

`lefthook` (Go binary, one committed YAML, installed by `prepare`). `pre-commit` is Biome
and the documentation-staleness check, staged-scoped and parallel, ~95 ms. `commit-msg` is
commitlint.

**Typecheck, knip, tests and e2e never go in a hook.** A slow pre-commit gets bypassed
within a week. And nothing in `lefthook.yml` may be the only place a check exists: hooks are
fast feedback, CI is the guarantee. See D61.

## Working style

- Ask when a decision is unresolved. Never guess and move on - an unasked question becomes
  a silent assumption in code.
- **Every question carries a recommended answer and the reasoning.** A question with no
  position attached is the same deferral the no-open-questions rule exists to prevent.
- If a fixed decision looks wrong, say so once with reasoning, then follow it unless it
  changes.
- Implementation follows `PROTOCOL.md`. If implementation reveals the spec is wrong,
  update the spec first and say so, then continue.
- Priority is shipping something real and honest, not something complete. Rough edges are
  acceptable if they are documented.

## Commits

Conventional Commits, scope required and validated against the workspace package list:
`feat(core):`, `fix(ci):`, `chore(repo):`.

**Subject only, never a body.** commitlint enforces an empty body. Breaking changes use
the `!` marker, because a `BREAKING CHANGE:` footer would require one:
`feat(core)!: rename emit to send`. Rationale lives in the changeset, the ADR, or
`PROTOCOL.md` - those are read, commit bodies are not.

One logical change per commit. If the subject needs "and", it is two commits. Never mix a
refactor with a behaviour change. Every commit passes typecheck, lint and unit tests on its
own, because bisect is the payoff for small commits and it only works if each one is green.
Commit at every green state rather than at the end of a task. Tests land in the same commit
as the code they cover. There is no line-count threshold: the "and" test and the green test
are the standards.
