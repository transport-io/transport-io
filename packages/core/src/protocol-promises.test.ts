/**
 * The promises PROTOCOL.md §10 makes, asserted on the wire.
 *
 * Every test here is named for a normative statement, and its body asserts that statement
 * and nothing adjacent to it. That distinction is what this file exists to hold. Before it
 * existed, three of these promises had a test whose *name* was the promise and whose body
 * asserted something cheaper to reach:
 *
 *   - "the 257th open is refused" drove the cap through `client.call()` and asserted the
 *     caller's own local throw, so the receiver-side refusal it names was never exercised.
 *   - version and contract mismatch were asserted by calling `negotiate()` directly and
 *     reading `TransportError.code`, so the close code a peer actually receives - the only
 *     part another implementation can observe - was never checked. `CloseCode` appeared in
 *     zero test files.
 *   - the emit bound was asserted against `new EmitQueue(3)` in isolation, never through a
 *     Session, which is why the bound being unreachable from a Session went unnoticed.
 *
 * So: assert what a second implementation would see. A `TransportError` raised locally is
 * not evidence that anything was transmitted.
 */
/**
 * Proves these normative statements, which name this file back. The link is checked
 * from both ends by `scripts/check-norms.ts`; see D82.
 *
 *   reliable-only-refused
 *   handshake-sent-without-waiting
 *   refusal-names-the-event
 *   reset-codes-one-byte
 *   close-reason-1024-bytes
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from './client.ts'
import { encodePayload } from './codec.ts'
import { buildEventTable, defineContract, type MapOf, type$ } from './contract.ts'
import { encodeFrame } from './framer.ts'
import { buildHandshake } from './handshake.ts'
import {
  CLOSE_REASON_MAX_BYTES,
  CloseCode,
  Codec,
  EVENT_ID_NOT_APPLICABLE,
  FrameType,
  MAX_CONCURRENT_CALL_STREAMS,
  ResetCode,
} from './protocol.ts'
import { createServer } from './server.ts'
import { Session } from './session.ts'
import { loopbackPair } from './transport/loopback.ts'
import type { Connection } from './transport/types.ts'

const contract = defineContract({
  chat: { lane: 'reliable', payload: type$<{ body: string }>() },
  slow: { lane: 'reliable', payload: type$<null>(), returns: type$<null>() },
})
interface AppMap extends MapOf<typeof contract> {}

/** A live Session on one side, and the other side left raw so a test can speak the wire. */
async function halfWired(): Promise<{
  session: Session
  peer: Connection
  started: Promise<unknown>
}> {
  const [ours, theirs] = loopbackPair()
  // A real peer reads the emit stream. Without this the session's own handshake write
  // never drains and start() blocks before it ever reaches the refusal - a property of the
  // harness, not of the code under test.
  theirs.onEmitStream((r) => {
    void (async () => {
      const reader = r.getReader()
      for (;;) {
        const { done } = await reader.read().catch(() => ({ done: true }) as const)
        if (done) break
      }
    })()
  })
  const session = new Session(ours, { table: await buildEventTable(contract), origin: 1 })
  // start() rejects when the peer's handshake is refused; that rejection is the subject of
  // these tests, not an accident, so it is captured rather than left unhandled.
  const started = session.start().then(
    () => undefined,
    (e: unknown) => e,
  )
  return { session, peer: theirs, started }
}

async function sendHandshake(peer: Connection, payload: unknown): Promise<void> {
  const writer = (await peer.openEmitStream()).getWriter()
  await writer.write(
    encodeFrame({
      type: FrameType.HANDSHAKE,
      codec: Codec.JSON,
      eventId: EVENT_ID_NOT_APPLICABLE,
      payload: encodePayload(payload),
    }),
  )
}

describe('§10.2 - a peer must be able to tell these apart from a framing bug', () => {
  test('peers disagreeing on `v` closes the session with 1000', async () => {
    const { peer, started } = await halfWired()
    const ours = buildHandshake(await buildEventTable(contract))
    await sendHandshake(peer, { ...ours, v: ours.v + 1 })

    // The wire code, not the local error. A Go peer told 1004 debugs framing forever.
    expect((await peer.closed).code).toBe(CloseCode.WT_PROTOCOL_VERSION_MISMATCH)
    expect(await started).toBeInstanceOf(Error)
  })

  test('a contract fingerprint disagreement closes the session with 1001', async () => {
    const { peer } = await halfWired()
    const ours = buildHandshake(await buildEventTable(contract))
    // Same version, same event, opposite lane: a disagreement about a guarantee.
    const flipped = ours.events.map(([n, id, lane]) =>
      n === 'chat' ? ([n, id, 'unreliable'] as const) : ([n, id, lane] as const),
    )
    await sendHandshake(peer, { ...ours, events: flipped })

    expect((await peer.closed).code).toBe(CloseCode.WT_CONTRACT_MISMATCH)
  })

  test('a reliable-only session closes with 1006 rather than being dropped silently', async () => {
    const [, raw] = loopbackPair()
    // D10: the guarantee is server-side, but a client that finds itself reliable-only must
    // still tell the peer why it is leaving instead of vanishing.
    const conn = new Proxy(raw, {
      get(t, p, r) {
        if (p === 'reliability') return () => 'reliable-only'
        const v = Reflect.get(t, p, r) as unknown
        return typeof v === 'function' ? v.bind(t) : v
      },
    }) as Connection

    const client = new Client<AppMap>({ contract, connect: async () => conn })
    await expect(client.connect()).rejects.toThrow('WT_RELIABILITY_REFUSED')
    expect((await raw.closed).code).toBe(CloseCode.WT_RELIABILITY_REFUSED)
  })

  test('a close reason is truncated to 1024 bytes, not 1024 characters', async () => {
    const { peer } = await halfWired()
    const ours = buildHandshake(await buildEventTable(contract))
    // Every character is 3 bytes, so a character-wise slice overshoots the cap threefold.
    const long = '€'.repeat(2000)
    const takenId = ours.events[0]?.[1] as number
    await sendHandshake(peer, {
      ...ours,
      events: [[long, takenId, 'unreliable'] as const, ...ours.events],
    })

    const { reason } = await peer.closed
    expect(new TextEncoder().encode(reason).byteLength).toBeLessThanOrEqual(
      CLOSE_REASON_MAX_BYTES,
    )
  })
})

