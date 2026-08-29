/**
 * A real client and a real server over the loopback transport.
 *
 * Not a mock. The hooks are thin, so a mocked client would test the mock; what is worth
 * testing is what happens when a real session delivers a real frame while React is
 * rendering. The loopback has hidden two bugs in this project, which is why there is also a
 * Playwright test over real QUIC.
 */

import type { ReactNode } from 'react'
import {
  Client,
  createServer,
  defineContract,
  type MapOf,
  reliable,
  rpc,
  type Server,
  type ServerPeer,
  streaming,
} from 'transport-io'
import { loopbackPair } from 'transport-io/testing'
import { TransportProvider } from './context.tsx'

export const contract = defineContract({
  chat: reliable<{ body: string }>(),
  save: rpc<{ text: string }, { n: number }>(),
  ask: streaming<{ prompt: string }, string>(),
})

export interface TestMap extends MapOf<typeof contract> {}

declare module 'transport-io' {
  interface Register {
    map: TestMap
  }
}

export interface Wired {
  readonly client: Client
  readonly server: Server
  /** The server's view of this client, for pushing an event at it. */
  readonly peer: ServerPeer
  readonly wrapper: ({ children }: { children: ReactNode }) => ReactNode
}

export async function wire(autoConnect = true): Promise<Wired> {
  const server = createServer({ contract })
  await server.listen()
  const [serverSide, clientSide] = loopbackPair()
  const client = new Client({ contract, connect: async () => clientSide })
  let peer: ServerPeer | undefined
  server.onSession((p) => {
    peer = p
  })
  await Promise.all([server.accept(serverSide), client.connect()])
  if (peer === undefined) throw new Error('no session: the harness did not connect')
  // `wire` connected once to get a session; the provider's own connect is refcounted on top.
  const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
    <TransportProvider client={client} autoConnect={autoConnect}>
      {children}
    </TransportProvider>
  )
  return { client, server, peer, wrapper }
}

/** Lets queued microtasks and the loopback's own scheduling settle. */
export const settle = async (ticks = 20): Promise<void> => {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 1))
}
