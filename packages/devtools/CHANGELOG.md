# @transport-io/devtools

## 0.1.0

### Minor Changes

- 6bcdcd0: The first release. A devtools panel in the page, because Chrome's network panel shows nothing
  useful for WebTransport: every frame in and out with its lane, event, stream and size, the
  call streams open now, the connection's status and transport, and the drops `stats()` counts,
  by event. Pause, a filter by event or lane, and copying the visible rows as text for an
  issue. `mountPanel(client, options?)` is framework-free, plain DOM in a shadow root, and reads
  no environment, so whether a build gets a panel is a line the application wrote.
  `TransportDevtools` from `@transport-io/devtools/react` takes the client as a prop, renders
  `null` unless `process.env.NODE_ENV` is `development`, and leaves none of the panel in a
  production bundle. Nothing loads either of them on its own. `createStore(client)` is the
  state behind the panel, for a panel of your own. Measured on `examples/chat` with both
  pointers driven at 60, 120 and 280 events a second: closed, no cost that can be measured;
  open, between 1 and 34 ms of main-thread time a second, and no dropped frame. It needs
  `transport-io` 0.13 or later.

### Patch Changes

- Updated dependencies [6d2a7c2]
- Updated dependencies [209f921]
  - transport-io@0.13.0
