import { TransportProvider } from '@transport-io/react'
import { type ReactNode, useState } from 'react'
import { Client } from 'transport-io'
import { connectDev } from 'transport-io/dev-transport'
import { type ChatMap, contract } from '../contract.ts'
import { Chat } from './Chat.tsx'

export function App(): ReactNode {
  // new Client, so the provider can connect it. One per mounted tree, never at module level.
  const [client] = useState(
    () => new Client<ChatMap>({ contract, connect: () => connectDev() }),
  )
  return (
    <TransportProvider client={client}>
      <Chat />
    </TransportProvider>
  )
}
