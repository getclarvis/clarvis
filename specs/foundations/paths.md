# Directory vocabulary, atomic writes and local leases

> Implemented at `packages/paths/src/**` and `packages/paths/tests/**` (plus
> `packages/kernel/tests/architecture/workspace-surface.test.ts`, the one test outside the package
> that pins its cross-cutting rule). Every claim below is anchored to a file and a named symbol or test. Open
> questions are collected in the final section.

## 1. Purpose

`@clarvis/paths` is the single owner of Clarvis's on-disk directory vocabulary — the literals
`.clarvis` and `.agents`, the temp-file prefix, and every path built from them — plus the
filesystem primitives that make writing into that vocabulary safe: atomic write-then-rename,
directory `fsync`, and a crash-recoverable local lease. It is a leaf with **zero dependencies**,
internal or external (`packages/paths/package.json` lists no `dependencies` key at all, and
`packages/paths/src/diag.ts` states the package "has no dependencies at all, internal or
external"), so every other package in the graph can depend on it without gaining an edge to
anything else (`packages/paths/src/index.ts`).

The problem it solves is stated directly in its own module doc: "Every other package reaches
`.clarvis` and `.agents` through this module and never spells either literal itself. That is what
keeps the naming conventions … from drifting apart across eight packages, which is how a sweeper
came to look for files no writer ever produced." (`packages/paths/src/index.ts`). A second,
narrower problem is durability: the atomic-write family "replaces seven hand-rolled tmp-and-rename
copies that had already diverged on the property that matters — one of them raced two processes
onto a single temp name" (`packages/paths/src/index.ts`; see also
`packages/paths/src/atomic.ts`, naming `@clarvis/server`'s signing key as the concrete instance: "written to a
bare `<file>.tmp`, so two boots racing the same key file collided on one temp path"). A third,
narrower reason covers the **resolve** family (`expandHome`, `resolveAgainst`,
`resolveWorkspaceDir`, §2.11): those three functions "were forked verbatim between the engine and
an optional feature package that is structurally forbidden from importing it," so this
dependency-free leaf is the only place both could share them (`packages/paths/src/index.ts`).

The package draws one structural line through everything it builds: a workspace's `<ws>/.clarvis`
tree holds only what a human authors or reads, and every byte of generated machinery — monitor
sidecars, shell spills, prompt history, the memory wiki's journal, plan lockfiles — lives instead
under the user's **global** root, keyed per workspace. That split is enforced by the *type
system*, not by convention: `WorkspacePaths` (`packages/paths/src/workspace.ts`) simply has no
key for any of that machinery, so writing it into a repository is a compile error rather than a
possibility to remember to avoid (`packages/paths/src/workspace.ts`).

## 2. Surface

### 2.1 Exports map

One entrypoint (`packages/paths/package.json`):

| Subpath | `bun` | `types` | `import` |
| --- | --- | --- | --- |
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

| Symbol | Value | File |
| --- | --- | --- |
| `CLARVIS_DIR` | `".clarvis"` | `packages/paths/src/constants.ts` |
| `AGENTS_DIR` | `".agents"` | `packages/paths/src/constants.ts` |
| `AGENTS_PLUGINS_DIR` | `"plugins"` | `packages/paths/src/constants.ts` |
| `MARKETPLACE_FILE` | `"marketplace.json"` | `packages/paths/src/constants.ts` |
| `TMP_PREFIX` | `".clarvis-tmp-"` | `packages/paths/src/constants.ts` |
| `DIR_MODE` | `0o700` | `packages/paths/src/constants.ts` |
| `FILE_MODE` | `0o600` | `packages/paths/src/constants.ts` |
| `TMP_GLOB` | `` `${TMP_PREFIX}*` `` | `packages/paths/src/constants.ts` |
| `MONITOR_PREFIX` | `"monitor-"` | `packages/paths/src/constants.ts` |
| `SPILL_PREFIX` | `"shell-"` | `packages/paths/src/constants.ts` |
| `TOOL_OUTPUT_PREFIX` | `"toolout-"` | `packages/paths/src/constants.ts` |
| `TOOL_OUTPUT_SUFFIX` | `".txt"` | `packages/paths/src/constants.ts` |
| `MONITOR_SIDECAR_SUFFIX` | `".json"` | `packages/paths/src/constants.ts` |
| `LOG_SUFFIX` | `".log"` | `packages/paths/src/constants.ts` |
| `CONTEXT_FILENAMES` | `["CLARVIS.md", "AGENTS.md"]` | `packages/paths/src/constants.ts` |
| `INTERNAL_SKIP_DIRS` | `[".git","node_modules","dist",CLARVIS_DIR,".next","coverage","build"]` | `packages/paths/src/constants.ts` |
| `INTERNAL_IGNORE_PATTERNS` | `[".git", CLARVIS_DIR, TMP_GLOB]` | `packages/paths/src/constants.ts` |

`INTERNAL_SKIP_DIRS` bounds a structural tree walk; `INTERNAL_IGNORE_PATTERNS` is applied beneath
user-supplied `grep`/`glob` ignore sources, and deliberately omits `AGENTS_DIR` — "it is the user's
own content, and `grep`/`glob` are expected to see it" (`packages/paths/src/constants.ts`). The two lists
"differ because they answer different questions, not because they drifted" (`packages/paths/src/constants.ts`).

### 2.3 Roots (`packages/paths/src/roots.ts`)

| Symbol | Kind | File | What it does |
| --- | --- | --- | --- |
| `HOME_ENV` | const | `packages/paths/src/roots.ts` | `"CLARVIS_HOME"` |
| `WORKSPACE_ENV` | const | `packages/paths/src/roots.ts` | `"CLARVIS_WORKSPACE_ROOT"` |
| `RootOptions` | interface | `packages/paths/src/roots.ts` | `{ env?, home?, cwd?, logger? }` — every ambient input is injectable |
| `globalRoot(opts?)` | fn | `packages/paths/src/roots.ts` | `$CLARVIS_HOME`, else `resolve(<home>/.clarvis)` |
| `workspaceRoot(opts?)` | fn | `packages/paths/src/roots.ts` | `$CLARVIS_WORKSPACE_ROOT`, else `resolve(cwd)` |
| `ownerFromWorkspace(dir, fallback?)` | fn | `packages/paths/src/roots.ts` | `ws_<sha256hex>` of the canonical absolute path |
| `workspaceScopeKey(owner, projectId, workspaceId)` | fn | `packages/paths/src/roots.ts` | stable `scope_<sha256hex>` namespace over all three identity components |
| `worktreeCheckoutRoot(primaryWorkspaceRoot, name)` | fn | `packages/paths/src/roots.ts` | canonical encoded checkout path under the primary worktree; detailed in §2.13 |
| `ownerSegment(value)` | fn | `packages/paths/src/roots.ts` | encodes an arbitrary id as one safe path segment |

`WORKSPACE_ENV` is the same variable name `@clarvis/hooks` injects into every hook subprocess
(stated at `packages/paths/src/roots.ts`), so a hook that invokes Clarvis inherits a pointer at the right tree.
An environment override is read through `override()` (`packages/paths/src/roots.ts`), which treats a blank or
whitespace-only value as unset.

`workspaceScopeKey` hashes `owner`, `projectId`, and `workspaceId` with NUL separators, so changing
any one component selects a different fixed-width state namespace without allowing an identifier to
be interpreted as a path segment. Production: `packages/paths/src/roots.ts`. Test:
`packages/paths/tests/unit/roots.test.ts`.

Both `globalRoot` and `workspaceRoot` log a `paths.roots_resolved` diagnostic the first time a
given resolved value is seen in the process, gated by `announceOnce` (`packages/paths/src/roots.ts` for the
global root for the workspace root): `global_root`/`global_from` (`"home"` or `"env"`)
or `workspace_root`/`workspace_from` (`"cwd"` or `"env"`). The `RootOptions.logger` field's own doc
frames this as foundational: "which root a process chose — and whether an environment override
chose it — is the first thing every other path in this package is derived from" (`packages/paths/src/roots.ts`).

### 2.4 Global paths (`packages/paths/src/global.ts`)

`globalPaths(root?, opts?)` (`packages/paths/src/global.ts`) returns a `GlobalPaths` record
(`packages/paths/src/global.ts`) rooted at `<global>`:

| Field | Path | File |
| --- | --- | --- |
| `root` | `<global>` | `packages/paths/src/global.ts` |
| `state` | `<global>/state` | `packages/paths/src/global.ts` |
| `cache` | `<global>/cache` | `packages/paths/src/global.ts` |
| `pluginDataRoot` | `<global>/state/plugin-data` | `GlobalPaths.pluginDataRoot`, `globalPaths` |
| `settingsFile` | `<global>/settings.json` | `packages/paths/src/global.ts` |
| `agentsDir` | `<global>/agents` | `packages/paths/src/global.ts` |
| `keysFile` | `<global>/keys.json` | `packages/paths/src/global.ts` |
| `subscriptionsFile` | `<global>/subscriptions.json` | `packages/paths/src/global.ts` |
| `mcpOAuthFile` | `<global>/state/mcp-oauth.json` | `packages/paths/src/global.ts` |
| `pluginsDir` | `<global>/plugins` | `packages/paths/src/global.ts` |
| `extensionProfilesDir` | `<global>/extension-profiles` | `packages/paths/src/global.ts` |
| `runtimeRecipesDir` | `<global>/runtime-recipes` | `GlobalPaths.runtimeRecipesDir`, `globalPaths` |
| `workspaceTrustFile` | `<global>/workspace-trust.json` | `packages/paths/src/global.ts` |
| `skillsDir` | `<global>/skills` | `packages/paths/src/global.ts` |
| `workflowsDir` | `<global>/workflows` | `packages/paths/src/global.ts` |
| `guardJudgeFile` | `<global>/guard-judge.md` | `packages/paths/src/global.ts` |
| `memoryPolicyFile` | `<global>/memory-policy.md` | `packages/paths/src/global.ts` |
| `authFile` | `<global>/auth.json` | `packages/paths/src/global.ts` |
| `authKeyFile` | `<global>/auth-key.json` | `packages/paths/src/global.ts` |
| `sessionsDir` | `<global>/state/sessions` | `packages/paths/src/global.ts` |
| `tracesDir` | `<global>/state/traces` | `packages/paths/src/global.ts` |
| `workflowRecordsDir` | `<global>/state/workflows` | `packages/paths/src/global.ts` |
| `extensionProfileSelectionFile` | `<global>/state/extension-profile.json` | `packages/paths/src/global.ts` |
| `codeConfigFile` | `<global>/state/code.json` | `packages/paths/src/global.ts` |
| `modelsCacheFile` | `<global>/cache/models-dev.json` | `packages/paths/src/global.ts` |
| `updateCheckCacheFile` | `<global>/cache/update-check.json` | `packages/paths/src/global.ts` |
| `runtimeRecipeStateDir` | `<global>/state/runtime-recipes` | `GlobalPaths.runtimeRecipeStateDir`, `globalPaths` |
| `runtimeRecipeLeaseFile(identity)` | `<global>/state/runtime-recipes/<ownerSegment(identity)>.lock` | `GlobalPaths.runtimeRecipeLeaseFile`, `globalPaths` |
| `contextCandidates` | `<global>/{CLARVIS.md,AGENTS.md}` | `packages/paths/src/global.ts` |
| `exportsDirForOwner(owner)` | `<global>/exports/<ownerSegment(owner)>` | `packages/paths/src/global.ts` |
| `agentFile(name)` | `<agentsDir>/<name>.md` | `packages/paths/src/global.ts` |

The module doc explains the placement: "Operator-owned configuration sits at the root, not under
a `config/` subdirectory" — burying it "made the global tree disagree with the workspace one"
(`packages/paths/src/global.ts`). What is nested under `state`/`cache` is what a user never edits: `state` is
"generated and recoverable but costly to lose", `cache` "may be deleted at any moment without
consequence" (`packages/paths/src/global.ts`).

`runtimeRecipesDir` is the operator-authored root for Docker customization scripts. Keeping it
outside workspace roots prevents an isolated agent from turning a later cold launch into an
operator-authorized build. `runtimeRecipeLeaseFile` is host-only coordination for one
content-addressed Docker image build. It lives under generated state rather than cache so an
operator cache cleanup cannot delete a live cross-process lease; the acquired file itself is
removed on release. The identity is encoded by the same `ownerSegment` boundary as every other
untrusted dynamic path component. Production: `GlobalPaths.runtimeRecipesDir`,
`GlobalPaths.runtimeRecipeStateDir`, `GlobalPaths.runtimeRecipeLeaseFile`, and `globalPaths` in
`packages/paths/src/global.ts`. Test: `globalPaths > names the generated state and the cache` in
`packages/paths/tests/component/paths.test.ts`.

### 2.5 Workspace paths (`packages/paths/src/workspace.ts`)

`workspacePaths(root?, opts?)` (`packages/paths/src/workspace.ts`) returns a `WorkspacePaths` record
(`packages/paths/src/workspace.ts`) rooted at `<ws>/.clarvis`:

| Field | Path | File |
| --- | --- | --- |
| `root` | working tree root | `packages/paths/src/workspace.ts` |
| `clarvisDir` | `<ws>/.clarvis` | `packages/paths/src/workspace.ts` |
| `settingsFile` | `<ws>/.clarvis/settings.json` | `packages/paths/src/workspace.ts` |
| `agentsDir` | `<ws>/.clarvis/agents` | `packages/paths/src/workspace.ts` |
| `skillsDir` | `<ws>/.clarvis/skills` | `packages/paths/src/workspace.ts` |
| `workflowsDir` | `<ws>/.clarvis/workflows` | `packages/paths/src/workspace.ts` |
| `pluginsDir` | `<ws>/.clarvis/plugins` | `packages/paths/src/workspace.ts` |
| `extensionProfilesDir` | `<ws>/.clarvis/extension-profiles` | `packages/paths/src/workspace.ts` |
| `guardJudgeFile` | `<ws>/.clarvis/guard-judge.md` | `packages/paths/src/workspace.ts` |
| `memoryPolicyFile` | `<ws>/.clarvis/memory-policy.md` | `packages/paths/src/workspace.ts` |
| `plansRoot` | `<ws>/.clarvis/plans` | `packages/paths/src/workspace.ts` |
| `memoryRoot` | `<ws>/.clarvis/memory` | `packages/paths/src/workspace.ts` |
| `contextCandidates` | `<ws>/{CLARVIS.md,AGENTS.md}` | `packages/paths/src/workspace.ts` |
| `plansRootForOwner(owner)` | `<ws>/.clarvis/owners/<seg>/plans` | `packages/paths/src/workspace.ts` |
| `memoryRootForOwner(owner)` | `<ws>/.clarvis/owners/<seg>/memory` | `packages/paths/src/workspace.ts` |
| `agentFile(name)` | `<agentsDir>/<name>.md` | `packages/paths/src/workspace.ts` |

Interface doc: "Machinery is deliberately **absent from this type**… The keys are removed rather
than deprecated so that writing generated bookkeeping into someone's working tree is a compile
error rather than a convention." (`packages/paths/src/workspace.ts`). The one residue kept is transient: an
atomic write's temp file must be a sibling of its target inside the same filesystem
(`packages/paths/src/workspace.ts`).

Supporting `.agents` functions (`packages/paths/src/workspace.ts`):

| Symbol | File | What it returns |
| --- | --- | --- |
| `agentsSkillsDirs(opts?)` | `packages/paths/src/workspace.ts` | `{ user: <home>/.agents/skills, workspace: <ws>/.agents/skills }` |
| `agentsPluginsDir(root)` | `packages/paths/src/workspace.ts` | `<root>/.agents/plugins` |
| `agentsPluginsDirs(opts?)` | `packages/paths/src/workspace.ts` | the global and workspace shared plugin inventories |
| `agentsMarketplaceFile(root)` | `packages/paths/src/workspace.ts` | `<root>/.agents/plugins/marketplace.json` |
| `agentsMarketplaceFiles(opts?)` | `packages/paths/src/workspace.ts` | the same, for both `home` and `workspaceRoot` |
| `isAgentsMarketplaceFile(candidate)` | `packages/paths/src/workspace.ts` | predicate matching the last three path segments |

### 2.6 Per-workspace machine state (`packages/paths/src/workspace-state.ts`)

`workspaceStatePaths(root?, opts?)` (`packages/paths/src/workspace-state.ts`) returns a `WorkspaceStatePaths`
record (`packages/paths/src/workspace-state.ts`) rooted at `<global>/state/workspaces/<segment>`, where
`segment = ownerSegment(ownerFromWorkspace(root))` (`packages/paths/src/workspace-state.ts`):

| Field | Path | File |
| --- | --- | --- |
| `root` | `<global>/state/workspaces/<segment>` | `packages/paths/src/workspace-state.ts` |
| `workspaceRoot` | the resolved working tree | `packages/paths/src/workspace-state.ts` |
| `localDir` | `<root>/local` | `packages/paths/src/workspace-state.ts` |
| `diagnosticsDir` | `<root>/local/diagnostics` | `packages/paths/src/workspace-state.ts` |
| `memoryMachineryRoot` | `<root>/memory` | `packages/paths/src/workspace-state.ts` |
| `plansLockDir` | `<root>/plans` | `packages/paths/src/workspace-state.ts` |
| `pluginDataRoot` | `<root>/plugin-data` | `WorkspaceStatePaths.pluginDataRoot`, `workspaceStatePaths` |
| `promptHistoryFile` | `<root>/local/prompt-history` | `packages/paths/src/workspace-state.ts` |
| `codeConfigFile` | `<root>/local/code.json` | `packages/paths/src/workspace-state.ts` |
| `extensionProfileSelectionFile` | `<root>/local/extension-profile.json` | `packages/paths/src/workspace-state.ts` |
| `runTempDir(executionId)` | `<root>/local/runs/<ownerSegment(executionId)>/tmp` | `WorkspaceStatePaths.runTempDir`, `workspaceStatePaths` |
| `runtimesDir` | `<root>/runtimes` | `WorkspaceStatePaths.runtimesDir`, `workspaceStatePaths` |
| `runtimeDir(runtimeId)` | `<root>/runtimes/<ownerSegment(runtimeId)>` | `WorkspaceStatePaths.runtimeDir`, `workspaceStatePaths` |
| `runtimeCheckpointsDir(runtimeId)` | `<runtime>/checkpoints` | `WorkspaceStatePaths.runtimeCheckpointsDir`, `workspaceStatePaths` |
| `runtimeCheckpointFile(runtimeId, executionId)` | `<runtime>/checkpoints/<ownerSegment(executionId)>.json` | `WorkspaceStatePaths.runtimeCheckpointFile`, `workspaceStatePaths` |
| `memoryMachineryRootForOwner(owner)` | `<root>/owners/<seg>/memory` | `packages/paths/src/workspace-state.ts` |
| `plansLockDirForOwner(owner)` | `<root>/owners/<seg>/plans` | `packages/paths/src/workspace-state.ts` |
| `monitorSidecar(id)` | `<localDir>/monitor-<id>.json` | `packages/paths/src/workspace-state.ts` |
| `monitorLog(id)` | `<localDir>/monitor-<id>.log` | `packages/paths/src/workspace-state.ts` |
| `monitorExit(id)` | `<localDir>/monitor-<id>.exit` | `packages/paths/src/workspace-state.ts` |
| `spillFile(token, stream)` | `<localDir>/shell-<token>.<stream>.log` | `packages/paths/src/workspace-state.ts` |
| `toolOutputSpill(token)` | `<localDir>/toolout-<token>.txt` | `packages/paths/src/workspace-state.ts` |

Predicates paired with the builders above: `isMonitorSidecar(name)` (`packages/paths/src/workspace-state.ts`)
and `isSpillFile(name)` (`packages/paths/src/workspace-state.ts`).

The `.agents` accessors do not share one blanket write policy. Standalone skills and marketplace
documents are read-only authored inputs. The managed global plugin lifecycle may mutate exactly one
directory below a global `agentsPluginsDir`, while both workspace plugin inventories are
repository-owned. Persistent portable-plugin data is source-qualified below `pluginDataRoot`, never
written into `.agents/plugins` or `.clarvis/plugins`. Production:
`packages/kernel/src/adapters/filesystem/plugin-repository.ts` and
`packages/kernel/src/plugins/plugin-runtime.ts`. Test:
`packages/paths/tests/architecture/agents-read-only.test.ts` and
`packages/kernel/tests/unit/plugin-runtime.test.ts`.

Ensure functions: `ensureWorkspaceStateDir(root?, opts?)` (`packages/paths/src/workspace-state.ts`) and
`ensureWorkspaceLocalDir(root?, opts?)` (`packages/paths/src/workspace-state.ts`) both `mkdirSync` with
`{ recursive: true, mode: DIR_MODE }` and seed nothing — "Nothing needs ignoring here, because
nothing here is in a repository." (`packages/paths/src/workspace-state.ts`).

### 2.7 Ensure functions and the workspace `.gitignore` (`packages/paths/src/ensure.ts`)

| Symbol | File | Behavior |
| --- | --- | --- |
| `WORKSPACE_GITIGNORE` | `packages/paths/src/ensure.ts` | `".gitignore\nplans/\nmemory/\nowners/\nworktrees/\n"` |
| `ensureWorkspaceDir(root)` | `packages/paths/src/ensure.ts` | creates `<ws>/.clarvis` (`DIR_MODE`), seeds `.gitignore`, and reconciles a missing mandatory `worktrees/` exclusion |
| `ensureWorkspaceSubdir(dir, root)` | `packages/paths/src/ensure.ts` | confines `dir` inside `<ws>/.clarvis`, calls `ensureWorkspaceDir`, then creates `dir` |

### 2.8 Atomic writes (`packages/paths/src/atomic.ts`)

| Symbol | File | Signature / behavior |
| --- | --- | --- |
| `RENAME_RETRY_DELAYS_MS` | `packages/paths/src/atomic.ts` | `[10, 25, 50, 100]` |
| `tmpPathFor(target)` | `packages/paths/src/atomic.ts` | `<dirname(target)>/.clarvis-tmp-<pid>-<counter>-<uuid>` |
| `isTmpFile(name)` | `packages/paths/src/atomic.ts` | `name.startsWith(TMP_PREFIX)` |
| `renameWithRetry(from, to, opts?)` | `packages/paths/src/atomic.ts` | async retried rename, Windows-only |
| `renameWithRetrySync(from, to, opts?)` | `packages/paths/src/atomic.ts` | sync twin, blocks the thread |
| `fsyncDir(dir)` | `packages/paths/src/atomic.ts` | best-effort async directory fsync, never throws |
| `fsyncDirSync(dir)` | `packages/paths/src/atomic.ts` | sync twin |
| `writeFileAtomic(file, data, opts?)` | `packages/paths/src/atomic.ts` | stage temp, rename over target |
| `writeFileAtomicSync(file, data, opts?)` | `packages/paths/src/atomic.ts` | sync twin |
| `writeFileDurable(file, data, opts?)` | `packages/paths/src/atomic.ts` | `writeFileAtomic` + payload `fsync` before rename + `fsyncDir` after |
| `writeFileDurableSync(file, data, opts?)` | `packages/paths/src/atomic.ts` | sync twin |

`AtomicWriteOptions` (`packages/paths/src/atomic.ts`): `{ mode?, dirMode?, logger? }`.
`RenameRetryOptions`/`RenameRetrySyncOptions` (`packages/paths/src/atomic.ts`): `{ rename?, delays?,
platform?, logger? }`.

### 2.9 Local leases (`packages/paths/src/local-lease.ts`)

| Symbol | File | Signature / behavior |
| --- | --- | --- |
| `LocalLeaseRecord` | `packages/paths/src/local-lease.ts` | `{ version: 1, pid, token, acquiredAt, host? }` |
| `LocalLeaseLostError` | `packages/paths/src/local-lease.ts` | thrown by `assertOwned()` on loss |
| `acquireLocalLease(path, opts)` | `packages/paths/src/local-lease.ts` | async, `Promise<LocalLease \| null>` |
| `acquireLocalLeaseSync(path, opts)` | `packages/paths/src/local-lease.ts` | sync, no waiting, `LocalLeaseSync \| null` |
| `reclaimLocalLease(path, opts)` | `packages/paths/src/local-lease.ts` | async orphan recovery, `Promise<boolean>` |
| `reclaimLocalLeaseSync(path, opts)` | `packages/paths/src/local-lease.ts` | sync twin |
| `LocalLease` | `packages/paths/src/local-lease.ts` | `{ path, record, renew(), owned(), assertOwned(), release() }` |
| `LocalLeaseSync` | `packages/paths/src/local-lease.ts` | `{ path, record, release(): boolean }` |
| `AcquireLocalLeaseOptions` | `packages/paths/src/local-lease.ts` | extends `LocalLeaseRecoveryOptions` + `{ waitMs?, retryMs?, heartbeatMs?, token?, beforeRelease?, beforeRenew?, afterPublish? }` |
| `AcquireLocalLeaseSyncOptions` | `packages/paths/src/local-lease.ts` | extends `LocalLeaseRecoveryOptions` + `{ token?, beforeRelease?, afterPublish? }` (no heartbeat) |
| `LocalLeaseRecoveryOptions` | `packages/paths/src/local-lease.ts` | `{ staleMs, now?, host?, processAlive?, beforeReclaim?, afterReclaimMove?, logger? }` |

### 2.10 Diagnostics (`packages/paths/src/diag.ts`)

| Symbol | File | Behavior |
| --- | --- | --- |
| `PathsLogger` | `packages/paths/src/diag.ts` | `{ debug, info, warn, error }(fields, msg)` — a minimal structural interface, deliberately **not** `@clarvis/capability`'s `Logger` (no dependency permitted) |
| `NOOP_PATHS_LOGGER` | `packages/paths/src/diag.ts` | discards every call; the default everywhere |
| `setPathsLogger(logger \| null)` | `packages/paths/src/diag.ts` | installs (or clears to noop) the process-wide sink; also clears `announceOnce` gates |
| `pathsLogger()` | `packages/paths/src/diag.ts` | returns the currently installed sink |
| `announceOnce(key)` | `packages/paths/src/diag.ts` | `true` the first time `key` is seen (budget: 256 keys, then cleared wholesale) |

### 2.11 Resolve helpers (`packages/paths/src/resolve.ts`)

| Symbol | File | Behavior |
| --- | --- | --- |
| `expandHome(p, home)` | `packages/paths/src/resolve.ts` | expands exactly `~` and `~/…`; anything else verbatim |
| `resolveAgainst(base, p, home)` | `packages/paths/src/resolve.ts` | expand then resolve against `base` unless already absolute |
| `resolveWorkspaceDir(workspace, cwd, home)` | `packages/paths/src/resolve.ts` | `cwd` verbatim if `workspace` is `undefined`, else `resolveAgainst` |

### 2.12 Command resolution (`packages/paths/src/which.ts`)

| Symbol | File | Behavior |
| --- | --- | --- |
| `executableOnPath(command, path?, platform?, pathext?)` | `packages/paths/src/which.ts` | first `PATH` entry holding an executable candidate |
| `resolveCommand(command)` | `packages/paths/src/which.ts` | memoized wrapper, falls back to the bare name on a miss |

`resolveCommand` logs a `paths.command_resolved` diagnostic (`command`, `resolved`, `found`) via
`pathsLogger()` on the first resolution of a given command name (`packages/paths/src/which.ts`); the memo
(`packages/paths/src/which.ts`) bounds this to one line per distinct command per process regardless of call
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

`sweepSpillDir(workspaceRoot, options?)` (`packages/paths/src/housekeeping.ts`), `options: { maxEntries?,
concurrency?, logger? }`. Deletes spill files (per `isSpillFile`) older than 24 hours
(`SPILL_MAX_AGE_MS = 24 * 60 * 60 * 1000`, `packages/paths/src/housekeeping.ts`) from
`workspaceStatePaths(workspaceRoot).localDir` (`packages/paths/src/housekeeping.ts`). `maxEntries` defaults to
`10_000`, floored at 0 (`packages/paths/src/housekeeping.ts`); `concurrency` defaults to 4 workers, floored at 1 and
capped at the number of candidate files the scan found (`packages/paths/src/housekeeping.ts`).

`sweepGlobalStateArtifacts(globalRoot, options?)` applies the same bounded recognized-spill sweep to
every `state/workspaces/*/local` directory, including inactive workspaces, and repairs recognized
spill permissions to `FILE_MODE` (`0600`) on POSIX. It also removes execution/run containers older
than 24 hours only when their descendant tree contains no files and no non-empty directory. The
public production symbols are `sweepGlobalStateArtifacts` and `GlobalStateSweepReport` in
`packages/paths/src/housekeeping.ts`; cross-workspace removal, mode repair and occupied/recent
preservation are pinned by `packages/paths/tests/integration/housekeeping.test.ts`.

### 2.15 What `index.ts` exports vs. what stays internal

`packages/paths/src/index.ts` re-exports the full public surface listed above. Two symbols
defined in `diag.ts` — `pathsLogger` (`packages/paths/src/diag.ts`) and `announceOnce` (`packages/paths/src/diag.ts`) — are
**not** re-exported from `index.ts`: the diagnostics export block at `packages/paths/src/index.ts` exports only
`NOOP_PATHS_LOGGER`, `setPathsLogger` and the `PathsLogger` type. These two remain
package-internal, consumed only by other modules in `src/`: `announceOnce` by `packages/paths/src/roots.ts`
and `packages/paths/src/atomic.ts`; `pathsLogger` by `packages/paths/src/local-lease.ts` (its four call sites are
`packages/paths/src/local-lease.ts`, each `options.logger ?? pathsLogger()`) — `local-lease.ts` never
imports or calls `announceOnce`.

### 2.16 Settings / model-facing surface

`@clarvis/paths` has **no** zod schemas, no settings block, no model-facing tool, and no CLI —
confirmed by the absence of `zod` from its dependencies (`package.json`, section 2 above) and by
`grep`, and consistent with its role as a pure leaf of path-building functions.

## 3. Data and formats

### 3.1 The two working-tree trees

`<ws>/.clarvis` top level, exhaustively enumerated by the allow-list a kernel test drives every
real writer against: `.gitignore`, `settings.json`, `agents`, `skills`, `workflows`, `plugins`,
`extension-profiles`, `guard-judge.md`, `plans`, `memory`, `owners`, `worktrees`
(`packages/kernel/tests/architecture/workspace-surface.test.ts`, INV-192).

`WORKSPACE_GITIGNORE` content, seeded verbatim (`packages/paths/src/ensure.ts`):
```
.gitignore
plans/
memory/
owners/
worktrees/
```
It "ignores itself, so a workspace Clarvis has run in reports a clean `git status`"
(`packages/paths/src/ensure.ts`).

`ensureWorkspaceDir` also appends the mandatory `worktrees/` line to an existing ignore file when
it is absent. The update is atomic and preserves every existing byte; it does not replace a
hand-edited file with the seeded template. Production: `ensureWorkspaceDir` and `seedFile` in
`packages/paths/src/ensure.ts`. Test: `packages/paths/tests/integration/ensure.test.ts`.

### 3.2 The global tree

`<global>` = `$CLARVIS_HOME` or `<home>/.clarvis` (`packages/paths/src/roots.ts`). Beneath it:
operator-authored files at the root (`settings.json`, `agents/`, `keys.json`, `plugins/`, `extension-profiles/`,
`workspace-trust.json`, `skills/`, `workflows/`, `guard-judge.md`,
`memory-policy.md`, `auth.json`, `auth-key.json`), and generated state under `state/`
(`sessions/`, `traces/`, `workflows/` [records], `extension-profile.json`, `code.json`, private remote-MCP OAuth credentials)
and `cache/` (`models-dev.json`, `update-check.json`)
— see the table in §2.4.

### 3.3 Per-workspace machine state tree

`<global>/state/workspaces/<segment>/`, where `segment = ownerSegment(ownerFromWorkspace(root))`
(`packages/paths/src/workspace-state.ts`). Under it: `local/` (prompt history, `code.json`, `extension-profile.json`, `diagnostics/`,
monitor sidecars/logs/exits, shell spills, tool-output spills), `memory/` (the wiki's machinery —
delegated to [memory-wiki-store](../capabilities/memory-store.md)), `plans/` (lockfiles — delegated to plan's own spec), and
`owners/<seg>/{memory,plans}` for a multi-owner deployment. "Nothing here is seeded with a
`.gitignore`: this tree is not inside anyone's repository, which is the entire point of it."
(`packages/paths/src/workspace-state.ts`). Confirmed present at runtime by the kernel test:
`inState.some((rel) => rel.startsWith("memory/.state/"))` and `"memory/.history/"`
(`packages/kernel/tests/architecture/workspace-surface.test.ts`).

Extension Profile definitions are authored content in the global/workspace trees; their global and
per-workspace selections are generated state. This split makes workspace definitions shareable
without making repository checkout an activation action. The format and precedence belong to
[`hosts/extension-profiles.md`](../hosts/extension-profiles.md). Production: `GlobalPaths.extensionProfilesDir`,
`GlobalPaths.extensionProfileSelectionFile`, `WorkspacePaths.extensionProfilesDir`, and
`WorkspaceStatePaths.extensionProfileSelectionFile`. The kernel materializes the global authored
catalog on first list but deliberately does not materialize the workspace authored catalog during
a read; that lifecycle is owned by `missingDefinitionCatalog` and `list` in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`. Test:
`packages/paths/tests/component/paths.test.ts`,
`packages/paths/tests/component/workspace-state.test.ts`, and
`packages/kernel/tests/integration/extension-profile-manager.test.ts` ("materializes an empty global
catalog without writing into the workspace").

### 3.4 Owner-id and segment encoding

- `ownerFromWorkspace(dir, fallback = "clarvis")` (`packages/paths/src/roots.ts`): `ws_<sha256hex>` of the
  resolved absolute path (or `fallback` if resolution is somehow empty). Chosen over a
  separator-to-underscore slug because that "was lossy: `/a/b` and `/a_b` both became `_a_b`,
  silently merging their state" (`packages/paths/src/roots.ts`).
- `ownerSegment(value)` (`packages/paths/src/roots.ts`): percent-encodes `value` via a `encodeSegment`
  extension of `encodeURIComponent` that additionally escapes `. ! ~ * ' ()` so a segment can
  never literally be `.` or `..` (`packages/paths/src/roots.ts`). If the encoded form exceeds
  `SEGMENT_MAX = 200` bytes (`packages/paths/src/roots.ts`), it instead returns `h_<sha256hex>` of the raw value —
  not reversible; "a host that must map a directory name back to an owner keeps its own registry"
  (`packages/paths/src/roots.ts`). Throws `TypeError` on an empty `value` (`packages/paths/src/roots.ts`), because an empty
  segment "would resolve to the parent root itself, silently merging every owner into one."
  (`packages/paths/src/roots.ts`).

### 3.5 Temp-file naming

`tmpPathFor(target)` (`packages/paths/src/atomic.ts`): `<dirname(target)>/.clarvis-tmp-<pid>-<counter>-<uuid>`.
The pid separates processes, the in-process `tmpCounter` (`packages/paths/src/atomic.ts`) separates concurrent
writers inside one process (including across a fork that inherits the counter's current value),
and the UUID makes the whole name collision-free (`packages/paths/src/atomic.ts`).

### 3.6 Local lease record (`LocalLeaseRecord`, `packages/paths/src/local-lease.ts`)

```json
{ "version": 1, "pid": 12345, "token": "<random or injected>", "acquiredAt": 1700000000000, "host": "<hostname>" }
```
`host` is optional — "missing only on a legacy record written before host identity was recorded"
(`packages/paths/src/local-lease.ts`). Parsed strictly by `parseLeaseRecord` (`packages/paths/src/local-lease.ts`): rejects
anything whose `version !== 1`, whose `pid`/`acquiredAt` are not finite/safe numbers, whose
`token` is empty, or whose `host` (if present) is a non-empty string violation — returning `null`
(treated as "no record") rather than throwing.

### 3.7 Recovery-intent marker

A per-reclaim marker directory `recoveryIntentDir(path) = "<path>.recovery"`
(`packages/paths/src/local-lease.ts`), holding files named `intent-<uuid>` whose body is a
`LocalLeaseRecord`-shaped record built by `recoveryIntentRecord` (`packages/paths/src/local-lease.ts`),
written durably via `writeFileDurable` (`packages/paths/src/local-lease.ts`).

## 4. Behavior

### 4.1 Ensuring the workspace directory

`ensureWorkspaceDir(root)` (`packages/paths/src/ensure.ts`): resolve `workspacePaths(root).clarvisDir`,
`mkdirSync(dir, { recursive: true, mode: DIR_MODE })`, then `seedFile` the `.gitignore` with
`{ flag: "wx", mode: FILE_MODE }` — exclusive-create. When a hand-edited file already exists,
`seedFile` preserves its content and atomically appends `worktrees/` only if that mandatory exclusion
is absent. A failure to inspect or update that existing file logs `paths.gitignore_update_failed`
and propagates, preventing worktree creation without ignore protection. A first-write failure other than `EEXIST` logs
`paths.gitignore_seed_skipped` at `debug` with `{ file, code }` (`packages/paths/src/ensure.ts`) and is
swallowed — the doc explicitly says "only `EEXIST` means it was already there" (`packages/paths/src/ensure.ts`),
which is a slight looseness: any write failure (permission denied, disk full) is treated
identically to "already exists" from the caller's point of view, because `seedFile` never inspects
the error code before giving up.

`ensureWorkspaceSubdir(dir, root)` (`packages/paths/src/ensure.ts`): compute `relative(clarvisDir, resolve
(dir))`; reject with a thrown `Error` if the relative path is empty, `..`, starts with `../`, or
is itself absolute (`packages/paths/src/ensure.ts`) — i.e. `dir` must be strictly inside `<ws>/.clarvis`.
Then call `ensureWorkspaceDir(root)` (guaranteeing the `.gitignore` exists first) before
`mkdirSync`ing the target. The doc frames this as fixing a reappearing instance of the same bug:
"Both used to `mkdir` their own root, which meant the workspace `.gitignore` was seeded only if
some *other* writer happened to run first" (`packages/paths/src/ensure.ts`).

### 4.2 Atomic write (`writeStaged`, `packages/paths/src/atomic.ts`)

1. `mkdir(dirname(file), { recursive: true, mode: dirMode ?? DIR_MODE })`.
2. Compute `tmp = tmpPathFor(file)`.
3. `open(tmp, "wx", mode)` — exclusive create.
4. `handle.writeFile(data)`; if `durable`, `handle.sync()` (payload fsync) before closing.
5. `handle.close()`.
6. `chmod(tmp, mode)` — corrects for the process umask masking the `open` mode
   (`packages/paths/src/atomic.ts`).
7. `renameWithRetry(tmp, file, { logger })`.
8. On **any** failure from step 3 onward, `rm(tmp, { force: true })` (best effort), report
   `paths.atomic_staging_failed` (with whether the removal itself succeeded), then rethrow the
   original error (`packages/paths/src/atomic.ts`).
9. If `durable`, `fsyncDir(dirname(file))` after the rename succeeds (`packages/paths/src/atomic.ts`).

The doc stresses step ordering: "Every step from `open` onward is staged inside one `try`, so
*any* failure removes the temp — not only a failed rename. Scoping the cleanup to the rename
leaked the temp whenever the write itself failed, which is exactly when failure is likeliest and
repeated: `ENOSPC`, `EIO` and `EDQUOT` all abort in `writeFile` or in the durable `sync()`."
(`packages/paths/src/atomic.ts`). `writeStagedSync` (`packages/paths/src/atomic.ts`) mirrors this exactly with
synchronous fs calls.

`writeFileAtomic` = `writeStaged(..., durable=false)`; `writeFileDurable` = `writeStaged(...,
durable=true)`. Kept as two functions rather than one flag "because the two make different
promises, and collapsing them would either cost every ordinary write two `fsync`s or quietly
downgrade the writes that back a crash-recovery guarantee." (`packages/paths/src/atomic.ts`).

An atomic write's target permission bits are always the caller's `mode`/`FILE_MODE`, never
inherited from whatever file previously existed at that path: "this package owns that policy," and
overwriting a target does not preserve its prior mode — "a Clarvis-owned file has one posture"
(`packages/paths/src/atomic.ts`).

### 4.3 Rename retry (`renameWithRetry`, `packages/paths/src/atomic.ts`)

For each `(attempt, backoff)` in `delays` (default `RENAME_RETRY_DELAYS_MS`):
1. Try `move(from, to)`; return on success.
2. On failure, compute `code = retryable ? retryableRenameCode(error) : undefined`, where
   `retryable = (platform ?? process.platform) === "win32"`.
3. If `code === undefined` (not retryable, or not on Windows), rethrow immediately.
4. Otherwise log `paths.rename_retried` and `await delay(backoff)`.
5. After the loop, one final unconditional `move(from, to)` — a 5th attempt whose failure
   propagates directly (not caught).

`RETRYABLE_RENAME_CODES = {"EPERM","EACCES","EBUSY"}` (`packages/paths/src/atomic.ts`). The rationale given: on
Windows an antivirus/indexer/editor can hold a destination handle transiently, causing these
errnos for tens of milliseconds; on POSIX the same `EPERM` "is a sticky-bit denial that will never
clear", so the retry is gated on platform as well as errno (`packages/paths/src/atomic.ts`). Two residual
Windows exposures are named as un-closed: a read-only-attribute destination (permanent, no retry
helps) and a holder that outlasts the whole schedule (`packages/paths/src/atomic.ts`).

### 4.4 `fsyncDir` (`packages/paths/src/atomic.ts`)

`open(dir, "r")` → `handle.sync()` → `finally handle?.close()`. Any thrown error (including "this
platform will not open a directory") is caught and routed to `reportUnsyncableDir`, which never
rethrows — `fsyncDir` "Never throws." (`packages/paths/src/atomic.ts`). `reportUnsyncableDir` rate-limits to one
`paths.fsync_dir_unsupported` log line per distinct errno via `announceOnce`
(`packages/paths/src/atomic.ts`). Its own doc states the consequence directly: because `fsyncDir`'s catch
treats the refusal as a no-op, "`writeFileDurable` silently degrades to `writeFileAtomic`" on a
filesystem or platform (Windows always) that refuses a directory handle or its sync — and every
crash-recovery guarantee in the product rests on that `fsync`: "the plan lockfiles, the trace
journal, `auth.json`, the signing key" (`packages/paths/src/atomic.ts`).

### 4.5 Acquiring a local lease (`acquireLocalLease`, `packages/paths/src/local-lease.ts`)

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
(`packages/paths/src/local-lease.ts`). `waitMs` defaults to 0 (one attempt only); `retryMs` defaults to 25,
floored at 1 (`packages/paths/src/local-lease.ts`).

`tryPublish` (`packages/paths/src/local-lease.ts`):
1. `mkdir(dirname(path), { recursive: true, mode: DIR_MODE })`.
2. `temp = tmpPathFor(path)`; `open(temp, O_CREAT|O_EXCL|O_RDWR, FILE_MODE)`.
3. Build a fresh `LocalLeaseRecord` (`token` from `options.token ?? randomUUID`, `host` from
   `options.host ?? systemHostname()`), write it, `chmod`, `handle.sync()` — the record is
   complete and durable *before* it is ever visible under its final name
   (`packages/paths/src/local-lease.ts`: "The canonical path appears in one step and already refers to
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
   error** rather than returning `null` (`packages/paths/src/local-lease.ts`; sync twin
   `abandonPublishedLeaseSync`) — a materially different outcome from step 7's
   contended `null`: `acquireLocalLease`/`acquireLocalLeaseSync` reject/throw instead. Pinned by
   `packages/paths/tests/contract/local-lease.test.ts` ("retires an async publication when its recovery recheck fails") and
   its sync twin, both of which also assert a subsequent acquisition still succeeds
   cleanly.
9. `finally`: if publication never completed (`published === false`), close and unlink the temp.

### 4.6 Reclaiming a stale lease (`reclaimLocalLease`, `packages/paths/src/local-lease.ts`)

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
      (`packages/paths/src/local-lease.ts`).
   f. `unlink(quarantine)`, `fsyncDir(dirname(path))`; on failure (other than ENOENT) restore the
      quarantine and refuse at `"unlink_failed"`.
   g. `forgetRetired(path, current)`, log `paths.lease_reclaimed`, return `true`.

The doc frames the mechanism: "The move to a unique quarantine makes two reclaimers race on one
directory entry; the winner validates that it moved the inode/token it inspected before deleting
it." (`packages/paths/src/local-lease.ts`).

### 4.7 Reclaim eligibility (`reclaimReason`, `packages/paths/src/local-lease.ts`)

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
`retiredLeases` set, `packages/paths/src/local-lease.ts`), `"no_record"` (an empty/unparsable legacy lockfile,
but still only once stale), or `"dead_pid"` (same host, and `processIsAlive(pid)` returns
`false`). A foreign host's stale lock is **never** reclaimed by this function — commented as
deliberate: "This primitive coordinates processes on one host only. A foreign host is therefore
unknowable, not dead" (`packages/paths/src/local-lease.ts`).

`retiredLeases` (`packages/paths/src/local-lease.ts`) is a plain in-process `Set`, never persisted to disk: its own
doc says to "remember only that exact inode in this process" (`packages/paths/src/local-lease.ts`). It exists
purely so a later reclaim call **within the same process** can recognise an identity it already
knows it abandoned; a second process racing the same path cannot see it at all and must fall back
to `"no_record"`/`"dead_pid"` reasoning instead.

### 4.8 Liveness probe (`processIsAlive`, `packages/paths/src/local-lease.ts`)

```
if pid is not a safe integer or pid <= 0: return true        # never treat as dead
try: process.kill(pid, 0); return true
catch: return errno(error) !== "ESRCH"                        # anything but "no such process" ⇒ alive
```
A permission error (`EPERM` — pid exists but belongs to another user) or any unexpected error is
treated as *alive*, i.e. the check fails closed.

### 4.9 Recovery-intent gate (`hasActiveRecoveryIntent`, `packages/paths/src/local-lease.ts`)

`readdir(<path>.recovery)`; a missing directory means "no intent", return `false`. Otherwise for
each marker file, `observe` it; if it is *not* reclaimable (i.e. its own owner is still plausibly
alive), the overall answer is `active = true` — meaning some other in-flight
reclaim/acquire is still running and must be respected. Markers that *are* reclaimable (their
owner is gone) are opportunistically unlinked as they are found, so the directory self-cleans over
time.

### 4.10 Release (`createLease(...).release`, `packages/paths/src/local-lease.ts`)

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
   (`packages/paths/src/local-lease.ts`).
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
(`packages/paths/src/local-lease.ts`) is structurally, not merely syntactically, different: it has no
heartbeat and therefore no persistent `lost` flag to gate step 5 on (contrast
`packages/paths/src/local-lease.ts` and step 5's `lost` check above). Instead it re-derives current ownership
at the moment of release from a fresh `descriptorOwns(descriptor, path, record.token)` call plus an
`fstatSync` of the held descriptor, and returns `false` directly from that check — a sync lease can
never lose ownership *between* operations the way the async one can, because nothing renews it in
the background.

### 4.11 Heartbeat renewal and coalescing (`createLease`, `packages/paths/src/local-lease.ts`)

`renew()` (`packages/paths/src/local-lease.ts`) first re-verifies ownership via `owned()`, then updates the
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
requested before it exits (`do {...; await renew(); } while (heartbeatRequested &&
!heartbeatStopped)`, `packages/paths/src/local-lease.ts`, the loop condition itself). This guarantees at most one `renew()` in flight at a time regardless of
tick rate, and `release()` awaits `heartbeatInFlight` before proceeding (`packages/paths/src/local-lease.ts`), so
a release can never race a heartbeat write. A caller must still invoke `release()` after ownership
loss: it returns `false` without detaching the canonical path, but closes the held handle. The
heartbeat-loss regression in `packages/paths/tests/contract/local-lease.test.ts` pins both the
diagnostic and this cleanup path.

### 4.12 Synchronous acquire (`acquireLocalLeaseSync`, `packages/paths/src/local-lease.ts`)

No wait/retry loop at all: `tryPublishSync` once; on failure, `reclaimLocalLeaseSync` once; on
success, `tryPublishSync` once more. Any contention returns `null` immediately — "This exists for
synchronous persistence APIs that cannot yield while holding their transaction."
(`packages/paths/src/local-lease.ts`).

## 5. Invariants

`configurationRoots` exposes `global_clarvis`, `workspace_clarvis`, `global_agents` and
`workspace_agents` without creating or authorizing their directories. The kernel supplies its
resolved global directory and workspace; shared global content uses the user home. Production:
[configuration.ts](../../packages/paths/src/configuration.ts). Test: all-four-root operations in
[configuration-files.test.ts](../../packages/kernel/tests/unit/configuration-files.test.ts).
The consumer's file allow-list and consent are owned by
[self-configuration.md](../hosts/self-configuration.md).

**INV-001.** No package outside `@clarvis/paths` may spell the literal directory names `.clarvis`
or `.agents`, or the temp-file prefix `.clarvis-tmp-`, in executable source under any package's
`src/` or package `tooling/` — only in comments/TSDoc. Production: not one file — the sweep covers
`packages/*/src/**/*.{ts,tsx}` and `packages/*/tooling/**/*.{ts,tsx}`
(`packages/paths/tests/architecture/invariant.test.ts`). Test:
`packages/paths/tests/architecture/invariant.test.ts`.

**INV-002.** The matcher used by INV-001 must positively recognise every quoting/call form the
codebase actually uses (`path.join(..., ".clarvis")`, backtick temp-prefix interpolation,
`.gitignore`-seed strings). Test: `packages/paths/tests/architecture/invariant.test.ts`.

**INV-003.** The same matcher must not fire on TSDoc/comment lines naming `.clarvis`/`.agents` in
prose, nor on unrelated dotted names (`.clarvisrc`, `.agentsfile`, `.git`). Test:
`packages/paths/tests/architecture/invariant.test.ts`.

**INV-004.** The list of files "pending migration" onto `@clarvis/paths` (`PENDING`,
`packages/paths/tests/architecture/invariant.test.ts`) must currently be empty, and must never name a file the sweep no longer
flags. Tests: `packages/paths/tests/architecture/invariant.test.ts` (list itself) ("already migrated" check).

**INV-005.** `tmpPathFor(target)` builds its temp file as a sibling of `target` in the same
directory, prefixed with `TMP_PREFIX`. Production: `packages/paths/src/atomic.ts`. Test:
`packages/paths/tests/contract/atomic.test.ts`.

**INV-006.** 200 concurrent calls to `tmpPathFor` for the same target inside one process never
collide on a name. Test: `packages/paths/tests/contract/atomic.test.ts`.

**INV-007.** The temp file name embeds the current process's pid, so an orphaned temp file is
attributable to the process that created it. Test: `packages/paths/tests/contract/atomic.test.ts`.

**INV-008.** `isTmpFile` recognises exactly the names `tmpPathFor` produces and no other pattern
(neither the bare target name nor legacy `*.tmp`/`*.tmp-<pid>` suffixes). Production:
`packages/paths/src/atomic.ts`. Test: `packages/paths/tests/contract/atomic.test.ts`.

**INV-009.** `writeFileAtomic` replacing an existing file leaves no orphaned temp file behind and
the directory contains only the target afterward. Test: `packages/paths/tests/contract/atomic.test.ts`.

**INV-010.** 12 concurrent `writeFileAtomic` calls to one path all settle (to one of the attempted
bodies) and none orphans a temp file. Test: `packages/paths/tests/contract/atomic.test.ts`.

**INV-011.** When the final `rename` fails, `writeFileAtomic` removes its own temp file and
propagates the rename's error; the same holds for the sync variant, `writeFileDurable` and
`writeFileDurableSync`. Test: `packages/paths/tests/contract/atomic.test.ts` (async) (sync)
(durable) (durable sync).

**INV-012.** `RENAME_RETRY_DELAYS_MS` has exactly four entries whose sum is under 250ms.
Production: `packages/paths/src/atomic.ts`. Test: `packages/paths/tests/contract/atomic.test.ts`.

**INV-013.** `renameWithRetry` retries only on `win32`, only for a transient errno (`EPERM`,
`EACCES`, `EBUSY`), and gives up once the schedule is exhausted, throwing the underlying error.
Test: `packages/paths/tests/contract/atomic.test.ts` (retries then succeeds) (schedule exhausted throws) (POSIX `EPERM` is a permanent denial, not retried) (an errno outside the
transient set, or a codeless error, is never retried).

**INV-014.** `fsyncDir` is a no-op (does not throw) on a platform or path that cannot yield a
directory handle, and its synchronous twin behaves identically. Test: `packages/paths/tests/contract/atomic.test.ts`.

**INV-015.** `acquireLocalLease` publishes one complete owner record and a `release()` call frees
only the record its own holder created. Production: `packages/paths/src/local-lease.ts`. Test:
`packages/paths/tests/contract/local-lease.test.ts`.

**INV-016.** A lease record that is stale (past `staleMs`) but whose owning pid is still alive on
the same host is never reclaimed. Test: `packages/paths/tests/contract/local-lease.test.ts`.

**INV-017.** A stale lease record owned by a *different host* is never reclaimed — the liveness
check fails closed rather than guessing. Test: `packages/paths/tests/contract/local-lease.test.ts`.

**INV-018.** A stale lease is reclaimed only once its owning process is positively known dead
(same host, pid not live). Test: `packages/paths/tests/contract/local-lease.test.ts`.

**INV-019.** When two contenders race to reclaim one stale lease concurrently, at most one
succeeds. Test: `packages/paths/tests/contract/local-lease.test.ts`.

**INV-020.** A non-positive pid (`0` or negative) in a lease record is treated as *live*, never as
evidence the owner is dead. Test: `packages/paths/tests/contract/local-lease.test.ts`.

**INV-021.** A fresh (non-stale) but only partially written lease record is never reclaimed. Test:
`packages/paths/tests/contract/local-lease.test.ts`.

**INV-192.** Driving every writer that touches a workspace (plan repository listing, two memory
batch writes, `markIndexed`) leaves `<ws>/.clarvis`'s top level containing only entries from the
fixed allowed set (`.gitignore`, `settings.json`, `agents`, `skills`, `workflows`, `plugins`,
`guard-judge.md`, `plans`, `memory`, `owners`, `worktrees`), and every file found under the workspace root is
inside `.clarvis/`. Test:
`packages/kernel/tests/architecture/workspace-surface.test.ts`.

**INV-193.** Everything generated under `plans/` and `memory/` in that same tree is either a `.md`
file or a transient atomic-write temp file (recognised by `isTmpFile`) — never raw machinery.
Test: `packages/kernel/tests/architecture/workspace-surface.test.ts`.

**INV-194.** The `.gitignore` seed file is present in `.clarvis` regardless of which writer
(plans, memory, prompt history, …) creates the directory first. Test:
`packages/kernel/tests/architecture/workspace-surface.test.ts`. Prevents (per the test's own docstring,
`packages/kernel/tests/architecture/workspace-surface.test.ts`): "`code`'s prompt history fired on the first Enter, before
any tool had run, through a bare recursive `mkdir` — so the ignore file existed only if some other
writer happened to go first."

**INV-195.** No file found under `<ws>/.clarvis` ends in `.lock`, and no path segment anywhere
under it is `.journal`, `.state`, `.history`, or `local` — all of that machinery is confirmed
instead to exist under the global state root (`memory/.state/`, `memory/.history/` present there).
Test: `packages/kernel/tests/architecture/workspace-surface.test.ts` (absence in `.clarvis`) (presence in the
state tree).

### Further invariants derived directly from the code (unnumbered in the global catalog)

**PATHS-A.** `ownerSegment` never returns an empty, `.`-only, or `..`-only path segment, and
throws `TypeError` on an empty input. Production: `packages/paths/src/roots.ts`. Test:
`packages/paths/tests/unit/roots.test.ts` directly covers safe values, separators, dot
encoding, empty-input refusal, and the fixed-width hash fallback.

**PATHS-B.** `reclaimLocalLease`/`reclaimLocalLeaseSync` never delete a lock whose identity
changed between the initial observation and the post-recovery-intent re-observation
(`sameObservedLease`, `packages/paths/src/local-lease.ts`), and never unlink a quarantined entry whose
moved identity/token does not match what was expected (`packages/paths/src/local-lease.ts`) — instead
restoring the quarantine. Production: `packages/paths/src/local-lease.ts` (async) (sync). Pinned
by `packages/paths/tests/contract/local-lease.test.ts` ("preserves a successor introduced before async quarantine",
"never detaches a raced successor after observing an older stale lease").

**PATHS-C.** A release's identity check (`heldIdentity`) is captured from the **held file
descriptor**, not from a fresh `lstat` of the path, so an ABA replacement of the path (unlink +
recreate with a different inode) between a holder's last confirmed ownership and its `release()`
call is detected and the release refuses to delete the successor. Production:
`packages/paths/src/local-lease.ts`. Pinned by `packages/paths/tests/contract/local-lease.test.ts` ("a late release cannot unlink a
successor with another token and inode", POSIX-only per `test.if(process.platform !== "win32")`).

**PATHS-D.** `writeStaged`/`writeStagedSync` always attempt to remove their staged temp file on
any failure from `open` onward, and report (via `paths.atomic_staging_failed`) whether that
removal itself succeeded — a removal failure never replaces or masks the original thrown error.
Production: `packages/paths/src/atomic.ts`. Pinned by `packages/paths/tests/contract/atomic.test.ts` (both
`test.if(modeBitsEnforced)`).

**PATHS-E.** An asynchronous lease that has already lost ownership still closes its held file handle
when `release()` is called. It returns `false` and does not detach the canonical lease path.
Production: `packages/paths/src/local-lease.ts` (`createLease`, `release`). Test:
`packages/paths/tests/contract/local-lease.test.ts` ("a holder that loses its lease on a heartbeat
says so, and names the phase").

**PATHS-F.** Remote MCP registrations and tokens are machine state, not operator-authored settings:
`globalPaths(root).mcpOAuthFile` is always `<global>/state/mcp-oauth.json`. Production:
`packages/paths/src/global.ts`. Test:
`packages/paths/tests/component/paths.test.ts`.

## 6. Failure modes and degradation

| Condition | Behavior | Cite |
| --- | --- | --- |
| Rename fails with a non-retryable errno, or on POSIX at all | throws immediately, no retry | `packages/paths/src/atomic.ts` |
| Rename fails transiently on Windows, schedule exhausted | one final unconditional attempt, its error (if any) propagates uncaught | `packages/paths/src/atomic.ts` |
| `fsyncDir` cannot open/sync a directory (any platform, any reason) | swallowed; logged once per errno at `debug`; caller never sees an error | `packages/paths/src/atomic.ts` |
| Atomic write fails at any stage (`open`, `writeFile`, `sync`, `chmod`, `rename`) | temp is best-effort removed, `paths.atomic_staging_failed` warned with whether removal succeeded, original error rethrown | `packages/paths/src/atomic.ts` |
| `ensureWorkspaceDir`'s `.gitignore` seed fails for a reason other than "already exists" | logs `paths.gitignore_seed_skipped` (`file`, `code`) at `debug` and swallows the error — the directory creation still succeeds and the caller is never told the ignore file may be missing | `packages/paths/src/ensure.ts` |
| An existing `.gitignore` cannot be read or atomically updated with `worktrees/` | logs `paths.gitignore_update_failed` (`file`, `code`) at `warn` and throws, so checkout creation cannot proceed without the exclusion | `packages/paths/src/ensure.ts` (`seedFile`) |
| `ensureWorkspaceSubdir` given a `dir` outside `<ws>/.clarvis` | throws a plain `Error` naming both paths | `packages/paths/src/ensure.ts` |
| `acquireLocalLease` contended and unreclaimable | returns `null` after `waitMs` of retries — never throws | `packages/paths/src/local-lease.ts` |
| `tryPublish`'s `afterPublish` callback or its post-publish recovery-intent recheck throws | the just-published lease is abandoned via `abandonPublishedLease(Sync)` and the original error is rethrown — `acquireLocalLease`/`acquireLocalLeaseSync` reject/throw rather than returning `null` | `packages/paths/src/local-lease.ts` (async) (sync) |
| `owned()` or `renew()` finds it no longer holds the lease | sets `lost = true` and logs `paths.lease_lost` with `phase` naming where the loss was discovered — one of the three `LeaseLossPhase` values `"renew"` (a failed heartbeat, `packages/paths/src/local-lease.ts`), `"stat"` (the identity capture at the start of `release()` failed), or `"release"` (`handle.close()` itself failed); every subsequent `owned()`/`release()` call returns `false`, while `release()` still stops heartbeat work and closes the held handle | `packages/paths/src/local-lease.ts` (`createLease`, `release`); `packages/paths/tests/contract/local-lease.test.ts` (heartbeat-loss regression) |
| A reclaim's rename-to-quarantine hits `ENOENT` (already gone) | treated as success (`return true`), not a refusal | `packages/paths/src/local-lease.ts` |
| A reclaim's quarantine identity mismatches | restores (links) the quarantine back to its original path, refuses, logs `paths.lease_reclaim_refused` with the stage | `packages/paths/src/local-lease.ts` |
| A lease reclaim decision is wrong (steals a lock from a still-alive holder due to clock skew or an unusual errno) | not detected or corrected anywhere in this package — the design note at `packages/paths/src/local-lease.ts` names this as "the single densest blind spot here: if the judgement is wrong, two holders both believe they own the path and nothing anywhere says so" | `packages/paths/src/local-lease.ts` |
| A diagnostic sink itself throws while a lease decision is being reported | caught and discarded via `reportQuietly` — "A diagnostic may be lost; it may never change an outcome." | `packages/paths/src/local-lease.ts` |
| `executableOnPath` finds nothing on `PATH` | `resolveCommand` returns the bare command name unchanged, deferring the failure to the eventual spawn | `packages/paths/src/which.ts` |
| `sweepSpillDir`'s target directory is missing, or scanning throws mid-iteration | the whole pass is treated as a no-op / partial pass; per-file `stat`/`rm` errors are individually swallowed | `packages/paths/src/housekeeping.ts` |
| `sweepSpillDir` scans past `maxEntries` | scan stops early (`truncated: true` in the `paths.spill_sweep` log), leaving the remainder of the directory unswept until the next pass | `packages/paths/src/housekeeping.ts` |
| `sweepGlobalStateArtifacts` encounters a missing/unreadable workspace or a changing entry | skips that branch or entry and continues within the configured bounds | `sweepGlobalStateArtifacts` in `packages/paths/src/housekeeping.ts` |

## 7. Coupling

**Depends on nothing.** `@clarvis/paths` has zero dependencies, internal or external
(`package.json`; `packages/paths/src/index.ts`; `packages/paths/src/diag.ts` states this is enforced by
`tooling/checks/package-graph.ts`, a build/tooling script outside this package's own `src`/`tests`
that this document's scope does not include verifying directly — see §8).

**Depended on by every package that touches a workspace or global root.** This is enforced
structurally rather than by any single test in this document's scope: `WorkspacePaths`,
`WorkspaceStatePaths` and `GlobalPaths` are the only typed way to reach `.clarvis`/`.agents`
paths, and `invariant.test.ts` (INV-001–004) makes spelling those literals anywhere else in
`packages/*/src` or `packages/*/tooling` a failing test. This is a **static, source-text**
enforcement (`Glob` + regex over file contents, `packages/paths/tests/architecture/invariant.test.ts`), not a type constraint
— a package could still in principle hand-build an equivalent path by concatenating segments
that individually don't match the literal regex (e.g. via string concatenation split across
variables) and the test would not catch it, though nothing found in this document's scope does so.

**`PathsLogger` is a structural duplicate, not a shared type**, of `@clarvis/capability`'s
`Logger` port. The doc names the reason: "this package has no dependencies at all, internal or
external, and `tooling/checks/package-graph.ts` enforces that. The capability port satisfies this
shape, so a host passes its own logger straight in; the drift test lives in
`packages/loop/tests/integration/execute-run-entrypoints.test.ts`, because a test here may not
import the package it would have to compare against." (`packages/paths/src/diag.ts`) — i.e. the coupling check
that the two shapes stay compatible lives in `@clarvis/loop`, not here, precisely because putting
it here would require an import this package must never have.

**`@clarvis/kernel`'s `workspace-surface.test.ts` is the one place outside this package that
exercises the workspace-content-vs-machinery rule end-to-end**, because it is "the lowest package
that sees both `@clarvis/plan` and `@clarvis/memory`" (`packages/kernel/tests/architecture/workspace-surface.test.ts`) — a
runtime/import-graph fact (this package cannot see either), not a type-level one. The monitor and
spill writers are explicitly *not* driven from here because "the kernel does not depend on
`@clarvis/tools`" (`packages/kernel/tests/architecture/workspace-surface.test.ts`); that coverage instead lives in `@clarvis/
tools`'s own suites (delegated, per the same comment, to `tools`' `monitor-lib`/`shell` suites and
`loop`'s `tool-spill` suite — outside this document's scope).

**`WORKSPACE_ENV` (`CLARVIS_WORKSPACE_ROOT`) is a cross-package contract with `@clarvis/hooks`**:
this package defines the name (`packages/paths/src/roots.ts`) and `@clarvis/hooks` injects it into every hook
subprocess's environment so a hook that shells back out to Clarvis resolves the same workspace
root — a **runtime** (environment-variable) coupling, not an import.

## 8. Open questions

- **Whether any test exercises the `PENDING` exception list becoming non-empty** (i.e. what
  happens when a deliberate, reviewed exception is actually added) is not observable from an
  always-empty list; the mechanism is present (`packages/paths/tests/architecture/invariant.test.ts`) but its behavior with
  a populated list is untested by construction.
- **The exact recovery/quarantine race outcome when a filesystem's `link()` does not behave
  POSIX-atomically** (a filesystem-specific assumption `tryPublish` depends on for its "canonical
  path appears in one step" guarantee, `packages/paths/src/local-lease.ts`) is asserted by comment, not
  measured against a real non-POSIX-compliant filesystem in any test in this document's scope.
- **Worktree launch semantics** are explicitly out of scope here and belong to the
  [launch-worktrees](../capabilities/worktrees.md) document; this package owns only the canonical
  checkout path.
- **The TOCTOU threat model for workspace-confined writes** (what happens if a parent directory is
  swapped for a symlink between validation and mutation) is explicitly delegated to the
  [security-confinement-and-redaction](../cross-cutting/security.md) document and is not analyzed here, even though
  `ensureWorkspaceSubdir`'s confinement check (`packages/paths/src/ensure.ts`) is a `@clarvis/paths` function;
  this document describes only what that function does, not whether it is sufficient against a
  concurrent adversary. **Recorded, in `@clarvis/tools` rather than here**: the threat
  model, the read/write asymmetry and the rejected partial mitigations are now stated in
  `resolvePath`'s `@remarks` (`packages/tools/src/lib/paths.ts`). It is written there because that is
  the function whose return value discards the canonical form — this package's own check is not the
  one the race turns on. The defect remains open.
- **`memory`'s and `trace`'s own on-disk layouts** beneath the roots this package hands them
  (`memoryMachineryRoot`, `tracesDir`, etc.) are delegated to [memory-wiki-store](../capabilities/memory-store.md) and
  [trace-recording-and-persistence](trace.md) respectively, per this document's scope statement, and are not
  described here beyond the single directory path each root resolves to.
