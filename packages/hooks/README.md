# @clarvis/hooks

Executes **workspace hooks** — the event-triggered shell commands an operator declares in
`settings.json` or a plugin manifest — and turns each one's output into a verdict the agent loop can
act on.

This package owns the risky half of that job: matching a hook against a pending tool call, spawning
the command through the host shell, feeding it a JSON payload on stdin, bounding what it can print
and how long it can run, killing its whole process tree when it overruns, and deciding what a
failure means. Its runner does **not** know what a lifecycle hook is — it exposes a structurally
typed `HookRunner` (`select` / `run` / `resolve`), which is what keeps the dependency graph acyclic
(`tools → hooks → loop`). **It must never import `@clarvis/loop`.**

It depends on `@clarvis/tools` via the `./shell` subpath — `resolveShell`, `shellArgs`, `killTree`,
`ownProcessGroup` — so a hook command behaves exactly like a `shell` tool command on the same host,
and on `@clarvis/capability` for the `Capability` contract its `./capability` entry implements.

## Contract

Hook matching, subprocess execution, payload dialect, verdicts, failure handling, and loop
composition are specified in [`execution/hooks.md`](../../specs/execution/hooks.md).

## Entry points

| Entry                       | Contents                                                                 |
| --------------------------- | ------------------------------------------------------------------------ |
| `@clarvis/hooks`            | `createHookRunner`, `filterHookEnv`, matching and parsing                |
| `@clarvis/hooks/capability` | the loop adapter, including exact user skill-command expansion observers |

`./capability` is a **separate entry on purpose**: nothing on `@clarvis/loop`'s eager configuration
path may reach it. The engine's `runtime/capabilities/hooks.ts` holds only the _settings block_,
which is what `settings-specs.ts` imports — keeping the two apart is what makes
`builtins.hooks = false` genuinely not load this package.

The hook _vocabulary_ itself (`hookSchema`, `HookConfig`, `HOOKS_CAPABILITY_NAME`, the event
groups, `HOOK_DEFAULT_TIMEOUT_MS`) lives in `@clarvis/capability`, because the settings block
declares it and the adapter executes against it — so it belongs to neither package alone.

## Test ownership

- `tests/unit/` owns pure environment filtering, credential-name collection, matching and output
  parsing, plus the exhaustive subprocess state machine driven by `FakeChild` and an injected
  clock. No unit test starts a real process or waits on wall-clock time.
- `tests/component/` owns the composed runner and the `Capability` adapter with external effects
  replaced by narrow fakes. These tests prove selection, failure resolution, payload projection,
  lifecycle-method presence and capability activation.
- `tests/integration/` owns real shell, pipe, signal, process-group and environment behavior. Tests
  in this tier import the package through `@clarvis/hooks` or `@clarvis/hooks/capability`; one public
  capability smoke owns real `session_start` execution, while failure policy remains in the component
  runner suite. Process readiness and reaping use bounded observable barriers rather than fixed waits.
- `tests/helpers/` contains typed fakes and builders only. There is no architecture tier here; the
  optional-package and reverse-dependency invariants are owned by `@clarvis/loop`, which can see
  both sides of those edges.

Run one tier with `bun run test:unit`, `bun run test:component` or
`bun run test:integration`. `bun run test` and `bun run test:coverage` continue to discover every
tier together.

## The subprocess contract

- **stdin** — one JSON object, then EOF, **flat**:

  ```json
  {
    "protocol": 1,
    "hook_event_name": "PreToolUse",
    "cwd": "/abs",
    "session_id": "…",
    "tool_name": "Bash",
    "tool_input": { "command": "ls -la" }
  }
  ```

  Identity first, then the event's own fields beside it — nothing nests under a
  wrapper key and nothing appears twice. `hook_event_name` carries the **foreign**
  spelling of the event, because that is what a hook authored elsewhere compares
  against; it falls back to our name for an event the dialect has no word for
  (`run_start`, `budget_exhausted`, …), whose fields likewise keep their Clarvis
  names. `tool_name` / `tool_input` / `tool_response` are the triple the dialect
  documents identically for the two tool events. Built-ins use the compatible
  external spellings, MCP tools use `mcp__<server>__<tool>`, and `load_skill`
  carries `skill` beside its native `name` argument. `CLARVIS_HOOK_TOOL` retains
  the Clarvis wire name and `CLARVIS_HOOK_TOOL_FULL_NAME` carries the stable dotted
  MCP identity when one exists. `session_id` appears only when the
  host supplies one; `protocol` is a Clarvis extension the dialect has no
  counterpart for. On overflow every event field is dropped and
  `payload_truncated: true` is set, so a hook that filters on the event and the
  tool still fires. Arguments never travel through argv, so no shell escaping is
  involved.

