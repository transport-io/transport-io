const randomPort = (): number => 40000 + Math.floor(Math.random() * 20000)

/**
 * The parity suite body, shared by one test file per transport.
 *
 * A byte count established that `@moq/web-transport` does not leak (D66). It established
 * nothing else. This establishes the rest: half-close for `call()`, reset for
 * `AbortSignal`, `maxDatagramSize`, oversized-datagram behaviour, and both lanes end to
 * end. The reference binding got each of those wrong in specific ways; this is how we
 * find out which ways the alternative gets them wrong.
 */
import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '../client.ts'
import { defineContract, type MapOf, type$ } from '../contract.ts'
import type { TransportError } from '../errors.ts'
import type { CloseInfo, Connection } from './types.ts'

const contract = defineContract({
  chat: { lane: 'reliable', payload: type$<{ body: string }>() },
  // Declared, so the suite runs on a transport that carries the reliable lane only.
  cursor: { lane: 'unreliable', payload: type$<{ n: number }>(), fallback: 'newest' },
  echo: { lane: 'reliable', payload: type$<{ n: number }>(), returns: type$<{ n: number }>() },
  slow: { lane: 'reliable', payload: type$<null>(), returns: type$<null>() },
})
interface AppMap extends MapOf<typeof contract> {}

interface Listener {
  port: number
  sessions: () => AsyncIterable<Connection>
  stop: () => void
}
export interface UnderTest {
  /**
   * Which lanes the transport carries. `'reliable-only'` skips the two call assertions by
   * capability rather than by comment, and asserts the refusal a call meets instead.
   */
  readonly lanes: 'all' | 'reliable-only'
  /**
   * Whether a peer's stream reset reaches the responder's `ctx.signal`.
   *
   * `false` is a real capability gap. moq surfaces STOP_SENDING only on
   * the next write, and a long-running handler never makes one, so the handler is not
   * told to stop. The caller still rejects either way - the work just keeps running.
   */
  readonly propagatesAbortToHandler: boolean
  readonly name: string
  readonly port: number
  listen: (o: {
    port: number
    host: string
    cert: string
    privKey: string
  }) => Promise<Listener>
  connect: (o: { url: string; certificateHash: Uint8Array }) => Promise<Connection>
}

// Random high ports. A fixed port makes this suite fail for a reason that has nothing to
// do with the code - an orphan from a previous killed run still holding the socket, which
// cost an hour to diagnose once already.

interface Minted {
  readonly dir: string
  readonly certPath: string
  readonly keyPath: string
  readonly cert: string
  readonly privKey: string
  readonly certificateHash: Uint8Array
}
let minted: Minted | undefined
/** Minted on first use, so a transport that needs no certificate never runs openssl. */
function certificate(): Minted {
  if (minted !== undefined) return minted
  const dir = mkdtempSync(join(tmpdir(), 'parity-'))
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
  const cert = readFileSync(certPath, 'utf8')
  minted = {
    dir,
    certPath,
    keyPath,
    cert,
    privKey: readFileSync(keyPath, 'utf8'),
    certificateHash: createHash('sha256').update(new X509Certificate(cert).raw).digest(),
  }
  // At exit and not at the end of a case: two cases in one process share the certificate.
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  return minted
}

const settle = async (ms = 400): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
}

/**
 * One transport per process, deliberately.
 *
 * Running both bindings' servers concurrently in a single process hangs - verified: each
 * works alone and both can bind, but sessions on both at once deadlock. That is a
 * property of running two native QUIC stacks side by side, not of transport-io, and no
 * deployment would do it. Splitting by process is also better isolation.
 */
