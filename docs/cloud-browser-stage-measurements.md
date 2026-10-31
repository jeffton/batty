# Cloud-browser latency stages

The largest local block is Chromium scroll processing plus producing and delivering its screencast JPEG, not input transport. A settled single move took **200/233 ms p50/p95** from viewer pointer event to canvas draw completion locally, versus **421/450 ms** through the 60 ms RTT/20 Mbit/s relay. Continuous dragging showed 251/316 ms locally and 417/468 ms through the relay; its per-move associations are not causal latency measurements.

No production behavior changed. The benchmark creates isolated viewer/target Chromium instances and a temporary browser-service directory. It closes its named session explicitly: disposing the service alone preserves persistent browsers. Preliminary traces collected before that cleanup correction were discarded; the published runs were collected after terminating only the benchmark's orphaned processes. Active user browsers, authentication, workers and artifacts are untouched.

## Method

Run the historical harness and summarizer from revision `470668d`:

```sh
git worktree add --detach /tmp/batty-jpeg-stages 470668d
ln -s "$PWD/node_modules" /tmp/batty-jpeg-stages/node_modules
cd /tmp/batty-jpeg-stages
BENCH_WORKLOAD=settled BENCH_RTT_MS=0 BENCH_DOWN_MBIT=1000 BENCH_LABEL=settled-local \
  pnpm exec tsx scripts/benchmark-cloud-stages.ts
BENCH_WORKLOAD=settled BENCH_RTT_MS=60 BENCH_DOWN_MBIT=20 BENCH_LABEL=settled-mobile \
  pnpm exec tsx scripts/benchmark-cloud-stages.ts
python3 scripts/summarize-cloud-stages.py /tmp/cloud-stages-settled-local.json
python3 scripts/summarize-cloud-stages.py /tmp/cloud-stages-settled-mobile.json
```

`BENCH_WORKLOAD=continuous` runs an eight-second drag. Repeat each profile three times and pass its three JSON paths to the summarizer. Mixing profiles/workloads is rejected. The viewer is emulated 390×844 mobile Chromium/DPR3. Capture stays at DPR3/JPEG85; input uses production native touch. The local profile uses the same relay with zero added delay and 1 Gbit/s downstream. The isolated viewer disables Chromium's local-network-access check for loopback WebSockets.

Forty settled trials per profile each use one 80 CSS-pixel move, hold for 400 ms, then release and wait 1.2 seconds. Each trial has a unique X coordinate and trial number. One move and a settled preceding trial remove continuous-touch attribution ambiguity. All 40 trials in both accepted traces produced a correlated response and exactly one scroll record. A preliminary mobile run with a WebSocket disconnect and a missing trial was rejected and rerun.

The target's `scroll` handler records its monotonic time and changes a fixed color marker. Every CDP screencast JPEG is timestamped on **Node receipt**; its marker is decoded **offline after timing**. JPEG hashes link captures to production WebSocket packets/frame IDs and client receipt/decode/draw timestamps. Thus unrelated frames cannot count as input responses. Explicit server command IDs, trial IDs and coordinate checks link client input/send to server receipt, service guard, CDP dispatch and ACK. Missing trials/IDs, ambiguous selected settled hashes, unmatched dispatches/captures and probe replacement failures abort analysis.

Browser monotonic clocks map to Node's monotonic clock using the midpoint of the lowest-RTT sample among 25 Playwright evaluations before and after measurement. Initial half-RTT bounds were below 0.6 ms and start/end offsets differed by less than 0.2 ms. Drift is checked. These bounds control offset, not every scheduling asymmetry; sub-millisecond stages should not be overinterpreted. Hashing and trace collection add observer overhead. These are instrumented emulation measurements, not physical-iPhone results.

## Settled single-move results

Milliseconds, p50 / p95; 40 separated responses per profile. [Result data, sample counts and clocks](benchmarks/cloud-browser-stages.json).

| Observable interval                                    |             Local | 60 ms RTT / 20 Mbit/s |
| ------------------------------------------------------ | ----------------: | --------------------: |
| Pointer event → client send                            |         0.1 / 0.2 |             0.1 / 0.2 |
| Client send → server WebSocket receive                 |         1.6 / 2.5 |           30.9 / 31.5 |
| Server receive → CDP dispatch, queues/guards included  |         1.2 / 1.5 |             1.3 / 1.9 |
| CDP dispatch → target `scroll` handler                 |       13.8 / 50.0 |           51.4 / 67.3 |
| Target `scroll` handler → Node screencast JPEG receipt |     111.2 / 140.4 |          95.4 / 117.2 |
| Screencast receipt → WebSocket `send` call             |         1.4 / 8.1 |             1.5 / 5.9 |
| WebSocket send → client frame receipt                  |       26.2 / 43.7 |         206.9 / 235.5 |
| Client frame receipt → decode start                    |        1.2 / 23.9 |             1.3 / 1.6 |
| `createImageBitmap` decode                             |       24.4 / 28.1 |           27.3 / 32.7 |
| Decode completion → canvas `drawImage` completion      |        0.4 / 15.7 |            0.5 / 12.5 |
| **Pointer event → canvas draw completion**             | **200.0 / 233.3** |     **421.3 / 450.2** |

