# The demo recording

There is no live demo on the site and there will not be a fake one. The demo needs a server
with raw UDP ingress; GitHub Pages is static. So the landing page reserves a slot with the
aspect ratio locked, and this is what goes in it.

The point being demonstrated is the one thing that is hard to believe from prose:
**two streams running at once, one cancelled, and the other does not notice.**

## The page

`examples/chat/web/agents.html`. Two panels, each running `client.stream('generate', …)`
against the same session, a stop button under each, a token counter and a live rate under
each, and **open streams** in the header reading `2` and then `1`.

```bash
cd examples/chat && bun run dev   # then http://localhost:8080/agents.html
```

Both panels start on load and run for about eighteen and twenty-two seconds. That is slower
than a model answers, and it is set against the clock rather than for realism: at a realistic
rate both finish in thirteen seconds, which is less time than a first-time visitor takes to
find the stop button.

The counter that carries the shot is the one that appears beside the panel you did **not**
stop: `+N since agent-a stopped`, starting at zero and climbing while the other panel sits
frozen. `e2e/two-streams-one-session.spec.ts` asserts it in both directions against a bound
computed from the server's own pacing, so a recording can never show something the suite is
not already holding true.

The tokens come from a fixed script in `examples/chat/agents.ts` and no model is called.
Pacing is a function of the token index rather than a random source, so two takes of the same
run are identical - which is the difference between recording this once and recording it
eleven times.

## Shot list

Eleven seconds of real content, looped. No cuts, no speed-ups: a cut is where a viewer
assumes you hid the latency.

Press **restart both** off camera, then start recording.

| t | what is on screen |
|---|---|
| 0.0s | Both panels nearly empty. **open streams** reads `2`. |
| 0.5s | Tokens filling A and B at visibly different rates. |
| 3.0s | Both mid-generation, both counters climbing. |
| 4.0s | Cursor moves to **stop** under panel A. Nothing else changes. |
| 4.5s | Click. **A stops on the same frame.** Its counter freezes and its state reads `stopped`. |
| 4.6s | **open streams** drops to `1`. `+N since agent-a stopped` appears under B, at `+1`. |
| 6.0s | B still going, A still frozen, the `+N` climbing and B's rate unchanged. |
| 11.0s | Cut. Loop. |

The frame at 4.5s is the whole recording. If the stop is not visibly instant, the take is
wasted, so record at 60 fps and check that frame before keeping it.

The clip ends mid-generation because a full run is eighteen seconds and the loop has to be
short. That is fine: nothing in the shot depends on either panel finishing, and B still
running when the clip cuts is the point rather than a loose end.

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
