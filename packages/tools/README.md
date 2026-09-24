# `@clarvis/tools`

Workspace-aware coding tools for LLM agents. The package can be used as a plain
TypeScript library. Its only internal dependency is `@clarvis/paths` — the
dependency-free directory-vocabulary leaf — from which it also re-exports
`executableOnPath` / `resolveCommand`.

> Private, unversioned workspace. The root manifest owns the Clarvis product version; this package
> is not published independently.

## Contract

Technical automatic-review failures report their failure category to the calling run, not the static
reason that triggered review. The message explicitly distinguishes failure from missing operator
authorization and does not ask the model to obtain repeated consent.

The tool surface and dispatcher contract are specified in
[`execution/tools-contract.md`](../../specs/execution/tools-contract.md), with focused contracts for
[`reads and search`](../../specs/execution/tools-read-and-search.md),
[`mutation`](../../specs/execution/tools-mutation.md), and
[`shell and sessions`](../../specs/execution/tools-shell-and-sessions.md). Approval analysis and the
host sandbox boundary are specified in
[`execution/command-guard.md`](../../specs/execution/command-guard.md) and
[`execution/sandbox.md`](../../specs/execution/sandbox.md).

The compact model-facing surface follows
[`model-instructions.md`](../../specs/cross-cutting/model-instructions.md): local argument rules and
recovery details live beside each tool. Shell commands block by default; `yield_time_ms` returns a live `session_id` for `shell_session`.
Descriptions retain truncation direction and continuation guidance, distinguish grep's regex engines,
and provide an executable multiline `apply_patch` example. The complete 20-tool descriptor JSON has
a 21,000-character regression ceiling; that is not a provider token count.

## What it provides

- File operations: read, batch read, image read, write, edit, multi-edit, patch,
  copy, move, mkdir, remove and stat.
- Discovery: directory listing, tree, glob, grep and diff.
- Project-wide regular-expression replacement.
- Shell execution and run-owned sessions with per-call sandbox escalation. A command can yield a session ID, then `shell_session` polls, stops, or lists it within the same run and agent.
- Read-only and environment-governed surfaces.
- A guard contract and shell analysis helpers for approval policies.
- Bounded in-memory shell output with per-stream cursors and omitted-byte counts. Generic oversized results from other tools may spill to workspace state; shell output does not.

`read_image` recognizes PNG, JPEG, GIF and WebP from their bytes. PNG input also requires a complete
chunk stream with valid CRCs, so a signature-only or corrupt file is refused before it can enter
model history and make later provider calls fail.

`ToolCallHooks.onExecutionStarted` is shell's successful-spawn notification, after review and
abort-listener installation. Failed spawn and pre-aborted dispatch do not announce execution.
An abort after process exit does not turn its completed output into an aborted result. The engine
waits for cooperative selective settlement to preserve stdout/stderr; the tools layer reports only
its structured generic `aborted` code, never the operator's intent.
The `shell` result, including timeout and abort errors, reports `stdout_truncated`,
`stderr_truncated`, `stdout_omitted_bytes`, `stderr_omitted_bytes`, and per-stream
`*_spill_incomplete` fields. A partial spill is labelled as such in the output marker; callers
must not treat its path as a complete transcript.

Spill names and their 24-hour collector are owned by `@clarvis/paths`; this
package writes those paths at owner-only `0600` permissions but does not export the collector.
Monitors create no sidecar, log, or exit file. The loop supplies one `ExecutionSessionManager`
for the run and closes it before removing run-owned scratch; a disabled tools capability allocates
no manager or scratch.

`apply_patch` recommends the model-familiar `*** Begin Patch` envelope with `Update File`, `Add
File`, `Delete File`, and optional `Move to` blocks. It also accepts raw `---`/`+++` unified diffs.
Both forms share classified-path admission, complete path locking, UTF-8 checks, and atomic multi-file
commit; a failed hunk changes nothing. The guard extracts paths from both grammars, including move
destinations. Numbered model-envelope hunks honor their old-file coordinates after adjusting for
earlier hunks, with a three-line tolerance for small drift; this also makes coordinate-only
insertions and duplicate context deterministic.

