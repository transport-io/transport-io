/**
 * `connectDev` refuses anywhere that is not loopback.
 *
 * These are the tests that matter for this file. The happy path is `connectBrowser`, which
 * has its own coverage; what is unique here is a promise that the function cannot be used in
 * production, and a promise like that is only worth what its refusals are worth.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { TransportError } from '../errors.ts'
import { connectDev, DEV_ENDPOINT } from './dev.ts'

type Globals = {
  location?: { hostname?: string }
  fetch?: typeof fetch
}
const g = globalThis as Globals
const originalFetch = g.fetch

afterEach(() => {
  delete g.location
  if (originalFetch === undefined) delete g.fetch
  else g.fetch = originalFetch
})

function servePage(hostname: string): void {
  g.location = { hostname }
}

function serveManifest(body: unknown, ok = true, status = 200): void {
  g.fetch = (async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch
}

describe('the page origin must be loopback', () => {
  for (const host of ['example.com', 'app.internal', '10.0.0.5', 'localhost.evil.com', '']) {
    test(`refuses a page served from ${host === '' ? '<empty>' : host}`, async () => {
      servePage(host)
      serveManifest({ sha256: [1, 2, 3], url: 'https://127.0.0.1:4433/' })
      const err = await connectDev().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TransportError)
      expect((err as TransportError).code).toBe('WT_DEV_ONLY')
      expect((err as TransportError).message).toContain('page origin')
    })
  }

  test('refuses outright when there is no browser at all', async () => {
    delete g.location
    const err = await connectDev().catch((e: unknown) => e)
    expect((err as TransportError).code).toBe('WT_DEV_ONLY')
  })
})

describe('the WebTransport URL must be loopback too', () => {
  test('a loopback page handed a remote target is still refused', async () => {
    // The manifest is data from the network. A page on localhost that fetches a manifest
    // pointing at someone else's host must not connect to it with a pinned hash.
    servePage('localhost')
    serveManifest({ sha256: [1, 2, 3], url: 'https://evil.example.com:4433/' })
    const err = await connectDev().catch((e: unknown) => e)
    expect((err as TransportError).code).toBe('WT_DEV_ONLY')
    expect((err as TransportError).message).toContain('WebTransport URL')
  })

  test('a malformed URL is refused rather than passed through', async () => {
    servePage('localhost')
    serveManifest({ sha256: [1], url: 'not a url' })
    const err = await connectDev().catch((e: unknown) => e)
    expect((err as TransportError).code).toBe('WT_DEV_ONLY')
  })
})

describe('the manifest itself is checked', () => {
  test('a missing endpoint names the command that serves it', async () => {
    servePage('localhost')
    serveManifest(null, false, 404)
    const err = await connectDev().catch((e: unknown) => e)
    expect((err as TransportError).code).toBe('WT_DEV_ONLY')
    expect((err as TransportError).remedy).toContain('transport-io dev')
  })

  test('a wrong shape is refused rather than coerced', async () => {
    servePage('localhost')
    serveManifest({ nope: true })
    const err = await connectDev().catch((e: unknown) => e)
    expect((err as TransportError).message).toContain('{sha256, url}')
  })
})

describe('an expired certificate is refused before dialling', () => {
  const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString()

  test('a manifest whose certificate has expired throws WT_CERT_EXPIRED', async () => {
    servePage('localhost')
    serveManifest({ sha256: [1], url: 'https://127.0.0.1:4433/', expiresAt: iso(-60_000) })
    const err = await connectDev().catch((e: unknown) => e)
    expect((err as TransportError).code).toBe('WT_CERT_EXPIRED')
    expect((err as TransportError).remedy).toContain('transport-io dev')
  })

  test('it fires before the URL check, because it is the more useful answer', async () => {
    // A remote URL would normally be refused with WT_DEV_ONLY. Expiry is the real problem
    // here and it is a fact rather than an inference, so it must win.
    servePage('localhost')
    serveManifest({ sha256: [1], url: 'https://evil.example.com/', expiresAt: iso(-1) })
    const err = await connectDev().catch((e: unknown) => e)
    expect((err as TransportError).code).toBe('WT_CERT_EXPIRED')
  })

  test('a certificate still inside its window is not refused for expiry', async () => {
    servePage('localhost')
    // Gets past expiry and fails on the target instead, which is how we know it passed.
    serveManifest({ sha256: [1], url: 'https://example.com/', expiresAt: iso(60_000) })
    const err = await connectDev().catch((e: unknown) => e)
    expect((err as TransportError).code).toBe('WT_DEV_ONLY')
  })

  test('an older dev server that publishes no expiresAt still works', async () => {
    servePage('localhost')
    serveManifest({ sha256: [1], url: 'https://example.com/' })
    const err = await connectDev().catch((e: unknown) => e)
    // Not WT_CERT_EXPIRED: a missing field is unknown, not expired.
    expect((err as TransportError).code).toBe('WT_DEV_ONLY')
  })

  test('an unparseable expiresAt is ignored rather than treated as expired', async () => {
    servePage('localhost')
    serveManifest({ sha256: [1], url: 'https://example.com/', expiresAt: 'not a date' })
    const err = await connectDev().catch((e: unknown) => e)
    expect((err as TransportError).code).toBe('WT_DEV_ONLY')
  })
})

describe('the endpoint is fixed so neither side configures it', () => {
  test('the default path is the well-known one', () => {
    expect(DEV_ENDPOINT).toBe('/.well-known/transport-io-dev')
  })

  test('every loopback spelling is accepted as a page origin', async () => {
    // Proven by getting PAST the page check and failing on the target instead.
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      servePage(host)
      serveManifest({ sha256: [1], url: 'https://example.com/' })
      const err = await connectDev().catch((e: unknown) => e)
      expect((err as TransportError).message).toContain('WebTransport URL')
    }
  })
})
