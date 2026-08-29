/**
 * Measure what hover actually shows, instead of quoting a number somebody once saw.
 *
 * D57 says the two-line contract pattern keeps `emit` hover at 126 characters instead of
 * 303, and adds that "the 126-character form is pinned in the type-level test". It is not.
 * `types.test-d.ts` uses the pattern but asserts nothing about hover width, so four
 * documents have been quoting a number nothing checks. Same defect as D69, in a decision
 * rather than a document.
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
  ask: { lane: 'reliable', payload: type$<{ prompt: string }>(), yields: type$<string>() },
})
interface AppMap extends MapOf<typeof contract> {}

declare const withInterface: Client<AppMap>
declare const inline: Client<MapOf<typeof contract>>
withInterface.emit('chat', { from: 'a', body: 'b' })
inline.emit('chat', { from: 'a', body: 'b' })
void withInterface.call('save', { text: 'x' })
void inline.call('save', { text: 'x' })
void withInterface.stream('ask', { prompt: 'x' })
void inline.stream('ask', { prompt: 'x' })
`

/**
 * The React hooks, measured the same way and for the same reason.
 *
 * These are the signatures a React application reads most, and they sit on top of the same
 * contract types, so a validator type leaking into `Registered` shows up here first. There
 * is no interface-versus-inline comparison to make: the hooks are typed off the registered
 * map and have only one form, so each carries a ceiling and nothing else.
 */
const HOOK_PROBE = `import { defineContract, type MapOf, reliable, rpc, streaming } from 'transport-io'
import { createHooks, useCall, useEvent, useStream } from '@transport-io/react'

const contract = defineContract({
  chat: reliable<{ from: string; body: string }>(),
  save: rpc<{ text: string }, { revision: number }>(),
  ask: streaming<{ prompt: string }, string>(),
})
interface AppMap extends MapOf<typeof contract> {}

declare module 'transport-io' {
  interface Register {
    map: AppMap
  }
}

export const api = createHooks<AppMap>()
// The same factory without the interface line, which is what the guides warn against.
export const bare = createHooks<MapOf<typeof contract>>()

export function Probe(): null {
  useEvent('chat', () => {})
  useCall('save')
  useStream('ask')
  api.useEvent('chat', () => {})
  api.useCall('save')
  api.useStream('ask')
  bare.useEvent('chat', () => {})
  return null
}
`

const HOOKS = [
  'useEvent',
  'useCall',
  'useStream',
  'api.useEvent',
  'api.useCall',
  'api.useStream',
] as const

/** Measured from a clean run, and may only go down. */
/**
 * `useCall` and `useStream` grew by 8 characters when `UseCallResult` and `UseStreamResult`
 * gained the map parameter that `createHooks` needs, so their ceilings moved with them.
 * Raising a ceiling is normally the wrong direction; it is right here because the signature
 * grew for a reason, and leaving `useCall` at 104 against 105 would break CI on the next
 * whitespace change in the printer rather than on a regression.
 */
const MAX_HOOK_CHARS: Readonly<Record<string, number>> = {
  useEvent: 130,
  useCall: 114,
  useStream: 140,
  // The factory form carries a `Hooks<AppMap>.` receiver, which is the whole difference.
  'api.useEvent': 140,
  'api.useCall': 120,
  'api.useStream': 145,
}

/**
 * Every method whose hover the two-line pattern is supposed to keep readable, not just the
 * one somebody measured first. `emit` was the only one checked, while D57's claim is about
 * the pattern rather than about `emit`, so a regression in `call` or `stream` was invisible
 * (D98).
 */
const METHODS = ['emit', 'call', 'stream'] as const

function lineOf(prefix: string, method: string): number {
  const want = `${prefix}.${method}(`
  return PROBE.split('\n').findIndex((l) => l.includes(want))
}

/**
 * Ceilings, not equalities. An exact pin would break on every TypeScript patch that changes
 * whitespace in the printer, and a gate that fails for cosmetic reasons gets deleted.
 *
 * `MAX_RATIO` is the claim that actually matters: the interface form must stay
 * substantially smaller than the inline one, because that is the entire argument for
 * writing the second line. An absolute ceiling alone would pass if both forms grew.
 */
/**
 * Per method, because a single ceiling derived from `emit` is not a ceiling for anything
 * else. `emit` takes an event and a payload; `call` adds an options bag and a return type,
 * and is legitimately 60 characters wider. One shared number either fails on `call` or is
 * so loose that `emit` could triple without anyone noticing - and the first version of this
 * gate had exactly that number, set from the only method it measured.
 *
 * Each is the measured width plus about 10%, which absorbs a TypeScript printer whitespace
 * change without absorbing a regression.
 */
const MAX_INTERFACE_CHARS: Readonly<Record<string, number>> = {
  emit: 120,
  call: 186,
  stream: 173,
}
const MAX_RATIO = 0.75

/**
 * The hook equivalent of `MAX_RATIO`, and the reason the guides tell you to write the
 * `MapOf` line.
 *
 * `createHooks<AppMap>()` and `createHooks<MapOf<typeof contract>>()` are the same call; the
 * only difference is whether the map has a name. Handing in the alias expands it, and the
 * hover fills with the validator's internals. If that gap ever closes the advice stops being
 * worth giving, which a ceiling on the good form alone would never notice.
 *
 * This exists because both guides quoted the bad number with nothing behind it, and an
 * ungated number in two documents is a shape that has drifted in this repository before.
 */
const MAX_HOOK_RATIO = 0.5

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
writeFileSync(join(DIR, 'hooks-probe.tsx'), HOOK_PROBE)

