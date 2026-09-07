# @clarvis/paths

The single owner of Clarvis's directory vocabulary: where a workspace and a user's global
state live on disk.

## Contract

The directory vocabulary, atomic-write family, local leases, and shared Git repository-environment
filter are specified in
[`foundations/paths.md`](../../specs/foundations/paths.md). The shared `.agents` interoperability
seam and its component-specific ownership rules are specified in
[`cross-cutting/agent-interop.md`](../../specs/cross-cutting/agent-interop.md).

Nothing else in the monorepo spells `".clarvis"` or `".agents"`. An architecture test in this
package (`tests/architecture/invariant.test.ts`) enforces that, scanning every package's `src/`
**and `tooling/`** and failing on any new occurrence. Restricting it to `src/` is what once let a drift through: a
smoke-test fixture seeded the old global layout by string join, and the failure surfaced four days
later as a 90-second timeout rather than as anything named.

## Why it exists

The literal used to be repeated across eight packages, and the copies had already drifted:

- `join(workspaceRoot, ".clarvis")` was computed independently in seven places.
- One creator used `mkdir` with no mode while three others used `0o700`.
- The shell tool wrote spill files as `shell-<token>.<stream>.log` while the sweeper looked
  for `bash-*` — so shell spills were never collected at all.
- The workspace `.gitignore` was seeded by whichever tool happened to run first, so whether
  it existed depended on the order of events rather than on any decision.

Centralising the vocabulary is what makes those failure modes unrepresentable. Builders and
their recognisers live together — `monitorSidecar` beside `isMonitorSidecar`, `spillFile`
beside `isSpillFile` — because a scanner that re-spells the convention is exactly how the
spill defect happened.

The collector belongs here too: `sweepSpillDir(workspaceRoot)` removes recognised
shell and generic-result spills older than 24 hours while preserving recent,
monitor and unrelated files. A pass scans at most 10,000 entries and processes
four at a time by default, so one pathological directory cannot turn cleanup
into an unbounded allocation or `Promise.all` burst. This keeps generic run housekeeping on an
always-present infrastructure leaf rather than making `@clarvis/tools` a hidden
runtime requirement of the loop's main entry.

`sweepGlobalStateArtifacts(globalRoot)` applies the same bounded policy across inactive workspace
state as well as the current workspace. It also repairs recognized spill files to `0600` on POSIX
and removes run containers older than 24 hours only when their descendants are empty temporary
directories. Active, recent, occupied and unrecognized paths are preserved.

## Shape

It has **no dependencies at all**, internal or external, so every writer of `.clarvis` — `tools`,
`trace`, `mcp-client`, `skills`, `memory`, `plan`, `loop`, `kernel`, `server` and `code` — can
depend on it without gaining an edge to anything else. It uses only `node:path`, `node:os`,
`node:fs`, `node:fs/promises` and `node:crypto`, with no literal separators and no POSIX
assumptions. It is the _filesystem_ leaf, which is why the atomic-write family lives here rather
than in `@clarvis/capability` — that one is the platform-free contract leaf and touches no Node
builtin at all.

`withoutGitRepositoryEnvironment` copies an environment while removing Git's repository-routing,
storage, index, and local-configuration variables plus `GIT_CEILING_DIRECTORIES`. Git callers that
select a repository through `cwd`, `-C`, or a clone destination use it so inherited repository state
cannot redirect the child. Transport and credential variables remain available. This shared
platform helper lives here rather than in the capability contract because its case comparison follows
the host operating system.

