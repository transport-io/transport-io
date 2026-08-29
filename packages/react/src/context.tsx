'use client'
import { createContext, type ReactNode, useContext, useEffect } from 'react'
/**
 * The client, and how components reach it.
 *
 * The provider takes a client rather than making one. Construction needs a `connect`
 * function, which is transport-specific, and hiding that choice in here would mean
 * re-exporting transport concerns from a React package. It also matters for the server: a
 * module-level singleton client is a cross-request state leak on anything rendering more
 * than one user, so the documented pattern builds one per browser session inside a client
 * component and the server never shares it.
 */
import type { AnyMap, Client, Registered } from 'transport-io'

// Stored loosely and narrowed on the way out. The provider is generic so it accepts a client
// for any map, which is what `createHooks` needs: nothing is registered, so `Client` alone
// would mean `Client<NoContractRegistered>` and reject every real client.
const ClientContext = createContext<Client<AnyMap> | null>(null)

export interface TransportProviderProps<M extends AnyMap = Registered> {
  readonly client: Client<M>
  /**
   * Connect while the provider is mounted. On by default: `connect` and `disconnect` are
   * idempotent and refcounted in core, so mounting twice is safe, and every application
   * writes this effect identically. Pass `false` to drive the connection yourself.
   */
  readonly autoConnect?: boolean
  readonly children?: ReactNode
}

export function TransportProvider<M extends AnyMap = Registered>({
  client,
  autoConnect = true,
  children,
}: TransportProviderProps<M>): ReactNode {
  useEffect(() => {
    if (!autoConnect) return
    // A failed connect is reported through `lastError` on the snapshot, which is what
    // `useConnection` reads. Rethrowing here would be an unhandled rejection with nowhere
    // to be caught, since an effect has no caller.
    void client.connect().catch(() => undefined)
    return () => {
      client.disconnect()
    }
  }, [client, autoConnect])

  return (
    <ClientContext.Provider value={client as Client<AnyMap>}>{children}</ClientContext.Provider>
  )
}

/**
 * The client from the nearest provider.
 *
 * Throws a plain `Error` rather than a `TransportError`: nothing has gone wrong on the
 * wire, and core must never gain a React-shaped error code.
 */
export function useClient(): Client<Registered> {
  const client = useContext(ClientContext)
  if (client === null) {
    throw new Error(
      'no transport-io client in context. Wrap this tree in <TransportProvider client={…}>, ' +
        'and note that the provider is a client component: it needs "use client" at the top ' +
        'of the file that renders it.',
    )
  }
  return client as Client<Registered>
}
