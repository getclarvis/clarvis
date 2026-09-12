# Shell-command analysis, guard modes, allow/deny policy and the judge

> Implemented at `packages/...`. Every claim below is anchored to a file and a named symbol or test. Open questions
> are collected in the final section.

## 1. Purpose

The command guard decides, per tool call, whether the call runs silently, is refused, or is put to
somebody (a person or an LLM) first. It is split across three packages that never see each other's
policy:

- **`packages/tools/src/guard/**` — the analyzer.** It turns a raw shell string into
  `ShellFacts` (per-command `Segment`s, the filesystem paths the command appears to touch, and an
  `undecidable` flag), and turns any tool call into a `GuardContext` carrying resolved `PathFact`s
  (`packages/tools/src/guard/analyze-shell.ts`, `packages/tools/src/guard/context.ts`). It
  ships **no policy**: `RuntimeConfig.guard` and `RuntimeConfig.elicit` are host-supplied ports
  (`packages/tools/src/config.ts`), and `applyGuard`
  (`packages/tools/src/core.ts`) is the only place a tool dispatch consults them.
- **`packages/kernel/src/guard/**` — the policy.** `createShellGuard`
  (`packages/kernel/src/guard/shell-guard.ts`) is a fixed-precedence rule cascade over deny
  host-command escalation, lists, undecidability, workspace containment, credential-file patterns
  and allow lists.
  `createGuardResolver` (`packages/kernel/src/guard/resolver.ts`) picks the run's mode, builds
  the guard, wires the answering channel (human elicitation, LLM judge, or a session allow list),
  and writes the audit record.
- **`packages/loop/src/runtime/capabilities/tools.ts` — the wiring.** The engine names a
  `GuardResolver` port, calls it once per run, and threads the resulting guard
  and a wait-bounded elicit into every agent's toolset. It owns the `guard` settings
  block and the `guard_mode`/`guard_judge` run params
  (`packages/loop/src/runtime/capabilities/tools-settings.ts`) in pure zod, with no
  import of `@clarvis/tools`, as that file's own header states
  (`packages/loop/src/runtime/capabilities/tools-settings.ts`).

The analyzer's stated posture is that it is *not* a shell parser: "This is a best-effort heuristic
for approval decisions, not a shell parser" (`packages/tools/src/guard/analyze-shell.ts`). Its
one hard contract is that anything it cannot bound is reported `undecidable`, and callers "must
treat an undecidable result as 'unknown', never as workspace-confined"
(`packages/tools/src/guard/analyze-shell.ts`).

Delegated elsewhere and **not** described here: the elicitation transport that actually reaches a
human ([elicitation-and-user-interaction](../cross-cutting/elicitation.md)); sandbox confinement ([sandbox-and-toolchains](sandbox.md)); why
`@clarvis/server` refuses `guard_mode` ([server-mcp-facade](../hosts/server-mcp.md) — the refusal itself is at
`packages/server/src/mcp/tools.ts`). Note also a **name collision**: the
`guard_escalation` trace kind (`packages/capability/src/trace-kinds.ts`) belongs to the
*convergence* guards (`packages/loop/src/runtime/guards/guard-escalation.ts`), not to this
subsystem.

---

## 2. Surface

### 2.1 `@clarvis/tools` → `./guard` (`packages/tools/src/guard/index.ts`)

| Symbol | Kind | File | Signature / shape |
| --- | --- | --- | --- |
| `Verdict` | type | `packages/tools/src/guard/types.ts` | `"allow" \| "deny" \| "ask"` |
| `GuardDecision` | iface | `packages/tools/src/guard/types.ts` | `{ verdict; reason?: string; escalate?: "human" }` |
| `Segment` | iface | `packages/tools/src/guard/types.ts` | `{ command; argv; normalized; envAssignments; decidable }` |
| `ShellFacts` | iface | `packages/tools/src/guard/types.ts` | `{ paths: string[]; segments: Segment[]; undecidable: boolean }` |
| `PathFact` | iface | `packages/tools/src/guard/types.ts` | `{ raw; resolved; withinWorkspace }` |
| `GuardContext` | iface | `packages/tools/src/guard/types.ts` | `{ tool; args; config; paths: PathFact[]; shell?: ShellFacts }` |
| `Guard` | type | `packages/tools/src/guard/types.ts` | `(ctx: GuardContext) => GuardDecision \| Promise<GuardDecision>` |
| `ElicitRequest` | iface | `packages/tools/src/guard/types.ts` | `{ tool; args; reason?; shell?; escalate? }` |
| `Elicit` | type | `packages/tools/src/guard/types.ts` | `(req: ElicitRequest) => boolean \| Promise<boolean>` |
| `Token` | iface | `packages/tools/src/guard/dialect.ts` | `{ text: string; glob: boolean }` |
| `PathCandidate` | type | `packages/tools/src/guard/dialect.ts` | `{kind:"none"} \| {kind:"path";value} \| {kind:"prefix";value} \| {kind:"opaque"}` |
| `ShellDialect` | iface | `packages/tools/src/guard/dialect.ts` | `{ flavor; split; tokenize; decidable; normalize; pathCandidate }` |
| `analyzeShell` | fn | `packages/tools/src/guard/analyze-shell.ts` | `(command: string, dialect = currentDialect()) => ShellFacts` |
| `buildGuardContext` | fn | `packages/tools/src/guard/context.ts` | `(tool, args, config, dialect = currentDialect()) => GuardContext` |
| `posixDialect` | const | `packages/tools/src/guard/dialects/posix.ts` (`posixDialect`) | the POSIX front end |
| `powershellDialect` | const | `packages/tools/src/guard/dialects/powershell.ts` (`powershellDialect`) | the PowerShell front end |
| `dialectFor` | fn | `packages/tools/src/guard/dialects/index.ts` | `(flavor: ShellFlavor) => ShellDialect` |
| `currentDialect` | fn | `packages/tools/src/guard/dialects/index.ts` | `(platform?) => ShellDialect` |
| `POSIX_DEFAULT_ALLOWED_COMMANDS` | const | `packages/tools/src/guard/dialects/posix.ts` | 154 entries |
| `WINDOWS_DEFAULT_ALLOWED_COMMANDS` | const | `packages/tools/src/guard/dialects/powershell.ts` | 137 entries |
| `withinWorkspace` | fn | `packages/tools/src/guard/helpers.ts` | `(ctx) => boolean` |
| `touchesOutside` | fn | `packages/tools/src/guard/helpers.ts` | `(ctx) => boolean` |

`resolveCandidate` (`packages/tools/src/guard/paths.ts`) is exported through `./guard` so the kernel
can resolve bare directory operands with the analyzer's existing symlink-aware boundary. `patchPaths`
remains internal. `GuardPlacement` is `"host" | "contained"`; `GuardCallFacts` carries optional
`placement`, `network: "none" | "host"`, `matched`, `dangerous`, `within_workspace` and
`touches_outside` on both `GuardDecision` and `ElicitRequest`. `isDangerousCommand(ShellFacts)`
reports forced `rm` and `sudo` from normalized argv (`packages/tools/src/guard/helpers.ts`).

### 2.2 `@clarvis/kernel` → `./policy` and internals

| Symbol | Kind | File | Signature |
| --- | --- | --- | --- |
| `createGuardResolver` | fn | `packages/kernel/src/guard/resolver.ts` | `(deps: GuardResolverDeps) => GuardResolver` |
| `resolveGuardMode` | fn | `packages/kernel/src/guard/resolver.ts` | `(param: GuardMode\|undefined, guard: GuardConfig\|undefined) => GuardMode` |
| `guardParksOnHuman` | fn | `packages/kernel/src/guard/resolver.ts` | `(param, guard, judgeConfigured) => boolean` |
| `GuardSettings` | iface | `packages/kernel/src/guard/resolver.ts` | `{ guard?; providers?; defaultModel?; sandbox?; runtime? }` |
| `GuardSettingsLoader` | type | `packages/kernel/src/guard/resolver.ts` | `() => GuardSettings` |
| `GuardResolverDeps` | iface | `packages/kernel/src/guard/resolver.ts` | `{ loadSettings; logger?; audit?; sessionAllowlistFor?; humanApprovalFor? }` |
| `createShellGuard` | fn | `packages/kernel/src/guard/shell-guard.ts` | `(opts?: ShellGuardOptions) => Guard` |
| `ShellGuardOptions` | iface | `packages/kernel/src/guard/shell-guard.ts` | `{ allowedCommands?; deniedCommands?; placement?; network?; allowHostJudge?; onDecision? }` |
| `ShellGuardDecision` | iface | `packages/kernel/src/guard/shell-guard.ts` | `{ tool; verdict; matched; reason?; escalate?; commandDigest? }` |
| `ShellGuardMatch` | type | `packages/kernel/src/guard/shell-guard.ts` | rule names in table §4.5 |
| `createGuardElicit` | fn | `packages/kernel/src/guard/guard-elicit.ts` | `(elicit: Elicit, opts?) => GuardElicit` |
| `createGuardSessionAllowlist` | fn | `packages/kernel/src/guard/guard-elicit.ts` | `() => GuardSessionAllowlist` |
| `GuardElicitParams` | type | `packages/kernel/src/guard/guard-elicit.ts` | `ElicitParams & { detail?: ElicitationCommandDetail }` |
| `createJudgeElicit` | fn | `packages/kernel/src/guard/judge.ts` | `(deps, cfg, humanElicit) => JudgeElicit \| undefined` (`JudgeElicitAnswer` carries `allowed` + final `answerer`) |
| `JudgeDeps` | iface | `packages/kernel/src/guard/judge.ts` | `{ llm; providers; defaultModel; logger?; signal?; operatorMessage? }` |
| `globToRegExp` | fn (re-export) | `packages/kernel/src/guard/glob.ts` | from `@clarvis/capability` (`packages/capability/src/glob.ts`) |

`./policy` exports only `createGuardResolver`, `resolveGuardMode`, `createShellGuard` and the three
shell-guard types (`packages/kernel/src/policy.ts`); `guardParksOnHuman` is internal and reached
only by `packages/kernel/src/runs/settings-assembler.ts`.

### 2.3 Loop capability ports (`packages/loop/src/runtime/capabilities/tools.ts`)

| Symbol | Shape |
| --- | --- |
| `GuardResolution` | `{ guard?: Guard; elicit?: GuardElicit }` |
| `GuardResolver` | `(ctx: RunCapabilityContext) => Promise<GuardResolution\|undefined> \| GuardResolution \| undefined` |
| `AgentToolsCapabilityOptions.resolveGuard` | optional; omitting it passes no policy guard, so dispatch proceeds without command review, including for `require_escalated` shell (`packages/tools/src/core.ts`) |
| `withGuardElicitWaitBound` | `(elicit, waitMs, signal) => GuardElicit` |
| `AGENT_TOOLS_CAPABILITY_NAME` | `"tools"` |

### 2.4 Settings key `guard` (`packages/loop/src/runtime/capabilities/tools-settings.ts`)

| Field | Type / default | Notes |
| --- | --- | --- |
| `type` | `"shell"`, **required** | error text `guard.type must be 'shell'`; "Names the policy, not a shell syntax: the dialect is derived from the host platform" |
| `mode` | `"off"\|"on"\|"auto"`, optional | absent ⇒ `"on"` via `defaultGuardMode` |
| `allowed_commands` | `string[]`, optional | each entry 1..2048 chars, ≤256 entries (`packages/loop/src/validation/input-limits.ts`) |
| `denied_commands` | `string[]`, optional | same bounds |

The object is `.strict()` — an unknown key is `unrecognized_keys`
(`packages/loop/tests/unit/settings-schema.test.ts`). Merge strategy is `"lastWins"`; `pluginContributable: false` with `pluginForbiddenReason` sourced from
`GUARD_PLUGIN_FORBIDDEN_REASON`, surfaced through `GUARD_PLUGIN_FIELDS` as
a `z.undefined()` field that exists solely "so that trying it explains why".

### 2.5 Run-request params (`packages/loop/src/runtime/capabilities/tools-settings.ts`)

| Param | Schema |
| --- | --- |
| `guard_mode` | `z.enum(["off","on","auto"])` |
| `guard_judge` | `.strict()` object : `prompt` (1..32768 chars, required), `model?` (min 1), `on_unsure?: "ask"\|"deny"`, default `"ask"` per its own `.describe()`, `timeout_ms?` (positive int ≤ 120000) |

Both reach the request schema through `capabilityRequestParamFields`
(`packages/loop/src/runtime/capabilities/settings-specs.ts`) and the spec's
`requestParams` (`packages/loop/src/runtime/capabilities/tools-settings.ts`). The protocol mirrors them as `StartRunParams.guard_mode`
/ `guard_judge` (`packages/protocol/src/runs.ts`, types); the
capability vocabulary declares `GuardMode` at `packages/capability/src/api.ts` and
`GuardJudgeConfig`.

### 2.6 `@clarvis/code` surface

