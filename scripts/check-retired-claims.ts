/**
 * Claims found false stay false.
 *
 * "`@transport-io/react` requires registration" was found stale three times, in three
 * sweeps, and survived all three. Not because anyone disagreed it was wrong: because each
 * sweep was a list of files, the sentence lived in a file that was never on the list, and
 * when it was finally grepped for, it was hard-wrapped across a line break and a line-based
 * grep does not see a sentence that turns a corner. Three different ways to miss one
 * sentence, and a fourth sweep would have found a fourth.
 *
 * So a claim found false is retired here, as a pattern, and every tracked markdown file is
 * matched against it with whitespace collapsed first, so a line break inside a sentence is
 * just a space. The list only grows. Each entry carries the sentence it was last seen as, and
 * the gate matches that sentence against its own pattern before scanning anything, so a
 * pattern that has drifted until it matches nothing fails here rather than passing quietly.
 *
 * Records that quote a retired claim to say it was wrong are exempt, and are the only files
 * that may contain one.
 *
 *   bun run scripts/check-retired-claims.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

interface Retired {
  /** Matched against every document with whitespace collapsed to single spaces. */
  readonly pattern: RegExp
  /** The wording it was last seen as, verbatim except for line breaks. The pattern must match it. */
  readonly lastSeen: string
  readonly where: string
  readonly why: string
}

const RETIRED: readonly Retired[] = [
  {
    pattern:
      /transport-io\/react[^.]{0,160}\b(currently |still )?(requires|needs) (it|registration)\b/i,
    lastSeen: '`@transport-io/react` is the one thing that currently requires it.',
    where: 'AGENTS.md, 2026-09-02, after two earlier sweeps had removed it elsewhere',
    why: 'createHooks<AppMap>() binds the hooks to a map; nothing requires registration',
  },
  {
    pattern: /socket\.io'?s mistakes/i,
    lastSeen: "without Socket.IO's mistakes",
    where: 'README.md, packages/core/README.md, CLAUDE.md, 2026-09-01',
    why: 'not a checkable claim; every claim about another project carries their link or is cut (D110)',
  },
  {
    pattern: /undocumented custom protocol/i,
    lastSeen:
      "Socket.IO's real sin was an undocumented custom protocol only their own client could speak.",
    where: 'DECISIONS.md D48, 2026-09-01',
    why: 'socket.io-protocol documents version 5 with history; engine.io-protocol is at 4.1',
  },
  {
    pattern: /\ba timer per entry\b/i,
    lastSeen:
      'an incrementing ack id per request, a map from id to pending callback, and a timer per entry to clean up.',
    where: 'ADR 0002, 2026-09-01',
    why: 'the timer exists only when the caller opted in with timeout()',
  },
  {
    pattern: /one slow response delays every other message/i,
    lastSeen:
      'head-of-line blocking - one slow response delays every other message on the connection.',
    where: 'ADR 0002, 2026-09-01',
    why: 'a slow handler delays nothing; a lost packet on one ordered channel does',
  },
  {
    pattern: /\bthe older path\b/i,
    lastSeen: 'They work, and they are the older path; see Registering the map',
    where: 'site/src/content/docs/guides/react.md, 2026-09-02',
    why: 'a compatibility note; those live in CHANGELOG.md only',
  },
  {
    pattern: /\b(107|377|169|439|157|427|129|411) characters\b/,
    lastSeen: 'hovering `emit` shows 107 characters; without it, 377',
    where: 'README.md, API.md, AGENTS.md, getting-started.md, guides/react.md, 2026-09-02',
    why: 'a measurement proving a design point; it lives in D57 and D100, and reader-facing documents link',
  },
  {
    pattern: /=== \d+\) break\b/,
    lastSeen: 'if (out.length === 20) break',
    where: 'README.md, API.md, AGENTS.md, 2026-09-02',
    why: 'a counter is not how a token stream ends; the loop ends when the server stops',
  },
  {
    pattern: /\) break \/\/[^\n]{0,80}\b(resets?|finally)\b/,
    lastSeen:
      "if (out.length === 20) break // resets the stream, and the handler's `finally` runs",
    where: 'README.md, API.md, 2026-09-02',
    why: 'a comment explaining a side effect of break is the smell; the guide says it once, in prose',
  },
  {
    pattern: /not (implemented|in this version)[^.]{0,200}\bframework bindings\b/i,
    lastSeen:
      '## Not implemented Namespaces, presence, middleware chains, binary codecs, framework bindings, the Redis adapter.',
    where: 'AGENTS.md, 2026-09-02',
    why: '@transport-io/react has shipped since 0.1.0',
  },
]

/** Files that quote a retired claim in order to say it was wrong. */
const RECORDS = [
  'DECISIONS.md',
  'KNOWN-ISSUES.md',
  'packages/core/CHANGELOG.md',
  'packages/react/CHANGELOG.md',
  'scripts/README.md',
]
const isRecord = (f: string): boolean => RECORDS.includes(f) || f.startsWith('ADR/')

const collapse = (s: string): string => s.replace(/\s+/g, ' ')

const problems: string[] = []

// The list must be able to fail, so each pattern is first proven against its own sentence.
if (RETIRED.length === 0) problems.push('no retired claims: this gate would pass over anything')
for (const r of RETIRED) {
  if (!r.pattern.test(collapse(r.lastSeen))) {
    problems.push(
      `pattern ${r.pattern} no longer matches the sentence it retires: "${r.lastSeen}"`,
    )
  }
}

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '*.md', '*.mdx'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((f) => f.length > 0 && !f.startsWith('site/dist') && existsSync(f) && !isRecord(f))

if (files.length === 0) problems.push('no markdown files enumerated, so nothing was checked')

let hits = 0
for (const file of files) {
  const text = collapse(readFileSync(file, 'utf8'))
  for (const r of RETIRED) {
    const m = r.pattern.exec(text)
    if (m === null) continue
    hits++
    const at = Math.max(0, m.index - 40)
    problems.push(
      `${file}: retired claim is back: "…${text.slice(at, m.index + m[0].length + 40)}…"\n` +
        `      retired because: ${r.why}`,
    )
  }
}

console.log(
  `retired claims: ${RETIRED.length} pattern(s) proven against their own wording, ${files.length} file(s) clean, ${hits} hit(s)`,
)
if (problems.length > 0) {
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
