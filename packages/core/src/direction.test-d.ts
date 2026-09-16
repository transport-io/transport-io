/**
 * The compile-time half of direction (D134): the side that is not the sender cannot emit a
 * directed event, the side that is the sender cannot listen for it, and a call or a stream
 * cannot take a direction at all.
 */
import { expectTypeOf } from 'expect-type'
import type { Client } from './client.ts'
import {
  defineContract,
  fromClient,
  fromServer,
  type MapOf,
  type ReceivedBy,
  reliable,
  rpc,
  type SentBy,
  unreliable,
} from './contract.ts'
import type { RoomTarget, ServerPeer } from './server.ts'

const contract = defineContract({
  chat: reliable<{ body: string }>(),
  users: fromServer(reliable<{ names: string[] }>()),
  move: fromClient(unreliable<{ x: number }>({ fallback: 'newest' })),
  save: rpc<{ text: string }, { n: number }>(),
})
interface AppMap extends MapOf<typeof contract> {}

expectTypeOf<AppMap['users']['from']>().toEqualTypeOf<'server'>()
expectTypeOf<AppMap['move']['from']>().toEqualTypeOf<'client'>()
expectTypeOf<AppMap['chat']['from']>().toEqualTypeOf<undefined>()

expectTypeOf<SentBy<AppMap, 'client'>>().toEqualTypeOf<'chat' | 'move' | 'save'>()
expectTypeOf<SentBy<AppMap, 'server'>>().toEqualTypeOf<'chat' | 'users' | 'save'>()
expectTypeOf<ReceivedBy<AppMap, 'client'>>().toEqualTypeOf<'chat' | 'users' | 'save'>()
expectTypeOf<ReceivedBy<AppMap, 'server'>>().toEqualTypeOf<'chat' | 'move' | 'save'>()

declare const client: Client<AppMap>
declare const peer: ServerPeer<AppMap>
declare const room: RoomTarget<AppMap>

client.emit('move', { x: 1 })
client.emit('chat', { body: 'hi' })
// @ts-expect-error a client cannot send what the server sends
client.emit('users', { names: [] })
client.on('users', () => {})
// @ts-expect-error a client never receives what only clients send
client.on('move', () => {})

peer.emit('users', { names: [] })
void room.emit('users', { names: [] })
// @ts-expect-error a server cannot send what the client sends
peer.emit('move', { x: 1 })
// @ts-expect-error nor broadcast it
void room.emit('move', { x: 1 })
peer.on('move', () => {})
// @ts-expect-error a server never receives what only it sends
peer.on('users', () => {})

// @ts-expect-error a call has a side already: the client asks
fromServer(rpc<{ text: string }, { n: number }>())
