---
'transport-io': minor
---

Register the contract once and drop the type argument from every construction site:

```ts
declare module 'transport-io' {
  interface Register {
    map: AppMap
  }
}

const client = new Client({ contract })
const server = createServer({ contract })
```

`Register` holds the map rather than the contract. Registering the contract would resolve the
map through a conditional type, which TypeScript expands in hover output: 377 characters
against 107 for the interface. The two-line contract pattern stays.

The explicit type argument still works and wins over the registration, which is what two
contracts in one process need. Forgetting to register fails at the first `emit` with an error
naming the fix. See D100.
