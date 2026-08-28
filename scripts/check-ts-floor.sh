#!/usr/bin/env bash
#
# The published .d.ts must be consumable by the oldest TypeScript this project claims.
# The floor is measured: 4.9.5 fails on the emitted `.d.ts` with TS1139 at the `const`
# type parameter, and 5.0.4 passes. That is D55; this script is what keeps it true.
#
# This runs against the PACKED TARBALL in a temporary directory, which is the design. Two earlier shapes of this gate were both wrong, in opposite directions:
#
#   1. `tsc --skipLibCheck packages/core/dist/index.d.ts` in the repository root. That flag
#      skips checking every declaration file *including the one named on the command line*,
#      so only parse-level diagnostics survived. The gate could not fail on anything a
#      consumer would hit.
#   2. The same command with the flag removed. It then type checked the entire ambient
#      surface of the repository's dev tree under a five-year-old compiler: `bun-types` and
#      `@types/node` against TS 5.0's `lib.dom.d.ts`, forty errors, none of them ours. Red
#      for three commits and about nothing.
#
# A consumer has our tarball, our declared dependencies, and their own tsconfig. So that is
# what is built here: `types: []` so no stray `@types` package is auto-included, an explicit
# `lib`, and `skipLibCheck` off so our declarations and our dependencies' declarations are
# actually checked.
#
# Both consumer resolution modes are checked. D56 records that `moduleResolution: bundler`
# permits extensionless imports that resolve for a bundler and then fail for a consumer on
# `node16`, so passing under one of the two is not evidence about the other.
#
# The negative probe matters. A gate that compiles a file which imports nothing
# interesting passes for ever; this one asserts that a wrong event name is still rejected at
# the floor version, so the gate fails if the checking silently stops happening.
#
#   ./scripts/check-ts-floor.sh [version]
#
set -euo pipefail

FLOOR="${1:-5.0.4}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT

cd "$ROOT"
[ -f packages/core/dist/index.d.ts ] || { echo "no dist; run npm run build first" >&2; exit 1; }

npm --workspace packages/core pack --pack-destination "$DIR" --json > "$DIR/pack.json"
TARBALL="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[0].filename" "$DIR/pack.json")"

cd "$DIR"
printf '%s\n' '{ "name": "ts-floor-probe", "private": true, "type": "module" }' > package.json
npm i --silent --no-audit --no-fund --ignore-scripts "./$TARBALL" "typescript@$FLOOR"

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "es2022",
    "lib": ["es2022", "dom"],
    "types": [],
    "skipLibCheck": false
  },
  "files": ["ok.ts"]
}
JSON
sed 's/"ok.ts"/"bad.ts"/' tsconfig.json > tsconfig.bad.json
sed 's/"ok.ts"/"surface.ts"/' tsconfig.json > tsconfig.surface.json
sed -e 's/"esnext"/"node16"/' -e 's/"bundler"/"node16"/' tsconfig.json > tsconfig.node16.json

cat > ok.ts <<'TS'
import { Client, createServer, defineContract, type MapOf, type$, VERSION } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'
// Type-only: the node transport's declarations were never loaded at the floor version
// because the probe imported three of the four entry points.
import type { Http3Listener } from 'transport-io/node-transport'
import { HostileAdapter } from 'transport-io/testing'

export const contract = defineContract({
  chat: { lane: 'reliable', payload: type$<{ body: string }>() },
  cursor: { lane: 'unreliable', payload: type$<{ x: number; y: number }>() },
  save: { lane: 'reliable', payload: type$<{ text: string }>(), returns: type$<{ n: number }>() },
  ask: { lane: 'reliable', payload: type$<{ prompt: string }>(), yields: type$<string>() },
})
export interface AppMap extends MapOf<typeof contract> {}

export const version: string = VERSION
export type Listener = Http3Listener

export async function probe(url: string): Promise<number> {
  const server = createServer<AppMap>({ contract, adapter: new HostileAdapter('probe') })
  server.handle('save', async ({ text }) => ({ n: text.length }))
  server.handle('ask', async function* ({ prompt }) {
    yield prompt
  })

  const client = new Client<AppMap>({ contract, connect: () => connectBrowser({ url }) })
  client.emit('chat', { body: 'hello' })
  client.emit('cursor', { x: 1, y: 2 })
  const { n } = await client.call('save', { text: 'hi' })
  const tokens = await client.stream('ask', { prompt: 'hi' }).toArray()
  for await (const token of client.stream('ask', { prompt: 'hi' })) void token.length
  return n + tokens.length
}
TS

