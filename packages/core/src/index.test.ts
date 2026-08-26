import { expect, test } from 'bun:test'
import pkg from '../package.json' with { type: 'json' }
import { VERSION } from './index.ts'

test('VERSION matches the package manifest', () => {
  expect(VERSION).toBe(pkg.version)
})