A later `read_file` or `read_files` call may read an exact generic overflow artifact in the current workspace's machine-local state. The file must be regular and non-link, and its identity is checked again after opening. No shell command receives state access through this exception. Prompt history, old sidecars, and other selected state files remain private. POSIX `/dev/null` is treated as the null device,
not as an escaping host file, so ordinary output-discard redirections do not create false denials.
The POSIX command analyzer matches `eval`/`env`/`source` and friends at the effective command head
so arguments such as `cat source` stay decidable, does not treat `NAME=value` assignment-only
segments as tokenizer failures, and inlines sequential literal `$NAME` bindings for analysis.

Text reads open one descriptor non-blocking, reject non-regular files from that descriptor, and
read at most `MAX_FILE_BYTES + 1`. The extra byte detects a file that grows after its initial stat;
the same bound feeds `read_file`, batch reads and the in-process grep path. FIFOs/devices therefore
cannot park the event loop and a concurrent path replacement cannot turn a validated small file into
an unbounded allocation.

The root library exports `readRawFile` and `ReadFileOptions` for trusted host
consumers that need the same bounded descriptor read. Callers supply their byte ceiling and, for
Goal evidence, the selected artifact root. The kernel uses it to hash declared goal artifacts inside the selected workspace;
this library operation does not add a model tool or grant access to host state roots.

The same descriptor-first rule covers ignore sources and `file_stat`. Ignore files cap at 1 MiB. Command sessions use bounded in-memory pipes and create no control or output files.
Non-regular inputs are ignored or rejected according to the reading surface's error contract.
Single-file ripgrep searches receive the already-bounded snapshot on stdin, so the subprocess never
reopens a pathname after validation. Directory searches always use the in-process scanner so each discovered path receives
classified-path admission. A single-file ripgrep search uses a bounded descriptor snapshot.

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
});

console.log(agentTools.listTools().map((tool) => tool.name));

