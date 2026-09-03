# Shell execution, background monitors, process trees and output spill

> Implemented at
> `packages/tools/src/{tools/shell.ts,tools/monitor.ts, shell.ts,lib/process.ts,lib/monitor.ts,lib/output.ts,lib/logslice.ts,lib/log.ts,lib/platform.ts, lib/tasks.ts,lib/token.ts}`
> and their tests. Every claim below is anchored to a file and line. Open questions are collected in
> the final section.

## 1. Purpose

This subsystem is `@clarvis/tools`' execution layer: the two model-facing ways to run an arbitrary
shell command (`shell`, which blocks to completion, and the `monitor_*` family, which backgrounds a
long-lived one), plus everything those two need underneath — resolving which shell binary and syntax
the host speaks, applying the configured sandbox before spawn, keeping a spawned tree's lifecycle
observable and killable, capturing and bounding two streams of unbounded output without exhausting
memory, and the one sanctioned escape hatch this package's machinery uses to report a problem the
model's own tool result cannot carry (`lib/log.ts`).

The core problem `shell` and `monitor_start` both solve is the same one from two angles: an agent
needs to run a real process under the resolved host-shell and sandbox posture, but neither the
command's own output volume nor its process tree's lifetime may be allowed to block or crash the
tool loop. `shell` solves it by capturing
both streams into bounded, spill-backed sinks and killing the whole tree on timeout/abort/overflow
(`packages/tools/src/tools/shell.ts:222`). `monitor_start`/`monitor_poll`/`monitor_stop`/`monitor_list`
solve the complementary problem — a command that is *supposed* to keep running (a dev server, a file
watcher) — by redirecting its output into a log file, minting an id the model pages through
(`packages/tools/src/tools/monitor.ts:173`), and separating "read the log" from "manage the process"
into small idempotent operations.

Underneath both, `resolveShell`/`shellArgs`/`exitCaptureWrapper` (`packages/tools/src/shell.ts`)
make "which shell, which syntax" a single derived fact rather than two independently configurable
ones, and `killTree`/`ownProcessGroup` (`packages/tools/src/lib/process.ts`) make "kill everything
this command started" work identically (in effect, not in mechanism) on POSIX and Windows.

## 2. Surface

### Model-facing tools

| Tool | File:line | `bounded` | Required args | Optional args |
|---|---|---|---|---|
| `shell` | `packages/tools/src/tools/shell.ts:134-138` | `true` (`:155`) | `command` | `cwd`, `timeout_ms` |
| `monitor_start` | `packages/tools/src/tools/monitor.ts:174-179` | `true` (`:188`) | `command` | `cwd`, `ready_when`, `ready_timeout_ms` |
| `monitor_poll` | `packages/tools/src/tools/monitor.ts:346-347` | `true` (`:353`) | `id` | `offset`, `match` |
| `monitor_stop` | `packages/tools/src/tools/monitor.ts:447-452` | `true` (`:456`) | `id` | — |
| `monitor_list` | `packages/tools/src/tools/monitor.ts:493-494` | `true` (`:498`) | — | — |

All five are registered `readOnly: false` in `toolDescriptors`
(`packages/tools/src/tools/registry.ts:55`, `:57-60`), including `monitor_poll` and `monitor_list`, which only
read state — the registry does not distinguish "reads state" from "read-only surface eligible". A
separate, cross-package test in `@clarvis/loop` (`packages/loop/tests/architecture/agent-tool-wire-names.test.ts:30`)
independently pins that `shell` and `monitor_start` specifically are never classified read-only
("they observe and mutate through one entry point").

`shell`'s and every `monitor_*` tool's `inputSchema` is a plain JSON Schema object compiled once by
Ajv (`packages/tools/src/core.ts:49-53`); `dispatch` validates, defaults and coerces caller arguments
against it before the handler runs (`packages/tools/src/core.ts:238-255`).

### Exported functions and types (reachable from `.`, `./shell`, or both)

| Symbol | File:line | What it is |
|---|---|---|
| `resolveShell(deps?)` | `packages/tools/src/shell.ts:83` | resolves this host's `ShellSpec` (memoized when called with no args) |
| `shellArgs(shell, command)` | `packages/tools/src/shell.ts:119` | builds argv to run `command` under `shell` |
| `encodePowerShellCommand(command)` | `packages/tools/src/shell.ts:101` | base64/UTF-16LE `-EncodedCommand` payload |
| `exitCaptureWrapper(command, flavor)` | `packages/tools/src/shell.ts:155` | wraps `command` so its exit status lands in `$MON_EXIT` |
| `currentShellFlavor(platform?)` | `packages/tools/src/lib/platform.ts:28` | `"posix"` or `"powershell"` for a platform |
| `ShellSpec` | `packages/tools/src/shell.ts:5` | `{ flavor, file }` |
| `ShellDeps` | `packages/tools/src/shell.ts:15` | injectable seams for `resolveShell` |
| `killTree(pid, signal, deps?)` | `packages/tools/src/lib/process.ts:78` | kills a whole process tree |
| `ownProcessGroup(platform?)` | `packages/tools/src/lib/process.ts:46` | whether `spawn` should set `detached` |
| `KillDeps`, `TaskkillRunner` | `packages/tools/src/lib/process.ts:11`, `:8` | injectable seams for `killTree` |
| `sweepMonitors(workspaceRoot, options?)` | `packages/tools/src/lib/monitor.ts:320` | GC's finished monitors' sidecar/log/exit files |
| `warn(message, warning?)` | `packages/tools/src/lib/log.ts:89` | emits through the process-wide `WarnSink` |
| `setWarnSink(fn \| null)` | `packages/tools/src/lib/log.ts:112` | installs/clears that sink |
| `NOOP_TOOLS_LOGGER` | `packages/tools/src/lib/log.ts:42` | a `ToolsLogger` that discards every call |
| `ToolsLogger`, `WarnSink`, `ToolsWarning` | `packages/tools/src/lib/log.ts:26`, `:72`, `:58` | the two diagnostics seams |
| `bound(text, maxBytes)` | `packages/tools/src/lib/output.ts:50` | head-truncate with a marker |
| `boundOrSpill(text, maxBytes, spill, logger?, stream?)` | `packages/tools/src/lib/output.ts:380` | tail-truncate, spilling the full text to a file first |
| `createCaptureSink(opts)` | `packages/tools/src/lib/output.ts:231` | bounded-resident, spill-on-overflow stream accumulator |
| `createOutputCoalescer(emit, intervalMs?)` | `packages/tools/src/lib/output.ts:80` | batches a live stream to at most one emit per interval |
| `allocateBudget(aBytes, bBytes, total)` | `packages/tools/src/lib/output.ts:126` | splits a shared byte budget between two streams |
| `CAPTURE_INLINE_FLOOR` | `packages/tools/src/lib/output.ts:157` | `64 * 1024` — smallest resident tail once a sink spills |
| `readLogSlice(logPath, offset, maxBytes)` | `packages/tools/src/lib/logslice.ts:32` | paginated, UTF-8-safe read of a log file |
| `uniqueToken()` | `packages/tools/src/lib/token.ts:13` | pid + epoch-ms + counter + 6 random bytes |
| `bestEffort(operation, run)` | `packages/tools/src/lib/tasks.ts:21` | swallow-and-warn wrapper for cleanup work |

Not exported from any entrypoint (internal to `tools/monitor.ts`/`lib/monitor.ts`): `MonitorMeta`,
`mintId`, `sidecarPath`, `logPath`, `exitPath`, `writeSidecar`, `readSidecar`, `listSidecars`,
`readExitState`, `readExitCode`, `monitorRunning`, `removeMonitorFiles`, `isAlive`,
`monitorDir`, `ensureClarvisDir`, `waitForReady`, `createShell`, `createMonitorStart`,
`createMonitorStop` — these are reached only via relative import inside the package and its tests
(`packages/tools/tests/integration/monitor-lib.test.ts:1-24` imports the lib functions directly;
`packages/tools/tests/component/monitor-spawn.test.ts:6` and
`packages/tools/tests/component/monitor-stop-kill.test.ts:4` import the `create*` factories directly).

