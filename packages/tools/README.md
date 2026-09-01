# `@clarvis/tools`

Workspace-aware coding tools for LLM agents. The package can be used as a plain
TypeScript library. Its only internal dependency is `@clarvis/paths` — the
dependency-free directory-vocabulary leaf — from which it also re-exports
`executableOnPath` / `resolveCommand`.

> Private, unversioned workspace. The root manifest owns the Clarvis product version; this package
> is not published independently.

## Contract

The tool surface and dispatcher contract are specified in
[`execution/tools-contract.md`](../../specs/execution/tools-contract.md), with focused contracts for
[`reads and search`](../../specs/execution/tools-read-and-search.md),
[`mutation`](../../specs/execution/tools-mutation.md), and
[`shell and monitors`](../../specs/execution/tools-shell-and-monitor.md). Approval analysis and the
host sandbox boundary are specified in
[`execution/command-guard.md`](../../specs/execution/command-guard.md) and
[`execution/sandbox.md`](../../specs/execution/sandbox.md).

## What it provides

- File operations: read, batch read, image read, write, edit, multi-edit, patch,
  copy, move, mkdir, remove and stat.
- Discovery: directory listing, tree, glob, grep and diff.
- Project-wide regular-expression replacement.
- Shell execution and background-process monitors.
- Guard-reviewed, argv-only host execution when the sandbox lacks required host capabilities.
- Read-only and workspace-confined surfaces.
- A guard contract and shell analysis helpers for approval policies.
- Bounded output with spill files for large results.

Spill names and their 24-hour collector are owned by `@clarvis/paths`; this
package writes those paths at owner-only `0600` permissions but does not export the collector. Monitor cleanup
remains tools-specific and runs when the tools capability is installed, even if
that capability is disabled for a particular run by environment.

`apply_patch` recommends the model-familiar `*** Begin Patch` envelope with `Update File`, `Add
File`, `Delete File`, and optional `Move to` blocks. It also accepts raw `---`/`+++` unified diffs.
Both forms share the same confinement, complete path locking, UTF-8 checks, and atomic multi-file
commit; a failed hunk changes nothing. The guard extracts paths from both grammars, including move
destinations. Numbered model-envelope hunks honor their old-file coordinates after adjusting for
earlier hunks, with a three-line tolerance for small drift; this also makes coordinate-only
insertions and duplicate context deterministic.

A later `read_file` or `read_files` call may read an overflow artifact whose absolute path was reported by
an earlier tool call, including one restored from a previous run. A `shell` or `monitor_start`
command receives the same exception only when its configured sandbox can expose the file read-only.
This is an exact-file exception, not state-directory access: Clarvis admits only an existing,
regular, non-link spill directly under this workspace's machine-local state directory. Prompt
history, monitor controls, other state files and another workspace's spills remain outside
confinement. POSIX `/dev/null` is treated as the null device,
not as an escaping host file, so ordinary output-discard redirections do not create false denials.

Text reads open one descriptor non-blocking, reject non-regular files from that descriptor, and
read at most `MAX_FILE_BYTES + 1`. The extra byte detects a file that grows after its initial stat;
the same bound feeds `read_file`, batch reads and the in-process grep path. FIFOs/devices therefore
cannot park the event loop and a concurrent path replacement cannot turn a validated small file into
an unbounded allocation.

The same descriptor-first rule covers ignore sources, `file_stat`, monitor logs and monitor control
records. Ignore files cap at 1 MiB, monitor metadata at 256 KiB and exit sentinels at 64 bytes;
non-regular inputs are ignored or rejected according to that surface's existing error contract.
Single-file ripgrep searches receive the already-bounded snapshot on stdin, so the subprocess never
reopens a pathname after validation. Confined directory searches always use the in-process scanner:
passing the mutable directory pathname to a subprocess would let a concurrent parent-link swap escape
the read boundary. Directory ripgrep is available only when the host explicitly disables workspace
confinement.

Discovery and mutation have independent pre-materialization ceilings. One walk
retains at most 50,000 entries; `list_dir`, `tree`, `glob`, in-process grep and
project replacement stop at that budget and surface an incomplete result where
their result shape permits it. A replacement transaction retains at most 64 MiB
of encoded write payload before its atomic commit. In-process diffs accept at
most 8 MiB of combined input and ask jsdiff to abort after 2 seconds; structured
tool metadata is reduced to at most 256 KiB before it leaves the dispatcher.
All four defaults are configurable on `createAgentTools`.

