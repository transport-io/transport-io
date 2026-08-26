/** JSON over UTF-8. PROTOCOL.md §5.3 — codec 0x01, the only one this version speaks. */
import { TransportError } from './errors.ts'

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
