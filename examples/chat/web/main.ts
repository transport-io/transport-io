/**
 * The browser half. Both lanes in one page, so the difference is visible rather than
 * described: chat messages are never lost, cursor positions frequently are, and the
 * contract is the only place that says which is which.
 */
import { Client, type TransportError } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'
import { type ChatMap, contract } from '../contract.ts'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`missing #${id}`)
  return el as T
}

const log = $<HTMLDivElement>('log')
const form = $<HTMLFormElement>('composer')
const input = $<HTMLInputElement>('body')
const statusEl = $<HTMLSpanElement>('status')
const roomsEl = $<HTMLSpanElement>('rooms')
const dropsEl = $<HTMLSpanElement>('drops')
const surface = $<HTMLDivElement>('surface')

const me = `guest-${Math.trunc(performance.now()).toString(36).slice(-4)}`
const cursors = new Map<string, HTMLDivElement>()

/** Returns the line, so a streaming response can keep writing into it. */
function append(from: string, body: string, at: number): HTMLDivElement {
  const line = document.createElement('div')
  line.className = 'line'
  const time = new Date(at).toLocaleTimeString()
  line.textContent = `${time}  ${from}: ${body}`
  log.append(line)
  log.scrollTop = log.scrollHeight
  return line
}

function moveCursor(from: string, x: number, y: number): void {
  let dot = cursors.get(from)
  if (dot === undefined) {
    dot = document.createElement('div')
    dot.className = 'cursor'
    dot.dataset.name = from
    surface.append(dot)
    cursors.set(from, dot)
  }
  dot.style.transform = `translate(${x}px, ${y}px)`
}

const { sha256, port } = (await (await fetch('/cert-hash')).json()) as {
  sha256: number[]
  port: number
}

/**
 * The seam form, `new Client({ connect })`, rather than `browserClient({ … })`.
 *
 * This page renders the connection status, so it needs the client *before* it is connected:
 * `connecting` is a state you can only show if you are holding the thing that is doing the
 * connecting. `browserClient` resolves once the session is up, which is one line shorter and
 * cannot express this. Same reason the React provider takes an unconnected client.
 */
const client = new Client<ChatMap>({
  contract,
  connect: () =>
    connectBrowser({
      url: `https://127.0.0.1:${port}/`,
      certificateHash: Uint8Array.from(sha256),
    }),
})

// The observable snapshot, rather than a pile of events. A React binding would pass these
// two methods straight to useSyncExternalStore.
client.subscribe(() => {
  const s = client.getSnapshot()
  statusEl.textContent = s.status
  statusEl.dataset.state = s.status
  roomsEl.textContent = s.rooms.join(', ') || '-'
  if (s.lastError !== null)
    append('system', `${s.lastError.code}: ${s.lastError.remedy}`, Date.now())
})

client.on('chat', ({ from, body, at }) => append(from, body, at))
client.on('cursor', ({ from, x, y }) => moveCursor(from, x, y))

try {
  await client.connect()
} catch (e) {
  const err = e as TransportError
  append('system', `could not connect - ${err.code}: ${err.remedy}`, Date.now())
  throw e
}

// A call: request and response on their own stream, with a deadline supplied by the
// caller because the library does not invent one.
const named = await client.call('setName', { name: me }, { signal: AbortSignal.timeout(5_000) })
append('system', named.accepted ? `you are ${named.name}` : 'name rejected', Date.now())

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const body = input.value.trim()
  if (body.length === 0) return
  input.value = ''

  // A streaming call: the response arrives a word at a time and the line grows as it
  // does. Nothing here manages a buffer or a subscription; the loop is the whole API.
  if (body.startsWith('/say ')) {
    void (async () => {
      const line = append('stream', '', Date.now())
      for await (const word of client.stream('say', { text: body.slice(5) })) {
        line.textContent = `${line.textContent ?? ''}${word} `
      }
    })()
    return
  }

  // Reliable lane. This will arrive.
  client.emit('chat', { from: named.name, body, at: Date.now() })
})

// Unreliable lane, at pointer rate. Most of these are redundant the moment they are sent,
// which is exactly why losing one costs nothing.
surface.addEventListener('pointermove', (e) => {
  const r = surface.getBoundingClientRect()
  client.emit('cursor', {
    from: named.name,
    x: Math.round(e.clientX - r.left),
    y: Math.round(e.clientY - r.top),
  })
})

setInterval(() => {
  const s = client.stats()
  if (s === undefined) return
  // Our drops, not the network's - the transport reports neither loss nor congestion.
  dropsEl.textContent = `overflow ${s.overflowDropped} · stale ${s.staleDropped} · dedup ${s.staleReceived}`
}, 500)