export async function runParity(t: UnderTest): Promise<void> {
  const { cert, privKey, certificateHash } = certificate()
  const { createServer } = await import('../server.ts')
  const server = createServer<AppMap>({ contract })
  await server.listen()
  server.handle('echo', async ({ n }) => ({ n: n * 2 }))
  let handlerSawAbort = false
  server.handle('slow', async (_p, ctx) => {
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener(
        'abort',
        () => {
          handlerSawAbort = true
          resolve()
        },
        { once: true },
      )
      // Bounded, so a transport that never delivers the reset fails an assertion instead
      // of hanging the suite. That distinction cost an afternoon to find.
      setTimeout(resolve, 3000)
    })
    return null
  })
  server.onSession((peer) => {
    void peer.join('lobby')
    peer.on('chat', (p) => void server.to('lobby').emit('chat', p))
    peer.on('cursor', (p) => void server.to('lobby').emit('cursor', p))
  })

  const listener = await t.listen({ port: t.port, host: '127.0.0.1', cert, privKey })
  void (async () => {
    for await (const conn of listener.sessions())
      void server.accept(conn).catch(() => undefined)
  })().catch(() => undefined)

  const url = `https://127.0.0.1:${t.port}/`
  const client = new Client<AppMap>({
    contract,
    origin: 0xf0000001,
    connect: () => t.connect({ url, certificateHash }),
  })
  await client.connect()
  assert.equal(client.getSnapshot().status, 'connected', `${t.name}: connected`)

  const chat: string[] = []
  const cursor: number[] = []
  client.on('chat', (p) => chat.push(p.body))
  client.on('cursor', (p) => cursor.push(p.n))
  await settle(600)

  client.emit('chat', { body: 'reliable' })
  await settle()
  assert.deepEqual(chat, ['reliable'], `${t.name}: reliable lane`)

  client.emit('cursor', { n: 7 })
  await settle()
  assert.deepEqual(cursor, [7], `${t.name}: unreliable lane`)

  if (t.lanes === 'all') {
    // Half-close for the request, response read to stream close.
    assert.deepEqual(await client.call('echo', { n: 21 }), { n: 42 }, `${t.name}: call`)

    // AbortSignal maps to a stream reset. The caller always rejects; whether the reset
    // reaches the responder is a property of the transport, asserted either way so a
    // regression in the supported direction is caught.
    const ac = new AbortController()
    const pending = client.call('slow', null, { signal: ac.signal })
    await settle(150)
    ac.abort()
    await assert.rejects(pending, `${t.name}: abort rejects the caller`)
    await settle(900)
    assert.equal(
      handlerSawAbort,
      t.propagatesAbortToHandler,
      `${t.name}: expected ctx.signal to ${t.propagatesAbortToHandler ? '' : 'NOT '}fire`,
    )
  } else {
    // No bidirectional streams: a call is refused with the code that says where it went,
    // and the session it was refused on is still up.
    await assert.rejects(
      client.call('echo', { n: 21 }),
      (e: unknown) => (e as TransportError).code === 'WT_LANE_UNAVAILABLE',
      `${t.name}: call refused on a reliable-only transport`,
    )
    assert.equal(client.getSnapshot().status, 'connected', `${t.name}: still connected`)
  }

  // Our layer refuses oversize before the transport can silently discard it.
  assert.throws(
    () => client.emit('cursor', { n: 1, pad: 'x'.repeat(4000) } as never),
    (e: unknown) => (e as TransportError).code === 'WT_DATAGRAM_TOO_LARGE',
    `${t.name}: oversized datagram refused locally`,
  )

  client.disconnect()
  listener.stop()
}

/**
 * The abrupt case: the peer dies with no close handshake, and the survivor has to notice.
 *
 * The suite above closes every session politely, which is why it never asked this. The
 * WebTransport specification rejects `closed` when a session ends abruptly; two of three
 * adapters passed that rejection across the seam, where everything waits with `.then()`,
 * so a browser said `connected` to a killed server for as long as anyone watched, and never
 * reconnected. The rule is that `closed` resolves, always (`closed.ts`), and this is where
 * each transport is held to it: a peer that can really be killed, the connection's `closed`
 * resolving inside a bound, the client's status leaving `connected`, and no rejection left
 * unhandled on the way.
 */
export interface KillablePeer {
  connect: () => Promise<Connection>
  /** Ends the peer with no close handshake: SIGKILL for a process, `drop()` for a loopback. */
  kill: () => void
}

export interface AbruptUnderTest {
  readonly name: string
  /**
   * The longest this transport may take to notice its peer is gone. Absolute, and set per
   * transport from a measurement: a QUIC stack learns it from its idle timeout, a socket
   * from the kernel closing it, the loopback at once.
   */
  readonly noticeWithinMs: number
  /** Brings up a peer serving the suite's contract, somewhere it can be killed. */
  peer: () => Promise<KillablePeer>
}

type Settled =
  | { readonly how: 'resolved'; readonly info: CloseInfo }
  | { readonly how: 'rejected'; readonly cause: unknown }
  | { readonly how: 'never' }

