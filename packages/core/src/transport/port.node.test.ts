/**
 * The two silences `port.node.ts` closes, reproduced: a UDP port another socket holds, and a
 * TCP port held on `::` alone, which a bind of `127.0.0.1` would have walked past.
 */
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { type AddressInfo, createServer } from 'node:net'
import { test } from 'node:test'
import type { TransportError } from '../errors.ts'
import { assertTcpPortFree, assertUdpPortFree } from './port.node.ts'

test('a UDP port another socket holds is WT_PORT_IN_USE, and a free one passes', async () => {
  const holder = createSocket('udp4')
  holder.bind(0, '127.0.0.1')
  await once(holder, 'listening')
  const port = holder.address().port
  try {
    await assert.rejects(assertUdpPortFree(port, '127.0.0.1'), (e: TransportError) => {
      assert.equal(e.code, 'WT_PORT_IN_USE')
      assert.match(e.message, new RegExp(`UDP port ${port}`))
      return true
    })
  } finally {
    holder.close()
  }
  await assertUdpPortFree(port, '127.0.0.1')
})

test('a TCP port held on ::1 alone is WT_PORT_IN_USE, naming the address that answered', async () => {
  // IPv6 loopback only, so `127.0.0.1` is free and only the second probe finds it.
  const holder = createServer()
  holder.listen(0, '::1')
  await once(holder, 'listening')
  const port = (holder.address() as AddressInfo).port
  try {
    await assert.rejects(assertTcpPortFree(port), (e: TransportError) => {
      assert.equal(e.code, 'WT_PORT_IN_USE')
      assert.match(e.message, new RegExp(`answers on \\[::1\\]:${port}`))
      return true
    })
  } finally {
    holder.close()
    await once(holder, 'close')
  }
  await assertTcpPortFree(port)
})
