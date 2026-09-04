import { Client, type TransportError } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'
import { type ChatMap, contract } from '../contract.ts'

function byId(id: string) {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`missing #${id}`)
  return el
}

const log = byId('log')
const form = byId('composer')
const input = byId('body') as HTMLInputElement
const statusEl = byId('status')
const roomsEl = byId('rooms')
const dropsEl = byId('drops')
const rxChatEl = byId('rx-chat')
const rxCursorEl = byId('rx-cursor')
const lossEl = byId('loss') as HTMLInputElement
const lossValueEl = byId('loss-value')
const surface = byId('surface')

const me = `guest-${Math.random().toString(36).slice(2, 6)}`
const cursors = new Map<string, HTMLDivElement>()

/** Returns the line, so a streaming response can keep writing into it. */
function append(from: string, body: string, at: number) {
  const line = document.createElement('div')
  line.className = 'line'
  const time = new Date(at).toLocaleTimeString()
  line.textContent = `${time}  ${from}: ${body}`
  log.append(line)
  log.scrollTop = log.scrollHeight
  return line
}

function moveCursor(from: string, x: number, y: number) {
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

// new Client, so the page can show "connecting"
const client = new Client<ChatMap>({
  contract,
  connect: () =>
    connectBrowser({
      url: `https://127.0.0.1:${port}/`,
      certificateHash: Uint8Array.from(sha256),
    }),
})

client.subscribe(() => {
  const s = client.getSnapshot()
  statusEl.textContent = s.status
  statusEl.dataset.state = s.status
  roomsEl.textContent = s.rooms.join(', ') || '-'
  if (s.lastError !== null)
    append('system', `${s.lastError.code}: ${s.lastError.remedy}`, Date.now())
})

let rxChat = 0
let rxCursor = 0
client.on('chat', ({ from, body, at }) => {
  rxChatEl.textContent = String(++rxChat)
  append(from, body, at)
})
client.on('cursor', ({ from, x, y }) => {
  rxCursorEl.textContent = String(++rxCursor)
  moveCursor(from, x, y)
})

try {
  await client.connect()
} catch (e) {
  const err = e as TransportError
  append('system', `could not connect - ${err.code}: ${err.remedy}`, Date.now())
  throw e
}

const named = await client.call('setName', { name: me }, { signal: AbortSignal.timeout(5_000) })
append('system', named.accepted ? `you are ${named.name}` : 'name rejected', Date.now())

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const body = input.value.trim()
  if (body.length === 0) return
  input.value = ''

  if (body.startsWith('/say ')) {
    void (async () => {
      const line = append('stream', '', Date.now())
      for await (const word of client.stream('say', { text: body.slice(5) })) {
        line.textContent = `${line.textContent ?? ''}${word} `
      }
    })()
    return
  }

  client.emit('chat', { from: named.name, body, at: Date.now() })
})

// The label shows what the server set, not what the slider asked for.
lossEl.addEventListener('input', () => {
  void client.call('setLoss', { percent: Number(lossEl.value) }).then(({ percent }) => {
    lossValueEl.textContent = `${percent}%`
  })
})

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
  // Our own queue drops. The transport reports no network loss.
  dropsEl.textContent = `overflow ${s.overflowDropped} · stale ${s.staleDropped} · dedup ${s.staleReceived}`
}, 500)
