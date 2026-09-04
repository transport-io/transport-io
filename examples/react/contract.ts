import { defineContract, type MapOf, reliable, rpc, streaming, unreliable } from 'transport-io'
import { z } from 'zod'

export const contract = defineContract({
  chat: reliable(z.object({ from: z.string(), body: z.string().max(2000), at: z.number() })),
  cursor: unreliable(z.object({ from: z.string(), x: z.number(), y: z.number() })),
  // Echoes the text one word at a time.
  say: streaming(z.object({ text: z.string().max(500) }), z.string()),
  setName: rpc(
    z.object({ name: z.string() }),
    z.object({ accepted: z.boolean(), name: z.string() }),
  ),
})

export interface ChatMap extends MapOf<typeof contract> {}
