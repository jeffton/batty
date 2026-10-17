# Cloud browser rendering

The CSS viewport stays mobile-sized; capture uses a separate physical surface at the viewer’s DPR (up to 3). Headless Chromium requires `Emulation.setVisibleSize` in addition to device-metrics emulation: changing JavaScript DPR alone leaves screencast bitmaps at 1×.

Frames travel as binary JPEG over an authenticated, same-origin WebSocket. There are at most two unacknowledged frames and one replaceable latest frame per viewer. The client decodes one bitmap at a time and paints atomically on animation frames; discarded frames release their credits. It never predicts or locally pans remote content.

Continuous scrolling sends coalesced CSS deltas without HTTP round-trip gating. Anchor groups stay separate; an explicit drain fence prevents a subsequent HTTP click from overtaking scroll input. During sustained movement, capture uses at most 2× density/JPEG80. After 150 ms idle it requests full density/JPEG85. Resolution changes preserve the same page, login and click-coordinate system.

## Measurement

Run `pnpm exec tsx scripts/benchmark-cloud-browser.ts`. The benchmark uses a real remote Chromium page, native touch input in an emulated 390×844/DPR3 viewer, a TCP relay with 60 ms RTT and 20 Mbit/s downstream, and a three-second drag after initial frames settle. A color marker in the remote page identifies actual presented paints. It reports cadence, transport bytes, first response, final paint and full-resolution refinement separately.

Median of three runs against `06490c4` and the binary/retina pipeline:

| Measurement                       |    `06490c4` | Binary/retina |
| --------------------------------- | -----------: | ------------: |
| Presented changed frames/s        |          9.1 |          15.1 |
| 95th-percentile frame gap         |       124 ms |        100 ms |
| First changed paint               |       199 ms |        273 ms |
| Final changed paint after release |       229 ms |        197 ms |
| Full-density final refinement     | 229 ms at 1× |  431 ms at 3× |
| Transport bytes per gesture       |      3.32 MB |       3.19 MB |

Higher density improves sharpness and steady-motion cadence; the first changed paint remains slower in this software-rendered benchmark. Full-density refinement is deliberately separate from motion feedback.

This measures emulated mobile Chromium, not a physical iPhone. Capture/encoding, browser decode/composition and link conditions affect the result. The raster is 1074×2271 for a 358×757 CSS viewport at rest, and 716×1514 during motion; rotation is covered by the live browser fixture.

See [runtime](runtime.md#shared-cloud-browser) and [client API](../src/client/API.md#shared-cloud-browser) for authentication and lifecycle details.
