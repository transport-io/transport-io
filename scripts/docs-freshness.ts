/**
 * If a change touches library source and no documentation file changed, say which
 * documents may need updating and require an explicit acknowledgement.
 *
 * Documentation updates ship in the SAME commit as the change, never in a follow-up.
 * A follow-up commit is a promise, and promises are how documentation goes stale.
 * This applies to humans and agents equally (CLAUDE.md).
 */
import { execSync } from 'node:child_process'

const ACK = 'DOCS_ACK'
const SOURCE = /^packages\/[^/]+\/src\//
const DOCS = /^(API\.md|PROTOCOL\.md|README\.md|AGENTS\.md|DECISIONS\.md|ADR\/)/

const baseIdx = process.argv.indexOf('--base')
const range = baseIdx > -1 ? `${process.argv[baseIdx + 1]}...HEAD` : '--cached'
const staged: string[] = execSync(`git diff ${range} --name-only`, { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

const touchedSource = staged.filter((f) => SOURCE.test(f) && !f.includes('.test.'))
const touchedDocs = staged.filter((f) => DOCS.test(f))

if (touchedSource.length > 0 && touchedDocs.length === 0) {
  if (process.env[ACK] === '1') {
    console.log(`[docs] ${ACK}=1 — proceeding without a documentation change.`)
    process.exit(0)
  }
  console.error('')
  console.error('  Library source changed and no documentation did.')
  console.error('')
  for (const f of touchedSource) console.error(`    changed: ${f}`)
  console.error('')
  console.error('  Documents that may need updating in THIS commit:')
  console.error('    API.md        — if any exported signature changed')
  console.error('    PROTOCOL.md   — if any wire format, constant or error code changed')
  console.error('    DECISIONS.md  — if this implements or revises a decision')
  console.error('    ADR/          — if this reverses something a record explains')
  console.error('')
  console.error(`  If none apply, re-run with ${ACK}=1 to record that judgement.`)
  console.error('')
  process.exit(1)
}
