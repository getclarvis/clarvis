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

1. **Module load is not first paint, and full hydration is not the start of interaction.** The
   benchmark times `--version`, the minimal shell, the focused startup composer, the branded header
   and the complete input marker independently (`packages/code/tooling/benchmarks/first-paint.ts`,
   `timeFirstPaint`, `measure`).
2. **RSS is not JavaScript heap.** The sampler records `rss`, `heapUsed`, `external` and
   `arrayBuffers`, while only RSS drives the fuse
   (`packages/code/src/adapters/memory-pressure.ts`). Native renderer
   allocations and memory-mapped runtime pages therefore remain visible even when the JS heap is
   small.
3. **A bound on one collection is not a process budget.** Transcript prose, hydrated tool bodies,
   session reconstruction, provider responses, MCP responses, traces and renderer objects have
   independent ceilings. Their temporary copies and native overhead can coexist.

## 2. Surface

### 2.1 Measurement commands and controls

| Surface | Contract | Source |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| OpenTUI dependency set | `@opentui/core`, `@opentui/keymap` and `@opentui/solid` are pinned together at 0.5.9 | `packages/code/package.json` (`dependencies`) |
| `bun run bench:code` | runs the package first-paint benchmark | `package.json`, `packages/code/package.json` |
| `bun run bench:code-overlays` | runs isolated post-GC renderer lifecycle cases; optional case names select a subset | `package.json` (`bench:code-overlays`), `packages/code/package.json` (`bench:overlays`) |
| `OVERLAY_SOAK_CYCLES`, `OVERLAY_SOAK_BATCH`, `OVERLAY_SOAK_WARMUP` | control measured cycles, sample cadence and discarded warm-up; defaults 100, 20 and 10 | `packages/code/tooling/benchmarks/overlays.tsx` (`cycles`, `batchSize`, `warmupCycles`) |
| per-case warm-up | a finite high-cardinality case may raise, never lower, the discarded global warm-up; the effective count is recorded in its result | `packages/code/tooling/benchmarks/overlays.tsx` (`SoakCase.warmupCycles`, `subjectWarmupCycles`) |
| `OVERLAY_SOAK_SIZES` | comma-separated matrix; defaults to reference 120x32 plus compact 80x24 | `packages/code/tooling/benchmarks/overlays.tsx` (`matrixSizes`) |
| `OVERLAY_SOAK_WIDTH`, `OVERLAY_SOAK_HEIGHT` | child-process dimensions supplied by the matrix runner | `packages/code/tooling/benchmarks/overlays.tsx` (`width`, `height`) |
| `OVERLAY_SOAK_MAX_MIB_PER_100` | production-policy PSS growth ceiling, or RSS off Linux; default 5 MiB/100 | `packages/code/tooling/benchmarks/overlays.tsx` (`PRODUCTION_CASES`, `maxMiBPer100`) |
| `OVERLAY_SOAK_WATCHDOG_MS`, `OVERLAY_SOAK_WATCHDOG_RSS_MB` | parent-process time and RSS limits; defaults 120 seconds and 1 GiB per case | `packages/code/tooling/benchmarks/overlays.tsx` (`watchdogMs`, `watchdogRssBytes`) |
| `OTUI_NO_NATIVE_RENDER=true` | runs the same soak with OpenTUI native frame composition disabled; the result is a control, not a heap/native-ownership classifier by itself | `packages/code/tooling/benchmarks/overlays.tsx` (`CaseResult.runtime.nativeRender`), `@opentui/core` (`OTUI_NO_NATIVE_RENDER`) |
| `BENCH_N` | measured repetitions after one discarded warm-up; default 7 | `packages/code/tooling/benchmarks/first-paint.ts` |
| `BENCH_POLL_MS` | PTY polling interval; default 25 ms | `packages/code/tooling/benchmarks/first-paint.ts` |
| `BENCH_TIMEOUT_MS` | deadline for one boot; default 90 seconds | `packages/code/tooling/benchmarks/first-paint.ts` |
| `BENCH_MAX_LOAD` | maximum one-minute load per core; default `0.35` | `packages/code/tooling/benchmarks/first-paint.ts` |
| `--arm=source | bundle | bin` | selects source, direct artifact or launcher arm | `packages/code/tooling/benchmarks/first-paint.ts` |
| `--json` | emits the environment and raw summary as JSON | `packages/code/tooling/benchmarks/first-paint.ts` |
| `--force` | permits an otherwise refused run and marks it untrusted | `packages/code/tooling/benchmarks/first-paint.ts` |
| `--require-ac` | optionally requires mains power | `packages/code/tooling/benchmarks/first-paint.ts` |
| `--debug[=level]` | writes bounded redacted lifecycle and memory diagnostics | `packages/code/src/cli-args.ts`, `packages/code/src/adapters/diagnostic-session.ts` |

The benchmark owns four visible markers: `Clarvis · code · starting` for the minimal shell,
`Queue a task…` for the focused startup composer, `◆ Clarvis` for complete header paint and
`New task…` for the complete input dock
(`packages/code/tooling/artifact/markers.ts`, `BOOT_SHELL_MARKER`, `APP_PAINT_MARKER`,
`STARTUP_READY_MARKER`, `APP_READY_MARKER`; `packages/code/tooling/benchmarks/first-paint.ts`, imported
marker aliases). The startup frame excludes both complete-app markers, and the complete application
excludes the startup-readiness marker. Each timestamp therefore belongs to one stage; a focused
composer cannot satisfy full hydration and a decorative shell cannot satisfy functional input.
The startup composer reuses the fixed `BrandBanner`: the eight-row banner paints at 60×16 or larger,
and its compact wordmark paints below either edge, without adding parser, catalog or runtime data.
Production: `packages/code/src/views/StartupComposer.tsx` (`StartupComposer`). Test:
`packages/code/tests/integration/splash-render.test.tsx` (marker exclusion).

### 2.2 Runtime memory controls

