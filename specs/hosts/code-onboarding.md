# First-run seeding, the platform doctor and TUI diagnostics

> Implemented at `packages/code/src/onboarding/**`, `packages/code/src/views/config/DoctorView.tsx`,
> `packages/code/src/adapters/{platform,terminal-guard, clipboard-process,debug-session,diagnostic-session}.ts`
> and `packages/code/src/core/diagnostic-events.ts`. Every claim below is anchored to a file and
> line. Open questions are collected in the final section.

## 1. Purpose

This subsystem is three loosely related things that share one job: getting `@clarvis/code` from "process
just started" to "a person can trust what they're looking at."

1. **Onboarding** (`src/onboarding/**`): a fixed ladder of readiness gates
   (`packages/code/src/onboarding/doctor.ts:116-524`) that decide whether the TUI can proceed straight to
   the shell or must first send the user to a setup wizard or a repair screen
   (`packages/code/src/onboarding/doctor.ts:592-604`), plus the idempotent "seed a default into global
   settings the first time this workspace is used" functions
   (`seed-memory.ts`, `seed-plans.ts`, `seed-default-allowlist.ts`, sharing one guard sequence in
   `seed-block-once.ts`).
2. **Platform adapter** (`src/adapters/platform.ts`): the one seam between `code` and everything
   OS-specific that is not already `@clarvis/kernel/local` — terminal capability detection, graceful
   shutdown sequencing, and native clipboard I/O (text and PNG image) — backed by a bounded child-process
   runner (`clipboard-process.ts`) and a guard that keeps a stray `console.*`/`process.stderr.write` call
   from corrupting the TUI's canvas (`terminal-guard.ts`).
3. **The `--debug` diagnostic channel** (`core/diagnostic-events.ts`, `adapters/diagnostic-session.ts`,
   `adapters/debug-session.ts`): a single process-wide, bounded, redacting JSONL sink that both `code`'s
   own code and the kernel's `Logger` port can write into, with its own retention, sampling and
   sanitization rules, independent of the trace and settings systems.

The doctor exists because a fresh install has the shipped agents without any on-disk agent files, no
settings file, and possibly no provider — yet `@clarvis/code` still needs to decide, on every boot,
whether starting the shell is safe.
The `PROFILE_SHAPED_ISSUES` doc comment at `packages/code/src/onboarding/doctor.ts:95-105` states the
concrete failure it closes: "every run in the workspace was rejected before its first model call while
Doctor reported `Ready`" (`packages/code/src/onboarding/doctor.ts:103-104`). The diagnostic channel exists because ordinary logging is
forbidden from touching the terminal
(`packages/code/src/adapters/terminal-guard.ts:34-44`) and because a user who hits a defect needs a record they can attach to a
report without waiting for it to happen twice.

## 2. Surface

### 2.1 `onboarding/doctor.ts`

| Symbol | Kind | Signature / shape | Cite |
|---|---|---|---|
| `GateId` | type | `"config" \| "providers" \| "credentials" \| "agents" \| "default_model" \| "default_agent" \| "theme" \| "memory" \| "plans" \| "run_safety" \| "workspace_trust" \| "backend" \| "diagnostics"` | `packages/code/src/onboarding/doctor.ts:20-33` |
| `GateResult` | interface | `{ status: "pass"\|"warn"\|"fail"; detail: string; hint?: string; fix?: FixKind }` | `packages/code/src/onboarding/doctor.ts:39-45` |
| `FixKind` | type | `{kind:"view";view:"providers"\|"model"\|"defaults"\|"theme"\|"agents"\|"memory"\|"controls"} \| {kind:"set-default"} \| {kind:"set-key"} \| {kind:"reconnect"} \| {kind:"repair-settings";scope:Scope}` | `packages/code/src/onboarding/doctor.ts:48-56` |
| `Gate` | interface | `{ id: GateId; label: string; severity: "hard"\|"soft"\|"ui"\|"comms"; optional?: boolean; fix?: FixKind; check(ctx): GateResult }` | `packages/code/src/onboarding/doctor.ts:59-66` |
| `BackendProbe` | interface | `{ status: "checking"\|"reachable"\|"unreachable"; profileCount?: number }` | `packages/code/src/onboarding/doctor.ts:69-72` |
| `DoctorCtx` | interface | `{ settings, agents: {list,conflicts}, code, env, backend: Accessor<BackendProbe>, sandboxInspection: Accessor<SandboxInspection\|null>, subscriptionReadiness?: Accessor<Partial<Record<SubscriptionScheme,{state:SubscriptionState;entitled?:boolean}>>> }` | `packages/code/src/onboarding/doctor.ts` (`DoctorCtx`) |
| `DoctorReport` | interface | `{ gates: Gate[]; results: Record<GateId,GateResult>; blocked: boolean }` | `packages/code/src/onboarding/doctor.ts:89-93` |
| `GATES` | const | the fixed 13-gate ladder, in display order | `packages/code/src/onboarding/doctor.ts:116-524` |
| `runGates(ctx): DoctorReport` | fn | evaluates every gate, times each, degrades a throw to a `fail` | `packages/code/src/onboarding/doctor.ts:574-584` |
| `bootGate(report): "shell"\|"doctor"` | fn | `report.blocked ? "doctor" : "shell"` | `packages/code/src/onboarding/doctor.ts:587-589` |
| `StartupRoute` | type | `"shell" \| "setup" \| "repair"` | `packages/code/src/onboarding/doctor.ts:592` |
| `startupRoute(ctx, report): StartupRoute` | fn | routes a blocked boot to `setup` or `repair` from settings state, not from the diagnostic screen | `packages/code/src/onboarding/doctor.ts:595-604` |

### 2.2 `onboarding/seed-*.ts`

| Symbol | Signature | Cite |
|---|---|---|
| `seedBlockOnce<T>(settings, {alreadyConfigured, buildPatch, additionalOutcome?}): Promise<SeedOutcome<T>>` | shared guard sequence: already-configured → corrupt → no-settings-file → write to `global` | `packages/code/src/onboarding/seed-block-once.ts:40-55` |
| `seedMemoryBlock(settings): Promise<MemorySeedOutcome>` | writes `{memory:{enabled:true}}` | `packages/code/src/onboarding/seed-memory.ts:40-45` |
| `seedPlansBlock(settings): Promise<PlansSeedOutcome>` | writes `{plans:{...PLANS_DEFAULTS}}` (from `@clarvis/kernel/config`) | `packages/code/src/onboarding/seed-plans.ts`, `seedPlansBlock` |
| `seedDefaultAllowlist(settings, platform?): Promise<AllowlistSeedOutcome>` | writes `{guard:{...existingGlobalGuard, type:"shell", allowed_commands:[...]}}`, list picked by `platform` | `packages/code/src/onboarding/seed-default-allowlist.ts`, `seedDefaultAllowlist` |

### 2.3 `DoctorView`

| Symbol | Shape | Cite |
|---|---|---|
| `DoctorViewDeps` | `{ ctx, report, recheck, openFix, startAnyway, keys, notify, openKeyboard?, boot? }` | `packages/code/src/views/config/DoctorView.tsx:23-42` |
| `DoctorView(host, deps): JSX.Element` | renders the gate ladder and wires resolve/skip/refresh/reconnect/back keys | `packages/code/src/views/config/DoctorView.tsx:63-418` |

Key bindings registered by `DoctorView`: `[g]` start/back, `[-]` skip (soft gates only), `[d]` show/hide
healthy detail, `[^r]` refresh (`recheck`), `[c]` reconnect backend, `[u]` refresh model catalog, `[k]`
keyboard diagnostic (when `openKeyboard` supplied), and `escape` returns to the previous screen regardless
of boot/gate state (`packages/code/src/views/config/DoctorView.tsx:266-321`). Ctrl+C is not claimed by
Doctor and remains the global cancel-or-quit command.
`DoctorView`'s row classification and its three fix flows (repair-settings, set-key, set-default) are in
§4.9; `packages/code/tests/integration/doctor-render.test.tsx` (726 lines, 28 tests) is the dedicated
integration suite behind every claim there.

### 2.4 `adapters/platform.ts`

| Symbol | Shape | Cite |
|---|---|---|
| `PlatformCapabilities` | `{revision, keyboard, remote, runtimePlatform, terminal, mouse, clipboard:{osc52}, multiplexer, plain, themeBg, colorDepth}` | `packages/code/src/adapters/platform.ts:25-37` |
| `Platform` | `{capabilities, onShutdown, shutdown, suspend, resume, copyText, readClipboardImage}` | `packages/code/src/adapters/platform.ts:46-56` |
| `PlatformOptions` | `{dev?, clipboardProcess?, runtimePlatform?, processEnv?}`; the last three fields are internal test seams | `packages/code/src/adapters/platform.ts` (`PlatformOptions`), `packages/code/src/adapters/renderer-bootstrap.ts` (`RendererBootstrapOptions`) |
| `assertInteractiveTTY(io?)` | exits process with code `2` and a stderr usage line if stdin/stdout are not a TTY | `packages/code/src/adapters/renderer-bootstrap.ts` |
| `buildRendererConfig(opts?): CliRendererConfig` | the OpenTUI renderer config `code` boots with | `packages/code/src/adapters/renderer-bootstrap.ts` |
| `createPlatform(renderer, opts?): Platform` | constructs the adapter around a live `CliRenderer` | `packages/code/src/adapters/platform.ts` (`createPlatform`) |
| `readClipboardImage(signal?, run?): Promise<ClipboardImage\|null>` | free function, also exposed on `Platform` | `packages/code/src/adapters/platform.ts:138-173` |
| `WINDOWS_CLIPBOARD_COPY_SCRIPT` | const (exported for tests) | `packages/code/src/adapters/platform.ts:98-100` |

