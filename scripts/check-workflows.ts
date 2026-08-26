/**
 * A workflow gate for the one CI defect that is exploitable rather than merely wrong.
 *
 * `${{ ... }}` inside a `run:` block is not a variable. GitHub substitutes it into the
 * script *text* before the shell ever sees it, so any expansion whose value an outsider
 * controls is arbitrary code on the runner. A pull request title is outsider-controlled by
 * definition, and the runner it lands on has the repository checked out, the dependency
 * tree installed and network egress — before a human has looked at the PR.
 *
 * The rule here is deliberately absolute rather than an allowlist of contexts believed
 * safe. `github.base_ref` is safe today because branch protection fixes the base; that is
 * a property of a setting somebody can change, not of the expression. Passing values
 * through `env:` is safe for a reason that cannot be revoked: the shell receives them as
 * data, and never re-parses them as script.
 *
 * Second rule: a workflow with no `permissions:` block inherits the repository default,
 * which on many repositories is read/write for every scope. Stating the minimum makes the
 * blast radius of the first rule failing a great deal smaller.
 *
 *   bun run scripts/check-workflows.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Violation {
  readonly file: string
  readonly line: number
  readonly rule: 'run-interpolation' | 'no-permissions'
  readonly detail: string
}

const WORKFLOW_DIR = '.github/workflows'

/**
 * Line-based on purpose: this must not depend on a YAML parser, because adding one to
 * catch a supply-chain problem would be its own supply-chain problem. The shapes it has
 * to recognise are `run: <script>` and `run: |` followed by a more-indented block, both
 * of which survive a scan far more simply than they survive a dependency.
 */
export function findWorkflowViolations(file: string, text: string): Violation[] {
  const out: Violation[] = []
  const lines = text.split('\n')

  if (!lines.some((l) => /^permissions:(\s|$)/.test(l))) {
    out.push({
      file,
      line: 1,
      rule: 'no-permissions',
      detail:
        'no top-level `permissions:` block, so this workflow inherits the repository ' +
        'default token scopes. State the minimum it needs, e.g. `contents: read`.',
    })
  }

  // Column of the `r` in `run:`, so a block body is anything indented past it.
  let runKeyColumn = -1

  for (const [i, line] of lines.entries()) {
    const at = line.search(/(?<![\w-])run:/)
    const indent = line.search(/\S/)

    if (runKeyColumn >= 0 && indent >= 0 && indent <= runKeyColumn) {
      runKeyColumn = -1 // the block ended: this line is a sibling or an ancestor
    }

    if (at >= 0 && /^\s*(-\s+)?(name:.*\s)?run:/.test(line)) {
      const inline = line.slice(at + 'run:'.length).trim()
      const isBlock = inline === '' || /^[|>][+-]?\d*$/.test(inline)
      runKeyColumn = isBlock ? at : -1
      if (!isBlock) flag(out, file, i, inline)
      continue
    }

    if (runKeyColumn >= 0) flag(out, file, i, line)
  }

  return out
}

function flag(out: Violation[], file: string, index: number, script: string): void {
  const m = /\$\{\{([^}]*)\}\}/.exec(script)
  if (m === null) return
  out.push({
    file,
    line: index + 1,
    rule: 'run-interpolation',
    detail:
      `\`\${{${m[1]}}}\` is substituted into the script text before the shell runs it. ` +
      'Bind it with `env:` and reference it as "$NAME", which the shell reads as data.',
  })
}

export function scanWorkflowDir(dir = WORKFLOW_DIR): Violation[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .flatMap((f) => findWorkflowViolations(join(dir, f), readFileSync(join(dir, f), 'utf8')))
}

if (import.meta.main) {
  const violations = scanWorkflowDir()
  for (const v of violations) console.error(`${v.file}:${v.line}  ${v.rule}\n  ${v.detail}`)
  if (violations.length > 0) {
    console.error(`\n${violations.length} workflow violation(s).`)
    process.exit(1)
  }
  console.log('workflows: no interpolation into run blocks, permissions stated')
}