```ts
import { globalPaths, workspacePaths, workspaceStatePaths } from "@clarvis/paths";

const ws = workspacePaths("/work/repo");
ws.plansRoot; //                /work/repo/.clarvis/plans

const st = workspaceStatePaths("/work/repo");
st.monitorSidecar("mon_ab"); // ~/.clarvis/state/workspaces/ws_<sha256>/local/monitor-mon_ab.json
st.diagnosticsDir; //             ~/.clarvis/state/workspaces/ws_<sha256>/local/diagnostics

const g = globalPaths(); //     $CLARVIS_HOME ?? ~/.clarvis
g.settingsFile; //              …/settings.json
g.pluginsDir; //                …/plugins (Clarvis-native global plugin inventory)
g.pluginDataRoot; //            …/state/plugin-data (persistent runtime data)
g.subscriptionsFile; //         …/subscriptions.json (renewable subscription credentials)
g.mcpOAuthFile; //              …/state/mcp-oauth.json (remote MCP registrations and tokens)
g.tracesDir; //                 …/state/traces
g.extensionProfilesDir; //           …/extension-profiles (operator-authored definitions)
g.runtimeRecipesDir; //               …/runtime-recipes (operator-authored Docker scripts)
g.extensionProfileSelectionFile; //  …/state/extension-profile.json (operator-wide default)
g.updateCheckCacheFile; //             …/cache/update-check.json (discardable version-check result)
g.runtimeRecipeStateDir; //            …/state/runtime-recipes (host build coordination)
g.runtimeRecipeLeaseFile("sha256:…"); // …/state/runtime-recipes/<segment>.lock
```

Two environment variables override the roots: `CLARVIS_HOME` and `CLARVIS_WORKSPACE_ROOT`.
The second is the name `@clarvis/hooks` already injects into every hook subprocess, so a hook
that invokes Clarvis inherits a variable that points at the right tree. They replaced
`CLARVIS_SERVER_CONFIG_DIR`, `CLARVIS_SERVER_WORKSPACE` and `CLARVIS_CODE_WORKSPACE`, which are
removed rather than deprecated.

## The four trees

`<ws>/.clarvis` holds what a human authors or reads plus one explicitly ignored Git-owned checkout
root. `settings.json`, `agents/`, `skills/`,
`plugins/`, `extension-profiles/`, `workflows/` and `guard-judge.md` are the workspace's own configuration and belong in its
history; `plans/` and `memory/` are generated Markdown the user is expected to open mid-run.
`worktrees/` contains operator-requested linked checkouts anchored in the primary worktree and is
always excluded by `.clarvis/.gitignore` before Git creates a checkout.

`<global>/state/workspaces/<segment>/` holds that workspace's **machinery** — `local/` (prompt
history, the UI's `code.json`, bounded opt-in diagnostics, per-run temporary roots, monitor sidecars and logs, shell and tool-result spills), the memory
wiki's `.history`/`.journal`/`.state`/`.lock`, and the plan lockfiles. The segment is
`ownerSegment(ownerFromWorkspace(root))`, the same composition `state/traces` and `state/sessions`
already use, so one workspace's generated data all lands under one name.
The workspace's active Extension Profile selection is also local machinery under that `local/`
tree, so switching Extension Profiles never dirties the repository.
The sibling `runtimes/` tree owns only host-accepted per-run checkpoints beneath each encoded
isolated-runtime generation. Runtime and run IDs pass through `ownerSegment`; no workspace copy,
baseline, apply journal, transaction staging, registry or lifecycle record is stored there. The
container mounts the already-selected workspace directly, so that checkout remains outside runtime
state and outside runtime cleanup.

`~/.clarvis` keeps the **operator's own files at the root** — `settings.json`, `agents/`,
`keys.json`, `subscriptions.json`, plugins, reusable Extension Profile definitions and their trust
records, Docker runtime recipes, `guard-judge.md`, `auth.json` — and nests only what a user never
edits: `state/` (sessions, traces, remote MCP OAuth credentials, workflow records, content-addressed
runtime-recipe build leases, the per-workspace machinery above), `cache/` (including the models.dev
snapshot and automatic version-check result), `exports/`. A `config/` layer was tried and removed:
it made the global tree disagree with
the workspace one, where `settings.json` and `agents/` have always sat at the root. This physical
layout stays stable; operator inventory classifies it logically rather than moving files into a new
hierarchy.

`.agents` is not one uniformly read-only tree. Standalone skills and marketplace documents remain
foreign/user-authored inputs, while `.agents/plugins/<name>/` is a first-class plugin inventory
beside `.clarvis/plugins/<name>/`. `agentsPluginsDirs()` returns its global and workspace roots;
managed global installs may target either global convention, and both workspace plugin roots remain
repository-owned rather than lifecycle-managed by the UI. Persistent `PLUGIN_DATA` never enters an
installed checkout: global instances use `<global>/state/plugin-data/<source>/<name>/`, and
workspace instances use that workspace's machine-local `plugin-data/<source>/<name>/` state tree.

