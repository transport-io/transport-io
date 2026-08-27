/**
 * Floors for the gates we do not own.
 *
 * An aggregate over an empty collection compared against a bound *passes*. Our own scripts
 * now refuse to report a clean run over nothing, but `knip` and `attw` are third-party and
 * cannot be taught that from the inside - both were measured green against empty input:
 *
 *   knip, on a project whose entry patterns match no files  -> exit 0, `{"issues":[]}`
 *   attw, on a package whose `dist` is empty                -> exit 0
 *
 * Neither is a bug in those tools. "No issues" is a truthful answer to "look at nothing".
 * The floor has to come from the caller, which is here.
 *
 *   bun run scripts/check-gate-inputs.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const problems: string[] = []

// ---------------------------------------------------------------- knip sees files
/**
 * Every `entry` pattern in the knip config must match at least one file. A pattern that
 * stops matching - a directory rename, an extension change - turns dead-code analysis into
 * a tool that reports no dead code because it found no code.
 */
const KNIP_CONFIG = existsSync('knip.jsonc') ? 'knip.jsonc' : 'knip.json'

function filesUnder(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory())
      return e.name === 'node_modules' || e.name === 'dist' ? [] : filesUnder(p)
    return [p]
  })
}

/**
 * Each declared workspace must exist and contain source. Deliberately not a glob engine:
 * translating knip's patterns by hand would put a second, subtly different matcher in the
 * repository, and the first draft of exactly that reported three false negatives against
 * patterns that do match. The failure this needs to catch is a config pointing somewhere
 * that no longer holds code - a renamed directory, a moved workspace - and a floor on files
 * under the workspace root catches it without pretending to reimplement anything.
 */
const MIN_FILES_PER_WORKSPACE = 2

if (existsSync(KNIP_CONFIG)) {
  // Comments are legal in .jsonc and this needs no parser to strip them.
  const raw = readFileSync(KNIP_CONFIG, 'utf8').replace(/^\s*\/\/.*$/gm, '')
  const config = JSON.parse(raw) as {
    workspaces?: Record<string, { entry?: string[]; project?: string[] }>
  }
  const workspaces = Object.entries(config.workspaces ?? {})
  if (workspaces.length === 0) problems.push(`knip: ${KNIP_CONFIG} declares no workspaces`)

  for (const [ws, spec] of workspaces) {
    const root = ws === '.' ? '.' : ws
    if (!existsSync(root)) {
      problems.push(`knip: workspace '${ws}' does not exist, so knip analyses nothing there`)
      continue
    }
    const ts = filesUnder(root).filter((f) => f.endsWith('.ts'))
    if (ts.length < MIN_FILES_PER_WORKSPACE) {
      problems.push(
        `knip: workspace '${ws}' holds ${ts.length} TypeScript file(s), expected at least ` +
          `${MIN_FILES_PER_WORKSPACE}. knip reports no dead code when it finds no code.`,
      )
    }
    if ((spec.entry ?? []).length === 0) {
      problems.push(`knip: workspace '${ws}' declares no entry patterns`)
    }
  }
  console.log(`knip: ${workspaces.length} workspace(s), each present and holding source`)
} else {
  problems.push('knip: no config found, so nothing constrains what it analyses')
}

// ---------------------------------------------------------------- the tarball has content
/**
 * Every target named by the package's `exports` map must exist in the packed tarball.
 * `attw` reports no problems for a package with an empty `dist`, which is true and useless:
 * a build that silently produced nothing would ship, and the first person to import it
 * would find out.
 */
const PKG = 'packages/core'
const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
  exports?: Record<string, Record<string, string>>
}
const targets = Object.values(pkg.exports ?? {}).flatMap((entry) => Object.values(entry))
if (targets.length === 0) problems.push(`${PKG}: no exports map, so nothing is being validated`)

const packed = execFileSync('npm', ['--workspace', PKG, 'pack', '--dry-run', '--json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
})
const files = (JSON.parse(packed) as { files: { path: string }[] }[])[0]?.files ?? []
const paths = new Set(files.map((f) => f.path))

for (const target of targets) {
  const rel = target.replace(/^\.\//, '')
  if (!paths.has(rel)) {
    problems.push(
      `${PKG}: exports names '${target}', which is not in the tarball.\n` +
        `    attw and publint both pass on an empty dist; ${files.length} file(s) packed.`,
    )
  }
}
console.log(
  `pack: ${targets.length} exports target(s), all present among ${files.length} files`,
)

for (const p of problems) console.error(`\n${p}`)
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s). A gate that looked at nothing is not a pass.`)
  process.exit(1)
}
console.log('gate inputs: knip and pack validation both have something to look at')
