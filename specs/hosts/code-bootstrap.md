# `@clarvis/code` — CLI fast path, entry resolution, app assembly and layering

> Implemented at `packages/code/...`. Every claim below is anchored to a file and a named symbol or test. Open
> questions are collected in the final section.

## 1. Purpose

`@clarvis/code` is an application package with no `exports` map; its one declared entry point is the
`clarvis` bin, which points at `src/cli.ts` (`packages/code/package.json`). This subsystem is
everything between that bin and a painted terminal frame: the flag table, the two textual flags and
explicit updater that run without loading the application, the choice between the built bundle and the TypeScript
sources, the headless modes, the interactive boot sequence that constructs a file kernel and a run
host, and the Solid/OpenTUI shell that the boot renders.

The organising constraint stated in the source is launch cost. `packages/code/src/cli.ts` records
that everything statically imported by `cli.ts` "is paid on every launch, including `--version`", and
that `--help`/`--version` "used to be handled inside `main()`, after the whole 847-file graph had
loaded, and cost ~2.5 s to print one string". `packages/code/src/cli-entry.ts` records the same
figure for running the sources instead of the bundle: "roughly 2.5 s a launch: from source Bun
transpiles the 847-file graph and applies the Solid JSX transform through Babel on every start". Two
architecture tests exist solely to keep those two properties from regressing
(`packages/code/tests/architecture/cli-fast-path.test.ts`).

The second organising constraint is layering. `packages/code/tests/architecture/architecture-boundary.test.ts`
enforces four directional rules among `core/`, `adapters/`, `ui/`, `views/` and `features/**/controller.ts`,
and `packages/code/tests/architecture/dependency-boundary.test.ts`, "imports only its declared Clarvis
dependencies and approved kernel entrypoints", confines the package to six
`@clarvis/kernel` entrypoints and three `@clarvis/*` manifest dependencies. `src/index.tsx` is the
lightweight renderer entry while `src/runtime.tsx` is the complete composition root. Both are exempt
from in-process coverage because importing either starts application lifecycle work; PTY smoke and
architecture tests pin their observable handoff (`tooling/checks/coverage.ts`,
`NO_COUNTER_ALLOWLIST`).

## 2. Surface

Interactive runtime composition also owns one in-memory conversation prompt scheduler. It binds
jobs to `RunHost.scheduledBinding`, supplies connection/configuration readiness, pauses on reconnect
or conversation changes, cancels registrations on session deletion and disposes timers on close.
App contributes draft/dialog admission gates and command composition registers `/loop`. Headless
execution does not instantiate this controller or restore any schedule. Production: `loops`,
`loopReadiness`, `buildRunHost`, `closeWorkspace` in
[runtime.tsx](../../packages/code/src/runtime.tsx) and `registerCodeCommands` in
[command-composition.ts](../../packages/code/src/app/command-composition.ts).
Test: controller disposal/binding cases in
[loop-controller.test.ts](../../packages/code/tests/unit/loop-controller.test.ts) and live App command
and interaction gates in [app-shell-render.test.tsx](../../packages/code/tests/integration/app-shell-render.test.tsx).
The owning contract is [loop-scheduling.md](loop-scheduling.md).

Interactive composition also constructs the goal presentation controller against the current kernel
connection. Conversation or connection changes retire its prior observation; canonical invalidations
coalesce state reads and follow host-started stages through `RunHost.synchronizeGoal`. Shutdown
disposes subscriptions and late presentation callbacks. Goal continuation has no client timer or
run-start bypass. The activity line combines durable goal status with the independently tracked run
status, and a checkpoint is displayed separately from final completion.
Production: goal controller composition and `closeWorkspace` in
[runtime.tsx](../../packages/code/src/runtime.tsx), `registerCodeCommands` in
[command-composition.ts](../../packages/code/src/app/command-composition.ts), and `runOutcomeStatus`
in [run-host.ts](../../packages/code/src/run-host.ts).
Test: [goal-controller.test.ts](../../packages/code/tests/unit/goal-controller.test.ts),
[goal-commands.test.tsx](../../packages/code/tests/integration/goal-commands.test.tsx) and
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts).

Goal status remains separate from the run's status string so the settled-outcome classifier cannot
confuse a cancelled goal with a completed physical run. `LeadActivityLine` retains the current
goal status beside its idle or working phase; `runOutcomeLabel` presents a saved checkpoint distinctly.
Production: `leadActivityDetail` in [App.tsx](../../packages/code/src/views/App.tsx),
`LeadActivityLine` in [Footer.tsx](../../packages/code/src/views/Footer.tsx) and `runOutcomeLabel` in
[status-presenter.ts](../../packages/code/src/features/run/status-presenter.ts).
Test: the idle/live goal-status case in
[app-shell-render.test.tsx](../../packages/code/tests/integration/app-shell-render.test.tsx) and
the checkpoint strip case in [run-status.test.ts](../../packages/code/tests/unit/run-status.test.ts).

### 2.1 The `clarvis` bin

| Property | Value | Source |
| --- | --- | --- |
| bin name | `clarvis` | `packages/code/package.json` |
| bin target | `src/cli.ts` | `packages/code/package.json` |
| bundle path preferred at runtime | `../dist/index.js` relative to `cli.ts` | `packages/code/src/cli.ts` |
| source fallback modules | `@opentui/solid/preload`, then `./index.tsx` | `packages/code/src/cli.ts` |
| package `exports` | absent (application package) | `packages/code/package.json` (no `exports` key) |

The manifest exposes no compatibility alias: the installed executable is `clarvis` only. The
TypeScript setup requires the exact Bun version pinned by `mise.toml`, performs a frozen root install,
selects `build:install` (whose artifact omits source maps), and removes the earlier executable only
when it is a symlink owned by this package before unregistering and linking again. It does not
download Bun or mutate shell profiles; ordinary root/package builds retain detached maps for development diagnostics
(`packages/code/package.json` (`bin`, `scripts.build:install`),
`packages/code/tooling/setup.ts` (build and link phases)).

The distinct POSIX development entry starts at root `dev-install.sh`, which checks that Bun is
available and delegates to `packages/code/tooling/development-install.ts`. In its default local mode, that typed installer
requires the exact `mise.toml` version, performs the frozen dependency install, configures the local
Git hook, and atomically creates a marked `clarvis-develop` regular file without replacing an
unmanaged destination. The launcher embeds the absolute checkout and Bun paths, does not change the
caller's current directory, exports `CLARVIS_CODE_SOURCE=1`, and executes `src/cli.ts`; it therefore
tests the current sources from another workspace without a release or Code build. Reinstallation
updates only the marked launcher and `--uninstall` removes only that file. Application startup uses
the authenticated local-host transition in `connectOrLaunchLocalKernel`: a same-wire prior artifact
is replaced only after it accepts an idle restart, while active physical work preserves the prior
generation. Production: `dev-install.sh`, `packages/code/tooling/development-install.ts`
(`installDevelopmentLauncher`, `developmentLauncherSource`, `uninstallDevelopmentLauncher`) and
`packages/kernel/src/hosting/launcher.ts` (`connectOrLaunchLocalKernel`). Test:
`packages/code/tests/unit/development-install.test.ts` (delegation, caller-workspace preservation,
source selection, ownership refusal, update, and uninstall cases) and
`packages/kernel/tests/integration/local-host-process.test.ts` (idle artifact transition and active
work refusal).

The explicit `--candidate [tag]` mode installs a published source prerelease into a separate unique
checkout below `${XDG_DATA_HOME:-$HOME/.local/share}/clarvis-candidates/`. Without a tag it chooses
the numerically highest RC among the latest 100 source releases that are non-draft prereleases and
have `runtime-candidate.json`. The manifest must declare `installation: "source-v1"`; older image-only
RCs are not installable through this path. Exact tags must satisfy the same publication filter.
The installer checks the fetched tag's commit against `source_revision`, root version and pinned Bun,
installs frozen dependencies, and smokes `--version` before atomically switching the marked launcher.
When Docker or Podman is installed, it tries the available engines in that order and requires one to
pull and inspect the digest-pinned candidate image. When neither is installed it skips prefetch,
activates the native-capable candidate and reports that container isolation still needs an engine.
Failure from every installed engine removes only the new checkout
and preserves the previous launcher; downloaded registry layers can remain. Successful older
checkouts are retained. Candidate mode cannot combine with installer clearing or maintenance modes.
The candidate launcher exports `CLARVIS_RUNTIME_CANDIDATE` and `CLARVIS_RUNTIME_CANDIDATE_REVISION`;
local launchers unset both to avoid inheriting a candidate selection. Updates require another explicit
candidate installation, and uninstall still removes only the launcher. Git and the exact Bun runtime
are prerequisites; candidate installation does not install a container engine.
Production: `packages/code/tooling/candidate-install.ts` (`installCandidate`, `candidateJson`,
`selectCandidateRelease`), `packages/code/tooling/development-install.ts`
(`parseDevelopmentInstallArgs`, `developmentLauncherSource`).
Test: `packages/code/tests/unit/candidate-install.test.ts` (publication selection, bounded downloads,
source/image identity and failure-safe activation), `packages/code/tests/unit/development-install.test.ts`
(launcher ownership and caller workspace).

The development-only `--empty-workspace` operation allocates a new empty
`/tmp/clarvis-development-temp/workspace-*` directory on every invocation and changes into it before
starting the source entry. The fixed parent is created owner-only and authenticated by an exact
regular-file marker. `--clear` resolves and permanently removes the same effective global root as
the app plus that complete temporary-workspace parent. A bare launcher cleanup exits; when combined
with `--empty-workspace`, cleanup precedes allocation and the source command starts in the new path.
Global cleanup refuses the user home itself, targets outside the home, symbolic links, and
non-directories. Temporary cleanup refuses a link, non-directory, foreign owner, missing marker, or
changed marker. Other workspace state is not in scope. Production:
`packages/code/tooling/development-install.ts` (`cleanDevelopmentState`,
`createEmptyDevelopmentWorkspace`, `clearDevelopmentTempWorkspaces`,
`clearDevelopmentEnvironment`). Test: `packages/code/tests/unit/development-install.test.ts`
(`clean removes only a real global-state directory below home`, `empty workspaces are always new
and clear removes only the authenticated root`). Release uninstall retains the separate
state-preserving contract in [Portable distribution](../cross-cutting/distribution-and-updates.md).

### 2.2 Flag table (`FLAGS`, `packages/code/src/cli-args.ts`)

`FLAGS` is declared as "the single source of truth for the CLI surface: parsing, `--help`, the usage
line and the README synopsis all derive from this table" (`packages/code/src/cli-args.ts`).

| Flag | Alias | Value form | Mode-selecting | Description string (verbatim) | File |
| --- | --- | --- | --- | --- | --- |
| `--help` | `-h` | — | yes | `print this help and exit` | `packages/code/src/cli-args.ts` |
| `--version` | — | — | yes | `print the version and exit` | `packages/code/src/cli-args.ts` |
| `--print` | `-p` | `<prompt>` (next token) | yes | `run the prompt headless: stream the reply to stdout, exit 0/1` | `packages/code/src/cli-args.ts` |
| `--agent` | — | `<name>` (next token) | no | `agent to run --print as (default: entry agent)` | `packages/code/src/cli-args.ts` |
| `--format` | — | `<text\|md>` (next token) | no | `--print output: text (default) or md transcript` | `packages/code/src/cli-args.ts` |
| `--resume` | — | `<session-id>` (next token) | yes | `resume a saved session` | `packages/code/src/cli-args.ts` |
| `--continue` | — | — | yes | `resume this workspace's most recent session` | `packages/code/src/cli-args.ts` |
| `--list` | — | — | yes | `list saved sessions and exit` | `packages/code/src/cli-args.ts` |
| `--delete` | — | `<session-id>` (next token) | yes | `delete a session and its runs` | `packages/code/src/cli-args.ts` |
| `--refresh-models` | — | — | yes | `refresh the models.dev catalog and exit` | `packages/code/src/cli-args.ts` |
| `--update` | — | — | yes | `install the newest eligible Clarvis release and exit` | `packages/code/src/cli-args.ts` (`FLAGS`) |
| `--ascii` | — | — | no | `render glyphs as plain ascii` | `packages/code/src/cli-args.ts` |
| `--extension-profile` | — | `<selector>` (next token) | no | `select an Extension Profile for this process (scope:name or name)` | `packages/code/src/cli-args.ts` (`FLAGS`) |
| `--worktree` | — | optional next token or `=name` | no | `open a dedicated Git worktree; omit name to generate one` | `packages/code/src/cli-args.ts` |
| `--remote` | — | `<user@host>` (next token) | no | `connect to a Clarvis installation over SSH` | `packages/code/src/cli-args.ts` |
| `--remote-workspace` | — | `<path>` (next token) | no | `absolute workspace path on the remote host` | `packages/code/src/cli-args.ts` |
| `--debug` | — | `[=<error\|warn\|info\|debug>]` (inline, optional) | no | `write bounded application diagnostics; --debug=<level>` | `packages/code/src/cli-args.ts` (`FLAGS`) |

`FlagSpec.value` consumes the **next** token and is mandatory; `FlagSpec.inlineValue` is attached with
`=` and is optional; `FlagSpec.optionalValue` accepts either the next token or an `=` value and also
permits the bare flag (`packages/code/src/cli-args.ts`).

### 2.3 `Mode` (`packages/code/src/cli-args.ts`)

```ts
export type WorktreeRequest = true | string;
export interface RemoteWorkspaceRequest { destination: string; workspace: string }
interface ExtensionProfileMode { extensionProfileSelector?: string }
interface WorkspaceMode extends ExtensionProfileMode {
  worktree?: WorktreeRequest;
  remote?: RemoteWorkspaceRequest;
}

export type Mode =
  | ({ kind: "run"; ascii: boolean; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "resume"; id: SessionId; ascii: boolean; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "continue"; ascii: boolean; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "print"; prompt: string; agent?: string; format: PrintFormat; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "list"; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "delete"; id: SessionId; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "refresh-models"; debug: DebugFlag } & WorkspaceMode)
  | { kind: "update" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "usage-error"; message: string };
```

`worktree` reaches run, resume, continue, print, list and delete, but not update/help/version/error.
`remote` reaches every mode that constructs a workspace kernel, including model refresh; both remote
flags are required together and exclude `worktree`. `extensionProfileSelector` reaches every mode that constructs a
kernel, including refresh, but not update/help/version/error. It is the process-local `--extension-profile`
selector with highest Extension Profile precedence; it changes no persisted selection. Qualified
`scope:name` and bare-name resolution are owned by
[Extension Profiles](extension-profiles.md). `ascii` reaches only the three interactive variants;
`update`/`help`/`version`/`usage-error` carry no `debug`
member at all, which is what `resolveDebugRequest`'s `!("debug" in mode)` guard keys on
(`packages/code/src/cli-args.ts`).

`InteractiveMode` is the subset `runInteractiveMode` and its internal `runApp` accept:
`Extract<Mode, { kind: "run" | "resume" | "continue" }>`
(`packages/code/src/index.tsx`, `packages/code/src/runtime.tsx`, `InteractiveMode`).

### 2.4 Exported functions

