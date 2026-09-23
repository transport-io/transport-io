/**
 * SHA-256 for a page with no `crypto.subtle`. `eventIdOf` reaches it only through a dynamic
 * `import()`, so a bundler makes it a chunk of its own, loaded by a page that is not a secure
 * context and by no other. Only `sha256` is imported: `sha2.js` whole would put every SHA-2
 * variant in that chunk. See D156.
 */
import { sha256 as noble } from '@noble/hashes/sha2.js'

/** What `crypto.subtle.digest` resolves to, so `eventIdOf` reads either one the same way. */
export function sha256(bytes: Uint8Array): ArrayBuffer {
  return noble(bytes).slice().buffer
}
