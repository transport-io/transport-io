/**
 * The list of status checks branch protection should require, derived from the workflows
 * rather than typed out beside them.
 *
 * `protect-branch.sh` used to carry eight context strings as a literal array. They were
 * correct when written and wrong the moment a workflow was added: the `site` workflow
 * landed and protection silently covered 8 of 10 jobs, which is the same defect as a
 * constants gate that only checks the constants somebody remembered to list. A list that
 * has to be kept in step with something else is a list that will stop being in step with it.
 *
 * **Not every job can be required.** A required check that never reports on a pull request
 * blocks every merge for ever, so a job is only requireable if it can actually run on one:
 *
 *   - its workflow must trigger on `pull_request`;
 *   - its `if:` condition must not restrict it to pushes.
 *
 * Both exclusions are printed rather than applied silently, because a job quietly dropped
 * from protection is exactly what this script exists to prevent.
 *
 *   bun run scripts/required-checks.ts          # one context per line
 *   bun run scripts/required-checks.ts --json   # a JSON array, for the API call
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DIR = resolve(import.meta.dirname, '../.github/workflows')

/** Fewer than this and the parse broke rather than the repository shrinking. */
const MIN_CONTEXTS = 5

export interface Job {
  readonly workflow: string
  readonly id: string
  readonly name: string
  readonly requireable: boolean
  readonly why?: string | undefined
}

/**
 * Deliberately line-based, like `check-workflows.ts`. Adding a YAML parser to the toolchain
 * to read two files is a dependency this does not need, and the shapes here are ours.
 */
export function jobsIn(workflow: string, source: string): Job[] {
  const lines = source.split('\n')

  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (jobsAt < 0) return []

  // `on:` block, up to the first top-level key after it.
  const onAt = lines.findIndex((l) => /^on:\s*$/.test(l))
  let onBlock = ''
  if (onAt >= 0) {
    for (let i = onAt + 1; i < lines.length; i++) {
      const line = lines[i] as string
      if (/^\S/.test(line)) break
      onBlock += `${line}\n`
    }
  }
  const onPullRequest = /^\s{2}pull_request:/m.test(onBlock)

  const out: Job[] = []
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const line = lines[i] as string
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1]
    if (id === undefined) continue

    // The job's own body, to its `name:` and any `if:`.
    let name = id
    let condition = ''
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j] as string
      if (/^ {2}\S/.test(body) || /^\S/.test(body)) break
      const n = /^ {4}name:\s*(.+)$/.exec(body)
      if (n?.[1] !== undefined) name = n[1].trim().replace(/^['"]|['"]$/g, '')
      const c = /^ {4}if:\s*(.+)$/.exec(body)
      if (c?.[1] !== undefined) condition = c[1]
    }

    const pushOnly = /github\.event_name\s*==\s*'push'/.test(condition)
    out.push({
      workflow,
      id,
      name,
      requireable: onPullRequest && !pushOnly,
      why: !onPullRequest
        ? 'its workflow does not trigger on pull_request'
        : pushOnly
          ? 'it runs only on push, so it would never report on a pull request'
          : undefined,
    })
  }
  return out
}

export function allJobs(): Job[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .flatMap((f) => jobsIn(f, readFileSync(join(DIR, f), 'utf8')))
}

if (import.meta.main) {
  const jobs = allJobs()
  const required = jobs.filter((j) => j.requireable).map((j) => j.name)

  if (required.length < MIN_CONTEXTS) {
    console.error(
      `only ${required.length} requireable job(s) found, expected at least ${MIN_CONTEXTS}. ` +
        'The workflow parse broke; protection must not be narrowed on the strength of that.',
    )
    process.exit(1)
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(required))
  } else {
    for (const j of jobs) {
      if (j.requireable) console.log(j.name)
      else console.error(`  excluded: ${j.workflow} / ${j.id} - ${j.why}`)
    }
  }
}