Definition and selection ownership is specified in
[`hosts/extension-profiles.md`](../../specs/hosts/extension-profiles.md): authored definitions live in the
global/workspace roots, while global and per-workspace choices live in generated state.

**The separation is enforced by the type, not by convention.** `WorkspacePaths` has no key naming
`local/`, a monitor file, a spill, prompt history or `code.json` — they were _removed_ rather than
deprecated, so writing generated bookkeeping into someone's working tree is a compile error.
`workspaceStatePaths` is the only way to spell them. The keys used to be on `WorkspacePaths`, and
four writers reached them through a hand-rolled `mkdir` that skipped `ensureLocalDir` entirely; the
worst was `code`'s prompt history, which fired on the first Enter — before any tool had run, so
before anything had seeded the ignore file — leaving a fresh repository reporting `?? .clarvis/`
after a single prompt, at the ambient umask rather than `0700`/`0600`.

One residue is unavoidable and deliberate: `plans/` and `memory/` still receive **transient**
`.clarvis-tmp-*` siblings, because `rename` is atomic only within one filesystem and an atomic
write's temp file must sit beside its target. `TMP_GLOB` and `INTERNAL_IGNORE_PATTERNS` already hide
them. `packages/kernel/tests/architecture/workspace-surface.test.ts` asserts that everything else under those two
directories ends in `.md`.

`workflowsDir` is authored config; `workflowRecordsDir` is generated history. Both would have been
called `workflows`, so the record store was renamed rather than left to collide. Authored
`WORKFLOW.md` documents are deliberately **not** gitignored — a workflow is configuration a
workspace keeps, exactly like an agent or a skill.

## Windows is a hard constraint here

`which.ts` (`executableOnPath`, `resolveCommand`) is a `PATH`/`PATHEXT` resolver whose whole reason
to exist is Windows, so **the Windows CI job runs this package's suite** alongside `@clarvis/tools`'.
That job has no build step and resolves both from source, so the `"bun": "./src/index.ts"` export
condition is what keeps it working.

`which.ts` arrived from `@clarvis/tools`, which already depended on this package — so the move added
no edge, and it is what kept `@clarvis/mcp-client` from having to depend on `@clarvis/tools` for one
PATH lookup, which would have made an `optionalDependencies` entry of the loop permanently
non-optional. `@clarvis/tools` re-exports both, so its consumers saw nothing.

## Test ownership

The package suite is classified by the effect boundary each file owns:

- `tests/unit/` covers pure path/root resolution and owner-segment policies;
- `tests/component/` covers the composed global, workspace and workspace-state path surfaces. The
  three existing `ensureWorkspaceStateDir` cases remain with `workspace-state.test.ts` during the
  behavior-preserving classification phase; splitting that file is a later cleanup, not part of
  this move;
- `tests/contract/` owns the atomic/durable write family across async and sync variants. Its real
  filesystem, rename and fsync effects are part of that contract and are deliberately not mocked;
- `tests/integration/` covers filesystem creation and housekeeping plus the real `PATH`/`PATHEXT`
  lookup boundary through the published package entrypoint;
- `tests/architecture/` owns only the repository-wide directory-vocabulary scan. The generic package
  graph belongs to `tooling/lib/package-graph.ts`, whose fixtures run under root `lint:intent`.
  Architecture runs separately after source coverage, because a repository scan is not source
  behavior coverage.

`bun run test` discovers all five tiers. Each tier also has a `test:<tier>` script for targeted runs,
and `test:coverage` executes every source-behavior tier before running architecture once without
coverage. The Windows CI command remains the full package suite, so moving `which.test.ts` under
`tests/integration/` does not drop the Windows cases.

## Writing to disk

`ensureWorkspaceDir` seeds `<ws>/.clarvis/.gitignore` and reconciles the mandatory `worktrees/`
exclusion into an existing hand-edited file without replacing its other content.
`ensureWorkspaceSubdir` is how the two generated Markdown trees get created — it seeds the parent ignore file in the same call, so `plans/`
and `memory/` can no longer arrive before it. Seeding deterministically is a problem of _two
creators_, and solving it requires that creation have a single owner too. Seeding uses
exclusive-create, so a hand-edited ignore file survives: determinism comes from every entry point
calling these, not from overwriting what they find.

