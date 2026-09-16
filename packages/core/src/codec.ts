/**
 * The two codecs this version speaks. PROTOCOL.md §5.3: `0x01` is JSON over UTF-8, `0x02`
 * is the application's bytes carried as they are. Which one a payload uses is a property of
 * the event's slot in the contract, never of the call site, and a frame that arrives under
 * the other codec is a protocol error rather than a guess.
 */
import { type EventDef, isBytes, type Schema } from './contract.ts'
import { TransportError } from './errors.ts'
import { Codec } from './protocol.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function encodePayload(value: unknown): Uint8Array {
  let json: string
  try {
    json = JSON.stringify(value)
  } catch (cause) {
    throw new TransportError(
      'WT_VALIDATION_FAILED',
      `payload is not JSON-serialisable: ${(cause as Error).message}`,
      'Remove cycles, functions and BigInt from the payload, or declare a codec that supports them.',
    )
  }
  if (json === undefined) {
    throw new TransportError(
      'WT_VALIDATION_FAILED',
      'payload serialised to undefined',
      'Send null rather than undefined. A zero-length frame is a protocol error.',
    )
  }
  return encoder.encode(json)
}

export function decodePayload(bytes: Uint8Array): unknown {
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    throw new TransportError(
      'WT_PROTOCOL_ERROR',
      'payload is not valid UTF-8',
      'Check the sender is encoding with codec 0x01 (JSON over UTF-8).',
    )
  }
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new TransportError(
      'WT_PROTOCOL_ERROR',
      `payload is not valid JSON: ${(cause as Error).message}`,
      'Check the sender is encoding with codec 0x01 (JSON over UTF-8).',
    )
  }
}

/** Validate inbound only. The process that produced a payload need not check its own work. */
export async function validate(
  schema: import('./contract.ts').Schema,
  value: unknown,
): Promise<unknown> {
  const result = await schema['~standard'].validate(value)
  if ('issues' in result && result.issues !== undefined) {
    const first = result.issues[0]
    const path = first?.path
      ?.map((p) => (typeof p === 'object' ? String(p.key) : String(p)))
      .join('.')
    throw new TransportError(
      'WT_VALIDATION_FAILED',
      path
        ? `field '${path}': ${first?.message ?? 'invalid'}`
        : (first?.message ?? 'invalid payload'),
      'Fix the payload to match the schema declared in the contract.',
    )
  }
  return (result as { value: unknown }).value
}

/** The codec an event's slot is declared with. A slot that is absent is JSON. */
function codecOf(schema: Schema | undefined): Codec {
  return schema !== undefined && isBytes(schema) ? Codec.BYTES : Codec.JSON
}

export type Slot = 'payload' | 'returns' | 'yields'

export function slotCodec(def: EventDef, slot: Slot): Codec {
  return codecOf(def[slot])
}

export function encodeWith(codec: Codec, value: unknown): Uint8Array {
  if (codec === Codec.BYTES) {
    if (!(value instanceof Uint8Array)) {
      throw new TransportError(
        'WT_VALIDATION_FAILED',
        'the event is declared bytes() and the payload is not a Uint8Array',
        'Pass a Uint8Array, or declare the event with a type or a schema for JSON.',
      )
    }
    return value
  }
  return encodePayload(value)
}

/** A copy for bytes, so the application never holds a view into a buffer the decoder reuses. */
export function decodeWith(codec: number, bytes: Uint8Array): unknown {
  return codec === Codec.BYTES ? new Uint8Array(bytes) : decodePayload(bytes)
}

/** The frame's codec against the contract's, for one slot of one event. */
export function expectCodec(event: string, slot: Slot, declared: Codec, arrived: number): void {
  if (declared === arrived) return
  const name = (c: number): string =>
    c === Codec.BYTES ? 'bytes' : c === Codec.JSON ? 'JSON' : `codec 0x${c.toString(16)}`
  throw new TransportError(
    'WT_PROTOCOL_ERROR',
    `event '${event}' declares ${name(declared)} for its ${slot} and the frame carries ${name(arrived)}`,
    'The two sides disagree about whether this slot is bytes() or JSON. Deploy the same contract on both.',
  )
}
