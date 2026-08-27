# Directory vocabulary, atomic writes and local leases

> Implemented at `packages/paths/src/**` and `packages/paths/tests/**` (plus
> `packages/kernel/tests/architecture/workspace-surface.test.ts`, the one test outside the package
> that pins its cross-cutting rule). Every claim below is anchored to a file and line. Open
> questions are collected in the final section.

## 1. Purpose

`@clarvis/paths` is the single owner of Clarvis's on-disk directory vocabulary — the literals
`.clarvis` and `.agents`, the temp-file prefix, and every path built from them — plus the
filesystem primitives that make writing into that vocabulary safe: atomic write-then-rename,
directory `fsync`, and a crash-recoverable local lease. It is a leaf with **zero dependencies**,
internal or external (`packages/paths/package.json:1` lists no `dependencies` key at all, and
`packages/paths/src/diag.ts:20` states the package "has no dependencies at all, internal or
external"), so every other package in the graph can depend on it without gaining an edge to
anything else (`packages/paths/src/index.ts:22`).

The problem it solves is stated directly in its own module doc: "Every other package reaches
`.clarvis` and `.agents` through this module and never spells either literal itself. That is what
keeps the naming conventions … from drifting apart across eight packages, which is how a sweeper
came to look for files no writer ever produced." (`packages/paths/src/index.ts:6-10`). A second,
narrower problem is durability: the atomic-write family "replaces seven hand-rolled tmp-and-rename
copies that had already diverged on the property that matters — one of them raced two processes
onto a single temp name" (`packages/paths/src/index.ts:14-16`, and see `packages/paths/src/
packages/paths/src/atomic.ts:44-46`, naming `@clarvis/server`'s signing key as the concrete instance: "written to a
bare `<file>.tmp`, so two boots racing the same key file collided on one temp path"). A third,
narrower reason covers the **resolve** family (`expandHome`, `resolveAgainst`,
`resolveWorkspaceDir`, §2.11): those three functions "were forked verbatim between the engine and
an optional feature package that is structurally forbidden from importing it," so this
dependency-free leaf is the only place both could share them (`packages/paths/src/index.ts:17-20`).

The package draws one structural line through everything it builds: a workspace's `<ws>/.clarvis`
tree holds only what a human authors or reads, and every byte of generated machinery — monitor
sidecars, shell spills, prompt history, the memory wiki's journal, plan lockfiles — lives instead
under the user's **global** root, keyed per workspace. That split is enforced by the *type
system*, not by convention: `WorkspacePaths` (`packages/paths/src/workspace.ts:35`) simply has no
key for any of that machinery, so writing it into a repository is a compile error rather than a
possibility to remember to avoid (`packages/paths/src/workspace.ts:24-29`).

## 2. Surface

### 2.1 Exports map

One entrypoint (`packages/paths/package.json:12-19`):

| Subpath | `bun` | `types` | `import` |
|---|---|---|---|
| `.` | `./src/index.ts` | `./dist/index.d.ts` | `./dist/index.js` |
| `./package.json` | *(literal)* | — | — |

### 2.1.1 Git repository environment filtering

`withoutGitRepositoryEnvironment(source)` returns a fresh environment without Git's complete
repository-local variable set or `GIT_CEILING_DIRECTORIES`. Names compare exactly on POSIX and
case-insensitively on Windows. The helper deliberately preserves transport and credential inputs:
callers use it before `cwd`, `-C`, or a clone destination selects the intended repository, preventing
inherited repository routing, index, object-store, work-tree, and local-config state from redirecting
the child.

Production: `packages/paths/src/git-environment.ts` (`withoutGitRepositoryEnvironment`).
Test: `packages/paths/tests/unit/git-environment.test.ts`.

### 2.2 Constants (`packages/paths/src/constants.ts`)

| Symbol | Value | Line |
|---|---|---|
| `CLARVIS_DIR` | `".clarvis"` | `packages/paths/src/constants.ts:8` |
| `AGENTS_DIR` | `".agents"` | `packages/paths/src/constants.ts:18` |
| `AGENTS_PLUGINS_DIR` | `"plugins"` | `packages/paths/src/constants.ts:24` |
| `MARKETPLACE_FILE` | `"marketplace.json"` | `packages/paths/src/constants.ts:27` |
| `TMP_PREFIX` | `".clarvis-tmp-"` | `packages/paths/src/constants.ts:30` |
| `DIR_MODE` | `0o700` | `packages/paths/src/constants.ts:40` |
| `FILE_MODE` | `0o600` | `packages/paths/src/constants.ts:52` |
| `TMP_GLOB` | `` `${TMP_PREFIX}*` `` | `packages/paths/src/constants.ts:55` |
| `MONITOR_PREFIX` | `"monitor-"` | `packages/paths/src/constants.ts:58` |
| `SPILL_PREFIX` | `"shell-"` | `packages/paths/src/constants.ts:61` |
| `TOOL_OUTPUT_PREFIX` | `"toolout-"` | `packages/paths/src/constants.ts:64` |
| `TOOL_OUTPUT_SUFFIX` | `".txt"` | `packages/paths/src/constants.ts:67` |
| `MONITOR_SIDECAR_SUFFIX` | `".json"` | `packages/paths/src/constants.ts:70` |
| `LOG_SUFFIX` | `".log"` | `packages/paths/src/constants.ts:73` |
| `CONTEXT_FILENAMES` | `["CLARVIS.md", "AGENTS.md"]` | `packages/paths/src/constants.ts:82` |
| `INTERNAL_SKIP_DIRS` | `[".git","node_modules","dist",CLARVIS_DIR,".next","coverage","build"]` | `packages/paths/src/constants.ts:93-101` |
| `INTERNAL_IGNORE_PATTERNS` | `[".git", CLARVIS_DIR, TMP_GLOB]` | `packages/paths/src/constants.ts:110` |

`INTERNAL_SKIP_DIRS` bounds a structural tree walk; `INTERNAL_IGNORE_PATTERNS` is applied beneath
user-supplied `grep`/`glob` ignore sources, and deliberately omits `AGENTS_DIR` — "it is the user's
own content, and `grep`/`glob` are expected to see it" (`packages/paths/src/constants.ts:107-108`). The two lists
"differ because they answer different questions, not because they drifted" (`packages/paths/src/constants.ts:88-91`).

### 2.3 Roots (`packages/paths/src/roots.ts`)

| Symbol | Kind | Line | What it does |
|---|---|---|---|
| `HOME_ENV` | const | `packages/paths/src/roots.ts:11` | `"CLARVIS_HOME"` |
| `WORKSPACE_ENV` | const | `packages/paths/src/roots.ts:21` | `"CLARVIS_WORKSPACE_ROOT"` |
| `RootOptions` | interface | `packages/paths/src/roots.ts:31` | `{ env?, home?, cwd?, logger? }` — every ambient input is injectable |
| `globalRoot(opts?)` | fn | `packages/paths/src/roots.ts:71` | `$CLARVIS_HOME`, else `resolve(<home>/.clarvis)` |
| `workspaceRoot(opts?)` | fn | `packages/paths/src/roots.ts:95` | `$CLARVIS_WORKSPACE_ROOT`, else `resolve(cwd)` |
| `ownerFromWorkspace(dir, fallback?)` | fn | `packages/paths/src/roots.ts:124` | `ws_<sha256hex>` of the canonical absolute path |
| `workspaceScopeKey(owner, projectId, workspaceId)` | fn | `packages/paths/src/roots.ts:130` | stable `scope_<sha256hex>` namespace over all three identity components |
| `worktreeCheckoutRoot(primaryWorkspaceRoot, name)` | fn | `packages/paths/src/roots.ts` | canonical encoded checkout path under the primary worktree; detailed in §2.13 |
| `ownerSegment(value)` | fn | `packages/paths/src/roots.ts:173` | encodes an arbitrary id as one safe path segment |

`WORKSPACE_ENV` is the same variable name `@clarvis/hooks` injects into every hook subprocess
(stated at `packages/paths/src/roots.ts:16-19`), so a hook that invokes Clarvis inherits a pointer at the right tree.
An environment override is read through `override()` (`packages/paths/src/roots.ts:55-63`), which treats a blank or
whitespace-only value as unset.

`workspaceScopeKey` hashes `owner`, `projectId`, and `workspaceId` with NUL separators, so changing
any one component selects a different fixed-width state namespace without allowing an identifier to
be interpreted as a path segment. Production: `packages/paths/src/roots.ts:129-132`. Test:
`packages/paths/tests/unit/roots.test.ts:127-135`.

Both `globalRoot` and `workspaceRoot` log a `paths.roots_resolved` diagnostic the first time a
given resolved value is seen in the process, gated by `announceOnce` (`packages/paths/src/roots.ts:76-87` for the
global root, `:99-109` for the workspace root): `global_root`/`global_from` (`"home"` or `"env"`)
or `workspace_root`/`workspace_from` (`"cwd"` or `"env"`). The `RootOptions.logger` field's own doc
frames this as foundational: "which root a process chose — and whether an environment override
chose it — is the first thing every other path in this package is derived from" (`packages/paths/src/roots.ts:41-43`).

### 2.4 Global paths (`packages/paths/src/global.ts`)

`globalPaths(root?, opts?)` (`packages/paths/src/global.ts:105`) returns a `GlobalPaths` record
(`packages/paths/src/global.ts:21`) rooted at `<global>`:

| Field | Path | Line |
|---|---|---|
| `root` | `<global>` | `packages/paths/src/global.ts:111` |
| `state` | `<global>/state` | `packages/paths/src/global.ts:107,112` |
| `cache` | `<global>/cache` | `packages/paths/src/global.ts:108,113` |
| `settingsFile` | `<global>/settings.json` | `packages/paths/src/global.ts:114` |
| `agentsDir` | `<global>/agents` | `packages/paths/src/global.ts:109,115` |
| `keysFile` | `<global>/keys.json` | `packages/paths/src/global.ts:116` |
| `subscriptionsFile` | `<global>/subscriptions.json` | `packages/paths/src/global.ts:117` |
| `mcpOAuthFile` | `<global>/state/mcp-oauth.json` | `packages/paths/src/global.ts:118` |
| `pluginsDir` | `<global>/plugins` | `packages/paths/src/global.ts:119` |
| `hookTrustFile` | `<global>/hook-trust.json` | `packages/paths/src/global.ts:120` |
| `workspaceTrustFile` | `<global>/workspace-trust.json` | `packages/paths/src/global.ts:121` |
| `skillsDir` | `<global>/skills` | `packages/paths/src/global.ts:122` |
| `workflowsDir` | `<global>/workflows` | `packages/paths/src/global.ts:123` |
| `guardJudgeFile` | `<global>/guard-judge.md` | `packages/paths/src/global.ts:124` |
| `memoryPolicyFile` | `<global>/memory-policy.md` | `packages/paths/src/global.ts:125` |
| `authFile` | `<global>/auth.json` | `packages/paths/src/global.ts:126` |
| `authKeyFile` | `<global>/auth-key.json` | `packages/paths/src/global.ts:127` |
| `sessionsDir` | `<global>/state/sessions` | `packages/paths/src/global.ts:128` |
| `tracesDir` | `<global>/state/traces` | `packages/paths/src/global.ts:129` |
| `workflowRecordsDir` | `<global>/state/workflows` | `packages/paths/src/global.ts:130` |
| `codeConfigFile` | `<global>/state/code.json` | `packages/paths/src/global.ts:131` |
| `modelsCacheFile` | `<global>/cache/models-dev.json` | `packages/paths/src/global.ts:132` |
| `contextCandidates` | `<global>/{CLARVIS.md,AGENTS.md}` | `packages/paths/src/global.ts:133` |
| `exportsDirForOwner(owner)` | `<global>/exports/<ownerSegment(owner)>` | `packages/paths/src/global.ts:134` |
| `agentFile(name)` | `<agentsDir>/<name>.md` | `packages/paths/src/global.ts:135` |

The module doc explains the placement: "Operator-owned configuration sits at the root, not under
a `config/` subdirectory" — burying it "made the global tree disagree with the workspace one"
(`packages/paths/src/global.ts:10-15`). What is nested under `state`/`cache` is what a user never edits: `state` is
"generated and recoverable but costly to lose", `cache` "may be deleted at any moment without
consequence" (`packages/paths/src/global.ts:17-19`).

### 2.5 Workspace paths (`packages/paths/src/workspace.ts`)

`workspacePaths(root?, opts?)` (`packages/paths/src/workspace.ts:100`) returns a `WorkspacePaths` record
(`packages/paths/src/workspace.ts:35`) rooted at `<ws>/.clarvis`:

| Field | Path | Line |
|---|---|---|
| `root` | working tree root | `packages/paths/src/workspace.ts:106` |
| `clarvisDir` | `<ws>/.clarvis` | `packages/paths/src/workspace.ts:102,107` |
| `settingsFile` | `<ws>/.clarvis/settings.json` | `packages/paths/src/workspace.ts:108` |
| `agentsDir` | `<ws>/.clarvis/agents` | `packages/paths/src/workspace.ts:103,109` |
| `skillsDir` | `<ws>/.clarvis/skills` | `packages/paths/src/workspace.ts:110` |
| `workflowsDir` | `<ws>/.clarvis/workflows` | `packages/paths/src/workspace.ts:111` |
| `pluginsDir` | `<ws>/.clarvis/plugins` | `packages/paths/src/workspace.ts:112` |
| `guardJudgeFile` | `<ws>/.clarvis/guard-judge.md` | `packages/paths/src/workspace.ts:113` |
| `memoryPolicyFile` | `<ws>/.clarvis/memory-policy.md` | `packages/paths/src/workspace.ts:114` |
| `plansRoot` | `<ws>/.clarvis/plans` | `packages/paths/src/workspace.ts:115` |
| `memoryRoot` | `<ws>/.clarvis/memory` | `packages/paths/src/workspace.ts:116` |
| `contextCandidates` | `<ws>/{CLARVIS.md,AGENTS.md}` | `packages/paths/src/workspace.ts:117` |
| `plansRootForOwner(owner)` | `<ws>/.clarvis/owners/<seg>/plans` | `packages/paths/src/workspace.ts:118` |
| `memoryRootForOwner(owner)` | `<ws>/.clarvis/owners/<seg>/memory` | `packages/paths/src/workspace.ts:119` |
| `agentFile(name)` | `<agentsDir>/<name>.md` | `packages/paths/src/workspace.ts:120` |

Interface doc: "Machinery is deliberately **absent from this type**… The keys are removed rather
than deprecated so that writing generated bookkeeping into someone's working tree is a compile
error rather than a convention." (`packages/paths/src/workspace.ts:24-29`). The one residue kept is transient: an
atomic write's temp file must be a sibling of its target inside the same filesystem
(`packages/paths/src/workspace.ts:31-33`).

Supporting functions, all read-only against `.agents` (`packages/paths/src/workspace.ts:130-191`):

| Symbol | Line | What it returns |
|---|---|---|
| `agentsSkillsDirs(opts?)` | `packages/paths/src/workspace.ts:134` | `{ user: <home>/.agents/skills, workspace: <ws>/.agents/skills }` |
| `agentsMarketplaceFile(root)` | `packages/paths/src/workspace.ts:153` | `<root>/.agents/plugins/marketplace.json` |
| `agentsMarketplaceFiles(opts?)` | `packages/paths/src/workspace.ts:163` | the same, for both `home` and `workspaceRoot` |
| `isAgentsMarketplaceFile(candidate)` | `packages/paths/src/workspace.ts:183` | predicate matching the last three path segments |

### 2.6 Per-workspace machine state (`packages/paths/src/workspace-state.ts`)

`workspaceStatePaths(root?, opts?)` (`packages/paths/src/workspace-state.ts:171`) returns a `WorkspaceStatePaths`
record (`packages/paths/src/workspace-state.ts:36`) rooted at `<global>/state/workspaces/<segment>`, where
`segment = ownerSegment(ownerFromWorkspace(root))` (`packages/paths/src/workspace-state.ts:157-159,173`):

| Field | Path | Line |
|---|---|---|
| `root` | `<global>/state/workspaces/<segment>` | `packages/paths/src/workspace-state.ts:173,177` |
| `workspaceRoot` | the resolved working tree | `packages/paths/src/workspace-state.ts:178` |
| `localDir` | `<root>/local` | `packages/paths/src/workspace-state.ts:174,179` |
| `diagnosticsDir` | `<root>/local/diagnostics` | `packages/paths/src/workspace-state.ts:180` |
| `memoryMachineryRoot` | `<root>/memory` | `packages/paths/src/workspace-state.ts:181` |
| `plansLockDir` | `<root>/plans` | `packages/paths/src/workspace-state.ts:182` |
| `promptHistoryFile` | `<root>/local/prompt-history` | `packages/paths/src/workspace-state.ts:183` |
| `codeConfigFile` | `<root>/local/code.json` | `packages/paths/src/workspace-state.ts:184` |
| `runTempDir(executionId)` | `<root>/local/runs/<ownerSegment(executionId)>/tmp` | `WorkspaceStatePaths.runTempDir`, `workspaceStatePaths` |
| `memoryMachineryRootForOwner(owner)` | `<root>/owners/<seg>/memory` | `packages/paths/src/workspace-state.ts:185` |
| `plansLockDirForOwner(owner)` | `<root>/owners/<seg>/plans` | `packages/paths/src/workspace-state.ts:186` |
| `monitorSidecar(id)` | `<localDir>/monitor-<id>.json` | `packages/paths/src/workspace-state.ts:187-188` |
| `monitorLog(id)` | `<localDir>/monitor-<id>.log` | `packages/paths/src/workspace-state.ts:189` |
| `monitorExit(id)` | `<localDir>/monitor-<id>.exit` | `packages/paths/src/workspace-state.ts:190` |
| `spillFile(token, stream)` | `<localDir>/shell-<token>.<stream>.log` | `packages/paths/src/workspace-state.ts:191-192` |
| `toolOutputSpill(token)` | `<localDir>/toolout-<token>.txt` | `packages/paths/src/workspace-state.ts:193-194` |

Predicates paired with the builders above: `isMonitorSidecar(name)` (`packages/paths/src/workspace-state.ts:122`)
and `isSpillFile(name)` (`packages/paths/src/workspace-state.ts:140`).

Ensure functions: `ensureWorkspaceStateDir(root?, opts?)` (`packages/paths/src/workspace-state.ts:206`) and
`ensureWorkspaceLocalDir(root?, opts?)` (`packages/paths/src/workspace-state.ts:224`) both `mkdirSync` with
`{ recursive: true, mode: DIR_MODE }` and seed nothing — "Nothing needs ignoring here, because
nothing here is in a repository." (`packages/paths/src/workspace-state.ts:222`).

### 2.7 Ensure functions and the workspace `.gitignore` (`packages/paths/src/ensure.ts`)

| Symbol | Line | Behavior |
|---|---|---|
| `WORKSPACE_GITIGNORE` | `packages/paths/src/ensure.ts` | `".gitignore\nplans/\nmemory/\nowners/\nworktrees/\n"` |
| `ensureWorkspaceDir(root)` | `packages/paths/src/ensure.ts` | creates `<ws>/.clarvis` (`DIR_MODE`), seeds `.gitignore`, and reconciles a missing mandatory `worktrees/` exclusion |
| `ensureWorkspaceSubdir(dir, root)` | `packages/paths/src/ensure.ts:104` | confines `dir` inside `<ws>/.clarvis`, calls `ensureWorkspaceDir`, then creates `dir` |

### 2.8 Atomic writes (`packages/paths/src/atomic.ts`)

| Symbol | Line | Signature / behavior |
|---|---|---|
| `RENAME_RETRY_DELAYS_MS` | `packages/paths/src/atomic.ts:25` | `[10, 25, 50, 100]` |
| `tmpPathFor(target)` | `packages/paths/src/atomic.ts:50` | `<dirname(target)>/.clarvis-tmp-<pid>-<counter>-<uuid>` |
| `isTmpFile(name)` | `packages/paths/src/atomic.ts:69` | `name.startsWith(TMP_PREFIX)` |
| `renameWithRetry(from, to, opts?)` | `packages/paths/src/atomic.ts:151` | async retried rename, Windows-only |
| `renameWithRetrySync(from, to, opts?)` | `packages/paths/src/atomic.ts:204` | sync twin, blocks the thread |
| `fsyncDir(dir)` | `packages/paths/src/atomic.ts:266` | best-effort async directory fsync, never throws |
| `fsyncDirSync(dir)` | `packages/paths/src/atomic.ts:283` | sync twin |
| `writeFileAtomic(file, data, opts?)` | `packages/paths/src/atomic.ts:458` | stage temp, rename over target |
| `writeFileAtomicSync(file, data, opts?)` | `packages/paths/src/atomic.ts:473` | sync twin |
| `writeFileDurable(file, data, opts?)` | `packages/paths/src/atomic.ts:498` | `writeFileAtomic` + payload `fsync` before rename + `fsyncDir` after |
| `writeFileDurableSync(file, data, opts?)` | `packages/paths/src/atomic.ts:513` | sync twin |

`AtomicWriteOptions` (`packages/paths/src/atomic.ts:296`): `{ mode?, dirMode?, logger? }`.
`RenameRetryOptions`/`RenameRetrySyncOptions` (`packages/paths/src/atomic.ts:99,111`): `{ rename?, delays?,
platform?, logger? }`.

### 2.9 Local leases (`packages/paths/src/local-lease.ts`)

| Symbol | Line | Signature / behavior |
|---|---|---|
| `LocalLeaseRecord` | `packages/paths/src/local-lease.ts:45` | `{ version: 1, pid, token, acquiredAt, host? }` |
| `LocalLeaseLostError` | `packages/paths/src/local-lease.ts:111` | thrown by `assertOwned()` on loss |
| `acquireLocalLease(path, opts)` | `packages/paths/src/local-lease.ts:1061` | async, `Promise<LocalLease \| null>` |
| `acquireLocalLeaseSync(path, opts)` | `packages/paths/src/local-lease.ts:1093` | sync, no waiting, `LocalLeaseSync \| null` |
| `reclaimLocalLease(path, opts)` | `packages/paths/src/local-lease.ts:605` | async orphan recovery, `Promise<boolean>` |
| `reclaimLocalLeaseSync(path, opts)` | `packages/paths/src/local-lease.ts:664` | sync twin |
| `LocalLease` | `packages/paths/src/local-lease.ts:119` | `{ path, record, renew(), owned(), assertOwned(), release() }` |
| `LocalLeaseSync` | `packages/paths/src/local-lease.ts:133` | `{ path, record, release(): boolean }` |
| `AcquireLocalLeaseOptions` | `packages/paths/src/local-lease.ts:83` | extends `LocalLeaseRecoveryOptions` + `{ waitMs?, retryMs?, heartbeatMs?, token?, beforeRelease?, beforeRenew?, afterPublish? }` |
| `AcquireLocalLeaseSyncOptions` | `packages/paths/src/local-lease.ts:101` | extends `LocalLeaseRecoveryOptions` + `{ token?, beforeRelease?, afterPublish? }` (no heartbeat) |
| `LocalLeaseRecoveryOptions` | `packages/paths/src/local-lease.ts:55` | `{ staleMs, now?, host?, processAlive?, beforeReclaim?, afterReclaimMove?, logger? }` |

### 2.10 Diagnostics (`packages/paths/src/diag.ts`)

| Symbol | Line | Behavior |
|---|---|---|
| `PathsLogger` | `packages/paths/src/diag.ts:29` | `{ debug, info, warn, error }(fields, msg)` — a minimal structural interface, deliberately **not** `@clarvis/capability`'s `Logger` (no dependency permitted) |
| `NOOP_PATHS_LOGGER` | `packages/paths/src/diag.ts:46` | discards every call; the default everywhere |
| `setPathsLogger(logger \| null)` | `packages/paths/src/diag.ts:78` | installs (or clears to noop) the process-wide sink; also clears `announceOnce` gates |
| `pathsLogger()` | `packages/paths/src/diag.ts:88` | returns the currently installed sink |
| `announceOnce(key)` | `packages/paths/src/diag.ts:106` | `true` the first time `key` is seen (budget: 256 keys, then cleared wholesale) |

### 2.11 Resolve helpers (`packages/paths/src/resolve.ts`)

| Symbol | Line | Behavior |
|---|---|---|
| `expandHome(p, home)` | `packages/paths/src/resolve.ts:19` | expands exactly `~` and `~/…`; anything else verbatim |
| `resolveAgainst(base, p, home)` | `packages/paths/src/resolve.ts:33` | expand then resolve against `base` unless already absolute |
| `resolveWorkspaceDir(workspace, cwd, home)` | `packages/paths/src/resolve.ts:51` | `cwd` verbatim if `workspace` is `undefined`, else `resolveAgainst` |

### 2.12 Command resolution (`packages/paths/src/which.ts`)

| Symbol | Line | Behavior |
|---|---|---|
| `executableOnPath(command, path?, platform?, pathext?)` | `packages/paths/src/which.ts:68` | first `PATH` entry holding an executable candidate |
| `resolveCommand(command)` | `packages/paths/src/which.ts:100` | memoized wrapper, falls back to the bare name on a miss |

`resolveCommand` logs a `paths.command_resolved` diagnostic (`command`, `resolved`, `found`) via
`pathsLogger()` on the first resolution of a given command name (`packages/paths/src/which.ts:106-108`); the memo
(`packages/paths/src/which.ts:96`) bounds this to one line per distinct command per process regardless of call
volume, and fires whether or not the lookup actually found the command on `PATH`.

### 2.13 Launch-worktree path (`packages/paths/src/roots.ts`)

`worktreeCheckoutRoot(primaryWorkspaceRoot, name)` builds
`<primary-worktree>/.clarvis/worktrees/<ownerSegment(name)>`. It creates nothing and owns no
registry or lifecycle state; the Code bootstrap identifies the primary checkout from Git's
registered worktree list, ensures its `.clarvis/.gitignore` contains `worktrees/`, and asks Git to
create the returned checkout. Anchoring in the primary checkout keeps the destination stable when
Clarvis is launched from a linked checkout.

Production: `packages/paths/src/roots.ts` (`worktreeCheckoutRoot`).
Test: `packages/paths/tests/unit/roots.test.ts`.

### 2.14 Housekeeping (`packages/paths/src/housekeeping.ts`)

`sweepSpillDir(workspaceRoot, options?)` (`packages/paths/src/housekeeping.ts:23`), `options: { maxEntries?,
concurrency?, logger? }`. Deletes spill files (per `isSpillFile`) older than 24 hours
(`SPILL_MAX_AGE_MS = 24 * 60 * 60 * 1000`, `packages/paths/src/housekeeping.ts:7`) from
`workspaceStatePaths(workspaceRoot).localDir` (`packages/paths/src/housekeeping.ts:27`). `maxEntries` defaults to
`10_000`, floored at 0 (`packages/paths/src/housekeeping.ts:28`); `concurrency` defaults to 4 workers, floored at 1 and
capped at the number of candidate files the scan found (`packages/paths/src/housekeeping.ts:67`).

`sweepGlobalStateArtifacts(globalRoot, options?)` applies the same bounded recognized-spill sweep to
every `state/workspaces/*/local` directory, including inactive workspaces, and repairs recognized
spill permissions to `FILE_MODE` (`0600`) on POSIX. It also removes execution/run containers older
than 24 hours only when their descendant tree contains no files and no non-empty directory. The
public production symbols are `sweepGlobalStateArtifacts` and `GlobalStateSweepReport` in
`packages/paths/src/housekeeping.ts`; cross-workspace removal, mode repair and occupied/recent
preservation are pinned by `packages/paths/tests/integration/housekeeping.test.ts`.

### 2.15 What `index.ts` exports vs. what stays internal

`packages/paths/src/index.ts:25-116` re-exports the full public surface listed above. Two symbols
defined in `diag.ts` — `pathsLogger` (`packages/paths/src/diag.ts:88`) and `announceOnce` (`packages/paths/src/diag.ts:106`) — are
**not** re-exported from `index.ts`: the diagnostics export block at `packages/paths/src/index.ts:45` exports only
`NOOP_PATHS_LOGGER`, `setPathsLogger` and the `PathsLogger` type. These two remain
package-internal, consumed only by other modules in `src/`: `announceOnce` by `packages/paths/src/roots.ts:6,76-84`
and `packages/paths/src/atomic.ts:17,159,213,247-251`; `pathsLogger` by `packages/paths/src/local-lease.ts:42` (its four call sites are
`packages/paths/src/local-lease.ts:609,665,755,1065`, each `options.logger ?? pathsLogger()`) — `local-lease.ts` never
imports or calls `announceOnce`.

### 2.16 Settings / model-facing surface

`@clarvis/paths` has **no** zod schemas, no settings block, no model-facing tool, and no CLI —
confirmed by the absence of `zod` from its dependencies (`package.json`, section 2 above) and by
`grep`, and consistent with its role as a pure leaf of path-building functions.

## 3. Data and formats

### 3.1 The two working-tree trees

`<ws>/.clarvis` top level, exhaustively enumerated by the allow-list a kernel test drives every
real writer against: `.gitignore`, `settings.json`, `agents`, `skills`, `workflows`, `plugins`,
`guard-judge.md`, `plans`, `memory`, `owners`, `worktrees`
(`packages/kernel/tests/architecture/workspace-surface.test.ts:34-45`, INV-192).

`WORKSPACE_GITIGNORE` content, seeded verbatim (`packages/paths/src/ensure.ts:33`):
```
.gitignore
plans/
memory/
owners/
worktrees/
```
It "ignores itself, so a workspace Clarvis has run in reports a clean `git status`"
(`packages/paths/src/ensure.ts:23-31`).

`ensureWorkspaceDir` also appends the mandatory `worktrees/` line to an existing ignore file when
it is absent. The update is atomic and preserves every existing byte; it does not replace a
hand-edited file with the seeded template. Production: `ensureWorkspaceDir` and `seedFile` in
`packages/paths/src/ensure.ts`. Test: `packages/paths/tests/integration/ensure.test.ts`.

### 3.2 The global tree

`<global>` = `$CLARVIS_HOME` or `<home>/.clarvis` (`packages/paths/src/roots.ts:71-87`). Beneath it:
operator-authored files at the root (`settings.json`, `agents/`, `keys.json`, `plugins/`,
`hook-trust.json`, `workspace-trust.json`, `skills/`, `workflows/`, `guard-judge.md`,
`memory-policy.md`, `auth.json`, `auth-key.json`), and generated state under `state/`
(`sessions/`, `traces/`, `workflows/` [records], `code.json`, private remote-MCP OAuth credentials)
and `cache/` (`models-dev.json`)
— see the table in §2.4.

### 3.3 Per-workspace machine state tree

`<global>/state/workspaces/<segment>/`, where `segment = ownerSegment(ownerFromWorkspace(root))`
(`packages/paths/src/workspace-state.ts:157-159,173`). Under it: `local/` (prompt history, `code.json`, `diagnostics/`,
monitor sidecars/logs/exits, shell spills, tool-output spills), `memory/` (the wiki's machinery —
delegated to [memory-wiki-store](../capabilities/memory-store.md)), `plans/` (lockfiles — delegated to plan's own spec), and
`owners/<seg>/{memory,plans}` for a multi-owner deployment. "Nothing here is seeded with a
`.gitignore`: this tree is not inside anyone's repository, which is the entire point of it."
(`packages/paths/src/workspace-state.ts:33-34`). Confirmed present at runtime by the kernel test:
`inState.some((rel) => rel.startsWith("memory/.state/"))` and `"memory/.history/"`
(`packages/kernel/tests/architecture/workspace-surface.test.ts:159-164`).

### 3.4 Owner-id and segment encoding

- `ownerFromWorkspace(dir, fallback = "clarvis")` (`packages/paths/src/roots.ts:124-127`): `ws_<sha256hex>` of the
  resolved absolute path (or `fallback` if resolution is somehow empty). Chosen over a
  separator-to-underscore slug because that "was lossy: `/a/b` and `/a_b` both became `_a_b`,
  silently merging their state" (`packages/paths/src/roots.ts:119-122`).
- `ownerSegment(value)` (`packages/paths/src/roots.ts:163-168`): percent-encodes `value` via a `encodeSegment`
  extension of `encodeURIComponent` that additionally escapes `. ! ~ * ' ( )` so a segment can
  never literally be `.` or `..` (`packages/paths/src/roots.ts:139-144`). If the encoded form exceeds
  `SEGMENT_MAX = 200` bytes (`packages/paths/src/roots.ts:130`), it instead returns `h_<sha256hex>` of the raw value —
  not reversible; "a host that must map a directory name back to an owner keeps its own registry"
  (`packages/paths/src/roots.ts:155-157`). Throws `TypeError` on an empty `value` (`packages/paths/src/roots.ts:164`), because an empty
  segment "would resolve to the parent root itself, silently merging every owner into one."
  (`packages/paths/src/roots.ts:152-153`).

### 3.5 Temp-file naming

`tmpPathFor(target)` (`packages/paths/src/atomic.ts:50-53`): `<dirname(target)>/.clarvis-tmp-<pid>-<counter>-<uuid>`.
The pid separates processes, the in-process `tmpCounter` (`packages/paths/src/atomic.ts:31`) separates concurrent
writers inside one process (including across a fork that inherits the counter's current value),
and the UUID makes the whole name collision-free (`packages/paths/src/atomic.ts:40-47`).

### 3.6 Local lease record (`LocalLeaseRecord`, `packages/paths/src/local-lease.ts:45-52`)

```json
{ "version": 1, "pid": 12345, "token": "<random or injected>", "acquiredAt": 1700000000000, "host": "<hostname>" }
```
`host` is optional — "missing only on a legacy record written before host identity was recorded"
(`packages/paths/src/local-lease.ts:51`). Parsed strictly by `parseLeaseRecord` (`packages/paths/src/local-lease.ts:199-227`): rejects
anything whose `version !== 1`, whose `pid`/`acquiredAt` are not finite/safe numbers, whose
`token` is empty, or whose `host` (if present) is a non-empty string violation — returning `null`
(treated as "no record") rather than throwing.

### 3.7 Recovery-intent marker

A per-reclaim marker directory `recoveryIntentDir(path) = "<path>.recovery"`
(`packages/paths/src/local-lease.ts:167-169`), holding files named `intent-<uuid>` whose body is a
`LocalLeaseRecord`-shaped record built by `recoveryIntentRecord` (`packages/paths/src/local-lease.ts:171-179`),
written durably via `writeFileDurable` (`packages/paths/src/local-lease.ts:482,500`).

## 4. Behavior

### 4.1 Ensuring the workspace directory

`ensureWorkspaceDir(root)` (`packages/paths/src/ensure.ts:82-87`): resolve `workspacePaths(root).clarvisDir`,
`mkdirSync(dir, { recursive: true, mode: DIR_MODE })`, then `seedFile` the `.gitignore` with
`{ flag: "wx", mode: FILE_MODE }` — exclusive-create. When a hand-edited file already exists,
`seedFile` preserves its content and atomically appends `worktrees/` only if that mandatory exclusion
is absent. A failure to inspect or update that existing file logs `paths.gitignore_update_failed`
and propagates, preventing worktree creation without ignore protection. A first-write failure other than `EEXIST` logs
`paths.gitignore_seed_skipped` at `debug` with `{ file, code }` (`packages/paths/src/ensure.ts:56-67`) and is
swallowed — the doc explicitly says "only `EEXIST` means it was already there" (`packages/paths/src/ensure.ts:65`),
which is a slight looseness: any write failure (permission denied, disk full) is treated
identically to "already exists" from the caller's point of view, because `seedFile` never inspects
the error code before giving up.

`ensureWorkspaceSubdir(dir, root)` (`packages/paths/src/ensure.ts:104-119`): compute `relative(clarvisDir, resolve
(dir))`; reject with a thrown `Error` if the relative path is empty, `..`, starts with `../`, or
is itself absolute (`packages/paths/src/ensure.ts:108-115`) — i.e. `dir` must be strictly inside `<ws>/.clarvis`.
Then call `ensureWorkspaceDir(root)` (guaranteeing the `.gitignore` exists first) before
`mkdirSync`ing the target. The doc frames this as fixing a reappearing instance of the same bug:
"Both used to `mkdir` their own root, which meant the workspace `.gitignore` was seeded only if
some *other* writer happened to run first" (`packages/paths/src/ensure.ts:98-102`).

### 4.2 Atomic write (`writeStaged`, `packages/paths/src/atomic.ts:370-402`)

1. `mkdir(dirname(file), { recursive: true, mode: dirMode ?? DIR_MODE })`.
2. Compute `tmp = tmpPathFor(file)`.
3. `open(tmp, "wx", mode)` — exclusive create.
4. `handle.writeFile(data)`; if `durable`, `handle.sync()` (payload fsync) before closing.
5. `handle.close()`.
6. `chmod(tmp, mode)` — corrects for the process umask masking the `open` mode
   (`packages/paths/src/atomic.ts:355-357`).
7. `renameWithRetry(tmp, file, { logger })`.
8. On **any** failure from step 3 onward, `rm(tmp, { force: true })` (best effort), report
   `paths.atomic_staging_failed` (with whether the removal itself succeeded), then rethrow the
   original error (`packages/paths/src/atomic.ts:391-400`).
9. If `durable`, `fsyncDir(dirname(file))` after the rename succeeds (`packages/paths/src/atomic.ts:401`).

The doc stresses step ordering: "Every step from `open` onward is staged inside one `try`, so
*any* failure removes the temp — not only a failed rename. Scoping the cleanup to the rename
leaked the temp whenever the write itself failed, which is exactly when failure is likeliest and
repeated: `ENOSPC`, `EIO` and `EDQUOT` all abort in `writeFile` or in the durable `sync()`."
(`packages/paths/src/atomic.ts:359-366`). `writeStagedSync` (`packages/paths/src/atomic.ts:405-437`) mirrors this exactly with
synchronous fs calls.

`writeFileAtomic` = `writeStaged(..., durable=false)`; `writeFileDurable` = `writeStaged(...,
durable=true)`. Kept as two functions rather than one flag "because the two make different
promises, and collapsing them would either cost every ordinary write two `fsync`s or quietly
downgrade the writes that back a crash-recovery guarantee." (`packages/paths/src/atomic.ts:491-496`).

An atomic write's target permission bits are always the caller's `mode`/`FILE_MODE`, never
inherited from whatever file previously existed at that path: "this package owns that policy," and
overwriting a target does not preserve its prior mode — "a Clarvis-owned file has one posture"
(`packages/paths/src/atomic.ts:450-452`).

### 4.3 Rename retry (`renameWithRetry`, `packages/paths/src/atomic.ts:151-175`)

For each `(attempt, backoff)` in `delays` (default `RENAME_RETRY_DELAYS_MS`):
1. Try `move(from, to)`; return on success.
2. On failure, compute `code = retryable ? retryableRenameCode(error) : undefined`, where
   `retryable = (platform ?? process.platform) === "win32"`.
3. If `code === undefined` (not retryable, or not on Windows), rethrow immediately.
4. Otherwise log `paths.rename_retried` and `await delay(backoff)`.
5. After the loop, one final unconditional `move(from, to)` — a 5th attempt whose failure
   propagates directly (not caught).

`RETRYABLE_RENAME_CODES = {"EPERM","EACCES","EBUSY"}` (`packages/paths/src/atomic.ts:28`). The rationale given: on
Windows an antivirus/indexer/editor can hold a destination handle transiently, causing these
errnos for tens of milliseconds; on POSIX the same `EPERM` "is a sticky-bit denial that will never
clear", so the retry is gated on platform as well as errno (`packages/paths/src/atomic.ts:132-142`). Two residual
Windows exposures are named as un-closed: a read-only-attribute destination (permanent, no retry
helps) and a holder that outlasts the whole schedule (`packages/paths/src/atomic.ts:144-149`).

### 4.4 `fsyncDir` (`packages/paths/src/atomic.ts:266-276`)

`open(dir, "r")` → `handle.sync()` → `finally handle?.close()`. Any thrown error (including "this
platform will not open a directory") is caught and routed to `reportUnsyncableDir`, which never
rethrows — `fsyncDir` "Never throws." (`packages/paths/src/atomic.ts:260`). `reportUnsyncableDir` rate-limits to one
`paths.fsync_dir_unsupported` log line per distinct errno via `announceOnce`
(`packages/paths/src/atomic.ts:245-252`). Its own doc states the consequence directly: because `fsyncDir`'s catch
treats the refusal as a no-op, "`writeFileDurable` silently degrades to `writeFileAtomic`" on a
filesystem or platform (Windows always) that refuses a directory handle or its sync — and every
crash-recovery guarantee in the product rests on that `fsync`: "the plan lockfiles, the trace
journal, `auth.json`, the signing key" (`packages/paths/src/atomic.ts:239-241`).

### 4.5 Acquiring a local lease (`acquireLocalLease`, `packages/paths/src/local-lease.ts:1061-1084`)

```
attempts = max(1, ceil(waitMs / retryMs) + 1)
for attempt in 0..attempts-1:
  lease = tryPublish(path, options)
  if lease != null: return lease
  if reclaimLocalLease(path, options):        # stale + dead → quarantine + delete
    recovered = tryPublish(path, options)
    if recovered != null: return recovered
  if this was the last attempt: return null
  log "paths.lease_contended"; await delay(retryMs)
return null
```
(`packages/paths/src/local-lease.ts:1069-1083`). `waitMs` defaults to 0 (one attempt only); `retryMs` defaults to 25,
floored at 1 (`packages/paths/src/local-lease.ts:1066-1068`).

`tryPublish` (`packages/paths/src/local-lease.ts:949-1001`):
1. `mkdir(dirname(path), { recursive: true, mode: DIR_MODE })`.
2. `temp = tmpPathFor(path)`; `open(temp, O_CREAT|O_EXCL|O_RDWR, FILE_MODE)`.
3. Build a fresh `LocalLeaseRecord` (`token` from `options.token ?? randomUUID`, `host` from
   `options.host ?? systemHostname()`), write it, `chmod`, `handle.sync()` — the record is
   complete and durable *before* it is ever visible under its final name
   (`packages/paths/src/local-lease.ts:972-975`: "The canonical path appears in one step and already refers to
   complete, fsync'd bytes. A crash can orphan the temp or the valid lease, never a canonical
   zero-length/half-written record.").
4. If `hasActiveRecoveryIntent(path, options)` is true, abort (return `null`) — another holder's
   in-flight reclaim/publish must not be raced.
5. `link(temp, path)` (hard link, not rename) — `EEXIST` means contention, return `null`;
   any other error propagates.
6. `unlinkQuietly(temp)`, `fsyncDir(parent)`, construct the `LocalLease` handle.
7. Call `options.afterPublish?.(path)`, then re-check `hasActiveRecoveryIntent`; if now active,
   `abandonPublishedLease(lease)` and return `null` (a race lost after publication is still
   correctly abandoned, not left dangling).
8. If `afterPublish` **or** that recheck itself throws, the surrounding `catch` calls
   `abandonPublishedLease(lease)` (retiring the just-published lease) and **rethrows the original
   error** rather than returning `null` (`packages/paths/src/local-lease.ts:984-994`; sync twin
   `abandonPublishedLeaseSync` at `:1035-1045`) — a materially different outcome from step 7's
   contended `null`: `acquireLocalLease`/`acquireLocalLeaseSync` reject/throw instead. Pinned by
   `packages/paths/tests/contract/local-lease.test.ts:76-97` ("retires an async publication when its recovery recheck fails") and
   its sync twin at `:122-143`, both of which also assert a subsequent acquisition still succeeds
   cleanly.
9. `finally`: if publication never completed (`published === false`), close and unlink the temp.

### 4.6 Reclaiming a stale lease (`reclaimLocalLease`, `packages/paths/src/local-lease.ts:605-661`)

1. `observe(path)` — `lstat` + parse; `null` (ENOENT) means "already gone", return `true`.
2. `reclaimable(path, observed, options)` — if not reclaimable, return `false` immediately (no
   intent is even created).
3. Otherwise `createRecoveryIntent` (durable marker under `<path>.recovery/`), then inside a
   `finally { intent.release() }` block:
   a. Call `options.beforeReclaim?.(path)` (test seam).
   b. Re-`observe(path)`; if now gone, return `true`.
   c. Recompute `reclaimReason` against the **current** observation; if the identity changed
      since the first observation (`!sameObservedLease(observed, current)`) or it is no longer
      reclaimable, abort with `paths.lease_reclaim_refused` stage `"identity_changed"`.
   d. `quarantine = tmpPathFor(path)`; `renameWithRetry(path, quarantine)`. `ENOENT` → return
      `true` (someone else already removed it); any other failure → refuse at stage
      `"rename_failed"`.
   e. `observe(quarantine)`; if the moved entry's identity/token no longer matches what was
      renamed, `restoreQuarantine` (link the quarantine back to `path`, unlink the quarantine) and
      refuse at stage `"quarantine_mismatch"` — "Never overwrite a successor."
      (`packages/paths/src/local-lease.ts:583-584`).
   f. `unlink(quarantine)`, `fsyncDir(dirname(path))`; on failure (other than ENOENT) restore the
      quarantine and refuse at `"unlink_failed"`.
   g. `forgetRetired(path, current)`, log `paths.lease_reclaimed`, return `true`.

The doc frames the mechanism: "The move to a unique quarantine makes two reclaimers race on one
directory entry; the winner validates that it moved the inode/token it inspected before deleting
it." (`packages/paths/src/local-lease.ts:601-603`).

### 4.7 Reclaim eligibility (`reclaimReason`, `packages/paths/src/local-lease.ts:334-355`)

```
record = observed.record
host = options.host ?? systemHostname()
localOwner = record == null || record.host == undefined || record.host == host
if localOwner and isRetired(path, observed): return "retired"
if now() - observed.info.mtimeMs <= max(0, staleMs): return undefined   # too fresh
if record == null: return "no_record"
if not localOwner: return undefined                                    # foreign host: unknowable
return processAlive(record.pid) ? undefined : "dead_pid"                # (exceptions → undefined)
```
A lock is only ever reclaimed for one of three reasons: `"retired"` (this same process already
released this exact record but a fault stopped it from detaching the path — see the
`retiredLeases` set, `packages/paths/src/local-lease.ts:165`), `"no_record"` (an empty/unparsable legacy lockfile,
but still only once stale), or `"dead_pid"` (same host, and `processIsAlive(pid)` returns
`false`). A foreign host's stale lock is **never** reclaimed by this function — commented as
deliberate: "This primitive coordinates processes on one host only. A foreign host is therefore
unknowable, not dead" (`packages/paths/src/local-lease.ts:346-349`).

`retiredLeases` (`packages/paths/src/local-lease.ts:165`) is a plain in-process `Set`, never persisted to disk: its own
doc says to "remember only that exact inode in this process" (`packages/paths/src/local-lease.ts:159-165`). It exists
purely so a later reclaim call **within the same process** can recognise an identity it already
knows it abandoned; a second process racing the same path cannot see it at all and must fall back
to `"no_record"`/`"dead_pid"` reasoning instead.

### 4.8 Liveness probe (`processIsAlive`, `packages/paths/src/local-lease.ts:189-197`)

```
if pid is not a safe integer or pid <= 0: return true        # never treat as dead
try: process.kill(pid, 0); return true
catch: return errno(error) !== "ESRCH"                        # anything but "no such process" ⇒ alive
```
A permission error (`EPERM` — pid exists but belongs to another user) or any unexpected error is
treated as *alive*, i.e. the check fails closed.

### 4.9 Recovery-intent gate (`hasActiveRecoveryIntent`, `packages/paths/src/local-lease.ts:512-536`)

`readdir(<path>.recovery)`; a missing directory means "no intent", return `false`. Otherwise for
each marker file, `observe` it; if it is *not* reclaimable (i.e. its own owner is still plausibly
alive), the overall answer is `active = true` — meaning some other in-flight
reclaim/acquire is still running and must be respected. Markers that *are* reclaimable (their
owner is gone) are opportunistically unlinked as they are found, so the directory self-cleans over
time.

### 4.10 Release (`createLease(...).release`, `packages/paths/src/local-lease.ts:809-874`)

1. Stop the heartbeat (if any) and await any in-flight renewal.
2. `owned()` — verify current ownership via `handleOwns` (stat the held handle vs. the current
   file's identity and token).
3. `handle.stat()` to capture the held identity (`heldIdentity`) *before* closing — needed later
   to validate the quarantine.
4. `handle.close()`.
5. If not currently owned, or the identity capture failed, return `false` (nothing more to do).
6. `beforeRelease?.(path)` test seam.
7. `quarantine = tmpPathFor(path)`; `renameWithRetry(path, quarantine)` — "Detach the directory
   entry first, then inspect the inode that was actually moved. This makes the check-and-remove
   one atomic namespace transition: an ABA successor is restored, never unlinked."
   (`packages/paths/src/local-lease.ts:837-839`).
8. `observe(quarantine)`; if the moved identity/token does not match what this holder held,
   `restoreQuarantine` and return `false` (an ABA race: someone else's lease got renamed away
   accidentally, restored intact).
9. `unlink(quarantine)`, `fsyncDir(dirname(path))`; return `true` on success (or `false` on
   ENOENT, meaning it's already gone — treated as "already released" rather than success, since
   this holder did not perform the removal).
10. `finally`: mark this exact `(token, dev, ino)` in `retiredLeases` if the release was **not**
    clean (`cleanlyReleased === false`) — so a later `reclaimLocalLease` from *this same process*
    can recognise its own abandoned identity as `"retired"` and finish the job, without wrongly
    matching a live PID's own successor lease.

This narrative is `createLease`'s (async) `release()`; `LocalLeaseSync`'s `release()`
(`packages/paths/src/local-lease.ts:889-906`) is structurally, not merely syntactically, different: it has no
heartbeat and therefore no persistent `lost` flag to gate step 5 on (contrast
`packages/paths/src/local-lease.ts:757-776` and step 5's `lost` check above). Instead it re-derives current ownership
at the moment of release from a fresh `descriptorOwns(descriptor, path, record.token)` call plus an
`fstatSync` of the held descriptor, and returns `false` directly from that check — a sync lease can
never lose ownership *between* operations the way the async one can, because nothing renews it in
the background.

### 4.11 Heartbeat renewal and coalescing (`createLease`, `packages/paths/src/local-lease.ts:743-799`)

`renew()` (`packages/paths/src/local-lease.ts:764-776`) first re-verifies ownership via `owned()`, then updates the
held file descriptor's mtime with `handle.utimes(stamp, stamp)` — it never rewrites the JSON
record, so a crash mid-heartbeat cannot corrupt an otherwise-valid record. If `beforeRenew` or
`handle.utimes` throws, the lease's internal `lost` flag is set permanently, `paths.lease_lost` is
reported with `phase: "renew"`, and `renew()` returns `false`; the heartbeat's next scheduled tick
still fires (the timer itself is untouched), but every subsequent `owned()`/`renew()` call now
returns `false` because `lost` never clears. Pinned by
`packages/paths/tests/contract/local-lease.test.ts` ("a holder that loses its lease on a heartbeat
says so, and names the phase", asserting `phase: "renew"`) and its throwing-sink counterpart.

If `heartbeatMs > 0`, `setInterval(requestHeartbeat, heartbeatMs)` (unref'd). `requestHeartbeat`
coalesces overlapping ticks: if a renewal is already in flight, it just sets
`heartbeatRequested = true` and returns; the in-flight renewal loop re-runs itself once more if
requested before it exits (`do { ...; await renew(); } while (heartbeatRequested &&
!heartbeatStopped)`, `packages/paths/src/local-lease.ts:786-793`, the loop condition itself at `:790`). This guarantees at most one `renew()` in flight at a time regardless of
tick rate, and `release()` awaits `heartbeatInFlight` before proceeding (`packages/paths/src/local-lease.ts:814`), so
a release can never race a heartbeat write. A caller must still invoke `release()` after ownership
loss: it returns `false` without detaching the canonical path, but closes the held handle. The
heartbeat-loss regression in `packages/paths/tests/contract/local-lease.test.ts` pins both the
diagnostic and this cleanup path.

### 4.12 Synchronous acquire (`acquireLocalLeaseSync`, `packages/paths/src/local-lease.ts:1093-1101`)

No wait/retry loop at all: `tryPublishSync` once; on failure, `reclaimLocalLeaseSync` once; on
success, `tryPublishSync` once more. Any contention returns `null` immediately — "This exists for
synchronous persistence APIs that cannot yield while holding their transaction."
(`packages/paths/src/local-lease.ts:1089-1090`).

## 5. Invariants

**INV-001.** No package outside `@clarvis/paths` may spell the literal directory names `.clarvis`
or `.agents`, or the temp-file prefix `.clarvis-tmp-`, in executable source under any package's
`src/` or package `tooling/` — only in comments/TSDoc. Production: not one file — the sweep covers
`packages/*/src/**/*.{ts,tsx}` and `packages/*/tooling/**/*.{ts,tsx}`
(`packages/paths/tests/architecture/invariant.test.ts:51`). Test:
`packages/paths/tests/architecture/invariant.test.ts:66-69`.

**INV-002.** The matcher used by INV-001 must positively recognise every quoting/call form the
codebase actually uses (`path.join(..., ".clarvis")`, backtick temp-prefix interpolation,
`.gitignore`-seed strings). Test: `packages/paths/tests/architecture/invariant.test.ts:76-87`.

**INV-003.** The same matcher must not fire on TSDoc/comment lines naming `.clarvis`/`.agents` in
prose, nor on unrelated dotted names (`.clarvisrc`, `.agentsfile`, `.git`). Test:
`packages/paths/tests/architecture/invariant.test.ts:89-104`.

**INV-004.** The list of files "pending migration" onto `@clarvis/paths` (`PENDING`,
`packages/paths/tests/architecture/invariant.test.ts:39`) must currently be empty, and must never name a file the sweep no longer
flags. Tests: `packages/paths/tests/architecture/invariant.test.ts:67-69` (list itself), `:71-74` ("already migrated" check).

**INV-005.** `tmpPathFor(target)` builds its temp file as a sibling of `target` in the same
directory, prefixed with `TMP_PREFIX`. Production: `packages/paths/src/atomic.ts:50`. Test:
`packages/paths/tests/contract/atomic.test.ts:59-65`.

**INV-006.** 200 concurrent calls to `tmpPathFor` for the same target inside one process never
collide on a name. Test: `packages/paths/tests/contract/atomic.test.ts:67-71`.

**INV-007.** The temp file name embeds the current process's pid, so an orphaned temp file is
attributable to the process that created it. Test: `packages/paths/tests/contract/atomic.test.ts:73-75`.

**INV-008.** `isTmpFile` recognises exactly the names `tmpPathFor` produces and no other pattern
(neither the bare target name nor legacy `*.tmp`/`*.tmp-<pid>` suffixes). Production:
`packages/paths/src/atomic.ts:69`. Test: `packages/paths/tests/contract/atomic.test.ts:77-83`.

**INV-009.** `writeFileAtomic` replacing an existing file leaves no orphaned temp file behind and
the directory contains only the target afterward. Test: `packages/paths/tests/contract/atomic.test.ts:94-102`.

**INV-010.** 12 concurrent `writeFileAtomic` calls to one path all settle (to one of the attempted
bodies) and none orphans a temp file. Test: `packages/paths/tests/contract/atomic.test.ts:110-117`.

**INV-011.** When the final `rename` fails, `writeFileAtomic` removes its own temp file and
propagates the rename's error; the same holds for the sync variant, `writeFileDurable` and
`writeFileDurableSync`. Test: `packages/paths/tests/contract/atomic.test.ts:119-125` (async), `:154-160` (sync), `:187-193`
(durable), `:213-219` (durable sync).

**INV-012.** `RENAME_RETRY_DELAYS_MS` has exactly four entries whose sum is under 250ms.
Production: `packages/paths/src/atomic.ts:25`. Test: `packages/paths/tests/contract/atomic.test.ts:223-226`.

**INV-013.** `renameWithRetry` retries only on `win32`, only for a transient errno (`EPERM`,
`EACCES`, `EBUSY`), and gives up once the schedule is exhausted, throwing the underlying error.
Test: `packages/paths/tests/contract/atomic.test.ts:237-248` (retries then succeeds), `:250-263` (schedule exhausted throws),
`:265-278` (POSIX `EPERM` is a permanent denial, not retried), `:280-295` (an errno outside the
transient set, or a codeless error, is never retried).

**INV-014.** `fsyncDir` is a no-op (does not throw) on a platform or path that cannot yield a
directory handle, and its synchronous twin behaves identically. Test: `packages/paths/tests/contract/atomic.test.ts:357-359`,
`:361-365`.

**INV-015.** `acquireLocalLease` publishes one complete owner record and a `release()` call frees
only the record its own holder created. Production: `packages/paths/src/local-lease.ts:1061`. Test:
`packages/paths/tests/contract/local-lease.test.ts:53-74`.

**INV-016.** A lease record that is stale (past `staleMs`) but whose owning pid is still alive on
the same host is never reclaimed. Test: `packages/paths/tests/contract/local-lease.test.ts:240-260`.

**INV-017.** A stale lease record owned by a *different host* is never reclaimed — the liveness
check fails closed rather than guessing. Test: `packages/paths/tests/contract/local-lease.test.ts:262-277`.

**INV-018.** A stale lease is reclaimed only once its owning process is positively known dead
(same host, pid not live). Test: `packages/paths/tests/contract/local-lease.test.ts:279-299`.

**INV-019.** When two contenders race to reclaim one stale lease concurrently, at most one
succeeds. Test: `packages/paths/tests/contract/local-lease.test.ts:301-320`.

**INV-020.** A non-positive pid (`0` or negative) in a lease record is treated as *live*, never as
evidence the owner is dead. Test: `packages/paths/tests/contract/local-lease.test.ts:322-327`.

**INV-021.** A fresh (non-stale) but only partially written lease record is never reclaimed. Test:
`packages/paths/tests/contract/local-lease.test.ts:233-238`.

**INV-192.** Driving every writer that touches a workspace (plan repository listing, two memory
batch writes, `markIndexed`) leaves `<ws>/.clarvis`'s top level containing only entries from the
fixed allowed set (`.gitignore`, `settings.json`, `agents`, `skills`, `workflows`, `plugins`,
`guard-judge.md`, `plans`, `memory`, `owners`, `worktrees`), and every file found under the workspace root is
inside `.clarvis/`. Test:
`packages/kernel/tests/architecture/workspace-surface.test.ts:113-122`.

**INV-193.** Everything generated under `plans/` and `memory/` in that same tree is either a `.md`
file or a transient atomic-write temp file (recognised by `isTmpFile`) — never raw machinery.
Test: `packages/kernel/tests/architecture/workspace-surface.test.ts:124-134`.

**INV-194.** The `.gitignore` seed file is present in `.clarvis` regardless of which writer
(plans, memory, prompt history, …) creates the directory first. Test:
`packages/kernel/tests/architecture/workspace-surface.test.ts:142-145`. Prevents (per the test's own docstring,
`packages/kernel/tests/architecture/workspace-surface.test.ts:137-140`): "`code`'s prompt history fired on the first Enter, before
any tool had run, through a bare recursive `mkdir` — so the ignore file existed only if some other
writer happened to go first."

**INV-195.** No file found under `<ws>/.clarvis` ends in `.lock`, and no path segment anywhere
under it is `.journal`, `.state`, `.history`, or `local` — all of that machinery is confirmed
instead to exist under the global state root (`memory/.state/`, `memory/.history/` present there).
Test: `packages/kernel/tests/architecture/workspace-surface.test.ts:147-157` (absence in `.clarvis`), `:159-164` (presence in the
state tree).

### Further invariants derived directly from the code (unnumbered in the global catalog)

**PATHS-A.** `ownerSegment` never returns an empty, `.`-only, or `..`-only path segment, and
throws `TypeError` on an empty input. Production: `packages/paths/src/roots.ts:139-178`. Test:
`packages/paths/tests/unit/roots.test.ts:138-187` directly covers safe values, separators, dot
encoding, empty-input refusal, and the fixed-width hash fallback.

**PATHS-B.** `reclaimLocalLease`/`reclaimLocalLeaseSync` never delete a lock whose identity
changed between the initial observation and the post-recovery-intent re-observation
(`sameObservedLease`, `packages/paths/src/local-lease.ts:233-238,619`), and never unlink a quarantined entry whose
moved identity/token does not match what was expected (`packages/paths/src/local-lease.ts:640-644,696-700`) — instead
restoring the quarantine. Production: `packages/paths/src/local-lease.ts:605-661` (async), `:664-717` (sync). Pinned
by `packages/paths/tests/contract/local-lease.test.ts:344-401` ("preserves a successor introduced before async quarantine",
"never detaches a raced successor after observing an older stale lease").

**PATHS-C.** A release's identity check (`heldIdentity`) is captured from the **held file
descriptor**, not from a fresh `lstat` of the path, so an ABA replacement of the path (unlink +
recreate with a different inode) between a holder's last confirmed ownership and its `release()`
call is detected and the release refuses to delete the successor. Production:
`packages/paths/src/local-lease.ts:816-852`. Pinned by `packages/paths/tests/contract/local-lease.test.ts:446-466` ("a late release cannot unlink a
successor with another token and inode", POSIX-only per `test.if(process.platform !== "win32")`).

**PATHS-D.** `writeStaged`/`writeStagedSync` always attempt to remove their staged temp file on
any failure from `open` onward, and report (via `paths.atomic_staging_failed`) whether that
removal itself succeeded — a removal failure never replaces or masks the original thrown error.
Production: `packages/paths/src/atomic.ts:391-402,426-437`. Pinned by `packages/paths/tests/contract/atomic.test.ts:395-412` and `:414-429` (both
`test.if(modeBitsEnforced)`).

**PATHS-E.** An asynchronous lease that has already lost ownership still closes its held file handle
when `release()` is called. It returns `false` and does not detach the canonical lease path.
Production: `packages/paths/src/local-lease.ts` (`createLease`, `release`). Test:
`packages/paths/tests/contract/local-lease.test.ts` ("a holder that loses its lease on a heartbeat
says so, and names the phase").

**PATHS-F.** Remote MCP registrations and tokens are machine state, not operator-authored settings:
`globalPaths(root).mcpOAuthFile` is always `<global>/state/mcp-oauth.json`. Production:
`packages/paths/src/global.ts:21-37,105-118`. Test:
`packages/paths/tests/component/paths.test.ts:66`.

## 6. Failure modes and degradation

| Condition | Behavior | Cite |
|---|---|---|
| Rename fails with a non-retryable errno, or on POSIX at all | throws immediately, no retry | `packages/paths/src/atomic.ts:165-166` |
| Rename fails transiently on Windows, schedule exhausted | one final unconditional attempt, its error (if any) propagates uncaught | `packages/paths/src/atomic.ts:174` |
| `fsyncDir` cannot open/sync a directory (any platform, any reason) | swallowed; logged once per errno at `debug`; caller never sees an error | `packages/paths/src/atomic.ts:266-276`, `:245-252` |
| Atomic write fails at any stage (`open`, `writeFile`, `sync`, `chmod`, `rename`) | temp is best-effort removed, `paths.atomic_staging_failed` warned with whether removal succeeded, original error rethrown | `packages/paths/src/atomic.ts:391-400` |
| `ensureWorkspaceDir`'s `.gitignore` seed fails for a reason other than "already exists" | logs `paths.gitignore_seed_skipped` (`file`, `code`) at `debug` and swallows the error — the directory creation still succeeds and the caller is never told the ignore file may be missing | `packages/paths/src/ensure.ts:56-67` |
| An existing `.gitignore` cannot be read or atomically updated with `worktrees/` | logs `paths.gitignore_update_failed` (`file`, `code`) at `warn` and throws, so checkout creation cannot proceed without the exclusion | `packages/paths/src/ensure.ts` (`seedFile`) |
| `ensureWorkspaceSubdir` given a `dir` outside `<ws>/.clarvis` | throws a plain `Error` naming both paths | `packages/paths/src/ensure.ts:108-115` |
| `acquireLocalLease` contended and unreclaimable | returns `null` after `waitMs` of retries — never throws | `packages/paths/src/local-lease.ts:1061-1084` |
| `tryPublish`'s `afterPublish` callback or its post-publish recovery-intent recheck throws | the just-published lease is abandoned via `abandonPublishedLease(Sync)` and the original error is rethrown — `acquireLocalLease`/`acquireLocalLeaseSync` reject/throw rather than returning `null` | `packages/paths/src/local-lease.ts:984-994` (async), `:1035-1045` (sync) |
| `owned()` or `renew()` finds it no longer holds the lease | sets `lost = true` and logs `paths.lease_lost` with `phase` naming where the loss was discovered — one of the three `LeaseLossPhase` values `"renew"` (a failed heartbeat, `packages/paths/src/local-lease.ts:764-776`), `"stat"` (the identity capture at the start of `release()` failed, `:820-823`), or `"release"` (`handle.close()` itself failed, `:826-829`); every subsequent `owned()`/`release()` call returns `false`, while `release()` still stops heartbeat work and closes the held handle | `packages/paths/src/local-lease.ts` (`createLease`, `release`); `packages/paths/tests/contract/local-lease.test.ts` (heartbeat-loss regression) |
| A reclaim's rename-to-quarantine hits `ENOENT` (already gone) | treated as success (`return true`), not a refusal | `packages/paths/src/local-lease.ts:629,650,685,706` |
| A reclaim's quarantine identity mismatches | restores (links) the quarantine back to its original path, refuses, logs `paths.lease_reclaim_refused` with the stage | `packages/paths/src/local-lease.ts:640-644` |
| A lease reclaim decision is wrong (steals a lock from a still-alive holder due to clock skew or an unusual errno) | not detected or corrected anywhere in this package — the design note at `packages/paths/src/local-lease.ts:73-77` names this as "the single densest blind spot here: if the judgement is wrong, two holders both believe they own the path and nothing anywhere says so" | `packages/paths/src/local-lease.ts:73-77` |
| A diagnostic sink itself throws while a lease decision is being reported | caught and discarded via `reportQuietly` — "A diagnostic may be lost; it may never change an outcome." | `packages/paths/src/local-lease.ts:365-384` |
| `executableOnPath` finds nothing on `PATH` | `resolveCommand` returns the bare command name unchanged, deferring the failure to the eventual spawn | `packages/paths/src/which.ts:100-111` |
| `sweepSpillDir`'s target directory is missing, or scanning throws mid-iteration | the whole pass is treated as a no-op / partial pass; per-file `stat`/`rm` errors are individually swallowed | `packages/paths/src/housekeeping.ts:31-32,44-46,61-63` |
| `sweepSpillDir` scans past `maxEntries` | scan stops early (`truncated: true` in the `paths.spill_sweep` log), leaving the remainder of the directory unswept until the next pass | `packages/paths/src/housekeeping.ts:38-41,71-81` |
| `sweepGlobalStateArtifacts` encounters a missing/unreadable workspace or a changing entry | skips that branch or entry and continues within the configured bounds | `sweepGlobalStateArtifacts` in `packages/paths/src/housekeeping.ts` |

## 7. Coupling

**Depends on nothing.** `@clarvis/paths` has zero dependencies, internal or external
(`package.json`; `packages/paths/src/index.ts:22`; `packages/paths/src/diag.ts:20-22` states this is enforced by
`tooling/checks/package-graph.ts`, a build/tooling script outside this package's own `src`/`tests`
that this document's scope does not include verifying directly — see §8).

**Depended on by every package that touches a workspace or global root.** This is enforced
structurally rather than by any single test in this document's scope: `WorkspacePaths`,
`WorkspaceStatePaths` and `GlobalPaths` are the only typed way to reach `.clarvis`/`.agents`
paths, and `invariant.test.ts` (INV-001–004) makes spelling those literals anywhere else in
`packages/*/src` or `packages/*/tooling` a failing test. This is a **static, source-text**
enforcement (`Glob` + regex over file contents, `packages/paths/tests/architecture/invariant.test.ts:53-64`), not a type constraint
— a package could still in principle hand-build an equivalent path by concatenating segments
that individually don't match the literal regex (e.g. via string concatenation split across
variables) and the test would not catch it, though nothing found in this document's scope does so.

**`PathsLogger` is a structural duplicate, not a shared type**, of `@clarvis/capability`'s
`Logger` port. The doc names the reason: "this package has no dependencies at all, internal or
external, and `tooling/checks/package-graph.ts` enforces that. The capability port satisfies this
shape, so a host passes its own logger straight in; the drift test lives in
`packages/loop/tests/integration/execute-run-entrypoints.test.ts`, because a test here may not
import the package it would have to compare against." (`packages/paths/src/diag.ts:20-27`) — i.e. the coupling check
that the two shapes stay compatible lives in `@clarvis/loop`, not here, precisely because putting
it here would require an import this package must never have.

**`@clarvis/kernel`'s `workspace-surface.test.ts` is the one place outside this package that
exercises the workspace-content-vs-machinery rule end-to-end**, because it is "the lowest package
that sees both `@clarvis/plan` and `@clarvis/memory`" (`packages/kernel/tests/architecture/workspace-surface.test.ts:28-29`) — a
runtime/import-graph fact (this package cannot see either), not a type-level one. The monitor and
spill writers are explicitly *not* driven from here because "the kernel does not depend on
`@clarvis/tools`" (`packages/kernel/tests/architecture/workspace-surface.test.ts:29-31`); that coverage instead lives in `@clarvis/
tools`'s own suites (delegated, per the same comment, to `tools`' `monitor-lib`/`shell` suites and
`loop`'s `tool-spill` suite — outside this document's scope).

**`WORKSPACE_ENV` (`CLARVIS_WORKSPACE_ROOT`) is a cross-package contract with `@clarvis/hooks`**:
this package defines the name (`packages/paths/src/roots.ts:11-21`) and `@clarvis/hooks` injects it into every hook
subprocess's environment so a hook that shells back out to Clarvis resolves the same workspace
root — a **runtime** (environment-variable) coupling, not an import.

## 8. Open questions

- **Whether any test exercises the `PENDING` exception list becoming non-empty** (i.e. what
  happens when a deliberate, reviewed exception is actually added) is not observable from an
  always-empty list; the mechanism is present (`packages/paths/tests/architecture/invariant.test.ts:39,71-74`) but its behavior with
  a populated list is untested by construction.
- **The exact recovery/quarantine race outcome when a filesystem's `link()` does not behave
  POSIX-atomically** (a filesystem-specific assumption `tryPublish` depends on for its "canonical
  path appears in one step" guarantee, `packages/paths/src/local-lease.ts:972-975`) is asserted by comment, not
  measured against a real non-POSIX-compliant filesystem in any test in this document's scope.
- **Worktree launch semantics** are explicitly out of scope here and belong to the
  [launch-worktrees](../capabilities/worktrees.md) document; this package owns only the canonical
  checkout path.
- **The TOCTOU threat model for workspace-confined writes** (what happens if a parent directory is
  swapped for a symlink between validation and mutation) is explicitly delegated to the
  [security-confinement-and-redaction](../cross-cutting/security.md) document and is not analyzed here, even though
  `ensureWorkspaceSubdir`'s confinement check (`packages/paths/src/ensure.ts:104-119`) is a `@clarvis/paths` function;
  this document describes only what that function does, not whether it is sufficient against a
  concurrent adversary. **Recorded 2026-08-22, in `@clarvis/tools` rather than here**: the threat
  model, the read/write asymmetry and the rejected partial mitigations are now stated in
  `resolvePath`'s `@remarks` (`packages/tools/src/lib/paths.ts`). It is written there because that is
  the function whose return value discards the canonical form — this package's own check is not the
  one the race turns on. The defect remains open.
- **`memory`'s and `trace`'s own on-disk layouts** beneath the roots this package hands them
  (`memoryMachineryRoot`, `tracesDir`, etc.) are delegated to [memory-wiki-store](../capabilities/memory-store.md) and
  [trace-recording-and-persistence](trace.md) respectively, per this document's scope statement, and are not
  described here beyond the single directory path each root resolves to.