| Surface | Current value or behavior | Source |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CLARVIS_TUI_RSS_LIMIT_MB` | limit in MiB; `0` disables the interactive fuse | `packages/code/src/views/App.tsx` (`process.env.CLARVIS_TUI_RSS_LIMIT_MB`), `packages/code/src/adapters/memory-pressure.ts` (`tuiRssLimitBytes`) |
| default RSS limit | 2 GiB | `packages/code/src/adapters/memory-pressure.ts` (`DEFAULT_TUI_RSS_LIMIT_BYTES`) |
| positive custom-limit floor | 512 MiB | `packages/code/src/adapters/memory-pressure.ts` (`MIN_TUI_RSS_LIMIT_BYTES`, `tuiRssLimitBytes`) |
| sampling interval | 500 ms | `packages/code/src/adapters/memory-pressure.ts` |
| warning threshold | 80% of the configured limit, sustained for three samples before local maintenance | `packages/code/src/adapters/memory-pressure.ts` |
| recovery threshold | three samples below 70% with no pending local maintenance | `packages/code/src/adapters/memory-pressure.ts` |
| maintenance step | 10 seconds for one in-flight local `maintain` callback | `packages/code/src/adapters/memory-pressure.ts` (`MEMORY_PRESSURE_STEP_TIMEOUT_MS`) |
| critical episode | 30 seconds before a blocking episode fails closed | `packages/code/src/adapters/memory-pressure.ts` (`MEMORY_PRESSURE_EPISODE_TIMEOUT_MS`) |
| recovery GC | at most one synchronous `Bun.gc(true)` per episode, only when TUI-owned work (local shell, rehydration, physical handles) is idle; otherwise skip | `packages/code/src/views/App.tsx` (`createMemoryPressureController`), `packages/code/src/adapters/memory-pressure.ts` (`collectOnce`) |
| efficiency advisory | 512 MiB absolute RSS, 256 MiB growth from baseline and 64 MiB rise over 20 samples; records evidence but does not maintain, block or collect | `packages/code/src/adapters/memory-pressure.ts` (`MEMORY_EFFICIENCY_*`, `publish`) |

The fuse samples only the TUI process. It does not account for external MCP servers, shell children
or other process trees (`packages/code/README.md`).

### 2.3 Resident collection ceilings

| Collection | Current ceiling | Source |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| one mutable transcript prose node | 2 Mi characters | `packages/code/src/adapters/store.ts` |
| aggregate mutable transcript prose | 64 MiB estimated UTF-16 | `packages/code/src/adapters/store.ts` |
| one sealed record's mounted prose | 512 Ki characters | `packages/code/src/core/transcript/records.ts` (`snapshotTranscriptNode`), `packages/code/src/core/transcript/presenters.ts` (`TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS`) |
| one immutable publication tool field | 64 Ki characters; arguments additionally use a 40 Ki character/value and 512-node projection | `packages/code/src/core/transcript/tool-display.ts` (`TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS`, `projectTranscriptToolDisplay`) |
| hydrated tool bodies | 200 nodes and 64 MiB estimated | `packages/code/src/adapters/store.ts` |
| pressure release of reconstructible tools | drop completed persisted bodies only; local/`!` results and in-flight tools keep their only copy | `packages/code/src/adapters/store.ts` (`releaseReconstructible`) |
| one hydrated tool body | 32 MiB estimated | `packages/code/src/adapters/store.ts` |
| hidden child live tails | 96 events and 128 KiB per child, 1 MiB aggregate; events above 16 KiB are omitted from the tail | `packages/code/src/adapters/child-transcript-store.ts` (`remember`) |
| detailed child transcript stores | one selected child; none retained after leaving that projection | `packages/code/src/adapters/child-transcript-store.ts` (`selectSubagent`) |
| visual transcript turns | 20 semantic turns | `packages/code/src/run-host.ts` |
| session resume chain | 10,000 messages and 16,000,000 payload characters | `SESSION_RESUME_MAX_MESSAGES`, `SESSION_RESUME_MAX_PAYLOAD_CHARS`, and `resumeSession` in `packages/code/src/adapters/session.ts` |
| complete session documents in the client cache | 8, excluding live write lanes from demotion | `MAX_RESIDENT_FULL_SESSIONS` and `demoteOldFullSessions` in `packages/code/src/adapters/session-store.ts` |
| provider HTTP response | 32 MiB | `packages/llm/src/ai-sdk/bounded-fetch.ts` |
| MCP HTTP or stdio frame | 16 MiB | `packages/mcp-client/src/bounded-fetch.ts`, `packages/mcp-client/src/bun-stdio-client.ts` |

These figures are independent safeguards, not permission for all maxima to be resident
simultaneously. Debug mode samples an aggregate application ledger every ten seconds and at state
changes, but it remains evidence rather than an allocator or a second hard budget.

## 3. Data and formats

### 3.1 Benchmark result

Each arm reports five `Stats` records — module-graph `version`, minimal `shell`, focused
`startupReady`, complete-header `paint`, and complete-app `ready` — with `n`, minimum, median and
maximum
(`packages/code/tooling/benchmarks/first-paint.ts`, `ArmResult`, `measure`). The
report also records Bun version, cwd, poll interval, power state, CPU governor/profile, observed CPU
frequency and load per core (`packages/code/tooling/benchmarks/first-paint.ts`, `Environment`,
`report`).

A number is comparable only when the relevant environment fields and workload match. The runner
refuses excessive load and marks a batch untrusted when load drifts materially during the run
(`packages/code/tooling/benchmarks/first-paint.ts`). A one-sample result, a measurement taken from
another cwd, or a direct `dist/index.js --version` comparison against the launcher's fast-path
`--version` does not support a startup conclusion.

The artifact smoke's outer elapsed duration is not a sixth startup marker. It includes the PTY's
100 ms polling cadence and waits for the complete-app marker plus validated
`app.boot.painted`, Markdown-preload and update-skip diagnostics, and a complete catalogue-absence
observation. Its success line therefore labels that value as
artifact-and-diagnostic settlement and reports the process-relative startup-shell and complete-app
paint diagnostics separately. Only the repeated benchmark above supports a performance comparison
(`packages/code/tooling/artifact/smoke.ts`, `main`).

### 3.2 Diagnostic records

Interactive `--debug` writes versioned, redacted JSONL. Performance-relevant events include:

| Event | Relevant details | Source |
| --------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `app.boot.begin` | mode and workspace | `packages/code/src/runtime.tsx` (`runApp`, `runHeadlessMode`) |
| `async.started` / `async.settled` | operation, duration, outcome and sampled count | `packages/code/src/core/diagnostic-events.ts` |
| `markdown.preload.completed | failed` | parser preload outcome | `packages/code/src/runtime.tsx` (`preloadMarkdown`) |
| `app.boot.shell-painted` | process uptime captured after the focused startup root reaches renderer idle | `packages/code/src/index.tsx` (`runInteractive`), emitted by `packages/code/src/runtime.tsx` (`runApp`) |
| `app.render.mounted` | mode | `packages/code/src/runtime.tsx` (`runApp`) |
| `app.boot.painted` | process uptime, mode and whether the catalog signal is still empty | `packages/code/src/runtime.tsx` (`runApp`) |
| `catalog.load.started` | the catalog-dependent surface that crossed the lazy boundary | `packages/code/src/runtime.tsx` (`ensureModelsCatalog`) |
| `memory.sample` | phase, RSS, heap, external, array buffers and limit | `packages/code/src/adapters/memory-pressure.ts` |
| `memory.phase` | previous phase, next phase, RSS and limit | `packages/code/src/adapters/memory-pressure.ts` |
| `memory.efficiency` | advisory transition, RSS, baseline and recent slope | `packages/code/src/adapters/memory-pressure.ts` (`publish`) |
| `memory.ledger` | bounded transcript/session/renderer/run/event-queue counters, including frame listeners; debug only | `packages/code/src/views/App.tsx` (`ledger`), `packages/code/src/adapters/memory-pressure.ts` (`publish`) |
| `memory.gc.completed | failed | skipped` | recovery collection outcome and whether physical work prevented it | `packages/code/src/adapters/memory-pressure.ts` (`collectOnce`) |

Repeated diagnostic counters are sampled rather than written on every occurrence, so the debug log
cannot itself become an unbounded amplifier (`packages/code/src/adapters/diagnostic-session.ts`).

### 3.3 Runtime evidence

Runtime soak results are evidence, not persisted application data and not timeless requirements.
They are recorded under the matching headings in [`../known-issues.md`](../known-issues.md). A new measurement must
retain its runtime version, terminal dimensions, cycle count, sampling point and whether an explicit
GC occurred; otherwise it must not be compared to a post-GC floor.

## 4. Behavior

### 4.1 Startup critical path

The launcher answers `--help` and `--version` before importing the application graph, then imports
the built artifact for every other mode (`packages/code/src/cli.ts`, `main`). Interactive boot then:

1. validates the terminal, creates the renderer and mounts a focused `StartupComposer` with the
   shared responsive Clarvis banner from the lightweight entry;
2. after renderer idle, starts the complete runtime import and, for an ordinary run without debug or
   worktree bootstrap, prepares the workspace kernel concurrently;
3. opens diagnostics in the runtime, uses or creates the pinned `WorkspaceClientManager`, and loads
   the foundation without calling models.dev or subscription entitlement;
4. constructs stores, the run host and command routing while the startup input remains usable;
5. takes the startup snapshot once and submits an accepted task before mounting `<App>` only when
   the active Agent Profile is runnable; otherwise the exact accepted submission or unsent draft becomes
   `App.initialDraft`;
6. mounts the complete application, emits `app.boot.painted`, releases after-paint work and only then
   starts Markdown parser warm-up and the optional managed-install release check; restored session
   content awaits the warm-up, while the release check is never awaited by boot or a run.

Production: `packages/code/src/index.tsx` (`runInteractive`),
`packages/code/src/startup-foundation.ts` (`prepareStartupFoundation`),
`packages/code/src/runtime.tsx` (`runApp`), and
`packages/code/src/views/StartupComposer.tsx` (`createStartupComposerState`).

The models.dev snapshot remains a required distributable asset because Providers, Model and Effort
need the offline catalog. First boot does not read or project it. `ensureModelsCatalog` is a
single-flight loader invoked only when one of those catalog-dependent routes is requested. Provider
routes await it concurrently with the dynamic module import before mounting because their first-run
picker opens synchronously; Model and Effort may mount against the reactive facade. The artifact
smoke rejects any first paint that emits `catalog.load.started` or reports
`deferred_catalog !== true` (`packages/code/src/runtime.tsx`, `ensureModelsCatalog`;
`packages/code/src/features/providers/commands.ts`; `packages/code/src/app/commands.tsx`,
`setup.providers`; `packages/code/tooling/artifact/smoke.ts`).


### 4.2 Subscription readiness on startup

App command construction performs no entitlement request. A locally configured subscription whose
runtime readiness has not been inspected is a passing deferred state, with detail `subscription
check deferred`; ordinary boot seeding and local settings writes only invalidate the local gate
revision. Doctor's explicit recheck and catalog-dependent provider/model actions perform the remote
inspection (`packages/code/src/app/commands.tsx`, `recheck`, `inspectReadiness`;
`packages/code/src/onboarding/doctor.ts`, the `credentials` gate in `GATES`). Escaping a nested configuration page
does not start that inspection (`packages/code/src/views/overlay-host.ts`, `popView`). Tests pin
the cold route and the explicit recheck boundary in
`packages/code/tests/integration/app-commands.test.tsx`, and the Escape boundary in
`packages/code/tests/integration/app-shell-render.test.tsx`.



### 4.3 Artifact loading and lazy boundaries

The distributable build enables splitting, keeps OpenTUI package-owned, keeps provider adapters
behind generated dynamic chunks, and moves development source maps away from runtime JavaScript
(`packages/code/tooling/artifact/build.ts`). These choices reduced the recorded idle Linux
baseline from roughly 237 MB to 171 MB (`packages/code/README.md`).

The installed build goes further: `build:install` emits no source maps before the package is linked.
This keeps offline diagnostic maps in developer/root builds without distributing them through the
installed command (`packages/code/tooling/artifact/build.ts` (`installBuild`, `main`),
`packages/code/tooling/setup.ts` (build phase)).

`src/index.tsx` statically imports only renderer/startup-shell concerns, including the fixed shared
banner reached through `StartupComposer`. It dynamically imports
`runtime.tsx`, while `startup-foundation.ts` may construct the same workspace manager concurrently
through the exact dynamic `@clarvis/kernel/bootstrap` boundary in
`adapters/workspace-client-manager.ts`. The build groups Code-owned cold surfaces behind
`views/cold-surfaces.ts` so dozens of route imports do not inflate linker fan-out; each route still
mounts through its lazy owner. Cold full-page routes do not enter the startup entry: `lazyView` combines
Solid `lazy` and `Suspense`, caches each module promise, and lets the route owner dispose the mounted
subtree. Settings and Extensions list metadata lives in a lightweight module so rendering their
menus does not import every child (`packages/code/src/views/config/lazy-view.tsx`,
`packages/code/src/views/config/hub-items.ts`, `packages/code/src/app/commands.tsx`). The artifact
contract scans representative markers from Help, Storage, Sessions, Workflows and Doctor, as
well as Diff and Plan (`packages/code/tooling/artifact/contract.ts`).

### 4.4 Transcript and session retention

The execution store retains bounded mutable facts and sealed inline snapshots independently of
native residence. Tool payload hydration and mounted text limits remain separate budgets. Folding
beyond 20 retained turns removes discarded records and their sealed snapshots, leaving one stable
folded-prefix notice; it does not retain rendering batches or staging timers.

One `TranscriptViewport` mounts the selected Lead or child projection. Sessions through 80 rows
mount that bounded set; longer projections use 40 rows and pages of 20, with an 80-row transition
ceiling. An expanded exploration mounts at most 20 members at a time, independently of the number
of calls ingested. Active off-window tools remain data, not native owners. Rows are direct native
ScrollBox children, retaining culling and a stable scrollbar gutter. No spacer-height cache, hidden
measurement tree, or second live tree exists.

Reading state is a semantic row and viewport-relative offset, retained for the current projection
and at most 63 inactive projections. Post-layout transactions validate their projection and token,
retry missing geometry at most three frames, and preserve native sticky follow only for tail intent.
Selection delays eviction within the 80-row ceiling; an explicit notice reports a blocked reveal.
Production: `TranscriptWindow` in
[window.ts](../../packages/code/src/core/transcript/window.ts), `TranscriptViewport` in
[TranscriptViewport.tsx](../../packages/code/src/views/transcript/TranscriptViewport.tsx), and
`TranscriptContent` in [transcript-content.ts](../../packages/code/src/adapters/transcript-content.ts).
Test: [transcript-window-render.test.tsx](../../packages/code/tests/integration/transcript-window-render.test.tsx),
[transcript-rows-render.test.tsx](../../packages/code/tests/integration/transcript-rows-render.test.tsx),
and [transcript-content.test.ts](../../packages/code/tests/unit/transcript-content.test.ts).

The deterministic benchmark uses 120 rows, 500 exploration members and 90 streaming frames at
120x32, with warm-up and three samples in
[transcript-budget-render.test.tsx](../../packages/code/tests/integration/transcript-budget-render.test.tsx).
A p95 of 33 ms and no comparable stabilized-RSS or interaction regression above 10% are engineering
targets, not results implied by passing assertions. Artifact, environment, dimensions, owner counts
and sampled frames must accompany measurements.

With `CLARVIS_TRANSCRIPT_MEASURE=1`, the fixture spaces streaming updates at 30 FPS and collects
before each sample. This fixture does not establish real-provider latency or a stabilized RSS verdict.
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
churn (`packages/code/src/views/overlays/ListPicker.tsx`, `maxVisibleRows`, `win`). `/help` lazily
mounts the full-page `Help` view (`packages/code/src/app/commands.tsx`, `help.open`;
`packages/code/src/views/overlays/Help.tsx`, `Help`).

The existing render tests prove layout and cleanup-visible behavior, not post-GC native RSS. The
controlled renderer soak in [`../known-issues.md`](../known-issues.md#every-floatframe-overlay-leaks-native-memory-per-rendered-row)
is the authority for the leak rate.

The high-cardinality retained Catalog Picker discards 220 finite traversal cycles before its
100-cycle measurement. The remounted elicitation control discards 400 because each distinct request
creates and disposes one legitimate key layer and OpenTUI/native allocator arenas continue warming
after the global ten-cycle default. These are per-case warm-ups, not weaker gates: both still run in
fresh processes at 120x32 and 80x24, keep the 5 MiB RSS/PSS-per-100 ceiling, and require renderable,
lifecycle-pass and live-key-layer balance. Production and test ownership:
`packages/code/tooling/benchmarks/overlays.tsx` (`SoakCase.warmupCycles`,
`catalog-picker-retained-100-rows`, `elicit-guard-confirm`, `runParent`).

The floating family includes these surfaces:

| Surface | Mount path | Variable allocation risk |
| --- | --- | --- |
| agent picker and default-scope picker | `App` -> retained `AgentProfilePicker` -> `ListPicker` -> `FloatFrame` | windowed agent rows, preview and optional second picker |
| provider/model/enum picker | config view -> retained `CatalogPicker` -> `ListPicker` -> `FloatFrame` | windowed rows, fuzzy-highlight spans, optional input, and a fixed nine-row first-run splash intro only when 76×24 fits |
| activity detail | `App` -> retained `ActivityDetail` -> `FloatFrame` | Markdown block count and parser-native renderables; payload is cleared on close |
| clean-worktree exit prompt | `App` -> retained `WorktreeExitPrompt` -> `FloatFrame` | fixed, small body |

`HintToast` is also conditionally instantiated while any host or transient overlay is open
(`packages/code/src/views/App.tsx`, `packages/code/src/views/Footer.tsx`). A full-app
soak must account for it separately from the card under test, even though an empty hint mounts no
native toast box.

### 4.6 Other overlay-like lifecycles

Not every surface called an overlay uses `FloatFrame`, and the known per-row rate must not be copied
onto these families without measurement:

- `OverlayRegion` keeps the transcript shell and Yoga geometry mounted while switching to any
  full-region configuration, Workflow, `DiffViewer` or `PlanOverlay` surface. The hidden fallback is
  input-inert and pauses physical-history observation. `SurfaceRegion` removes inactive retained
  pages from Yoga layout and painting; configuration parents deliberately stay mounted only while
  their frame remains in the stack (`packages/code/src/views/app/OverlayRegion.tsx`, `OverlayRegion`,
  `packages/code/src/views/overlay-host.ts`, `mountView`, `popView`).
- full Help, Diff and Plan pages use `PageFrame`. Help and the current-plan fallback currently
  construct all projected rows, while a loaded current-plan document and Diff may construct a large
  Markdown or tool renderer (`packages/code/src/views/overlays/Help.tsx`,
  `packages/code/src/views/overlays/PlanOverlay.tsx` (`tasks`, `Prose`),
  `packages/code/src/views/overlays/DiffViewer.tsx`). Plan has no history catalogue to window.
- `AutocompletePopup` is lazily retained by `InputDock`. It windows to at most ten rows and rewrites
  the same fixed-height container, headers, highlighted spans and row slots after the first open;
  scroll mode mounts no overflow-count rows as selection moves
  (`packages/code/src/views/InputDock.tsx`, `SurfaceBoundary`,
  `packages/code/src/ui/patterns/windowed-list.tsx`, `StableWindowedList`,
  `packages/code/src/views/input/AutocompletePopup.tsx`, `MAX_ROWS_CAP`).
- guided Extensions Step 3 projects 196 representative listings into fixed retained slots.
  Its production-policy case first traverses the finite catalog as discarded warm-up, then measures
  another 100 selection changes while requiring stable renderable, lifecycle-pass, live-key-layer
  and key-layer-registration ownership
  (`packages/code/src/views/config/ExtensionsHub.tsx`, `openExtensionPicker`;
  `packages/code/tooling/benchmarks/overlays.tsx`,
  `extensions-setup-retained-196-listings`).
- guided Extensions pending-operation motion has a separate production-policy case. It enters a
  deliberately unresolved plugin install, then measures 100 animated frames while requiring stable
  renderable, lifecycle-pass, live-key-layer, and key-layer-registration ownership
  (`packages/code/src/views/config/ExtensionsHub.tsx`, `operationPending`;
  `packages/code/tooling/benchmarks/overlays.tsx`, `extensions-setup-pending-install`).
- the focused Plugins browser keeps 196 marketplace listings in the same bounded row pool while a
  right/left collection round trip replaces All with Installed, an exact source, Workspace, or Add
  Marketplace. After finite warm-up, 100 round trips must retain identical renderable, lifecycle,
  live-key-layer, and key-registration ownership
  (`packages/code/src/views/config/MarketplaceBrowser.tsx`, `collections`, `changeCollection`, and
  `StableWindowedList` (`packages/code/src/ui/patterns/windowed-list.tsx`); `packages/code/tooling/benchmarks/overlays.tsx`,
  `marketplace-collections-retained-196-listings`).
- the activity panel replaces the transcript column in place — no scrim, no residual strip — while
  editor expansion merely
  changes layout properties on the already-mounted input region. The summary strip is conditional in the
  same sense
  (`packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion`'s
  `summaryVisible`/`activityPanel` owners, `packages/code/src/views/App.tsx`).
- Splash, elicitation, terminal-floor and fatal-boot surfaces are conditional, but they are not
  normal high-frequency modal routes. They still belong in control cases because input churn can
  accidentally remount Splash and make an autocomplete measurement invalid
  (`packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion`'s Splash condition,
  `packages/code/src/views/App.tsx` (terminal-floor `Show`), and
  `packages/code/src/views/FatalBoot.tsx` (`FatalBoot`)).

The implementation plan in section 8.4 therefore begins with independent process-level attribution,
not a blanket assumption that every conditional surface has the upstream `FloatFrame` defect.

### 4.7 RSS fuse and recovery

The memory controller samples every 500 ms. Three consecutive samples at 80% start one silent local
maintenance pass that drops reconstructible completed tool bodies
(`packages/code/src/adapters/store.ts`, `releaseReconstructible`). At the limit it blocks expensive
new admissions without cancelling independent hosted work or restarting the workspace host
(`packages/code/src/adapters/memory-pressure.ts`). One in-flight `maintain` callback is kept even
after its 10-second step timeout; a blocking critical episode fails closed after 30 seconds. At most
one synchronous `Bun.gc(true)` runs per episode, and only when TUI-owned local shell work,
rehydration, and physical run handles are idle. When that work is still settling, recovery records
`memory.gc.skipped` and does not schedule collection for later (`packages/code/src/views/App.tsx`,
`canCollect`; `packages/code/src/adapters/memory-pressure.ts`, `collectOnce`). Rearm requires three
samples below 70% and no pending local maintenance. A later natural RSS drop can also rearm a
measured failure that did not lose integrity.

The default is 2 GiB, so the preventive band begins at 1.6 GiB. Positive overrides are clamped to
512 MiB, while zero still disables the fuse. A separate efficiency advisory can report sustained
growth far below the hard limit, but never maintains, blocks or collects. Debug-only aggregate
ledgers are gated by the active diagnostic logger so ordinary runs do not traverse renderer or host
counters every ten seconds (`packages/code/src/views/App.tsx`, `ledgerEnabled`). Successful
maintenance is silent; the footer shows `Restoring the interface…` only while admission is blocked.

## 5. Invariants

1. **PERF-1: `--help` and `--version` do not import the application graph.**
   Production: `packages/code/src/cli.ts`.
   Test: `packages/code/tests/architecture/cli-fast-path.test.ts`.

2. **PERF-2: the built artifact keeps the AI SDK/provider adapter behind a generated lazy chunk.**
   Production: `packages/code/tooling/artifact/build.ts`.
   Test: `packages/code/tests/architecture/artifact-contract.test.ts`.

3. **PERF-3: developer source maps remain available away from runtime JavaScript; installed source
   maps are omitted.**
   Production: `packages/code/tooling/artifact/build.ts` (`detachSourceMaps`, `installBuild`, `main`).
   Test: `packages/code/tests/architecture/artifact-contract.test.ts` (developer and install map
   cases).

4. **PERF-4: transcript prose is bounded per node and across settled resident nodes.**
   Production: `packages/code/src/adapters/store.ts`.
   Test: `packages/code/tests/unit/streaming-delta.test.ts`.

   Hidden sub-agent detail has a separate bounded event tail and does not enter the Lead node
   collection. Only a selected child may own a detailed store, and leaving it releases that store.
   The diagnostic ledger samples tail bytes, selected-child nodes and hydration counts without
   traversing every child. Production: `packages/code/src/adapters/child-transcript-store.ts`
   (`createChildTranscriptStore`, `memory`). Test:
   `packages/code/tests/unit/child-transcript-store.test.ts` (16 hidden children and terminal release).

5. **PERF-5: settled hydrated tool bodies obey both count and aggregate-byte limits.**
   Production: `packages/code/src/adapters/store.ts`.
   Test: `packages/code/tests/unit/store-hydration.test.ts`.

6. **PERF-6: a persisted non-manager turn releases reconstructible history and can rebuild it
   lazily when provider continuation is unavailable.**
   Production: `packages/code/src/run-host.ts`.
   Test: `packages/code/tests/component/run-host.test.ts`.

7. **PERF-7: a manager releases durably reconstructible resident history while idle, then rebuilds
   and sends the complete chain rather than using `continue_from`.**
   Production: `packages/code/src/run-host.ts` (`fullRequestMessages`, `submitTurn`).
   Test: `packages/code/tests/component/run-host.test.ts` ("manager runs release persisted history
   and rebuild the complete chain for the next turn").

8. **PERF-8: the 2 GiB-default RSS fuse starts silent local maintenance after sustained 80%
   samples, blocks expensive admissions at the limit without exiting or restarting the host, and
   rearms after three safe samples. Positive overrides cannot fall below 512 MiB, and recovery GC
   runs at most once per episode while TUI-owned work is idle.**
   Production: `packages/code/src/adapters/memory-pressure.ts` (`tuiRssLimitBytes`,
   `createMemoryPressureController`), `packages/code/src/adapters/store.ts`
   (`releaseReconstructible`).
   Test: `packages/code/tests/unit/memory-pressure.test.ts` and
   `packages/code/tests/unit/store-hydration.test.ts` (pressure-release cases).

9. **PERF-9: memory sampling uses one unrefed 500 ms timer and a disabled fuse installs no timer.**
   Production: `packages/code/src/adapters/memory-pressure.ts`.
   Test: `packages/code/tests/unit/memory-pressure.test.ts`.

10. **PERF-10: connected subscription readiness is deferred and passing at boot; only an explicit
    Doctor recheck or subscription-dependent surface performs the remote inspection.**
    Production: `packages/code/src/onboarding/doctor.ts` (`GATES`, the `credentials` gate),
    `packages/code/src/app/commands.tsx` (`inspectReadiness`), and
    `packages/code/src/views/overlay-host.ts` (`popView`).
    Test: `packages/code/tests/integration/doctor.test.ts`,
    `packages/code/tests/integration/app-commands.test.tsx` (explicit entitlement recheck), and
    `packages/code/tests/integration/app-shell-render.test.tsx` (nested Escape does not inspect).

11. **PERF-11: repeated full-region visits preserve one bounded transcript shell; Plan, Diff and
    autocomplete reuse bounded renderer ownership after first use, while configuration navigation
    retains its exact frame-disposal boundary.**
    Production: `packages/code/src/views/app/OverlayRegion.tsx` (`OverlayRegion`),
    `packages/code/src/views/InputDock.tsx` (`SurfaceBoundary`), and
    `packages/code/src/ui/patterns/windowed-list.tsx` (`StableWindowedList`) and
    `packages/code/src/views/input/AutocompletePopup.tsx` (`MAX_ROWS_CAP`).
    Test: `packages/code/tests/integration/overlay-region-render.test.tsx`,
    `packages/code/tests/integration/autocomplete-popup-render.test.tsx`, and
    `packages/code/tests/unit/overlay-host.test.ts`.

12. **PERF-12: Diff and Plan stay outside the first-load JavaScript
    entrypoint.**
    Production: `packages/code/src/views/app/OverlayRegion.tsx` (`lazy`),
    `packages/code/tooling/artifact/contract.ts` (`assertLazySurfaceArtifact`), and
    `packages/code/tooling/artifact/build.ts` (`assertLazyProviderChunk`).
    Test: `packages/code/tests/architecture/artifact-contract.test.ts` ("cold full-page and floating
    surfaces remain in lazy chunks").

13. **PERF-13: a surface has one explicit disposal policy, a stable portal owner and balanced
    non-visual ownership.** Non-portal regions may dispose or retain; portal surfaces always retain
    one bounded subtree because changing the Portal host during recursive conditional removal
    orphans lifecycle-pass renderables. Inactive floating components keep disabled key layers and a
    constant lifecycle-pass set rather than registering or allocating again per activation. A
    `FloatFrame` resolves its JSX-valued navigation prop once, so repeated footer probes cannot mount
    duplicate responsive subtrees or renderer resize listeners.
    Production: `packages/code/src/ui/patterns/surface-lifecycle.tsx` (`SurfaceBoundary`,
    `SurfacePortal`, `useSurfaceFocus`, `useSurfaceActivationGuard`),
    `packages/code/src/views/overlays/FloatFrame.tsx` (`FloatFrame`), and
    `packages/code/src/views/overlays/ListPicker.tsx` (`ListPicker`).
    Test: `packages/code/tests/integration/surface-lifecycle-render.test.tsx`,
    `packages/code/tests/integration/float-frame-render.test.tsx` (single responsive navigation
    subtree and listener cleanup), and `packages/code/tests/integration/list-picker-render.test.tsx`
    ("a retained picker keeps one key layer registration and gates it while inactive").

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

15. **PERF-15: first boot does not read the models.dev catalog or call subscription entitlement;
    cold full-page modules load only when their owning routes mount.**
    Production: `packages/code/src/runtime.tsx` (`ensureModelsCatalog`),
    `packages/code/src/views/config/lazy-view.tsx`, and
    `packages/code/src/app/commands.tsx` (dynamic route factories), plus
    Test: `packages/code/tests/integration/app-commands.test.tsx`,
    `packages/code/tests/architecture/artifact-contract.test.ts`, and
    `packages/code/tooling/artifact/smoke.ts`.

16. **PERF-16: the lightweight Solid root paints a focused parser-free composer before the complete
    application, and parser warm-up does not hold either usable input or full paint; aggregate memory
    diagnostics are O(1) at their data sources and disabled when no diagnostic sink exists.**
    Production: `packages/code/src/index.tsx` (`runInteractive`),
    `packages/code/src/runtime.tsx` (`runApp`),
    `packages/code/src/views/StartupComposer.tsx`, `packages/code/src/views/App.tsx` (`ledgerEnabled`), and
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

19. **PERF-19: high-cardinality guided Extensions selection rewrites a bounded retained slot pool
    and does not re-register its key layer after warm-up.** Production:
    `packages/code/src/views/config/ExtensionsHub.tsx` (`openExtensionPicker`, `spec`) and
    `packages/code/src/ui/patterns/windowed-list.tsx` (`StableWindowedList`). Test:
    `packages/code/tooling/benchmarks/overlays.tsx`
    (`extensions-setup-retained-196-listings`, `stableRegistrations`).

20. **PERF-20: guided Extensions operation motion owns no per-row clock and no phase-driven key
    registration churn.** The process-shared spinner clock runs only while the retained view is
    active and an operation is pending; busy state gates the existing level through its reactive
    matcher. Production: `packages/code/src/views/config/ExtensionsHub.tsx` (`useSpinnerClock`,
    `operationPending`, `bindLevelKeys`). Test:
    `packages/code/tests/integration/extensions-hub-render.test.tsx` (pending install and Apply)
    and `packages/code/tooling/benchmarks/overlays.tsx`
    (`extensions-setup-pending-install`, `stableRegistrations`).

21. **PERF-21: marketplace collection movement reuses the retained row/key owners after warm-up.**
    Left/right changes only the reactive collection projection; it performs no fetch, filesystem
    scan, timer allocation, or structural key-layer registration. Production:
    `packages/code/src/views/config/MarketplaceBrowser.tsx` (`collections`, `collectionRows`,
    `changeCollection`, `StableWindowedList`). Test:
    `packages/code/tests/integration/marketplace-browser-render.test.tsx` (exact collection case)
    and `packages/code/tooling/benchmarks/overlays.tsx`
    (`marketplace-collections-retained-196-listings`, `stableRegistrations`).

22. **PERF-22: boot continuity owns one bounded startup composer, not parser/catalog or variable
    per-row work.** It has one focused input, one external draft/submission snapshot, distinct
    markers and the shared fixed-size `BrandBanner`. The complete eight-row banner is admitted only
    at 60×16 or larger; its one-line fallback preserves compact layouts. Enter is accepted once; the
    task starts before complete-app mount when a profile is runnable, while an unsent draft or
    currently unrunnable submission transfers exactly to `App`. Renderer teardown is owned
    continuously from creation through the complete keymap mount. Production:
    `packages/code/src/views/StartupComposer.tsx`
    (`STARTUP_SPLASH_MIN_ROWS`, `createStartupComposerState`, `StartupComposer`),
    `packages/code/src/views/Splash.tsx` (`BrandBanner`) and `packages/code/src/runtime.tsx`
    (`startup_submit`, `boot.app-mount`) and
    `packages/code/src/adapters/renderer-bootstrap.ts` (`installBootRendererLifecycle`). Tests:
    `packages/code/tests/integration/splash-render.test.tsx`,
    `packages/code/tests/integration/app-shell-render.test.tsx`,
    `packages/code/tests/unit/renderer-bootstrap-lifecycle.test.ts`,
    `packages/code/tests/architecture/architecture-boundary.test.ts`, and
    `packages/code/tooling/artifact/smoke.ts` (complete paint and deferred catalogue).

    Workspace-plugin inventory hashing and its automatic trust modal are full-runtime work after the
    startup composer has painted. Repository plugins remain inactive until that resolution completes;
    neither trust computation nor the modal is an admission dependency for first paint.

23. **PERF-23: automatic release discovery is post-paint, bounded and physically cancellable.**
    Only an enabled managed portable interactive TUI schedules it, through `AppShell.afterPaint`.
    The checker runs once per process, uses a 24-hour global cache and a five-second request timeout,
    and platform shutdown aborts the underlying fetch. Fast paths, headless modes, source and
    unmanaged installs never request the release index; failures do not paint UI or block other
    work. Production: `packages/code/src/runtime.tsx` (`update_check`),
    `packages/code/src/update/check.ts`, and
    `packages/code/src/update/github-releases.ts` (`fetchReleaseIndex`). Test:
    `packages/code/tests/architecture/{architecture-boundary,cli-fast-path}.test.ts` and
    `packages/code/tests/integration/update-check.test.ts`.

The near-250 ms and below-500 ms functional startup targets are review criteria on a comparable
named host, not cross-platform invariants. No invariant currently sets an absolute complete-app or
healthy-idle RSS target. The overlay runner
enforces 5 MiB/100 post-GC growth and balanced renderer/key ownership for production-policy cases at
reference and compact dimensions. It does not yet sample a complete real-model multi-run process
tree.

## 6. Failure modes and degradation

| Failure or pressure | Current degradation | Evidence |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| benchmark host is too busy | refuse unless forced; forced report is untrusted | `packages/code/tooling/benchmarks/first-paint.ts` |
| PTY never reaches a marker | fail with bounded screen and stderr context | `packages/code/tooling/benchmarks/first-paint.ts` |
| Markdown parser warm-up fails | emit a warning diagnostic and keep the usable application shell | `packages/code/src/runtime.tsx` (`markdownPreload`) |
| final Markdown or diff syntax work is still pending | keep the previous Markdown tree visible or the new diff transparent until `waitForSyntaxFrame` completes; reveal OpenTUI's fallback if readiness rejects, and do not pause the renderer | `packages/code/src/ui/patterns/stable-syntax.tsx` (`StableMarkdown`, `StableDiff`, `waitForSyntaxFrame`) |
| on-demand catalog load fails | keep the live catalog empty and emit `catalog.unavailable`; the already-painted shell remains usable | `packages/code/src/runtime.tsx` (`ensureModelsCatalog`) |
| an OAuth-backed MCP has no token and its browser is ignored | keep authorization background, omit that server from the current run, and continue other tools/model work | `packages/mcp-client/src/oauth.ts` (`MCPAuthorizationPendingError`), `packages/loop/src/runtime/open-tool-pool.ts` |
| subscription readiness has not been inspected | keep the local gate passing with `subscription check deferred`; explicit Doctor inspection can later report a real warning | `packages/code/src/onboarding/doctor.ts` (`GATES`, the `credentials` gate) |
| one transcript prose value is oversized | truncate before it enters reactive state | `packages/code/src/adapters/store.ts` |
| aggregate prose is full | release older settled prose, preserve newest | `packages/code/src/adapters/store.ts` |
| hydrated tool budget is full | dehydrate older bodies; explicit expand can re-fetch within queue limits | `packages/code/src/adapters/store.ts` |
| session reconstruction exceeds request-shape limits | throw `SessionResumeLimitError` before the next batch | `SessionResumeLimitError` and `resumeSession` in `packages/code/src/adapters/session.ts` |
| RSS reaches configured limit | cancel, detach after grace if required, block new work and offer recovery | `packages/code/src/adapters/memory-pressure.ts` |
| overlay soak child starves or grows past its process budget | parent watchdog kills it and fails with the case name and limit | `packages/code/tooling/benchmarks/overlays.tsx` (`runParent`) |
| interactive event loop is starved outside the soak | in-process sampler may not run; host/process-tree monitoring is still required | `specs/known-issues.md` (reactive microtask starvation) |
| external MCP/shell process grows | TUI self-RSS fuse does not observe it | `packages/code/README.md` |

## 7. Coupling

- **`code` -> OpenTUI/Solid:** renderer-native allocation, parser preload, reconciler destruction and
  floating renderables determine both first paint and native RSS. OpenTUI remains external to the
  bundle so its worker, grammars and platform package keep correct ownership
  (`packages/code/tooling/artifact/build.ts`).
- **`code` -> `kernel`:** the interactive host constructs an in-process file kernel before mounting
  `<App>`, but kernel bootstrap enters through the exact dynamic factory boundary and may run in
  parallel with the complete runtime import (`packages/code/src/startup-foundation.ts`,
  `prepareStartupFoundation`; `packages/code/src/adapters/workspace-client-manager.ts`,
  `connectLocalKernel`).
- **`code` -> model/subscription services:** the boot foundation does not cross either expensive
  service. Catalog-bearing routes call the models service through `ensureModelsCatalog`; Doctor's
  explicit recheck and subscription-dependent actions call entitlement over the protocol surface
  (`packages/code/src/runtime.tsx`, `ensureModelsCatalog`;
  `packages/code/src/app/commands.tsx`, `inspectReadiness`).
- **`code` -> transcript/session persistence:** visual windows can release presentation data, but a
  future full request may require persisted traces to reconstruct semantic history
  (`releaseHistory` use in `packages/code/src/run-host.ts`; `resumeSession` in
  `packages/code/src/adapters/session.ts`).
- **`code` -> `llm`/`mcp-client`:** response ceilings bound individual inputs to the transcript but
  are not charged against the same resident budget
  (`packages/llm/src/ai-sdk/bounded-fetch.ts`,
  `packages/mcp-client/src/bounded-fetch.ts`).
- **Performance -> diagnostics:** any new hot-path metric must follow the bounded counter sampler;
  observability must not become the leak it is diagnosing
  (`packages/code/src/adapters/diagnostic-session.ts`).

The owning package README is [`packages/code/README.md`](../../packages/code/README.md). Build artifact
details remain owned by [build-and-ci.md](../cross-cutting/build-and-ci.md); exact session and
transcript semantics remain owned by [sessions.md](sessions.md),
[code-run-host.md](code-run-host.md) and [code-transcript.md](code-transcript.md).

## 8. Open questions

The overlay lifecycle regression gate is implemented in
`packages/code/tooling/benchmarks/overlays.tsx` and its current limits are
described in §2.3 and §5. Other absolute startup and resident-memory targets
remain review criteria until an owner names a comparable reference host and
accepts the limits. The benchmark records focused-composer and complete-app
paint separately; a passing focused-composer time does not establish complete
hydration or real-provider readiness.

A controlled multi-run process-tree soak with a real model, external MCP
servers and shell work has not been qualified here. The TUI RSS sampler excludes
external children, so those resources need separate host measurements. Native
Linux and macOS, physical terminal, subscription and provider paths each need
their own attributable evidence before they can be called qualified.

Historical startup, overlay and implementation measurements are retained in
[known issues](../known-issues.md), where their exact environment and
diagnostic limits can be kept without turning old runs into current behavior.
