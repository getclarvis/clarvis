# Workspace hooks: matching, subprocess contract, verdicts and payload dialect

> Implemented at `packages/hooks/src/**`, `packages/capability/src/hooks-config.ts`,
> `packages/loop/src/runtime/capabilities/hooks.ts` and `packages/hooks/tests/**`. Every claim below
> is anchored to a file and line. Open questions are collected in the final section.

## 1. Purpose

`@clarvis/hooks` executes **workspace hooks**: shell commands an operator declares in
`settings.json` or a plugin manifest, each bound to a lifecycle event, that run with the
operator's own privileges and hand back a verdict the host may act on
(`packages/hooks/src/index.ts:1-9`). The package owns four mechanical concerns end to end:
deciding whether a tool-scoped hook applies to the pending call (`match.ts`), spawning and bounding
the subprocess (`subprocess.ts`), reading its stdout into a typed outcome (`parse.ts`), and
orchestrating selection/execution/resolution across a whole list of configured hooks
(`runner.ts`). A fifth module, `capability.ts`, is the sole place that adapts this vocabulary onto
`@clarvis/loop`'s `LifecycleHook` contract — everything else in the package is deliberately
ignorant of what a lifecycle hook is (`packages/hooks/src/types.ts:5-10`, `packages/hooks/src/index.ts:6-9`).

The package explicitly is **not** a sandbox: "This is credential hygiene, not a sandbox"
(`packages/hooks/src/env.ts:5`). A hook command runs with full operator privileges, reads/writes
the workspace and reaches the network; the one goal the environment filter pursues is that "the
model-provider credentials this run is holding must not reach a subprocess that had no reason to
see them" (`packages/hooks/src/env.ts:9-10`). Likewise a tool/argument `match` filter is "a scoping
device, not a security boundary — the command guard is what enforces policy"
(`packages/hooks/src/types.ts:17-18`).

The vocabulary a hook is validated and classified against — which events exist, which are gates,
their default timeouts, hard configuration limits, and the Clarvis↔foreign-dialect name
correspondence — lives in `@clarvis/capability/src/hooks-config.ts` rather than in this package,
because that vocabulary must be reachable on the engine's **eager** configuration path (settings /
plugin / request schemas) even when the optional `@clarvis/hooks` package itself is never loaded
(`packages/capability/src/hooks-config.ts:5-14`).

## 2. Surface

### 2.1 `@clarvis/hooks` entrypoint `.` (`src/index.ts`)

| Symbol | Kind | Defined at |
|---|---|---|
| `createHookRunner` | fn | `packages/hooks/src/runner.ts:365` |
| `HOOK_PROTOCOL_VERSION` (`= 1`) | const | `packages/hooks/src/runner.ts:24` |
| `MAX_STDIN_BYTES` (`= 256 * 1024`) | const | `packages/hooks/src/runner.ts:35` |
| `HookRunner` | interface | `packages/hooks/src/runner.ts:85` |
| `HookRunnerDeps` | interface | `packages/hooks/src/runner.ts:56` |
| `filterHookEnv` | fn | `packages/hooks/src/env.ts:175` |
| `interpolatedNames` | fn | `packages/hooks/src/env.ts:216` |
| `EnvFilterOptions`, `FilteredHookEnv` | interface | `packages/hooks/src/env.ts:115`, `:148` |
| `argText`, `compileMatch`, `matchesCandidate` | fn | `packages/hooks/src/match.ts:112`, `:54`, `:145` |
| `globToRegExp` | fn (re-export) | `packages/capability/src/glob.ts:30`, via `packages/hooks/src/match.ts:11-14` |
| `ARG_MATCH_MAX_CHARS` (`= 8192`) | const | `packages/hooks/src/match.ts:26` |
| `CompiledMatch` | interface | `packages/hooks/src/match.ts:29` |
| `parseHookStdout` | fn | `packages/hooks/src/parse.ts:201` |
| `HOOK_MESSAGE_MAX_CHARS` (`= 4_000`) | const | `packages/hooks/src/parse.ts:21` |
| `ParsedHookOutput`, `ParseOptions` | type/interface | `packages/hooks/src/parse.ts:27`, `:32` |
| `runHookCommand` | fn | `packages/hooks/src/subprocess.ts:376` |
| `DEFAULT_KILL_GRACE_MS` (`= 1_500`), `DEFAULT_MAX_STDOUT_BYTES` (`= 64*1024`), `DEFAULT_MAX_STDERR_BYTES` (`= 8*1024`) | const | `packages/hooks/src/subprocess.ts:30,32,34` |
| `HookChildProcess`, `HookReadable`, `HookWritable`, `HookSpawnOptions`, `SpawnFn`, `SubprocessDeps`, `SubprocessRequest`, `SubprocessResult`, `TimerDeps` | interface/type | `packages/hooks/src/subprocess.ts:61,49,55,80,90,119,138,163,106` |
| `NOOP_HOOK_LOGGER` | const | `packages/hooks/src/types.ts:190` |
| `HookFailure`, `HookFailureKind`, `HookInvocation`, `HookLogger`, `HookMatch`, `HookOutcome`, `HookResult`, `HookSpec`, `ToolCandidate` | interface/type | `packages/hooks/src/types.ts:124,118,67,174,20,145,153,42,61` |

Not re-exported from `.` though defined in `src/`: `HOOK_BLOCKING_EXIT_CODE` (`= 2`,
`packages/hooks/src/runner.ts:50`) and `ignoreRejection` (`packages/hooks/src/subprocess.ts:220`).
`event-serialization.ts` (`HookEvent` type, `hookInvocationFor` fn) is reachable from **no**
entrypoint — it is consumed only by `capability.ts` internally
(`packages/hooks/src/event-serialization.ts:1,27,241`).

### 2.2 Entrypoint `./capability` (`src/capability.ts`)

| Symbol | Kind | Defined at |
|---|---|---|
| `HOOKS_SEED_MARKER` (`= "<workspace-hooks>"`) | const | `packages/hooks/src/capability.ts:48` |
| `compileWorkspaceHooks` | fn | `packages/hooks/src/capability.ts:123` |
| `buildSeedBlock` | fn | `packages/hooks/src/capability.ts:248` |
| `runCredentialNames` | fn | `packages/hooks/src/capability.ts:298` |
| `WorkspaceHooksOptions` | interface | `packages/hooks/src/capability.ts:316` |
| `createWorkspaceHooksCapability` | fn | `packages/hooks/src/capability.ts:358` |
| `createHooksCapability` | fn | `packages/hooks/src/capability.ts:420` |

This is a **separate export subpath** from `.`, and separate from the engine's
`runtime/capabilities/hooks.ts` settings block, so that nothing on the engine's eager
settings/plugin/request-schema path can reach executable code — which is what lets
`builtins.hooks = false` genuinely not load `@clarvis/hooks` at all
(`packages/hooks/src/capability.ts:10-15`).

### 2.3 Hook vocabulary — `@clarvis/capability/src/hooks-config.ts`

| Symbol | Value / shape | Line |
|---|---|---|
| `HOOKS_CAPABILITY_NAME` | `"hooks"` | `:19` |
| `GATE_HOOK_EVENTS` | `["pre_tool_use","post_tool_use","pre_finalize","pre_delegate_task"]` | `:27-32` |
| `OBSERVER_HOOK_EVENTS` | `["run_start","run_end","post_compact","subagent_start","subagent_complete","model_call_error","budget_exhausted","user_steer"]` | `:38-47` |
| `COMPACTION_HOOK_EVENTS` | `["pre_compact"]` | `:62` |
| `CONTEXT_HOOK_EVENTS` | `["session_start"]` | `:74` |
| `PROMPT_HOOK_EVENTS` | `["user_prompt_expansion"]` | `:85` |
| `EXTERNAL_HOOK_EVENT_NAMES` | Clarvis→foreign event-name table (§3.4) | `:104-116` |
| `EXTERNAL_TOOL_NAMES` | foreign-normalized-name→Clarvis-tool-name table (§3.4) | `:142-159` |
| `EXTERNAL_HOOK_TOOL_NAMES` | Clarvis built-in→preferred foreign stdin name | `:162-174` |
| `EXTERNAL_TOOLS_WITHOUT_COUNTERPART` | `Set` of 5 foreign names with no Clarvis tool | `:185-191` |
| `normalizeToolName` | fn: strip non-alnum, lower-case | `:202-204` |
| `HOOK_DEFAULT_TIMEOUT_MS` | per-class default timeout table | `:241-247` |
| `MAX_HOOKS_PER_SOURCE` (`64`), `MAX_HOOKS_PER_RUN` (`128`), `MAX_HOOK_COMMAND_CHARS` (`8192`), `MAX_HOOK_MATCH_PATTERNS` (`64`), `MAX_HOOK_PATTERN_CHARS` (`2048`), `MAX_HOOK_TIMEOUT_MS` (`60000`) | consts | `:250-255` |
| `hookSchema` | zod schema, one validated hook entry | `:276-454` |
| `HookConfig` | `z.infer<typeof hookSchema>` | `:457` |

### 2.4 Settings/plugin surface — `packages/loop/src/runtime/capabilities/hooks.ts`

| Symbol | Shape | Line |
|---|---|---|
| `HOOKS_SETTINGS_FIELDS.hooks` | `z.array(hookSchema).max(MAX_HOOKS_PER_SOURCE)`, optional | `:23-33` |
| `HOOKS_REQUEST_PARAMS.hook_user_prompt_expansion` | strict, optional host-derived `{ command_name }` context | `:35-53` |
| `HOOKS_PLUGIN_FIELDS.hooks` | same schema, plugin-manifest field | `:61-68` |
| `hooksSettingsSpec` | `CapabilitySettingsSpec` — `key: "hooks"`, merges scopes as **all operator hooks then all plugin hooks**, capped at `MAX_HOOKS_PER_RUN`, `pluginContributable: true` | `:75-86` |

