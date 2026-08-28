import { describe, expect, test } from 'bun:test'
import { prefixRootLinks } from './base-links.ts'

const link = (url: string): { type: string; children: { type: string; url?: string }[] } => ({
  type: 'root',
  children: [{ type: 'link', url }],
})
const urlOf = (t: { children: { url?: string }[] }): string | undefined => t.children[0]?.url

describe('base prefixing', () => {
  test('a root-absolute link gains the base', () => {
    const t = link('/limitations/')
    expect(prefixRootLinks(t, '/transport-io')).toBe(1)
    expect(urlOf(t)).toBe('/transport-io/limitations/')
  })

  test('an anchor survives', () => {
    const t = link('/protocol/#6-6-call-credit')
    prefixRootLinks(t, '/transport-io')
    expect(urlOf(t)).toBe('/transport-io/protocol/#6-6-call-credit')
  })

  test('an already-prefixed link is untouched, so a second pass is a no-op', () => {
    const t = link('/transport-io/limitations/')
    expect(prefixRootLinks(t, '/transport-io')).toBe(0)
    expect(urlOf(t)).toBe('/transport-io/limitations/')
  })

  test('absolute, protocol-relative and bare-anchor links are left alone', () => {
    for (const url of [
      'https://example.com',
      '//cdn.example.com/x',
      '#section',
      'relative.md',
    ]) {
      const t = link(url)
      expect(prefixRootLinks(t, '/transport-io')).toBe(0)
      expect(urlOf(t)).toBe(url)
    }
  })

  test('an empty base changes nothing, so serving from the root still works', () => {
    const t = link('/limitations/')
    expect(prefixRootLinks(t, '/')).toBe(0)
    expect(urlOf(t)).toBe('/limitations/')
  })

  test('nested links are reached', () => {
    const t = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'link', url: '/reference/' }] }],
    }
    expect(prefixRootLinks(t, '/transport-io')).toBe(1)
  })
})
