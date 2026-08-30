/**
 * Two streams running at once, one of them stopped, and the other not noticing.
 *
 * This is the one claim in this library that is hard to believe from prose, so the page
 * exists to make it a thing you watch rather than a thing you are told. Everything on
 * screen comes from two `stream()` calls against one session. There is no framing code
 * here, no correlation identifier, and no pending map: each call is its own bidirectional
 * QUIC stream, which is what makes stopping one of them a local event.
 */
import { Client, type TransportError } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'
import { AGENTS } from '../agents.ts'
import { type ChatMap, contract } from '../contract.ts'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`missing #${id}`)
  return el as T
}

const statusEl = $('status')
const openEl = $('open')

/**
 * Derived from which panels are streaming, rather than kept as a counter with paired
 * increments. A restart cancels a stream whose loop settles a turn later, so the pairing is
 * not what it looks like in the source, and a counter briefly reads three.
 */
const live = new Set<string>()
function setLive(id: string, streaming: boolean): void {
  if (streaming) live.add(id)
  else live.delete(id)
  openEl.textContent = String(live.size)
}

const { sha256, port } = (await (await fetch('/cert-hash')).json()) as {
  sha256: number[]
  port: number
}

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

interface Panel {
  start(): void
  /** True if there was a running stream to stop, so a finished panel does not claim one. */
  stop(): boolean
  /** Count from here, labelled with whichever panel just stopped. */
  countFrom(label: string): void
  clearCount(): void
}

function makePanel(id: 'a' | 'b', name: string): Panel {
  const agent = AGENTS[name]
  if (agent === undefined) throw new Error(`unknown agent '${name}'`)

  const out = $<HTMLDivElement>(`${id}-out`)
  const stateEl = $(`${id}-state`)
  const tokensEl = $(`${id}-tokens`)
  const rateEl = $(`${id}-rate`)
  const sinceEl = $(`${id}-since`)
  $(`${id}-question`).textContent = agent.question

  /** Bumped by every start, so a superseded loop writes nothing to the DOM. */
  let generation = 0
  let handle: { cancel(): void } | null = null
  let tokens = 0
  let startedAt = 0
  let sinceBase: number | null = null
  let sinceLabel = ''

  function setState(state: string): void {
    stateEl.textContent = state
    stateEl.dataset.state = state
    setLive(id, state === 'streaming')
  }

  function render(): void {
    tokensEl.textContent = String(tokens)
    const seconds = (performance.now() - startedAt) / 1000
    // Over the whole run rather than a sliding window: a stall drags the average down and
    // keeps it down, so the number stays a stall detector after the stall is over.
    rateEl.textContent = seconds > 0.25 ? (tokens / seconds).toFixed(1) : '0.0'
    sinceEl.textContent =
      sinceBase === null ? '' : `+${tokens - sinceBase} since ${sinceLabel} stopped`
  }

  async function begin(): Promise<void> {
    handle?.cancel()
    const mine = ++generation

    out.textContent = ''
    tokens = 0
    startedAt = performance.now()
    sinceBase = null
    setState('streaming')
    render()

    // One call, one stream. Nothing below this line knows the other panel exists.
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
      // `cancel()` is this page's own doing, so it ends the stream rather than failing it.
      setState(err.code === 'WT_ABORTED' ? 'stopped' : `failed: ${err.code}`)
    } finally {
      // However this stream ended, there is nothing left to stop. A panel that has finished
      // on its own would otherwise report a stop that never happened, and the other panel
      // would start counting from a moment nothing occurred at.
      if (mine === generation) handle = null
    }
  }

  return {
    start: () => void begin(),
    stop: () => {
      // From outside the loop, where `break` cannot reach. It resets the QUIC stream, the
      // loop above sees WT_ABORTED, and the server's generator is cancelled where it stands.
      if (handle === null) return false
      handle.cancel()
      handle = null
      return true
    },
    countFrom: (label) => {
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

// Stopping one panel is also what tells the other to start counting. That number is the
// whole demonstration: it climbs while the panel beside it is frozen.
$('a-stop').addEventListener('click', () => {
  if (a.stop()) b.countFrom('agent-a')
})
$('b-stop').addEventListener('click', () => {
  if (b.stop()) a.countFrom('agent-b')
})
$('a-start').addEventListener('click', () => {
  a.start()
  b.clearCount()
})
$('b-start').addEventListener('click', () => {
  b.start()
  a.clearCount()
})
$('restart').addEventListener('click', () => {
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
