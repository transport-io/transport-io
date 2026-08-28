/**
 * Tags and the registry must agree.
 *
 * `v0.2.1` and `v0.4.1` are tagged in this repository and were never published. A tag is how
 * everyone else finds a release - it is what a changelog links to, what a bisect starts from,
 * and what a person types into a compare view - so a tag with no registry version behind it
 * advertises a release that does not exist. The reverse is worse: a published version with no
 * tag has no commit anyone can point at.
 *
 * The rule this enforces: **tag on publish, not before.** Tagging first opens a window where
 * the two disagree legitimately, and a check that has to tolerate that window is exactly the
 * check that let 0.2.1 and 0.4.1 through - both were the newest tag once, and both stayed
 * unpublished. Removing the window is what makes the check total.
 *
 * The two existing divergences are recorded below rather than deleted, because deleting a
 * pushed tag rewrites history other people may already have. The list can only shrink: if one
 * of them is ever published, this fails until it is removed, so it cannot quietly become a
 * permanent allowlist.
 */
import { execFileSync } from 'node:child_process'

const PACKAGE = 'transport-io'

/**
 * Versions that exist as a tag but not on the registry, each one a decision already made.
 * Nothing may be added here: a new divergence is the defect this gate exists to report.
 */
const UNPUBLISHED_TAGS: Readonly<Record<string, string>> = {
  '0.2.1': 'tagged before the publish ritual existed, and superseded by 0.3.0 before release',
  '0.4.1': 'tagged, then superseded by 0.5.0 the same day; its one fix shipped inside 0.5.0',
}

/**
 * Registry versions with no tag. `0.0.1` is on the registry to claim the name, published from
 * the same tree as nothing in particular, and is documented as not being a release.
 */
const UNTAGGED_VERSIONS: Readonly<Record<string, string>> = {
  '0.0.1': 'a name claim, not a release. Documented in KNOWN-ISSUES.md',
}

function gitTags(): string[] {
  return execFileSync('git', ['tag', '-l', 'v*'], { encoding: 'utf8' })
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/^v/, ''))
}

async function registryVersions(): Promise<string[]> {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE}`, {
    headers: { 'cache-control': 'no-cache' },
  })
  if (!res.ok) throw new Error(`registry returned HTTP ${res.status} for ${PACKAGE}`)
  const doc = (await res.json()) as { versions?: Readonly<Record<string, unknown>> }
  return Object.keys(doc.versions ?? {})
}

const tags = gitTags()
const published = await registryVersions()

// A floor, because comparing two empty sets passes and says nothing. If either side comes
// back empty the check has failed to look, which is not the same as finding no divergence.
if (tags.length === 0) throw new Error('no v* tags found: `git tag -l` returned nothing')
if (published.length === 0) throw new Error(`no published versions found for ${PACKAGE}`)

const failures: string[] = []

for (const v of tags) {
  if (published.includes(v)) continue
  const reason = UNPUBLISHED_TAGS[v]
  if (reason === undefined) {
    failures.push(
      `v${v} is tagged but is not on the registry.\n` +
        '    A tag advertises a release. Publish it, or delete the tag.\n' +
        '    Tag on publish, not before: tagging first is what produced the two recorded here.',
    )
  }
}

for (const v of published) {
  if (tags.includes(v)) continue
  if (UNTAGGED_VERSIONS[v] === undefined) {
    failures.push(
      `${v} is published but has no v${v} tag.\n` +
        '    Nobody can point at the commit it was built from. Tag it.',
    )
  }
}

// The exception lists may only shrink. An entry that is no longer true is a stale exemption,
// and a stale exemption is how an allowlist becomes permanent.
for (const [v, why] of Object.entries(UNPUBLISHED_TAGS)) {
  if (published.includes(v)) {
    failures.push(
      `${v} is recorded as an unpublished tag but is now on the registry.\n` +
        `    Remove it from UNPUBLISHED_TAGS in this file. Recorded reason: ${why}`,
    )
  }
}
for (const [v, why] of Object.entries(UNTAGGED_VERSIONS)) {
  if (tags.includes(v)) {
    failures.push(
      `${v} is recorded as an untagged version but a v${v} tag now exists.\n` +
        `    Remove it from UNTAGGED_VERSIONS in this file. Recorded reason: ${why}`,
    )
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`  ${f}`)
  console.error(`\ntags: ${failures.length} divergence(s) between tags and the registry.`)
  process.exit(1)
}

const exempt = Object.keys(UNPUBLISHED_TAGS).length + Object.keys(UNTAGGED_VERSIONS).length
console.log(
  `tags: ${tags.length} tag(s) and ${published.length} published version(s) agree ` +
    `(${exempt} recorded exception(s))`,
)
