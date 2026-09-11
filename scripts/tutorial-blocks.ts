/**
 * The block grammar of a tutorial page, and the reconstruction of every file it builds.
 *
 * A tutorial shows a file once, complete, and after that shows only what changes, the way a
 * diff reads. The gate rebuilds each file from the first appearance plus every change, in
 * page order, so the reader's view and the checked artefact are the same thing. Four kinds
 * of fenced block take part, all named by `file=` except the last:
 *
 *   - complete: the whole file. Allowed once per file outside a collapsed block; a second
 *     one fails, so a file cannot be reprinted.
 *   - change: a `diff` fence holding one unified hunk in plus, minus and space form. Its
 *     pre-image, the context and removed lines in order, must occur exactly once in the
 *     file as reconstructed so far. No match and two matches both fail.
 *   - ref: a complete copy inside a `<details>` block, tagged `ref`. Compared with the
 *     reconstruction at that point and never used as a source of truth: a reference that
 *     disagrees fails rather than quietly winning.
 *   - excerpt: `excerpt=<repository path>`, a verbatim contiguous run of that file, for
 *     showing a piece of code the tutorial links to rather than builds.
 *
 * Pure: this module reads nothing and writes nothing, so `tutorial-blocks.test.ts` can prove
 * each rule on fixtures. `check-tutorial.ts` is the gate around it.
 */

export type Block =
  | {
      readonly kind: 'complete'
      readonly file: string
      readonly body: string
      readonly line: number
    }
  | {
      readonly kind: 'change'
      readonly file: string
      readonly body: string
      readonly line: number
    }
  | {
      readonly kind: 'ref'
      readonly file: string
      readonly body: string
      readonly line: number
    }
  | {
      readonly kind: 'excerpt'
      readonly path: string
      readonly body: string
      readonly line: number
    }

export interface Parsed {
  readonly blocks: readonly Block[]
  readonly problems: readonly string[]
}

const FILE_TAG = /(?:^|\s)file=([\w./-]+)/
const EXCERPT_TAG = /(?:^|\s)excerpt=([\w./-]+)/
const REF_TAG = /(?:^|\s)ref(?:\s|$)/

/** Every block that takes part, with the page line its fence opens on. */
export function parseTutorial(markdown: string): Parsed {
  const blocks: Block[] = []
  const problems: string[] = []
  const lines = markdown.split('\n')
  let inDetails = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const fence = /^```(\w*)([^\n]*)$/.exec(line)
    if (fence === null) {
      if (/^<details\b/.test(line)) inDetails = true
      if (/^<\/details>/.test(line)) inDetails = false
      i++
      continue
    }
    const at = i + 1
    const lang = fence[1] ?? ''
    const meta = fence[2] ?? ''
    const body: string[] = []
    i++
    while (i < lines.length && lines[i] !== '```') {
      body.push(lines[i] ?? '')
      i++
    }
    i++ // the closing fence
    const text = body.join('\n')
    const excerpt = EXCERPT_TAG.exec(meta)?.[1]
    if (excerpt !== undefined) {
      blocks.push({ kind: 'excerpt', path: excerpt, body: text, line: at })
      continue
    }
    const file = FILE_TAG.exec(meta)?.[1]
    if (file === undefined) continue
    const isRef = REF_TAG.test(meta)
    if (isRef && !inDetails) {
      problems.push(
        `line ${at}: the reference block for ${file} is outside a <details> block, so it prints the file in full`,
      )
      continue
    }
    if (inDetails && !isRef) {
      problems.push(
        `line ${at}: the block for ${file} inside a <details> block is not tagged ref, so it would count as the file`,
      )
      continue
    }
    if (isRef) blocks.push({ kind: 'ref', file, body: text, line: at })
    else if (lang === 'diff') blocks.push({ kind: 'change', file, body: text, line: at })
    else blocks.push({ kind: 'complete', file, body: text, line: at })
  }
  return { blocks, problems }
}

export interface Hunk {
  /** The context and removed lines, in order: what must be found exactly once. */
  readonly pre: readonly string[]
  /** The context and added lines, in order: what replaces it. */
  readonly post: readonly string[]
}

/** One hunk in plus, minus and space form. An empty line is an empty context line. */
export function parseHunk(body: string): { hunk: Hunk } | { error: string } {
  const pre: string[] = []
  const post: string[] = []
  for (const [n, raw] of body.split('\n').entries()) {
    if (raw === '') {
      pre.push('')
      post.push('')
      continue
    }
    const mark = raw[0]
    const rest = raw.slice(1)
    if (mark === ' ') {
      pre.push(rest)
      post.push(rest)
    } else if (mark === '-') pre.push(rest)
    else if (mark === '+') post.push(rest)
    else if (raw.startsWith('\\')) {
      // "\ No newline at end of file": a diff artefact, not a line.
    } else if (raw.startsWith('@@')) {
      return {
        error: `hunk line ${n + 1} is a header; a change block holds one hunk and no headers`,
      }
    } else {
      return { error: `hunk line ${n + 1} has no +, - or space prefix: ${JSON.stringify(raw)}` }
    }
  }
  if (pre.length === 0) {
    return { error: 'the hunk has no context and removes nothing, so it cannot be placed' }
  }
  return { hunk: { pre, post } }
}

