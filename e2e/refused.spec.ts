import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ensureCertificate } from '../packages/core/dist/cli/certificate.node.js'
import {
  createServer,
  defineContract,
  type MapOf,
  refuse,
  reliable,
  type ServerPeer,
} from '../packages/core/dist/index.js'
import { listenHttp3 } from '../packages/core/dist/transport/fails.node.js'
import { DEMO_ORIGIN } from '../playwright.config.ts'

/**
 * A refusal in a real browser, which is where it went wrong. Chromium fails the stream the
 * client opens before `closed` has delivered the code, so the page saw `WT_SESSION_CLOSED`
 * where Node saw `WT_UNAUTHORIZED`, and an application's "sign in again" never appeared.
 * And the loop: a client that reconnects on its own and is refused stops, where it used to
 * say "offline, retrying" for as long as anyone watched.
 */

const contract = defineContract({ chat: reliable<{ body: string }>() })
interface AppMap extends MapOf<typeof contract> {}
interface Who {
  user: string
}

test('a refused page sees WT_UNAUTHORIZED and the reason, and a refused reconnect stops', async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'refused-e2e-'))
  const cert = ensureCertificate(dir)
  let valid = 'first'
  const asked: string[] = []
  const origins: (string | undefined)[] = []
  const listener = await listenHttp3<Who>({
    port: 0,
    host: '127.0.0.1',
    cert: cert.cert,
    privKey: cert.privKey,
    path: '/',
    authorize: ({ query, headers }) => {
      const token = query.get('token') ?? ''
      asked.push(token)
      origins.push(headers['origin'])
      return token === valid ? { user: 'ann' } : refuse('expired')
    },
  })
  const server = createServer<AppMap, Who>({ contract })
  const peers: ServerPeer<AppMap, Who>[] = []
  server.onSession((peer) => peers.push(peer))
  await server.listen(listener)

  try {
    await page.goto(DEMO_ORIGIN)
    const setup = { origin: DEMO_ORIGIN, port: listener.port, hash: [...cert.sha256] }

    // At the door, on the first connect.
    const atTheDoor = await page.evaluate(async ({ origin, port, hash }) => {
      const core = await import(`${origin}/_transport-io/index.js`)
      const browser = await import(`${origin}/_transport-io/transport/browser.js`)
      const client = new core.Client({
        contract: core.defineContract({ chat: core.reliable() }),
        connect: () =>
          browser.connectBrowser({
            url: `https://127.0.0.1:${port}/?token=stale`,
            certificateHash: new Uint8Array(hash),
            probe: false,
          }),
      })
      try {
        await client.connect()
        return { connected: true }
      } catch (e) {
        const err = e as { code?: string; reason?: string }
        const state = client.getSnapshot()
        return {
          connected: false,
          code: err.code,
          reason: err.reason,
          isRefusedError: e instanceof core.RefusedError,
          status: state.status,
          refused: state.refused,
        }
      }
    }, setup)
    expect(atTheDoor).toEqual({
      connected: false,
      code: 'WT_UNAUTHORIZED',
      reason: 'expired',
      isRefusedError: true,
      status: 'closed',
      refused: { reason: 'expired' },
    })
    // The library checks no origin, so an application that wants one checked does it here:
    // the browser puts the page's origin on the request, and `authorize` is handed it.
    expect(origins).toEqual([DEMO_ORIGIN])

    // On a reconnect: connected with a token that then stops being valid.
    asked.length = 0
    const connected = await page.evaluate(async ({ origin, port, hash }) => {
      const core = await import(`${origin}/_transport-io/index.js`)
      const browser = await import(`${origin}/_transport-io/transport/browser.js`)
      const client = new core.Client({
        contract: core.defineContract({ chat: core.reliable() }),
        reconnect: { minMs: 100, maxMs: 200 },
        connect: () =>
          browser.connectBrowser({
            url: `https://127.0.0.1:${port}/?token=first`,
            certificateHash: new Uint8Array(hash),
            probe: false,
          }),
      })
      ;(window as unknown as { client: unknown }).client = client
      await client.connect()
      return client.getSnapshot().status
    }, setup)
    expect(connected).toBe('connected')
    await expect.poll(() => peers.length).toBe(1)

    valid = 'second'
    peers[0]?.close(0, 'restart')
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  client: { getSnapshot: () => { refused: { reason: string } | null } }
                }
              ).client.getSnapshot().refused,
          ),
        { timeout: 10_000 },
      )
      .toEqual({ reason: 'expired' })
    // Fifteen of the longest waits later, the door has been asked once more and no more.
    await page.waitForTimeout(3_000)
    expect(asked).toEqual(['first', 'first'])
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as { client: { getSnapshot: () => { status: string } } }
          ).client.getSnapshot().status,
      ),
    ).toBe('closed')
  } finally {
    listener.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
