# Isolated H.264 prototype

**GO for the video direction, not for deploying this prototype as the default browser.** Native software H.264 doubled useful scroll updates and used roughly one seventh of JPEG's movement bandwidth. Median input response improved by 44 ms on the synthetic mobile link; local response did not improve and mobile p95 was essentially unchanged.

The prototype is `scripts/prototype-h264.ts` with a small standalone viewer. It is not imported by the application. No production routes, browser launch defaults, profiles or services change.

## What runs

- A private `Xvfb -displayfd` display at 1074×2271, TCP listening disabled.
- A separate temporary headed Chromium profile, fullscreen, mobile CSS viewport 358×757/DPR3. No desktop toolbar is captured.
- **H.264:** existing FFmpeg 6.1.1 `x11grab` → bilinear scale to 716×1514 → software libx264, ultrafast, zerolatency, CRF18, baseline 4:2:0, explicit BT.709, no B frames, two encoder threads, 30 fps. Annex-B access units travel over WebSocket; the browser uses WebCodecs `VideoDecoder` and canvas. AUD boundaries preserve frame dependencies; no arbitrary delta-frame replacement is attempted.
- **JPEG control:** the real `CloudBrowserStreams` and socket writer through a fixture adapter. This preserves production DPR2/JPEG80 during motion, DPR3/JPEG85 at rest, capture-mode restarts, stream polling and frame credits. The client uses bitmap decoding and animation-frame canvas drawing.
- Both paths receive identical native touch start/move/end through WebSocket and CDP, preserving gesture timestamps. Pending moves coalesce as in the production route; gesture boundaries stay ordered.
- A FIFO, application-level TCP relay supplies zero added RTT/1 Gbit/s or 60 ms RTT/20 Mbit/s. FIFO release matters: preliminary per-chunk timers could reorder bytes and corrupt WebSocket messages. Those failed trials were discarded.

All HTTP/WebSocket listeners bind loopback. The prototype accepts only its own viewer Origin and serves a fixed fixture, not an arbitrary browsing proxy. **It is not a production authentication design.** It never attaches to an existing browser or host display. Child cleanup is idempotent, including signal-terminated FFmpeg; profiles are removed, result images and recordings retained in the printed temporary directory.

No packages were added. Existing FFmpeg/Xvfb avoid a native-package installation for this first experiment. PixelFlux 2.1.0 was researched as an alternative, but this experiment does not claim to benchmark pixelflux.

## Results

[Machine-readable results](benchmarks/h264-prototype.json). Forty separate single-move trials per codec on the mobile profile; twenty per codec locally. One accepted run per codec/profile, not a repeatability study. Latency ends at **canvas draw completion**, not physical screen presentation.

| Pointer event → corresponding marker drawn | Adaptive JPEG p50/p95 |        H.264 p50/p95 |
| ------------------------------------------ | --------------------: | -------------------: |
| 60 ms RTT / 20 Mbit/s, 40 trials           |      233.7 / 248.8 ms | **189.5 / 247.6 ms** |
| Local relay, 20 trials                     |  **116.5 / 139.9 ms** |     129.7 / 165.4 ms |

The target increments a color marker in its real scroll handler. Each settled trial contains exactly one move and one scroll record. The summarizer requires matching pixels in the viewer and measures pointer and canvas timestamps on the **same viewer monotonic clock**. It rejects missing/ambiguous trials; an unrelated frame cannot count as a response. Continuous-drag latency is deliberately not inferred from latest-touch associations.

Eight-second continuous drag, mobile profile:

| Metric                                | Adaptive JPEG |           H.264 |
| ------------------------------------- | ------------: | --------------: |
| Canvas frames/s                       |         14.54 |           30.11 |
| Frames/s with a changed scroll marker |         14.15 |       **28.69** |
| Relay downstream bytes                |    14,298,779 |       1,913,778 |
| Average downstream rate               |  14.39 Mbit/s | **1.93 Mbit/s** |
| Full harness CPU, one core = 100%     |          211% |        **160%** |

Exact byte counts and durations are in the JSON. Both received 242 input commands; JPEG dispatched 175 and H.264 234, with intervening pending moves coalesced. The frame-rate claim distinguishes repeated video frames from genuinely changed marker frames.

Sparse single-move runs used **134% H.264 versus 73% JPEG** harness CPU. A fixed 30 fps encoder wastes work between gestures. CPU is sampled from the complete Linux process tree, including Node, Xvfb, target Chromium, viewer Chromium and FFmpeg—not isolated server or encoder CPU. Hardware encoding was not used. The VPS has four CPU cores.

