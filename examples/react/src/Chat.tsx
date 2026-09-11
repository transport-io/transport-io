import { type FormEvent, useEffect, useState } from 'react'
import { api } from './api.ts'

const me = `guest-${Math.random().toString(36).slice(2, 6)}`

interface Line {
  id: number
  from: string
  body: string
  at: number
}

interface Point {
  x: number
  y: number
}

export function Chat() {
  const { status, lastError } = api.useConnection()
  const [setName, named] = api.useCall('setName')

  // On every connect: a reconnect is a new session.
  useEffect(() => {
    if (status === 'connected') void setName({ name: me })
  }, [status, setName])

  const name = named.status === 'success' && named.data.accepted ? named.data.name : null

  return (
    <>
      <header>
        <h1>transport-io</h1>
        <span className="meta">
          status{' '}
          <span id="status" data-state={status}>
            {status}
          </span>
        </span>
        <span className="meta">
          you are <span id="me">{name ?? '…'}</span>
        </span>
        <Received />
        <Loss />
        {lastError !== null && (
          <span className="meta" id="error">
            {lastError.code}: {lastError.remedy}
          </span>
        )}
      </header>
      <main>
        <section>
          <div className="label">
            chat, <strong>reliable</strong>. Type <code>/say some words</code> for a stream.
          </div>
          <Log />
          <Composer name={name} />
        </section>
        <section>
          <div className="label">
            cursors, <strong>unreliable</strong>. Move your pointer; the other window sees it.
            The slider makes the server drop that share of your frames, so the other window
            watches the loss.
          </div>
          <Surface name={name} />
        </section>
      </main>
    </>
  )
}

function Received() {
  const [chat, setChat] = useState(0)
  const [cursor, setCursor] = useState(0)
  api.useEvent('chat', () => setChat((n) => n + 1))
  api.useEvent('cursor', () => setCursor((n) => n + 1))

  return (
    <span className="meta">
      received <span id="rx-chat">{chat}</span> chat · <span id="rx-cursor">{cursor}</span>{' '}
      cursor
    </span>
  )
}

function Loss() {
  const [setLoss, loss] = api.useCall('setLoss')
  // The label shows what the server set, not what the slider asked for.
  const percent = loss.status === 'success' ? loss.data.percent : 0

  return (
    <label className="meta" htmlFor="loss">
      drop <strong id="loss-value">{percent}%</strong> of my cursor frames{' '}
      <input
        id="loss"
        type="range"
        min={0}
        max={100}
        step={10}
        defaultValue={0}
        style={{ verticalAlign: 'middle', width: 110 }}
        onChange={(e) => void setLoss({ percent: Number(e.target.value) })}
      />
    </label>
  )
}

function Log() {
  const [lines, setLines] = useState<Line[]>([])
  api.useEvent('chat', (msg) => setLines((prev) => [...prev, { ...msg, id: prev.length }]))

  return (
    <div id="log">
      {lines.map((l) => (
        <div className="line" key={l.id}>
          {new Date(l.at).toLocaleTimeString()} {l.from}: {l.body}
        </div>
      ))}
    </div>
  )
}

function Composer({ name }: { name: string | null }) {
  const client = api.useClient()
  const [say, stream, stop] = api.useStream('say')
  const [body, setBody] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = body.trim()
    setBody('')
    if (text.length === 0 || name === null) return
    if (text.startsWith('/say ')) say({ text: text.slice(5) })
    else client.emit('chat', { from: name, body: text, at: Date.now() })
  }

  return (
    <>
      {stream.status !== 'idle' && (
        <div id="stream" className="line" data-state={stream.status}>
          stream: {stream.elements.join(' ')}
          {stream.status === 'streaming' && (
            <button id="stop" type="button" onClick={stop}>
              stop
            </button>
          )}
          {stream.status === 'error' && <span> {stream.error.code}</span>}
        </div>
      )}
      <form id="composer" onSubmit={submit}>
        <input
          id="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={name === null ? 'connecting' : 'say something'}
          autoComplete="off"
          disabled={name === null}
        />
        <button type="submit">send</button>
      </form>
    </>
  )
}

function Surface({ name }: { name: string | null }) {
  const client = api.useClient()
  const [cursors, setCursors] = useState<Record<string, Point>>({})
  api.useEvent('cursor', ({ from, x, y }) =>
    setCursors((prev) => ({ ...prev, [from]: { x, y } })),
  )

  return (
    <div
      id="surface"
      onPointerMove={(e) => {
        if (name === null) return
        const r = e.currentTarget.getBoundingClientRect()
        client.emit('cursor', {
          from: name,
          x: Math.round(e.clientX - r.left),
          y: Math.round(e.clientY - r.top),
        })
      }}
    >
      {Object.entries(cursors).map(([from, { x, y }]) => (
        <div
          className="cursor"
          key={from}
          data-name={from}
          style={{ transform: `translate(${x}px, ${y}px)` }}
        />
      ))}
    </div>
  )
}
