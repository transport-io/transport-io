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
function extractBlocks(file: string): { line: number; body: string }[] {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const out: { line: number; body: string }[] = []
  for (const m of text.matchAll(/^```(?:ts|typescript)([^\n]*)\n([\s\S]*?)^```/gm)) {
    const info = (m[1] ?? '').trim()
    if (info.includes('ignore') || info.includes('no-check')) {
      ignoredBlocks++
      continue
    }
    out.push({ line: text.slice(0, m.index).split('\n').length, body: m[2] ?? '' })
  }
  return out
}

/**
 * A block tagged `ignore` is a promise to come back. The count is printed on every run
 * and must only ever go down, so the exemption cannot quietly become permanent.
 */
const MAX_IGNORED_BLOCKS = 1

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

let blockCount = 0
let fileCount = 0
// AGENTS.md was exempt from this gate entirely — four `ts` blocks that no tool had ever
// compiled, in the document whose whole purpose is to be read and copied by a machine.
for (const doc of ['API.md', 'README.md', 'AGENTS.md']) {
  const blocks = extractBlocks(doc)
  if (blocks.length === 0) continue
  // Blocks from one document are fragments of one surface, so they are concatenated in
  // source order. Compiling each alone would fail on cross-references, not on defects.
  const body = blocks.map((b) => `// ${doc}:${b.line}\n${b.body}`).join('\n')
  writeFileSync(join(OUT, `${doc.replace(/\W/g, '_')}.ts`), `// generated from ${doc}\n${body}`)
  blockCount += blocks.length
  fileCount++
}
console.log(
  `docs: ${blockCount} block(s) checked, ${ignoredBlocks} awaiting implementation (ceiling ${MAX_IGNORED_BLOCKS})`,
)
if (ignoredBlocks > MAX_IGNORED_BLOCKS) {
  fail(
    `${ignoredBlocks} documentation blocks are tagged \`ignore\`, above the ceiling of ` +
      `${MAX_IGNORED_BLOCKS}. Implement the surface or lower the ceiling — never raise it.`,
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
    `docs: snippet compilation PENDING — core is still the stub entry (${blockCount} blocks)`,
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