const result = await agentTools.callTool("read_file", {
  path: "package.json",
});
await agentTools.close();
```

`workspaceRoot` must name an existing directory and anchors relative paths. Host file access
follows OS permissions; Sandbox access follows the run filesystem policy.
Use `readOnly: true` to expose only non-mutating tools.

`sandbox: { type: "native" }` selects Bubblewrap on Linux and Seatbelt on macOS. Both backends allow
reads from host-visible files and limit writes to the selected workspace and temporary roots,
subject to `workspace-read-only` and nested read-only roots. Workspace `.clarvis`, `.agents` and
Git metadata are read-only to sandboxed processes; classified file commits use the host review port.
The run's immutable
`ResolvedFilesystemPolicy` supplies the same placement and paths to `shell` and `shell_session`.
All file tools run in one run-owned child under that same native policy; a missing backend or lost
child fails the call closed. Host executes file calls locally. Required
isolation fails closed when the selected backend cannot apply its policy.
The native service sends the host-selected state root as data; `@clarvis/paths` rebuilds the
complete workspace state paths inside the worker, including owner and spill builders.
Command Review asks before a Sandbox shell command touches a path outside the workspace; the native
backend still enforces its write roots. Guard review continues to receive location facts for paths outside the workspace.
`availability: "optional"` is accepted on stored settings and treated as required. Other platforms
currently have no native backend. Toolchain inventory is passive: it resolves executable paths and
install roots but never launches discovered entrypoints for version probes, so merely opening host
diagnostics cannot trigger an operating-system installer or tool initialization.
Seatbelt uses both authored and canonical path spellings in its write rules, so macOS aliases such
as `/var` to `/private/var` cannot reopen a protected path. Broad reads let Apple's installed Git
shim inspect `developer_dir` and `xcode_select_link`; the opt-in real-host canary resolves these
selectors before executing `/usr/bin/git --version`. `network: "none"` still denies every network
operation, even though filesystem reads include resolver sockets. The real-host canary tests
host/denied networking against a local listener, independently of public DNS or registry
availability. Native POSIX
sandboxes set npm's script shell to the absolute `/bin/sh`: npm otherwise searches a bare `sh`
through synthetic ancestor `node_modules/.bin` entries, where an inaccessible host path can
turn package execution into `spawn EPERM` even after download and extraction succeeded. On macOS,
the read-only system runtime and filtered `PATH` also include `/opt/homebrew`, so Apple Silicon
Homebrew command shims remain executable while the prefix itself receives no sandbox write rule. A
separate canary packs a local fixture outside Seatbelt, then requires npm to install and execute it
offline inside a denied-network profile; this isolates package execution from public-registry
latency while preserving the real npm/Homebrew/runtime path.

`shell` accepts optional `sandbox_permissions`. Omitted or `use_default` follows
the run Isolation. `require_escalated` plus a short `justification` asks to run that one command on
the host after review when Isolation is Sandbox. Isolation Host already runs unsandboxed, so the
field is a no-op. In native Host/Sandbox, mode `on` sends that unsandbox ask to a human. Mode `auto` sends it to the
judge: `allow` executes, and `deny`, unsure, failed or malformed review refuse to the calling agent.
An unavailable judge refuses. Host-command review bypasses session coverage and never offers
`allow_session`; clean judge decisions retain their exact-call memo. Mode `off` proceeds without a reviewer. Git credential output,
`gh auth token`, Git `--exec` helpers, and
`scheme::` transport URLs are denied on every command tool. Direct Git/GitHub token output remains
unavailable. The ordinary sandbox remains the default; the model should request escalation only after
the sandboxed command cannot complete the user's request.

For a linked worktree, Clarvis validates the `.git` pointer, its `<common>/worktrees/<name>` target,
and the reciprocal backlink once while creating the toolset. The resulting canonical common Git
directory is pinned in runtime configuration and exposed for later sandbox commands; mutable
`.git` or `commondir` files are not consulted again.

A host may pass up to 512 canonical `skillExecutionRoots` for selected skills whose helper files
must be addressed by `shell`. Each entry must already be a directory and may be
neither a filesystem root nor a root that contains the workspace. The containment comparison uses
the canonical identities of both paths, so platform aliases such as macOS `/var` → `/private/var`
cannot disguise the workspace as a separate child. Command path analysis still recognizes those
exact package roots; an explicit shell `cwd` may name any existing directory the selected placement
can access. Native file-mutation tools still reject every target beneath them,
including when a package sits below the workspace. The recursive `replace` tool also rejects an
ancestor scope that contains one of those packages; otherwise walking `.agents`, for example, could
rewrite protected descendants without naming them directly. With a native sandbox the same roots
are mounted read-only. Without one, commands are ordinary secret-scrubbed host processes: the guard
still reviews them, but this option is not a filesystem-immutability boundary and a command can
modify files its operating-system identity may write. Nothing here executes a helper merely because
its skill was selected.

Native file-mutation tools also protect the four Clarvis and shared Agent roots resolved by
`configurationRoots`. Admitted authoring and operational targets use the shared
`configurationPathClass` vocabulary and require a complete reviewed effect through the host
`reviewMutation` port. Reads and copies of admitted configuration files remain available; explicit
global `glob` and `grep` scopes use the same canonical classification. Their walks skip private
directories and leaves before reading bytes, and grep uses descriptor-bound reads rather than a
subprocess for configuration directories. Private paths such as `keys.json` are refused before
direct content access and hidden by `list_dir`.
Loading guidance never grants access.
Project-wide `replace` excludes both roots while continuing over ordinary workspace files. Command
tools retain the separate shell and sandbox posture above and cannot substitute for host-reviewed
configuration file tools.

A host may additionally pass existing `temporaryRoots`. Every native tool,
guarded path analysis, and native sandbox admits every listed root; `shell` and
`shell` exposes the first one as `TMPDIR`, `TEMP`, and `TMP`. The standalone
library defaults to no temporary roots. The Clarvis loop instead supplies its
owner-only run scratch first, followed by `systemTemporaryRoots()`: the existing
environment-selected temp directory plus `/tmp` on POSIX, or the environment-selected
temp directory on Windows. This matches host-native CLIs that ignore or replace
`TMPDIR`, so a path they return remains usable by a later shell or native coding tool.

System temporary roots are access policy, never lifecycle ownership. After tracked command trees physically exit, the loop removes only the scratch it allocated. A command owns directories it creates with `mktemp`, even under an accessible system temporary root. Uncertain termination retains the run scratch.
When a read-only workspace lives below a system temporary root, Bubblewrap mount
ordering and Seatbelt exclusions keep the workspace read-only while the exact run
scratch remains writable.

For `shell`, an absolute command head below a platform system executable root or
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
// Close the instance after the final call.
await readOnly.close();
```

