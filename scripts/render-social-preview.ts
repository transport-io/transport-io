/**
 * Renders `assets/social/preview.html` to `assets/social/preview.png` at exactly 1280 by
 * 640, which is what GitHub's social preview wants.
 *
 * The wordmark is IBM Plex Mono SemiBold, live text. The brand notes say to outline it
 * wherever the font is not installed; a raster is the outline, so this script needs the font
 * at render time. It looks in `--font-dir` for `plex-latin-400.woff2` and
 * `plex-latin-600.woff2`, else falls back to whatever the system has, and says which it did.
 *
 *   bun run scripts/render-social-preview.ts --font-dir /path/with/woff2
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'

const ROOT = resolve(import.meta.dirname, '..')
const html = join(ROOT, 'assets/social/preview.html')
const png = join(ROOT, 'assets/social/preview.png')
const fontDirArg = process.argv.indexOf('--font-dir')
const fontDir = fontDirArg >= 0 ? process.argv[fontDirArg + 1] : undefined

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: 1280, height: 640 },
  deviceScaleFactor: 1,
})
await page.goto(`file://${html}`)

const faces = [400, 600].map((w) => ({
  w,
  file: fontDir ? join(fontDir, `plex-latin-${w}.woff2`) : '',
}))
if (fontDir && faces.every((f) => existsSync(f.file))) {
  await page.addStyleTag({
    content: faces
      .map(
        (f) =>
          `@font-face{font-family:'IBM Plex Mono';font-weight:${f.w};src:url('file://${f.file}') format('woff2');}`,
      )
      .join('\n'),
  })
  await page.evaluate('document.fonts.ready')
  console.log(`social preview: IBM Plex Mono from ${fontDir}`)
} else {
  console.log('social preview: IBM Plex Mono not supplied, rendering with the system fallback')
  console.log('  pass --font-dir <dir> holding plex-latin-400.woff2 and plex-latin-600.woff2')
}

await page.screenshot({ path: png, type: 'png' })
await browser.close()
console.log(`social preview: wrote ${png}`)
