# The tool contract: dispatch, config, registry and the advertised surface

> Implemented at `packages/tools/src/{core,config,errors,index}.ts`,
> `packages/tools/src/tools/{registry,types,content}.ts` and the package's `tests/architecture` and
> `tests/component` suites. Every claim below is anchored to a file and line. Open questions are
> collected in the final section.

## 1. Purpose

`@clarvis/tools` (`packages/tools`) exposes a fixed catalog of coding tools to an LLM agent as one
validated call surface. This document covers the load-bearing seam every individual tool sits
behind: a single dispatcher (`core.ts`) that validates a call's arguments, runs the optional
command-approval gate, invokes the tool's handler, and bounds its output — all against one resolved,
immutable `RuntimeConfig` (`config.ts`) built once per workspace by `resolveConfig`
(`packages/tools/src/config.ts:324`). The registry (`tools/registry.ts`) is the single table that
both the full and read-only surfaces are derived from, so there is exactly one place a tool is added,
removed, or reclassified. The package's own architecture tests pin two properties about this seam
that the type system cannot express on its own: that the advertised surface has one fixed size
(`packages/tools/tests/component/tool-surface.test.ts:32`), and that no model-facing refusal may name
the way around a restriction it just enforced
(`packages/tools/tests/architecture/no-bypass-hints.test.ts:81`).

The package also owns a negative property: it contains no source-code parser. `outline` and
`check_syntax`, and every capability flag and syntax annotation that went with them, were removed
together and are asserted absent by name
(`packages/tools/tests/architecture/no-tree-sitter.test.ts:73`-`81`), so a caller that dispatches
either name today gets the same `not_found` refusal as a typo
(`packages/tools/tests/component/tool-surface.test.ts:52`).

## 2. Surface

### Package exports (five `exports` keys, four real subpaths)

`packages/tools/package.json:29`-`51` declares five keys under `exports`: four subpaths each with a
`bun` (source), `types` and `import` (built) condition, plus a fifth, `./package.json`, that is a bare
self-reference string with none of those conditions (`packages/tools/package.json:50`):

| Subpath | Source entry | Consumer-facing purpose |
| --- | --- | --- |
| `.` | `packages/tools/src/index.ts` | the library facade: `createAgentTools`, `dispatch`, `listTools`, config, registry, errors, content — and, re-exported alongside them, the same shell, guard, process-kill and warn-sink bindings the `./shell`/`./guard` subpaths expose (see below) |
| `./guard` | `packages/tools/src/guard/index.ts` | the command-approval analysis surface (owned by the sibling [command-guard-and-approval](command-guard.md) document) |
| `./shell` | `packages/tools/src/shell-entry.ts` | shell resolution primitives (`resolveShell`, `shellArgs`, `encodePowerShellCommand`, `exitCaptureWrapper`, `currentShellFlavor`, plus `killTree`/`ownProcessGroup` and the `ShellSpec`/`ShellDeps`/`ShellFlavor`/`KillDeps`/`TaskkillRunner` types) re-exported for `@clarvis/hooks` and `@clarvis/kernel` without pulling in the rest of the tool API |
| `./sandbox` | `packages/tools/src/sandbox-entry.ts` | sandbox configuration types (owned by the sibling [sandbox-and-toolchains](sandbox.md) document) |
| `./package.json` | `package.json` itself | boilerplate self-reference (no `bun`/`types`/`import` condition); not a source entry and out of scope below |

`./shell` and `./guard` are not the *only* way to reach those bindings: root `.` re-exports the
identical shell primitives and the identical guard-analysis surface (see the root facade table below),
so a consumer that already imports `.` for anything else does not need the subpath at all — the
subpaths exist so `@clarvis/hooks` (for `./shell`) and the sibling guard document's consumers (for
`./guard`) can pull in only that surface without the rest of the tool API.

### `./shell` — `packages/tools/src/shell-entry.ts` (26 lines, re-exports only)

The module's own doc comment states the reason it exists rather than `.` alone: "`@clarvis/tools`'
root export pulls the whole tool registry - ajv, diff, tinyglobby and ripgrep - which is the wrong
price for a consumer that only needs to know which shell this host speaks and how to kill what it
spawned" (`packages/tools/src/shell-entry.ts:5`-`8`), and it pairs the two halves deliberately: "{@link
ownProcessGroup} decides what `spawn`'s `detached` option must be on this platform, and {@link
killTree} is what that decision exists to enable" (`:13`-`15`). It re-exports, with no logic of its
own:

| From | Symbols |
| --- | --- |
| `./shell.ts` (value) | `resolveShell`, `shellArgs`, `encodePowerShellCommand`, `exitCaptureWrapper`, `currentShellFlavor` (`packages/tools/src/shell-entry.ts:17`-`23`) |
| `./shell.ts` (type) | `ShellSpec`, `ShellDeps`, `ShellFlavor` (`:24`) |
| `./lib/process.ts` (value) | `killTree`, `ownProcessGroup` (`:25`) |
| `./lib/process.ts` (type) | `KillDeps`, `TaskkillRunner` (`:26`) |

**Verified consumers** (resolving the prior "declared-but-unverified" note — see §8's former entry,
now removed): `packages/hooks/src/subprocess.ts:21`-`26` imports `killTree`, `ownProcessGroup`,
`resolveShell`, `shellArgs` and the `ShellSpec` type from `@clarvis/tools/shell`, aliasing all four
functions with a `default*` prefix. `packages/kernel/src/local.ts:12`-`21` re-exports all seven value
symbols and both remaining types (`ShellSpec`, `ShellFlavor`) from `@clarvis/tools/shell` verbatim —
a consumer this document's own scope had not previously named. `packages/kernel/src/capability-executables/session-manager.ts:15`
imports only `killTree`/`ownProcessGroup` from it, to tear down a capability-executable's child
process tree the same way a `shell` tool call would. `packages/hooks/tests/unit/subprocess.test.ts:2`
imports `shellArgs` from the same subpath directly, confirming the export map resolves for a
consumer outside this package's own workspace-linked build.

