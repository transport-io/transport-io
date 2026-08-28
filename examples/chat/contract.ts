import { defineContract, type MapOf, reliable, rpc, streaming, unreliable } from 'transport-io'

/**
 * The whole application surface, in one file. Reading this tells you every event, its
 * payload and - critically - whether it can be dropped.
 */
export const contract = defineContract({
  /** Reliable and ordered. A chat message that vanishes is a bug. */
  chat: reliable<{ from: string; body: string; at: number }>(),
  /** Unreliable. A cursor position that vanishes is last week's news. */
  cursor: unreliable<{ from: string; x: number; y: number }>(),
  /**
   * Streaming: the answer is a sequence rather than a value. The client gets an async
   * iterable and the server writes an async generator.
   */
  say: streaming<{ text: string }, string>(),
  /** Callable: one value comes back. */
  setName: rpc<{ name: string }, { accepted: boolean; name: string }>(),
})

// The second line is not optional decoration. It is what keeps hover readable.
export interface ChatMap extends MapOf<typeof contract> {}

// Registering the map makes it the default everywhere, so nothing else in this example
// carries a type argument.
declare module 'transport-io' {
  interface Register {
    map: ChatMap
  }
}
