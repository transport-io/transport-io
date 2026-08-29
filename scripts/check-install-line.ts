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
 * So it is executed rather than reasoned about. Every ```bash block in every tracked
 * markdown file whose first word is `npm install` is run in a temporary directory, and the
 * installed package must be the library.
 *
 *   bun run scripts/check-install-line.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every tracked markdown file, discovered rather than listed.
 *
 * This used to name two documents. `AGENTS.md` carried a third install line that nothing
 * ever executed, missed twice over: wrong file, and its fence had no language tag so even
 * the pattern would not have matched. A gate scoped to the documents somebody remembered is
 * blind to the one they forgot, which is the shape of every allowlist in this repository
 * (D98).
 */
// `--cached --others --exclude-standard` rather than a bare `ls-files`: a bare one reads
// the index, so a file that exists on disk but has never been `git add`ed is invisible to
// the gate. That is how a new guide with four compile errors passed - it was untracked, so
// nothing enumerated it. `--others` adds working-tree files, `--exclude-standard` keeps
// gitignored build output out. `existsSync` below covers the opposite case: an index entry
// whose file is gone, which is what `changeset version` leaves behind.
const DOCS: string[] = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((f) => f.length > 0 && !f.startsWith('site/dist'))

/** Fewer than this and the discovery broke rather than the documents losing their lines. */
const MIN_INSTALL_LINES = 3
const LIBRARY = 'transport-io'

/** The package that must NOT end up installed: the private monorepo root. */
const ROOT_PACKAGE = JSON.parse(readFileSync('package.json', 'utf8')).name as string

export function installCommands(markdown: string): string[] {
  const out: string[] = []
  // Any fence, tagged or not: the line this gate exists for lived in an untagged one.
  for (const m of markdown.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gm)) {
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

/**
 * Packages a documented install line names that are not on the registry yet.
 *
 * An install line for something unpublished is a lie, which is exactly what this gate exists
 * to catch, so an entry here is a debt rather than a decision. It can only shrink: the check
 * below asks the registry, and a package that has since been published fails until its entry
 * is removed, so this cannot quietly become permanent.
 */
const PENDING_PUBLISH: Readonly<Record<string, string>> = {
  '@transport-io/react': 'the React binding, built and documented before its first publish',
}

/** True when the registry has never heard of it. */
async function isUnpublished(pkg: string): Promise<boolean> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}`, {
      headers: { 'cache-control': 'no-cache' },
    })
    return res.status === 404
  } catch {
    // A network failure is not evidence either way, and guessing "unpublished" would turn
    // an offline run into a silent pass.
    return false
  }
}

const problems: string[] = []
const found = DOCS.filter((d) => existsSync(d)).flatMap((d) =>
  installCommands(readFileSync(d, 'utf8')).map((c) => ({ doc: d, cmd: c })),
)

/**
 * One run per distinct command, not per occurrence. Four documents repeating the same line
 * is four npm installs and one fact; the sources are reported together so a failure still
 * names every document that would mislead a reader.
 */
const commands = [...new Map(found.map((f) => [f.cmd, f])).values()].map((f) => ({
  cmd: f.cmd,
  doc: found
    .filter((o) => o.cmd === f.cmd)
    .map((o) => o.doc)
    .join(', '),
}))

if (found.length > 0 && found.length < MIN_INSTALL_LINES) {
  problems.push(
    `only ${found.length} install line(s) found across ${DOCS.length} document(s), ` +
      `expected at least ${MIN_INSTALL_LINES}. The discovery broke, or a document lost its line.`,
  )
}

if (commands.length === 0) {
  /**
   * No install line was a legitimate state before the package was published, when the
   * documents said clone and build instead. It is not one now, and this branch survives
   * only so that "nothing to check" can never be silently green: a document with neither
   * an install line nor a clone-and-build instruction tells a reader nothing at all, and
   * this gate would otherwise pass hardest on exactly that.
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
    `install: no \`npm install\` line found; every document gives clone-and-build instead ` +
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
      const named = Object.keys(PENDING_PUBLISH).find((p) => cmd.includes(p))
      if (named !== undefined && (await isUnpublished(named))) {
        console.log(
          `install: \`${cmd}\` skipped - ${named} is not published yet ` +
            `(${PENDING_PUBLISH[named] ?? ''}), from ${doc}`,
        )
        continue
      }
      problems.push(
        `${doc}: \`${cmd}\` failed to run: ${(e as Error).message.split('\n')[0]}\n` +
          '    An install line that does not execute is not an instruction.',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

for (const [pkg, why] of Object.entries(PENDING_PUBLISH)) {
  if (!(await isUnpublished(pkg))) {
    problems.push(
      `${pkg} is recorded as pending publish and is now on the registry.\n` +
        `    Remove it from PENDING_PUBLISH so its install line is executed. Reason given: ${why}`,
    )
  }
}

for (const p of problems) console.error(`\n${p}`)
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s).`)
  process.exit(1)
}
console.log('install: every documented install line was executed and installs the library')
