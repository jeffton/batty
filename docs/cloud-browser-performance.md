# Cloud browser rendering

Chromium launches with native device scale factor 3. CDP device metrics set the page’s CSS viewport, mobile layout and requested DPR independently. Native compositor capture supplies real high-density pixels; `setVisibleSize` is not used because enlarging that surface pads the page rather than rendering it at Retina density. Existing Chromium processes retain their launch settings and live state until closed.

CDP screencast JPEG frames travel directly over an authenticated, same-origin binary WebSocket. Capture does not run through the agent/input queue or trigger screenshots. Each viewer retains at most two unacknowledged frames and one replaceable latest paint. The client decodes one bitmap at a time and paints atomically; discarded frames release their credits. It never predicts or locally pans remote content.

Scrolling sends coalesced CSS deltas without HTTP round-trip gating. Anchor groups stay separate; a drain fence prevents a later click from overtaking scroll input. Screencast limits downsample to at most 2× density/JPEG80 during motion; after 150 ms idle, capture returns to the requested density/JPEG85. These limits do not upscale lower-density source pixels. Resolution changes preserve the page, login and CSS-coordinate input system.

## Verification

A large bitmap alone does not prove correct rendering. The binary-popover regression test checks page colors in all four viewport corners, edge clicks, nested scrolling, outer scrolling and rotation at DPR3. A 358×757 CSS viewport produces 1074×2271 pixels at rest and 716×1514 during motion, with the page filling the image.

Run `pnpm exec tsx scripts/benchmark-cloud-browser.ts` for repeatable performance measurements. It uses a real remote Chromium page, native touch input in an emulated 390×844/DPR3 viewer, a TCP relay with 60 ms RTT and 20 Mbit/s downstream, and a three-second drag. A remote color marker identifies presented paints. The benchmark rejects padded images and reports cadence, bytes, first response, final paint and full-resolution refinement separately.

A measured run presented 38 distinct motion frames in three seconds (12.77 fps), with a 98 ms p95 frame gap, 367 ms first motion paint, 539 ms final native-density paint after lift and 5.83 MB transferred. The final raster was 1074×2271 and scrolling moved exactly 720 CSS pixels. PNG delivered 6.38 fps and used 8.74 MB under the same setup; JPEG is retained. Frame gaps are not input-to-visible latency measurements.

These tests emulate mobile Chromium, not a physical iPhone. Browser composition and network conditions affect performance.

## Design references

- [Chromium compositor capture](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/page_handler.cc): screencast limits downsample the actual compositor surface; they cannot create Retina detail.
- [Cua native capture](https://github.com/trycua/cua/blob/main/libs/cua-spacesd/crates/cua-spacesd-desktop/src/linux_stream.rs): damage-driven capture separate from input.
- [Selkies](https://github.com/selkies-project/selkies): independent capture/encoding and bounded-latency streaming; WebRTC is not a prerequisite for interactive video.
- [OpenAI computer-use example](https://github.com/openai/openai-cua-sample-app/blob/main/python-app/app/browser.py): discrete screenshots serve agent observations, not a continuous interactive video loop.

See [runtime](runtime.md#shared-cloud-browser) and [client API](../src/client/API.md#shared-cloud-browser) for authentication and lifecycle details.
