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

The compact model-facing surface follows
[`model-instructions.md`](../../specs/cross-cutting/model-instructions.md): local argument rules and
recovery details live beside each tool. Shell commands block; persistent work uses `monitor_start`.
Descriptions retain truncation direction and continuation guidance, distinguish grep's regex engines,
and provide an executable multiline `apply_patch` example. The complete 23-tool descriptor JSON has
a 21,000-character regression ceiling; that is not a provider token count.

## What it provides

- File operations: read, batch read, image read, write, edit, multi-edit, patch,
  copy, move, mkdir, remove and stat.
- Discovery: directory listing, tree, glob, grep and diff.
- Project-wide regular-expression replacement.
- Shell execution and background-process monitors, including a per-call host escalation field when Isolation is Sandbox.
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

The root library exports `readRawFile`, `ReadFileOptions` and `ReadConfinement` for trusted host
consumers that need the same bounded descriptor read. Callers supply their byte ceiling and explicit
confinement policy. The kernel uses it to hash declared goal artifacts inside the selected workspace;
this library operation does not add a model tool or grant access to host state roots.

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
isolation fails closed when the selected backend cannot apply its policy.
`availability: "optional"` is accepted on stored settings and treated as required. Other platforms
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
the graphical installer. With `network: "host"`, Seatbelt also admits only the authored and
canonical `mDNSResponder` socket paths required by the macOS resolver. `network: "none"` admits
neither and still denies every network operation. The real-host canary tests host/denied networking
against a local listener, independently of public DNS or registry availability. Native POSIX
sandboxes set npm's script shell to the absolute `/bin/sh`: npm otherwise searches a bare `sh`
through synthetic ancestor `node_modules/.bin` entries, where a deliberately hidden host path can
turn package execution into `spawn EPERM` even after download and extraction succeeded. On macOS,
the read-only system runtime and filtered `PATH` also include `/opt/homebrew`, so Apple Silicon
Homebrew command shims remain executable while the prefix itself receives no sandbox write rule. A
separate canary packs a local fixture outside Seatbelt, then requires npm to install and execute it
offline inside a denied-network profile; this isolates package execution from public-registry
latency while preserving the real npm/Homebrew/runtime path.

`shell` and `monitor_start` accept optional `sandbox_permissions`. Omitted or `use_default` follows
the run Isolation. `require_escalated` plus a short `justification` asks to run that one command on
the host after review when Isolation is Sandbox. Isolation Host already runs unsandboxed, so the
field is a no-op. Isolated container guests reject it: the guest has no channel to the machine host.
Mode `on` and `auto` send that unsandbox ask to a human; the auto-judge does not decide it. Mode
`off` proceeds without a reviewer. Git credential output, `gh auth token`, Git `--exec` helpers, and
`scheme::` transport URLs are denied on every command tool. Direct Git/GitHub token output remains
unavailable. The ordinary sandbox remains the default; the model should request escalation only after
the sandboxed command cannot complete the user's request.

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

Native file-mutation tools also protect the workspace-authored Clarvis roots resolved by
`configurationRoots`. Reads remain available, including copying a configuration file to an
ordinary workspace destination. Writes targeting those roots fail before guard review and direct
the operator to `/clarvis-configure <change>`, whose kernel-owned route asks for consent.
Project-wide `replace` excludes both roots while continuing over ordinary workspace files. Command
tools retain the separate shell and sandbox posture above; the builtin configuration guide forbids
using them as an alternate writer.

A host may additionally pass existing `temporaryRoots`. Every native tool,
guarded path analysis, and native sandbox admits every listed root; `shell` and
`monitor_start` expose the first one as `TMPDIR`, `TEMP`, and `TMP`. The standalone
library defaults to no temporary roots. The Clarvis loop instead supplies its
owner-only run scratch first, followed by `systemTemporaryRoots()`: the existing
environment-selected temp directory plus `/tmp` on POSIX, or the environment-selected
temp directory on Windows. This matches host-native CLIs that ignore or replace
`TMPDIR`, so a path they return remains usable by a later shell or native coding tool.

System temporary roots are access policy, never lifecycle ownership. The loop
removes only its run scratch and exact directories registered as newly created by
the run; it never removes the system roots or unrelated content below them. For an
explicit POSIX `mktemp -d /tmp/name-XXXXXX` template, `shell` still snapshots that
template and registers only a new, non-symlink directory owned by the current user.
When a read-only workspace lives below a system temporary root, Bubblewrap mount
ordering and Seatbelt exclusions keep the workspace read-only while the exact run
scratch remains writable.

For `shell` and `monitor_start`, an absolute command head below a platform system executable root or
an explicitly admitted sandbox runtime root is classified as the executable, not as an external
data operand. Its exact argv remains available for review, while allow/deny matching uses the same
basename identity as the PATH spelling (`/usr/bin/git push` is still `git push` to policy). Windows
also removes `.exe`, `.com`, `.bat`, and `.cmd` from that policy identity, matching its extensionless
PATH spelling. Darwin's roots include `/opt/homebrew` for Apple Silicon Homebrew commands. The
exception belongs to that command-head occurrence only: if the same absolute path appears later as
an operand, that occurrence remains outside the workspace boundary, as do an absolute argument such
as `/etc/passwd` and an executable outside the host-approved roots.

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

| Entry                    | Contents                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `@clarvis/tools`         | `createAgentTools`, `listTools`, `dispatch`, and the re-exported `which` helpers                                |
| `@clarvis/tools/guard`   | the guard types and shell-analysis helpers, without the rest of the tool API                                    |
| `@clarvis/tools/shell`   | `resolveShell`, `shellArgs`, `killTree`, `ownProcessGroup`                                                      |
| `@clarvis/tools/sandbox` | Native Bubblewrap/Seatbelt probing, policy construction, host temporary-root discovery, and path-policy helpers |
| `@clarvis/tools/monitor` | `sweepMonitors` housekeeping without loading the complete tool registry                                         |

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

The exported POSIX and PowerShell starter allowlists cover routine inspection,
build, test, lint and type-check commands across JavaScript/TypeScript, Python,
Rust, Go, JVM, .NET, C/C++, Ruby, PHP, Swift, Elixir/Erlang, Dart, Zig, Haskell,
Clojure, Lua, Perl and shell projects. They deliberately omit package installs,
publishing, deploys, migrations, generic interpreters and unconstrained task
runners, so those calls still require review. Every seeded entry is asserted to
be decidable and canonical in its host dialect. These lists express approval
policy, not containment: builds and tests may run repository-controlled code, so
hosts that require isolation must also enable the native sandbox.

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
are never charged; unrelated delay between regex applications does not consume
the budget, while scheduler time during an in-flight application is part of its
elapsed cost. A plain pattern over 200,000 lines normally charges 5-7 ms against
it. On exhaustion:

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
