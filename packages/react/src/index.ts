/**
 * React bindings for transport-io.
 *
 * Every hook reads state through `useSyncExternalStore`, every subscription unsubscribes on
 * unmount, and nothing touches `window` or `WebTransport` at module scope, so importing this
 * on a server is safe.
 */
export { TransportProvider, type TransportProviderProps, useClient } from './context.tsx'
export { createHooks, type Hooks } from './create-hooks.ts'
export { type CallState, type UseCallOptions, type UseCallResult, useCall } from './use-call.ts'
export { type Connection, useConnection } from './use-connection.ts'
export { useEvent } from './use-event.ts'
export {
  type StreamState,
  type UseStreamOptions,
  type UseStreamResult,
  useStream,
} from './use-stream.ts'
