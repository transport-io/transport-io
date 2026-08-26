import type { UserConfig } from '@commitlint/types'

/**
 * Scope is required and validated against the actual workspace package list,
 * so `feat(cor):` fails. See DECISIONS.md D29.
 *
 * No commit ever has a body. Breaking changes use the `!` marker, because a
 * `BREAKING CHANGE:` footer would require one.
 */
const scopes = ['core', 'ci', 'docs', 'deps', 'repo']

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