`ensureWorkspaceStateDir` / `ensureWorkspaceLocalDir` are the machinery-side equivalents and seed
**no** ignore file, because nothing they create is inside a repository. That is also why
`WORKSPACE_GITIGNORE` no longer lists `local/`, and why `LOCAL_GITIGNORE` is gone.

`DIR_MODE` (`0o700`) and `FILE_MODE` (`0o600`) are the posture everything Clarvis creates gets.
Windows honours only the write bit and that is accepted — a platform that cannot express the mode
must not turn a write into an error.

### The atomic-write family

The monorepo held **eight** copies of "write to a tmp file, then rename", and they had already
diverged on the property that matters. Four kernel modules and `code` used `.tmp.${pid}` /
`.tmp-${pid}`, which is safe against two _processes_ and not against two writers inside one;
`memory` used `.${pid}.${counter}.tmp` and `trace` `.tmp-${randomUUID()}`, which are; and
`@clarvis/server` wrote its Ed25519 signing key to a bare `${file}.tmp` with **no pid at all**, so
two boots racing that one file collided on a single temp path. Nobody had filed it.

```ts
await writeFileAtomic(file, text); // tmp + rename; 0600 file, 0700 parents
await writeFileDurable(file, text); // + fsync payload before rename, fsync dir after
writeFileAtomicSync(file, text); // for the config/session writers that cannot await
writeFileDurableSync(file, text);
```

- **`tmpPathFor` ships with `isTmpFile`**, for the reason `monitorSidecar` ships with
  `isMonitorSidecar`: `@clarvis/trace` carried a private `/\.json\.tmp-/` recognising a shape
  six other modules built independently, which is the spill defect again. The name is
  `<dir>/.clarvis-tmp-<pid>-<counter>-<uuid>` — the pid makes an orphan attributable, the counter
  separates two writers inside one process, the UUID makes the whole thing collision-free. It is a
  _sibling_ of the target because `rename` is only atomic within one filesystem, and because it is
  a **prefix**, `TMP_GLOB` and `INTERNAL_IGNORE_PATTERNS` already hide every orphan from
  `grep`/`glob` and from git with no further rule.
- **`writeFileDurable` is a separate function, not a flag.** `rename` is atomic but not durable:
  after a power loss the kernel may reorder it ahead of the data it publishes, leaving a journal
  entry pointing at bytes that never landed — and a recovery matrix reasoning over such a journal
  would be theatre. `@clarvis/memory`'s batch journal and `@clarvis/trace`'s record insert both
  depend on it. Collapsing the two would either charge every ordinary write two `fsync`s or quietly
  downgrade the writes that back a crash-recovery guarantee.
- **An existing target's permission bits are not preserved.** The point of routing every writer
  through here is that a Clarvis-owned file has exactly one posture; a caller passing `mode` is
  stating a deliberate exception.

### Local filesystem leases

`acquireLocalLease` is the process-shared lock primitive for short local persistence transactions.
It publishes an immutable `{ pid, host, token, acquiredAt }` record by hard-linking a fully written
and fsync'd sibling temp into the canonical lock path, so a crash may leave a valid lease or a hidden
temp orphan but cannot publish a new empty/partial lock. The holder renews the canonical inode mtime,
coalescing timer pressure into at most one active renewal plus one pending request, checks token plus
file identity before fenced work, and releases by atomically moving the directory entry to quarantine
before validating and deleting it. Release stops new heartbeat requests and drains only the active
renewal, rather than an accumulated timer chain. A successor raced into that entry is restored, not
unlinked. If that final detach fails transiently, the holder retires only its exact token and inode
in-process, allowing a later local acquisition to finish cleanup without treating another inode at
the same path as abandoned. Reclamation also publishes a unique recovery intent before detaching
the canonical name. Acquirers check those intents on both sides of publication, and the reclaimer
revalidates the observed inode under the intent. Intent names are never reused, so crash cleanup can
remove one exact stale contender without recreating the ABA problem it prevents. This closes the
three-contender window where a delayed reclaimer could otherwise quarantine a live successor long
enough for another process to acquire its path. The empty recovery directory remains as a stable
namespace: removing it would race a concurrent creator between its `mkdir` and marker publication.

