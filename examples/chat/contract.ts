import { defineContract, type MapOf, type$ } from 'transport-io'

/**
 * The whole application surface, in one file. Reading this tells you every event, its
 * payload and - critically - whether it can be dropped.
 */
export const contract = defineContract({
  /** Reliable and ordered. A chat message that vanishes is a bug. */
  chat: {
    lane: 'stream',
    payload: type$<{ from: string; body: string; at: number }>(),
  },
  /** Unreliable. A cursor position that vanishes is last week's news. */
  cursor: {
    lane: 'datagram',
    payload: type$<{ from: string; x: number; y: number }>(),
  },
  /** Callable: it declares `returns`. */
  setName: {
    lane: 'stream',
    payload: type$<{ name: string }>(),
    returns: type$<{ accepted: boolean; name: string }>(),
  },
})

// The second line is not optional decoration. It is what keeps hover readable.
export interface ChatMap extends MapOf<typeof contract> {}
