/**
 * Signing in again without a reload, under the provider, in a real browser.
 *
 * The provider holds the one `connect()` for the tree, so a component that wants a fresh
 * attempt calls the pair from `useConnection()`: `disconnect()` takes the hold to zero and
 * `connect()` takes it back to one, and the `query` function sends whatever the token is by
 * then. This page exists because the application that asked for it had never run that path:
 * it reloads. Deliberately ugly, like its sibling.
 */
import { TransportProvider } from '@transport-io/react'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Client } from 'transport-io'
import { connectDev } from 'transport-io/dev-transport'
import { api, contract, type E2EMap } from './contract.ts'

// A stale token first, so the page is refused at the door.
let token = 'stale'
const asked: string[] = []

const client = new Client<E2EMap>({
  contract,
  reconnect: { minMs: 200, maxMs: 1000 },
  connect: () =>
    connectDev({
      query: () => {
        asked.push(token)
        return { token }
      },
    }),
})
const g = globalThis as {
  __client?: unknown
  __asked?: string[]
  __setToken?: (t: string) => void
}
g.__client = client
g.__asked = asked
g.__setToken = (t) => {
  token = t
}

function Door(): React.ReactNode {
  const { status, refused, connect, disconnect } = api.useConnection()

  if (refused !== null) {
    return (
      <button
        id="signin"
        type="button"
        onClick={() => {
          // What a real page does after its sign-in form: a token that will pass, then the
          // pair. A second refusal lands in `refused` again, so the rejection is not news.
          token = 'good'
          disconnect()
          void connect().catch(() => undefined)
        }}
      >
        sign in again ({refused.reason})
      </button>
    )
  }
  return <span id="status">{status}</span>
}

function Root(): React.ReactNode {
  const [mounted, setMounted] = useState(true)
  return (
    <div>
      <button id="unmount" type="button" onClick={() => setMounted(false)}>
        unmount
      </button>
      {mounted ? (
        <TransportProvider client={client}>
          <Door />
        </TransportProvider>
      ) : (
        <span id="gone">unmounted</span>
      )}
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
