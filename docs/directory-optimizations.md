# Directory repair optimizations on master and the client experiment

The subsequent [shared-library consolidation](shared-engine.md) uses one engine for both modes and records a separate before/after performance comparison.

The optimized client experiment now matches master's warm directory-repair latency in the tested scenarios.
It uses one foreground fact request, including freshness checks.
Cold client repairs still require several requests; unrelated Python and referenced-file workloads retain their previous network-latency penalties.

## Changes, tested and committed issue by issue

| Issue | master | experiment/client-driven-terminal |
| --- | --- | --- |
| Whole-path exact lookup; filter regular files before ranking; prepare matching names | `3fc9e55` | `54d4bea` |
| Bounded directory snapshots, live invalidation, larger enumeration buffer | `cecba45` | `ad94b98` |
| Fused lookup/listing, concurrent branches and validation | `248317d` | `9c66c44` |
| Skip unrelated path catalog collection for directory grammar | `9404c2d` | `ea69cf8` |
| Reuse browser snapshots; batch freshness checks; retry changed directories | — | `4ede026` |
| Push context, field-level catalog deltas, bounded cwd/home prefetch | — | `76ea3f2` |

The filesystem implementation, fact types, matching changes, relevant regressions and benchmark harness were copied between the two checkouts.
The moved directory walkers retain the same algorithm with their native/browser adapters.
Master continues to compute suggestions on the host; it does not need the browser transport changes.

The first cache implementation failed a rapid directory-to-file replacement test.
The committed version combines metadata checks with bounded filesystem watchers; replacements, additions and deletions invalidate listings.
Watchers are nonpersistent, close on eviction, and have a metadata fallback.
The cache holds at most 64 listings / 40,000 entries.
Metadata includes device, inode, nanosecond timestamps, size, link count and mode.
Listings indicate whether enumeration was complete; a truncated listing cannot prove an exact path absent.

Exact paths without dot/dot-dot components bypass the component walk.
The first component is probed concurrently so the shortcut adds no sequential round trip on a miss.
Quoting, exact-file precedence, inaccessible listings and symlink handling remain covered by regressions.
Regular files no longer consume the eight fuzzy candidate slots.
Branches and independent syntax/path checks run concurrently with the existing search and subprocess bounds.

The browser holds at most 32 directory snapshots / 30,000 entries.
Matching may use these speculatively, but every used version is verified before the result is applied.
Version checks travel alongside required filesystem operations; all-local/literal outcomes still verify their snapshots.
A changed directory refreshes the cache and retries, at most twice within the original foreground deadline.
A new exact prefix can therefore defeat an old fuzzy match even if the old final destination still exists.

While an attached shell is idle at a prompt, the experiment pushes lightweight context every two seconds.
Only changed catalog fields are resent.
Small complete cwd/home listings (at most 1,000 entries each) are prefetched; larger directories stay on demand.
The worker starts on the first push.
A cached context can bypass foreground fetching only at the same prompt and while recent; disconnects reset it.
The host still enforces shell identity and prompt/revision checks.

## Four-way benchmark

`npm run bench:architecture` is identical on both branches.
It extracts four recorded revisions into a temporary directory and runs the real engines and host operations with JSON serialization and simulated RTT.
The raw result, including exact revisions, request counts, byte counts and background-push cost, is in [directory-optimization-results.json](../archive/migration/README.md).

This run used Node 26.8.1 on Linux x64, 3,007 command names, 5,000 history entries and a large directory with 2,000 ordinary files plus one target directory.
Each of nine cases ran cold once and warm three times at 0, 50 and 150 ms RTT.
All **432 candidate-array comparisons passed**.
The regular-file crowding fix intentionally improves behavior beyond the baseline and is tested separately.

Warm medians at **150 ms RTT**, in milliseconds:

| Case | Original master | Optimized master | Original experiment | Optimized experiment |
| --- | ---: | ---: | ---: | ---: |
| Fuzzy directory | 152.58 | 151.12 | 905.91 | **150.93** |
| Exact directory | 151.55 | 151.39 | 452.74 | **151.11** |
| Large-directory repair | 160.53 | 151.54 | 762.26 | **151.18** |
| Python arguments | 154.10 | 154.51 | 456.20 | 456.07 |
| Referenced filename | 159.02 | 158.41 | 761.65 | 760.93 |

Warm medians with **no injected network delay**, in milliseconds:

| Case | Original master | Optimized master | Original experiment | Optimized experiment |
| --- | ---: | ---: | ---: | ---: |
| Fuzzy directory | 0.68 | 0.49 | 1.60 | 0.47 |
| Exact directory | 0.61 | 0.38 | 0.64 | 0.39 |
| Large-directory repair | 9.21 | **0.47** | 9.59 | **0.58** |

For fuzzy directory repair at 150 ms RTT, the client's warm foreground request count falls from **six to one**.
Cold latency falls from **1,061.56 to 609.63 ms**, with seven requests reduced to four.
Exact cold repair falls from 608.84 to 459.31 ms.
Large-directory cold repair falls from 918.74 to 611.66 ms.

For the large directory, warm client traffic falls from about **124 KB to 704 bytes per repair**, excluding headers and background pushes.
The normal fuzzy-path case falls from 1,609 to 701 bytes.
These are uncompressed JSON measurements.

### Measurement limits and costs

Cold trials begin before a context push has arrived.
Warm optimized-client trials model a recently delivered idle push, with its byte count and host time recorded separately rather than charged to the keystroke.
Across three warm directory trials, the fixture's pushes total about 174 KB, mostly the initial catalog; subsequent unchanged updates are small.
This shifts preparation earlier and adds periodic idle work.
Catalog deltas are per field, so changing history still transmits the history array, not just appended entries.

Client CPU runs in Node for the benchmark, not a phone.
Timings exclude HTTP/TLS framing, bandwidth throttling, terminal replacement acknowledgements, worker startup and rendering.
Native engines receive a prepared catalog, so the benchmark does not quantify the additional benefit of avoiding irrelevant catalog scans.
OS and native probe caches can be warm across cases; “cold” describes engine/client state, not a rebooted machine.
Samples are small, and sub-millisecond differences should not be treated as precise production predictions.

No general performance parity is claimed: deep cold paths can still hit search deadlines; Python and referenced-file repairs still need several dependent requests.
Real-device CPU, memory, battery, sustained terminal output and SSH integration remain to be measured.
The thin-server experiment still has no SSH adapter.

## Validation

- Master: 65 unit tests, production build and browser/transport suite pass.
- Experiment: 70 unit tests, production build, browser/transport suites at `/` and `/t` pass.
- Chromium directly asserts that a repeated directory repair uses exactly one foreground fact batch and includes directory-version validation.
- Existing checks retain stale-edit rejection, cancellation, IME behavior, shortcuts, non-executing discovery, offline/reconnect behavior and acknowledged terminal output.

Reproduce with `npm run bench:architecture`; set `BENCH_RTT`, `BENCH_REPEATS`, `BENCH_MASTER`, `BENCH_CLIENT` or `BENCH_OUTPUT` to change the run.
The default comparison uses original commits `ba21e2c` and `17e629b` plus the current tips of `master` and `experiment/client-driven-terminal`.
The branch names must exist locally.
Temporary checkouts and fixture files are removed after the run.
