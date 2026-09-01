/**
 * A word ceiling for the reader-facing README, enforced the way the hover ceilings are.
 *
 * The README drifted into a design record three times, each time in the same shape: a
 * paragraph defending a decision to an imagined skeptic, with a measurement attached. Each
 * fix was a sweep, and a sweep is a promise to sweep again. A budget is a mechanism, because
 * rationale is what gets cut when something has to go, and it is exactly what should.
 *
 * Prose words only: fenced code, HTML tags and link targets are not counted, so a longer
 * example or a longer URL cannot trip this, and a longer explanation can.
 *
 * The ceiling may only go down. Raising it is the drift this gate exists to refuse; if the
 * README genuinely needs more words, something else in it has stopped earning its place.
 *
 *   bun run scripts/check-prose-budget.ts
 */
import { existsSync, readFileSync } from 'node:fs'

/**
 * What a README of this kind weighs, measured on 2026-09-02 with this counter. With a
 * documentation site behind it: socket.io 116, uWebSockets.js 181, partykit 237, hono 251,
 * trpc 394. As its own reference: ws 848, fastify 913. This one has a site behind it and
 * also carries a quickstart and a limitations list a stranger must read before building, so
 * its destination is the top of the first group and the bottom of the second: about 1000.
 *
 * The ceiling starts where the README is, not where it should be, because a ceiling below
 * the document fails on the commit that introduces it and teaches nothing. It was 2032 the
 * day this gate landed, after the hover paragraphs and the comparison were cut. Each approved
 * cut moves the ceiling down to the new measurement plus about three percent, and it never
 * moves up.
 */
const BUDGET: Readonly<Record<string, number>> = {
  'README.md': 2100,
}

export function proseWords(md: string): number {
  const noFences = md.replace(/```[\s\S]*?```/g, ' ')
  const noHtml = noFences.replace(/<[^>]+>/g, ' ')
  const noLinkTargets = noHtml.replace(/\]\([^)]*\)/g, ']')
  const noFrontmatter = noLinkTargets.replace(/^---[\s\S]*?---\n/, ' ')
  return noFrontmatter.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length
}

const problems: string[] = []
for (const [file, ceiling] of Object.entries(BUDGET)) {
  if (!existsSync(file)) {
    problems.push(`${file}: missing, so there is nothing to measure and this cannot pass`)
    continue
  }
  const words = proseWords(readFileSync(file, 'utf8'))
  if (words === 0) {
    problems.push(
      `${file}: counted zero prose words, which is a broken counter not a lean document`,
    )
    continue
  }
  const pct = Math.round((words / ceiling) * 100)
  console.log(`prose: ${file} ${words} words (ceiling ${ceiling}, ${pct}%)`)
  if (words > ceiling) {
    problems.push(
      `${file}: ${words} prose words, above the ceiling of ${ceiling}. Cut rationale and ` +
        'link to DECISIONS.md or an ADR; never raise the ceiling.',
    )
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
