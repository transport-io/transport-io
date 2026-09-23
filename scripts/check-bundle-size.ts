/**
 * A byte ceiling for what every browser application pays, enforced the way the README's
 * word ceiling is.
 *
 * `Client.observe()` is off unless something subscribes, and the branch it costs a session
 * nobody observes is not measurable. Its bytes are: a class's methods do not tree-shake, so
 * the seam ships in every production bundle, including every one that never opens a panel.
 * A size nobody pins drifts, and this one is paid by people who got nothing for it. See D149.
 *
 * What is measured is what a browser application imports: the client, the contract helpers
 * and the browser transport, from the built `dist`, bundled and minified for a browser, then
 * gzipped. The bundler and the compressor are esbuild and fflate, both JavaScript or
 * platform-independent and both pinned by the lockfile, so the figure is a function of this
 * repository and nothing else. It is not Bun's bundler, which CI and a laptop run at
 * different versions, and not zlib, whose output differs between processor architectures.
 *
 * The bundle is split the way an application's bundler splits it, so what is measured is what
 * a page loads before anything runs: the entry chunk and every chunk it imports statically.
 * A chunk reached only through a dynamic `import()` is loaded by some pages and not others,
 * and it has a ceiling of its own. Without splitting, esbuild inlines a dynamic import, and a
 * chunk most pages never load would be counted as though every page did.
 *
 * Both ceilings may only go down. Raising one is the drift this gate exists to refuse: if core
 * genuinely needs more bytes in a browser, something else in the bundle has to give them up,
 * or the ceiling is raised in a commit that says what every application is now paying for.
 *
 *   bun run scripts/check-bundle-size.ts [path to a core package, default packages/core]
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { gzipSync } from 'fflate'

/**
 * Gzipped bytes, measured with this script on 2026-09-17: 12,803 at e288d12, before the
 * observer seam, and 13,810 with it. The seam is 1,007 of them, for records of every frame,
 * every call stream and every drop. It started at 1,146; D149 has what came out.
 */
const CEILING = 13_810

/** Gzipped bytes of every chunk loaded only through a dynamic `import()`. None is. */
const LAZY_CEILING = 0

const core = resolve(process.argv[2] ?? 'packages/core')
const index = resolve(core, 'dist/index.js')
const browser = resolve(core, 'dist/transport/browser.js')

const problems: string[] = []
for (const file of [index, browser]) {
  if (!existsSync(file)) problems.push(`${file} is missing. Run \`npm run build\` first.`)
}

if (problems.length === 0) {
  const result = await build({
    stdin: {
      contents: [
        "export { Client, defineContract, reliable, unreliable } from 'transport-io'",
        "export { connectBrowser } from 'transport-io/browser-transport'",
      ].join('\n'),
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    alias: { 'transport-io/browser-transport': browser, 'transport-io': index },
    bundle: true,
    splitting: true,
    outdir: 'bundle-size',
    metafile: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  })
  for (const w of result.warnings) problems.push(`esbuild warned: ${w.text}`)

  const outputs = result.metafile.outputs
  const entry = Object.keys(outputs).find((path) => outputs[path]?.entryPoint !== undefined)
  // What loads before anything runs: the entry, and what it imports statically, transitively.
  const initial = new Set<string>()
  const visit = (path: string): void => {
    if (initial.has(path)) return
    initial.add(path)
    for (const i of outputs[path]?.imports ?? [])
      if (i.kind === 'import-statement') visit(i.path)
  }
  if (entry !== undefined) visit(entry)

  let entryBytes = 0
  let entryGzipped = 0
  const lazy: { path: string; gzipped: number }[] = []
  for (const file of result.outputFiles) {
    const path = Object.keys(outputs).find((p) => file.path.endsWith(p))
    if (path === undefined) continue
    const gzipped = gzipSync(file.contents, { level: 9, mtime: 0 }).byteLength
    if (initial.has(path)) {
      entryBytes += file.contents.byteLength
      entryGzipped += gzipped
    } else {
      lazy.push({ path, gzipped })
    }
  }

  if (entryBytes === 0) {
    problems.push('the bundle is empty, which is a broken measurement and not a small library')
  } else {
    const pct = Math.round((entryGzipped / CEILING) * 100)
    console.log(
      `bundle: browser client ${entryBytes} bytes minified, ${entryGzipped} gzipped ` +
        `(ceiling ${CEILING}, ${pct}%)`,
    )
    if (entryGzipped > CEILING) {
      problems.push(
        `the browser client is ${entryGzipped} bytes gzipped, above the ceiling of ${CEILING}. ` +
          'Every production bundle pays this. Find the bytes, or say in the commit what they buy.',
      )
    }
    const lazyGzipped = lazy.reduce((n, c) => n + c.gzipped, 0)
    for (const c of lazy)
      console.log(`bundle: loaded on demand, ${c.path}: ${c.gzipped} gzipped`)
    console.log(`bundle: loaded on demand, ${lazyGzipped} gzipped (ceiling ${LAZY_CEILING})`)
    if (lazyGzipped > LAZY_CEILING) {
      problems.push(
        `the chunks loaded on demand are ${lazyGzipped} bytes gzipped, above the ceiling of ` +
          `${LAZY_CEILING}. Find the bytes, or say in the commit what they buy and who loads them.`,
      )
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
