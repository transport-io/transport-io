/**
 * Two documentation gates.
 *
 * 1. Every ```ts block in API.md / README.md is extracted and typechecked, so when the
 *    API changes the docs stop compiling and the build breaks. Blocks tagged
 *    ```ts ignore are skipped. This half activates by itself once packages/core
 *    exports a real surface.
 * 2. Every normative constant and error code in PROTOCOL.md is parsed out and compared
 *    against protocol.ts, which is the single source. Adding an error code without
 *    documenting it fails here, and so does changing a default without updating a table.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  CLOSE_REASON_MAX_BYTES,
  CloseCode,
  DATAGRAM_CONSERVATIVE_FLOOR,
  DATAGRAM_CONSERVATIVE_PAYLOAD_MAX,
  DATAGRAM_HEADER_BYTES,
  FrameType,
  HANDSHAKE_DEADLINE_MS,
  HOST_ORDINAL_QUARANTINE_MS,
  MAX_SESSION_HOSTS,
  ORIGIN_QUARANTINE_MS,
  ResetCode,
  SEQUENCE_STATE_RETENTION_MS,
  STREAM_FRAME_OVERHEAD_BYTES,
} from '../packages/core/src/protocol.ts'

const OUT = '.docs-check'
let failures = 0
const fail = (msg: string): void => {
  console.error(`  FAIL ${msg}`)
  failures++
}

// ---------------------------------------------------------------- doc snippets
let ignoredBlocks = 0
interface Block {
  readonly line: number
  readonly body: string
  /**
   * Tagged ```ts standalone: this block must compile with nothing before it.
   *
   * Prefix concatenation lets a block inherit imports from earlier blocks, which is right
   * for a document read top to bottom - but wrong for a block a reader copies whole. The
   * README's contract snippet says "the whole surface, in one file" and called
   * `defineContract` without importing it; an earlier block three screens up had the
   * import, so every form of concatenation accepted it and the reader got a broken file.
   */
  readonly standalone: boolean
}

function extractBlocks(file: string): Block[] {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const out: Block[] = []
  for (const m of text.matchAll(/^```(?:ts|typescript)([^\n]*)\n([\s\S]*?)^```/gm)) {
    const info = (m[1] ?? '').trim()
    if (info.includes('ignore') || info.includes('no-check')) {
      ignoredBlocks++
      continue
    }
    out.push({
      line: text.slice(0, m.index).split('\n').length,
      body: m[2] ?? '',
      standalone: info.includes('standalone'),
    })
  }
  return out
}

/**
 * A block tagged `ignore` is a promise to come back. The count is printed on every run
 * and must only ever go down, so the exemption cannot quietly become permanent.
 */
const MAX_IGNORED_BLOCKS = 1

/**
 * Floors, because finding nothing is far more often a broken glob than a clean repository.
 * Zero snippets compiled cleanly, and zero constants disagreed with zero constants - both
 * are green, and both mean the gate looked at nothing. Same class as the lane soak passing
 * on an empty sample set.
 */
const MIN_BLOCKS = 15
const MIN_CONSTANT_ROWS = 3

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

