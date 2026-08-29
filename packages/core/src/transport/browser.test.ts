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

/** A WebTransport whose `ready` rejects exactly as the real one does. */
function stubFailing(err: unknown): void {
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
