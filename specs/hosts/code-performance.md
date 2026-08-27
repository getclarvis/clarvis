# `@clarvis/code` performance: startup latency, resident memory and measurement discipline

> Implemented across `packages/code/`, the in-process `packages/kernel/` host and the bounded
> execution packages it composes. Runtime measurements live beside the contract in
> [`../known-issues.md`](../known-issues.md); proposals that are not implemented are kept in the
> final section rather than stated as guarantees.

## 1. Purpose

This document owns the performance contract of the interactive `@clarvis/code` terminal
application: what counts as startup, which memory is sampled, which resident collections are
bounded, how the distributable artifact preserves lazy work, and how a performance claim must be
measured before it can guide a product decision.

It does not redefine the boot sequence, transcript semantics, session reconstruction or build
artifact. Those contracts remain in [code-bootstrap.md](code-bootstrap.md),
[code-run-host.md](code-run-host.md), [code-transcript.md](code-transcript.md),
[sessions.md](sessions.md) and [build-and-ci.md](../cross-cutting/build-and-ci.md). This document reads
those paths together because their costs accumulate in one process and are experienced by one user.

Three distinctions are load-bearing:

1. **Module load is not first paint, and first paint is not usable conversation.** The benchmark
   times `--version`, the parser-free boot frame, the branded header and the input marker
   independently (`packages/code/tooling/benchmarks/first-paint.ts`, `timeFirstPaint`, `measure`).
2. **RSS is not JavaScript heap.** The sampler records `rss`, `heapUsed`, `external` and
   `arrayBuffers`, while only RSS drives the fuse
   (`packages/code/src/adapters/memory-pressure.ts:110-118`, `:169-188`). Native renderer
   allocations and memory-mapped runtime pages therefore remain visible even when the JS heap is
   small.
3. **A bound on one collection is not a process budget.** Transcript prose, hydrated tool bodies,
   session reconstruction, provider responses, MCP responses, traces and renderer objects have
   independent ceilings. Their temporary copies and native overhead can coexist.

The dated review in section 8 was requested after interactive sessions were observed near 700 MB
RSS. It establishes real reproduction paths and a prioritized reduction plan, but does not claim
that one isolated mechanism explains every such peak.

## 2. Surface

### 2.1 Measurement commands and controls

| Surface | Contract | Source |
| --- | --- | --- |
| `bun run bench:code` | runs the package first-paint benchmark | `package.json:68`, `packages/code/package.json:31` |
| `bun run bench:code-overlays` | runs isolated post-GC renderer lifecycle cases; optional case names select a subset | `package.json` (`bench:code-overlays`), `packages/code/package.json` (`bench:overlays`) |
| `OVERLAY_SOAK_CYCLES`, `OVERLAY_SOAK_BATCH`, `OVERLAY_SOAK_WARMUP` | control measured cycles, sample cadence and discarded warm-up; defaults 100, 20 and 10 | `packages/code/tooling/benchmarks/overlays.tsx` (`cycles`, `batchSize`, `warmupCycles`) |
| `OVERLAY_SOAK_SIZES` | comma-separated matrix; defaults to reference 120x32 plus compact 80x24 | `packages/code/tooling/benchmarks/overlays.tsx` (`matrixSizes`) |
| `OVERLAY_SOAK_WIDTH`, `OVERLAY_SOAK_HEIGHT` | child-process dimensions supplied by the matrix runner | `packages/code/tooling/benchmarks/overlays.tsx` (`width`, `height`) |
| `OVERLAY_SOAK_MAX_MIB_PER_100` | production-policy PSS growth ceiling, or RSS off Linux; default 5 MiB/100 | `packages/code/tooling/benchmarks/overlays.tsx` (`PRODUCTION_CASES`, `maxMiBPer100`) |
| `OVERLAY_SOAK_WATCHDOG_MS`, `OVERLAY_SOAK_WATCHDOG_RSS_MB` | parent-process time and RSS limits; defaults 120 seconds and 1 GiB per case | `packages/code/tooling/benchmarks/overlays.tsx` (`watchdogMs`, `watchdogRssBytes`) |
| `OTUI_NO_NATIVE_RENDER=true` | runs the same soak with OpenTUI native frame composition disabled; the result is a control, not a heap/native-ownership classifier by itself | `packages/code/tooling/benchmarks/overlays.tsx` (`CaseResult.runtime.nativeRender`), `@opentui/core` (`OTUI_NO_NATIVE_RENDER`) |
| `BENCH_N` | measured repetitions after one discarded warm-up; default 7 | `packages/code/tooling/benchmarks/first-paint.ts:41`, `:265-278` |
| `BENCH_POLL_MS` | PTY polling interval; default 25 ms | `packages/code/tooling/benchmarks/first-paint.ts:42`, `:219-220` |
| `BENCH_TIMEOUT_MS` | deadline for one boot; default 90 seconds | `packages/code/tooling/benchmarks/first-paint.ts:43`, `:219` |
| `BENCH_MAX_LOAD` | maximum one-minute load per core; default `0.35` | `packages/code/tooling/benchmarks/first-paint.ts:44-45` |
| `--arm=source|bundle|bin` | selects source, direct artifact or launcher arm | `packages/code/tooling/benchmarks/first-paint.ts:237-254` |
| `--json` | emits the environment and raw summary as JSON | `packages/code/tooling/benchmarks/first-paint.ts:325-365` |
| `--force` | permits an otherwise refused run and marks it untrusted | `packages/code/tooling/benchmarks/first-paint.ts:325-338` |
| `--require-ac` | optionally requires mains power | `packages/code/tooling/benchmarks/first-paint.ts:331-338` |
| `--debug[=level]` | writes bounded redacted lifecycle and memory diagnostics | `packages/code/src/cli-args.ts:108-110`, `packages/code/src/adapters/diagnostic-session.ts:354-374` |

The benchmark owns three visible markers: `Clarvis · starting` for the exclusive parser-free shell,
`◆ Clarvis` for complete header paint and `New task…` for the input dock
(`packages/code/tooling/benchmarks/first-paint.ts`, `SHELL_MARKER`, `PAINT_MARKER`, `READY_MARKER`).
The first marker is absent from the complete application frame, so a missing shell paint cannot be
misreported as a header paint.

### 2.2 Runtime memory controls

| Surface | Current value or behavior | Source |
| --- | --- | --- |
| `CLARVIS_TUI_RSS_LIMIT_MB` | limit in MiB; `0` disables the interactive fuse | `packages/code/src/adapters/memory-pressure.ts:101-108` |
| default RSS limit | 2 GiB | `packages/code/src/adapters/memory-pressure.ts` (`DEFAULT_TUI_RSS_LIMIT_BYTES`) |
| positive custom-limit floor | 512 MiB | `packages/code/src/adapters/memory-pressure.ts` (`MIN_TUI_RSS_LIMIT_BYTES`, `tuiRssLimitBytes`) |
| sampling interval | 500 ms | `packages/code/src/adapters/memory-pressure.ts:5`, `:251-255` |
| warning threshold | 80% of the configured limit | `packages/code/src/adapters/memory-pressure.ts:7-11`, `:133` |
| recovery threshold | three samples below 70% | `packages/code/src/adapters/memory-pressure.ts:7-11`, `:212-218` |
| abort grace | 10 seconds before forced run detachment | `packages/code/src/adapters/memory-pressure.ts:6`, `:200-209` |
| recovery GC | synchronous `Bun.gc(true)` only when every physical run handle and local process has settled; otherwise skip | `packages/code/src/views/App.tsx` (`createMemoryPressureController`), `packages/code/src/adapters/memory-pressure.ts` (`finishRecovery`) |
| efficiency advisory | 512 MiB absolute RSS, 256 MiB growth from baseline and 64 MiB rise over 20 samples; records evidence but does not abort or collect | `packages/code/src/adapters/memory-pressure.ts` (`MEMORY_EFFICIENCY_*`, `publish`) |

The fuse samples only the TUI process. It does not account for external MCP servers, shell children
or other process trees (`packages/code/README.md:143-158`).

### 2.3 Resident collection ceilings

| Collection | Current ceiling | Source |
| --- | ---: | --- |
| one transcript prose node | 2 Mi characters | `packages/code/src/adapters/store.ts:84-90` |
| aggregate resident transcript prose | 64 MiB estimated UTF-16 | `packages/code/src/adapters/store.ts:89-90`, `:349-352` |
| hydrated tool bodies | 200 nodes and 64 MiB estimated | `packages/code/src/adapters/store.ts:286-307`, `:596-617` |
| one hydrated tool body | 32 MiB estimated | `packages/code/src/adapters/store.ts:306-307`, `:601-605` |
| visual transcript turns | 20 semantic turns | `packages/code/src/run-host.ts:202-205`, `:973-981` |
| session resume chain | 10,000 messages and 16,000,000 payload characters | `packages/code/src/adapters/session.ts:399-400`, `:510-531` |
| complete session documents in the client cache | 8, excluding live write lanes from demotion | `packages/code/src/adapters/session-store.ts:250`, `:326-338` |
| provider HTTP response | 32 MiB | `packages/llm/src/ai-sdk/bounded-fetch.ts:4`, `:64-109` |
| MCP HTTP or stdio frame | 16 MiB | `packages/mcp-client/src/bounded-fetch.ts:6`, `packages/mcp-client/src/bun-stdio-client.ts:112` |