cat > bad.ts <<'TS'
import { Client, defineContract, type MapOf, type$ } from 'transport-io'

const contract = defineContract({
  chat: { lane: 'reliable', payload: type$<{ body: string }>() },
})
interface AppMap extends MapOf<typeof contract> {}

declare const client: Client<AppMap>
client.emit('nope', { body: 'x' })
TS

# Every published export, referenced. Generated from the tarball's own declarations rather
# than hand-listed: the probe above exercises the surface a user meets first, and this makes
# sure nothing ships that cannot be named or used at the floor version.
node "$ROOT/scripts/exported-surface.ts" "$DIR/node_modules/transport-io/dist/index.d.ts" > surface.ts

TSC="$DIR/node_modules/typescript/bin/tsc"
echo "ts floor: $("$TSC" --version), package $TARBALL"

for cfg in tsconfig.json tsconfig.node16.json tsconfig.surface.json; do
  "$TSC" -p "$cfg"
  echo "ts floor: ${cfg} compiles at $FLOOR under $(sed -n 's/.*"moduleResolution": "\([a-z0-9]*\)".*/\1/p' "$cfg") resolution"
done

# Every shipped declaration must be reachable from the public entry points, or it is not
# being checked at the floor version at all.
#
# The probe used to be a hand-written sample of the API: five of forty-eight exports, chosen
# by whoever wrote it. Measured, importing a single symbol pulls thirteen of twenty-four
# declaration files into the program, so eleven were never type checked at 5.0 and a
# declaration broken there would have shipped. Coverage is now driven by the tarball rather
# than by the sample (D98).
"$TSC" -p tsconfig.json --listFiles > listed.txt
node -e '
const { readFileSync, readdirSync, statSync } = require("node:fs")
const { join } = require("node:path")
const root = "node_modules/transport-io/dist"
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".d.ts") ? [join(d, e.name)] : [])
const shipped = walk(root)
const listed = readFileSync("listed.txt", "utf8")

// Declarations that ship but no public entry point can reach. Each is dead weight in the
// tarball rather than a hole in the probe, and each is listed so the distinction stays
// visible: an unreachable file nobody named is a gap, an unreachable file with a reason is
// a decision. Trimming them from the build is a separate change.
const UNREACHABLE = {
  "codec.d.ts": "internal encode/decode, not exported and not in the exports map",
  "hub.d.ts": "internal room fan-out, reachable only through Server",
  "origin.d.ts": "internal origin allocator, reachable only through Server",
  "transport/moq.node.d.ts": "the alternative transport behind the ADR 0007 seam, unexported",
  "transport/parity-suite.d.ts": "test infrastructure for transport implementers",
}
const missing = shipped
  .filter((f) => !listed.includes(f))
  .filter((f) => !(f.slice(root.length + 1) in UNREACHABLE))
if (shipped.length < 10) {
  console.error(`only ${shipped.length} declaration file(s) shipped; the walk found nothing`)
  process.exit(1)
}
if (missing.length > 0) {
  console.error(`\n${missing.length} shipped declaration(s) are never loaded at the floor version:`)
  for (const m of missing) console.error(`    ${m.slice(root.length + 1)}`)
  console.error("\n    Either the probe does not reach them, or nothing does and they are dead")
  console.error("    weight in the tarball. Both are worth knowing; neither is checked today.")
  process.exit(1)
}
const exempt = Object.keys(UNREACHABLE).length
console.log(
  `ts floor: ${shipped.length - exempt} of ${shipped.length} shipped declaration(s) checked, ` +
    `${exempt} unreachable by design`,
)
'

# Same settings, the wrong event name. Compiling this is the failure.
if "$TSC" -p tsconfig.bad.json > /dev/null 2>&1; then
  echo "ts floor: an unknown event name compiled at $FLOOR, so this gate proves nothing" >&2
  exit 1
fi
echo "ts floor: an unknown event name is still rejected at $FLOOR"
