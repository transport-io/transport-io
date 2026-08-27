/**
 * The gate has to fail on the real defect, not on a fixture resembling it - so the last
 * test here runs against the actual `.github/workflows`. That test failed before the
 * workflow was fixed, which is the only evidence that any of this works.
 */
import { describe, expect, test } from 'bun:test'
import { findWorkflowViolations, scanWorkflowDir } from './check-workflows.ts'

const WITH_PERMISSIONS = 'permissions:\n  contents: read\n'

describe('interpolation into a run block', () => {
  test('the exact shape that shipped: a PR title spliced into a shell script', () => {
    const v = findWorkflowViolations(
      'ci.yml',
      `${WITH_PERMISSIONS}jobs:\n  a:\n    steps:\n      - run: echo "\${{ github.event.pull_request.title }}" | npx commitlint\n`,
    )
    expect(v.map((x) => x.rule)).toEqual(['run-interpolation'])
    expect(v[0]?.line).toBe(6)
  })

  test('a block scalar is scanned too, not just the inline form', () => {
    const v = findWorkflowViolations(
      'ci.yml',
      `${WITH_PERMISSIONS}jobs:\n  a:\n    steps:\n      - run: |\n          git fetch origin \${{ github.base_ref }}\n          echo done\n`,
    )
    expect(v.map((x) => x.rule)).toEqual(['run-interpolation'])
    expect(v[0]?.line).toBe(7)
  })

  test('a `name:` before the `run:` key does not hide it', () => {
    const v = findWorkflowViolations(
      'ci.yml',
      `${WITH_PERMISSIONS}jobs:\n  a:\n    steps:\n      - name: fetch\n        run: |\n          git fetch \${{ github.base_ref }}\n`,
    )
    expect(v.map((x) => x.rule)).toEqual(['run-interpolation'])
  })

  test('the block ends where indentation returns, so a later step is not misattributed', () => {
    const v = findWorkflowViolations(
      'ci.yml',
      `${WITH_PERMISSIONS}jobs:\n  a:\n    steps:\n      - run: |\n          echo safe\n      - uses: actions/checkout@v5\n        with: { ref: \${{ github.sha }} }\n`,
    )
    // `with:` is not a script. Substitution there is an input, not shell text.
    expect(v).toEqual([])
  })

  test('interpolation in `env:` is the fix, so it must not be flagged', () => {
    const v = findWorkflowViolations(
      'ci.yml',
      `${WITH_PERMISSIONS}jobs:\n  a:\n    steps:\n      - run: printf '%s' "$PR_TITLE" | npx commitlint\n        env:\n          PR_TITLE: \${{ github.event.pull_request.title }}\n`,
    )
    expect(v).toEqual([])
  })

  test('a word merely ending in run does not start a block', () => {
    const v = findWorkflowViolations(
      'ci.yml',
      `${WITH_PERMISSIONS}jobs:\n  a:\n    steps:\n      - name: dry-run: \${{ github.sha }}\n        uses: actions/checkout@v5\n`,
    )
    expect(v).toEqual([])
  })
})

describe('permissions', () => {
  test('a workflow with no permissions block is a violation', () => {
    const v = findWorkflowViolations('ci.yml', 'name: CI\njobs:\n  a:\n    steps: []\n')
    expect(v.map((x) => x.rule)).toEqual(['no-permissions'])
  })

  test('a job-level block does not satisfy it; the default must be stated at the top', () => {
    const v = findWorkflowViolations(
      'ci.yml',
      'name: CI\njobs:\n  a:\n    permissions:\n      contents: read\n    steps: []\n',
    )
    expect(v.map((x) => x.rule)).toEqual(['no-permissions'])
  })
})

describe('the repository as it actually is', () => {
  test('no workflow interpolates anything into a run block, and all state permissions', () => {
    // Before the fix this reported ci.yml:22 run-interpolation (the PR title) plus four
    // base_ref splices and a missing permissions block. It is the reason this file exists.
    expect(scanWorkflowDir()).toEqual([])
  })
})
