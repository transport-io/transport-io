/** Shared by the fixture's server and its page, so the two cannot drift apart. */
import { defineContract, type MapOf, reliable, rpc, streaming } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string }>(),
  save: rpc<{ text: string }, { n: number }>(),
  ask: streaming<{ prompt: string }, string>(),
})

export interface E2EMap extends MapOf<typeof contract> {}

declare module 'transport-io' {
  interface Register {
    map: E2EMap
  }
}
