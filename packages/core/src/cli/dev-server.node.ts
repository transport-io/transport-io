/**
 * The plain HTTP half of `transport-io dev`.
 *
 * Three jobs, and deliberately no fourth. It publishes the certificate hash at a fixed
 * endpoint so the browser can pin it; it serves the package's own built ESM so a page can
 * import the library without a bundler; and it serves whatever static files the project
 * already built.
 *
 * It does NOT bundle. Bundling browser TypeScript needs a bundler, which would be the first
 * runtime dependency this package has ever taken for the CLI, so a real project keeps
 * running its own `vite dev` or `bun build --watch` alongside this. The demo needs no
 * bundler because it imports the built ESM directly.
 *
 * `http` rather than `https` on purpose: `http://localhost` is a trustworthy origin, so the
 * page gets a secure context for free and only the WebTransport endpoint needs a certificate.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { DEV_ENDPOINT } from '../transport/dev.ts'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** Where the package's own built ESM is served, so a page can import it with no build step. */
export const LIB_PREFIX = '/_transport-io/'

export interface DevServerOptions {
  readonly port: number
  /** The directory of static files to serve, if the project has one. */
  readonly staticDir?: string
  /** Served at `/` when there is no static file for it. The demo uses this. */
  readonly indexHtml?: string
  /** The package's `dist`, served under `LIB_PREFIX`. */
  readonly distDir: string
  /** What the browser must pin, and where it should connect. */
  readonly manifest: { readonly sha256: readonly number[]; readonly url: string }
}

/**
 * Resolves a URL path inside a root, refusing anything that escapes it.
 *
 * A dev server still serves the filesystem, and `..` in a request path is the oldest way to
 * read a file that was never meant to be public.
 */
function safeJoin(root: string, urlPath: string): string | undefined {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '')
  const full = resolve(join(root, clean))
  const rootFull = resolve(root)
  if (full !== rootFull && !full.startsWith(rootFull + '/')) return undefined
  return full
}

function sendFile(res: ServerResponse, file: string): boolean {
  if (!existsSync(file)) return false
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(file)
  } catch {
    return false
  }
  if (!stat.isFile()) return false
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
  return true
}

export function startDevServer(opts: DevServerOptions): Promise<HttpServer> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'

    if (path === DEV_ENDPOINT) {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        // The hash changes when the certificate is renewed, so it must never be cached.
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(opts.manifest))
      return
    }

    if (path.startsWith(LIB_PREFIX)) {
      const file = safeJoin(opts.distDir, path.slice(LIB_PREFIX.length))
      if (file !== undefined && sendFile(res, file)) return
      res.writeHead(404).end('not found')
      return
    }

    if (opts.staticDir !== undefined) {
      const rel = path === '/' ? '/index.html' : path
      const file = safeJoin(opts.staticDir, rel)
      if (file !== undefined && sendFile(res, file)) return
    }

    if (opts.indexHtml !== undefined && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'content-type': MIME['.html'] as string })
      res.end(opts.indexHtml)
      return
    }

    res.writeHead(404).end('not found')
  })

  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(opts.port, '127.0.0.1', () => ok(server))
  })
}