let blockCount = 0
let fileCount = 0
// AGENTS.md was exempt from this gate entirely - four `ts` blocks that no tool had ever
// compiled, in the document whose whole purpose is to be read and copied by a machine.
for (const doc of ['API.md', 'README.md', 'AGENTS.md']) {
  const blocks = extractBlocks(doc)
  if (blocks.length === 0) continue

  /**
   * Block N compiles against blocks 1..N, in source order - a *prefix*, not the whole
   * document.
   *
   * The difference is the whole gate. Concatenating every block into one module made this
   * blind: TypeScript hoists imports, so a block could use a name that a *later* block
   * imported. That is exactly how the README's flagship snippet called `defineContract`
   * without importing it and still compiled - the import was three blocks further down the
   * page, where no reader copying the first block would ever see it.
   *
   * A prefix keeps the narrative working, because a later block legitimately builds on the
   * `contract` and `AppMap` an earlier one defined, and that is how the documents are meant
   * to be read. It just refuses to let a block borrow from its own future.
   *
   * Import *bindings* already in scope are dropped, per module - a document re-stating an
   * import so a snippet reads correctly on its own must not then fail as a duplicate
   * identifier. Dropping whole duplicate lines is not enough: README imports
   * `defineContract` alone in one block and alongside `MapOf` and `type$` in another, so
   * the lines differ while the binding collides. A block that imports nothing still has
   * nothing, which is the case this gate exists to catch.
   */
  const prefix: string[] = []
  for (const b of blocks) {
    prefix.push(`// ${doc}:${b.line}\n${b.body}`)
    const scope = b.standalone ? [`// ${doc}:${b.line}\n${b.body}`] : prefix
    const seen = new Map<string, Set<string>>()
    const source = scope
      .join('\n')
      .split('\n')
      .map((line) => {
        const m = /^(\s*import\s+\{)([^}]*)(\}\s+from\s+['"])([^'"]+)(['"].*)$/.exec(line)
        if (m === null) return line
        const [, head, names, mid, module_, tail] = m
        const already = seen.get(module_ as string) ?? new Set<string>()
        const kept = (names as string)
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n.length > 0)
          .filter((n) => {
            const binding = n
              .replace(/^type\s+/, '')
              .split(/\s+as\s+/)
              .pop() as string
            if (already.has(binding)) return false
            already.add(binding)
            return true
          })
        seen.set(module_ as string, already)
        return kept.length === 0 ? '' : `${head} ${kept.join(', ')} ${mid}${module_}${tail}`
      })
      .join('\n')
    const name = `${doc.replace(/\W/g, '_')}__${String(b.line).padStart(4, '0')}.ts`
    writeFileSync(
      join(OUT, name),
      `// generated from ${doc}, blocks up to line ${b.line}\n${source}`,
    )
    fileCount++
  }
  blockCount += blocks.length
}
console.log(
  `docs: ${blockCount} block(s) checked, ${ignoredBlocks} awaiting implementation (ceiling ${MAX_IGNORED_BLOCKS})`,
)
if (blockCount < MIN_BLOCKS) {
  fail(
    `only ${blockCount} documentation block(s) found, expected at least ${MIN_BLOCKS}. ` +
      'The documents did not lose their examples; the extractor or the file list changed.',
  )
}
if (ignoredBlocks > MAX_IGNORED_BLOCKS) {
  fail(
    `${ignoredBlocks} documentation blocks are tagged \`ignore\`, above the ceiling of ` +
      `${MAX_IGNORED_BLOCKS}. Implement the surface or lower the ceiling - never raise it.`,
  )
}