For lower-level integrations, `listTools(config)` returns the available
definitions and `dispatch(name, args, config)` executes one call.
`createAgentTools` and direct `resolveConfig`/`dispatch` get a private in-process `ExecutionSessionManager` by default. Call `await tools.close()` or `await config.sessionManager.close()` before discarding the owner. `shell_session` uses only live handles admitted to that manager and agent; no persisted file authorizes control. An unconfirmed stop reports `termination_unconfirmed`.
IDs carry 128 bits of randomness. Host or sandbox process trees that deliberately daemonize out of
the tracked group can escape this backend; an abrupt host crash outside a sandbox may orphan work.

### Filesystem access

The run placement controls file access for commands and native file tools. Host uses OS permissions;
Sandbox runs both under its frozen native policy. The workspace
root anchors relative paths. File-tool paths starting with `~`, `~/`, or `~\` fail with
`invalid_input` instead of creating a literal workspace directory. Paths inside the workspace are
reported relatively; external paths are reported absolutely. Classified secret configuration,
selected skills and exact output
artifact rules remain independent protections. Production: `resolveFilesystemPolicy` in
`packages/tools/src/sandbox.ts`, `resolveFileToolPath` in `packages/tools/src/lib/paths.ts`, and
`resolveReadableTextPath` in `packages/tools/src/lib/state-artifacts.ts`. Test:
`packages/tools/tests/integration/no-isolation.test.ts`,
`packages/tools/tests/integration/sandbox.test.ts`, and
`packages/tools/tests/unit/state-artifact-access.test.ts`.

## Entry points

| Entry                    | Contents                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `@clarvis/tools`         | `createAgentTools`, `listTools`, `dispatch`, and the re-exported `which` helpers                                |
| `@clarvis/tools/guard`   | the guard types and shell-analysis helpers, without the rest of the tool API                                    |
| `@clarvis/tools/shell`   | `resolveShell`, `shellArgs`, `killTree`, `ownProcessGroup`, `isAlive`                                           |
| `@clarvis/tools/sandbox` | Native Bubblewrap/Seatbelt probing, policy construction, host temporary-root discovery, and path-policy helpers |

`./shell` exists for `@clarvis/hooks`, which spawns operator-declared commands and
must behave exactly like a `shell` tool command on the same host, without pulling
in the tool API.
calls it.

## Guards

`ShellFacts.analysisIssues` aggregates each segment's structured syntax causes with zero-based
segment indices and affected positions. `undecidable` remains the conservative nonempty-issues
fold. A dynamic value is not proof of a safe effect: `GuardReviewability` reserves `judgeable`
for host attestation. POSIX and PowerShell provide their own issue analysis. Environment assignment
values participate in path extraction; the assignment name is not part of a filesystem path.
An ordinary allow-list miss can still be judged from the complete call in Auto mode. That call-local
answer does not claim a registered effect or persist authority. The reviewer receives the exact
segment source plus separate executable, parameter and environment-binding fields, so `TMPDIR=/tmp`,
ordinary flags, wrappers and dynamic values do not become human-only merely because they are
parameters. Deterministic denial, credential and destructive rules retain precedence in the host.

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
Optional `reviewer_decision` separates the semantic result (`allow`, `deny`, `unsure`, `failed`)
from the final outcome. Semantic denials label the static review trigger separately from that result.
When automatic review denied or was unsure, the message says so and does not ask for a UI approval
that was not presented. Technical failures instead report the failure category and explain that
repeated consent is not a fix; they do not invent a semantic explanation from the shell analyzer's reason.

The exported POSIX and PowerShell starter allowlists cover routine inspection,
build, test, lint and type-check commands across JavaScript/TypeScript, Python,
Rust, Go, JVM, .NET, C/C++, Ruby, PHP, Swift, Elixir/Erlang, Dart, Zig, Haskell,
Clojure, Lua, Perl and shell projects. They deliberately omit package installs,
publishing, deploys, migrations, generic interpreters and unconstrained task
runners, so those calls still require review. Every seeded entry is asserted to
be decidable and canonical in its host dialect. These lists express approval
policy, not containment: builds and tests may run repository-controlled code, so
hosts that require isolation must also enable the native sandbox.

`GuardPlacement` (`"host" | "contained"`) and `GuardCallFacts` describe optional trusted per-call
review facts: `matched`, `placement`, `network`, `dangerous`, `risk_findings`, `within_workspace`, and
`touches_outside`. `GuardDecision` and `ElicitRequest` share those fields; dispatch copies only
decision-supplied facts, never same-named model arguments. `ElicitRequest.operator_message` is an
optional host-reviewer message separate from the policy reason. These facts do not themselves
authorize execution.

`commandRiskFindings(shell: ShellFacts)` reports per-segment `forced_removal` and
`privilege_elevation` findings, including extractable operands and whether a removal is recursive.
`isDangerousCommand` is true when any finding exists. Neither helper is an approval policy or a
human-channel decision. Force options count only before `--` or `--%`; PowerShell `rm`/`del` are
canonicalized to `Remove-Item`. POSIX normalization removes consecutive Git
`--no-pager`/`--no-color` global prefixes after environment assignments and wrappers; it preserves
subcommand flags and `-C` for host policy analysis. PowerShell still canonicalizes only `argv[0]`.
`resolveCandidate(raw, workspaceRoot, opts?)` exposes the same symlink-aware path facts used by
the context builder, with optional shell tilde expansion and explicitly admitted roots. These
helpers and types are exported from both the root and `@clarvis/tools/guard`.

`sandboxWouldApply(sandbox, forceBare?)`, exported by `@clarvis/tools/sandbox`, is the probe-free
predicate shared with command construction. It reports the commitment to native containment or
failure for required and legacy optional policies, not backend readiness. Absent policies,
`enabled: false` settings, and explicitly bare calls return false; there is no optional host fallback.

## Process groups

**Never pass `detached: true` unconditionally to `spawn`.** On POSIX it makes the
child a process-group leader, which is what lets `killTree` address a whole tree
as `-pid`; on Windows it means `DETACHED_PROCESS`, which denies the child a
console, so a console-subsystem shell spawned that way runs nothing at all — and
fails silently, with empty stdout, empty stderr, a `null` exit code and a spawn
that still reports success. Use `ownProcessGroup()` instead.

## The regex scan budget

`grep` uses `rg` for a single-file descriptor snapshot when it is on `PATH`. A directory search uses the
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

`regexScanBudgetMs` (default 5000, `DEFAULT_REGEX_SCAN_BUDGET_MS`, min 1) caps how much
_regular-expression_ time one call may spend. Shell `ready_when` matching uses the same budget
over its bounded rolling output window. Disk reads and the directory walk
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

| Level   | `event`                     | Fields                                                                                                                                                           |
| ------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug` | `tools.config_resolved`     | `ripgrep, sandbox_mode, sandbox_availability, read_only, skill_execution_roots, platform`                                                                        |
| `warn`  | `tools.sandbox_unavailable` | `requested, reason` — the probe reason an `optional` sandbox used to discard                                                                                     |
| `debug` | `tools.shell_spawn`         | `shell_file, flavor, detached, cwd, timeout_ms, sandboxed` — **never the command text**                                                                          |
| `debug` | `tools.shell_exit`          | `exit_code, signal, timed_out, aborted, stdout_bytes, stderr_bytes, stdout_truncated, stderr_truncated, stdout_omitted_bytes, stderr_omitted_bytes, duration_ms` |
| `warn`  | `tools.kill_tree_failed`    | `pid, signal, platform` — every caller ignores the `false` return                                                                                                |
| `warn`  | `tools.session_stop_failed` | `cause` — a timeout or abort stop threw before confirmation                                                                                                      |
| `debug` | `tools.grep_path`           | `engine, is_dir, classified_roots`                                                                                                                               |
| `error` | `tools.internal_error`      | `err` — via the warn sink                                                                                                                                        |
| `warn`  | `tools.ignore_unreadable`   | `path` — via the warn sink                                                                                                                                       |
| `debug` | `tools.fs_error_unmapped`   | `errno_code, syscall, path, platform` — via the warn sink                                                                                                        |

