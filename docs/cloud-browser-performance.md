# Cloud browser rendering

Each viewed browser has a private headed Chromium/X11 display. Native FFmpeg x11grab → software H.264 capture supplies high-density pixels; the authenticated, same-origin binary WebSocket carries Annex-B access units and their codec, keyframe, stream and page/revision metadata. The popover uses WebCodecs `VideoDecoder` and canvas. Each viewer permits four unacknowledged video frames; its bounded dependent-frame queue discards an overflowing GOP and waits for a keyframe. There is no production JPEG fallback or local scroll prediction. Agent screenshots remain separate from the continuous video path.

Chromium launches at native device scale factor 3. CDP device metrics set CSS viewport, mobile layout and requested DPR. Motion capture scales to at most 2× density; idle capture uses requested density. Wheel idle is 150 ms; touch holds motion capture through pauses and one second after release. Density changes restart the encoder, not the browser/page. H.264 dimensions round up to even pixels: 358×757 CSS produces 1074×2272 at rest and 716×1514 in motion.

Capture-target polling reads local page/revision/viewport metadata every 100 ms. Full status (titles, tabs and focused fields) is read every 500 ms and on capture-target changes. Status retains session queues and revision guards; continuous video does not require full status reads.

Mobile finger input sends native CDP touch start/move/end/cancel events in CSS coordinates. Chromium owns hit testing, nested scrolling, touch-action handling, taps and release inertia. Only pending moves coalesce; gesture boundaries remain ordered. Native taps do not also send mouse clicks. Desktop wheel input sends coalesced CSS deltas with separate anchor groups. Both use WebSocket input without HTTP round-trip gating. A drain fence orders later HTTP controls after input dispatch, not after the resulting fling. Disconnects, coordinate changes and agent interactions cancel held touches; a live touch belongs to its originating viewer.

`client/browser/transport.ts` owns generations/reconnects, `frames.ts` owns video decoding/painting and credits, and `input.ts` owns gestures, focus and scroll fences. `BrowserPopover.vue` handles layout and viewport sizing. Tool/viewer command schemas live in `server/browser-schemas.ts`; HTTP and WebSocket retain transport-specific guards around browser service operations.

## Production-path benchmark

