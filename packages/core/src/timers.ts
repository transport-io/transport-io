/**
 * Every timer an object owns, in one place.
 *
 * `dispose()` used to release timers one named field at a time, which meant that adding a
 * timer required remembering to extend a method three hundred lines away. Twice nobody did,
 * and the second time it took CI down with no commit behind it (D117). Holding them here
 * makes disposal one unconditional call that never needs editing when a timer is added.
 *
 * The registry alone would only be a nicer list. What makes the class impossible is that
 * `scripts/check-boundaries.ts` refuses a direct `setTimeout` or `setInterval` in any module
 * that defines a `dispose()`, so this is the only way in rather than the polite way in.
 *
 * It does not solve the other half of D117: a timer is often the only thing that will ever
 * answer a promise somebody is awaiting, so releasing it without settling that promise trades
 * a leak for a hang. `session-teardown.test.ts` is what covers that half.
 */

/** One timer, which its owner may cancel early and which disposal will cancel regardless. */
export interface OwnedTimer {
  cancel(): void
  /**
   * Node returns a `Timeout` carrying `unref`; browsers return a number. Neither type exists
   * in both runtimes, so this is narrowed rather than assumed, and does nothing where absent.
   */
  unref(): void
}

export class OwnedTimers {
  readonly #live = new Set<OwnedTimer>()

  /** Fires once. A timer that has fired is no longer live and needs no release. */
  after(ms: number, fn: () => void): OwnedTimer {
    let self: OwnedTimer | undefined
    const id = setTimeout(() => {
      if (self !== undefined) this.#live.delete(self)
      fn()
    }, ms)
    self = this.#own(id, () => {
      clearTimeout(id)
    })
    return self
  }

  /** Repeats until it is cancelled, or until the owner is disposed. */
  every(ms: number, fn: () => void): OwnedTimer {
    const id = setInterval(fn, ms)
    return this.#own(id, () => {
      clearInterval(id)
    })
  }

  /**
   * Releases everything still live. Idempotent, and the only call a teardown needs: a timer
   * added tomorrow is covered without this line, or the teardown, changing.
   */
  clearAll(): void {
    for (const timer of [...this.#live]) timer.cancel()
    this.#live.clear()
  }

  /** Outstanding timers, for the teardown tests that assert the invariant. */
  get liveCount(): number {
    return this.#live.size
  }

  #own(id: unknown, clear: () => void): OwnedTimer {
    const timer: OwnedTimer = {
      cancel: () => {
        clear()
        this.#live.delete(timer)
      },
      unref: () => {
        ;(id as { unref?: () => void }).unref?.()
      },
    }
    this.#live.add(timer)
    return timer
  }
}
