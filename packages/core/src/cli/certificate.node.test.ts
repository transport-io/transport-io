/**
 * The certificate lifecycle `transport-io dev` hides.
 *
 * Fourteen days is a specification constraint, so expiry is normal operation rather than a
 * fault, and the person running the command should never have to understand it. That makes
 * the renewal path the part worth testing: it runs unattended, and if it is wrong the
 * failure arrives as a browser refusing to connect for no visible reason.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  daysLeft,
  ensureCertificate,
  MAX_VALIDITY_DAYS,
  RENEW_WITHIN_MS,
} from './certificate.node.ts'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'tio-cert-'))

describe('minting', () => {
  test('produces a pinnable certificate on a clean directory', () => {
    const c = ensureCertificate(scratch())
    assert.equal(c.renewed, true)
    // 32 bytes, because `serverCertificateHashes` pins a SHA-256 over the DER.
    assert.equal(c.sha256.length, 32)
    assert.ok(c.cert.includes('BEGIN CERTIFICATE'))
    assert.ok(c.privKey.includes('PRIVATE KEY'))
    // Inside the ceiling the specification imposes, not merely close to it.
    assert.ok(daysLeft(c.validTo) <= MAX_VALIDITY_DAYS)
    assert.ok(daysLeft(c.validTo) > MAX_VALIDITY_DAYS - 2)
  })

  test('a second start reuses it, so the hash a tab pinned stays valid', () => {
    const dir = scratch()
    const first = ensureCertificate(dir)
    const second = ensureCertificate(dir)
    assert.equal(second.renewed, false)
    assert.deepEqual([...second.sha256], [...first.sha256])
  })
})

describe('recovery', () => {
  test('a corrupt certificate is replaced rather than thrown', () => {
    const dir = scratch()
    ensureCertificate(dir)
    writeFileSync(join(dir, 'cert.pem'), 'not a certificate')
    const c = ensureCertificate(dir)
    assert.equal(c.renewed, true)
    assert.equal(c.sha256.length, 32)
  })

  test('a missing key is replaced even when the certificate looks fine', () => {
    const dir = scratch()
    const first = ensureCertificate(dir)
    writeFileSync(join(dir, 'key.pem'), '')
    // The certificate file is still valid, so only pairing them catches this.
    const c = ensureCertificate(dir)
    assert.ok(readFileSync(join(dir, 'key.pem'), 'utf8').includes('PRIVATE KEY'))
    assert.notDeepEqual([...c.sha256], [...first.sha256])
  })
})

describe('the renewal threshold', () => {
  test('a whole day, so a morning session cannot expire by evening', () => {
    assert.equal(RENEW_WITHIN_MS, 24 * 60 * 60 * 1000)
  })

  test('daysLeft floors, and never goes negative', () => {
    const now = Date.UTC(2026, 0, 10)
    assert.equal(daysLeft(new Date(Date.UTC(2026, 0, 20)), now), 10)
    // Most of a day left is still zero days: the status line must not round up to "1d".
    assert.equal(daysLeft(new Date(now + 23 * 60 * 60 * 1000), now), 0)
    assert.equal(daysLeft(new Date(Date.UTC(2026, 0, 1)), now), 0)
  })

  test('the ceiling is the specification constant, not a preference', () => {
    assert.equal(MAX_VALIDITY_DAYS, 14)
  })
})
