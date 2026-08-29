/**
 * Tags and the registry must agree, for every package this repository publishes.
 *
 * `v0.2.1` and `v0.4.1` are tagged here and were never published. A tag is how everyone else
 * finds a release - it is what a changelog links to, what a bisect starts from, and what a
 * person types into a compare view - so a tag with no registry version behind it advertises a
 * release that does not exist. The reverse is worse: a published version with no tag has no
 * commit anyone can point at.
 *
 * The rule this enforces: **tag on publish, not before.** Tagging first opens a window where
 * the two disagree legitimately, and a check that has to tolerate that window is exactly the
 * check that let 0.2.1 and 0.4.1 through - both were the newest tag once, and both stayed
 * unpublished. Removing the window is what makes the check total.
 *
 * Two packages ship from here, so they get one tag namespace each: core takes `v*`, and
 * anything else takes `<name>-v*`. Without the prefix a second package's tags would be read
 * as core's and every one of them would look like a release core never made.
 */
import { execFileSync } from 'node:child_process'

interface Published {
  /** The npm package name. */
  readonly pkg: string
  /** The git tag prefix that names a release of it. */
  readonly prefix: string
  /** Tagged but never published. Each entry is a decision already made, and may only be removed. */
  readonly unpublishedTags: Readonly<Record<string, string>>
  /** Published with no tag. Same rule. */
  readonly untaggedVersions: Readonly<Record<string, string>>
}

const PACKAGES: readonly Published[] = [
  {
    pkg: 'transport-io',
    prefix: 'v',
    unpublishedTags: {
      '0.2.1':
        'tagged before the publish ritual existed, and superseded by 0.3.0 before release',
      '0.4.1':
        'tagged, then superseded by 0.5.0 the same day; its one fix shipped inside 0.5.0',
    },
    untaggedVersions: {
      '0.0.1': 'a name claim, not a release. Documented in KNOWN-ISSUES.md',
    },
  },
  {
    pkg: '@transport-io/react',
    prefix: 'react-v',
    unpublishedTags: {},
    untaggedVersions: {},
  },
]

function gitTags(prefix: string): string[] {
  const all = execFileSync('git', ['tag', '-l'], { encoding: 'utf8' })
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  // What remains after the prefix must be a version, which is what keeps `react-v0.1.0` out
  // of core's `v` namespace: it does not start with `v` at all, and anything that did but was
  // not followed by a version would be some other kind of tag rather than a release.
  return all
    .filter((t) => t.startsWith(prefix))
    .map((t) => t.slice(prefix.length))
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
}

async function registryVersions(pkg: string): Promise<string[]> {
  const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`, {
    headers: { 'cache-control': 'no-cache' },
  })
  if (!res.ok) throw new Error(`registry returned HTTP ${res.status} for ${pkg}`)
  const doc = (await res.json()) as { versions?: Readonly<Record<string, unknown>> }
  return Object.keys(doc.versions ?? {})
}

const failures: string[] = []

for (const entry of PACKAGES) {
  const tags = gitTags(entry.prefix)
  const published = await registryVersions(entry.pkg)

  // Floors, because comparing two empty sets passes and says nothing. If either side comes
  // back empty the check failed to look, which is not the same as finding no divergence.
  if (tags.length === 0) {
    failures.push(`${entry.pkg}: no ${entry.prefix}* tags found, so nothing was compared`)
    continue
  }
  if (published.length === 0) {
    failures.push(`${entry.pkg}: no published versions found, so nothing was compared`)
    continue
  }

  for (const v of tags) {
    if (published.includes(v)) continue
    if (entry.unpublishedTags[v] === undefined) {
      failures.push(
        `${entry.prefix}${v} is tagged but ${entry.pkg} ${v} is not on the registry.\n` +
          '    A tag advertises a release. Publish it, or delete the tag.\n' +
          '    Tag on publish, not before: tagging first is what produced the recorded ones.',
      )
    }
  }

  for (const v of published) {
    if (tags.includes(v)) continue
    if (entry.untaggedVersions[v] === undefined) {
      failures.push(
        `${entry.pkg} ${v} is published but has no ${entry.prefix}${v} tag.\n` +
          '    Nobody can point at the commit it was built from. Tag it.',
      )
    }
  }

  // The exception lists may only shrink. An entry that is no longer true is a stale exemption,
  // and a stale exemption is how an allowlist becomes permanent.
  for (const [v, why] of Object.entries(entry.unpublishedTags)) {
    if (published.includes(v)) {
      failures.push(
        `${entry.pkg} ${v} is recorded as an unpublished tag and is now on the registry.\n` +
          `    Remove it from this file. Recorded reason: ${why}`,
      )
    }
  }
  for (const [v, why] of Object.entries(entry.untaggedVersions)) {
    if (tags.includes(v)) {
      failures.push(
        `${entry.pkg} ${v} is recorded as untagged but ${entry.prefix}${v} now exists.\n` +
          `    Remove it from this file. Recorded reason: ${why}`,
      )
    }
  }

  const exempt =
    Object.keys(entry.unpublishedTags).length + Object.keys(entry.untaggedVersions).length
  console.log(
    `tags: ${entry.pkg} - ${tags.length} tag(s) and ${published.length} published version(s) ` +
      `agree (${exempt} recorded exception(s))`,
  )
}

if (failures.length > 0) {
  for (const f of failures) console.error(`  ${f}`)
  console.error(`\ntags: ${failures.length} divergence(s) between tags and the registry.`)
  process.exit(1)
}