### Root (`.`) facade — `packages/tools/src/index.ts`

| Symbol | Kind | Location | Contract |
| --- | --- | --- | --- |
| `AgentTools` | interface | `packages/tools/src/index.ts:11` | `{ config: RuntimeConfig; listTools(): ToolInfo[]; callTool(name, args?): Promise<DispatchResult> }` |
| `createAgentTools(options)` | function | `packages/tools/src/index.ts:36` | resolves `options` via `resolveConfig`, returns an `AgentTools` bound to that config |
| `dispatch(name, args, config, signal?, hooks?)` | function | `packages/tools/src/core.ts:200` | invokes one tool by name |
| `listTools(config)` | function | `packages/tools/src/core.ts:108` | lists the effective `ToolInfo[]` for a config |
| `resolveConfig(options)` | function | `packages/tools/src/config.ts:324` | builds a validated `RuntimeConfig` |
| `StartupError` | class | `packages/tools/src/config.ts:177` | thrown by `resolveConfig` on invalid startup options |
| thirteen `DEFAULT_*` limit constants | const | `packages/tools/src/config.ts:135`-`168` | see §3 |
| `tools`, `readOnlyTools`, `getTool`, `selectSurface` | value | `packages/tools/src/tools/registry.ts:73,79,102,90` | the registry (see §2's surface table below) |
| `ToolDef`, `ToolCallHooks` | type | `packages/tools/src/tools/types.ts:29,8` | one tool's schema+handler; optional live-output hooks |
| `ContentPart`, `TextPart`, `ImagePart`, `ToolResult`, `contentText` | type/fn | `tools/content.ts` | the result envelope shape |
| `ToolError`, `serializeError`, `fsError` | class/fn | `packages/tools/src/errors.ts:34,65,99` | the package's error type and its two renderers |
| `ErrorCode` | type | `packages/tools/src/errors.ts:8` | the closed union of 18 stable codes |
| `SandboxConfig` | type | `packages/tools/src/index.ts:66` | re-exported from `./sandbox.ts` |
| `resolveShell`, `shellArgs`, `encodePowerShellCommand`, `exitCaptureWrapper`, `currentShellFlavor` | fn | `packages/tools/src/index.ts:67`-`73` | shell resolution primitives, the same ones `./shell` exposes |
| `ShellSpec`, `ShellDeps`, `ShellFlavor` | type | `packages/tools/src/index.ts:74` | types for the shell primitives above |
| `executableOnPath`, `resolveCommand` | fn | `packages/tools/src/index.ts:75` | re-exported from `@clarvis/paths` |
| `killTree`, `ownProcessGroup` | fn | `packages/tools/src/index.ts:76` | process-tree kill primitives |
| `KillDeps`, `TaskkillRunner` | type | `packages/tools/src/index.ts:77` | types for the kill primitives above |
| `analyzeShell`, `posixDialect`, `POSIX_DEFAULT_ALLOWED_COMMANDS`, `WINDOWS_DEFAULT_ALLOWED_COMMANDS`, `buildGuardContext`, `withinWorkspace`, `touchesOutside` | fn/const | `packages/tools/src/index.ts:82`-`:90` | the guard-analysis surface, the same bindings `./guard` exposes |
| `Verdict`, `GuardDecision`, `Segment`, `ShellFacts`, `PathFact`, `GuardContext`, `Guard`, `ElicitRequest`, `Elicit`, `ShellDialect`, `Token`, `PathCandidate` | type | `packages/tools/src/index.ts:91`-`:104` | types for the guard-analysis surface above |
| `sweepMonitors` | fn | `packages/tools/src/index.ts:111` | background-monitor sweep housekeeping |
| `setWarnSink`, `warn`, `NOOP_TOOLS_LOGGER` | fn/const | `packages/tools/src/index.ts:113` | the package's warn-sink API |
| `WarnSink`, `ToolsLogger`, `ToolsWarning` | type | `packages/tools/src/index.ts:114` | types for the warn-sink API above |

`createAgentTools` is the package's "headline example": its options type makes every field but
`workspaceRoot` optional so `createAgentTools({ workspaceRoot })` alone works
(`packages/tools/src/config.ts:290`-`292`, documented on `AgentToolsOptions.logger`).

### Model-facing tool surface

The surface is a single ordered table, `toolDescriptors` (`packages/tools/src/tools/registry.ts:42`),
of `{ tool: ToolDef, readOnly: boolean }` pairs. `tools` is its full projection and `readOnlyTools` its
`readOnly`-filtered one (`packages/tools/src/tools/registry.ts:73`, `:79`); both preserve `toolDescriptors`' order. The oracle
of this table, `EXPECTED_TOOL_DESCRIPTORS`
(`packages/tools/tests/helpers/tool-surface.ts:15`), pins the presentation order and read-only flags,
verified equal to the production registry by
`packages/tools/tests/component/core.test.ts:26` (`toolDescriptors.map(...) .toEqual([...EXPECTED_TOOL_DESCRIPTORS])`):

| # | Tool name | Read-only |
| --- | --- | --- |
| 1 | `read_file` | yes |
| 2 | `read_image` | yes |
| 3 | `read_files` | yes |
| 4 | `write_file` | no |
| 5 | `edit_file` | no |
| 6 | `multi_edit` | no |
| 7 | `apply_patch` | no |
| 8 | `replace` | no |
| 9 | `list_dir` | yes |
| 10 | `glob` | yes |
| 11 | `grep` | yes |
| 12 | `diff` | yes |
| 13 | `shell` | no |
| 14 | `host_vcs` | no |
| 15 | `monitor_start` | no |
| 16 | `monitor_poll` | no |
| 17 | `monitor_stop` | no |
| 18 | `monitor_list` | no |
| 19 | `move` | no |
| 20 | `copy` | no |
| 21 | `mkdir` | no |
| 22 | `remove` | no |
| 23 | `file_stat` | yes |
| 24 | `tree` | yes |

24 tools total, 9 read-only (`read_file`, `read_image`, `read_files`, `list_dir`, `glob`, `grep`,
`diff`, `file_stat`, `tree`). Individual tool argument schemas and handler behaviour belong to the
three sibling `tools-*` documents; this document covers only that the table exists, is single-owned, and
is what `dispatch`/`listTools` consume.

### `ToolInfo` (model-visible descriptor) — `packages/tools/src/core.ts:91`

```ts
interface ToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
```

`listTools(config)` (`packages/tools/src/core.ts:108`) maps `selectSurface(config.readOnly)` to this shape, dropping the
handler. `selectSurface(readOnly)` (`packages/tools/src/tools/registry.ts:90`) returns `readOnlyTools` when `readOnly` is true,
else `tools`.

### `RuntimeConfig` — `packages/tools/src/config.ts:15`-`127`

The full field list, defaults and overrides are given in §3. The fields most relevant to dispatch
itself: `guard?: Guard`, `elicit?: Elicit` (consulted by `applyGuard`, `packages/tools/src/core.ts:130`), `readOnly:
boolean` (selects the surface), `confineToWorkspace: boolean`, `stateRoot: string`, and
`temporaryRoots: readonly string[]` (path-confinement
policy consumed by individual tools, not by `core.ts` itself), `maxOutputBytes` and `maxToolMetaBytes`
(consumed by `dispatch`'s own bounding step).
`registerTemporaryRoot(root)` is the validated dynamic half of the same contract: `shell` calls it
only for a newly-created, owner-controlled directory proven from an explicit system-temp `mktemp -d`
template; hosts may observe registration to include that root in run-end cleanup.
`gitMetadataPaths` is the immutable linked-worktree metadata-root list discovered while resolving the
config, before the agent can mutate `.git`; sandbox execution consumes the pinned roots rather than
re-reading mutable worktree pointers (`packages/tools/src/config.ts:94-98,324-330,445-449`). The
discovery and mount validation belong to [sandbox-and-toolchains](sandbox.md).

### `DispatchResult` — `packages/tools/src/core.ts:34`

```ts
interface DispatchResult {
  isError: boolean;
  content: ContentPart[];
  meta?: Record<string, unknown>;
  guard?: GuardReview;
}
```

`guard` is present when the host policy exposes its effective mode. It is the
final review fact — `{ mode, outcome, answerer }` — and accompanies both a
successful dispatch and a guard denial. Production: `DispatchResult`,
`GuardGate`, and `applyGuard` in `packages/tools/src/core.ts`; Test:
`"returns the final auto-guard verdict and answerer with the tool result"` in
`packages/tools/tests/integration/guard-dispatch.test.ts`.

## 3. Data and formats

### `RuntimeConfig` fields, defaults and minimums

Every numeric limit in `AgentToolsOptions` (`packages/tools/src/config.ts:234`) is optional and falls back to a
`DEFAULT_*` constant, then is re-validated by `requireMin` (`packages/tools/src/config.ts:215`) against a minimum.
Confirmed by `packages/tools/tests/integration/config.test.ts:18` (documented defaults) and `:106`
(each override's minimum, and the inverted-timeout-range rejection).

| Field | Default constant | Default value | Minimum | Source line |
| --- | --- | --- | --- | --- |
| `maxOutputBytes` | `DEFAULT_MAX_OUTPUT_BYTES` | `131072` | `1024` (`MIN_OUTPUT_BYTES`) | `packages/tools/src/config.ts:135,390` |
| `maxShellOutputBytes` | `DEFAULT_MAX_SHELL_OUTPUT_BYTES` | `16384` | `1024` | `packages/tools/src/config.ts:137,395` |
| `maxFileBytes` | `DEFAULT_MAX_FILE_BYTES` | `20_000_000` | `1024` (`MIN_FILE_BYTES`) | `packages/tools/src/config.ts:139,400` |
| `maxImageBytes` | `DEFAULT_MAX_IMAGE_BYTES` | `5_000_000` | `1024` | `packages/tools/src/config.ts:141,405` |
| `maxTraversalEntries` | `DEFAULT_MAX_TRAVERSAL_ENTRIES` | `50_000` | `1` | `packages/tools/src/config.ts:143,410` |
| `maxMutationBytes` | `DEFAULT_MAX_MUTATION_BYTES` | `64 * 1024 * 1024` | `1024` | `packages/tools/src/config.ts:145,415` |
| `maxDiffInputBytes` | `DEFAULT_MAX_DIFF_INPUT_BYTES` | `8 * 1024 * 1024` | `1024` | `packages/tools/src/config.ts:147,420` |
| `maxToolMetaBytes` | `DEFAULT_MAX_TOOL_META_BYTES` | `256 * 1024` | `1024` | `packages/tools/src/config.ts:149,425` |
| `shellTimeoutMs` | `DEFAULT_SHELL_TIMEOUT_MS` | `120000` | `1` | `packages/tools/src/config.ts:151,332` |
| `shellTimeoutMaxMs` | `DEFAULT_SHELL_TIMEOUT_MAX_MS` | `600000` | `1`, and `>= shellTimeoutMs` | `packages/tools/src/config.ts:153,337-342` |
| `monitorReadyTimeoutMs` | `DEFAULT_MONITOR_READY_TIMEOUT_MS` | `30000` | `1` | `packages/tools/src/config.ts:155,432` |
| `maxMonitors` | `DEFAULT_MAX_MONITORS` | `32` | `1` | `packages/tools/src/config.ts:157,437` |
| `regexScanBudgetMs` | `DEFAULT_REGEX_SCAN_BUDGET_MS` | `5000` | `1` | `packages/tools/src/config.ts:168,438` |

Unlike the size limits above it, `regexScanBudgetMs` is not a plain byte ceiling: its TSDoc
(`packages/tools/src/config.ts:55`-`69`) states it is charged only by `grep`'s in-process fallback and by `replace`
(which has no ripgrep path in any deployment), through `createScanBudget`; it bounds a catastrophically
backtracking user pattern, and it is never charged for disk or directory-walk time, so machine load
cannot trip it. Its default's own TSDoc (`packages/tools/src/config.ts:158`-`167`) reasons about the value in worst-case
terms: roughly seven seconds worst case (the budget plus one in-flight application) against the hours
an unbounded scan would cost, while leaving roughly a thousandfold margin over the time a legitimate
scan actually spends (a plain pattern over 200,000 lines charges 5-7 ms).

Non-numeric fields: `readOnly` defaults `false` (`packages/tools/src/config.ts:345`), `confineToWorkspace` defaults
`true` (`packages/tools/src/config.ts:346`), `ripgrepAvailable` is computed by probing `rg --version` on `PATH`
(`probeRipgrep`, `packages/tools/src/config.ts:184`-`191`) unless a caller injects `probeRipgrep` (test seam), and a
throwing probe is treated as `false` rather than propagating
(`runProbe`, `packages/tools/src/config.ts:193`-`199`; pinned by `packages/tools/tests/integration/config.test.ts:143`-`152`). `stateRoot` is **not** a
caller override — `resolveConfig` always derives it as
`workspaceStatePaths(workspaceRoot).root` (`packages/tools/src/config.ts:446`), which is a value from `@clarvis/paths`
outside this package's scope. `logger` defaults to `NOOP_TOOLS_LOGGER` when the caller supplies none
(`packages/tools/src/config.ts:330`). `guard`, `elicit`, `sandbox`, `secretEnvNames` all pass through unchanged from
`AgentToolsOptions` with no default beyond `undefined` (`packages/tools/src/config.ts:450`-`453`).

### `AgentToolsOptions` (`packages/tools/src/config.ts:234`) vs. `RuntimeConfig` (`packages/tools/src/config.ts:15`)

`AgentToolsOptions` is the caller-facing input: only `workspaceRoot` is required, every limit is
optional, and `probeRipgrep` exists solely as a test seam (`packages/tools/src/config.ts:284`). `resolveConfig` is the
one function that turns it into the fully resolved `RuntimeConfig` every handler consumes as-is — no
handler re-applies a default or re-validates a limit.

### `ServerConfig` — `packages/tools/src/config.ts:457`-`458`

`export type ServerConfig = RuntimeConfig;`, with the comment "Internal compatibility for tests that
import this private module directly" (`packages/tools/src/config.ts:457`). It is not re-exported from `index.ts`'s root
facade — a caller reaching it goes straight at `config.ts` rather than through the package's public
surface. Over 20 files under `packages/tools/tests/` import `ServerConfig` from `../../src/config.ts`
rather than `RuntimeConfig` (e.g. `packages/tools/tests/component/core.test.ts:12`, `packages/tools/tests/component/read-only.test.ts:13`,
`packages/tools/tests/integration/rg.test.ts:12`, `packages/tools/tests/unit/guard-context.test.ts:5`).

### Error wire shape

`serializeError` (`packages/tools/src/errors.ts:65`) renders any thrown value to a JSON string, always with an `error`
key:

- A `ToolError`: `{"error": "<code>", "message": "<message>", ...fields}` (`packages/tools/src/errors.ts:67`) — `fields`
  is spread flat alongside `error`/`message`, e.g. `{ error: "not_found", message: "No such file:
  /w/a.txt", path: "/w/a.txt" }` from `fsError` (`packages/tools/src/errors.ts:100`).
- Anything else: collapsed to `{"error": "internal", "message": "internal error"}`
  (`packages/tools/src/errors.ts:75`), regardless of the original error's message or type — pinned by
  `packages/tools/tests/unit/errors.test.ts:51`-`66` across a plain `Error`, a stackless `Error`, and a
  bare string throwable.

### `ErrorCode` — the closed union (`packages/tools/src/errors.ts:8`-`26`)

`invalid_input`, `not_found`, `not_a_file`, `is_binary`, `not_an_image`, `no_match`,
`ambiguous_match`, `patch_failed`, `io_error`, `timeout`, `aborted`, `output_limit`, `too_large`,
`path_escape`, `denied`, `monitor_not_found`, `too_many_monitors`, `internal` — 18 codes.

### `fsError` mapping table (`packages/tools/src/errors.ts:99`-`116`)

| Node `err.code` | `ErrorCode` | Message shape |
| --- | --- | --- |
| `ENOENT` | `not_found` | `No such file: <path>` |
| `EISDIR` | `not_a_file` | `Path is a directory: <path>` |
| `ENOTDIR` | `not_a_file` | `Not a directory: <path>` |
| anything else (e.g. `EACCES`), or no code at all | `io_error` | `<code ?? "EIO">: <err.message>` |

All four branches attach `{ path }` to `fields`. Pinned by
`packages/tools/tests/unit/errors.test.ts:9`-`42`.

### Tool result envelope

`ToolResult` (`packages/tools/src/tools/content.ts:24`) is `{ content: string | ContentPart[]; meta?: Record<string,
unknown> }`. A `ToolDef.handler` may return a bare string or this envelope
(`packages/tools/src/tools/types.ts:52`-`60`); `normalizeOutput` (`packages/tools/src/core.ts:43`) wraps a bare string as `{ content }`
before dispatch proceeds. `ContentPart` is `TextPart | ImagePart` (`packages/tools/src/tools/content.ts:2`-`17`); `contentText`
(`packages/tools/src/tools/content.ts:57`) flattens an array to its concatenated text, dropping image parts to `""`.

## 4. Behavior

### `resolveConfig` (`packages/tools/src/config.ts:324`-`455`), in call order

1. Reject a falsy `workspaceRoot` (`packages/tools/src/config.ts:325-327`).
2. `validateWorkspace` (`packages/tools/src/config.ts:201`): `path.resolve` it, `statSync` it, throw `StartupError` if it
   does not exist or is not a directory (`packages/tools/src/config.ts:204`-`212`). The existence check's `catch` is
   untyped (`packages/tools/src/config.ts:206`-`207`): *any* thrown error from `statSync` — not only `ENOENT` —
   collapses to the same "Workspace root does not exist" message, so a permission-denied root
   (`EACCES`) is reported identically to a genuinely missing one.
3. Pin any valid linked-worktree metadata roots with `discoverLinkedGitMetadataPaths`, then resolve
   `logger` (fallback `NOOP_TOOLS_LOGGER`, `packages/tools/src/config.ts:328-330`).
4. Resolve and validate `shellTimeoutMs`/`shellTimeoutMaxMs` against their minimum, then
   `assertTimeoutOrder` (`packages/tools/src/config.ts:222`) throws if `shellTimeoutMaxMs < shellTimeoutMs`
   (`packages/tools/src/config.ts:332`-`342`).
5. Run the ripgrep probe (`runProbe`, swallowing a throw to `false`) and resolve `readOnly` /
   `confineToWorkspace` (`packages/tools/src/config.ts:344`-`346`).
6. Emit one `debug` log, `event: "tools.config_resolved"`, naming the flags that "decide the surface
   it advertises" (`packages/tools/src/config.ts:374`-`385`).
7. Build and return the `RuntimeConfig` object, `requireMin`-validating every remaining limit inline
   and deriving `stateRoot` from `@clarvis/paths` (`packages/tools/src/config.ts:387`-`454`).

### `dispatch` (`packages/tools/src/core.ts:200`-`235`), in call order

1. **Lookup.** `getTool(name, selectSurface(config.readOnly))` (`packages/tools/src/core.ts:207`). A miss — an unknown
   name, or a write tool name against a read-only surface (`getTool` only searches the surface it is
   given, `packages/tools/src/tools/registry.ts:102`) — returns `errorResult(new ToolError("not_found", "Unknown tool:
   <name>"))` (`packages/tools/src/core.ts:208`-`210`).
2. **Validate.** `structuredClone(args)` (so the caller's object is never mutated,
   `packages/tools/src/core.ts:213`), then run the tool's pre-compiled Ajv validator (`validators`, a `Map<name,
   ValidateFunction>` built once at module load over every entry in `tools`, `packages/tools/src/core.ts:24`-`27`) with
   `{ allErrors: true, useDefaults: true, coerceTypes: true }` (`packages/tools/src/core.ts:23`). On failure, return
   `invalid_input` with `ajv.errorsText(...)` joined by `"; "`, or the literal string `"invalid
   arguments"` if that text is empty (`packages/tools/src/core.ts:212`-`217`).
3. **Guard.** `applyGuard(name, filled, config)` (detailed below) returns a gate;
   its `denied` member short-circuits dispatch and its `review` member is retained
   on the eventual result.
4. **Execute.** Call `tool.handler(filled, config, signal, hooks)`, `normalizeOutput` its return
   value, split `content` into parts if it was a bare string, and return
   `{ isError: false, content: boundParts(...), ...(meta && { meta: boundMeta(...) }) }`
   (`packages/tools/src/core.ts:222`-`230`). A thrown error (from the handler, or a bug anywhere in step 4) is caught and
   rendered via `errorResult` (`packages/tools/src/core.ts:231`-`234`) — nothing above this dispatcher ever throws.

### `applyGuard` (`packages/tools/src/core.ts:130`-`179`)

| Input state | Outcome |
| --- | --- |
| `config.guard` unset | empty gate (proceed), except `host_vcs`, which denies because host execution always requires review |
| guard throws | caught, `errorResult(err)` — `packages/tools/src/core.ts:176`-`178` |
| `decision.verdict === "allow"` | proceed; when mode is known, review is `allowed/policy` |
| `decision.verdict === "deny"` | `errorResult(new ToolError("denied", reason))` — `packages/tools/src/core.ts:149`-`154` |
| `decision.verdict === "ask"`, no `config.elicit` | `errorResult(... "denied" ...)` — `packages/tools/src/core.ts:155`-`159` |
| `verdict === "ask"`, `elicit` allows | proceed and retain the rich answerer's allowed review |
| `verdict === "ask"`, `elicit` resolves `false` | `errorResult(... "denied" ...)` — `packages/tools/src/core.ts:167`-`175` |

`reason` defaults to the literal `"blocked by guard"` when `decision.reason` is absent
(`packages/tools/src/core.ts:149`). The `GuardContext` passed to `config.guard` is built by `buildGuardContext(name,
args, config)` (`packages/tools/src/core.ts:141`), which is owned by the sibling [command-guard-and-approval](command-guard.md) document;
`core.ts` only calls it and interprets the three-way `Verdict` (`"allow" | "deny" | "ask"`) it
produces.

### Output bounding

- `boundParts` (`packages/tools/src/core.ts:51`-`58`): a no-op when `tool.bounded` is true; otherwise every `TextPart`'s
  text is passed through `bound(text, config.maxOutputBytes)` (from `lib/output.ts`, a sibling
  concern — see `packages/tools/tests/component/core.test.ts:94`-`107` for the bounded/unbounded
  distinction observed end-to-end).
- `boundMeta` (`packages/tools/src/core.ts:60`-`85`): a no-op if the JSON-encoded `meta` already fits
  `config.maxToolMetaBytes`. Otherwise it returns `{ truncated: true, truncation_reason: "tool
  metadata exceeded <N> bytes" }`, and if `meta.diff` is a string it binary-searches (`low`/`high`
  over `diff.length`) for the longest prefix of `diff` (plus a `"\n[diff truncated to metadata
  budget]"` suffix) whose encoding still fits the budget alongside the `base` fields
  (`packages/tools/src/core.ts:70`-`83`).

### `listTools` (`packages/tools/src/core.ts:108`-`114`)

`selectSurface(config.readOnly).map(t => ({ name, description, inputSchema }))` — a pure projection;
no validation, guard or bounding logic runs here.

## 5. Invariants

| # | Rule | Production site | Test |
| --- | --- | --- | --- |
| INV-037 | No tool-facing refusal message in `@clarvis/tools`'s source may tell the model how to lift the restriction it just hit (a "set/pass/export/use … to permit/allow/disable/bypass/override" shape, or a `FOO=1 to permit` shape). | `packages/tools/src/lib/paths.ts:162` is the concrete instance the test guards (`assertWithinWorkspace`'s `path_escape` message states the boundary and that it "cannot be changed from within it," but never names `ALLOW_OUTSIDE_WORKSPACE`). | `packages/tools/tests/architecture/no-bypass-hints.test.ts:81` (scans all of `src/`, excluding comments), guarded against a vacuous pass by `:77`-`79` (`sources(SRC).length` must exceed 30) and calibrated both ways: `:85`-`93` proves the regex fires on three known-bad phrasings, `:95`-`103` proves it does not fire on a refusal that merely states the boundary without hinting at how to lift it |
| INV-038 | `@clarvis/tools` contains no source-code parser: no mention of tree-sitter (any spelling), the removed tool names (`outline`, `check_syntax`), the removed capability-flag identifiers (`treeSitterAvailable`, `probeTreeSitter`, `requiresTreeSitter`, `TREE_SITTER`), or the removed syntax annotation (`syntaxWarnings`, `surface_degraded`) anywhere in its `src/`, `tests/`, `README.md` or `package.json`. | n/a (absence) | `packages/tools/tests/architecture/no-tree-sitter.test.ts:130` (`it.each(FORBIDDEN)`), scanning >80 files (`:127`) |
| INV-039 | No workspace manifest in the monorepo, and no line of `bun.lock`, names `@vscode/tree-sitter-wasm`; and no package's production `src/` names the removed `check_syntax` tool. | n/a (absence, repo-wide) | `packages/tools/tests/architecture/no-tree-sitter.test.ts:141` (manifests), `:148` (lockfile), `:158` (repo-wide `check_syntax` scan) |
| INV-040 | `web-tree-sitter` (a distinct npm specifier `@clarvis/code` legitimately depends on for OpenTUI syntax highlighting) is not a substring of, nor contains, the forbidden `@vscode/tree-sitter-wasm`, and `@clarvis/code`'s manifest and the lockfile still declare/install it. | `packages/code/package.json` (asserted by the cited test rather than cited directly) | `packages/tools/tests/architecture/no-tree-sitter.test.ts:178` (substring check), `:183`-`185` (calibration: the word-level `/tree[-_ ]?sitter/i` matcher *does* fire on `web-tree-sitter`, which is why the substring carve-out above is necessary at all rather than redundant), `:187` (still declared/installed) |
| INV-042 | The advertised tool surface is exactly 24 coding tools, 9 of them read-only, and the same set (in the same order) is advertised on every config. | `packages/tools/src/tools/registry.ts:42`-`81` (`toolDescriptors`, `tools`, `readOnlyTools`) | `packages/tools/tests/component/tool-surface.test.ts:32` |
| INV-043 | Neither the full nor the read-only tool surface advertises `outline` or `check_syntax`. | `packages/tools/src/tools/registry.ts:42`-`67` (absent from `toolDescriptors`) | `packages/tools/tests/component/tool-surface.test.ts:43` |
| INV-044 | Dispatching a removed tool name (`outline`, `check_syntax`) fails with the exact same `{error: "not_found", message: "Unknown tool: <name>"}` shape as dispatching a name that never existed (`does_not_exist`). | `packages/tools/src/core.ts:207`-`210` (`getTool` miss path, uniform for any unrecognized name) | `packages/tools/tests/component/tool-surface.test.ts:52` |
| INV-045 | The refusal for dispatching `outline` never leaks why the tool was removed or hints at a runtime the model could try to install: it contains none of `tree`, `sitter`, `unavailable`, `disabled`, `install`, `degraded` (case-insensitive). | `packages/tools/src/core.ts:209` (`Unknown tool: ${name}` is the entire message — no code path appends anything else for a `not_found`) | `packages/tools/tests/component/tool-surface.test.ts:64` |

INV-038's own scan exempts exactly three files from the forbidden-vocabulary check via an
`ASSERT_ABSENCE` set — this file itself, `tests/component/tool-surface.test.ts`, and
`tests/integration/no-syntax-annotation.test.ts` — because each of them must keep spelling the
removed vocabulary in order to assert its absence (dispatching `outline`, asserting no write result
carries the old syntax warning, etc.). The file's own comment states the rule directly: "Keep the
list at three — anything else naming these tokens is drift"
(`packages/tools/tests/architecture/no-tree-sitter.test.ts:56`-`58`; the set itself is `:59`-`63`).

Three further invariants this document's scope directly evidences, but that the table above does not
number:

- **Arguments are never mutated in place.** `dispatch` validates a `structuredClone` of `args`, never
  the caller's object (`packages/tools/src/core.ts:213`, documented at `packages/tools/src/core.ts:185`-`198`). Unpinned by a dedicated test
  in this document's scope — `tests/component/core.test.ts` exercises validation outcomes but does not
  assert on the original `args` object's identity/contents after a coercing call.
- **A descriptor carries exactly two fields.** `toolDescriptors` entries are `{ tool, readOnly }` and
  nothing else — a third field (e.g. a capability bit making the surface conditional again) requires
  a deliberate, visible edit. Production: `packages/tools/src/tools/registry.ts:29`-`34` (`ToolDescriptor` interface). Test:
  `packages/tools/tests/component/core.test.ts:32`-`34`
  (`expect(Object.keys(descriptor).sort()).toEqual(["readOnly", "tool"])`).
- **The monitor tools' `readOnly: false` is the same classification `@clarvis/loop` gives them, not a
  coincidentally-agreeing second one.** `toolDescriptors` marks `monitor_poll`, `monitor_list` and
  `monitor_stop` `readOnly: false` alongside `monitor_start` with no comment attached to those four
  lines (`packages/tools/src/tools/registry.ts:57`-`60`), even though `monitor_poll`'s and
  `monitor_list`'s own handlers never write anything — `monitor_poll` only reads a sidecar, an exit
  sentinel and a log slice (`packages/tools/src/tools/monitor.ts`, `monitorPoll.handler`), and `monitor_list` only
  lists sidecars and recomputes liveness (`packages/tools/src/tools/monitor.ts`, `monitorList.handler`). But this
  package's own `readOnlyTools` (derived mechanically from that same `toolDescriptors` flag,
  `packages/tools/src/tools/registry.ts:79`-`81`) is not read by `@clarvis/loop` through a second,
  independently-authored list: `packages/loop/src/runtime/tools/builtin/names.ts:1` imports
  `readOnlyTools` directly from `@clarvis/tools` (itself derived from the same `toolDescriptors` flag
  at `packages/tools/src/tools/registry.ts:79`-`81`), and the very comment beside that import states the
  reason for excluding the monitor family: "`shell` and the monitors observe and mutate through the
  same entry point, so no caller can treat them as safe without executing the command first"
  (`packages/loop/src/runtime/tools/builtin/names.ts:10`-`13`). `tool-effect.ts`'s `READ` set is in
  turn built from a hand-mirrored constant (`READ_ONLY_AGENT_TOOL_WIRE_NAMES`, kept eager-load-free),
  and `packages/loop/tests/architecture/agent-tool-wire-names.test.ts:19`-`21` pins that mirror
  equal (sorted) to this package's own `READ_ONLY_TOOL_NAMES` — which is what makes the equality
  test evidence that `monitor_poll`/`monitor_list`/`monitor_stop` are excluded too, not just the
  `monitor_start`/`shell` pair the same file's `:30`-`33` names explicitly. So the two "classifications" the ambiguity compared are one classification
  read twice: `@clarvis/tools` originates the flag (uncommented at its own definition site) and
  `@clarvis/loop` states, next to a direct import of that same flag, the reason it excludes the
  monitor family from what it calls read-only. **Resolved** — this closes one of the ambiguities
  the retired gap report counted as fully resolved (also referenced from
  [engine/tool-dispatch.md](../engine/tool-dispatch.md) §4.8, INV-067, which already documents the
  loop side of this same fact).

## 6. Failure modes and degradation

| Failure | Handling | Cite |
| --- | --- | --- |
| Unknown tool name (never existed, or removed, or write-tool-on-read-only-surface) | `not_found`, message `Unknown tool: <name>` | `packages/tools/src/core.ts:207`-`210` |
| Schema validation failure (missing required field, wrong type not coercible) | `invalid_input`, message from `ajv.errorsText` or the fallback `"invalid arguments"` | `packages/tools/src/core.ts:212`-`217` |
| Guard denies, or `ask` with no/failing elicit | `denied`, message the guard's `reason` or `"blocked by guard"` | `packages/tools/src/core.ts:149`-`175` |
| Guard or elicit callback throws | caught, rendered via `errorResult`/`serializeError` — never propagates | `packages/tools/src/core.ts:176`-`178` |
| Handler throws a `ToolError` | serialized with its own `code`/`message`/`fields` | `packages/tools/src/errors.ts:66`-`68` |
| Handler throws anything else (a bug) | collapsed to `{error: "internal", message: "internal error"}`; the real detail (stack or `String(err)`) goes only to the warn sink, event `tools.internal_error`, level `error` | `packages/tools/src/errors.ts:69`-`75` |
| Unrecognized Node `ErrnoException` code (not `ENOENT`/`EISDIR`/`ENOTDIR`) | mapped to `io_error`; the raw errno is logged at `debug` (`tools.fs_error_unmapped`) since "an unusual errno is an ordinary outcome" | `packages/tools/src/errors.ts:105`-`115` |
| `resolveConfig` given a missing/non-existent/non-directory `workspaceRoot` | throws `StartupError` synchronously — startup aborts, no degraded config is returned | `packages/tools/src/config.ts:201`-`213` |
| `resolveConfig` given a limit below its minimum, or an inverted shell timeout range | throws `StartupError` | `packages/tools/src/config.ts:215`-`230`, pinned by `packages/tools/tests/integration/config.test.ts:106`-`141` |
| `resolveConfig`'s ripgrep probe throws | swallowed; `ripgrepAvailable` is set `false`, not propagated as a startup failure | `packages/tools/src/config.ts:193`-`199`, pinned by `packages/tools/tests/integration/config.test.ts:143`-`152` |
| Tool result's serialized `meta` exceeds `maxToolMetaBytes` | truncated to `{truncated: true, truncation_reason: ...}` plus, for a `diff` field, the longest prefix that still fits | `packages/tools/src/core.ts:60`-`85` |
| Non-`bounded` tool's text output exceeds `maxOutputBytes` | clamped by `bound()` (sibling concern in `lib/output.ts`), never dropped or errored | `packages/tools/src/core.ts:51`-`58` |

Nothing in `dispatch` throws to its caller: every one of the above resolves to a `DispatchResult`
with `isError: true` and a JSON-string error in `content` (documented at `packages/tools/src/core.ts:191`-`198`).

## 7. Coupling

**What this depends on (runtime, static imports):**

- `@clarvis/paths`: `resolveCommand` (used by `probeRipgrep`, `packages/tools/src/config.ts:186`) and
  `workspaceStatePaths` (used to derive `stateRoot`, `packages/tools/src/config.ts:7,446`). A hard, direct dependency —
  `packages/tools/src/config.ts:7` imports it by name; there is no fallback path.
- `ajv` (via `createRequire`, `packages/tools/src/core.ts:1,21`): loaded once at module scope to build the shared
  validator map over every entry in `tools` (`packages/tools/src/core.ts:24`-`27`) — this is why adding a 25th tool to
  the registry automatically gets a compiled validator with no further wiring. This map is built over
  the *full* surface (`tools`) regardless of `readOnly`, so a read-only-configured run still has a
  compiled validator sitting in the module-level `Map` for every write tool it will never expose —
  `listTools`/`getTool` make that tool unreachable via `selectSurface`, but the validator for it exists
  all the same.
- Every individual tool module (`./tools/read-file.ts`, `./tools/write-file.ts`, ... 21 import
  statements binding the 24 tool implementations — one line imports four monitor
  bindings at once — `packages/tools/src/tools/registry.ts:1`-`21`): `registry.ts` is the one file that imports every tool
  implementation; nothing else in the package needs to.
- `./guard/context.ts` (`buildGuardContext`) and `./guard/types.ts` (`ElicitRequest`): `packages/tools/src/core.ts:8-9`
  imports them to build the `GuardContext` passed to `config.guard`, but does not implement guard
  policy itself — that is the sibling [command-guard-and-approval](command-guard.md) document's domain, reached here only
  through the `Guard`/`Elicit` function types on `RuntimeConfig` (`packages/tools/src/config.ts:5`, `112`, `115`).

**What forces this shape:**

- `registry.ts`'s `ToolDescriptor` interface (`packages/tools/src/tools/registry.ts:29`-`34`, exactly two keys) is what
  prevents a tool from silently regaining a conditional-surface bit; `packages/tools/tests/component/core.test.ts:32`-`34` fails if a
  third key appears.
- `selectSurface`'s single-parameter signature (`packages/tools/src/tools/registry.ts:90`) is what the `no-tree-sitter.test.ts`
  header comment (`:16`-`20`) calls out as untypeable: `Function.length` and structural assignability
  would both silently accept a re-added second (capability) parameter, so only the text scan in
  `no-tree-sitter.test.ts` would catch its return.
- `dispatch`'s exact refusal string for an unknown tool (`Unknown tool: ${name}`, `packages/tools/src/core.ts:209`) is
  pinned byte-for-byte by `packages/tools/tests/component/tool-surface.test.ts:57`-`60`'s `toEqual`, which is what makes INV-044 (a
  removed tool refused identically to a typo) a property of the code rather than an accident of
  phrasing.

