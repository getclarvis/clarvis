# `@clarvis/code` — CLI fast path, entry resolution, app assembly and layering

> Implemented at `packages/code/...`. Every claim below is anchored to a file and line. Open
> questions are collected in the final section.

## 1. Purpose

`@clarvis/code` is an application package with no `exports` map; its one declared entry point is the
`clarvis` bin, which points at `src/cli.ts` (`packages/code/package.json:7-9`). This subsystem is
everything between that bin and a painted terminal frame: the flag table, the two textual flags and
explicit updater that run without loading the application, the choice between the built bundle and the TypeScript
sources, the headless modes, the interactive boot sequence that constructs a file kernel and a run
host, and the Solid/OpenTUI shell that the boot renders.

The organising constraint stated in the source is launch cost. `packages/code/src/cli.ts:7-12` records
that everything statically imported by `cli.ts` "is paid on every launch, including `--version`", and
that `--help`/`--version` "used to be handled inside `main()`, after the whole 847-file graph had
loaded, and cost ~2.5 s to print one string". `packages/code/src/cli-entry.ts:10-12` records the same
figure for running the sources instead of the bundle: "roughly 2.5 s a launch: from source Bun
transpiles the 847-file graph and applies the Solid JSX transform through Babel on every start". Two
architecture tests exist solely to keep those two properties from regressing
(`packages/code/tests/architecture/cli-fast-path.test.ts:80-98`).

The second organising constraint is layering. `packages/code/tests/architecture/architecture-boundary.test.ts:71-119`
enforces four directional rules among `core/`, `adapters/`, `ui/`, `views/` and `features/**/controller.ts`,
and `packages/code/tests/architecture/dependency-boundary.test.ts`, "imports only its declared Clarvis
dependencies and approved kernel entrypoints", confines the package to five
`@clarvis/kernel` entrypoints and three `@clarvis/*` manifest dependencies. `src/index.tsx` is the one
composition root that is allowed to touch all of them at once, and it is exempt from coverage
(`tooling/checks/coverage.ts:73-76`) because "importing either from a test starts a terminal UI".

## 2. Surface

### 2.1 The `clarvis` bin

| Property | Value | Source |
|---|---|---|
| bin name | `clarvis` | `packages/code/package.json:8` |
| bin target | `src/cli.ts` | `packages/code/package.json:8` |
| bundle path preferred at runtime | `../dist/index.js` relative to `cli.ts` | `packages/code/src/cli.ts:36` |
| source fallback modules | `@opentui/solid/preload`, then `./index.tsx` | `packages/code/src/cli.ts:50-51` |
| package `exports` | absent (application package) | `packages/code/package.json` (no `exports` key) |

The manifest exposes no compatibility alias: the installed executable is `clarvis` only. The
TypeScript setup requires the exact Bun version pinned by `mise.toml`, performs a frozen root install,
selects `build:install` (whose artifact omits source maps), and removes the earlier executable only
when it is a symlink owned by this package before unregistering and linking again. It does not
download Bun or mutate shell profiles; ordinary root/package builds retain detached maps for development diagnostics
(`packages/code/package.json` (`bin`, `scripts.build:install`),
`packages/code/tooling/setup.ts` (build and link phases)).

### 2.2 Flag table (`FLAGS`, `packages/code/src/cli-args.ts:84-112`)

`FLAGS` is declared as "the single source of truth for the CLI surface: parsing, `--help`, the usage
line and the README synopsis all derive from this table" (`packages/code/src/cli-args.ts:80-83`).

| Flag | Alias | Value form | Mode-selecting | Description string (verbatim) | Line |
|---|---|---|---|---|---|
| `--help` | `-h` | — | yes | `print this help and exit` | `packages/code/src/cli-args.ts:85` |
| `--version` | — | — | yes | `print the version and exit` | `packages/code/src/cli-args.ts:86` |
| `--print` | `-p` | `<prompt>` (next token) | yes | `run the prompt headless: stream the reply to stdout, exit 0/1` | `packages/code/src/cli-args.ts:87-93` |
| `--agent` | — | `<name>` (next token) | no | `agent to run --print as (default: entry agent)` | `packages/code/src/cli-args.ts:94` |
| `--format` | — | `<text\|md>` (next token) | no | `--print output: text (default) or md transcript` | `packages/code/src/cli-args.ts:95` |
| `--resume` | — | `<session-id>` (next token) | yes | `resume a saved session` | `packages/code/src/cli-args.ts:96` |
| `--continue` | — | — | yes | `resume this workspace's most recent session` | `packages/code/src/cli-args.ts:97` |
| `--list` | — | — | yes | `list saved sessions and exit` | `packages/code/src/cli-args.ts:98` |
| `--delete` | — | `<session-id>` (next token) | yes | `delete a session and its runs` | `packages/code/src/cli-args.ts:99` |
| `--refresh-models` | — | — | yes | `refresh the models.dev catalog and exit` | `packages/code/src/cli-args.ts:100` |
| `--update` | — | — | yes | `install the newest eligible Clarvis release and exit` | `packages/code/src/cli-args.ts` (`FLAGS`) |
| `--ascii` | — | — | no | `render glyphs as plain ascii` | `packages/code/src/cli-args.ts:101` |
| `--worktree` | — | optional next token or `=name` | no | `open a dedicated Git worktree; omit name to generate one` | `packages/code/src/cli-args.ts:102-106` |
| `--debug` | — | `[=<error\|warn\|info\|debug>]` (inline, optional) | no | `write bounded application diagnostics; --debug=<level>` | `packages/code/src/cli-args.ts` (`FLAGS`) |

`FlagSpec.value` consumes the **next** token and is mandatory; `FlagSpec.inlineValue` is attached with
`=` and is optional; `FlagSpec.optionalValue` accepts either the next token or an `=` value and also
permits the bare flag (`packages/code/src/cli-args.ts:60-78`).

### 2.3 `Mode` (`packages/code/src/cli-args.ts:33-58`)

```ts
export type WorktreeRequest = true | string;
interface WorkspaceMode { worktree?: WorktreeRequest }

export type Mode =
  | ({ kind: "run"; ascii: boolean; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "resume"; id: SessionId; ascii: boolean; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "continue"; ascii: boolean; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "print"; prompt: string; agent?: string; format: PrintFormat; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "list"; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "delete"; id: SessionId; debug: DebugFlag } & WorkspaceMode)
  | { kind: "refresh-models"; debug: DebugFlag }
  | { kind: "update" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "usage-error"; message: string };
```

`worktree` reaches run, resume, continue, print, list and delete, but not the repository-independent
refresh/update/help/version/error modes. `ascii` reaches only the three interactive variants;
`update`/`help`/`version`/`usage-error` carry no `debug`
member at all, which is what `resolveDebugRequest`'s `!("debug" in mode)` guard keys on
(`packages/code/src/cli-args.ts:146`).

`InteractiveMode` is the subset `runApp` accepts:
`Extract<Mode, { kind: "run" | "resume" | "continue" }>` (`packages/code/src/index.tsx:424`).

### 2.4 Exported functions

| Module | Export | Signature | Line |
|---|---|---|---|
| `src/cli-args.ts` | `PrintFormat` | `"text" \| "md"` | 17 |
| | `DebugFlag` | `{ enabled: boolean; level?: DiagnosticLevel }` | 20-25 |
| | `DebugRequest` | `{ enabled: boolean; level: DiagnosticLevel }` | 28-31 |
| | `Mode` | union above | 34 |
| | `FLAGS` | `readonly FlagSpec[]` | 68 |
| | `DebugEnv` | index-signature env view naming `CLARVIS_CODE_DEBUG`, `CLARVIS_CODE_DEBUG_LEVEL` | 101-105 |
| | `resolveDebugRequest` | `(mode: Mode, env: DebugEnv) => DebugRequest` | 145 |
| | `usageText` | `() => string` | 163 |
| | `helpText` | `() => string` | 169 |
| | `versionText` | `() => string` | 186 |
| | `productVersion` | `() => string` | `packages/code/src/cli-args.ts` |
| | `parseMode` | `(argv: string[]) => Mode` | 203 |
| `src/cli-entry.ts` | `EntryInputs` | `{ distPath: string; distExists: boolean; forceSource: boolean }` | 16-23 |
| | `EntryChoice` | `{kind:"dist"} \| {kind:"source"} \| {kind:"error"; message:string}` | 26-27 |
| | `resolveEntry` | `(inputs: EntryInputs) => EntryChoice` | 37 |
| `src/cli-mode.ts` | `resolveResumeMeta` | `(store, owner, workspace, mode) => SessionMeta \| null` | 25-30 |
| | `createPrintStream` | `(write: (chunk: string) => void) => (event: RunEvent) => void` | 40 |
| | `drainPrintEvents` | `(events, sink) => { transcriptDone: Promise<void>; drained: Promise<void> }` | 82-85 |
| `src/app/layout.ts` | `LayoutMode` / `SecondarySurfaceMode` | `"wide"\|"narrow"\|"single"\|"floor"` / `"closed"\|"split"\|"drawer"` | `packages/code/src/app/layout.ts` |
| | `INSPECTOR_MIN_WIDTH` / `INSPECTOR_MAX_WIDTH` / `INSPECTOR_SPLIT_MIN_WIDTH` | `32` / `56` / `100` | 12-14 |
| | `FLOOR_MIN_COLUMNS` / `FLOOR_MIN_ROWS` | `24` / `6` | 47, 49 |
| | `LayoutController` / `createLayoutController` | content- and viewport-driven reactive controller | `packages/code/src/app/layout.ts` |
| `src/app/workspace-runtime.ts` | `WorkspaceCallbackTarget<T>` | `{ current(); bind(v); clear() }` | 2-6 |
| | `createWorkspaceCallbackTarget` | `<T>() => WorkspaceCallbackTarget<T>` | 12 |
| | `isActiveWorkspaceCallbackTarget` | `(candidate, published) => boolean` | 26-30 |
| `src/bootstrap/worktree.ts` | `WorktreeBootstrapResult`, `WorktreeBootstrapDependencies` | selected checkout/result and injectable Git/time/random seams | 14-35 |
| | `runBootstrapGit` | bounded argv-only Git runner | 43 |
| | `bootstrapWorktree` | `(startingWorkspace, request, deps?) => Promise<WorktreeBootstrapResult>` | 145 |
| `src/app/command-composition.ts` | `FeatureCommandDeps` | settings/catalog/keys/code/agents/env/notify | 13-21 |
| | `CodeCommandDeps` | `AppCommandDeps & { features: FeatureCommandDeps }` | 24-26 |
| | `registerCodeCommands` | `(deps: CodeCommandDeps) => AppCommandWiring` | 34 |
| `src/app/commands.tsx` | `AppCommandDeps` | application command dependency bag | 89-148 |
| | `AppCommandWiring` | `{ doctorDirty; recheck; sandboxInspection; skillAgent; dispose }` | 151-164 |
| | `registerAppCommands` | `(deps: AppCommandDeps) => AppCommandWiring` | 173 |
| `src/views/App.tsx` | `AppShell` / `AppRunControls` / `AppSessionControls` / `AppFleet` / `AppBackend` / `AppProps` | see §2.5 | 98, 111, 142, 156, 174, 190 |
| | `App` | `(props: AppProps) => JSX.Element` | 213 |
| `src/views/FatalBoot.tsx` | `runFatalBoot` | `({ renderer, error, retry, quit }) => Promise<void>` | 63-68 |
| `src/views/Splash.tsx` | `BANNER` | `string[]`, 8 rows of ASCII art | 8-17 |
| | `FIRST_RUN_SPLASH_MIN_COLUMNS` / `FIRST_RUN_SPLASH_MIN_ROWS` | `76` / `24` | named constants |
| | `firstRunSplashFits` | `(width: number, height: number) => boolean` | `firstRunSplashFits` |
| | `BrandBanner` | `({ width: () => number }) => JSX.Element` | `BrandBanner` |
| | `Splash` | `({ agent, model, width, rightInset? }) => JSX.Element` | `Splash` |
| `src/views/PageFrame.tsx` | `PageFrame` | `({ title, subtitle?, interaction, children }) => JSX.Element` | 16-21 |
| `src/views/HeaderRows.tsx` | `HeaderRowsProps` / `HeaderRows` | `{ plan: Accessor<HeaderPlan> }` | 8, 15 |

`src/index.tsx` exports **nothing**; it is a bootstrap module whose top level runs
`detachObserved("code_main", main, …)` (`packages/code/src/index.tsx:1347-1350`).

### 2.5 The five control groups `index.tsx` hands `App`

`App` takes exactly seven props (`packages/code/src/views/App.tsx:190-198`): the transcript and
activity stores plus five control groups. The process is pinned to one workspace, so these objects
do not implement runtime worktree switching:

| Prop | Interface | Constructed at | Notable members |
|---|---|---|---|
| `store` | `TranscriptStore` | `packages/code/src/index.tsx:509-513` | `describeToolCall`, `fetchRun` |
| `activity` | `ActivityStore` | `packages/code/src/index.tsx:514` | — |
| `shell` | `AppShell` (`packages/code/src/views/App.tsx`) | `packages/code/src/index.tsx` | renderer/platform/debug session, immutable workspace identity, branch/files, optional managed-worktree clean/remove controls, quit |
| `run` | `AppRunControls` (`packages/code/src/views/App.tsx:111-139`) | `packages/code/src/index.tsx:1129-1150` | submit/compact/context inspection/cancel/local-command controls; `switching` is always false |
| `session` | `AppSessionControls` (`packages/code/src/views/App.tsx:142-153`) | `packages/code/src/index.tsx:1151-1175` | current-workspace list/catalog/resume/delete/clear/export/status/cost |
| `fleet` | `AppFleet` (`packages/code/src/views/App.tsx:156-171`) | `packages/code/src/index.tsx:1182-1213` | agents/settings/guard/memory/keys/catalog and refresh operations |
| `backend` | `AppBackend` (`packages/code/src/views/App.tsx:174-187`) | `packages/code/src/index.tsx:1214-1243` | client/plans/models/provider auth/workflows/plugins/tasks/storage/run lookup/reconnect |

### 2.6 Environment variables read by this subsystem

| Variable | Read at | Effect |
|---|---|---|
| `CLARVIS_CODE_SOURCE=1` | `packages/code/src/cli.ts:40` | forces the source entry over the bundle |
| `CLARVIS_INSTALL_ROOT` | `packages/code/src/update/installation.ts` (`managedInstallation`) | authenticates a versioned portable install for explicit self-update |
| `CLARVIS_CODE_DEBUG` | `packages/code/src/cli-args.ts:147-148` | enables diagnostics unless in `{"", "0", "off", "false", "no"}` (`packages/code/src/cli-args.ts:111`); its value also doubles as a level (`packages/code/src/cli-args.ts:149`) |
| `CLARVIS_CODE_DEBUG_LEVEL` | `packages/code/src/cli-args.ts:149` | level only; takes precedence over the level read out of `CLARVIS_CODE_DEBUG` |
| `CLARVIS_OWNER` | `packages/code/src/index.tsx:143` | passed as `defaultOwner` to `WorkspaceClientManager.create` (`packages/code/src/index.tsx:185`, `packages/code/src/index.tsx:501`) |
| `CLARVIS_AGENT_TOOLS_MAX_GRANT` | `packages/code/src/index.tsx:145` | defaulted (`??=`) to `"exec"` before anything else runs |
| `CLARVIS_CODE_DEV` | `packages/code/src/index.tsx:456` | `dev` flag into `buildRendererConfig` and `createPlatform` |
| `SSH_TTY` / `SSH_CONNECTION` | `packages/code/src/index.tsx:457-458` | sets `OPENTUI_FORCE_EXPLICIT_WIDTH ??= "true"` |
| `CLARVIS_TUI_RSS_LIMIT_MB` | `packages/code/src/views/App.tsx:206` | memory-fuse limit (owned by the memory-pressure adapter) |

## 3. Data and formats

### 3.1 `--version` output

`versionText()` returns `` `clarvis ${product.version}` `` where `product` is the root
`../../../package.json`, the monorepo's sole version authority
(`packages/code/src/cli-args.ts`, `versionText`). Pinned by
`packages/code/tests/unit/cli-args.test.ts` (`version reports the product`).

### 3.2 `--help` output

Assembled in `helpText()` (`packages/code/src/cli-args.ts:169-183`):

```
clarvis <version> — the Clarvis terminal UI

usage: clarvis [-h] [--version] [-p <prompt>] [--agent <name>] ... [--debug[=<error|warn|info|debug>]]

Run without flags to start an interactive session in the current directory.

flags:
  -h, --help                        print this help and exit
      ...
```

The usage line comes from `usageText()`, which brackets each flag's alias-or-canonical token plus its
metavar (`packages/code/src/cli-args.ts:163-166`); `metavar()` renders `" <v>"` for a value flag and
`"[=<v>]"` for an inline one (`packages/code/src/cli-args.ts:157-160`). The flag column is padded to
`max(len(invocation)) + 2` (`packages/code/src/cli-args.ts:172`).

### 3.3 The missing-bundle error text (`packages/code/src/cli-entry.ts:40-49`)

```
clarvis: no build found at <distPath>

  build it:                     bun --filter @clarvis/code build
  or reinstall:                 bun run setup
  or run from source (slower):  CLARVIS_CODE_SOURCE=1 clarvis
```

The TSDoc states the reason for carrying the fix commands inline: "a missing bundle must never reach
the user as a module-resolution failure" (`packages/code/src/cli-entry.ts:33-35`). Every one of those
four substrings is asserted in `packages/code/tests/unit/cli-entry.test.ts:21-29`.

### 3.4 The non-TTY refusal (`packages/code/src/adapters/platform.ts:201-207`)

```
clarvis is an interactive TUI and needs a terminal.
Headless modes: clarvis --help | --list | --delete <id> | --refresh-models | -p <prompt>
```

followed by `process.exit(2)`.

### 3.5 `--list` row format (`packages/code/src/index.tsx:214-218`)

`${workspaceLabel}${available ? "" : " (workspace unavailable)"}  ${formatSessionRow(meta, now)}`,
sorted by `meta.updatedAt` descending (`packages/code/src/index.tsx:209`); the empty case writes `no sessions\n`
(`packages/code/src/index.tsx:211`).

`formatSessionRow` itself (`packages/code/src/views/session-row.ts:43-53`) joins six columns with
two-space gutters and `.trimEnd()`s the result: `m.id`, `relTime(m.updatedAt, now)` padded to
`TIME_COL_WIDTH = 8` (`:16`), `` `${sessionTurnCount(m)} turns` `` padded to the exported
`TURNS_COL_WIDTH = 9` (`:19`), `tokensCellText(m)` padded to the exported `TOKENS_COL_WIDTH = 12`
(`:22`), `costCellText(m)` padded to the exported `COST_COL_WIDTH = 7` (`:25`), and
`m.title || "(untitled)"`. Its own TSDoc calls it "the `--list` view of the same columns the Sessions
hub renders" (`:40-41`), and every export beyond `formatSessionRow` itself — `relTime`,
`tokensCellText`, `costCellText` and the three `*_COL_WIDTH` constants — is re-exported specifically
so [code-domain-hubs](code-domain-hubs.md)'s `SessionsHub`
(`packages/code/src/views/config/SessionsHub.tsx:13-20`, importing all six) can render its own rows
to this same column format rather than re-deriving it; `WorkflowsHub`
(`packages/code/src/views/config/WorkflowsHub.tsx:23`) reuses only `relTime`, for its own
last-updated timestamps.

`relTime(ms, now)` (`:6-14`) buckets the clamped-non-negative delta as seconds under a minute,
minutes under an hour, hours under a day, else days, each `Math.round`-ed — so `relTime(NOW +
5_000, NOW)` (a delta that clamps to `0`) reads `"0s ago"` rather than a negative duration
(`packages/code/tests/unit/session-row.test.ts:29`). `tokensCellText` (`:28-32`) renders
`↑{input} ↓{output}` only when the session has a nonzero total in either direction, else the empty
string; `costCellText` (`:35-37`) renders `formatCostUsd(m.totals.costUsd)` only when a cost was
recorded, else the empty string — both are what "zero tokens and no cost leave their columns blank"
pins (`packages/code/tests/unit/session-row.test.ts:43-50`).

### 3.6 `--delete` summary (`packages/code/src/index.tsx:372-376`)

`session ${deleted|not found}; traces ${okTraces}/${total} deleted`.

### 3.7 `--refresh-models` summary (`packages/code/src/index.tsx:386-392`)

`models.dev refreshed — ${providers} providers / ${models} models`, where the em dash is
`glyph("emDash")` and the model count sums `p.models.length` over providers (`packages/code/src/index.tsx:388-390`).

### 3.8 The splash banner (`packages/code/src/views/Splash.tsx`, `BANNER`)

Eight literal rows of figlet-style ASCII spelling `Clarvis`, e.g. row 0 is
`" .d8888b.  888                           d8b"`. `packages/code/tests/integration/splash-render.test.tsx:35-38`
pins both facts about it: exactly 8 rows, and every row shorter than 60 columns — matching the
60-column fallback inside `BrandBanner`.

First-run setup uses the stricter shared `firstRunSplashFits(width, height)` predicate: the complete
banner is mounted only from 76 columns by 24 rows. The column floor accounts for the 85%-wide picker
card and its horizontal chrome; the row floor leaves card chrome, a filter and at least three catalog
rows after the banner. `packages/code/tests/integration/splash-render.test.tsx`
(`first-run splash fit keeps one threshold across setup and catalog pickers`) pins both edges.

### 3.9 Execution identifier for `--print`

`"exec_" + crypto.randomUUID()` (`packages/code/src/index.tsx:290`).

### 3.10 Session export path

`globalPaths().exportsDirForOwner(owner)`, created `mode: 0o700`, file `${meta?.id ?? "session"}.md`
opened `"w", 0o600` (`packages/code/src/index.tsx:1090-1096`).

### 3.11 The `FatalBoot` screen text (`packages/code/src/views/FatalBoot.tsx:37-51`)

Four literal fragments, top to bottom on the screen:

- `` glyph("error") + " clarvis failed to start" `` (`:37`)
- the run's own error text, from `props.error()` (`:39`)
- `` "the kernel could not boot " + glyph("emDash") + " fix the cause above and retry; once the app starts, Doctor lists checks and fixes" `` (`:43-45`)
- `` props.busy() ? "retrying" + glyph("ellipsis") : "[r] retry   [ctrl+c] quit" `` (`:50`)

### 3.12 The `Splash` agent/model line and hint row (`packages/code/src/views/Splash.tsx`, `Splash`)

The idle screen's second block reads `"agent: "` + `props.agent()` then
`` " " + glyph("separator") + " model: " `` + `props.model()` (`:69-74`); its third block joins three
literal strings with `glyph("separator")` (`:76-83`):

```
"Type / for commands", "@ for workspace files", "Shift+Tab for agents"
```

`glyph("separator")` renders `"·"` in unicode mode (`packages/code/src/core/marks.ts:57`), so the
joined row reads `Type / for commands · @ for workspace files · Shift+Tab for agents`.

## 4. Behavior

### 4.1 `cli.ts` — the fast path, in execution order

| # | Step | Line |
|---|---|---|
| 1 | static imports: `node:fs` `existsSync`, `node:url`, `./cli-args.ts`, `./cli-entry.ts` | `packages/code/src/cli.ts:21-24` |
| 2 | `parseMode(process.argv.slice(2))` | `packages/code/src/cli.ts:26` |
| 3 | `help` → write `helpText()`, `process.exit(0)` | `packages/code/src/cli.ts:27-30` |
| 4 | `version` → write `versionText()`, `process.exit(0)` | `packages/code/src/cli.ts:31-34` |
| 5 | compute `distPath` = `../dist/index.js` next to `cli.ts` | `packages/code/src/cli.ts:36` |
| 6 | `resolveEntry({ distPath, distExists, forceSource })` | `packages/code/src/cli.ts:37-41` |
| 7 | `error` → write message to stderr, `process.exit(1)` | `packages/code/src/cli.ts:43-46` |
| 8 | `dist` → `await import(pathToFileURL(distPath).href)` | `packages/code/src/cli.ts:47-48` |
| 9 | otherwise → `await import("@opentui/solid/preload")` then `await import("./index.tsx")` | `packages/code/src/cli.ts:49-51` |

Note what is **not** here: a usage error is not intercepted. `packages/code/src/cli.ts:14-16` states this is deliberate
— "It is a human at a keyboard rather than a scripted call, so it can afford the slow path, and
delegating keeps validation semantics owned in one place." A `usage-error` therefore falls through to
step 5, loads the whole application, and is reported by `main()` at `packages/code/src/index.tsx:1322-1324`.

`resolveEntry` is a three-line precedence (`packages/code/src/cli-entry.ts:37-49`):

| Condition | Result |
|---|---|
| `forceSource` | `{ kind: "source" }` (even when the bundle exists — pinned at `packages/code/tests/unit/cli-entry.test.ts:12-19`) |
| else `distExists` | `{ kind: "dist" }` |
| else | `{ kind: "error", message }` |

The decision was extracted out of `cli.ts` for a stated reason: "The launcher in `cli.ts` is invisible
to coverage — Bun instruments only the test process, and `coverage.ts` allowlists the file for
that reason — so the decision lives here, as a pure function over already-gathered facts, and the
launcher only performs it" (`packages/code/src/cli-entry.ts:5-8`; the allowlist entry is
`tooling/checks/coverage.ts:75`).

### 4.2 `parseMode` — tokenising and validation order

`packages/code/src/cli-args.ts:203-281`, in order:

1. Build `specOf`: canonical flag → spec, plus alias → spec (`:205-209`).
2. Scan `argv` left to right; a token not starting with `-` is skipped entirely (`:213`) — this is how
   `--resume 0198c0ff` works and how a bare positional is ignored.
