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
sed -e 's/"esnext"/"node16"/' -e 's/"bundler"/"node16"/' tsconfig.json > tsconfig.node16.json

cat > ok.ts <<'TS'
import { Client, createServer, defineContract, type MapOf, type$, VERSION } from 'transport-io'
import { connectBrowser } from 'transport-io/browser-transport'
import { HostileAdapter } from 'transport-io/testing'

export const contract = defineContract({
  chat: { lane: 'stream', payload: type$<{ body: string }>() },
  cursor: { lane: 'datagram', payload: type$<{ x: number; y: number }>() },
  save: { lane: 'stream', payload: type$<{ text: string }>(), returns: type$<{ n: number }>() },
})
export interface AppMap extends MapOf<typeof contract> {}

export const version: string = VERSION

export async function probe(url: string): Promise<number> {
  const server = createServer<AppMap>({ contract, adapter: new HostileAdapter('probe') })
  server.handle('save', async ({ text }) => ({ n: text.length }))

  const client = new Client<AppMap>({ contract, connect: () => connectBrowser({ url }) })
  client.emit('chat', { body: 'hello' })
  client.emit('cursor', { x: 1, y: 2 })
  const { n } = await client.call('save', { text: 'hi' })
  return n
}
TS

cat > bad.ts <<'TS'
import { Client, defineContract, type MapOf, type$ } from 'transport-io'

const contract = defineContract({
  chat: { lane: 'stream', payload: type$<{ body: string }>() },
})
interface AppMap extends MapOf<typeof contract> {}

declare const client: Client<AppMap>
client.emit('nope', { body: 'x' })
TS

TSC="$DIR/node_modules/typescript/bin/tsc"
echo "ts floor: $("$TSC" --version), package $TARBALL"

for cfg in tsconfig.json tsconfig.node16.json; do
  "$TSC" -p "$cfg"
  echo "ts floor: the published surface compiles at $FLOOR under $(sed -n 's/.*"moduleResolution": "\([a-z0-9]*\)".*/\1/p' "$cfg") resolution"
done

# Same settings, the wrong event name. Compiling this is the failure.
if "$TSC" -p tsconfig.bad.json > /dev/null 2>&1; then
  echo "ts floor: an unknown event name compiled at $FLOOR, so this gate proves nothing" >&2
  exit 1
fi
echo "ts floor: an unknown event name is still rejected at $FLOOR"