### 2.5 `adapters/clipboard-process.ts`

| Symbol | Shape | Cite |
|---|---|---|
| `ClipboardProcessRequest` | `{command, args, stdin?, signal?, timeoutMs?, maxStdoutBytes?}` | `packages/code/src/adapters/clipboard-process.ts:10-17` |
| `ClipboardProcessResult` | `{exitCode, stdout: Buffer, stderr: string, timedOut, cancelled, outputExceeded, error?}` | `packages/code/src/adapters/clipboard-process.ts:20-28` |
| `ClipboardProcessDependencies` | `{spawn?, killTree?, ownProcessGroup?, killGraceMs?}` | `packages/code/src/adapters/clipboard-process.ts:37-42` |
| `runClipboardProcess(request, deps?): Promise<ClipboardProcessResult>` | bounded, cancellable, byte-capped process runner | `packages/code/src/adapters/clipboard-process.ts:58-173` |

### 2.6 `adapters/terminal-guard.ts`

| Symbol | Shape | Cite |
|---|---|---|
| `installTerminalGuard(): () => void` | intercepts `process.stderr.write` and every text-emitting `console.*` method; returns a restore function that flushes what was withheld | `packages/code/src/adapters/terminal-guard.ts:62-118` |

### 2.7 `adapters/debug-session.ts`

| Symbol | Shape | Cite |
|---|---|---|
| `DebugSessionStatus` | `{open: boolean; path?: string; level?: DiagnosticLevel}` | `packages/code/src/adapters/debug-session.ts:11-17` |
| `DebugSessionController` | `{status, open(level?), close(), dispose()}` | `packages/code/src/adapters/debug-session.ts:20-41` |
| `DebugSessionControllerDeps` | `{workspace?: string; create?: (level) => DiagnosticSession}` | `packages/code/src/adapters/debug-session.ts:44-49` |
| `createDebugSessionController(deps?): DebugSessionController` | owns the `/debug` lifecycle: open/retune/close/status | `packages/code/src/adapters/debug-session.ts:64-104` |

### 2.8 `adapters/diagnostic-session.ts`

| Symbol | Shape | Cite |
|---|---|---|
| `DiagnosticSessionOptions` | `{workspace?, directory?, maxBytes?, keepFiles?, now?, pid?, level?}` | `packages/code/src/adapters/diagnostic-session.ts:81-97` |
| `createDiagnosticSession(options?): DiagnosticSession` | opens one bounded, owner-only JSONL session file, with a `DiagnosticLogger` the kernel can be handed | `packages/code/src/adapters/diagnostic-session.ts:346-589` |

### 2.9 `core/diagnostic-events.ts`

