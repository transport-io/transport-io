import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import type { ChatMap } from '../contract.ts'
import { api } from './api.ts'

const me = `guest-${Math.trunc(performance.now()).toString(36).slice(-4)}`

type Line = ChatMap['chat']['payload'] & { readonly id: number }
interface Point {
  readonly x: number
  readonly y: number
}

export function Chat(): ReactNode {
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
          </div>
          <Surface name={name} />
        </section>
      </main>
    </>
  )
}

function Log(): ReactNode {
  const [lines, setLines] = useState<readonly Line[]>([])
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

function Composer({ name }: { readonly name: string | null }): ReactNode {
  const client = api.useClient()
  const [say, stream, stop] = api.useStream('say')
  const [body, setBody] = useState('')

  const submit = (e: FormEvent): void => {
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

function Surface({ name }: { readonly name: string | null }): ReactNode {
  const client = api.useClient()
  const [cursors, setCursors] = useState<Readonly<Record<string, Point>>>({})
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