export async function runAbruptDrop(t: AbruptUnderTest): Promise<void> {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)

  const peer = await t.peer()
  let conn: Connection | undefined
  const client = new Client<AppMap>({
    contract,
    origin: 0xf0000002,
    connect: async () => {
      conn = await peer.connect()
      return conn
    },
  })
  try {
    await client.connect()
    assert.equal(client.getSnapshot().status, 'connected', `${t.name}: connected`)
    assert.ok(conn !== undefined)

    // Live before it dies, so what follows is a drop and not a session that never worked.
    const chat: string[] = []
    client.on('chat', (p) => chat.push(p.body))
    await settle(300)
    client.emit('chat', { body: 'before' })
    await settle(300)
    assert.deepEqual(chat, ['before'], `${t.name}: the session carried an emit before the kill`)

    const killedAt = Date.now()
    peer.kill()
    let bound: ReturnType<typeof setTimeout> | undefined
    const settled = await Promise.race<Settled>([
      conn.closed.then(
        (info) => ({ how: 'resolved', info }),
        (cause: unknown) => ({ how: 'rejected', cause }),
      ),
      new Promise<Settled>((resolve) => {
        bound = setTimeout(() => resolve({ how: 'never' }), t.noticeWithinMs)
      }),
    ])
    clearTimeout(bound)
    assert.equal(
      settled.how,
      'resolved',
      `${t.name}: closed must resolve after the peer is killed; within ${t.noticeWithinMs} ms it ${
        settled.how === 'rejected' ? `rejected with ${String(settled.cause)}` : 'did not settle'
      }`,
    )
    console.log(`  ${t.name}: noticed the killed peer after ${Date.now() - killedAt} ms`)
    // No session close code crossed the wire, so none is reported: a transport's own code
    // for a lost connection must not arrive looking like one of §10.2's.
    if (settled.how === 'resolved') {
      assert.equal(
        settled.info.code,
        0,
        `${t.name}: a lost connection reported close code ${settled.info.code}, which no peer sent`,
      )
    }

    await settle(100)
    const after = client.getSnapshot()
    assert.equal(after.status, 'closed', `${t.name}: the client's status left connected`)
    assert.equal(after.sessionId, null, `${t.name}: the dead session is no longer the client's`)
    assert.throws(
      () => client.emit('chat', { body: 'after' }),
      (e: unknown) => (e as TransportError).code === 'WT_SESSION_CLOSED',
      `${t.name}: an emit after the drop is refused, not queued for a dead peer`,
    )
    assert.deepEqual(unhandled, [], `${t.name}: no rejection was left unhandled`)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    client.disconnect()
    peer.kill()
  }
}

/**
 * A peer in a process of its own, which is the only way to kill one honestly. The test file
 * is its own fixture: run with `PARITY_PEER` set it is the peer (`servePeer`, `connectPeer`)
 * and registers no tests, so no fixture file ships in the package beside this suite.
 */