| Source | Export | Signature |
| --- | --- | --- |
| `packages/code/src/cli-args.ts` | `PrintFormat` | `"text" \| "md"` |
| `packages/code/src/cli-args.ts` | `DebugFlag` | `{ enabled: boolean; level?: DiagnosticLevel }` |
| `packages/code/src/cli-args.ts` | `DebugRequest` | `{ enabled: boolean; level: DiagnosticLevel }` |
| `packages/code/src/cli-args.ts` | `Mode` | union above |
| `packages/code/src/cli-args.ts` | `RemoteWorkspaceRequest` | `{ destination: string; workspace: string }` |
| `packages/code/src/cli-args.ts` | `FLAGS` | `readonly FlagSpec[]` |
| `packages/code/src/cli-args.ts` | `DebugEnv` | index-signature env view naming `CLARVIS_CODE_DEBUG`, `CLARVIS_CODE_DEBUG_LEVEL` |
| `packages/code/src/cli-args.ts` | `resolveDebugRequest` | `(mode: Mode, env: DebugEnv) => DebugRequest` |
| `packages/code/src/cli-args.ts` | `usageText` | `() => string` |
| `packages/code/src/cli-args.ts` | `helpText` | `() => string` |
| `packages/code/src/cli-args.ts` | `versionText` | `() => string` |
| `packages/code/src/cli-args.ts` | `productVersion` | `() => string` |
| `packages/code/src/cli-args.ts` | `parseMode` | `(argv: string[]) => Mode` |
| `packages/code/src/cli-entry.ts` | `EntryInputs` | `{ distPath: string; distExists: boolean; forceSource: boolean }` |
| `packages/code/src/cli-entry.ts` | `EntryChoice` | `{kind:"dist"} \| {kind:"source"} \| {kind:"error"; message:string}` |
| `packages/code/src/cli-entry.ts` | `resolveEntry` | `(inputs: EntryInputs) => EntryChoice` |
| `packages/code/src/cli-entry.ts` | `privateEntry` | `(argv: readonly string[]) => "remote-kernel" \| undefined` |
| `packages/code/src/adapters/remote-kernel-arguments.ts` | `encodeRemoteKernelArguments` / `parseRemoteKernelArguments` | closed bounded base64url launch payload |
| `packages/code/src/cli-mode.ts` | `resolveResumeMeta` | `(store, owner, workspace, mode) => SessionMeta \| null` |
| `packages/code/src/cli-mode.ts` | `createPrintStream` | `(write: (chunk: string) => void) => (event: RunEvent) => void` |
| `packages/code/src/cli-mode.ts` | `drainPrintEvents` | `(events, sink) => { transcriptDone: Promise<void>; drained: Promise<void> }` |
| `packages/code/src/app/layout.ts` | `LayoutMode` / `SecondarySurfaceMode` | `"wide"\|"narrow"\|"single"\|"floor"` / `"closed"\|"split"\|"drawer"` |
| `packages/code/src/app/layout.ts` | `INSPECTOR_MIN_WIDTH` / `INSPECTOR_MAX_WIDTH` / `INSPECTOR_SPLIT_MIN_WIDTH` | `32` / `56` / `100` |
| `packages/code/src/app/layout.ts` | `FLOOR_MIN_COLUMNS` / `FLOOR_MIN_ROWS` | `24` / `6` |
| `packages/code/src/app/layout.ts` | `LayoutController` / `createLayoutController` | content- and viewport-driven reactive controller |
| `packages/code/src/app/workspace-runtime.ts` | `WorkspaceCallbackTarget<T>` | `{ current(); bind(v); clear() }` |
| `packages/code/src/app/workspace-runtime.ts` | `createWorkspaceCallbackTarget` | `<T>() => WorkspaceCallbackTarget<T>` |
| `packages/code/src/app/workspace-runtime.ts` | `isActiveWorkspaceCallbackTarget` | `(candidate, published) => boolean` |
| `packages/code/src/bootstrap/worktree.ts` | `WorktreeBootstrapResult`, `WorktreeBootstrapDependencies` | selected checkout/result and injectable Git/time/random seams |
| `packages/code/src/bootstrap/worktree.ts` | `runBootstrapGit` | bounded argv-only Git runner |
| `packages/code/src/bootstrap/worktree.ts` | `bootstrapWorktree` | `(startingWorkspace, request, deps?) => Promise<WorktreeBootstrapResult>` |
| `packages/code/src/app/command-composition.ts` | `FeatureCommandDeps` | settings/catalog/keys/code/agents/env/notify |
| `packages/code/src/app/command-composition.ts` | `CodeCommandDeps` | `AppCommandDeps & { features: FeatureCommandDeps }` |
| `packages/code/src/app/command-composition.ts` | `registerCodeCommands` | `(deps: CodeCommandDeps) => AppCommandWiring` |
| `packages/code/src/app/commands.tsx` | `AppCommandDeps` | application command dependency bag |
| `packages/code/src/app/commands.tsx` | `AppCommandWiring` | `{ doctorDirty; recheck; sandboxInspection; skillAgent; dispose }` |
| `packages/code/src/app/commands.tsx` | `registerAppCommands` | `(deps: AppCommandDeps) => AppCommandWiring` |
| `packages/code/src/views/App.tsx` | `AppShell` / `AppRunControls` / `AppSessionControls` / `AppFleet` / `AppBackend` / `AppProps` | see §2.5 |
| `packages/code/src/views/App.tsx` | `App` | `(props: AppProps) => JSX.Element` |
| `packages/code/src/views/FatalBoot.tsx` | `runFatalBoot` | `({ renderer, error, retry, quit }) => Promise<boolean>`; `true` means retry recovery, `false` means terminal renderer teardown |
| `packages/code/src/views/Splash.tsx` | `BANNER` | `string[]`, 8 rows of ASCII art |
| `packages/code/src/views/Splash.tsx` | `FIRST_RUN_SPLASH_MIN_COLUMNS` / `FIRST_RUN_SPLASH_MIN_ROWS` | `76` / `24` |
| `packages/code/src/views/Splash.tsx` | `firstRunSplashFits` | `(width: number, height: number) => boolean` |
| `packages/code/src/views/Splash.tsx` | `BrandBanner` | `({ width: () => number, compact?: () => boolean }) => JSX.Element` |
| `packages/code/src/views/Splash.tsx` | `Splash` | `({ agent, model, width, rightInset? }) => JSX.Element` |
| `packages/code/src/views/PageFrame.tsx` | `PageFrame` | `({ title, subtitle?, interaction, children }) => JSX.Element` |
| `packages/code/src/views/HeaderRows.tsx` | `HeaderRowsProps` / `HeaderRows` | `{ plan: Accessor<HeaderPlan> }` |
| `packages/code/src/views/StartupComposer.tsx` | `StartupComposerSnapshot`, `StartupComposerState`, `createStartupComposerState`, `StartupComposer` | one-shot draft/submission bridge and focused pre-runtime input; `StartupComposer` also receives the root-owned product `version` |
| `packages/code/src/boot-shell.ts` | `BootShell` | renderer/root handoff from the lightweight entry to the runtime |
| `packages/code/src/runtime.tsx` | `runInteractiveMode`, `runHeadlessMode` | continue interactive or headless dispatch after the lightweight entry |

`src/index.tsx` exports **nothing**; it is a bootstrap module whose top level runs
`main()` and records an unhandled failure as `clarvis failed: <text>` without forcing an immediate
process exit (`packages/code/src/index.tsx`, `main`).

### 2.5 The five control groups `runtime.tsx` hands `App`

`App` takes exactly seven props (`packages/code/src/views/App.tsx`): the transcript and
activity stores plus five control groups. The process is pinned to one workspace, so these objects
do not implement runtime worktree switching:

| Prop | Interface | Constructed at | Notable members |
| --- | --- | --- | --- |
| `store` | `TranscriptStore` | `packages/code/src/runtime.tsx` (`store`) | `describeToolCall`, `fetchRun` |
| `activity` | `ActivityStore` | `packages/code/src/runtime.tsx` (`activity`) | — |
| `shell` | `AppShell` (`packages/code/src/views/App.tsx`) | `packages/code/src/runtime.tsx` (`shell`) | renderer/platform/debug session, immutable workspace identity, branch/files, optional managed-worktree clean/remove controls, post-paint queue, quit |
| `run` | `AppRunControls` (`packages/code/src/views/App.tsx`) | `packages/code/src/runtime.tsx` (`runControls`) | submit/compact/context inspection/cancel/local-command controls; `switching` is always false |
| `session` | `AppSessionControls` (`packages/code/src/views/App.tsx`) | `packages/code/src/runtime.tsx` (`sessionControls`) | current-workspace list/catalog/resume/delete/clear/export/status/cost |
| `fleet` | `AppFleet` (`packages/code/src/views/App.tsx`) | `packages/code/src/runtime.tsx` (`fleet`) | agents/settings/guard/memory/keys/catalog and refresh operations |
| `backend` | `AppBackend` (`packages/code/src/views/App.tsx`) | `packages/code/src/runtime.tsx` (`backendConn`) | client/current-plan reader/models/provider auth/workflows/plugins/tasks/storage/run lookup/reconnect |

### 2.6 Environment variables read by this subsystem

| Variable | Read at | Effect |
| --- | --- | --- |
| `CLARVIS_CODE_SOURCE=1` | `packages/code/src/cli.ts` | forces the source entry over the bundle |
| `CLARVIS_INSTALL_ROOT` | `packages/code/src/update/installation.ts` (`managedInstallation`) | authenticates a versioned portable install for explicit self-update |
| `CLARVIS_CODE_DEBUG` | `packages/code/src/cli-args.ts` | enables diagnostics unless in `{"", "0", "off", "false", "no"}` (`packages/code/src/cli-args.ts`); its value also doubles as a level (`packages/code/src/cli-args.ts`) |
| `CLARVIS_CODE_DEBUG_LEVEL` | `packages/code/src/cli-args.ts` | level only; takes precedence over the level read out of `CLARVIS_CODE_DEBUG` |
| `CLARVIS_OWNER` | `packages/code/src/startup-foundation.ts`, `packages/code/src/runtime.tsx` | passed as `defaultOwner` to `WorkspaceClientManager.create` |
| `CLARVIS_AGENT_TOOLS_MAX_GRANT` | `packages/code/src/index.tsx` (`runInteractive`) and `packages/code/src/adapters/host-kernel-options.ts` (`codeHostEnvironment`) | defaulted to `"exec"` before launcher policy identity or local/remote workspace-kernel construction |
| `CLARVIS_CODE_DEV` | `packages/code/src/index.tsx` (`runInteractive`) | `dev` flag into `buildRendererConfig`; the runtime passes it to `createPlatform` |
| `SSH_TTY` / `SSH_CONNECTION` | `packages/code/src/index.tsx` (`runInteractive`) | sets `OPENTUI_FORCE_EXPLICIT_WIDTH ??= "true"` |
| `CLARVIS_TUI_RSS_LIMIT_MB` | `packages/code/src/views/App.tsx` | memory-fuse limit (owned by the memory-pressure adapter) |

## 3. Data and formats

### 3.1 `--version` output

`versionText()` returns `` `clarvis ${product.version}` `` where `product` is the root
`../../../package.json`, the monorepo's sole version authority
(`packages/code/src/cli-args.ts`, `versionText`). Pinned by
`packages/code/tests/unit/cli-args.test.ts` (`version reports the product`).
The interactive entry passes `productVersion()` into `StartupComposer`, and the complete `App`
passes the same value into `projectHeader`; both headers render it as `v<version>` in their final
right-aligned zone. Production: `packages/code/src/index.tsx` (`runInteractive`),
`packages/code/src/views/App.tsx` (`headerPlan`),
`packages/code/src/views/StartupComposer.tsx` (`StartupComposer`) and
`packages/code/src/views/header-projection.ts` (`projectHeader`). Tests:
`packages/code/tests/integration/splash-render.test.tsx`,
`packages/code/tests/integration/header-render.test.tsx` and
`packages/code/tests/integration/app-shell-render.test.tsx`.

### 3.2 `--help` output

Assembled in `helpText()` (`packages/code/src/cli-args.ts`):

```
clarvis <version> — the Clarvis terminal UI

usage: clarvis [-h] [--version] [-p <prompt>] [--agent <name>] ... [--debug[=<error|warn|info|debug>]]

Run without flags to start an interactive session in the current directory.

flags:
  -h, --help                        print this help and exit
      ...
```

The usage line comes from `usageText()`, which brackets each flag's alias-or-canonical token plus its
metavar (`packages/code/src/cli-args.ts`); `metavar()` renders `" <v>"` for a value flag and
`"[=<v>]"` for an inline one (`packages/code/src/cli-args.ts`). The flag column is padded to
`max(len(invocation)) + 2` (`packages/code/src/cli-args.ts`).

### 3.3 The missing-bundle error text (`packages/code/src/cli-entry.ts`)

```
clarvis: no build found at <distPath>

  build it:                     bun --filter @clarvis/code build
  or reinstall:                 bun run setup
  or run from source (slower):  CLARVIS_CODE_SOURCE=1 clarvis
```

The TSDoc states the reason for carrying the fix commands inline: "a missing bundle must never reach
the user as a module-resolution failure" (`packages/code/src/cli-entry.ts`). Every one of those
four substrings is asserted in `packages/code/tests/unit/cli-entry.test.ts`.

### 3.4 The non-TTY refusal (`packages/code/src/adapters/renderer-bootstrap.ts`)

```
clarvis is an interactive TUI and needs a terminal.
Headless modes: clarvis --help | --list | --delete <id> | --refresh-models | --update | -p <prompt>
```

followed by `process.exit(2)`.

### 3.5 `--list` row format (`packages/code/src/runtime.tsx`, `runListMode`)

`${workspaceLabel}${available ? "" : " (workspace unavailable)"}  ${formatSessionRow(meta, now)}`,
sorted by `meta.updatedAt` descending; the empty case writes `no sessions\n`
(`packages/code/src/runtime.tsx`, `runListMode`).

`formatSessionRow` itself (`packages/code/src/views/session-row.ts`) joins six columns with
two-space gutters and `.trimEnd()`s the result: `m.id`, `relTime(m.updatedAt, now)` padded to
`TIME_COL_WIDTH = 8`, `` `${sessionTurnCount(m)} turns` `` padded to the exported
`TURNS_COL_WIDTH = 9`, `tokensCellText(m)` padded to the exported `TOKENS_COL_WIDTH = 12`, `costCellText(m)` padded to the exported `COST_COL_WIDTH = 7`, and
`m.title || "(untitled)"`. Its own TSDoc calls it "the `--list` view of the same columns the Sessions
hub renders", and every export beyond `formatSessionRow` itself — `relTime`,
`tokensCellText`, `costCellText` and the three `*_COL_WIDTH` constants — is re-exported specifically
so [code-domain-hubs](code-domain-hubs.md)'s `SessionsHub`
(`packages/code/src/views/config/SessionsHub.tsx`, importing all six) can render its own rows
to this same column format rather than re-deriving it; `WorkflowsHub`
(`WorkflowsHub` reuses only `relTime`), for its own
last-updated timestamps.

`relTime(ms, now)` buckets the clamped-non-negative delta as seconds under a minute,
minutes under an hour, hours under a day, else days, each `Math.round`-ed — so `relTime(NOW +
5_000, NOW)` (a delta that clamps to `0`) reads `"0s ago"` rather than a negative duration
(`packages/code/tests/unit/session-row.test.ts`). `tokensCellText` renders
`↑{input} ↓{output}` only when the session has a nonzero total in either direction, else the empty
string; `costCellText` renders `formatCostUsd(m.totals.costUsd)` only when a cost was
recorded, else the empty string — both are what "zero tokens and no cost leave their columns blank"
pins (`packages/code/tests/unit/session-row.test.ts`).

### 3.6 `--delete` summary (`packages/code/src/runtime.tsx`, `runDeleteMode`)

`session ${deleted|not found}; traces ${okTraces}/${total} deleted`.

### 3.7 `--refresh-models` summary (`packages/code/src/runtime.tsx`, `runRefreshMode`)

`models.dev refreshed — ${providers} providers / ${models} models`, where the em dash is
`glyph("emDash")` and the model count sums `p.models.length` over providers
(`packages/code/src/runtime.tsx`, `runRefreshMode`).

### 3.8 The splash banner (`packages/code/src/views/Splash.tsx`, `BANNER`)

Eight literal rows of figlet-style ASCII spelling `Clarvis`, e.g. row 0 is
`" .d8888b.  888                           d8b"`. `packages/code/tests/integration/splash-render.test.tsx`
(`the banner art is 8 rows and fits 60 cols`) pins both facts about it: exactly 8 rows, and every row shorter than 60 columns — matching the
60-column fallback inside `BrandBanner`.

First-run setup uses the stricter shared `firstRunSplashFits(width, height)` predicate: the complete
banner is mounted only from 76 columns by 24 rows. The column floor accounts for the 85%-wide picker
card and its horizontal chrome; the row floor leaves card chrome, a filter and at least three catalog
rows after the banner. `packages/code/tests/integration/splash-render.test.tsx`
(`first-run splash fit keeps one threshold across setup and catalog pickers`) pins both edges.

The lightweight `StartupComposer` also mounts `BrandBanner`. It allows the complete banner from 60
columns by 16 rows, the exact space needed by its fixed header/input chrome plus the banner and
connection status. Below either edge it uses `BrandBanner`'s one-line wordmark instead, so first paint
keeps the empty-run identity without clipping the usable startup input. Test:
`packages/code/tests/integration/splash-render.test.tsx` (`the startup composer shares the responsive
Clarvis splash on first paint`).

### 3.9 Execution identifier for `--print`

`"exec_" + crypto.randomUUID()` (`packages/code/src/runtime.tsx`, `runPrintMode`).

### 3.10 Session export path

`globalPaths().exportsDirForOwner(owner)`, created `mode: 0o700`, file `${meta?.id ?? "session"}.md`
opened `"w", 0o600` (`packages/code/src/runtime.tsx`, `exportSession`).

### 3.11 The `FatalBoot` screen text (`packages/code/src/views/FatalBoot.tsx`)

Four literal fragments, top to bottom on the screen:

- `` glyph("error") + " clarvis failed to start" ``
- the run's own error text, from `props.error()`
- `` "the kernel could not boot " + glyph("emDash") + " fix the cause above and retry; once the app starts, Doctor lists checks and fixes" ``
- `` props.busy() ? "retrying" + glyph("ellipsis") : "[r] retry [ctrl+c] quit" ``

### 3.12 The `Splash` agent/model line and hint row (`packages/code/src/views/Splash.tsx`, `Splash`)

The idle screen's second block reads `"agent: "` + `props.agent()` then
`` " " + glyph("separator") + " model: " `` + `props.model()` (`Splash`, agent/model block); its
third block joins three literal strings with `glyph("separator")` (`Splash`, hint block):

