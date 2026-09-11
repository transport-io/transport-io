/**
 * The tutorial builds `examples/chat`, and this is what makes that a check rather than a
 * promise.
 *
 * Every fenced block on the tutorial page that names a file is taken in order, later blocks
 * replacing earlier ones, and the final state of every file is written into one directory.
 * That directory is compiled as one project with the tutorial's own `tsconfig.json`, the way
 * a reader's project would be, and then every source file in it is compared byte for byte
 * with the example. A tutorial that declares something it never built, or drifts from the
 * example by one line, fails here rather than on a reader's machine.
 *
 * Two files are the reader's own and are not compared: `package.json`, because the example's
 * depends on the workspace and the reader's on the registry, and `tsconfig.json`, because
 * the example's extends the monorepo's base.
 *
 *   bun run scripts/check-tutorial.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PAGE = 'site/src/content/docs/tutorial/chat.md'
const EXAMPLE = 'examples/chat'
const OUT = '.tutorial-check'

/** The example's sources. The tutorial must produce every one of them, identically. */
const FILES: readonly string[] = [
  'contract.ts',
  'app.ts',
  'agents.ts',
  'server.node.ts',
  'web/index.html',
  'web/main.ts',
  'web/agents.html',
  'web/agents.ts',
]

/** Written by the tutorial, owned by the reader, and therefore not compared. */
const READER_OWN: Readonly<Record<string, string>> = {
  'package.json': "the example's depends on the workspace; the reader's on the registry",
  'tsconfig.json': "the example's extends the monorepo's base; the reader's stands alone",
}

/** Fewer named blocks than this and the extractor is broken, not the tutorial short. */
const MIN_NAMED_BLOCKS = 10

const problems: string[] = []
const fail = (msg: string): void => {
  problems.push(msg)
}

if (!existsSync(PAGE)) {
  console.error(`tutorial: ${PAGE} does not exist, so there is nothing that builds the example`)
  process.exit(1)
}

const text = readFileSync(PAGE, 'utf8')
const files = new Map<string, string>()
let named = 0
for (const m of text.matchAll(/^```(\w+)([^\n]*)\n([\s\S]*?)^```/gm)) {
  const name = /(?:^|\s)file=([\w./-]+)/.exec(m[2] ?? '')?.[1]
  if (name === undefined) continue
  named++
  if (!FILES.includes(name) && !(name in READER_OWN)) {
    fail(`${PAGE} writes ${name}, which the example does not have`)
    continue
  }
  files.set(name, m[3] ?? '')
}

if (named < MIN_NAMED_BLOCKS) {
  fail(`only ${named} named block(s) on the page, expected at least ${MIN_NAMED_BLOCKS}`)
}
for (const f of FILES) {
  if (!files.has(f)) fail(`the tutorial never writes ${f}, which the example has`)
}
if (!files.has('tsconfig.json'))
  fail('the tutorial never writes tsconfig.json, so nothing compiles it')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
for (const [name, body] of files) {
  mkdirSync(dirname(join(OUT, name)), { recursive: true })
  writeFileSync(join(OUT, name), body)
}

// The reader's project, compiled as the reader would: one tsconfig, every file at once.
if (files.has('tsconfig.json')) {
  try {
    execFileSync('./node_modules/typescript/bin/tsc', ['-p', join(OUT, 'tsconfig.json')], {
      stdio: 'inherit',
    })
  } catch {
    fail('the assembled tutorial project does not compile')
  }
}

// The finished state is the example, byte for byte, or the tutorial has drifted.
const trimEnd = (s: string): string => s.replace(/\n+$/, '')
let compared = 0
for (const f of FILES) {
  const got = files.get(f)
  if (got === undefined) continue
  const want = readFileSync(join(EXAMPLE, f), 'utf8')
  compared++
  if (trimEnd(got) === trimEnd(want)) continue
  const a = trimEnd(got).split('\n')
  const b = trimEnd(want).split('\n')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  fail(
    `${f} differs from ${EXAMPLE}/${f} at line ${i + 1}:\n` +
      `         tutorial: ${JSON.stringify(a[i] ?? '<end>')}\n` +
      `         example:  ${JSON.stringify(b[i] ?? '<end>')}`,
  )
}

for (const p of problems) console.error(`  FAIL ${p}`)
if (problems.length > 0) {
  console.error(`tutorial: ${problems.length} problem(s)`)
  process.exit(1)
}
console.log(
  `tutorial: ${named} named block(s) assembled into ${files.size} file(s), compiled as one project, ` +
    `${compared} of them identical to ${EXAMPLE}`,
)
