/**
 * What an observer is told, and the one thing it must never be handed.
 *
 * A record is numbers, names the event table already owns, and at most one fresh string.
 * It never references a frame's bytes or a decoded payload, so an observer that keeps every
 * record it is given keeps nothing the session would otherwise release. Measured with a full
 * ring of 1,000 after 5,000 frames of 64 KiB: 0.4 MB over nobody observing, against 66.6 MB
 * for a ring of payloads. `bench/observe-retention.node.ts` is the measurement; see D149.
 */
import { Codec } from './protocol.ts'

/**
 * One kind per frame type, one for a datagram, two for a call stream opening and closing,
 * and one for each drop `stats()` counts, named after its counter.
 */
export type FrameKind =
  | 'handshake'
  | 'emit'
  | 'datagram'
  | 'request'
  | 'response'
  | 'error'
  | 'credit'
  | 'join'
  | 'leave'
  | 'open'
  | 'close'
  | 'overflow-dropped'
  | 'stale-dropped'
  | 'stale-received'
  | 'direction-dropped'

export interface FrameRecord {
  /** The session's clock, in milliseconds. */
  readonly at: number
  /** 1 for the client's first session, 2 for the next: a reconnect is a new session (D4). */
  readonly session: number
  readonly kind: FrameKind
  /** For `open` and `close`, which side opened the stream. */
  readonly dir: 'in' | 'out'
  /** From the contract, so a datagram the fallback wrapped in a frame is still `unreliable`. */
  readonly lane: 'reliable' | 'unreliable'
  /** `null` for a frame that carries no event, and for an event id not in the contract. */
  readonly event: string | null
  /**
   * 0 is the emit stream, and everything on a WebSocket. Any other number is a call stream,
   * counted by this session as it opens or accepts them; it is not the QUIC stream id, which
   * the platform does not expose. `null` for a datagram.
   */
  readonly stream: number | null
  /** Bytes on the wire, header included. 0 for `open` and `close`. */
  readonly size: number
  /** Datagrams only. */
  readonly sequence: number | null
  /** `null` unless the subscription asked for previews. */
  readonly preview: string | null
}

export type FrameObserver = (record: FrameRecord) => void

export interface ObserveOptions {
  /**
   * Include the start of each payload: the first `PREVIEW_MAX_BYTES` of a JSON payload as
   * text, or the first 32 bytes of a `bytes()` payload as hex. Off unless asked for, because
   * a payload is the application's data and a log is somewhere it may not belong.
   */
  readonly preview?: boolean
}

/** What a session is handed: one observer, composed from whoever subscribes. */
export interface Tap {
  readonly observer: FrameObserver
  readonly preview: boolean
  readonly session: number
}

export interface Subscriber {
  readonly observer: FrameObserver
  readonly preview: boolean
}

/**
 * One tap for every subscriber, or none when there are none. A subscriber that did not ask
 * for previews never sees one, whoever else did, and one that throws is a broken panel or a
 * broken logger: it does not starve the next, and it never reaches the session.
 */
export function composeTap(
  subscribers: readonly Subscriber[],
  session: number,
): Tap | undefined {
  if (subscribers.length === 0) return undefined
  return {
    observer: (record) => {
      for (const s of subscribers) {
        try {
          s.observer(
            s.preview || record.preview === null ? record : { ...record, preview: null },
          )
        } catch {
          // Deliberately nothing.
        }
      }
    },
    preview: subscribers.some((s) => s.preview),
    session,
  }
}

export const PREVIEW_MAX_BYTES = 256
const PREVIEW_HEX_BYTES = 32

/**
 * Indexed by frame type, §5.2: 0x01 is HANDSHAKE and 0x08 is CALL_CREDIT. An array and not
 * a map keyed by `FrameType`, because this ships in every browser bundle and the keys were
 * most of it; `observe.test.ts` holds each index to the constant it stands for. A DATAGRAM
 * frame has no kind: it is recorded as the datagram it carries.
 */
export const FRAME_KINDS: readonly (FrameKind | undefined)[] = [
  undefined,
  'handshake',
  'emit',
  'request',
  'response',
  'error',
  'join',
  'leave',
  'credit',
]

// Not fatal: a preview cut mid-character ends in a replacement character, and that is fine.
const decoder = new TextDecoder()

/**
 * Decoded from the bytes, never sliced from a string. `JSON.stringify(value).slice(0, 256)`
 * looks like the same thing and is not: a sliced string keeps its whole parent alive, and a
 * ring of 1,000 of them held every 64 KiB payload it was cut from, measured.
 */
export function previewOf(codec: number, payload: Uint8Array): string {
  if (codec === Codec.JSON) {
    return decoder.decode(
      payload.byteLength > PREVIEW_MAX_BYTES ? payload.subarray(0, PREVIEW_MAX_BYTES) : payload,
    )
  }
  let hex = ''
  const n = Math.min(payload.byteLength, PREVIEW_HEX_BYTES)
  for (let i = 0; i < n; i++) hex += (payload[i] as number).toString(16).padStart(2, '0')
  return hex
}
