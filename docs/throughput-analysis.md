# Upload throughput analysis — are we at the ceiling?

Evidence-based assessment (2026-06-03) of whether ps5upload extracts the maximum
write throughput the PS5 allows, using code analysis, hardware measurement (the
payload's per-phase `timing_us`), and scene research.

## Verdict

**We are at or near the realistic ceiling, and beating the only documented
competitor.** Multi-stream (v2.23.9, default 4) put us at/ahead of the best
scene tools. The remaining headroom is in specific scenarios, not the common case.

## The bottleneck is scenario-dependent (measured, not theorized)

A 2 GiB single-file upload, reading the payload's `timing_us` breakdown:

| Console | avg | recv (waiting for data) | write_wait (blocked on disk) | verdict |
|---------|-----|-------------------------|------------------------------|---------|
| Pro (9.60) | 85.1 MiB/s | **21.5 s (89%)** | 0.01 s (~0) | **recv-bound** — disk writes instantly; limit is how fast we feed the wire |
| Fat (5.10) | 31.3 MiB/s | 21.1 s | **41.2 s** | **write-bound** — disk write path tops out ~50 MiB/s |

Two different walls:
- **Fast-disk consoles (Pro): network/feed-bound.** The SSD keeps up trivially
  (`write_wait ≈ 0`); throughput is gated by how fast the host feeds bytes. Single
  stream ≈ 85 MiB/s ≈ the recv ceiling (~97). Gigabit (~110 MiB/s practical) is
  the hard wall; 4 streams already reach ~88 (~80% of wire).
- **Slow-disk consoles (Fat): disk-write-bound.** UFS write tops ~50 MiB/s. Single
  stream gets only ~31 because recv and write overlap poorly with the 2-slot
  buffer (recv 21 s + write_wait 41 s ≈ additive). 4 streams reach ~52 ≈ the
  disk's aggregate write ceiling.

## Scene research (corroboration)

- PS5 has a **1 Gbps NIC** → ~110–112 MiB/s practical TCP is the hard ceiling.
  No tool documents sustained >~115 MiB/s to internal `/data`.
- The only direct competitor (`PS5-Upload-Suite`) reports **30–36 MB/s per large
  file**, reaching 104 MB/s only via 4 parallel connections — same pattern and
  same per-stream rate as us. `ps5-ftp-server` is single-connection and slower.
- `ezremote-client` notes internal writes are "awfully slow" and recommends an
  **external USB3 SSD** target; reports **~4× with kstuff disabled**.
- Root causes of sub-SSD-speed writes: the homebrew POSIX `write()` → UFS path
  (not Sony's I/O complex), UFS metadata cost on small files, single-thread CPU,
  and **kstuff's per-syscall #GP-trap overhead**.

## Where the real headroom is (ranked)

1. **Engine: overlap disk-read + hash with the network send** (producer/consumer
   thread). Today the send loop is serial read→hash→send, so the wire idles during
   host reads. Confirmed relevant: the Pro is recv-bound (waiting on our feed).
   Biggest win for **single-file** uploads (which can't multi-stream) and **slow
   sources** (NAS/network/exFAT — the wire idles during every read). Engine-only,
   testable. Pro single-stream ~85 → toward ~110; slow-source could be large.
2. **Payload: deeper writer buffer ring (3–4+ slots)** instead of 2. Recovers the
   lost recv↔write overlap on slow-disk consoles: Fat single-file ~31 → toward the
   ~50 disk ceiling. Helps single-stream / single-file; multi-stream already near
   the disk wall. Payload threading change — higher risk, needs HW validation.
3. **Payload: share buffers + writer thread across multi-file shards** (the
   deferred `config.h` fix). Mostly **stability** (kills the 46k-file heap-churn
   crash) + lets us safely raise the 4 MiB buffer and run 4-stream concurrency
   (4×2×4 MiB churn today). Do for robustness, not raw speed.
4. **Engine: BLAKE3 `update_rayon` for large shards** — hash is ~1.2–1.6 s on the
   critical path. Minor; do alongside #1 (which moves hash off the send thread).
5. **Environment (not our code): run with kstuff disabled during transfer**, and/or
   target an external USB3 SSD. Scene-reported the largest lever for slow consoles.

## Diminishing returns note

With multi-stream default (4), the **common case** (a game folder on a decent
source) is already at the aggregate ceiling: Fat ≈ disk wall, Pro ≈ 80% of
gigabit. Optimizations #1–#4 mainly help **single-file uploads** and **slow
sources**, where multi-stream can't aggregate around the per-stream limit.