### Relevant `RuntimeConfig` fields (`packages/tools/src/config.ts:15-135`)

| Field | Default constant | Default value | File:line |
|---|---|---|---|
| `maxOutputBytes` | `DEFAULT_MAX_OUTPUT_BYTES` | `131072` | `packages/tools/src/config.ts:20`, `:138` |
| `maxShellOutputBytes` | `DEFAULT_MAX_SHELL_OUTPUT_BYTES` | `16384` | `:23`, `:140` |
| `shellTimeoutMs` | `DEFAULT_SHELL_TIMEOUT_MS` | `120000` | `:44`, `:154` |
| `shellTimeoutMaxMs` | `DEFAULT_SHELL_TIMEOUT_MAX_MS` | `600000` | `:47`, `:156` |
| `monitorReadyTimeoutMs` | `DEFAULT_MONITOR_READY_TIMEOUT_MS` | `30000` | `:50`, `:158` |
| `maxMonitors` | `DEFAULT_MAX_MONITORS` | `32` | `:53`, `:160` |
| `stateRoot` | — | (derived) | `:80-89`, resolved at `:503` |
| `temporaryRoots` | — | `[]` | ordered writable temp policy; the first root supplies the command environment, remaining roots are compatibility paths; resolved by `resolveConfig` |
| `skillExecutionRoots` | — | `[]` | host-selected, canonical package directories; validated by `resolveConfig` |
| `gitMetadataPaths` | — | discovered once from a validated linked worktree | `:97-98`, resolved at `:336` |
| `registerTemporaryRoot` | — | closure over the live `temporaryRoots` list | `:100-101`, built at `:405-417` |
| `logger` | — | `NOOP_TOOLS_LOGGER` when unset | `:103-113`, resolved at `:337` |
| `sandbox` | — | `undefined` | `:120-121` |
| `secretEnvNames` | — | `undefined` | `:122-134` |

`ServerConfig` (`packages/tools/src/config.ts:516`) is a type alias of `RuntimeConfig` and is
**not** re-exported from `index.ts`, whose type re-export at `packages/tools/src/index.ts:65` names
only `RuntimeConfig` and `AgentToolsOptions` — tests import it directly from `../../src/config.ts`.

## 3. Data and formats

### Monitor sidecar (`MonitorMeta`, `packages/tools/src/lib/monitor.ts:20-34`)

```json
{
  "id": "mon_1a2b3c4d",
  "command": "npm run dev",
  "cwd": "/abs/workspace/path",
  "pid": 48213,
  "startedAt": 1737400000000,
  "readyWhen": "listening on"
}
```

Serialized whole via `JSON.stringify` and written atomically (`writeSidecar`,
`packages/tools/src/lib/monitor.ts:122-124`, using `writeAtomic` from `lib/atomic.ts`). `id` is minted
by `mintId()` as `mon_` + 8 lowercase hex characters (`packages/tools/src/lib/monitor.ts:62-64`;
pinned by `packages/tools/tests/integration/monitor-lib.test.ts:64-67`, which also asserts two calls
never collide).

### On-disk layout (all under the workspace's machine-local state dir, never the working tree)

| Path builder | Produces | File:line |
|---|---|---|
| `monitorSidecar(id)` | `<state>/local/monitor-<id>.json` | `packages/paths/src/workspace-state.ts:191-192` |
| `monitorLog(id)` | `<state>/local/monitor-<id>.log` | `:189` |
| `monitorExit(id)` | `<state>/local/monitor-<id>.exit` | `:190` |
| `spillFile(token, stream)` | `<state>/local/shell-<token>.<stream>.log` | `:191-192` |
| `toolOutputSpill(token)` | `<state>/local/toolout-<token>.txt` | `:193-194` |

Both streaming shell capture and generic tool-result spill writers create their directories with
`DIR_MODE` and files with `FILE_MODE` (`0600` on POSIX). Production: `createCaptureSink` and
`boundOrSpill` in `packages/tools/src/lib/output.ts`, and `createToolSpill` in
`packages/loop/src/runtime/context/tool-spill.ts`. Test:
`packages/tools/tests/integration/output.test.ts` and
`packages/loop/tests/integration/tool-spill.test.ts`.

`monitorDir(workspaceRoot)` is `workspaceStatePaths(workspaceRoot).localDir`
(`packages/tools/src/lib/monitor.ts:41-43`); `sidecarPath`/`logPath`/`exitPath` are thin wrappers over
the same builders (`:46-59`). `isMonitorSidecar` recognizes exactly the `monitor-*.json` shape
(`packages/paths/src/workspace-state.ts:126-127`) and is what `listSidecars` filters directory entries
by (`packages/tools/src/lib/monitor.ts:187-188`). None of the three monitor files, nor a shell spill,
ever lands inside the workspace root — pinned directly:
`packages/tools/tests/integration/monitor-lib.test.ts:58-62` asserts none of the three built paths
`startsWith(workspacePaths(root).root)`, and
`packages/tools/tests/integration/shell.test.ts:241-252` asserts a spill on a virgin workspace creates
no `.clarvis` directory and leaves the working tree's own listing empty.

The exit sentinel (`<...>.exit`) holds only ASCII decimal digits, optionally signed, capped at
`MAX_MONITOR_EXIT_BYTES = 64` bytes (`packages/tools/src/lib/monitor.ts:13`); the sidecar is capped at
`MAX_MONITOR_SIDECAR_BYTES = 256 * 1024` bytes (`:12`).

### Tool result shapes (all JSON-stringified text)

| Tool | Shape |
|---|---|
| `shell` (success) | `{ exit_code, stdout, stderr, signal, timed_out: false }` (`packages/tools/src/tools/shell.ts:410-417`) |
| `shell` (error) | `ToolError` codes `timeout`/`aborted`/`output_limit`/`io_error`, each carrying `stdout`/`stderr` (`:383-406`, `:420-428`) |
| `monitor_start` | `{ id, running, ready, output, next_offset }` — `ready: null` when no `ready_when` given (`packages/tools/src/tools/monitor.ts:314-324`) |
| `monitor_poll` | `{ running, output, next_offset, exit_code }` (`:395-417`) |
| `monitor_stop` | `{ stopped: true, id }` (`:475-476`) |
| `monitor_list` | `{ monitors: [{ id, command, running, started_at, cwd }, ...] }`, newest-first (`:503-515`) |

### Truncation markers (exact strings the model sees)

- Head-truncated (`bound`): `\n[... output truncated: {end} of {total} bytes shown ...]`
  (`packages/tools/src/lib/output.ts:36-38`).
- Tail-truncated with a spill file named (`tailMarker`):
  `[... earlier output truncated: last {shownBytes} of {total} bytes shown; full output written to
  {spillPath} ...]\n` — the `; full output written to …` clause is omitted when the spill failed
  (`packages/tools/src/lib/output.ts:134-137`).