For those move commands, CDP dispatch → ACK was **3.1/3.6 ms** locally and **3.3/6.2 ms** through the relay. ACK is not a paint fence and overlaps the table's timeline; do not add it. Across all 120 commands/profile, service-guard admission measured 1.0/1.9 ms locally and 1.0/7.8 ms mobile; route waiting measured 0.23/0.42 and 0.24/0.40 ms. The service-guard timestamp is `cloudInputPage` execution after serialized-operation entry, not exact lock acquisition. Full command-phase results are in the JSON.

Quantiles do not add. End-to-end quantiles are calculated per correlated response.

## Continuous workload and the roughly 271 ms local baseline

Three drags/profile sent 726 commands. Local execution retained 524 and coalesced 202; mobile retained 534 and coalesced 192. Local capture received 1,002 screencast events and transmitted/drew 738 frames; mobile received 1,074 screencast events and transmitted/drew 250 frames. Statistics retain 445 local and 212 mobile distinct marker associations. They are **frame-selected associations**, not distributions across every input or independent samples.

| Continuous interval, p50 / p95 ms              |         Local |         Relay |
| ---------------------------------------------- | ------------: | ------------: |
| Server receive → CDP dispatch                  |   14.7 / 42.3 |   15.4 / 42.4 |
| CDP dispatch → target scroll-event association |  82.4 / 116.1 |  77.2 / 116.9 |
| Scroll event → screencast JPEG receipt         |  94.4 / 134.4 |  95.9 / 126.4 |
| Screencast receipt → WebSocket send            |    8.0 / 26.2 |   11.8 / 33.6 |
| WebSocket send → client frame receipt          |   10.9 / 31.0 | 155.2 / 167.2 |
| Decode                                         |   16.9 / 27.5 |   15.9 / 24.5 |
| Decode completion → canvas draw completion     |    9.8 / 16.2 |    8.6 / 16.2 |
| Pointer → associated canvas draw               | 250.9 / 316.2 | 417.0 / 467.9 |

Continuous move ACKs cost **39.9/70.1 ms locally** and **41.2/65.2 ms mobile**. The route awaits ACKs, so later moves wait and coalesce. The missing time outside the earlier touch-operation measurement is not hidden network RTT: Chromium scroll processing, approximately **100 ms from scroll handler to JPEG receipt**, and client decode/draw remain substantial. Separated trials confirm the JPEG-delivery block remains large with negligible input queues and a 3 ms move ACK.

Compositor scrolling and main-thread `touchmove` delivery are asynchronous. Continuous markers record the latest delivered move when the scroll handler runs; they do not prove that exact move caused those pixels. The settled table provides stronger causal evidence.

## Relay and bytes

The relay intercepts actual HTTP/WebSocket TCP traffic. Each chunk is released after half-RTT plus serialization at its configured rate. It caps each connection independently and measures scheduled `to.write` releases, not acknowledged packet delivery. It does not model radio scheduling/loss or honor downstream backpressure as a real TCP shaper would.

During the three mobile drags, downstream releases were **18.85, 18.82 and 18.79 MB over about 7.93 seconds**: **19.00, 18.98 and 18.96 Mbit/s**. The 20 Mbit/s throttle therefore applies to WebSocket traffic. Whole-trace mobile frame-payload counts were 22.21, 22.46 and 22.23 MB, within 2.7 kB of relay totals; HTTP/WS framing accounts for the difference. Local totals matched within 4.3 kB. Snapshots need not be exact wire-delivery boundaries.

Frames are roughly **268–275 kB** at full DPR3. A 275 kB frame takes about 110 ms to serialize at 20 Mbit/s, before 30 ms downstream propagation, preceding queued bytes and browser work. The earlier “9 MB during three seconds” count covered the **whole measurement window**, including settling after the drag, not three seconds of throughput.

Server WebSocket `bufferedAmount` was zero at p50/p95 for selected frames. This does not exclude the relay's separate byte queue. Production flow control still retains two unacknowledged frames and one replaceable latest paint.

## Observation boundaries

- The target `scroll` handler is a main-thread observation, not the first compositor movement. Its marker proves a painted state change and avoids counting unrelated JPEGs.
- **Render/commit, capture scheduling, JPEG encoding and CDP delivery form one unresolved internal block** between scroll handler and Node screencast receipt. CDP exposes no separate encode start/end here. Base64 conversion/packet packing and stream-credit waits fall within receipt → WebSocket send.
- Canvas timing ends at synchronous `drawImage` completion inside an animation-frame callback. GPU completion, scan-out and physical-iPhone Safari presentation are not observed. This is not input-to-photon latency.
- The tests exclude initial page/socket setup and use fixed capture. Gesture-start capture-mode restarts in normal adaptive quality are outside this experiment.

**Conclusion:** local remote-render/capture latency is substantial before network limits are added. The synthetic mobile link adds a large, directly measured frame-transport cost. Input serialization and final canvas drawing are not the primary local bottlenecks. No performance fixes were made.
