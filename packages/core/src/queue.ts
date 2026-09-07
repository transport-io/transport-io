/**
 * Backpressure. PROTOCOL.md §9 - three lanes, three answers, because they make different
 * promises.
 *
 * The transport swallows its own "blocked" indication along with "too big", so a refused
 * write reports success. We therefore do not attempt to infer network congestion: we bound
 * our own queue and report our own drops, labelled as ours.
 */
import { DATAGRAM_QUEUE_MAX, DATAGRAM_TTL_MS, EMIT_QUEUE_MAX } from './protocol.ts'

export interface QueueStats {
  readonly queueDepth: number
  readonly overflowDropped: number
  readonly staleDropped: number
}

interface Queued<T> {
  readonly item: T
  readonly at: number
}

/**
 * Unreliable lane: bounded ring, drop OLDEST on overflow, TTL checked at DEQUEUE.
 *
 * The two axes are different problems. Drop-oldest handles a burst. It does nothing for a
 * peer that stalls two seconds and resumes - the ring never overflows, so a backlog of
 * stale positions is delivered and the application renders history, which is worse than
 * delivering nothing. TTL at dequeue is what fixes that, and the two causes are counted
 * separately so an operator can tell a slow consumer from a slow network.
 */
export class DatagramQueue<T> {
  readonly #items: Queued<T>[] = []
  readonly #max: number
  readonly #ttlMs: number
  #overflowDropped = 0
  #staleDropped = 0

  constructor(max: number = DATAGRAM_QUEUE_MAX, ttlMs: number = DATAGRAM_TTL_MS) {
    this.#max = max
    this.#ttlMs = ttlMs
  }

  /** Never throws and never blocks: dropping is this lane's advertised contract. */
  push(item: T, now: number): void {
    if (this.#items.length >= this.#max) {
      this.#items.shift()
      this.#overflowDropped++
    }
    this.#items.push({ item, at: now })
  }

  /** Drop everything, for a session that is going away with frames still queued. */
  clear(): void {
    this.#items.length = 0
  }

  /**
   * Drains what is still fresh. Anything past its TTL is discarded here, not on entry.
   *
   * `limit` caps how many fresh items leave; the rest stay queued with their original
   * timestamps, so a later drain still judges their age from when they were pushed. The
   * WebSocket mapping uses it to take only as many as the emit lane has room for.
   */
  drain(now: number, limit: number = Number.POSITIVE_INFINITY): T[] {
    const out: T[] = []
    let taken = 0
    while (taken < this.#items.length) {
      const q = this.#items[taken] as Queued<T>
      if (now - q.at >= this.#ttlMs) {
        this.#staleDropped++
        this.#items.splice(taken, 1)
        continue
      }
      if (out.length >= limit) break
      out.push(q.item)
      taken++
    }
    this.#items.splice(0, taken)
    return out
  }

  stats(): QueueStats {
    return {
      queueDepth: this.#items.length,
      overflowDropped: this.#overflowDropped,
      staleDropped: this.#staleDropped,
    }
  }
}

export class PeerTooSlowError extends Error {
  constructor(depth: number) {
    super(`emit queue reached ${depth} frames`)
    this.name = 'PeerTooSlowError'
  }
}

/**
 * Emit lane: bounded, and NEVER drops. A lane that advertises reliable ordered delivery
 * and then discards silently is the lie this project exists to avoid, so a peer that falls
 * this far behind is disconnected instead.
 */
export class EmitQueue<T> {
  readonly #items: T[] = []
  readonly #max: number

  constructor(max: number = EMIT_QUEUE_MAX) {
    this.#max = max
  }

  push(item: T): void {
    if (this.#items.length >= this.#max) throw new PeerTooSlowError(this.#items.length)
    this.#items.push(item)
  }

  /**
   * The head, left in place. An item leaves this queue only when its write has actually
   * completed - `shift()` on hand-off would make depth a measure of nothing, which is
   * precisely how the bound came to be unreachable.
   */
  peek(): T | undefined {
    return this.#items[0]
  }

  shift(): T | undefined {
    return this.#items.shift()
  }

  get depth(): number {
    return this.#items.length
  }

  /** Drop everything, for a session that is going away with frames still queued. */
  clear(): void {
    this.#items.length = 0
  }
}
