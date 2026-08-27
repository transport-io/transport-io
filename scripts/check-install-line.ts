/**
 * Run the install command the documents give a reader, and check what it installs.
 *
 * This has been wrong twice, and the second one was written in the commit that fixed the
 * first. That is a pattern rather than bad luck, and the pattern is that an install
 * instruction is a *claim about how a package manager behaves* - nobody's intuition about
 * monorepo git installs is reliable, and mine was wrong in a document about not fabricating
 * things.
 *
 *   1. `npm install transport-io` - named an unpublished package, so a reader would either
 *      get a 404 or, worse, whatever stranger claimed the name.
 *   2. `npm install github:v0id-user/transport-io` (the repository's address at the time) - resolves the repository *root*, whose
 *      package is `transport-io-monorepo` and is private. What lands in `node_modules` is
 *      the monorepo, and `import … from 'transport-io'` fails.
 *
 * So it is executed rather than reasoned about. Every ```bash block in README.md and
 * packages/core/README.md whose first word is `npm install` is run in a temporary
 * directory, and the installed package must be the library.
 *
 *   bun run scripts/check-install-line.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DOCS = ['README.md', 'packages/core/README.md']
const LIBRARY = 'transport-io'

/** The package that must NOT end up installed: the private monorepo root. */
const ROOT_PACKAGE = JSON.parse(readFileSync('package.json', 'utf8')).name as string

export function installCommands(markdown: string): string[] {
  const out: string[] = []
  for (const m of markdown.matchAll(/^```bash\n([\s\S]*?)^```/gm)) {
    for (const line of (m[1] ?? '').split('\n')) {
      const cmd = line.trim()
      if (!cmd.startsWith('npm install ')) continue
      // Only the library's own install line. A reader installing the native transport is
      // following a different instruction with a different failure mode.
      if (cmd.includes('@fails-components') || cmd.includes('@moq/')) continue
      out.push(cmd)
    }
  }
  return out
}

const problems: string[] = []
const commands = DOCS.filter((d) => existsSync(d)).flatMap((d) =>
  installCommands(readFileSync(d, 'utf8')).map((c) => ({ doc: d, cmd: c })),
)

if (commands.length === 0) {
  /**
   * No install line is a legitimate state - the documents currently say clone and build,
   * because the package is not published. But "nothing to check" must not be silently
   * green, so the alternative instruction has to be there instead. Otherwise this gate
   * passes hardest on a README that tells a reader nothing at all.
   */
  for (const doc of DOCS.filter((d) => existsSync(d))) {
    const text = readFileSync(doc, 'utf8')
    if (!/git clone https:\/\/github\.com\/[^\s]+/.test(text)) {
      problems.push(
        `${doc}: no \`npm install ${LIBRARY}\` line and no clone-and-build instruction.\n` +
          '    A reader is told neither how to install it nor how to build it.',
      )
    }
  }
  console.log(
    `install: no \`npm install\` line yet; both READMEs give clone-and-build instead ` +
      `(${DOCS.length} checked)`,
  )
} else {
  for (const { doc, cmd } of commands) {
    const dir = mkdtempSync(join(tmpdir(), 'tio-install-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', private: true }))
      execFileSync('sh', ['-c', cmd], { cwd: dir, stdio: 'ignore', timeout: 180_000 })

      const installed = join(dir, 'node_modules', LIBRARY, 'package.json')
      const rootLanded = join(dir, 'node_modules', ROOT_PACKAGE, 'package.json')
      if (existsSync(rootLanded)) {
        problems.push(
          `${doc}: \`${cmd}\` installs '${ROOT_PACKAGE}' - the private monorepo root.\n` +
            `    \`import … from '${LIBRARY}'\` fails for anyone who follows this line.`,
        )
      } else if (!existsSync(installed)) {
        problems.push(`${doc}: \`${cmd}\` did not install '${LIBRARY}' at all.`)
      } else {
        const pkg = JSON.parse(readFileSync(installed, 'utf8')) as {
          name: string
          main?: string
        }
        if (pkg.name !== LIBRARY) {
          problems.push(`${doc}: \`${cmd}\` installed '${pkg.name}', not '${LIBRARY}'.`)
        } else {
          console.log(`install: \`${cmd}\` -> ${pkg.name} (from ${doc})`)
        }
      }
    } catch (e) {
      problems.push(
        `${doc}: \`${cmd}\` failed to run: ${(e as Error).message.split('\n')[0]}\n` +
          '    An install line that does not execute is not an instruction.',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

for (const p of problems) console.error(`\n${p}`)
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s).`)
  process.exit(1)
}
console.log('install: every documented install line was executed and installs the library')
