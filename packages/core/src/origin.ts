/**
 * Origin allocation. PROTOCOL.md §7.3.
 *
 * Allocated, not derived: hashing a PeerId would carry a birthday problem into a place
 * where a collision is close to undebuggable, since two peers would share a sequence space
 * and each would silently discard the other's datagrams as stale.
 *
 * Quarantined, not retired: never reusing turns the counter into a clock — 2^22 values at
 * 100 sessions per second exhausts in under twelve hours — so a busy host would stop
 * accepting sessions and need a restart.
 */
import { TransportError } from './errors.ts'
import { MAX_SESSION_HOSTS, ORIGIN_QUARANTINE_MS } from './protocol.ts'

const COUNTER_BITS = 22
const COUNTER_SPACE = 1 << COUNTER_BITS

export class OriginAllocator {
  readonly #ordinal: number
  readonly #quarantineMs: number
  readonly #live = new Set<number>()
  readonly #quarantined: { value: number; until: number }[] = []
  #next = 0

  constructor(hostOrdinal = 0, quarantineMs: number = ORIGIN_QUARANTINE_MS) {
    if (!Number.isInteger(hostOrdinal) || hostOrdinal < 0 || hostOrdinal >= MAX_SESSION_HOSTS) {
      throw new TransportError(
        'WT_PROTOCOL_ERROR',
        `host ordinal ${hostOrdinal} is outside 0..${MAX_SESSION_HOSTS - 1}`,
        `This deployment supports at most ${MAX_SESSION_HOSTS} concurrent session hosts.`,
      )
    }
    this.#ordinal = hostOrdinal
    this.#quarantineMs = quarantineMs
  }

  allocate(now: number): number {
    this.#release(now)
    for (let i = 0; i < COUNTER_SPACE; i++) {
      const counter = (this.#next + i) % COUNTER_SPACE
      // 0 is reserved so a zero-filled buffer cannot parse as a real peer.
      if (this.#ordinal === 0 && counter === 0) continue
      const value = (this.#ordinal << COUNTER_BITS) | counter
      if (this.#live.has(value)) continue
      if (this.#quarantined.some((q) => q.value === value)) continue
      this.#next = (counter + 1) % COUNTER_SPACE
      this.#live.add(value)
      return value
    }
    throw new TransportError(
      'WT_TOO_MANY_STREAMS',
      `this host has no free origin identifiers (${COUNTER_SPACE} live plus quarantined)`,
      'This is a concurrency limit, not a clock. Add another session host, or reduce concurrent sessions.',
    )
  }

  /** Held well beyond any window in which a stale datagram or sequence entry can survive. */
  free(value: number, now: number): void {
    if (!this.#live.delete(value)) return
    this.#quarantined.push({ value, until: now + this.#quarantineMs })
  }

  #release(now: number): void {
    while (
      this.#quarantined.length > 0 &&
      (this.#quarantined[0] as { until: number }).until <= now
    ) {
      this.#quarantined.shift()
    }
  }

  stats(now: number): { live: number; quarantined: number } {
    this.#release(now)
    return { live: this.#live.size, quarantined: this.#quarantined.length }
  }
}
