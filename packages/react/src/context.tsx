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
import type { AnyMap, Client, FallbackClient, NativeLanes, Registered } from 'transport-io'

/**
 * Either kind of client. `withFallback` returns the same object as `new Client` with `call`
 * and `stream` typed away, so the two differ in what the compiler lets a component reach,
 * never in what is there.
 */
export type AnyClient<M extends AnyMap = Registered> = Client<M> | FallbackClient<M>

// Stored loosely and narrowed on the way out. The provider is generic so it accepts a client
// for any map, which is what `createHooks` needs: nothing is registered, so `Client` alone
// would mean `Client<NoContractRegistered>` and reject every real client.
const ClientContext = createContext<AnyClient<AnyMap> | null>(null)

export interface TransportProviderProps<M extends AnyMap = Registered> {
  readonly client: AnyClient<M>
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
    <ClientContext.Provider value={client as unknown as AnyClient<AnyMap>}>
      {children}
    </ClientContext.Provider>
  )
}

/**
 * The client from the nearest provider.
 *
 * Throws a plain `Error` rather than a `TransportError`: nothing has gone wrong on the
 * wire, and core must never gain a React-shaped error code.
 */
export function useClient(): AnyClient<Registered> {
  const client = useContext(ClientContext)
  if (client === null) {
    throw new Error(
      'no transport-io client in context. Wrap this tree in <TransportProvider client={…}>, ' +
        'and note that the provider is a client component: it needs "use client" at the top ' +
        'of the file that renders it.',
    )
  }
  return client as unknown as AnyClient<Registered>
}

/**
 * `call` and `stream` as the object has them, whatever its type says.
 *
 * The hooks decide availability from the snapshot's transport, not from the type: a
 * fallback client on a native session carries both lanes, and on a fallback session the hook
 * reports `unavailable` before this is ever reached. The cast is honest because
 * `withFallback` hands back the `Client` instance itself.
 */
export function callable<M extends AnyMap>(client: AnyClient<M>): NativeLanes<M> {
  return client as unknown as NativeLanes<M>
}