| Symbol | File | Purpose |
| --- | --- | --- |
| `GuardMode` | `packages/code/src/adapters/guard-mode.ts` | local restatement of the three modes |
| `guardAutoResolves` | `packages/code/src/adapters/guard-mode.ts` | `auto` is usable only with a `default_model` that `validateProviders` accepts |
| `GuardModeStore` | `packages/code/src/adapters/guard-mode.ts` | `{ mode; setMode; cycle }` |
| `createGuardModeStore` | `packages/code/src/adapters/guard-mode.ts` | seeds from `code.json` default, else `defaultGuardMode(settings.guard)` |
| `DEFAULT_GUARD_JUDGE_PROMPT` | `packages/code/src/adapters/guard-judge-prompt.ts` | the built-in judge system prompt |
| `GuardJudgePrompt` | `packages/code/src/adapters/guard-judge-prompt.ts` | `{ prompt; source: "workspace"\|"global"\|"builtin" }` |
| `loadGuardJudgePrompt` | `packages/code/src/adapters/guard-judge-prompt.ts` | workspace → global → builtin |

The mode reaches a run through `judgePayloadFor` (`packages/code/src/runtime.tsx`) and
`toStartParams` (`packages/code/src/adapters/kernel-run-client.ts`). The `review.picker` command
opens the independent Off/Approval/Auto selector; its portable route is `Ctrl+G` and its enhanced
route is `Alt+G` (`packages/code/src/app/commands.tsx`, `packages/code/src/keys/interaction.ts`).

---

## 3. Data and formats

### 3.1 `ShellFacts` — what one analysis looks like

Nothing persists `ShellFacts`; it lives for one dispatch. Its shape, from the driver
(`packages/tools/src/guard/analyze-shell.ts`), for the POSIX input
`LD_PRELOAD=./evil.so bun test`:

```json
{
  "paths": ["./evil.so"],
  "segments": [
    { "command": "LD_PRELOAD=./evil.so bun test",
      "argv": ["bun", "test"],
      "normalized": "bun test",
      "envAssignments": ["LD_PRELOAD=./evil.so"],
      "decidable": true }
  ],
  "undecidable": false
}
```