```
"Type / for commands", "@ for workspace files", "Shift+Tab for agents"
```

`glyph("separator")` renders `"·"` in unicode mode (`packages/code/src/core/marks.ts`), so the
joined row reads `Type / for commands · @ for workspace files · Shift+Tab for agents`.

## 4. Behavior

### 4.1 `cli.ts` — the fast path, in execution order

| # | Step | File |
| --- | --- | --- |
| 1 | static imports: `node:fs` `existsSync`, `node:url`, `./cli-args.ts`, `./cli-entry.ts` | `packages/code/src/cli.ts` |
| 2 | `parseMode(process.argv.slice(2))` | `packages/code/src/cli.ts` |
| 3 | `help` → write `helpText()`, `process.exit(0)` | `packages/code/src/cli.ts` |
| 4 | `version` → write `versionText()`, `process.exit(0)` | `packages/code/src/cli.ts` |
| 5 | compute `distPath` = `../dist/index.js` next to `cli.ts` | `packages/code/src/cli.ts` |
| 6 | `resolveEntry({ distPath, distExists, forceSource })` | `packages/code/src/cli.ts` |
| 7 | `error` → write message to stderr, `process.exit(1)` | `packages/code/src/cli.ts` |
| 8 | `dist` → `await import(pathToFileURL(distPath).href)` | `packages/code/src/cli.ts` |
| 9 | otherwise → `await import("@opentui/solid/preload")` then `await import("./index.tsx")` | `packages/code/src/cli.ts` |

Note what is **not** here: a usage error is not intercepted. `packages/code/src/cli.ts` states this is deliberate
— "It is a human at a keyboard rather than a scripted call, so it can afford the slow path, and
delegating keeps validation semantics owned in one place." A `usage-error` therefore falls through to
step 5, loads the runtime chunk, and is reported by `main()` in `packages/code/src/index.tsx`.

`resolveEntry` implements this precedence (`packages/code/src/cli-entry.ts`):

| Condition | Result |
| --- | --- |
| `forceSource` | `{ kind: "source" }` (even when the bundle exists — pinned at `packages/code/tests/unit/cli-entry.test.ts`) |
| else `distExists` | `{ kind: "dist" }` |
| else | `{ kind: "error", message }` |

The decision was extracted out of `cli.ts` for a stated reason: "The launcher in `cli.ts` is invisible
to coverage — Bun instruments only the test process, and `coverage.ts` allowlists the file for
that reason — so the decision lives here, as a pure function over already-gathered facts, and the
launcher only performs it" (`packages/code/src/cli-entry.ts`; the allowlist entry is
`tooling/checks/coverage.ts`).

### 4.2 `parseMode` — tokenising and validation order

`packages/code/src/cli-args.ts`, in order:

1. Build `specOf`: canonical flag → spec, plus alias → spec.
2. Scan `argv` left to right; a token not starting with `-` is skipped entirely — this is how
   `--resume 0198c0ff` works and how a bare positional is ignored.
3. A token containing `=` at index > 0 resolves the prefix; if that spec has no `inlineValue`, it is
   `unknown flag: <whole token>`. This is why `--verbose=1` reports the full token
   (`packages/code/tests/unit/cli-args.test.ts`).
4. Otherwise, unknown token → `unknown flag: <tok>`.
5. A `value` flag consumes `argv[i+1]`; a missing token, or one starting with `-`, is
   `` `${tok} requires a ${noun(spec.value)} (usage: clarvis ${spec.flag} ${spec.value})` ``. `noun()` strips `<>` and turns `-` into a space, so `<session-id>`
   reads as `session id` — the string `packages/code/tests/unit/cli-args.test.ts` asserts.
6. `--help` short-circuits, then `--version` — both **before** mode-conflict checking,
   so `--list --help` is `help`, not a conflict.
7. At most one `mode: true` flag; two or more →
   `` `${modes[0]} cannot be combined with ${rest.join(", ")}` ``.
8. `--agent`/`--format` outside `--print` → `<flag> applies only with -p/--print`.
9. `--update` rejects `--ascii`, `--worktree`, both remote flags, `--extension-profile`, or `--debug`; it never constructs a kernel.
10. `--debug=<x>` with an unrecognised `x` → `--debug must be one of error, warn, info, debug, got: x`. A **bare** `--debug` stores `""` and is exempt from that check.
11. Require `--remote` and `--remote-workspace` together, reject remote plus `--worktree`, and fold
    workspace, remote and Extension Profile selection into the shared mode fragments before switching on the mode flag.
    `--print` additionally rejects a whitespace-only prompt
     and a `--format` that is neither `text` nor `md`; `format` defaults to
    `"text"`. No mode flag → `{ kind: "run", ascii, debug }`.

`ascii` is computed **unconditionally**, for every mode, unlike `--agent`/`--format`'s explicit
step-8 rejection outside `--print`. Only the three interactive `Mode` variants (`run`, `resume`,
`continue`) carry an `ascii` field in their returned object; for `--print`, `--list`,
`--delete` and `--refresh-models`, the computed value is simply never attached to the returned `Mode`
and is silently discarded — `--refresh-models --ascii` parses without error and `--ascii` has no effect,
where `--format` in the same position would be a usage error. No test in
`packages/code/tests/unit/cli-args.test.ts` exercises `--ascii` combined with a headless mode flag; see
§8.

`extensionProfileSelector` is retained on run, resume, continue, print, list, delete, and refresh-models.
Tests in `packages/code/tests/unit/cli-args.test.ts` pin the missing-value error, qualified/bare values,
propagation to those modes, and the `--update` incompatibility.

### 4.3 `resolveDebugRequest` — folding flag and environment

`packages/code/src/cli-args.ts`:

| `mode` has `debug`? | `--debug` present | `CLARVIS_CODE_DEBUG` | Result `enabled` | Result `level` |
| --- | --- | --- | --- | --- |
| no (`help`/`version`/`usage-error`) | — | anything | `false` | `"debug"` |
| yes | no | absent | `false` | `"debug"` |
| yes | no | `"1"` | `true` | `"debug"` |
| yes | no | `"info"` | `true` | `"info"` |
| yes | no | `"off"` (or `""`/`"0"`/`"false"`/`"no"`) | `false` | `"debug"` |
| yes | yes (bare) | `"off"` | `true` | `"debug"` |
| yes | `--debug=warn` | `CLARVIS_CODE_DEBUG_LEVEL=error` | `true` | `"warn"` |
| yes | no | `CLARVIS_CODE_DEBUG_LEVEL="shout"` only | `false` | `"debug"` |

Every row above is an assertion in `packages/code/tests/unit/cli-args.test.ts`. Level
precedence is `mode.debug.level ?? debugLevel(CLARVIS_CODE_DEBUG_LEVEL) ?? debugLevel(CLARVIS_CODE_DEBUG) ?? "debug"`
(`packages/code/src/cli-args.ts`, default constant).

The asymmetry between a bad level on the command line (usage error) and a bad level in the environment
(silently ignored) is stated at `packages/code/src/cli-args.ts`: "losing diagnostics to a typo
in a wrapper script is worse than recording more than was asked for — while the same typo on the
command line is a usage error, because a person typed it and is there to read the answer."

### 4.4 `index.tsx` — lightweight dispatch

`main()` in `packages/code/src/index.tsx` parses once. Usage errors, help and version complete without
importing `runtime.tsx`; update imports only its updater. An unhandled failure writes
`clarvis failed: <text>` and sets `process.exitCode = 1`, allowing already-started background cleanup
to drain.

| `mode.kind` | Handler | Runtime graph |
| --- | --- | --- |
| `usage-error` | stderr `<message>\n<usageText()>`, exit 1 | not imported |
| `help` | stdout `helpText()`, exit 0 | not imported |
| `version` | stdout `versionText()`, exit 0 | not imported |
| `update` | dynamic `runUpdateCommand` | updater only |
| `resume` / `continue` | `runInteractive(mode)` calls `prepareInteractiveMode` before creating OpenTUI; only a valid session continues into `StartupComposer` and `runInteractiveMode` | runtime imported for terminal-free preflight |
| `run` | `runInteractive(mode)` paints `StartupComposer`, then dynamically calls `runInteractiveMode` | imported after startup input paint |
| `print` / `refresh-models` / `list` / `delete` | dynamic `runHeadlessMode(mode)` | imported on demand |

Interactive worktree bootstrap, diagnostics and Extension Profile selection are continued by
`runInteractiveMode`; headless equivalents are continued by `runHeadlessMode`. Both retain
`mode.extensionProfileSelector` and `mode.remote`, apply worktree selection before constructing a kernel, and use the final
canonical workspace (`packages/code/src/runtime.tsx`, `runInteractiveMode`, `runHeadlessMode`).

Before ordinary mode parsing, `privateEntry` recognizes only `--remote-kernel`. The thin launcher
dynamically loads `remote-host.ts` from source or its separate bundled entry. That process decodes a
closed base64url envelope, canonicalizes its absolute workspace on the remote machine and composes
the same application FileKernel options as `local-host.ts`. This private entry is the fixed command
started through SSH; it is not a user-facing mode in `FLAGS`.

### 4.5 The headless modes

**`bootSilentSessionStore()`** (`packages/code/src/runtime.tsx`) is the shared prelude for `--list`, the
resume/continue preflight and `--delete`: it creates a `WorkspaceClientManager` over `workspace` +
`globalRoot()`, with `logger: activeDiagnosticLogger() ?? createLogger("silent")`, opens a client and
loads the owner's session store. Its TSDoc records that `runPrintMode` creates its **own manager**
instead because it needs `keySources` and `memory: true`, neither of which a silent listing/delete
command has any use for. All complete kernel paths still acquire their kernel through
`WorkspaceClientManager`, which owns lazy Docker/Podman factory composition
(`packages/code/src/runtime.tsx`, `bootSilentSessionStore`, `runPrintMode`, `runRefreshMode`).

**`runPrintMode`** (`packages/code/src/runtime.tsx`, `runPrintMode`):
1. Builds `ClarvisDirs` from
   `globalPaths()`/`workspacePaths(workspace)`/`workspaceStatePaths(workspace)`.
2. Creates a `CodeConfigStore` inside a `createRoot` to get `keySources()`.
3. Creates and opens `WorkspaceClientManager({ workspaceRoot, globalDir, keySources, memory: true,
   extensionProfileSelector, logger, openMcpAuthorizationUrl: openPublicUrl })`.
   `--print` is headless only in its output
   and elicitation policy: a remote MCP OAuth challenge may still open the system browser, but the
   current run degrades that server and never waits for the human callback.
4. If `--agent` was not given, resolves one: `kernel.config.listAgents()` + `loadAgentFiles` + settings +
   `readEnvView()`, filters to runnable candidates via `agentReadiness`, prefers `code.agentDefault()`
   when it is present and runnable, else `automaticAgentFallback`. Failure writes
   `no interactive entry agent configured — pass --agent or set a default` and exits 1.
5. Starts the run with a fresh `exec_` id and the prompt as a single user message.
6. Registers an elicit handler that **auto-declines** every request, writing
   `<kind> auto-denied (headless): <first line>` to stderr.
7. Chooses a sink: `format: "md"` builds a `TranscriptStore`, seeds it with the user message, and
   prints `renderTranscriptMarkdown(store.nodes)` at the end; otherwise
   `createPrintStream` streams to stdout and appends a trailing newline only if anything printed.
8. `drainPrintEvents(handle.events, { onEvent, onNotice })`.
9. `await handle.done` → `await transcriptDone` → `finish()` → dispose store → `await drained` →
   release the opened client → close the manager.
10. Non-`completed` status: stderr `run ${status}: ${reason}` and exit 1; else exit 0.
11. Any throw: `print failed: <text>`, close the kernel swallowing errors, exit 1.

**`createPrintStream`** (`packages/code/src/cli-mode.ts`) filters to `agent === "lead"` and `channel === "text"`, inserts a blank-line separator between iterations, honours an in-iteration
`reset` by writing one newline, and — on `iteration_completed` — prints the whole response
only when that iteration streamed nothing, because "streaming may be unavailable on some
providers".

**`drainPrintEvents`** (`packages/code/src/cli-mode.ts`) returns two promises. `transcriptDone` is
`Promise.race([runEnded, drained])`, so the answer prints at `run_ended` rather than at
stream exhaustion; `drained` stays alive until the stream closes, which the TSDoc says is what "lets
the index pass finish, with its notices narrating the wait via `onNotice`". A
`memory_ingest` event is routed to `onNotice` and never to `onEvent`. A stream failure is
swallowed with the stated reason "A failed stream still settles the run's `done` with a
terminal result."

**`runListMode`**, **`runDeleteMode`** and **`runRefreshMode`** in
`packages/code/src/runtime.tsx` each boot, act, close and `process.exit` — none of them return.

### 4.6 `runApp` — the interactive boot sequence

`packages/code/src/runtime.tsx` (`runApp`), in order:

| # | Step | Production |
| --- | --- | --- |
| 1 | the thin entry validates TTY/SSH/ASCII policy; resume/continue resolve worktree identity and session existence before any renderer call; a valid invocation then creates OpenTUI, immediately installs bootstrap teardown ownership, and mounts a focused `StartupComposer` | `runInteractive` in `packages/code/src/index.tsx`; `prepareInteractiveMode` in `packages/code/src/runtime.tsx`; `installBootRendererLifecycle` in `packages/code/src/adapters/renderer-bootstrap.ts`; `packages/code/src/views/StartupComposer.tsx` |
| 2 | after renderer idle, capture `shellElapsedMs`; start the runtime import and, for ordinary `run`, the workspace foundation in parallel | `runInteractive`; `prepareStartupFoundation` in `packages/code/src/startup-foundation.ts` |
| 3 | the runtime opens diagnostics, records `app.boot.begin` plus the captured `app.boot.shell-painted`, then creates the complete platform and transfers Ctrl+C ownership while retaining exit/key teardown through full-app mount | `BootShell.handoffRendererLifecycle`; `runApp` in `packages/code/src/runtime.tsx` |
| 4 | use the prepared `WorkspaceClientManager` or create one; establish immutable workspace identity and construct stores/config/history/capabilities | `runApp`; `WorkspaceClientManager.create` |
| 5 | load the foundation without reading models.dev, then list Agent Profiles, resolve the branch and bind the run host | `runApp`, `loadFoundation` |
| 6 | take the startup snapshot exactly once; an Enter submission starts immediately through `runHost.submitTurn` before full-app mount only when the active Agent Profile is runnable | `StartupComposerState.take`; `resolveStartupComposerHandoff`; `startup_submit` in `runApp` |
| 7 | replace the startup root with `<App>`; an unsent draft or a submission that had no runnable Agent Profile becomes exact `initialDraft`; release bootstrap key/exit ownership only after mount; emit mounted/painted diagnostics | `BootShell.mount`; `AppProps.initialDraft`; `releaseBootRendererLifecycle` |
| 8 | after `app.boot.painted`, release Markdown warm-up and the optional managed-install release check; resume/continue restore saved content after parser warm-up | `runApp` |

`StartupComposer` is not a decorative progress placeholder. In `run` mode it owns a real focused
OpenTUI input, records content outside Solid/renderable ownership, and accepts Enter once. Its
`Queue a task…` marker is distinct from the complete app's `◆ Clarvis` and `New task…` markers.
Workspace-plugin trust resolution does not enter this bootstrap root. Repository plugins remain
inactive while the kernel resolves their bounded inventory; after `<App>` mounts, its internal
command wiring opens the workspace approval modal automatically for `unapproved` or `changed`.
Its centre uses the shared `BrandBanner`: the complete eight-row splash appears when 60×16 fits and
the standard compact wordmark appears below either threshold. The startup-only connection status
does not invent the not-yet-resolved agent/model line or advertise complete-app shortcuts. Its
header already anchors the root-owned `v<version>` at the right edge, so the product identity does
not move when the complete application replaces it.
Replacing the root cannot lose an unsent draft or an accepted task: the latter either starts on a
runnable Agent Profile or returns as exact composer text. Resume/continue render the same
bounded frame with input disabled. Production: `createStartupComposerState` and `StartupComposer` in
`packages/code/src/views/StartupComposer.tsx`, `BootShell` in `packages/code/src/boot-shell.ts`, and
the handoff in `packages/code/src/index.tsx` and `packages/code/src/runtime.tsx`. Test:
`packages/code/tests/integration/splash-render.test.tsx`,
`packages/code/tests/integration/app-shell-render.test.tsx`, and
`packages/code/tests/architecture/architecture-boundary.test.ts` (submission before app mount and
bootstrap teardown ownership through mount), plus
`packages/code/tests/unit/renderer-bootstrap-lifecycle.test.ts`.

The manager created at step 6 receives `extensionProfileSelector`, and its reconnect path retains that
launch override. While one is active, persisted Extension Profile selection mutations return a conflict
because they could not change the process-selected Extension Profile.

Two orderings the code annotates explicitly:

- The exit handler for diagnostics is registered twice inside the runtime. Its comment states why:
  "Cover failures before the renderer/platform exists. Once the
  platform installs its own exit restoration below, move this handler behind it so renderer teardown
  remains visible before diagnostics.stop."
- Markdown warm-up begins immediately after the usable application shell paints, so worker startup
  cannot compete with that frame. Restored session content is not published until warm-up settles.
  Production: `packages/code/src/runtime.tsx` (`preloadMarkdown`, `markdownPreload`, `appProps`,
  `app.boot.painted`). Test:
  `packages/code/tooling/artifact/smoke.ts`.
- Durable memory recovery belongs to the independent host. It begins after authenticated discovery
  publication and survives TUI disconnect; another paint or connection recovery does not restart it.
  Production: `serveLocalFileKernel` in `packages/kernel/src/hosting/serve-local.ts`.
  Test: `packages/code/tests/architecture/architecture-boundary.test.ts` checks that the UI and manager
  do not own its release; process lifecycle is exercised in
  `packages/kernel/tests/integration/local-host-process.test.ts`.
- The automatic version check is another after-paint task, but only for a managed portable
  installation whose global Code preference remains enabled. It dynamically imports the read-only
  checker, uses a 24-hour disposable cache, and is aborted by platform shutdown; its failure never
  blocks or paints an error. Production: `packages/code/src/runtime.tsx` (`AppShell.afterPaint`,
  `update_check`) and `packages/code/src/update/check.ts`. Test:
  `packages/code/tests/architecture/architecture-boundary.test.ts` (post-paint gate),
  `packages/code/tests/unit/update-check.test.ts`, and
  `packages/code/tests/integration/app-shell-render.test.tsx`.
