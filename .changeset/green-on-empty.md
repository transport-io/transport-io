---
'transport-io': patch
---

Every gate was fed an empty input set and six passed, because an aggregate over nothing is
inside every bound. All six now fail loudly: the norms, workflow, boundary and documentation
gates carry explicit floors, and `knip` and `attw` — which cannot be taught this from the
inside — are fronted by a check that their inputs are non-empty. The three unproven normative
statements are now zero: two were provable, and the third turned out to be a real defect,
since nothing stopped `call()` opening a stream on a closed session.