Apart from an exact identity explicitly retired by this process, recovery waits for the configured
stale grace. A valid same-host record is reclaimed only after its process is known dead; a stale
foreign-host record fails closed because this process cannot prove the remote PID dead. A legacy
empty/partial record becomes reclaimable after the same grace rather than wedging the caller forever.
`reclaimLocalLeaseSync` carries the identical policy for synchronous cleanup paths. These are
local-filesystem leases, not a distributed consensus protocol and must not be presented as
NFS/multi-host coordination.

Every acquired asynchronous lease must be released, including after `renew()`, `owned()` or
`assertOwned()` reports ownership loss. In that state `release()` returns `false` because it cannot
remove the canonical entry as its own, but it still stops heartbeat work and closes the held file
handle. Leaving a lost lease unreleased delegates descriptor cleanup to runtime garbage collection.

`acquireLocalLeaseSync` publishes and releases the same record synchronously, with no contention
wait or heartbeat. It exists only for APIs whose whole filesystem transaction is synchronous; an
asynchronous caller uses `acquireLocalLease` so it never blocks the event loop while waiting.

### Renaming over an existing file on Windows

`rename` onto an existing path is a real hazard on Windows and not on POSIX: an antivirus, the
search indexer or an editor momentarily holding the destination makes `MoveFileEx` fail with
`EPERM`/`EACCES`/`EBUSY` for a few tens of milliseconds. **The decision is to retry, and only
there** — `renameWithRetry`/`renameWithRetrySync` back off over `RENAME_RETRY_DELAYS_MS`
(`10/25/50/100 ms`, five attempts in all), gated on the platform _as well as_ the errno, because a
POSIX `EPERM` is a sticky-bit denial that will never clear and must not be delayed by 185 ms. Every
other errno propagates on the first attempt on both platforms. `platform`, `delays` and `rename`
are injectable, which is how the Windows branch is tested from a POSIX host.

Two exposures remain, documented rather than papered over: `MoveFileEx` refuses to replace a
destination carrying the read-only attribute (a permanent failure no retry helps, and clearing the
attribute would be a behaviour change rather than a portability fix), and a holder that keeps the
destination open past the schedule still fails the write.

`fsyncDir`/`fsyncDirSync` never throw, because Windows will not open or sync a directory handle at
all and several filesystems reject the `fsync`. Left unguarded that turns every durable write on
Windows into a failure _after_ the file has already landed.

### The resolve family

`expandHome`, `resolveAgainst` and `resolveWorkspaceDir` were forked verbatim between
`@clarvis/loop` and `@clarvis/skills`, whose copy claimed the family sourced one implementation
from the loop — impossible, since `skills` is an optional feature package and may never import the
engine. Both already depend on this one. Only the two forms a shell itself produces are expanded:
a bare `~` and a `~/…` prefix. `~foo` is another user's home directory, which is a different lookup
with a different failure mode, and `~\foo` is not a spelling these values ever arrive in.

## Diagnostics

This package writes nothing to `stdout` or `stderr` — `@clarvis/code` imports it to locate the two
roots _before a kernel exists_, so a console fallback would paint over the terminal UI's first frame.
Every event goes to a `PathsLogger`, a local structural re-declaration of `@clarvis/capability`'s
`Logger` (this package has no dependencies, and `tooling/checks/package-graph.ts` enforces that; the
drift test lives in `packages/loop/tests/integration/execute-run-entrypoints.test.ts`, which is the
lowest place that can see both shapes). The default is always the no-op.

Most sites take their logger on the options bag they already have —
`LocalLeaseRecoveryOptions`/`AcquireLocalLeaseOptions`, `AtomicWriteOptions`, `RenameRetryOptions`,
`sweepSpillDir`'s options, `RootOptions`. The four entry points that have no options bag at all
(`ensureWorkspaceDir`, `ensureWorkspaceSubdir`, `fsyncDir`, `resolveCommand` — roughly seventy call
sites between them) reach the process-wide `setPathsLogger` sink instead. That sink is **host boot
only, never per run**: one slot, last writer wins, which is correct for one host process and
ambiguous the moment two share one. `@clarvis/loop`'s `buildExecuteRunDeps` installs it.

