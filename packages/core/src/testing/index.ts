/**
 * Test-only exports. Shipped so anyone writing an Adapter can run the same conformance
 * suite core does, rather than discovering the difference on a real bus.
 */

export { loopbackPair } from '../transport/loopback.ts'
export { UnreliableConnection, type UnreliableOptions } from '../transport/unreliable.ts'
export { HostileAdapter, type HostileOptions } from './hostile-adapter.ts'