**What depends on this package:**
`@clarvis/hooks` depends on the `./shell` subpath specifically (per the export map,
`packages/tools/package.json:40`-`44`), verified at the consumer: `packages/hooks/src/subprocess.ts:21`-`26`
imports `killTree`, `ownProcessGroup`, `resolveShell`, `shellArgs` and `ShellSpec` from it (see the
`./shell` surface entry in §2 for the full consumer list, which also includes `@clarvis/kernel`'s
`local.ts` and `capability-executables/session-manager.ts` — a coupling not previously named here).
`@clarvis/loop`'s `optionalDependencies` includes `@clarvis/tools` per the repository's package-level
conventions; that consumer side is outside this document's scope.

## 8. Open questions

- **Why `stateRoot` has no caller override.** `AgentToolsOptions` has no `stateRoot` field; it is
  always derived from `workspaceStatePaths(workspaceRoot).root` (`packages/tools/src/config.ts:446`). The code does not
  say whether this is a deliberate closure (to keep `stateRoot` from ever diverging from
  `workspaceRoot`) or simply unneeded so far — no test in this document's scope exercises overriding
  it.
- **Whether `structuredClone(args)` before validation is itself covered by a dedicated test.** The
  behavior is documented in `packages/tools/src/core.ts:185`-`198` and is consistent with every dispatch test observed,
  but no test in `tests/component/core.test.ts` specifically asserts the caller's original `args`
  object is left unmutated after a call that triggers Ajv's `useDefaults`/`coerceTypes` defaulting —
  this is an unpinned invariant (noted in §5).