- **the external dialect is read too**, so a hook written for another host works unchanged:
  `hookSpecificOutput.permissionDecision` (`deny` / `allow` / `ask`) with
  `permissionDecisionReason`, the legacy `{"decision":"block","reason":"…"}`, `continue:false`,
  `additionalContext`, and `updatedInput` alongside an `allow`. `additionalContext` becomes a
  `context` where there is one and an `advise` at a gate; `ask` degrades to `advise`.
- **`rewrite` replaces the pending call's arguments wholesale** — never a merge, so a hook's effect
  cannot depend on which keys the model happened to send. It is honoured only on `pre_tool_use`;
  asked for anywhere else it is bad output, never a silent no-op. Replacement arguments are still
  validated against the tool's own schema and still meet the command guard, both of which sit
  downstream, and the model is told what actually ran.
- **exit code** — non-zero is a failure even when stdout parsed cleanly, with one exception: **exit
  2 at a gate is a denial**, with the reason taken from stderr. It is the blocking form a shell
  script reaches for when writing JSON is inconvenient.
- **failure** resolves through the hook's `on_failure`: `pass` (the default) lets the event proceed,
  `deny` blocks it. A cancelled run always passes, so teardown never looks like a policy denial.
  This is why a decision to block is read before anything else: routing a contradictory body to
  `on_failure` would resolve a block into an allow.
- **portable lifecycle fields are retained**: `commandWindows` selects a Windows-only command,
  `async` detaches command hooks with an eight-process background ceiling (except `SessionEnd`,
  which always waits), `additionalContextLimit` bounds parsed stdout, and `statusMessage` remains
  available as display metadata. `prompt` and `agent` entries are reported and skipped.
- **`mcp_tool` hooks call the already-open server directly** with recursively expanded
  `${field.path}` input templates. They use the command-hook output contract, fail open when the
  server/tool is unavailable, never recursively trigger tool hooks, and are skipped for
  `SessionEnd`.

## What the child inherits

`cwd` is the workspace root. The environment is the host's, minus this run's provider credentials
and anything whose name looks like a secret, plus `CLARVIS_HOOK_*` describing the fire point. A
plugin hook additionally receives `PLUGIN_ROOT`/`PLUGIN_DATA` and the
`CODEX_PLUGIN_ROOT`/`CODEX_PLUGIN_DATA` compatibility aliases, without adding credential material.
That is credential hygiene, **not a sandbox** — a hook command runs with the operator's own
privileges, which is the point of it being installed/operator-authored config.

Docker and Podman do not disable this policy. The kernel's private hook bridge invokes the admitted
host lifecycle callbacks, retaining command/environment filtering and native gate/rewriting order.
Only configured fire points and validated event contexts cross that bridge; the guest never supplies
a hook command. MCP hooks acquire an admitted host server connection rather than exposing credentials
to the guest. See the [isolated runtime contract](../../specs/hosts/isolated-agent-runtime.md).

## Usage

```ts
import { createHookRunner, filterHookEnv } from "@clarvis/hooks";

const runner = createHookRunner({
  workspaceRoot: "/abs/path",
  baseEnv: filterHookEnv(process.env, { denyExact: ["MY_PROVIDER_KEY"] }).env,
});

const inv = { event: "pre_tool_use", data, candidate, defaultTimeoutMs: 5_000, gate: true };
for (const spec of runner.select(hooks, inv)) {
  const outcome = runner.resolve(await runner.run(spec, inv, signal), inv);
  if (outcome.kind === "deny") break;
}
```

`run` never rejects and `resolve` never throws: every failure mode is a value.

## Diagnostics

`HookRunnerDeps.logger` and `SubprocessDeps.logger` take a `HookLogger` — a local
structural shape (`debug`/`info`/`warn`/`error`) that `@clarvis/capability`'s `Logger`
satisfies, so a host passes its own straight in and this package still depends on no
logging implementation. `subprocess.ts` reads it off the same `deps` bag `runHookCommand`
already takes, so nothing gained a parameter.

