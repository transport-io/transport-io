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
 * The ceiling may only go down. Raising it is the drift this gate exists to refuse: if core
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
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  })
  for (const w of result.warnings) problems.push(`esbuild warned: ${w.text}`)

  const bytes = result.outputFiles[0]?.contents
  if (bytes === undefined || bytes.byteLength === 0) {
    problems.push('the bundle is empty, which is a broken measurement and not a small library')
  } else {
    const gzipped = gzipSync(bytes, { level: 9, mtime: 0 }).byteLength
    const pct = Math.round((gzipped / CEILING) * 100)
    console.log(
      `bundle: browser client ${bytes.byteLength} bytes minified, ${gzipped} gzipped ` +
        `(ceiling ${CEILING}, ${pct}%)`,
    )
    if (gzipped > CEILING) {
      problems.push(
        `the browser client is ${gzipped} bytes gzipped, above the ceiling of ${CEILING}. ` +
          'Every production bundle pays this. Find the bytes, or say in the commit what they buy.',
      )
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