| Symbol | Shape | Cite |
|---|---|---|
| `DiagnosticLevel` | `"debug" \| "info" \| "warn" \| "error"` | `packages/code/src/core/diagnostic-events.ts:3` |
| `DIAGNOSTIC_LEVELS` | `["debug","info","warn","error"]`, least to most severe | `packages/code/src/core/diagnostic-events.ts:7` |
| `DEFAULT_DIAGNOSTIC_LEVEL` | `"debug"` | `packages/code/src/core/diagnostic-events.ts:10` |
| `isDiagnosticLevel(value): value is DiagnosticLevel` | | `packages/code/src/core/diagnostic-events.ts:19-21` |
| `DiagnosticLogger` | `{debug,info,warn,error: LogFn; child?(bindings, {level?}); readonly level?}` — structural port the kernel's `Logger` satisfies | `packages/code/src/core/diagnostic-events.ts:29-51` |
| `DiagnosticSession` | `{path, logger, level, setLevel, event, count, bind, close}` | `packages/code/src/core/diagnostic-events.ts:53-79` |
| `installDiagnosticSession(session): () => void` | installs the process-wide singleton; returned fn uninstalls only if it is still the active one | `packages/code/src/core/diagnostic-events.ts:84-89` |
| `activeDiagnosticLogger(): DiagnosticLogger \| undefined` | for handing the kernel its logger at construction | `packages/code/src/core/diagnostic-events.ts:100-102` |
| `activeDiagnosticSession(): DiagnosticSession \| undefined` | for a surface reporting on diagnostics (Doctor's `diagnostics` gate, `/debug`) | `packages/code/src/core/diagnostic-events.ts:113-115` |
| `diagnosticBind(fields)`, `diagnosticEvent(event, details?, level?)`, `diagnosticCount(event, details?, counterKey?)` | fire-and-forget free functions, inert with no session installed | `packages/code/src/core/diagnostic-events.ts:126-144` |
| `diagnosticAsync<T>(operation, run, options?): Promise<T>` | wraps one async op with `async.started`/`async.pending`/`async.settled`/`async.failed`; is a no-op wrapper when no session and no `onSlow` | `packages/code/src/core/diagnostic-events.ts:160-200` |

### 2.10 CLI surface (`cli-args.ts`, cited for the `--debug` contract only — see delegation note below)

| Flag / env var | Effect | Cite |
|---|---|---|
| `--debug` | enables the session for the current normal application invocation; help/version remain fast paths, usage errors do not open it, and update refuses it | `packages/code/src/cli-args.ts:120-123`, `:284-313`, `:325-359` |
| `--debug=<error\|warn\|info\|debug>` | enables and sets the floor in one flag | `packages/code/src/cli-args.ts:120-123`, `:305-313` |
| `CLARVIS_CODE_DEBUG` | env equivalent of `--debug`; any value not in `{"", "0", "off", "false", "no"}` enables it, and if it also names a level it sets the floor | `packages/code/src/cli-args.ts:134-137`, `:178-189` |
| `CLARVIS_CODE_DEBUG_LEVEL` | env equivalent of `--debug=<level>`, read before falling back to `CLARVIS_CODE_DEBUG`'s own value as a level | `packages/code/src/cli-args.ts:134-137`, `:178-189` |
| `resolveDebugRequest(mode, env): DebugRequest` | folds flag + env, flag wins in both directions | `packages/code/src/cli-args.ts:178-189` |

### 2.11 `views/onboarding/SetupView.tsx` and `RecoveryView.tsx`

These two functions are the visual layer immediately downstream of `startupRoute` (§4.1): one screen per
non-`shell` route, each a thin `(host, deps) => JSX.Element` over `ViewFrame` with its own `LevelSpec`
bound through `bindLevelKeys` (the import and call in each onboarding view) — the level-key machinery itself belongs to
`code-keyboard-and-navigation` (`specs/hosts/code-keyboard.md`), not here.

`SetupView` (`packages/code/src/views/onboarding/SetupView.tsx`, `SetupView`) is driven by two exported
types: `SetupPhase = "welcome" | "preparing" | "ready" | "error"` and `SetupState { phase; detail;
model?; agent? }`. Its `deps` are three callbacks (`begin`, `retry`, `finish`) plus a
`state: Accessor<SetupState>` — no phase state of its own. `primary()` maps phase to the one
enabled action: `welcome` → "begin setup" (`deps.begin`), `ready` → "start using Clarvis" (`deps.finish`),
`error` → "retry" (`deps.retry`), `preparing` → `undefined` (no primary action while a seeder runs).
The `LevelSpec` registers that single primary verb under `return` only when `primary()` is defined and
has no local Escape or quit route. The body first mounts `BrandBanner` only when the shared
`firstRunSplashFits` predicate passes, then renders four mutually exclusive `<Show>` blocks, one per
phase, printing `deps.state().detail` in `preparing`/`error` and, in `ready`, `deps.state().agent ??
"coder"` and `deps.state().model ?? "configured default"`. The predicate's 76×24 floor is deliberately
derived for the narrower catalog picker, so the banner never appears here only to disappear in the
next two steps.

`RecoveryView` (`packages/code/src/views/onboarding/RecoveryView.tsx:19-66`) presents one blocking
`StartupIssue { label; detail; hint? }` (`:12-16`) — always the *first* blocking gate, computed by its
caller (`recoveryIssue` in `packages/code/src/app/commands.tsx`, outside this document). Its `deps`
add `ready(): boolean` and `onReady(): void` to the same shape of callbacks: a `createEffect` (`:31-33`)
calls `deps.onReady()` via `queueMicrotask` the moment `deps.ready()` turns true, which is how the screen
closes itself as soon as the last blocking gate clears without any user action. Its `LevelSpec` (`:33-47`)
registers only `return` → `resolve` ("repair") and `d` → `openDoctor` ("open Doctor"); it has no local
Escape, `q`, or quit route. The body renders a fixed `BrandBanner`, a warning glyph line, then
`deps.issue()?.label`/`detail` (defaulting to `"configuration"`/`"rechecking"` when no issue is current)
and `deps.issue()?.hint` (defaulting to `"Open the focused repair and return here."`).

Both screens are pinned end-to-end by `packages/code/tests/integration/onboarding-render.test.tsx`: the
`SetupView` tests drive all four phases through one mounted instance and assert the large branded
frame, the small unbranded frame, each phase's rendered text, and that `[↵]` is absent only in
`preparing`; the `RecoveryView` test asserts
the blocked/cleared issue text, its two action bindings, inert `q`/Escape behavior, and that setting
`ready()` true fires `onReady` without a keypress.

## 3. Data and formats

### 3.1 Settings patches the seeders write

All three seeders write to the **global** scope only, never workspace
(`packages/code/src/onboarding/seed-block-once.ts:53`), and every write is a full-block *replacement* of that key, not a merge with
whatever else might be under it in the global file (`buildPatch()` in each seeder).

| Seeder | Patch written | Example |
|---|---|---|
| `seedMemoryBlock` | `{ memory: { enabled: true } }` — `model` deliberately omitted | `packages/code/src/onboarding/seed-memory.ts:43`, pinned by `packages/code/tests/unit/seed-memory.test.ts:24-26` |
| `seedPlansBlock` | `{ plans: { ...PLANS_DEFAULTS } }`, where `PLANS_DEFAULTS` (from `@clarvis/kernel/config`) is asserted to include `{mode:"on", retention:"keep"}` | `packages/code/src/onboarding/seed-plans.ts:33`, `packages/code/tests/unit/seed-plans.test.ts:26` |
| `seedDefaultAllowlist` | `{ guard: { ...existingGlobalGuardFieldsOnly, type:"shell", allowed_commands:[...POSIX_or_WINDOWS_DEFAULTS] } }` | `packages/code/src/onboarding/seed-default-allowlist.ts`, `seedDefaultAllowlist` |

The allowlist seeder reads the *global* `guard` block only to spread its other fields forward
(`packages/code/src/onboarding/seed-default-allowlist.ts:53`), but decides whether seeding is needed from the **effective** (merged)
guard (`packages/code/src/onboarding/seed-default-allowlist.ts:59-61`) — so a workspace-only `allowed_commands` still counts as
configured, but a workspace-only `guard.mode` is never carried into the global write
(`packages/code/tests/unit/seed-default-allowlist.test.ts:113-126`).

The platform-selected lists cover conventional inspection, build, test, lint and type-check
commands across common language ecosystems while leaving generic interpreters/task runners and
explicit install, publish, deploy and migration commands reviewable. They are intentionally
first-seed-only: an existing list, including `[]`, remains operator-owned and is never expanded by a
later Clarvis version. Production: `POSIX_DEFAULT_ALLOWED_COMMANDS` and
`WINDOWS_DEFAULT_ALLOWED_COMMANDS` in `packages/tools/src/guard/dialects/`. Test:
`packages/tools/tests/unit/posix-dialect.test.ts`,
`packages/tools/tests/unit/powershell-dialect.test.ts`, and
`packages/code/tests/unit/seed-default-allowlist.test.ts`.

### 3.2 Workflow-free onboarding

Onboarding does not install or write workflow documents. `prepareSetup` seeds only settings-backed
defaults before refreshing the agent catalogue and selecting the default profile
(`packages/code/src/app/commands.tsx`, `prepareSetup`). The kernel supplies the built-in workflow
catalogue directly from `@clarvis/workflows`; operator-authored documents remain optional overrides
and are outside the onboarding subsystem.

### 3.3 Diagnostic JSONL record

**File location and naming.** `<global-state>/workspaces/<segment>/local/diagnostics/code-debug-<ISO
stamp with `:` replaced by `-`>-<pid>[-N].jsonl`, resolved via `workspaceStatePaths(workspace).diagnosticsDir`
(`packages/code/src/adapters/diagnostic-session.ts:361-366`; path composition in `packages/paths/src/workspace-state.ts:181-184`).
Opened with `wx` (exclusive create) and mode `0o600`; a same-second collision from the same pid retries
with a numeric suffix up to 100 times (`packages/code/src/adapters/diagnostic-session.ts:254-269`), and the newest `keepFiles - 1`
files are kept before opening a new one (`retainNewest`, `packages/code/src/adapters/diagnostic-session.ts:243-252`).

**One JSON object per line**, shape:

```json
{
  "v": 1,
  "at": "2026-08-12T12:00:00Z",
  "seq": 3,
  "level": "warn",
  "source": "kernel",
  "event": "mcp.connect.failed",
  "pid": 42,
  "...bound envelope fields (workspace, execution_id, ...)": "...",
  "memory": { "...process.memoryUsage()...": "sampled only sometimes, see below" },
  "details": { "context": { "...sanitized bindings..." }, "message": "..." }
}
```
(`buildLine`, `packages/code/src/adapters/diagnostic-session.ts:387-413`; example fields pinned by
`packages/code/tests/unit/diagnostics.test.ts:83-101`, `:369-388`.)

- `source` is `"code"` for this UI's own calls (`event`/`count`/lifecycle records) and `"kernel"` for
  anything written through the `DiagnosticLogger` handed to the kernel (`packages/code/src/adapters/diagnostic-session.ts:388`,
  `:479`).
- `event` is either the caller's own name, the value of a declared `event` field on a pino-style bindings
  object (`loggerEvent`, `packages/code/src/adapters/diagnostic-session.ts:314-323`), or the fallback `kernel.<level>`; an
  unrecognized event-name shape (must match `/^[a-z0-9][a-z0-9._-]*$/`, ≤160 chars) is replaced with
  `diagnostics.invalid-event` (`eventName`/`validDiagnosticName`, `:196-206`).
- `memory` is attached for every record at `warn`/`error`, and otherwise only on the first record and
  every 32nd one after (`samplesMemory`, `:365-366`, pinned by `packages/code/tests/unit/diagnostics.test.ts:390-402`).
- A line whose serialized form exceeds `MAX_RECORD_BYTES` (16 KiB) is replaced wholesale with a `{
  truncated: true, reason: "record exceeded 16 KiB" }` details block (`:387-393`).
- Reserved envelope keys `v, at, seq, level, source, event, pid, memory, details` cannot be overwritten
  by `session.bind()` (`RESERVED_ENVELOPE_KEYS`, `:50-60`, `:494-501`).

**Sanitization** (`sanitize()`, `packages/code/src/adapters/diagnostic-session.ts:161-209`) is applied to every logged detail and
every bound field, and bounds: string length (2,000 chars, longer strings truncated with a
`"...[truncated N chars]"` marker and a 4,096-char pre-scan cap), array items (32), object keys (64, with
`__truncated_keys: true` past that), recursion depth (5), and total visited nodes across one call (256,
returning `"[node-limit]"` past that). A getter/accessor property is **never invoked** — its descriptor
is read and `"[accessor]"` substituted instead (`:182-185`, pinned by
`packages/code/tests/unit/diagnostics.test.ts:152-176`). Circular-reference detection tracks only the current recursion
*path* (a `WeakSet` added-to and deleted-from around each recursive call), so the same object reachable
from two different keys is serialized twice rather than reported as `"[circular]"`
(`:163-169`, `:188`, pinned by `packages/code/tests/unit/diagnostics.test.ts:178-194`).

**Redaction.** A key is redacted (value replaced with `"[redacted]"`) when, after normalizing to
snake_case, it matches `SECRET_KEY` (`api_key`/`authorization`/`cookie`/`credential`/`password`/`secret`/
`token`, as whole underscore-delimited segments), a `private_key` pattern, or `CONTENT_KEY` — a fixed
list of field names whose *value* is payload rather than identifier: `args, arguments, body, clipboard,
content, diff, env, headers, input, messages, output, params, payload, prompt, raw_key, request,
response, result, stderr, stdin, stdout, input_text, output_text, message_content, prompt_text,
request_body, response_body, tool_arguments` (`SECRET_KEY`/`CONTENT_KEY`/`mustRedactKey`,
`packages/code/src/adapters/diagnostic-session.ts:103-136`). `path` is deliberately **not** in `CONTENT_KEY` — including it made the session's own
`diagnostics.start` record redact the very file path it announces (`:89-95`). Independently of key-based
redaction, every string value is scrubbed by `sanitizeErrorMessage` (from `@clarvis/kernel/policy`) for
embedded secrets (e.g. a URL's `user:pass@` or a `Bearer <token>` substring) and has ANSI CSI escape
sequences stripped (`safeString`, `:119-128`).

**Counters** (`session.count`) are recorded only at counts 1–8 and at powers of two thereafter
(`isPowerOfTwo`, `:192-194`, `:526`), and at most 256 distinct counter keys are tracked before new ones
collapse into `diagnostics.counter-overflow` (`MAX_COUNTERS`, `:518-523`).

**Size and retention bounds.** A session's file is capped at `maxBytes` (default 16 MiB), with the last
`FINAL_RESERVE_BYTES` (≤4,096, and ≤¼ of `maxBytes`) reserved so the closing `diagnostics.stop` record
can always be written even after the regular budget is exhausted (`:330-336`, `:396-439`). Once the
regular budget (`regularLimit = maxBytes - finalReserve`) would be exceeded, one `diagnostics.saturated`
record is appended and all further non-`force` writes are dropped (`:424-437`). At most `keepFiles`
(default 5) files are kept per directory, oldest deleted first by mtime (`retainNewest`, `:224-233`).
Non-finite/invalid `maxBytes`/`keepFiles` seams fall back to the production defaults
(`:330-341`, pinned by `packages/code/tests/unit/diagnostics.test.ts:322-337`).

**Two concrete record shapes the session constructs directly, beside the generic envelope above:**

- **`diagnostics.stop`** (`close()`, `packages/code/src/adapters/diagnostic-session.ts:553-564`, forced): `{bytes, saturated,
  counterKeys, topCounters}`, where `topCounters` is the top 32 counters by count, descending
  (`[...counters].sort(...).slice(0, 32)`).
- **`runtime.heartbeat`** (`packages/code/src/adapters/diagnostic-session.ts:580-586`): fired every `HEARTBEAT_MS` (5000 ms) via a
  `setInterval` the session `unref()`s so it cannot keep the process alive (`:568`); payload is
  `{delayedMs}`, the amount by which the actual firing lagged the expected one.

### 3.4 Doctor gate ladder (as data)

The 13-gate table, in fixed display order, its severity and default fix:

| # | `id` | severity | default `fix` |
|---|---|---|---|
| 1 | `config` | hard | `{view:"providers"}` (superseded per-result by `repair-settings` when corrupt) |
| 2 | `agents` | hard | none (per-result `{view:"agents"}` on conflict/refusal) |
| 3 | `providers` | soft | `{view:"providers"}` |
| 4 | `credentials` | soft | `{set-key}` |
| 5 | `default_model` | soft | `{view:"model"}` |
| 6 | `workspace_trust` | ui, optional | none |
| 7 | `run_safety` | ui, optional | `{view:"controls"}` |
| 8 | `default_agent` | ui, optional | `{set-default}` |
| 9 | `theme` | ui, optional | `{view:"theme"}` |
| 10 | `memory` | ui, optional | `{view:"memory"}` |
| 11 | `plans` | ui, optional | `{view:"controls"}` |
| 12 | `backend` | comms, optional | `{reconnect}` |
| 13 | `diagnostics` | ui, optional | none |

(`packages/code/src/onboarding/doctor.ts:116-524`; order/severity ranking pinned by
`packages/code/tests/integration/doctor.test.ts:597-603`, which also asserts the array holds no `"tty"` gate.)

### 3.5 `platform.ts`'s own diagnostic events

Beside the doctor's `diagnostics` gate and the generic JSONL envelope, `platform.ts` itself is a
producer of named diagnostic events/counters:

| Event/counter | Fields | Cite |
|---|---|---|
| `platform.create` | `dev`, `remote` (an `SSH_TTY`/`SSH_CONNECTION` check), `runtime` (`process.platform`) | `packages/code/src/adapters/platform.ts` (`createPlatform`) |
| `renderer.theme-mode` (counter) | `mode` | `packages/code/src/adapters/platform.ts` (`createPlatform`) |
| `renderer.capabilities` (counter) | none | `packages/code/src/adapters/platform.ts` (`createPlatform`) |
| `renderer.destroy` | none | `packages/code/src/adapters/platform.ts` (`createPlatform`) |
| `platform.shutdown.begin` | `reason`, `error?` | `packages/code/src/adapters/platform.ts` (`createPlatform`) |
| `platform.shutdown.hooks-settled` | `reason` | `packages/code/src/adapters/platform.ts` (`createPlatform`) |

### 3.6 Renderer configuration (as data)

`buildRendererConfig` (`packages/code/src/adapters/renderer-bootstrap.ts`) returns the fixed base
`CliRendererConfig` `code` boots with:

```
{
  screenMode: "alternate-screen",
  exitOnCtrlC: false,
  exitSignals: [],
  useKittyKeyboard: directMacIterm
    ? { allKeysAsEscapes: true, reportText: true }
    : {},
  ...(directMacIterm ? { prependInputHandlers: [consumeItermModifierStateReport] } : {}),
  useMouse: true,
  autoFocus: true,
  clearOnShutdown: true,
  consoleMode: opts.dev === true ? "console-overlay" : "disabled",
  openConsoleOnError: opts.dev ?? false,
  targetFps: 30,
  maxFps: 60,
}
```

`directMacIterm` requires a local, non-tmux iTerm session. Full reporting lets the renderer retain
the physical Option key and its associated text at once. iTerm also emits standalone modifier-state
packets in this mode; the prepended handler consumes only those packets before OpenTUI can parse
their numeric state as a control character. SSH, tmux and every other terminal retain OpenTUI's
conservative disambiguation-plus-alternate-key defaults.

`exitOnCtrlC: false` and `exitSignals: []` pair with the manual `SIGINT`/`SIGTERM`/`SIGHUP` handlers in
§4.6 — OpenTUI is told to leave process-exit entirely to `platform.ts`'s own `shutdown()`. `maxFps` is
stated explicitly, even though it repeats OpenTUI's own default, because it is the ceiling a forced
`requestRender()` runs into; the doc comment above the function (`:190-196`) notes it never binds today
because `@clarvis/loop`'s `DELTA_BATCH` already holds flushes well under it, but raising either threshold
would make `maxFps` the visible limiter. `openConsoleOnError` toggling on `opts.dev` is pinned by
`packages/code/tests/integration/platform-lifecycle.test.ts:125-178`.

## 4. Behavior

### 4.1 Boot routing decision

```
runGates(ctx) -> DoctorReport{gates, results, blocked}
  blocked = any(hard gate).status == "fail"  OR  any(soft gate).status != "pass"
             (ui/comms gates never block)                              [packages/code/src/onboarding/doctor.ts:577-582]

bootGate(report)   = report.blocked ? "doctor" : "shell"                [packages/code/src/onboarding/doctor.ts:587-589]

startupRoute(ctx, report):
  if !blocked                              -> "shell"
  else if global or workspace scope corrupt -> "repair"
  else if no settings.json in either scope
        or effective().providers is empty   -> "setup"
  else                                      -> "repair"                [packages/code/src/onboarding/doctor.ts:595-604]
```

This means: a fresh machine with nothing written yet routes to `setup`
(`packages/code/tests/integration/doctor.test.ts:231-248`); an unset credential on an otherwise-configured provider
routes to `repair`, not `setup` (`packages/code/tests/integration/doctor.test.ts:341-365`); a corrupt settings file
always routes to `repair` regardless of provider state (`packages/code/tests/integration/doctor.test.ts:506-523`).

### 4.2 Per-gate evaluation, and failure containment

`runGates` calls `checkGate(gate, ctx)` for every entry in `GATES`, in array order
(`packages/code/src/onboarding/doctor.ts:576`). `checkGate` times the call and, on a throw, calls `reportGateFailure`, which (a) emits
a `doctor.check.failed` diagnostic event at `error` level carrying `check_id`, the error, and
`duration_ms`, and (b) substitutes a synthetic `{status:"fail", detail:"check failed: <message>",
hint:"...run with --debug..."}` result for that one gate only (`packages/code/src/onboarding/doctor.ts:538-566`, pinned by
`packages/code/tests/integration/doctor.test.ts:525-564`). A throwing gate never aborts `runGates` or corrupts another
gate's result.

### 4.3 Notable gate logic

- **`agents`** normally sees the shipped five even when no agent file exists on disk. If its effective
  list is actually empty, it hard-fails with `"no agents"`; otherwise it warns on cross-scope name
  conflicts, invalid frontmatter, or a refused customization overlay, listing the first offending
  kind's detail (`packages/code/src/onboarding/doctor.ts`, `GATES` `agents` check). A conflict/invalid finding is reported even when it
  coexists with the other kind (`packages/code/tests/integration/doctor.test.ts:288-307`), and an unrecognized
  frontmatter key alone does not count as invalid (`:304-319`).
- **`agents`**'s second phase, run only once the fleet is conflict/invalid/refusal-free, computes
  `agentReadiness(...).issues` per agent and keeps only the subset in `PROFILE_SHAPED_ISSUES`
  (`malformed_frontmatter`, `unknown_grant`, `unknown_spawn_target`, `default_spawn_not_in_can_spawn`,
  `orchestration_needs_can_spawn`, `budget_needs_limit`) — deliberately excluding model-resolution issues,
  which the `providers`/`default_model` gates already own (`packages/code/src/onboarding/doctor.ts:96-113`, `:184-204`).
- **`default_model`** resolves a model against providers via `modelResolves`, checking a model's
  provider **and** its declared model name, not the provider name alone
  (`packages/code/tests/integration/doctor.test.ts:392-410`).
- **`run_safety`**: with sandboxing enabled but not yet inspected (`sandboxInspection()` is `null`), the
  gate **passes** with a "checking sandbox host" detail rather than warning
  (`packages/code/src/onboarding/doctor.ts:337-343`). Cold command composition deliberately leaves
  this inspection deferred; an explicit Doctor recheck or the Sandbox settings surface performs the
  host probe (`packages/code/src/app/commands.tsx`, `inspectReadiness`;
  `packages/code/src/views/config/SandboxConfigPanel.tsx`, `refreshInspection`; pinned by
  `packages/code/tests/integration/app-commands.test.tsx`, "sandbox inspection is deferred until an
  explicit Doctor recheck"). Only a completed inspection reporting unavailability warns, distinguishing
  `availability:"required"` (blocks runs) from optional (falls back to host)
  (`:344-358`).
- **`workspace_trust`** is keyed on the trust verdict (`inert`/`trusted`/other), never solely on
  `withheldWorkspaceFields()`, because an untrusted workspace whose only executable surface is agent
  `.md` files would otherwise report "nothing withheld" (`packages/code/src/onboarding/doctor.ts:300-324`).
- **`memory`** reports `warn` ("not configured") when its block is absent from `effective()`;
  **`plans`** instead reports `pass` ("`<policy>` (defaults)") when unconfigured
  (`packages/code/src/onboarding/doctor.ts`, `memory` and `plans` gate definitions) — only memory's absence is flagged as a warning, plans treats its defaults as a
  healthy state. Its hint routes review changes to `/plan` and retention changes to Run Controls;
  Run Controls no longer edits planning mode. Neither gate ever blocks boot regardless, since both are `ui` severity
  (`packages/code/tests/integration/doctor.test.ts:660-684` for memory, `:686-710` for plans — the latter asserting
  `results.plans.status` is `"pass"`, not `"warn"`, on an unconfigured block).
- **`credentials`** (soft severity): subscription-backed `openai-codex` and `xai-grok` providers are
  checked in declaration order before API-key providers. Missing readiness returns `pass` with
  `"subscription check deferred"` immediately, so later subscriptions and `api_key_env` entries are
  not evaluated during that check. The first state other than `connected`, denied entitlement, or
  entitlement still being checked warns and points to the Providers view. Only when every declared
  subscription has current connected-and-entitled readiness does the gate inspect `api_key_env`.
  When no API-key credential is missing, its
  detail splits how many resolve from the environment versus from `keys.json`
  (`"N in env · M in keys.json"`). Production:
  `packages/code/src/onboarding/doctor.ts` (`credentials` gate). Test:
  `packages/code/tests/integration/doctor.test.ts` ("credentials: ChatGPT and Grok must both be
  connected and entitled" and "credentials: a key present only in keys.json passes via the keyfile
  source").
- **`diagnostics`** reports `warn` (never `fail`) while a session is recording, deliberately — `ui`
  severity never blocks, and `warn` is the only status Doctor keeps on-screen without "show details"; the
  session's `path` travels as the `hint` (`packages/code/src/onboarding/doctor.ts:495-522`).

### 4.4 Seeding sequence at app mount

On mount (`packages/code/src/app/commands.tsx`, `registerAppCommands`'s `seed_plans_settings`,
`seed_memory_settings` and `seed_default_allowlist` observed tasks; outside this document's owned file set but the call site of every
seeder here), three seeders run unconditionally and idempotently, each `.then()`-notifying the user only
on a real write and calling `recheck()` to re-run the gate ladder:

1. `seedPlansBlock` → on success, notify `planning: on · keep plans (<scope> settings) — use
   /plan for review and Run controls for retention`.
2. `seedMemoryBlock` → on success, also calls `deps.memoryMode.refresh()` then `.setMode("on")` before
   notifying — the memory-mode store freezes its signal from `configured()` at construction
   (`packages/code/src/onboarding/seed-memory.ts:34-38`), so a mid-session seed must force both calls or the session keeps asking for
   `memory:"off"` for its whole lifetime.
3. `seedDefaultAllowlist` → on success, notify the count of commands seeded.

Only after those three (fire-and-forget) is `startupRoute` consulted to decide whether to open
`setup.open` or `recovery.open` (`packages/code/src/app/commands.tsx`, `startupRoute`). The first-run **wizard** path
(`prepareSetup` in `packages/code/src/app/commands.tsx`) calls the same three seeders synchronously
(`seedSetupDefaults`) before refreshing the live agent catalogue and setting the default entry agent.
It performs no workflow filesystem writes.

### 4.5 Clipboard candidate ordering

`copyText` (`packages/code/src/adapters/platform.ts`, `createPlatform`):

```
remote (SSH_TTY or SSH_CONNECTION set)?
  yes -> try OSC-52 first; on success return true
         else -> try native tool; else -> false
  no  -> try native tool first; on success return true
         else -> try OSC-52 (only path where local falls back to OSC-52)
```
Pinned exactly by `packages/code/tests/integration/platform-copy.test.ts:68-107`.

Native-tool candidate lists, tried **in order** until one succeeds (`exitCode===0`, no error, not timed
out):
- copy: darwin→`pbcopy`; win32→PowerShell `Set-Clipboard` via `-EncodedCommand`; `WAYLAND_DISPLAY` set→
  `wl-copy`; `DISPLAY` set→`xclip -selection clipboard` then `xsel --clipboard --input`
  (`packages/code/src/adapters/platform.ts:105-120`).
- paste-image: darwin→`pngpaste`; win32→PowerShell `Clipboard.GetImage()`; `WAYLAND_DISPLAY`→`wl-paste
  --type image/png`; `DISPLAY`→`xclip -selection clipboard -t image/png -o` — **`xsel` is never tried for
  image paste** (`packages/code/src/adapters/platform.ts:140-155`, pinned by `packages/code/tests/integration/platform.test.ts:133-142`). A
  candidate's output must start with the 8-byte PNG signature or it is rejected as not-an-image
  (`isPng`, `packages/code/src/adapters/platform.ts:123-127`, `:144`).

### 4.6 Shutdown sequence

`shutdown(reason, err?)` (`packages/code/src/adapters/platform.ts`, `createPlatform`): a second concurrent call short-circuits to
`restore()` + `process.exit` immediately (`:325-328`, pinned by
`packages/code/tests/integration/platform-lifecycle.test.ts:400-412`). Otherwise: abort every in-flight clipboard
controller → run every registered `onShutdown` hook in **reverse registration order**, each wrapped so a
throw/rejection cannot stop the others, capped at `SHUTDOWN_BUDGET_MS` (2000 ms) total → restore the
terminal (destroy the renderer, swallowing any error) → if not a panic and running over SSH, drain stdin
until quiet (`drainStdinUntilQuiet`, capped at `DRAIN_MAX_MS`=500 with a `DRAIN_QUIET_MS`=120 quiet
window) → on panic with an error, write its stack to stderr → `process.exit(reason==="panic" ? 1 : 0)`.

**What invokes `shutdown`**, registered once inside `createPlatform`
(`packages/code/src/adapters/platform.ts`, `createPlatform`):

| Event | Handler | Calls full `shutdown()`? |
|---|---|---|
| `process.on("exit", ...)` | `restore` | No — `exit` only runs `restore()` (terminal teardown), never the hook/drain sequence; the process is already terminating by the time `"exit"` fires |
| `process.on("uncaughtException", ...)` | `shutdown("panic", e)` | Yes |
| `process.on("unhandledRejection", ...)` | `shutdown("panic", e)` | Yes |
| `SIGINT` | `shutdown("signal:SIGINT")` | Yes |
| `SIGTERM` | `shutdown("signal:SIGTERM")` | Yes |
| `SIGHUP` (only when `process.platform !== "win32"`) | `shutdown("signal:SIGHUP")` | Yes |

### 4.7 Terminal guard lifecycle

`installTerminalGuard()` (`packages/code/src/adapters/terminal-guard.ts:62-118`): replaces `process.stderr.write` and all eight
text-emitting `console.*` methods with interceptors that append to a shared byte-capped ring buffer
(`MAX_DEFERRED_BYTES` = 64 KiB, oldest chunks dropped first, `:68-74`); a write's callback still fires
synchronously so a caller awaiting drain is never stranded (`:87`, pinned by
`packages/code/tests/unit/terminal-guard.test.ts:63-76`). The returned restore function is idempotent (a second call is
a no-op, `:104-105`) and, on first call, puts every original back and flushes the buffered bytes through
the *original* `process.stderr.write` in one `Buffer.concat` write.

### 4.8 Debug-session controller state machine

| State | Event | New state | Effect |
|---|---|---|---|
| no session installed | `open(level?)` | this controller owns a session | creates via `create()`, installs it, `retuned:false` | `packages/code/src/adapters/debug-session.ts:96-99` |
| this controller's session installed | `open(level?)` | same session, retuned | `setLevel(level)` on the existing session; `retuned:true`, same `path` | `:90-94` |
| a **foreign** session installed (opened by `--debug` at boot, not by this controller) | `open(level?)` | unchanged | retunes the *foreign* session in place (since `activeDiagnosticSession()` still finds it) and reports `retuned:true` | `:90-94` |
| this controller's session installed | `close()` | none installed | uninstalls, closes the file, returns its path | `:73-81` |
| a foreign session installed | `close()` | unchanged | returns `null` — "left for its own owner to close" | `:73-75`, `packages/code/src/adapters/debug-session.ts:59-62` remark |
| none installed | `close()` | none | returns `null` | pinned `packages/code/tests/unit/debug-session.test.ts:91-97` |

`open()` always reports `retuned:true` whenever a session was already installed (own or foreign),
whether or not the requested `level` differs from the one already active — it does not itself
distinguish the two. But `setLevel`'s own no-op short-circuit (`packages/code/src/adapters/diagnostic-session.ts:528-529`, invariant
11) means a same-level retune writes no `diagnostics.level` record, while a genuine level change does —
so the effect on the JSONL file, not `retuned`'s own value, is what tells the two apart.

### 4.9 DoctorView interaction behavior

**Row classification** (`packages/code/src/views/config/DoctorView.tsx:82-98`): every gate not already resolved (`isResolved`: `status
=== "pass"` or session-skipped) falls into one of four buckets computed each render —

- `issueRows`: unresolved `hard`/`soft` gates.
- `recommendationRows`: unresolved gates of every other severity (`ui`/`comms`).
- `actionRows`: `issueRows ∪ recommendationRows`, filtered to rows carrying a `fix` (own or per-result)
  **or** whose `severity === "soft"` — a soft gate with no `fix` at all is still "actionable" purely by
  severity, which is non-obvious given every other severity needs a concrete `fix` to qualify.
- `passiveRows`: the unresolved rows left over — rendered as plain bullets, never reachable by keyboard.

Only `actionRows` participate in keyboard navigation (`sel`/`clamp` index into it exclusively); `[return]`
on a `passiveRow` is structurally impossible, since navigation never lands there. Pinned by
`packages/code/tests/integration/doctor-render.test.tsx:679` ("only unresolved actionable rows participate in Doctor
navigation") and `:342` ("a gate with no action is status-only and Enter does not pretend it can fix
it").

**`doRepairSettings` fix flow** (`packages/code/src/views/config/DoctorView.tsx:147-181`), reached from the `repair-settings` fix kind:
calls `settings.planRepair(scope)`; a `null` plan notifies "nothing to repair" and still `recheck()`s. A
non-null plan branches on `plan.action`: `"strip"` confirms "strip invalid keys ... drops: <fields>",
anything else confirms "reset ... to {}" naming `plan.reason` — both `danger: true` through
`host.confirm`. Declining leaves settings untouched; confirming calls `settings.applyRepair(plan)` and
notifies what happened. `recheck()` always runs in a `finally`, on decline, success or thrown failure
alike. Pinned by `packages/code/tests/integration/doctor-render.test.tsx:186` (corrupt config gate),  `:571` (valid
config: nothing to repair, rechecks anyway), `:602` (decline leaves settings untouched), `:640`
(unparsable file offers reset, failed repair notifies).

**`doSetKey` fix flow** (`packages/code/src/views/config/DoctorView.tsx:183-222`), reached from the `set-key` fix kind: collects every
provider's `api_key_env` whose `envStatus` is `"unset"`, deduped through a `Set`. Zero missing notifies
"no missing credentials". Exactly one missing opens the secret editor (`promptForApiKey`) directly for
that variable; several missing instead offers an `fe.startPick` chooser naming each. On save, a rejected
`keys.set` notifies the failure and stops; a successful save notifies, `recheck()`s, and dispatches
`backend.reconnect`. Pinned by `packages/code/tests/integration/doctor-render.test.tsx:434` (no missing credentials),
`:447` (one missing: opens editor directly, save failure notifies), `:488` (one missing: saves,
rechecks, reconnects), `:536` (several missing: picker first).

**`doSetDefault` fix flow** (`packages/code/src/views/config/DoctorView.tsx:224-244`), reached from the `set-default` fix kind: picks the
first agent in `ctx.agents.list()` whose `agentReadiness(...).runnable` is `true`, falling back to
`list[0]` when none is runnable; no agents at all notifies "no agent to set". A write failure
(`code.writeAgentDefault` throwing) notifies the error and stops short of `recheck()`; success `recheck()`s
and notifies the chosen name and scope. Pinned by `packages/code/tests/integration/doctor-render.test.tsx:378` (picks
the first runnable agent), `:397` (no agents at all), `:415` (write failure notifies).

### 4.10 Diagnostic child-logger floor composition

`DiagnosticSession.logger.child(bindings, options?)` (`packages/code/src/adapters/diagnostic-session.ts:439-486`) composes a derived
logger's floor rather than replacing it: the new `ownFloor` is `Math.max(ownFloor, childFloor(options?.level))`
(`:471-472`), so a child can only ever narrow (raise) what its parent already admits, never widen it. The
derived logger's own `level` getter reports `DIAGNOSTIC_LEVELS[Math.max(floor, ownFloor)] ?? "silent"`
(`:474`) — the session's current floor and the chain's composed `ownFloor`, whichever is stricter.
`childFloor(requested)` (`:452-457`) reads a `CLARVIS_LOG`-style level: `undefined` yields `0` (emit
everything), `"silent"` yields one past the last real level (suppress everything), and any other
unrecognized string also yields `0` — an unrecognized level is treated as "no additional restriction"
rather than as `"silent"`, so a typo widens rather than silences. Pinned by
`packages/code/tests/unit/diagnostics.test.ts:404` ("CLARVIS_LOG scopes reach this sink: a component's records carry it
and honour its level"), `:437` ("a component scope composes with the session floor, and a silent scope
writes nothing"), `:454` ("a derived logger reports its own effective level and keeps its parent's
bindings").

### 4.11 `SetupView`/`RecoveryView` self-closing behavior

Neither screen polls or is told to close by its caller on a timer; each closes itself from a condition it
alone observes. `SetupView` has no auto-close — `finish` fires only from the user pressing `return` in the
`ready` phase (`packages/code/src/views/onboarding/SetupView.tsx`, `primary`) — but `RecoveryView` does:
its `createEffect` (`packages/code/src/views/onboarding/RecoveryView.tsx:31-33`) re-runs on every change to
`deps.ready()`, and the instant it reads `true` it schedules `deps.onReady()` on a microtask rather than
calling it synchronously inside the effect. `commands.tsx` wires `ready` to `bootGate(report()) ===
"shell"` and `onReady` to `host.close()` (`packages/code/src/app/commands.tsx`, `recovery.open`), so a repair
that clears every blocking gate (e.g. `repairStartupSettings`'s `recheck()`) dismisses the
recovery screen with no further keypress — pinned by
`packages/code/tests/integration/onboarding-render.test.tsx:143-146` ("recovery closes itself once
`ready()` turns true").

## 5. Invariants

1. **A doctor gate's throw degrades only that gate**, never the whole report. — `packages/code/src/onboarding/doctor.ts:538-566` —
   pinned by `packages/code/tests/integration/doctor.test.ts:525-564`.
2. **Boot is blocked exactly when a `hard` gate fails or a `soft` gate is not passing**; `ui`/`comms`
   gates never block. — `packages/code/src/onboarding/doctor.ts:577-582` — pinned by
   `packages/code/tests/integration/doctor.test.ts:204-229` (all-pass → not blocked) and `:326-339` (soft `warn` →
   blocked).
3. **Having no on-disk agent files is healthy because the shipped fleet remains effective; an actually
   empty effective fleet hard-fails.** Production: `packages/code/src/onboarding/doctor.ts` (`GATES`
   `agents` check). Test: `packages/code/tests/integration/doctor.test.ts` ("ladder: a fresh machine
   blocks on config alone — the agent fleet is always there" and "agents gate hard-fails when the
   effective fleet is actually empty").
4. **`startupRoute` returns `repair` for any corrupt scope, even before checking for missing settings or
   providers.** — `packages/code/src/onboarding/doctor.ts:597-599` — pinned by `packages/code/tests/integration/doctor.test.ts:506-523`.
5. **An unset provider credential routes to `repair`, not `setup`**, because providers already exist —
   only their credential is missing. Subscription checks are sequential: missing readiness returns a
   deferred `pass` immediately, while the first known disconnected or unentitled subscription points
   at Providers; API-key checks run only after all declared subscriptions are known connected and
   entitled. Production: `packages/code/src/onboarding/doctor.ts` (`credentials` gate and
   `startupRoute`). Test: `packages/code/tests/integration/doctor.test.ts` ("credentials: ChatGPT and
   Grok must both be connected and entitled" and the unset native-key route case).
6. **A seeder never writes when no `settings.json` exists in either scope, and never writes over a
   corrupt scope** — creating the file is the `config` gate's job, and a write over corruption would fail
   anyway. — `packages/code/src/onboarding/seed-block-once.ts:48-52` — pinned by `tests/unit/seed-block-once.test.ts` (`"declines when
   ... corrupt"`, `"declines when no settings.json exists"`) and mirrored per-seeder in
   `packages/code/tests/unit/seed-memory.test.ts:62-75`, `tests/unit/seed-plans.test.ts` (analogous cases).
7. **A seeder's write always targets the global scope**, regardless of which scope had a settings file. —
   `packages/code/src/onboarding/seed-block-once.ts:53` — pinned by `packages/code/tests/unit/seed-memory.test.ts:35-40`.
8. **An explicit `enabled:false`/`mode:"off"`/present `allowed_commands` (including an empty array)
   counts as already-configured and is never re-seeded.** — each seeder's `alreadyConfigured` —
   `packages/code/src/onboarding/seed-memory.ts:42`, `packages/code/src/onboarding/seed-plans.ts:32`, `packages/code/src/onboarding/seed-default-allowlist.ts:58-61` — pinned by
   `packages/code/tests/unit/seed-memory.test.ts:42-49`, `tests/unit/seed-plans.test.ts` ("never re-seeds over an
   explicit opt-out"), `packages/code/tests/unit/seed-default-allowlist.test.ts:81-89` (empty list is deliberate).
9. **The default-allowlist seed never carries a workspace's `guard` fields other than
   `allowed_commands`/`type` into the global write** — it spreads only the *global* scope's existing
   `guard` block, deciding "already configured" from the merged `effective()` but writing from the
   unmerged global file. Production: `packages/code/src/onboarding/seed-default-allowlist.ts`
   (`seedDefaultAllowlist`). Test: `packages/code/tests/unit/seed-default-allowlist.test.ts`
   ("does not persist untrusted workspace guard fields into the global scope").
10. **Onboarding never materializes built-in workflow documents.** `prepareSetup` seeds settings,
    refreshes profiles and selects the default agent; workflow definitions are supplied by the kernel.
    — `packages/code/src/app/commands.tsx` (`prepareSetup`) — pinned end to end by
    `packages/kernel/tests/integration/workflows-service.test.ts` ("offers built-in workflows without
    materializing a workflow directory").
11. **A diagnostic session's own lifecycle records (`diagnostics.start`, `diagnostics.level`,
    `diagnostics.stop`, `diagnostics.saturated`) bypass both the level floor and the saturation cutoff**
    (`force=true`), so a session tuned to `error` still records its own start/stop and a saturated
    session still gets its final stop line. `setLevel(next)` is itself a no-op — writes nothing, not even
    a `diagnostics.level` record — when `next === level`, so retuning to the level already active leaves
    no trace on the line (`packages/code/src/adapters/diagnostic-session.ts:528-529`). —
    `packages/code/src/adapters/diagnostic-session.ts:436-458`, `:532-533`, `:553-564` —
    pinned by `packages/code/tests/unit/diagnostics.test.ts:339-358` (level floor) and
    `tests/integration/diagnostics... "file size and retention remain bounded"` (`:299-320`, saturation).
12. **A diagnostic accessor property is read via its descriptor, never invoked**, so a logged payload
    cannot trigger side effects during sanitization. — `packages/code/src/adapters/diagnostic-session.ts:201-204` — pinned by
    `packages/code/tests/unit/diagnostics.test.ts:152-176`.
13. **Circular-reference detection in `sanitize` tracks only the current recursion path**, so the same
    object reachable through two sibling keys is serialized twice, not folded to `"[circular]"` on its
    second occurrence. — `packages/code/src/adapters/diagnostic-session.ts:182-188`, `:207` — pinned by
    `packages/code/tests/unit/diagnostics.test.ts:178-194`.
14. **`path` is excluded from the content-redaction key list on purpose** — including it redacted the
    diagnostic session's own announcement of where it writes. — `packages/code/src/adapters/diagnostic-session.ts:108-114` — no test
    directly asserts the *absence* of the exclusion (unpinned as a negative claim), but
    `packages/code/tests/unit/diagnostics.test.ts:143-150` asserts the `diagnostics.start` record's `path` field is
    readable, which the redaction would have defeated.
15. **The debug-session controller retunes an already-installed session in place rather than opening a
    second file** — including a *foreign* session it did not itself open — and reports whether a given
    `open()` call was the first (`retuned:false`) or a retune (`retuned:true`). — `packages/code/src/adapters/debug-session.ts:90-99`
    — pinned by `packages/code/tests/unit/debug-session.test.ts:51-72`, `:99-116`.
16. **`close()` on the debug-session controller only ever closes the session *this controller* opened**;
    closing a foreign (e.g. boot-time `--debug`) session is refused, returning `null`. —
    `packages/code/src/adapters/debug-session.ts:73-81`, `:59-62` — pinned by `packages/code/tests/unit/debug-session.test.ts:99-116`.
17. **`--debug` on the command line always enables the session, even when `CLARVIS_CODE_DEBUG=off` is set
    in the environment**, and an explicit `--debug=<level>` always wins over
    `CLARVIS_CODE_DEBUG_LEVEL`/an env-supplied level — the flag wins in both directions. —
    `packages/code/src/cli-args.ts:165-186` — pinned by `packages/code/tests/unit/cli-args.test.ts:154-187` ("resolveDebugRequest
    folds the environment in, with the flag winning both ways"), though `cli-args.ts` itself belongs to
    [hosts/code-bootstrap.md](code-bootstrap.md) per §8.
18. **An unrecognized diagnostic level in the *environment* is silently ignored (falls back to
    `debug`), while the same typo on the command line is a usage error.** —
    `packages/code/src/cli-args.ts:169-176` (remark), `:149-160` (`debugLevel` returns `undefined` on no match), `:305-309`
    (`usageError` on an unmatched `--debug=<level>`, directly implementing the command-line half) — pinned
    by `packages/code/tests/unit/cli-args.test.ts:133-152` (bad `--debug=loud` is a `usage-error` naming the flag) and
    `:184-187` (an unrecognized `CLARVIS_CODE_DEBUG_LEVEL` silently falls back rather than erroring).
19. **`installTerminalGuard`'s restore is idempotent**: a second call neither restores twice nor
    re-flushes the buffer. — `packages/code/src/adapters/terminal-guard.ts:104-105` — pinned by
    `packages/code/tests/unit/terminal-guard.test.ts:35-46`.
20. **The terminal guard withholds `console.log`/`console.info` (stdout-bound methods) as well as the
    stderr ones**, because the renderer paints through `process.stdout.write` directly and never through
    `console`, so withholding cannot suppress a frame — only prevent corruption. —
    `packages/code/src/adapters/terminal-guard.ts:16-25` — pinned by `packages/code/tests/unit/terminal-guard.test.ts:79-98` (asserts `console.log`
    is withheld and later flushed).
21. **Locally (no SSH env vars), `copyText` never invokes OSC-52 when the native tool already
    succeeded**; over SSH, OSC-52 is tried first and the native tool is skipped when it succeeds. —
    `packages/code/src/adapters/platform.ts` (`copyText`) — pinned by `packages/code/tests/integration/platform-copy.test.ts:68-107`.
22. **`readClipboardImage` never falls back to `xsel` for image paste**, even though `xsel` is a text-copy
    candidate. — `packages/code/src/adapters/platform.ts:140-155` — pinned by `packages/code/tests/integration/platform.test.ts:133-142`.
23. **A clipboard helper process is force-killed (`SIGTERM` then, after `killGraceMs`, `SIGKILL`) on
    timeout, abort, or oversized stdout**, and stdout past `maxStdoutBytes` is truncated rather than
    buffered without bound. — `packages/code/src/adapters/clipboard-process.ts:101-121`, `:144-154` — pinned by
    `packages/code/tests/integration/clipboard-process.test.ts:28-46` (timeout→SIGTERM→SIGKILL),
    `:66-82` (oversized output capped and terminated).
24. **`SIGHUP` is registered only off Windows** (`process.platform !== "win32"`), since Windows never
    raises it. — `packages/code/src/adapters/platform.ts` (`createPlatform`) — unpinned by a Windows-specific test within this document's scope
    (no Windows job covers `code`; see the repository-wide Windows-CI note, out of this document's scope).

## 6. Failure modes and degradation

| Failure | Handling | Cite |
|---|---|---|
| A gate's `check()` throws | Caught by `checkGate`; logged as `doctor.check.failed` (error-level diagnostic with `check_id`/`duration_ms`); substitutes a synthetic `fail` result naming the thrown message and hinting `--debug` | `packages/code/src/onboarding/doctor.ts:538-566` |
| A seeder finds no settings file in either scope | Declines with `reason:"no-settings-file"`, writes nothing | `packages/code/src/onboarding/seed-block-once.ts:51-52` |
| A seeder finds a corrupt scope | Declines with `reason:"corrupt"`, writes nothing (would fail anyway) | `packages/code/src/onboarding/seed-block-once.ts:50` |
| Native clipboard tool spawn fails (`ENOENT`, `EPERM`, ...) | Reported as `result.error`, treated as a miss — the next candidate (or OSC-52 fallback) is tried, never a thrown exception reaching `Platform.copyText` | `packages/code/src/adapters/platform.ts:115-120`, pinned `packages/code/tests/integration/platform-lifecycle.test.ts:491-499` |
| Clipboard helper hangs | Killed after `timeoutMs` (default 2000 ms); `child.kill` itself throwing is swallowed | `packages/code/src/adapters/clipboard-process.ts:101-121` |
| `renderer.destroy()`/`suspend()`/`resume()` throws | Swallowed with an empty `catch {}` | `packages/code/src/adapters/platform.ts` (`createPlatform`), pinned `packages/code/tests/integration/platform-lifecycle.test.ts:398-403` |
| A registered `onShutdown` hook throws or its promise rejects | Wrapped in `Promise.resolve().then(...)`, awaited via `Promise.allSettled`, so one hook's failure never blocks another's | `packages/code/src/adapters/platform.ts` (`createPlatform`), pinned `packages/code/tests/integration/platform-lifecycle.test.ts:280-293` |
| Shutdown hooks collectively exceed `SHUTDOWN_BUDGET_MS` | The `Promise.race` against a timer proceeds to `restore()` anyway — hooks may still be in flight | `packages/code/src/adapters/platform.ts` (`SHUTDOWN_BUDGET_MS`, `createPlatform`) |
| Diagnostic session's file write itself fails (`writeSync` throws) | Session marks itself `saturated` and drops further non-forced writes; does not throw out to the caller | `packages/code/src/adapters/diagnostic-session.ts:418-425` |
| A diagnostic record would exceed `MAX_RECORD_BYTES` | Replaced with a `{truncated:true, reason:"record exceeded 16 KiB"}` details stand-in, same envelope | `packages/code/src/adapters/diagnostic-session.ts:406-412`, pinned `packages/code/tests/unit/diagnostics.test.ts:234-237` |
| A pathological/oversized event or counter name | Normalized to `diagnostics.invalid-event`/`diagnostics.invalid-counter`, never persisted verbatim | `packages/code/src/adapters/diagnostic-session.ts:215-225`, pinned `packages/code/tests/unit/diagnostics.test.ts:252-265` |
| `debugSession.close()` called with nothing this controller opened | Returns `null`; a foreign (`--debug`-at-boot) session is left alone | `packages/code/src/adapters/debug-session.ts:73-81` |
| `diagnosticAsync`'s `onSlow` callback itself throws | Caught, reported as an `async.slow-handler-failed` error event, and does not propagate to the awaited operation | `packages/code/src/core/diagnostic-events.ts:175-179` |
| Non-finite/NaN `maxBytes`/`keepFiles` options | Silently fall back to the production defaults rather than producing an unbounded or zero-capacity session | `packages/code/src/adapters/diagnostic-session.ts:349-360`, pinned `packages/code/tests/unit/diagnostics.test.ts:322-337` |
| `openUniqueFile` exhausts 100 same-second/same-pid filename collisions | Throws `"could not allocate a unique Clarvis diagnostic log"`, which propagates out of `createDiagnosticSession` itself — construction, not just a later write, fails | `packages/code/src/adapters/diagnostic-session.ts:259-268` — no test in this document's scope exercises the 100-collision path (see §8) |

## 7. Coupling

**Depends on** (runtime, static imports unless noted):

- `@clarvis/paths` — `CLARVIS_DIR`, `globalPaths`, `ensureWorkspaceLocalDir`, `workspaceStatePaths` — for
  settings-file location and the diagnostics directory (`packages/code/src/onboarding/doctor.ts:3`,
  `packages/code/src/adapters/diagnostic-session.ts:11`).
- `@clarvis/kernel/policy` — `defaultGuardMode` (doctor's `run_safety` gate, `packages/code/src/onboarding/doctor.ts:5`) and
  `sanitizeErrorMessage` (diagnostic string scrubbing, `packages/code/src/adapters/diagnostic-session.ts:12`).
- `@clarvis/kernel/config` — `PLANS_DEFAULTS` (`packages/code/src/onboarding/seed-plans.ts:1`).
- `@clarvis/kernel/local` — `POSIX_DEFAULT_ALLOWED_COMMANDS`/`WINDOWS_DEFAULT_ALLOWED_COMMANDS`
  (`packages/code/src/onboarding/seed-default-allowlist.ts:1-4`), `resolveShell`/`shellArgs` (Windows clipboard script construction,
  `packages/code/src/adapters/platform.ts:4`), `killTree`/`ownProcessGroup` (`packages/code/src/adapters/clipboard-process.ts:2`).
- `../adapters/execution-safety.ts` (`deriveIsolation`, `memoryState`, `modelResolves`,
  `planRetentionLabel`, `plansState`) and `../adapters/agent-files.ts` (`agentReadiness`) — doctor's gate
  logic reads these projections but does not own their semantics (`packages/code/src/onboarding/doctor.ts:6-13`) — delegated to
  sibling documents (memory/plan capability semantics; agent readiness/grants).
- `@opentui/core` — `CliRenderer`/`CliRendererConfig` types, consumed structurally by `platform.ts`.

**What forces the direction:**

- `doctor.ts` imports only *interfaces* it is handed (`SettingsAdapter`, `CodeConfigStore`, `AgentFile`,
  `EnvView`) — `DoctorCtx` is built by the caller (`doctorCtx` in `packages/code/src/app/commands.tsx`, outside this document), so
  `doctor.ts` cannot construct its own dependencies and is a pure function of whatever `ctx` it is given;
  this is what lets `tests/integration/doctor.test.ts` build a `DoctorCtx` entirely from fakes/real
  adapters without touching the app shell.
- `DiagnosticLogger` is a **structural** port (`packages/code/src/core/diagnostic-events.ts:29-51`) deliberately shaped so a
  pino-backed `Logger` from `@clarvis/capability`/`@clarvis/loop` satisfies it without either package
  importing the other — `activeDiagnosticLogger()` is handed to `@clarvis/kernel`'s construction call
  (`packages/code/src/runtime.tsx`, `bootSilentSessionStore`, `runPrintMode`, `runApp`, outside this
  document), so the coupling from kernel→diagnostics runs
  through this narrow structural type, never a concrete import.
- `installDiagnosticSession`'s uninstall guard (`if (activeSession === session) activeSession =
  undefined`, `packages/code/src/core/diagnostic-events.ts:86-88`) is what makes two independently-owned sessions (a boot-time
  `--debug` one and a later `/debug`-opened one) safe to layer without one's teardown clobbering the
  other's installation — this is also why `DebugSessionController.close()` reports `null` for a session it
  did not itself install (§5, invariant 16): it has no reference to compare.

**What depends on this subsystem:**

- `packages/code/src/runtime.tsx` and `packages/code/src/app/commands.tsx` (outside this document's file set)
  are the sole call sites of every symbol here: `runGates`/`bootGate`/`startupRoute` drive boot routing
  (`packages/code/src/app/commands.tsx`, `report`, `prepareSetup`, `recovery.open`, startup routing), and the three seeders are called
  both at `onMount` and from the guided-setup `prepareSetup`, while workflows require no onboarding
  call. `createDebugSessionController`/`resolveDebugRequest`/`installDiagnosticSession` drive the
  `--debug` lifecycle (`packages/code/src/runtime.tsx`, `runApp`, `runHeadlessMode`, and
  `packages/code/src/index.tsx`, `main`), and `installTerminalGuard` is installed once by
  `runInteractive` and released through the `BootShell`/runtime shutdown path.
  `src/views/onboarding/SetupView.tsx`/`RecoveryView.tsx` are the visual presentation of the
  `setup`/`repair` `StartupRoute`s — they consume `startupRoute`'s result and the seeder/doctor state via
  `commands.tsx` (§2.11, §4.11), while their key-binding *machinery* (`LevelSpec`, `bindLevelKeys`,
  `ViewFrame`) belongs to `code-keyboard-and-navigation`.
- `packages/code/src/app/commands.tsx`'s `/debug` slash command (`applyDebugCommand`,
  `packages/code/src/app/commands.tsx:387-420`) is the sole caller of
  `DebugSessionController.open`/`close`/`status`. Its final branch (`:415-419`) is the "kernel records
  need a relaunch with --debug" notice, fired whenever `open()` did not report a retune.

## 8. Open questions

- **`cli-args.ts`'s `resolveDebugRequest`/`FLAGS`/`DebugFlag` machinery** is the CLI half of the `--debug`
  contract and is cited in §2.10/§5 because the diagnostic channel's boot-time enablement is otherwise
  undocumented, but the file itself — and its dedicated `tests/unit/cli-args.test.ts`, which does pin
  invariants 17–18 directly — belongs to [hosts/code-bootstrap.md](code-bootstrap.md) §2.2, not to
  this document.
- **Why `MEMORY_SAMPLE_EVERY` is exactly 32, `MAX_SANITIZE_NODES` exactly 256, `HEARTBEAT_MS` exactly
  5000, or `SHUTDOWN_BUDGET_MS` exactly 2000** — all are stated as fixed constants with a doc-comment
  rationale for *why sampling/bounding exists at all* (e.g. `packages/code/src/adapters/diagnostic-session.ts:59-66`), but not for why
  that specific number. Not settled by the source beyond "it is the current tuning."
  `session.close()`'s `runtime.heartbeat` counter/timer's *consumer* (what reads it, if anything, once
  written) is not visible in this document's scope.
- **Whether any test exercises the `heartbeat` timer's actual firing** (as opposed to its construction) is
  not answered in `tests/unit/diagnostics.test.ts`; the heartbeat's `unref()` call (`packages/code/src/adapters/diagnostic-session.ts:587`)
  suggests it is expected not to keep the process alive, but no test in this document's scope asserts that.
- **The exact eight `GateId`s classified `optional: true`** (`workspace_trust`, `run_safety`,
  `default_agent`, `theme`, `memory`, `plans`, `backend`, `diagnostics` — i.e., every non-hard/soft gate)
  carry an `optional` flag on the `Gate` interface (`packages/code/src/onboarding/doctor.ts:63`) whose only reader within this document's
  scope is documentation-only; `runGates`'s blocking computation reads `severity`, not `optional`
  (`packages/code/src/onboarding/doctor.ts:577-582`). Whether `optional` is consumed anywhere else (e.g. a UI affordance beyond what
  `DoctorView.tsx` already renders from `severity`) is undetermined; it may be dead metadata, another document's
  concern, or read only by `views/onboarding/**` (see above).
- **The specific numeric values of `PROFILE_SHAPED_ISSUES`'s issue codes** (`malformed_frontmatter`,
  `unknown_grant`, etc.) are read here only as opaque strings the `agents` gate filters on
  (`packages/code/src/onboarding/doctor.ts:106-113`); their producer (`agentReadiness` in `adapters/agent-files.ts`) and the full set of
  issue codes it can emit belong to [hosts/kernel-config.md](kernel-config.md) per the delegation note in this document's scope
  and are not described further here.