- `monitor_poll`'s buffered-continuation marker: `\n[... more output buffered; continue with
  offset={nextOffset} ...]` (`packages/tools/src/tools/monitor.ts:386-388`).

An absolute spill path in the shell truncation marker remains usable by a later command, including
after run rehydration. Guard analysis admits only that exact existing regular non-link spill under
the owning workspace's local state directory, while native sandbox execution receives the same file
as a read-only root. This is intentionally not access to `stateRoot` or `localDir`. Production:
`packages/tools/src/lib/state-artifacts.ts`, `packages/tools/src/guard/context.ts`,
`packages/tools/src/tools/shell.ts`, and `packages/tools/src/tools/monitor.ts`. Test:
`packages/tools/tests/integration/guard-dispatch.test.ts`.

### `uniqueToken()` format (`packages/tools/src/lib/token.ts:13-15`)

`${pid}-${epochMs}-${counter++}-${6 random bytes as hex}` — used both for `shell`'s spill filenames
(`spillTarget`, `packages/tools/src/tools/shell.ts:49-56`) and anywhere else a collision-proof suffix
is needed.

## 4. Behavior

### `shell` — one call, blocking (`createShell`/`runCommand`, `packages/tools/src/tools/shell.ts:118-440`)

1. Resolve `cwd` (confined via `resolvePath`) and clamp `timeout_ms` to
   `min(requested, config.shellTimeoutMaxMs, MAX_TIMER_DELAY_MS)` (`:181-194`), where
   `MAX_TIMER_DELAY_MS = 2_147_483_647` is `setTimeout`'s int32 ceiling (`:39`).
2. `statDirectory` confirms `cwd` exists and is a directory before ever spawning (`:196`).
3. `runCommand` builds the sandbox-resolved spec (`sandboxCommand`, delegated — see §7), spawns with
   `stdio: ["ignore", "pipe", "pipe"]` and `detached: ownProcessGroup()` (`runCommand`). The first
   configured temporary root becomes `TMPDIR`, `TEMP`, and `TMP`; every configured root is admitted
   by command analysis, native file tools, Bubblewrap and Seatbelt. The product loop supplies its
   owner-only run scratch first, then `systemTemporaryRoots()` so host-native CLIs that select the
   environment temp or `/tmp` can return paths that remain usable in later calls. The standalone
   library keeps the `[]` default and widens only when its host opts in. Production:
   `RuntimeConfig.temporaryRoots`, `systemTemporaryRoots`, `createShell`, and `sandboxCommand`. Tests:
   `packages/tools/tests/integration/api.test.ts` exercises both run scratch and a bare host-temp
   `mktemp` result, while `packages/loop/tests/integration/command-guard-wiring.test.ts` proves the
   product pre-authorization crosses shell and native tools without transferring parent ownership.
   A POSIX command that instead spells an absolute `mktemp -d /tmp/name-XXXXXX` template is handled
   after execution by `snapshotExplicitTemporaryDirectories` / `createdTemporaryDirectories`: only
   a matching directory absent before the call, not a symlink, and owned by the current uid is
   registered. A standalone caller that did not opt into `systemTemporaryRoots()` still refuses the
   parent; the product loop's compatible parent remains access-only and is never registered for
   cleanup.
   For linked worktrees, the spawn request also carries the canonical Git metadata paths that
   `resolveConfig` pinned at toolset creation; how those paths are mounted is owned by the sandbox
   spec. Production: `packages/tools/src/config.ts:336`,
   `packages/tools/src/tools/shell.ts:241-250`. Test:
   `packages/tools/tests/integration/sandbox.test.ts` (linked-worktree metadata mount posture).
   The same confinement admits `cwd` and analyzed command paths below a selected
   `RuntimeConfig.skillExecutionRoots` entry. A native sandbox mounts each such root read-only;
   without a sandbox this is only path admission plus normal guard/secret filtering, not an
   immutability guarantee for the spawned host process. No selection event spawns a command.
4. Two `CaptureSink`s are created, one per stream, sharing `captureCap = max(config.maxOutputBytes,
   MAX_CAPTURE_FLOOR)` (`MAX_CAPTURE_FLOOR = 8 * 1024 * 1024`, `:37`, `:274`) and `inlineLimit =
   max(config.maxShellOutputBytes, CAPTURE_INLINE_FLOOR)` (`:275`). A sink accumulates in an in-memory
   string until its cumulative `bytes` crosses `inlineLimit`, at which point it lazily asks `opts.spill()`
   once for a target and switches to write-through: every further push both enqueues the chunk to the
   file (a sequential drain queue, `packages/tools/src/lib/output.ts:264-288`) and appends it to a
   bounded `tail` capped at `inlineLimit` bytes (`:290-296`, the mechanism behind invariant 17); the
   write queue itself is bounded only by `captureCap` under a synchronous flood
   (`packages/tools/tests/integration/capture-sink.test.ts:84-91`, "queues rather than drops").
5. Each `data` event first returns early if the sink is already `capped`; otherwise it pushes into the
   live `OutputCoalescer` (if an `onOutput` hook was given) and into the sink *before* checking whether
   that same push crossed `captureCap` (`packages/tools/src/tools/shell.ts:305-315`) — so the chunk
   that causes capping is still fully captured and counted, not dropped preemptively. Only once the
   sink reports `capped` for the first time does `outputLimited` get set and the whole tree killed
   (`:311-314`).
6. A `setTimeout(timeoutMs)` kills the tree and sets `timedOut` on expiry (`:322-325`); an
   `AbortSignal` (if given) does the same on abort (`:300-303`, `:327-330`).
7. On the child's `exit` event, settlement is deferred `STDIO_DRAIN_MS = 100`ms to catch trailing
   output before `close`/`finish` runs (`:38`, `:431-438`); `close` finishes immediately if it fires
   first. `beginSettle()` is one-shot — whichever of `exit`+drain or `close` arrives first wins, the
   other is a no-op (`:340-349`).
8. `finalize` (the injectable `finalizeOutput`) splits the shared `maxShellOutputBytes` budget between
   the two sinks via `allocateBudget` on their *observed* byte counts, then calls `finish(budget)` on
   each (`:95-109`). `allocateBudget(aBytes, bBytes, total)` (`packages/tools/src/lib/output.ts:127-133`)
   is a four-branch rule: if both requests fit within `total`, each keeps its full ask; otherwise
   whichever stream's ask is `<= total / 2` is granted in full and the other takes the remainder; only
   when *both* asks exceed half the total does it split evenly, with the odd byte going to the first
   stream. All four branches are pinned by name in
   `packages/tools/tests/integration/output.test.ts:43-57` ("keeps both when they fit within total",
   "gives a its ask and the rest to b when a is within half", the symmetric case, and "splits evenly
   when both exceed half"). A sink's `finish` spills lazily even when it never crossed `inlineLimit`,
   whenever this per-call budget is smaller than what is buffered inline — falling back to
   `boundOrSpill(inline, budgetBytes, opts.spill(), ...)` (`packages/tools/src/lib/output.ts:333-336`),
   which is exactly what happens when `allocateBudget` starves one stream to grow the other.
9. In priority order, a settled call rejects `aborted`, then `timeout`, then `output_limit`, and only
   otherwise resolves with the JSON success envelope (`:351-418`) — so an abort that also happened to
   overflow the cap is reported as `aborted`, not `output_limit`. `exit_code` in the success envelope
   comes from `computeExit(code, signal)` (`packages/tools/src/tools/shell.ts:64-78`): a normal exit
   returns `code` as-is, and a signalled death maps to `128 + signum` (the shell convention); the
   signal branch is documented as unreachable on Windows, which reports no terminating signal and
   always delivers an exit code (`:71-72`).

`createOutputCoalescer(emit, intervalMs?)` (`packages/tools/src/lib/output.ts:56-112`) is the
`OutputCoalescer` step 5 pushes into. Two constants govern it: `OUTPUT_COALESCE_INTERVAL_MS = 200`
(the default gap between emits — a `push` starts a timer only if one is not already pending, so all
pushes within one interval land in a single `emit`) and `MAX_COALESCED_FLUSH_BYTES = 8192` (an
oversized pending batch is trimmed to its tail on a UTF-8 boundary before the emit, on the reasoning
that the consumer renders a tail anyway). A throwing `emit` callback is swallowed rather than
propagated, and after `settle()` runs, further `push` calls are silent no-ops. All four behaviors are
pinned by name in `packages/tools/tests/integration/output.test.ts:63-112` ("batches pushes within one
interval into a single emit", "starts a fresh batch after each flush", "keeps only the tail of an
oversized batch", "swallows a throwing emit").

### `monitor_start` — background, non-blocking (`createMonitorStart`, `packages/tools/src/tools/monitor.ts:174-327`)

1. Resolve/confine `cwd`; compile `ready_when` into a `RegExp` if given, converting a parse failure
   into `invalid_input` (`compileRegex`, `:40-48`; handler at `:216-235`).
2. Count currently-live monitors (`listSidecars` + `monitorRunning` per entry, `:237-242`); refuse with
   `too_many_monitors` at or above `config.maxMonitors` (`:243-248`).
3. Mint an id, resolve the shell once (`shell()`, threaded into both the wrapper and
   `sandboxCommand` so they can never disagree — `:251-271`), wrap the command with
   `exitCaptureWrapper(command, host.flavor)` (`:256`).
   The same request carries `config.gitMetadataPaths` and the complete ordered temporary-root list,
   exactly as the blocking `shell` path does (`monitor_start`).
   It also carries the same selected skill roots and therefore has the same sandboxed-read-only versus
   unsandboxed-host-process distinction as `shell`.
4. Open the log file for append (`openSync(lp, "a")`), spawn with
   `stdio: ["ignore", fd, fd]` and `env: { ...spec.options.env, MON_EXIT: ep }`, `detached:
   ownProcessGroup()` (`:258-290`). The fd is closed in the parent immediately after spawn (`:296`);
   the child inherits its own copy.
5. A spawn error or a child with no `pid` removes the just-created log file and throws `io_error`
   (`:291-301`); `child.unref()` lets the parent process exit without waiting on it (`:302`).
6. The sidecar is written (`:304-312`). If `ready_when` was given, `waitForReady` polls
   `readLogSlice(logPath, 0, config.maxOutputBytes)` every `READY_POLL_MS = 75`ms
   (`:28`, `:82-110`) until the regex matches, the process dies, or `ready_timeout_ms`/abort fires;
   otherwise the call returns immediately with `ready: null`. Every poll reads the *same* fixed window
   `[0, config.maxOutputBytes)`, never a later slice — the function's own remark states the regex "is
   only ever tested against the first `maxOutputBytes` of output, so a readiness marker beyond that
   window is never observed" (`packages/tools/src/tools/monitor.ts:102-103`).

`isAlive(pid)` (`packages/tools/src/lib/monitor.ts:93-108`) is the liveness probe every check in this
subsystem is built on (`monitor_poll`'s `running`, `monitorRunning`, `monitor_stop`'s escalation
decision). It sends signal 0 via `process.kill(pid, 0)`; a thrown `EPERM` counts as alive (the process
exists but is owned by another user), any other thrown error (e.g. `ESRCH`) counts as dead. On Linux
specifically, a successful signal-0 probe is followed by a read of `/proc/<pid>/stat`, and a `Z`
(zombie) state code there is reported as **not** alive — a check with no Windows counterpart, because
Windows's own signal-0 emulation (`GetExitCodeProcess`/`STILL_ACTIVE`) already reports an
exited-but-handle-held process as gone, the same case the zombie check covers
(`:88-91`, the function's own remarks). Pinned by
`packages/tools/tests/integration/monitor-lib.test.ts:77-79` ("current process alive, bogus pid
dead"), `:82-89` ("isAlive treats EPERM as alive"), and `:91-97` ("isAlive treats ESRCH as dead").

### `monitor_poll` (`packages/tools/src/tools/monitor.ts:343-416`)

1. Read the sidecar (throws `monitor_not_found` if missing/corrupt) and the exit state; `running =
   !exited && isAlive(pid)` (`:350-352`).
2. Read a `readLogSlice` window from `offset` up to `config.maxOutputBytes` (`:353-357`).
3. **Partial-line hold-back**: while still `running`, if the slice does not already end on `more:
   false` and the text contains a newline but does not end with one, the trailing partial line is
   cut off and `nextOffset` is rewound to its start, so a line is never split across two polls
   (`:372-377`).
4. An optional `match` regex (compiled the same way as `ready_when`) filters to matching lines only,
   applied to the (already hold-back-adjusted) text (`:379-384`).
5. If the slice reported `more`, the buffered-continuation marker is appended (`:386-388`) — **after**
   the `match` filter, so the marker is never itself filtered out.
6. `exit_code` is `exitState.code` when `exited`, else `null` — this is `null` both while running and
   when the monitor was killed without a natural exit (no exit file at all).

### `monitor_stop` (`createMonitorStop`, `packages/tools/src/tools/monitor.ts:444-476`)

`(state, event) → (state, effect)`:

| State | Event | Effect |
|---|---|---|
| exited (exit file present) or dead (`!isAlive`) | `monitor_stop` called | no signal sent; files removed; `{stopped:true}` |
| alive | `monitor_stop` called | `SIGTERM` to the tree, wait `STOP_GRACE_MS = 400`ms (`:29`), re-check |
| alive after grace | (escalation) | `SIGKILL` to the tree |
| any | after signalling (or not) | `removeMonitorFiles` unconditionally (`:449`) |

Idempotent by construction: an already-gone or unknown-but-present-file monitor still reaches
`removeMonitorFiles` and reports `stopped: true` (title of
`packages/tools/tests/integration/monitor.test.ts:266-279`). On Windows, `killTree`'s first call
already force-kills (`taskkill /T /F`), so the grace period becomes latency rather than a second real
signal (`packages/tools/src/tools/monitor.ts:439-442`).

### `monitor_list` (`packages/tools/src/tools/monitor.ts:490-514`)

Enumerates every sidecar, recomputes `running` per entry via `monitorRunning` (never trusts a stale
cached flag), and sorts `started_at` descending (`:488`).

### Monitor lifecycle as a whole

| State | How entered | How left |
|---|---|---|
| spawned/running | `monitor_start` succeeds | exit file appears (natural exit) *or* `killTree` succeeds (killed) |
| exited (natural) | child process exits, `exitCaptureWrapper`'s trap/`finally` writes `$MON_EXIT` | `monitor_stop` (files removed) *or* `sweepMonitors` after `MONITOR_MAX_AGE_MS = 24h` past the exit file's mtime (`packages/tools/src/lib/monitor.ts:303-308`, `:331-332`) |
| killed (no exit file) | `monitor_stop`'s `SIGKILL`, or an external kill | `sweepMonitors` reaps immediately — no completion timestamp to preserve (`:303-306`, `:318`) |
| gone (files removed) | `monitor_stop` or `sweepMonitors` | terminal |

`sweepMonitors(workspaceRoot, options?)` (`packages/tools/src/lib/monitor.ts:320-341`) lists sidecars
via `listSidecars(workspaceRoot, options.maxEntries ?? 10_000)` — a default cap of 10,000 entries — and
reaps each non-running one per the table above, run by a bounded worker pool: `Math.min(Math.max(1,
options.concurrency ?? 4), metas.length)` workers pull from a single shared index in a loop, so the
default concurrency is 4 regardless of how many sidecars exist, and never more workers than there are
entries to process.

### `resolveShell` / `shellArgs` / `exitCaptureWrapper` derivation (`packages/tools/src/shell.ts`)

`currentShellFlavor(platform)` (`packages/tools/src/lib/platform.ts:28-30`) is the single source both
the executor and the guard's analyzer derive from — the `ShellFlavor` type's own doc comment states
the two selections (transport and analyzer dialect) "must never disagree - a guard that analyzes
POSIX while PowerShell runs produces no error and no failing test, it just decides wrong"
(`packages/tools/src/lib/platform.ts:6-8`). `currentShellFlavor`'s own remarks give the reason it is
not a separate setting: a configurable shell plus a configurable analyzer flavor would make that
mismatch expressible, and deriving both from one function "makes that state unrepresentable rather
than merely discouraged" (`packages/tools/src/lib/platform.ts:20-26`).
`computeShell` (`packages/tools/src/shell.ts:52-61`): non-`win32` always yields `{flavor:"posix",
file:"sh"}`; on `win32` it prefers `pwsh` (via `executableOnPath(..., "win32", ".EXE")`, only `.EXE`
considered), falling back to the fixed `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
path. Called with no `deps`, the result is memoized process-wide in `cachedShell`; called with `deps`,
it is recomputed and never cached (`:83-86`), so an injected call can never poison the shared memo
(pinned by `packages/tools/tests/unit/shell.test.ts:63-70`).

