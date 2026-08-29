/**
 * The React binding, in a real browser, over real QUIC.
 *
 * The loopback transport has hidden two bugs in this project, so the hooks are also exercised
 * against the same server `transport-io dev --demo` runs: a real certificate, real UDP, real
 * Chromium. Deliberately ugly - it is a fixture, and every element exists to be asserted on.
 */

import { TransportProvider, useConnection, useEvent } from '@transport-io/react'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Client } from 'transport-io'
import { connectDev } from 'transport-io/dev-transport'
import { contract } from './contract.ts'

const client = new Client({ contract, connect: () => connectDev() })
;(globalThis as { __client?: unknown }).__client = client

// Fixture instrumentation: how many live `on` subscriptions exist, so a test can tell a
// double delivery caused by two subscriptions from one caused by anything else.
{
  const realOn = client.on.bind(client)
  const g = globalThis as { __live?: number }
  g.__live = 0
  ;(client as unknown as { on: typeof client.on }).on = ((event, handler) => {
    g.__live = (g.__live ?? 0) + 1
    // Counted at the client, below React entirely: this separates "the transport delivered
    // twice" from "React invoked the handler twice".
    const counted = (p: unknown): void => {
      const gg = globalThis as { __clientDelivered?: number }
      gg.__clientDelivered = (gg.__clientDelivered ?? 0) + 1
      ;(handler as (x: unknown) => void)(p)
    }
    const off = realOn(event, counted as never)
    return () => {
      g.__live = (g.__live ?? 1) - 1
      off()
    }
  }) as typeof client.on
}

function Panel(): React.ReactNode {
  const { status } = useConnection()
  const [lines, setLines] = useState<string[]>([])
  const [renders, setRenders] = useState(0)

  // A fresh inline handler on every render, which is the case `useEvent` exists for.
  useEvent('chat', (msg) => {
    // Counted outside React too, so a test can distinguish a double *delivery* from React
    // applying the updater twice.
    const g = globalThis as { __delivered?: number }
    g.__delivered = (g.__delivered ?? 0) + 1
    setLines((prev) => [...prev, `${msg.from}: ${msg.body}`])
  })

  // A handle for the test to send from, rather than driving a form. Assigned during render
  // on purpose: this is a fixture, and it keeps the page free of anything to assert on that
  // is not the hook's own output.
  ;(globalThis as { __send?: (body: string) => void }).__send = (body) => {
    client.emit('chat', { from: 'tab', body })
  }

  return (
    <div>
      <span id="status">{status}</span>
      <span id="renders">{renders}</span>
      <button id="rerender" type="button" onClick={() => setRenders((n) => n + 1)}>
        rerender
      </button>
      <ul id="log">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <TransportProvider client={client}>
      <Panel />
    </TransportProvider>
  </StrictMode>,
)