`normalized` is `argv.join(" ")` (`packages/tools/src/guard/analyze-shell.ts`) — the env-stripped, wrapper-stripped
command. The `normalized`/`envAssignments` split is pinned by
`packages/tools/tests/unit/posix-dialect.test.ts` ("records the stripped env assignments so
approvals can key on them").

### 3.2 `guard` settings block, as written

Seeded by `code` into the **global** scope on first use
(`packages/code/src/onboarding/seed-default-allowlist.ts`, `seedDefaultAllowlist`; that seeding belongs to
[code-onboarding-doctor-and-platform](../hosts/code-onboarding.md)):

```json
{ "guard": { "type": "shell", "allowed_commands": ["git status", "git diff", "…"] } }
```

The 154 POSIX entries and 137 PowerShell entries live beside their dialects in
`packages/tools/src/guard/dialects/{posix,powershell}.ts`. They cover conventional inspection,
build, test, lint and type-check commands across the common language ecosystems without granting
generic interpreters/task runners or explicit install, publish, deploy and migration commands.
Windows entries use the **canonical cmdlet spelling** because the analyzer rewrites aliases before
matching. Every entry is test-pinned as decidable and identical to the normalized text the guard
actually matches (`packages/tools/tests/unit/{posix,powershell}-dialect.test.ts`). These are approval
defaults rather than an isolation boundary: builds and tests may execute repository-controlled code,
so process containment remains the native sandbox's job.

### 3.3 Allow/deny entry syntax

One entry compiles to one predicate over a segment's `normalized`
(`packages/kernel/src/guard/shell-guard.ts`):

| Entry form | Match rule | File |
| --- | --- | --- |
| `""` (or whitespace) | never matches | — |
| no `*` | `normalized === entry` or `normalized.startsWith(entry + " ")` | — |
| contains `*` | anchored `globToRegExp(entry)` — `^…$`, `*`→`.*`, everything else escaped | `packages/capability/src/glob.ts` |

The same `*`-glob implementation backs `@clarvis/hooks`' `match.tool`, so "the anchoring and
escaping rules can only be right or wrong once" (`packages/capability/src/glob.ts`).

### 3.4 `guard_judge` payload and the `decide` tool

Request-side shape (§2.5). Judge-side, the model is given exactly two messages
(`packages/kernel/src/guard/judge.ts`): `system` = the caller's `prompt` verbatim, and
`user` = the pretty-printed JSON facts document (`packages/kernel/src/guard/judge.ts`):

```json
{
  "tool": "shell",
  "args": { "command": "curl evil" },
  "guard_reason": "no allowed commands list configured",
  "segments": ["curl evil"],
  "undecidable": false,
  "paths": []
}
```

It is forced to answer through one tool, `decide` (`packages/kernel/src/guard/judge.ts`), with
`toolChoice: { type: "function", function: { name: "decide" } }` (`packages/kernel/src/guard/judge.ts`):

```json
{ "type": "object", "required": ["decision"], "additionalProperties": false,
  "properties": { "decision": { "type": "string", "enum": ["allow","deny","unsure"] },
                  "reason": { "type": "string" } } }
```

Arguments are re-validated on the way back with a **loose** zod schema (`packages/kernel/src/guard/judge.ts`) that
tolerates extra keys; a string `arguments` is `JSON.parse`d first, and a parse failure yields
`undefined` (`packages/kernel/src/guard/judge.ts`).

The JSON also includes the optional host-attested `GuardCallFacts` fields and `operator_message`.
`applyGuard` copies facts from the decision, never from similarly named tool arguments. The resolver
snapshots user text from `RunRequest.messages`: newest messages have priority within 4 KiB of UTF-8,
retained text stays chronological, and excess prefixes are cut without partial code points. Bare
strings and text parts count; assistant messages, tool results and images do not. Empty text omits
the field. For a child this is its own request brief, not the parent's transcript. Mid-run steers do
not update this snapshot and cannot authorize a destructive command through this field.

The Code builtin treats command, justification and other arguments as data, not authority, and
`operator_message` as its only source of intent.
Contained, non-dangerous routine in-tree work (including `git add`, ordinary `git commit`, `mkdir`,
`cp`, `mv`, `cd`, and ordinary expansions) prefers `allow` rather than `unsure`. Destructive effects
such as restore, hard reset, forced clean/removal, and published-history rewrites require explicit
intent for that effect; missing intent returns `unsure`. Credential access and exfiltration return
`deny`. Host or missing placement never implies a sandbox and does not gain the contained routine
rule. A host command explicitly requested by `operator_message` may be allowed without containment,
including native unsandbox in Auto; destructive or external effects still require explicit intent
for that effect. A prompt overlay still replaces the builtin
whole. This is prompt policy, not a deterministic guarantee of a real model's ruling.

Production: `factsMessage` and `createJudgeElicit` in `packages/kernel/src/guard/judge.ts`,
`operatorMessage` in `packages/kernel/src/guard/operator-message.ts`, `createGuardResolver` in
`packages/kernel/src/guard/resolver.ts`, and `DEFAULT_GUARD_JUDGE_PROMPT` in
`packages/code/src/adapters/guard-judge-prompt.ts`. Test:
`packages/kernel/tests/integration/guard-auto-review.test.ts` (Auto facts and operator snapshot),
`packages/tools/tests/integration/guard-dispatch.test.ts` (trusted decision propagation),
`packages/code/tests/integration/guard-judge-prompt.test.ts` (builtin/overlay contract), and
`packages/kernel/tests/unit/guard.test.ts` (unsure-to-human bridge).

### 3.5 Elicitation payload for a `guard_confirm`

`createGuardElicit` builds `GuardElicitParams` (`packages/kernel/src/guard/guard-elicit.ts`):

- `kind: "guard_confirm"`
- `message`: the reason, then `$ <command>` (or `Command segments: a, b` when there is no command
  string), then the literal `"Warning: this command contains undecidable expansions."` when the
  facts are undecidable
- `requestedSchema.properties.decision.enum`: `["deny","allow","allow_session"]` when a session
  allow list is available, the ask is not `host_command`, and the command is decidable and non-empty,
  else `["deny","allow"]`

- `detail?: ElicitationCommandDetail` — `{ command, cwd, reason, warning? }`, whose protocol type is `packages/protocol/src/runs.ts`. `cwd` is
  `resolve(workspaceRoot, args.cwd)` or the workspace root itself. It is attached only
  when both a `command` arg and a `workspaceRoot` option are present.

The kernel's elicit bridge lifts `detail` onto the wire `ElicitationRequest`
(`packages/kernel/src/runs/elicit-bridge.ts`) — the engine itself never knows the shape
(`packages/kernel/src/guard/guard-elicit.ts`).

### 3.6 Session allow-list key

In-memory only, `Set<string>`, never persisted (`packages/kernel/src/guard/guard-elicit.ts`).
One key per segment: `[...envAssignments, normalized].join(" ")`
(`packages/kernel/src/guard/guard-elicit.ts`). So `FOO=1 bun test` keys as `"FOO=1 bun test"` and does not cover
`bun test` (pinned at `packages/kernel/tests/unit/guard.test.ts`).

Both `covers()` and `record()` are a no-op — `false` / nothing recorded — for an undecidable or
empty-segment `ShellFacts` (`packages/kernel/src/guard/guard-elicit.ts`). Combined with invariant 24 (`escalate:
"human"` always carries an undecidable command and bypasses the allowlist check anyway), this means
the session allowlist can never be satisfied by, and never grows from, an undecidable command.

### 3.7 Audit records

Three events, all `info` except the last, all written to a **separate** audit logger rather than
the diagnostic one (`packages/kernel/src/guard/resolver.ts`):

| Event | Emitted at | Fields |
| --- | --- | --- |
| `guard.resolved` | `packages/kernel/src/guard/resolver.ts` | `mode`, `source: "request"\|"settings"`, `judge_configured`, `human_channel` (+ `run_id`, `owner` from the child binding) |
| `guard.decision` | `packages/kernel/src/guard/resolver.ts` | `verdict`, `matched`, `mode`, `tool`, `reason?`, `escalate?`, `command_digest?` |
| `guard.elicit.answered` | `packages/kernel/src/guard/resolver.ts` | `answer: "allow"\|"allow_session"\|"deny"`, `answerer: "human"\|"judge"\|"session_allowlist"` |
| `guard.escalation.no_channel` (**warn**) | `packages/kernel/src/guard/resolver.ts` | `run_id` |

`command_digest` is the first 16 hex characters of the command's SHA-256
(`packages/kernel/src/guard/shell-guard.ts`); it is absent when the call carries no
non-empty `command` string, "because … an empty digest field would read as 'the empty command'"
(`packages/kernel/src/guard/shell-guard.ts`).

The whole channel is gated by the environment default `CLARVIS_LOG_AUDIT` (`packages/capability/src/env.ts`,
`boolFromEnv(true)`). `createAuditLogger(root, enabled)`
(`packages/kernel/src/component-loggers.ts`) returns `NOOP_LOGGER` whenever `enabled` is
`false` or `root` is `undefined`/`silent`, and otherwise binds `{ component: "audit", audit: true }`
pinned at `info` (`packages/kernel/src/component-loggers.ts`); `packages/kernel/src/file-kernel.ts` is the
production call site. So a host operator flipping `CLARVIS_LOG_AUDIT` off silently loses every event
in the table above, with no trace of the omission. Pinned:
`packages/kernel/tests/unit/guard-audit.test.ts` ("is silent when CLARVIS_LOG_AUDIT is off") ("stamps audit: true on every record").

### 3.8 The default guard-judge policy

`DEFAULT_GUARD_JUDGE_PROMPT` (`packages/code/src/adapters/guard-judge-prompt.ts`) is the
operative policy any workspace gets under `guard_mode: "auto"` with no custom `guard-judge.md`; when
`code` resolves it as the fallback (§4.11), it reaches the judge model verbatim as the `system`
message (§3.4; `packages/kernel/src/guard/judge.ts`). Its three decision categories:

- **`allow`** — routine inspection/build/test; contained non-dangerous in-tree development, including
  ordinary Git commits and expansions, follows the low-interruption rule in §3.4.
- **`deny`** — credential access and exfiltration, regardless of placement.
- **`unsure`** — unassessable effects, missing intent for destructive or external effects, and Host
  operations beyond routine inspection/build/test without explicit authorization in
  `operator_message`, the only intent source. Explicitly requested host commands may be allowed
  without containment, subject to the destructive/external-effect and credential rules.

The prompt asserts a sandbox/container boundary only for explicit `placement: "contained"` and
never equates it with denied networking or complete path analysis. Explicit unsandbox under
Isolation Sandbox reaches the judge in Auto as a host effect; `on` remains human-only. Production: `packages/code/src/adapters/guard-judge-prompt.ts`
(`DEFAULT_GUARD_JUDGE_PROMPT`). Test:
`packages/code/tests/integration/guard-judge-prompt.test.ts`.

---

## 4. Behavior

### 4.1 Where the guard is consulted

`dispatch` (`packages/tools/src/core.ts`) runs, in order:

1. tool lookup → `not_found` (`packages/tools/src/core.ts`);
2. `structuredClone` + AJV validation of the arguments → `invalid_input`
   (`packages/tools/src/core.ts`);
3. the skill-package mutation boundary (`packages/tools/src/core.ts`);
4. **`applyGuard(name, filled, config)`** (`packages/tools/src/core.ts`);
5. the handler (`packages/tools/src/core.ts`).

So the guard sees **defaulted, schema-valid arguments**, never the raw ones, and the handler is
never entered when the gate returns a result.

`applyGuard` itself (`packages/tools/src/core.ts`):

| Condition | Result |
| --- | --- |
| `config.guard` absent | proceed with `{}` for every tool, including `require_escalated` shell |
| `verdict === "allow"` | proceed, carrying review metadata when the policy named a mode |
| `verdict === "deny"` | `ToolError("denied", reason)` plus review metadata |
| `verdict === "ask"`, no `config.elicit` | `ToolError("denied", reason)` with answerer `unavailable` |
| `verdict === "ask"`, elicit approves | proceed, carrying the answerer in review metadata |
| `verdict === "ask"`, elicit declines | `ToolError("denied", "command review did not approve: ...")` |
| guard or elicit **throws** | `errorResult(err)` — fail closed |

`reason` defaults to the literal `"blocked by guard"` (`packages/tools/src/core.ts`). The `ElicitRequest` handed
on carries `tool`, `args`, `reason`, `ctx.shell` and `escalate` when the decision set it
(`packages/tools/src/core.ts`). All of these are pinned in
`packages/tools/tests/integration/guard-dispatch.test.ts` by the allow, deny, no-elicit, and
"resolves an ask through the elicit handler" cases.

### 4.2 Building the context

`buildGuardContext` (`packages/tools/src/guard/context.ts`) reads a different arg shape per
tool family, and an unrecognized tool yields no paths and no shell facts :

| Family | Members | Extraction | File |
| --- | --- | --- | --- |
| command tools | `shell`, `monitor_start` | `analyzeShell(args.command)`, each path occurrence resolved with **shell semantics** (tilde expansion) against workspace, every configured temporary root (product run scratch plus system compatibility roots), and exact host-selected skill roots; an absolute command head beneath a platform system executable root or configured runtime root is admitted only for that segment occurrence and normalized to its basename for allow/deny matching, with Windows `PATHEXT` suffixes removed; duplicate absolute operands remain outside even when their string equals an admitted head; when a sandbox is configured, an existing verified spill is admitted as that exact read-only-mounted file; unsandboxed commands do not receive the spill exception; `args.cwd` is added with plain fs semantics against the same roots; `sandbox_permissions` and `justification` are copied onto the context | `packages/tools/src/guard/context.ts` (`commandPathOccurrences`, `externalExecutableHeads`, `normalizeExternalExecutables`), `packages/tools/src/lib/state-artifacts.ts`, `packages/tools/src/lib/system-executables.ts`, `packages/loop/src/runtime/capabilities/tools.ts` |
| patch | `apply_patch` | `patchPaths(args.patch)` — raw unified `---`/`+++` plus model-envelope Update/Add/Delete/Move headers, `/dev/null` dropped, `a/`/`b/` prefixes stripped, deduped first-seen | `packages/tools/src/guard/context.ts`, `packages/tools/src/guard/paths.ts` |
| src/dest | `move`, `copy` | `args.source`, `args.destination` | `packages/tools/src/guard/paths.ts` |
| list | `read_files` | every string in `args.paths` | `packages/tools/src/guard/paths.ts` |
| pair | `diff` | `args.from`, `args.to` | `packages/tools/src/guard/paths.ts` |
| scoped | `replace` | `args.path` if a non-empty string, else `"."` | `packages/tools/src/guard/paths.ts` |
| single path | `read_file`, `write_file`, `edit_file`, `multi_edit`, `read_image`, `list_dir`, `glob`, `grep`, `file_stat`, `tree`, `mkdir`, `remove` | `args.path` | `packages/tools/src/guard/paths.ts` |

`resolveCandidate` (`packages/tools/src/guard/paths.ts`) resolves the token twice: once normally for
`resolved`, once in confining mode inside a `try`, and a throw becomes `withinWorkspace: false`. Shell-semantics resolution first expands a leading `~`/`~/` (and `~\` on Windows) to
the real home directory (`packages/tools/src/guard/paths.ts`) — which is why `cat ~/.ssh/id_rsa` reports as
escaping (`packages/tools/tests/unit/guard-context.test.ts`) while a literal `path: "~"`
arg on `read_file` stays inside.

### 4.3 The analyzer driver

`analyzeShell` (`packages/tools/src/guard/analyze-shell.ts`) owns everything invariant and
delegates everything syntactic:

1. `dialect.split(command)` → `{ segments, balanced }`.
2. For each source segment: `dialect.tokenize` → `dialect.normalize(tokens.map(t => t.text))` →
   push a `Segment` with `decidable: dialect.decidable(source)`.
3. For each token: `dialect.pathCandidate(token)`. `opaque` sets `tokenUndecidable` and
   contributes **no** path; `none` contributes nothing; otherwise the value is pushed once,
   deduplicated by a `Set`, first-seen order.
4. `undecidable = !balanced || tokenUndecidable || emptySegment || some(!decidable)`, where `emptySegment` means some segment reduced to `argv.length === 0` **and** recorded no `envAssignments`. A `NAME=value` assignment-only segment is not a tokenizer failure.

The `emptySegment` term is the one with a stated reason: the guard matches its deny list against
`normalized` **before** consulting `undecidable`, so a tokenizer that came up empty would produce a
`normalized` no deny entry can match — "Degrading `allow` to `ask` is acceptable; degrading `deny`
to `ask` is not" (`packages/tools/src/guard/analyze-shell.ts`). Pinned generically over a stub dialect and
specifically over POSIX at `packages/tools/tests/unit/shell-dialect.test.ts`, and against
a `["*"]` allow list at `packages/kernel/tests/unit/guard.test.ts`. Optional
`ShellDialect.analyzeSources` may rewrite split sources for tokenization, decidability and path
extraction; `Segment.command` stays the original source. POSIX uses that hook to inline sequential
literal `$NAME` / `${NAME}` bindings.

The driver carrying no dialect syntax is itself pinned with a deliberately ignorant stub dialect
(`packages/tools/tests/unit/shell-dialect.test.ts`).

### 4.4 Dialect selection

`currentDialect(platform?)` = `dialectFor(currentShellFlavor(platform))`
(`packages/tools/src/guard/dialects/index.ts`); `currentShellFlavor` returns
`"powershell"` on `win32` and `"posix"` elsewhere (`packages/tools/src/lib/platform.ts`).
The same function selects the executor's shell (`packages/tools/src/tools/shell.ts`,
`packages/tools/src/shell.ts`), which is what makes "analyze one dialect, run another"
unrepresentable rather than merely discouraged (`packages/tools/src/guard/dialects/index.ts`,
`packages/tools/src/lib/platform.ts`). Pinned by the "dialect selection" suite in
`packages/tools/tests/unit/powershell-dialect.test.ts`.

#### POSIX (`packages/tools/src/guard/dialects/posix.ts`)

| Concern | Rule | Owner |
| --- | --- | --- |
| split | `&&`, `\|\|`, `;`, `\|`, `&`, newline at depth 0; never inside quotes/backticks/parens; a redirect `&` (`&>` or after `>`) does not split | `splitByOperators` |
| balanced | no open single/double quote, backtick, or paren | `splitByOperators` |
| tokenize | quote-aware; backtick spans and `$()`/`<()`/`>()` consumed and dropped; `glob` set only for unquoted `*?[]{}` | `tokenize` |
| decidable | after `scrubExpansions` (single-quoted spans removed, double-quoted kept) no expansion pattern matches, quotes are balanced, and the effective argv head is not an opaque command | `posixDialect.decidable`, `scrubExpansions`, `opaqueCommand` |
| expansion patterns | `$(`, `` ` ``, `${`/`$NAME`, `<(`, `>(` | `EXPANSION_PATTERNS` |
| opaque commands | effective argv head `eval`, `exec`, `source`, `env`, `xargs`, `base64`, or `sh`/`bash` with `-c`, after skipping grouping, negation, `command`/`builtin` and compound-list keywords | `UNDECIDABLE_COMMANDS`, `effectiveArgv` |
| sequential bindings | on a `;` / `&&` / newline chain, literal `NAME=value` assignment-only segments inline later `$NAME` / `${NAME}` for analysis only | `analyzeSources` |
| normalize | strip leading `NAME=value` assignments (recorded), then `timeout\|time\|nice\|nohup\|stdbuf` with their options and `timeout`'s duration, repeatedly | `stripEnvAndWrappers`, `SAFE_WRAPPERS` |
| pathCandidate | strip `[0-9&]*(>>?\|<)` redirect prefix; `/dev/null` and test-builtin `[` / `]` / `[[` / `]]` → none; `~user` → opaque; glob with `..` → opaque; glob → literal directory prefix; else the `looksLikePath` heuristic | `pathCandidate`, `looksLikePath` |

The POSIX null device is the one special path-shaped token discarded by `pathCandidate`: after a
redirection prefix is stripped (or when it is a spaced redirect target), `/dev/null` contributes no
outside-workspace fact. Native sandbox policy explicitly admits the null device; an unsandboxed
process reaches the host's null device. Other absolute device paths remain ordinary path facts. Production:
`packages/tools/src/guard/dialects/posix.ts`. Test:
`packages/tools/tests/unit/posix-dialect.test.ts` and
`packages/tools/tests/integration/guard-dispatch.test.ts`.

The state-spill exception is narrower than `config.stateRoot`. `readableStateArtifactPath` requires
the candidate to be a direct child of `<stateRoot>/local`, match the `@clarvis/paths` spill naming
family, exist as a regular file, reject a final symlink, and resolve back to that same local
directory. The guard adds only that exact file to read-only `read_file`/`read_files`, and to
`shell`/`monitor_start` only when a sandbox can mount it read-only. Unsandboxed command tools retain
`outside_workspace`, preventing overwrite or deletion; prompt history and all other state paths do
too. Production:
`packages/tools/src/lib/state-artifacts.ts`, `packages/tools/src/guard/context.ts`. Test:
`packages/tools/tests/integration/guard-dispatch.test.ts`.

Skill execution roots are a separate host-approved class. Command analysis admits only the exact
canonical directories reported by selected skills; they are not added to native file-tool roots and
selection never launches a process. Guard approval also does not make an unsandboxed host process
read-only. Production: `buildGuardContext` in `packages/tools/src/guard/context.ts` and
`buildExecuteRunDeps` in `packages/loop/src/runtime/build-run-deps.ts`. Test:
`packages/tools/tests/integration/api.test.ts`.

Opaque command names are matched against the effective argv head, not scanned through arguments.
A whole-segment regex treated `cat source`, `git add source` and `npm run env` as `source`/`env` in
command position, which made ordinary parameterized commands undecidable (and, with a deny list,
wrong refusals). Filenames that merely contain a command name, and arguments that *are* that name,
stay decidable; the command itself — including `(eval rm)`, `{ eval foo; }` and `command env` —
stays undecidable (`opaqueCommand` in `packages/tools/src/guard/dialects/posix.ts`). Pinned by the
`analyzeBash — command names are matched in command position only` suite
(`packages/tools/tests/unit/posix-dialect.test.ts`). Sequential literal assignments are pinned by
`analyzeBash — sequential literal assignments` in the same file and by
`packages/kernel/tests/unit/guard.test.ts`.

`looksLikePath` (`packages/tools/src/guard/dialects/posix.ts`) is the fallback rule that decides whether a bare token
becomes a `PathFact` at all, gating every downstream path check (outside-workspace,
credential-file): `false` for an empty token, one starting with `-`, or one containing
`PATH_METACHARS` (same file); otherwise `true` for a token containing `/`, one starting with
`~` or `.`, or one shaped like a bare `name.ext`; `false` for everything else.

The default-list exclusions are stated in the constant's own docs: `make` runs an unconstrained
project recipe; `find` and `awk` can execute code the analyzer cannot see; `sed -n` only appears
read-only because scripts may still write; and generic interpreters/runners plus install, publish
and deploy commands intentionally retain review. Re-added regressions fail in
`packages/tools/tests/unit/posix-dialect.test.ts` ("omits the commands that execute arbitrary code
behind a safe-looking name").

#### PowerShell (`packages/tools/src/guard/dialects/powershell.ts`)

| Concern | Rule | Owner |
| --- | --- | --- |
| split | `;`, newline, `\|`, `\|\|`, `&&` at paren/brace depth 0; never inside quotes, here-strings, `()` or `{ }`; `&` is **never** a separator; a trailing backtick continues the line; `#` line comments and `<# #>` blocks are dropped | `split` |
| `#` comment start | only when preceded by start-of-input or whitespace — otherwise `file#1.txt` would yield a phantom segment (`git status # note; rm -rf x`) | `startsComment` |
| tokenize | backtick = **escape**, not substitution; `''` and `""` escape a quote inside their span; `$()`, `@()`, `${ }` and here-strings consumed | `tokenize` |
| decidable | balanced, no call/dot-source operator in command position, no `UNDECIDABLE_PATTERNS` match, and no `$var` outside the inert set | `decidable`, `scrubExpansions` |
| inert variables | `$_`, `$null`, `$true`, `$false`, `$args`, `$psitem` — every other `$name` makes the segment undecidable | `INERT_VARIABLES`, `decidable` |
| undecidable patterns | 30 case-insensitive entries incl. `Invoke-Expression`/`iex`, `New-Object`, `[scriptblock]`, `powershell`/`pwsh`, `cmd`/`wsl`/`bash`/`sh`/`zsh`, `.ps1`, `Start-Process`, `Invoke-WebRequest`, `DownloadString`, `FromBase64String`, `Set/New-Alias`, `function `, `--%`, `<#` | `UNDECIDABLE_PATTERNS` |
| normalize | canonicalize **`argv[0]` only** through the alias table, case-insensitively; no env assignments to strip | `powershellDialect.normalize`, `canonicalCommand`, `ALIASES` |
| pathCandidate | strip `(\d\|\*)?>>?(&\d)?`; `~x` (not `~/`, `~\`) → opaque; provider-qualified (`Env:`, `HKLM:`) and drive-relative (`C:`, `C:foo`) → opaque; glob with `..` → opaque; glob → prefix (stopping at a drive root); else `looksLikePath` incl. `C:\`, `\\server\share` | `pathCandidate`, `looksLikePath` |

The backtick asymmetry is the design's stated load-bearing point — "A single grammar covering both
shells is unsound, because the same characters carry opposite meanings"
(`packages/tools/src/guard/dialect.ts`) — and is pinned side by side against the POSIX
tokenizer by "treats the backtick as an escape, not as substitution" in
`packages/tools/tests/unit/powershell-dialect.test.ts`. Aliases are canonicalized so a deny entry
written either way bites (same file, "gives an alias and its cmdlet the same spelling for the lists
to match"); the deliberately *un*-aliased `curl`/`wget`/`where`/`sort` are pinned by "does not
canonicalize names that are version-dependent aliases", with the stated reason that they are
version-dependent (`ALIASES` in `packages/tools/src/guard/dialects/powershell.ts`).

PowerShell's `looksLikePath` (`packages/tools/src/guard/dialects/powershell.ts`) is the same fallback rule, over the same
`PATH_METACHARS` idea (same file): `false` for an empty token, one starting with `-`, or
one matching the dialect's own metacharacter set; `true` for a drive-absolute (`C:\`) or UNC
(`\\server\share`) token, one containing `\` or `/`, one starting with `~` or `.`, or a bare
`name.ext` shape; `false` otherwise. It is reached only after the provider-qualified/drive-relative
and glob checks above have already classified the token, so it sees only a plain bare word.

### 4.5 The rule cascade (`createShellGuard`)

Evaluated top-down; the first match returns (`packages/kernel/src/guard/shell-guard.ts`):

| # | Condition | `matched` | Verdict |
| --- | --- | --- | --- |
| 1 | `shell` present, deny list configured, **any** segment's `normalized` matches | `deny_list` | `deny` |
| 2a | `shell.undecidable` and deny list **non-empty** | `undecidable` | `deny` |
| 2b | `sandboxPermissions === "require_escalated"` and Isolation is Sandbox (`config.sandbox` present) | `host_command` | `ask`; `escalate: "human"` unless `allowHostJudge` is true (Auto only) |
| 3a | `shell.undecidable`, no/empty deny list, placement Host | `undecidable` | `ask` + `escalate: "human"` |
| 3b | `shell.undecidable`, no/empty deny list, placement contained | `undecidable` | `ask`, no escalation restriction |
| 4 | `touchesOutside(ctx)` — some resolved path escapes | `outside_workspace` | `deny` |
| 5 | some path's `raw` matches a credential pattern and no exception | `credential_file` | `ask` |
| 6 | `ctx.shell === undefined` (a non-command tool) | `non_bash` | `allow` |
| 7 | allow list configured and **every** comparison segment matches, ignoring validated POSIX `cd` | `allow_list` | `allow` |
| 7a | forced `rm` (`-f`, `--force`, short cluster containing `f`) or `sudo` | `dangerous` | `ask`, no escalation restriction |
| 8 | `!withinWorkspace(ctx)` — i.e. no resolved paths at all | `outside_workspace` | `ask` |
| 9 | otherwise | `default` | `ask` |

The original adjacent-pair ordering cases live in `packages/kernel/tests/unit/guard.test.ts`.
Placement, dangerous precedence and comparison-only POSIX directory handling are pinned by
`packages/kernel/tests/integration/guard-auto-review.test.ts`.

There is no contained silent-allow rule: unmatched contained commands still ask, and only Auto
changes who may answer. Placement is resolved once per run from host settings. An enabled native
policy is contained-or-fail-closed (`sandboxWouldApply`); even legacy `availability: "optional"`
never falls back to bare execution. A Docker/Podman guest is also contained, while an absent or
disabled native policy on Host is not. `loadGuardSettings` uses the same effective native policy
resolver as tool execution, including Docker's required-Sandbox fallback. Container launch captures
its actual backend/network for the guest rather than relying on later settings edits. Native network
uses `"host" | "none"`; container `none` maps to `none`, while `internet`/`outbound` are omitted rather
than misrepresented as native host networking. Per-call unsandbox overrides placement to Host and
omits the no-longer-applicable native network restriction. Its `host_command` ask precedes generic
undecidability, but never deny-list enforcement. `createGuardResolver` passes `allowHostJudge: true`
only for Auto: `allow` executes and `deny` refuses; unsure, errors and malformed responses use
normal `on_unsure` fallback (default `ask`, configured `deny` respected). No usable model routes to
a human. Mode `on` retains `escalate: "human"`; `off` is unchanged. Docker/Podman still reject
escalation, and on Host the field is a no-op under normal command policy.

Production: `createGuardResolver`, `createShellGuard`, `loadGuardSettings` in
`packages/kernel/src/file-kernel.ts`, `sandboxWouldApply` in `packages/tools/src/sandbox.ts`, and
`guestGuardSettings` in `packages/kernel/src/runtime/guest-loop-executor.ts`. Test:
`packages/kernel/tests/integration/guard-auto-review.test.ts`,
`packages/tools/tests/unit/sandbox-placement.test.ts`, and
`packages/kernel/tests/integration/runtime-guest-loop.test.ts` (container Auto expansions).

POSIX normalization removes consecutive leading Git `--no-pager`/`--no-color` presentation flags.
`commandComparison` in `packages/kernel/src/guard/command-comparison.ts` additionally validates bare
`cd <path>` and leading `git -C <path>` operands, and skips assignment-only `NAME=value` segments
for allow-list comparison so `QA=/tmp/foo; git status` can match `git status`. In a straight `&&` chain, an in-workspace `cd`
segment needs no allowlist entry; in-workspace Git `-C` is removed only from comparison, leaving
normalized session keys untouched. Directory paths still participate in outside-path denial.
Unsupported control flow, `cd` options and PowerShell retain ordinary matching. Original analyzer
path facts are never weakened: root-relative analysis can conservatively refuse a `..` operand
which would have stayed in-tree after `cd`. This remains a heuristic, not shell execution simulation.
Both original and comparison forms participate in deny matching. Production: `commandComparison`
and `createShellGuard`. Test: `packages/kernel/tests/integration/guard-auto-review.test.ts` (POSIX
comparison cases) and `packages/tools/tests/unit/guard-normalization.test.ts`.

Notes the code states about specific rules:

- **Rule 2a's non-empty test** exists because `denied_commands: []` means "deny nothing", and
  reading it as "a deny list exists" would make `git commit -m "$MSG"` an unappealable refusal
  (`packages/kernel/src/guard/shell-guard.ts`); pinned at `packages/kernel/tests/unit/guard.test.ts`.
- **Rule 5 outranks rule 7** so no allow-list entry can wave `cat.env` through — "`cat` is exactly
  the sort of entry a starter allow list contains" (`packages/kernel/src/guard/shell-guard.ts`); pinned at
  `packages/kernel/tests/unit/guard.test.ts`. Its verdict is `ask`, not `deny`, because
  such files "sit *inside* the workspace as often as not … Reading them is frequently legitimate"
  (`packages/kernel/src/guard/shell-guard.ts`).
- **Rule 8's reason string** is `"the paths this command touches could not be determined"`, chosen
  after the previous wording asserted an escape for `whoami` "and the model read that as fact and
  invented explanations from it" (`packages/kernel/src/guard/shell-guard.ts`).
- **Deny matching checks normalized and comparison forms, not raw command text.** The substitution
  case is handled by rule 2a (`packages/kernel/src/guard/shell-guard.ts`).
- **Rule 9's reason has two variants.** `"no allowed commands list configured"` when `allowed`
  is `undefined` (no `allowed_commands` in settings at all), versus `"command not in the allowed
  commands list"` when an allow list exists but the command's segments did not fully match it
  (`packages/kernel/src/guard/shell-guard.ts`). §3.4's example JSON uses the first string without stating which
  condition produces it.
- **Neither `commandsAllowed` nor `commandDenied` inspects `Segment.envAssignments`** — both match
  only `normalized`, which is already env-assignment-stripped (§3.1, invariant 7). So an allow-list
  entry like `git status` is satisfied by `LD_PRELOAD=/evil.so git status` as readily as by the bare
  command; nothing in `shell-guard.ts` re-checks the stripped prefix against the list
  (`packages/kernel/src/guard/shell-guard.ts`). This is the same normalization that lets the *session*
  allow-list key include `envAssignments` (§3.6) — the settings-configured allow/deny lists do not.

Credential patterns (`packages/kernel/src/guard/shell-guard.ts`): `.env` (with a following `.` or end), `*.pem`,
`*.key`, `id_rsa`, `id_ed25519`, `.npmrc`, `.netrc`, `.git-credentials`, `.aws/credentials`,
`.ssh/`, `keys.json`. The one exception set is `.env.example|sample|template`
(`packages/kernel/src/guard/shell-guard.ts`), because "Prompting for `.env.example` is how a guard teaches the answer
'approve'". Matching is against `PathFact.raw`, not `resolved`
(`packages/kernel/src/guard/shell-guard.ts`).

Whatever it returns, the guard reports the ruling to `onDecision` before returning it, and stays a
pure `GuardDecision` when no observer is supplied (`packages/kernel/src/guard/shell-guard.ts`; pinned at
`packages/kernel/tests/unit/guard-audit.test.ts`). A throw from the observer "propagates
to the caller rather than being swallowed into a silent approval" (`packages/kernel/src/guard/shell-guard.ts`).

### 4.6 Resolving a run's guard

By default, `createGuardResolver` creates one allowlist shared by its runs. A host with independent
interactive lifetimes supplies `sessionAllowlistFor`, resolving the current list on each command by
owner/execution identity. Returning `undefined` disables session approval for that command. Human
questions capture the list present when they open; revocation permanently clears that instance, so
an old pending response cannot authorize a new controller. Judge fallback uses the same lookup.

The list retains at most 1,024 normalized segment keys and 1 MiB of key bytes. An accepted command
that would exceed either budget remains approved once but is not cached; later calls ask again.
There is no partial insertion or silent eviction of a different approved command.

Production: `createGuardResolver` and `GuardResolverDeps.sessionAllowlistFor` in
[resolver.ts](../../packages/kernel/src/guard/resolver.ts), `createGuardSessionAllowlist` in
[guard-elicit.ts](../../packages/kernel/src/guard/guard-elicit.ts). Test: `revalidates the live
controller's allowlist inside an already resolved run`, `cannot seed a new controller's consent
with an older pending answer`, and `bounds retained command approvals and never revives a revoked
list` in [guard.test.ts](../../packages/kernel/tests/unit/guard.test.ts).

Per run:

1. `settings = deps.loadSettings()` — re-read every time.
2. `guardMode = ctx.request.guard_mode ?? defaultGuardMode(settings.guard)`
   (`resolveGuardMode`).
3. `audit = auditRoot.child({ run_id: ctx.executionId, owner: ctx.owner })`.
4. `buildGuard` returns `undefined` for mode `off` → the resolver returns
   `undefined` and the run is unguarded.
5. Human consent uses `humanApprovalFor` when supplied by the guest adapter, otherwise
   `createGuardHumanApproval` over `ctx.elicit` and the current `sessionAllowlistFor` lookup.
   Both paths consult the same host scope and reject stale answers.
6. `judgeElicit` = `createJudgeElicit(…)` only when `guardMode === "auto"` **and**
   `ctx.request.guard_judge !== undefined`. The judge's model falls back to
   `settings.defaultModel`, then `ctx.env.CLARVIS_DEFAULT_MODEL`.
7. `chosenHuman` = `humanElicit` for `on`, and for `auto` only when no judge resolved. A resolved
   judge returns both `allowed` and the final `answerer`, so an internal human fallback is audited
   as human rather than judge.
8. Emit `guard.resolved`.

| (mode, judge param, judge model resolves, human channel) | `guard` | answering channel |
| --- | --- | --- |
| `off`, * | `undefined` | none (unguarded) |
| `on`, *, *, yes | built | human |
| `on`, *, *, no | built | none — every `ask` fails closed |
| `auto`, absent, *, yes | built | human (`packages/kernel/src/guard/resolver.ts`; test `packages/kernel/tests/unit/guard.test.ts`) |
| `auto`, present, no, yes | built | human (`packages/kernel/tests/unit/guard.test.ts`) |
| `auto`, present, yes, yes | built | judge for `allow`/`deny`; `on_unsure` fallback for unsure, judge failure, or malformed response (`ask` by default, configured `deny` respected) |
| `auto`, present, yes, no | built | judge; an `escalate:"human"` ask denies with a warn (`packages/kernel/tests/unit/guard-audit.test.ts`) |

### 4.7 Answering an `ask`

The composed elicit (`packages/kernel/src/guard/resolver.ts`):

| Event | Effect | File |
| --- | --- | --- |
| `req.escalate === "human"`, human channel exists | route to the human, bypassing both automatic answerers | — |
| `req.escalate === "human"`, no human channel | `noHumanChannel` → warn `guard.escalation.no_channel`, return `false` | — |
| `matched !== "host_command"` and session allow list already `covers(req.shell)` | record `answerer: "session_allowlist"`, return `true` **without** consulting the judge or the human | — |
| judge exists | call it and record the returned final `answerer`; a judge fallback is attributed to `human` | `createGuardResolver` |
| no judge, human fallback exists | call the human and record `answerer: "human"` | `createGuardResolver` |

Host-command review is per call, never volatile session consent: `matched: "host_command"` bypasses
session coverage and never offers `allow_session`, even when Auto falls back to a human. Clean judge
`allow`/`deny` answers still use the exact-facts memo; this is separate from session approval and
does not cache human fallback answers. Production: `createGuardResolver` in
`packages/kernel/src/guard/resolver.ts`, `createGuardElicit` in
`packages/kernel/src/guard/guard-elicit.ts`, and `memoKey` in `packages/kernel/src/guard/judge.ts`.
Test: `packages/kernel/tests/integration/guard-auto-review.test.ts` and
`packages/kernel/tests/unit/guard.test.ts`.

`createGuardHumanApproval` reads the current allowlist before and after the question to distinguish
`allow_session` from `allow`. It captures the scope before awaiting the answer, then refuses approval
if the signal aborted or the scope retired, including a late one-time approval. `humanApprovalFor`
lets the guest use that same host decision through `runtime.guard_approval`; the guest has no local
human allowlist or memoized fallback answer. The host reconstructs shell facts from displayed argv
text and never accepts guest-supplied segments or scope identifiers.
Production: [human-approval.ts](../../packages/kernel/src/guard/human-approval.ts),
[resolver.ts](../../packages/kernel/src/guard/resolver.ts) and
[guard-approval-bridge.ts](../../packages/kernel/src/runtime/guard-approval-bridge.ts).
Test: [runtime-guard-approval.test.ts](../../packages/kernel/tests/component/runtime-guard-approval.test.ts)
checks native/guest detach, takeover, disconnect, conversation close and late answers;
[runtime-guard-revocation.test.ts](../../packages/kernel/tests/integration/runtime-guard-revocation.test.ts)
executes the guest loop and refuses a repeated command after detach without fresh approval.

`createGuardElicit`'s own mapping (`packages/kernel/src/guard/guard-elicit.ts`):

| Elicitation result | Returns | Side effect |
| --- | --- | --- |
| `action !== "accept"` (decline / cancel) | `false` | none |
| `accept` + `decision: "allow"` | `true` | none |
| `accept` + `decision: "allow_session"` **and** the option was offered | `true` | `allowlist.record(shell)` |
| `accept` + `decision: "allow_session"` when it was **not** offered | `false` | none (`packages/kernel/tests/unit/guard.test.ts`) |
| anything else | `false` | none |

The prompt waits `ELICIT_NO_TIMEOUT_MS = 2_147_483_647` ms unless the run's signal aborts
(`packages/kernel/src/guard/guard-elicit.ts`) — the wait bound that actually applies is imposed one layer
up, in the loop (§4.8).

### 4.8 The engine's wiring

`createAgentToolsCapability` (`packages/loop/src/runtime/capabilities/tools.ts`):

1. `forRun` returns `null` unless `ctx.env.CLARVIS_AGENT_TOOLS_ENABLED` — no toolset, no
   guard.
2. `await opts?.resolveGuard?.(ctx)` — **once per run**.
3. `elicitWaitMs = ctx.request.elicit_wait_ms ?? ctx.env.CLARVIS_DEFAULT_ELICIT_WAIT_MS`
   (env default 1,800,000 ms at `packages/capability/src/env.ts`).
4. `forAgent` computes the grant ceiling and returns `null` for an agent that cannot even read; otherwise it wraps the elicit with `withGuardElicitWaitBound(…, scope.signal)`
    and passes `guard` + `elicit` into `createAgentToolset`.

`withGuardElicitWaitBound` resolves `true` only on an explicit approval; a timeout,
an abort and a rejection all resolve `false`. `waitMs` is treated as a real bound whenever it is
`>= 0 && Number.isFinite` — so `0` denies on the next macrotask rather than waiting forever, which
the code calls out as the documented meaning of `elicit_wait_ms` and "the worst place" for
unbounded blocking. Only a non-finite value is unbounded. Every branch is pinned at
`packages/loop/tests/unit/guard-elicit-bound.test.ts`, including the `waitMs: 0` case
 and the "arms no timer only for a non-finite bound" case. A resolution of the
underlying, unbounded elicit call that lands *after* the bound has already denied is silently
discarded rather than racing or double-firing.

Because the guard is resolved per **run** and threaded into every agent's toolset, it applies to
lead-spawned subagents too (`packages/loop/tests/integration/command-guard-wiring.test.ts`).

### 4.9 The judge

`createJudgeElicit` (`packages/kernel/src/guard/judge.ts`):

- **Construction.** No model token (neither `cfg.model` nor `deps.defaultModel`) → `warn` +
  `undefined`. An unresolvable provider → `warn` + `undefined`.
  Both warnings end with the literal `"— degrading to mode 'on'"`.
- **Per call.** `memoKey` uses the exact `factsMessage` JSON supplied to the judge, including raw
  args/cwd and attested facts. Normalized equality alone cannot reuse a ruling across changed raw
  expansions, environment prefixes, placement or dangerous flags. Production: `memoKey` in
  `packages/kernel/src/guard/judge.ts`. Test:
  `packages/kernel/tests/integration/guard-auto-review.test.ts` (judge verdict identity).

State table for one `judgeOnce` :

| Outcome | Returns | Memoized? | File |
| --- | --- | --- | --- |
| `llm.call` throws, human fallback permitted/present | human answer, `answerer:"human"` | **no** (`clean:false`) | `createJudgeElicit` |
| `llm.call` throws, no permitted human fallback | deny, `answerer:"judge"` | **no** | `createJudgeElicit` |
| `decide` → `allow` | allow, `answerer:"judge"` | yes | `createJudgeElicit` |
| `decide` → `deny` | deny, `answerer:"judge"` | yes | `createJudgeElicit` |
| unparsable / wrong tool / schema mismatch, human fallback permitted/present | human answer, `answerer:"human"` | **no** | `createJudgeElicit` |
| unparsable / wrong tool / schema mismatch, no permitted human fallback | deny, `answerer:"judge"` | **no** | `createJudgeElicit` |
| `unsure`, `on_unsure !== "deny"`, human channel present | human answer, `answerer:"human"` | **no** | `createJudgeElicit` |
| `unsure`, otherwise | deny, `answerer:"judge"` | yes | `createJudgeElicit` |
| the escalated human elicit **rejects** | rethrows | **evicted** | — |

An `unsure` escalation appends `"The automated reviewer was unsure and escalated this to you"` plus
the judge's own reason to the request's existing reason; pinned at
`packages/kernel/tests/unit/guard.test.ts`.

The judge call uses `cfg.timeout_ms ?? 20_000` and forwards the run's
abort signal.

When the resolved provider kind is `openai-codex`, `AiSdkAdapter.call` streams even though the judge
does not install `onStreamDelta`; ChatGPT's pinned Codex Responses endpoint rejects non-streaming
requests. Production: `providerRequiresStream` in `packages/llm/src/ai-sdk-adapter.ts`. Test:
`packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts` (`"streams ChatGPT subscription
calls even without a delta consumer"`).

### 4.10 Prompt-cache TTL side effect

`guardParksOnHuman(param, guard, judgeConfigured)` returns `true` for mode `on`, and for mode `auto`
with no judge configured (`packages/kernel/src/guard/resolver.ts`). The run assembler uses
it to derive `prompt_cache_ttl: "1h"` when the caller named none
(`packages/kernel/src/runs/settings-assembler.ts`), pinned across the whole truth table
at `packages/kernel/tests/component/settings-assembler.test.ts`. The reason is stated in
the function's own docs: such runs "park repeatedly mid-conversation … the loop cannot derive this
itself because guard mode is resolved from host settings it never sees"
(`packages/kernel/src/guard/resolver.ts`). The economics belong to [prompt-cache-and-prefix-stability](../cross-cutting/prompt-cache.md).

### 4.11 `code`'s surface

- **Session mode** lives in a signal seeded from `code.json`'s `guard.mode`, else the settings-
  derived default (`packages/code/src/adapters/guard-mode.ts`,
  `packages/code/src/adapters/code-config.ts`). `cycle()` walks `off → on → auto → off`
  (`packages/code/src/adapters/guard-mode.ts`; pinned at `packages/code/tests/unit/guard-mode.test.ts`).
- **Quick Review picker** writes the block to `settings.json` through the same controller as Run
  Controls. It is reached by `Ctrl+G` everywhere and by `Alt+G` on an enhanced keyboard path; neither
  route changes Isolation (`packages/code/src/views/overlays/ReviewPicker.tsx`,
  `packages/code/src/features/run/review.ts`).
- **Run Controls** writes the block to `settings.json` and *pre-degrades*: choosing `auto` without a
  usable `default_model` persists `"on"` and says so
  (`packages/code/src/views/config/RunControlsPanel.tsx`, `applyGuard`). Its source column reads
  `"session"` whenever the session mode differs from the persisted one
  (`packages/code/src/views/config/RunControlsPanel.tsx`, `guardSource`). `applyReviewMode` preserves
  the effective `allowed_commands`/`denied_commands`; a workspace write carries forward a global
  policy when the workspace has no list of its own. Pinned by
  `packages/code/tests/integration/run-controls-render.test.tsx` and
  `packages/code/tests/integration/isolation-review-picker-render.test.tsx`.
- **Judge prompt** resolution is workspace `guard-judge.md` → global → built-in, with a blank or
  unreadable file treated as absent (`packages/code/src/adapters/guard-judge-prompt.ts`) and a >1 MiB file rejected without reading its body; pinned at
  `packages/code/tests/integration/guard-judge-prompt.test.ts`. The prompt is sent only
  when the mode is `auto` (`packages/code/src/runtime.tsx`, `judgePayloadFor`). `judgePayloadFor`
  (called by `buildRunHost` in `packages/code/src/runtime.tsx`) is the only production path that attaches `guard_judge` to a
  run request, and its return type is `{ guardJudge?: { prompt: string } }`
  (`packages/code/src/run-host.ts`) — it never sets `model`, `on_unsure` or `timeout_ms`, even
  though `toStartParams` forwards all three when present (`packages/code/src/adapters/kernel-run-client.ts`)
  and `GuardJudgeInput` declares them (`packages/code/src/adapters/run-types.ts`). Through
  `code`, the judge therefore always falls back to `settings.defaultModel`/`CLARVIS_DEFAULT_MODEL`
  (§4.6) and `on_unsure`'s omitted-field behavior (§2.5, invariant 43); the wider fields are wired
  end-to-end but dead on this client's path.
- **Isolation is separate.** Host/Sandbox/Docker/Podman selection writes no guard field, and a Review write
  writes no runtime or Sandbox field. The header and Run Controls therefore report both axes rather
  than naming a combined posture (`packages/code/src/features/run/isolation.ts`,
  `packages/code/src/features/run/review.ts`,
  `packages/code/src/adapters/execution-safety.ts`). The containment half belongs to
  [sandbox-and-toolchains](sandbox.md) and
  [isolated-agent-runtime](../hosts/isolated-agent-runtime.md).

---

## 5. Invariants

Numbered, declarative, falsifiable. "Unpinned" means no test was found that fails if the rule is
broken.

1. **An undecidable command is never workspace-confined.** `withinWorkspace` returns `false`
   whenever `ctx.shell.undecidable` is set, before looking at any path.
   `packages/tools/src/guard/helpers.ts`. Pinned:
   `packages/tools/tests/unit/guard-helpers.test.ts`.

2. **`withinWorkspace` and `touchesOutside` are not negations.** A call with no resolved paths (or
   an undecidable one) makes both `false`. `packages/tools/src/guard/helpers.ts`. Pinned:
   `packages/tools/tests/unit/guard-helpers.test.ts`.

3. **A dialect that reports a token `opaque` contributes no path *and* forces the whole command
   undecidable.** `packages/tools/src/guard/analyze-shell.ts`. Pinned generically over a
   stub dialect: `packages/tools/tests/unit/shell-dialect.test.ts`.

4. **A segment whose `argv` is empty *and* that recorded no env assignments makes the command
   undecidable.** Since `split` drops whitespace-only segments, this means exactly "source text
   existed and the front end produced no command". A `NAME=value` assignment-only segment is not
   that failure and does not poison later segments. `packages/tools/src/guard/analyze-shell.ts`.
   Pinned: `packages/tools/tests/unit/shell-dialect.test.ts` and, as a policy consequence under a
   `["*"]` allow list, `packages/kernel/tests/unit/guard.test.ts`.

5. **`analyzeShell` deduplicates paths across segments, preserving first-seen order.**
   `packages/tools/src/guard/analyze-shell.ts`. Pinned:
   `packages/tools/tests/unit/shell-dialect.test.ts`.

6. **The analyzer dialect and the executor shell derive from one `currentShellFlavor` call.**
   `packages/tools/src/guard/dialects/index.ts`, `packages/tools/src/shell.ts` and
   `packages/tools/src/tools/shell.ts`, all three reading `packages/tools/src/lib/platform.ts`.
   Pinned: the "dialect selection" suite in
   `packages/tools/tests/unit/powershell-dialect.test.ts` pins the platform→dialect mapping, and
   `packages/tools/tests/architecture/one-shell-flavor.test.ts` pins the executor half —
   for each of `win32`, `linux`, `darwin` and `freebsd` it asserts that
   `currentDialect(platform).flavor` and `resolveShell({platform, …}).flavor` both equal
   `currentShellFlavor(platform)`. The same file's scan makes the disagreement
   unrepresentable rather than merely absent today: no `src` module but `src/lib/platform.ts` may
   turn a platform into a shell flavor at all.

7. **Every env-assignment prefix stripped from a segment is recorded, never discarded.**
   `stripEnvAndWrappers` in `packages/tools/src/guard/dialects/posix.ts`; consumed by the session allow-list key
   at `packages/kernel/src/guard/guard-elicit.ts`. Pinned:
   `packages/tools/tests/unit/posix-dialect.test.ts` ("records the stripped env assignments so
   approvals can key on them") and
   `packages/kernel/tests/unit/guard.test.ts`.

8. **A POSIX opaque command name is matched only at the effective argv head** — after grouping,
   negation, `command`/`builtin` and compound-list keywords, optionally with a directory prefix —
   so `cat source` and `cat .env` stay decidable while `(sh -c "rm -rf /")` and `command env`
   do not. `opaqueCommand` in `packages/tools/src/guard/dialects/posix.ts`. Pinned:
   `packages/tools/tests/unit/posix-dialect.test.ts` ("analyzeBash — command names are matched in
   command position only").

9. **Every alphabetic PowerShell undecidable pattern is case-insensitive; the punctuation-only
   entries carry no `/i` since case does not apply to them.**
   `UNDECIDABLE_PATTERNS` in `packages/tools/src/guard/dialects/powershell.ts` — 5 of the 30 entries
   (`$(`, `@(`, `${`, `--%`, `<#`) are pure punctuation and carry no `/i`; the
   remaining 25 do. Pinned for the highest-value case:
   `packages/tools/tests/unit/powershell-dialect.test.ts` (the `invoke-expression $payload` case).

10. **PowerShell `normalize` rewrites `argv[0]` only.**
    `powershellDialect.normalize` in `packages/tools/src/guard/dialects/powershell.ts`. Pinned:
    `packages/tools/tests/unit/powershell-dialect.test.ts` ("rewrites only the command word, never
    the arguments").

11. **PowerShell `&` is never a statement separator.**
    `split` in `packages/tools/src/guard/dialects/powershell.ts` (no `&` arm). Pinned:
    `packages/tools/tests/unit/powershell-dialect.test.ts` ("never treats & as a separator").

12. **A PowerShell `#` opens a comment only at a token boundary**, so a trailing `# … ; rm -rf x`
    cannot produce a phantom segment an operator would see in the approval prompt.
    `startsComment` in `packages/tools/src/guard/dialects/powershell.ts`. Pinned:
    `packages/tools/tests/unit/powershell-dialect.test.ts` ("drops a line comment rather than
    yielding a phantom segment from it").

13. **A provider-qualified or drive-relative PowerShell token is `opaque`, never `none`.** Stated as
    a pre-empted failure mode, not an accident being fixed: reporting `none` "would let them
    contribute no `PathFact` while still looking analyzed, so a future allow-list entry would clear
    `Get-Content Env:\SECRET` on a command nothing had confined"
    (`pathCandidate`'s TSDoc in `packages/tools/src/guard/dialects/powershell.ts`). Production:
    `pathCandidate` in the same file. Pinned:
    `packages/tools/tests/unit/powershell-dialect.test.ts` ("reports a provider-qualified name as
    opaque, not as no path at all" and "reports a drive-relative reference as opaque").

14. **`PathFact.withinWorkspace` is derived by re-resolving in confining mode and catching the
    throw**, never by string comparison. `packages/tools/src/guard/paths.ts`. Pinned
    indirectly: `packages/tools/tests/unit/guard-context.test.ts`.

15. **Command-tool path tokens are resolved with shell semantics (tilde expansion); every other
    tool's path arg is not.** `packages/tools/src/guard/context.ts`.
    Pinned: `packages/tools/tests/unit/guard-context.test.ts`.

16. **The guard runs after argument validation and before the handler.**
    `packages/tools/src/core.ts`. Pinned: the handler's side effect is absent in
    `packages/tools/tests/integration/guard-dispatch.test.ts`, "denies the call and never runs the
    handler".

17. **An `ask` with no elicit channel is a denial, not an allow.**
    `packages/tools/src/core.ts`. Pinned in
    `packages/tools/tests/integration/guard-dispatch.test.ts`, "denies an ask when no elicit handler
    is configured".

18. **A throw anywhere in the guard or the elicit fails closed.**
    `packages/tools/src/core.ts`. Pinned in
    `packages/tools/tests/integration/guard-dispatch.test.ts`, "fails closed when the guard throws".

19. **The rule cascade's order is fixed: deny list → undecidable with nonempty deny list →
    guarded host-command review → generic undecidable →
    outside-workspace → credential file → non-shell allow → allow list → dangerous ask → unbounded-paths ask →
    default ask.**
    `packages/kernel/src/guard/shell-guard.ts`. Pinned pair-by-pair:
    `packages/kernel/tests/unit/guard.test.ts`, plus
    `packages/kernel/tests/unit/guard.test.ts` for the credential-file position.

    An explicit unsandbox host-command ask carries `escalate: "human"` in `on`; Auto alone passes
    `allowHostJudge: true` and can send it to the judge, without session coverage or session approval.
    Production:
    `packages/kernel/src/guard/shell-guard.ts` (`createShellGuard`). Test:
    `packages/kernel/tests/integration/guard-auto-review.test.ts` (Auto explicit unsandbox review,
    including real shell dispatch, judge denial, human fallback and session-coverage exclusion).

20. **The guard only ever narrows.** The sole `allow` verdicts are `non_bash` (rule 6) and
    `allow_list` (rule 7). `packages/kernel/src/guard/shell-guard.ts`.
    Pinned by exhaustion of the `matched` vocabulary in
    `packages/kernel/tests/unit/guard-audit.test.ts`.

21. **An empty `denied_commands` array never turns an unanalyzable command into a denial.**
    `packages/kernel/src/guard/shell-guard.ts` tests `denied.length > 0`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts`.

22. **A non-empty deny list turns *any* unanalyzable command into a denial** — it is not downgraded
    to an ask that a judge or session allow list could answer.
    `packages/kernel/src/guard/shell-guard.ts`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts`, and as a property over six commands.

23. **An `undecidable` ask carries `escalate: "human"` only on Host.** Contained undecidability
    remains an ordinary ask, never a silent policy allow. Explicit unsandbox matches `host_command`
    first and is reviewable by Auto, unless a deny-list rule already refused it.
    Production: `createShellGuard` in `packages/kernel/src/guard/shell-guard.ts`. Test:
    `packages/kernel/tests/integration/guard-auto-review.test.ts` (placement and dangerous cascade)
    and `packages/kernel/tests/unit/guard-audit.test.ts`.

24. **An `escalate: "human"` request bypasses both automatic answerers — the LLM judge and the
    session allow list.** `packages/kernel/src/guard/resolver.ts` (the escalate arm
    returns before the allow-list check). Pinned:
    `packages/kernel/tests/unit/guard-audit.test.ts`.

25. **An escalated ask with no human channel denies and emits a warn record**, rather than denying
    in silence. `packages/kernel/src/guard/resolver.ts`. Pinned:
    `packages/kernel/tests/unit/guard-audit.test.ts`.

26. **Allow/deny entries use normalized/comparison forms**, never raw segment
    text. In-workspace POSIX directory handling follows §4.5. Normalization strips env-assignment
    prefixes, so neither list can
    see them: an allow entry `git status` is satisfied by `LD_PRELOAD=/evil.so git status` exactly
    as it is by the bare command. `packages/kernel/src/guard/shell-guard.ts`.
    Pinned indirectly by the substitution case, which now resolves through the undecidable rule
    (`packages/kernel/tests/unit/guard.test.ts`); the env-assignment blind spot itself is
    unpinned in this document's scope.

27. **An entry containing `*` is an anchored full-string glob; one without is an exact-or-space-
    boundary prefix; a blank entry never matches.**
    `packages/kernel/src/guard/shell-guard.ts`, `packages/capability/src/glob.ts`.
    Unpinned — the shell-guard's own `compileCommandEntry("")` arm has no test, and the
    `@clarvis/tools` helper that used to pin the same blank-entry rule no longer exists.

28. **The allow list requires every non-skipped comparison segment to match; the deny list requires
    only one original or comparison match.** Validated POSIX `cd` segments may be skipped (§4.5).
    `packages/kernel/src/guard/shell-guard.ts`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts`.

29. **An undecidable or empty command is never allow-listed.**
    `packages/kernel/src/guard/shell-guard.ts`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts`.

30. **A credential-file match is decided on `PathFact.raw`, and `.env.example|sample|template` is
    exempt.** `packages/kernel/src/guard/shell-guard.ts`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts`.

31. **An audit record carries a digest of the command, never the command.**
    `packages/kernel/src/guard/shell-guard.ts`, `packages/kernel/src/guard/resolver.ts`.
    Pinned twice, including a `not.toContain` on the secret text:
    `packages/kernel/tests/unit/guard-audit.test.ts`.

32. **The audit channel is a distinct logger from the diagnostic one**, so lowering
    `CLARVIS_LOG_LEVEL` cannot silence the record of what a run was allowed to execute — but the
    whole channel is still gated by `CLARVIS_LOG_AUDIT` (default `true`), which `createAuditLogger`
    turns into a `NOOP_LOGGER`. `packages/kernel/src/guard/resolver.ts`; bound at
    `packages/kernel/src/file-kernel.ts`;
    `packages/kernel/src/component-loggers.ts`;
    `packages/capability/src/env.ts`. Pinned:
    `packages/kernel/tests/unit/guard-audit.test.ts`.

33. **`onDecision` cannot change a verdict.** The guard destructures the ruling and returns
    `decision` regardless of what the observer does.
    `packages/kernel/src/guard/shell-guard.ts`. Pinned:
    `packages/kernel/tests/unit/guard-audit.test.ts`.

34. **An absent `guard` block means unconfigured, not disabled: the default mode is `on`.**
    `packages/loop/src/runtime/capabilities/tools-settings.ts`. Pinned three times:
    `packages/kernel/tests/unit/guard.test.ts`, the product-level posture suite, and `packages/code/tests/unit/guard-mode.test.ts`.

35. **A run-request `guard_mode` overrides the settings default.**
    `packages/kernel/src/guard/resolver.ts`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts`.

36. **A plugin manifest may not contribute a `guard` block.**
    `packages/loop/src/runtime/capabilities/tools-settings.ts`, spec flags.
    The declared reason: "guard is a singleton and the last writer wins, so a plugin could silently
    disarm the workspace's own guard". Pinned:
    `packages/loop/tests/unit/settings-specs.test.ts` and
    `packages/loop/tests/unit/plugin-schema.test.ts`.

37. **The `guard` block merges last-scope-wins as a whole object, never field by field.**
    `packages/loop/src/runtime/capabilities/tools-settings.ts`. Pinned:
    `packages/loop/tests/unit/settings-merge.test.ts`.

38. **The guard's settings/request schema module imports no `@clarvis/tools` value**, so the
    settings schema carries no static dependency on the optional tools package.
    `packages/loop/src/runtime/capabilities/tools-settings.ts` (imports are `zod`,
    `@clarvis/capability` types and `input-limits`). Pinned by the architecture walk in
    `packages/loop/tests/architecture/optional-package-loading.test.ts` (derived from the engine
    manifest).

39. **`guard_mode: "off"` yields no guard object at all**, not a permissive one; tool dispatch then
    proceeds without command review, including for `require_escalated` shell.
    Production: `createGuardResolver` in `packages/kernel/src/guard/resolver.ts` and `applyGuard` in
    `packages/tools/src/core.ts`. Test: `packages/kernel/tests/unit/guard.test.ts` and
    `packages/tools/tests/integration/shell-escalation.test.ts`.

40. **Mode `auto` builds the judge only when `guard_judge` is present *and* a model resolves;
    otherwise it falls back to the human prompt.** `packages/kernel/src/guard/resolver.ts`. Pinned: `packages/kernel/tests/unit/guard.test.ts`.

41. **A judge failure or malformed response is not memoized and escalates to the human when the
    default `on_unsure: "ask"` policy and a human channel permit it; otherwise it denies.** The
    final audit answerer is `human` when that fallback answers, never incorrectly `judge`.
    Production: `fallback`/`judgeOnce` in `packages/kernel/src/guard/judge.ts` and the judge branch
    in `createGuardResolver`. Tests: `packages/kernel/tests/unit/guard.test.ts` (`"routes call
    failures and malformed responses to the human channel"`) and
    `packages/kernel/tests/unit/guard-audit.test.ts` (`"attributes a judge failure fallback to the
    human who answered it"`).

42. **A judge that cannot be constructed degrades the run to mode `on`, it does not disarm the
    guard.** `packages/kernel/src/guard/judge.ts` returns `undefined`;
    `packages/kernel/src/guard/resolver.ts` falls back to `humanElicit`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts`.

43. **`on_unsure: "deny"` never reaches the human, even when a human channel exists; an omitted
    `on_unsure` behaves as its documented default `"ask"` — `packages/kernel/src/guard/judge.ts`'s
    `cfg.on_unsure !== "deny"` treats `undefined` the same as `"ask"`.**
    `packages/kernel/src/guard/judge.ts`;
    `packages/loop/src/runtime/capabilities/tools-settings.ts`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts`.

44. **Session approvals are keyed exactly, never by prefix.** `packages/kernel/src/guard/guard-elicit.ts` uses
    `Set.has` on the full key. Pinned: `packages/kernel/tests/unit/guard.test.ts`
    (`git diff` covered, `git diff --stat` and `git` not).

45. **`allow_session` is offered only when the ask is not `host_command`, the command is decidable
    and non-empty and an allow list object exists**, and an `allow_session` answer that was not offered records nothing and denies.
    `packages/kernel/src/guard/guard-elicit.ts`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts`.

46. **The session allowlist is never persisted; its host can revoke it independently of the
    resolver.** The default lifetime remains one resolver, while `sessionAllowlistFor` chooses the
    current interactive scope per command. A revoked instance cannot be repopulated; a pending
    answer from that scope cannot approve even once. Container calls use the same host lookup and
    never cache human answers in the guest judge. Production:
    `createGuardSessionAllowlist` and `createGuardResolver` in
    [guard-elicit.ts](../../packages/kernel/src/guard/guard-elicit.ts) and
    [resolver.ts](../../packages/kernel/src/guard/resolver.ts). Test: the default across-run and
    controller-lifetime cases in [guard.test.ts](../../packages/kernel/tests/unit/guard.test.ts).

47. **A run with no elicit channel gets no elicit at all, even after another run of the same
    resolver recorded a session approval.** `packages/kernel/src/guard/resolver.ts`. Pinned: `packages/kernel/tests/unit/guard.test.ts`.

48. **The guard elicit is wait-bounded and fails closed on timeout, abort or rejection; `waitMs: 0`
    denies promptly rather than waiting forever, and a late resolution that arrives after the bound
    already denied is swallowed rather than racing or double-firing.**
    `packages/loop/src/runtime/capabilities/tools.ts`. Pinned:
    `packages/loop/tests/unit/guard-elicit-bound.test.ts`.

49. **The run's guard is resolved once and applies to every agent in the run, sub-agents
    included.** `packages/loop/src/runtime/capabilities/tools.ts` (run scope)
    (per agent). Pinned: `packages/loop/tests/integration/command-guard-wiring.test.ts`.

50. **A run whose guard parks on a human gets `prompt_cache_ttl: "1h"` unless the caller named a
    TTL.** `packages/kernel/src/guard/resolver.ts`,
    `packages/kernel/src/runs/settings-assembler.ts`. Pinned:
    `packages/kernel/tests/component/settings-assembler.test.ts`.

51. **The judge's `model` counts as a referenced provider for request validation**, even though the
    judge is not a profile. `packages/loop/src/validation/request/provider-rules.ts`, with
    the stated failure it prevents. Unpinned in this document's scope.

52. **Allow/deny lists are bounded: ≤256 entries, each 1..2048 characters, and an empty-string entry
    is rejected at parse time.** `packages/loop/src/runtime/capabilities/tools-settings.ts`,
    `packages/loop/src/validation/input-limits.ts`. Pinned for the empty entry:
    `packages/loop/tests/unit/settings-schema.test.ts`.

53. **`code` never sends a judge prompt for a mode other than `auto`.**
    `packages/code/src/runtime.tsx` (`judgePayloadFor`). Unpinned.

54. **`code`'s judge-prompt loader treats blank, unreadable and oversized files as absent, falling
    through to the next scope.** `packages/code/src/adapters/guard-judge-prompt.ts`. Pinned:
    `packages/code/tests/integration/guard-judge-prompt.test.ts`.

55. **`allowed_commands: []` and an omitted `allowed_commands` reach identical verdicts everywhere,
    but a human asked to confirm sees different words for it — `denied_commands: []` does not even
    have that.** `boundedPatternList` (`packages/loop/src/runtime/capabilities/tools-settings.ts`)
    has no `.min()` on the array itself, only on each entry's string length, so `[]` is a schema-legal,
    distinct-from-omitted value an operator can write for either list; `buildGuard` preserves that
    distinction by spreading the settings key only when `!== undefined`
    (`packages/kernel/src/guard/resolver.ts`). Inside `createShellGuard`, every branch that
    reads `denied` guards on `denied !== undefined` only to avoid calling `.map()`/`.length` on
    `undefined` — `commandDenied` (`packages/kernel/src/guard/shell-guard.ts`) and the
    `undecidable` branch's `denied.length > 0` check (invariant 21) both evaluate identically
    for `denied = []` and `denied = undefined`, so an operator's explicit `denied_commands: []` is
    truly indistinguishable, in every observable outcome, from never writing the key. `allowed`
    differs in exactly one place: the terminal `default` ruling's `reason` text branches on
    `allowed === undefined` directly, so `allowed_commands: []` produces `"command not
    in the allowed commands list"` where an omitted key produces `"no allowed commands list
    configured"` — same `ask` verdict, different sentence. That sentence is not merely internal: it
    is written to the audit channel's `reason` field (`packages/kernel/src/guard/resolver.ts`) and
    is what a human sees in the confirmation prompt itself when the ask escalates
    (`req.reason ?? …` at `packages/kernel/src/guard/guard-elicit.ts`), so the distinction the
    resolver preserves is operator-visible for `allowed_commands` and a documented no-op for
    `denied_commands`. This resolves, for `allowedCommands`, one of the ambiguities
    the retired gap report counted as fully resolved; for `deniedCommands` the
    resolution is that there is nothing left to distinguish — the two spellings are one behavior
    wearing the same words everywhere they surface.

56. **Changing command Review never erases the effective allow/deny policy or changes Isolation.**
    A workspace with no local list copies the global list into its written guard block so the
    capability's last-wins scope merge cannot shadow it. Production:
    `packages/code/src/features/run/review.ts` (`scopedGuardPolicy`, `applyReviewMode`) and
    `packages/code/src/views/config/RunControlsPanel.tsx` (`applyGuard`). Test:
    `packages/code/tests/integration/run-controls-render.test.tsx` and
    `packages/code/tests/integration/isolation-review-picker-render.test.tsx`.

57. **A selected skill's execution approval widens command analysis only to that skill directory.**
    The guard sees shell paths and `cwd` beneath exact `skillExecutionRoots`; native mutation remains
    separately denied and an unsandboxed child retains ordinary host filesystem rights. Production:
    `packages/tools/src/guard/context.ts`, `packages/tools/src/core.ts`, and
    `packages/loop/src/runtime/build-run-deps.ts`. Test:
    `packages/tools/tests/integration/api.test.ts` and
    `packages/skills/tests/integration/api.test.ts`.

58. **A literal path below the host environment temp or POSIX `/tmp` is inside the product's command
    boundary before any tool executes.** `createAgentToolsRunCapability` appends
    `systemTemporaryRoots()` to the run scratch, and `buildGuardContext` evaluates shell paths and
    `cwd` against the complete `RuntimeConfig.temporaryRoots`. This is pre-authorization, not a
    path learned from prior output. Production: `packages/loop/src/runtime/capabilities/tools.ts`
    (`accessibleTemporaryRoots`) and `packages/tools/src/guard/context.ts` (`commandRoots`). Test:
    `packages/loop/tests/integration/command-guard-wiring.test.ts` (`preauthorizes the host temp
    across shell and native tools without owning its parent`).

59. **An absolute executable spelling is not mistaken for an external data operand, and cannot
    bypass command policy.** For `shell`/`monitor_start`, only the first argv item of a segment is a
    candidate; it must resolve outside the workspace but beneath a platform system executable root
    or the configured sandbox runtime roots. The exception is attached to that lexical occurrence,
    never to the path string globally: the same path used as a later operand stays outside. Its
    basename replaces only the policy-facing `normalized` head, and Windows removes `.exe`, `.com`,
    `.bat`, or `.cmd`, so `/usr/bin/git push` still matches `git push` and an absolute `curl.exe`
    still matches an extensionless `curl` deny. Darwin includes the Apple Silicon Homebrew prefix
    `/opt/homebrew` among its platform roots. `/etc/passwd` remains an outside-workspace operand and
    `/opt/untrusted/bin/tool` remains denied. Production:
    `packages/tools/src/guard/context.ts` (`commandPathOccurrences`, `externalExecutableHeads`,
    `normalizeExternalExecutables`), `packages/tools/src/guard/dialects/powershell.ts`
    (`canonicalCommand`), and `packages/tools/src/lib/system-executables.ts`
    (`systemExecutableRoots`, `stripWindowsExecutableSuffix`). Test:
    `packages/tools/tests/unit/guard-context.test.ts` (`does not let a command-head exemption cover
    the same path used later as an operand`, `drops a Windows executable suffix from an absolute
    command's policy identity`) and `packages/kernel/tests/integration/guard-dialects.test.ts`
    (`keeps an absolute executable exemption local to its command-head occurrence`, `matches an
    absolute Windows executable suffix against an extensionless deny entry`).

60. **Every seeded default command is statically decidable and already written in the canonical
    form its host dialect matches.** The lists cover representative validation commands across
    JavaScript/TypeScript, Python, Rust, Go, JVM, .NET, C/C++, Ruby, PHP, Swift, Elixir/Erlang,
    Dart, Zig, Haskell, Clojure, Lua, Perl and shell projects, while generic interpreters/runners
    and explicit install, publish and deploy commands remain absent. Production:
    `POSIX_DEFAULT_ALLOWED_COMMANDS` and `WINDOWS_DEFAULT_ALLOWED_COMMANDS` in
    `packages/tools/src/guard/dialects/`. Test:
    `packages/tools/tests/unit/posix-dialect.test.ts` and
    `packages/tools/tests/unit/powershell-dialect.test.ts` (settings-bound/uniqueness assertions,
    complete decidability/canonicality loops, ecosystem samples and exclusion matrices).

61. **Container placement preserves command-guard decisions without trusting guest execution or
    audit identity.** The host sends only the guard/default-model settings needed to reconstruct
    `createGuardResolver`; provider secrets remain behind the model broker. The guest caps its
    built-in tool surface at `exec` and serializes only the closed guard-audit vocabulary. The guest
    has no host-exec channel: `require_escalated` fails closed there. The host
    rejects malformed audit events and overwrites guest-claimed `run_id`/`owner` with the
    authenticated route before writing. The OCI policy is the guest containment boundary; no missing
    nested native sandbox is treated as a guard bypass. Production: `guestGuardSettings` and
    `createGuestLoopExecutor` in `packages/kernel/src/runtime/guest-loop-executor.ts`;
    `forwardGuestGuardAudit` in `packages/kernel/src/runtime/guard-audit-bridge.ts`;
    `createRuntimeAuthorityRouter` in `packages/kernel/src/runtime/isolated-run-executor.ts`. Test:
    `packages/tools/tests/integration/shell-escalation.test.ts`;
    `runtime guard audit bridge` in
    `packages/kernel/tests/unit/runtime-guard-audit-bridge.test.ts`; `runtime guest loop` in
    `packages/kernel/tests/integration/runtime-guest-loop.test.ts`.

---

## 6. Failure modes and degradation

| Failure | Handling | Cite |
| --- | --- | --- |
| Guard function throws | `applyGuard` catches and returns an error result; the handler never runs | `packages/tools/src/core.ts` |
| Elicit throws inside the tools layer | same catch | `packages/tools/src/core.ts` |
| Elicit throws inside the loop wrapper | `mapRejection: () => false` — denies | `packages/loop/src/runtime/capabilities/tools.ts` |
| Elicit exceeds `elicit_wait_ms` | `onTimeout: () => false` — denies | `packages/loop/src/runtime/capabilities/tools.ts` |
| Run cancelled mid-prompt | `onAbort: () => false` at the loop layer; `signal` also passed into the elicitation itself | `packages/loop/src/runtime/capabilities/tools.ts`; `packages/kernel/src/guard/guard-elicit.ts` |
| Client declines or cancels the elicitation | `false` (deny) | `packages/kernel/src/guard/guard-elicit.ts` |
| No human channel on an escalated ask | `false` + warn `guard.escalation.no_channel` — the code calls this "the one denial a user can neither see nor answer" | `packages/kernel/src/guard/resolver.ts` |
| No judge model / unresolvable provider | judge is not built; run degrades to the human prompt; `warn` ending `"degrading to mode 'on'"` | `packages/kernel/src/guard/judge.ts` |
| Judge LLM call throws (incl. a non-`Error` throw) | ask the human when policy/channel permit, otherwise deny; warn and do not memoize | `fallback` and `judgeOnce` in `packages/kernel/src/guard/judge.ts` |
| Judge returns a non-`decide` call, unparsable JSON, or a schema mismatch | ask the human when policy/channel permit, otherwise deny; warn and do not memoize | `parseDecision`, `fallback`, and `judgeOnce` in `packages/kernel/src/guard/judge.ts` |
| Judge times out | governed by `cfg.timeout_ms ?? 20_000` passed to `llm.call`; surfaces as the throw path above | `packages/kernel/src/guard/judge.ts` |
| Escalated human elicit rejects inside the judge | memo evicted and the rejection rethrown | `packages/kernel/src/guard/judge.ts` |
| Analyzer cannot parse the command | deny with a nonempty deny list; otherwise explicit unsandbox reaches `host_command`, then generic Host human-escalated or contained reviewable ask | `packages/kernel/src/guard/shell-guard.ts` |
| A tool family the context builder does not know | no paths, no shell facts → rule 6 `non_bash` `allow` | `packages/tools/src/guard/context.ts`, `packages/kernel/src/guard/shell-guard.ts` |
| `CLARVIS_AGENT_TOOLS_ENABLED` unset | no toolset at all, so no guard is even constructed | `packages/loop/src/runtime/capabilities/tools.ts` |
| Host supplies no `resolveGuard` | calls receive no policy guard and proceed without command review, including `require_escalated` shell | `packages/loop/src/runtime/capabilities/tools.ts`; `packages/tools/src/core.ts` |
| Host supplies no audit logger | `NOOP_LOGGER`; rulings still happen, nothing is recorded | `packages/kernel/src/guard/resolver.ts`; test `packages/kernel/tests/unit/guard-audit.test.ts` |
| Guest sends a malformed or open-ended guard-audit event | the host throws `invalid_request`; no record is written with guest-controlled fields | `forwardGuestGuardAudit` in `packages/kernel/src/runtime/guard-audit-bridge.ts`; `runtime guard audit bridge` in `packages/kernel/tests/unit/runtime-guard-audit-bridge.test.ts` |
| `guard-judge.md` unreadable / blank / >1 MiB | silently treated as absent, next scope wins | `packages/code/src/adapters/guard-judge-prompt.ts` |
| `auto` chosen in Run Controls without a usable model | persisted as `"on"` with a notification | `packages/code/src/views/config/RunControlsPanel.tsx` (`applyGuard`) |

An unappealable static `deny` carries the guard's reason. When an `ask` reaches a reviewer but is not
approved — whether declined, cancelled, timed out or denied by the model — the tool error instead
prefixes that reason with `"command review did not approve"`, making the attempted review visible
without claiming why it returned false (`packages/tools/src/core.ts`). Both reach the
transcript as the tool call's `error`
(`packages/loop/tests/integration/command-guard-wiring.test.ts`). Note that the guard's reason strings
are tool results, so they fall under the tools package's "no bypass hints" scan
(`packages/tools/tests/architecture/no-bypass-hints.test.ts`) — that rule is owned by
[tools-contract-and-dispatch](tools-contract.md).

The terminal tool event also carries the final structured review whenever the
resolver supplied a mode: `mode`, `outcome: "allowed" | "denied"`, and the
actual `answerer`. The resolver returns rich answers from the judge, human, and
session-allowlist paths; `dispatch` attaches them to its result; and
`executeAgentToolCall` records them on `ToolCallDetail.guard`. Static allow/deny
rules use `answerer: "policy"`; an unavailable review channel uses
`"unavailable"`. Production: `buildGuard`/`answered`/`createGuardResolver` in
`packages/kernel/src/guard/resolver.ts`, `applyGuard` in
`packages/tools/src/core.ts`, and `executeAgentToolCall` in
`packages/loop/src/runtime/tools/builtin/execute-agent-tool-call.ts`. Tests:
`packages/kernel/tests/unit/guard.test.ts`,
`packages/tools/tests/integration/guard-dispatch.test.ts`, and
`packages/loop/tests/integration/command-guard-wiring.test.ts`.

That structured distinction also controls convergence. A policy, judge, session, unavailable-channel
or human refusal is a pre-execution `denied` outcome, not a failing tool execution: the transcript and
trace retain the error, while the loop breaks the active execution-failure and successful-result
repetition streaks. This prevents review decisions from exhausting `tool_failure_loop`; actual handler,
schema, unknown-tool, and MCP errors still count. Production: `executeAgentToolCall` and
`createConvergenceGuards` in `@clarvis/loop`. Test:
`packages/loop/tests/integration/command-guard-wiring.test.ts` (`policy and human denials do not
accumulate as execution failures`).

---

## 7. Coupling

### Runtime edges (value imports)

| From | To | What forces it |
| --- | --- | --- |
| `packages/tools/src/core.ts` | `buildGuardContext` | `applyGuard` must build a context before calling the host's guard |
| `packages/tools/src/guard/context.ts` | `analyzeShell`, `currentDialect` | command tools need facts and a dialect |
| `packages/tools/src/guard/dialects/index.ts` | `lib/platform.ts` | dialect selection derives from the same flavor the executor uses |
| `packages/kernel/src/guard/shell-guard.ts` | `@clarvis/tools/guard` (`withinWorkspace`, `touchesOutside` + types) | the policy reasons over the analyzer's facts |
| `packages/kernel/src/guard/shell-guard.ts` → `packages/kernel/src/guard/glob.ts` | `@clarvis/capability`'s `globToRegExp` | one shared glob dialect with `@clarvis/hooks` |
| `packages/kernel/src/guard/resolver.ts` | `@clarvis/loop/host`'s `defaultGuardMode` + `GuardConfig` | the settings shape is the engine's, not the kernel's |
| `packages/kernel/src/guard/judge.ts` | `@clarvis/capability`'s `parseModelRef`, `resolveProvider` | judge model resolution reuses the shared provider registry |
| `packages/kernel/src/file-kernel.ts` and `packages/kernel/src/runtime/guest-loop-executor.ts` | `createGuardResolver` | native and isolated guest construction sites; the latter receives stripped host settings and returns validated audit events |
| `packages/loop/src/runtime/capabilities/tools.ts` | `opts.resolveGuard` | the engine's single call into host guard policy |
| `packages/loop/src/runtime/tools/builtin/index.ts` | `@clarvis/tools/guard` values | re-export barrel under the tools capability subpath |
| `packages/code/src/onboarding/seed-default-allowlist.ts` | `@clarvis/kernel/local`'s two default lists | the seed is the analyzer's own list, not a copy |
| `packages/code/src/adapters/guard-mode.ts` | `@clarvis/kernel/policy`'s `defaultGuardMode` | the TUI's seed must agree with the kernel's default |

### Type-only edges

- `packages/loop/src/runtime/capabilities/tools-settings.ts` imports only *types* from
  `@clarvis/capability`, and nothing from `@clarvis/tools` — that absence is the whole reason the
  file exists, and it is what keeps `settings-specs.ts` off the optional package.
- `packages/kernel/src/guard/guard-elicit.ts` imports `ElicitationCommandDetail` as a type from
  `@clarvis/protocol`; the engine "pipes params through opaquely", so the loop has no
  edge to the protocol here.
- `packages/kernel/src/guard/resolver.ts` takes `Guard`, `GuardElicit`, `GuardMode`,
  `GuardResolution`, `GuardResolver` as types from `@clarvis/loop`.

### Registration edges

- `agentToolsSettingsSpec` is listed in `BUILTIN_SETTINGS_SPECS`
  (`packages/loop/src/runtime/capabilities/settings-specs.ts`), which is what puts `guard` in the
  settings schema, the merge strategy table and the plugin manifest surface, and `guard_mode`/
  `guard_judge` in the run request — enforced as a registry-wide property at
  `packages/loop/tests/unit/settings-specs.test.ts`.
- `GUARD_PLUGIN_FIELDS` is spread into `capabilityPluginFields`
  (`packages/loop/src/runtime/capabilities/settings-specs.ts`), which is what makes a plugin's
  `guard` a *parse error* rather than a silently ignored key.

### Who depends on this

`@clarvis/tools`' `dispatch` (every tool call), `@clarvis/kernel`'s run assembler (for the cache
TTL), `@clarvis/code`'s Run Controls / header / Review picker, and `@clarvis/server`, which
deliberately does **not** expose `guard_mode` (`packages/server/src/mcp/tools.ts`) and
separately postures guard confirmations per principal
(`packages/server/src/mcp/elicitation.ts`) — both delegated to [server-mcp-facade](../hosts/server-mcp.md) and
[elicitation-and-user-interaction](../cross-cutting/elicitation.md).

---

## 8. Open questions

- **`code.json`'s `guard.mode` is read but never written.** It is **read** as a seed by
  `createGuardModeStore` (`packages/code/src/adapters/code-config.ts`,
  `packages/code/src/adapters/guard-mode.ts`), while Run Controls persists the mode through
  `deps.settings.write` instead (`packages/code/src/views/config/RunControlsPanel.tsx`, `applyGuard`).
  `GuardModeStore` accordingly exposes only `mode`/`setMode`/`cycle`
  (`packages/code/src/adapters/guard-mode.ts`) — nothing in it writes the seed back.
  Whether the read-only seed is intentional remains undetermined.
- **A stale test comment.** `packages/kernel/tests/unit/guard.test.ts` says the
  `$(echo git) push origin main` case is closed by "Matching the raw segment text as well", but
  `commandDenied` matches `normalized` only and the source explicitly records that raw matching "was
  tried and removed" (`packages/kernel/src/guard/shell-guard.ts`). The test passes
  through the *undecidable* rule instead. The comment describes an implementation that no longer
  exists.
- **A plugin `guard` block would still merge if it ever reached the merger.**
  `packages/loop/tests/unit/settings-merge.test.ts` asserts that a plugin-scope `guard`
  survives the merge at lowest precedence. The plugin *schema* rejects it first
  (`packages/loop/src/runtime/capabilities/tools-settings.ts`), so nothing real can produce that state — but the merger itself has no
  guard-specific refusal, and the source does not settle whether that is deliberate defence-in-depth
  absence or an oversight.
- ~~**No test asserts the executor and the analyzer actually share a flavor.**~~ Resolved: invariant
  6's `packages/tools/tests/architecture/one-shell-flavor.test.ts` scan rejects a second
  platform-to-flavor derivation and checks the analyzer/executor answer together.
- **Windows behaviour is unverified here.** The PowerShell dialect's own tests avoid asserting
  `PathFact.withinWorkspace` because "on a POSIX host `node:path` does not treat `\` as a separator,
  so a confinement assertion here would pass for the wrong reason. That belongs to the Windows job"
  (`packages/tools/tests/unit/powershell-dialect.test.ts`, "still extracts the paths a command
  touches"). Whether that job currently
  runs is outside this document's scope.
- ~~**Rationale is largely absent for the pattern tables.**~~ **Each now states its membership
  rule at the source**, which is what was missing — not a defence of each individual entry but the
  test that decides whether one belongs:
  - The **30 PowerShell undecidable patterns** are long because PowerShell offers many spellings of
    one capability. Every entry is a substitution the analyzer cannot resolve, a way to evaluate a
    string as code, a way to hand the command to another interpreter, or a way to run something out
    of band; the aliases sit beside their cmdlets because to PowerShell an alias *is* the command,
    so matching only the long form is no defence rather than a partial one
    (`UNDECIDABLE_PATTERNS`' TSDoc in `packages/tools/src/guard/dialects/powershell.ts`).
  - The **11 credential-file regexes** do not try to enumerate every secret-bearing file, which is
    impossible. They name the conventional locations whose *name alone* is sufficient evidence, in
    three families — the ambient project secret, private key material, and the credential stores
    specific tools are known to write. Since the verdict is `ask`, the list errs towards matching
    (`packages/kernel/src/guard/shell-guard.ts`).
  - The **five POSIX safe wrappers** pass one test: does the wrapper alter the *effect* of what it
    runs? These five change only scheduling, buffering or a deadline. `sudo`, `env` and `xargs` look
    like wrappers and are excluded, because each changes the privileges, environment or arguments the
    real command ends up with — looking past one would let a deny list be walked around by prefixing
    it (`SAFE_WRAPPERS`' TSDoc in `packages/tools/src/guard/dialects/posix.ts`).
  - The **1 MiB judge-prompt cap** exists because over-size is treated as *absent*, not truncated:
    cutting an operator's security policy in half would judge commands against half a rule set, while
    falling back to the built-in prompt judges them against a complete one. It sits far above any
    policy a person writes — the default is under 2 KB — so reaching it means the wrong file
    (`packages/code/src/adapters/guard-judge-prompt.ts`).

  Both starter allow lists carry an explicit, test-enforced inclusion/exclusion rationale. Their
  dialect suites assert every entry is statically decidable and canonical, sample the supported
  ecosystem breadth, and keep generic runners plus install/publish commands out
  (`packages/tools/tests/unit/{posix,powershell}-dialect.test.ts`).
- **`escalate` admits only `"human"`.** `createShellGuard` sets it for generic Host undecidability
  and explicit unsandbox without `allowHostJudge` (`packages/kernel/src/guard/shell-guard.ts`).
  It bars both the judge and session coverage. Auto host-command asks instead omit this field and
  bypass session coverage by `matched: "host_command"` in `packages/kernel/src/guard/resolver.ts`;
  they may use the judge but never session approval. Test:
  `packages/kernel/tests/integration/guard-auto-review.test.ts` and
  `packages/kernel/tests/unit/guard.test.ts`.
- **Handed to siblings, not covered here:** the elicitation transport, buffering and the
  `auto_decline` posture ([elicitation-and-user-interaction](../cross-cutting/elicitation.md)); how `ElicitBlock` renders a
  `guard_confirm` (`packages/code/src/views/ElicitBlock.tsx`, [code-transcript-and-tool-rendering](../hosts/code-transcript.md));
  the seeding of `allowed_commands` on first boot ([code-onboarding-doctor-and-platform](../hosts/code-onboarding.md)); the
  independent Isolation control ([sandbox-and-toolchains](sandbox.md) and
  [isolated-agent-runtime](../hosts/isolated-agent-runtime.md)); and the prompt-cache economics
  behind the `1h` TTL ([prompt-cache-and-prefix-stability](../cross-cutting/prompt-cache.md)).