## Usage

```ts
import { createAgentTools } from "@clarvis/tools";

const agentTools = createAgentTools({
  workspaceRoot: process.cwd(),
  confineToWorkspace: true,
});

console.log(agentTools.listTools().map((tool) => tool.name));

const result = await agentTools.callTool("read_file", {
  path: "package.json",
});
```

`workspaceRoot` must name an existing directory. Tools are confined to it by
default. Use `readOnly: true` to expose only non-mutating tools.

`sandbox: { type: "native" }` selects Bubblewrap on Linux and Seatbelt on macOS. Both backends apply
the configured workspace read/write posture, read-only runtime roots, minimal environment, writable
run scratch, and host/denied networking; their kernel primitives are not identical. Required
isolation fails closed when the selected backend cannot apply its policy. Only
`availability: "optional"` permits a logged, secret-scrubbed direct-host fallback. Other platforms
currently have no native backend. Toolchain inventory is passive: it resolves executable paths and
install roots but never launches discovered entrypoints for version probes, so merely opening host
diagnostics cannot trigger an operating-system installer or tool initialization.
Seatbelt admits both authored and canonical spellings of the read-only macOS system aliases it
depends on. In particular, `/etc` resolves to `/private/etc`, while `/var` plus the narrow
authored/canonical `var/select` and `var/db` trees let Apple's installed Git shim resolve both
`developer_dir` and `xcode_select_link`; denying those existence/readlink checks makes Apple
incorrectly request Command Line Tools even when they are installed. The opt-in real-host canary
first resolves both selectors inside the generated profile and only then executes
`/usr/bin/git --version`; a selector regression therefore fails before Apple's Git shim can request
the graphical installer.

`host_vcs` is the narrow fallback for an operation the sandbox cannot perform because it lacks a
host environment variable, credential channel, runtime, or service. The historical name remains for
compatibility, but `program` may name any host executable. This is not a host shell: arguments are an
argv array, cwd remains inside the workspace, output and time are bounded, prompts are disabled, and
Clarvis-managed secret variables are withheld. It fails closed without guard review. In guard mode
`on`, a human answers; in `auto`, the configured judge answers and may fall back to the human under
its normal unsure policy. Git additionally loses inherited repository-routing state, hooks, external
protocol helpers, known direct executable options, and custom transport-helper URLs. Direct
Git/GitHub token output remains unavailable. The ordinary sandbox remains the default; the model
should use this fallback only after the sandboxed command cannot complete the operation.

For a linked worktree, Clarvis validates the `.git` pointer, its `<common>/worktrees/<name>` target,
and the reciprocal backlink once while creating the toolset. The resulting canonical common Git
directory is pinned in runtime configuration and exposed for later sandbox commands; mutable
`.git` or `commondir` files are not consulted again.

A host may pass up to 512 canonical `skillExecutionRoots` for selected skills whose helper files
must be addressed by `shell` or `monitor_start`. Each entry must already be a directory and may be
neither a filesystem root nor a root that contains the workspace. The containment comparison uses
the canonical identities of both paths, so platform aliases such as macOS `/var` → `/private/var`
cannot disguise the workspace as a separate child. Command path analysis and `cwd` confinement admit
only those exact package roots. Native file-mutation tools still reject every target beneath them,
including when a package sits below the workspace. The recursive `replace` tool also rejects an
ancestor scope that contains one of those packages; otherwise walking `.agents`, for example, could
rewrite protected descendants without naming them directly. With a native sandbox the same roots
are mounted read-only. Without one, commands are ordinary secret-scrubbed host processes: the guard
still reviews them, but this option is not a filesystem-immutability boundary and a command can
modify files its operating-system identity may write. Nothing here executes a helper merely because
its skill was selected.