- ~~The exact behavior of `boundMeta`'s binary search when `meta` has a `diff` field but the `base`
  object alone already exceeds `maxToolMetaBytes`~~ **Resolved: `base` always fits.** The loop
  (`packages/tools/src/core.ts:73`-`83`) initializes `best = base` and only updates it on a fitting
  candidate, so the fallback return value is `base` whenever no candidate fits — but every call site
  that can reach `boundMeta` passes a `maxBytes` that is bound below by `MIN_OUTPUT_BYTES = 1024`
  (`packages/tools/src/config.ts:169`), enforced not by convention but by `requireMin` throwing a `StartupError`
  at config construction if `maxToolMetaBytes < 1024` (`packages/tools/src/config.ts:215-220`, applied at `:425`-`429`); the sole
  production call site is `packages/tools/src/core.ts:228`, `boundMeta(meta, config.maxToolMetaBytes)`, so no dispatch can
  ever pass a smaller bound. `base`'s own JSON encoding — `{"truncated":true,"truncation_reason":"tool
  metadata exceeded <N> bytes"}` (`packages/tools/src/core.ts:64`-`67`) — is a small, fixed-shape object whose only
  variable part is `String(maxBytes)`; even for the largest value the field could plausibly carry
  (`Number.MAX_SAFE_INTEGER`, 16 digits) the whole encoded object is under 100 bytes, an order of
  magnitude below the 1024-byte floor. So `best = base` can never itself exceed `maxBytes`: the
  guarantee holds structurally, from the config-time minimum plus the fixed small shape of `base`,
  not from any test. (`packages/tools/tests/integration/diff-meta.test.ts:82`-`96` exercises the adjacent binary-search
  path at the `MIN_OUTPUT_BYTES` floor and confirms the overall result stays within budget, but does
  not isolate the pure-`base`, no-`diff` case; that remaining gap is a test-coverage note, not an open
  question about the code's behavior.)
- **Consumer-side usage of the `./shell` subpath is documented** (see §2's `./shell` entry and §7):
  `@clarvis/hooks` (`subprocess.ts`) and `@clarvis/kernel` (`local.ts`, `capability-executables/session-manager.ts`)
  each import from it directly. **`./sandbox` has no documented consumer** — no consumer of
  `SandboxConfig` is within this document's scope.