| Level            | `event`                | Fields                                                                      |
| ---------------- | ---------------------- | --------------------------------------------------------------------------- |
| `debug`          | `hooks.selected`       | `hook_event, matched, total, broken_patterns`                               |
| `debug`          | `hooks.spawn`          | `hook_event, shell_file, detached, timeout_ms, stdin_bytes, data_truncated` |
| `info` / `debug` | `hooks.verdict`        | `hook_event, kind, hook_index, duration_ms` — `info` for `deny`             |
| `warn`           | `hooks.timeout_kill`   | `hook_event, timeout_ms, escalated_to_sigkill, tree_killed`                 |
| `warn`           | `hooks.command_failed` | the pre-existing failure record, now carrying a stable `event`              |
| `debug`          | `hooks.env_filtered`   | `denied_count, denied_by_exact, denied_by_shape` — **counts only**          |

The hook's own event is `hook_event`, never `event`: `event` is the record's stable
machine name and the two would collide.

**`hooks.env_filtered` names nothing, ever.** The denylist is derived per run from the
request's `api_key_env` entries and the `${VAR}` names interpolated into MCP `env`/`headers`
— that is, it names exactly the variables holding this run's credentials, so publishing a
name would undo the filter it is reporting. `filterHookEnv` therefore returns the counts
(`{ env, denied: { exact, shape } }`) rather than logging them, which keeps the counting
testable and leaves no place where the naming decision could be made wrongly.

A hook's `command` is operator-authored config rather than model-authored text, which is
why the pre-existing failure record still carries a bounded excerpt of it; nothing new
logs a command, and no record carries a hook's stdout, its stdin payload, or the tool
arguments it was matched against.

## Rules that are easy to undo by accident

- **Failure resolution order is the design**: `aborted` → `timeout` → `spawn_failed` →
  `exit_nonzero` → `bad_output`. `aborted` outranks everything and **always passes**, so a cancelled
  run is never reported to the model as a policy denial. A command that does not exist is
  `exit_nonzero` **127**, not `spawn_failed` — what gets spawned is the shell, and the shell exists.
- **stdin is why this could not reuse either existing prototype.** Both the `shell` tool and
  `@clarvis/code`'s local shell spawn with `stdio[0] = "ignore"`, so neither meets the case where a
  hook exits without reading, the write end breaks, and an unhandled `EPIPE` on a stream with no
  `error` listener **takes the host process down**. The listener is registered before the write, and
  a real-subprocess test covers it.
- **Defaults differ per event class**, and the schema's own `timeout_ms` description is generated
  from `HOOK_DEFAULT_TIMEOUT_MS` so the two cannot drift: **5000 ms** for the tool events, which fire
  on every tool call in sequence inside the dispatch; **30000 ms** for `pre_finalize` /
  `pre_delegate_task`, which are O(1) per agent; **2000 ms** for `run_end`.
- **`session_start` is a dedicated context group**, not an observer. Its `{"kind":"context","text":"…"}`
  output is collected by the capability's `seedBlock()` into a pinned, non-evictable entry-context
  block that **survives compaction** rather than being re-injected after it. Its `seedMarker` is
  declared on the `Capability`, so a stale block is stripped from a continuation even on a later run
  with hooks configured away. The schema rejects `on_failure` there, and `buildSeedBlock` swallows
  every failure — a throw from `seedBlock` fails the run.
- **`user_prompt_expansion` is an exact host-command observer.** It fires once from the seed phase
  before a user-invoked skill run, with the qualified command name when the skill came from a plugin.
  It does not approximate an ordinary prompt and does not fire for a model's later `load_skill` call;
  its output and failures cannot block the run.
- **The compiled `LifecycleHook` defines only the methods that have a spec.** Two engine behaviours
  read a method's mere _presence_ — `buildPreFinalizeGate`'s `fastAcceptOk` and the
  fast-accept-submit path — so an object carrying all thirteen keys would switch both off for the whole
  run.
- **Argument rewriting is sequential and selection-stable.** Every matching hook is selected against
  the model's original call. A successful `pre_tool_use` rewrite replaces the entire argument object
  seen by later selected hooks; it never re-runs selection, so one hook cannot silence another. The
  final replacement still passes the tool schema and command guard before dispatch.