A host may additionally pass existing `temporaryRoots`. These are narrow,
host-owned scratch roots, not a general filesystem escape: every native tool
and guarded path analysis admits exactly those roots, while unrelated `/tmp`
paths remain refused. `shell` and `monitor_start` expose the first root as
`TMPDIR`, `TEMP`, and `TMP`. POSIX commands should root their template explicitly
(`mktemp -d "$TMPDIR/clarvis.XXXXXX"`), because macOS `/usr/bin/mktemp` may ignore a
reassigned `TMPDIR` when no template is supplied; PowerShell commands create beneath
`$env:TEMP`. Either form produces work that a later `grep`, `read_file`, or mutation
can access. For compatibility with POSIX agents
that spell an absolute `mktemp -d /tmp/name-XXXXXX` template, `shell` snapshots
that exact template and adopts only a new, non-symlink directory owned by the
current user; it does not admit the parent temp directory or a pre-existing match.

```ts
const readOnly = createAgentTools({
  workspaceRoot: process.cwd(),
  readOnly: true,
});
```

For lower-level integrations, `listTools(config)` returns the available
definitions and `dispatch(name, args, config)` executes one call.

### Lifting the confinement

Confinement is off only when the host asks for it. This package reads one
control and no environment at all: `confineToWorkspace: false` on the options
`createAgentTools` is **constructed** with, defaulting to `true`. It is read
once, at construction, so nothing that happens during a run can change it.

An operator reaches that option through whichever host built the toolset. Under
`@clarvis/loop` the spelling is `CLARVIS_AGENT_TOOLS_CONFINE=0` in the engine's
environment, which the tools capability forwards here.

Lift it only when the agent is genuinely meant to work across the filesystem —
never to unblock a task that hit the wall. A refused path is the boundary doing
its job, and it is the operator's call whether the boundary was wrong.

**The refusal itself deliberately does not mention any of this.** A `path_escape`
message becomes a tool result, and its reader is the model — telling it which
variable turns the check off is handing the workaround to the party the check
exists to bound. `tests/architecture/no-bypass-hints.test.ts` scans every tool
message for that shape, so a helpful-looking hint cannot come back by accident.

## Entry points

| Entry                    | Contents                                                                         |
| ------------------------ | -------------------------------------------------------------------------------- |
| `@clarvis/tools`         | `createAgentTools`, `listTools`, `dispatch`, and the re-exported `which` helpers |
| `@clarvis/tools/guard`   | the guard types and shell-analysis helpers, without the rest of the tool API     |
| `@clarvis/tools/shell`   | `resolveShell`, `shellArgs`, `killTree`, `ownProcessGroup`                       |
| `@clarvis/tools/sandbox` | Native Bubblewrap/Seatbelt probing, policy construction, and path-policy helpers |
| `@clarvis/tools/monitor` | `sweepMonitors` housekeeping without loading the complete tool registry          |

`./shell` exists for `@clarvis/hooks`, which spawns operator-declared commands and
must behave exactly like a `shell` tool command on the same host, without pulling
in the tool API.
`./monitor` exists for the kernel's startup housekeeping path; it retains the root export for
compatibility while keeping tool definitions and dispatch code outside kernel boot.

## Guards

```ts
import { analyzeShell, buildGuardContext, touchesOutside, type Guard } from "@clarvis/tools/guard";
```

A host may pass `guard` and `elicit` callbacks to `createAgentTools` to decide
whether a command is allowed and to request approval when needed. When an ask is
not approved, the denied tool result explicitly says that command review did not
approve it; it does not repeat the static ask reason as though no reviewer ran.
When the host's guard includes its effective mode, `DispatchResult.guard` also
records the final allowed/denied outcome and whether policy, the judge, the user,
the session allowlist, or an unavailable review channel answered it.

## Process groups

**Never pass `detached: true` unconditionally to `spawn`.** On POSIX it makes the
child a process-group leader, which is what lets `killTree` address a whole tree
as `-pid`; on Windows it means `DETACHED_PROCESS`, which denies the child a
console, so a console-subsystem shell spawned that way runs nothing at all — and
fails silently, with empty stdout, empty stderr, a `null` exit code and a spawn
that still reports success. Use `ownProcessGroup()` instead.

## The regex scan budget

