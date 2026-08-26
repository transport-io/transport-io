---
'transport-io': patch
---

The package is now shippable: an MIT LICENSE file exists (it was declared in package.json
and present nowhere, so GitHub detected no licence and granted no rights), the tarball
carries a README and the licence rather than `dist` alone, and `RemoteEnvelope` — required to
implement the `Adapter` interface — is exported. The install instructions no longer point at
an unpublished npm name, and AGENTS.md is compiled by the documentation gate, which
immediately caught two broken snippets in it.
