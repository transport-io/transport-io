/**
 * The alternative transport, behind the same seam.
 *
 * `@moq/web-transport` is a NAPI-RS binding over a Rust QUIC stack. It is measured flat
 * on the per-stream churn that costs the reference binding 11.6 KB (D66), but a byte
 * count establishes exactly one property. This adapter exists so the existing suite can
 * run against it unchanged and establish the rest.
 *
 * Its surface is promise-and-method based rather than WHATWG streams, so the wrapping
 * here is thicker than in `fails.node.ts`. That is the seam doing its job.
 *
 * KNOWN ADOPTION BLOCKER: the package declares `exports: { ".": "./src/index.ts" }` — raw
 * TypeScript, no compiled JavaScript — and Node refuses to strip types inside
 * `node_modules`. The native binding is reachable only by file path, which means reaching
 * past the `exports` map to an implementation detail that a patch release may move. This
 * is not adoptable as a default until upstream ships a JavaScript entry point or exports
 * the binding. See D66.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { TransportError } from '../errors.ts'
import { DATAGRAM_CONSERVATIVE_FLOOR } from '../protocol.ts'
import type { BidiStream, CloseInfo, Connection } from './types.ts'

interface MoqSend {
  write: (data: Buffer) => Promise<void>
  finish: () => Promise<void>
  reset: (code: number) => Promise<void>
}
interface MoqRecv {
  read: (maxSize: number) => Promise<Buffer | null>
  stop: (code: number) => Promise<void>
}
interface MoqBi {
  takeSend: () => MoqSend
  takeRecv: () => MoqRecv
}
interface MoqSession {
  openUni: () => Promise<MoqSend>
  acceptUni: () => Promise<MoqRecv>
  openBi: () => Promise<MoqBi>
  acceptBi: () => Promise<MoqBi>
  sendDatagram: (data: Buffer) => void
  recvDatagram: () => Promise<Buffer>
  maxDatagramSize: () => number
  close: (code: number, reason: string) => void
  closed: () => Promise<{ closeCode: number; reason: string }>
}
interface MoqNative {
  NapiClient: {
    withCertificateHashes: (hashes: Buffer[]) => {
      connect: (url: string) => Promise<MoqSession>
    }
  }
  NapiServer: {
    bind: (
      addr: string,
      certPem: Buffer,
      keyPem: Buffer,
    ) => { accept: () => Promise<{ ok: () => Promise<MoqSession> } | null>; close: () => void }
  }
}

let cached: MoqNative | undefined
function native(): MoqNative {
  if (cached !== undefined) return cached
  try {
    const req = createRequire(import.meta.url)
    cached = req(join(process.cwd(), 'node_modules/@moq/web-transport/napi.cjs')) as MoqNative
    return cached
  } catch (cause) {
    throw new TransportError(
      'WT_NO_SUPPORT',
      `could not load @moq/web-transport: ${(cause as Error).message}`,
      'Install @moq/web-transport. Note it is reached by file path because its exports map has no JavaScript entry.',
    )
  }
}

const CHUNK = 65536

function toReadable(recv: MoqRecv): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await recv.read(CHUNK)
        if (chunk === null) {
          controller.close() // FIN
          return
        }
        controller.enqueue(new Uint8Array(chunk))
      } catch (e) {
        controller.error(e)
      }
    },
    cancel(reason) {
      // STOP_SENDING with an explicit code — no message-string parsing needed here.
      void recv.stop(codeOf(reason)).catch(() => undefined)
    },
  })
}

function toWritable(send: MoqSend): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      await send.write(Buffer.from(chunk))
    },
    async close() {
      await send.finish() // FIN, leaving the read side open
    },
    abort(reason) {
      // RESET_STREAM with an explicit code, likewise.
      void send.reset(codeOf(reason)).catch(() => undefined)
    },
  })
}

/**
 * Both `reset` and `stop` take a numeric code directly, so this transport needs no
 * equivalent of `resetCodeFromError`. That function exists only because the reference
 * binding drops the specification's `streamErrorCode` and leaves the message string as
 * the sole carrier.
 */