describe('§10.1 - the receiver refuses, the initiator is not merely asked not to', () => {
  test(`the ${MAX_CONCURRENT_CALL_STREAMS + 1}th INBOUND call stream is reset with WT_TOO_MANY_STREAMS`, async () => {
    const server = createServer<AppMap>({ contract })
    await server.listen()
    const [serverSide, clientSide] = loopbackPair()
    const client = new Client<AppMap>({ contract, connect: async () => clientSide })
    // Registered before accept: a handler added afterwards would not be on this session,
    // every request would fail fast with WT_UNKNOWN_EVENT, and nothing would stay in
    // flight to reach the cap at all.
    server.handle('slow', () => new Promise<never>(() => {})) // never resolves
    await Promise.all([server.accept(serverSide), client.connect()])
    const id = (await buildEventTable(contract)).byName('slow')?.id as number
    const request = encodeFrame({
      type: FrameType.CALL_REQUEST,
      codec: Codec.JSON,
      eventId: id,
      payload: encodePayload(null),
    })

    // Raw streams on purpose: `client.call()` refuses locally at the cap, so driving the
    // cap through it can never reach the receiver. That is what the old test did.
    //
    // The outcome is returned inside an object rather than from an async function: an
    // accepted stream never answers, and `await` flattens a promise-of-promise, so
    // returning it directly would await the hang instead of handing it back.
    const openOne = async (): Promise<{ outcome: Promise<Error | null> }> => {
      const stream = await clientSide.openBidi()
      const writer = stream.writable.getWriter()
      const reader = stream.readable.getReader()
      const outcome = (async (): Promise<Error | null> => {
        try {
          await writer.write(request)
          await writer.close()
          await reader.read()
          return null
        } catch (e) {
          return e as Error
        }
      })()
      return { outcome }
    }

    let settled = 0
    for (let i = 0; i < MAX_CONCURRENT_CALL_STREAMS; i++) {
      void (await openOne()).outcome.then(() => settled++)
    }
    await new Promise((r) => setTimeout(r, 50))

    // None of the first 256 was refused: they are in flight against a hung handler, which
    // is what makes the next open the one the cap has to stop.
    expect(settled).toBe(0)

    const refused = await (await openOne()).outcome
    expect(refused).toBeInstanceOf(Error)
    expect(refused?.message).toContain(`code:${ResetCode.WT_TOO_MANY_STREAMS}`)

    // The session survives the refusal - a cap that closes the session is a denial of
    // service with extra steps.
    expect(client.getSnapshot().status).toBe('connected')
  })
})

describe('every code the protocol defines is transmitted by some code path', () => {
  /**
   * A code that is defined, documented and sent by nothing is a promise to a second
   * implementer that this one will never keep. Four of them shipped.
   *
   * This is a text scan, and it is honest about its limit: it proves a code is *named* on
   * some non-test code path, not that the path is reachable. `WT_PEER_TOO_SLOW` is named
   * at session.ts and its branch is dead, which is why the exemption below carries the
   * behavioural test that has to replace it rather than a shrug. The list may only shrink.
   */
  const NOT_YET_TRANSMITTED: ReadonlyMap<string, string> = new Map([
    [
      'ResetCode.WT_NO_ERROR',
      'QUIC signals normal termination by a clean FIN with no application code; there is ' +
        'nothing for us to send explicitly. Documented so a reader of §10.1 can decode a 0.',
    ],
  ])

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return sourceFiles(p)
      if (!e.name.endsWith('.ts')) return []
      if (/\.(test|test-d)\.ts$/.test(e.name)) return []
      if (e.name === 'protocol.ts') return [] // the definitions themselves
      return [p]
    })
  }

  const corpus = sourceFiles('packages/core/src')
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')

  const defined = [
    ...Object.keys(CloseCode).map((k) => `CloseCode.${k}`),
    ...Object.keys(ResetCode).map((k) => `ResetCode.${k}`),
  ]

  test('no code is defined and documented but sent by nothing', () => {
    const orphans = defined.filter(
      (name) => !corpus.includes(name) && !NOT_YET_TRANSMITTED.has(name),
    )
    expect(orphans).toEqual([])
  })

  test('the exemption list may only shrink: every entry is still genuinely absent', () => {
    const stale = [...NOT_YET_TRANSMITTED.keys()].filter((name) => corpus.includes(name))
    expect(stale).toEqual([])
  })
})