The [accepted clean mobile comparison](cloud-browser-production-measurements.md#authoritative-clean-mobile-comparison) measures the actual popover, native touch, production routes and BrowserService against isolated historical JPEG code: about twice the useful updates and 79.5% less traffic, with 348 versus 300 ms median first response. It is not interchangeable with the standalone prototype or the contended initial controls.

```sh
BENCH_LABEL=h264-mobile node_modules/.bin/tsx scripts/benchmark-production-browser.ts
BENCH_LABEL=h264-local BENCH_RTT_MS=0 BENCH_DOWN_MBIT=1000 \
  node_modules/.bin/tsx scripts/benchmark-production-browser.ts
```

The harness launches only its own temporary browser/profile/display and loopback listeners. It does not attach to a user browser. Defaults: 20 isolated one-move trials, then a six-second continuous native-touch drag, in an emulated 390×844/DPR3 viewer. The remote page is 358×757 CSS. The FIFO relay adds 60 ms RTT and 20 Mbit/s downstream, or zero added RTT/1 Gbit/s for the local comparison. The relay's FIFO drain prevents the TCP chunk reordering observed in earlier timer-per-chunk experiments.

Latency is the viewer pointermove's source `event.timeStamp` → matching marker pixels drawn on canvas, using one viewer monotonic clock. Explicit CDP timestamps preserve the intended source gesture timeline identically in both implementations; previous production input stays unchanged in the historical control. Every accepted sparse trial must contain exactly one pointermove and one remote scroll event. Holding the finger before release excludes momentum from the single-move trial; the continuous workload uses the full native gesture path. It reports both canvas frames and changed-marker frames, plus downstream TCP bytes during the continuous interval. Capture restarts, frame credits, status polling, decoder and input queues are left intact.

These measurements end at canvas draw, not physical screen presentation. They do not measure a physical iPhone/Safari or David's network. Sparse first-response tests include a return from idle to motion capture; continuous throughput is a separate metric.

### Historical control without a production codec switch

Run the **same new harness** in a detached historical worktree. `470668d` contains the preceding production adaptive-JPEG stream; its unrelated standalone H.264 prototype is not used by this control.

```sh
git worktree add --detach /tmp/batty-jpeg-production-baseline 470668d
ln -s "$PWD/node_modules" /tmp/batty-jpeg-production-baseline/node_modules
cp scripts/benchmark-production-browser.ts /tmp/batty-jpeg-production-baseline/scripts/
cd /tmp/batty-jpeg-production-baseline
BENCH_LABEL=jpeg-mobile node_modules/.bin/tsx scripts/benchmark-production-browser.ts
BENCH_LABEL=jpeg-local BENCH_RTT_MS=0 BENCH_DOWN_MBIT=1000 \
  node_modules/.bin/tsx scripts/benchmark-production-browser.ts
```

The worktree and installed dependencies remain isolated from live runtime data. Run codec/profile cases sequentially with full test/build gates paused to avoid CPU contention. There is no environment variable that restores JPEG in the production application.

## Historical JPEG measurements

Historical JPEG harnesses and their analysis scripts are preserved at revision `470668d`. Run them from an isolated worktree at that revision to reproduce the stage measurements and standalone prototype below. Use `scripts/benchmark-production-browser.ts` for the current production path.

- [Stage measurements](cloud-browser-stage-measurements.md): fixed-DPR3 JPEG, 40 settled moves per profile. Local total 200/233 ms p50/p95; synthetic mobile 421/450 ms. Chromium→CDP JPEG accounted for about 95–111 ms, mobile image transport 207 ms and decode 25–27 ms. This is not the adaptive-JPEG control above.
- [Standalone H.264 prototype](h264-prototype.md): same headed target for both codec paths, mirrored input and a fixture adapter rather than actual BrowserService/popover integration. Mobile 190 vs 234 ms median, 28.7 vs 14.2 changed frames/s and 1.93 vs 14.39 Mbit/s. These gains cannot be presented as production integration measurements.
- Earlier three-second JPEG drag: 38 distinct motion frames (12.77 fps), 98 ms p95 frame gap, 367 ms first paint, 539 ms final native-density refinement and 5.83 MB. PNG gave 6.38 fps and 8.74 MB. Frame gaps are not input latency.
- Removing the redundant pre-wheel mousemove reduced median server operation p50 from 48.1 to 42.6 ms across three runs, but first input→visible stayed 296 vs 302 ms. Native touch later gave 318 ms/13.4 fps vs wheel's 273 ms/13.1 fps; its purpose was correct inertia/nested scrolling, not a demonstrated latency win.
- Fixed-DPR3 captures during motion measured 452 ms/8.4 fps for wheel and 519 ms/8.1 fps for native touch. Continuous reflected-input-age matching used cumulative position and was not slop-corrected; settled one-move trials are the stronger latency comparison.

## Verification and references

Raster size alone does not prove correct rendering. Browser tests exercise four viewport corners, edge clicks, nested and outer scrolling, rotation, tap deduplication, touch cancellation and disconnects. Codec support detection is not equivalent to decoding a complete live stream on a physical iPhone.

- [CDP native touch](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchTouchEvent)
- [WebCodecs low-latency configuration](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/configure)
- [FFmpeg x11grab](https://ffmpeg.org/ffmpeg-devices.html#x11grab)
- [Cua native capture](https://github.com/trycua/cua/blob/main/libs/cua-spacesd/crates/cua-spacesd-desktop/src/linux_stream.rs)
- [Selkies](https://github.com/selkies-project/selkies)
- [OpenAI computer-use example](https://github.com/openai/openai-cua-sample-app/blob/main/python-app/app/browser.py): discrete agent observations, not a continuous interactive video loop.

See [runtime](runtime.md#shared-cloud-browser) and [client API](../src/client/API.md#shared-cloud-browser) for authentication and lifecycle details.