| Level | Event                           | Fields                                                                                                                    |
| ----- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| warn  | `paths.lease_reclaimed`         | `path`, `prior_pid`, `prior_host`, `age_ms`, `reason` (`retired`/`dead_pid`/`no_record`)                                  |
| warn  | `paths.lease_lost`              | `path`, `token`, `phase` (`renew`/`release`/`stat`)                                                                       |
| warn  | `paths.atomic_staging_failed`   | `file`, `code`, `durable`, `tmp_removed`                                                                                  |
| debug | `paths.lease_reclaim_refused`   | `path`, `stage` (`identity_changed`/`rename_failed`/`quarantine_mismatch`/`unlink_failed`)                                |
| debug | `paths.lease_contended`         | `path`, `attempt`, `waited_ms`                                                                                            |
| debug | `paths.rename_retried`          | `to`, `attempt`, `code`, `backoff_ms`                                                                                     |
| debug | `paths.fsync_dir_unsupported`   | `dir`, `code` — once per process per errno                                                                                |
| debug | `paths.gitignore_seed_skipped`  | `file`, `code` — `EEXIST` is normal, `EACCES`/`EROFS` are not                                                             |
| warn  | `paths.gitignore_update_failed` | `file`, `code` — an existing ignore file could not receive the mandatory `worktrees/` exclusion                           |
| debug | `paths.spill_sweep`             | `dir`, `scanned`, `candidates`, `removed`, `truncated`                                                                    |
| debug | `paths.roots_resolved`          | `global_root`/`workspace_root`, `global_from` (`env`/`home`) / `workspace_from` (`env`/`cwd`) — once per process per root |
| debug | `paths.command_resolved`        | `command`, `resolved`, `found` — once per command, because the answer is memoized                                         |

Three of these exist because the code path they describe resolves to a boolean nobody can read:

- **`paths.lease_reclaimed`** is the densest blind spot the package had. Taking another process's
  lock on a stale-mtime plus dead-PID judgement recorded nothing at all, and if that judgement is
  wrong two holders both believe they own the path.
- **`paths.fsync_dir_unsupported`** is the only way an operator can learn that
  `writeFileDurable` has silently degraded to `writeFileAtomic` — `fsyncDir` treats "this filesystem
  will not sync a directory handle" as a no-op, and every crash-recovery guarantee in the product
  rests on that `fsync`.
- **`paths.atomic_staging_failed`**'s `tmp_removed` is the half the thrown error never carries. A
  failed cleanup leaks a `.clarvis-tmp-*` orphan that `TMP_GLOB` hides from `grep`, from `glob` and
  from git, so nothing else would ever mention it.

`paths.spill_sweep`'s `truncated` is the same class: `sweepSpillDir` stops at 10,000 entries and
returns `void`, so a workspace past that threshold would otherwise stop being swept silently and
permanently.

## Owner segments

Owner-derived builders take the **raw owner id** and encode it themselves:
`exportsDirForOwner`, `plansRootForOwner`, `memoryRootForOwner`,
`plansLockDirForOwner` and `memoryMachineryRootForOwner`. A caller cannot forget
the encoding step and let `../escape` leave its owner root. `ownerSegment` remains
public for flat filenames and stores that do not use one of these builders.

`ownerFromWorkspace` derives the default local owner as `ws_<sha256>` over the
resolved workspace path. The earlier separator-to-underscore slug was lossy:
`/a/b` and `/a_b` both became `_a_b`, so their workspace state could be merged.
The hash is fixed-width, filesystem-safe and preserves the complete path as the
identity input.

This is a pre-release persistence-format migration. Existing default-owner and
per-workspace state directories keep their bytes on disk, but the new version
does not address them through the old lossy slug. Clarvis remains pre-1.0;
there is no legacy fallback that could reintroduce the collision.

The two encoders used to live in `@clarvis/loop`, while the loop was their only caller. They moved when
`@clarvis/trace`'s store, `@clarvis/mcp-client`'s pool and `@clarvis/memory`'s capability adapter
each came to need one — a value two packages need belongs in the leaf both can reach, and these need
nothing beyond the Node path and crypto primitives. `@clarvis/loop` re-exports them from `host.ts`, so `kernel` and `code`
never saw the move.
