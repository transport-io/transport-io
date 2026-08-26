/**
 * A gate for normative prose, which had none.
 *
 * Numeric constants are asserted against `protocol.ts`. Code blocks are compiled. Sentences
 * that say what an implementation MUST do were checked by nobody — which is how four
 * promises lived in three documents and no code, and how ADR 0010 kept claiming a `u16`
 * event id against a wire that had been `u32` for weeks.
 *
 * The rule is deliberately shallow: every normative statement carries an identifier, and
 * that identifier names a test file which must mention it back. That is a two-way link, so
 * a marker cannot point at an unrelated file and a test cannot claim coverage the document
 * does not acknowledge.
 *
 * **This does not verify that the test is any good.** It is not trying to. It makes an
 * unimplemented promise impossible to write down *silently*, which is the failure that
 * recurred five times in one day. Writing `MUST` now costs either a test or an explicit,
 * counted admission that there is none.
 *
 *   <!-- norm: handshake-frame-zero -> packages/core/src/protocol-promises.test.ts -->
 *   <!-- norm: some-future-thing -> UNPROVEN: reason it is not yet testable -->
 *
 * The marker goes on the line directly after the statement it covers. One marker may cover
 * several consecutive normative lines — a table of MUSTs needs one, not twelve.
 *
 *   bun run scripts/check-norms.ts
 */
import { existsSync, readFileSync } from 'node:fs'

const DOCS = ['PROTOCOL.md', 'API.md'] as const

/**
 * Statements that are about the words themselves rather than about behaviour. Only the
 * RFC-2119 boilerplate qualifies, and it is listed rather than pattern-matched so that
 * adding to this list is a visible act.
 */
const NOT_NORMATIVE = [
  '"MUST", "MUST NOT", "SHOULD" and "MAY" carry their usual specification force.',
]

/**
 * Admissions may only ever go down. Same idiom as the `ignore` block ceiling in
 * `check-docs.ts`, and for the same reason: an exemption with no ratchet becomes permanent
 * on the first busy afternoon.
 */
const MAX_UNPROVEN = 8

/**
 * A floor, because finding nothing is far more often a broken glob than a clean repository.
 *
 * An aggregate over an empty collection compared against a bound *passes*: zero violations
 * is zero, which is under every threshold. That is how the lane soak reported
 * `peak RSS -Infinity  bound < 600  PASS` having sampled nothing, and how `test:node` was
 * green twice over while running no tests. A gate that cannot tell "clean" from "looked at
 * nothing" is not a gate.
 */
const MIN_STATEMENTS = 20
const MIN_MARKERS = 15

export interface Statement {
  readonly doc: string
  readonly line: number
  readonly text: string
}

export interface Marker {
  readonly doc: string
  readonly line: number
  readonly id: string
  readonly target: string
  readonly unproven: boolean
}

const NORMATIVE = /\b(MUST NOT|MUST|SHALL NOT|SHALL)\b/

/**
 * `API.md` states its guarantees as bold lead-ins rather than RFC-2119 keywords — "**The
 * lane lives in the contract, never at the call site.**" is exactly as binding as a MUST
 * and would otherwise slip past. Restricted to bold openers so that ordinary prose using
 * the word "never" is not dragged in.
 */
const NORMATIVE_BOLD = /^\*\*[^*]+\b(never|always)\b/
const MARKER = /^\s*<!--\s*norm:\s*([a-z0-9-]+)\s*->\s*(.+?)\s*-->\s*$/

export function parse(
  doc: string,
  text: string,
): { statements: Statement[]; markers: Marker[] } {
  const statements: Statement[] = []
  const markers: Marker[] = []
  for (const [i, raw] of text.split('\n').entries()) {
    const m = MARKER.exec(raw)
    if (m !== null) {
      const target = m[2] as string
      markers.push({
        doc,
        line: i + 1,
        id: m[1] as string,
        target,
        unproven: target.startsWith('UNPROVEN:'),
      })
      continue
    }
    const isNormative = NORMATIVE.test(raw) || NORMATIVE_BOLD.test(raw)
    if (isNormative && !NOT_NORMATIVE.some((n) => raw.includes(n))) {
      statements.push({ doc, line: i + 1, text: raw.trim() })
    }
  }
  return { statements, markers }
}

/**
 * A statement is covered when a marker appears within `REACH` lines below it, so one marker
 * can cover a run of consecutive MUSTs — a table row per line otherwise needs a marker per
 * row, which would make the documents unreadable and the gate resented.
 */
const REACH = 40

export function uncovered(
  statements: readonly Statement[],
  markers: readonly Marker[],
): Statement[] {
  return statements.filter(
    (s) => !markers.some((m) => m.doc === s.doc && m.line > s.line && m.line - s.line <= REACH),
  )
}

function main(): void {
  const statements: Statement[] = []
  const markers: Marker[] = []
  for (const doc of DOCS) {
    if (!existsSync(doc)) continue
    const parsed = parse(doc, readFileSync(doc, 'utf8'))
    statements.push(...parsed.statements)
    markers.push(...parsed.markers)
  }

  const problems: string[] = []

  for (const s of uncovered(statements, markers)) {
    problems.push(
      `${s.doc}:${s.line}  normative statement with no marker\n    ${s.text.slice(0, 96)}\n` +
        '    Add:  <!-- norm: <id> -> <test file> -->   (or -> UNPROVEN: <reason>)',
    )
  }

  const byId = new Map<string, Marker>()
  for (const m of markers) {
    const prior = byId.get(m.id)
    if (prior !== undefined) {
      problems.push(
        `${m.doc}:${m.line}  duplicate norm id '${m.id}' (also ${prior.doc}:${prior.line})`,
      )
      continue
    }
    byId.set(m.id, m)
    if (m.unproven) continue

    if (!existsSync(m.target)) {
      problems.push(
        `${m.doc}:${m.line}  norm '${m.id}' names '${m.target}', which does not exist`,
      )
      continue
    }
    // The link has to hold from both ends, or a marker could name any file at all.
    if (!readFileSync(m.target, 'utf8').includes(m.id)) {
      problems.push(
        `${m.doc}:${m.line}  norm '${m.id}' names '${m.target}', which never mentions it\n` +
          `    Reference the id in that file, e.g. in the test name or a comment.`,
      )
    }
  }

  if (statements.length < MIN_STATEMENTS) {
    problems.push(
      `only ${statements.length} normative statement(s) found, expected at least ` +
        `${MIN_STATEMENTS}. The documents did not lose their MUSTs; the pattern or the ` +
        'file list changed. Fix that before trusting a green run.',
    )
  }
  if (markers.length < MIN_MARKERS) {
    problems.push(
      `only ${markers.length} marker(s) parsed, expected at least ${MIN_MARKERS}. ` +
        'A marker-syntax change turns this whole gate into a no-op that exits 0.',
    )
  }

  const unproven = markers.filter((m) => m.unproven)
  console.log(
    `norms: ${statements.length} normative statement(s), ${markers.length} marker(s), ` +
      `${unproven.length} unproven (ceiling ${MAX_UNPROVEN})`,
  )
  if (unproven.length > MAX_UNPROVEN) {
    problems.push(
      `${unproven.length} markers are UNPROVEN, above the ceiling of ${MAX_UNPROVEN}. ` +
        'Prove one or delete the promise — never raise the ceiling.',
    )
  }

  for (const p of problems) console.error(`\n${p}`)
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s).`)
    process.exit(1)
  }
  console.log('norms: every normative statement names a test that mentions it back')
}

if (import.meta.main) main()