function codeOf(reason: unknown): number {
  if (typeof reason === 'number') return reason & 0xff
  const m = /code:\s*(\d+)/i.exec(reason instanceof Error ? reason.message : String(reason))
  return m?.[1] === undefined ? 0 : Number(m[1]) & 0xff
}

class MoqConnection implements Connection {
  readonly #s: MoqSession
  readonly closed: Promise<CloseInfo>

  constructor(session: MoqSession) {
    this.#s = session
    this.closed = session
      .closed()
      .then((i) => ({ code: i.closeCode, reason: i.reason }))
      .catch(() => ({ code: 0, reason: 'closed' }))
  }

  async openEmitStream(): Promise<WritableStream<Uint8Array>> {
    return toWritable(await this.#s.openUni())
  }

  onEmitStream(cb: (readable: ReadableStream<Uint8Array>) => void): void {
    void (async () => {
      try {
        for (;;) cb(toReadable(await this.#s.acceptUni()))
      } catch {
        // Session gone; `closed` reports it.
      }
    })()
  }

  async openBidi(): Promise<BidiStream> {
    const bi = await this.#s.openBi()
    return { readable: toReadable(bi.takeRecv()), writable: toWritable(bi.takeSend()) }
  }

  onBidi(cb: (stream: BidiStream) => void): void {
    void (async () => {
      try {
        for (;;) {
          const bi = await this.#s.acceptBi()
          cb({ readable: toReadable(bi.takeRecv()), writable: toWritable(bi.takeSend()) })
        }
      } catch {
        // As above.
      }
    })()
  }

  sendDatagram(bytes: Uint8Array): void {
    try {
      this.#s.sendDatagram(Buffer.from(bytes))
    } catch {
      // Whether this throws on oversize is a property of the binding, not something to
      // rely on: our layer checks the size before ever getting here.
    }
  }

  onDatagram(cb: (bytes: Uint8Array) => void): void {
    void (async () => {
      try {
        for (;;) cb(new Uint8Array(await this.#s.recvDatagram()))
      } catch {
        // As above.
      }
    })()
  }

  maxDatagramSize(): number {
    const r = this.#s.maxDatagramSize()
    return typeof r === 'number' && r > 0 ? r : DATAGRAM_CONSERVATIVE_FLOOR
  }

  /**
   * This binding speaks HTTP/3 only and exposes no reliability attribute. `undefined` is
   * the correct answer and is safe: D10 refuses only an explicit `reliable-only`, and
   * there is no HTTP/2 mapping here to be negotiated into.
   */
  reliability(): undefined {
    return undefined
  }

  close(code: number, reason: string): void {
    try {
      this.#s.close(code, reason.slice(0, 1024))
    } catch {
      // Already closed.
    }
  }
}

export interface MoqServerOptions {
  readonly port: number
  readonly host?: string
  readonly cert: string
  readonly privKey: string
}

export interface MoqListener {
  readonly port: number
  sessions(): AsyncIterable<Connection>
  stop(): void
}

export async function listenMoq(opts: MoqServerOptions): Promise<MoqListener> {
  const { NapiServer } = native()
  const host = opts.host ?? '127.0.0.1'
  const server = NapiServer.bind(
    `${host}:${opts.port}`,
    Buffer.from(opts.cert),
    Buffer.from(opts.privKey),
  )
  return {
    port: opts.port,
    stop: () => server.close(),
    async *sessions(): AsyncIterable<Connection> {
      for (;;) {
        const request = await server.accept()
        if (request === null) return
        yield new MoqConnection(await request.ok())
      }
    },
  }
}

export interface MoqClientOptions {
  readonly url: string
  readonly certificateHash: Uint8Array
}

export async function connectMoq(opts: MoqClientOptions): Promise<Connection> {
  const { NapiClient } = native()
  const client = NapiClient.withCertificateHashes([Buffer.from(opts.certificateHash)])
  try {
    return new MoqConnection(await client.connect(opts.url))
  } catch (cause) {
    throw new TransportError(
      'WT_SESSION_CLOSED',
      `could not open a session to ${opts.url}: ${(cause as Error).message}`,
      'Check the server is listening, that UDP reaches it, and that the certificate hash matches.',
    )
  }
}
