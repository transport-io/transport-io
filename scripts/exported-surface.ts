/**
 * Generate a probe that references every published export, so the TypeScript floor gate
 * covers the surface rather than a sample of it.
 *
 * `check-ts-floor.sh` used to compile a hand-written probe exercising five of forty-eight
 * exports. The declarations were all checked - `skipLibCheck` is off, so importing the
 * package checks its whole declaration graph - but only five were ever *used*, and a new
 * export that is unusable at TypeScript 5.0 would have passed. That is the allowlist shape
 * again (D98): coverage equal to what somebody remembered to add.
 *
 * So the list is derived from the shipped `index.d.ts`. Nothing to keep in step.
 *
 *   node scripts/exported-surface.ts <path to index.d.ts>
 */
import { readFileSync } from 'node:fs'

/** Below this the parse broke rather than the surface shrinking. */
const MIN_EXPORTS = 40

export interface Surface {
  readonly values: readonly string[]
  readonly types: readonly string[]
}

export function exportedSurface(dts: string): Surface {
  const values = new Set<string>()
  const types = new Set<string>()

  // `export declare const NAME`, `export declare function NAME`, and friends.
  for (const m of dts.matchAll(/^export declare (?:const|function|class|let|var)\s+(\w+)/gm)) {
    values.add(m[1] as string)
  }
  for (const m of dts.matchAll(/^export (?:type|interface)\s+(\w+)/gm)) {
    types.add(m[1] as string)
  }

  // `export { ... }` and `export type { ... }` re-export lists.
  for (const m of dts.matchAll(/^export\s+(type\s+)?\{([^}]*)\}/gm)) {
    const everythingIsAType = m[1] !== undefined
    for (const raw of (m[2] as string).split(',')) {
      const entry = raw.trim()
      if (entry.length === 0) continue
      // `X as Y` publishes Y; a leading `type ` marks this one entry as a type.
      const isType = everythingIsAType || entry.startsWith('type ')
      const name = entry
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim()
      if (name === undefined || name.length === 0) continue
      ;(isType ? types : values).add(name)
    }
  }

  return { values: [...values].sort(), types: [...types].sort() }
}

/**
 * A module that names every export. Values are referenced, so one that cannot be used at
 * this compiler version is an error. Types are imported by name, which is what proves each
 * is actually exported.
 */
export function probeSource(s: Surface): string {
  return [
    `import { ${s.values.join(', ')} } from 'transport-io'`,
    `import type { ${s.types.join(', ')} } from 'transport-io'`,
    '',
    '// Every published value, referenced. An export that cannot be used at this compiler',
    "// version fails here rather than in somebody else's project.",
    `export const surface: readonly unknown[] = [${s.values.join(', ')}]`,
    '',
    '// Every published type. The import is the assertion: a name that is not exported is',
    '// TS2305 here. They are deliberately not instantiated - most are generic, and picking',
    '// type arguments for each would be inventing usage rather than checking existence.',
    '',
  ].join('\n')
}

if (process.argv[2] !== undefined) {
  const surface = exportedSurface(readFileSync(process.argv[2], 'utf8'))
  const total = surface.values.length + surface.types.length
  if (total < MIN_EXPORTS) {
    console.error(
      `only ${total} export(s) parsed from ${process.argv[2]}, expected at least ${MIN_EXPORTS}. ` +
        'A probe generated from a broken parse would check almost nothing and pass.',
    )
    process.exit(1)
  }
  console.error(`ts floor: ${surface.values.length} value(s), ${surface.types.length} type(s)`)
  console.log(probeSource(surface))
}
