import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { UserConfig } from '@commitlint/types'

/**
 * Scope is required and validated against the actual workspace package list, so
 * `feat(cor):` fails. See DECISIONS.md D29, and D98 for why it is derived rather than
 * listed.
 *
 * No commit ever has a body. Breaking changes use the `!` marker, because a
 * `BREAKING CHANGE:` footer would require one.
 */
/**
 * Package scopes are DERIVED from the workspaces, not listed here.
 *
 * They used to be a literal array, while `CLAUDE.md` claimed they were "validated against
 * the workspace package list". They were not, and the gap showed up the first time a
 * workspace was added: `site` existed, `feat(site):` was rejected, and the fix was to edit
 * a second list by hand. A list that must be kept in step with another list will not be.
 *
 * The meta scopes below are genuinely not packages, so they stay literal: they describe the
 * kind of change rather than the thing changed.
 */
const META_SCOPES = ['ci', 'docs', 'deps', 'repo']

const workspaceScopes = (): string[] => {
  const { workspaces = [] } = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
  ) as { workspaces?: string[] }

  return workspaces.flatMap((pattern) => {
    // `packages/*` means every directory under `packages`; `site` means itself.
    if (!pattern.endsWith('/*')) return existsSync(pattern) ? [basename(pattern)] : []
    const dir = pattern.slice(0, -2)
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'package.json')))
      .map((e) => e.name)
  })
}

const scopes = [...new Set([...workspaceScopes(), ...META_SCOPES])].sort()

if (scopes.length < META_SCOPES.length + 1) {
  throw new Error(
    `commitlint derived only ${scopes.length} scope(s); the workspace scan found nothing. ` +
      'Refusing to narrow the allowed scopes on the strength of a broken parse.',
  )
}

const config: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-empty': [2, 'never'],
    'scope-enum': [2, 'always', scopes],
    'subject-case': [2, 'never', ['upper-case', 'pascal-case', 'start-case']],
    'header-max-length': [2, 'always', 72],
    'body-empty': [2, 'always'],
    'footer-empty': [2, 'always'],
  },
}
export default config