`shellArgs` (`:119-122`): POSIX gets `["-c", command]` verbatim; PowerShell gets `["-NoProfile",
"-NonInteractive", "-EncodedCommand", encodePowerShellCommand(command)]` — the whole command is
base64, so it never meets the Windows command-line tokenizer at all (`:94-99`).
`encodePowerShellCommand` (`:101-102`) prepends a fixed UTF-8-forcing `POWERSHELL_PREAMBLE`
(`:47-48`) ahead of the raw command, then encodes `preamble\ncommand` as UTF-16LE→base64. Three design
points the source states explicitly and this document had not surfaced:

- The preamble's encoder is built as `New-Object System.Text.UTF8Encoding $false` rather than taken
  from `[Text.Encoding]::UTF8`, because the latter is a `UTF8Encoding(true)` and would prepend a
  byte-order mark to stdout, breaking every assertion on exact output (`:43-45`). Pinned by
  `packages/tools/tests/unit/shell.test.ts:96-103`, "forces BOM-less UTF-8 on both stream directions
  before running anything".
- `cmd.exe` is unsupported on the same reasoning that rules out a configurable analyzer flavor: it has
  no `-EncodedCommand` equivalent, so every command would have to survive its non-composable quoting,
  and it offers no dependable exit status across a chained command (`:78-81`).
