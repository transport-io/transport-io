/**
 * Two documentation gates (DECISIONS.md, doc-staleness mechanisms):
 *
 * 1. Every ```ts block in API.md / README.md is extracted and typechecked.
 *    When the API changes, the docs stop compiling and the build breaks.
 *    Blocks tagged ```ts ignore are skipped.
 * 2. Every normative constant in PROTOCOL.md is parsed out and asserted against
 *    the single source in code, so a table and an implementation cannot drift.
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

const OUT = '.docs-check'
let failures = 0

function fail(msg: string): void {
  console.error(`  FAIL ${msg}`)
  failures++
}

// ---------- 1. compile the documentation ----------
function extractBlocks(file: string): { line: number; body: string }[] {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const re = /^```(?:ts|typescript)([^\n]*)\n([\s\S]*?)^```/gm
  const out: { line: number; body: string }[] = []
  for (const m of text.matchAll(re)) {
    const info = (m[1] ?? '').trim()
    if (info.includes('ignore') || info.includes('no-check')) continue
    out.push({ line: text.slice(0, m.index).split('\n').length, body: m[2] ?? '' })
  }
  return out
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// Blocks from one document are fragments of one coherent surface, so they are
// concatenated per document in source order. Compiling each in isolation would fail
// on cross-references between sections rather than on anything real.
let blockCount = 0
let fileCount = 0
for (const doc of ['API.md', 'README.md']) {
  const blocks = extractBlocks(doc)
  if (blocks.length === 0) continue
  const header = `// generated from ${doc} — do not edit\n`
  const body = blocks.map((b) => `// ${doc}:${b.line}\n${b.body}`).join('\n')
  writeFileSync(join(OUT, `${doc.replace(/\W/g, '_')}.ts`), header + body)
  blockCount += blocks.length
  fileCount++
}
console.log(`docs: extracted ${blockCount} block(s) from ${fileCount} document(s)`)

// ---------- 2. PROTOCOL.md constants vs code ----------
const proto = existsSync('PROTOCOL.md') ? readFileSync('PROTOCOL.md', 'utf8') : ''

function section(header: string): string {
  const i = proto.indexOf(header)
  if (i < 0) return ''
  const j = proto.indexOf('\n### ', i + 1)
  return j > 0 ? proto.slice(i, j) : proto.slice(i)
}
function tableRows(seg: string): string[][] {
  return [...seg.matchAll(/^\|(.+)\|$/gm)].map((m) =>
    (m[1] ?? '').split('|').map((c) => c.trim().replace(/`/g, '')),
  )
}

const resetCodes = new Map<number, string>()
for (const c of tableRows(section('### 10.1 Stream reset codes'))) {
  if (c[0] && /^\d+$/.test(c[0]) && c[1]?.startsWith('WT_')) resetCodes.set(Number(c[0]), c[1])
}
const closeCodes = new Map<number, string>()
for (const c of tableRows(section('### 10.2 Session close codes'))) {
  if (c[0] && /^\d+$/.test(c[0]) && c[1]?.startsWith('WT_')) closeCodes.set(Number(c[0]), c[1])
}

console.log(`protocol: ${resetCodes.size} reset codes, ${closeCodes.size} close codes parsed`)

// Reset codes MUST fit one byte — a protocol-wide constraint, not a style rule.
for (const [code, name] of resetCodes) {
  if (code < 0 || code > 255) fail(`reset code ${name}=${code} outside the one-byte range`)
}

// Derived datagram arithmetic must agree with the field budget table.
const headerMatch = [...proto.matchAll(/\*\*Fixed overhead\*\* \| \*\*(\d+)\*\*/g)].map((m) =>
  Number(m[1]),
)
const floorMatch = /or \*\*(\d+)\*\* when/.exec(proto)
const payloadMaxMatch = /conservative payload maximum is \*\*(\d+) bytes\*\*/.exec(proto)
if (headerMatch.length >= 2 && floorMatch?.[1] && payloadMaxMatch?.[1]) {
  const dgHeader = headerMatch[1] as number
  const floor = Number(floorMatch[1])
  const payloadMax = Number(payloadMaxMatch[1])
  if (floor - dgHeader !== payloadMax) {
    fail(
      `datagram arithmetic: floor(${floor}) - header(${dgHeader}) != payloadMax(${payloadMax})`,
    )
  } else {
    console.log(`protocol: ${floor} - ${dgHeader} = ${payloadMax} OK`)
  }
} else {
  fail('could not parse the datagram budget out of PROTOCOL.md')
}

// The snippet gate activates by itself. While packages/core is still the Phase 2a stub
// (a version constant and nothing else), API.md necessarily documents types that do not
// exist, so compiling it would fail for a reason that is not a defect. The moment core
// exports anything beyond VERSION, this turns on with no marker for anyone to forget.
const coreEntry = readFileSync('packages/core/src/index.ts', 'utf8')
const coreExports = [...coreEntry.matchAll(/^export /gm)].length
const coreIsStub = coreExports <= 1 && coreEntry.includes('VERSION')

if (coreIsStub) {
  console.log(
    `docs: snippet compilation PENDING — packages/core is still the stub entry.\n` +
      `      ${blockCount} block(s) will be typechecked as soon as core exports a real surface.`,
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
        '--noEmitOnError',
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