3. A token containing `=` at index > 0 resolves the prefix; if that spec has no `inlineValue`, it is
   `unknown flag: <whole token>` (`:214-219`). This is why `--verbose=1` reports the full token
   (`packages/code/tests/unit/cli-args.test.ts:95-97`).
4. Otherwise, unknown token → `unknown flag: <tok>` (`:221-222`).
5. A `value` flag consumes `argv[i+1]`; a missing token, or one starting with `-`, is
   `` `${tok} requires a ${noun(spec.value)} (usage: clarvis ${spec.flag} ${spec.value})` ``
   (`:223-230`). `noun()` strips `<>` and turns `-` into a space (`:190-192`), so `<session-id>`
   reads as `session id` — the string `packages/code/tests/unit/cli-args.test.ts:191` asserts.
6. `--help` short-circuits, then `--version` (`:236-237`) — both **before** mode-conflict checking,
   so `--list --help` is `help`, not a conflict.
7. At most one `mode: true` flag; two or more →
   `` `${modes[0]} cannot be combined with ${rest.join(", ")}` `` (`:239-241`).
8. `--agent`/`--format` outside `--print` → `<flag> applies only with -p/--print` (`:244-247`).
9. `--debug=<x>` with an unrecognised `x` → `--debug must be one of error, warn, info, debug, got: x`
   (`:250-253`). A **bare** `--debug` stores `""` and is exempt from that check (`:252`).
10. Switch on the mode flag (`:258-280`). `--print` additionally rejects a whitespace-only prompt
    (`:261`) and a `--format` that is neither `text` nor `md` (`:262-264`); `format` defaults to
    `"text"` (`:262`). No mode flag → `{ kind: "run", ascii, debug }` (`:279`).

`ascii` (`:249`) is computed **unconditionally**, for every mode, unlike `--agent`/`--format`'s explicit
step-8 rejection outside `--print`. Only the three interactive `Mode` variants (`run`, `resume`,
`continue`) carry an `ascii` field in their returned object (`:264-279`); for `--print`, `--list`,
`--delete` and `--refresh-models`, the computed value is simply never attached to the returned `Mode`
and is silently discarded — `--refresh-models --ascii` parses without error and `--ascii` has no effect,
where `--format` in the same position would be a usage error. No test in
`packages/code/tests/unit/cli-args.test.ts` exercises `--ascii` combined with a headless mode flag; see
§8.

### 4.3 `resolveDebugRequest` — folding flag and environment

`packages/code/src/cli-args.ts:145-154`:

| `mode` has `debug`? | `--debug` present | `CLARVIS_CODE_DEBUG` | Result `enabled` | Result `level` |
|---|---|---|---|---|
| no (`help`/`version`/`usage-error`) | — | anything | `false` | `"debug"` |
| yes | no | absent | `false` | `"debug"` |
| yes | no | `"1"` | `true` | `"debug"` |
| yes | no | `"info"` | `true` | `"info"` |
| yes | no | `"off"` (or `""`/`"0"`/`"false"`/`"no"`) | `false` | `"debug"` |
| yes | yes (bare) | `"off"` | `true` | `"debug"` |
| yes | `--debug=warn` | `CLARVIS_CODE_DEBUG_LEVEL=error` | `true` | `"warn"` |
| yes | no | `CLARVIS_CODE_DEBUG_LEVEL="shout"` only | `false` | `"debug"` |

Every row above is an assertion in `packages/code/tests/unit/cli-args.test.ts:105-137`. Level
precedence is `mode.debug.level ?? debugLevel(CLARVIS_CODE_DEBUG_LEVEL) ?? debugLevel(CLARVIS_CODE_DEBUG) ?? "debug"`
(`packages/code/src/cli-args.ts:149,152`, default constant at `:108`).

The asymmetry between a bad level on the command line (usage error) and a bad level in the environment
(silently ignored) is stated at `packages/code/src/cli-args.ts:139-143`: "losing diagnostics to a typo
in a wrapper script is worse than recording more than was asked for — while the same typo on the
command line is a usage error, because a person typed it and is there to read the answer."

### 4.4 `index.tsx` — `main()` dispatch

`packages/code/src/index.tsx:1312-1345`, wrapped by `detachObserved("code_main", …)` whose failure
handler writes `clarvis failed: <text>` and sets `process.exitCode = 1` (`:1340-1343`) — note it
sets the code rather than calling `process.exit`.

Before resolving diagnostics or dispatching a mode, `main` applies `--worktree`: it awaits
`bootstrapWorktree`, replaces the process workspace with the returned canonical checkout, and sets
`CLARVIS_WORKSPACE_ROOT` (`:1307-1311`).

| `mode.kind` | Handler | Line |
|---|---|---|
| `usage-error` | stderr `<message>\n<usageText()>`, exit 1 | 1315-1317 |
| `help` | stdout `helpText()`, exit 0 | 1318-1320 |
| `version` | stdout `versionText()`, exit 0 | 1321-1323 |
| `print` | `runPrintMode(mode)` | 1324-1325 |
| `refresh-models` | `runRefreshMode()` | 1326-1327 |
| `list` | `runListMode()` | 1328-1329 |
| `delete` | `runDeleteMode(mode.id)` | 1330-1331 |
| `resume` / `continue` / `run` | `runApp(mode, debug)` | 1332-1336 |

Before the switch, `openHeadlessDiagnostics(mode, debug)` opens a diagnostic session for every
**non**-interactive mode (`:1294-1303`); the interactive path opens its own inside `runApp` "because
it must re-register the exit handler behind the platform's so renderer teardown is recorded before
`diagnostics.stop`" (`:1290-1292`).

### 4.5 The headless modes

**`bootSilentSessionStore()`** (`packages/code/src/index.tsx:176-196`) is the shared prelude for `--list`, the
resume/continue preflight and `--delete`: it creates a `WorkspaceClientManager` over `workspace` +
`globalRoot()`, with `logger: activeDiagnosticLogger() ?? createLogger("silent")`, opens a client and
loads the owner's session store. Its TSDoc records that `runPrintMode` boots its **own** kernel
instead "it needs `keySources` and `memory: true`, neither of which a silent listing/delete command
has any use for" (`:167-169`).

**`runPrintMode`** (`packages/code/src/index.tsx:247-371`):
1. Builds `ClarvisDirs` from `globalPaths()`/`workspacePaths(workspace)`/`workspaceStatePaths(workspace)` (`:247-251`).
2. Creates a `CodeConfigStore` inside a `createRoot` to get `keySources()` (`:252-255`).
3. `createFileKernel({ workspaceRoot, globalDir, keySources, memory: true, logger,
   openMcpAuthorizationUrl: openPublicUrl })` (`:251-258`). `--print` is headless only in its output
   and elicitation policy: a remote MCP OAuth challenge may still open the system browser.
4. If `--agent` was not given, resolves one: `kernel.listAgents()` + `loadAgentFiles` + settings +
   `readEnvView()`, filters to runnable candidates via `agentReadiness`, prefers `code.agentDefault()`
   when it is present and runnable, else `automaticAgentFallback` (`:264-302`). Failure writes
   `no interactive entry agent configured — pass --agent or set a default` and exits 1 (`:303-309`).
5. Starts the run with a fresh `exec_` id and the prompt as a single user message (`:311-316`).
6. Registers an elicit handler that **auto-declines** every request, writing
   `<kind> auto-denied (headless): <first line>` to stderr (`:317-324`).
7. Chooses a sink: `format: "md"` builds a `TranscriptStore`, seeds it with the user message, and
   prints `renderTranscriptMarkdown(store.nodes)` at the end (`:329-338`); otherwise
   `createPrintStream` streams to stdout and appends a trailing newline only if anything printed
   (`:339-349`).
8. `drainPrintEvents(handle.events, { onEvent, onNotice })` (`:350-353`).
9. `await handle.done` → `await transcriptDone` → `finish()` → dispose store → `await drained` →
   `kernel.close()` (`:354-359`).
10. Non-`completed` status: stderr `run ${status}: ${reason}` and exit 1; else exit 0 (`:360-365`).
11. Any throw: `print failed: <text>`, close the kernel swallowing errors, exit 1 (`:366-370`).

**`createPrintStream`** (`packages/code/src/cli-mode.ts:40-71`) filters to `agent === "lead"` and `channel === "text"`
(`:49`), inserts a blank-line separator between iterations (`:44-46, 51-52`), honours an in-iteration
`reset` by writing one newline (`:54-57`), and — on `iteration_completed` — prints the whole response
only when that iteration streamed nothing (`:61-68`), because "streaming may be unavailable on some
providers" (`:37-38`).

**`drainPrintEvents`** (`packages/code/src/cli-mode.ts:82-103`) returns two promises. `transcriptDone` is
`Promise.race([runEnded, drained])` (`:102`), so the answer prints at `run_ended` rather than at
stream exhaustion; `drained` stays alive until the stream closes, which the TSDoc says is what "lets
the index pass finish, with its notices narrating the wait via `onNotice`" (`:74-81`). A
`memory_ingest` event is routed to `onNotice` and never to `onEvent` (`:91-94`). A stream failure is
swallowed (`:98-100`) with the stated reason "A failed stream still settles the run's `done` with a
terminal result."

**`runListMode`** (`packages/code/src/index.tsx:198-221`), **`runDeleteMode`** (`:367-396`) and **`runRefreshMode`**
(`:404-422`) each boot, act, close and `process.exit` — none of them return.

### 4.6 `runApp` — the interactive boot sequence

`packages/code/src/index.tsx` (`runApp`), in order:

| # | Step | Line |
|---|---|---|
| 1 | `assertInteractiveTTY()` — exits 2 if either stream is not a TTY | 400 |
| 2 | open/install optional diagnostics, print its path, register a provisional exit close, emit `app.boot.begin` | 402-420 |
| 3 | for `resume`/`continue`, preflight the session in this selected workspace | 422-423 |
| 4 | read dev/SSH settings and create the renderer | `runApp` |
| 5 | mount one Solid root with the parser-free `BootFrame`, wait for renderer idle and emit `app.boot.shell-painted` | `runApp`, `packages/code/src/views/BootFrame.tsx` |
| 6 | create the process's single `WorkspaceClientManager` with memory and key sources | 466-487 |
| 7 | establish immutable workspace identity; create stores, config, history, run client and capabilities | 488-686 |
| 8 | `bootFoundation()` without reading the models.dev catalog; on failure mount `runFatalBoot` and retry | `runApp`, `loadFoundation` |
| 9 | list profiles, resolve the current Git branch asynchronously, mark connection ready | 801-819 |
| 10 | create and publish workspace adapters; build/bind the run host and shutdown cleanup | 821-1007 |
| 11 | create the Tasks controller and the five `App` control groups | 1009-1236 |
| 12 | replace `BootFrame` with `<App>` inside the existing root and emit mounted/painted diagnostics | `runApp` |
| 13 | after `app.boot.painted`, release durable memory-queue recovery and start Markdown parser warm-up; for `resume`/`continue`, resolve the selected workspace's session, await warm-up and then load it | `runApp` |

Two orderings the code annotates explicitly:

- The exit handler for diagnostics is registered twice (steps 2 and 5). The comment at
  `packages/code/src/index.tsx:421-424` states why: "Cover failures before the renderer/platform exists. Once the
  platform installs its own exit restoration below, move this handler behind it so renderer teardown
  remains visible before diagnostics.stop."
- Markdown warm-up begins immediately after the usable application shell paints, so worker startup
  cannot compete with that frame. Restored session content is not published until warm-up settles.
  Production: `packages/code/src/index.tsx` (`preloadMarkdown`, `markdownPreload`, `appProps`,
  `app.boot.painted`) and `packages/code/src/views/BootFrame.tsx`. Test:
  `packages/code/tooling/artifact/smoke.ts`.
- Durable memory-queue recovery is released immediately after the same `app.boot.painted` boundary.
  Kernel construction and the earlier shell/application paints do not start an index pass.
  Production: `packages/code/src/index.tsx` (`app.boot.painted`, `startMemoryRecovery`) and
  `packages/code/src/adapters/workspace-client-manager.ts` (`startMemoryRecovery`). Test:
  `packages/code/tests/architecture/architecture-boundary.test.ts` (paint-before-recovery order).