Windows process capture and stop still require native CI qualification; `specs/known-issues.md` records that boundary.

`tools.fs_error_unmapped` names the errno behind `apply_patch` reporting
`io_error` where POSIX reports `not_a_file` — the code known-issues records as
_"not been identified"_, because it existed only inside a tool result no CI job
retains.

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
  session composition when process effects are replaced by fakes. The expected
  surface metadata has one oracle in `tests/helpers/tool-surface.ts`; registry,
  public-facade, and read-only assertions derive their views from it instead of
  repeating name matrices.
- `tests/contract/` owns behavior shared by the ripgrep and in-process grep
  implementations.
- `tests/integration/` owns real filesystem, symlink, process, shell session,
  ripgrep, timing, and platform effects, including environment policy and
  other OS/security contracts. Its atomic tests own the tools-specific
  multi-file transaction and rollback; `@clarvis/paths` owns temp naming,
  rename retry, atomic-write cleanup, and directory fsync conformance, which
  this package consumes rather than retesting.
  Reviewed configuration writes, copies and moves use private file and new directory modes;
  reviewed copies and moves use the shared rollback transaction. The mediated routes are covered
  in `tests/integration/api.test.ts`, `copy.test.ts` and `move.test.ts`.
- `tests/architecture/` owns static source and public-message invariants; it
  does not claim runtime behavior coverage.