`grep` uses `rg` for a single-file descriptor snapshot when it is on `PATH`. A directory uses `rg`
only when workspace confinement is explicitly disabled; under the default confinement it uses the
in-process JS scanner so Clarvis opens and validates every file itself. So the `path` argument alone
decides which grammar reads the pattern, and the two are not the same language: some constructs one
engine refuses outright, and a handful — `\A`, `\z`, `\p{...}`, `[]]`, `\d`/`\w`/`\b` and case
folding among them — are read _differently_ by each with no error on either side.
`packages/tools/tests/contract/regex-dialect.test.ts` enumerates the boundary construct by construct,
recording what each engine actually returned, and `grep`'s own `pattern` description names the
portable spellings. That table is a sampled diff rather than a proof: a construct it does not list is
unclassified, never portable by default. `replace` has **no** ripgrep path in any deployment — it is
always in process, so it always reads the JavaScript grammar.

Both in-process scanners apply a caller-supplied pattern many times over: `grep`
once per line, `replace` once per file. A pattern with nested quantifiers such as
`(a+)+` backtracks catastrophically, costing seconds per application on
non-matching text, so an unbounded scan of a large tree would freeze the
single-threaded host for hours with nothing able to interrupt it (an
`AbortSignal` cannot preempt synchronous regex work already in flight).

`regexScanBudgetMs` (default 5000, `REGEX_SCAN_BUDGET_MS`, min 1) caps how much
_regular-expression_ time one call may spend. Disk reads and the directory walk
are never charged, so machine load cannot exhaust it — a plain pattern over
200,000 lines charges 5-7 ms against it. On exhaustion:

- `grep` returns what it found plus an explicit "search incomplete" warning
  naming the pattern as the cause.
- `replace` fails with `timeout` and writes nothing, rather than committing a
  partial codemod against its all-or-none contract.

The residual is the budget plus one in-flight application, because the check can
only happen _between_ applications. On a JavaScriptCore host (Bun) that last
application is itself capped by the engine at roughly two seconds; on a runtime
whose regex engine does not bound backtracking it is unbounded, and this guard
cannot preempt it.

## Diagnostics

Runtime-config diagnostics go through one of two seams and never write directly to a terminal.
`@clarvis/code` owns the terminal as a canvas and must install the warn-sink bridge before any tools
code that can warn is used; the standalone default sink writes warnings to `stderr` until a host
replaces it. `tests/architecture/logging-channel.test.ts` fails on any `process.stderr` /
`process.stdout` / `console.*` in `src/` outside that deliberate `lib/log.ts` fallback.