### 2.5 `HookRunner` (the package's whole public surface)

```ts
interface HookRunner {
  select(hooks: readonly HookSpec[], inv: HookInvocation): readonly HookSpec[];
  run(hook: HookSpec, inv: HookInvocation, signal?: AbortSignal): Promise<HookResult>;
  resolve(result: HookResult, inv: HookInvocation): HookOutcome;
}
```
(`packages/hooks/src/runner.ts:85-99`, remark at `:5-8`: "the runner is the whole public surface of
this package: everything else is an implementation detail it composes").

### 2.6 CLI flags / env vars

No CLI flags. Every hook subprocess additionally receives these injected environment variables,
set by `runner.ts`'s `run` beside the caller-supplied filtered `baseEnv`
(`packages/hooks/src/runner.ts:484-503`):

| Variable | Value |
|---|---|
| `CLARVIS_HOOK_PROTOCOL` | `String(HOOK_PROTOCOL_VERSION)` |
| `CLARVIS_HOOK_EVENT` | the Clarvis event name (e.g. `pre_tool_use`) |
| `CLARVIS_HOOK_GATE` | `"1"` or `"0"` |
| `CLARVIS_HOOK_TIMEOUT_MS` | the resolved timeout for this fire point |
| `CLARVIS_WORKSPACE_ROOT` | the workspace root |
| `CLARVIS_HOOK_TOOL` | present only when `inv.candidate` exists |
| `CLARVIS_HOOK_TOOL_FULL_NAME` | the stable dotted MCP identity when it differs from the wire name |

A bundled plugin command additionally receives canonical `PLUGIN_ROOT`/`PLUGIN_DATA` and the
`CODEX_PLUGIN_ROOT`/`CODEX_PLUGIN_DATA` compatibility aliases. They are attached after credential
filtering and contain paths, never credentials. Production: the command environment in
`createHookRunner` (`packages/hooks/src/runner.ts`). Test:
`packages/hooks/tests/component/runner.test.ts` (`publishes plugin root and writable data paths`).

## 3. Data and formats

### 3.1 One configured hook (`HookConfig` / `HookSpec`)

```ts
{
  event: "pre_tool_use" | "post_tool_use" | "pre_finalize" | "pre_delegate_task"
       | "run_start" | "run_end" | "post_compact" | "subagent_start"
       | "subagent_complete" | "model_call_error"
       | "budget_exhausted" | "user_steer" | "session_start" | "pre_compact"
       | "user_prompt_expansion",
  match?: { tool?: string | string[], args?: Record<string, string> },
  type?: "command" | "mcp_tool",
  command: string,                    // command hooks; max 8192 chars
  command_windows?: string,
  async?: boolean,
  status_message?: string,            // bounded display metadata
  additional_context_limit?: number,  // 0..65536 captured chars
  server?: string, tool?: string, input?: unknown, // mcp_tool hooks
  plugin_root?: string, plugin_data?: string, // optional command environment paths
  timeout_ms?: number,                // 1..60000
  on_failure?: "pass" | "deny",
}
```
Schema at `packages/capability/src/hooks-config.ts`, `hookSchema`. Cross-field rules enforced by
its `superRefine`: `match` is valid only for `pre_tool_use`/`post_tool_use` and must set
`tool` and/or `args`; every `match.args` value must compile as a `RegExp`; `on_failure` is rejected
outright on the two "offering" events (`session_start`, `pre_compact` — "a hook that offers text
and fails simply contributes nothing"); `on_failure: "deny"` is rejected on any other observer
event; an `mcp_tool` requires `server` and `tool` and cannot declare failure policy because its
failure is always non-blocking.

`plugin_root` and `plugin_data` are optional bounded path strings in the strict schema. The plugin
manifest adapter normally supplies them for translated plugin commands, but the settings parser does
not reserve them from an operator-authored hook. The runner publishes their values as the compatible
plugin environment aliases; it does not change `cwd` or create a confinement boundary from them.
Production: `packages/capability/src/hooks-config.ts:349-350`,
`packages/kernel/src/plugins/plugin-manifest.ts:758-762`, and
`packages/hooks/src/runner.ts:484-503`.

### 3.2 The stdin payload — flat, foreign-dialect identity fields

Built by `stdinPayload` (`packages/hooks/src/runner.ts:334-354`) from `identityFields`
(`:307-318`):

```json
{
  "protocol": 1,
  "hook_event_name": "PreToolUse",
  "cwd": "/workspace/root",
  "tool_name": "Bash",
  "tool_input": { "command": "ls -la" }
}
```
Example drawn from `packages/hooks/tests/component/runner.test.ts:390-397` and the real-shell
integration test at `packages/hooks/tests/integration/real-subprocess.test.ts:108-115` — neither
supplies a `session_id`, which is why the example omits one; see the next paragraph for when the
field is present instead. The
envelope is deliberately **flat**: identity fields plus the event's own fields spread beside them,
never nested under a `data` key, and "nothing appears twice" — no `event` beside
`hook_event_name`, no `workspace_root` beside `cwd`
(`packages/hooks/src/runner.ts:328-332`, proven by
`packages/hooks/tests/component/runner.test.ts:400-414`). `session_id` is omitted when the host
supplies none (`packages/hooks/src/runner.ts:316`, test at `packages/hooks/tests/component/runner.test.ts:466-472`).

The model-facing wire identity is retained in `CLARVIS_HOOK_TOOL`; matching also sees the optional
canonical dotted identity (`ToolCandidate.aliases`, `packages/hooks/src/types.ts:60-65`, consumed at
`packages/hooks/src/match.ts:145-155`). Stdin uses the external built-in spelling, or
`mcp__<server>__<tool>` for MCP, and deliberately removes Clarvis's plugin namespace because that
namespace does not exist in the compatible payload dialect
(`packages/hooks/src/event-serialization.ts:95-124`). The separate
`CLARVIS_HOOK_TOOL_FULL_NAME` retains the canonical identity for Clarvis-native commands and
diagnostics (`packages/hooks/src/runner.ts:484-503`; pinned at
`packages/hooks/tests/component/runner.test.ts:641-657`).

If the serialized payload exceeds `MAX_STDIN_BYTES` (256 KiB) or fails to serialize, the payload
is replaced by `{ ...identity, payload_truncated: true }` and `truncated: true` is reported
(`packages/hooks/src/runner.ts:347-353`; tests `packages/hooks/tests/component/runner.test.ts:474-505`).

### 3.3 Per-event serialization table (`event-serialization.ts`)

`SERIALIZE` (`packages/hooks/src/event-serialization.ts:141-228`) is a **total, statically checked**
record over `HookConfig["event"]` (`satisfies { [Event in HookEvent]: ... }`, `:228`) — a new
schema event cannot compile until its stdin projection is defined here. Every field name is
`snake_case`; the two tool events reuse the exact field names the foreign dialect documents
(`tool_name`, `tool_input`, `tool_response`) so a hook authored elsewhere reads them unmodified
(`:95-108`). Free-text fields are clamped to `TEXT_CLAMP = 8_000` chars
(`clampText`, `:51,53-56`); structured values are clamped to `VALUE_CLAMP = 32_000` bytes of JSON,
replaced by `{ truncated: true, bytes }` when they exceed it, or `{ truncated: true }` when they
fail to serialize at all (`clampValue`, `:53,58-68`). `post_tool_use`'s `tool_response` drops raw
image bytes and reports `image_count` instead (`:146-155`; test at
`packages/hooks/tests/component/capability.test.ts:515-534`).

Every event's exact field set (`packages/hooks/src/event-serialization.ts:141-228`), each individually pinned by a
`payloadFor("<event>", …)` assertion in `packages/hooks/tests/component/capability.test.ts:312-548`:

| Event | Fields on the stdin payload | Test |
|---|---|---|
| `pre_tool_use` | `tool_name`, `tool_input` (clamped value) | shape: `packages/hooks/tests/component/runner.test.ts:380-397`; clamping: `packages/hooks/tests/component/capability.test.ts:446-453` |
| `post_tool_use` | `tool_name`, `tool_input`, `tool_response: { text, progress, task_id, image_count }` | `packages/hooks/tests/component/capability.test.ts:516-534` |
| `pre_finalize` | `agent`, `subagent_instance_id`, `mode`, `text`, `value` (clamped) | `packages/hooks/tests/component/capability.test.ts:498-513` |
| `pre_delegate_task` | `title`, `task` (clamped text), `profile`, `task_id` | `packages/hooks/tests/component/capability.test.ts:352-358` |
| `run_start` | `mode`, `entry`, `lead_model`, `subagent_model` | `packages/hooks/tests/component/capability.test.ts:359-363` |
| `run_end` | `status`, `error_code`, `iterations_used`, `elapsed_ms` | `packages/hooks/tests/component/capability.test.ts:365-374` |
| `post_compact` | `agent`, `subagent_instance_id`, `operation`, `freed_chars`, `kept_chars` | `packages/hooks/tests/component/capability.test.ts:376-392` |
| `subagent_start` | `subagent_instance_id`, `profile`, `model`, `task` (clamped text) | `packages/hooks/tests/component/capability.test.ts:394-408` |
| `subagent_complete` | `subagent_instance_id`, `status`, `result` (clamped text) | `packages/hooks/tests/component/capability.test.ts:410-414` |
| `pre_compact` | `agent`, `subagent_instance_id`, `estimated_tokens` | `packages/hooks/tests/component/capability.test.ts:416-420` |
| `model_call_error` | `agent`, `subagent_instance_id`, `iteration`, `model`, `message` (clamped) | `packages/hooks/tests/component/capability.test.ts:422-432` |
| `budget_exhausted` | `agent`, `reason`, `tokens_used`, `iterations_used` | `packages/hooks/tests/component/capability.test.ts:434-443` |
| `user_steer` | `agent`, `subagent_instance_id`, `iteration`, `message` (clamped), `id` | `packages/hooks/tests/component/capability.test.ts:339-350` |
| `session_start` | none — projects to `{}` (`packages/hooks/src/event-serialization.ts:224`) | not exercised via `payloadFor` in this document's scope |
| `user_prompt_expansion` | `command_name` | `packages/hooks/tests/component/capability.test.ts:662-678` |

(`pre_delegate_task` through `budget_exhausted` above share one test body, "projects every
remaining event onto snake_case fields", `packages/hooks/tests/component/capability.test.ts:352-444`.)

`defaultTimeoutFor` (`packages/hooks/src/event-serialization.ts:42-48`) resolves `HookInvocation.defaultTimeoutMs` by
**tier precedence**, checked in this order — tool events first, then gates, then a `run_end`
special case, then the remaining context event, falling back to the observer default — rather than
by the flat per-class table alone:

```ts
function defaultTimeoutFor(event) {
  if (TOOL_EVENTS.has(event)) return HOOK_DEFAULT_TIMEOUT_MS.tool;      // 5_000
  if (GATE_EVENTS.has(event)) return HOOK_DEFAULT_TIMEOUT_MS.gate;      // 30_000
  if (event === "run_end") return HOOK_DEFAULT_TIMEOUT_MS.run_end;      // 2_000
  if (CONTEXT_EVENTS.has(event)) return HOOK_DEFAULT_TIMEOUT_MS.context; // 5_000
  return HOOK_DEFAULT_TIMEOUT_MS.observer;                              // 5_000
}
```

Because the tool check runs **before** the gate check, `pre_tool_use`/`post_tool_use` — which are
also members of `GATE_HOOK_EVENTS` — get the short `tool` default (5000 ms), not the long `gate`
one (30000 ms); only the two non-tool gates (`pre_finalize`, `pre_delegate_task`) get 30000 ms.
Pinned by "gives the tool events the short default budget and the rare gates the long one",
asserting `[5_000, 30_000, 2_000, 5_000]` for `pre_tool_use`/`pre_finalize`/`run_end`/`run_start`
in that order (`packages/hooks/tests/component/capability.test.ts:587-600`).

### 3.4 The Clarvis ↔ foreign dialect correspondence tables

`EXTERNAL_HOOK_EVENT_NAMES` (`packages/capability/src/hooks-config.ts:104-116`):

| Clarvis event | Foreign name |
|---|---|
| `pre_tool_use` | `PreToolUse` |
| `post_tool_use` | `PostToolUse` |
| `pre_compact` | `PreCompact` |
| `session_start` | `SessionStart` |
| `run_end` | `SessionEnd` |
| `post_compact` | `PostCompact` |
| `subagent_start` | `SubagentStart` |
| `subagent_complete` | `SubagentStop` |
| `pre_finalize` | `Stop` |
| `user_steer` | `UserPromptSubmit` |
| `user_prompt_expansion` | `UserPromptExpansion` |

`pre_delegate_task`, `run_start`, `model_call_error`, `budget_exhausted` have **no** foreign
counterpart and are absent from the table on purpose — "an approximation that fires at the wrong
moment is worse than an honest gap" (`:90-91`).

`EXTERNAL_TOOL_NAMES` (`:142-159`, keyed by `normalizeToolName`: letters+digits only, lower-cased,
`:202-204`): `bash`/`shell→shell`, `read`/`readfile→read_file`, `write`/`writefile→write_file`,
`edit`/`editfile→edit_file`, `multiedit→multi_edit`, `applypatch→apply_patch`, `glob→glob`,
`grep→grep`, `ls`/`listdir→list_dir`, `task→delegate_task`, `skill→load_skill`. Measured against a public catalog of
196 plugins: "five of the thirty-nine names their filters used existed here; the other thirty-four
… translated cleanly, installed, were approved, and then matched nothing"
(`:123-129`). `EXTERNAL_HOOK_TOOL_NAMES` (`:162-174`) owns the reverse spelling emitted on stdin;
the two directions are explicit because several external aliases map to one Clarvis tool.
`EXTERNAL_TOOLS_WITHOUT_COUNTERPART` (`:185-191`) lists 5 foreign names with no
Clarvis tool at all (`exitplanmode`, `todowrite`, `notebookedit`, `webfetch`, `websearch`) so a
filter naming one is reported rather than silently installed as a pattern that can never match.
**This correspondence-table content is delegated as an interop contract to
[agent-interop-and-shared-surface](../cross-cutting/agent-interop.md)**; this document only describes how `@clarvis/hooks` consumes it
(as the event-name label on the stdin payload).

### 3.5 The runner's outcome/failure vocabulary

```ts
type HookOutcome =
  | { kind: "pass" }
  | { kind: "deny"; message: string }
  | { kind: "advise"; message: string }
  | { kind: "context"; text: string }
  | { kind: "rewrite"; arguments: object; message?: string };

type HookFailureKind = "spawn_failed" | "timeout" | "exit_nonzero" | "bad_output" | "aborted";
```
(`packages/hooks/src/types.ts:147-152`, `:118-119`.)

### 3.6 Environment filter result

```ts
interface FilteredHookEnv {
  env: Record<string, string>;
  denied: { exact: number; shape: number };  // counts only, never names
}
```
(`packages/hooks/src/env.ts:148-158`.) The keep-list (`KEEP_EXACT`, 31 names +
`KEEP_PREFIX = ["LC_"]`, `packages/hooks/src/env.ts:42-76`), the secret name-shape regex
(`SECRET_NAME`, `:76-77`) and the credential-family prefixes (`SECRET_PREFIX`, 13 entries, `:80-94`)
are the concrete rule set; **derivation rationale for the denylist is delegated to
[security-confinement-and-redaction](../cross-cutting/security.md)**.

An `EnvFilterOptions.add` record (`packages/hooks/src/env.ts:128-129`) supplies variables applied **last**, after
every rule, and exempt from all of them — the one bypass of keep-list/deny precedence. Pinned by
"added variables are applied last and are never filtered" and "does not mutate the source"
(`packages/hooks/tests/unit/env.test.ts:83-96`). The one production caller,
`createWorkspaceHooksCapability`, never supplies it (`packages/hooks/src/capability.ts:366-368`
passes only `denyExact`).

## 4. Behavior

### 4.1 One fire point, end to end

1. The host builds a `HookInvocation` for the event (data payload, optional tool candidate,
   default timeout, `gate` flag, `rewritable` flag, `externalEvent` name) — for the
   `compileWorkspaceHooks` path this is `hookInvocationFor` (`packages/hooks/src/event-serialization.ts:241-254`).
2. `runner.select(hooks, inv)` filters the configured list to those whose `event` matches and whose
   compiled `match` accepts the candidate, in **configuration order**
   (`packages/hooks/src/runner.ts:400-415`); logs `hooks.selected` with counts of matched/total/broken
   (`:404-413`).
3. For each selected spec, `runner.run(spec, inv, signal)`:
   a. builds the stdin payload (§3.2) and the injected env (§2.6);
   b. for an `mcp_tool`, resolves the already-open server/tool through `MCP_HOOK_TOOL_PORT`,
      recursively expands `${field.path}` values from the event payload, calls it directly, and
      applies the same output verdict parser without entering ordinary tool dispatch;
   c. for a command hook, selects `command_windows` on Windows and otherwise `command`, then calls
      `runHookCommand` (`packages/hooks/src/subprocess.ts:376`) which spawns the host shell, writes stdin, bounds
      stdout/stderr, bounds the wall clock, and never rejects (§4.4);
   d. `classify(res, inv)` (`packages/hooks/src/runner.ts:232-270`) turns the `SubprocessResult` into either a
      `HookFailure` or a `HookOutcome`, in this precedence: `aborted` > `timedOut` > `spawnError` >
      (gate + exit code 2 + no signal ⇒ `deny`) > (non-zero exit or signalled ⇒ `exit_nonzero`) >
      `parseHookStdout` of stdout;
   e. logs `hooks.command_failed`/`hooks.mcp_failed` (warn) on failure or `hooks.verdict` (info for `deny`/`rewrite`,
      debug otherwise) on success (`:541-575`);
   f. returns a `HookResult` — never throws. An async command returns `pass` immediately and enters
      the runner's bounded background queue; `run_end` remains synchronous even when authored async.
4. `runner.resolve(result, inv)` (`packages/hooks/src/runner.ts:581-590`) folds the result into the `HookOutcome` the
   host actually acts on:
   - a successful non-gate `deny` downgrades to `pass` (an observer event can never block);
   - an `aborted` failure always resolves to `pass`;
   - a non-gate failure always resolves to `pass`;
   - a gate failure resolves to `pass` unless `hook.on_failure === "deny"`, in which case it denies
     with a message wrapping the failure's own.

### 4.2 Matching semantics (`match.ts`) — what `runner.select` actually evaluates

`argText(args, key)` (`packages/hooks/src/match.ts:112-123`) reads one argument field as the text a pattern is tested
against, with four rules each pinned by a dedicated test (`packages/hooks/tests/unit/match.test.ts:92-192`):
- **Own properties only** — `Object.prototype.hasOwnProperty.call` guards the read, so a filter
  keyed `constructor` or `toString` cannot resolve through the prototype chain and match every call.
- **A non-object `arguments` value never matches** — there is no fallback to stringifying the whole
  value; failing to read the named field is failing to narrow, by the module's own stated
  direction ("every rule here is a narrowing", `packages/hooks/src/match.ts:1-9`).
- **A non-string value is `JSON.stringify`'d** — `null` becomes `"null"`, numbers their digits,
  objects compact JSON in insertion-key order, so a pattern against a structured argument is
  key-order-dependent.
- **An unserializable value yields no match** (`undefined`) rather than throwing — a circular
  object or a `BigInt` fails to stringify and a function or symbol produces `undefined` directly.

`matchesCandidate(compiled, candidate)` (`packages/hooks/src/match.ts:145-163`) combines a compiled filter and a
candidate: an `undefined` filter always matches (including with no candidate, which is what lets
one runner serve tool and non-tool events alike); a `broken` filter or a missing candidate never
matches; `tool` patterns are **alternatives** (any one matching is enough) while `args` entries are
**conjunctive** (every one must match); matching is case-sensitive; and `args` patterns are
**unanchored** — a pattern matches anywhere in the value, anchoring being the operator's job. Each
combination rule is individually pinned in `match.test.ts` (lines 81-181).

`compileMatch` (`packages/hooks/src/match.ts:54-87`) compiles `tool` patterns via `globToRegExp` and `args` patterns as
plain `RegExp`s, **without** the `g`/`y` flags — a stateful `lastIndex` would make one call's result
depend on the previous one's. A pattern that fails to construct sets `broken: true` (permanently
non-matching, never ignored) and logs a warning naming the field and pattern (`:68-81`; pinned by
`packages/hooks/tests/unit/match.test.ts:137-140`). The doc comment states this path is reachable only for an embedder that
skips validation: "the loop's schema already rejects an uncompilable `args` pattern at config read
time, so `broken` is reachable only for an embedder that skipped validation" (`packages/hooks/src/match.ts:47-49`) —
`hookSchema`'s own `superRefine` is what performs that rejection (`packages/capability/src/hooks-config.ts:380-450`).

### 4.3 `compileWorkspaceHooks` — folding a list of results into one `LifecycleHook` verdict

For a **gate** event (`packages/hooks/src/capability.ts:136-159`): iterates every selected spec in
order; a `deny` short-circuits the whole loop immediately (test:
`packages/hooks/tests/component/capability.test.ts:239-263`, "short-circuits on the first deny, so
an operator judges first"); an `advise` is appended to a running list; a `rewrite` replaces the
working arguments (`current`), and **re-selection is not re-run** against the new arguments — "a
later rewrite does not re-run selection" (`packages/hooks/src/capability.ts:130-134`) — but every *subsequent* hook in
the same pass now sees the invocation rebuilt from the replaced arguments (test:
`packages/hooks/tests/component/capability.test.ts:158-176`, "threads the replacement forward so the last writer wins"). At the
end: if any rewrite occurred, the verdict is `{ kind: "rewrite", arguments, message? }` (joined
advisories as the message); otherwise `{ kind: "advise", message }` if any advisory text
accumulated, else `{ kind: "pass" }` (`:152-156`).

For an **observer** event (`:161-167`): all selected hooks run concurrently via
`Promise.all(...map(run))`; the method itself returns `void`. Unlike the gate closure, nothing here
folds the individual runs into one ordered outcome, so invariant #11's "operator always precedes
plugin" guarantee — meaningful where a fold produces a single verdict or an ordered array — has no
observable effect at an observer event: the hooks are still *dispatched* in configuration order
(`.map` iterates the array in order), but `Promise.all` gives no guarantee about the order in which
their underlying subprocesses actually complete or log.

For a **compaction** event (`pre_compact`, `:169-181`): every selected hook runs in sequence; each
successful `context` outcome becomes one `{ source: "hook", text }` `CompactionContribution`,
collected into an array; anything else (pass, failure, advise, deny) contributes nothing.

`EVENT_METHOD` (`:71-85`) is a **total** record over gate+observer+compaction events mapping each to
its `LifecycleHook` method name (mechanical `snake_case`→`onCamelCase` except the two tool events,
which predate the naming). Only the methods with a configured spec are ever defined on the returned
object (`:183-194`), and the function returns `undefined` when nothing gate/observer/compaction-shaped
is configured (`:194`; test: "returns undefined when nothing gate- or observer-shaped is
configured", `packages/hooks/tests/component/capability.test.ts:60-66`).

#### Portable lifecycle and direct MCP execution

`createHookRunner` caps active async command hooks at `MAX_BACKGROUND_HOOKS = 8`; excess work waits
in FIFO order. Async output is not a verdict for the current event. `run_end`/`SessionEnd` always
waits so shutdown does not discard the command. `additional_context_limit` narrows stdout capture;
zero keeps the host default. `status_message` is retained as display metadata but is not injected
into the transcript. Production: `scheduleBackground` and `run` in
`packages/hooks/src/runner.ts`. Test: async, SessionEnd and plugin-environment cases in
`packages/hooks/tests/component/runner.test.ts`.

An `mcp_tool` hook calls the run-scoped `MCP_HOOK_TOOL_PORT` populated only after the MCP pool opens.
It does not traverse the model's tool dispatcher and therefore cannot recursively fire tool hooks.
MCP absence, tool failure, cancellation and timeout become ordinary `HookResult` failures; schema
policy makes them fail open. Portable SessionEnd MCP entries are skipped during dialect conversion.
Production: `MCP_HOOK_TOOL_PORT` in `packages/capability/src/hooks-config.ts`, its provider in
`packages/loop/src/runtime/orchestrator.ts`, `createWorkspaceHooksCapability` in
`packages/hooks/src/capability.ts`, and `convertHooksDocument` in
`packages/kernel/src/plugins/hook-dialects.ts`. Test: direct MCP cases in
`packages/hooks/tests/component/runner.test.ts` and conversion cases in
`packages/kernel/tests/integration/plugin-manifest.test.ts`.

### 4.4 `runHookCommand` — spawn/bound/kill state machine

Injectable deps (`spawn`, `killTree`, `ownProcessGroup`, `resolveShell`, `shellArgs`, `timers`,
`now`, `logger`) all default to real implementations (`packages/hooks/src/subprocess.ts:380-388`).
`detached` comes from `ownProcessGroup()` and is **never** passed unconditionally — POSIX process
groups vs. Windows `DETACHED_PROCESS`, whose console-less child would be a silent do-nothing spawn
(`:361-367`; see also the repo-wide Windows rule this mirrors).

Just before spawning, `hooks.spawn` is logged at debug with `hook_event`, `shell_file`, `detached`,
`timeout_ms`, `stdin_bytes` and `data_truncated` — never the command text or its arguments
(`packages/hooks/src/subprocess.ts:409-420`; pinned by `describe("hooks.spawn")`,
`packages/hooks/tests/component/observability.test.ts:121-152`).

Settlement is driven by four independent signals that must all resolve before the promise settles:

| Signal | Effect |
|---|---|
| `timeoutHandle` fires | `timedOut = true`; `startKill()` (SIGTERM, then SIGKILL after `killGraceMs`) |
| `signal` (AbortSignal) aborts | `aborted = true`; `startKill()` |
| child `exit` event | records `exitResult`; may trigger settle once `close` and stdin are also done |
| child `close` event | records `closeResult`; same |
| child `stdin` `error`/`close` | `stdinDone = true`; same |

`finishAfterProcessEvents` (`:527-545`) settles immediately (via `setImmediate`) once `exit`,
`close` **and** `stdinDone` have all landed; if only one of `exit`/`close` has landed it waits up to
`EXIT_DRAIN_MS = 100` (`:44`) before forcing settlement and destroying the stdout/stderr streams
(tests: "exit without close settles after the drain window",
`packages/hooks/tests/unit/subprocess.test.ts:183-196`). A spawn that throws synchronously settles
immediately with `spawnError` set and never reaches the child machinery (`:430-433`; tests
`packages/hooks/tests/unit/subprocess.test.ts:299-320`). An already-aborted signal short-circuits **before** any spawn at all
(`:404`; test `packages/hooks/tests/unit/subprocess.test.ts:273-281`).

`killAll` (`:457-467`), used by both `startKill`'s SIGTERM and its SIGKILL escalation, is a
**two-tier** strategy: it first calls `killTree(pid, sig)` and only falls back to `child.kill(sig)`
directly when the tree walk reports failure or the child never had a `pid` at all. Pinned by "falls
back to killing the lone process when the tree walk fails" and "kills directly when the child has
no pid" (`packages/hooks/tests/unit/subprocess.test.ts`), and confirmed against a real spawned
process tree by "falls back to the child's own kill when the process group cannot be reaped"
(`packages/hooks/tests/integration/bun-spawn.test.ts:40-56`). Once the child has settled, if the
deadline (not abort) fired, `hooks.timeout_kill` is logged at warn with `hook_event`, `timeout_ms`,
`escalated_to_sigkill` and `tree_killed` (`packages/hooks/src/subprocess.ts:499-508`; pinned by `describe("hooks.timeout_kill")`,
`packages/hooks/tests/component/observability.test.ts:202-230`).

`stdin` is fed via `stdin.end(req.stdin, "utf8")` (`:566`) with an `error` listener registered
*before* the write, specifically to swallow `EPIPE` from a hook that never reads stdin — "an
unhandled `EPIPE` on a stream with no `error` listener takes the host process down"
(`:10-13`; test: "a hook that never reads stdin does not take the host down",
`packages/hooks/tests/unit/subprocess.test.ts:108-115`). **This is a seam guarding the injectable `SpawnFn`, not something
the production spawn can hit.** `stdinDone` is initialized `child.stdin === null`
(`packages/hooks/src/subprocess.ts:454`), and the real Bun spawn (`bunSpawn`, `:265-336`) always returns `stdin: null`
(`:324`) because the payload is supplied at spawn time as `stdin: new Blob([options.input])`
(`:274`) — the doc comment on `HookSpawnOptions.input` states this plainly: "Payload supplied at
spawn time on Bun, whose child-process stdin drops writes" (`:85-86`). So in production the
`stdin.on("error")`/`.end()` branch at `:555-567` never runs at all; it exists to protect a
test double (`FakeChild`) that models a live writable stream, which is what
`packages/hooks/tests/integration/real-subprocess.test.ts:118-126` exercises through `bunSpawn` — that test proves a large payload
neither crashes nor deadlocks, but it never reaches the `stdin.on`/`.end()` code, because the real
path avoids the EPIPE hazard structurally rather than by catching it.

### 4.5 `parseHookStdout` — order of interpretation

1. `opts.truncated` ⇒ immediate failure, "stdout exceeded the capture limit" (`packages/hooks/src/parse.ts:202`).
2. Empty/whitespace-only stdout ⇒ `pass` (`:203`).
3. Non-JSON or non-object JSON ⇒ failure (`:206-213`).
4. `body.kind === undefined` ⇒ delegate to `translateForeignOutcome` (§4.6); its result (or `pass`
   as fallback) is returned (`:216-219`).
5. `body.kind` present but not a string ⇒ failure (`:221`).
6. Otherwise switch on `"pass"|"deny"|"advise"|"rewrite"|"context"`, each with its own field
   validation, defaulting/degradation rules, and `opts.allowContext`/`opts.allowRewrite` gating
   (`:223-264`); unknown `kind` ⇒ failure naming the (clamped) value (`:264`).

Every `kind`'s degradation rule, individually tested:

| `kind` | Input | Outcome | Test |
|---|---|---|---|
| _(none)_ | Bare `{}` or `{"other":1}` — no recognized field at all | `pass` | `packages/hooks/tests/unit/parse.test.ts:20-21` |
| `deny` | `message` absent, empty, or **not a string** (e.g. `7`) | `deny` with placeholder `"denied by hook (no reason given)"` | `packages/hooks/tests/unit/parse.test.ts:223-231` |
| `advise` | `message` absent | degrades to `pass` | `packages/hooks/tests/unit/parse.test.ts:240-245` |
| `context` | `text` absent or empty/whitespace, at a `CONTEXTUAL` fire point | degrades to `pass` | `packages/hooks/tests/unit/parse.test.ts:261-266` |
| `context` | any non-empty `text`, at a gate (`opts.allowContext === false`) | `bad_output`, `"a 'context' outcome is not valid at this event"` | `packages/hooks/tests/unit/parse.test.ts:247-252` |
| `rewrite` | `opts.allowRewrite === false`, or `arguments` not a plain object (string, array, absent) | `bad_output`, `"arguments cannot be replaced at this event"` / `"replacement arguments are not an object"` | `packages/hooks/tests/unit/parse.test.ts:178-193` |

`translateForeignOutcome`'s own literal reason strings are enumerated in §4.6.

### 4.6 `translateForeignOutcome` — reading the dialect that carries no `kind`

Order of checks, and why each precedes the next (`packages/hooks/src/parse.ts:132-178`):

1. **Blocking check first.** `permissionDecision ∈ {deny, block}` (nested under
   `hookSpecificOutput` or top-level `decision`) or `continue === false` ⇒ immediate `deny`,
   regardless of anything else in the body (`:140-142`). This precedes replacement-argument
   handling deliberately: "refusing a body that both denies and carries `updatedInput` would make
   it bad output, which `on_failure` then resolves to a **pass** by default. The contradiction
   would turn a block into an allow" (`:109-113`).
2. A decision present, not `allow`/`approve`, yet **also** carrying `updatedInput` ⇒ bad output,
   with the reason naming the offending decision — `` `replacement arguments cannot accompany a
   '${decision}' decision` `` (or "that decision" when `decision` is not itself a string)
   (`:146-149`).
3. `decision === "ask"` ⇒ `advise` if it has a reason, else `pass` (`:151-153`) — "ask" has no
   Clarvis gate counterpart.
4. `additionalContext` read **before** honoring a plain allow, because the dialect lets one body
   carry both an `allow` and context (`:104-107`, `:155-157`). The field is read under **three**
   spellings — `hookSpecificOutput.additionalContext`, top-level `additionalContext`, and a third,
   snake_case `additional_context` (`:156`) — none of which is documented anywhere else in this
   file; pinned by "every context spelling … becomes a context outcome"
   (`packages/hooks/tests/unit/parse.test.ts:73-81`).
5. `updatedInput` present ⇒ rewrite if `opts.allowRewrite`, else bad output; the replacement must be
   a plain object or it is bad output (`:159-168`). This branch fires **even with no decision field
   at all** — "replacement arguments carry their own intent" (`:115-119`, `:159`).
6. Non-empty offered context ⇒ `context` if `opts.allowContext`, else `advise` (never dropped)
   (`:170-174`).
7. `allow`/`approve` with nothing else offered ⇒ `pass` (`:176`).
8. Otherwise `undefined`, which the caller treats as `pass` (`:177`, `packages/hooks/src/parse.ts:219`).

### 4.7 `buildSeedBlock` — the `session_start` pinned context block

Runs every `session_start` hook (`CONTEXT_HOOK_EVENTS`) through `runner.select`/`runner.run`,
collecting each successful `context` outcome's text; catches **any** thrown error per hook (the
production runner never throws, but this guard is exercised against a runner double that does) and
logs a warning instead of propagating (`packages/hooks/src/capability.ts:248-270`; test:
`packages/hooks/tests/component/capability.test.ts:720-746`, "swallows a throwing context hook
rather than failing the run"). Returns `undefined` when nothing contributed; otherwise
`` `${HOOKS_SEED_MARKER}\n${texts.join("\n\n")}\n${HOOKS_SEED_CLOSE}` `` (`:269-270`).

Confirmed against a **real** POSIX shell, not just the runner-double above, by
`packages/hooks/tests/integration/capability-real-subprocess.test.ts`: "wraps every context hook's
text in one marked seed block", "swallows a failing context hook rather than failing the run", and
"contributes nothing when the context hooks emit no context" — all driving
`createWorkspaceHooksCapability`/`buildSeedBlock` end to end through a live shell.

### 4.8 `createWorkspaceHooksCapability.forRun` — per-run activation

1. `opts.resolveHooks(ctx) ?? []`; if empty, returns `null` — the capability does not activate
   (`packages/hooks/src/capability.ts:363-364`; test: "does not activate for a run with no hooks
   configured", `packages/hooks/tests/component/capability.test.ts:615-621`). Re-read on **every** call (`WorkspaceHooksOptions.resolveHooks`
   remark, `:323-328`; test: "re-reads the configuration on every run", `packages/hooks/tests/component/capability.test.ts:623-632`).
2. `filterHookEnv(opts.environment, { denyExact: runCredentialNames(ctx, opts.credentialNames?.() ??
   []) })` builds the per-run child environment (§4.9).
3. Logs `hooks.env_filtered` with only the withheld **counts**, never names
   (`packages/hooks/src/capability.ts:370-378`).
4. Builds a `HookRunner` bound to `ctx.workspaceRoot`, the filtered env, the normalized logger
   (`ctx.logger ?? NOOP_LOGGER`, `:369`), and `ctx.executionId` as `sessionId` (`:379-389`).
5. `compileWorkspaceHooks` builds the `LifecycleHook` (or `undefined` if nothing gate/observer/
   compaction-shaped is configured). The host-derived `hook_user_prompt_expansion.command_name`,
   when present, is read once into a prompt context (`packages/hooks/src/capability.ts:391-395`).
   The returned `RunCapability` carries `lifecycle: [hook]` only when defined, and `seedBlock`
   first runs the prompt observers and then `buildSeedBlock` (`:396-403`), so a
   context-only config still contributes; a hook-only config contributes `undefined` from
   `seedBlock`, per test `packages/hooks/tests/component/capability.test.ts:764-771`). `forAgent` always returns `null` — no
   per-agent surface (`:396`-`:404`; test `packages/hooks/tests/component/capability.test.ts:634-642`).

`runUserPromptExpansionHooks` (`packages/hooks/src/capability.ts:197-231`) returns immediately when
there is no host command context, selects only `PROMPT_HOOK_EVENTS`, fires each selected command,
and swallows structural runner throws. Tests pin one exact fire with the external event name and
qualified generic command, plus zero fires without the context; a rejecting structural runner is
also swallowed and reported (`packages/hooks/tests/component/capability.test.ts:662-718`). The settings assembler creates that
context only for a resolved user-invoked skill and omits it for ordinary prompts and model-initiated
loads (`packages/kernel/src/runs/settings-assembler.ts:482-488`; tests
`packages/kernel/tests/component/settings-assembler.test.ts:549-607`).

The `Capability` object itself (returned by `createWorkspaceHooksCapability`, not its activation)
**always** declares `seedMarker: HOOKS_SEED_MARKER` regardless of whether any hook is configured
(`:358`-`:364`), so a stale `<workspace-hooks>` block from a prior run is stripped even on a later run
where hooks are configured away entirely (test: "always declares its seed marker, so a stale block
is stripped even when off", `packages/hooks/tests/component/capability.test.ts:607-613`).

### 4.9 `runCredentialNames` — the denylist a run's own credential surface derives

Collects, per run (`packages/hooks/src/capability.ts:298-313`):
- every provider's `api_key_env` (when set);
- every name `${VAR}`-interpolated into a provider's own `headers` and into each of its `models`
  headers (`models` is a **record**, read via `Object.values` — a `for…of` directly over it "would
  drop every model-level header in silence", `:294-296`; pinned by the two "T9" tests, one per
  level — "denies the variables a provider interpolates into its own headers" and "denies the
  variables a MODEL interpolates into its headers" —
  `packages/hooks/tests/unit/credential-names.test.ts:46-93`);
- every name interpolated into each MCP server's `env` and `headers`;
- plus `extra` (the caller-supplied `credentialNames` list) — because "the kernel narrows a run's
  `servers` to those whose tools some profile actually grants," so a configured-but-unused MCP
  server's credential would otherwise never be named even though its token is still present in the
  inherited environment (`:283-289`; test: "keeps host-managed names even when the run narrowed
  every server away", `packages/hooks/tests/unit/credential-names.test.ts:41-44`).

### 4.10 `createHooksCapability` — wrapping an already-built hook list

A second, materially different constructor, alongside `createWorkspaceHooksCapability`
(`packages/hooks/src/capability.ts:420-435`). It takes `hooks: readonly LifecycleHook[]` that are
already built — not a `HookConfig[]` to resolve from settings — and an overridable `name` that
defaults to `HOOKS_CAPABILITY_NAME` (`:420-426`). Its `forRun` returns `null` only when the supplied
list is empty; otherwise it returns a `RunCapability` whose `lifecycle` is the list **verbatim**
and whose `forAgent` always returns `null` (`:426-432`). Three asymmetries from
`createWorkspaceHooksCapability`:
- **No `seedMarker` at all** — the returned `Capability` object carries only `name` and `forRun`
  (`:424-434`), unlike `createWorkspaceHooksCapability`'s `Capability`, which always declares
  `HOOKS_SEED_MARKER` (`:361`).
- **The hook list is fixed at construction**, not re-resolved per run — there is no
  `resolveHooks(ctx)` call here at all.
- **The capability name is a parameter**, not hard-coded to `HOOKS_CAPABILITY_NAME`.

Pinned by `describe("createHooksCapability")`: "does not activate for an empty hook set", "carries
the supplied hooks and contributes no per-agent surface", and "defaults to the registry name and
accepts an override" (`packages/hooks/tests/component/capability.test.ts:821-841`).

## 5. Invariants

The following invariants govern the behaviour covered above.

1. **A hook's runner surface never throws.** `runHookCommand` documents "**Never rejects**"
   (`packages/hooks/src/subprocess.ts:357`) and `HookRunner.run` documents "Never rejects"
   (`packages/hooks/src/runner.ts:96`). Pinned by the spawn-throw tests
   (`packages/hooks/tests/unit/subprocess.test.ts:299-320`) and by `compileWorkspaceHooks`'s "gate
   method never throws, whatever the runner reports"
   (`packages/hooks/tests/component/capability.test.ts:311-322`).
2. **An observer event can never deny, however the hook resolves.** `runner.resolve`: a successful
   non-gate `deny` downgrades to `pass` (`packages/hooks/src/runner.ts:583`); a non-gate failure resolves to `pass`
   regardless of `on_failure` (`:584`). Pinned by `packages/hooks/tests/component/runner.test.ts:934-954`.
3. **Cancellation never denies, even for a fail-closed hook.** `runner.resolve`: `aborted` resolves
   to `pass` before `on_failure` is even consulted (`packages/hooks/src/runner.ts:586`). Pinned by
   `packages/hooks/tests/component/runner.test.ts:984-998` and by `classify`'s precedence
   (`aborted` outranks `timeout`, `packages/hooks/src/runner.ts:215-217,238`).
4. **Exit code 2 at a gate is a verdict (`deny`), not an ordinary failure**, and is honoured even
   with an empty stderr (falls back to "denied by hook (no reason given)"). Production:
   `packages/hooks/src/runner.ts:246-251,224-230`. Pinned by
   `packages/hooks/tests/component/runner.test.ts:703-722` and the real-shell integration path is
   exercised indirectly (the same classify function). At a non-gate (observer) event the same exit
   code 2 is an ordinary `exit_nonzero` failure (`packages/hooks/src/runner.ts:252-261`; test
   `packages/hooks/tests/component/runner.test.ts:752-765`).
5. **A command that does not exist is `exit_nonzero` (code 127), never `spawn_failed`** — "what
   gets spawned is the shell, and the shell exists" (`packages/hooks/src/types.ts:116-118`, `packages/hooks/src/runner.ts:221-222`).
   Pinned end-to-end by `packages/hooks/tests/integration/real-subprocess.test.ts:162-172`.
6. **A rewrite outcome is representable only where `HookInvocation.rewritable` is true**, and
   attempting one elsewhere is reported as `bad_output`, never silently dropped or silently
   allowed. Production: `packages/hooks/src/types.ts:94-100`, enforced in `packages/hooks/src/parse.ts:239-241,159-160`. Pinned by
   `packages/hooks/tests/unit/parse.test.ts:178-193` (our own `rewrite` kind), by
   `packages/hooks/tests/unit/parse.test.ts:91-152` (the foreign dialect's `updatedInput`, including the `GATE`-scoped case
   "arguments cannot be replaced at this event"), and by
   `packages/hooks/tests/component/runner.test.ts:742-750`.
7. **`REWRITABLE_EVENTS` contains only `pre_tool_use`, not `post_tool_use`.** A rewrite fired after
   the call has already run "would name a decision nothing can still act on"
   (`packages/hooks/src/event-serialization.ts:36-40`). Unpinned directly by a dedicated `post_tool_use`-rewrite test in
   this package (the constraint's *effect* is pinned generically by the `allowRewrite`-off tests in
   `parse.test.ts`, but no test in this package specifically drives `post_tool_use` through
   `hookInvocationFor` and asserts `rewritable` is false there).
8. **A rewrite replaces arguments wholesale, never merges them.** Stated at the `HookOutcome` type
   (`packages/hooks/src/types.ts:152`) and at the loop's own `HookVerdict` (`packages/capability/src/api.ts:536-537`,
   "The replacement is total, not a merge"). Within `compileWorkspaceHooks`, later hooks see the
   replaced arguments and "the last writer wins" (`packages/hooks/src/capability.ts:133`); pinned by
   `packages/hooks/tests/component/capability.test.ts:158-176`.
9. **Selection is decided once per fire point, against the model's original arguments, and is not
   re-run after a rewrite.** `compileWorkspaceHooks`'s gate closure calls `runner.select` exactly
   once, before the loop over selected specs (`packages/hooks/src/capability.ts:143`); a later replacement changes
   `current`/`inv` for subsequent hooks' *invocation* but does not re-select which specs fire
   (`:123-127`). Unpinned by a test that would prove re-selection does *not* happen (the existing
   "threads the replacement forward" test only proves the replaced arguments are visible to the next
   hook, not that a hook which would have newly matched the replaced arguments is excluded).
10. **A `deny` short-circuits the gate fold; hooks after it never run.** `packages/hooks/src/capability.ts:146`
    ("return" inside the `for` loop). Pinned by
    `packages/hooks/tests/component/capability.test.ts:239-263`.
11. **Configuration order is load-bearing: operator hooks always precede plugin hooks**, and the
    runner's `select` preserves whatever order the input list is in
    (`packages/hooks/src/runner.ts:90-93,400-414`). The *production* of that order (operator-then-plugin) is
    `hooksSettingsSpec.merge` in `packages/loop/src/runtime/capabilities/hooks.ts:78-81`, outside
    `@clarvis/hooks` itself but consumed by it; the ordering guarantee "an operator always gets
    the first verdict" is stated at `packages/hooks/src/runner.ts:91-92` and at `packages/loop/src/runtime/capabilities/hooks.ts:72-73`, and demonstrated by
    the short-circuit test in #10 above (operator hook, named `"operator"`, denies before the
    plugin hook named `"plugin"` runs).
12. **The `session_start`/`pre_compact` seed/contribution channels never fail or block a run.**
    `hookSchema`'s `superRefine` rejects `on_failure` on these events at config time
    (`packages/capability/src/hooks-config.ts:433-440`); `buildSeedBlock` additionally swallows a throwing runner in
    production code, not merely by convention (`packages/hooks/src/capability.ts:238-246,261-266`; pinned by
    `packages/hooks/tests/component/capability.test.ts:720-746`).
13. **The credential-environment denylist is derived per run, never a static list, and is applied
    with keep-list precedence over both deny rules — and a fourth, unconditional tier sits after
    all three.** `filterHookEnv`'s precedence is keep-list → exact denylist → name-shape
    (`packages/hooks/src/env.ts:151-155,167-179`), and `opts.add` is applied last, exempt from every rule
    (`packages/hooks/src/env.ts:110-111,175`); pinned by "an exact denylist entry cannot strip a keep-listed variable"
    (`packages/hooks/tests/unit/env.test.ts:73-77`), "a keep-listed variable counts as neither"
    (`packages/hooks/tests/unit/env.test.ts:115-118`), and "added variables are applied last and are never filtered"
    (`packages/hooks/tests/unit/env.test.ts:83-91`).
14. **Withheld environment variables are counted, never named**, anywhere in this package's own
    logging. `FilteredHookEnv.denied` carries counts only (`packages/hooks/src/env.ts:120-128,133-139`);
    `createWorkspaceHooksCapability` logs only `denied_count`/`denied_by_exact`/`denied_by_shape`
    (`packages/hooks/src/capability.ts:371-377`). Unpinned by a direct assertion that the log line's JSON never
    contains a credential's name (the `hooks.spawn` log test does assert the *command* is absent
    from its own JSON, `packages/hooks/tests/component/observability.test.ts:151-153`, but no test asserts the same of a denied
    variable's identity specifically for `hooks.env_filtered`).
15. **A hook that never reads stdin cannot bring down the host process — by two distinct
    mechanisms, not one.** For the injectable `SpawnFn` seam (a test double whose `stdin` is a live
    writable stream), the `error` listener registered before the write specifically catches `EPIPE`
    (`packages/hooks/src/subprocess.ts:10-13,555-567`); pinned by `packages/hooks/tests/unit/subprocess.test.ts:108-115`.
    Production's real spawn (`bunSpawn`) never reaches that branch at all: it always returns
    `stdin: null` (`:324`), because the payload was already supplied at spawn time as a `Blob`
    (`:274`), so `stdinDone` starts `true` (`:454`) and the guard code is structurally unreachable.
    `packages/hooks/tests/integration/real-subprocess.test.ts:118-126` ("a hook that never reads a large payload neither crashes nor
    deadlocks") goes through `bunSpawn` and is evidence for the *second* mechanism, not the first —
    it never exercises the `stdin.on`/`.end()` branch.
16. **A hook's whole process tree dies with it on timeout or abort**, via `killTree`, not merely the
    immediate child. Production: `runner.ts` (via `packages/hooks/src/subprocess.ts:457-474`, `killAll`/`startKill`).
    Pinned end-to-end by `packages/hooks/tests/integration/real-subprocess.test.ts:215-229`, "a
    hook's grandchild dies with it".
17. **Truncation sticks for the remainder of a stream once the cap is hit**, rather than marking
    only the boundary chunk. Production: `collector`'s `truncated` flag latches
    (`packages/hooks/src/subprocess.ts:187-205`). Pinned by
    `packages/hooks/tests/unit/subprocess.test.ts:126-137`.
18. **Truncated stdout is never parsed, even if the truncated prefix happens to look like valid
    JSON.** `parseHookStdout` checks `opts.truncated` before anything else
    (`packages/hooks/src/parse.ts:202`). Pinned by `packages/hooks/tests/unit/parse.test.ts:9-15`.
19. **Argument-match patterns are tested only against a clamped prefix** (`ARG_MATCH_MAX_CHARS =
    8192`) of the argument's text, to bound regex work against a model-authored value
    (`packages/hooks/src/match.ts:16-26,160`). Pinned by
    `packages/hooks/tests/unit/match.test.ts:185-191`.
20. **A broken `match.args` regex makes the whole filter never fire, rather than being ignored.**
    `compileMatch` sets `broken: true` on a failed compile, and `matchesCandidate` treats a broken
    filter as never matching (`packages/hooks/src/match.ts:68-81`, `:150`). Pinned by
    `packages/hooks/tests/unit/match.test.ts:137-140` and
    `packages/hooks/tests/component/observability.test.ts:33-58` (the `broken_patterns` count in
    `hooks.selected`).
21. **A hook's compiled `match` is cached by object identity (`WeakMap`) across repeated fire
    points**, so a hook that fires on every tool call pays regex construction once. Production:
    `packages/hooks/src/runner.ts:382,390-397`. Pinned by
    `packages/hooks/tests/component/runner.test.ts:129-135`, "filters are compiled once per spec".
22. **`hooks[].event` is a closed, exhaustive enum of exactly the five vocabulary groups
    (gate+observer+context+compaction+prompt), and `hookSchema` rejects anything else.** Production:
    `HOOK_EVENTS` composition and `z.enum(HOOK_EVENTS, …)` (`packages/capability/src/hooks-config.ts:206-212,239-242`).
    Unpinned directly in this document's scope by a schema-rejection test (the schema itself is
    delegated to [capability-contract-and-vocabulary](../foundations/capability.md); this package treats `event` as an opaque
    string per `packages/hooks/src/types.ts:38-40`, so it has no independent test of the enum's closure).
23. **A prompt-expansion observer fires only for host-supplied user skill-command context, once in
    the seed phase, and can never block the run.** Production:
    `packages/hooks/src/capability.ts:197-231,391-403`; the host supplies it only from a resolved
    skill invocation at `packages/kernel/src/runs/settings-assembler.ts:482-488`. Pinned:
    `packages/hooks/tests/component/capability.test.ts:662-718` and
    `packages/kernel/tests/component/settings-assembler.test.ts:549-607`.
24. **Tool hook matching keeps both wire and canonical identities, while compatible stdin uses the
    external spelling.** Production: `packages/hooks/src/event-serialization.ts:95-124,230-237`,
    `packages/hooks/src/match.ts:145-155`, and `packages/loop/src/runtime/loop/loop.ts:494-508`.
    Pinned: `packages/hooks/tests/component/capability.test.ts:455-495`,
    `packages/hooks/tests/unit/match.test.ts:43-54`, and
    `packages/loop/tests/unit/tool-hooks.test.ts:172-212`.
25. **Async command hooks cannot accumulate unbounded live processes, and SessionEnd is never
    detached.** Production: `MAX_BACKGROUND_HOOKS`, `scheduleBackground`, and `run` in
    `packages/hooks/src/runner.ts`. Test: async and SessionEnd cases in
    `packages/hooks/tests/component/runner.test.ts`.
26. **Plugin hook paths are explicit environment data, not authority.** Only the resolved plugin
    root and writable data directory become `PLUGIN_*`/`CODEX_PLUGIN_*`; the base environment still
    passes through per-run credential filtering. Production: `resolveHooks` in
    `packages/kernel/src/plugins/plugin-manifest.ts`, `filterHookEnv` in
    `packages/hooks/src/capability.ts`, and `createHookRunner` in `packages/hooks/src/runner.ts`.
    Test: plugin environment cases in `packages/hooks/tests/component/runner.test.ts`.
27. **Direct MCP hooks do not recursively trigger tool hooks and cannot fail closed.** They call the
    run-scoped connection façade, not model dispatch, and `hookSchema` rejects `on_failure` for
    `mcp_tool`. Production: `MCP_HOOK_TOOL_PORT`, `createWorkspaceHooksCapability`, and
    `createHookRunner`. Test: direct MCP cases in
    `packages/hooks/tests/component/runner.test.ts`.

## 6. Failure modes and degradation

| Condition | Classification | Where | Resolution |
|---|---|---|---|
| Signal aborted before spawn | `aborted: true`, no spawn attempted | `packages/hooks/src/subprocess.ts:404` | `classify` → `aborted` failure → always resolves `pass` |
| `spawn()` throws | `spawnError` set | `packages/hooks/src/subprocess.ts:430-433` | `classify` → `spawn_failed` failure |
| Child emits `error` | `spawnError` set from the error message | `packages/hooks/src/subprocess.ts:523-526` | same as above |
| Deadline elapses | `timedOut = true`; SIGTERM then SIGKILL after `killGraceMs` | `packages/hooks/src/subprocess.ts:476-483` | `classify` → `timeout` failure (unless `aborted` also true, which outranks it) |
| Abort mid-flight | `aborted = true`; SIGTERM then SIGKILL | `packages/hooks/src/subprocess.ts:484-488` | `classify` → `aborted` failure, outranks `timedOut` |
| Non-zero exit / signalled | `exitCode`/`signal` recorded | `subprocess.ts` (child's own `exit`) | `classify` → `exit_nonzero` (unless gate+code 2+no signal, which is `deny`) |
| stdout exceeds cap | `stdoutTruncated: true` | `subprocess.ts` (`collector`) | `parseHookStdout` refuses to parse → `bad_output`, "stdout exceeded the capture limit" |
| stdout is not JSON at all (bare text, JSON with trailing garbage) | — | `packages/hooks/src/parse.ts:206-209` | `bad_output`, `"stdout is not JSON"` |
| stdout parses to JSON that is not an object (array, `null`, string, number) | — | `packages/hooks/src/parse.ts:211-213` | `bad_output`, `"stdout JSON is not an object"` |
| `kind` is present but not a string (e.g. `7`) | — | `packages/hooks/src/parse.ts:221` | `bad_output`, `"stdout 'kind' is not a string"` |
| `kind` is a string but not one of the five recognized values | — | `packages/hooks/src/parse.ts:264` | `bad_output`, `` `unknown kind '<clamped value>'` `` |

The six JSON-shape sub-cases above are individually pinned by the parametrized table
`packages/hooks/tests/unit/parse.test.ts:195-207` ("`%p` is bad output").
| A representable-but-illegal outcome (`context` at a gate, `rewrite` where not rewritable, non-object rewrite arguments) | — | `packages/hooks/src/parse.ts:159-168,239-264` | `bad_output`, specific reason string |
| A gate hook itself throws (only reachable via a non-production `HookRunner`) | — | n/a (production runner never throws) | `buildSeedBlock` catches and logs; the engine's own blanket fail-closed handling of a *thrown* `LifecycleHook` method is documented as "unreachable here by construction" (`packages/hooks/src/capability.ts:118-121`) |

`HookFailure.stderr` carries a clamped tail (`STDERR_TAIL_CHARS = 2_000`,
`packages/hooks/src/runner.ts:40,101-103,234-236`) of the child's stderr for every failure kind except
`deny`-via-exit-2 (which instead reads stderr as the deny *message*, clamped via
`cleanHookMessage`). Stderr is "only ever logged, never shown to the model"
(`packages/hooks/src/subprocess.ts:15-16`; `packages/hooks/src/types.ts:130`).

`HookOutcome`/`HookFailure` messages headed to the model (`deny`, `advise`, `context.text`) are
clamped to `HOOK_MESSAGE_MAX_CHARS = 4_000` and stripped of control characters
(`cleanHookMessage`, `packages/hooks/src/parse.ts:67-70`), including in the *failure reason string* itself, which is
also length-guarded to under 200 chars for an oversized `kind` value (`packages/hooks/src/parse.ts:264`; pinned by
`packages/hooks/tests/unit/parse.test.ts:292-308`).

## 7. Coupling

**Depends on** (production, `packages/hooks/package.json:44-47` — exactly two entries):
`@clarvis/capability` (the `HookConfig` type only — no value import, and no dependency on `zod` at
all: the package consumes `hookSchema`'s inferred type but defines no schema of its own; also
`LifecycleHook`, `HookVerdict`, the thirteen `*Context` types, `Capability`/`RunCapability`/
`RunCapabilityContext`, `Logger`/`NOOP_LOGGER`, and the hooks-config vocabulary consumed in
`packages/hooks/src/capability.ts:25-38` and `packages/hooks/src/event-serialization.ts:2-24`); `@clarvis/tools/shell` — the narrow
subpath carrying `resolveShell`/`shellArgs`/`killTree`/`ownProcessGroup`/`ShellSpec`
(`packages/hooks/src/subprocess.ts:20-26`), chosen specifically to avoid pulling in the whole tool registry —
the root export carries ajv, diff, ignore, picomatch and ripgrep, "the wrong price for a consumer
that only needs to know which shell this host speaks and how to kill what it spawned"
(`packages/tools/src/shell-entry.ts:5-11`).

**Must never depend on `@clarvis/loop`.** Stated as the acyclicity reason at
`packages/hooks/src/index.ts:6-9` and at `packages/hooks/src/types.ts:5-10`: "the loop depends on this package, so this
package must never depend on the loop." Enforced structurally by every type in `types.ts` being
written so a `HookConfig` (the loop's validated shape) is assignable to `HookSpec` without a cast,
and by `event` being treated as an opaque `string` rather than the loop's closed union
(`packages/hooks/src/types.ts:38-40`). Nothing under `packages/hooks/src` imports `@clarvis/loop`
statically or dynamically — the name occurs there only in TSDoc prose
(`packages/hooks/src/index.ts:7`, `packages/hooks/src/types.ts:5,37`).

**Consumed by** `@clarvis/loop`, and only through `./capability`, and only **dynamically**, gated by
`useHooks = builtins?.hooks !== false && env.CLARVIS_HOOKS_ENABLED && resolveHooks !== undefined`
(`packages/loop/src/runtime/build-run-deps.ts:401-403,524-531`). The bare `.` entrypoint has **no
production consumer anywhere in the repository** — its only importers are this package's own
integration tests (`packages/hooks/tests/integration/bun-spawn.test.ts:15`,
`packages/hooks/tests/integration/real-subprocess.test.ts:26`) and one type-only import in the
engine's suite (`packages/loop/tests/architecture/logger-drift.test.ts:23`). `@clarvis/kernel`,
`@clarvis/server` and `@clarvis/code` never reach `@clarvis/hooks` at all, statically or
dynamically — the closest any of them comes is naming it in a TSDoc remark; the kernel's
plugin-manifest reader
(`packages/kernel/src/plugins/hook-dialects.ts`, delegated to [plugins-and-marketplace](../hosts/plugins.md)) inverts
`EXTERNAL_TOOL_NAMES`/`EXTERNAL_HOOK_EVENT_NAMES` for its own purposes without importing this
package.

**`hooks-config.ts` is forced to live in `@clarvis/capability`**, not `@clarvis/hooks`, by the fact
that `HOOKS_SETTINGS_FIELDS`/`hooksSettingsSpec` (`packages/loop/src/runtime/capabilities/hooks.ts`)
is imported by `settings-specs.ts` and hence by the engine's settings/plugin/request schemas —
i.e. by every import of the engine, whether or not `@clarvis/hooks` is ever loaded
(`packages/capability/src/hooks-config.ts:5-14`). Moving the vocabulary into the optional package would make
`builtins.hooks = false` require the package to be installed merely to *validate* configuration.

**`capability.ts` is a separate export subpath from `.`**, forced by the same reasoning in reverse:
`.` (the executor) has zero production consumers of its bare form, while `./capability` is the only
subpath `build-run-deps.ts` ever reaches, and only inside the `useHooks` conditional
(`packages/hooks/src/capability.ts:10-15`; `packages/loop/src/runtime/build-run-deps.ts:526-540`).

**`compileWorkspaceHooks`'s "only define methods with a spec" behavior is load-bearing for two
engine-side fast paths outside this package's scope**: `buildPreFinalizeGate`'s `fastAcceptOk`
(`packages/loop/src/runtime/loop/lifecycle-hooks.ts:224`, `!hooks.some(h => h.preFinalize)`) and an
analogous fast-accept-submit check both key on whether the compiled object carries the
`preFinalize` key at all, not on whether it would resolve to a pass — an object carrying all thirteen
keys would silently disable both fast paths for the whole run (`packages/hooks/src/capability.ts:112-116`). This is
stated as the reason for the "only define methods that have a spec" design but its consumer lives
in [loop-run-lifecycle](../engine/loop-run-lifecycle.md), delegated per the document boundary.

## 8. Open questions

- **Why `pre_delegate_task`, `run_start`, `model_call_error` and `budget_exhausted` have no foreign
  dialect counterpart** is not stated beyond the general principle ("an approximation that fires at
  the wrong moment is worse than an honest gap", `packages/capability/src/hooks-config.ts:101-102`); no comment explains why
  specifically these four rather than some other subset lack a mapping.
- **Invariant #7** (`post_tool_use` is deliberately excluded from `REWRITABLE_EVENTS`) has no direct
  unit test in this package driving `hookInvocationFor("post_tool_use", …)` and asserting
  `rewritable` is `false`; the constraint is enforced by construction (the `Set` literally omits
  it) and by the generic `allowRewrite: false` tests in `parse.test.ts`, but nothing in this read
  set exercises the specific event.
- **Invariant #9** (selection is not re-run after a rewrite) is stated as a documented design
  decision in a `remarks` comment (`packages/hooks/src/capability.ts:130-134`) but the existing test suite proves only
  that later hooks see the *replaced arguments*, not that a hook which would newly match those
  replaced arguments (but not the original ones) is excluded from firing. No test constructs that
  scenario.
- **Whether `denied_by_exact`/`denied_by_shape` counts, or any other field of the
  `hooks.env_filtered` log record, could ever leak a variable's identity through some other field**
  (e.g. if a future change added a details object) is not tested; the current code only ever emits
  counts (`packages/hooks/src/capability.ts:371-377`), so the invariant holds today, but there is no architecture-level
  guard (comparable to `packages/paths`'s literal-scan test) enforcing it against a future
  regression in this package's own tests.
- **The production values `HookRunnerDeps` composes into a `HookRunner`'s `killGraceMs` /
  `maxStdoutBytes` when a **host** other than `createWorkspaceHooksCapability` constructs one** are
  not fully explored here — `createHookRunner` is called with only `workspaceRoot`, `baseEnv`,
  `logger`, `sessionId` in `packages/hooks/src/capability.ts:379-389`, leaving `killGraceMs`/`maxStdoutBytes`/
  `maxStderrBytes` at the subprocess-level defaults (`DEFAULT_KILL_GRACE_MS`,
  `DEFAULT_MAX_STDOUT_BYTES`, `DEFAULT_MAX_STDERR_BYTES`) for every workspace-hook run in
  production; whether any other host in the repository overrides them is outside this document's
  scope (`packages/loop/src/runtime/build-run-deps.ts` construction call was not traced past the
  `useHooks` gate cited above).
- **Translating a plugin's foreign hooks document into Clarvis's vocabulary** (`hook-dialects.ts`)
  is explicitly delegated to [plugins-and-marketplace](../hosts/plugins.md) per this document's scope and is not described here
  beyond its existence and its import of `EXTERNAL_TOOL_NAMES`
  (`packages/kernel/src/plugins/hook-dialects.ts:29-30`).
- ~~**The rationale for the specific set of `KEEP_EXACT` names and `SECRET_NAME`/`SECRET_PREFIX`
  patterns.**~~ **The membership rules are now stated at the source.** `KEEP_EXACT` has three groups
  and the third is empty on purpose: what a shell needs to start and behave (plus the Windows
  equivalents), and the version-manager and toolchain roots that make `bun`, `cargo` or `java`
  resolvable — and *nothing* kept merely because a hook is likely to want it, since a name promoted
  into the keep-list becomes unremovable by any future secret rule
  (`packages/hooks/src/env.ts:19`–`:44`). `SECRET_NAME` is deliberately not the same pattern as
  `@clarvis/capability`'s `SENSITIVE_KEY`, and must not converge with it: that one redacts a value
  already being logged, where over-matching costs only legibility, so it is unanchored; this one
  *drops an environment variable*, where over-matching breaks the hook — hence the separator
  anchoring and the extra `auth`/`credentials`/`session` families a redactor has no reason to carry
  (`packages/hooks/src/env.ts:79`–`:94`). The deeper threat model remains delegated to
  [security-confinement-and-redaction](../cross-cutting/security.md); the mechanism and precedence
  are in §3.6, §4.9 and invariant #13 here.