const lsp = start()
const uri = `file://${join(DIR, 'probe.ts')}`
const hookUri = `file://${join(DIR, 'hooks-probe.tsx')}`
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
  lsp.notify('textDocument/didOpen', {
    textDocument: {
      uri: hookUri,
      languageId: 'typescriptreact',
      version: 1,
      text: HOOK_PROBE,
    },
  })
  // The project has to load before hover means anything. A null answer here reads as a
  // pass if it is not distinguished from a real one, so it is treated as a failure below.
  await new Promise((r) => setTimeout(r, 3000))

  const measure = async (line: number, label: string, method: string): Promise<number> => {
    // On the method name, computed rather than guessed: a fixed column lands inside a
    // string literal on the shorter line and the server answers with nothing at all.
    const character = (PROBE.split('\n')[line] ?? '').indexOf(`.${method}`) + 2
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

  console.log('hover width against the README contract\n')
  for (const method of METHODS) {
    const withInterface = await measure(
      lineOf('withInterface', method),
      `${method} interface`,
      method,
    )
    const inline = await measure(lineOf('inline', method), `${method} inline`, method)
    if (!Number.isFinite(withInterface) || !Number.isFinite(inline)) continue

    const ceiling = MAX_INTERFACE_CHARS[method] ?? 0
    if (ceiling === 0) {
      problems.push(`\`${method}\` has no ceiling; add one measured from a clean run.`)
    } else if (withInterface > ceiling) {
      problems.push(
        `\`${method}\` hovers at ${withInterface} characters with the two-line form, over the ` +
          `${ceiling} ceiling.\n` +
          '    Something leaked a validator type into the public signature.',
      )
    }
    const ratio = withInterface / inline
    if (ratio > MAX_RATIO) {
      problems.push(
        `\`${method}\` is ${(ratio * 100).toFixed(0)}% of the inline form, over the ` +
          `${MAX_RATIO * 100}% ceiling.\n` +
          '    D57 exists because that gap is large. If it closes, the advice stops being worth giving.',
      )
    }
    console.log(
      `  ${method.padEnd(7)} ${String(withInterface).padStart(4)} chars ` +
        `(ceiling ${ceiling})   interface/inline = ${(ratio * 100).toFixed(0)}%`,
    )
    console.log('')
  }
  console.log('\nreact hook hover width\n')
  const hookLines = HOOK_PROBE.split('\n')
  for (const hook of HOOKS) {
    // `api.useEvent(` and `useEvent(` both appear, so the dotted form has to be matched
    // exactly rather than by suffix, or the bare one wins and both report the same number.
    const line = hookLines.findIndex((l) =>
      hook.startsWith('api.') ? l.includes(`${hook}(`) : l.trimStart().startsWith(`${hook}(`),
    )
    if (line < 0) {
      problems.push(`${hook}: not found in the hook probe, so nothing was measured`)
      continue
    }
    const needle = hook.startsWith('api.') ? hook.slice('api.'.length) : hook
    const character = (hookLines[line] ?? '').indexOf(needle) + 2
    const hover = await Promise.race([
      lsp.request('textDocument/hover', {
        textDocument: { uri: hookUri },
        position: { line, character },
      }),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 20_000)),
    ])
    const sig = hover === undefined ? undefined : signatureOf(hover)
    if (sig === undefined || sig.length === 0) {
      problems.push(`${hook}: the language server returned no hover, so nothing was measured`)
      continue
    }
    const ceiling = MAX_HOOK_CHARS[hook] ?? 0
    if (ceiling === 0) {
      problems.push(`\`${hook}\` has no ceiling; add one measured from a clean run.`)
    } else if (sig.length > ceiling) {
      problems.push(
        `\`${hook}\` hovers at ${sig.length} characters, over the ${ceiling} ceiling.\n` +
          '    Something leaked a validator or contract internal into the hook signature.',
      )
    }
    console.log(
      `  ${hook.padEnd(10)} ${String(sig.length).padStart(4)} chars (ceiling ${ceiling})`,
    )
    console.log(`             ${sig}`)
  }

  const measureHook = async (label: string): Promise<number> => {
    const line = hookLines.findIndex((l) => l.includes(`${label}(`))
    if (line < 0) return Number.NaN
    const needle = label.includes('.') ? label.slice(label.indexOf('.') + 1) : label
    const hover = await lsp.request('textDocument/hover', {
      textDocument: { uri: hookUri },
      position: { line, character: (hookLines[line] ?? '').indexOf(needle) + 2 },
    })
    const sig = signatureOf(hover)
    return sig === undefined || sig.length === 0 ? Number.NaN : sig.length
  }

  const named = await measureHook('api.useEvent')
  const anonymous = await measureHook('bare.useEvent')
  if (!Number.isFinite(named) || !Number.isFinite(anonymous)) {
    problems.push('the named/anonymous hook comparison measured nothing')
  } else {
    const ratio = named / anonymous
    console.log(
      `\n  api.useEvent ${named} chars against ${anonymous} without the interface line ` +
        `(${(ratio * 100).toFixed(0)}%, ceiling ${MAX_HOOK_RATIO * 100}%)`,
    )
    if (ratio > MAX_HOOK_RATIO) {
      problems.push(
        `naming the map saves only ${(100 - ratio * 100).toFixed(0)}% of the hover, under the ` +
          `${(100 - MAX_HOOK_RATIO * 100).toFixed(0)}% the guides claim.\n` +
          '    Either the gap closed and the advice should go, or something regressed.',
      )
    }
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
