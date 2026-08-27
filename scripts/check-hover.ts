/**
 * Measure what hover actually shows, instead of quoting a number somebody once saw.
 *
 * D57 says the two-line contract pattern keeps `emit` hover at 126 characters instead of
 * 303, and adds that "the 126-character form is pinned in the type-level test". It is not.
 * `types.test-d.ts` uses the pattern but asserts nothing about hover width, so four
 * documents have been quoting a number nothing checks. That is the D69 defect wearing a
 * decision's clothes: a promise written down, believed, and never wired to anything.
 *
 * This wires it up. TypeScript 7.0 has no compiler API until 7.1, but `tsc --lsp --stdio`
 * speaks LSP, and `textDocument/hover` returns exactly the string an editor renders.
 *
 * The measurement is contract-dependent, which is the other half of the finding: hover
 * width is a property of *your contract*, not of this library. A number quoted without the
 * contract that produced it cannot be reproduced by anyone. So the probe below pins the
 * canonical README contract, and the numbers this prints are only meaningful with it.
 *
 *   bun run scripts/check-hover.ts
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DIR = join(ROOT, '.hover-check')

/**
 * The README's contract, verbatim in shape. Changing it changes the numbers, which is why
 * it is here and not improvised: the bound below is only meaningful against this input.
 */
const PROBE = `import { Client, defineContract, type MapOf, type$ } from 'transport-io'

const contract = defineContract({
  chat: { lane: 'reliable', payload: type$<{ from: string; body: string }>() },
  cursor: { lane: 'unreliable', payload: type$<{ x: number; y: number }>() },
  save: {
    lane: 'reliable',
    payload: type$<{ text: string }>(),
    returns: type$<{ revision: number }>(),
  },
})
interface AppMap extends MapOf<typeof contract> {}

declare const withInterface: Client<AppMap>
declare const inline: Client<MapOf<typeof contract>>
withInterface.emit('chat', { from: 'a', body: 'b' })
inline.emit('chat', { from: 'a', body: 'b' })
`

/** 0-based, and the two call lines are the last two. */
const LINE_INTERFACE = PROBE.split('\n').findIndex((l) => l.startsWith('withInterface.emit'))
const LINE_INLINE = PROBE.split('\n').findIndex((l) => l.startsWith('inline.emit'))

/**
 * Ceilings, not equalities. An exact pin would break on every TypeScript patch that changes
 * whitespace in the printer, and a gate that fails for cosmetic reasons gets deleted.
 *
 * `MAX_RATIO` is the claim that actually matters: the interface form must stay
 * substantially smaller than the inline one, because that is the entire argument for
 * writing the second line. An absolute ceiling alone would pass if both forms grew.
 */
const MAX_INTERFACE_CHARS = 160
const MAX_RATIO = 0.75

interface Lsp {
  request(method: string, params: unknown): Promise<Record<string, unknown>>
  notify(method: string, params: unknown): void
  stop(): void
}

