/**
 * The dev command and the entry it starts end together.
 *
 * The command installed no signal handler, so a SIGTERM aimed at it alone, `kill <pid>` or
 * `ChildProcess.kill()` from a script, ended the command and left the entry running with its
 * UDP port held. Ctrl-C never showed it, because a terminal signals the whole foreground
 * process group. Every case here signals one process and then asks about the other.
 *
 * The entry is a plain UDP socket on the port the command hands it. The port is the same
 * kernel resource a QUIC listener holds, and the test needs no native transport to hold it.
 */
import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { constants, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertUdpPortFree } from '../transport/port.node.ts'
import { DEV_HOST } from './dev-server.node.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAIN = resolve(HERE, 'main.node.ts')
const SUPERVISE = resolve(HERE, 'supervise.node.ts')

const dir = mkdtempSync(join(tmpdir(), 'transport-io-signals-'))
after(() => rmSync(dir, { recursive: true, force: true }))

/** Holds the WebTransport port as a server would, and says which process it is. */
const SERVER = join(dir, 'server.mts')
writeFileSync(
  SERVER,
  `import { createSocket } from 'node:dgram'
const socket = createSocket('udp4')
socket.bind(Number(process.env.TRANSPORT_IO_DEV_WT_PORT), '${DEV_HOST}', () => {
  console.log(\`entry \${process.pid} bound\`)
})
`,
)

/** Says it is up, then exits by itself with a code of its own. */
const QUITS = join(dir, 'quits.mts')
writeFileSync(
  QUITS,
  `console.log(\`entry \${process.pid} bound\`)
setTimeout(() => process.exit(7), 50)
`,
)

/** A command that supervises an entry and then exits for a reason that is not a signal. */
const FAILS = join(dir, 'fails.mts')
writeFileSync(
  FAILS,
  `import { spawn } from 'node:child_process'
import { superviseChild } from ${JSON.stringify(pathToFileURL(SUPERVISE).href)}
superviseChild(spawn(process.execPath, [${JSON.stringify(SERVER)}], { stdio: 'inherit' }))
process.on('SIGUSR2', () => process.exit(3))
`,
)

/** A port nothing holds, learned by binding it once and letting it go. */
async function freePort(): Promise<number> {
  const s = createServer()
  s.listen(0, DEV_HOST)
  await once(s, 'listening')
  const port = (s.address() as AddressInfo).port
  s.close()
  await once(s, 'close')
  return port
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** For the one case where the command does not wait: the entry is signalled as it leaves. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 500 && alive(pid); i++) await sleep(10)
  return !alive(pid)
}

interface Running {
  readonly command: ChildProcess
  readonly entryPid: number
  readonly exited: Promise<[number | null, NodeJS.Signals | null]>
  /** Whatever the test concluded, nothing it started outlives it. */
  stop(): void
}

/** Starts a command and resolves once the entry under it has said it is up. */
function start(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<Running> {
  return new Promise((ok, fail) => {
    const command = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'], env })
    const exited = once(command, 'exit') as Promise<[number | null, NodeJS.Signals | null]>
    let out = ''
    let entryPid: number | undefined
    const stop = (): void => {
      if (entryPid !== undefined && alive(entryPid)) process.kill(entryPid, 'SIGKILL')
      command.kill('SIGKILL')
    }
    const onData = (chunk: Buffer): void => {
      out += chunk.toString()
      const m = /entry (\d+) bound/.exec(out)
      if (m === null || entryPid !== undefined) return
      entryPid = Number(m[1])
      ok({ command, entryPid, exited, stop })
    }
    command.stdout?.on('data', onData)
    command.stderr?.on('data', onData)
    void exited.then(() =>
      fail(new Error(`the command exited before its entry was up:\n${out}`)),
    )
    // Never hang a test on an entry that did not start.
    setTimeout(stop, 15_000).unref()
  })
}

async function startDev(entry: string): Promise<Running & { readonly wtPort: number }> {
  const port = await freePort()
  const wtPort = await freePort()
  const argv = [MAIN, 'dev', entry, '--port', String(port), '--wt-port', String(wtPort)]
  return { ...(await start(argv, process.env)), wtPort }
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  test(`${signal} sent to the dev command alone ends the entry and frees its UDP port`, async () => {
    const dev = await startDev(SERVER)
    try {
      await assert.rejects(assertUdpPortFree(dev.wtPort, DEV_HOST), { code: 'WT_PORT_IN_USE' })
      dev.command.kill(signal)
      const ended = await dev.exited
      assert.equal(alive(dev.entryPid), false, 'the entry outlived the command')
      await assertUdpPortFree(dev.wtPort, DEV_HOST)
      // As it ended before it handled the signal, so a script that kills it reads the same.
      assert.deepEqual(ended, [null, signal])
    } finally {
      dev.stop()
    }
  })
}

test('an entry that exits with a code ends the command with that code', async () => {
  const dev = await startDev(QUITS)
  try {
    assert.deepEqual(await dev.exited, [7, null])
  } finally {
    dev.stop()
  }
})

test('an entry killed by a signal the command does not forward ends it with 128 plus the number', async () => {
  const dev = await startDev(SERVER)
  try {
    process.kill(dev.entryPid, 'SIGKILL')
    assert.deepEqual(await dev.exited, [128 + constants.signals.SIGKILL, null])
  } finally {
    dev.stop()
  }
})

test('a command that exits for a reason other than a signal takes its entry with it', async () => {
  const wtPort = await freePort()
  const env = { ...process.env, TRANSPORT_IO_DEV_WT_PORT: String(wtPort) }
  const failing = await start([FAILS], env)
  try {
    failing.command.kill('SIGUSR2')
    assert.deepEqual(await failing.exited, [3, null])
    assert.equal(await gone(failing.entryPid), true, 'the entry outlived the command')
    await assertUdpPortFree(wtPort, DEV_HOST)
  } finally {
    failing.stop()
  }
})
