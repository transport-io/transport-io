import { defineContract, type MapOf, reliable, rpc, streaming, unreliable } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string; at: number }>(),
  cursor: unreliable<{ from: string; x: number; y: number }>(),
  /** Echoes the text one word at a time. */
  say: streaming<{ text: string }, string>(),
  setName: rpc<{ name: string }, { accepted: boolean; name: string }>(),
})

export interface ChatMap extends MapOf<typeof contract> {}
