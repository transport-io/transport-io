---
'transport-io': patch
---

Two defects a fresh clone found and a working checkout could not. `npm run e2e` now builds the
library before the example, which imports it through its exports map and could not resolve it
in a clone where `dist` had never been built. And the install instructions no longer offer a
git install: the repository root is a private monorepo package, so `npm install
github:owner/repo` installs that root rather than the library.