/** Every index at which `needle` occurs in `hay` as a contiguous run. */
function occurrences(hay: readonly string[], needle: readonly string[]): number[] {
  const out: number[] = []
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false
        break
      }
    }
    if (ok) out.push(i)
  }
  return out
}

/**
 * Applies one hunk to a file. The pre-image must occur exactly once; the error says which
 * line could not be placed, or where the two places are.
 */
export function applyHunk(current: string, hunk: Hunk): { text: string } | { error: string } {
  const lines = current.split('\n')
  const found = occurrences(lines, hunk.pre)
  if (found.length === 0) {
    const missing = hunk.pre.find((l) => !lines.includes(l))
    return {
      error:
        missing === undefined
          ? `matches nothing: every line of it is in the file, but not as one run; it starts with ${JSON.stringify(hunk.pre[0])}`
          : `matches nothing; the first line of it that is not in the file: ${JSON.stringify(missing)}`,
    }
  }
  if (found.length > 1) {
    const [a, b] = found
    return {
      error: `matches ${found.length} places, at lines ${(a ?? 0) + 1} and ${(b ?? 0) + 1}; add context until it matches once`,
    }
  }
  const at = found[0] ?? 0
  const next = [...lines.slice(0, at), ...hunk.post, ...lines.slice(at + hunk.pre.length)]
  return { text: next.join('\n') }
}

const trimEnd = (s: string): string => s.replace(/\n+$/, '')

/** The first line at which two texts differ, 1-based, or -1 when they are the same. */
export function firstDifference(a: string, b: string): number {
  const x = trimEnd(a).split('\n')
  const y = trimEnd(b).split('\n')
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  return i < x.length || i < y.length ? i + 1 : -1
}

/** True when `piece` is a contiguous run of whole lines of `whole`. */
export function isExcerptOf(piece: string, whole: string): boolean {
  return occurrences(trimEnd(whole).split('\n'), trimEnd(piece).split('\n')).length > 0
}

export interface Reconstruction {
  /** Every file the page built, in its final state. */
  readonly files: ReadonlyMap<string, string>
  readonly problems: readonly string[]
  /** Blocks of each kind, so a gate can insist the page uses the grammar. */
  readonly counts: { complete: number; change: number; ref: number; excerpt: number }
}

export interface ReconstructOptions {
  /** A file the page may build. Anything else named by `file=` is a problem. */
  readonly allowed: (file: string) => boolean
  /** The repository file an excerpt block quotes, or undefined when it does not exist. */
  readonly readRepository: (path: string) => string | undefined
}

/** Runs the page in order: complete, then hunks, with references and excerpts checked as met. */
export function reconstruct(markdown: string, opts: ReconstructOptions): Reconstruction {
  const parsed = parseTutorial(markdown)
  const problems = [...parsed.problems]
  const files = new Map<string, string>()
  const counts = { complete: 0, change: 0, ref: 0, excerpt: 0 }

  for (const b of parsed.blocks) {
    counts[b.kind]++
    if (b.kind === 'excerpt') {
      const whole = opts.readRepository(b.path)
      if (whole === undefined) {
        problems.push(`line ${b.line}: excerpt of ${b.path}, which does not exist`)
      } else if (!isExcerptOf(b.body, whole)) {
        const first = trimEnd(b.body).split('\n')[0] ?? ''
        problems.push(
          `line ${b.line}: excerpt is not a contiguous run of ${b.path}; it starts with ${JSON.stringify(first)}`,
        )
      }
      continue
    }
    if (!opts.allowed(b.file)) {
      problems.push(`line ${b.line}: writes ${b.file}, which the example does not have`)
      continue
    }
    const current = files.get(b.file)
    if (b.kind === 'complete') {
      if (current !== undefined) {
        problems.push(
          `line ${b.line}: a second complete block for ${b.file}; after the first appearance a file changes only by hunks`,
        )
        continue
      }
      files.set(b.file, trimEnd(b.body))
      continue
    }
    if (current === undefined) {
      problems.push(`line ${b.line}: a ${b.kind} block for ${b.file} before the file exists`)
      continue
    }
    if (b.kind === 'change') {
      const parsedHunk = parseHunk(trimEnd(b.body))
      if ('error' in parsedHunk) {
        problems.push(`line ${b.line}: the change to ${b.file}: ${parsedHunk.error}`)
        continue
      }
      const applied = applyHunk(current, parsedHunk.hunk)
      if ('error' in applied) {
        problems.push(`line ${b.line}: the change to ${b.file} ${applied.error}`)
        continue
      }
      files.set(b.file, applied.text)
      continue
    }
    // A reference: checked, never adopted.
    const diff = firstDifference(b.body, current)
    if (diff !== -1) {
      const got = trimEnd(b.body).split('\n')[diff - 1]
      const want = trimEnd(current).split('\n')[diff - 1]
      problems.push(
        `line ${b.line}: the reference block for ${b.file} disagrees with the reconstruction at its line ${diff}:\n` +
          `         reference:      ${JSON.stringify(got ?? '<end>')}\n` +
          `         reconstruction: ${JSON.stringify(want ?? '<end>')}`,
      )
    }
  }
  return { files, problems, counts }
}
