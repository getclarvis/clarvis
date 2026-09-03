# Shell-command analysis, guard modes, allow/deny policy and the judge

> Implemented at `packages/...`. Every claim below is anchored to a file and line. Open questions
> are collected in the final section.

## 1. Purpose

The command guard decides, per tool call, whether the call runs silently, is refused, or is put to
somebody (a person or an LLM) first. It is split across three packages that never see each other's
policy:

- **`packages/tools/src/guard/**` — the analyzer.** It turns a raw shell string into
  `ShellFacts` (per-command `Segment`s, the filesystem paths the command appears to touch, and an
  `undecidable` flag), and turns any tool call into a `GuardContext` carrying resolved `PathFact`s
  (`packages/tools/src/guard/analyze-shell.ts:39`, `packages/tools/src/guard/context.ts:66`). It
  ships **no policy**: `RuntimeConfig.guard` and `RuntimeConfig.elicit` are host-supplied ports
  (`packages/tools/src/config.ts:115`-`:119`), and `applyGuard`
  (`packages/tools/src/core.ts:156`-`:205`) is the only place a tool dispatch consults them.
- **`packages/kernel/src/guard/**` — the policy.** `createShellGuard`
  (`packages/kernel/src/guard/shell-guard.ts:244`) is a fixed-precedence rule cascade over deny
  host-command escalation, lists, undecidability, workspace containment, credential-file patterns
  and allow lists.
  `createGuardResolver` (`packages/kernel/src/guard/resolver.ts:225`) picks the run's mode, builds
  the guard, wires the answering channel (human elicitation, LLM judge, or a session allow list),
  and writes the audit record.
- **`packages/loop/src/runtime/capabilities/tools.ts` — the wiring.** The engine names a
  `GuardResolver` port (`:60`-`:62`), calls it once per run (`:132`), and threads the resulting guard
  and a wait-bounded elicit into every agent's toolset (`:205`-`:223`). It owns the `guard` settings
  block and the `guard_mode`/`guard_judge` run params
  (`packages/loop/src/runtime/capabilities/tools-settings.ts:21`, `:154`) in pure zod, with no
  import of `@clarvis/tools`, as that file's own header states
  (`packages/loop/src/runtime/capabilities/tools-settings.ts:1`-`:8`).

The analyzer's stated posture is that it is *not* a shell parser: "This is a best-effort heuristic
for approval decisions, not a shell parser" (`packages/tools/src/guard/analyze-shell.ts:28`). Its
one hard contract is that anything it cannot bound is reported `undecidable`, and callers "must
treat an undecidable result as 'unknown', never as workspace-confined"
(`packages/tools/src/guard/analyze-shell.ts:26`-`:27`).

Delegated elsewhere and **not** described here: the elicitation transport that actually reaches a
human ([elicitation-and-user-interaction](../cross-cutting/elicitation.md)); sandbox confinement ([sandbox-and-toolchains](sandbox.md)); why
`@clarvis/server` refuses `guard_mode` ([server-mcp-facade](../hosts/server-mcp.md) — the refusal itself is at
`packages/server/src/mcp/tools.ts:50`-`:51`). Note also a **name collision**: the
`guard_escalation` trace kind (`packages/capability/src/trace-kinds.ts:514`) belongs to the
*convergence* guards (`packages/loop/src/runtime/guards/guard-escalation.ts:16`), not to this
subsystem.

---

## 2. Surface

### 2.1 `@clarvis/tools` → `./guard` (`packages/tools/src/guard/index.ts`)

| Symbol | Kind | Defined at | Signature / shape |
| --- | --- | --- | --- |
| `Verdict` | type | `packages/tools/src/guard/types.ts:7` | `"allow" \| "deny" \| "ask"` |
| `GuardDecision` | iface | `packages/tools/src/guard/types.ts:13` | `{ verdict; reason?: string; escalate?: "human" }` |
| `Segment` | iface | `packages/tools/src/guard/types.ts:42` | `{ command; argv; normalized; envAssignments; decidable }` |
| `ShellFacts` | iface | `packages/tools/src/guard/types.ts:64` | `{ paths: string[]; segments: Segment[]; undecidable: boolean }` |
| `PathFact` | iface | `packages/tools/src/guard/types.ts:80` | `{ raw; resolved; withinWorkspace }` |
| `GuardContext` | iface | `packages/tools/src/guard/types.ts:95` | `{ tool; args; config; paths: PathFact[]; shell?: ShellFacts }` |
| `Guard` | type | `packages/tools/src/guard/types.ts:107` | `(ctx: GuardContext) => GuardDecision \| Promise<GuardDecision>` |
| `ElicitRequest` | iface | `packages/tools/src/guard/types.ts:114` | `{ tool; args; reason?; shell?; escalate? }` |
| `Elicit` | type | `packages/tools/src/guard/types.ts:131` | `(req: ElicitRequest) => boolean \| Promise<boolean>` |
| `Token` | iface | `packages/tools/src/guard/dialect.ts:7` | `{ text: string; glob: boolean }` |
| `PathCandidate` | type | `packages/tools/src/guard/dialect.ts:26` | `{kind:"none"} \| {kind:"path";value} \| {kind:"prefix";value} \| {kind:"opaque"}` |
| `ShellDialect` | iface | `packages/tools/src/guard/dialect.ts:48` | `{ flavor; split; tokenize; decidable; normalize; pathCandidate }` |
| `analyzeShell` | fn | `packages/tools/src/guard/analyze-shell.ts:39` | `(command: string, dialect = currentDialect()) => ShellFacts` |
| `buildGuardContext` | fn | `packages/tools/src/guard/context.ts:66` | `(tool, args, config, dialect = currentDialect()) => GuardContext` |
| `posixDialect` | const | `packages/tools/src/guard/dialects/posix.ts:463` | the POSIX front end |
| `powershellDialect` | const | `packages/tools/src/guard/dialects/powershell.ts:748` | the PowerShell front end |
| `dialectFor` | fn | `packages/tools/src/guard/dialects/index.ts:12` | `(flavor: ShellFlavor) => ShellDialect` |
| `currentDialect` | fn | `packages/tools/src/guard/dialects/index.ts:29` | `(platform?) => ShellDialect` |
| `POSIX_DEFAULT_ALLOWED_COMMANDS` | const | `packages/tools/src/guard/dialects/posix.ts:72` | 35 entries |
| `WINDOWS_DEFAULT_ALLOWED_COMMANDS` | const | `packages/tools/src/guard/dialects/powershell.ts:94` | 20 entries |
| `withinWorkspace` | fn | `packages/tools/src/guard/helpers.ts:14` | `(ctx) => boolean` |
| `touchesOutside` | fn | `packages/tools/src/guard/helpers.ts:29` | `(ctx) => boolean` |

`resolveCandidate` (`packages/tools/src/guard/paths.ts:46`) and `patchPaths` (`packages/tools/src/guard/paths.ts:85`) are internal to the
package — `packages/tools/src/guard/index.ts:10`-`:27` does not re-export them.

### 2.2 `@clarvis/kernel` → `./policy` and internals

| Symbol | Kind | Defined at | Signature |
| --- | --- | --- | --- |
| `createGuardResolver` | fn | `packages/kernel/src/guard/resolver.ts:225` | `(deps: GuardResolverDeps) => GuardResolver` |
| `resolveGuardMode` | fn | `packages/kernel/src/guard/resolver.ts:59` | `(param: GuardMode\|undefined, guard: GuardConfig\|undefined) => GuardMode` |
| `guardParksOnHuman` | fn | `packages/kernel/src/guard/resolver.ts:80` | `(param, guard, judgeConfigured) => boolean` |
| `GuardSettings` | iface | `packages/kernel/src/guard/resolver.ts:21` | `{ guard?: GuardConfig; providers?: ProviderConfig[]; defaultModel?: string }` |
| `GuardSettingsLoader` | type | `packages/kernel/src/guard/resolver.ts:31` | `() => GuardSettings` |
| `GuardResolverDeps` | iface | `packages/kernel/src/guard/resolver.ts:34` | `{ loadSettings; logger?; audit? }` |
| `createShellGuard` | fn | `packages/kernel/src/guard/shell-guard.ts:246` | `(opts?: ShellGuardOptions) => Guard` |
| `ShellGuardOptions` | iface | `packages/kernel/src/guard/shell-guard.ts:55` | `{ allowedCommands?; deniedCommands?; onDecision? }` |
| `ShellGuardDecision` | iface | `packages/kernel/src/guard/shell-guard.ts:36` | `{ tool; verdict; matched; reason?; escalate?; commandDigest? }` |
| `ShellGuardMatch` | type | `packages/kernel/src/guard/shell-guard.ts:19` | 8 rule names (table §4.5) |
| `createGuardElicit` | fn | `packages/kernel/src/guard/guard-elicit.ts:118` | `(elicit: Elicit, opts?) => GuardElicit` |
| `createGuardSessionAllowlist` | fn | `packages/kernel/src/guard/guard-elicit.ts:73` | `() => GuardSessionAllowlist` |
| `GuardElicitParams` | type | `packages/kernel/src/guard/guard-elicit.ts:36` | `ElicitParams & { detail?: ElicitationCommandDetail }` |
| `createJudgeElicit` | fn | `packages/kernel/src/guard/judge.ts` | `(deps, cfg, humanElicit) => JudgeElicit \| undefined` (`JudgeElicitAnswer` carries `allowed` + final `answerer`) |
| `JudgeDeps` | iface | `packages/kernel/src/guard/judge.ts:50` | `{ llm; providers; defaultModel; logger?; signal? }` |
| `globToRegExp` | fn (re-export) | `packages/kernel/src/guard/glob.ts:10` | from `@clarvis/capability` (`packages/capability/src/glob.ts:30`) |

`./policy` exports only `createGuardResolver`, `resolveGuardMode`, `createShellGuard` and the three
shell-guard types (`packages/kernel/src/policy.ts:2`); `guardParksOnHuman` is internal and reached
only by `packages/kernel/src/runs/settings-assembler.ts:13`.

### 2.3 Loop capability ports (`packages/loop/src/runtime/capabilities/tools.ts`)

| Symbol | Defined at | Shape |
| --- | --- | --- |
| `GuardResolution` | `:50`-`:53` | `{ guard?: Guard; elicit?: GuardElicit }` |
| `GuardResolver` | `:60`-`:62` | `(ctx: RunCapabilityContext) => Promise<GuardResolution\|undefined> \| GuardResolution \| undefined` |
| `AgentToolsCapabilityOptions.resolveGuard` | `:82`-`:86` | optional; omitting it passes no policy guard (`:79`-`:81`), while core still hard-denies `host_vcs` (`packages/tools/src/core.ts:161`-`:164`) |
| `withGuardElicitWaitBound` | `:103`-`:115` | `(elicit, waitMs, signal) => GuardElicit` |
| `AGENT_TOOLS_CAPABILITY_NAME` | `:46` | `"tools"` |

### 2.4 Settings key `guard` (`packages/loop/src/runtime/capabilities/tools-settings.ts:21`)

| Field | Line | Type / default | Notes |
| --- | --- | --- | --- |
| `type` | `:24` | `"shell"`, **required** | error text `guard.type must be 'shell'`; "Names the policy, not a shell syntax: the dialect is derived from the host platform" (`:28`) |
| `mode` | `:31` | `"off"\|"on"\|"auto"`, optional | absent ⇒ `"on"` via `defaultGuardMode` (`:116`-`:118`) |
| `allowed_commands` | `:43` | `string[]`, optional | each entry 1..2048 chars, ≤256 entries (`:14`-`:16`, `packages/loop/src/validation/input-limits.ts:19`-`:20`) |
| `denied_commands` | `:51` | `string[]`, optional | same bounds |