These figures are independent safeguards, not permission for all maxima to be resident
simultaneously. Debug mode samples an aggregate application ledger every ten seconds and at state
changes, but it remains evidence rather than an allocator or a second hard budget.

## 3. Data and formats

### 3.1 Benchmark result

Each arm reports four `Stats` records — module-graph `version`, minimal `shell`, header `paint`, and
input `ready` — with `n`, minimum, median and maximum
(`packages/code/tooling/benchmarks/first-paint.ts`, `ArmResult`, `measure`). The
report also records Bun version, cwd, poll interval, power state, CPU governor/profile, observed CPU
frequency and load per core (`packages/code/tooling/benchmarks/first-paint.ts`, `Environment`,
`report`).

A number is comparable only when the relevant environment fields and workload match. The runner
refuses excessive load and marks a batch untrusted when load drifts materially during the run
(`packages/code/tooling/benchmarks/first-paint.ts:331-360`). A one-sample result, a measurement taken from
another cwd, or a direct `dist/index.js --version` comparison against the launcher's fast-path
`--version` does not support a startup conclusion.

### 3.2 Diagnostic records

Interactive `--debug` writes versioned, redacted JSONL. Performance-relevant events include:

| Event | Relevant details | Source |
| --- | --- | --- |
| `app.boot.begin` | mode and workspace | `packages/code/src/index.tsx:426-436` |
| `async.started` / `async.settled` | operation, duration, outcome and sampled count | `packages/code/src/core/diagnostic-events.ts:125-170` |
| `markdown.preload.completed|failed` | parser preload outcome | `packages/code/src/index.tsx:445-458` |
| `app.boot.shell-painted` | process uptime after the minimal parser-free shell reaches renderer idle | `packages/code/src/index.tsx` (`app.boot.shell-painted`) |
| `app.render.mounted` | mode | `packages/code/src/index.tsx:1291-1307` |
| `app.boot.painted` | process uptime, mode and whether the catalog signal is still empty | `packages/code/src/index.tsx:1307-1315` |
| `catalog.load.started` | the catalog-dependent surface that crossed the lazy boundary | `packages/code/src/index.tsx` (`ensureModelsCatalog`) |
| `memory.sample` | phase, RSS, heap, external, array buffers and limit | `packages/code/src/adapters/memory-pressure.ts:169-182` |
| `memory.phase` | previous phase, next phase, RSS and limit | `packages/code/src/adapters/memory-pressure.ts:183-188` |
| `memory.efficiency` | advisory transition, RSS, baseline and recent slope | `packages/code/src/adapters/memory-pressure.ts` (`publish`) |
| `memory.ledger` | bounded transcript/session/renderer/run/event-queue counters; debug only | `packages/code/src/views/App.tsx` (`ledger`), `packages/code/src/adapters/memory-pressure.ts` (`publish`) |
| `memory.gc.completed|failed|skipped` | recovery collection outcome and whether physical work prevented it | `packages/code/src/adapters/memory-pressure.ts` (`finishRecovery`) |

Repeated diagnostic counters are sampled rather than written on every occurrence, so the debug log
cannot itself become an unbounded amplifier (`packages/code/src/adapters/diagnostic-session.ts:535-558`).

### 3.3 Runtime evidence

Runtime soak results are evidence, not persisted application data and not timeless requirements.
They are recorded under the matching headings in [`../known-issues.md`](../known-issues.md), including
the OpenTUI `FloatFrame` leak and the historical workflow-remount incident. A new measurement must
retain its runtime version, terminal dimensions, cycle count, sampling point and whether an explicit
GC occurred; otherwise it must not be compared to a post-GC floor.

## 4. Behavior

### 4.1 Startup critical path

The launcher answers `--help` and `--version` before importing the application graph, then imports
the built artifact for every other mode (`packages/code/src/cli.ts:23-51`). Interactive boot then:

1. opens diagnostics;
2. creates the renderer and mounts one Solid root containing the parser-free `BootFrame`;
3. waits for renderer idle and emits `app.boot.shell-painted`;
4. connects and loads the workspace/kernel foundation without calling the models service or
   subscription provider;
5. constructs stores, the run host and lightweight command routing;
6. replaces `BootFrame` with `<App>` in the same root, emits `app.boot.painted`, and only then starts
   Markdown parser warm-up; restored session content awaits the warm-up
   (`packages/code/src/index.tsx`, `runApp`, `loadFoundation`; `packages/code/src/views/BootFrame.tsx`).

The models.dev snapshot remains a required distributable asset because Providers, Model and Effort
need the offline catalog. First boot does not read or project it. `ensureModelsCatalog` is a
single-flight loader invoked only when one of those catalog-dependent routes is requested. Provider
routes await it concurrently with the dynamic module import before mounting because their first-run
picker opens synchronously; Model and Effort may mount against the reactive facade. The artifact
smoke rejects any first paint that emits `catalog.load.started` or reports
`deferred_catalog !== true` (`packages/code/src/index.tsx`, `ensureModelsCatalog`;
`packages/code/src/features/providers/commands.ts`; `packages/code/src/app/commands.tsx`,
`setup.providers`; `packages/code/tooling/artifact/smoke.ts`).

### 4.2 Subscription and sandbox readiness on startup

App command construction performs no entitlement request. A locally configured subscription whose
runtime readiness has not been inspected is a passing deferred state, with detail `subscription
check deferred`; ordinary boot seeding and local settings writes only invalidate the local gate
revision. Doctor's explicit recheck and catalog-dependent provider/model actions perform the remote
inspection (`packages/code/src/app/commands.tsx`, `recheck`, `inspectReadiness`;
`packages/code/src/onboarding/doctor.ts`, `credentialGate`). Tests pin both the cold route and the
explicit recheck boundary in `packages/code/tests/integration/app-commands.test.tsx`.

The same cold-start boundary applies to sandbox inspection. App command construction leaves
`sandboxInspection` null and does not run host toolchain `--version` probes. Doctor's explicit
recheck and the Sandbox settings surface own that inspection; the run-safety gate treats null as a
passing deferred state (`packages/code/src/app/commands.tsx`, `refreshSandboxInspection`;
`packages/code/src/views/config/SandboxConfigPanel.tsx`, `refreshInspection`;
`packages/code/src/onboarding/doctor.ts`, `run_safety`). The integration test above pins both the
cold route and explicit recheck.

### 4.3 Artifact loading and lazy boundaries

The distributable build enables splitting, keeps OpenTUI package-owned, keeps provider adapters
behind generated dynamic chunks, and moves development source maps away from runtime JavaScript
(`packages/code/tooling/artifact/build.ts:20-35`, `:110-135`). These choices reduced the recorded idle Linux
baseline from roughly 237 MB to 171 MB (`packages/code/README.md:655-663`).

The installed build goes further: `build:install` emits no source maps before the package is linked.
This keeps offline diagnostic maps in developer/root builds without distributing them through the
installed command (`packages/code/tooling/artifact/build.ts` (`installBuild`, `main`),
`packages/code/tooling/setup.ts` (build phase)).

`src/index.tsx` still statically imports the app shell and kernel bootstrap entry because they own
the interactive host. Cold full-page routes do not enter the startup entry: `lazyView` combines
Solid `lazy` and `Suspense`, caches each module promise, and lets the route owner dispose the mounted
subtree. Settings and Extensions list metadata lives in a lightweight module so rendering their
menus does not import every child (`packages/code/src/views/config/lazy-view.tsx`,
`packages/code/src/views/config/hub-items.ts`, `packages/code/src/app/commands.tsx`). The artifact
contract scans representative markers from Help, Tasks, Storage, Sessions, Workflows and Doctor, as
well as Diff and Plan (`packages/code/tooling/artifact/contract.ts`).

### 4.4 Transcript and session retention

Settled prose is charged against one aggregate budget and old prose is replaced with a release
notice. Settled tool bodies are charged by both count and estimated bytes and are dehydrated oldest
first (`packages/code/src/adapters/store.ts:384-470`, `:596-625`). The live host also folds semantic
turns beyond its 20-turn visual window (`packages/code/src/run-host.ts:973-981`).

An ordinary or manager session releases its reconstructible full message chain after the stored
trace is available. Manager turns still never use `continue_from`: immediately before the next
manager request, `fullRequestMessages` reconstructs the complete chain from persisted traces and
refuses an incomplete rebuild (`packages/code/src/run-host.ts`, `fullRequestMessages`,
`submitTurn`). This moves manager history out of steady-state residency without weakening the
full-message semantic contract.

### 4.5 Floating overlays

