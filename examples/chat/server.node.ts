/** The local server. `npx transport-io dev server.node.ts` runs it and serves `web/`. */
import { createServer } from 'transport-io'
import { listenDev } from 'transport-io/node-transport'
import { attach } from './app.ts'
import { type ChatMap, contract } from './contract.ts'

const server = createServer<ChatMap>({ contract })
attach(server)

await server.listen(await listenDev(), {
  onAcceptError: (e) => console.error('session refused:', (e as Error).message),
})
