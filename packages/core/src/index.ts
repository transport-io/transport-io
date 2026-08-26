export { TransportError, type TransportErrorCode } from './errors.ts'
export { encodeFrame, type Frame, FrameDecoder, maxPayloadFor } from './framer.ts'
export {
  CloseCode,
  Codec,
  DATAGRAM_CONSERVATIVE_PAYLOAD_MAX,
  DATAGRAM_HEADER_BYTES,
  EVENT_ID_NOT_APPLICABLE,
  FrameType,
  MAX_CALL_PAYLOAD_BYTES,
  MAX_EMIT_PAYLOAD_BYTES,
  ResetCode,
  STREAM_FRAME_OVERHEAD_BYTES,
} from './protocol.ts'

export const VERSION: string = '0.0.0'