`FloatFrame` owns an animated scrim, card, border, title, content and optional navigation/footer
(`packages/code/src/views/overlays/FloatFrame.tsx`, `FloatFrame`). Floating `SurfaceBoundary` hosts
place one bounded retained tree in a root `Portal` which survives activation changes. The portal must
not be created inside a conditionally mounted `FloatFrame`, and Portal content must not use
`dispose-on-close`: both forms reproduced accumulating renderer lifecycle passes
(`packages/code/src/ui/patterns/surface-lifecycle.tsx`, `SurfaceBoundary`, `SurfacePortal`).
`ListPicker` windows its rows before mounting them because every mounted row amplifies renderer
churn (`packages/code/src/views/overlays/ListPicker.tsx`, `maxVisibleRows`, `win`). Help is not part
of the floating family: `/help` lazily mounts the full-page `Help` view, and no F1-owned retained
tree exists (`packages/code/src/app/commands.tsx`, `help.open`;
`packages/code/src/views/overlays/Help.tsx`, `Help`).

The existing render tests prove layout and cleanup-visible behavior, not post-GC native RSS. The
controlled renderer soak in [`../known-issues.md`](../known-issues.md#every-floatframe-overlay-leaks-native-memory-per-rendered-row)
is the authority for the leak rate.

The floating family is larger than the two historically measured entry points:

| Surface | Mount path | Variable allocation risk | Current evidence |
| --- | --- | --- | --- |
| agent picker and default-scope picker | `App` -> retained `ProfilePicker` -> `ListPicker` -> `FloatFrame` | windowed agent rows, preview and optional second picker | remount +12.71; retained -0.23 MiB PSS/100 |
| safety preset picker | `App` -> lazy retained `SafetyPresetPicker` -> `ListPicker` -> `FloatFrame` | six fixed rows, one preview and an armed confirmation | +1.56 MiB PSS/100 at 120x32; +1.28 at 80x24; zero owner deltas |
| provider/model/enum picker | config view -> retained `CatalogPicker` -> `ListPicker` -> `FloatFrame` | windowed rows, fuzzy-highlight spans and optional input | remount +14.26; retained -1.49 MiB PSS/100 |
| activity detail | `App` -> retained `ActivityDetail` -> `FloatFrame` | Markdown block count and parser-native renderables; payload is cleared on close | -16.92 MiB PSS/100 in the 200-section remount case; no confirmed slope |
| clean-worktree exit prompt | `App` -> retained `WorktreeExitPrompt` -> `FloatFrame` | fixed, small body | +0.44 MiB PSS/100 in the remount case; no confirmed slope |

`HintToast` is also conditionally instantiated while any host or transient overlay is open
(`packages/code/src/views/App.tsx:1284-1286`, `packages/code/src/views/Footer.tsx:34-56`). A full-app
soak must account for it separately from the card under test, even though an empty hint mounts no
native toast box.

### 4.6 Other overlay-like lifecycles

Not every surface called an overlay uses `FloatFrame`, and the known per-row rate must not be copied
onto these families without measurement:

- `OverlayRegion` keeps the transcript shell mounted while switching to retained configuration,
  `DiffViewer` or `PlanOverlay` surfaces. `SurfaceRegion` removes inactive retained pages from Yoga
  layout and painting; configuration parents deliberately stay mounted only while their frame
  remains in the stack (`packages/code/src/views/app/OverlayRegion.tsx`, `OverlayRegion`,
  `packages/code/src/views/overlay-host.ts`, `mountView`, `popView`).
- full Help, Diff and Plan pages use `PageFrame`. Help and Plan currently construct all projected
  rows, while Diff may construct a large tool renderer
  (`packages/code/src/views/overlays/Help.tsx:193`,
  `packages/code/src/views/overlays/PlanOverlay.tsx:521-570`,
  `packages/code/src/views/overlays/DiffViewer.tsx:43-81`).
- `AutocompletePopup` is lazily retained by `InputDock`. It windows to at most ten rows and rewrites
  the same container, headers, highlighted spans and row slots after the first open
  (`packages/code/src/views/InputDock.tsx`, `SurfaceBoundary`,
  `packages/code/src/ui/patterns/windowed-list.tsx`, `StableWindowedList`,
  `packages/code/src/views/input/AutocompletePopup.tsx`, `MAX_ROWS_CAP`).
- the compact activity drawer mounts a full-bleed scrim and Sidebar, while editor expansion merely
  changes layout properties on the already-mounted input region
  (`packages/code/src/views/app/TranscriptRegion.tsx:246-280`,
  `packages/code/src/views/App.tsx:1290-1321`).
- Splash, elicitation, terminal-floor and fatal-boot surfaces are conditional, but they are not
  normal high-frequency modal routes. They still belong in control cases because input churn can
  accidentally remount Splash and make an autocomplete measurement invalid
  (`packages/code/src/views/app/TranscriptRegion.tsx:199-245`,
  `packages/code/src/views/App.tsx` (terminal-floor `Show`), and
  `packages/code/src/views/FatalBoot.tsx` (`FatalBoot`)).

The implementation plan in section 8.4 therefore begins with independent process-level attribution,
not a blanket assumption that every conditional surface has the upstream `FloatFrame` defect.

### 4.7 RSS fuse and recovery

The memory controller samples every 500 ms. At 80% it warns; at the limit it cancels active work
once and blocks new work while leaving explicit recovery, clear and quit routes available
(`packages/code/src/adapters/memory-pressure.ts:193-229`, `:94-99`). Recovery reconnects the backend,
synchronously collects JavaScript garbage only when every physical backend handle and local process
has settled, then waits for three samples below 70% before rearming. Forced UI detachment does not
release the physical lease; when work is still settling, recovery records `memory.gc.skipped` and
does not schedule collection for later (`packages/code/src/run-host.ts`, `physicalWorkActive`;
`packages/code/src/adapters/memory-pressure.ts`, `finishRecovery`). This prevents a recovery GC from
overlapping the next provider/tool run.

The default is 2 GiB, so warning begins at 1.6 GiB. Positive overrides are clamped to 512 MiB, while
zero still disables the fuse. A separate efficiency advisory can report sustained growth far below
the hard limit, but never cancels, reconnects or collects. Debug-only aggregate ledgers are gated by
the active diagnostic logger so ordinary runs do not traverse renderer or host counters every ten
seconds (`packages/code/src/views/App.tsx`, `ledgerEnabled`).

## 5. Invariants

1. **PERF-1: `--help` and `--version` do not import the application graph.**
   Production: `packages/code/src/cli.ts:23-34`.
   Test: `packages/code/tests/architecture/cli-fast-path.test.ts:80-98`.

2. **PERF-2: the built artifact keeps the AI SDK/provider adapter behind a generated lazy chunk.**
   Production: `packages/code/tooling/artifact/build.ts:70-81`, `:115-126`.
   Test: `packages/code/tests/architecture/artifact-contract.test.ts:11-33`.

3. **PERF-3: developer source maps remain available away from runtime JavaScript; installed source
   maps are omitted.**
   Production: `packages/code/tooling/artifact/build.ts` (`detachSourceMaps`, `installBuild`, `main`).
   Test: `packages/code/tests/architecture/artifact-contract.test.ts` (developer and install map
   cases).

4. **PERF-4: transcript prose is bounded per node and across settled resident nodes.**
   Production: `packages/code/src/adapters/store.ts:84-110`, `:384-470`.
   Test: `packages/code/tests/unit/streaming-delta.test.ts:160-220`.

5. **PERF-5: settled hydrated tool bodies obey both count and aggregate-byte limits.**
   Production: `packages/code/src/adapters/store.ts:286-307`, `:596-617`.
   Test: `packages/code/tests/unit/store-hydration.test.ts:98-159`.

6. **PERF-6: a persisted non-manager turn releases reconstructible history and can rebuild it
   lazily when provider continuation is unavailable.**
   Production: `packages/code/src/run-host.ts:678-768`.
   Test: `packages/code/tests/component/run-host.test.ts:1269-1340`.

7. **PERF-7: a manager releases durably reconstructible resident history while idle, then rebuilds
   and sends the complete chain rather than using `continue_from`.**
   Production: `packages/code/src/run-host.ts` (`fullRequestMessages`, `submitTurn`).
   Test: `packages/code/tests/component/run-host.test.ts` ("manager runs release persisted history
   and rebuild the complete chain for the next turn").

8. **PERF-8: the 2 GiB-default RSS fuse warns at 80%, cancels once at the limit, and remains
   recoverable rather than exiting the process. Positive overrides cannot fall below 512 MiB, and
   recovery GC runs only while physical work is idle.**
   Production: `packages/code/src/adapters/memory-pressure.ts` (`tuiRssLimitBytes`,
   `finishRecovery`), `packages/code/src/run-host.ts` (`physicalWorkActive`).
   Test: `packages/code/tests/unit/memory-pressure.test.ts` and
   `packages/code/tests/component/run-host.test.ts` (physical lease cases).

9. **PERF-9: memory sampling uses one unrefed 500 ms timer and a disabled fuse installs no timer.**
   Production: `packages/code/src/adapters/memory-pressure.ts:248-260`.
   Test: `packages/code/tests/unit/memory-pressure.test.ts:189-234`.

10. **PERF-10: connected subscription readiness is deferred and passing at boot; only an explicit
    Doctor recheck or subscription-dependent surface performs the remote inspection.**
    Production: `packages/code/src/onboarding/doctor.ts` (`credentialGate`) and
    `packages/code/src/app/commands.tsx` (`inspectReadiness`).
    Test: `packages/code/tests/integration/doctor.test.ts` and
    `packages/code/tests/integration/app-commands.test.tsx` (explicit entitlement recheck).

11. **PERF-11: repeated Plan, Diff and autocomplete opens reuse bounded renderer ownership after
    first use, while configuration navigation retains its exact shell/frame disposal.**
    Production: `packages/code/src/views/app/OverlayRegion.tsx` (`OverlayRegion`),
    `packages/code/src/views/InputDock.tsx` (`SurfaceBoundary`), and
    `packages/code/src/ui/patterns/windowed-list.tsx` (`StableWindowedList`) and
    `packages/code/src/views/input/AutocompletePopup.tsx` (`MAX_ROWS_CAP`).
    Test: `packages/code/tests/integration/overlay-region-render.test.tsx`,
    `packages/code/tests/integration/autocomplete-popup-render.test.tsx`, and
    `packages/code/tests/unit/overlay-host.test.ts`.

12. **PERF-12: Diff, Plan and the safety-preset picker stay outside the first-load JavaScript
    entrypoint.**
    Production: `packages/code/src/views/app/OverlayRegion.tsx` (`lazy`),
    `packages/code/src/views/App.tsx` (`SafetyPresetPicker`),
    `packages/code/tooling/artifact/contract.ts` (`assertLazySurfaceArtifact`), and
    `packages/code/tooling/artifact/build.ts` (`assertLazyProviderChunk`).
    Test: `packages/code/tests/architecture/artifact-contract.test.ts` ("cold full-page and floating
    surfaces remain in lazy chunks").

13. **PERF-13: a surface has one explicit disposal policy, a stable portal owner and balanced
    non-visual ownership.** Non-portal regions may dispose or retain; portal surfaces always retain
    one bounded subtree because changing the Portal host during recursive conditional removal
    orphans lifecycle-pass renderables. Inactive floating components keep disabled key layers and a
    constant lifecycle-pass set rather than registering or allocating again per activation.
    Production: `packages/code/src/ui/patterns/surface-lifecycle.tsx` (`SurfaceBoundary`,
    `SurfacePortal`, `useSurfaceFocus`, `useSurfaceActivationGuard`),
    `packages/code/src/views/overlays/FloatFrame.tsx` (`FloatFrame`), and
    `packages/code/src/views/overlays/ListPicker.tsx` (`ListPicker`), including the lazy retained
    `SafetyPresetPicker` host in `packages/code/src/views/App.tsx`.
    Test: `packages/code/tests/integration/surface-lifecycle-render.test.tsx` and
    `packages/code/tests/integration/list-picker-render.test.tsx` ("a retained picker keeps one key
    layer registration and gates it while inactive"), plus
    `packages/code/tooling/benchmarks/overlays.tsx` (`safety-preset-picker-retained`).

14. **PERF-14: retained inactive configuration pages do not keep periodic background work alive.**
    Workflow polling and provider authorization countdowns run only while their owning view is
    active; configuration and input key layers use stable reactive matchers across activation.
    Production: `packages/code/src/views/config/WorkflowsHub.tsx` (running-poll effect),
    `packages/code/src/views/config/ProvidersPanel.tsx` (countdown effect),
    `packages/code/src/ui/patterns/bind-level-keys.ts` (`bindLevelKeys`),
    `packages/code/src/views/overlay-host.ts` (`mountView`), and
    `packages/code/src/views/InputDock.tsx` (`visibleMatcher`).
    Test: `packages/code/tests/integration/workflows-hub-render.test.tsx` ("a retained workflow page
    pauses polling while inactive"), `packages/code/tests/unit/level-keys.test.ts`, and
    `packages/code/tests/unit/overlay-host.test.ts`.

15. **PERF-15: first boot does not read the models.dev catalog, call subscription entitlement or
    probe sandbox toolchains; catalog and cold full-page modules load only when their owning routes
    mount.**
    Production: `packages/code/src/index.tsx` (`ensureModelsCatalog`),
    `packages/code/src/views/config/lazy-view.tsx`, and
    `packages/code/src/app/commands.tsx` (dynamic route factories), plus
    `packages/code/src/views/App.tsx` (lazy `SafetyPresetPicker`).
    Test: `packages/code/tests/integration/app-commands.test.tsx`,
    `packages/code/tests/architecture/artifact-contract.test.ts`, and
    `packages/code/tooling/artifact/smoke.ts`.

16. **PERF-16: one Solid root paints a parser-free shell before the usable application, and parser
    warm-up does not hold that usable paint; aggregate memory diagnostics are O(1) at their data
    sources and disabled when no diagnostic sink exists.**
    Production: `packages/code/src/index.tsx` (`appProps`, `app.boot.shell-painted`),
    `packages/code/src/views/BootFrame.tsx`, `packages/code/src/views/App.tsx` (`ledgerEnabled`), and
    `packages/kernel/src/core/event-stream.ts` (`stats`).
    Test: `packages/code/tooling/artifact/smoke.ts`,
    `packages/code/tests/unit/memory-pressure.test.ts`, and
    `packages/kernel/tests/unit/event-stream.test.ts`.

17. **PERF-17: high-churn list input changes content inside bounded retained ownership instead of
    reconstructing catalog, completion or renderer trees.** Bare slash reuses the command catalog
    and browse rows, autocomplete uses fixed stable slots, and retained float
    timelines restart only on their first activation. Production: `packages/code/src/keys/commands.ts`
    (`commandCatalog`), `packages/code/src/views/input/command-completion.ts`,
    `packages/code/src/ui/patterns/windowed-list.tsx` (`StableWindowedList`), and
    `packages/code/src/views/overlays/FloatFrame.tsx` (`FloatFrame`). Test:
    `packages/code/tests/unit/commands.test.ts`,
    `packages/code/tests/integration/autocomplete-popup-render.test.tsx`, and
    `packages/code/tooling/benchmarks/overlays.tsx` (`autocomplete-retained-scroll-10-rows`).

18. **PERF-18: streamed syntax surfaces use a bounded readiness handoff instead of exposing parser
    transitions or remounting stable work.** Ordinary assistant settlement preserves sealed-prefix
    identity and retains at most one visible plus one preparing Markdown tree. A diff has one
    retained intrinsic while its value is stable. Both await public descendant highlight completion
    and one confirming paint; neither pauses the renderer nor uses a delay timer. Production:
    `packages/code/src/core/transcript/segment.ts` (`IncrementalMarkdownSegmenter.#settle`) and
    `packages/code/src/ui/patterns/stable-syntax.tsx` (`StableMarkdown`, `StableDiff`,
    `waitForSyntaxFrame`). Tests: `packages/code/tests/unit/segment-markdown.test.ts` ("settling
    preserves stable Markdown prefixes and large replies stay plain"),
    `packages/code/tests/integration/markdown-render-contract.test.tsx` ("settlement keeps the
    painted streaming markdown visible until its final tree is ready"), and
    `packages/code/tests/integration/tool-diff-render.test.tsx` ("a finalized diff keeps one
    renderable while an active sibling updates").

No invariant currently sets an absolute usable-input or healthy-idle RSS target. The overlay runner
enforces 5 MiB/100 post-GC growth and balanced renderer/key ownership for production-policy cases at
reference and compact dimensions. It does not yet sample a complete real-model multi-run process
tree.

## 6. Failure modes and degradation

| Failure or pressure | Current degradation | Evidence |
| --- | --- | --- |
| benchmark host is too busy | refuse unless forced; forced report is untrusted | `packages/code/tooling/benchmarks/first-paint.ts:331-360` |
| PTY never reaches a marker | fail with bounded screen and stderr context | `packages/code/tooling/benchmarks/first-paint.ts:211-234` |
| Markdown parser warm-up fails | emit a warning diagnostic and keep the usable application shell | `packages/code/src/index.tsx` (`markdownPreload`) |
| final Markdown or diff syntax work is still pending | keep the previous Markdown tree visible or the new diff transparent until `waitForSyntaxFrame` completes; reveal OpenTUI's fallback if readiness rejects, and do not pause the renderer | `packages/code/src/ui/patterns/stable-syntax.tsx` (`StableMarkdown`, `StableDiff`, `waitForSyntaxFrame`) |
| on-demand catalog load fails | keep the live catalog empty and emit `catalog.unavailable`; the already-painted shell remains usable | `packages/code/src/index.tsx` (`ensureModelsCatalog`) |
| subscription readiness has not been inspected | keep the local gate passing with `subscription check deferred`; explicit Doctor inspection can later report a real warning | `packages/code/src/onboarding/doctor.ts` (`credentialGate`) |
| one transcript prose value is oversized | truncate before it enters reactive state | `packages/code/src/adapters/store.ts:103-110` |
| aggregate prose is full | release older settled prose, preserve newest | `packages/code/src/adapters/store.ts:394-470` |
| hydrated tool budget is full | dehydrate older bodies; explicit expand can re-fetch within queue limits | `packages/code/src/adapters/store.ts:596-617`, `:647-758` |
| session reconstruction exceeds request-shape limits | throw `SessionResumeLimitError` before the next batch | `packages/code/src/adapters/session.ts:510-531` |
| RSS reaches configured limit | cancel, detach after grace if required, block new work and offer recovery | `packages/code/src/adapters/memory-pressure.ts:193-229` |
| overlay soak child starves or grows past its process budget | parent watchdog kills it and fails with the case name and limit | `packages/code/tooling/benchmarks/overlays.tsx` (`runParent`) |
| interactive event loop is starved outside the soak | in-process sampler may not run; host/process-tree monitoring is still required | `specs/known-issues.md` (reactive microtask starvation) |
| external MCP/shell process grows | TUI self-RSS fuse does not observe it | `packages/code/README.md:149-151` |

## 7. Coupling

- **`code` -> OpenTUI/Solid:** renderer-native allocation, parser preload, reconciler destruction and
  floating renderables determine both first paint and native RSS. OpenTUI remains external to the
  bundle so its worker, grammars and platform package keep correct ownership
  (`packages/code/tooling/artifact/build.ts:20-23`, `:120-125`).
- **`code` -> `kernel`:** the interactive host constructs an in-process file kernel before mounting
  `<App>`, so kernel imports and composition are part of startup and RSS
  (`packages/code/src/index.tsx:11`, `:466-487`).
- **`code` -> model/subscription services:** the boot foundation does not cross either expensive
  service. Catalog-bearing routes call the models service through `ensureModelsCatalog`; Doctor's
  explicit recheck and subscription-dependent actions call entitlement over the protocol surface
  (`packages/code/src/index.tsx`, `ensureModelsCatalog`;
  `packages/code/src/app/commands.tsx`, `inspectReadiness`).
- **`code` -> transcript/session persistence:** visual windows can release presentation data, but a
  future full request may require persisted traces to reconstruct semantic history
  (`packages/code/src/run-host.ts:681-699`, `packages/code/src/adapters/session.ts:462-509`).
- **`code` -> `llm`/`mcp-client`:** response ceilings bound individual inputs to the transcript but
  are not charged against the same resident budget
  (`packages/llm/src/ai-sdk/bounded-fetch.ts:64-109`,
  `packages/mcp-client/src/bounded-fetch.ts:67-112`).
- **Performance -> diagnostics:** any new hot-path metric must follow the bounded counter sampler;
  observability must not become the leak it is diagnosing
  (`packages/code/src/adapters/diagnostic-session.ts:535-558`).

The owning package README is [`packages/code/README.md`](../../packages/code/README.md). Build artifact
details remain owned by [build-and-ci.md](../cross-cutting/build-and-ci.md); exact session and
transcript semantics remain owned by [sessions.md](sessions.md),
[code-run-host.md](code-run-host.md) and [code-transcript.md](code-transcript.md).

## 8. Open questions and measured review

### 8.1 Measurement snapshot — 2026-08-24

The official benchmark ran with Bun 1.4.0, 16 cores, AC power, `performance` governor/profile,
approximately 4.5 GHz observed CPU frequency, low per-core load, five measured repetitions plus one
discarded warm-up, and returned `trusted: true`.

| Arm | `--version` median | header median | input-ready median |
| --- | ---: | ---: | ---: |
| source | 15.9 ms | 1,131.3 ms | 1,131.3 ms |
| direct bundle | 261.9 ms | 1,131.1 ms | 1,131.1 ms |
| launcher/bin | 16.8 ms | 1,132.1 ms | 1,132.1 ms |

The direct-bundle `--version` arm intentionally loads the application entry; the launcher answers
that flag before importing it. For an interactive launch, the diagnostic interval from process start
to `app.boot.begin` was approximately 259 ms, consistent with application graph load. Two live debug
boots painted according to the in-process event at 669-670 ms. Their measured sub-spans included
58 ms for Markdown initialization/preload, 45-46 ms for workspace/kernel construction, 7-8 ms for
agent listing and approximately 55-60 ms between settings completion and agent-file loading while the
catalog was parsed/projected.

Three configured PTY boots using the local connected subscription separated the first header from a
conversation-only marker:

| Sample | header | conversation usable | gap |
| --- | ---: | ---: | ---: |
| 1 | 727.6 ms | 1,336.7 ms | 609.0 ms |
| 2 | 726.6 ms | 1,356.0 ms | 629.4 ms |
| 3 | 725.2 ms | 1,265.1 ms | 539.9 ms |

Source inspection and the mounted-view diagnostics show that `recovery.open` existed during that
gap and closed after subscription readiness changed. It is therefore a supported inference — not a
network trace — that the pending entitled-catalog check is the dominant configured-only delay in
this sample.

Healthy idle settled near 175-180 MiB RSS with about 33 MiB JS heap. One 100-cycle Help open/close
churn moved process RSS from 173,328 KiB to 253,872 KiB before an explicit collection. A following
100-cycle agent-picker churn moved it from 241,488 KiB to 305,692 KiB. Those immediate deltas include
collectable JS/external allocations and are not leak rates.

A second Help run used a 220 MiB fuse so the supported `/recover-memory` path would rebuild the
backend and invoke `Bun.gc(true)`. After 30 cycles, the settled process remained at 203,392 KiB versus
176,548 KiB before churn, about 26 MiB higher. Backend reconstruction is a confounder, so this run
shows a retained residue in that full-process path but does not replace the controlled rates in
[`../known-issues.md`](../known-issues.md#every-floatframe-overlay-leaks-native-memory-per-rendered-row).
It also demonstrated that a low fixed fuse can never rearm when 70% of its limit is below healthy
idle RSS.

The expanded fresh-process runner then exercised real production components at 120x32. The first
100-cycle screen identified four high remount cases: Context Help +21.32, Profile Picker +13.39,
Catalog Picker +16.68 and the 64-agent activity drawer +30.38 MiB PSS/100. Activity Detail with 200
Markdown sections (-16.92), Worktree Exit (+0.44), elicitation guard (+2.25), HintToast (-4.25) and
Splash (+1.63) did not show the same positive slope. Three-hundred-cycle confirmation measured
Context Help +19.54, Profile Picker +12.71, Catalog Picker +14.26 and the drawer +19.15 MiB PSS/100.
The corresponding retained variants were +0.72, -0.23, -1.49 and +0.13 MiB/100. Renderable counts
returned to baseline and JS heap decreased, locating the high remount slopes in renderer/native
lifecycle residue rather than reachable Solid objects.

Context Help was not retained in production: a clean real-PTY probe made immediate PSS grow by
roughly 94-100 MiB over 100 rapid retained visibility cycles, and a 20-cycle paced run was worse than
the conditional remount. Windowing and replacing the two-level `EntityRow` tree with four compact
stable action rows instead reduced the controlled 300-cycle result from +19.54 to +5.77 MiB PSS/100.
An empty and one-row `FloatFrame` measured +1.30 and +1.21 MiB PSS/100 respectively. This is a large
reduction, but +5.77 is still growth and narrowly misses the proposed 5 MiB criterion; the F1
residual was left open at this measurement stage and is addressed by the 2026-08-25 follow-up below.

The retained Profile Picker, Catalog Picker and drawer variants are flat after forced collection and
are now used lazily after first open. Their full-process immediate samples can still rise before the
runtime reclaims native arenas; retention is a leak correction, not a promise that the instantaneous
RSS number falls on close.

An additional, less-confounded autocomplete probe kept a non-empty `x ` draft so Splash remained
unmounted, then completed 100 screen-verified `@` popup open/close cycles in the same 120x32 PTY.
Immediate RSS rose from 195,552 KiB to 239,656 KiB; PSS rose from 167,558 KiB to 211,662 KiB; and
`Private_Dirty` rose from 142,544 KiB to 186,456 KiB. A later sample without explicit GC had already
fallen to 202,192 KiB RSS and 148,992 KiB private dirty. This makes autocomplete a candidate for the
post-GC matrix, but does **not** establish a 44 MiB leak. The controlled forced-GC scrolling case
was added in the 2026-08-25 follow-up below.

The current bundle was 3.75 MB and its detached source map named 691 startup-entry modules. Source
content represented substantial eager surfaces from `code`, `kernel`, `loop`, `memory`, `plan`,
`workflows`, `trace`, `mcp-client`, `tasks` and their third-party dependencies. This is a bundle
composition observation, not a claim that source byte count maps linearly to runtime cost.

No intentional model workload was part of this audit. During overlay driving, PTY input-ordering
mistakes submitted malformed `/settings/settings` and `slashhelp` text. Both were cancelled as soon
as they were noticed; neither response was used as performance evidence. The local subscription was
otherwise exercised only by startup readiness/catalog. A controlled real-model, multi-run soak with
MCP and an external process-tree watchdog remains unperformed.

#### Historical current-memory slash, scroll and former F1 follow-up — 2026-08-25

A bare `/` followed by Backspace reproduced a different symptom from the retained-owner leak: close
samples climbed by roughly 5–6 MiB per cycle and then fell without explicit collection after the
process sat idle. Source attribution found that each bare-slash query rebuilt the complete command
catalog twice, constructed nested command rows that the browse path discarded, sorted a new browse
array and recomputed fuzzy highlight runs for unchanged text. F1 also reprojected the footer actions
and restarted the retained `FloatFrame` timeline on every activation. These were collectable
allocation bursts, not monotonically reachable overlay owners, but they raised current RSS/PSS fast
enough to be operationally significant.

The correction cached the command catalog against registry revision and keyboard environment,
cached the bare-slash projection while rechecking dynamic eligibility, used fixed slots for both
autocomplete and the former Context Help surface, rendered unfiltered rows without fuzzy run arrays,
reused the footer action projection and animated a retained float only on its first activation. No
opportunistic or periodic GC was added. The former Context Help/F1 production surface and its soak
cases were removed later on 2026-08-25; the measurements below remain historical attribution
evidence, not a current product matrix.

In a fresh 120x32 source PTY, ten `/`+Backspace cycles moved PSS from 225,704 to 234,532 KiB, with
plateaus and a decline, rather than the prior repeated 5–6 MiB step. Ten Down selections in the open
command popup moved 233,484 to 235,672 KiB, including a decline at selection six. After the first
retained F1 activation, close samples two through five moved 238,200 to 240,636 KiB and included one
decline; a delayed sample after the combined exercise was 233,276 KiB. Immediate endpoints remain
allocator/GC observations, not leak rates.

The fresh-process, forced-GC 100-cycle matrix measured autocomplete visibility at +0.58 MiB PSS/100,
autocomplete scrolling at -22.32, retained Context Help at +1.64 and retained Context Help with
action reprojection at +2.20. The negative scrolling endpoint is collection of warm-up arenas, not a
memory saving. Every case kept live renderables, lifecycle passes and key layers at delta zero, and
all production cases remained below the 5 MiB PSS/100 policy threshold. The longer 300-cycle
confirmation measured autocomplete scrolling at -10.07 MiB PSS/100 and reprojected retained Context
Help at +1.25 MiB PSS/100; both again kept every ownership delta at zero. The positive Context Help
endpoint is therefore reported as bounded residual growth below the policy threshold, not described
as a memory reduction or a zero slope. Production:
`packages/code/src/keys/commands.ts` (`commandCatalog`),
`packages/code/src/views/input/command-completion.ts`,
`packages/code/src/ui/patterns/windowed-list.tsx` (`StableWindowedList`),
`packages/code/src/views/input/AutocompletePopup.tsx`,
`packages/code/src/views/overlays/FloatFrame.tsx`. Test:
`packages/code/tests/unit/commands.test.ts`,
`packages/code/tests/integration/autocomplete-popup-render.test.tsx`, and
`packages/code/tooling/benchmarks/overlays.tsx`.

### 8.2 Prioritized changes and implementation status

1. **Remove subscription entitlement from the blocking startup path.** Treat locally connected but
   not-yet-checked readiness as pending rather than repair-worthy; perform the remote entitlement
   check at the first subscription-dependent action. **Implemented:** ordinary boot and internal
   settings writes only rerun local gates; Doctor's explicit recheck owns remote inspection.
2. **Make catalog deferral temporal, not merely unawaited.** **Implemented:**
   `loadFoundation` does not call `client.models.get()`; a catalog-bearing view crosses the
   single-flight `ensureModelsCatalog` boundary.
3. **Close every overlay leak demonstrated by the matrix in section 8.4 — implemented for the
   current matrix.** Retained autocomplete, Plan/Diff, Profile Picker, Catalog Picker and activity
   drawer lifecycles close their controlled slopes. The former Context Help surface was first bounded
   and retained, then removed with its F1 route; `/help` now owns Help without a floating tree. Small
   fixed modals were measured and left disposable because they did not
   reproduce a high positive slope.
4. **Release manager history at idle.** **Implemented:** durable traces release the resident chain;
   the next manager turn rebuilds it before sending the required full request.
5. **Create one aggregate memory ledger.** **Implemented:** resident prose bytes, hydrated tool bytes, session
   message count/payload, transcript/renderable node count, trace/event queue bytes and manager
   history bytes enter bounded debug diagnostics. Event queues and stores maintain O(1) counters;
   renderer traversal runs only while a diagnostic sink exists.
6. **Separate efficiency warning from catastrophic fuse.** **Implemented:** the advisory uses
   absolute, baseline-growth and recent-slope gates without abort or GC; positive fuse overrides
   have a 512 MiB floor, and the product default is now 2 GiB.
7. **Split cold routes and capabilities.** **Implemented for Code-owned full-page routes and
   models.dev:** settings panels, domain hubs and Help load through cached Solid lazy boundaries;
   artifact checks reject representative markers in the startup entry. Kernel bootstrap remains
   eager because it is the in-process host, not an optional route.
8. **Paint a minimal shell before non-visual boot work.** **Implemented:** one Solid root first paints
   `BootFrame`, then usable `<App>` before Markdown warm-up starts. Restored session Markdown waits
   for both grammars.
9. **Extend measurement coverage.** Add a configured-home fixture with a shell-only ready marker, a
   long manager-session soak, and a real-model multi-run process-tree sampler. **Partially
   implemented:** artifact smoke asserts the shell marker and catalog deferral; the controlled
   first-paint benchmark records the exclusive parser-free shell separately from the complete app;
   overlay soaks run at two sizes under a parent RSS/time watchdog and enforce the production
   threshold. Real-model and long-manager process-tree soaks remain intentionally user-controlled
   external measurements.

### 8.3 Acceptance and review gates

The production overlay gate is implemented; the remaining absolute values are review criteria until
they have a named reference host and owner acceptance:

- no external network request blocks the conversation shell on an already configured launch;
- trusted configured-startup median below 1 second on the named Linux reference host;
- healthy idle below 200 MiB RSS at 120x32 on that host;
- no more than 5 MiB post-GC PSS growth after 100 repeated opens of every production-policy overlay
  case on Linux, or RSS where PSS is unavailable — **enforced by `bench:code-overlays`**;
- no single-agent multi-run soak exceeds 512 MiB RSS after transient response buffers settle;
- process-tree measurements report external MCP/shell memory separately from Clarvis self-RSS.

Absolute thresholds require a named reference machine and separate Linux, macOS and Windows evidence.
The non-overlay absolute thresholds remain review criteria rather than release gates.

### 8.4 Overlay leak implementation and correction plan

This plan covers every current overlay and overlay-like mount path. It deliberately distinguishes a
**confirmed leak**, a **source-confirmed member of a leaking family**, and a **candidate requiring a
post-GC control**. Fixing only F1 would leave the agent/catalog/activity/worktree `FloatFrame` paths,
autocomplete, full-region pages and drawer lifecycle unguarded.

#### Implementation status — 2026-08-24

The correction followed the attribution order and was widened beyond F1:

1. `bench:code-overlays` added fresh-process post-GC controls plus production Context Help,
   Activity Detail, Worktree Exit, Profile Picker, Catalog Picker, elicitation, drawer, HintToast,
   Splash and empty Workflows cases alongside primitive, autocomplete and `PageFrame` cases.
2. `@opentui/core`, `@opentui/keymap` and `@opentui/solid` moved together from 0.4.3 to 0.5.7. The
   30-row primitive changed from the historical row-proportional slope to +0.77 MiB PSS per 100
   cycles. That positive number means residual growth, not memory saved; production components
   exposed larger lifecycle amplifiers that the primitive-only result did not predict.
3. `SurfaceBoundary` now owns lazy construction, `dispose-on-close`/`retain-one`, activation identity,
   root-portal placement, focus release and stale-async guards. Every root-Portal surface uses
   `retain-one`; Profile Picker, every Catalog Picker and the narrow activity drawer do the same in
   their respective hosts. The component-local `*Mounted` latches and retained-spec proxy are gone.
   Inactive key layers use stable reactive matchers, and a catalog resets filter and cursor state
   when its spec changes.
4. The non-float audit found a repeatable Plan page residue. `OverlayRegion` now keeps the shell
   mounted behind Plan/Diff, lazily retains those pages after first use, and gates their inactive key
   layers. Plan PSS changed from about +15.1 MiB to +2.15 MiB per 100 real PTY cycles.
5. `InputDock` now lazily retains one autocomplete container with ten stable row/header slots;
   Help uses stable indexed section/row ownership. Prompt/editor layers register once and are gated
   by reactive visibility/state matchers. The retained autocomplete primitive measured -1.48 MiB
   PSS per 100 post-GC cycles, so its earlier immediate increase is not classified as a leak.
   Configuration/onboarding level layers use the same policy: activation, editor, confirmation and
   picker gates no longer create another layer registration unless the level structure itself
   changes.
6. Floating boundaries own a stable root `Portal`; `FloatFrame` no longer creates a portal inside
   its remounted subtree. The rejected intermediate design grew the 30-row primitive by +48.21 MiB
   PSS/100 and accumulated 3,200 renderer lifecycle passes. A subsequent absolute counter found that
   even a stable outer Portal orphaned two text lifecycle passes per disposable cycle when its host
   visibility or layout changed during recursive removal. Portal placement now requires bounded
   `retain-one`, and the regression test requires its post-first-open lifecycle set to stay constant.
7. The former Context Help retained its bounded four-action projection after first use. Its last disposable
   stable-portal 100-cycle run was non-monotonic and ended at +2.39 MiB PSS/100; retained and
   reprojected controls ended at -2.85 and -1.59. The old +5.77 result remains historical evidence,
   but the current retained policy is driven by the deterministic lifecycle ownership counter rather
   than that noisy memory slope. The component, action and active soak cases were subsequently
   removed; the row remains historical evidence for the lifecycle decision.
8. Configuration navigation keeps its intentional stack ownership: inactive parents remain mounted,
   and popped frames dispose once. Stable matchers avoid layer registration churn, Workflow polling
   and provider countdowns pause while inactive, and Plan invalidates in-flight read identities on
   deactivation. Activity Detail and Worktree Exit retain their Portal subtrees with inactive key
   gates; Activity Detail replaces its Markdown payload with an empty value on every close.
   Elicitation, Splash and non-portal HintToast keep their existing conditional/disposable ownership
   because their independent cases did not reproduce a high post-GC slope. No opportunistic `Bun.gc`
   was added.
9. Diff and Plan now use Solid `lazy`/`Suspense`, and the build plus artifact smoke reject a bundle
   that absorbs their marker content into `dist/index.js`. The final build produced a 2.35 MB entry,
   32 lazy chunks, 33 detached maps and 66 outputs. Its clean-HOME artifact smoke reached first paint
   in 1,140 ms with `app.boot.painted` at 624 ms. The controlled AC/performance n=7 bundle benchmark
   measured a 268 ms median module graph and a 1,105 ms median for both header paint and input ready
   (1,104-1,132 ms, 28 ms spread). Lifecycle retention and module-graph deferral remain separate
   policies. The entry is 1.40 MB smaller than the 3.75 MB audit snapshot, but no controlled
   pre-change n=7 run exists, so the spec makes no causal first-paint latency claim from that byte
   delta alone.
10. The same reusable `lazyView` boundary now covers every Code-owned cold full-page command route,
    while lightweight Settings/Extensions metadata stays eager. The overlay runner executes the
    default 120x32 and 80x24 matrix under a parent 120-second/1-GiB watchdog, fails production-policy
    cases above 5 MiB PSS/100 (RSS off Linux), and requires renderable, lifecycle-pass and live-key
    ownership to balance. The post-change developer build produced a 0.51 MB entry, 85 lazy chunks,
    86 detached maps and 172 outputs. Its clean-HOME smoke reached the parser-free shell at 300 ms,
    the usable app diagnostic at 647 ms and the observed input at 732 ms, with
    `deferred_catalog=true`. A subsequent trusted AC/performance n=7 bundle benchmark measured a
    270 ms median module graph, 312 ms parser-free shell, 641 ms complete header and 641 ms
    input-ready frame; the shell spread was 2 ms and the complete-frame spread was 29 ms. The
    then-current complete 12-case production-policy soak passed 100 cycles at both dimensions: the highest
    positive PSS endpoint was elicitation at +2.85 MiB/100 on 120x32 and +1.17 MiB/100 on 80x24;
    every case returned live renderables, lifecycle passes and key layers to baseline. Negative
    endpoints mean warm-up memory was collected, not that closing a surface "saved" that amount.
11. `SafetyPresetPicker` enters through its own lazy `retain-one` portal and reuses `ListPicker` plus
    the shared preset-application contract. On 2026-08-25 its focused production-policy soak passed
    100 cycles at both dimensions: +1.56 MiB PSS/100 at 120x32 and +1.28 MiB PSS/100 at 80x24, with
    zero renderable, lifecycle-pass, live-key-layer and cumulative-registration deltas. The rebuilt
    artifact produced a 0.52 MB entry with 90 lazy chunks; clean-home smoke reached the parser-free
    shell at 295 ms, the usable app at 647 ms and observed input at 731 ms with
    `deferred_catalog=true`.

The final 120x32 native-render matrix used ten warm-up cycles and 100 measured cycles per fresh
process. These are endpoint PSS changes after forced collection, not amounts of memory "saved" when
negative:

| Case | PSS MiB/100 | Cumulative registrations during measured cycles |
| --- | ---: | ---: |
| no-overlay control | +0.27 | 0 |
| `FloatFrame`, 30 rows | -1.16 | 0 |
| autocomplete remount / retained | +4.41 / +0.60 | 0 / 0 |
| former Context Help remount / retained | +3.27 / -2.04 | 100 / 0 |
| former Context Help retained with reprojected actions | -2.11 | 0 |
| Profile Picker remount / retained | +11.42 / -1.65 | 100 / 0 |
| retained Safety Preset Picker | +1.56 | 0 |
| Catalog Picker remount / retained | +8.01 / -1.53 | 200 / 0 |
| 64-agent drawer remount / retained | +25.13 / -1.46 | 0 / 0 |
| retained Activity Detail, 200 Markdown sections | -28.55 | 0 |
| retained worktree prompt | -4.12 | 0 |
| empty Workflows page remount / retained | +2.81 / +1.17 | 200 / 0 |
| elicitation / Splash / HintToast | +1.79 / +1.36 / -0.18 | 100 / 0 / 0 |

The remount rows remain attribution controls and intentionally expose the behavior the production
policy avoids. Every retained comparator had zero additional layer registrations after warm-up;
focused renderer tests separately require constant renderable/lifecycle ownership after first use.

The runner now records live renderables, renderer lifecycle passes, live key layers, cumulative layer
registrations and whether native frame composition was enabled. `OTUI_NO_NATIVE_RENDER=true` did not
reduce the noisy 40-cycle remount projections, so those samples do not justify assigning the residue
to native composition. Compact-terminal coverage, the parent RSS/time watchdog, production-policy
threshold and current production consumer set are implemented. Exact timeline counts and real-model
multi-run process-tree sampling remain future measurement work. The implemented correction closes
the demonstrated Profile Picker, Catalog Picker, drawer and Plan/autocomplete slopes. The former
Context Help slope is historical because that production surface no longer exists. This does not
make the non-overlay candidate values in section 8.3 release gates.

#### Phase 0 — build an attribution harness before changing lifecycle code

Add a package-owned soak runner that executes each case in a fresh process against the production
bundle and a real OpenTUI renderer. Each case must:

1. run at 120x32 and at one compact supported size;
2. warm up, force `Bun.gc(true)`, record RSS/PSS/private-dirty plus JS heap/external/array-buffer
   counters, then sample post-GC floors after fixed cycle batches;
3. record live renderable-node, keymap-command/layer and timeline counts before opening and after
   closing;
4. have both a no-op render/capture control and a state/input mutation control with no overlay;
5. run under a parent-process RSS/time watchdog so event-loop starvation cannot hide growth; and
6. fail with the cycle number, screen capture, runtime versions and raw samples needed to reproduce
   the slope.

Run every row below independently so one surface cannot inherit another's retained memory:

| Family | Required cases |
| --- | --- |
| controls | no overlay; draft mutation with Splash held either mounted or unmounted; empty `HintToast` lifecycle |
| `FloatFrame` primitive | empty fixed-size frame; frame with fixed row counts of 1, 10 and 30 |
| `ProfilePicker` | primary agent list; default-scope second step; empty and maximum practical lists |
| `SafetyPresetPicker` | six-row retained picker; direct-host armed-confirmation path |
| `CatalogPicker` | compact enum; filtered provider/model catalog; empty/manual row; maximum visible window |
| `ActivityDetail` | short plain text; long Markdown with code blocks and lists |
| `WorktreeExitPrompt` | cancel path, using an isolated disposable clean-worktree fixture |
| autocomplete | slash and workspace-file triggers; zero, one and ten visible rows; fixed non-empty draft so Splash does not churn |
| full-region pages | full Help; empty and populated Diff; empty, active and history-heavy Plan; root and nested Settings views |
| shell overlays | activity drawer; Splash visibility; terminal-floor resize transition; editor expansion control |

The harness becomes the regression gate; one-off `ps` snapshots remain diagnostic evidence only.

#### Phase 1 — decide the shared OpenTUI remediation

Re-run the complete matrix against the newest compatible OpenTUI release before writing a local
workaround. If the post-GC slopes are flat, upgrade `@opentui/core`, `@opentui/keymap` and
`@opentui/solid` together at exact versions, refresh the lockfile and run the artifact, renderer and
smoke contracts. If the primitive still leaks, reduce it to an upstream reproduction and keep the
Clarvis workaround in owned source; do not patch `node_modules`.

When an upstream fix is unavailable, introduce one application-lifetime floating host. Keep its
scrim, card chrome and bounded row-slot pool mounted, switch data and visibility in place, and prove
that hiding, changing overlay kind and closing restore node/key/timeline counts. Merely retaining the
outer card is insufficient if variable children are still destroyed on every cycle.

#### Phase 2 — remove amplifiers and migrate every floating consumer

1. The former Context Help was windowed by visible rows before the product surface was retired; it
   is no longer a production consumer or required soak case.
2. Move both `ProfilePicker` stages, `SafetyPresetPicker`, and every `CatalogPicker` caller onto the
   persistent host. Keep a fixed number of row slots and update their cells/previews rather than
   recreating native rows.
3. Give `ActivityDetail` a bounded Markdown projection or a full-page reader if Markdown blocks
   cannot be safely pooled. Test small and large content separately.
4. Route `WorktreeExitPrompt` through the same host despite its low frequency so the primitive has no
   exceptional mount path.
5. Keep `HintToast` mounted for the application lifetime and toggle/update its one row in place, so
   full-app measurements do not add a sibling lifecycle to every overlay cycle.

#### Phase 3 — fix non-`FloatFrame` candidates from evidence

- Keep one autocomplete container and a fixed pool of at most ten result/header slots mounted in
  `InputDock`; hide and rewrite them when completion closes. Pin a control that holds Splash out of
  the tree. This work is required if the forced-GC matrix confirms a slope; the current immediate
  PTY result is not enough by itself.
- Measure `PageFrame` and configuration `ViewFrame` separately. If flat, add the soak regression and
  do not complicate their ownership. If they retain native memory, keep one full-region frame rooted
  and swap bounded content; window Help/Plan history and bound large Diff/Markdown projections.
- Preserve the existing configuration stack rule: inactive parents remain mounted, a popped frame
  disposes once, and closing the root disposes the complete stack. Add exact mount/factory/dispose
  counter assertions around async updates.
- Apply the same evidence rule to the activity drawer and Splash. Prefer `visible`/in-place updates
  for any confirmed repeated-mount residue; leave one-shot FatalBoot and rare terminal-floor paths
  simple unless their dedicated case fails.

#### Phase 4 — acceptance, rollout and ordering

Implement in reviewable slices: (1) harness and counters, (2) OpenTUI upgrade decision, (3) shared
floating host, (4) bounded floating consumers, (5) profile/catalog/activity/worktree migration,
(6) autocomplete, and (7) only the full-region/drawer fixes that their independent cases justify.
After every slice, run the affected integration render tests and the full soak matrix in addition to
the normal `@clarvis/code` build, typecheck, lint, test, artifact and smoke checks.

The implemented gate in section 8.3 requires that no **production-policy** case grow more than 5 MiB
per 100 post-GC cycles, its regression slope must not remain
monotonically positive across successive batches, and node/keymap/timeline counts must return
exactly to baseline. Deliberate remount comparators may exceed the memory candidate only to preserve
attribution and must have a paired production case. The final manual gate is a bundled 120x32 PTY
pass through every reachable surface, followed by a multi-run process-
tree soak. The work is complete only when every confirmed slope is flat or an explicitly accepted
upstream residual is documented with a lower operational bound and watchdog coverage.

### 8.5 Reusable surface-lifecycle implementation plan

**Implemented on 2026-08-24.** The numbered decisions below are retained as the implementation
record. The product does not depend on an upstream patch: Clarvis closes the deterministic OpenTUI
Portal-removal residue with a bounded retained-host policy. A reduced upstream report remains useful,
but no `node_modules` patch is part of this correction.

The component-specific `*Mounted` latches introduced while attributing the overlay soaks are an
intermediate correction, not the target architecture. They mix four independent policies at each
call site: when code is imported, when native renderables are first constructed, whether they are
disposed or retained after close, and how their non-visual behavior is deactivated. OpenTUI's
`visible=false` removes a subtree from Yoga layout and native painting but does not destroy it or
automatically suspend descendant focus, key layers, timers, timelines or asynchronous work.

The implementation therefore proceeds through one code-owned `SurfaceLifecycle` capability rather
than another family of component-local booleans:

1. **Introduce the lifecycle contract.** A `SurfaceBoundary` owns lazy first mount and one explicit
   retention policy: `dispose-on-close` or `retain-one`. It provides `mounted`, `active` and a
   monotonically increasing `activation` accessor through Solid context. A retained boundary hides
   one bounded subtree after deactivation; a disposable non-portal boundary preserves Solid's
   ordinary owner disposal. Portal placement statically requires `retain-one`; retention is never an
   implicit call-site default.
2. **Make components participate.** Shared hooks register activation/deactivation work, keep key
   layers registered behind their active predicate, release descendant focus on deactivation and
   invalidate stale asynchronous completions. A visual wrapper alone is not accepted as lifecycle
   ownership.
3. **Centralize floating ownership.** Each floating `SurfaceBoundary` owns one stable root `Portal`,
   outside clipped page regions, and retains exactly one bounded descendant tree after first use.
   The host becomes invisible while inactive so it cannot intercept mouse input. This constraint is
   load-bearing: changing host visibility, size or z-order during conditional recursive removal
   leaves orphaned lifecycle-pass nodes in OpenTUI 0.5.7. `FloatFrame` plays its timeline on
   activation and pauses it on deactivation. Putting `Portal` inside
   `FloatFrame` is a tested regression because Portal cleanup then escapes the local remount owner.
4. **Keep allocation bounds separate.** A stable-slot/window projection owns list virtualization.
   `overflow="hidden"` and ScrollBox viewport culling remain paint/layout controls and must not be
   described as allocation bounds. Retained surfaces declare a finite native-row/renderable budget.
5. **Migrate by measured policy.** Autocomplete, every root-Portal float, Profile Picker, Catalog
   Picker, Plan, Diff and the narrow activity drawer use `retain-one`; bounded floats gate inactive
   keys and Activity Detail clears its document payload on close. Configuration parents retain only
   while present in their existing stack and dispose on pop. Elicitation, Splash, HintToast and
   other non-Portal conditional surfaces keep measured disposal semantics.
6. **Separate first-load deferral.** The lifecycle boundary delays native construction but a static
   import still enters the startup module graph. Cold full-page routes gain an optional dynamic
   `load()` boundary only after their retained/disposable behavior is correct; artifact tests must
   prove the resulting chunks stay outside the startup entry.
7. **Measure ownership and native residue independently.** The soak records renderables, key layers,
   renderer lifecycle passes and activation/deactivation balance beside RSS/PSS/private dirty. An
   `OTUI_NO_NATIVE_RENDER=true` control distinguishes native frame/composition pressure from the
   remaining Yoga/TextBuffer/allocator path. Post-GC PSS is called a native residue until a native
   ownership metric or allocator control proves unreachable memory.
8. **Escalate a remaining residual upstream.** The package-owned primitive cases compare normal
   rendering with the no-native-render control after reconciler microtasks settle. Clarvis does not
   patch `node_modules`; an upstream issue is required only when the minimal case retains a
   repeatable monotonic slope after the application-owned portal and lifecycle counters balance.

Implementation evidence: `packages/code/src/ui/patterns/surface-lifecycle.tsx` owns the capability;
`SurfaceBoundary` call sites replace the old mount latches; `CatalogPicker` owns the latest live spec
without a proxy component; retained list surfaces have finite windows; inactive layers use OpenTUI
reactive matchers; retained polling/countdowns pause; and the surface, picker, overlay-region,
workflow and artifact tests pin those seams. Immediate peak and idle floor remain acceptance inputs:
a retained tree that flattens the latter while materially worsening the former is not a successful
remediation.

### 8.6 External implementation basis

The reusable lifecycle and GC decisions were checked against upstream documentation and source on
2026-08-24:

- [OpenTUI renderer lifecycle](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/renderer.mdx)
  assigns renderer destruction to its creator; Clarvis keeps that ownership in the single `runApp`
  root and does not create a second application renderer.
- [OpenTUI renderer source](https://github.com/anomalyco/opentui/blob/main/packages/core/src/renderer.ts)
  exposes lifecycle-pass ownership used by the deterministic overlay regression counters. Clarvis's
  retained Portal rule is a repository measurement-driven workaround, not an upstream guarantee.
- [Bun benchmarking guidance](https://bun.sh/docs/project/benchmarking) distinguishes explicit
  synchronous and asynchronous GC. Clarvis uses the synchronous form only inside explicit recovery
  while `physicalWorkActive()` is false; it never enables periodic production GC or `--smol` as a
  leak workaround.

The syntax-surface handoff was checked again against the upstream OpenTUI documentation and source
through a version-aware documentation index on 2026-08-25:

- [Markdown](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/components/markdown.mdx)
  defines `streaming` for incremental content and `internalBlockMode="top-level"` for incremental
  block commits; Clarvis retains those modes instead of replacing OpenTUI's parser.
- [Rendering diagnostics](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/test-and-debug/rendering-diagnostics.mdx)
  states that `frame` fires only after a pass reaches the rendered state, while `idle()` covers
  scheduler idleness. `waitForSyntaxFrame` therefore requests and observes real rendered frames but
  separately awaits the installed `CodeRenderable.highlightingDone` contract.
- [Renderer source](https://github.com/anomalyco/opentui/blob/main/packages/core/src/renderer.ts)
  shows that `requestRender()` schedules through the renderer rather than through a userland
  microtask. The handoff uses that API and does not add an arbitrary delay or a second render loop.