The object is `.strict()` (`:60`) — an unknown key is `unrecognized_keys`
(`packages/loop/tests/unit/settings-schema.test.ts:205`). Merge strategy is `"lastWins"`
(`:265`); `pluginContributable: false` with `pluginForbiddenReason` (`:266`-`:267`) sourced from
`GUARD_PLUGIN_FORBIDDEN_REASON` (`:175`-`:178`), surfaced through `GUARD_PLUGIN_FIELDS` (`:181`) as
a `z.undefined()` field that exists solely "so that trying it explains why" (`:185`).

### 2.5 Run-request params (`packages/loop/src/runtime/capabilities/tools-settings.ts:154`)

| Param | Line | Schema |
| --- | --- | --- |
| `guard_mode` | `:155` | `z.enum(["off","on","auto"])` (`:121`) |
| `guard_judge` | `:164` | `.strict()` object (`:130`-`:140`): `prompt` (1..32768 chars, required), `model?` (min 1), `on_unsure?: "ask"\|"deny"`, default `"ask"` per its own `.describe()` (`:170`), `timeout_ms?` (positive int ≤ 120000) |

Both reach the request schema through `capabilityRequestParamFields`
(`packages/loop/src/runtime/capabilities/settings-specs.ts:64-69`) and the spec's
`requestParams` (`packages/loop/src/runtime/capabilities/tools-settings.ts:268`). The protocol mirrors them as `StartRunParams.guard_mode`
/ `guard_judge` (`packages/protocol/src/runs.ts:95`-`:96`, types at `:45` and `:48`); the
capability vocabulary declares `GuardMode` at `packages/capability/src/api.ts:522` and
`GuardJudgeConfig` at `:526`-`:532`.

### 2.6 `@clarvis/code` surface

| Symbol | Defined at | Purpose |
| --- | --- | --- |
| `GuardMode` | `packages/code/src/adapters/guard-mode.ts:7` | local restatement of the three modes |
| `guardAutoResolves` | `packages/code/src/adapters/guard-mode.ts:20` | `auto` is usable only with a `default_model` that `validateProviders` accepts |
| `GuardModeStore` | `packages/code/src/adapters/guard-mode.ts:28` | `{ mode; setMode; cycle }` |
| `createGuardModeStore` | `packages/code/src/adapters/guard-mode.ts:44` | seeds from `code.json` default, else `defaultGuardMode(settings.guard)` (`:46`) |
| `DEFAULT_GUARD_JUDGE_PROMPT` | `packages/code/src/adapters/guard-judge-prompt.ts:5` | the built-in judge system prompt |
| `GuardJudgePrompt` | `packages/code/src/adapters/guard-judge-prompt.ts:31` | `{ prompt; source: "workspace"\|"global"\|"builtin" }` |
| `loadGuardJudgePrompt` | `packages/code/src/adapters/guard-judge-prompt.ts:81` | workspace → global → builtin |

The mode reaches a run through `judgePayloadFor` (`packages/code/src/runtime.tsx`) and
`toStartParams` (`packages/code/src/adapters/kernel-run-client.ts:137`-`:172`). The command
`guard.cycle` is registered at `packages/code/src/app/commands.tsx:481`-`:488` and runs
`cycleGuardMode` (`packages/code/src/views/App.tsx:619`-`:623`).

---

## 3. Data and formats

### 3.1 `ShellFacts` — what one analysis looks like

Nothing persists `ShellFacts`; it lives for one dispatch. Its shape, from the driver
(`packages/tools/src/guard/analyze-shell.ts:53`-`:76`), for the POSIX input
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

`normalized` is `argv.join(" ")` (`packages/tools/src/guard/analyze-shell.ts:56`) — the env-stripped, wrapper-stripped
command. The `normalized`/`envAssignments` split is pinned by
`packages/tools/tests/unit/posix-dialect.test.ts:79`-`:85`.

### 3.2 `guard` settings block, as written

Seeded by `code` into the **global** scope on first use
(`packages/code/src/onboarding/seed-default-allowlist.ts`, `seedDefaultAllowlist`; that seeding belongs to
[code-onboarding-doctor-and-platform](../hosts/code-onboarding.md)):

```json
{ "guard": { "type": "shell", "allowed_commands": ["git status", "git diff", "…"] } }
```

The 35 POSIX entries are at `packages/tools/src/guard/dialects/posix.ts:72`-`:108`; the 20
PowerShell entries at `packages/tools/src/guard/dialects/powershell.ts:94`-`:115`. Windows entries
are written in the **canonical cmdlet spelling** because the analyzer rewrites aliases before
matching (`packages/tools/src/guard/dialects/powershell.ts:84`-`:86`).

### 3.3 Allow/deny entry syntax

One entry compiles to one predicate over a segment's `normalized`
(`packages/kernel/src/guard/shell-guard.ts:159`-`:165`):

| Entry form | Match rule | Line |
| --- | --- | --- |
| `""` (or whitespace) | never matches | `:146` |
| no `*` | `normalized === entry` or `normalized.startsWith(entry + " ")` | `:147` |
| contains `*` | anchored `globToRegExp(entry)` — `^…$`, `*`→`.*`, everything else escaped | `:148`, `packages/capability/src/glob.ts:30`-`:31` |

The same `*`-glob implementation backs `@clarvis/hooks`' `match.tool`, so "the anchoring and
escaping rules can only be right or wrong once" (`packages/capability/src/glob.ts:5`-`:7`).

### 3.4 `guard_judge` payload and the `decide` tool

Request-side shape (§2.5). Judge-side, the model is given exactly two messages
(`packages/kernel/src/guard/judge.ts:179`-`:182`): `system` = the caller's `prompt` verbatim, and
`user` = the pretty-printed JSON facts document (`packages/kernel/src/guard/judge.ts:68`-`:81`):

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

It is forced to answer through one tool, `decide` (`packages/kernel/src/guard/judge.ts:17`, `:32`-`:47`), with
`toolChoice: { type: "function", function: { name: "decide" } }` (`packages/kernel/src/guard/judge.ts:191`):

```json
{ "type": "object", "required": ["decision"], "additionalProperties": false,
  "properties": { "decision": { "type": "string", "enum": ["allow","deny","unsure"] },
                  "reason": { "type": "string" } } }
```

Arguments are re-validated on the way back with a **loose** zod schema (`packages/kernel/src/guard/judge.ts:24`-`:29`) that
tolerates extra keys; a string `arguments` is `JSON.parse`d first, and a parse failure yields
`undefined` (`packages/kernel/src/guard/judge.ts:115`-`:124`).

The Code host's built-in prompt states that the judge has no surrounding conversation or prior user
authorization. Operations whose safety depends on that missing intent — including `git restore`,
`git reset`, `git clean`, checkout-over-files and broad workspace deletion — must return `unsure`,
which the default `on_unsure: "ask"` path escalates to the human. `deny` is reserved for conduct that
is unacceptable regardless of missing conversational intent
(`packages/code/src/adapters/guard-judge-prompt.ts:26`-`:33`). Pinned by
`packages/code/tests/integration/guard-judge-prompt.test.ts` (`"falls back to the built-in prompt when
no override file exists"`) and the kernel's actual unsure-to-human bridge test
`packages/kernel/tests/unit/guard.test.ts:519`-`:549`.

### 3.5 Elicitation payload for a `guard_confirm`

`createGuardElicit` builds `GuardElicitParams` (`packages/kernel/src/guard/guard-elicit.ts:118`-`:177`):

- `kind: "guard_confirm"` (`:138`-`:155`)
- `message`: the reason, then `$ <command>` (or `Command segments: a, b` when there is no command
  string), then the literal `"Warning: this command contains undecidable expansions."` when the
  facts are undecidable (`:120`-`:130`, constant at `:29`)
- `requestedSchema.properties.decision.enum`: `["deny","allow","allow_session"]` when a session
  allow list is available and the command is decidable and non-empty, else `["deny","allow"]`
  (`:131`-`:154`)
- `detail?: ElicitationCommandDetail` — `{ command, cwd, reason, warning? }`
  (`:156`-`:164`), whose protocol type is `packages/protocol/src/runs.ts:651`-`:659`. `cwd` is
  `resolve(workspaceRoot, args.cwd)` or the workspace root itself (`:160`). It is attached only
  when both a `command` arg and a `workspaceRoot` option are present (`:157`).

The kernel's elicit bridge lifts `detail` onto the wire `ElicitationRequest`
(`packages/kernel/src/runs/elicit-bridge.ts:52`, `:59`) — the engine itself never knows the shape
(`packages/kernel/src/guard/guard-elicit.ts:31`-`:36`).

### 3.6 Session allow-list key

In-memory only, `Set<string>`, never persisted (`packages/kernel/src/guard/guard-elicit.ts:38`-`:85`).
One key per segment: `[...envAssignments, normalized].join(" ")`
(`packages/kernel/src/guard/guard-elicit.ts:58`-`:64`). So `FOO=1 bun test` keys as `"FOO=1 bun test"` and does not cover
`bun test` (pinned at `packages/kernel/tests/unit/guard.test.ts:316`-`:329`).

Both `covers()` and `record()` are a no-op — `false` / nothing recorded — for an undecidable or
empty-segment `ShellFacts` (`packages/kernel/src/guard/guard-elicit.ts:77`, `:66`). Combined with invariant 24 (`escalate:
"human"` always carries an undecidable command and bypasses the allowlist check anyway), this means
the session allowlist can never be satisfied by, and never grows from, an undecidable command.

### 3.7 Audit records

Three events, all `info` except the last, all written to a **separate** audit logger rather than
the diagnostic one (`packages/kernel/src/guard/resolver.ts:39`-`:48`):

| Event | Emitted at | Fields |
| --- | --- | --- |
| `guard.resolved` | `packages/kernel/src/guard/resolver.ts:268`-`:277` | `mode`, `source: "request"\|"settings"`, `judge_configured`, `human_channel` (+ `run_id`, `owner` from the child binding at `:231`) |
| `guard.decision` | `packages/kernel/src/guard/resolver.ts:124`-`:138` | `verdict`, `matched`, `mode`, `tool`, `reason?`, `escalate?`, `command_digest?` |
| `guard.elicit.answered` | `packages/kernel/src/guard/resolver.ts:148`-`:162` | `answer: "allow"\|"allow_session"\|"deny"`, `answerer: "human"\|"judge"\|"session_allowlist"` |
| `guard.escalation.no_channel` (**warn**) | `packages/kernel/src/guard/resolver.ts:201`-`:207` | `run_id` |

`command_digest` is the first 16 hex characters of the command's SHA-256
(`packages/kernel/src/guard/shell-guard.ts:213`-`:217`); it is absent when the call carries no
non-empty `command` string, "because … an empty digest field would read as 'the empty command'"
(`packages/kernel/src/guard/shell-guard.ts:210`-`:212`).

The whole channel is gated by the environment default `CLARVIS_LOG_AUDIT` (`packages/capability/src/env.ts:198`,
`boolFromEnv(true)`). `createAuditLogger(root, enabled)`
(`packages/kernel/src/component-loggers.ts:102`-`:106`) returns `NOOP_LOGGER` whenever `enabled` is
`false` or `root` is `undefined`/`silent`, and otherwise binds `{ component: "audit", audit: true }`
pinned at `info` (`packages/kernel/src/component-loggers.ts:82`-`:106`); `packages/kernel/src/file-kernel.ts:360` is the
production call site. So a host operator flipping `CLARVIS_LOG_AUDIT` off silently loses every event
in the table above, with no trace of the omission. Pinned:
`packages/kernel/tests/unit/guard-audit.test.ts:332` ("is silent when CLARVIS_LOG_AUDIT is off") and
`:337` ("stamps audit: true on every record").

### 3.8 The default guard-judge policy

`DEFAULT_GUARD_JUDGE_PROMPT` (`packages/code/src/adapters/guard-judge-prompt.ts:5`-`:28`) is the
operative policy any workspace gets under `guard_mode: "auto"` with no custom `guard-judge.md`; when
`code` resolves it as the fallback (§4.11), it reaches the judge model verbatim as the `system`
message (§3.4; `packages/kernel/src/guard/judge.ts:180`). Its three decision categories:

- **`allow`** — "reading or listing files, builds, tests, linters, formatters, type checkers,
  version-control queries (status/diff/log), and other routine development commands with no effect
  outside the project" (`packages/code/src/adapters/guard-judge-prompt.ts:15`-`:17`).
- **`deny`** — "exfiltrating data or secrets, reading credential stores, downloading-and-executing
  content, installing software system-wide, changing system configuration, force-pushing or
  rewriting published history, or destructive deletion beyond obvious scratch files"
  (`packages/code/src/adapters/guard-judge-prompt.ts:18`-`:21`).
- **`unsure`** — "anything you cannot confidently place above, including every command with
  undecidable dynamic expansions … escalates to a human; when in doubt, prefer it over 'allow'"
  (`packages/code/src/adapters/guard-judge-prompt.ts:22`-`:24`).

The prompt states that the denylist is already enforced and that ordinary sandboxed commands also
have a workspace boundary. It names `host_vcs` as the explicit exception: the judge must assess its
exact executable, argv, paths, credentials, and host-side effects rather than assuming sandbox
containment. Production: `packages/code/src/adapters/guard-judge-prompt.ts`
(`DEFAULT_GUARD_JUDGE_PROMPT`). Test:
`packages/code/tests/integration/guard-judge-prompt.test.ts`.

---

## 4. Behavior

### 4.1 Where the guard is consulted

`dispatch` (`packages/tools/src/core.ts:226`-`:266`) runs, in order:

1. tool lookup → `not_found` (`packages/tools/src/core.ts:233`-`:236`);
2. `structuredClone` + AJV validation of the arguments → `invalid_input`
   (`packages/tools/src/core.ts:238`-`:243`);
3. the skill-package mutation boundary (`packages/tools/src/core.ts:245`-`:249`);
4. **`applyGuard(name, filled, config)`** (`packages/tools/src/core.ts:251`-`:252`);
5. the handler (`packages/tools/src/core.ts:254`-`:265`).

So the guard sees **defaulted, schema-valid arguments**, never the raw ones, and the handler is
never entered when the gate returns a result.

`applyGuard` itself (`packages/tools/src/core.ts:156`-`:205`):

| Condition | Result | Line |
| --- | --- | --- |
| `config.guard` absent | proceed with `{}`, except `host_vcs`, which is denied because it requires command review | `:161`-`:164` |
| `verdict === "allow"` | proceed, carrying review metadata when the policy named a mode | `:169`-`:174` |
| `verdict === "deny"` | `ToolError("denied", reason)` plus review metadata | `:175`-`:180` |
| `verdict === "ask"`, no `config.elicit` | `ToolError("denied", reason)` with answerer `unavailable` | `:181`-`:185` |
| `verdict === "ask"`, elicit approves | proceed, carrying the answerer in review metadata | `:193`-`:197` |
| `verdict === "ask"`, elicit declines | `ToolError("denied", "command review did not approve: ...")` | `:193`-`:201` |
| guard or elicit **throws** | `errorResult(err)` — fail closed | `:202`-`:204` |

`reason` defaults to the literal `"blocked by guard"` (`packages/tools/src/core.ts:175`). The `ElicitRequest` handed
on carries `tool`, `args`, `reason`, `ctx.shell` and `escalate` when the decision set it
(`packages/tools/src/core.ts:186`-`:192`). All of these are pinned in
`packages/tools/tests/integration/guard-dispatch.test.ts` by the allow, deny, no-elicit, and
"resolves an ask through the elicit handler" cases.

### 4.2 Building the context

`buildGuardContext` (`packages/tools/src/guard/context.ts:66`-`:119`) reads a different arg shape per
tool family, and an unrecognized tool yields no paths and no shell facts (`:114`-`:118`):

| Family | Members | Extraction | Line |
| --- | --- | --- | --- |
| guarded host fallback | `host_vcs` | render `program` plus each string argv member with display-safe quoting into `args.command`, analyze that display command, and resolve `args.cwd` with plain fs semantics | `packages/tools/src/guard/context.ts` |
| command tools | `shell`, `monitor_start` | `analyzeShell(args.command)`, each path occurrence resolved with **shell semantics** (tilde expansion) against workspace, every configured temporary root (product run scratch plus system compatibility roots), and exact host-selected skill roots; an absolute command head beneath a platform system executable root or configured runtime root is admitted only for that segment occurrence and normalized to its basename for allow/deny matching, with Windows `PATHEXT` suffixes removed; duplicate absolute operands remain outside even when their string equals an admitted head; when a sandbox is configured, an existing verified spill is admitted as that exact read-only-mounted file; unsandboxed commands do not receive the spill exception; `args.cwd` is added with plain fs semantics against the same roots | `packages/tools/src/guard/context.ts` (`commandPathOccurrences`, `externalExecutableHeads`, `normalizeExternalExecutables`), `packages/tools/src/lib/state-artifacts.ts`, `packages/tools/src/lib/system-executables.ts`, `packages/loop/src/runtime/capabilities/tools.ts` |
| patch | `apply_patch` | `patchPaths(args.patch)` — raw unified `---`/`+++` plus model-envelope Update/Add/Delete/Move headers, `/dev/null` dropped, `a/`/`b/` prefixes stripped, deduped first-seen | `packages/tools/src/guard/context.ts`, `packages/tools/src/guard/paths.ts` |
| src/dest | `move`, `copy` | `args.source`, `args.destination` | `:23`, `:66`-`:68` |
| list | `read_files` | every string in `args.paths` | `:69`-`:74` |
| pair | `diff` | `args.from`, `args.to` | `:75`-`:77` |
| scoped | `replace` | `args.path` if a non-empty string, else `"."` | `:78`-`:80` |
| single path | `read_file`, `write_file`, `edit_file`, `multi_edit`, `read_image`, `list_dir`, `glob`, `grep`, `file_stat`, `tree`, `mkdir`, `remove` | `args.path` | `:9`-`:22`, `:81`-`:83` |

