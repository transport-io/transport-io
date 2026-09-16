/**
 * The CLI through the path npm actually runs it by.
 *
 * `node_modules/.bin/transport-io` is a symlink, and the entry guard compared
 * `process.argv[1]`, which keeps the link, with `import.meta.url`, which is the target. The
 * two never matched, so `npx transport-io dev --demo` exited 0 without printing a line, in
 * every release that had the guard. Nothing caught it because every test and every e2e ran
 * `node dist/cli/main.node.js` on the real path. This runs the symlink.
 */
import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), 'main.node.ts')

const usageThrough = (entry: string): string =>
  execFileSync(process.execPath, [entry, '--help'], { encoding: 'utf8', stdio: 'pipe' })

test('the usage prints through an extensionless symlink, as it does on the real path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transport-io-bin-'))
  try {
    // Named as npm names it: no extension, so the loader has to reach the target itself.
    const link = join(dir, 'transport-io')
    symlinkSync(MAIN, link)
    const direct = usageThrough(MAIN)
    const linked = usageThrough(link)
    assert.match(direct, /transport-io dev/)
    assert.equal(linked, direct)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A port nothing holds, learned by binding it once and letting it go. */
async function freePort(): Promise<number> {
  const s = createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const port = (s.address() as AddressInfo).port
  s.close()
  await once(s, 'close')
  return port
}

/** Runs the demo and collects its output until it exits or `until` matches. */
function runDemo(
  port: number,
  wtPort: number,
  until: RegExp | undefined,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(
      process.execPath,
      [MAIN, 'dev', '--demo', '--port', String(port), '--wt-port', String(wtPort)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    const settle = (code: number | null): void => resolve({ code, out })
    const onData = (chunk: Buffer): void => {
      out += chunk.toString()
      if (until !== undefined && until.test(out)) {
        child.kill()
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', settle)
    // Never hang a test on a server that started when it should have refused.
    setTimeout(() => child.kill(), 15_000).unref()
  })
}

test('the dev command prints the address it binds, and exits with WT_PORT_IN_USE on a port held on ::', async () => {
  const port = await freePort()
  const wtPort = await freePort()
  const free = await runDemo(port, wtPort, /webtransport\s+https/)
  assert.match(free.out, new RegExp(`page\\s+http://127\\.0\\.0\\.1:${port}`))
  assert.doesNotMatch(free.out, /localhost/)

  // Their case: a dev server on every IPv6 address, which `127.0.0.1` binds beside.
  const holder = createServer()
  holder.listen(port, '::')
  await once(holder, 'listening')
  try {
    const taken = await runDemo(port, wtPort, undefined)
    assert.equal(taken.code, 1)
    assert.match(taken.out, /WT_PORT_IN_USE/)
    assert.match(taken.out, new RegExp(`answers on (127\\.0\\.0\\.1|\\[::1\\]):${port}`))
  } finally {
    holder.close()
  }
})

test('a WebTransport port another socket holds exits with WT_PORT_IN_USE rather than starting silently', async () => {
  const port = await freePort()
  const wtPort = await freePort()
  const holder = createSocket('udp4')
  holder.bind(wtPort, '127.0.0.1')
  await once(holder, 'listening')
  try {
    const taken = await runDemo(port, wtPort, undefined)
    assert.equal(taken.code, 1)
    assert.match(taken.out, /WT_PORT_IN_USE/)
    assert.match(taken.out, new RegExp(`UDP port ${wtPort}`))
  } finally {
    holder.close()
  }
})
