/** Shared by the fixture's server and its page, so the two cannot drift apart. */

import { createHooks } from '@transport-io/react'
import { defineContract, type MapOf, reliable, rpc, streaming } from 'transport-io'

export const contract = defineContract({
  chat: reliable<{ from: string; body: string }>(),
  save: rpc<{ text: string }, { n: number }>(),
  ask: streaming<{ prompt: string }, string>(),
})

export interface E2EMap extends MapOf<typeof contract> {}

/** The documented default: hooks bound to this map, with nothing registered globally. */
export const api = createHooks<E2EMap>()
