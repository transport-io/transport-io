import { defineConfig } from 'vite'

export default defineConfig({
  // `transport-io dev` publishes the certificate hash on 3000; the page on 5173 reads it there.
  server: { proxy: { '/.well-known/transport-io-dev': 'http://localhost:3000' } },
})
