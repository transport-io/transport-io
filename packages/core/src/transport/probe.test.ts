/**
 * The probe asks one question and is shaped so the answer cannot be faked: no cache, no
 * credentials, no body, and a budget it cannot outlive.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { handshakeFailure, PROBE_BUDGET_MS, PROBE_PATH, probe, probeTarget } from './probe.ts'

type Globals = { fetch?: typeof fetch }
const g = globalThis as Globals
const originalFetch = g.fetch

afterEach(() => {
  if (originalFetch === undefined) delete g.fetch
  else g.fetch = originalFetch
})

describe('the target', () => {
  test('is the origin of the WebTransport URL at the fixed path', () => {
    expect(probeTarget('https://127.0.0.1:4433/')).toBe(`https://127.0.0.1:4433${PROBE_PATH}`)
    expect(probeTarget('https://example.test/sessions?x=1')).toBe(
      `https://example.test${PROBE_PATH}`,
    )
  })

  test('is undefined for a URL that does not parse, rather than a throw', () => {
    expect(probeTarget('not a url')).toBeUndefined()
  })
})

describe('the request', () => {
  test('is a HEAD with no CORS opt-in, no cache and no credentials', async () => {
    let seen: { url: unknown; init: RequestInit | undefined } | undefined
    g.fetch = (async (url: unknown, init?: RequestInit) => {
      seen = { url, init }
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch

    expect(await probe('https://h/.well-known/transport-io')).toBe('answered')
    expect(seen?.url).toBe('https://h/.well-known/transport-io')
    expect(seen?.init?.method).toBe('HEAD')
    expect(seen?.init?.mode).toBe('no-cors')
    expect(seen?.init?.cache).toBe('no-store')
    expect(seen?.init?.credentials).toBe('omit')
    expect(seen?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  test('any status is an answer, because a 404 still proves TCP, TLS and HTTP reached a server', async () => {
    g.fetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch
    expect(await probe('https://h/x')).toBe('answered')
  })

  test('a network error is unanswered', async () => {
    g.fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect(await probe('https://h/x')).toBe('unanswered')
  })

  test('a probe that outlives its budget is unanswered, and the budget is what cuts it', async () => {
    g.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as unknown as typeof fetch
    const started = performance.now()
    expect(await probe('https://h/x', 30)).toBe('unanswered')
    expect(performance.now() - started).toBeLessThan(PROBE_BUDGET_MS)
  })

  test('a runtime with no fetch skips rather than reporting the server unreachable', async () => {
    delete g.fetch
    expect(await probe('https://h/x')).toBe('skipped')
  })
})

describe('what the failure becomes', () => {
  const url = 'https://127.0.0.1:4433/'
  const target = `https://127.0.0.1:4433${PROBE_PATH}`
  const raw = new Error('Opening handshake failed.')

  test('answered is the one case with its own code, and it names the origin', () => {
    const e = handshakeFailure(url, target, 'answered', raw)
    expect(e.code).toBe('WT_UDP_UNREACHABLE')
    expect(e.message).toContain('https://127.0.0.1:4433 answers over HTTPS')
    expect(e.remedy).toContain('UDP')
    expect(e.remedy).toContain('no UDP ingress')
    expect((e as { cause?: unknown }).cause).toBe(raw)
  })

  test('unanswered keeps the generic code and says the origin did not answer', () => {
    const e = handshakeFailure(url, target, 'unanswered', raw)
    expect(e.code).toBe('WT_HANDSHAKE_FAILED')
    expect(e.message).toContain(`${target} did not answer over HTTPS`)
    expect((e as { cause?: unknown }).cause).toBe(raw)
  })

  test('skipped is the message as it always was', () => {
    const e = handshakeFailure(url, undefined, 'skipped', raw)
    expect(e.code).toBe('WT_HANDSHAKE_FAILED')
    expect(e.message).not.toContain('answer')
  })
})
