/**
 * The tutorial builds `examples/react`, and this is what makes that a check rather than a
 * promise.
 *
 * The page shows each file once, complete, and after that only what changes, as a diff
 * hunk. `tutorial-blocks.ts` rebuilds every file from the first appearance plus each hunk in
 * page order, checks every collapsed reference copy against that reconstruction, and checks
 * every excerpt against the repository file it quotes. The final state of every file is
 * written into one directory, compiled as one project with the tutorial's own
 * `tsconfig.json`, the way a reader's project would be, and compared byte for byte with the
 * example. A hunk that cannot be placed, a reference that disagrees, a project that does not
 * compile, or a file that drifts from the example by one line fails here rather than on a
 * reader's machine.
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
import { firstDifference, reconstruct } from './tutorial-blocks.ts'

const PAGE = 'site/src/content/docs/tutorial/chat.md'
const EXAMPLE = 'examples/react'
const OUT = '.tutorial-check'

/** The example's sources. The tutorial must produce every one of them, identically. */
const FILES: readonly string[] = [
  'contract.ts',
  'server.node.ts',
  'index.html',
  'vite.config.ts',
  'src/main.tsx',
  'src/App.tsx',
  'src/api.ts',
  'src/Chat.tsx',
]

/** Written by the tutorial, owned by the reader, and therefore not compared. */
const READER_OWN: Readonly<Record<string, string>> = {
  'package.json': "the example's depends on the workspace; the reader's on the registry",
  'tsconfig.json': "the example's extends the monorepo's base; the reader's stands alone",
}

/** Fewer blocks than this and the extractor is broken, not the tutorial short. */
const MIN_BLOCKS = 10

if (!existsSync(PAGE)) {
  console.error(`tutorial: ${PAGE} does not exist, so there is nothing that builds the example`)
  process.exit(1)
}

const text = readFileSync(PAGE, 'utf8')
const { files, problems, counts } = reconstruct(text, {
  allowed: (f) => FILES.includes(f) || f in READER_OWN,
  readRepository: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined),
})
const fails: string[] = problems.map((p) => `${PAGE}:${p}`)
const fail = (msg: string): void => {
  fails.push(msg)
}

const total = counts.complete + counts.change + counts.ref + counts.excerpt
if (total < MIN_BLOCKS)
  fail(`only ${total} block(s) on the page, expected at least ${MIN_BLOCKS}`)
if (counts.change === 0)
  fail('the page never shows a change as a hunk; every file is printed whole')
for (const f of FILES) {
  if (!files.has(f)) fail(`the tutorial never writes ${f}, which the example has`)
}
if (!files.has('tsconfig.json'))
  fail('the tutorial never writes tsconfig.json, so nothing compiles it')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
for (const [name, body] of files) {
  mkdirSync(dirname(join(OUT, name)), { recursive: true })
  writeFileSync(join(OUT, name), `${body}\n`)
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
let compared = 0
for (const f of FILES) {
  const got = files.get(f)
  if (got === undefined) continue
  const want = readFileSync(join(EXAMPLE, f), 'utf8')
  compared++
  const at = firstDifference(got, want)
  if (at === -1) continue
  const a = got.split('\n')[at - 1]
  const b = want.replace(/\n+$/, '').split('\n')[at - 1]
  fail(
    `${f} differs from ${EXAMPLE}/${f} at line ${at}:\n` +
      `         tutorial: ${JSON.stringify(a ?? '<end>')}\n` +
      `         example:  ${JSON.stringify(b ?? '<end>')}`,
  )
}

for (const p of fails) console.error(`  FAIL ${p}`)
if (fails.length > 0) {
  console.error(`tutorial: ${fails.length} problem(s)`)
  process.exit(1)
}
console.log(
  `tutorial: ${counts.complete} complete, ${counts.change} change, ${counts.ref} reference and ` +
    `${counts.excerpt} excerpt block(s) rebuilt ${files.size} file(s), compiled as one project, ` +
    `${compared} of them identical to ${EXAMPLE}`,
)
