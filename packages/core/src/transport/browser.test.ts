/**
 * `connectBrowser` turns the browser's opaque handshake failure into a checklist.
 *
 * Measured in Chromium against a real server: a wrong hash, a correct hash for an expired
 * certificate, and nothing listening on the port all produce the same `WebTransportError`
 * with the message "Opening handshake failed.", `code: 0`, and no own enumerable properties.
 * The wrap deliberately does not guess which of the three it was.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { TransportError } from '../errors.ts'
import { connectBrowser } from './browser.ts'

type G = { WebTransport?: unknown }
const g = globalThis as G
const original = g.WebTransport

afterEach(() => {
  if (original === undefined) delete g.WebTransport
  else g.WebTransport = original
})

/**
 * A WebTransport whose `ready` rejects exactly as the real one does, with the probe that
 * follows stubbed silent: a unit test never touches the network, and a test about the probe
 * installs its own answer after this.
 */
function stubFailing(err: unknown): void {
  silent()
  g.WebTransport = class {
    readonly ready = Promise.reject(err)
    readonly closed = new Promise(() => {})
    constructor() {
      // `ready` is rejected at construction; observe it so it is never unhandled.
      void this.ready.catch(() => undefined)
    }
  }
}

describe('a failed handshake becomes a TransportError', () => {
  test('the opaque browser error is wrapped, not propagated raw', async () => {
    const raw = Object.assign(new Error('Opening handshake failed.'), {
      name: 'WebTransportError',
    })
    stubFailing(raw)

    const err = await connectBrowser({ url: 'https://127.0.0.1:4433/' }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).code).toBe('WT_HANDSHAKE_FAILED')
  })

  test('the remedy names all three causes, in the order worth checking', async () => {
    stubFailing(new Error('Opening handshake failed.'))
    const err = (await connectBrowser({ url: 'https://127.0.0.1:4433/' }).catch(
      (e: unknown) => e,
    )) as TransportError

    const remedy = err.remedy
    expect(remedy).toContain('server is running')
    expect(remedy).toContain('14-day')
    expect(remedy).toContain('DER')
    // Ordered: reachability first, then expiry, then the hash itself.
    expect(remedy.indexOf('server is running')).toBeLessThan(remedy.indexOf('14-day'))
    expect(remedy.indexOf('14-day')).toBeLessThan(remedy.indexOf('DER'))
  })

  test('it does not claim to know which cause it was', async () => {
    stubFailing(new Error('Opening handshake failed.'))
    const err = (await connectBrowser({ url: 'https://127.0.0.1:4433/' }).catch(
      (e: unknown) => e,
    )) as TransportError
    // Naming one cause would be a confident wrong answer two times in three.
    expect(err.message).not.toContain('expired')
    expect(err.message).not.toContain('hash does not match')
  })

  test('the original error survives as `cause`, since it is the only artefact', async () => {
    const raw = new Error('Opening handshake failed.')
    stubFailing(raw)
    const err = (await connectBrowser({ url: 'https://127.0.0.1:4433/' }).catch(
      (e: unknown) => e,
    )) as TransportError
    expect((err as { cause?: unknown }).cause).toBe(raw)
  })

  test('the URL is in the message, because a wrong port is a common cause', async () => {
    stubFailing(new Error('nope'))
    const err = (await connectBrowser({ url: 'https://127.0.0.1:9999/' }).catch(
      (e: unknown) => e,
    )) as TransportError
    expect(err.message).toContain('https://127.0.0.1:9999/')
  })
})

/**
 * The probe: the one fact available after the failure, and the code it earns.
 *
 * A blocked UDP path and a dead server produce the same browser error. Whether the origin
 * answers over TCP is what tells them apart, and it is asked only after `ready` rejects.
 */
type FetchGlobals = { fetch?: typeof fetch }
const fg = globalThis as FetchGlobals
const originalFetch = fg.fetch

afterEach(() => {
  if (originalFetch === undefined) delete fg.fetch
  else fg.fetch = originalFetch
})

function answering(): { calls: string[] } {
  const calls: string[] = []
  fg.fetch = (async (url: unknown) => {
    calls.push(String(url))
    return new Response(null, { status: 404 })
  }) as unknown as typeof fetch
  return { calls }
}

function silent(): { calls: string[] } {
  const calls: string[] = []
  fg.fetch = (async (url: unknown) => {
    calls.push(String(url))
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch
  return { calls }
}

/** A WebTransport whose `ready` resolves, with just enough of a session to be wrapped. */
function stubConnecting(): void {
  g.WebTransport = class {
    readonly ready = Promise.resolve()
    readonly closed = new Promise(() => {})
  }
}

describe('the probe splits a blocked UDP path from a dead server', () => {
  test('an origin that answers over HTTPS turns the failure into WT_UDP_UNREACHABLE', async () => {
    stubFailing(new Error('Opening handshake failed.'))
    const { calls } = answering()
    const err = (await connectBrowser({ url: 'https://127.0.0.1:4433/' }).catch(
      (e: unknown) => e,
    )) as TransportError
    expect(err.code).toBe('WT_UDP_UNREACHABLE')
    expect(calls).toEqual(['https://127.0.0.1:4433/.well-known/transport-io'])
    expect(err.remedy).toContain('UDP')
  })

  test('an origin that does not answer keeps WT_HANDSHAKE_FAILED and says so', async () => {
    stubFailing(new Error('Opening handshake failed.'))
    silent()
    const err = (await connectBrowser({ url: 'https://127.0.0.1:4433/' }).catch(
      (e: unknown) => e,
    )) as TransportError
    expect(err.code).toBe('WT_HANDSHAKE_FAILED')
    expect(err.message).toContain('did not answer over HTTPS')
  })

  test('the probe never runs when the handshake succeeds', async () => {
    stubConnecting()
    const { calls } = answering()
    await connectBrowser({ url: 'https://127.0.0.1:4433/' })
    expect(calls).toEqual([])
  })

  test('probe: false never asks, and the message carries no clause about it', async () => {
    stubFailing(new Error('Opening handshake failed.'))
    const { calls } = answering()
    const err = (await connectBrowser({ url: 'https://127.0.0.1:4433/', probe: false }).catch(
      (e: unknown) => e,
    )) as TransportError
    expect(calls).toEqual([])
    expect(err.code).toBe('WT_HANDSHAKE_FAILED')
    expect(err.message).not.toContain('answer')
  })

  test('a custom probe target is asked instead of the origin', async () => {
    stubFailing(new Error('Opening handshake failed.'))
    const { calls } = answering()
    const err = (await connectBrowser({
      url: 'https://127.0.0.1:4433/',
      probe: 'https://edge.example.test/health',
    }).catch((e: unknown) => e)) as TransportError
    expect(calls).toEqual(['https://edge.example.test/health'])
    expect(err.code).toBe('WT_UDP_UNREACHABLE')
  })

  test('the original browser error is still the cause, whichever code it became', async () => {
    const raw = new Error('Opening handshake failed.')
    stubFailing(raw)
    answering()
    const err = (await connectBrowser({ url: 'https://127.0.0.1:4433/' }).catch(
      (e: unknown) => e,
    )) as TransportError
    expect((err as { cause?: unknown }).cause).toBe(raw)
  })
})