`test` and `test:coverage` continue to discover every tier. The tier-specific
commands exist for targeted development and do not replace the full suite.

The package requires Bun 1.4.0 or newer.

The test fixture helpers derive workspace state and lock paths from the fixture's explicit global
root. They do not use an operator `CLARVIS_HOME` for locks or state, and the isolation regression
in `tests/unit/fixtures-isolation.test.ts` asserts that a fixture leaves no state in the ambient
global tree. Native sandbox tests remain separate from these fixture guarantees: an unavailable
backend is a failed/unsupported boundary, not evidence that an unconfined command was safe.

### Effect facts and authoring

The standalone guard DTO can carry host-attested effect facts and review receipts without importing
capability. Those facts describe a configuration change, not a command: the command guard resolves
one deterministic policy and sends every remaining Auto `ask` to the call-local reviewer without
classifying an operation. Admitted workspace authoring and operational configuration passes native
mutation protection only through the host's `reviewMutation` port. Without that port — a ceiling other than `edit`/`exec`, or disabled builtin tools — the file tool refuses the
protected target before the guard runs, and an absent/off guard never authorizes the write. The
host passes global roots only to eligible entry-agent file handlers; shell commands do not gain
writable roots, and unrelated file paths follow the selected environment policy. See
[effect review](../../specs/execution/effect-review.md).

File tools prepare complete atomic mutation batches before effect review. The entry agent receives the host `reviewMutation` callback; profiles cannot install it. In Sandbox, the child sends prepared bytes through a bounded typed channel and waits for the host's decision before committing. Configuration batches reuse the configuration reviewer, validate recognized documents and check captured revisions before staging. The host commits only approved classified configuration batches; a mixed batch may include ordinary targets inside the writable workspace. Copy uses captured UTF-8 bytes for protected destinations; rename/delete include their source effects. Mixed patches and recursive replacement review all prepared targets together. The callback carries exact workspace trust and notifies catalogs after success. Ordinary binary file operations retain their existing behavior.

`remove` accepts one file, symlink entry, or empty directory. Directory removal checks emptiness,
passes the target through review, and synchronizes the parent after commit. With `recursive: true`,
it can delete an ordinary workspace tree after one bounded effect review in Auto or human review in
On. An empty directory still takes the `rmdir` route. The preview
is limited to 64 entries, 8 KiB of path names and depth 32; links, special files, deceptive names, configuration,
selected skills, state, and Git metadata are refused. The tree is rechecked before deletion.
Partial removal is reported as `commit_partial`; recursive cleanup is not atomic.
The exported `scanSmallTree` helper returns the bounded entry list and an identity revision for
the host review; it never reads file bodies or grants deletion authority.

The native file service carries bounded typed failures for prepare, review, commit, and execution;
expected errors keep their code instead of collapsing into `internal`. `remove` unlinks an admitted
symlink entry without following its destination. `move` keeps same-filesystem rename and stages a
bounded copy in the destination filesystem on `EXDEV`; a failed source removal after publication
returns `commit_partial` with observable endpoint state. Production: `SandboxAgentFilesystem` in
`src/filesystem-service.ts`, `applyOpsAtomic` in `src/lib/atomic.ts`, `remove` and `move` in
`src/tools/`. Test: typed worker and native cross-device cases in
`tests/integration/filesystem-service.test.ts` and symlink deletion in
`tests/integration/remove.test.ts`.

An explicitly scoped recursive replacement inside configuration directories discovers bounded admitted leaves despite default configuration ignore rules. Private files are filtered before content reads; generic workspace replacement retains its normal ignore behavior.