// ---------------------------------------------------------------- protocol constants
const proto = existsSync('PROTOCOL.md') ? readFileSync('PROTOCOL.md', 'utf8') : ''
const section = (header: string): string => {
  const i = proto.indexOf(header)
  if (i < 0) return ''
  const j = proto.indexOf('\n### ', i + 1)
  return j > 0 ? proto.slice(i, j) : proto.slice(i)
}
const tableRows = (seg: string): string[][] =>
  [...seg.matchAll(/^\|(.+)\|$/gm)].map((m) =>
    (m[1] ?? '').split('|').map((c) => c.trim().replace(/`/g, '')),
  )

const parseCodes = (header: string): Map<number, string> => {
  const out = new Map<number, string>()
  for (const c of tableRows(section(header))) {
    if (c[0] && /^\d+$/.test(c[0]) && c[1]?.startsWith('WT_')) out.set(Number(c[0]), c[1])
  }
  return out
}
const resetCodes = parseCodes('### 10.1 Stream reset codes')
const closeCodes = parseCodes('### 10.2 Session close codes')

const frameTypesDoc = new Map<number, string>()
for (const c of tableRows(section('### 5.2 Type'))) {
  const m = /^0x([0-9A-Fa-f]{2})$/.exec(c[0] ?? '')
  if (m?.[1] && /^[A-Z_]+$/.test(c[1] ?? '')) {
    frameTypesDoc.set(Number.parseInt(m[1], 16), c[1] as string)
  }
}
console.log(
  `protocol: ${resetCodes.size} reset, ${closeCodes.size} close, ${frameTypesDoc.size} frame types parsed`,
)

for (const [code, name] of resetCodes) {
  if (code < 0 || code > 255) fail(`reset code ${name}=${code} is outside the one-byte range`)
}

function compare(label: string, doc: Map<number, string>, code: Record<string, number>): void {
  const fromCode = new Map<number, string>(Object.entries(code).map(([k, v]) => [v, k]))
  for (const [num, name] of doc) {
    const inCode = fromCode.get(num)
    if (inCode === undefined)
      fail(`${label} ${num} (${name}) is documented but absent from protocol.ts`)
    else if (inCode !== name) fail(`${label} ${num}: doc says ${name}, code says ${inCode}`)
  }
  for (const [num, name] of fromCode) {
    if (!doc.has(num)) fail(`${label} ${num} (${name}) is in protocol.ts but undocumented`)
  }
}
// Each table must have parsed something. Comparing an empty parse against an empty enum
// agrees perfectly, and comparing an empty parse against a populated enum only fails in one
// direction - so a parser that silently stopped matching rows would be caught by luck, or
// not at all.
for (const [name, rows] of [
  ['reset code', resetCodes],
  ['close code', closeCodes],
  ['frame type', frameTypesDoc],
] as const) {
  if (rows.size < MIN_CONSTANT_ROWS) {
    fail(
      `${name} table parsed ${rows.size} row(s), expected at least ${MIN_CONSTANT_ROWS}. ` +
        'A table that parses as empty agrees with everything.',
    )
  }
}

compare('reset code', resetCodes, ResetCode)
compare('close code', closeCodes, CloseCode)
compare('frame type', frameTypesDoc, FrameType)

const overheads = [...proto.matchAll(/\*\*Fixed overhead\*\* \| \*\*(\d+)\*\*/g)].map((m) =>
  Number(m[1]),
)
const floor = Number(/or \*\*(\d+)\*\* when/.exec(proto)?.[1] ?? -1)
const payloadMax = Number(
  /conservative payload maximum is \*\*(\d+) bytes\*\*/.exec(proto)?.[1] ?? -1,
)

if (overheads.length < 2) fail('could not parse both field budgets out of PROTOCOL.md')
else {
  const checks: [string, number, number][] = [
    ['stream frame overhead', overheads[0] as number, STREAM_FRAME_OVERHEAD_BYTES],
    ['datagram header bytes', overheads[1] as number, DATAGRAM_HEADER_BYTES],
    ['datagram payload max', payloadMax, DATAGRAM_CONSERVATIVE_PAYLOAD_MAX],
    ['datagram conservative floor', floor, DATAGRAM_CONSERVATIVE_FLOOR],
    [
      'handshake deadline ms',
      Number(/\*\*Deadline: (\d+) ms/.exec(proto)?.[1] ?? -1),
      HANDSHAKE_DEADLINE_MS,
    ],
    [
      'close reason max bytes',
      Number(/exceed \*\*(\d+) bytes\*\*/.exec(proto)?.[1] ?? -1),
      CLOSE_REASON_MAX_BYTES,
    ],
    [
      'sequence state retention ms',
      Number(/after `(\d+)` seconds with no datagram/.exec(proto)?.[1] ?? -1) * 1000,
      SEQUENCE_STATE_RETENTION_MS,
    ],
    [
      'origin quarantine ms',
      Number(
        /origin is therefore quarantined for at least `(\d+)` seconds/.exec(proto)?.[1] ?? -1,
      ) * 1000,
      ORIGIN_QUARANTINE_MS,
    ],
    [
      'host ordinal quarantine ms',
      Number(
        /quarantined for at least `(\d+)` seconds before reallocation/.exec(proto)?.[1] ?? -1,
      ) * 1000,
      HOST_ORDINAL_QUARANTINE_MS,
    ],
    [
      'max session hosts',
      Number(
        /Stated limit: ([\d,]+) concurrent session hosts/.exec(proto)?.[1]?.replace(/,/g, '') ??
          -1,
      ),
      MAX_SESSION_HOSTS,
    ],
  ]
  for (const [label, fromDoc, fromCode] of checks) {
    if (fromDoc !== fromCode)
      fail(`${label}: doc says ${fromDoc}, protocol.ts says ${fromCode}`)
  }
  if (floor - DATAGRAM_HEADER_BYTES !== payloadMax) {
    fail(`datagram arithmetic: ${floor} - ${DATAGRAM_HEADER_BYTES} != ${payloadMax}`)
  } else {
    console.log(
      `protocol: ${floor} - ${DATAGRAM_HEADER_BYTES} = ${payloadMax}, and all codes agree with protocol.ts`,
    )
  }
}

// ---------------------------------------------------------------- compile the snippets
const coreEntry = readFileSync('packages/core/src/index.ts', 'utf8')
const coreIsStub = [...coreEntry.matchAll(/^export /gm)].length <= 1

if (coreIsStub) {
  console.log(
    `docs: snippet compilation PENDING - core is still the stub entry (${blockCount} blocks)`,
  )
} else if (fileCount > 0) {
  try {
    execFileSync(
      './node_modules/typescript/bin/tsc',
      [
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--module',
        'preserve',
        '--moduleResolution',
        'bundler',
        '--target',
        'es2023',
        '--ignoreConfig',
        ...readdirSync(OUT).map((f) => join(OUT, f)),
      ],
      { stdio: 'inherit' },
    )
  } catch {
    fail('documentation snippets do not compile')
  }
}

rmSync(OUT, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\ndocs-check: ${failures} failure(s)`)
  process.exit(1)
}
console.log('docs-check: OK')