**`RuntimeConfig.logger` — per toolset.** A `ToolsLogger` (a local structural
shape, so this package's only internal dependency stays `@clarvis/paths`;
`@clarvis/capability`'s `Logger` satisfies it). Pass it as
`AgentToolsOptions.logger`; `resolveConfig` fills the field with a no-op when you
do not, so no call site is optional-chained. It resolves once per agent, which is
why it is not a per-call argument: two calls on one toolset must not disagree
about where their diagnostics go.

**`setWarnSink` — process-wide.** One slot, last writer wins, for the two sites
that cannot reach a config: `serializeError` and `loadIgnore`. Each warning
carries a structured `ToolsWarning` beside its message, so a host bridges both onto its own logger
without losing the event name. Until a host installs one, the default writes to `stderr` — a
fallback the TUI host must replace before tool warnings are possible.

| Level   | `event`                         | Fields                                                                                              |
| ------- | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `debug` | `tools.config_resolved`         | `ripgrep, sandbox_mode, sandbox_availability, read_only, confined, skill_execution_roots, platform` |
| `warn`  | `tools.sandbox_unavailable`     | `requested, reason` — the probe reason an `optional` sandbox used to discard                        |
| `debug` | `tools.shell_spawn`             | `shell_file, flavor, detached, cwd, timeout_ms, sandboxed` — **never the command text**             |
| `debug` | `tools.shell_exit`              | `exit_code, signal, timed_out, aborted, output_limited, stdout_bytes, stderr_bytes, duration_ms`    |
| `warn`  | `tools.kill_tree_failed`        | `pid, signal, platform` — every caller ignores the `false` return                                   |
| `debug` | `tools.monitor_spawn`           | `id, platform, detached, stdio_slots, log_path, flavor` — the write side of the capture             |
| `debug` | `tools.monitor_poll`            | `id, running, offset, log_bytes` — the read side                                                    |
| `warn`  | `tools.monitor_exit_unreadable` | `id, raw, reason, flavor`                                                                           |
| `warn`  | `tools.spill_failed`            | `stream, target, cause`                                                                             |
| `debug` | `tools.grep_path`               | `engine, is_dir, confined`                                                                          |
| `debug` | `tools.path_refused`            | `input, reason, allow_roots_count`                                                                  |
| `error` | `tools.internal_error`          | `err` — via the warn sink                                                                           |
| `warn`  | `tools.ignore_unreadable`       | `path` — via the warn sink                                                                          |
| `debug` | `tools.fs_error_unmapped`       | `errno_code, syscall, path, platform` — via the warn sink                                           |

Four of these exist to make remaining **Windows** gaps diagnosable. The Windows
CI leg now runs `@clarvis/tools`; named capability predicates suppress only the
platform properties that are unavailable or still unverified there. The current
evidence and those residual gaps are recorded in `specs/known-issues.md`:

- `tools.monitor_spawn` and `tools.monitor_poll` are a pair. A monitor that is
  `running` with `log_bytes: 0` names the write side as the failure and settles
  the `monitor` capture gap — the conclusion an abandoned two-handle experiment
  (`50aa7c2`, reverted in `2705c3a`) was needed to reach.
- `tools.monitor_exit_unreadable` separates an unparsable sentinel from a killed
  process. Without it both arrive as `{ exited: true, code: null }`, which also
  swallows a parse error in the command and PowerShell's `$?`-vs-`$LASTEXITCODE`
  gap.
- `tools.fs_error_unmapped` names the errno behind `apply_patch` reporting
  `io_error` where POSIX reports `not_a_file` — the code known-issues records as
  _"not been identified"_, because it existed only inside a tool result no CI job
  retains.

`tools.path_refused` closes the other conflation: a symlink that stopped the
canonicalization walk (`reason: "unresolvable"`) used to be reported exactly like
a genuine escape (`reason: "outside_root"`), and commits `0c655d9`/`8b3319f` both
fixed instances of it.

**What is deliberately not here.** A tool call's name, arguments, result, error,
timing and diff are already trace entries (`tool_call`, `tool_call_started`), and
streamed output is `tool_output_delta`; duplicating them would put one fact on two
channels with two lifetimes. Directory walks, the in-process scanner, per-file
replace and the output coalescer emit nothing per item — the bindings object is
allocated before any backend sees the level, so `debug` is not cheap enough on a
hot path. And nothing here bears on the parent-directory TOCTOU in
`specs/known-issues.md`: that race is between a validated pathname and a later
path-based `mkdir`/`rename`, and a log entry is not a check.

## Development

Run commands from the monorepo root:

```bash
bun --filter @clarvis/tools build
bun --filter @clarvis/tools typecheck
bun --filter @clarvis/tools test
bun --filter @clarvis/tools test:unit
bun --filter @clarvis/tools test:component
bun --filter @clarvis/tools test:contract
bun --filter @clarvis/tools test:integration
bun --filter @clarvis/tools test:architecture
bun --filter @clarvis/tools lint
bun --filter @clarvis/tools format:check
```

### Test ownership

- `tests/unit/` owns pure policies, parsers, renderers, shell dialect analysis,
  and process decisions exercised through narrow injected collaborators.
- `tests/component/` owns the package facade, registry/surface selection, and
  monitor composition when process effects are replaced by fakes. The expected
  surface metadata has one oracle in `tests/helpers/tool-surface.ts`; registry,
  public-facade, and read-only assertions derive their views from it instead of
  repeating name matrices.
- `tests/contract/` owns behavior shared by the ripgrep and in-process grep
  implementations.
- `tests/integration/` owns real filesystem, symlink, process, shell, monitor,
  ripgrep, timing, and platform effects, including confinement and
  other OS/security contracts. Its atomic tests own the tools-specific
  multi-file transaction and rollback; `@clarvis/paths` owns temp naming,
  rename retry, atomic-write cleanup, and directory fsync conformance, which
  this package consumes rather than retesting.
- `tests/architecture/` owns static source and public-message invariants; it
  does not claim runtime behavior coverage.

`test` and `test:coverage` continue to discover every tier. The tier-specific
commands exist for targeted development and do not replace the full suite.

The package requires Bun 1.4.0 or newer.
