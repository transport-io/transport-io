/**
 * `transport-io dev --demo`: two tabs talking, with no project and no files written.
 *
 * This exists because the acceptance test for `dev` is a person who has never used this
 * library seeing a message cross, and serving a project they do not have cannot meet it. It
 * writes nothing to disk and scaffolds nothing; it serves a page out of the package.
 *
 * It is a second thing to maintain, which is the honest cost. The e2e suite drives it, so it
 * cannot rot quietly.
 */
import { createServer } from '../server.ts'
import { listenDev } from '../transport/fails.node.ts'
import { type DemoMap, demoContract } from './demo-contract.ts'
import { LIB_PREFIX } from './dev-server.node.ts'

const ROOM = 'demo'

/** Starts the demo's WebTransport server. The certificate comes from the environment. */
export async function startDemoServer(): Promise<void> {
  const server = createServer<DemoMap>({ contract: demoContract })

  server.onSession((peer) => {
    void peer.join(ROOM)
    // Reliable: everyone sees it, including the sender, in one order.
    peer.on('chat', (msg) => void server.to(ROOM).emit('chat', msg))
    // Unreliable: excluded from the sender, because you know where your own pointer is.
    peer.on('cursor', (pos) => void server.to(ROOM).except(peer.id).emit('cursor', pos))
  })

  await server.listen(await listenDev(), {
    onAcceptError: (e) => console.error('session refused:', (e as Error).message),
  })
}

/**
 * The page.
 *
 * It imports the built package over `LIB_PREFIX` as native ESM, which is why the demo needs
 * no bundler, and it imports the same contract module the server above uses, which is why
 * the two cannot disagree.
 */
export const DEMO_PAGE: string = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>transport-io demo</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; height: 100vh;
         display: flex; flex-direction: column; }
  header { padding: .6rem 1rem; border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent);
           display: flex; gap: 1rem; align-items: baseline; }
  h1 { font-size: 1rem; margin: 0; font-weight: 600; }
  #status { font-size: .8rem; opacity: .7; }
  #log { flex: 1; overflow-y: auto; margin: 0; padding: 1rem; list-style: none; }
  #log li { padding: .15rem 0; }
  #log .me { opacity: .65; }
  form { display: flex; gap: .5rem; padding: 1rem; border-top: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
  input { flex: 1; padding: .5rem .7rem; font: inherit; border-radius: 6px;
          border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; color: inherit; }
  button { padding: .5rem 1rem; font: inherit; border-radius: 6px; border: 0;
           background: currentColor; cursor: pointer; }
  button span { color: Canvas; }
  .dot { position: fixed; width: 10px; height: 10px; border-radius: 50%;
         background: crimson; pointer-events: none; transition: translate 60ms linear; }
</style>
<header>
  <h1>transport-io</h1>
  <span id="status">connecting</span>
  <span id="hint" style="font-size:.8rem;opacity:.5">open a second tab</span>
</header>
<ul id="log"></ul>
<form id="send">
  <input id="body" placeholder="Type a message and press enter" autocomplete="off" autofocus>
  <button type="submit"><span>Send</span></button>
</form>
<script type="module">
import { Client } from '${LIB_PREFIX}index.js'
import { connectDev } from '${LIB_PREFIX}transport/dev.js'
import { demoContract } from '${LIB_PREFIX}cli/demo-contract.js'

const me = 'guest-' + Math.random().toString(16).slice(2, 6)
const log = document.getElementById('log')
const status = document.getElementById('status')

const add = (text, mine) => {
  const li = document.createElement('li')
  li.textContent = text
  if (mine) li.className = 'me'
  log.append(li)
  log.scrollTop = log.scrollHeight
}

const client = new Client({ contract: demoContract, connect: () => connectDev() })

client.subscribe(() => {
  const s = client.getSnapshot()
  status.textContent = s.status
  if (s.status === 'closed' && s.lastError) add('! ' + s.lastError.message, true)
})

client.on('chat', (m) => add(m.from + ': ' + m.body, m.from === me))

// The unreliable lane. Dropped frames are the point, not a fault.
const dots = new Map()
client.on('cursor', (p) => {
  let dot = dots.get(p.from)
  if (!dot) { dot = document.createElement('div'); dot.className = 'dot'; document.body.append(dot); dots.set(p.from, dot) }
  dot.style.translate = p.x + 'px ' + p.y + 'px'
})

document.getElementById('send').addEventListener('submit', (e) => {
  e.preventDefault()
  const input = document.getElementById('body')
  const body = input.value.trim()
  if (body === '') return
  client.emit('chat', { from: me, body, at: Date.now() })
  input.value = ''
})

addEventListener('pointermove', (e) => {
  if (client.getSnapshot().status === 'connected') {
    client.emit('cursor', { from: me, x: e.clientX, y: e.clientY })
  }
})

try {
  await client.connect()
  add('connected as ' + me + '. Open this page in a second tab.', true)
} catch (err) {
  status.textContent = 'failed'
  add('! ' + (err && err.message ? err.message : String(err)), true)
}
</script>
</html>
`
