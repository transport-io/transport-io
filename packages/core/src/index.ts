export {
  type Adapter,
  type BroadcastOptions,
  type Frame as AdapterFrame,
  MemoryAdapter,
  type MemoryBus,
  memoryBus,
  type PeerId,
  // `Adapter.onRemote` is typed in terms of this, so anyone writing a Redis adapter needs
  // it. Without it their only options were `unknown` or retyping the interface by hand —
  // the exact failure mode CLAUDE.md records as having already broken this project three
  // times.
  type RemoteEnvelope,
} from './adapter.ts'
export { Client, type ClientOptions, type ClientState, type Status } from './client.ts'
export {
  type AnyMap,
  type CallableOf,
  type Contract,
  defineContract,
  type EventDef,
  type EventShape,
  type Infer,
  type Lane,
  type MapOf,
  type Schema,
  type$,
} from './contract.ts'
export { maxDatagramPayload } from './datagram.ts'
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
  PROTOCOL_VERSION,
  ResetCode,
  STREAM_FRAME_OVERHEAD_BYTES,
} from './protocol.ts'
export {
  createServer,
  type RoomTarget,
  Server,
  type ServerOptions,
  type ServerPeer,
} from './server.ts'
export type { SessionStats } from './session.ts'

/**
 * Hand-maintained and asserted against `package.json` by `index.test.ts`, because
 * `isolatedDeclarations` forbids inferring it from an import and a version that drifts from
 * its manifest is a lie in the one place a user checks first.
 *
 * `changeset version` moves the manifest, so this moves in the same commit — which the test
 * enforces rather than trusting anyone to remember.
 */
export const VERSION: string = '0.1.0'
