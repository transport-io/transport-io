import { Client, type TransportError } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'
import { AGENTS } from '../agents.ts'
import { type ChatMap, contract } from '../contract.ts'

function byId(id: string) {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`missing #${id}`)
  return el
}

const statusEl = byId('status')
const openEl = byId('open')

const live = new Set<string>()
function setLive(id: string, streaming: boolean) {
  if (streaming) live.add(id)
  else live.delete(id)
  openEl.textContent = String(live.size)
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
})

function makePanel(id: string, name: string) {
  const agent = AGENTS[name]
  if (agent === undefined) throw new Error(`unknown agent '${name}'`)

  const out = byId(`${id}-out`)
  const stateEl = byId(`${id}-state`)
  const tokensEl = byId(`${id}-tokens`)
  const rateEl = byId(`${id}-rate`)
  const sinceEl = byId(`${id}-since`)
  byId(`${id}-question`).textContent = agent.question

  /** Bumped by every start, so a superseded loop writes nothing to the DOM. */
  let generation = 0
  let handle: { cancel(): void } | null = null
  let tokens = 0
  let startedAt = 0
  let sinceBase: number | null = null
  let sinceLabel = ''

  function setState(state: string) {
    stateEl.textContent = state
    stateEl.dataset.state = state
    setLive(id, state === 'streaming')
  }

  function render() {
    tokensEl.textContent = String(tokens)
    const seconds = (performance.now() - startedAt) / 1000
    rateEl.textContent = seconds > 0.25 ? (tokens / seconds).toFixed(1) : '0.0'
    sinceEl.textContent =
      sinceBase === null ? '' : `+${tokens - sinceBase} since ${sinceLabel} stopped`
  }

  async function begin() {
    handle?.cancel()
    const mine = ++generation

    out.textContent = ''
    tokens = 0
    startedAt = performance.now()
    sinceBase = null
    setState('streaming')
    render()

    const result = client.stream('generate', { agent: name })
    handle = result
    try {
      for await (const token of result) {
        if (mine !== generation) return
        out.append(token)
        out.scrollTop = out.scrollHeight
        tokens++
        render()
      }
      if (mine === generation) setState('done')
    } catch (e) {
      if (mine !== generation) return
      const err = e as TransportError
      // WT_ABORTED is this page's own cancel(), so it reads as stopped rather than failed.
      setState(err.code === 'WT_ABORTED' ? 'stopped' : `failed: ${err.code}`)
    } finally {
      // Nothing left to stop, however it ended.
      if (mine === generation) handle = null
    }
  }

  return {
    start: () => void begin(),
    // True if a running stream was stopped.
    stop: () => {
      // Resets the stream; the loop above sees WT_ABORTED.
      if (handle === null) return false
      handle.cancel()
      handle = null
      return true
    },
    // Count from here, labelled with whichever panel just stopped.
    countFrom: (label: string) => {
      sinceBase = tokens
      sinceLabel = label
      render()
    },
    clearCount: () => {
      sinceBase = null
      render()
    },
  }
}

const a = makePanel('a', 'agent-a')
const b = makePanel('b', 'agent-b')

byId('a-stop').addEventListener('click', () => {
  if (a.stop()) b.countFrom('agent-a')
})
byId('b-stop').addEventListener('click', () => {
  if (b.stop()) a.countFrom('agent-b')
})
byId('a-start').addEventListener('click', () => {
  a.start()
  b.clearCount()
})
byId('b-start').addEventListener('click', () => {
  b.start()
  a.clearCount()
})
byId('restart').addEventListener('click', () => {
  a.start()
  b.start()
  a.clearCount()
  b.clearCount()
})

try {
  await client.connect()
} catch (e) {
  const err = e as TransportError
  statusEl.textContent = `${err.code}: ${err.remedy}`
  throw e
}

a.start()
b.start()
