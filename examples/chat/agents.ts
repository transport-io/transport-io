/** The scripts behind `generate`. No model is called. */

export interface Agent {
  /** Shown above the panel. */
  readonly question: string
  /** Milliseconds between tokens, before jitter. */
  readonly pace: number
  readonly tokens: readonly string[]
}

/**
 * Tokens keep their trailing whitespace. Newlines inside a paragraph collapse to a space;
 * blank lines survive.
 */
function tokenize(script: string): readonly string[] {
  const text = script
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .join('\n\n')
  return text.match(/\S+\s*/g) ?? []
}

const AGENT_A = `
Because these two panels are not sharing a pipe.

Each panel called stream() once, and each call opened its own bidirectional QUIC stream
inside the one WebTransport session. QUIC orders bytes within a stream and promises nothing
at all across streams, so the tokens filling this panel and the tokens filling the one
beside it are two independent sequences that happen to share a UDP flow.

When you press stop, the client resets this stream. That reset is a frame on the wire
carrying a code, and the generator producing this text is cancelled the moment it arrives,
so production ends at the source rather than continuing into a reader that has looked away.
None of that touches the other stream. It has its own ordering, its own flow control and its
own credit, and it goes on delivering at the rate it was already delivering.

The number that appears beside the other panel starts at zero the moment you press stop and
counts what has arrived since. If these two were sharing one ordered channel, that number
would sit still for as long as this stream took to unwind. Watching it not sit still is a
different kind of claim from a paragraph telling you it would not.

On a WebSocket both of these would be multiplexed over one TCP connection, framed by hand to
tell them apart, and a stop would be a message you send and then wait to have honoured. Here
it is a property of the transport.

Nothing else about the session changes either. The connection stays up, room membership
stays put, and if you press restart under this panel a new stream opens beside the one still
running. Streams are cheap, because that is what QUIC is for. There is no pool to exhaust
and no queue to be stuck behind, so a slow answer is slow on its own and takes nothing else
down with it.
`

const AGENT_B = `
Tokens, one frame each, on a stream opened for this request and closed when the answer ends.

The library hides the framing and hides nothing else. Every frame carries a length prefix,
because stream reads do not preserve write boundaries: a handful of small writes and one
large one arrive as an arbitrary number of reads with the boundaries gone. Nobody using this
library should ever write that code, which is why it is not in your way here.

Before any of this, the two ends agreed on what the events are. The first frame of the
session carries the contract: every event name, the identifier it hashes to, and the lane it
travels on. A peer that disagrees is refused at that frame, rather than at the first message
that fails to parse an hour later.

The pacing you are watching is not the transport's doing either. The reference transport
applies no write backpressure worth the name, so a producer left to itself will run
arbitrarily far ahead of a consumer that has taken almost nothing. This library keeps its
own credit window instead: a responder runs a bounded number of frames ahead of what its
consumer has actually taken. That is why this panel cannot be flooded, and why a slow reader
slows its own stream and no other.

This stream is the reliable half. The other half is datagrams, and it exists because some
data is worse for arriving late than for not arriving at all: a cursor position, a frame of
audio, the current value of anything that changes faster than you can draw it. Which half an
event uses is settled in the contract, once, and never at the call site, so nobody can
quietly make a droppable message reliable in order to close a bug.

The words themselves are generated on the server from a fixed script. No model is called.
What is real is everything underneath them: real QUIC over real UDP, a real certificate, and
two real streams that do not know about each other.
`

export const AGENTS: Readonly<Record<string, Agent>> = {
  'agent-a': {
    question: 'Why does stopping this panel not affect the other one?',
    pace: 55,
    tokens: tokenize(AGENT_A),
  },
  'agent-b': {
    question: 'What is actually on the wire?',
    pace: 64,
    tokens: tokenize(AGENT_B),
  },
}

/** Jitter derived from the index, so every run paces identically. */
export function paceOf(agent: Agent, index: number): number {
  const noise = ((Math.imul(index + 1, 2654435761) >>> 0) % 1000) / 1000
  return Math.round(agent.pace * (0.55 + 0.9 * noise))
}