`resolveCandidate` (`packages/tools/src/guard/paths.ts:46`-`:60`) resolves the token twice: once normally for
`resolved`, once in confining mode inside a `try`, and a throw becomes `withinWorkspace: false`
(`:53`-`:58`). Shell-semantics resolution first expands a leading `~`/`~/` (and `~\` on Windows) to
the real home directory (`packages/tools/src/guard/paths.ts:21`-`:28`) — which is why `cat ~/.ssh/id_rsa` reports as
escaping (`packages/tools/tests/unit/guard-context.test.ts:26`-`:29`) while a literal `path: "~"`
arg on `read_file` stays inside (`:48`-`:50`).

### 4.3 The analyzer driver

`analyzeShell` (`packages/tools/src/guard/analyze-shell.ts:39`-`:76`) owns everything invariant and
delegates everything syntactic:

1. `dialect.split(command)` → `{ segments, balanced }` (`:43`).
2. For each source segment: `dialect.tokenize` → `dialect.normalize(tokens.map(t => t.text))` →
   push a `Segment` with `decidable: dialect.decidable(source)` (`:51`-`:59`).
3. For each token: `dialect.pathCandidate(token)`. `opaque` sets `tokenUndecidable` and
   contributes **no** path; `none` contributes nothing; otherwise the value is pushed once,
   deduplicated by a `Set`, first-seen order (`:60`-`:70`).
4. `undecidable = !balanced || tokenUndecidable || emptySegment || some(!decidable)`
   (`:73`-`:75`), where `emptySegment` means some segment reduced to `argv.length === 0`.

The `emptySegment` term is the one with a stated reason: the guard matches its deny list against
`normalized` **before** consulting `undecidable`, so a tokenizer that came up empty would produce a
`normalized` no deny entry can match — "Degrading `allow` to `ask` is acceptable; degrading `deny`
to `ask` is not" (`packages/tools/src/guard/analyze-shell.ts:36`-`:37`). Pinned generically over a stub dialect and
specifically over POSIX at `packages/tools/tests/unit/shell-dialect.test.ts:50`-`:87`, and against
a `["*"]` allow list at `packages/kernel/tests/unit/guard.test.ts:117`-`:130`.

The driver carrying no dialect syntax is itself pinned with a deliberately ignorant stub dialect
(`packages/tools/tests/unit/shell-dialect.test.ts:10`-`:47`).

### 4.4 Dialect selection

`currentDialect(platform?)` = `dialectFor(currentShellFlavor(platform))`
(`packages/tools/src/guard/dialects/index.ts:29`-`:31`); `currentShellFlavor` returns
`"powershell"` on `win32` and `"posix"` elsewhere (`packages/tools/src/lib/platform.ts:28`-`:30`).
The same function selects the executor's shell (`packages/tools/src/tools/shell.ts:131`,
`packages/tools/src/shell.ts:1`), which is what makes "analyze one dialect, run another"
unrepresentable rather than merely discouraged (`packages/tools/src/guard/dialects/index.ts:24`-`:27`,
`packages/tools/src/lib/platform.ts:21`-`:23`). Pinned at
`packages/tools/tests/unit/powershell-dialect.test.ts:14`-`:23`.

#### POSIX (`packages/tools/src/guard/dialects/posix.ts`)

| Concern | Rule | Line |
| --- | --- | --- |
| split | `&&`, `\|\|`, `;`, `\|`, `&`, newline at depth 0; never inside quotes/backticks/parens; a redirect `&` (`&>` or after `>`) does not split | `:279`-`:365`, `:262`-`:264` |
| balanced | no open single/double quote, backtick, or paren | `:363` |
| tokenize | quote-aware; backtick spans and `$( )`/`<( )`/`>( )` consumed and dropped; `glob` set only for unquoted `*?[]{}` | `:194`-`:255`, `:111` |
| decidable | after `scrubExpansions` (single-quoted spans removed, double-quoted kept) no pattern in `UNDECIDABLE_PATTERNS` matches, and quotes balanced | `:454`-`:457`, `:156`-`:181` |
| undecidable patterns | `$(`, `` ` ``, `${`/`$NAME`, and the command words `eval`, `exec`, `source`, `env`, `xargs`, `base64`, `sh -c`, `bash -c`, `<(`, `>(` | `:29`-`:43` |
| command-word boundary | `(?:^\|[\s(){};&\|])(?:\S*/)?NAME(?:\s\|$)` — punctuation, not only whitespace | `:23`-`:26` |
| normalize | strip leading `NAME=value` assignments (recorded), then `timeout\|time\|nice\|nohup\|stdbuf` with their options and `timeout`'s duration, repeatedly | `:381`-`:408`, `:116`-`:118` |
| pathCandidate | strip `[0-9&]*(>>?\|<)` redirect prefix; `~user` → opaque; glob with `..` → opaque; glob → literal directory prefix; else the `looksLikePath` heuristic | `:424`-`:439`, `:126`-`:147` |

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

The boundary regex has a documented failure it exists to prevent: a bare `\benv\b` matched the
`env` inside `.env`, "which was merely noisy while undecidable meant `ask`, and becomes a wrong
refusal now that an unanalyzable command with a deny list configured is denied"
(`packages/tools/src/guard/dialects/posix.ts:11`-`:14`). Both halves are pinned: filenames that merely contain a command name stay
decidable (`packages/tools/tests/unit/posix-dialect.test.ts:203`-`:218`), and the command itself —
including inside a subshell, where `(` is the preceding character — stays undecidable
(`:220`-`:243`).

`looksLikePath` (`packages/tools/src/guard/dialects/posix.ts:133`-`:145`) is the fallback rule that decides whether a bare token
becomes a `PathFact` at all, gating every downstream path check (outside-workspace,
credential-file): `false` for an empty token, one starting with `-`, or one containing
`PATH_METACHARS` (`packages/tools/src/guard/dialects/posix.ts:110`); otherwise `true` for a token containing `/`, one starting with
`~` or `.`, or one shaped like a bare `name.ext`; `false` for everything else.

Four omissions from the default allow list are stated in the constant's own docs: `make` ("arbitrary
execution wearing a build command's name"), `find` and `awk` ("execute code the analyzer cannot
see"), and `sed -n` ("only looks read-only … The protection was accidental")
(`packages/tools/src/guard/dialects/posix.ts:60`-`:70`), and re-added regressions fail at
`packages/tools/tests/unit/posix-dialect.test.ts:186`-`:192`.

#### PowerShell (`packages/tools/src/guard/dialects/powershell.ts`)

| Concern | Rule | Line |
| --- | --- | --- |
| split | `;`, newline, `\|`, `\|\|`, `&&` at paren/brace depth 0; never inside quotes, here-strings, `( )` or `{ }`; `&` is **never** a separator; a trailing backtick continues the line; `#` line comments and `<# #>` blocks are dropped | `:336`-`:514` |
| `#` comment start | only when preceded by start-of-input or whitespace — otherwise `file#1.txt` would yield a phantom segment (`git status # note; rm -rf x`) | `:303`-`:316` |
| tokenize | backtick = **escape**, not substitution; `''` and `""` escape a quote inside their span; `$( )`, `@( )`, `${ }` and here-strings consumed | `:530`-`:650` |
| decidable | balanced, no call/dot-source operator in command position, no `UNDECIDABLE_PATTERNS` match, and no `$var` outside the inert set | `:242`-`:251` |
| inert variables | `$_`, `$null`, `$true`, `$false`, `$args`, `$psitem` — every other `$name` makes the segment undecidable | `:9`, `:247`-`:249` |
| undecidable patterns | 30 case-insensitive entries incl. `Invoke-Expression`/`iex`, `New-Object`, `[scriptblock]`, `powershell`/`pwsh`, `cmd`/`wsl`/`bash`/`sh`/`zsh`, `.ps1`, `Start-Process`, `Invoke-WebRequest`, `DownloadString`, `FromBase64String`, `Set/New-Alias`, `function `, `--%`, `<#` | `:24`-`:55` |
| normalize | canonicalize **`argv[0]` only** through the alias table, case-insensitively; no env assignments to strip | `:735`-`:738`, `:119`-`:162` |
| pathCandidate | strip `(\d\|\*)?>>?(&\d)?`; `~x` (not `~/`, `~\`) → opaque; provider-qualified (`Env:`, `HKLM:`) and drive-relative (`C:`, `C:foo`) → opaque; glob with `..` → opaque; glob → prefix (stopping at a drive root); else `looksLikePath` incl. `C:\`, `\\server\share` | `:689`-`:707`, `:656`-`:675` |

The backtick asymmetry is the design's stated load-bearing point — "A single grammar covering both
shells is unsound, because the same characters carry opposite meanings"
(`packages/tools/src/guard/dialect.ts:41`-`:47`) — and is pinned side by side against the POSIX
tokenizer at `packages/tools/tests/unit/powershell-dialect.test.ts:117`-`:126`. Aliases are
canonicalized so a deny entry written either way bites
(`packages/tools/tests/unit/powershell-dialect.test.ts:281`-`:296`); the deliberately *un*-aliased
`curl`/`wget`/`where`/`sort` are pinned at `:303`-`:309` with the stated reason that they are
version-dependent (`packages/tools/src/guard/dialects/powershell.ts:128`-`:132`).

PowerShell's `looksLikePath` (`packages/tools/src/guard/dialects/powershell.ts:684`-`:693`) is the same fallback rule, over the same
`PATH_METACHARS` idea (`packages/tools/src/guard/dialects/powershell.ts:281`): `false` for an empty token, one starting with `-`, or
one matching the dialect's own metacharacter set; `true` for a drive-absolute (`C:\`) or UNC
(`\\server\share`) token, one containing `\` or `/`, one starting with `~` or `.`, or a bare
`name.ext` shape; `false` otherwise. It is reached only after the provider-qualified/drive-relative
and glob checks above have already classified the token, so it sees only a plain bare word.

### 4.5 The rule cascade (`createShellGuard`)

Evaluated top-down; the first match returns (`packages/kernel/src/guard/shell-guard.ts:250`-`:327`):

| # | Condition | `matched` | Verdict | Line |
| --- | --- | --- | --- | --- |
| 1 | `shell` present, deny list configured, **any** segment's `normalized` matches | `deny_list` | `deny` | `:251`-`:257` |
| 2a | `shell.undecidable` and deny list **non-empty** | `undecidable` | `deny` | `:258`-`:267` |
| 2b | `shell.undecidable` and no/empty deny list | `undecidable` | `ask` + `escalate: "human"` | `:268`-`:273` |
| 3 | `tool === "host_vcs"` | `host_command` | `ask`; the configured human or judge answers | `:275`-`:280` |
| 4 | `touchesOutside(ctx)` — some resolved path escapes | `outside_workspace` | `deny` | `:282`-`:287` |
| 5 | some path's `raw` matches a credential pattern and no exception | `credential_file` | `ask` | `:289`-`:295` |
| 6 | `ctx.shell === undefined` (a non-command tool) | `non_bash` | `allow` | `:297`-`:299` |
| 7 | allow list configured and **every** segment matches | `allow_list` | `allow` | `:300`-`:302` |
| 8 | `!withinWorkspace(ctx)` — i.e. no resolved paths at all | `outside_workspace` | `ask` | `:303`-`:318` |
| 9 | otherwise | `default` | `ask` | `:320`-`:327` |

Every adjacent-pair ordering is pinned individually, with the test file stating the method: "Each
case below is chosen so that exactly one swap of adjacent rules would change its verdict"
(`packages/kernel/tests/unit/guard.test.ts:132`-`:135`, cases at `:136`, `:149`, `:162`, `:174`).

Notes the code states about specific rules:

- **Rule 2a's non-empty test** exists because `denied_commands: []` means "deny nothing", and
  reading it as "a deny list exists" would make `git commit -m "$MSG"` an unappealable refusal
  (`packages/kernel/src/guard/shell-guard.ts:240`-`:244`); pinned at `packages/kernel/tests/unit/guard.test.ts:837`-`:850`.
- **Rule 5 outranks rule 7** so no allow-list entry can wave `cat .env` through — "`cat` is exactly
  the sort of entry a starter allow list contains" (`packages/kernel/src/guard/shell-guard.ts:235`-`:238`); pinned at
  `packages/kernel/tests/unit/guard.test.ts:916`-`:926`. Its verdict is `ask`, not `deny`, because
  such files "sit *inside* the workspace as often as not … Reading them is frequently legitimate"
  (`packages/kernel/src/guard/shell-guard.ts:85`-`:90`).
- **Rule 8's reason string** is `"the paths this command touches could not be determined"`, chosen
  after the previous wording asserted an escape for `whoami` "and the model read that as fact and
  invented explanations from it" (`packages/kernel/src/guard/shell-guard.ts:303`-`:318`).
- **`commandDenied` matches `normalized` only.** Matching the raw segment text too "was tried and
  removed … It added false-positive surface and caught nothing"; the substitution case is instead
  handled by rule 2a (`packages/kernel/src/guard/shell-guard.ts:191`-`:200`).
- **Rule 9's reason has two variants.** `"no allowed commands list configured"` when `allowed`
  is `undefined` (no `allowed_commands` in settings at all), versus `"command not in the allowed
  commands list"` when an allow list exists but the command's segments did not fully match it
  (`packages/kernel/src/guard/shell-guard.ts:320`-`:327`). §3.4's example JSON uses the first string without stating which
  condition produces it.
- **Neither `commandsAllowed` nor `commandDenied` inspects `Segment.envAssignments`** — both match
  only `normalized`, which is already env-assignment-stripped (§3.1, invariant 7). So an allow-list
  entry like `git status` is satisfied by `LD_PRELOAD=/evil.so git status` as readily as by the bare
  command; nothing in `shell-guard.ts` re-checks the stripped prefix against the list
  (`packages/kernel/src/guard/shell-guard.ts:176`-`:179`, `:198`-`:199`). This is the same normalization that lets the *session*
  allow-list key include `envAssignments` (§3.6) — the settings-configured allow/deny lists do not.

Credential patterns (`packages/kernel/src/guard/shell-guard.ts:107`-`:119`): `.env` (with a following `.` or end), `*.pem`,
`*.key`, `id_rsa`, `id_ed25519`, `.npmrc`, `.netrc`, `.git-credentials`, `.aws/credentials`,
`.ssh/`, `keys.json`. The one exception set is `.env.example|sample|template`
(`packages/kernel/src/guard/shell-guard.ts:128`), because "Prompting for `.env.example` is how a guard teaches the answer
'approve'" (`:109`-`:111`). Matching is against `PathFact.raw`, not `resolved`
(`packages/kernel/src/guard/shell-guard.ts:137`).

Whatever it returns, the guard reports the ruling to `onDecision` before returning it, and stays a
pure `GuardDecision` when no observer is supplied (`packages/kernel/src/guard/shell-guard.ts:329`-`:340`; pinned at
`packages/kernel/tests/unit/guard-audit.test.ts:149`-`:156`). A throw from the observer "propagates
to the caller rather than being swallowed into a silent approval" (`packages/kernel/src/guard/shell-guard.ts:74`-`:77`).

### 4.6 Resolving a run's guard

`createGuardResolver` creates **one** session allow list up front, shared by every run it resolves
(`packages/kernel/src/guard/resolver.ts:226`). Per run (`:228`-`:303`):

1. `settings = deps.loadSettings()` — re-read every time (`:229`, contract at `:35`).
2. `guardMode = ctx.request.guard_mode ?? defaultGuardMode(settings.guard)`
   (`:230`, `resolveGuardMode` at `:59`-`:64`).
3. `audit = auditRoot.child({ run_id: ctx.executionId, owner: ctx.owner })` (`:231`).
4. `buildGuard` returns `undefined` for mode `off` (`:97`-`:112`) → the resolver returns
   `undefined` and the run is unguarded (`:235`).
5. `humanElicit` = `createGuardElicit(ctx.elicit, …)` only when the run has an elicit channel
   (`:236`-`:243`).
6. `judgeElicit` = `createJudgeElicit(…)` only when `guardMode === "auto"` **and**
   `ctx.request.guard_judge !== undefined` (`:244`-`:259`). The judge's model falls back to
   `settings.defaultModel`, then `ctx.env.CLARVIS_DEFAULT_MODEL` (`:250`-`:252`).
7. `chosenHuman` = `humanElicit` for `on`, and for `auto` only when no judge resolved. A resolved
   judge returns both `allowed` and the final `answerer`, so an internal human fallback is audited
   as human rather than judge.
8. Emit `guard.resolved` (`:268`-`:277`).

| (mode, judge param, judge model resolves, human channel) | `guard` | answering channel |
| --- | --- | --- |
| `off`, * | `undefined` | none (unguarded) |
| `on`, *, *, yes | built | human |
| `on`, *, *, no | built | none — every `ask` fails closed |
| `auto`, absent, *, yes | built | human (`packages/kernel/src/guard/resolver.ts:264`; test `packages/kernel/tests/unit/guard.test.ts:754`) |
| `auto`, present, no, yes | built | human (`packages/kernel/tests/unit/guard.test.ts:737`) |
| `auto`, present, yes, yes | built | judge for `allow`/`deny`; human for `unsure`, judge failure, or malformed response |
| `auto`, present, yes, no | built | judge; an `escalate:"human"` ask denies with a warn (`packages/kernel/tests/unit/guard-audit.test.ts:273`) |

### 4.7 Answering an `ask`

The composed elicit (`packages/kernel/src/guard/resolver.ts:288`-`:302`):

| Event | Effect | Line |
| --- | --- | --- |
| `req.escalate === "human"`, human channel exists | route to the human, bypassing both automatic answerers | `:291`-`:293` |
| `req.escalate === "human"`, no human channel | `noHumanChannel` → warn `guard.escalation.no_channel`, return `false` | `:292`, `:201`-`:207` |
| session allow list already `covers(req.shell)` | record `answerer: "session_allowlist"`, return `true` **without** consulting the judge or the human | `:296`-`:299` |
| judge exists | call it and record the returned final `answerer`; a judge fallback is attributed to `human` | `createGuardResolver` |
| no judge, human fallback exists | call the human and record `answerer: "human"` | `createGuardResolver` |

`answered` reads the allow list before and after so it can distinguish `allow_session` from `allow`
without the elicit bridge reporting it (`:176`-`:188`).

`createGuardElicit`'s own mapping (`packages/kernel/src/guard/guard-elicit.ts:165`-`:176`):

| Elicitation result | Returns | Side effect |
| --- | --- | --- |
| `action !== "accept"` (decline / cancel) | `false` | none |
| `accept` + `decision: "allow"` | `true` | none |
| `accept` + `decision: "allow_session"` **and** the option was offered | `true` | `allowlist.record(shell)` |
| `accept` + `decision: "allow_session"` when it was **not** offered | `false` | none (`packages/kernel/tests/unit/guard.test.ts:330`-`:342`) |
| anything else | `false` | none |

The prompt waits `ELICIT_NO_TIMEOUT_MS = 2_147_483_647` ms unless the run's signal aborts
(`packages/kernel/src/guard/guard-elicit.ts:27`, `:147`-`:150`) — the wait bound that actually applies is imposed one layer
up, in the loop (§4.8).

### 4.8 The engine's wiring

`createAgentToolsCapability` (`packages/loop/src/runtime/capabilities/tools.ts:127`):

1. `forRun` returns `null` unless `ctx.env.CLARVIS_AGENT_TOOLS_ENABLED` (`:130`-`:131`) — no toolset, no
   guard.
2. `await opts?.resolveGuard?.(ctx)` — **once per run** (`:132`).
3. `elicitWaitMs = ctx.request.elicit_wait_ms ?? ctx.env.CLARVIS_DEFAULT_ELICIT_WAIT_MS`
   (`:174`; env default 1,800,000 ms at `packages/capability/src/env.ts:68`).
4. `forAgent` computes the grant ceiling and returns `null` for an agent that cannot even read
   (`:205`-`:207`); otherwise it wraps the elicit with `withGuardElicitWaitBound(…, scope.signal)`
   (`:208`-`:211`) and passes `guard` + `elicit` into `createAgentToolset` (`:212`-`:223`).

`withGuardElicitWaitBound` (`:89`-`:115`) resolves `true` only on an explicit approval; a timeout,
an abort and a rejection all resolve `false`. `waitMs` is treated as a real bound whenever it is
`>= 0 && Number.isFinite` — so `0` denies on the next macrotask rather than waiting forever, which
the code calls out as the documented meaning of `elicit_wait_ms` and "the worst place" for
unbounded blocking (`:97`-`:101`). Only a non-finite value is unbounded. Every branch is pinned at
`packages/loop/tests/unit/guard-elicit-bound.test.ts:15`-`:98`, including the `waitMs: 0` case
(`:66`) and the "arms no timer only for a non-finite bound" case (`:72`). A resolution of the
underlying, unbounded elicit call that lands *after* the bound has already denied is silently
discarded rather than racing or double-firing (`:89`).

Because the guard is resolved per **run** and threaded into every agent's toolset, it applies to
lead-spawned subagents too (`packages/loop/tests/integration/command-guard-wiring.test.ts:211`-`:272`).

### 4.9 The judge

`createJudgeElicit` (`packages/kernel/src/guard/judge.ts:153`):

- **Construction.** No model token (neither `cfg.model` nor `deps.defaultModel`) → `warn` +
  `undefined` (`:158`-`:165`). An unresolvable provider → `warn` + `undefined` (`:166`-`:174`).
  Both warnings end with the literal `"— degrading to mode 'on'"`.
- **Per call.** Memoized by `memoKey` — the normalized segments joined by `" && "`, or
  `JSON.stringify({tool,args})` for a call with no segments (`:88`-`:94`, `:224`-`:226`).

State table for one `judgeOnce` (`:178`-`:221`):

| Outcome | Returns | Memoized? | Line |
| --- | --- | --- | --- |
| `llm.call` throws, human fallback permitted/present | human answer, `answerer:"human"` | **no** (`clean:false`) | `createJudgeElicit` |
| `llm.call` throws, no permitted human fallback | deny, `answerer:"judge"` | **no** | `createJudgeElicit` |
| `decide` → `allow` | allow, `answerer:"judge"` | yes | `createJudgeElicit` |
| `decide` → `deny` | deny, `answerer:"judge"` | yes | `createJudgeElicit` |
| unparsable / wrong tool / schema mismatch, human fallback permitted/present | human answer, `answerer:"human"` | **no** | `createJudgeElicit` |
| unparsable / wrong tool / schema mismatch, no permitted human fallback | deny, `answerer:"judge"` | **no** | `createJudgeElicit` |
| `unsure`, `on_unsure !== "deny"`, human channel present | human answer, `answerer:"human"` | yes | `createJudgeElicit` |
| `unsure`, otherwise | deny, `answerer:"judge"` | yes | `createJudgeElicit` |
| the escalated human elicit **rejects** | rethrows | **evicted** | `:232`-`:235` |

An `unsure` escalation appends `"The automated reviewer was unsure and escalated this to you"` plus
the judge's own reason to the request's existing reason (`:213`-`:217`); pinned at
`packages/kernel/tests/unit/guard.test.ts:481`-`:539`.

The judge call uses `cfg.timeout_ms ?? 20_000` (`:192`, constant at `:14`) and forwards the run's
abort signal (`:193`).

When the resolved provider kind is `openai-codex`, `AiSdkAdapter.call` streams even though the judge
does not install `onStreamDelta`; ChatGPT's pinned Codex Responses endpoint rejects non-streaming
requests. Production: `providerRequiresStream` in `packages/llm/src/ai-sdk-adapter.ts`. Test:
`packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts` (`"streams ChatGPT subscription
calls even without a delta consumer"`).

### 4.10 Prompt-cache TTL side effect

`guardParksOnHuman(param, guard, judgeConfigured)` returns `true` for mode `on`, and for mode `auto`
with no judge configured (`packages/kernel/src/guard/resolver.ts:80`-`:87`). The run assembler uses
it to derive `prompt_cache_ttl: "1h"` when the caller named none
(`packages/kernel/src/runs/settings-assembler.ts:471-478`), pinned across the whole truth table
at `packages/kernel/tests/component/settings-assembler.test.ts:544`-`:582`. The reason is stated in
the function's own docs: such runs "park repeatedly mid-conversation … the loop cannot derive this
itself because guard mode is resolved from host settings it never sees"
(`packages/kernel/src/guard/resolver.ts:75`-`:79`). The economics belong to [prompt-cache-and-prefix-stability](../cross-cutting/prompt-cache.md).

### 4.11 `code`'s surface

- **Session mode** lives in a signal seeded from `code.json`'s `guard.mode`, else the settings-
  derived default (`packages/code/src/adapters/guard-mode.ts:44`-`:49`,
  `packages/code/src/adapters/code-config.ts:203`-`:206`). `cycle()` walks `off → on → auto → off`
  (`packages/code/src/adapters/guard-mode.ts:8`, `:51`-`:54`; pinned at `packages/code/tests/unit/guard-mode.test.ts:54`).
- **`Alt`-cycled** through the `guard.cycle` action (`packages/code/src/app/commands.tsx:481`-`:488`),
  which notifies `guard: <mode> (this session)` and warns when `auto` will degrade
  (`packages/code/src/views/App.tsx:619`-`:623`, `:585`-`:592`).
- **Run Controls** writes the block to `settings.json` and *pre-degrades*: choosing `auto` without a
  usable `default_model` persists `"on"` and says so
  (`packages/code/src/views/config/RunControlsPanel.tsx`, `applyGuard`). Its source column reads
  `"session"` whenever the session mode differs from the persisted one
  (`packages/code/src/views/config/RunControlsPanel.tsx`, `guardSource`). Both direct guard-mode changes
  and named safety presets preserve the effective `allowed_commands`/`denied_commands` through
  `guardPolicyForWrite`; a workspace write carries forward a global policy when the workspace has no
  list of its own (`packages/code/src/views/config/RunControlsPanel.tsx`). Pinned by
  `packages/code/tests/integration/run-controls-render.test.tsx` (guard-mode merge, reviewed preset,
  and workspace-inherits-global cases).
- **Judge prompt** resolution is workspace `guard-judge.md` → global → built-in, with a blank or
  unreadable file treated as absent (`packages/code/src/adapters/guard-judge-prompt.ts:81`-`:87`,
  `:39`-`:61`) and a >1 MiB file rejected without reading its body (`:37`, `:45`); pinned at
  `packages/code/tests/integration/guard-judge-prompt.test.ts:25`-`:61`. The prompt is sent only
  when the mode is `auto` (`packages/code/src/runtime.tsx`, `judgePayloadFor`). `judgePayloadFor`
  (called by `buildRunHost` in `packages/code/src/runtime.tsx`) is the only production path that attaches `guard_judge` to a
  run request, and its return type is `{ guardJudge?: { prompt: string } }`
  (`packages/code/src/run-host.ts:82`) — it never sets `model`, `on_unsure` or `timeout_ms`, even
  though `toStartParams` forwards all three when present (`packages/code/src/adapters/kernel-run-client.ts:135`-`:142`)
  and `GuardJudgeInput` declares them (`packages/code/src/adapters/run-types.ts:24`-`:29`). Through
  `code`, the judge therefore always falls back to `settings.defaultModel`/`CLARVIS_DEFAULT_MODEL`
  (§4.6) and `on_unsure`'s omitted-field behavior (§2.5, invariant 43); the wider fields are wired
  end-to-end but dead on this client's path.
- **Safety presets** classify the sandbox/guard pair: `free`, `approval`, `isolated`, `reviewed`,
  `protected`, else `custom` (`packages/code/src/adapters/execution-safety.ts:121`-`:134`), with the
  canonical write-back at `:222`-`:239`. The guard-mode half of that mapping:
  `free`/`approval` → `off`/`on` with the sandbox disabled; `isolated`/`reviewed`/`protected` →
  `off`/`auto`/`on` with the sandbox enabled (`packages/code/src/adapters/execution-safety.ts:129`-`:133`, `:218`-`:219`). The
  sandbox half belongs to [sandbox-and-toolchains](sandbox.md).

---

## 5. Invariants

Numbered, declarative, falsifiable. "Unpinned" means no test was found that fails if the rule is
broken.

1. **An undecidable command is never workspace-confined.** `withinWorkspace` returns `false`
   whenever `ctx.shell.undecidable` is set, before looking at any path.
   `packages/tools/src/guard/helpers.ts:15`. Pinned:
   `packages/tools/tests/unit/guard-helpers.test.ts:27`-`:29`.

2. **`withinWorkspace` and `touchesOutside` are not negations.** A call with no resolved paths (or
   an undecidable one) makes both `false`. `packages/tools/src/guard/helpers.ts:16`, `:30`. Pinned:
   `packages/tools/tests/unit/guard-helpers.test.ts:21`-`:37`.

3. **A dialect that reports a token `opaque` contributes no path *and* forces the whole command
   undecidable.** `packages/tools/src/guard/analyze-shell.ts:62`-`:65`. Pinned generically over a
   stub dialect: `packages/tools/tests/unit/shell-dialect.test.ts:33`-`:38`.

4. **A segment whose `argv` is empty makes the command undecidable.** Since `split` drops
   whitespace-only segments, this means exactly "source text existed and the front end produced no
   command". `packages/tools/src/guard/analyze-shell.ts:73`-`:75`. Pinned:
   `packages/tools/tests/unit/shell-dialect.test.ts:60`-`:87` and, as a policy consequence under a
   `["*"]` allow list, `packages/kernel/tests/unit/guard.test.ts:117`-`:130`.

5. **`analyzeShell` deduplicates paths across segments, preserving first-seen order.**
   `packages/tools/src/guard/analyze-shell.ts:47`, `:67`-`:69`. Pinned:
   `packages/tools/tests/unit/shell-dialect.test.ts:40`-`:47`.

6. **The analyzer dialect and the executor shell derive from one `currentShellFlavor` call.**
   `packages/tools/src/guard/dialects/index.ts:30`, `packages/tools/src/shell.ts:53` and
   `packages/tools/src/tools/shell.ts:131`, all three reading `packages/tools/src/lib/platform.ts:28`.
   Pinned: `packages/tools/tests/unit/powershell-dialect.test.ts:14`-`:23` pins the
   platform→dialect mapping, and
   `packages/tools/tests/architecture/one-shell-flavor.test.ts:97`-`:105` pins the executor half —
   for each of `win32`, `linux`, `darwin` and `freebsd` it asserts that
   `currentDialect(platform).flavor` and `resolveShell({platform, …}).flavor` both equal
   `currentShellFlavor(platform)`. The same file's scan (`:87`-`:89`) makes the disagreement
   unrepresentable rather than merely absent today: no `src` module but `src/lib/platform.ts` may
   turn a platform into a shell flavor at all.

7. **Every env-assignment prefix stripped from a segment is recorded, never discarded.**
   `packages/tools/src/guard/dialects/posix.ts:394`-`:420`; consumed by the session allow-list key
   at `packages/kernel/src/guard/guard-elicit.ts:58`-`:64`. Pinned:
   `packages/tools/tests/unit/posix-dialect.test.ts:79`-`:85` and
   `packages/kernel/tests/unit/guard.test.ts:316`-`:329`.

8. **A POSIX command name in `UNDECIDABLE_PATTERNS` is matched only in command position** — start
   of segment or after shell punctuation, optionally with a directory prefix — so `cat .env` stays
   decidable while `(sh -c "rm -rf /")` does not.
   `packages/tools/src/guard/dialects/posix.ts:23`-`:27`. Pinned:
   `packages/tools/tests/unit/posix-dialect.test.ts:203`-`:243`.

9. **Every alphabetic PowerShell undecidable pattern is case-insensitive; the punctuation-only
   entries carry no `/i` since case does not apply to them.**
   `packages/tools/src/guard/dialects/powershell.ts:42`-`:73` — 5 of the 30 entries (`$(`, `@(`,
   `${`, `--%`, `<#`, at `:25`-`:27`, `:53`-`:54`) are pure punctuation and carry no `/i`; the
   remaining 25 do. Pinned for the highest-value case:
   `packages/tools/tests/unit/powershell-dialect.test.ts:233` (`invoke-expression $payload`).

10. **PowerShell `normalize` rewrites `argv[0]` only.**
    `packages/tools/src/guard/dialects/powershell.ts:753`-`:756`. Pinned:
    `packages/tools/tests/unit/powershell-dialect.test.ts:293`-`:296`.

11. **PowerShell `&` is never a statement separator.**
    `packages/tools/src/guard/dialects/powershell.ts:499`-`:516` (no `&` arm). Pinned:
    `packages/tools/tests/unit/powershell-dialect.test.ts:41`-`:47`.

12. **A PowerShell `#` opens a comment only at a token boundary**, so a trailing `# … ; rm -rf x`
    cannot produce a phantom segment an operator would see in the approval prompt.
    `packages/tools/src/guard/dialects/powershell.ts:330`-`:334`. Pinned:
    `packages/tools/tests/unit/powershell-dialect.test.ts:77`-`:84`.

13. **A provider-qualified or drive-relative PowerShell token is `opaque`, never `none`.** Stated as
    a pre-empted failure mode, not an accident being fixed: reporting `none` "would let them
    contribute no `PathFact` while still looking analyzed, so a future allow-list entry would clear
    `Get-Content Env:\SECRET` on a command nothing had confined"
    (`packages/tools/src/guard/dialects/powershell.ts:695`-`:705`).
    `packages/tools/src/guard/dialects/powershell.ts:716`-`:719`. Pinned:
    `packages/tools/tests/unit/powershell-dialect.test.ts:160`-`:171`.

14. **`PathFact.withinWorkspace` is derived by re-resolving in confining mode and catching the
    throw**, never by string comparison. `packages/tools/src/guard/paths.ts:53`-`:58`. Pinned
    indirectly: `packages/tools/tests/unit/guard-context.test.ts:17`-`:24`.

15. **Command-tool path tokens are resolved with shell semantics (tilde expansion); every other
    tool's path arg is not.** `packages/tools/src/guard/context.ts:59` vs `:61`, `:64`, `:67`-`:82`.
    Pinned: `packages/tools/tests/unit/guard-context.test.ts:26`-`:29` and `:48`-`:50`.

16. **The guard runs after argument validation and before the handler.**
    `packages/tools/src/core.ts:238`-`:255`. Pinned: the handler's side effect is absent in
    `packages/tools/tests/integration/guard-dispatch.test.ts`, "denies the call and never runs the
    handler".

17. **An `ask` with no elicit channel is a denial, not an allow.**
    `packages/tools/src/core.ts:181`-`:185`. Pinned in
    `packages/tools/tests/integration/guard-dispatch.test.ts`, "denies an ask when no elicit handler
    is configured".

18. **A throw anywhere in the guard or the elicit fails closed.**
    `packages/tools/src/core.ts:202`-`:204`. Pinned in
    `packages/tools/tests/integration/guard-dispatch.test.ts`, "fails closed when the guard throws".

19. **The rule cascade's order is fixed: deny list → undecidable → guarded host-command review →
    outside-workspace → credential file → non-shell allow → allow list → unbounded-paths ask →
    default ask.**
    `packages/kernel/src/guard/shell-guard.ts:250`-`:327`. Pinned pair-by-pair:
    `packages/kernel/tests/unit/guard.test.ts:136`, `:149`, `:162`, `:174`, plus
    `packages/kernel/tests/unit/guard.test.ts:916` and `:968` for the credential-file position.

    A host-command ask deliberately carries no `escalate` field: mode `on` uses the human channel,
    while a configured mode `auto` judge can answer it. Production:
    `packages/kernel/src/guard/shell-guard.ts` (`createShellGuard`). Test:
    `packages/kernel/tests/unit/guard.test.ts` (host reviewer and auto-judge cases).

20. **The guard only ever narrows.** The sole `allow` verdicts are `non_bash` (rule 6) and
    `allow_list` (rule 7). `packages/kernel/src/guard/shell-guard.ts:232`-`:233`, `:297`-`:302`.
    Pinned by exhaustion of the `matched` vocabulary in
    `packages/kernel/tests/unit/guard-audit.test.ts:73`-`:138`.

21. **An empty `denied_commands` array never turns an unanalyzable command into a denial.**
    `packages/kernel/src/guard/shell-guard.ts:259` tests `denied.length > 0`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts:837`-`:850`.

22. **A non-empty deny list turns *any* unanalyzable command into a denial** — it is not downgraded
    to an ask that a judge or session allow list could answer.
    `packages/kernel/src/guard/shell-guard.ts:258`-`:273`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts:871`-`:881`, and as a property over six commands at
    `:893`-`:911`.

23. **An `undecidable` ask always carries `escalate: "human"`.**
    `packages/kernel/src/guard/shell-guard.ts:269`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts:883`-`:893` and
    `packages/kernel/tests/unit/guard-audit.test.ts:81`-`:88`.

24. **An `escalate: "human"` request bypasses both automatic answerers — the LLM judge and the
    session allow list.** `packages/kernel/src/guard/resolver.ts:291`-`:293` (the escalate arm
    returns before the allow-list check at `:296`). Pinned:
    `packages/kernel/tests/unit/guard-audit.test.ts:273`-`:316`.

25. **An escalated ask with no human channel denies and emits a warn record**, rather than denying
    in silence. `packages/kernel/src/guard/resolver.ts:292`, `:201`-`:207`. Pinned:
    `packages/kernel/tests/unit/guard-audit.test.ts:273`-`:299`.

26. **Allow/deny entries are matched against `Segment.normalized` only**, never against raw segment
    text — and `normalized` is already stripped of env-assignment prefixes, so neither list can
    see them: an allow entry `git status` is satisfied by `LD_PRELOAD=/evil.so git status` exactly
    as it is by the bare command. `packages/kernel/src/guard/shell-guard.ts:176`-`:179`, `:198`-`:199`.
    Pinned indirectly by the substitution case, which now resolves through the undecidable rule
    (`packages/kernel/tests/unit/guard.test.ts:851`-`:869`); the env-assignment blind spot itself is
    unpinned in this document's scope.

27. **An entry containing `*` is an anchored full-string glob; one without is an exact-or-space-
    boundary prefix; a blank entry never matches.**
    `packages/kernel/src/guard/shell-guard.ts:159`-`:165`, `packages/capability/src/glob.ts:31`.
    Unpinned — the shell-guard's own `compileCommandEntry("")` arm has no test, and the
    `@clarvis/tools` helper that used to pin the same blank-entry rule no longer exists.

28. **The allow list requires *every* segment to match; the deny list requires only one.**
    `packages/kernel/src/guard/shell-guard.ts:179` vs `:199`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts:107`-`:115` and `:895`-`:913`.

29. **An undecidable or empty command is never allow-listed.**
    `packages/kernel/src/guard/shell-guard.ts:177`-`:178`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts:117`-`:130`.

30. **A credential-file match is decided on `PathFact.raw`, and `.env.example|sample|template` is
    exempt.** `packages/kernel/src/guard/shell-guard.ts:137`-`:141`, `:128`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts:927`-`:941` and `:942`-`:967`.

31. **An audit record carries a digest of the command, never the command.**
    `packages/kernel/src/guard/shell-guard.ts:213`-`:217`, `packages/kernel/src/guard/resolver.ts:134`.
    Pinned twice, including a `not.toContain` on the secret text:
    `packages/kernel/tests/unit/guard-audit.test.ts:140`-`:147` and `:188`-`:208`.

32. **The audit channel is a distinct logger from the diagnostic one**, so lowering
    `CLARVIS_LOG_LEVEL` cannot silence the record of what a run was allowed to execute — but the
    whole channel is still gated by `CLARVIS_LOG_AUDIT` (default `true`), which `createAuditLogger`
    turns into a `NOOP_LOGGER`. `packages/kernel/src/guard/resolver.ts:39`-`:48`, `:227`; bound at
    `packages/kernel/src/file-kernel.ts:330-338`, `:709-713`;
    `packages/kernel/src/component-loggers.ts:82`-`:102`;
    `packages/capability/src/env.ts:198`. Pinned:
    `packages/kernel/tests/unit/guard-audit.test.ts:327`-`:354`, `:332`, `:337`.

33. **`onDecision` cannot change a verdict.** The guard destructures the ruling and returns
    `decision` regardless of what the observer does.
    `packages/kernel/src/guard/shell-guard.ts:329`-`:340`. Pinned:
    `packages/kernel/tests/unit/guard-audit.test.ts:149`-`:156`.

34. **An absent `guard` block means unconfigured, not disabled: the default mode is `on`.**
    `packages/loop/src/runtime/capabilities/tools-settings.ts:116`-`:118`. Pinned three times:
    `packages/kernel/tests/unit/guard.test.ts:206`-`:212`, the product-level posture suite at
    `:797`-`:831`, and `packages/code/tests/unit/guard-mode.test.ts:27`-`:38`.

35. **A run-request `guard_mode` overrides the settings default.**
    `packages/kernel/src/guard/resolver.ts:63`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts:196`-`:205`.

36. **A plugin manifest may not contribute a `guard` block.**
    `packages/loop/src/runtime/capabilities/tools-settings.ts:181`-`:186`, spec flags at `:266`-`:267`.
    The declared reason: "guard is a singleton and the last writer wins, so a plugin could silently
    disarm the workspace's own guard" (`:176`-`:177`). Pinned:
    `packages/loop/tests/unit/settings-specs.test.ts:34`-`:52` and
    `packages/loop/tests/unit/plugin-schema.test.ts:25`-`:29`.

37. **The `guard` block merges last-scope-wins as a whole object, never field by field.**
    `packages/loop/src/runtime/capabilities/tools-settings.ts:265`. Pinned:
    `packages/loop/tests/unit/settings-merge.test.ts:74`-`:80` and `:111`-`:130`.

38. **The guard's settings/request schema module imports no `@clarvis/tools` value**, so the
    settings schema carries no static dependency on the optional tools package.
    `packages/loop/src/runtime/capabilities/tools-settings.ts:1`-`:12` (imports are `zod`,
    `@clarvis/capability` types and `input-limits`). Pinned by the architecture walk in
    `packages/loop/tests/architecture/optional-package-loading.test.ts` (derived from the engine
    manifest, `:18`-`:40`).

39. **`guard_mode: "off"` yields no guard object at all**, not a permissive one.
    `packages/kernel/src/guard/resolver.ts:102`, `:235`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts:611`-`:616`.

40. **Mode `auto` builds the judge only when `guard_judge` is present *and* a model resolves;
    otherwise it falls back to the human prompt.** `packages/kernel/src/guard/resolver.ts:244`-`:245`,
    `:263`-`:264`. Pinned: `packages/kernel/tests/unit/guard.test.ts:737`-`:772`.

41. **A judge failure or malformed response is not memoized and escalates to the human when the
    default `on_unsure: "ask"` policy and a human channel permit it; otherwise it denies.** The
    final audit answerer is `human` when that fallback answers, never incorrectly `judge`.
    Production: `fallback`/`judgeOnce` in `packages/kernel/src/guard/judge.ts` and the judge branch
    in `createGuardResolver`. Tests: `packages/kernel/tests/unit/guard.test.ts` (`"routes call
    failures and malformed responses to the human channel"`) and
    `packages/kernel/tests/unit/guard-audit.test.ts` (`"attributes a judge failure fallback to the
    human who answered it"`).

42. **A judge that cannot be constructed degrades the run to mode `on`, it does not disarm the
    guard.** `packages/kernel/src/guard/judge.ts:159`-`:174` returns `undefined`;
    `packages/kernel/src/guard/resolver.ts:264` falls back to `humanElicit`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts:346`-`:355`, `:404`-`:424`, `:737`-`:753`.

43. **`on_unsure: "deny"` never reaches the human, even when a human channel exists; an omitted
    `on_unsure` behaves as its documented default `"ask"` — `packages/kernel/src/guard/judge.ts:175`'s
    `cfg.on_unsure !== "deny"` treats `undefined` the same as `"ask"`.**
    `packages/kernel/src/guard/judge.ts:175`, `:212`;
    `packages/loop/src/runtime/capabilities/tools-settings.ts:170`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts:540`-`:565`.

44. **Session approvals are keyed exactly, never by prefix.** `packages/kernel/src/guard/guard-elicit.ts:78` uses
    `Set.has` on the full key. Pinned: `packages/kernel/tests/unit/guard.test.ts:301`-`:315`
    (`git diff` covered, `git diff --stat` and `git` not).

45. **`allow_session` is offered only when the command is decidable and non-empty and an allow list
    object exists**, and an `allow_session` answer that was not offered records nothing and denies.
    `packages/kernel/src/guard/guard-elicit.ts:131`-`:154`, `:169`-`:176`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts:285`-`:300` and `:330`-`:342`.

46. **The session allow list is never persisted and lives exactly as long as one resolver.**
    `packages/kernel/src/guard/guard-elicit.ts:38`-`:85`;
    `packages/kernel/src/guard/resolver.ts:226`. Pinned across two runs of one resolver:
    `packages/kernel/tests/unit/guard.test.ts:642`-`:656`.

47. **A run with no elicit channel gets no elicit at all, even after another run of the same
    resolver recorded a session approval.** `packages/kernel/src/guard/resolver.ts:236`-`:243`,
    `:289`. Pinned: `packages/kernel/tests/unit/guard.test.ts:684`-`:694`.

48. **The guard elicit is wait-bounded and fails closed on timeout, abort or rejection; `waitMs: 0`
    denies promptly rather than waiting forever, and a late resolution that arrives after the bound
    already denied is swallowed rather than racing or double-firing.**
    `packages/loop/src/runtime/capabilities/tools.ts:103`-`:115`. Pinned:
    `packages/loop/tests/unit/guard-elicit-bound.test.ts:15`, `:32`, `:43`, `:66`, `:81`, `:89`.

49. **The run's guard is resolved once and applies to every agent in the run, sub-agents
    included.** `packages/loop/src/runtime/capabilities/tools.ts:132` (run scope) vs `:205`-`:223`
    (per agent). Pinned: `packages/loop/tests/integration/command-guard-wiring.test.ts:211`-`:272`.

50. **A run whose guard parks on a human gets `prompt_cache_ttl: "1h"` unless the caller named a
    TTL.** `packages/kernel/src/guard/resolver.ts:80`-`:87`,
    `packages/kernel/src/runs/settings-assembler.ts:471-478`. Pinned:
    `packages/kernel/tests/component/settings-assembler.test.ts:554`-`:582`.

51. **The judge's `model` counts as a referenced provider for request validation**, even though the
    judge is not a profile. `packages/loop/src/validation/request/provider-rules.ts:69`-`:71`, with
    the stated failure it prevents at `:57`-`:62`. Unpinned in this document's scope.

52. **Allow/deny lists are bounded: ≤256 entries, each 1..2048 characters, and an empty-string entry
    is rejected at parse time.** `packages/loop/src/runtime/capabilities/tools-settings.ts:14`-`:16`,
    `packages/loop/src/validation/input-limits.ts:19`-`:20`. Pinned for the empty entry:
    `packages/loop/tests/unit/settings-schema.test.ts:188`-`:195`.

53. **`code` never sends a judge prompt for a mode other than `auto`.**
    `packages/code/src/runtime.tsx` (`judgePayloadFor`). Unpinned.

54. **`code`'s judge-prompt loader treats blank, unreadable and oversized files as absent, falling
    through to the next scope.** `packages/code/src/adapters/guard-judge-prompt.ts:56`, `:64`,
    `:55`-`:57`, `:71`-`:75`. Pinned:
    `packages/code/tests/integration/guard-judge-prompt.test.ts:45`-`:61`.

55. **`allowed_commands: []` and an omitted `allowed_commands` reach identical verdicts everywhere,
    but a human asked to confirm sees different words for it — `denied_commands: []` does not even
    have that.** `boundedPatternList` (`packages/loop/src/runtime/capabilities/tools-settings.ts:14-16`)
    has no `.min()` on the array itself, only on each entry's string length, so `[]` is a schema-legal,
    distinct-from-omitted value an operator can write for either list; `buildGuard` preserves that
    distinction by spreading the settings key only when `!== undefined`
    (`packages/kernel/src/guard/resolver.ts:104-109`). Inside `createShellGuard`, every branch that
    reads `denied` guards on `denied !== undefined` only to avoid calling `.map()`/`.length` on
    `undefined` — `commandDenied` (`packages/kernel/src/guard/shell-guard.ts:198-200`) and the
    `undecidable` branch's `denied.length > 0` check (`:242`, invariant 21) both evaluate identically
    for `denied = []` and `denied = undefined`, so an operator's explicit `denied_commands: []` is
    truly indistinguishable, in every observable outcome, from never writing the key. `allowed`
    differs in exactly one place: the terminal `default` ruling's `reason` text branches on
    `allowed === undefined` directly (`:296-302`), so `allowed_commands: []` produces `"command not
    in the allowed commands list"` where an omitted key produces `"no allowed commands list
    configured"` — same `ask` verdict, different sentence. That sentence is not merely internal: it
    is written to the audit channel's `reason` field (`packages/kernel/src/guard/resolver.ts:132`) and
    is what a human sees in the confirmation prompt itself when the ask escalates
    (`req.reason ?? …` at `packages/kernel/src/guard/guard-elicit.ts:120`), so the distinction the
    resolver preserves is operator-visible for `allowed_commands` and a documented no-op for
    `denied_commands`. This resolves, for `allowedCommands`, one of the ambiguities
    the retired gap report counted as fully resolved; for `deniedCommands` the
    resolution is that there is nothing left to distinguish — the two spellings are one behavior
    wearing the same words everywhere they surface.

56. **Changing command-review mode or applying a named safety preset never erases the effective
    allow/deny policy.** A workspace with no local list copies the global list into its written guard
    block so the capability's last-wins scope merge cannot shadow it. Production:
    `packages/code/src/views/config/RunControlsPanel.tsx` (`guardPolicyForWrite`, `applyPreset`,
    `applyGuard`). Test: `packages/code/tests/integration/run-controls-render.test.tsx` (direct-mode,
    reviewed-global, and reviewed-workspace policy-retention cases).

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
    still matches an extensionless `curl` deny. `/etc/passwd` remains an outside-workspace operand
    and `/opt/untrusted/bin/tool` remains denied. Production:
    `packages/tools/src/guard/context.ts` (`commandPathOccurrences`, `externalExecutableHeads`,
    `normalizeExternalExecutables`), `packages/tools/src/guard/dialects/powershell.ts`
    (`canonicalCommand`), and `packages/tools/src/lib/system-executables.ts`
    (`systemExecutableRoots`, `stripWindowsExecutableSuffix`). Test:
    `packages/tools/tests/unit/guard-context.test.ts` (`does not let a command-head exemption cover
    the same path used later as an operand`, `drops a Windows executable suffix from an absolute
    command's policy identity`) and `packages/kernel/tests/integration/guard-dialects.test.ts`
    (`keeps an absolute executable exemption local to its command-head occurrence`, `matches an
    absolute Windows executable suffix against an extensionless deny entry`).

---

## 6. Failure modes and degradation

| Failure | Handling | Cite |
| --- | --- | --- |
| Guard function throws | `applyGuard` catches and returns an error result; the handler never runs | `packages/tools/src/core.ts:202`-`:204` |
| Elicit throws inside the tools layer | same catch | `packages/tools/src/core.ts:202`-`:204` |
| Elicit throws inside the loop wrapper | `mapRejection: () => false` — denies | `packages/loop/src/runtime/capabilities/tools.ts:114` |
| Elicit exceeds `elicit_wait_ms` | `onTimeout: () => false` — denies | `packages/loop/src/runtime/capabilities/tools.ts:112` |
| Run cancelled mid-prompt | `onAbort: () => false` at the loop layer; `signal` also passed into the elicitation itself | `packages/loop/src/runtime/capabilities/tools.ts:110`-`:114`; `packages/kernel/src/guard/guard-elicit.ts:167` |
| Client declines or cancels the elicitation | `false` (deny) | `packages/kernel/src/guard/guard-elicit.ts:169` |
| No human channel on an escalated ask | `false` + warn `guard.escalation.no_channel` — the code calls this "the one denial a user can neither see nor answer" | `packages/kernel/src/guard/resolver.ts:198`-`:207` |
| No judge model / unresolvable provider | judge is not built; run degrades to the human prompt; `warn` ending `"degrading to mode 'on'"` | `packages/kernel/src/guard/judge.ts:160`-`:173` |
| Judge LLM call throws (incl. a non-`Error` throw) | ask the human when policy/channel permit, otherwise deny; warn and do not memoize | `fallback` and `judgeOnce` in `packages/kernel/src/guard/judge.ts` |
| Judge returns a non-`decide` call, unparsable JSON, or a schema mismatch | ask the human when policy/channel permit, otherwise deny; warn and do not memoize | `parseDecision`, `fallback`, and `judgeOnce` in `packages/kernel/src/guard/judge.ts` |
| Judge times out | governed by `cfg.timeout_ms ?? 20_000` passed to `llm.call`; surfaces as the throw path above | `packages/kernel/src/guard/judge.ts:192` |
| Escalated human elicit rejects inside the judge | memo evicted and the rejection rethrown | `packages/kernel/src/guard/judge.ts:232`-`:235` |
| Analyzer cannot parse the command | `undecidable` → rule 2a/2b (deny with a deny list, human-escalated ask without) | `packages/kernel/src/guard/shell-guard.ts:258`-`:273` |
| A tool family the context builder does not know | no paths, no shell facts → rule 6 `non_bash` `allow` | `packages/tools/src/guard/context.ts:114`-`:118`, `packages/kernel/src/guard/shell-guard.ts:297`-`:299` |
| `CLARVIS_AGENT_TOOLS_ENABLED` unset | no toolset at all, so no guard is even constructed | `packages/loop/src/runtime/capabilities/tools.ts:130`-`:131` |
| Host supplies no `resolveGuard` | ordinary calls receive no policy guard; `host_vcs` remains hard-denied by core | `packages/loop/src/runtime/capabilities/tools.ts:79`-`:83`, `:132`; `packages/tools/src/core.ts:161`-`:164` |
| Host supplies no audit logger | `NOOP_LOGGER`; rulings still happen, nothing is recorded | `packages/kernel/src/guard/resolver.ts:227`; test `packages/kernel/tests/unit/guard-audit.test.ts:318`-`:324` |
| `guard-judge.md` unreadable / blank / >1 MiB | silently treated as absent, next scope wins | `packages/code/src/adapters/guard-judge-prompt.ts:56`, `:64`, `:66` |
| `auto` chosen in Run Controls without a usable model | persisted as `"on"` with a notification | `packages/code/src/views/config/RunControlsPanel.tsx` (`applyGuard`) |

An unappealable static `deny` carries the guard's reason. When an `ask` reaches a reviewer but is not
approved — whether declined, cancelled, timed out or denied by the model — the tool error instead
prefixes that reason with `"command review did not approve"`, making the attempted review visible
without claiming why it returned false (`packages/tools/src/core.ts:175`-`:203`). Both reach the
transcript as the tool call's `error`
(`packages/loop/tests/integration/command-guard-wiring.test.ts:83`). Note that the guard's reason strings
are tool results, so they fall under the tools package's "no bypass hints" scan
(`packages/tools/tests/architecture/no-bypass-hints.test.ts:36`-`:40`) — that rule is owned by
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
| `packages/tools/src/core.ts:156-168` | `buildGuardContext` | `applyGuard` must build a context before calling the host's guard |
| `packages/tools/src/guard/context.ts:2`, `:4` | `analyzeShell`, `currentDialect` | command tools need facts and a dialect |
| `packages/tools/src/guard/dialects/index.ts:1` | `lib/platform.ts` | dialect selection derives from the same flavor the executor uses |
| `packages/kernel/src/guard/shell-guard.ts:2`-`:9` | `@clarvis/tools/guard` (`withinWorkspace`, `touchesOutside` + types) | the policy reasons over the analyzer's facts |
| `packages/kernel/src/guard/shell-guard.ts:10` → `packages/kernel/src/guard/glob.ts:10` | `@clarvis/capability`'s `globToRegExp` | one shared glob dialect with `@clarvis/hooks` |
| `packages/kernel/src/guard/resolver.ts:11` | `@clarvis/loop/host`'s `defaultGuardMode` + `GuardConfig` | the settings shape is the engine's, not the kernel's |
| `packages/kernel/src/guard/judge.ts:11` | `@clarvis/capability`'s `parseModelRef`, `resolveProvider` | judge model resolution reuses the shared provider registry |
| `packages/kernel/src/file-kernel.ts:709-713` | `createGuardResolver` | the only production construction site |
| `packages/loop/src/runtime/capabilities/tools.ts:127-133` | `opts.resolveGuard` | the engine's single call into host guard policy |
| `packages/loop/src/runtime/tools/builtin/index.ts:21`-`:29` | `@clarvis/tools/guard` values | re-export barrel under the tools capability subpath |
| `packages/code/src/onboarding/seed-default-allowlist.ts:1`-`:4` | `@clarvis/kernel/local`'s two default lists | the seed is the analyzer's own list, not a copy |
| `packages/code/src/adapters/guard-mode.ts:2` | `@clarvis/kernel/policy`'s `defaultGuardMode` | the TUI's seed must agree with the kernel's default |

### Type-only edges

- `packages/loop/src/runtime/capabilities/tools-settings.ts:10`-`:11` imports only *types* from
  `@clarvis/capability`, and nothing from `@clarvis/tools` — that absence is the whole reason the
  file exists (`:1`-`:8`), and it is what keeps `settings-specs.ts` off the optional package.
- `packages/kernel/src/guard/guard-elicit.ts:9` imports `ElicitationCommandDetail` as a type from
  `@clarvis/protocol`; the engine "pipes params through opaquely" (`:17`-`:20`), so the loop has no
  edge to the protocol here.
- `packages/kernel/src/guard/resolver.ts:2`-`:10` takes `Guard`, `GuardElicit`, `GuardMode`,
  `GuardResolution`, `GuardResolver` as types from `@clarvis/loop`.

### Registration edges

- `agentToolsSettingsSpec` is listed in `BUILTIN_SETTINGS_SPECS`
  (`packages/loop/src/runtime/capabilities/settings-specs.ts:52`), which is what puts `guard` in the
  settings schema, the merge strategy table and the plugin manifest surface, and `guard_mode`/
  `guard_judge` in the run request — enforced as a registry-wide property at
  `packages/loop/tests/unit/settings-specs.test.ts:15`-`:32`.
- `GUARD_PLUGIN_FIELDS` is spread into `capabilityPluginFields`
  (`packages/loop/src/runtime/capabilities/settings-specs.ts:79`), which is what makes a plugin's
  `guard` a *parse error* rather than a silently ignored key.

### Who depends on this

`@clarvis/tools`' `dispatch` (every tool call), `@clarvis/kernel`'s run assembler (for the cache
TTL), `@clarvis/code`'s Run Controls / header / safety presets, and `@clarvis/server`, which
deliberately does **not** expose `guard_mode` (`packages/server/src/mcp/tools.ts:50`-`:56`) and
separately postures guard confirmations per principal
(`packages/server/src/mcp/elicitation.ts:223`) — both delegated to [server-mcp-facade](../hosts/server-mcp.md) and
[elicitation-and-user-interaction](../cross-cutting/elicitation.md).

---

## 8. Open questions

- **`code.json`'s `guard.mode` is read but never written.** It is **read** as a seed by
  `createGuardModeStore` (`packages/code/src/adapters/code-config.ts:203`,
  `packages/code/src/adapters/guard-mode.ts:44`-`:46`), while Run Controls persists the mode through
  `deps.settings.write` instead (`packages/code/src/views/config/RunControlsPanel.tsx`, `applyGuard`).
  `GuardModeStore` accordingly exposes only `mode`/`setMode`/`cycle`
  (`packages/code/src/adapters/guard-mode.ts:28`-`:32`) — nothing in it writes the seed back.
  Whether the read-only seed is intentional remains undetermined.
- **A stale test comment.** `packages/kernel/tests/unit/guard.test.ts:852`-`:856` says the
  `$(echo git) push origin main` case is closed by "Matching the raw segment text as well", but
  `commandDenied` matches `normalized` only and the source explicitly records that raw matching "was
  tried and removed" (`packages/kernel/src/guard/shell-guard.ts:189`-`:196`). The test passes
  through the *undecidable* rule instead. The comment describes an implementation that no longer
  exists.
- **A plugin `guard` block would still merge if it ever reached the merger.**
  `packages/loop/tests/unit/settings-merge.test.ts:199`-`:209` asserts that a plugin-scope `guard`
  survives the merge at lowest precedence. The plugin *schema* rejects it first
  (`packages/loop/src/runtime/capabilities/tools-settings.ts:181`), so nothing real can produce that state — but the merger itself has no
  guard-specific refusal, and the source does not settle whether that is deliberate defence-in-depth
  absence or an oversight.
- **No test asserts the executor and the analyzer actually share a flavor.** Invariant 6's second
  half is stated in prose in three places (`packages/tools/src/lib/platform.ts:5`-`:10`,
  `packages/tools/src/guard/dialects/index.ts:24`-`:27`,
  `packages/loop/src/runtime/subagents/build-subagent-input.ts:12`) but nothing fails if
  `tools/shell.ts` were changed to read `process.platform` directly.
- **Windows behaviour is unverified here.** The PowerShell dialect's own tests avoid asserting
  `PathFact.withinWorkspace` because "on a POSIX host `node:path` does not treat `\` as a separator,
  so a confinement assertion here would pass for the wrong reason. That belongs to the Windows job"
  (`packages/tools/tests/unit/powershell-dialect.test.ts:312`-`:315`). Whether that job currently
  runs is outside this document's scope.
- ~~**Rationale is largely absent for the pattern tables.**~~ **Each now states its membership
  rule at the source**, which is what was missing — not a defence of each individual entry but the
  test that decides whether one belongs:
  - The **30 PowerShell undecidable patterns** are long because PowerShell offers many spellings of
    one capability. Every entry is a substitution the analyzer cannot resolve, a way to evaluate a
    string as code, a way to hand the command to another interpreter, or a way to run something out
    of band; the aliases sit beside their cmdlets because to PowerShell an alias *is* the command,
    so matching only the long form is no defence rather than a partial one
    (`packages/tools/src/guard/dialects/powershell.ts:11`–`:41`).
  - The **11 credential-file regexes** do not try to enumerate every secret-bearing file, which is
    impossible. They name the conventional locations whose *name alone* is sufficient evidence, in
    three families — the ambient project secret, private key material, and the credential stores
    specific tools are known to write. Since the verdict is `ask`, the list errs towards matching
    (`packages/kernel/src/guard/shell-guard.ts:80`–`:107`).
  - The **five POSIX safe wrappers** pass one test: does the wrapper alter the *effect* of what it
    runs? These five change only scheduling, buffering or a deadline. `sudo`, `env` and `xargs` look
    like wrappers and are excluded, because each changes the privileges, environment or arguments the
    real command ends up with — looking past one would let a deny list be walked around by prefixing
    it (`packages/tools/src/guard/dialects/posix.ts:119`–`:131`).
  - The **1 MiB judge-prompt cap** exists because over-size is treated as *absent*, not truncated:
    cutting an operator's security policy in half would judge commands against half a rule set, while
    falling back to the built-in prompt judges them against a complete one. It sits far above any
    policy a person writes — the default is under 2 KB — so reaching it means the wrong file
    (`packages/code/src/adapters/guard-judge-prompt.ts:36`–`:48`).

  The POSIX allow list was already the exception: its four omissions carry an explicit,
  test-enforced rationale (`packages/tools/src/guard/dialects/posix.ts:60`-`:70`).
- **`escalate` has exactly one producer and one value.** Only rule 2b sets it
  (`packages/kernel/src/guard/shell-guard.ts:269`) and the type admits only `"human"`
  (`packages/tools/src/guard/types.ts:28`). **Resolved 2026-08-22 by derivation**: it is one value
  because the resolver implements one restriction — *bar every automatic answerer*. A second spelling
  would have to name a **partial** restriction (bar the session allow list but keep the judge, say),
  and there is no branch that could act on one: `escalate === "human"` takes the human channel or
  fails closed (`packages/kernel/src/guard/resolver.ts`), and everything else takes the ordinary
  path. So it is not a placeholder awaiting siblings; widening it means writing that branch first,
  and the type now says so. Whether a second producer is *planned* remains undetermined — but the
  field is read, not dead, which is the part that was in question.
- **Handed to siblings, not covered here:** the elicitation transport, buffering and the
  `auto_decline` posture ([elicitation-and-user-interaction](../cross-cutting/elicitation.md)); how `ElicitBlock` renders a
  `guard_confirm` (`packages/code/src/views/ElicitBlock.tsx:61`, [code-transcript-and-tool-rendering](../hosts/code-transcript.md));
  the seeding of `allowed_commands` on first boot ([code-onboarding-doctor-and-platform](../hosts/code-onboarding.md)); the
  sandbox half of the safety presets ([sandbox-and-toolchains](sandbox.md)); and the prompt-cache economics
  behind the `1h` TTL ([prompt-cache-and-prefix-stability](../cross-cutting/prompt-cache.md)).
