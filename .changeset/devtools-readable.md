---
'@transport-io/devtools': patch
---

On a light page the panel's dim text was 4.38 to 1 against its ground and its accent text
3.46, under the 4.5 that text needs. Light-scheme text is now the site's next grey down and
its `accent-high`, and every text colour is held to 4.5 in both schemes by a test. The list
shows whole rows only: a few pixels of the row above the first used to show under the column
names.
