/**
 * The certificate `transport-io dev` pins.
 *
 * WebTransport will not accept an arbitrary self-signed certificate. It accepts one pinned
 * by hash, under constraints that are not ours and are easy to get wrong: ECDSA P-256, a
 * SHA-256 hash, and a total validity of at most 14 days. A newcomer should never learn any
 * of that, so this module owns all three and the CLI only asks for a usable certificate.
 *
 * Fourteen days means expiry is normal operation rather than an error. Every start checks,
 * and anything expired or expiring within a day is replaced silently. The user finds out
 * only because a line says the certificate was renewed, and because a browser tab holding
 * the old hash has to be reloaded.
 *
 * Minting shells out to `openssl` because Node cannot issue an X.509 certificate:
 * `crypto.Certificate` handles SPKAC only, and there is no issuance API. The alternative is
 * a runtime dependency, and this package has none for the CLI.
 */
import { execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The spec's ceiling. Not a preference, and not adjustable. */
export const MAX_VALIDITY_DAYS: number = 14

/**
 * Replace a certificate with less than this left. A whole day, so a `dev` session started
 * in the morning cannot expire underneath the person running it before evening.
 */
export const RENEW_WITHIN_MS: number = 24 * 60 * 60 * 1000

export interface DevCertificate {
  readonly cert: string
  readonly privKey: string
  /** SHA-256 over the DER, which is what `serverCertificateHashes` pins. */
  readonly sha256: Uint8Array
  readonly validTo: Date
  /** True when this start had to mint a new one, so open tabs hold a stale hash. */
  readonly renewed: boolean
}

function openssl(args: readonly string[]): void {
  try {
    execFileSync('openssl', [...args], { stdio: 'pipe' })
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(
      `openssl failed: ${detail}\n\n` +
        'transport-io dev mints a short-lived certificate with openssl, because Node cannot ' +
        'issue one. Install openssl and run this again: `brew install openssl` on macOS, ' +
        '`apt install openssl` on Debian or Ubuntu.',
    )
  }
}

function readIfUsable(certPath: string, keyPath: string): DevCertificate | undefined {
  if (!existsSync(certPath) || !existsSync(keyPath)) return undefined
  try {
    const cert = readFileSync(certPath, 'utf8')
    const privKey = readFileSync(keyPath, 'utf8')
    const x509 = new X509Certificate(cert)
    const validTo = new Date(x509.validTo)
    if (Number.isNaN(validTo.getTime())) return undefined
    if (validTo.getTime() - Date.now() < RENEW_WITHIN_MS) return undefined
    // The key has to match the certificate, not merely exist. An empty or stale `key.pem`
    // beside a valid `cert.pem` passed an existence check and was handed to the server,
    // which then failed to start for a reason no one running `dev` could be expected to
    // work out. Checking the pair is the only way to catch that here.
    if (!x509.checkPrivateKey(createPrivateKey(privKey))) return undefined
    return {
      cert,
      privKey,
      sha256: new Uint8Array(createHash('sha256').update(x509.raw).digest()),
      validTo,
      renewed: false,
    }
  } catch {
    // Corrupt, truncated, or not a certificate. Minting a new one is always the answer.
    return undefined
  }
}

/**
 * Returns a usable certificate, minting one only when there is not already a good one.
 *
 * `dir` should be somewhere already ignored by the project's version control, so this never
 * plants a private key in a commit and never has to edit anyone's `.gitignore`.
 */
export function ensureCertificate(dir: string): DevCertificate {
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')

  const existing = readIfUsable(certPath, keyPath)
  if (existing !== undefined) return existing

  mkdirSync(dir, { recursive: true })
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath])
  openssl([
    'req',
    '-new',
    '-x509',
    '-key',
    keyPath,
    '-out',
    certPath,
    '-days',
    String(MAX_VALIDITY_DAYS),
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ])

  const cert = readFileSync(certPath, 'utf8')
  const x509 = new X509Certificate(cert)
  return {
    cert,
    privKey: readFileSync(keyPath, 'utf8'),
    sha256: new Uint8Array(createHash('sha256').update(x509.raw).digest()),
    validTo: new Date(x509.validTo),
    renewed: true,
  }
}

/** Whole days left, floored, for the status line. */
export function daysLeft(validTo: Date, now: number = Date.now()): number {
  return Math.max(0, Math.floor((validTo.getTime() - now) / (24 * 60 * 60 * 1000)))
}
