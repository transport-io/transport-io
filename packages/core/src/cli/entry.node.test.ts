/**
 * The CLI through the path npm actually runs it by.
 *
 * `node_modules/.bin/transport-io` is a symlink, and the entry guard compared
 * `process.argv[1]`, which keeps the link, with `import.meta.url`, which is the target. The
 * two never matched, so `npx transport-io dev --demo` exited 0 without printing a line, in
 * every release that had the guard. Nothing caught it because every test and every e2e ran
 * `node dist/cli/main.node.js` on the real path. This runs the symlink.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), 'main.node.ts')

const usageThrough = (entry: string): string =>
  execFileSync(process.execPath, [entry, '--help'], { encoding: 'utf8', stdio: 'pipe' })

test('the usage prints through an extensionless symlink, as it does on the real path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transport-io-bin-'))
  try {
    // Named as npm names it: no extension, so the loader has to reach the target itself.
    const link = join(dir, 'transport-io')
    symlinkSync(MAIN, link)
    const direct = usageThrough(MAIN)
    const linked = usageThrough(link)
    assert.match(direct, /transport-io dev/)
    assert.equal(linked, direct)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
