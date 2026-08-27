# The demo recording

There is no live demo on the site and there will not be a fake one. The demo needs a server
with raw UDP ingress; GitHub Pages is static. So the landing page reserves a slot with the
aspect ratio locked, and this is what goes in it.

The point being demonstrated is the one thing that is hard to believe from prose:
**two streams running at once, one cancelled, and the other does not notice.**

## What to build first

The chat example already streams. For the recording it needs a purpose-built page with two
panels side by side, which is a small addition to `examples/chat`:

- **Panel A and Panel B**, each running `client.stream('ask', …)` against the same session,
  rendering tokens as they arrive.
- **A stop button under panel A**, wired to `break` out of A's loop and nothing else.
- **A counter under each panel**: elements received, updating live.
- **A session-wide counter**: open streams, which should read `2`, then `1`.

Everything above already exists in the library. The panel is 30 lines of DOM.

## Shot list

Nine seconds of real content, looped. No cuts, no speed-ups: a cut is where a viewer assumes
you hid the latency.

| t | what is on screen |
|---|---|
| 0.0s | Both panels empty. Stream counter reads `0`. |
| 0.5s | Both start. Tokens begin filling A and B at slightly different rates. |
| 3.0s | Both mid-generation, both counters climbing, stream counter reads `2`. |
| 4.0s | Cursor moves to **Stop** under panel A. Nothing else changes. |
| 4.5s | Click. **A stops on the same frame.** Its counter freezes. |
| 4.6s | Stream counter drops to `1`. **B's counter does not pause, stutter or reset.** |
| 6.0s | B still going, A still frozen, the gap between the two counters growing. |
| 9.0s | B completes on its own. Loop. |

The frame at 4.5s is the whole recording. If the stop is not visibly instant, the take is
wasted, so record at 60 fps and check that frame before keeping it.

## Format

| property | value | why |
|---|---|---|
| capture | 2560 × 1440, 60 fps | Downscales cleanly to the 1120 px slot at 2× for retina. 60 fps is what makes "lands instantly" legible. |
| aspect | 16:9 exactly | The slot's `aspect-ratio` is locked to it, so any other ratio letterboxes or shifts the layout. |
| delivery | MP4, H.264, yuv420p, `-movflags +faststart` | Plays inline everywhere including iOS Safari. |
| audio | **no audio track at all** | Not merely muted. Saves bytes, and a video with a stripped audio track never trips an autoplay policy. |
| duration | 9 to 12 seconds, seamless loop | Long enough to show the gap growing after the stop; short enough to loop without irritation. |
| size budget | under 2 MB | It is the first thing on the page and it is on GitHub Pages. |
| poster | WebP or PNG, 2560 × 1440, the frame at 3.0s | Both panels mid-stream, so the still already tells the story before playback starts. |

One `ffmpeg` line that produces the delivery file from a screen capture:

```bash
ffmpeg -i capture.mov -an -vf scale=2560:1440 -c:v libx264 -profile:v high \
  -pix_fmt yuv420p -crf 23 -movflags +faststart site/public/demo.mp4
```

Drop the result at `site/public/demo.mp4` and the poster at `site/public/demo-poster.webp`,
and replace the placeholder in `site/src/content/docs/index.mdx` with the `<video>` element
commented next to it.
