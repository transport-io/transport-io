#!/usr/bin/env node
/**
 * `npx transport-io dev`.
 *
 * The first thirty minutes with this library used to be two openssl invocations, three
 * constraints nobody tells you about, a DER extraction, a SHA-256, and an undocumented hop
 * getting that hash from the server process into the browser bundle. This closes all of it.
 *
 * What it does NOT do is bundle. That needs a bundler, which would be this package's first
 * CLI dependency, so a real project keeps running its own `vite dev` or `bun build --watch`
 * beside this and points `--static` at the output. `--demo` needs no bundler because the
 * page imports the built package as native ESM.
 *
 * Everything here is Node built-ins and this library's own source. The import boundary check
 * enforces that, so a future feature cannot quietly add a dependency.
 */
import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { daysLeft, ensureCertificate } from './certificate.node.ts'
import { startDevServer } from './dev-server.node.ts'

const DEFAULT_PORT = 3000
const DEFAULT_WT_PORT = 4433

export interface Args {
  readonly entry: string | undefined
  readonly demo: boolean
  readonly port: number
  readonly wtPort: number
  readonly staticDir: string | undefined
  readonly help: boolean
}

export function parseArgs(input: readonly string[]): Args {
  // The command word is dropped here rather than by the caller, so there is one place that
  // knows about it. Leaving it in made `dev ./server.ts` take `dev` as the entry and fail
  // with "Cannot find module .../dev", naming something the user never typed.
  const argv = input[0] === 'dev' ? input.slice(1) : input
  let entry: string | undefined
  let demo = false
  let port = DEFAULT_PORT
  let wtPort = DEFAULT_WT_PORT
  let staticDir: string | undefined
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--demo') demo = true
    else if (a === '--help' || a === '-h') help = true
    else if (a === '--port') port = Number(argv[++i])
    else if (a === '--wt-port') wtPort = Number(argv[++i])
    else if (a === '--static') staticDir = argv[++i]
    else if (!a.startsWith('-')) entry ??= a
  }
  return { entry, demo, port, wtPort, staticDir, help }
}

const USAGE = `transport-io dev - a local WebTransport server with a pinned certificate

  npx transport-io dev [entry]      run your server, with a certificate already minted
  npx transport-io dev --demo       two tabs talking, no project needed

Options
  --demo             serve the built-in demo instead of a project
  --port <n>         HTTP port for the page          (default ${DEFAULT_PORT})
  --wt-port <n>      WebTransport port               (default ${DEFAULT_WT_PORT})
  --static <dir>     directory of files to serve     (default ./public, then ./web)

Your server file should listen with the certificate this command minted:

  import { listenDev } from 'transport-io/node-transport'
  await server.listen(await listenDev())

This does not bundle browser code. Keep running your own bundler and point --static at it.
`

function findStatic(explicit: string | undefined): string | undefined {
  if (explicit !== undefined) return resolve(explicit)
  for (const candidate of ['public', 'web/dist', 'web', 'dist']) {
    const full = resolve(candidate)
    if (existsSync(full)) return full
  }
  return undefined
}

async function main(): Promise<void> {
  const command = process.argv[2]
  const args = parseArgs(process.argv.slice(2))

  if (args.help || command === undefined || (command !== 'dev' && !command.startsWith('-'))) {
    if (command !== undefined && command !== 'dev' && !command.startsWith('-')) {
      console.error(`unknown command '${command}'\n`)
    }
    console.log(USAGE)
    process.exit(args.help ? 0 : 1)
  }

  // `node_modules/.cache` is ignored by every project already, so a private key never lands
  // in a commit and this never edits anyone's .gitignore.
  const cacheDir = resolve('node_modules/.cache/transport-io')
  const cert = ensureCertificate(cacheDir)

  const wtUrl = `https://127.0.0.1:${args.wtPort}/`
  const here = dirname(fileURLToPath(import.meta.url))
  // `dist/cli` -> `dist`, the directory served as ESM to the browser.
  const distDir = resolve(here, '..')

  const staticDir = args.demo ? undefined : findStatic(args.staticDir)
  let demoPage: string | undefined
  if (args.demo) {
    const { DEMO_PAGE, startDemoServer } = await import('./demo.node.ts')
    demoPage = DEMO_PAGE
    process.env.TRANSPORT_IO_DEV_CERT = cert.cert
    process.env.TRANSPORT_IO_DEV_KEY = cert.privKey
    process.env.TRANSPORT_IO_DEV_WT_PORT = String(args.wtPort)
    await startDemoServer()
  }

  await startDevServer({
    port: args.port,
    ...(staticDir === undefined ? {} : { staticDir }),
    ...(demoPage === undefined ? {} : { indexHtml: demoPage }),
    distDir,
    manifest: {
      sha256: [...cert.sha256],
      url: wtUrl,
      expiresAt: cert.validTo.toISOString(),
    },
  })

  const short = Buffer.from(cert.sha256).toString('hex').slice(0, 6)
  console.log('')
  console.log('transport-io dev')
  console.log('')
  console.log(`  page          http://localhost:${args.port}`)
  console.log(`  webtransport  ${wtUrl}`)
  console.log(`  certificate   valid ${daysLeft(cert.validTo)}d  sha-256 ${short}…`)
  if (cert.renewed) {
    console.log('  certificate renewed, so reload any tab you already had open')
  }
  console.log('')
  console.log('  Open the page in two tabs. Chrome or Firefox; Safari cannot connect.')
  if (!args.demo && staticDir === undefined) {
    console.log('')
    console.log('  No static directory found. Pass --static <dir> to serve your built page.')
  }
  console.log('')

  if (!args.demo && args.entry !== undefined) {
    const child = spawn(process.execPath, [args.entry], {
      stdio: 'inherit',
      env: {
        ...process.env,
        TRANSPORT_IO_DEV_CERT: cert.cert,
        TRANSPORT_IO_DEV_KEY: cert.privKey,
        TRANSPORT_IO_DEV_WT_PORT: String(args.wtPort),
      },
    })
    child.on('exit', (code) => process.exit(code ?? 0))
  } else if (!args.demo) {
    console.log('  No entry given, so no server was started. Pass one, or use --demo.')
    console.log('')
  }
}

/**
 * Only when this file is the process entry.
 *
 * Without the guard, importing it to test `parseArgs` runs the whole command: the test
 * printed the usage text and exited. Compared by path rather than `import.meta.main` so it
 * behaves the same under node and bun, and by *real* path on both sides: npm's `bin` is a
 * symlink, `process.argv[1]` keeps the link while `import.meta.url` is its target, and the
 * plain comparison made `npx transport-io` exit 0 having done nothing (D115).
 */
function isEntry(): boolean {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntry()) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