- Application command composition performs no sandbox host inspection. The null probe is a passing
  deferred readiness state; Doctor recheck and Settings > Sandbox are the explicit inspection
  routes. Production: `packages/code/src/app/commands.tsx` (`refreshSandboxInspection`,
  `inspectReadiness`). Test: `packages/code/tests/integration/app-commands.test.tsx` ("sandbox
  inspection is deferred until an explicit Doctor recheck").

`debugSession` is built even when `--debug` was absent, with the stated reason: "a diagnostic channel
you can only ask for before the failure you want it for is no channel"
(`packages/code/src/runtime.tsx`, `runApp`).

Both code-host kernel paths supply the same browser opener through `WorkspaceClientManager.create`
(`packages/code/src/runtime.tsx`, `runPrintMode`, `runApp`; `packages/code/src/startup-foundation.ts`,
`prepareStartupFoundation`). `openPublicUrl` accepts only HTTP(S), uses an
argv-based platform launcher, and returns `false` on parse, protocol, spawn or exit failure
(`packages/code/src/adapters/open-public-url.ts`, `openPublicUrl`). That boolean lets the MCP client
report an explicit interactive-authorization-unavailable error. Opening succeeds or fails in the
background; it never holds a run waiting for the callback. Other Clarvis hosts do not gain a browser
side effect merely because the file kernel supports the port; omission is the headless contract.

**Step 5's `activate()` indirection.** `createWorkspaceAdapters`
(`packages/code/src/runtime.tsx`, `createWorkspaceAdapters`) builds a
`WorkspaceAdaptersSnapshot` whose `appearanceActive` signal starts `false`, and two
`createEffect`s — one setting the renderer's background color, one calling `applyAsciiMode` — both
return immediately when `appearanceActive()` is false. The same object exposes an
`activate()` closure that, in a `batch`, flips `appearanceActive` to `true` and bumps a companion
`appearanceRevision` signal the two effects also read. `createWorkspaceAdapters` itself
never calls `activate()`; only `publishWorkspaceAdapters` does, as its last step. So
building the snapshot alone wires no background-color or ascii-mode effect — the effects exist but are
inert until the object is published. Unpinned: no test in `packages/code/tests/` references
`appearanceActive`, `appearanceRevision` or `.activate()`.

### 4.7 `loadFoundation` and the `BootPhase` ledger

`BootPhase` is `"connect" | "keys" | "agents" | "settings" | "agent-files" | "sessions" | "profiles"`
(`packages/code/src/runtime.tsx`, `BootPhase`). It is a mutable cursor set immediately before each step so the
`catch` can name the step that threw:

| Source | Span | Work |
| --- | --- | --- |
| `packages/code/src/runtime.tsx` | `boot.kernel-connect` | `client.connect()` |
| `packages/code/src/runtime.tsx` | `boot.keys` | `createKeysAdapter(client.secrets)` |
| `packages/code/src/runtime.tsx` | `boot.list-agents` | `client.config.listAgents()` |
| `packages/code/src/runtime.tsx` | `boot.settings` | `createSettingsAdapter(...)` |
| `packages/code/src/runtime.tsx` | `boot.agent-files` | `loadAgentFilesSnapshot(...)` |
| `packages/code/src/runtime.tsx` | (none) | `createSessionStore(... await loadSessions...)` |
| `packages/code/src/runtime.tsx` | `boot.profiles` | `runClient.listProfiles(bootAgentSummaries)` |

`reportBootFailure` emits `boot.failed` with `{ phase, error, attempt }` and is extracted
from the `catch` for a coverage reason stated inline: "Extracted from the `catch` so Bun counts it as
its own unit; [cross-cutting/test-architecture.md](../cross-cutting/test-architecture.md) §3.7 records that a `catch` body's line counter is otherwise
satisfied by the enclosing `try`".

One agent listing serves the whole boot records that "The settings adapter, the agent-file
snapshot and the Agent Profile catalogue each used to fetch their own, so a cold start read the fleet from
disk three times over."

The models catalogue is temporally lazy, not merely unawaited. `loadFoundation` never calls
`client.models.get()`. The single-flight `ensureModelsCatalog` starts the request only when Model,
Effort or Providers crosses its lazy route boundary, records `catalog.load.started`, and publishes
the projected catalog signal. Until then `liveCatalog` degrades every accessor to an
empty/`undefined` answer. Provider routes load their module and await the single-flight request
concurrently before mounting `ProvidersPanel`: its bootstrap `onMount` opens the picker immediately,
so mounting first would permanently choose the reduced no-catalog branch for that picker instance.
Production: `packages/code/src/runtime.tsx` (`loadFoundation`, `ensureModelsCatalog`, `liveCatalog`),
`packages/code/src/features/providers/commands.ts` (`registerProvidersCommands`), and
`packages/code/src/app/commands.tsx` (`setup.providers`). Test:
`packages/code/tests/integration/app-commands.test.tsx` ("the public model catalog is requested only
after a catalog-backed route opens" and "first-run setup waits for the lazy model catalog before
mounting its provider picker") and `packages/code/tooling/artifact/smoke.ts`.

### 4.8 `runFatalBoot` — the boot-failure screen

`packages/code/src/views/FatalBoot.tsx` (`runFatalBoot`). It mounts on the **bare** renderer via
`engine.attach` + `_render` with a manual `RendererContext.Provider`, because it is
"Rendered before the keymap/theme exist — the token signals carry usable defaults, and keys are bound
straight off the renderer".

| State | Key | Effect | Production symbol |
| --- | --- | --- | --- |
| idle | `r` | `setBusy(true)`, call `retry()` | `runFatalBoot` (`onKey`) |
| idle | `ctrl+c` | call `quit()` (expected to exit); `q`, Escape and all other keys are ignored | `runFatalBoot` (`onKey`) |
| idle | anything else | ignored | `runFatalBoot` (`onKey`) |
| busy | `ctrl+c` | prevent propagation and remain on the retry screen | `runFatalBoot` (`onKey`) |
| busy | anything else | ignored | `runFatalBoot` (`onKey`) |
| retry resolved | — | `close(true)`: unhook keypress + destroy listener, hide, dispose the Solid root, resolve | `runFatalBoot` (`close`, `onKey`) |
| retry rejected | — | `setMessage(errorText(e))`, `setBusy(false)` — the screen stays up for another attempt | `runFatalBoot` (`onKey`) |
| renderer destroyed | — | `close(false)` — resolve `false` without clearing so the surrounding boot returns instead of continuing during shutdown | `runFatalBoot` (`onDestroy`), `runtime.tsx` (`recovered`) |

`runtime.tsx`'s `retry` closure disposes the failed run client first, then re-runs `bootFoundation()`,
re-reporting any failure before rethrowing so the screen sees it (`packages/code/src/runtime.tsx`,
`bootFoundation`); `quit` releases the temporary boot renderer lifecycle and delegates to the
platform's `boot-failed` shutdown path, which restores the renderer once and exits 1
(`packages/code/src/runtime.tsx`, `packages/code/src/adapters/platform.ts`).
Its key listener is prepended ahead of the temporary bootstrap Ctrl+C owner. It prevents propagation
for Ctrl+C in both states: idle calls the fatal `quit`, while busy keeps the documented inert retry
state instead of falling through to platform shutdown. Test:
`packages/code/tests/integration/fatal-boot-render.test.tsx` (`fatal boot owns Ctrl+C ahead of
bootstrap teardown and ignores it during retry`).

`packages/code/tests/integration/fatal-boot-render.test.tsx` ("fatal boot: disposes its root on
success so the App mounts alone") additionally pins that the root is disposed on success — after
`settled`, a freshly rendered `<text>APP_MOUNTED</text>` is the only thing on screen and the
renderer's `destroy` listener count is back to `rootsBefore + 1`.

### 4.9 Launch-time worktree selection

`--worktree [name]` is resolved before diagnostics, a kernel or a session store is created. In an
interactive invocation the lightweight startup composer may already be painted, but its input is
locked for resume/continue and no workspace foundation starts against the original checkout
(`packages/code/src/runtime.tsx`, `runInteractiveMode`, `runHeadlessMode`). `bootstrapWorktree` then
pins the process to the returned
canonical checkout by replacing `workspace` and setting `CLARVIS_WORKSPACE_ROOT`; there is no
in-process worktree switch or worktree-management hub.

`bootstrapWorktree` (`packages/code/src/bootstrap/worktree.ts`) resolves the starting Git
top-level and common directory with repository-local Git environment variables removed, derives a
stable `prj_<sha256(common-dir)>` project id, validates or generates the worktree name, and resolves
the primary checkout from Git's first `worktree list` record. New checkouts live at
`<primary-worktree>/.clarvis/worktrees/<name>`, keeping one stable anchor even when Code starts from
a linked checkout. Before `git worktree add`, bootstrap makes the primary `.clarvis/.gitignore`
contain `worktrees/` and verifies the intended destination with `git check-ignore`; an absent,
unreadable, or semantically negated exclusion fails startup. Git's NUL-delimited
`worktree list --porcelain -z` is the only registry. A registered destination or registered
`clarvis/<name>` branch checkout is reopened without requiring nested-path setup or a writable
primary checkout; an unregistered existing destination is refused.
For a new checkout Clarvis reuses `clarvis/<name>` when that branch exists, otherwise it best-effort
fetches `origin`, chooses `origin/HEAD` or `HEAD`, and creates the branch with `git worktree add -b`.
It writes no lease, journal, or parallel registry.

For an interactive launch selected with `--worktree`, the final user-quit path checks
`git status --porcelain=v1 --untracked-files=all --ignore-submodules=none`. A clean checkout opens
the `WorktreeExitPrompt`: `y` requests checkout removal and exits, `n` keeps it and exits, and
Escape cancels exit. Dirty worktrees exit without the removal offer. Requested removal closes the
workspace client, adapters and kernel, checks cleanliness again, changes cwd to the primary
checkout, and calls `git worktree remove` without `--force` before `platform.shutdown` starts its
two-second hook budget. The branch is always kept. Only a checkout at the canonical managed location
may remove the now-empty `.clarvis/worktrees/` parent; an external checkout's parent is untouched.
Signals and panic shutdown never request removal.

The Git runner is argv-only with `shell: false`, disables prompts, removes repository-local Git
environment, caps combined output at 1 MiB and kills the child after 15 seconds
(`packages/code/src/bootstrap/worktree.ts`). Production behavior is pinned by
`packages/code/tests/integration/worktree-bootstrap.test.ts` (create, reopen, inherited Git
environment isolation, primary anchoring, ignore protection, clean removal, dirty refusal,
generated name, path collision and invalid name) and parsing is
pinned by `packages/code/tests/unit/cli-args.test.ts`.

**Callback identity remains local, not a switching API.** `createWorkspaceCallbackTarget` is a
one-slot box and `isActiveWorkspaceCallbackTarget` accepts only the same still-bound object
(`packages/code/src/app/workspace-runtime.ts`). The run host binds it once and shutdown clears it
(`packages/code/src/runtime.tsx`, `publishWorkspaceAdapters`), preventing a late callback after
teardown.

### 4.10 Layout breakpoints

`layoutModeFromDims` (`packages/code/src/app/layout.ts`):

| Condition | `LayoutMode` |
| --- | --- |
| `w < 24 \|\| h < 6` | `floor` |
| `w < 72` | `single` |
| `w < 100` | `narrow` |
| otherwise | `wide` |

`secondaryMode` (`packages/code/src/app/layout.ts`, `createLayoutController`):

| explicit `drawerOpen` intent | `w >= 100` | result |
| --- | --- | --- |
| false | — | `closed` |
| true | true | `split` |
| true | false | `drawer` |

`sidebarVisible` is exactly `secondaryMode() === "split"`; `contentInset` is `sidebarWidth()`
when visible, else `0`. `sidebarWidth` is `clamp(round(w * 0.32), 32, 56)` then clamped again
to the viewport, so a 24-column terminal yields `24` — pinned at
`packages/code/tests/unit/layout.test.ts`. In split mode, `TranscriptRegion.splitOpen()` also
opts transcript blocks and inline elicitation cards into the full width of the remaining left pane;
the pane's flex boundary, not a second arithmetic inset, stops them at the sidebar
(`packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion`). The 200-column shell regression
pins content beyond the old 110-column cap and no transcript text past the sidebar at
`packages/code/tests/integration/app-shell-render.test.tsx`.

There is no stored sidebar preference and no global toggle. `App` owns three independent automatic
reveal intents: the first live Plan reveals Plan, the first workflow state/leader reveals Parallel work,
and the first typed delegation reveals Agents once for that execution context. Each intent preserves
the Lead transcript selection and never opens `ActivityDetail`. Escape or scrim close dismisses the
intent that opened the surface, so later updates of that kind cannot reopen it; the first event for a
different section may still reveal and orient the Sidebar. A new execution context resets the
corresponding intent. The controller presents either automatic or pointer intent as a split at 100
columns or wider and as a drawer below the threshold. Production:
`packages/code/src/app/layout.ts` (`createLayoutController`) and
`packages/code/src/views/App.tsx` (`requestAutomaticSidebar`, `visiblePlanContext`,
`visibleSubagentContext`, `closeActivitySidebar`,
`compactActivityStrip`, `Footer.onRunStripMouseDown`, `dismissTopOverlay`). Tests:
`packages/code/tests/unit/layout.test.ts` (responsive explicit-intent mechanics) and
`packages/code/tests/integration/app-shell-render.test.tsx` ("Plan, Parallel work, and Agents own
independent once-per-run sidebar reveals", "the first workflow leader opens and reveals Parallel
work", the narrow-drawer Escape case and isolated child selection).

### 4.11 The floor screen

Two independent mechanisms, both in `App.tsx`:

1. `refuseAtFloor()` returns true at `layoutMode() === "floor"` and is checked before opening
   Activity Detail or a managed-worktree exit prompt. Its TSDoc states the reason: "An overlay
   opened underneath it painted a shredded card *over* that message — destroying the one instruction
   that could get the user out — so the request is refused here rather than at each opener".
2. The floor panel itself is rendered last, absolutely positioned, at `zIndex={FLOAT_Z + 2}`
   (`packages/code/src/views/App.tsx`), showing `terminal too small` and
   `needs ${FLOOR_MIN_COLUMNS}x${FLOOR_MIN_ROWS}, have ${w}x${h}` — i.e. `needs 24x6, have …`. The
    inline comment says this second half stops "one already open from covering the message".

`packages/code/tests/integration/app-shell-render.test.tsx` mounts at 20×8 and asserts
`needs 24x6` while the ordinary composer controls remain absent.

### 4.12 `App`'s own composition order

`App` (`packages/code/src/views/App.tsx`) builds, in order: syntax-style binding, hint state, memory
pressure controller, terminal dims + layout controller, transcript state, overlay host, quit confirm, the `InteractionEffects` object, `createInteraction`, `createCommands`, and finally
`registerCodeCommands(...)` whose `dispose` is registered on cleanup together with the
overlay host, commands and interaction.

**Quit confirm** (`createQuitConfirm`, `packages/code/src/views/quit-confirm.ts`) is App's own
"press again to quit" gate, and `App` wires it with `isDirtyView: () =>
overlays.viewDirty()`, `isRunAtRisk` (an active run without confirmed host continuation), `isDraftNonEmpty: () =>
(inputEl?.plainText ?? "").trim().length > 0`, `notify` and a `requestFinalQuit` indirection; its
`.quit` is what `InteractionEffects.quit` calls, and its `.disarm` is called during teardown. The
gate's own contract type is `QuitConfirm = { quit(opts: { confirm: boolean }): void; disarm(): void
}` over `QuitConfirmDeps` (`packages/code/src/views/quit-confirm.ts`).

`createQuitConfirm`'s own TSDoc states the two calling conventions: `confirm: true` "always arms the
gate — the first call only notifies and starts a [1500ms] window, and quitting happens on a second
call inside that window"; `confirm: false` "is for a caller that has already spent a keystroke on the
decision (the double-tap `^C` path, and `/quit`, where typing the command is itself explicit): it
quits immediately from a state where nothing is at stake.". But the gate does not simply
trust that flag: a dirty view or a run that will be cancelled on exit still requires confirmation.
Mechanically, `atStake = dirtyView || deps.isRunAtRisk()` and the gate arms whenever `confirm || atStake`.
An observed hosted run with confirmed `continue` policy is not at risk merely because it is active;
the activity line displays `continues after exit`. This projection does not change host policy or
tool consent, and a later turn defaults to ordinary exit policy.
A non-empty draft is deliberately excluded from that arming set: "Running `/quit` from the composer
leaves the command itself sitting in the draft, so counting it would make the slash command arm
against its own text." — `isDraftNonEmpty` is consulted only to pick the *wording* of an
already-armed prompt (`" (unsaved changes)"` > `" (run active)"` > `" (draft unsaved)"` > none), never to decide whether to arm. `disarm()` clears `pending` and cancels the pending
`setTimeout`; the window itself resets `pending` and clears the toast via
`deps.notify("")` when it elapses unconfirmed.
`packages/code/tests/unit/quit-confirm.test.ts` pins the double-tap arm/confirm cycle through its
named draft-only, run-active wording, and `/quit`-mid-run cases;
`packages/code/tests/integration/interaction.test.ts` cross-references
the double-tap `^C` path this gate was written for.
Production: `createQuitConfirm` in [quit-confirm.ts](../../packages/code/src/views/quit-confirm.ts)
and its composition in [App.tsx](../../packages/code/src/views/App.tsx). Test:
[app-shell-render.test.tsx](../../packages/code/tests/integration/app-shell-render.test.tsx)
exercises the actual slash-input path under both hosted disconnect policies.

`requestFinalQuit` delegates directly to `props.shell.quit` for a normal checkout and performs the
asynchronous clean-worktree check for a managed checkout. A clean result mounts
`WorktreeExitPrompt`; keep continues shutdown immediately, remove awaits workspace close plus Git
cleanup before starting shutdown, and Escape returns to the app. This second prompt does not weaken
the dirty-view/live-run gate: it runs only after that gate accepts the quit request.

`registerCodeCommands` (`packages/code/src/app/command-composition.ts`) opens **one** feature scope, registers the
providers and agents feature commands into it, then calls `registerAppCommands(deps)`, and returns the app wiring with a `dispose` that is idempotent and disposes the app
registration before the feature scope. `registerAppCommands` itself opens its own scope and
shadows the four registration methods so everything it registers lands there (`packages/code/src/app/commands.tsx`).

The render tree returned by `App` is, top to bottom: `KeymapProvider` →
`HeaderRows` → a one-row top rule → the region box holding `OverlayRegion` with `TranscriptRegion` as
its fallback → the floating pickers/readers (`AgentProfilePicker`, lazy `IsolationPicker`, lazy
`ReviewPicker`, `ActivityDetail`, `WorktreeExitPrompt`) as
**siblings
after** the region → `HintToast` → the bottom box (`LeadActivityLine`, `InputDock`, `Footer`) → the
floor panel. `MemoryPressureBanner`, elicitation and the fixed reading runway remain final children
of the history ScrollBox through `LiveTranscriptTail`; no Plan pane is mounted below the transcript.

The two-route overlay rule is stated at `packages/code/src/views/App.tsx`: a kind that owns the whole
region (`view`, `diff`, `plan`) is rendered by `OverlayRegion` as a cover over one still-mounted,
paused transcript fallback; a picker is a floating card mounted as a sibling after the region "so
the transcript keeps rendering behind it — moving it into the region's switch would black out
everything the scrim exists to show through."

**`OverlayRegion` itself** (`packages/code/src/views/app/OverlayRegion.tsx`, `OverlayRegion`) keeps
the fallback shell and its Yoga geometry mounted but hidden for every full-region configuration,
Workflow, Diff and Plan surface. `overlayFallbackActive` pauses its physical-history observation and
removes hidden input, hit and elicitation ownership without discarding the Lead projection, its one
bounded child projection or either projection's scroll state. Configuration frames remain bounded
by their mounted stack and dispose when popped; Diff and Plan have their own lazy retained
boundaries. `PlanOverlay` is wired only to `props.activity.plan`, the optional
`Pick<PlansService, "read">`, the active accessor and an `onClose` that calls
`props.host.dismissTop()`. Its own TSDoc names the omission: "A picker kind such as `agentPicker` is
deliberately not here… so it reaches this switch as the fallback rather than as a full-region
branch. Anything else unrecognized falls back the same way, which keeps an unknown kind from
blanking the screen." `ActivityDetail` follows this floating route through App's `activityDetail`
transient overlay kind: opening a bounded activity preview stores the full content, blocks transcript
input behind the scrim. Escape restores it; Ctrl+C remains the global cancel-or-quit route. Production: `openActivityDetail` and the
`activityDetail` render branch in `packages/code/src/views/App.tsx`; pinned by
`packages/code/tests/integration/app-shell-render.test.tsx` and
`activity-detail-render.test.tsx`. `OverlayRegionProps.plans` is
`Pick<PlansService, "read"> | undefined`: the TUI can read the current plan document but has no
protocol surface for history listing, per-plan retention mutation or deletion. Pinned by
`packages/code/tests/integration/overlay-region-render.test.tsx` (live-plan and no-history-read cases).

Each `"view"` frame is painted through the module-level `renderMountedView`, which wraps
`frame.factory(frame.host)` in Solid's `untrack` and records `diagnosticCount("overlay.view.factory",
undefined, "overlay.view.factory")` first. Its own comment states why the reactive read must be
suppressed: "A view factory creates its own reactive owner and effects. Do not let the surrounding
`<For>` mapper subscribe to signals the factory reads during construction, or any async state update
will execute the factory again, remounting the page and restarting its I/O in an unbounded feedback
loop.". `packages/code/tests/integration/overlay-region-render.test.tsx` exercises all three
`Match` arms plus the `"view"`-with-zero-views fallback case, and pins the single-mount guarantee
`renderMountedView` protects through the named test `an empty WorkflowsHub inside OverlayRegion
performs one mount and one initial list`.

### 4.13 `PageFrame` and `Splash`

`PageFrame` (`packages/code/src/views/PageFrame.tsx`) is three boxes: a `height={1}` title row that is opaque and
`zIndex={1}`, a `flexGrow` content region with `overflow="hidden"`, and an
`InteractionNavigationBar` footer that is also opaque and `zIndex={1}`. The clip is
load-bearing: `packages/code/tests/integration/page-frame-clip.test.tsx` reproduces the two-box shape at 80×5
with an unwrapped `<Splash>` child and shows that `overflow="visible"` lets the absolutely-positioned,
vertically-centred wordmark paint into the title row while `"hidden"` does not. Its three consumers
are `DiffViewer` (`packages/code/src/views/overlays/DiffViewer.tsx`, `DiffViewer`), `PlanOverlay`
(`packages/code/src/views/overlays/PlanOverlay.tsx`, `PlanOverlay`)
and `Help` (`packages/code/src/views/overlays/Help.tsx`).

`Splash` (`packages/code/src/views/Splash.tsx`, `Splash`) is absolutely positioned with
`right = rightInset?.() ?? 0` so a visible sidebar does not get painted under, and `BrandBanner`
shows the gradient `BANNER` at ≥60 columns or `glyph("diamond") + SPLASH_WORDMARK` below. It is mounted by `TranscriptRegion`
only when the transcript is empty, no elicitation is pending and the draft is empty
(`packages/code/src/views/app/TranscriptRegion.tsx`, `TranscriptRegion`'s Splash condition), and
`TranscriptRegion`'s root box clips for the same reason `PageFrame`'s does (`TranscriptRegion`).

`StartupComposer` reuses `BrandBanner` inside its bounded centre rather than copying the banner. It
forces the compact branch below 16 rows because its fixed header, connection status and focused input
consume the remaining space; the ordinary 60-column width fallback still applies. Production:
`packages/code/src/views/StartupComposer.tsx` (`STARTUP_SPLASH_MIN_ROWS`, `StartupComposer`) and
`packages/code/src/views/Splash.tsx` (`BrandBanner`). Test:
`packages/code/tests/integration/splash-render.test.tsx` (`the startup composer shares the responsive
Clarvis splash on first paint`).

The guided setup and its catalog pickers deliberately do not use that compact fallback. `SetupView`
and bootstrap `CatalogPicker` both gate `BrandBanner` through `firstRunSplashFits`, so the same complete
eight-row splash remains present throughout the first-run journey or is absent throughout when the
terminal cannot fit it. Production: `packages/code/src/views/onboarding/SetupView.tsx` (`SetupView`),
`packages/code/src/views/config/CatalogPicker.tsx` (`CatalogPicker`), and
`packages/code/src/views/Splash.tsx` (`firstRunSplashFits`). Tests:
`packages/code/tests/integration/onboarding-render.test.tsx`,
`packages/code/tests/integration/catalog-picker-render.test.tsx`, and
`packages/code/tests/integration/providers-key-render.test.tsx` (both bootstrap picker steps).
One Escape from either bootstrap provider or model picker closes that picker back to setup without
saving the staged controller choice. Production:
`packages/code/src/views/config/providers/list-level.tsx` (`closePicker`) and
`packages/code/src/views/config/ProvidersPanel.tsx` (first-model `onClose`). Test:
`packages/code/tests/integration/providers-key-render.test.tsx` (first-run Escape for both pickers).

`HeaderRows` (`packages/code/src/views/HeaderRows.tsx`, `HeaderRows`) renders exactly one
`height={1}` row: brand wordmark, workspace chip, optional identity chip, an `Index` over status
chips, a `flexGrow` spacer, optional exception and urgent chips, then the non-shrinking product
version after one gutter column. It is a pure projection of `HeaderPlan`, computed by
`projectHeader` (`packages/code/src/views/header-projection.ts`, `projectHeader`).

#### 4.13.1 `projectHeader`: priority-zoned chips and their elision ladder

App's `effectiveRunIsolation` projection uses host-reported native placement during an active run,
including an explicitly approved native configuration turn, and keeps configured next-run preferences
when the native host is idle. A latched sandbox fallback and container status retain their existing
projection. Production: `effectiveRunIsolation` in
[execution-safety.ts](../../packages/code/src/adapters/execution-safety.ts), used by `App`.
Test: `shows active native configuration without replacing the idle next-run preference` in
[execution-safety.test.ts](../../packages/code/tests/unit/execution-safety.test.ts).

`HeaderInput` (`packages/code/src/views/header-projection.ts`, `HeaderInput`) is the one shell snapshot the row is derived
from — `width`, `version`, `floor`, `agentName`, `model`, `isolation`, `review`, `sandboxUnavailable?`,
`memoryConfigured`, `memory`, `plans`, `connection`, `doctorDirty`, `workspace`, `workspaceLabel?`,
`branch?` — and its own TSDoc assigns App the sole derivation point for every header status.
`HeaderFieldKey` is the closed union of workspace, identity, model, isolation, review, memory,
urgent, exception and `version`; a
`HeaderField` is `{ key, text, color, elastic }`; `HeaderPlan` makes its `version` field mandatory
beside the existing left/status/host-state zones (same module, named types).

The projection's TSDoc states its three-zone layout directly: identity and next-run configuration
form one separator-joined group on the left, actionable host state follows the flexible gap, and the
root-owned product version anchors the final zone. The first field after the gap carries no
separator of its own because a `·` stranded after whitespace separates nothing
(`packages/code/src/views/header-projection.ts`, `projectHeader`).

**Reserved columns.** `BRAND_COLS = 10` is the painted left padding plus `◆ Clarvis`;
`WORKSPACE_FLOOR = 14` keeps the workspace from disappearing; `IDENTITY_FLOOR = 10` is skipped in
`floor` mode; and `VERSION_GUTTER = 1` plus `Bun.stringWidth(version.text)` is always held back for
the final `v<version>` field. `cols()` measures with `Bun.stringWidth`, while `separator()` is two
spaces, `glyph("separator")`, two spaces (`packages/code/src/views/header-projection.ts`, named
constants, `cols` and `separator`).

**Left-of-gap zones — computed unconditionally.** `workspace` in `projectHeader` resolves to
`input.workspaceLabel ?? basename(input.workspace) || input.workspace || "workspace"`, appending
`" (branch)"` when `input.branch` is set, and is always `elastic: true` and coloured `tokens.fg`.
`identity` is `input.agentName` in `tokens.muted`, `elastic: true`, and is entirely omitted when
`input.floor` is set (`packages/code/src/views/header-projection.ts`, `projectHeader`).

**Right-of-gap zones — computed first, because they bound the room left for status chips.** The
version field is always `v${input.version}` in `tokens.muted`, never elastic. `urgentField` fires
whenever `input.connection.phase !== "ready"`: a warning glyph plus
`connectionLabel(input.connection, input.width < 72)` in `tokens.warn`, never elastic. `exceptionField`
is a strict priority chain evaluated only when `exceptionAllowed` (`input.width >= 100`):
`sandboxUnavailable` ("Sandbox unavailable") outranks Host isolation ("Isolation: Host"), which is
itself only checked when the caller passes `includeIsolation: true`, which outranks `doctorDirty`
("Doctor needs attention") — all three render in `tokens.warn`. Both are computed before `room` so
their reserved width is subtracted first; the wider-of-two-renderings probe exists because whether
`exception` will end up absorbing the Host-isolation warning is not known until after `statusChips`
has run (`packages/code/src/views/header-projection.ts`, `urgentField`, `exceptionField`,
`projectHeader`).

**`statusChips` — the elision ladder.** `modelNames` reduces `input.model`
through `parseModelRef` to its `modelId`, then to the substring after the last `/` as the `short` form.
`memoryLabel` maps `memory === "off"` to `"off"` and anything else — including `"inert"` —
to `"on"`, because ("Memory as the rest of the product states it — `inert` is still configured, so it
reads `on`"). Five candidate chip sets are tried widest-first, and the first whose summed width
(chip text plus one separator each) fits `room` wins (`packages/code/src/views/header-projection.ts`,
`statusChips`, `modelNames`, `memoryLabel`):

| Rung | Chips |
| --- | --- |
| 1 | `model.full`, `Isolation: {isolation}`, `Review: {review}`, `Memory: {memory}` |
| 2 | `model.short`, `Isolation: {isolation}`, `Review: {review}`, `Memory: {memory}` |
| 3 | `model.short`, `Iso {isolation}`, `{review}`, `mem {memory}` |
| 4 | `model.short`, `{isolation}`, `{review}` |
| 5 | `model.short` |

If none fits, `statusChips` returns `[]`. The model chip is always `tokens.fg`; Isolation is
`tokens.warn` for Host, Review is `tokens.warn` for Off, and other status chips are `tokens.muted`
(same named functions).

**Assembly.** `room` in `projectHeader` is `width − BRAND_COLS − WORKSPACE_FLOOR −
(floor ? 0 : IDENTITY_FLOOR) − VERSION_GUTTER − version width − (urgent reserved) −
(exception reserved)`. `exception` is only actually computed, past the
`exceptionAllowed` gate, with `includeIsolation` set to whether the chosen chip rung already carries
an `"isolation"` key — so a visible Host chip suppresses the redundant `"Isolation: Host"`
exception. Every status chip and every
host-state field except the first in its group is prefixed with a fresh `separator()`; the first
field after the flexible gap carries none, and the separate final version zone uses its fixed gutter
instead. `packages/code/tests/unit/header-projection.test.ts` pins every rung of the ladder,
the grouped separator rule, the Sandbox-outranks-doctor and Host-stated-once priorities, the
floor-mode identity drop and the version field; the render side is pinned by
`packages/code/tests/integration/header-render.test.tsx`.

### 4.14 Three `runtime.tsx` behaviors §2.5 names but does not narrate

**`AppSessionControls.resumeCatalog` and `.delete`** are strictly current-workspace operations
(`packages/code/src/runtime.tsx`, `sessionControls`). `catalog()` projects only
`listSessionsForWorkspace(sessionStore, workspaceRef().id)` and marks every row available.
`resumeCatalog(item)` resumes `item.meta.id` directly. `delete(item)` loads from the one session
store, clears the active session when ids match, and deletes the session and its runs through the
current run client. No temporary client or cross-workspace branch exists.

**`reconnectBackend`** (`packages/code/src/runtime.tsx`): refuses while `RunHost.scheduledBusy()`
reports local preparation, physical run closure, shell work or compaction. Otherwise it sets
connection state to `connecting`, pauses loop readiness, and calls `runClient.reconnect(mode)`.
`/reconnect` selects `connection`, which replaces the transport without restarting the executor;
`/reconnect reload` and configuration callbacks select `reload`, which requires host quiescence.
Success reloads local keys/settings/agent adapters and the profile catalogue before publishing
`ready`. Failure probes the retained client: a rejected reload with a healthy connection remains
`ready`, while an unavailable connection becomes `failed` and offers `/reconnect`. Host polling
also reports lost connection separately from the runtime placement label. Neither path retries a
run or silently reattaches its controls.

Production: `createWorkspaceRunClient`, `reconnectBackend` and `subscribeConnectionFailure` wiring
in `packages/code/src/runtime.tsx`; `WorkspaceClientManager` and `createKernelRunClient`.
Test: the recovery/refused-reload cases in
`packages/code/tests/component/workspace-client-manager.test.ts`, transition-intent and retained-client
cases in `packages/code/tests/component/kernel-run-client.test.ts`, and `/reconnect` routing in
`packages/code/tests/integration/app-commands.test.tsx`.

**`exportSession`/`writeExportChunk`** (`packages/code/src/runtime.tsx`): `writeExportChunk`
writes a chunk's UTF-8 bytes in a loop over `output.write(bytes, offset, …)`, advancing `offset` by
`written.bytesWritten` each pass and throwing `new Error("export write made no progress")` the moment a
write returns `bytesWritten <= 0`. `exportSession` resolves the export directory, opens
the target file `"w", 0o600`, writes the Markdown header via `writeExportChunk`, then iterates
`for await (const nodes of runHost.exportNodeBatches())` and writes every chunk `renderTranscriptMarkdownChunks(nodes)`
yields through the same guarded writer, closing the handle in a `finally`; any thrown
error — including the guard's own — is caught and reported as `export failed: <text>`.

## 5. Invariants

Each invariant names its production evidence and the test that pins it. "unpinned" means no
test in `packages/code/tests/` asserts it.

**INV-CB-1 (owns INV-248).** The static, value-carrying import closure of `src/cli.ts` — everything
evaluated before `--version` can print — is exactly `{src/cli.ts, src/cli-args.ts, src/cli-entry.ts,
../../package.json}`.
Production: `packages/code/src/cli.ts` (static launcher imports); `packages/code/src/cli-args.ts`
(root product-manifest import).
Pinned: `packages/code/tests/architecture/cli-fast-path.test.ts`
(`reaches nothing beyond the argument modules before printing --version`). The test's own remark
records that the launcher previously loaded the whole application before answering this flag.

**INV-CB-2 (owns INV-249).** `src/cli.ts` reaches `@opentui/solid/preload` and `./index.tsx` only
through a dynamic `import()`, and reaches each at least once.
Production: `packages/code/src/cli.ts` (dynamic preload and application imports).
Pinned: `packages/code/tests/architecture/cli-fast-path.test.ts`
(`loads the application only through a dynamic import`).

**INV-CB-3 (owns INV-250).** `src/cli-args.ts` has exactly one non-type, non-dynamic import: the root
`../../../package.json` product manifest.
Production: `packages/code/src/cli-args.ts` (root manifest import; `SessionId` and `DiagnosticLevel`
are type-only and erased by `verbatimModuleSyntax`).
Pinned: `packages/code/tests/architecture/cli-fast-path.test.ts`
(`root product manifest` case).

**INV-CB-3a.** `--update` reaches the mutating updater only through a dynamic import before
bundle/source entry resolution. `--help`, `--version`, every headless mode, source, `bun link`, and
unmanaged installs do not perform the automatic request. A managed interactive TUI may dynamically
import the separate read-only checker only from `AppShell.afterPaint`; disabling the global Code
preference prevents that import. Production: `packages/code/src/cli.ts` and
`packages/code/src/index.tsx` (`update` branches), `packages/code/src/runtime.tsx` (`update_check`),
and `packages/code/src/update/check.ts`. Pinned:
`packages/code/tests/architecture/{cli-fast-path,architecture-boundary}.test.ts` and
`packages/code/tests/unit/{update-check,update-command}.test.ts`. The discovery, archive, and
activation contract belongs to [distribution and updates](../cross-cutting/distribution-and-updates.md).

**INV-CB-4.** The static-import walker used by INV-CB-1..3 distinguishes value, type-only and dynamic
forms.
Pinned by a self-test: `packages/code/tests/architecture/cli-fast-path.test.ts`.

**INV-CB-5 (owns INV-243).** No file under `src/core/**` imports `solid-js`, any `@opentui/*`, any
`@clarvis/kernel*`, `@clarvis/paths`, `node:fs`, `node:fs/promises`, or anything resolving into
`adapters/`, `infrastructure/`, `theme/`, `ui/` or `views/`.
Pinned: `packages/code/tests/architecture/architecture-boundary.test.ts`.
Note: `src/infrastructure/` does not exist (`packages/code/src/` listing), so that clause is currently
vacuous.

**INV-CB-6 (owns INV-244).** No file under `src/adapters/**` imports anything resolving into `ui/` or
`views/`.
Pinned: `packages/code/tests/architecture/architecture-boundary.test.ts`.

**INV-CB-7 (owns INV-245).** No file under `src/ui/**` imports `@clarvis/kernel*`, or anything
resolving into `adapters/` or `features/`.
Pinned: `packages/code/tests/architecture/architecture-boundary.test.ts`.

**INV-CB-8 (owns INV-246).** No `src/features/**/controller.ts` imports anything resolving into
`theme/`, `ui/` or `views/`, nor any specifier ending in `.tsx`.
Pinned: `packages/code/tests/architecture/architecture-boundary.test.ts`. Three controllers are
in scope: `features/{agents,providers,tasks}/controller.ts`.
Note the asymmetry with INV-CB-5: the four boundary checks count **type-only** imports as violations —
the walker at `packages/code/tests/architecture/architecture-boundary.test.ts` records every `ImportDeclaration` regardless of
`isTypeOnly`, is a self-test proving a `import type { HintTone } from "../views/hint.ts"`
is seen. `packages/code/src/app/command-composition.ts` is exactly such an import and is legal only because `app/` is
not one of the four constrained layers.

**INV-CB-9 (owns INV-251).** Every `@clarvis/kernel…` specifier anywhere in `src/` **or `tests/`** is
one of the six sanctioned entrypoints (`@clarvis/kernel`, `/bootstrap`, `/config`, `/policy`,
`/local`, `/logger`), and none of `@clarvis/{capability,loop,memory,plan,tools,skills,tasks,workflows}` appears at
all.
Pinned: `packages/code/tests/architecture/dependency-boundary.test.ts` (entrypoint set forbidden list). The lightweight startup/runtime imports `createLogger` from the narrow
`@clarvis/kernel/logger` entry; file-kernel construction enters only through a dynamic
`@clarvis/kernel/bootstrap` import in `WorkspaceClientManager`.

**INV-CB-9a.** The specifier walker behind INV-CB-9 recognizes type-only, re-exported, side-effect and
dynamic `import()` forms, not just plain value imports.
Pinned by a self-test: `packages/code/tests/architecture/dependency-boundary.test.ts` — it feeds
`import type`, `export type`, a bare side-effect `import`, a dynamic `import()` and an `import(...).Foo`
type-position reference through `importedSpecifiers` and asserts all five specifiers are collected.

**INV-CB-9b.** Every relative import under `src`, `tooling` and `tests` names the actual TypeScript
source extension (`.ts` or `.tsx`). A `.js` specifier is valid only when it refers to a real runtime
artifact rather than aliasing a neighboring TypeScript source; generated `dist/index.js` and lazy
chunks therefore remain JavaScript. Production: `packages/code/tsconfig.json`
(`allowImportingTsExtensions`) and the package's relative source imports. Test:
`tooling/checks/import-extensions.ts` (`aliasedTypeScriptImports`), the repository-wide guard owned
by **build-and-ci**, resolves every relative runtime extension and rejects it when a matching
TypeScript source exists.

**INV-CB-10 (owns INV-252).** The manifest declares exactly three `@clarvis/*` dependencies:
`@clarvis/kernel`, `@clarvis/paths`, `@clarvis/protocol`.
Production: `packages/code/package.json`.
Pinned: `packages/code/tests/architecture/dependency-boundary.test.ts`, "imports only its declared
Clarvis dependencies and approved kernel entrypoints".

**INV-CB-11.** `resolveEntry` precedence is `forceSource` → `distExists` → error; `CLARVIS_CODE_SOURCE=1`
wins over a present bundle.
Production: `packages/code/src/cli-entry.ts`.
Pinned: `packages/code/tests/unit/cli-entry.test.ts`.

**INV-CB-12.** The missing-bundle message names the path and all three remedies.
Production: `packages/code/src/cli-entry.ts`.
Pinned: `packages/code/tests/unit/cli-entry.test.ts`.

**INV-CB-13.** `FLAGS` is the sole source for `--help`, the usage line **and** the package README's CLI
section — every flag token and every `desc` string appears in all three.
Production: `packages/code/src/cli-args.ts`.
Pinned: `packages/code/tests/unit/cli-args.test.ts`.

**INV-CB-14.** At most one `mode: true` flag per invocation; two or more is a usage error naming all of
them.
Production: `packages/code/src/cli-args.ts`.
Pinned: `packages/code/tests/unit/cli-args.test.ts`.

**INV-CB-15.** `--agent` and `--format` are legal only alongside `-p/--print`.
Production: `packages/code/src/cli-args.ts`.
Pinned: `packages/code/tests/unit/cli-args.test.ts`.

**INV-CB-16.** `--help` and `--version` short-circuit before mode-conflict validation, so they can
never produce a usage error.
Production: `packages/code/src/cli-args.ts`.
Pinned indirectly: `packages/code/tests/unit/cli-args.test.ts` asserts the bare forms; **no test
asserts the short-circuit against a conflicting flag** (e.g. `--list --help`). Unpinned in that respect.

**INV-CB-17.** A `--debug=<x>` naming no level is a usage error; the same typo in
`CLARVIS_CODE_DEBUG_LEVEL` is ignored and the default level stands.
Production: `packages/code/src/cli-args.ts`.
Pinned: `packages/code/tests/unit/cli-args.test.ts`.

**INV-CB-18.** The `--debug` flag overrides the environment in both directions: it enables against
`CLARVIS_CODE_DEBUG=off`, and `--debug=<level>` overrides `CLARVIS_CODE_DEBUG_LEVEL`.
Production: `packages/code/src/cli-args.ts`.
Pinned: `packages/code/tests/unit/cli-args.test.ts`.

**INV-CB-19.** `update`/`help`/`version`/`usage-error` never open a diagnostic session, whatever the
environment says, because those `Mode` variants carry no `debug` member.
Production: `packages/code/src/cli-args.ts` (union) (the `"debug" in mode` guard).
Pinned: `packages/code/tests/unit/cli-args.test.ts`.

**INV-CB-20.** `--continue` is strict to the current workspace and never falls back to a global most
recent session.
Production: `packages/code/src/cli-mode.ts` filtering through `listSessionsForWorkspace` in
`packages/code/src/adapters/session-store.ts`.
Pinned: `packages/code/tests/unit/cli-mode.test.ts`.

**INV-CB-21.** `--print` writes only the lead agent's `text` channel to stdout; sub-agent output and
the reasoning channel never reach it.
Production: `packages/code/src/cli-mode.ts`.
Pinned: `packages/code/tests/unit/cli-mode.test.ts`.

**INV-CB-22.** A `--print` transcript settles at `run_ended` rather than at stream exhaustion, and a
stream that closes without `run_ended` still settles it.
Production: `packages/code/src/cli-mode.ts`.
Pinned: `packages/code/tests/unit/cli-mode.test.ts`.

**INV-CB-23.** `runInteractive` refuses a non-TTY with exit code 2 and a message naming every
headless mode before creating the renderer.
Production: `packages/code/src/index.tsx` (`runInteractive`) →
`packages/code/src/adapters/renderer-bootstrap.ts` (`assertInteractiveTTY`).
Pinned: `packages/code/tests/integration/platform-lifecycle.test.ts` ( for stdin).

**INV-CB-24.** Worktree selection completes before any host service boots, and the selected canonical
checkout is the process workspace for every mode that accepts `--worktree`.
Production: `packages/code/src/runtime.tsx` (`runInteractiveMode`, `runHeadlessMode`).
Pinned: `packages/code/tests/unit/cli-args.test.ts` (mode propagation) and
`packages/code/tests/integration/worktree-bootstrap.test.ts` (canonical create/reopen results).

**INV-CB-25.** Git's registered worktree list is the sole registry; an existing destination that Git
does not register is refused rather than adopted.
Production: `packages/code/src/bootstrap/worktree.ts`.
Pinned: `packages/code/tests/integration/worktree-bootstrap.test.ts` (reopen and collision cases).

**INV-CB-26.** Worktree bootstrap never uses a shell and does not inherit repository-local Git
environment variables; prompts are disabled and output/time are bounded.
Production: `packages/code/src/bootstrap/worktree.ts`.
Pinned for inherited `GIT_INDEX_FILE` isolation:
`packages/code/tests/integration/worktree-bootstrap.test.ts`; the argv-only spawn, prompt
variables and timeout/output caps are unpinned.

**INV-CB-27.** A callback target is accepted only while it is the published, still-bound target;
`clear()` makes it inert.
Production: `packages/code/src/app/workspace-runtime.ts`.
Pinned: `packages/code/tests/unit/workspace-runtime.test.ts`.

**INV-CB-28.** Interactive runtime switching is absent: the only advertised `switching` accessor is
the constant false value used by the generic App shell.
Production: `packages/code/src/runtime.tsx` (`runControls.switching`);
`WorkspaceClientManager.open` rejects any id other
than its immutable current workspace (`packages/code/src/adapters/workspace-client-manager.ts`).
Pinned: `packages/code/tests/component/workspace-client-manager.test.ts`.

**INV-CB-29.** The layout floor is 24 columns × 6 rows; below either dimension the mode is `floor`.
Production: `packages/code/src/app/layout.ts`.
Pinned: `packages/code/tests/unit/layout.test.ts`.

**INV-CB-30.** The secondary inspector has three independent automatic reveal intents per execution
context: the first live Plan reveals Plan, the first workflow state/leader reveals Parallel work, and the
first visible sub-agent reveals Agents. Each preserves `Lead transcript` selection and leaves
`ActivityDetail` closed. An explicit close is sticky for later updates of the intent that opened the
surface; the first event for a different section may still reveal it, and a new execution context
may reveal each section once again. Automatic and explicit footer intent both produce a split at
≥100 columns and a drawer below that threshold; while closed, and for every drawer presentation,
`contentInset` stays 0. There is no stored sidebar preference or global toggle command.
Production: `packages/code/src/app/layout.ts` (`createLayoutController`) and
`packages/code/src/views/App.tsx` (`requestAutomaticSidebar`, `visiblePlanContext`,
`visibleSubagentContext`, `closeActivitySidebar`,
`compactActivityStrip`, `Footer.onRunStripMouseDown`). Pinned:
`packages/code/tests/unit/layout.test.ts` (responsive intent mechanics) and
`packages/code/tests/integration/app-shell-render.test.tsx` ("Plan, Parallel work, and Agents own
independent once-per-run sidebar reveals", including new Plan and Workflow contexts; "the first
visible sub-agent opens Agents once per run and an explicit close is sticky"; "clicking the drawer
scrim keeps dismissal sticky for later sub-agents"; "Escape closes a narrow-layout inspector drawer
without canceling the active run"; and the isolated child-selection cases).

**INV-CB-31.** `sidebarWidth` never exceeds the viewport, so the inspector's nominal 32-column minimum
degrades rather than overflowing on a 24-column terminal.
Production: `packages/code/src/app/layout.ts` (`createLayoutController.sidebarWidth`).
Pinned: `packages/code/tests/unit/layout.test.ts`.

**INV-CB-32.** At the floor, App refuses Activity Detail and the managed-worktree exit prompt, and
the floor message paints above the float layer so an already-open overlay cannot cover it.
Production: `packages/code/src/views/App.tsx`.
Pinned only for floor rendering: `packages/code/tests/integration/app-shell-render.test.tsx`;
the two opener refusals are unpinned.

**INV-CB-33.** `runFatalBoot` accepts `r` repeatedly until one retry succeeds, ignores keys while a
retry is in flight, and routes idle `ctrl+c` to `quit`; `q` and Escape are inert. It resolves `false`
when renderer teardown wins, and `runApp` treats that result as terminal so profile boot cannot
continue while shutdown drains. Production: `packages/code/src/views/FatalBoot.tsx`
(`runFatalBoot`, `onKey`, `onDestroy`) and `packages/code/src/runtime.tsx` (`recovered`). Pinned:
`packages/code/tests/integration/fatal-boot-render.test.tsx` (retry, key ownership, and terminal
renderer-teardown cases) and `packages/code/tests/architecture/architecture-boundary.test.ts`.

**INV-CB-34.** `runFatalBoot` disposes its Solid root on success, so the application mounts alone
rather than on top of it. Production: `packages/code/src/views/FatalBoot.tsx` (`runFatalBoot`,
`close`). Pinned: `packages/code/tests/integration/fatal-boot-render.test.tsx` ("fatal boot:
disposes its root on success so the App mounts alone").

**INV-CB-35.** `PageFrame`'s content region clips, so an over-tall or absolutely-positioned child can
never composite over the title row.
Production: `packages/code/src/views/PageFrame.tsx` (rule stated).
Pinned: `packages/code/tests/integration/page-frame-clip.test.tsx`.

**INV-CB-36.** The shared banner falls back to a one-line wordmark below 60 columns or when its caller
explicitly cannot spare the eight-row art; the banner art is 8 rows each under 60 columns wide.
Production: `packages/code/src/views/Splash.tsx` (`BANNER`, `BrandBanner`).
Pinned: `packages/code/tests/integration/splash-render.test.tsx` (idle width fallback, banner shape,
and startup width/height edges).

**INV-CB-37.** `HeaderRows` is one terminal row.
Production: `packages/code/src/views/HeaderRows.tsx` (`height={1}` on the only row box, inside the single column wrapper).
Pinned: `packages/code/tests/integration/header-render.test.tsx` — the fixture places a rule and
a `BODY` line after the header and asserts they land on rows 1 and 2.

**INV-CB-38.** `registerCodeCommands`'s `dispose` is idempotent and releases the app registration
before the feature scope.
Production: `packages/code/src/app/command-composition.ts`.
Unpinned — no test in `packages/code/tests/` calls `registerCodeCommands().dispose()` twice; `App`
calls it once from `onCleanup` (`packages/code/src/views/App.tsx`).

**INV-CB-39.** `src/cli.ts`, `src/index.tsx` and `src/runtime.tsx` are absent from LCOV by design and
must stay on `NO_COUNTER_ALLOWLIST`: the first two are executable entries, while importing either
TUI module starts application lifecycle work.
Production: `tooling/checks/coverage.ts` (`NO_COUNTER_ALLOWLIST.code`).
Self-pinning: `tooling/checks/coverage.ts` reports allowlist entries that are no longer needed.

**INV-CB-40.** `CLARVIS_AGENT_TOOLS_MAX_GRANT` defaults to `"exec"` before any local or remote Code
kernel is constructed, and only if unset. The local launcher's policy identity uses the same resolved
environment as the child host. Production: `packages/code/src/index.tsx` (`runInteractive`),
`codeHostEnvironment` in `packages/code/src/adapters/host-kernel-options.ts`, and
`WorkspaceClientManager` in `packages/code/src/adapters/workspace-client-manager.ts`. Test:
`packages/code/tests/unit/host-kernel-options.test.ts`.

**INV-CB-41.** Durable memory recovery follows the independent host lifecycle, not a TUI paint or
transport reconnect. Production: `serveLocalFileKernel` in
`packages/kernel/src/hosting/serve-local.ts`. Test:
`packages/code/tests/architecture/architecture-boundary.test.ts` checks that the UI owns no recovery
trigger; `packages/kernel/tests/integration/local-host-process.test.ts` exercises process lifecycle,
and `packages/kernel/tests/integration/owner-isolation.test.ts` pins idempotent recovery release.

**INV-CB-42.** One `--extension-profile` value reaches every kernel created by the invocation and remains the
highest-precedence selector across backend reconnects; it never writes persisted selection state.
Production: `Mode.extensionProfileSelector` in `packages/code/src/cli-args.ts`, capture and constructor
plumbing in `packages/code/src/runtime.tsx` and `packages/code/src/startup-foundation.ts`, and
`packages/code/src/adapters/workspace-client-manager.ts`. Test:
`packages/code/tests/unit/cli-args.test.ts` and
`packages/code/tests/component/workspace-client-manager.test.ts`.

**INV-CB-43.** The first interactive frame preserves Clarvis visual continuity without entering the
application parser or models-catalog path: one branded `StartupComposer` owns a focused input, a
distinct startup-readiness marker and the shared `BrandBanner`. At 60×16 or larger it paints the same
complete eight-row banner as an empty untouched run; below either edge it paints the shared compact
wordmark. It accepts at most one queued task; the snapshot survives root replacement, starts before
complete-app hydration when submitted, and otherwise transfers the exact draft to `App`. It never
contains the complete app's paint/readiness markers. Production:
`runInteractive` in `packages/code/src/index.tsx`, `createStartupComposerState` in
`packages/code/src/views/StartupComposer.tsx`, `BrandBanner` in
`packages/code/src/views/Splash.tsx`, and the startup handoff in
`packages/code/src/runtime.tsx`. Tests: `packages/code/tests/integration/splash-render.test.tsx`,
`packages/code/tests/integration/app-shell-render.test.tsx`,
`packages/code/tests/architecture/architecture-boundary.test.ts`, and
`packages/code/tooling/artifact/smoke.ts` (complete-app paint and deferred catalogue).

**INV-CB-44.** `clarvis-develop` is a marked, source-only launcher distinct from the product's sole
`clarvis` executable. It preserves the caller's working directory unless `--empty-workspace`
selects a newly allocated temporary directory, never replaces an unmanaged destination, and
exposes global-state and managed-temporary deletion only through explicit `--clear`. Production:
`dev-install.sh` and `packages/code/tooling/development-install.ts`
(`developmentLauncherSource`, `existingLauncher`, `cleanDevelopmentState`,
`createEmptyDevelopmentWorkspace`, `clearDevelopmentTempWorkspaces`). Test:
`packages/code/tests/unit/development-install.test.ts` (launcher execution, ownership, cleanup, and
shell-delegation cases).

**INV-CB-45.** Resume/continue session preflight finishes before OpenTUI renderer creation, so a
missing session never enters raw mode or the alternate screen. Once renderer creation begins,
teardown has an owner from the first post-creation instruction through the complete keymap mount.
Exit, every platform-supported catchable OpenTUI default signal and raw Ctrl+C cannot leave raw mode
or the alternate screen behind;
`SIGKILL` is inherently uncatchable. Ownership transfers to the platform without a gap, and
FatalBoot has priority over the temporary Ctrl+C owner. A startup submission starts only when the
active Agent Profile is runnable, otherwise its exact bytes become the complete composer's draft.
The first platform shutdown hook latches boot shutdown before releasing the terminal; `runApp`
checks that latch before starting and immediately after awaiting Agent Profile discovery, so neither
startup submission nor complete-app mount can begin after shutdown wins the boot race.
Production: `installBootRendererLifecycle` in
`packages/code/src/adapters/renderer-bootstrap.ts`, `runInteractive` in
`packages/code/src/index.tsx`, `prepareInteractiveMode` in `packages/code/src/runtime.tsx`,
`resolveStartupComposerHandoff` in
`packages/code/src/views/StartupComposer.tsx`, and `runApp` in
`packages/code/src/runtime.tsx`. Test:
`packages/code/tests/unit/renderer-bootstrap-lifecycle.test.ts`,
`packages/code/tests/integration/{fatal-boot-render,splash-render}.test.tsx`, and
`packages/code/tests/architecture/architecture-boundary.test.ts`.

**INV-CB-46.** A managed checkout can be removed on exit only after an explicit `y`, only after two
cleanliness checks, and only through non-forced `git worktree remove`; its branch is preserved and
the requested cleanup completes before the bounded platform-shutdown sequence begins. An external
checkout's parent is never treated as Clarvis-owned.
Production: `WorktreeExitPrompt` in `packages/code/src/views/overlays/WorktreeExitPrompt.tsx`,
`worktreeIsClean` and `removeWorktreeCheckout` in `packages/code/src/bootstrap/worktree.ts`, and the
pre-shutdown close/removal path in `packages/code/src/runtime.tsx`. Pinned:
`packages/code/tests/integration/app-shell-render.test.tsx` (remove/keep/dirty UI paths) and
`packages/code/tests/integration/worktree-bootstrap.test.ts` (clean removal, branch retention, dirty
refusal, external-parent retention and external reopen without primary setup).

**INV-CB-47.** The primary checkout's `.clarvis/.gitignore` effectively ignores `worktrees/` before
any nested checkout is created, and launching from a linked checkout still targets the primary root.
Production: `ensureWorktreeIgnore` and `bootstrapWorktree` in
`packages/code/src/bootstrap/worktree.ts`; `ensureWorkspaceDir` in `packages/paths/src/ensure.ts`.
Pinned: `packages/code/tests/integration/worktree-bootstrap.test.ts` and
`packages/paths/tests/integration/ensure.test.ts`.

**INV-CB-48.** The lightweight startup composer and the complete application header render the same
root-manifest product version as `v<version>` in a fixed right-aligned zone. Header projection
reserves that version and its one-column gutter before admitting status chips, so narrow-width
elision removes optional run configuration rather than the product identity. Production:
`packages/code/src/index.tsx` (`runInteractive`),
`packages/code/src/views/StartupComposer.tsx` (`StartupComposer`),
`packages/code/src/views/App.tsx` (`headerPlan`),
`packages/code/src/views/header-projection.ts` (`projectHeader`) and
`packages/code/src/views/HeaderRows.tsx` (`HeaderRows`). Tests:
`packages/code/tests/unit/header-projection.test.ts` and
`packages/code/tests/integration/{splash-render,header-render,app-shell-render}.test.tsx`.

**INV-CB-49.** Every complete Code kernel boot goes through `WorkspaceClientManager`, so interactive,
`--print`, session-only and model-refresh modes all receive either the selected local host or the
operator-selected SSH host. Both application host entries share the same Docker/Podman runtime
factory. No direct `createFileKernel` call remains in `runtime.tsx`. Production:
`packages/code/src/runtime.tsx` (`bootSilentSessionStore`, `runPrintMode`, `runRefreshMode`, `runApp`)
and `packages/code/src/adapters/workspace-client-manager.ts` (`WorkspaceClientManager.create`) plus
`packages/code/src/adapters/host-kernel-options.ts` (`createCodeHostKernelOptions`).
Pinned: `packages/code/tests/architecture/architecture-boundary.test.ts` ("routes every complete
kernel boot through the runtime-aware workspace manager").

**INV-CB-50.** A remote Code invocation requires paired SSH destination and absolute remote
workspace selection, carries no local provider credential or discovery token, accepts the
server-owned session namespace, and never exposes machine-local controls. Its reconnect creates a
new SSH process without replaying an operation; reload is unavailable. Client diagnostics and
prompt history use the local invocation's state while workspace files and sessions use the remote
services. OpenSSH owns encryption, integrity, host-key verification and user authentication using
its normal configuration, default identities and local agent. Clarvis disables port, agent and X11
forwarding, leaves `StrictHostKeyChecking` to OpenSSH configuration, forces `BatchMode=yes`, and does
not implement password or identity-file UI; operators prepare a verified, noninteractive SSH login
before starting the TUI. Production: `packages/code/src/cli-args.ts`, `packages/code/src/remote-host.ts`,
`packages/code/src/adapters/remote-kernel-arguments.ts`, and
`packages/code/src/adapters/workspace-client-manager.ts`. Test:
`packages/code/tests/unit/cli-args.test.ts`,
`packages/code/tests/unit/remote-kernel-arguments.test.ts`,
`packages/code/tests/component/workspace-client-manager.test.ts`, and
`packages/kernel/tests/integration/remote-ssh.test.ts`.

## 6. Failure modes and degradation

| Situation | Handling | Exit / effect | Cite |
| --- | --- | --- | --- |
| No `dist/index.js` and no `CLARVIS_CODE_SOURCE` | full remedy text on stderr | exit 1 | `packages/code/src/cli.ts`, `packages/code/src/cli-entry.ts` |
| Unknown flag / missing value / mode conflict / bad `--print` prompt or format | `usage-error` mode in the lightweight entry; the complete runtime is not imported | stderr `<message>\n<usage>`, exit 1 | `packages/code/src/cli.ts`, `packages/code/src/index.tsx` (`main`) |
| `--extension-profile` names an invalid or missing Extension Profile | kernel creation/current resolution fails closed or exposes the invalid snapshot; no builtin fallback is substituted | invocation fails or the interactive diagnostics view shows the exact issue | [Extension Profiles](extension-profiles.md#6-failure-modes-and-degradation) |
| stdout or stdin is not a TTY in an interactive mode | guidance naming every headless mode | exit 2 | `packages/code/src/adapters/renderer-bootstrap.ts` (`assertInteractiveTTY`) |
| `--resume <id>` names no session | terminal-free `prepareInteractiveMode` reports `session not found: <id> — run clarvis --list` before renderer creation | exit 1 | `packages/code/src/runtime.tsx` (`prepareInteractiveMode`, `assertSessionExists`); `packages/code/src/index.tsx` (`runInteractive`) |
| `--continue` with no session in this workspace | terminal-free `prepareInteractiveMode` reports `no session to continue in this workspace — run clarvis --list` before renderer creation | exit 1 | `packages/code/src/runtime.tsx` (`prepareInteractiveMode`, `assertSessionExists`); `packages/code/src/index.tsx` (`runInteractive`) |
| `--delete <id>` names no session | `session not found: <id>` | exit 1 | `packages/code/src/runtime.tsx` (`runDeleteMode`) |
| `--delete` trace deletion fails per run | per-execution `try/catch` returning `false`; counted in the summary as `okTraces/total` | exit 0 regardless | `packages/code/src/runtime.tsx` (`runDeleteMode`) |
| `--refresh-models` throws | `refresh failed: <text>` | exit 1 | `packages/code/src/runtime.tsx` (`runRefreshMode`) |
| `--update` is unmanaged, unsupported, concurrent, untrusted, or fails staging | one bounded `clarvis update failed: <reason>` line; active version unchanged | exit 1 | `packages/code/src/update/index.ts`, [distribution failure modes](../cross-cutting/distribution-and-updates.md#6-failure-modes-and-degradation) |
| `--print` with no resolvable entry agent | `no interactive entry agent configured — pass --agent or set a default` | exit 1 | `packages/code/src/runtime.tsx` (`runPrintMode`) |
| `--print` run does not complete | `run <status>: <error.message ?? ended_reason ?? status>` | exit 1 | `packages/code/src/runtime.tsx` (`runPrintMode`) |
| `--print` throws anywhere | `print failed: <text>`; opened-client release and manager-close errors swallowed | exit 1 | `packages/code/src/runtime.tsx` (`runPrintMode`) |
| `--print` receives an elicitation | auto-declined, one stderr line per request | run continues | `packages/code/src/runtime.tsx` (`runPrintMode`) |
| `--print` event stream throws mid-iteration | swallowed; `drained` still resolves | the run's `done` still settles | `packages/code/src/cli-mode.ts` |
| Tree-sitter Markdown warm-up fails | `markdown.preload.failed` at `warn`; the already-usable shell continues unhighlighted | degrade | `packages/code/src/runtime.tsx` (`markdownPreload`) |
| `loadFoundation` throws on boot | `boot.failed` with the phase, connection → `failed`, `runFatalBoot` retry screen | interactive retry; Ctrl+C exits 1, while `q` is inert | `packages/code/src/runtime.tsx` (`loadFoundation`, `bootFoundation`) |
| A retry inside `runFatalBoot` throws | message replaced on the same screen, `busy` cleared, screen stays | retryable | `packages/code/src/views/FatalBoot.tsx` (`runFatalBoot`, `onKey`) |
| `boot.profiles` throws | reported, then rethrown outside the fatal-foundation retry | `clarvis failed: …`, `process.exitCode = 1` | `packages/code/src/runtime.tsx` (`runApp`); `packages/code/src/index.tsx` (`main`) |
| Models catalogue unavailable after a catalog surface requests it | `catalog.unavailable` at `warn` with `source: "kernel" \| "snapshot"`; `liveCatalog` answers empty on every accessor | picker empty, boot is unaffected | `packages/code/src/runtime.tsx` (`ensureModelsCatalog`, `liveCatalog`) |
| Worktree branch lookup fails | `worktree.branch.unavailable` at `warn`; header branch stays `undefined` | degrade | `packages/code/src/runtime.tsx` (`runApp`) |
| Prompt-history persistence fails | `historyFailure` string pushed into the run status line | degrade | `packages/code/src/runtime.tsx` (`runApp`) |
| Session store errors | routed to `setRunStatus` through `onError` | degrade | `packages/code/src/runtime.tsx` (`runApp`) |
| `reconnectBackend` while local work is active or preparing | refuses with an explanatory message, no reconnect attempted | `{ ok: false, message }` | `packages/code/src/runtime.tsx` (`reconnectBackend`) |
| `reconnectBackend` throws | probes the retained client; keeps `ready` if reachable, otherwise sets `failed` with a connection recovery action | `{ ok: false }` | `packages/code/src/runtime.tsx` (`reconnectBackend`) |
| Session export fails | `export failed: <text>` returned as the status string | degrade | `packages/code/src/runtime.tsx` (`exportSession`) |
| An export write makes no progress | `new Error("export write made no progress")` | caught by the above | `packages/code/src/runtime.tsx` (`writeExportChunk`) |
| `--worktree` is outside Git, names an invalid branch segment, collides with an unregistered path, or Git fails/times out/overflows | bootstrap rejects before a kernel/session starts; an interactive startup composer may already be painted | top-level `clarvis failed: <text>`, soft exit 1 | `packages/code/src/bootstrap/worktree.ts`; `packages/code/src/runtime.tsx` (`runInteractiveMode`, `runHeadlessMode`) |
| Remote flags are unpaired, combined with `--worktree`, or contain an unsafe SSH destination/remote command | argument or transport admission rejects before a remote kernel handshake | usage error or top-level failure, no mutation replay | `packages/code/src/cli-args.ts`; `packages/kernel/src/hosting/connect-remote-ssh.ts` |
| SSH needs interactive host-key, password or key-passphrase input | `BatchMode=yes` prevents OpenSSH from prompting after the TUI owns the terminal | startup fails with captured, sanitized SSH diagnostics; establish the host key and key/agent/certificate login first | `connectRemoteKernelOverSsh`; [security](../cross-cutting/security.md) |
| SSH stdio closes | in-flight runs settle unavailable, connection state exposes `/reconnect`, and the remote host retires conversation authority | future goal continuation pauses; reconnect starts one new SSH process | `WorkspaceClientManager`; `serveRemoteFileKernelOverStdio`; goal-service authority retirement |
| Worktree ignore protection cannot be created or verified | bootstrap rejects before `git worktree add` or any kernel/session starts; an interactive startup composer may already be painted | top-level `clarvis failed: <text>`, soft exit 1 | `ensureWorktreeIgnore` in `packages/code/src/bootstrap/worktree.ts`; `seedFile` in `packages/paths/src/ensure.ts` |
| Exit cleanup sees new pending changes or `git worktree remove` fails | checkout and branch are kept; `worktree.remove.failed` records the error before normal exit continues | normal exit | `removeWorktreeCheckout` in `packages/code/src/bootstrap/worktree.ts`; pre-shutdown removal in `packages/code/src/runtime.tsx` |
| Resume of a named session fails at boot | `resume failed: <text>` into the status line | degrade | `packages/code/src/runtime.tsx` (`runApp`) |
| Remote MCP needs OAuth and the browser is ignored | browser flow stays background; that MCP is inactive for the current run | composer and other model/tools continue | [MCP client](../foundations/mcp-client.md), `MCPAuthorizationPendingError` |
| Any unhandled failure in `main` | `clarvis failed: <text>` on stderr; `process.exitCode = 1` (process still drains) | soft exit 1 | `packages/code/src/index.tsx` (`main`) |
| Any detached UI task fails | `task.failed` diagnostic with `{ operation, error, observed }`; the observer's own throw becomes `task.observer_failed` | never escapes | `packages/code/src/core/tasks.ts` |

## 7. Coupling

### 7.1 Outward (runtime, static)

| From | To | Nature | Cite |
| --- | --- | --- | --- |
| `cli.ts` | `node:fs`, `node:url` | value | `packages/code/src/cli.ts` |
| `cli.ts` | `./cli-args.ts`, `./cli-entry.ts` | value | `packages/code/src/cli.ts` |
| `cli-args.ts` | root `../../../package.json` | value (the **only** one), product version | `packages/code/src/cli-args.ts` |
| `index.tsx` | `@opentui/core`, `@opentui/solid`, `solid-js` | renderer plus the focused startup root | `packages/code/src/index.tsx` |
| `index.tsx` | `cli-args`, `StartupComposer`, renderer/terminal bootstrap | value; bounded pre-runtime graph | `packages/code/src/index.tsx` |
| `startup-foundation.ts` | `@clarvis/paths`, `@clarvis/kernel/logger` | minimal workspace/key-source projection while the runtime chunk loads | `packages/code/src/startup-foundation.ts` |
| `adapters/workspace-client-manager.ts` | `@clarvis/kernel/bootstrap` | type-only options plus dynamic `createFileKernel` factory | `packages/code/src/adapters/workspace-client-manager.ts` (`loadFileKernelFactory`) |
| `runtime.tsx` | `@clarvis/paths`, `@clarvis/kernel/logger`, OpenTUI/Solid, Node filesystem | complete headless and interactive composition graph | `packages/code/src/runtime.tsx` |
| `views/App.tsx` | `../app/command-composition.ts` | value: `registerCodeCommands` | `packages/code/src/views/App.tsx` |
| `views/App.tsx` | `../app/layout.ts` | value | `packages/code/src/views/App.tsx` |
| `app/command-composition.ts` | `./commands.tsx`, `../features/{agents,providers}/commands.ts` | value | `packages/code/src/app/command-composition.ts` |
| `app/commands.tsx` | lightweight route metadata, controllers and adapters; registered config/help screens enter through `lazyView` dynamic imports | mixed | `packages/code/src/app/commands.tsx`, `packages/code/src/views/config/lazy-view.tsx` |

### 7.2 Outward (type-only)

`cli-args.ts` imports `SessionId` from `./adapters/session-store.ts` and `DiagnosticLevel` from
`./core/diagnostic-events.ts` as **types** (`packages/code/src/cli-args.ts`); the file's remark says
`verbatimModuleSyntax` erases them and that this is what keeps INV-CB-3 true. `cli-mode.ts`
imports `RunEvent` from `@clarvis/protocol` as a type (`packages/code/src/cli-mode.ts`) but `listSessionsForWorkspace`
and `memoryNoticeStatus`/`plainStatusLine` as values — which is precisely why it is a
separate module from `cli-args.ts` and why the flag table is "deliberately **not** re-exported from
here — a barrel would put this file's imports back on `cli.ts`'s fast path" (`packages/code/src/cli-mode.ts`).

### 7.3 Inward

| Consumer | What it uses | Cite |
| --- | --- | --- |
| `src/index.tsx` | parser/help/version plus `StartupComposer`, `BootShell` and renderer bootstrap | `packages/code/src/index.tsx` |
| `src/startup-foundation.ts` | startup key-source reader, browser opener and `WorkspaceClientManager` | `packages/code/src/startup-foundation.ts` |
| `src/runtime.tsx` | print/session helpers, workspace callbacks, worktree lifecycle, `runFatalBoot`, `App` and its five control interfaces | `packages/code/src/runtime.tsx` |
| `views/App.tsx` | `createLayoutController`, `FLOOR_MIN_COLUMNS`, `FLOOR_MIN_ROWS` | `packages/code/src/views/App.tsx` |
| `views/StartupComposer.tsx` | `BrandBanner` | `packages/code/src/views/StartupComposer.tsx` |
| `views/app/TranscriptRegion.tsx` | `Splash` | `packages/code/src/views/app/TranscriptRegion.tsx` |
| `views/onboarding/{SetupView,RecoveryView}.tsx` | `BrandBanner`; Setup also uses `firstRunSplashFits` | the corresponding imports in each onboarding view |
| `views/config/CatalogPicker.tsx` | `BANNER`, `BrandBanner`, `firstRunSplashFits` | the first-run picker intro |
| `views/overlays/{DiffViewer,PlanOverlay,Help}.tsx` | `PageFrame` | corresponding `PageFrame` imports |
| `packages/code/tooling/artifact/build.ts` (via the `build` script) | `src/index.tsx` as the bundle entry | `packages/code/package.json` |

### 7.4 What forces the direction

- **The bin points at `cli.ts`, not `index.tsx`** (`packages/code/package.json`), so `cli.ts`'s import closure is
  the launch cost; `packages/code/tests/architecture/cli-fast-path.test.ts` is what makes that measurable and enforced.
- **`cli-args.ts` cannot import `cli-mode.ts`** (or anything else) without failing
  `packages/code/tests/architecture/cli-fast-path.test.ts`; the split exists only to satisfy that.
- **`views/App.tsx` imports `app/command-composition.ts`, not the reverse** — `command-composition.ts`
  imports only adapter/feature types and `commands.tsx` (`packages/code/src/app/command-composition.ts`), while
  `commands.tsx` imports `views/config/*` freely (`packages/code/src/app/commands.tsx`). No test forbids the reverse
  edge; the four boundary rules do not cover `app/`.
- **`runtime.tsx` is the only place all complete-app layers meet.** It imports `adapters/`, `core/`,
  `theme/`, `features/`, `app/`, `views/`, `onboarding/` and the narrow kernel logger entry together.
  `index.tsx` reaches it only through dynamic import after the startup composer paints; the artifact
  contract pins that split (`packages/code/src/index.tsx`, `packages/code/src/runtime.tsx`,
  `packages/code/tests/architecture/artifact-contract.test.ts`).
- **`@clarvis/paths` is a `core/` violation but a composition-root legality**:
  `packages/code/tests/architecture/architecture-boundary.test.ts` forbids `@clarvis/paths` under
  `core/`; `startup-foundation.ts` and `runtime.tsx` sit outside every constrained layer.

### 7.5 `adapters/errors.ts` — a duplicate kept for the sake of INV-CB-9

`errorText` (`packages/code/src/adapters/errors.ts`, `return e instanceof Error ? e.message :
String(e)`) is a byte-for-byte copy of `@clarvis/kernel/policy`'s function of the same name, not a
re-export. The file's own `@remarks` states why: "fourteen modules across `code/src` import it —
including several on the path evaluated before the first frame. `kernel/src/policy.ts` re-exports the
run-event mappers and reaches `@clarvis/loop/host`, so that import dragged the host graph and its
schema construction onto the pre-paint path merely to obtain this helper"
(`packages/code/src/adapters/errors.ts`) — i.e. importing the real thing would satisfy INV-CB-9 (only
the six sanctioned `@clarvis/kernel` entrypoints, §5) but would defeat the fast-path measurement
`cli-fast-path.test.ts` exists to hold (§7.4's first bullet). The duplication is pinned identical to its
source rather than merely similar: `packages/code/tests/unit/errors.test.ts` imports both
`errorText` from `../../src/adapters/errors.ts` and `@clarvis/kernel/policy`'s and asserts the two agree
on ten cases spanning both branches (a plain `Error`, a subclass, an `Error` with a `cause`, an empty
message, a bare string, a number, `null`, `undefined`, a non-`Error` object shaped like one, and a
`Symbol`) — so a future edit to the kernel's version that this copy does not follow would fail the test
rather than silently drift.

Its importers span every layer this document's boundary rules separate:
`packages/code/src/run-host.ts`, `packages/code/src/runtime.tsx`,
`packages/code/src/views/App.tsx`, `packages/code/src/views/FatalBoot.tsx`,
`packages/code/src/views/overlay-host.ts`, `packages/code/src/onboarding/doctor.ts`,
`packages/code/src/app/commands.tsx`, nine `views/config/*.tsx` screens,
`packages/code/src/features/agents/events.ts`, `packages/code/src/features/providers/events.ts`,
`packages/code/src/adapters/marketplace.ts`, and `packages/code/src/adapters/plugin-install.ts` — all importing the same relative `./errors.ts` (or
`../adapters/errors.ts`) sibling rather than reaching past it into the kernel.

## 8. Open questions

1. ~~**`--continue`'s preflight is dead as written.**~~ **Resolved:** it was the `null`/`undefined`
   slip, and the comparison is now `!== null` (`packages/code/src/runtime.tsx`,
   `assertSessionExists`), so a workspace with no session prints
   "no session to continue in this workspace" and exits 1 instead of
   booting the full TUI to land on `setRunStatus("session not found")`. `resolveResumeMeta`
   still returns `SessionMeta | null` (`packages/code/src/cli-mode.ts`); the `resume` branch
   is checked against the same selected workspace session store. `runtime.tsx` remains on
   `NO_COUNTER_ALLOWLIST`, so the preflight itself is still untested — what is pinned is
   the shape that made the old comparison wrong: a miss is `null`, never `undefined`
   (`packages/code/tests/unit/cli-mode.test.ts`).
2. ~~**`src/index.tsx` combined the complete interactive boot and had no direct seam.**~~
   **Resolved in part:** `index.tsx` is now the focused renderer/parser entry;
   the complete interactive/headless composition moved to `runtime.tsx` and loads only after the
   focused startup composer paints. Integration tests pin the draft/submission handoff, architecture
   tests pin submit-before-mount ordering and the artifact smoke covers the built PTY. Both modules
   remain on `NO_COUNTER_ALLOWLIST` because importing either starts application lifecycle work, so
   the large runtime's branch-level in-process coverage gap remains explicit rather than being
   mislabeled closed (`tooling/checks/coverage.ts`, `NO_COUNTER_ALLOWLIST.code`).
3. **Why the four boundary rules count type-only imports as violations while `cli-fast-path` exempts
   them** is not stated anywhere. Mechanically the two walkers differ:
   `packages/code/tests/architecture/architecture-boundary.test.ts` ignores `isTypeOnly`, `packages/code/tests/architecture/cli-fast-path.test.ts` honours
   it. No comment or assertion message explains the difference.
4. **The exact `AppCommandDeps` contents and app command registrations** are out of scope here and
   belong to [hosts/code-input-and-overlays.md](code-input-and-overlays.md).
   This spec covers only its two exported types, its scope-shadowing construction
   (`packages/code/src/app/commands.tsx`) and the composition wrapper.
5. **Run streaming, `run-host.ts`, `kernel-run-client.ts`, `WorkspaceClientManager` and the transcript
   store** are named here only as the objects `runtime.tsx` assembles. Their contracts belong to
   [hosts/code-run-host.md](code-run-host.md).
6. **The `dist/index.js` bundle's own contract** — what `packages/code/tooling/artifact/build.ts` externalises, what assets
   it copies, what `tests/architecture/artifact-contract.test.ts` asserts — belongs to
   [cross-cutting/build-and-ci.md](../cross-cutting/build-and-ci.md). This spec establishes only that `cli.ts` prefers that path when it
   exists (`packages/code/src/cli.ts`).
7. **The `847-file` and `~2.5 s` figures** appear four times in this subsystem's own prose
   (`packages/code/src/cli.ts`, `packages/code/src/cli-entry.ts`, `packages/code/src/cli-args.ts`, `packages/code/tests/architecture/cli-fast-path.test.ts`) but are not
   re-derivable from the code; no benchmark in this document's scope measures them. `packages/code/tooling/benchmarks/first-paint.ts`
   exists (`packages/code/package.json`) but is outside this document's scope.
8. ~~**`--print`'s entry-agent resolution reads a `SettingsFile` cast.**~~ **Resolved:** the cast is
   gone. `agentReadiness` now takes a `ReadinessSettings` — `default_model` plus the provider names,
   which is all it ever read (`packages/code/src/adapters/agent-files.ts`) — so `settingsView.merged` is passed as itself
   (`packages/code/src/runtime.tsx`, `runPrintMode`). The question the cast raised is therefore moot rather than
   answered: nothing now asserts the whole `SettingsFile` shape, so nothing depends on whether the
   protocol's `merged` satisfies it.
9. **`INV-247` (the ASCII-source rule) and `INV-253`–`INV-266`** are `@clarvis/code` invariants owned
    by sibling documents; only `INV-243`–`INV-246` and `INV-248`–`INV-252` are restated above.
10. **No test exercises `registerCodeCommands`'s disposal ordering or idempotence** (INV-CB-38), nor
    the `--list --help` short-circuit (INV-CB-16), nor the `CLARVIS_AGENT_TOOLS_MAX_GRANT` default
    (INV-CB-40). Those are three concrete gaps in an otherwise well-pinned
    surface.
12. ~~**`HeaderRowsProps.agentName` is a dead prop.**~~ **Resolved by removal:** the prop is gone.
    `HeaderRowsProps` is now `{ plan: Accessor<HeaderPlan> }` (`packages/code/src/views/HeaderRows.tsx`) and the
    call site passes only `plan` (`packages/code/src/views/App.tsx`), which matches what the render
    body (`packages/code/src/views/HeaderRows.tsx`) ever read. The active-agent name still reaches the row, but
    through `HeaderInput.agentName` → `projectHeader`'s `identity` field
    (`packages/code/src/views/header-projection.ts`), never as a prop.
12. **`--ascii` combined with a headless mode has no test.** `parseMode` computes `ascii` for every
    invocation (`packages/code/src/cli-args.ts`) but only attaches it to the `run`/`resume`/`continue` variants of
    `Mode`; for `--print`/`--list`/`--delete`/`--refresh-models` the value is silently dropped rather
    than rejected the way `--agent`/`--format` are outside `--print`. No test in
    `packages/code/tests/unit/cli-args.test.ts` asserts what `parseMode(["--refresh-models",
    "--ascii"])` returns, so whether this asymmetry with `--agent`/`--format` is intentional is not
    determinable from the code.
