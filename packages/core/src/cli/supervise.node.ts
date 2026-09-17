/**
 * The dev command and the entry it spawns end together.
 *
 * A signal sent to the command alone, `kill <pid>` or `ChildProcess.kill()` from a script,
 * used to end the command and leave the entry running with its UDP port held. A terminal
 * hides this, because Ctrl-C goes to the whole foreground process group and the entry gets
 * its own.
 *
 * The entry stays in that group, so on Ctrl-C it receives SIGINT from the terminal and again
 * from here. Nothing can be done for SIGKILL, which no process gets to handle. See D151.
 */
import type { ChildProcess } from 'node:child_process'
import { constants } from 'node:os'

/** The signals that ask a process to stop. Each one ends a process that does not handle it. */
const FORWARDED: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP']

export function superviseChild(child: ChildProcess): void {
  for (const signal of FORWARDED) {
    // Passed on, and nothing else happens here. The entry may take its time to drain, and
    // this process exits when the entry has.
    process.on(signal, () => child.kill(signal))
  }

  // Every other way out, `process.exit` or an uncaught exception. `kill` on a child that has
  // already exited sends nothing.
  process.on('exit', () => child.kill())

  child.on('exit', (code, signal) => {
    // One of the two is always set.
    if (signal === null) process.exit(code ?? 0)
    if (FORWARDED.includes(signal)) {
      // Die by the same signal, as this process did before it handled any. A shell running
      // this in a loop stops on Ctrl-C only when it sees that.
      process.removeAllListeners(signal)
      process.kill(process.pid, signal)
      return
    }
    // What a shell reports for a process a signal killed.
    process.exit(128 + constants.signals[signal])
  })
}