- Neither `-ExecutionPolicy Bypass` nor `$ErrorActionPreference = 'Stop'` is set on the PowerShell
  invocation: the first would widen what runs beyond the machine's own policy for any `.ps1` the
  payload invokes, and the second would abort a payload on a non-terminating error, diverging from
  `sh -c` where only the last command's status matters (`:112-117`).

`exitCaptureWrapper` (`:155-174`): POSIX installs an `EXIT` trap that writes `$?` to a `.tmp` sibling
and renames it onto `$MON_EXIT` (same-directory rename, atomic on both platforms — the two-step
write-then-rename exists specifically so a poller never observes a truncated, not-yet-written exit
file, per the function's own remarks at `:143-149`). PowerShell wraps the command in `try {…} finally
{…}`, testing `$?` *before* `$LASTEXITCODE` (`:166`) because `$LASTEXITCODE` is sticky across the whole
payload once any native command has run — reversing the order would make an unrelated earlier
command's status leak into the reported exit code (`:136-141`; pinned by
`packages/tools/tests/unit/shell.test.ts:128-135`, "tests $? before $LASTEXITCODE").

### Debug log events

Four structured `logger.debug` events, each carrying a remark quoted nowhere else in this document:

| Event | File:line | Remark |
|---|---|---|
| `tools.shell_spawn` | `packages/tools/src/tools/shell.ts:244-255` | "a shell command is being spawned; everything it does from here is attributed to this process group" |
| `tools.shell_exit` | `packages/tools/src/tools/shell.ts:369-382` | "a shell command settled; the trace keeps its output as opaque text and indexes none of these" |
| `tools.monitor_spawn` | `packages/tools/src/tools/monitor.ts:270-281` | "a background monitor is being spawned with both streams redirected into one log; this is the write side of the pair that decides whether output can be captured at all" |
| `tools.monitor_poll` | `packages/tools/src/tools/monitor.ts:381-390` | "a monitor was polled; this is the read side of the pair — zero bytes against a running monitor means the capture never happened, not that the command is quiet" |

The `monitor_spawn`/`monitor_poll` pair's remarks directly name the Windows redirected-stdio gap in
§6: `monitor_spawn` is the write side that decides whether capture is possible at all, and
`monitor_poll`'s zero-bytes-means-capture-never-happened remark is what a caller sees when that write
side has silently failed.

## 5. Invariants

1. **The `shell`/`monitor_*` tools are never advertised or dispatchable on the read-only surface.**
   Production: `packages/tools/src/tools/registry.ts:53-57` (`readOnly: false` for all five). Test:
   `packages/loop/tests/architecture/agent-tool-wire-names.test.ts:29-32` ("excludes shell and the
   monitors, which observe and mutate through one entry point" — a cross-package test in `@clarvis/loop`
   that independently pins the same classification this package's registry encodes).

2. **No production module in this package's `src/` writes to `process.stderr`, `process.stdout`, or
   any `console.*` method, except `lib/log.ts`; inside that one module, `process.stderr` is written
   exactly once and neither `console.*` nor `process.stdout` appears at all.**
   Production: `packages/tools/src/lib/log.ts:75-77`.
   Test: `packages/tools/tests/architecture/logging-channel.test.ts:48` (forbidden-pattern sweep) and
   `:60-65` (exact-count check on the sanctioned module).

3. **The default `WarnSink` writes to `process.stderr`; installing a custom sink via `setWarnSink`
   fully replaces it until `setWarnSink(null)` restores the default.**
   Production: `packages/tools/src/lib/log.ts:75-77`, `:112-114`.
   Test: `packages/tools/tests/unit/log.test.ts:17-46`.

4. **`ownProcessGroup` returns `true` on every non-`win32` platform and `false` on `win32`, and
   `spawn`'s `detached` option is never passed unconditionally — both `shell` and `monitor_start`
   compute it via this function immediately before spawning.**
   Production: `packages/tools/src/lib/process.ts:46-48`; call sites
   `packages/tools/src/tools/shell.ts:243`, `packages/tools/src/tools/monitor.ts:269`.
   Test: `packages/tools/tests/unit/process.test.ts:6-14`.

5. **`killTree` on POSIX addresses the process group as `-pid`, falling back to the bare `pid` only
   when the group signal itself throws; on Windows it always uses `taskkill /T /F` (force, no
   softer signal), falling back to a direct `process.kill` only if `taskkill` fails, and reports
   `false` only when every attempt fails.**
   Production: `packages/tools/src/lib/process.ts:78-109`.
   Test: `packages/tools/tests/unit/process.test.ts:17-98` (POSIX group-first-then-fallback at
   `:26-42`; Windows always-force at `:63-73`; both-fail → `false` at `:89-97`).

6. **`resolveShell()` called with no arguments memoizes its answer process-wide; called with any
   `deps`, it recomputes and never writes to or reads from that memo.**
   Production: `packages/tools/src/shell.ts:83-86`.
   Test: `packages/tools/tests/unit/shell.test.ts:63-70`.

7. **`exitCaptureWrapper`'s PowerShell branch tests `$?` strictly before `$LASTEXITCODE` in the
   emitted script text.** Reversing the order would make a sticky `$LASTEXITCODE` from an earlier
   native command in the same payload override the payload's actual final status.
   Production: `packages/tools/src/shell.ts:166` (the ordering in the emitted lines).
   Test: `packages/tools/tests/unit/shell.test.ts:128-135`.

8. **`shellArgs`'s PowerShell branch never lets any character of the raw command reach the Windows
   command-line tokenizer** — the entire payload, preamble included, is base64.
   Production: `packages/tools/src/shell.ts:101-102`, `:119-122`.
   Test: `packages/tools/tests/unit/shell.test.ts:84-89` (`payload` matches only base64 alphabet even
   for a command full of shell metacharacters).

9. **A monitor's exit file, sidecar, and log never resolve inside the workspace root.**
   Production: `packages/paths/src/workspace-state.ts:178-200` (`localDir` under the global state
   root, not the workspace).
   Test: `packages/tools/tests/integration/monitor-lib.test.ts:58-62`; also
   `packages/tools/tests/integration/shell.test.ts:241-252` for a shell spill.

10. **`monitorRunning` trusts the exit sentinel over a live pid check** — once the exit file exists,
    the monitor is reported not-running even if its (possibly reused) pid still answers `isAlive`.
    Production: `packages/tools/src/lib/monitor.ts:271-279` (exit-file check first, `isAlive` only as
    the else branch — see §4's `isAlive` paragraph for what that probe itself checks).
    Test: `packages/tools/tests/integration/monitor-lib.test.ts:183-189` ("trusts the exit sentinel
    over a live (reused) pid").

11. **`sweepMonitors` reaps a monitor with no exit file immediately (no grace period), and reaps a
    naturally-exited monitor only once its exit file's mtime is older than `MONITOR_MAX_AGE_MS` (24h);
    a monitor that exited within that window, or is still alive, is left untouched.**
    Production: `packages/tools/src/lib/monitor.ts:303-341`.
    Test: `packages/tools/tests/integration/monitor-lib.test.ts:191-230` (reaps a stale exit past 24h
    at `:191-200`, preserves a fresh exit at `:202-210`, removes a dead/no-exit monitor while keeping
    a live one at `:222-230`).

12. **`readLogSlice` never returns a slice with a trailing incomplete UTF-8 sequence, except when the
    entire requested window would otherwise be empty — in that one case it keeps every byte rather
    than returning nothing.**
    Production: `packages/tools/src/lib/logslice.ts:60-78`.
    Test: `packages/tools/tests/integration/logslice.test.ts:83-127` (multi-byte cut-boundary cases;
    "still makes progress when a single char is larger than the budget" at `:115-120`).

13. **`readLogSlice` reads size and bytes from the same open file descriptor**, so a rename/replace
    racing the read cannot observe a size from one file and bytes from another.
    Production: `packages/tools/src/lib/logslice.ts:37-58` (one `handle`, `stat()` at `:45` then
    `handle.read()` on the same handle at `:58`).
    Test: `packages/tools/tests/integration/logslice.test.ts:37-48` ("takes size and bytes from the
    same descriptor after a pathname race").

14. **`monitor_poll` holds back a trailing partial line (no final newline) while the monitored process
    is still running, and rewinds `next_offset` to its start** — a caller never sees a line split
    across two polls while the source is live.
    Production: `packages/tools/src/tools/monitor.ts:395-400`.
    Test: `packages/tools/tests/integration/monitor.test.ts:314-333` (`.skipIf(!monitorCapturesOutput)`)
    and the complementary "emits a final partial line once the process is dead" at `:335-347`.

15. **`monitor_poll`'s `match` filter is applied after the partial-line hold-back and before the
    "more output buffered" marker is appended**, so the marker itself is never subject to the filter.
    Production: `packages/tools/src/tools/monitor.ts:392-411` (order of operations).
    Test: `packages/tools/tests/integration/monitor.test.ts:442-463` ("keeps matching lines and pages
    forward when output overflows the byte cap" — the marker survives alongside filtered lines).

16. **`shell`'s settlement priority is `aborted` > `timeout` > `output_limit` > success** — an abort
    that also overflowed the capture cap is reported as `aborted`, never `output_limit`.
    Production: `packages/tools/src/tools/shell.ts:362-388` (the `if` chain's order).
    Test: unpinned directly for the triple-overlap case; `packages/tools/tests/integration/shell.test.ts`
    exercises `aborted` (`:171-192`), `timeout` (`:128-154`) and `output_limit` (`:294-309`)
    individually but no single test forces all three conditions simultaneously to assert the
    priority order.

17. **A `CaptureSink` never holds more than `inlineLimit` bytes resident once it has started spilling**
    — the accumulated text is flushed to a file and only a trailing `inlineLimit`-byte tail is kept
    in memory afterward, except for the write queue, which is bounded only by `captureCap` under a
    synchronous flood.
    Production: `packages/tools/src/lib/output.ts:198-230` (the function's own remarks state the queue
    caveat explicitly), `:290-296` (`appendTail` truncates `tail` to `inlineLimit`).
    Test: `packages/tools/tests/integration/capture-sink.test.ts:62-75` ("writes every observed byte
    to the spill file while holding only a bounded tail" — tracks peak `residentBytes` across 40
    pushes and asserts `peak <= INLINE * 2` and `peak < 40_000`) pins the bound directly; `:84-87`
    ("queues rather than drops when a synchronous burst outruns the write") pins the queue caveat,
    asserting `residentBytes` *exceeds* `INLINE * 2` under a synchronous flood — exactly the caveat
    above. `CaptureSink.residentBytes` is exposed "for tests" (`packages/tools/src/lib/output.ts:195`),
    and this is the file that reads it.

18. **A failed spill degrades to a bare tail with no file reference, never an exception** — both
    `boundOrSpill` and `createCaptureSink`'s internal spill path catch the write failure, log through
    `logger.warn`, and still return/finish with the truncated tail.
    Production: `packages/tools/src/lib/output.ts:390-406` (`boundOrSpill`'s catch branch),
    `:252-262` + `:275-279` (`createCaptureSink`'s `spillFailed`/`drain` catch).
    Test: `packages/tools/tests/integration/output.test.ts:174-187` ("falls back to the plain
    truncation marker when the spill write fails").

19. **`monitor_start` refuses to start once live monitors reach `config.maxMonitors`, and a slot frees
    the instant a monitor's liveness (not its file presence) drops** — a finished-but-not-yet-swept
    monitor does not count against the limit.
    Production: `packages/tools/src/tools/monitor.ts:236-248` (liveness computed fresh per call via
    `monitorRunning`, not from any cached count).
    Test: `packages/tools/tests/integration/monitor.test.ts:300-312` (refusal at the limit),
    `:501-516` ("frees a monitor slot once a monitor exits").

20. **No model-facing refusal message in this package's source tells the model how to lift the
    restriction it just hit** (a "set/pass/export/use … to permit/allow/disable/bypass/override" or
    `FOO=1 to permit` shape) — this constrains, among others, `monitor_start`'s `too_many_monitors`
    message, which instead names a legitimate action (`monitor_stop`).
    Production: `packages/tools/src/tools/monitor.ts:243-247` (the actual message: "stop some with
    monitor_stop first" — an instruction to use another tool, not to lift a restriction).
    Test: `packages/tools/tests/architecture/no-bypass-hints.test.ts:81` (package-wide sweep; not
    specific to monitor but covers this file).

21. **The dispatcher never re-clamps a `bounded: true` tool's text output to `maxOutputBytes`** — all
    five tools in this subsystem set `bounded: true`, so their own internal bounding (via `bound`,
    `boundOrSpill`, or a `CaptureSink`) is the only truncation that ever applies to them.
    Production: `packages/tools/src/core.ts:79-85` (`boundParts` returns `parts` unchanged when
    `bounded` is truthy); tool declarations at `packages/tools/src/tools/shell.ts:150`,
    `packages/tools/src/tools/monitor.ts:187`, `:350`, `:453`, `:495`.
    Test: unpinned by a dedicated bounded-vs-unbounded comparison test in this document's scope; the truncation
    behavior itself is exercised in `packages/tools/tests/integration/output.test.ts:200-212`, but
    without a control case that disables `bounded` to show the dispatcher would otherwise re-clamp.

22. **Selected skill package roots widen command path/cwd admission, not automatic execution or bare
    host isolation.** `buildGuardContext` adds only the exact roots for `shell` and `monitor_start`;
    `resolveConfig` adds them to sandbox read-only mounts. If no native sandbox is active, the child
    remains an ordinary secret-scrubbed host process and can write whatever its operating-system
    identity permits. Production: `packages/tools/src/guard/context.ts`, `config.ts`, `tools/shell.ts`,
    and `tools/monitor.ts`. Tests: `packages/tools/tests/integration/api.test.ts` and `config.test.ts`.

23. **A host-native temporary path remains usable across tool calls without making its parent
    run-owned.** The loop puts `systemTemporaryRoots()` after the run scratch in `temporaryRoots`;
    shell and monitor pass the complete list to `sandboxCommand`, while teardown tracks a separate
    owned set. Production: `packages/tools/src/tools/shell.ts`, `tools/monitor.ts`,
    `sandbox.ts` (`systemTemporaryRoots`, `sandboxCommand`), and
    `packages/loop/src/runtime/capabilities/tools.ts` (`accessibleTemporaryRoots`,
    `ownedTemporaryRoots`). Tests: `packages/tools/tests/integration/api.test.ts` (`reuses a bare
    mktemp result from the host temp root in a later native tool`) and
    `packages/loop/tests/integration/command-guard-wiring.test.ts` (`preauthorizes the host temp
    across shell and native tools without owning its parent`).

## 6. Failure modes and degradation

| Failure | Where handled | Result |
|---|---|---|
| Spawn throws synchronously (`shell`) | `packages/tools/src/tools/shell.ts:261-264` | `ToolError("io_error", "Failed to spawn command: …")` |
| Spawn throws synchronously (`monitor_start`) | `packages/tools/src/tools/monitor.ts:288-292` | log fd closed, log file removed, `ToolError("io_error", "Failed to spawn monitor: …")` |
| Spawned child never gets a pid (`monitor_start`) | `:272-275` | log file removed, `ToolError("io_error", "… process has no pid")` |
| A monitor child emits `error` after a successful spawn (`monitor_start`) | `packages/tools/src/tools/monitor.ts:294` | `child.on("error", () => {})` — a completely silent no-op; no log call, no sidecar update, nothing surfaced to the caller. Not exercised by any test in this document's scope |
| Child `error` event (`shell`) | `packages/tools/src/tools/shell.ts:404-408` | both sinks disposed (best-effort, errors swallowed), `ToolError("io_error", "Failed to run command: …")` |
| `finalizeOutput` rejects (`shell`) | `:387-389` | `ToolError("io_error", "Failed to finalize output: …")` |
| Wall-clock timeout | `:302-305`, `:355-364` | tree `SIGKILL`ed, `ToolError("timeout", …)` carrying partial `stdout`/`stderr` |
| `AbortSignal` fires | `:280-283`, `:350-353` | tree `SIGKILL`ed, `ToolError("aborted", …)` carrying partial `stdout`/`stderr` |
| One stream exceeds `captureCap` | `:291-294`, `:366-375` | tree `SIGKILL`ed, `ToolError("output_limit", …)` naming `max_capture_bytes` |
| Spill file write fails (either `boundOrSpill` or `CaptureSink`) | `packages/tools/src/lib/output.ts:390-406`, `:252-262` | degrades to a bare tail marker with no file reference; logged via `logger.warn` at event `tools.spill_failed` |
| Monitor sidecar missing/corrupt/wrong-shape/oversized | `packages/tools/src/lib/monitor.ts:135-157` | `ToolError("monitor_not_found", …)` — indistinguishable from a monitor that never existed |
| Monitor exit sentinel unreadable/non-numeric/out-of-range | `:221-249` | `{exited: true, code: null}` — logged at `tools.monitor_exit_unreadable`; "indistinguishable from a killed process" per the function's own remark (`:229`) |
| Monitor exit sentinel too-large or not-a-file | `:239-241` | same as above (treated as present-but-unreadable, not absent) |
| Invalid `ready_when`/`match` regex | `packages/tools/src/tools/monitor.ts:63-71` | `ToolError("invalid_input", …)` naming the offending field |
| `maxMonitors` reached | `:219-225` | `ToolError("too_many_monitors", …)` |
| `killTree` cannot signal anything | `packages/tools/src/lib/process.ts:81-87` | returns `false`; logged at `tools.kill_tree_failed`; every caller (`shell`'s `killAll`, `monitor_stop`) falls back to a direct `child.kill`/no further action rather than throwing |
| `taskkill` binary absent/fails on a non-Windows test host | `packages/tools/src/lib/process.ts:88-97` | falls back to `process.kill(pid, "SIGKILL")`; if that also throws, `false` |
| Monitor process ignores `SIGTERM` | `packages/tools/src/tools/monitor.ts:465-471` | after `STOP_GRACE_MS`, escalates to `SIGKILL` |
| **Windows: `monitor_start`'s redirected stdio never captures output at all** | not handled — an open defect | `packages/tools/tests/helpers/fixtures.ts:266-282` (`monitorCapturesOutput`) documents this as the write side failing silently: "the log is empty, not merely differently encoded"; `shell` is unaffected because it captures over pipes, not an inherited descriptor. The tool's own doc comment (`packages/tools/src/tools/monitor.ts:164-171`) independently records that establishing which side (write vs. read) fails took "an abandoned two-handle experiment" and that a `running` monitor whose poll reports zero bytes is this defect surfacing, not a quiet command |
| Non-`ToolError` throw anywhere in a handler | `packages/tools/src/errors.ts:65-76` | collapsed to a generic `{error:"internal", message:"internal error"}`; the real detail (stack or message) goes only to the warn sink at `tools.internal_error` |
| A descendant is re-parented before `killTree` walks the tree | `packages/tools/src/lib/process.ts:66-72` | escapes the kill on both platforms, from opposite directions — acknowledged, unmitigated, by the function's own remark: "Both have the same hole from opposite directions: a descendant whose intermediate parent has already exited is re-parented and escapes the walk, exactly as `setsid` detaches a child from its group on POSIX. Closing it on Windows would take a Job Object, which is deliberately out of scope." Not handled by any timeout/abort/output_limit/`monitor_stop` path, all of which rely on `killTree` |

Every one of `shell`'s and `monitor_start`'s process-kill paths (`timeout`, `abort`, `output_limit`,
`monitor_stop`'s escalation) goes through `killTree`, never a bare `child.kill()` first — `shell`'s
`killAll` only falls back to `child.kill("SIGKILL")` when `killTree` itself reports `false`
(`packages/tools/src/tools/shell.ts:285-290`).

## 7. Coupling

**What this subsystem depends on (runtime, static import):**

- `@clarvis/paths` — `ensureWorkspaceLocalDir`, `workspaceStatePaths`, `isMonitorSidecar` from
  `packages/tools/src/lib/monitor.ts:4`; `executableOnPath` from `packages/tools/src/shell.ts:2`.
  Forced by the paths package being this package's *only* internal `dependencies` entry
  (`packages/tools/package.json:79-84`); nothing in `lib/monitor.ts` or `shell.ts`
  spells `.clarvis`/`.agents` directly (that literal is `@clarvis/paths`'s alone, enforced repo-wide
  by `packages/paths/tests/architecture/invariant.test.ts`, outside this document's scope).
- `../sandbox.ts` (`sandboxCommand`) — both `packages/tools/src/tools/shell.ts:18` and
  `packages/tools/src/tools/monitor.ts:24` import it to build the actual spawn spec (file/args/env,
  possibly native-sandbox-wrapped). Both pass the pinned `gitMetadataPaths` and complete
  `temporaryRoots`; the former makes linked-worktree Git metadata available without re-reading a
  mutable `.git` pointer, while the latter supplies primary run scratch plus compatible system
  roots. Sandboxed execution
  itself is **out of this document's scope** (see the [sandbox-and-toolchains](sandbox.md) document); this
  subsystem only threads a resolved `ShellSpec` into it so the wrapper and the executor can never
  disagree on shell flavor (`packages/tools/src/tools/monitor.ts:255-271`).
- `../guard/context.ts` (`buildGuardContext`) is used by `core.ts`'s `applyGuard`
  (`packages/tools/src/core.ts:156-192`), not by `shell.ts`/`monitor.ts` directly — whether a `shell`
  or `monitor_start` call is allowed at all is decided upstream of the handler, by the
  [command-guard-and-approval](command-guard.md) document's machinery. `RuntimeConfig.guard`/`.elicit`
  (`packages/tools/src/config.ts:115-119`) are the seam; this document's handlers never reference them.
- `../core.ts`'s `dispatch`/`boundParts` — the dispatcher (not the handler) is what makes `bounded:
  true` mean "do not re-clamp" (`packages/tools/src/core.ts:79-85`); this document's tools only declare
  the flag.

**What depends on this subsystem:**

- `@clarvis/loop` (`packages/loop/src/runtime/build-run-deps.ts:541-564`) dynamically imports
  `@clarvis/tools` and calls `setWarnSink`, bridging the global `warn()` singleton's call sites —
  `bestEffort`'s failures in `lib/tasks.ts`, plus the two named in `lib/log.ts`'s own doc comment as
  the ones with no `RuntimeConfig` in scope: `serializeError` (`packages/tools/src/errors.ts`) and the
  `.gitignore` loader (`packages/tools/src/lib/ignore.ts`) — into the host's own structured `Logger`
  (`packages/tools/src/lib/log.ts:6-9`). This is a **separate seam** from `spillFailed`
  (`lib/output.ts`), `kill_tree_failed` (`lib/process.ts`) and every other `logger.warn` call in this
  document's failure-modes table: those reach a host through the per-toolset `RuntimeConfig.logger`
  (set independently, at capability construction), never through `warn()`/`WarnSink`. Grepping `src/`
  confirms only `errors.ts`, `lib/ignore.ts` and `lib/tasks.ts` import `warn` from `./log.ts` anywhere
  in the package; `lib/output.ts`, `lib/monitor.ts` and `lib/process.ts` import only
  `NOOP_TOOLS_LOGGER`/`ToolsLogger`. This is a **runtime, dynamic** edge (`importOptional`), not a
  static import, consistent with `tools` being one of the loop's `optionalDependencies`.
- `@clarvis/kernel` (`packages/kernel/src/file-kernel.ts`, `createFileKernel`'s
  `WorkspaceHousekeeping` construction) statically imports
  `sweepMonitors` from `@clarvis/tools` and schedules it (alongside `@clarvis/paths`'s
  `sweepSpillDir`) inside a `WorkspaceHousekeeping` instance (`:909-913`) — a static, direct call, not
  behind the loop's optional-package machinery.
- `@clarvis/loop`'s `agent-tool-wire-names.test.ts` (see invariant 1) reads this package's tool
  classification indirectly, through `@clarvis/loop`'s own `READ_ONLY_TOOL_NAMES`/`AGENT_TOOL_NAMES`
  vocabulary — a **type-only/name-only** coupling asserted by a test in the consumer, not an import
  from `@clarvis/loop` back into `@clarvis/tools`.
- `packages/tools/src/index.ts` re-exports nearly everything in the "Surface" tables above; any host
  consuming the package's `.` entrypoint gets `resolveShell`/`shellArgs`/`killTree`/`ownProcessGroup`/
  `setWarnSink` etc. directly. `./shell` (`src/shell-entry.ts`) re-exports the identical shell/process
  symbol set alone, which is what lets `@clarvis/hooks` depend on shell-spawning semantics
  without pulling in the whole tool registry: `packages/hooks/src/subprocess.ts:20`-`26` imports
  `killTree`, `ownProcessGroup`, `resolveShell` and `shellArgs` from `@clarvis/tools/shell` and
  nothing else from this package, and `packages/tools/src/shell-entry.ts:1`-`16` names that consumer
  as the subpath's reason to exist.

## 8. Open questions

- **Whether invariant 16's priority order (`aborted` > `timeout` > `output_limit`) is actually
  exercised by any test when all three conditions coincide in one call.** Each condition has its own
  dedicated test, but no test in `packages/tools/tests/integration/shell.test.ts` constructs a
  scenario where a call is both aborted and has overflowed its capture cap at settlement time. The
  `if` chain's order (`packages/tools/src/tools/shell.ts:362-388`) is the only evidence for the
  priority; it is unpinned by a targeted regression test.

- **A discrepancy between a comment and the code it sits beside**: `lib/tasks.ts`'s `bestEffort` doc
  comment says "The sink is installed by the host and defaults to discarding"
  (`packages/tools/src/lib/tasks.ts:13`), but `lib/log.ts`'s own default `WarnSink` writes to
  `process.stderr` (`packages/tools/src/lib/log.ts:75-77`), and
  `packages/tools/tests/unit/log.test.ts:34-46` explicitly asserts that restoring the default sink
  (`setWarnSink(null)`) makes a warning reach `process.stderr`, not nowhere. The comment appears to
  describe the *effective* behavior once a host (e.g. `@clarvis/loop`, see §7) has installed its own
  sink, but taken literally about the package's own default it is inaccurate. Not something this document
  can resolve from the code — it is a documentation/behavior mismatch to flag, not a bug in either
  direction of runtime behavior.

- **Why `STOP_GRACE_MS` is exactly `400`, `READY_POLL_MS` is exactly `75`, `MONITOR_MAX_AGE_MS` is
  exactly 24 hours, or `MAX_CAPTURE_FLOOR` is exactly 8 MiB.** These constants
  (`packages/tools/src/tools/monitor.ts:39-52`, `packages/tools/src/lib/monitor.ts:303`,
  `packages/tools/src/tools/shell.ts:32`) are used consistently and some have comments explaining
  *what* they do, but none of the read files states *why* those specific magnitudes were chosen over
  another value in the same order of magnitude.

- **The exact shape and content of `spec.options` and how `sandboxCommand` decides between a bare
  spawn and a native-sandbox-wrapped one** is out of this document's scope (owned by
  [sandbox-and-toolchains](sandbox.md)); this document only establishes that `shell.ts`/`monitor.ts` call into it
  and thread a pre-resolved `ShellSpec` through.

- **The full command-guard decision path** (`applyGuard`, `buildGuardContext`, the `Guard`/`Elicit`
  ports) is out of this document's scope (owned by [command-guard-and-approval](command-guard.md)); this document only
  establishes that `dispatch` — not `shell.ts`/`monitor.ts` — is where that gate runs, ahead of any
  handler in this subsystem.

- **How `@clarvis/code` renders a `shell`/`monitor_*` result to the terminal**, including the
  documented "shell's renderer must not treat its error as a second stream" behavior, is out of this
  document's scope (owned by [code-transcript-and-tool-rendering](../hosts/code-transcript.md)); nothing in `packages/tools/src` reaches
  into `@clarvis/code`.

- **Whether any host other than `@clarvis/loop` installs a `WarnSink`** — this document's scope shows exactly
  one call site (`packages/loop/src/runtime/build-run-deps.ts:543-564`); whether `@clarvis/server` or
  a bare `createAgentTools` consumer does anything with the default `stderr` sink is not visible from
  this package's own source.
