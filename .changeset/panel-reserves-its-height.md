---
'@transport-io/devtools': patch
---

The open panel pads the page by its own height, and puts the padding back when it closes.
It is fixed along the bottom of the window, and a control under it was out of reach until the
panel was closed; found when the chat example's agents page mounted it and its stop buttons
were under the panel at a laptop's height. Now they are a scroll away.
