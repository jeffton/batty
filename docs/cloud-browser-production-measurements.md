# Production-path H.264 measurements

**The accepted clean mobile pair delivers about twice the useful scroll updates with 79.5% less traffic. First-response latency is worse: 348 versus 300 ms median.** Adaptive DPR3-idle/DPR2-motion capture and four video credits are retained; no reduced-resolution compromise or JPEG fallback is introduced.

[Machine-readable measurements and every latency sample](benchmarks/production-browser-h264.json).

## Authoritative clean mobile comparison

Measured sequentially on 18 October 2026 during an explicitly coordinated quiet window after the momentum worker completed its heavy tests. No full tests/builds ran during the pair. Historical JPEG completed at **08:51:14 UTC**, current H.264 at **08:52:08 UTC**. These are one run per implementation, not a repeatability study or physical iPhone measurement.

| Metric                                           | Previous production JPEG | Current production H.264 candidate |
| ------------------------------------------------ | -----------------------: | ---------------------------------: |
| Source pointermove → matching canvas pixels, p50 |             **300.0 ms** |                           347.7 ms |
| Same endpoint, p95                               |             **333.2 ms** |                           397.7 ms |
| Canvas frames/s during six-second drag           |                     13.4 |                           **30.1** |
| Frames/s with a changed scroll marker            |                     13.2 |                           **27.0** |
| Downstream traffic                               |             13.71 Mbit/s |                    **2.81 Mbit/s** |
| Downstream bytes during drag                     |               10,352,167 |                      **2,133,821** |

Both cases pass all **20 one-move/one-scroll matching-pixel assertions** with no viewer page errors. H.264's wire trace contains **zero skipped frame IDs within an unchanged stream**. JPEG intentionally replaces independent images under backpressure, so skipped JPEG frame IDs are not a video-dependency failure. The comparison supports a cadence/bandwidth benefit, not a first-response improvement.

The candidate includes the input fix that preserves `PointerEvent.timeStamp` rather than handler execution time. The historical worktree retains its previous production input code. This is a previous-production versus candidate comparison, **not an isolated codec-only A/B**.

## Same harness and endpoints

The identical `scripts/benchmark-production-browser.ts` runs in the current checkout and a detached historical JPEG worktree at `470668d`. It opens the real `BrowserPopover` fixture with production BrowserService/routes, WebSocket writer, capture and client renderer. It does not use the standalone H.264 prototype or a capture adapter.

- Viewer: mobile-emulated Chromium, 390×844/DPR3; target: 358×757 CSS/DPR3.
- FIFO TCP relay: **60 ms RTT, 20 Mbit/s downstream**. FIFO draining avoids the earlier independent-timer TCP chunk reordering defect.
- Twenty isolated gestures: touch start, one 80-pixel move at source time +80 ms, then hold until corresponding marker pixels appear and release after a pause. Each trial must have exactly one viewer move and one target scroll event.
- A 1.3-second interval exercises real idle→motion capture transitions. Latency starts at the viewer's **source event timestamp** and ends at the matching canvas marker, on the same viewer monotonic clock.
- Continuous drag: 180 moves at 30 Hz over six seconds. Explicit CDP epoch timestamps preserve the intended source timeline under scheduling delays in both implementations. The benchmark does not rewrite historical production input to apply the candidate's timestamp fix.
- Target scroll handlers encode their sequence in a color marker. Changed-marker frames are distinct from repeated canvas frames. Byte counts include downstream TCP/application framing during the drag, excluding startup and final refinement.

Stationary H.264 output is 1074×2272 (even codec dimensions), versus JPEG's 1074×2271; motion output is 716×1514 for both. Each run owns its temporary profile/display and loopback listeners. User browser sessions are not touched.

The endpoint is canvas drawing, not physical display scanout. Mobile Chromium emulation does not establish physical iPhone/Safari latency. Source-event→handler delay is included. Pooled across all 200 sparse and continuous moves, its medians were about 29 ms for JPEG and 31 ms for H.264; sparse-trial-only medians were 15.5 and 18.6 ms. Earlier exploratory measurements started at handler execution and must not be compared directly to these source-event latencies.

## Indicative final-pair stages

| Interval, p50 / p95                                    |             JPEG |            H.264 |
| ------------------------------------------------------ | ---------------: | ---------------: |
| Source input → matching CDP network-frame notification | 297.5 / 320.1 ms | 328.3 / 375.2 ms |
| Network notification → matching canvas pixels          |    9.7 / 15.4 ms |   25.4 / 48.2 ms |
| Server touch operation, all phases                     |   42.2 / 63.6 ms |   21.2 / 36.5 ms |

Input→canvas latency uses one clock. The split at the network notification instead uses midpoint clock correlation, with **±10.5 ms JPEG / ±4.1 ms H.264 calibration uncertainty**. CDP notification time is not exact WebSocket callback time. Separate quantiles cannot be summed; touch-operation time overlaps the first interval. These stages do not isolate FFmpeg probing, encoding or Chromium's internal capture duration.

## Historical appendix: exploratory controls

Raw samples remain in the JSON for traceability; this appendix is not the authoritative production comparison.

- **Initial two-credit/local samples are invalid for performance comparison.** Confirmed tests ran **08:20:31–08:20:59.750 UTC** and **08:21:16–08:21:41.720 UTC**; a build started after **08:21:42 UTC**, with unknown end. H.264 local and JPEG mobile overlap tests; JPEG local may overlap the build. H.264 mobile has no confirmed overlap but its JPEG control is contended. File completion times were 08:20:08, 08:21:00, 08:21:52 and 08:22:41 UTC respectively.
- Four-credit exploratory runs reached about 30 canvas frames/s. Their comparison against the initial contended JPEG row is superseded by the clean pair above.
- Constant-DPR2 diagnostic: 263/325 ms handler→canvas p50/p95, 27.6 changed frames/s, 3.33 Mbit/s. Constant-DPR3: 336/399 ms, 21.3 changed frames/s, 11.57 Mbit/s. Avoiding restarts at DPR2 helped response but sacrificed idle Retina detail; neither diagnostic changes production density policy.
- FFmpeg `-probesize 32 -analyzeduration 0` trial: 356/392 ms versus a fresh control's 326/378 ms, both approximately 30 canvas frames/s and 2.94 Mbit/s. All matching-content assertions passed with no skipped H.264 frame IDs. The flags showed no benefit and were removed. No `-avioflags direct` or `-fflags nobuffer` was retained. See [FFmpeg format options](https://ffmpeg.org/ffmpeg-formats.html#Format-Options).
- The standalone prototype's 190 ms median/29 changed frames/s used a different writer/input adapter. It is not production validation.

## Gates and reproduction

The clean pair passes content-association assertions and demonstrates the cadence/bandwidth benefit with a disclosed first-response tradeoff. Complete application test/build/startup/offline and independent-review gates remain separate from these benchmarks. Physical iPhone/Safari performance is unmeasured.

Commands and historical worktree isolation are in [cloud browser rendering](cloud-browser-performance.md#production-path-benchmark). Temporary final traces/screenshots are `/tmp/production-browser-{jpeg,h264}-mobile-final-clean.{json,png}` on the measurement host. No production codec toggle, fallback, commit or deployment is performed by the benchmark.