- Application command composition performs no sandbox host inspection. The null probe is a passing
  deferred readiness state; Doctor recheck and Settings > Sandbox are the explicit inspection
  routes. Production: `packages/code/src/app/commands.tsx` (`refreshSandboxInspection`,
  `inspectReadiness`). Test: `packages/code/tests/integration/app-commands.test.tsx` ("sandbox
  inspection is deferred until an explicit Doctor recheck").

`debugSession` is built even when `--debug` was absent, with the stated reason: "a diagnostic channel
you can only ask for before the failure you want it for is no channel" (`packages/code/src/index.tsx:458-461`).

Both code-host kernel paths supply the same browser opener: `runPrintMode` passes it directly and
the interactive path passes it through `WorkspaceClientManager.create`
(`packages/code/src/index.tsx:251-258`, `:495-510`). `openPublicUrl` accepts only HTTP(S), uses an
argv-based platform launcher, and returns `false` on parse, protocol, spawn or exit failure
(`packages/code/src/adapters/platform.ts:118-139`). That boolean lets the MCP client report an
explicit interactive-authorization-unavailable error. Other Clarvis hosts do not gain a browser
side effect merely because the file kernel supports the port; omission is the headless contract.

**Step 10's `activate()` indirection.** `createWorkspaceAdapters` (`packages/code/src/index.tsx:838-923`) builds a
`WorkspaceAdaptersSnapshot` whose `appearanceActive` signal starts `false` (`:884`), and two
`createEffect`s — one setting the renderer's background color, one calling `applyAsciiMode` — both
return immediately when `appearanceActive()` is false (`:889-899`). The same object exposes an
`activate()` closure that, in a `batch`, flips `appearanceActive` to `true` and bumps a companion
`appearanceRevision` signal the two effects also read (`:900-905`). `createWorkspaceAdapters` itself
never calls `activate()`; only `publishWorkspaceAdapters` does, as its last step (`:918-925`). So
building the snapshot alone wires no background-color or ascii-mode effect — the effects exist but are
inert until the object is published. Unpinned: no test in `packages/code/tests/` references
`appearanceActive`, `appearanceRevision` or `.activate()`.

### 4.7 `loadFoundation` and the `BootPhase` ledger

`BootPhase` is `"connect" | "keys" | "agents" | "settings" | "agent-files" | "sessions" | "profiles"`
(`packages/code/src/index.tsx:399-403`). It is a mutable cursor set immediately before each step so the
`catch` can name the step that threw:

| Phase set at | Span | Work |
|---|---|---|
| `:693` | `boot.kernel-connect` | `client.connect()` (`:694`) |
| `:695` | `boot.keys` | `createKeysAdapter(client.secrets)` (`:696`) |
| `:702` | `boot.list-agents` | `client.config.listAgents()` (`:703-705`) |
| `:706` | `boot.settings` | `createSettingsAdapter(...)` (`:707-713`) |
| `:734` | `boot.agent-files` | `loadAgentFilesSnapshot(...)` (`:735-737`) |
| `:738` | (none) | `createSessionStore(... await loadSessions ...)` (`:739-744`) |
| `:801` | `boot.profiles` | `runClient.listProfiles(bootAgentSummaries)` (`:802-804`) |

`reportBootFailure` emits `boot.failed` with `{ phase, error, attempt }` (`:671-673`) and is extracted
from the `catch` for a coverage reason stated inline: "Extracted from the `catch` so Bun counts it as
its own unit; [cross-cutting/test-architecture.md](../cross-cutting/test-architecture.md) §3.7 records that a `catch` body's line counter is otherwise
satisfied by the enclosing `try`" (`:667-669`).

One agent listing serves the whole boot; `:698-705` records that "The settings adapter, the agent-file
snapshot and the profile catalogue each used to fetch their own, so a cold start read the fleet from
disk three times over."

The models catalogue is temporally lazy, not merely unawaited. `loadFoundation` never calls
`client.models.get()`. The single-flight `ensureModelsCatalog` starts the request only when Model,
Effort or Providers crosses its lazy route boundary, records `catalog.load.started`, and publishes
the projected catalog signal. Until then `liveCatalog` degrades every accessor to an
empty/`undefined` answer. Provider routes load their module and await the single-flight request
concurrently before mounting `ProvidersPanel`: its bootstrap `onMount` opens the picker immediately,
so mounting first would permanently choose the reduced no-catalog branch for that picker instance.
Production: `packages/code/src/index.tsx` (`loadFoundation`, `ensureModelsCatalog`, `liveCatalog`),
`packages/code/src/features/providers/commands.ts` (`registerProvidersCommands`), and
`packages/code/src/app/commands.tsx` (`setup.providers`). Test:
`packages/code/tests/integration/app-commands.test.tsx` ("the public model catalog is requested only
after a catalog-backed route opens" and "first-run setup waits for the lazy model catalog before
mounting its provider picker") and `packages/code/tooling/artifact/smoke.ts`.

### 4.8 `runFatalBoot` — the boot-failure screen

`packages/code/src/views/FatalBoot.tsx:63-115`. It mounts on the **bare** renderer via
`engine.attach` + `_render` with a manual `RendererContext.Provider` (`:72-82`), because it is
"Rendered before the keymap/theme exist — the token signals carry usable defaults, and keys are bound
straight off the renderer" (`:10-11`).

| State | Key | Effect | Line |
|---|---|---|---|
| idle | `r` | `setBusy(true)`, call `retry()` | 101-103 |
| idle | `ctrl+c` | call `quit()` (expected to exit); `q`, Escape and all other keys are ignored | 97-101 |
| idle | anything else | ignored | 101 |
| busy | any | ignored (`if (busy()) return`) | 96 |
| retry resolved | — | `close(true)`: unhook keypress + destroy listener, hide, dispose the Solid root, resolve | 85-93, 104 |
| retry rejected | — | `setMessage(errorText(e))`, `setBusy(false)` — the screen stays up for another attempt | 105-109 |
| renderer destroyed | — | `close(false)` — resolve without clearing | 94, 113 |

`index.tsx`'s `retry` closure disposes the failed run client first, then re-runs `bootFoundation()`,
re-reporting any failure before rethrowing so the screen sees it (`packages/code/src/index.tsx:789-796`); `quit`
destroys the renderer inside a `try`/empty-`catch`, releases the terminal and exits 1 (`:791-797`).

`packages/code/tests/integration/fatal-boot-render.test.tsx:74-101` additionally pins that the root is
disposed on success — after `settled`, a freshly rendered `<text>APP_MOUNTED</text>` is the only thing
on screen and the renderer's `destroy` listener count is back to `rootsBefore + 1`.

### 4.9 Launch-time worktree selection

`--worktree [name]` is resolved before diagnostics, a kernel, a session store, or the TUI is created
(`packages/code/src/index.tsx:1312-1320`). `bootstrapWorktree` then pins the process to the returned
canonical checkout by replacing `workspace` and setting `CLARVIS_WORKSPACE_ROOT`; there is no
in-process worktree switch or worktree-management hub.

`bootstrapWorktree` (`packages/code/src/bootstrap/worktree.ts:145-205`) resolves the starting Git
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
(`packages/code/src/bootstrap/worktree.ts:42-85`). Production behavior is pinned by
`packages/code/tests/integration/worktree-bootstrap.test.ts` (create, reopen, inherited Git
environment isolation, primary anchoring, ignore protection, clean removal, dirty refusal,
generated name, path collision and invalid name) and parsing is
pinned by `packages/code/tests/unit/cli-args.test.ts`.

**Callback identity remains local, not a switching API.** `createWorkspaceCallbackTarget` is a
one-slot box and `isActiveWorkspaceCallbackTarget` accepts only the same still-bound object
(`packages/code/src/app/workspace-runtime.ts:1-30`). The run host binds it once and shutdown clears it
(`packages/code/src/index.tsx:985-1013`), preventing a late callback after teardown.

### 4.10 Layout breakpoints

`layoutModeFromDims` (`packages/code/src/app/layout.ts:51-56`):

| Condition | `LayoutMode` |
|---|---|
| `w < 24 \|\| h < 6` | `floor` |
| `w < 72` | `single` |
| `w < 100` | `narrow` |
| otherwise | `wide` |

`secondaryMode` (`packages/code/src/app/layout.ts`, `createLayoutController`):

| `hasSidebarContent` | `w >= 100` | `drawerOpen` | result |
|---|---|---|---|
| false | — | — | `closed` |
| true | true | — | `split` |
| true | false | true | `drawer` |
| true | false | false | `closed` |

`sidebarVisible` is exactly `secondaryMode() === "split"`; `contentInset` is `sidebarWidth()`
when visible, else `0`. `sidebarWidth` is `clamp(round(w * 0.32), 32, 56)` then clamped again
to the viewport, so a 24-column terminal yields `24` — pinned at
`packages/code/tests/unit/layout.test.ts:71-73`. In split mode, `TranscriptRegion.splitOpen()` also
opts transcript blocks and inline elicitation cards into the full width of the remaining left pane;
the pane's flex boundary, not a second arithmetic inset, stops them at the sidebar
(`packages/code/src/views/app/TranscriptRegion.tsx:80-86,184-243`). The 200-column shell regression
pins content beyond the old 110-column cap and no transcript text past the sidebar at
`packages/code/tests/integration/app-shell-render.test.tsx:1490-1530`.

There is no stored sidebar preference and no global toggle. At 100 columns or wider, content opens
the split automatically. Below that threshold the visible compact activity strip may set
`drawerOpen`; Escape closes the drawer. Content disappearing closes either presentation regardless
of the drawer signal. Production: `packages/code/src/app/layout.ts` (`createLayoutController`) and
`packages/code/src/views/App.tsx` (`compactActivityStrip`, `dismissTopOverlay`). Tests:
`packages/code/tests/unit/layout.test.ts` and
`packages/code/tests/integration/app-shell-render.test.tsx`.

### 4.11 The floor screen

Two independent mechanisms, both in `App.tsx`:

1. `refuseAtFloor()` returns true at `layoutMode() === "floor"` and is checked before opening
   Activity Detail or a managed-worktree exit prompt. Its TSDoc states the reason: "An overlay
   opened underneath it painted a shredded card *over* that message — destroying the one instruction
   that could get the user out — so the request is refused here rather than at each opener"
   (`:334-342`).
2. The floor panel itself is rendered last, absolutely positioned, at `zIndex={FLOAT_Z + 2}`
   (`packages/code/src/views/App.tsx:1309-1331`), showing `terminal too small` and
   `needs ${FLOOR_MIN_COLUMNS}x${FLOOR_MIN_ROWS}, have ${w}x${h}` — i.e. `needs 24x6, have …`. The
   inline comment says this second half stops "one already open from covering the message" (`:1310-1313`).

`packages/code/tests/integration/app-shell-render.test.tsx` mounts at 20×8 and asserts
`needs 24x6` while the ordinary composer controls remain absent.

### 4.12 `App`'s own composition order

`App` (`packages/code/src/views/App.tsx:201`) builds, in order: syntax-style binding (`:202-203`), hint state (`:204`), memory
pressure controller (`:205-238`), terminal dims + layout controller (`:245-260`), transcript state
(`:261-272`), overlay host (`:301-307`), quit confirm (`:309-315`), the `InteractionEffects` object
(`:355-473`), `createInteraction` (`:478-483`), `createCommands` (`:546`), and finally
`registerCodeCommands(...)` (`:638-709`) whose `dispose` is registered on cleanup together with the
overlay host, commands and interaction (`:711-720`).

**Quit confirm** (`createQuitConfirm`, `packages/code/src/views/quit-confirm.ts:42-80`) is App's own
"press again to quit" gate, and `App` wires it at `:309-314` with `isDirtyView: () =>
overlays.viewDirty()`, `isRunActive: () => props.run.active()`, `isDraftNonEmpty: () =>
(inputEl?.plainText ?? "").trim().length > 0`, `notify` and a `requestFinalQuit` indirection; its
`.quit` is what `InteractionEffects.quit` calls, and its `.disarm` is called during teardown. The
gate's own contract type is `QuitConfirm = { quit(opts: { confirm: boolean }): void; disarm(): void
}` over `QuitConfirmDeps` (`quit-confirm.ts:4-16`).

`createQuitConfirm`'s own TSDoc states the two calling conventions: `confirm: true` "always arms the
gate — the first call only notifies and starts a [1500ms] window, and quitting happens on a second
call inside that window"; `confirm: false` "is for a caller that has already spent a keystroke on the
decision (the double-tap `^C` path, and `/quit`, where typing the command is itself explicit): it
quits immediately from a state where nothing is at stake." (`:20-29`). But the gate does not simply
trust that flag: "**The gate still arms whenever work would be lost**, whatever the flag says — a
dirty view or a live run. It used to check only the dirty view, and `/quit` passes `confirm: false`,
so typing it mid-run discarded a run in flight with no prompt at all." (`:31-36`) — mechanically,
`atStake = dirtyView || deps.isRunActive()` and the gate arms whenever `confirm || atStake` (`:57-59`).
A non-empty draft is deliberately excluded from that arming set: "Running `/quit` from the composer
leaves the command itself sitting in the draft, so counting it would make the slash command arm
against its own text." (`:38-40`) — `isDraftNonEmpty` is consulted only to pick the *wording* of an
already-armed prompt (`" (unsaved changes)"` > `" (run active)"` > `" (draft unsaved)"` > none,
`:61-67`), never to decide whether to arm. `disarm()` clears `pending` and cancels the pending
`setTimeout` (`:46-52`); the window itself resets `pending` and clears the toast via
`deps.notify("")` when it elapses unconfirmed (`:70-74`).
`packages/code/tests/unit/quit-confirm.test.ts` pins the double-tap arm/confirm cycle, the
draft-alone-does-not-arm case (line 75), the run-active wording (line 46), and the `/quit`-mid-run
scenario the TSDoc names (line 64); `packages/code/tests/integration/interaction.test.ts:352` cross-references
the double-tap `^C` path this gate was written for.

`requestFinalQuit` delegates directly to `props.shell.quit` for a normal checkout and performs the
asynchronous clean-worktree check for a managed checkout. A clean result mounts
`WorktreeExitPrompt`; keep continues shutdown immediately, remove awaits workspace close plus Git
cleanup before starting shutdown, and Escape returns to the app. This second prompt does not weaken
the dirty-view/live-run gate: it runs only after that gate accepts the quit request.

`registerCodeCommands` (`packages/code/src/app/command-composition.ts:34-63`) opens **one** feature scope, registers the
providers and agents feature commands into it (`:36-51`), then calls `registerAppCommands(deps)`
(`:52`), and returns the app wiring with a `dispose` that is idempotent and disposes the app
registration before the feature scope (`:53-62`). `registerAppCommands` itself opens its own scope and
shadows the four registration methods so everything it registers lands there (`packages/code/src/app/commands.tsx:168-176`).

The render tree returned by `App` is, top to bottom: `KeymapProvider` →
`HeaderRows` → a one-row top rule → the region box holding `OverlayRegion` with `TranscriptRegion` as
its fallback → the floating pickers/readers (`ProfilePicker`, lazy `SafetyPresetPicker`,
`ActivityDetail`, `WorktreeExitPrompt`) as
**siblings
after** the region → `HintToast` → the bottom box (`MemoryPressureBanner`, `PlanStrip`, `InputDock`,
`Footer`) → the floor panel.

The two-route overlay rule is stated at `packages/code/src/views/App.tsx:194-199`: a kind that owns the whole region (`view`,
`diff`, `plan`) is rendered by `OverlayRegion` which swaps out the transcript; a picker is a floating
card mounted as a sibling after the region "so the transcript keeps rendering behind it — moving it
into the region's switch would black out everything the scrim exists to show through."

**`OverlayRegion` itself** (`packages/code/src/views/app/OverlayRegion.tsx:52-77`) is a Solid `<Switch fallback={props.fallback}>`
over `props.host.overlay()` with three `<Match>` arms: `"view"` (only when `props.host.views().length
> 0`) renders every mounted view frame inside a `<For>`, each wrapped in a `box` whose `visible` tracks
`frame.host.active()`; `"diff"` renders `DiffViewer`; `"plan"` renders `PlanOverlay`, wired to
`props.activity.plan`, `props.plans`, `props.notify`, `props.planOrigin` and an `onClose` that calls
`props.host.dismissTop()`. Its own TSDoc names the omission: "A picker kind such as `agentPicker` is
deliberately not here… so it reaches this switch as the fallback rather than as a `Match`. Anything
else unrecognized falls back the same way, which is what keeps an unknown kind from blanking the
screen." (`:41-50`). `ActivityDetail` follows this floating route through App's `activityDetail`
transient overlay kind: opening a bounded activity preview stores the full content, blocks transcript
input behind the scrim. Escape restores it; Ctrl+C remains the global cancel-or-quit route. Production: `openActivityDetail` and the
`activityDetail` render branch in `packages/code/src/views/App.tsx`; pinned by
`packages/code/tests/integration/app-shell-render.test.tsx` and
`activity-detail-render.test.tsx`. `OverlayRegionProps.plans` is `PlansService | undefined`, and its own TSDoc gives
the reason: "Absent until a backend supplies one; `PlanOverlay` declares the same prop optional and
opens on its task list rather than its history when it is missing, so requiring it here only made this
component stricter than the one it forwards to." (`:30-35`).

Each `"view"` frame is painted through the module-level `renderMountedView` (`:12-21`), which wraps
`frame.factory(frame.host)` in Solid's `untrack` and records `diagnosticCount("overlay.view.factory",
undefined, "overlay.view.factory")` first. Its own comment states why the reactive read must be
suppressed: "A view factory creates its own reactive owner and effects. Do not let the surrounding
`<For>` mapper subscribe to signals the factory reads during construction, or any async state update
will execute the factory again, remounting the page and restarting its I/O in an unbounded feedback
loop." (`:13-16`). `packages/code/tests/integration/overlay-region-render.test.tsx` exercises all three
`Match` arms plus the `"view"`-with-zero-views fallback case, and pins the single-mount guarantee
`renderMountedView` protects (line 224: "an empty `WorkflowsHub` inside `OverlayRegion` performs one
mount and one initial list").

### 4.13 `PageFrame` and `Splash`

`PageFrame` (`packages/code/src/views/PageFrame.tsx:16-56`) is three boxes: a `height={1}` title row that is opaque and
`zIndex={1}` (`:30`), a `flexGrow` content region with `overflow="hidden"` (`:47`), and an
`InteractionNavigationBar` footer that is also opaque and `zIndex={1}` (`:52-53`). The clip is
load-bearing: `packages/code/tests/integration/page-frame-clip.test.tsx:14-42` reproduces the two-box shape at 80×5
with an unwrapped `<Splash>` child and shows that `overflow="visible"` lets the absolutely-positioned,
vertically-centred wordmark paint into the title row while `"hidden"` does not. Its three consumers
are `DiffViewer` (`packages/code/src/views/overlays/DiffViewer.tsx:43`), `PlanOverlay` (`packages/code/src/views/overlays/PlanOverlay.tsx:521`)
and `Help` (`packages/code/src/views/overlays/Help.tsx:193`).

`Splash` (`packages/code/src/views/Splash.tsx`, `Splash`) is absolutely positioned with `right = rightInset?.() ?? 0` so a
visible sidebar does not get painted under (`:51-53, 59`), and shows the gradient `BANNER` at ≥60
columns or `glyph("diamond") + SPLASH_WORDMARK` below (`:25-28`). It is mounted by `TranscriptRegion`
only when the transcript is empty, no elicitation is pending and the draft is empty
(`packages/code/src/views/app/TranscriptRegion.tsx:244-253`), and `TranscriptRegion`'s root box clips for the same
reason `PageFrame`'s does (`packages/code/src/views/app/TranscriptRegion.tsx:62-76`).

The guided setup and its catalog pickers deliberately do not use that compact fallback. `SetupView`
and bootstrap `CatalogPicker` both gate `BrandBanner` through `firstRunSplashFits`, so the same complete
eight-row splash remains present throughout the first-run journey or is absent throughout when the
terminal cannot fit it. Production: `packages/code/src/views/onboarding/SetupView.tsx` (`SetupView`),
`packages/code/src/views/config/CatalogPicker.tsx` (`CatalogPicker`), and
`packages/code/src/views/Splash.tsx` (`firstRunSplashFits`). Tests:
`packages/code/tests/integration/onboarding-render.test.tsx`,
`packages/code/tests/integration/catalog-picker-render.test.tsx`, and
`packages/code/tests/integration/providers-key-render.test.tsx` (both bootstrap picker steps).

`HeaderRows` (`packages/code/src/views/HeaderRows.tsx:15-68`) renders exactly one `height={1}` row: brand wordmark,
workspace chip, optional identity chip, an `Index` over status chips, a `flexGrow` spacer, then
optional exception and urgent chips. It is a pure projection of `HeaderPlan`, computed by
`projectHeader` (`packages/code/src/views/header-projection.ts:173-221`).

#### 4.13.1 `projectHeader`: priority-zoned chips and their elision ladder

`HeaderInput` (`packages/code/src/views/header-projection.ts:9-26`) is the one shell snapshot the row is derived
from — `width`, `floor`, `agentName`, `model`, `safetyPreset`, `guardMode`, `sandboxUnavailable?`,
`memoryConfigured`, `memory`, `plans`, `connection`, `doctorDirty`, `workspace`, `workspaceLabel?`,
`branch?` — and its own TSDoc records why so many fields survive unused by the current row: "Legacy
configuration fields remain input so App owns one derivation point" (`:9`). `HeaderFieldKey` is the
closed union `"workspace" | "identity" | "model" | "safety" | "memory" | "urgent" | "exception"`
(`:28-29`); a `HeaderField` is `{ key, text, color, elastic }` (`:31-36`); `HeaderPlan` is
`{ regime: "one-line", workspace, identity?, status: HeaderField[], urgent?, exception? }`
(`:39-46`).

The row's own TSDoc states its layout model directly: "The row is two groups, not a list: who you are
and how the next run is configured read as one separator-joined run of text on the left, and what is
happening or wrong sits against the right edge. The flexible gap between them is the boundary, which
is why the first field after it carries no separator of its own — a `·` stranded after several columns
of whitespace separates nothing. Everything inside a group does carry one, so the model no longer butts
against the agent name across a gap." (`:159-171`).

**Reserved columns.** `BRAND_COLS = 10` is "the painted brand zone: the row's left padding plus
`◆ Clarvis`" (`:55-56`); `WORKSPACE_FLOOR = 14` is "held back so the workspace name never truncates
away entirely" (`:57-58`); `IDENTITY_FLOOR = 10` is held back "for the active agent name when it is on
the row at all" (`:59-60`), and is skipped entirely in `floor` mode. `cols()` measures with
`Bun.stringWidth` (`:51-53`); `separator()` is two spaces, `glyph("separator")`, two spaces (`:48-50`).

**Left-of-gap zones — computed unconditionally.** `workspace` (`:175-176`) resolves to
`input.workspaceLabel ?? basename(input.workspace) || input.workspace || "workspace"`, appending
`" (branch)"` when `input.branch` is set (`:177`), and is always `elastic: true` and coloured
`tokens.fg` (`:203-208`). `identity` (`:209-216`) is `input.agentName` in `tokens.muted`, `elastic:
true`, and is entirely omitted when `input.floor` is set.

**Right-of-gap zones — computed first, because they bound the room left for status chips.**
`urgentField` (`:63-73`) fires whenever `input.connection.phase !== "ready"`: a warning glyph plus
`connectionLabel(input.connection, input.width < 72)` in `tokens.warn`, never elastic. `exceptionField`
(`:75-98`) is a strict priority chain evaluated only when `exceptionAllowed` (`input.width >= 100`,
`:179`): `sandboxUnavailable` ("Sandbox unavailable") outranks a `free` safety preset ("Safety: free"),
which is itself only checked when the caller passes `includeSafety: true`, which outranks
`doctorDirty` ("Doctor needs attention") — all three render in `tokens.warn`. Both are computed before
`room` so their reserved width (`cols(urgent.text) + cols(sep)` and, for `exception`, the wider of the
`includeSafety: true`/`false` renderings plus a separator, `:180-185`) is subtracted first
(`:186-192`); the wider-of-two-renderings probe exists because whether `exception` will end up
absorbing the safety warning is not known until after `statusChips` has run.

**`statusChips` — the elision ladder** (`:117-159`). `modelNames` (`:101-106`) reduces `input.model`
through `parseModelRef` to its `modelId`, then to the substring after the last `/` as the `short` form.
`memoryLabel` (`:109-111`) maps `memory === "off"` to `"off"` and anything else — including `"inert"` —
to `"on"`, because ("Memory as the rest of the product states it — `inert` is still configured, so it
reads `on`", `:108`). Five candidate chip sets are tried widest-first, and the first whose summed width
(chip text plus one separator each) fits `room` wins (`:121-146`):

| Rung | Chips |
|---|---|
| 1 | `model.full`, `Safety: {preset}`, `Memory: {memory}` |
| 2 | `model.short`, `Safety: {preset}`, `Memory: {memory}` |
| 3 | `model.short`, `{preset}`, `mem {memory}` |
| 4 | `model.short`, `{preset}` |
| 5 | `model.short` |

If none fits, `statusChips` returns `[]` (`:147`). The model chip is always `tokens.fg`; the safety
chip is `tokens.warn` when `preset === "free"`, else `tokens.muted`; the memory chip is always
`tokens.muted` (`:151-157`).

**Assembly.** `room` (`:186-192`) is `width − BRAND_COLS − WORKSPACE_FLOOR − (floor ? 0 : IDENTITY_FLOOR)
− (urgent reserved) − (exception reserved)`. `exception` is only actually computed, past the
`exceptionAllowed` gate, with `includeSafety` set to whether the chosen chip rung already carries a
`"safety"` key (`:194-196`) — so a visible "Safety: free" chip suppresses the redundant "Safety: free"
exception, and `free` is "stated once" as its own test names it. Every status chip and every
right-of-gap field except the first in its group is prefixed with a fresh `separator()`; the first
field after the flexible gap (whichever of `exception`/`urgent` is present and first) carries none
(`:197-200`), which is the mechanical form of the TSDoc rule quoted above.
`packages/code/tests/unit/header-projection.test.ts` pins every rung of the ladder (lines 74-84),
the two-groups separator rule (lines 34-61), the sandbox-outranks-doctor and free-stated-once
priorities (lines 92-107), and the floor-mode identity drop (line 109); the render side is pinned by
`packages/code/tests/integration/header-render.test.tsx`.

### 4.14 Three `index.tsx` behaviors §2.5 names but does not narrate

**`AppSessionControls.resumeCatalog` and `.delete`** are strictly current-workspace operations
(`packages/code/src/index.tsx:1151-1175`). `catalog()` projects only
`listSessionsForWorkspace(sessionStore, workspaceRef().id)` and marks every row available.
`resumeCatalog(item)` resumes `item.meta.id` directly. `delete(item)` loads from the one session
store, clears the active session when ids match, and deletes the session and its runs through the
current run client. No temporary client or cross-workspace branch exists.

**`reconnectBackend`** (`packages/code/src/index.tsx:1016-1039`): refuses immediately, with no reconnect
attempt, while a run is active (`"run in progress " + glyph("emDash") + " cancel it before reconnecting"`). Otherwise it sets
connection state to `connecting`, calls `runClient.reconnect()`, then reloads keys, settings and agent
files and re-lists profiles, sets connection to `ready` (with detail `"no profiles"` when the list is
empty), and returns `{ ok: true, message: "backend reconnected " + glyph("emDash") + " keys applied" }`
(`:1015-1024`). A throw anywhere in that sequence sets connection to `failed` and returns
`` { ok: false, message: `reconnect failed ${glyph("emDash")} restart clarvis (${errorText(e)})` } ``
(`:1025-1030`).

**`exportSession`/`writeExportChunk`** (`packages/code/src/index.tsx:1079-1108`): `writeExportChunk`
writes a chunk's UTF-8 bytes in a loop over `output.write(bytes, offset, …)`, advancing `offset` by
`written.bytesWritten` each pass and throwing `new Error("export write made no progress")` the moment a
write returns `bytesWritten <= 0` (`:1073-1080`). `exportSession` resolves the export directory, opens
the target file `"w", 0o600`, writes the Markdown header via `writeExportChunk`, then iterates
`for await (const nodes of runHost.exportNodeBatches())` and writes every chunk `renderTranscriptMarkdownChunks(nodes)`
yields through the same guarded writer, closing the handle in a `finally` (`:1083-1097`); any thrown
error — including the guard's own — is caught and reported as `export failed: <text>` (`:1098-1101`).

## 5. Invariants

Each invariant names the production line it is about and the test that pins it. "unpinned" means no
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

**INV-CB-3a.** `--update` reaches the updater only through a dynamic import before bundle/source
entry resolution, so ordinary startup and `--version` do not load the update graph or perform a
release request. Production: `packages/code/src/cli.ts` and `packages/code/src/index.tsx` (`update`
branches). Pinned: `packages/code/tests/architecture/cli-fast-path.test.ts` (dynamic updater import)
and `packages/code/tests/unit/update-command.test.ts` (unmanaged invocation fetches nothing). The
archive and activation contract belongs to
[distribution and updates](../cross-cutting/distribution-and-updates.md).

**INV-CB-4.** The static-import walker used by INV-CB-1..3 distinguishes value, type-only and dynamic
forms.
Pinned by a self-test: `packages/code/tests/architecture/cli-fast-path.test.ts:100-113`.

**INV-CB-5 (owns INV-243).** No file under `src/core/**` imports `solid-js`, any `@opentui/*`, any
`@clarvis/kernel*`, `@clarvis/paths`, `node:fs`, `node:fs/promises`, or anything resolving into
`adapters/`, `infrastructure/`, `theme/`, `ui/` or `views/`.
Pinned: `packages/code/tests/architecture/architecture-boundary.test.ts:72-89`.
Note: `src/infrastructure/` does not exist (`packages/code/src/` listing), so that clause is currently
vacuous.

**INV-CB-6 (owns INV-244).** No file under `src/adapters/**` imports anything resolving into `ui/` or
`views/`.
Pinned: `packages/code/tests/architecture/architecture-boundary.test.ts:91-97`.

**INV-CB-7 (owns INV-245).** No file under `src/ui/**` imports `@clarvis/kernel*`, or anything
resolving into `adapters/` or `features/`.
Pinned: `packages/code/tests/architecture/architecture-boundary.test.ts:99-107`.

**INV-CB-8 (owns INV-246).** No `src/features/**/controller.ts` imports anything resolving into
`theme/`, `ui/` or `views/`, nor any specifier ending in `.tsx`.
Pinned: `packages/code/tests/architecture/architecture-boundary.test.ts:109-119`. Three controllers are
in scope: `features/{agents,providers,tasks}/controller.ts`.
Note the asymmetry with INV-CB-5: the four boundary checks count **type-only** imports as violations —
the walker at `packages/code/tests/architecture/architecture-boundary.test.ts:36-48` records every `ImportDeclaration` regardless of
`isTypeOnly`, and `:121-136` is a self-test proving a `import type { HintTone } from "../views/hint.ts"`
is seen. `packages/code/src/app/command-composition.ts:7` is exactly such an import and is legal only because `app/` is
not one of the four constrained layers.

**INV-CB-9 (owns INV-251).** Every `@clarvis/kernel…` specifier anywhere in `src/` **or `tests/`** is
one of the five sanctioned entrypoints (`@clarvis/kernel`, `/bootstrap`, `/config`, `/policy`,
`/local`), and none of `@clarvis/{capability,loop,memory,plan,tools,skills,tasks,workflows}` appears at
all.
Pinned: `packages/code/tests/architecture/dependency-boundary.test.ts:73-87` (entrypoint set `:6-12`,
forbidden list `:13-22`). In this subsystem the only kernel import is
`createFileKernel, createLogger` from `@clarvis/kernel/bootstrap` (`packages/code/src/index.tsx:11`).

**INV-CB-9a.** The specifier walker behind INV-CB-9 recognizes type-only, re-exported, side-effect and
dynamic `import()` forms, not just plain value imports.
Pinned by a self-test: `packages/code/tests/architecture/dependency-boundary.test.ts:55-71` — it feeds
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
Production: `packages/code/package.json:34-36`.
Pinned: `packages/code/tests/architecture/dependency-boundary.test.ts`, "imports only its declared
Clarvis dependencies and approved kernel entrypoints".

**INV-CB-11.** `resolveEntry` precedence is `forceSource` → `distExists` → error; `CLARVIS_CODE_SOURCE=1`
wins over a present bundle.
Production: `packages/code/src/cli-entry.ts:38-39`.
Pinned: `packages/code/tests/unit/cli-entry.test.ts:6-19`.

**INV-CB-12.** The missing-bundle message names the path and all three remedies.
Production: `packages/code/src/cli-entry.ts:42-47`.
Pinned: `packages/code/tests/unit/cli-entry.test.ts:21-29`.

**INV-CB-13.** `FLAGS` is the sole source for `--help`, the usage line **and** the package README's CLI
section — every flag token and every `desc` string appears in all three.
Production: `packages/code/src/cli-args.ts:68-91, 163-183`.
Pinned: `packages/code/tests/unit/cli-args.test.ts:206-215` and `:217-223`.

**INV-CB-14.** At most one `mode: true` flag per invocation; two or more is a usage error naming all of
them.
Production: `packages/code/src/cli-args.ts:239-241`.
Pinned: `packages/code/tests/unit/cli-args.test.ts:171-178`.

**INV-CB-15.** `--agent` and `--format` are legal only alongside `-p/--print`.
Production: `packages/code/src/cli-args.ts:244-247`.
Pinned: `packages/code/tests/unit/cli-args.test.ts:161-162`.

**INV-CB-16.** `--help` and `--version` short-circuit before mode-conflict validation, so they can
never produce a usage error.
Production: `packages/code/src/cli-args.ts:236-237` (before `:239`).
Pinned indirectly: `packages/code/tests/unit/cli-args.test.ts:37-39` asserts the bare forms; **no test
asserts the short-circuit against a conflicting flag** (e.g. `--list --help`). Unpinned in that respect.

**INV-CB-17.** A `--debug=<x>` naming no level is a usage error; the same typo in
`CLARVIS_CODE_DEBUG_LEVEL` is ignored and the default level stands.
Production: `packages/code/src/cli-args.ts:252-253` versus `:149` (via `debugLevel`'s `undefined`
return at `:122-128`).
Pinned: `packages/code/tests/unit/cli-args.test.ts:89-94` and `:130-133`.

**INV-CB-18.** The `--debug` flag overrides the environment in both directions: it enables against
`CLARVIS_CODE_DEBUG=off`, and `--debug=<level>` overrides `CLARVIS_CODE_DEBUG_LEVEL`.
Production: `packages/code/src/cli-args.ts:151-152`.
Pinned: `packages/code/tests/unit/cli-args.test.ts:122-129`.

**INV-CB-19.** `update`/`help`/`version`/`usage-error` never open a diagnostic session, whatever the
environment says, because those `Mode` variants carry no `debug` member.
Production: `packages/code/src/cli-args.ts:34-44` (union) and `:146` (the `"debug" in mode` guard).
Pinned: `packages/code/tests/unit/cli-args.test.ts:134-137`.

**INV-CB-20.** `--continue` is strict to the current workspace and never falls back to a global most
recent session.
Production: `packages/code/src/cli-mode.ts:32` filtering through `listSessionsForWorkspace`
(`packages/code/src/adapters/session-store.ts:252-255`).
Pinned: `packages/code/tests/unit/cli-mode.test.ts:38-49`.

**INV-CB-21.** `--print` writes only the lead agent's `text` channel to stdout; sub-agent output and
the reasoning channel never reach it.
Production: `packages/code/src/cli-mode.ts:49, 62`.
Pinned: `packages/code/tests/unit/cli-mode.test.ts:94-100`.

**INV-CB-22.** A `--print` transcript settles at `run_ended` rather than at stream exhaustion, and a
stream that closes without `run_ended` still settles it.
Production: `packages/code/src/cli-mode.ts:96, 102`.
Pinned: `packages/code/tests/unit/cli-mode.test.ts:171` and `:192`.

**INV-CB-23.** `runApp` refuses a non-TTY with exit code 2 and a message naming every headless mode.
Production: `packages/code/src/index.tsx:431` → `packages/code/src/adapters/platform.ts:201-207`.
Pinned: `packages/code/tests/integration/platform-lifecycle.test.ts:88-98` (and `:99-107` for stdin).

**INV-CB-24.** Worktree selection completes before any host service boots, and the selected canonical
checkout is the process workspace for every mode that accepts `--worktree`.
Production: `packages/code/src/index.tsx:1312-1320`.
Pinned: `packages/code/tests/unit/cli-args.test.ts` (mode propagation) and
`packages/code/tests/integration/worktree-bootstrap.test.ts` (canonical create/reopen results).

**INV-CB-25.** Git's registered worktree list is the sole registry; an existing destination that Git
does not register is refused rather than adopted.
Production: `packages/code/src/bootstrap/worktree.ts:167-185`.
Pinned: `packages/code/tests/integration/worktree-bootstrap.test.ts` (reopen and collision cases).

**INV-CB-26.** Worktree bootstrap never uses a shell and does not inherit repository-local Git
environment variables; prompts are disabled and output/time are bounded.
Production: `packages/code/src/bootstrap/worktree.ts:42-85`.
Pinned for inherited `GIT_INDEX_FILE` isolation:
`packages/code/tests/integration/worktree-bootstrap.test.ts:42-65`; the argv-only spawn, prompt
variables and timeout/output caps are unpinned.

**INV-CB-29.** A managed checkout can be removed on exit only after an explicit `y`, only after two
cleanliness checks, and only through non-forced `git worktree remove`; its branch is preserved and
the requested cleanup completes before the bounded platform-shutdown sequence begins. An external
checkout's parent is never treated as Clarvis-owned.
Production: `WorktreeExitPrompt` in `packages/code/src/views/overlays/WorktreeExitPrompt.tsx`,
`worktreeIsClean` and `removeWorktreeCheckout` in `packages/code/src/bootstrap/worktree.ts`, and the
pre-shutdown close/removal path in `packages/code/src/index.tsx`. Pinned:
`packages/code/tests/integration/app-shell-render.test.tsx` (remove/keep/dirty UI paths) and
`packages/code/tests/integration/worktree-bootstrap.test.ts` (clean removal, branch retention, dirty
refusal, external-parent retention and external reopen without primary setup).

**INV-CB-30.** The primary checkout's `.clarvis/.gitignore` effectively ignores `worktrees/` before
any nested checkout is created, and launching from a linked checkout still targets the primary root.
Production: `ensureWorktreeIgnore` and `bootstrapWorktree` in
`packages/code/src/bootstrap/worktree.ts`; `ensureWorkspaceDir` in `packages/paths/src/ensure.ts`.
Pinned: `packages/code/tests/integration/worktree-bootstrap.test.ts` and
`packages/paths/tests/integration/ensure.test.ts`.

**INV-CB-27.** A callback target is accepted only while it is the published, still-bound target;
`clear()` makes it inert.
Production: `packages/code/src/app/workspace-runtime.ts:1-30`.
Pinned: `packages/code/tests/unit/workspace-runtime.test.ts`.

**INV-CB-28.** Interactive runtime switching is absent: the only advertised `switching` accessor is
the constant false value used by the generic App shell.
Production: `packages/code/src/index.tsx:1149`; `WorkspaceClientManager.open` rejects any id other
than its immutable current workspace (`packages/code/src/adapters/workspace-client-manager.ts`).
Pinned: `packages/code/tests/component/workspace-client-manager.test.ts`.

**INV-CB-29.** The layout floor is 24 columns × 6 rows; below either dimension the mode is `floor`.
Production: `packages/code/src/app/layout.ts:47-52`.
Pinned: `packages/code/tests/unit/layout.test.ts:34-56`.

**INV-CB-30.** The split sidebar opens only at ≥100 columns and only when content exists. There is no
sidebar preference or toggle command; below the split threshold the explicit drawer signal is the
only way to show the secondary surface, and `contentInset` stays 0.
Production: `packages/code/src/app/layout.ts` (`createLayoutController`) and
`packages/code/src/views/App.tsx` (`compactActivityStrip`).
Pinned: `packages/code/tests/unit/layout.test.ts` and
`packages/code/tests/integration/app-shell-render.test.tsx`.

**INV-CB-31.** `sidebarWidth` never exceeds the viewport, so the inspector's nominal 32-column minimum
degrades rather than overflowing on a 24-column terminal.
Production: `packages/code/src/app/layout.ts` (`createLayoutController.sidebarWidth`).
Pinned: `packages/code/tests/unit/layout.test.ts:71-73`.

**INV-CB-32.** At the floor, no overlay may be opened, and the floor message paints above the float
layer so an already-open overlay cannot cover it.
Production: `packages/code/src/views/App.tsx:343, 377, 396, 1324`.
Pinned: `packages/code/tests/integration/app-shell-render.test.tsx:415-427`.

**INV-CB-33.** `runFatalBoot` accepts `r` repeatedly until one retry succeeds, ignores keys while a
retry is in flight, and routes only `ctrl+c` to `quit`; `q` and Escape are inert.
Production: `packages/code/src/views/FatalBoot.tsx:95-110`.
Pinned: `packages/code/tests/integration/fatal-boot-render.test.tsx:12-48` and `:50-72`.

**INV-CB-34.** `runFatalBoot` disposes its Solid root on success, so the application mounts alone
rather than on top of it.
Production: `packages/code/src/views/FatalBoot.tsx:85-93` (`dispose()` at `:91`).
Pinned: `packages/code/tests/integration/fatal-boot-render.test.tsx:74-101`.

**INV-CB-35.** `PageFrame`'s content region clips, so an over-tall or absolutely-positioned child can
never composite over the title row.
Production: `packages/code/src/views/PageFrame.tsx:47` (rule stated at `:11-14`).
Pinned: `packages/code/tests/integration/page-frame-clip.test.tsx:32-42`.

**INV-CB-36.** The splash falls back to a one-line wordmark below 60 columns, and the banner art is 8
rows each under 60 columns wide.
Production: `packages/code/src/views/Splash.tsx` (`BANNER`, `BrandBanner`).
Pinned: `packages/code/tests/integration/splash-render.test.tsx:29-38`.

**INV-CB-37.** `HeaderRows` is one terminal row.
Production: `packages/code/src/views/HeaderRows.tsx:18-19` (`height={1}` on the only row box, inside the single column wrapper at `:17`).
Pinned: `packages/code/tests/integration/header-render.test.tsx:42-52` — the fixture places a rule and
a `BODY` line after the header and asserts they land on rows 1 and 2.

**INV-CB-38.** `registerCodeCommands`'s `dispose` is idempotent and releases the app registration
before the feature scope.
Production: `packages/code/src/app/command-composition.ts:53-62`.
Unpinned — no test in `packages/code/tests/` calls `registerCodeCommands().dispose()` twice; `App`
calls it once from `onCleanup` (`packages/code/src/views/App.tsx:717`).

**INV-CB-39.** `src/cli.ts` and `src/index.tsx` are both absent from LCOV by design and must stay on
`NO_COUNTER_ALLOWLIST`, with the stated reason "Importing either from a test starts a terminal UI".
Production: `tooling/checks/coverage.ts:73-76`.
Self-pinning: `tooling/checks/coverage.ts:450` reports allowlist entries that are no longer needed.

**INV-CB-40.** `CLARVIS_AGENT_TOOLS_MAX_GRANT` defaults to `"exec"` before any kernel is constructed,
and only if unset.
Production: `packages/code/src/index.tsx:142` (`??=`, at module top level, before `main()` runs at
`:1305`).
Unpinned.

**INV-CB-41.** Interactive durable memory recovery begins only after the usable application paint;
reconnecting after that release starts recovery on the replacement kernel without moving work back
onto the cold-boot path.
Production: `packages/code/src/index.tsx` (`app.boot.painted`, `startMemoryRecovery`) and
`packages/code/src/adapters/workspace-client-manager.ts` (`startMemoryRecovery`, `reconnect`).
Pinned: `packages/code/tests/architecture/architecture-boundary.test.ts` (paint-before-recovery
order) and `packages/kernel/tests/integration/owner-isolation.test.ts` (idempotent release and later
owner startup).

## 6. Failure modes and degradation

| Situation | Handling | Exit / effect | Cite |
|---|---|---|---|
| No `dist/index.js` and no `CLARVIS_CODE_SOURCE` | full remedy text on stderr | exit 1 | `packages/code/src/cli.ts:43-46`, `packages/code/src/cli-entry.ts:40-49` |
| Unknown flag / missing value / mode conflict / bad `--print` prompt or format | `usage-error` mode; **not** intercepted by `cli.ts`, so the whole app loads first | stderr `<message>\n<usage>`, exit 1 | `packages/code/src/cli.ts:14-16`, `packages/code/src/index.tsx:1322-1324` |
| stdout or stdin is not a TTY in an interactive mode | guidance naming every headless mode | exit 2 | `packages/code/src/adapters/platform.ts:201-207` |
| `--resume <id>` names no session | `session not found: <id> — run clarvis --list` | exit 1 | `packages/code/src/index.tsx:209-223` |
| `--continue` with no session in this workspace | `no session to continue in this workspace — run clarvis --list` | exit 1 | `packages/code/src/index.tsx:209-223` |
| `--delete <id>` names no session | `session not found: <id>` | exit 1 | `packages/code/src/index.tsx:352-360` |
| `--delete` trace deletion fails per run | per-execution `try/catch` returning `false`; counted in the summary as `okTraces/total` | exit 0 regardless | `packages/code/src/index.tsx:361-376` |
| `--refresh-models` throws | `refresh failed: <text>` | exit 1 | `packages/code/src/index.tsx:379-396` |
| `--update` is unmanaged, unsupported, concurrent, untrusted, or fails staging | one bounded `clarvis update failed: <reason>` line; active version unchanged | exit 1 | `packages/code/src/update/index.ts`, [distribution failure modes](../cross-cutting/distribution-and-updates.md#6-failure-modes-and-degradation) |
| `--print` with no resolvable entry agent | `no interactive entry agent configured — pass --agent or set a default` | exit 1 | `packages/code/src/index.tsx:248-288` |
| `--print` run does not complete | `run <status>: <error.message ?? ended_reason ?? status>` | exit 1 | `packages/code/src/index.tsx:333-344` |
| `--print` throws anywhere | `print failed: <text>`; kernel close errors swallowed | exit 1 | `packages/code/src/index.tsx:345-348` |
| `--print` receives an elicitation | auto-declined, one stderr line per request | run continues | `packages/code/src/index.tsx:291-303` |
| `--print` event stream throws mid-iteration | swallowed; `drained` still resolves | the run's `done` still settles | `packages/code/src/cli-mode.ts:98-100` |
| Tree-sitter Markdown warm-up fails | `markdown.preload.failed` at `warn`; the already-usable shell continues unhighlighted | degrade | `packages/code/src/index.tsx` (`markdownPreload`) |
| `loadFoundation` throws on boot | `boot.failed` with the phase, connection → `failed`, `runFatalBoot` retry screen | interactive retry; `q` exits 1 | `packages/code/src/index.tsx` (`loadFoundation`, `bootFoundation`, `runFatalBoot`) |
| A retry inside `runFatalBoot` throws | message replaced on the same screen, `busy` cleared, screen stays | retryable | `packages/code/src/views/FatalBoot.tsx:105-109` |
| `boot.profiles` throws | reported, then **rethrown** — no fatal-boot screen, so it escapes to `detachObserved("code_main")` | `clarvis failed: …`, `process.exitCode = 1` | `packages/code/src/index.tsx:808-814`, `:1340-1343` |
| Models catalogue unavailable after a catalog surface requests it | `catalog.unavailable` at `warn` with `source: "kernel" \| "snapshot"`; `liveCatalog` answers empty on every accessor | picker empty, boot is unaffected | `packages/code/src/index.tsx` (`ensureModelsCatalog`, `liveCatalog`) |
| Worktree branch lookup fails | `worktree.branch.unavailable` at `warn`; header branch stays `undefined` | degrade | `packages/code/src/index.tsx:815-821` |
| Prompt-history persistence fails | `historyFailure` string pushed into the run status line | degrade | `packages/code/src/index.tsx:517-562, 990` |
| Session store errors | routed to `setRunStatus` through `onError` | degrade | `packages/code/src/index.tsx:745-751` |
| `reconnectBackend` while a run is active | refuses with an explanatory message, no reconnect attempted | `{ ok: false, message }` | `packages/code/src/index.tsx:1016-1021` |
| `reconnectBackend` throws | connection → `failed`, `reconnect failed — restart clarvis (<text>)` | `{ ok: false }` | `packages/code/src/index.tsx:1032-1037` |
| Session export fails | `export failed: <text>` returned as the status string | degrade | `packages/code/src/index.tsx:1090-1108` |
| An export write makes no progress | `new Error("export write made no progress")` | caught by the above | `packages/code/src/index.tsx:1080-1087` |
| `--worktree` is outside Git, names an invalid branch segment, collides with an unregistered path, or Git fails/times out/overflows | bootstrap rejects before any kernel/session/TUI starts | top-level `clarvis failed: <text>`, soft exit 1 | `packages/code/src/bootstrap/worktree.ts:42-85`, `:96-113`, `:145-205`; `packages/code/src/index.tsx:1314-1318` |
| Worktree ignore protection cannot be created or verified | bootstrap rejects before `git worktree add` or any kernel/session/TUI starts | top-level `clarvis failed: <text>`, soft exit 1 | `ensureWorktreeIgnore` in `packages/code/src/bootstrap/worktree.ts`; `seedFile` in `packages/paths/src/ensure.ts` |
| Exit cleanup sees new pending changes or `git worktree remove` fails | checkout and branch are kept; `worktree.remove.failed` records the error before normal exit continues | normal exit | `removeWorktreeCheckout` in `packages/code/src/bootstrap/worktree.ts`; pre-shutdown removal in `packages/code/src/index.tsx` |
| Resume of a named session fails at boot | `resume failed: <text>` into the status line | degrade | `packages/code/src/index.tsx:1280-1292` |
| Any unhandled failure in `main` | `clarvis failed: <text>` on stderr; `process.exitCode = 1` (process still drains) | soft exit 1 | `packages/code/src/index.tsx:1347-1350` |
| Any detached UI task fails | `task.failed` diagnostic with `{ operation, error, observed }`; the observer's own throw becomes `task.observer_failed` | never escapes | `packages/code/src/core/tasks.ts:22-45` |

## 7. Coupling

### 7.1 Outward (runtime, static)

| From | To | Nature | Cite |
|---|---|---|---|
| `cli.ts` | `node:fs`, `node:url` | value | `packages/code/src/cli.ts:21-22` |
| `cli.ts` | `./cli-args.ts`, `./cli-entry.ts` | value | `packages/code/src/cli.ts:23-24` |
| `cli-args.ts` | root `../../../package.json` | value (the **only** one), product version | `packages/code/src/cli-args.ts` |
| `index.tsx` | `@clarvis/paths` | value: `globalPaths`, `globalRoot`, `workspacePaths`, `workspaceRoot`, `workspaceStatePaths` | `packages/code/src/index.tsx:1-7` |
| `index.tsx` | `@clarvis/kernel/bootstrap` | value: `createFileKernel`, `createLogger` — the package's only kernel import in this subsystem | `packages/code/src/index.tsx:11` |
| `index.tsx` | `@opentui/core`, `@opentui/solid`, `solid-js` | value | `packages/code/src/index.tsx:12-14` |
| `index.tsx` | `node:fs`, `node:fs/promises`, `node:path` | value | `packages/code/src/index.tsx:8-10` |
| `views/App.tsx` | `../app/command-composition.ts` | value: `registerCodeCommands` | `packages/code/src/views/App.tsx:27` |
| `views/App.tsx` | `../app/layout.ts` | value | `packages/code/src/views/App.tsx` |
| `app/command-composition.ts` | `./commands.tsx`, `../features/{agents,providers}/commands.ts` | value | `packages/code/src/app/command-composition.ts:8-10` |
| `app/commands.tsx` | lightweight route metadata, controllers and adapters; registered config/help screens enter through `lazyView` dynamic imports | mixed | `packages/code/src/app/commands.tsx`, `packages/code/src/views/config/lazy-view.tsx` |

### 7.2 Outward (type-only)

`cli-args.ts` imports `SessionId` from `./adapters/session-store.ts` and `DiagnosticLevel` from
`./core/diagnostic-events.ts` as **types** (`packages/code/src/cli-args.ts:13-14`); the file's remark says
`verbatimModuleSyntax` erases them and that this is what keeps INV-CB-3 true (`:6-8`). `cli-mode.ts`
imports `RunEvent` from `@clarvis/protocol` as a type (`packages/code/src/cli-mode.ts:10`) but `listSessionsForWorkspace`
and `memoryNoticeStatus`/`plainStatusLine` as values (`:11-17`) — which is precisely why it is a
separate module from `cli-args.ts` and why the flag table is "deliberately **not** re-exported from
here — a barrel would put this file's imports back on `cli.ts`'s fast path" (`packages/code/src/cli-mode.ts:6-8`).

### 7.3 Inward

| Consumer | What it uses | Cite |
|---|---|---|
| `src/index.tsx` | `helpText`, `parseMode`, `resolveDebugRequest`, `usageText`, `versionText`, `Mode`, `PrintFormat`, `DebugRequest` | `packages/code/src/index.tsx:25-34` |
| `src/index.tsx` | `createPrintStream`, `drainPrintEvents`, `resolveResumeMeta` | `packages/code/src/index.tsx:35` |
| `src/index.tsx` | `createWorkspaceCallbackTarget`, `isActiveWorkspaceCallbackTarget`, `WorkspaceCallbackTarget` | `packages/code/src/index.tsx:106-109` |
| `src/index.tsx` | `bootstrapWorktree`, `runBootstrapGit`, `worktreeIsClean`, `removeWorktreeCheckout`, `WorktreeBootstrapResult` | `packages/code/src/index.tsx` |
| `src/index.tsx` | `runFatalBoot` | `packages/code/src/index.tsx:117` |
| `src/index.tsx` | `App` + its five props interfaces | `packages/code/src/index.tsx:132-139` |
| `views/App.tsx` | `createLayoutController`, `FLOOR_MIN_COLUMNS`, `FLOOR_MIN_ROWS` | `packages/code/src/views/App.tsx:68` |
| `views/app/TranscriptRegion.tsx` | `Splash` | `packages/code/src/views/app/TranscriptRegion.tsx:16` |
| `views/onboarding/{SetupView,RecoveryView}.tsx` | `BrandBanner`; Setup also uses `firstRunSplashFits` | the corresponding imports in each onboarding view |
| `views/config/CatalogPicker.tsx` | `BANNER`, `BrandBanner`, `firstRunSplashFits` | the first-run picker intro |
| `views/overlays/{DiffViewer,PlanOverlay,Help}.tsx` | `PageFrame` | `packages/code/src/views/overlays/DiffViewer.tsx:9`, `packages/code/src/views/overlays/PlanOverlay.tsx:25`, `packages/code/src/views/overlays/Help.tsx:12` |
| `packages/code/tooling/artifact/build.ts` (via the `build` script) | `src/index.tsx` as the bundle entry | `packages/code/package.json:18` |

### 7.4 What forces the direction

- **The bin points at `cli.ts`, not `index.tsx`** (`packages/code/package.json:8`), so `cli.ts`'s import closure is
  the launch cost; `packages/code/tests/architecture/cli-fast-path.test.ts:81-83` is what makes that measurable and enforced.
- **`cli-args.ts` cannot import `cli-mode.ts`** (or anything else) without failing
  `packages/code/tests/architecture/cli-fast-path.test.ts:94-98`; the split exists only to satisfy that.
- **`views/App.tsx` imports `app/command-composition.ts`, not the reverse** — `command-composition.ts`
  imports only adapter/feature types and `commands.tsx` (`packages/code/src/app/command-composition.ts:1-10`), while
  `commands.tsx` imports `views/config/*` freely (`packages/code/src/app/commands.tsx:60-72`). No test forbids the reverse
  edge; the four boundary rules do not cover `app/`.
- **`index.tsx` is the only place all layers meet.** It imports `adapters/`, `core/`, `theme/`,
  `features/`, `app/`, `views/`, `onboarding/` and `@clarvis/kernel/bootstrap` together
  (`packages/code/src/index.tsx:1-139`). Nothing imports `index.tsx` except the bundler and `cli.ts`'s dynamic import.
- **`@clarvis/paths` is a `core/` violation but an `index.tsx` legality**: `packages/code/tests/architecture/architecture-boundary.test.ts:81`
  forbids `@clarvis/paths` under `core/` specifically, and `index.tsx` sits outside every constrained
  layer.

### 7.5 `adapters/errors.ts` — a duplicate kept for the sake of INV-CB-9

`errorText` (`packages/code/src/adapters/errors.ts:18-19`, `return e instanceof Error ? e.message :
String(e)`) is a byte-for-byte copy of `@clarvis/kernel/policy`'s function of the same name, not a
re-export. The file's own `@remarks` states why: "fourteen modules across `code/src` import it —
including several on the path evaluated before the first frame. `kernel/src/policy.ts` re-exports the
run-event mappers and reaches `@clarvis/loop/host`, so that one line dragged roughly 250 files and
several hundred zod schema constructions onto the pre-paint module graph, to obtain a two-line function"
(`packages/code/src/adapters/errors.ts:8-13`) — i.e. importing the real thing would satisfy INV-CB-9 (only
the five sanctioned `@clarvis/kernel` entrypoints, §5) but would defeat the fast-path measurement
`cli-fast-path.test.ts` exists to hold (§7.4's first bullet). The duplication is pinned identical to its
source rather than merely similar: `packages/code/tests/unit/errors.test.ts:23-27` imports both
`errorText` from `../../src/adapters/errors.ts` and `@clarvis/kernel/policy`'s and asserts the two agree
on ten cases spanning both branches (a plain `Error`, a subclass, an `Error` with a `cause`, an empty
message, a bare string, a number, `null`, `undefined`, a non-`Error` object shaped like one, and a
`Symbol`) — so a future edit to the kernel's version that this copy does not follow would fail the test
rather than silently drift.

Its importers span every layer this document's boundary rules separate: `run-host.ts:13`, `index.tsx:52`,
`views/App.tsx:62`, `views/FatalBoot.tsx:5`, `views/overlay-host.ts:7`, `onboarding/doctor.ts:17`,
`app/commands.tsx:76`, nine `views/config/*.tsx` screens, `features/{agents,providers}/events.ts:2`, and
`adapters/{marketplace,plugin-install}.ts:11,1` — all importing the same relative `./errors.ts` (or
`../adapters/errors.ts`) sibling rather than reaching past it into the kernel.

## 8. Open questions

1. ~~**`--continue`'s preflight is dead as written.**~~ **Resolved:** it was the `null`/`undefined`
   slip, and the comparison is now `!== null` (`packages/code/src/index.tsx:229`), so a workspace with
   no session prints "no session to continue in this workspace" (`:232`) and exits 1 instead of
   booting the full TUI to land on `setRunStatus("session not found")`. `resolveResumeMeta`
   still returns `SessionMeta | null` (`packages/code/src/cli-mode.ts:30`, `:32`); the `resume` branch
   is checked against the same selected workspace session store. `index.tsx` remains on `NO_COUNTER_ALLOWLIST`
   (`tooling/checks/coverage.ts:76`), so the preflight itself is still untested — what is pinned is
   the shape that made the old comparison wrong: a miss is `null`, never `undefined`
   (`packages/code/tests/unit/cli-mode.test.ts:29`-`:36`).
2. **`src/index.tsx` — 1,343 lines at 2026-08-23, the entire interactive boot — has no direct test.**
   It is allowlisted out of coverage (`tooling/checks/coverage.ts:137`) for the stated reason that
   importing it starts a terminal UI. Everything in §4.6, §4.7 and the `index.tsx` half of §4.9 is
   therefore unpinned except where a helper it calls has its own test. The nearest thing to end-to-end
   coverage is `packages/code/tooling/artifact/smoke.ts` driven by `bun run smoke`
   (`packages/code/package.json:19`), which belongs to the build-tooling document.
   **Recorded 2026-08-22**: the allowlist entry now carries what closing it would take — either
   splitting the boot into importable steps (argument mode selection, kernel construction, session
   restore, the one-shot `--print` path), or growing the smoke harness past being a smoke test. Both
   are real work with a real cost, and neither is owed by any change in flight, so it stays recorded
   rather than quietly treated as covered. The gap itself is unchanged.
3. **Why the four boundary rules count type-only imports as violations while `cli-fast-path` exempts
   them** is not stated anywhere. Mechanically the two walkers differ:
   `packages/code/tests/architecture/architecture-boundary.test.ts:36-48` ignores `isTypeOnly`, `packages/code/tests/architecture/cli-fast-path.test.ts:34, 72` honours
   it. No comment or assertion message explains the difference.
4. **The exact `AppCommandDeps` contents and app command registrations** are out of scope
   here — `app/commands.tsx` is 1,394 lines and belongs to the [hosts/code-input-and-overlays.md](code-input-and-overlays.md) document.
   This spec covers only its two exported types, its scope-shadowing construction
   (`packages/code/src/app/commands.tsx:168-176`) and the composition wrapper.
5. **Run streaming, `run-host.ts`, `kernel-run-client.ts`, `WorkspaceClientManager` and the transcript
   store** are named here only as the objects `index.tsx` assembles. Their contracts belong to
   [hosts/code-run-host.md](code-run-host.md).
6. **The `dist/index.js` bundle's own contract** — what `packages/code/tooling/artifact/build.ts` externalises, what assets
   it copies, what `tests/architecture/artifact-contract.test.ts` asserts — belongs to
   [cross-cutting/build-and-ci.md](../cross-cutting/build-and-ci.md). This spec establishes only that `cli.ts` prefers that path when it
   exists (`packages/code/src/cli.ts:36-48`).
7. **The `847-file` and `~2.5 s` figures** appear four times in this subsystem's own prose
   (`packages/code/src/cli.ts:11`, `packages/code/src/cli-entry.ts:9-12`, `packages/code/src/cli-args.ts:9`, `packages/code/tests/architecture/cli-fast-path.test.ts:12`) but are not
   re-derivable from the code; no benchmark in this document's scope measures them. `packages/code/tooling/benchmarks/first-paint.ts`
   exists (`packages/code/package.json:31`) but is outside this document's scope.
8. ~~**`--print`'s entry-agent resolution reads a `SettingsFile` cast.**~~ **Resolved:** the cast is
   gone. `agentReadiness` now takes a `ReadinessSettings` — `default_model` plus the provider names,
   which is all it ever read (`packages/code/src/adapters/agent-files.ts:186`-`:189`,
   `:210`-`:216`) — so `settingsView.merged` is passed as itself
   (`packages/code/src/index.tsx:294`). The question the cast raised is therefore moot rather than
   answered: nothing now asserts the whole `SettingsFile` shape, so nothing depends on whether the
   protocol's `merged` satisfies it.
9. **`INV-247` (the ASCII-source rule) and `INV-253`–`INV-266`** are `@clarvis/code` invariants owned
    by sibling documents; only `INV-243`–`INV-246` and `INV-248`–`INV-252` are restated above.
10. **No test exercises `registerCodeCommands`'s disposal ordering or idempotence** (INV-CB-38), nor
    the `--list --help` short-circuit (INV-CB-16), nor the `CLARVIS_AGENT_TOOLS_MAX_GRANT` default
    (INV-CB-40). Those are three concrete gaps in an otherwise well-pinned
    surface.
12. ~~**`HeaderRowsProps.agentName` is a dead prop.**~~ **Resolved by removal:** the prop is gone.
    `HeaderRowsProps` is now `{ plan: Accessor<HeaderPlan> }` (`packages/code/src/views/HeaderRows.tsx:8`-`:10`) and the
    call site passes only `plan` (`packages/code/src/views/App.tsx:1077`), which matches what the render
    body (`packages/code/src/views/HeaderRows.tsx:15`-`:68`) ever read. The active-agent name still reaches the row, but
    through `HeaderInput.agentName` → `projectHeader`'s `identity` field
    (`packages/code/src/views/header-projection.ts:13`, `:209`-`:216`), never as a prop.
12. **`--ascii` combined with a headless mode has no test.** `parseMode` computes `ascii` for every
    invocation (`packages/code/src/cli-args.ts:249`) but only attaches it to the `run`/`resume`/`continue` variants of
    `Mode`; for `--print`/`--list`/`--delete`/`--refresh-models` the value is silently dropped rather
    than rejected the way `--agent`/`--format` are outside `--print`. No test in
    `packages/code/tests/unit/cli-args.test.ts` asserts what `parseMode(["--refresh-models",
    "--ascii"])` returns, so whether this asymmetry with `--agent`/`--format` is intentional is not
    determinable from the code.