The local control uses the same headed target, not the production headless process. JPEG imports production capture/writer behavior, but the fixture adapter omits BrowserService auth/lifecycle guards. Input handling is mirrored, not a replacement production route. The prototype results should not be compared directly to the earlier fixed-DPR3 421 ms reference.

## Image quality and codec support

Both movement streams deliver 716×1514 pixels. CRF18 and JPEG quality80 are not equivalent numeric quality settings; H.264 is not being made smaller by lowering resolution below the JPEG control.

After measurement, input is drained, scroll position must remain stable for five checks, and the viewer must display the final marker. JPEG is held at its DPR2/JPEG80 motion setting for this sample. Decoded canvas pixels are compared to a fresh native-display PNG resized to the same dimensions. Accepted settled samples measured approximately **37.9 dB PSNR for H.264 versus 29.0 dB for JPEG**. The corrected continuous-run samples were also 38.0 versus 29.0 dB. Preliminary unmatched-frame quality scores were discarded.

This measures the complete raster path, including resampling and color conversion. It is a static greyscale-text fixture, not a perceptual quality study of colored UI, photographs or text during motion. Explicit BT.709 signaling prevents the color-matrix mismatch found during bring-up. Saved `decoded.png`, `target.png` and `viewer.png` make visual inspection reproducible.

The emitted codec is **`avc1.42c020`**. Chromium decoded the complete live stream. The installed Playwright WebKit engine (Safari/26.6 user-agent) both reported support and **actually decoded a prototype keyframe** to 716×1514 with the expected dark marker. That is stronger than codec feature detection, but is **not physical iPhone/Safari validation** and not full-stream WebKit latency testing.

A private demo contains a recording and a local WebCodecs capability check. Recorded MP4 playback and WebCodecs decoding are different APIs; playing the recording alone does not establish live-stream support.

## Reproduce

Requires the repository's installed Node dependencies plus existing Linux `Xvfb` and FFmpeg with libx264. The script fails rather than choosing another codec/capture path.

```sh
PROTO_LABEL=h264-mobile pnpm exec tsx scripts/prototype-h264.ts
PROTO_CODEC=jpeg PROTO_LABEL=jpeg-mobile pnpm exec tsx scripts/prototype-h264.ts

PROTO_TRIALS=20 BENCH_RTT_MS=0 BENCH_DOWN_MBIT=1000 PROTO_LABEL=h264-local \
  pnpm exec tsx scripts/prototype-h264.ts
PROTO_CODEC=jpeg PROTO_TRIALS=20 BENCH_RTT_MS=0 BENCH_DOWN_MBIT=1000 PROTO_LABEL=jpeg-local \
  pnpm exec tsx scripts/prototype-h264.ts

PROTO_WORKLOAD=continuous PROTO_LABEL=h264-drag pnpm exec tsx scripts/prototype-h264.ts
PROTO_CODEC=jpeg PROTO_WORKLOAD=continuous PROTO_LABEL=jpeg-drag \
  pnpm exec tsx scripts/prototype-h264.ts

python3 scripts/summarize-h264-prototype.py \
  /tmp/h264-prototype-{h264-mobile,jpeg-mobile,h264-local,jpeg-local,h264-drag,jpeg-drag}.json
```

Each invocation prints the JSON path and its private image/recording directory. The run terminates its own viewers, browser, encoder and display. It installs no service and opens no public port. A one-frame Annex-B boundary wait, 30 fps sampling and software scaling/encoding remain in this implementation; the experiment does not prove that native capture itself is faster than CDP.

## Deployment boundary

This is a successful transport/playback experiment, **not a deployable browser backend**. Production integration would need bounded decoder-aware congestion handling, keyframe recovery, lifecycle/auth binding, dynamic geometry/page revisions, per-session display isolation and real iPhone tests. None is silently implemented as a compatibility path here. WebRTC is not needed for these measured bandwidth/frame-rate benefits.

Sources: [FFmpeg x11grab](https://ffmpeg.org/ffmpeg-devices.html#x11grab), [x264/FFmpeg encoder options](https://ffmpeg.org/ffmpeg-codecs.html#libx264_002c-libx264rgb), [WebCodecs low-latency decoding](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/configure), [WebKit H.264/VP8](https://webkit.org/blog/8672/on-the-road-to-webrtc-1-0-including-vp8/), [PixelFlux releases](https://github.com/selkies-project/pixelflux/releases), [Selkies capture/codec settings](https://docs.selkies.io/latest/settings).