async function spawnSelf(
  testFile: string,
  role: 'server' | 'client',
  port: number,
): Promise<ChildProcess> {
  const { certPath, keyPath, certificateHash } = certificate()
  const child = spawn(process.execPath, [testFile], {
    env: {
      ...process.env,
      PARITY_PEER: role,
      PARITY_PORT: String(port),
      PARITY_CERT: certPath,
      PARITY_KEY: keyPath,
      PARITY_HASH: Buffer.from(certificateHash).toString('hex'),
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

export async function spawnPeer(
  testFile: string,
  connect: UnderTest['connect'],
): Promise<KillablePeer> {
  const port = randomPort()
  const child = await spawnSelf(testFile, 'server', port)
  const { certificateHash } = certificate()
  return {
    connect: () => connect({ url: `https://127.0.0.1:${port}/`, certificateHash }),
    kill: () => {
      child.kill('SIGKILL')
    },
  }
}

/** Which peer this process is, when `spawnSelf` started it; `undefined` in the test run. */
export function peerRole(): 'server' | 'client' | undefined {
  const role = process.env.PARITY_PEER
  return role === 'server' || role === 'client' ? role : undefined
}

/** Held open until killed, which is the point of it. */
function stayAlive(): void {
  console.log('parity-peer ready')
  setInterval(() => undefined, 60_000)
}

/** The child's half of `spawnPeer`: the suite's server on the transport under test. */
export async function servePeer(listen: UnderTest['listen']): Promise<void> {
  const { createServer } = await import('../server.ts')
  const server = createServer<AppMap>({ contract })
  await server.listen()
  server.onSession((peer) => {
    void peer.join('lobby')
    peer.on('chat', (p) => void server.to('lobby').emit('chat', p))
  })
  const listener = await listen({
    port: Number(process.env.PARITY_PORT),
    host: '127.0.0.1',
    cert: readFileSync(process.env.PARITY_CERT as string, 'utf8'),
    privKey: readFileSync(process.env.PARITY_KEY as string, 'utf8'),
  })
  void (async () => {
    for await (const conn of listener.sessions())
      void server.accept(conn).catch(() => undefined)
  })().catch(() => undefined)
  stayAlive()
}

/** The child's half of the other direction: a client that connects and then says nothing. */
export async function connectPeer(connect: UnderTest['connect']): Promise<void> {
  const client = new Client<AppMap>({
    contract,
    origin: 0xf0000003,
    connect: () =>
      connect({
        url: `https://127.0.0.1:${process.env.PARITY_PORT}/`,
        certificateHash: Buffer.from(process.env.PARITY_HASH as string, 'hex'),
      }),
  })
  await client.connect()
  stayAlive()
}

/**
 * The same case with the server as the survivor, and a server that sends nothing while it
 * waits. That second half is the one that matters: a transport whose stack learns of a dead
 * peer only when it has something unacknowledged in flight passes this with a chatty server
 * and holds a killed client's session for ever with a quiet one, which is what the reference
 * binding did. Its listener sends a liveness probe because of what this measured.
 */
export interface AbruptClientUnderTest {
  readonly name: string
  readonly noticeWithinMs: number
  readonly testFile: string
  listen: UnderTest['listen']
}

export async function runAbruptClientDrop(t: AbruptClientUnderTest): Promise<void> {
  const { cert, privKey } = certificate()
  const { createServer } = await import('../server.ts')
  const server = createServer<AppMap>({ contract })
  await server.listen()
  let closed: Promise<CloseInfo> | undefined
  server.onSession((peer) => {
    void peer.join('lobby')
    closed = peer.closed
  })
  const port = randomPort()
  const listener = await t.listen({ port, host: '127.0.0.1', cert, privKey })
  void (async () => {
    for await (const conn of listener.sessions())
      void server.accept(conn).catch(() => undefined)
  })().catch(() => undefined)

  const child = await spawnSelf(t.testFile, 'client', port)
  try {
    await settle(300)
    assert.equal(server.memberCount('lobby'), 1, `${t.name}: the client is in the room`)
    assert.ok(closed !== undefined)

    const killedAt = Date.now()
    child.kill('SIGKILL')
    let bound: ReturnType<typeof setTimeout> | undefined
    const settled = await Promise.race<Settled>([
      closed.then(
        (info) => ({ how: 'resolved', info }),
        (cause: unknown) => ({ how: 'rejected', cause }),
      ),
      new Promise<Settled>((resolve) => {
        bound = setTimeout(() => resolve({ how: 'never' }), t.noticeWithinMs)
      }),
    ])
    clearTimeout(bound)
    assert.equal(
      settled.how,
      'resolved',
      `${t.name}: peer.closed must resolve after the client is killed, on a server that sends nothing; within ${t.noticeWithinMs} ms it ${
        settled.how === 'rejected' ? `rejected with ${String(settled.cause)}` : 'did not settle'
      }`,
    )
    console.log(
      `  ${t.name}: the server noticed the killed client after ${Date.now() - killedAt} ms`,
    )
    assert.equal(server.memberCount('lobby'), 0, `${t.name}: the room forgot the dead peer`)
  } finally {
    child.kill('SIGKILL')
    listener.stop()
  }
}

/**
 * The suite's server in this process, for a transport with no process to kill. The contract
 * stays in this file: `isolatedDeclarations` cannot emit one, and a second copy would drift.
 */
export async function localPeer(): Promise<{
  accept: (conn: Connection) => void
  members: () => number
}> {
  const { createServer } = await import('../server.ts')
  const server = createServer<AppMap>({ contract })
  await server.listen()
  server.onSession((peer) => {
    void peer.join('lobby')
    peer.on('chat', (p) => void server.to('lobby').emit('chat', p))
  })
  return {
    accept: (conn) => void server.accept(conn).catch(() => undefined),
    members: () => server.memberCount('lobby'),
  }
}

export { randomPort }
