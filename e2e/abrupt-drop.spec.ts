import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEMO_ORIGIN } from '../playwright.config.ts'

/**
 * The parity suite's abrupt case, for the transport that had the defect: the browser's.
 *
 * A server in a process of its own is killed with SIGKILL under a connected page. The
 * platform rejects the session's `closed`, and the page has to leave `connected`, reconnect
 * once the server is back, and leave no rejection unhandled on the way. Before the seam's
 * rule (`transport/closed.ts`) the page said `connected` for as long as anyone watched.
 *
 * The session is held past one liveness probe first, so this is also where a real browser
 * is shown the reference server's empty datagram and carries on.
 *
 * The server is the parity suite's own peer: its test file, run with `PARITY_PEER=server`.
 */

const PEER = join(
  import.meta.dirname,
  '../packages/core/src/transport-parity-fails.node.test.ts',
)

function mint(): { dir: string; certPath: string; keyPath: string; hash: number[] } {
  const dir = mkdtempSync(join(tmpdir(), 'abrupt-e2e-'))
  const keyPath = join(dir, 'k.pem')
  const certPath = join(dir, 'c.pem')
  execFileSync('openssl', [
    'ecparam',
    '-name',
    'prime256v1',
    '-genkey',
    '-noout',
    '-out',
    keyPath,
  ])
  execFileSync(
    'openssl',
    [
      'req',
      '-new',
      '-x509',
      '-key',
      keyPath,
      '-out',
      certPath,
      '-days',
      '14',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  const der = new X509Certificate(readFileSync(certPath, 'utf8')).raw
  return { dir, certPath, keyPath, hash: [...createHash('sha256').update(der).digest()] }
}

async function serve(port: number, certPath: string, keyPath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [PEER], {
    env: {
      ...process.env,
      PARITY_PEER: 'server',
      PARITY_PORT: String(port),
      PARITY_CERT: certPath,
      PARITY_KEY: keyPath,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (d: Buffer) => {
      if (String(d).includes('parity-peer ready')) resolve()
    })
    child.once('exit', (code) => reject(new Error(`the peer exited early, code ${code}`)))
  })
  return child
}

test('a page notices a server killed with no close handshake, and reconnects to the next one', async ({
  page,
}) => {
  test.setTimeout(150_000)
  const { dir, certPath, keyPath, hash } = mint()
  const port = 40000 + Math.floor(Math.random() * 20000)
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  let server: ChildProcess | undefined = await serve(port, certPath, keyPath)

  try {
    await page.goto(DEMO_ORIGIN)
    const first = await page.evaluate(
      async ({ origin, port, hash }) => {
        const core = await import(`${origin}/_transport-io/index.js`)
        const browser = await import(`${origin}/_transport-io/transport/browser.js`)
        const contract = core.defineContract({
          chat: core.reliable(),
          cursor: core.unreliable({ fallback: 'newest' }),
        })
        const client = new core.Client({
          contract,
          reconnect: { minMs: 250, maxMs: 1000 },
          connect: () =>
            browser.connectBrowser({
              url: `https://127.0.0.1:${port}/`,
              certificateHash: new Uint8Array(hash),
              probe: false,
            }),
        })
        const w = window as unknown as {
          client: typeof client
          statuses: string[]
          chat: string[]
          sessions: number
        }
        w.client = client
        w.statuses = []
        w.chat = []
        w.sessions = 0
        client.subscribe(() => w.statuses.push(client.getSnapshot().status))
        client.onSession(() => w.sessions++)
        client.on('chat', (p: { body: string }) => w.chat.push(p.body))
        await client.connect()
        return client.getSnapshot().status
      },
      { origin: DEMO_ORIGIN, port, hash },
    )
    expect(first).toBe('connected')

    // Past one liveness probe: the empty datagram reaches a real browser and nothing happens.
    await page.waitForTimeout(17_000)
    await page.evaluate(() => {
      const w = window as unknown as { client: { emit: (e: string, p: unknown) => void } }
      w.client.emit('chat', { body: 'after the probe' })
    })
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { chat: string[] }).chat), {
        timeout: 5_000,
      })
      .toEqual(['after the probe'])
    expect(
      await page.evaluate(() =>
        (window as unknown as { statuses: string[] }).statuses.includes('closed'),
      ),
    ).toBe(false)

    const killedAt = Date.now()
    server.kill('SIGKILL')
    server = undefined
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (window as unknown as { statuses: string[] }).statuses.includes('closed'),
          ),
        {
          timeout: 45_000,
          message: 'the page never left connected after the server was killed',
        },
      )
      .toBe(true)
    console.log(`  the page noticed the killed server after ${Date.now() - killedAt} ms`)

    // The same port and certificate, as a restarted server is, and the client comes back.
    server = await serve(port, certPath, keyPath)
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { sessions: number }).sessions), {
        timeout: 30_000,
        message: 'the page never reconnected to the restarted server',
      })
      .toBe(2)
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as { client: { getSnapshot: () => { status: string } } }
          ).client.getSnapshot().status,
      ),
    ).toBe('connected')
    expect(pageErrors).toEqual([])

    await page.evaluate(() => {
      ;(window as unknown as { client: { disconnect: () => void } }).client.disconnect()
    })
  } finally {
    server?.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