function start(): Lsp {
  const proc = spawn('node_modules/.bin/tsc', ['--lsp', '--stdio'], { cwd: ROOT })
  const write = (o: unknown): void => {
    const s = JSON.stringify(o)
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(s, 'utf8')}\r\n\r\n${s}`)
  }
  const pending = new Map<number, (v: Record<string, unknown>) => void>()
  let buf = Buffer.alloc(0)
  proc.stdout.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      const i = buf.indexOf('\r\n\r\n')
      if (i < 0) return
      const m = /Content-Length: (\d+)/i.exec(buf.subarray(0, i).toString())
      if (m === null) return
      const len = Number(m[1])
      if (buf.length < i + 4 + len) return
      const msg = JSON.parse(buf.subarray(i + 4, i + 4 + len).toString()) as {
        id?: number
        method?: string
      }
      buf = buf.subarray(i + 4 + len)
      if (msg.id !== undefined && msg.method === undefined) {
        pending.get(msg.id)?.(msg as Record<string, unknown>)
        pending.delete(msg.id)
      } else if (msg.id !== undefined) {
        // The server registers capabilities back at us and waits for an answer. Ignoring
        // these deadlocks the session before the first hover.
        write({ jsonrpc: '2.0', id: msg.id, result: {} })
      }
    }
  })
  let id = 0
  return {
    request(method, params) {
      const msg = { jsonrpc: '2.0', id: ++id, method, params }
      write(msg)
      return new Promise((res) => pending.set(msg.id, res))
    },
    notify(method, params) {
      write({ jsonrpc: '2.0', method, params })
    },
    stop() {
      proc.kill()
    },
  }
}

/** The signature only. The doc comment is identical in both forms and is not type noise. */
function signatureOf(hover: unknown): string | undefined {
  const contents = (hover as { result?: { contents?: unknown } } | undefined)?.result?.contents
  const text =
    typeof contents === 'string'
      ? contents
      : ((contents as { value?: string } | undefined)?.value ?? undefined)
  if (text === undefined) return undefined
  const fenced = /```(?:typescript|ts)?\n([\s\S]*?)```/.exec(text)
  const body = fenced?.[1] ?? text
  // Everything up to the return type; the JSDoc that follows is documentation.
  const end = body.indexOf('): void')
  return (end < 0 ? body : body.slice(0, end + 7)).trim()
}

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
writeFileSync(
  join(DIR, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: 'preserve',
      moduleResolution: 'bundler',
      target: 'es2023',
      skipLibCheck: true,
      paths: { 'transport-io': ['../packages/core/src/index.ts'] },
    },
    include: ['probe.ts'],
  }),
)
writeFileSync(join(DIR, 'probe.ts'), PROBE)

const lsp = start()
const uri = `file://${join(DIR, 'probe.ts')}`
const problems: string[] = []

try {
  await lsp.request('initialize', {
    processId: process.pid,
    rootUri: `file://${ROOT}`,
    capabilities: { textDocument: { hover: { contentFormat: ['markdown', 'plaintext'] } } },
    workspaceFolders: [{ uri: `file://${ROOT}`, name: 'transport-io' }],
  })
  lsp.notify('initialized', {})
  lsp.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'typescript', version: 1, text: PROBE },
  })
  // The project has to load before hover means anything. A null answer here reads as a
  // pass if it is not distinguished from a real one, so it is treated as a failure below.
  await new Promise((r) => setTimeout(r, 3000))

  const measure = async (line: number, label: string): Promise<number> => {
    // On the method name, computed rather than guessed: a fixed column lands inside a
    // string literal on the shorter line and the server answers with nothing at all.
    const character = (PROBE.split('\n')[line] ?? '').indexOf('.emit') + 2
    const hover = await Promise.race([
      lsp.request('textDocument/hover', {
        textDocument: { uri },
        position: { line, character },
      }),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 20_000)),
    ])
    const sig = hover === undefined ? undefined : signatureOf(hover)
    if (sig === undefined || sig.length === 0) {
      problems.push(`${label}: the language server returned no hover, so nothing was measured`)
      return Number.NaN
    }
    console.log(`  ${label.padEnd(10)} ${String(sig.length).padStart(4)} chars   ${sig}`)
    return sig.length
  }

  console.log('hover width for `emit`, against the README contract\n')
  const withInterface = await measure(LINE_INTERFACE, 'interface')
  const inline = await measure(LINE_INLINE, 'inline')

  if (Number.isFinite(withInterface) && Number.isFinite(inline)) {
    console.log('')
    if (withInterface > MAX_INTERFACE_CHARS) {
      problems.push(
        `the two-line form hovers at ${withInterface} characters, over the ${MAX_INTERFACE_CHARS} ceiling.\n` +
          '    Something leaked a validator type into the public signature.',
      )
    }
    const ratio = withInterface / inline
    if (ratio > MAX_RATIO) {
      problems.push(
        `the two-line form is ${(ratio * 100).toFixed(0)}% of the inline form, over the ${MAX_RATIO * 100}% ceiling.\n` +
          '    D57 exists because that gap is large. If it closes, the advice stops being worth giving.',
      )
    }
    console.log(
      `  interface / inline = ${(ratio * 100).toFixed(0)}%   ceiling ${MAX_RATIO * 100}%, ` +
        `absolute ceiling ${MAX_INTERFACE_CHARS}`,
    )
  }
} finally {
  lsp.stop()
  rmSync(DIR, { recursive: true, force: true })
}

for (const p of problems) console.error(`\n${p}`)
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s).`)
  process.exit(1)
}
console.log('\nhover: measured, not quoted')
