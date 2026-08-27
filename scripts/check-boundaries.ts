/**
 * D14's runtime split, enforced against what people actually write.
 *
 * The rule: anything that loads the quiche transport runs on Node; everything else runs on
 * Bun. It is enforced because the native addon segfaults Bun on exit - measured 3/3 runs -
 * and a segfault *after* a reporter has printed its summary looks like a pass.
 *
 * The Biome rule that was supposed to carry this matches three package specifiers and
 * nothing else, so `import { connectHttp3 } from './transport/fails.node.ts'` inside a plain
 * `*.test.ts` sailed straight through. That import is the more likely mistake of the two:
 * nobody reaches for the raw package name, they reach for the wrapper next door.
 *
 * So this checks the property rather than a list of package names - a module that is not
 * itself Node-only may not reach anything that is, by any specifier.
 *
 *   bun run scripts/check-boundaries.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Violation {
  readonly file: string
  readonly line: number
  readonly specifier: string
}

/** Package specifiers that load a native addon, and the wrappers around them. */
const NODE_ONLY_PACKAGES = [
  '@fails-components/webtransport',
  '@fails-components/webtransport-transport-http3-quiche',
  '@moq/web-transport',
]

/** A module is Node-only if its own name says so. That is the whole convention. */
export function isNodeOnly(file: string): boolean {
  return /\.node\.(test\.)?ts$/.test(file)
}

export function findBoundaryViolations(file: string, source: string): Violation[] {
  if (isNodeOnly(file)) return []
  const out: Violation[] = []
  for (const [i, line] of source.split('\n').entries()) {
    // Anchored at the start of the line on purpose. An unanchored match also fires inside
    // string literals - including this checker's own doc comment and its test's fixtures,
    // which are made entirely of the thing being detected.
    const m =
      /^\s*(?:import|export)\b[^'"]*['"]([^'"]+)['"]/.exec(line) ??
      /^\s*(?:const|let|var)\s[^'"]*\bimport\s*\(\s*['"]([^'"]+)['"]/.exec(line) ??
      /^\s*(?:await\s+|void\s+|return\s+)?import\s*\(\s*['"]([^'"]+)['"]/.exec(line)
    const specifier = m?.[1]
    if (specifier === undefined) continue

    const isPackage = NODE_ONLY_PACKAGES.some(
      (p) => specifier === p || specifier.startsWith(`${p}/`),
    )
    // The one the package-name rule could never see: a relative import of a Node-only module.
    const isRelativeNodeModule = /^\.{1,2}\//.test(specifier) && /\.node\.ts$/.test(specifier)
    if (isPackage || isRelativeNodeModule) {
      out.push({ file, line: i + 1, specifier })
    }
  }
  return out
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p)
    return e.name.endsWith('.ts') ? [p] : []
  })
}

/**
 * This checker's own test is excluded, and it is the only exclusion. Its entire content is
 * fixtures of the thing being detected, so scanning it would be scanning a list of examples
 * - and an exclusion list that grows past one entry is a rule losing an argument.
 */
const SELF_TEST = 'check-boundaries.test.ts'

/**
 * A floor, because finding nothing is far more often a broken glob than a clean repository.
 *
 * An aggregate over an empty collection compared against a bound *passes*: zero violations
 * is zero, which is under every threshold. That is how the lane soak reported
 * `peak RSS -Infinity  bound < 600  PASS` having sampled nothing. A gate that cannot tell
 * "clean" from "looked at nothing" is not a gate.
 */
const MIN_FILES = 40

export function scan(
  roots: readonly string[] = ['packages', 'examples', 'scripts'],
): Violation[] {
  const files = roots.flatMap((r) => sourceFiles(r)).filter((f) => !f.endsWith(SELF_TEST))
  if (files.length < MIN_FILES) {
    throw new Error(
      `scanned ${files.length} source file(s), expected at least ${MIN_FILES}. ` +
        'Zero violations across nothing is not the same as zero violations.',
    )
  }
  return files.flatMap((f) => findBoundaryViolations(f, readFileSync(f, 'utf8')))
}

if (import.meta.main) {
  const violations = scan()
  for (const v of violations) {
    console.error(
      `${v.file}:${v.line}  imports '${v.specifier}'\n` +
        '  This module is not Node-only, so it may be loaded by Bun, where the native addon ' +
        'segfaults on exit.\n  Rename it to *.node.ts, or move the import behind one. See D14.',
    )
  }
  if (violations.length > 0) {
    console.error(`\n${violations.length} import-boundary violation(s).`)
    process.exit(1)
  }
  console.log('boundaries: no non-Node module reaches the transport')
}
