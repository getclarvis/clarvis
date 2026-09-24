# Shell-command analysis, guard modes, allow/deny policy and the judge

> Implemented at `packages/...`. Every claim below is anchored to a file and a named symbol or test. Open questions
> are collected in the final section.

## 1. Purpose

Auto review receives host-captured persistent instructions from both global and workspace context,
with `CLARVIS.md` preferred over `AGENTS.md` independently per scope. Direct operator restrictions
take precedence. A missing allowlist match or dynamic-expansion analysis limitation triggers
semantic review rather than proving the command unauthorized. The final Guard outcome retains an
optional `reviewer_decision` separately from its static trigger and any later Approval answer.
Production: `JUDGE_POLICY` in [prompt.ts](../../packages/judge/src/prompt.ts), `createCommandReview`
in [command-review.ts](../../packages/kernel/src/guard/command-review.ts), and `createAgentTools`
in [index.ts](../../packages/tools/src/index.ts).
Test: [judge-host.test.ts](../../packages/kernel/tests/integration/judge-host.test.ts) and
[command-review.test.ts](../../packages/kernel/tests/unit/command-review.test.ts).

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
treat an undecidable result as 'unknown', never as within-workspace"
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
| `Segment` | iface | `packages/tools/src/guard/types.ts` | `{ command; argv; normalized; envAssignments; decidable; analysisIssues }` |
| `ShellFacts` | iface | `packages/tools/src/guard/types.ts` | `{ paths: string[]; segments: Segment[]; undecidable: boolean; analysisIssues }` |
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
| `commandRiskFindings` | fn | `packages/tools/src/guard/helpers.ts` | `(shell) => GuardRiskFinding[]` |
| `isDangerousCommand` | fn | `packages/tools/src/guard/helpers.ts` | `(shell) => boolean` |

`resolveCandidate` (`packages/tools/src/guard/paths.ts`) is exported through `./guard` so the kernel
can resolve bare directory operands with the analyzer's existing symlink-aware boundary. `patchPaths`
remains internal. `GuardPlacement` is `"host" | "contained"`; `GuardCallFacts` carries optional
`placement`, `network: "none" | "host"`, `matched`, `dangerous`, `risk_findings`,
`within_workspace` and `touches_outside` on both `GuardDecision` and `ElicitRequest`.
`commandRiskFindings(ShellFacts)` reports per-segment forced `rm`/`Remove-Item` and `sudo`
from normalized argv; `isDangerousCommand` is the derived non-empty predicate
(`packages/tools/src/guard/helpers.ts`). Findings are syntactic facts, not a human-channel
policy.
Production: `commandRiskFindings` in [helpers.ts](../../packages/tools/src/guard/helpers.ts)
and `createShellGuard` in [shell-guard.ts](../../packages/kernel/src/guard/shell-guard.ts).
Test: [guard-helpers.test.ts](../../packages/tools/tests/unit/guard-helpers.test.ts) and
[guard-auto-review.test.ts](../../packages/kernel/tests/integration/guard-auto-review.test.ts).

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

### 2.5 Run-request params

| Param | Schema |
| --- | --- |
| `guard_mode` | `z.enum(["off","on","auto"])` |
| `guard_judge` | `.strict()` object : `guidance?` (1..32768 chars), `model?` (min 1), `max_retries?` (nonnegative integer within `CLARVIS_RETRY_CEILING`), `on_unsure?: "ask"\|"deny"`, default `"deny"`, `timeout_ms?` (positive int within the ordinary host timeout ceiling; shared model inactivity semantics) |

`guard_mode` is contributed by the built-in tools settings spec in
`packages/loop/src/runtime/capabilities/tools-settings.ts`. `guard_judge` is contributed by
`judgeSettingsSpec` in `packages/judge/src/settings.ts`, registered by the Kernel before parsing.
The Protocol mirrors them as `StartRunParams.guard_mode` and `guard_judge` without depending on
Judge. Neutral Capability vocabulary retains `GuardMode`; `GuardJudgeConfig` belongs to Judge.

### 2.6 `@clarvis/code` surface

| Symbol | File | Purpose |
| --- | --- | --- |
| `GuardMode` | `packages/code/src/adapters/guard-mode.ts` | local restatement of the three modes |
| `guardAutoResolves` | `packages/code/src/adapters/guard-mode.ts` | `auto` needs a resolvable `effect_review.model` or `default_model` |
| `GuardModeStore` | `packages/code/src/adapters/guard-mode.ts` | `{ mode; setMode; cycle }` |
| `createGuardModeStore` | `packages/code/src/adapters/guard-mode.ts` | seeds from `code.json` default, else `defaultGuardMode(settings.guard)` |
| `DEFAULT_GUARD_JUDGE_PROMPT` | `packages/code/src/adapters/guard-judge-prompt.ts` | empty compatibility value when no guidance exists |
| `GuardJudgePrompt` | `packages/code/src/adapters/guard-judge-prompt.ts` | `{ prompt; source: "workspace"\|"global"\|"builtin" }` |
| `loadGuardJudgePrompt` | `packages/code/src/adapters/guard-judge-prompt.ts` | workspace → global → builtin |

The mode reaches a run through `judgePayloadFor` (`packages/code/src/runtime.tsx`) and
`toStartParams` (`packages/code/src/adapters/kernel-run-client.ts`). The `review.picker` command
opens the independent Off/Approval/Auto selector through the portable `Ctrl+X G` sequence
(`packages/code/src/app/commands.tsx`, `packages/code/src/keys/interaction.ts`).

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
      "decidable": true,
      "analysisIssues": [] }
  ],
  "undecidable": false,
  "analysisIssues": []
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

### 3.4 `guard_judge` guidance and automatic decisions

`guard_judge.guidance` is the only typed field for bounded additional guidance. Code composes operator-global guidance before workspace guidance. Every command ask the allow/deny lists did not deterministically resolve uses the call-local reviewer in
`judge.ts`: it receives the complete command and host guard facts plus host-owned operator evidence. Top-level
`review_context` contains the complete persisted Goal definition and the stable substantive Plan
projection when present, separate from `operator_evidence`. The reviewer treats those
host-attested definitions as the operator's semantic objective and intended implementation path;
they may establish a necessary routine bounded prerequisite such as installing declared project
dependencies. They cannot by themselves authorize publication, deployment, destructive
actions, credential access or external contact from that context, nor override an exclusion. The Judge serializes the bounded Goal and Plan projections in dedicated fixed-position
slots, then one message per chronological operator-evidence entry. It does not receive the work
run's Goal operational reminder, Plan CAS/task-status header or transcript. The volatile authority
block omits evidence and review context already sent in those slots, preventing duplicate prompt
input. Its
verdict applies to that exact call and cannot register an effect, install an authority grant or add
session coverage. Each segment supplies its exact source, normalized argv, explicit executable and
parameter list, environment bindings split at their first `=`, and structured analysis issues. This
lets the reviewer assess options, wrappers, `NAME=value`, `env NAME=value command` and dynamic values
without treating parameter syntax alone as uncertainty. Command review rechecks the authority revision
and the atomically captured Plans semantic revision after inference; a changed Plans revision also
invalidates a compiled configuration envelope before reuse. Missing evidence, invalid output and stale revisions
become `unsure` and refuse to the calling agent.
Command review resolves `JUDGE_PORT` at invocation and uses its private child run. The Judge owns
fixed policy, canonical snapshot breakpoint, separate volatile case, resolved TTL and semantic
memoization. The host adapter keeps only in-flight answer deduplication for concurrent identical
cases; human answers are never cached as semantic verdicts. Missing port or
architecture failure propagates without elicitation. Retirement denies without asking a human.

Production: `createCommandReview` in
[command-review.ts](../../packages/kernel/src/guard/command-review.ts), composed by
`createGuardResolver` in [resolver.ts](../../packages/kernel/src/guard/resolver.ts).
Test: [command-review.test.ts](../../packages/kernel/tests/unit/command-review.test.ts) pins eight
concurrent callers, configured fallback counts, architecture faults and cancellation;
[judge-host.test.ts](../../packages/kernel/tests/integration/judge-host.test.ts) runs the adapter
through the real coordinator/engine and proves cache reuse and private accounting;
[command-guard-routing.test.ts](../../packages/kernel/tests/integration/command-guard-routing.test.ts)
pins the single path for simple and composite commands.
The command review integration fixtures compose the production coordinator and Loop with host
consumers. They contain no alternate reviewer policy or direct-provider review implementation.
Configuration changes are reviewed by the separate transactional path owned by
[effect review](effect-review.md). Test:
[judge.test.ts](../../packages/kernel/tests/integration/judge.test.ts) and
[operator-authority.test.ts](../../packages/kernel/tests/unit/operator-authority.test.ts).

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

### 3.8 The nonreplaceable reviewer policy

`JUDGE_POLICY` in
[prompt.ts](../../packages/judge/src/prompt.ts) is always the first system
message. Workspace and global guidance are additional data and never replace it. Admitted operator
evidence anchors authority; host-attested Goal and Plan semantics let the reviewer interpret that
evidence for routine bounded prerequisites. Configuration review requires host validation of
registered effect, target, evidence and grant coverage after the model responds; an uncertain or
noninferable configuration effect is refused. Review on remains human review, and containment alone grants
no semantic authority. Command review compiles no envelope: the Judge answers the exact call, and a
recognised operation name is never an authorization rule.

Goal Steward output is a completion verdict or correction, never an operator message, approval or
new authority anchor. It cannot invoke Auto Guard or grant effects. Production:
`createGoalCapability` and `buildGoalStewardRequest`. Test: the completion-review journey in
[goal-steward-runtime.test.ts](../../packages/kernel/tests/integration/goal-steward-runtime.test.ts).

A host-started Goal stage does not admit its synthetic start or continuation message as operator
evidence. Literal Goals supply the complete definition explicitly declared by the user. Guided Goals
supply the exact source-execution user messages followed by the exact seed; auto Goals supply only
those exact source messages. Inferred objective, criteria, constraints, exclusions and assumptions,
together with stable Plan substance, can authorize only a necessary routine bounded prerequisite;
they never satisfy an explicit authority boundary. Production: `goalAuthorityMessages` in
[hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts) and its use by `createRunService` in
[run-service.ts](../../packages/kernel/src/runs/run-service.ts). Test: the exact literal/guided Goal
authority cases in
[goal-hosted-continuation.test.ts](../../packages/kernel/tests/integration/goal-hosted-continuation.test.ts)
and [run-service-lifecycle.test.ts](../../packages/kernel/tests/unit/run-service-lifecycle.test.ts).

Production: `createGuardResolver` and `createCommandReview`.
Test: [command-guard-routing.test.ts](../../packages/kernel/tests/integration/command-guard-routing.test.ts)
and [guard-judge-prompt.test.ts](../../packages/code/tests/integration/guard-judge-prompt.test.ts).

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
| command tools | `shell` | `analyzeShell(args.command)` resolves each path occurrence with shell semantics against workspace, configured temporary roots, and exact selected skill roots; an absolute command head beneath a platform system executable root or configured runtime root is admitted only for that occurrence and normalized to its basename for allow/deny matching; `args.cwd` is resolved against the same roots; `sandbox_permissions` and `justification` are copied onto the context. Commands receive no machine-state spill exception. | `packages/tools/src/guard/context.ts` (`commandPathOccurrences`, `externalExecutableHeads`, `normalizeExternalExecutables`), `packages/tools/src/lib/system-executables.ts` |
| patch | `apply_patch` | `patchPaths(args.patch)` — raw unified `---`/`+++` plus model-envelope Update/Add/Delete/Move headers, `/dev/null` dropped, `a/`/`b/` prefixes stripped, deduped first-seen | `packages/tools/src/guard/context.ts`, `packages/tools/src/guard/paths.ts` |
| src/dest | `move`, `copy` | `args.source`, `args.destination` | `packages/tools/src/guard/context.ts`, `packages/tools/src/guard/paths.ts` |
| list | `read_files` | every string in `args.paths` | `packages/tools/src/guard/context.ts`, `packages/tools/src/guard/paths.ts` |
| pair | `diff` | `args.from`, `args.to` | `packages/tools/src/guard/context.ts`, `packages/tools/src/guard/paths.ts` |
| scoped | `replace` | `args.path` if a non-empty string, else `"."` | `packages/tools/src/guard/context.ts`, `packages/tools/src/guard/paths.ts` |
| single path | `read_file`, `write_file`, `edit_file`, `multi_edit`, `read_image`, `list_dir`, `glob`, `grep`, `file_stat`, `tree`, `mkdir`, `remove` | `args.path` | `packages/tools/src/guard/context.ts`, `packages/tools/src/guard/paths.ts` |

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
   collect `dialect.analysisIssues` with zero-based segment indices. Legacy dialects that report
   undecidability without causes receive `tokenizer_gap`; unbalanced syntax and empty tokenization
   receive their own causes. `decidable` means the segment has no issues.
3. For each token: `dialect.pathCandidate(token)`. `opaque` adds `opaque_path` and
   contributes **no** path; `none` contributes nothing; otherwise the value is pushed once,
   deduplicated by a `Set`, first-seen order.
4. Aggregate segment issues; `undecidable = analysisIssues.length > 0`. Empty tokenization means
   `argv.length === 0` **and** no `envAssignments`. An assignment-only segment is not a tokenizer failure.

`ShellAnalysisIssueKind` distinguishes parameter, command and process substitution, dynamic
command/subcommand/path, opaque command/path, unbalanced syntax and tokenizer gaps.
`ShellAnalysisImpact` distinguishes value, executable, subcommand, path, environment and control
flow. These are syntax facts, never permission. The call-local reviewer may use these facts only for
its exact command verdict.
POSIX assignment values are classified as paths separately from their variable names. Production:
[analyzer](../../packages/tools/src/guard/analyze-shell.ts) (`analyzeShell`) and
[dialects](../../packages/tools/src/guard/dialects/index.ts). Test:
[issue corpus](../../packages/tools/tests/unit/analysis-issues.test.ts).

The empty-segment case is the one with a stated reason: the guard matches its deny list against
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

The state-spill exception is narrower than `config.stateRoot`. `resolveReadableTextPath` admits only an exact generic result spill directly under `<stateRoot>/local`, requires a regular non-link file, and pins its filesystem identity through the read. Only `read_file` and `read_files` receive that exact-file allowance; `shell` cannot mount or read state through it. Prompt history, legacy sidecars, and another workspace's state remain outside the exception. Production: `packages/tools/src/lib/state-artifacts.ts`, `packages/tools/src/lib/files.ts`, and `packages/tools/src/guard/context.ts`. Test: `packages/tools/tests/unit/state-artifact-access.test.ts` and `packages/tools/tests/integration/guard-dispatch.test.ts`.

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
| 3a | `shell.undecidable`, no/empty deny list, placement Host | `undecidable` | `ask`; `escalate: "human"` unless `allowHostJudge` is true (Auto only) |
| 3b | `shell.undecidable`, no/empty deny list, placement contained | `undecidable` | `ask`, no escalation restriction |
| 4 | credential path plus forced removal or privilege elevation | `dangerous` | Auto `ask` (Judge); Approval asks a human for forced removal and denies privilege elevation |
| 5 | credential path without that command risk | `credential_file` | `ask` |
| 6 | forced removal (`rm -f`, `rm --force` or a short force cluster) or privilege elevation | `dangerous` | Auto `ask` (Judge); Approval asks a human for forced removal and denies privilege elevation, regardless of the allow list |
| 7 | `touchesOutside(ctx)` — some resolved path escapes | `outside_workspace` | `ask`; on Host without Auto, ask a human. The selected environment still enforces physical access |
| 8 | `ctx.shell === undefined` (a non-command tool) | `non_bash` | `allow` |
| 9 | any segment has a preserved environment assignment | `default` | `ask`; `escalate: "human"` on Host unless `allowHostJudge` is true |
| 10 | allow list configured and **every** comparison segment matches, ignoring validated POSIX `cd` | `allow_list` | `allow` |
| 11 | `!withinWorkspace(ctx)` — i.e. no resolved paths at all | `outside_workspace` | `ask` |
| 12 | otherwise | `default` | `ask` |

The original adjacent-pair ordering cases live in `packages/kernel/tests/unit/guard.test.ts`.
Placement, dangerous precedence and comparison-only POSIX directory handling are pinned by
`packages/kernel/tests/integration/guard-auto-review.test.ts`.
Reviewed commands and file tools may read a host-visible external file in a native Sandbox;
Bubblewrap or Seatbelt still enforces declared write roots. Host uses its OS permissions. External paths require review and do not become an access grant.
Production: `createShellGuard` in [shell-guard.ts](../../packages/kernel/src/guard/shell-guard.ts)
and `resolveFilesystemPolicy` in [sandbox.ts](../../packages/tools/src/sandbox.ts).
Test: `packages/kernel/tests/integration/guard-file-parity.test.ts` and external read/write cases
in `packages/tools/tests/integration/filesystem-service.test.ts`.

There is no contained silent-allow rule: unmatched Sandbox commands still ask, and only Auto
changes who may answer. Placement is resolved once per Host/Sandbox run from host settings. An
enabled native policy is contained-or-fail-closed (`sandboxWouldApply`); even legacy
`availability: "optional"` never falls back to bare execution. `loadGuardSettings` uses the same
effective native policy resolver as tool execution. Per-call unsandbox overrides placement to Host and
omits the native network restriction. Its `host_command` ask precedes generic undecidability, but
never deny-list enforcement. Auto asks the reviewer; unsure, operational
failures and malformed responses refuse to the calling agent and never use a human. Approval asks a
human only for the grey zone. `off` is unchanged.
Contained `rm`, `rmdir` and `rm -rf` therefore receive an Auto decision for their complete command;
the native sandbox still blocks writes to workspace configuration and Git metadata after an allow.
The file tool's ordinary bounded recursive cleanup follows the same Auto review principle through
its separate effect reviewer. Production: `createShellGuard` in
[shell-guard.ts](../../packages/kernel/src/guard/shell-guard.ts), `sandboxCommand` in
[sandbox.ts](../../packages/tools/src/sandbox.ts) and `remove` in
[remove.ts](../../packages/tools/src/tools/remove.ts). Test:
[guard-auto-review.test.ts](../../packages/kernel/tests/integration/guard-auto-review.test.ts),
[guard-file-parity.test.ts](../../packages/kernel/tests/integration/guard-file-parity.test.ts), and
[sandbox.test.ts](../../packages/tools/tests/integration/sandbox.test.ts).

POSIX normalization removes consecutive leading Git `--no-pager`/`--no-color` presentation flags.
`commandComparison` in `packages/kernel/src/guard/command-comparison.ts` additionally validates bare
`cd <path>` and leading `git -C <path>` operands. Assignment-only `NAME=value` segments and
command environment prefixes prevent static allowlist approval, even with wildcard entries.
Unattested bindings ask a human on Host and require explicit review when contained. In a straight `&&` chain, an in-workspace `cd`
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
- **Rule 5b outranks rule 8** so no allow-list entry can wave `cat .env` through — "`cat` is exactly
  the sort of entry a starter allow list contains" (`packages/kernel/src/guard/shell-guard.ts`); pinned at
  `packages/kernel/tests/unit/guard.test.ts`. A credential-file read is `ask`, not `deny`, because
  such files "sit *inside* the workspace as often as not … Reading them is frequently legitimate"
  (`packages/kernel/src/guard/shell-guard.ts`). Forced removal or sudo of a credential path is
  rule 5a: Auto asks the Judge and Approval denies.
- **Rule 9's reason string** is `"the paths this command touches could not be determined"`, chosen
  after the previous wording asserted an escape for `whoami` "and the model read that as fact and
  invented explanations from it" (`packages/kernel/src/guard/shell-guard.ts`).
- **Deny matching checks normalized and comparison forms, not raw command text.** The substitution
  case is handled by rule 2a (`packages/kernel/src/guard/shell-guard.ts`).
- **Rule 10's reason names the miss.** `"no allowed commands list configured"` when `allowed`
  is `undefined`. When an allow list exists, the reason includes the unmatched comparison
  segments (`command not in the allowed commands list: unmatched rm -r ./dist`). A deny-list
  hit names both the segment and the matching entry. Forced-removal and privilege-elevation
  asks quote the normalized segment. Production: `createShellGuard`. Test:
  [guard-auto-review.test.ts](../../packages/kernel/tests/integration/guard-auto-review.test.ts).
- **Environment bindings never inherit static approval from bare argv.** `commandsAllowed`
  rejects any segment carrying `envAssignments`. `commandDenied` retains bare normalized matching
  so an environment prefix cannot hide a denial. Session approval retains exact environment keys.
  Production: `createShellGuard` in [shell-guard.ts](../../packages/kernel/src/guard/shell-guard.ts).
  Test: [guard contrasts](../../packages/kernel/tests/integration/guard-auto-review.test.ts).

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

`createGuardResolver` resolves the effective mode and native Host/Sandbox placement and builds one
policy guard for the resolved mode. Review `off` returns no guard and no elicit. Review `on`
(Approval) asks a human only when the call is neither an allow-list match nor a
dangerous match. Dangerous matches in Approval deny to the principal with the exact segment.
Review `auto` never elicits a person: every `ask` that applicable session consent does not already
cover goes to the call-local reviewer, including forced removal, privilege elevation,
credential-file asks and unsandbox. Judge deny and Judge unsure refuse to the principal. Absence of
a reviewer port or model refuses. Deterministic denies and exact static allows finish before any
model call. The policy decides alone: no effect catalogue, operation rule, probe or compiled
envelope sits between it and the Judge.

Production: [resolver.ts](../../packages/kernel/src/guard/resolver.ts). Test:
[guard.test.ts](../../packages/kernel/tests/unit/guard.test.ts),
[judge.test.ts](../../packages/kernel/tests/integration/judge.test.ts)
(`sends Auto mktemp capture cleanup to the call-local reviewer`,
`sends mixed forced removal and privilege elevation to Auto instead of a human`,
`routes a formerly human-only command to the same call-local reviewer as any other ask`),
[guard-session-auto.test.ts](../../packages/kernel/tests/integration/guard-session-auto.test.ts), and
[command-guard-routing.test.ts](../../packages/kernel/tests/integration/command-guard-routing.test.ts).

### 4.7 Answering an `ask`

The composed elicit applies session coverage only to the exact analyzable non-host command and then
routes the ask to the channel the mode selects: the Judge for `auto`, a human for Approval's grey
zone. A call-local allow is keyed by the authority revision and the complete guard request, including
the raw command, and installs no grant. Auto refuses `unsure` to the principal and never uses the
human channel. Approval asks a human only for grey-zone asks. Human answers and operational failures
are not cached as clean verdicts. `matched: "host_command"` never receives sticky session consent in
Auto; Approval may ask a person for unsandbox.

`createGuardHumanApproval` reads the current allowlist before and after the question. It refuses late
answers after the controller or scope is retired. `humanApprovalFor` is available only to native
Host/Sandbox runs.

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

### 4.9 Automatic review boundaries

Review `auto` has exactly two outcomes for an `ask`: applicable session consent already covers the
exact analyzable non-host command, or the Judge decides the complete call. The command payload
carries the original call, its segments, resolved paths, explicit environment bindings, placement,
the policy reason and host-owned operator evidence; it carries no operation catalogue and no
compiled grant. Its payload labels command arguments as
untrusted data and supplies authenticated intent separately. The case key includes the ledger
revision; a steer invalidates an in-flight result. The configuration rollout stage
(`effect_review.rollout`) scopes the transactional configuration reviewer only and never changes
command routing.

Production: `createGuardResolver` and `createCommandReview`. Test:
[command-guard-routing.test.ts](../../packages/kernel/tests/integration/command-guard-routing.test.ts) and
[judge.test.ts](../../packages/kernel/tests/integration/judge.test.ts).

### 4.10 Prompt-cache TTL side effect

`guardParksOnHuman(param, guard)` returns `true` only for mode `on`
(`packages/kernel/src/guard/resolver.ts`). Auto never parks. The run assembler uses
it to derive `prompt_cache_ttl: "1h"` when the caller named none
(`packages/kernel/src/runs/settings-assembler.ts`), pinned across the whole truth table
at `packages/kernel/tests/component/settings-assembler.test.ts`. The economics belong to
[prompt-cache-and-prefix-stability](../cross-cutting/prompt-cache.md).

### 4.11 `code`'s surface

- **Session mode** lives in a signal seeded from `code.json`'s `guard.mode`, else the settings-
  derived default (`packages/code/src/adapters/guard-mode.ts`,
  `packages/code/src/adapters/code-config.ts`). `cycle()` walks `off → on → auto → off`
  (`packages/code/src/adapters/guard-mode.ts`; pinned at `packages/code/tests/unit/guard-mode.test.ts`).
- **Quick Review picker** writes the block to `settings.json` through the same controller as Run
  Controls. It is reached by `Ctrl+X G`; the sequence does not change Isolation
  (`packages/code/src/views/overlays/ReviewPicker.tsx`,
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
- **Judge guidance** composes global `guard-judge.md` before workspace guidance, preserving only
  global guidance if the combined bound is exceeded, with a blank or
  unreadable file treated as absent (`packages/code/src/adapters/guard-judge-prompt.ts`) and a >32 KiB file rejected without reading its body; pinned at
  `packages/code/tests/integration/guard-judge-prompt.test.ts`. The guidance is sent only
  when the mode is `auto` (`packages/code/src/runtime.tsx`, `judgePayloadFor`). `judgePayloadFor`
  (called by `buildRunHost` in `packages/code/src/runtime.tsx`) is the only production path that attaches `guard_judge` to a
  run request, and its return type is `{ guardJudge?: { guidance: string } }`
  (`packages/code/src/run-host.ts`) — it never sets `model`, `on_unsure` or `timeout_ms`, even
  though `toStartParams` forwards all three when present (`packages/code/src/adapters/kernel-run-client.ts`)
  and `GuardJudgeInput` declares them (`packages/code/src/adapters/run-types.ts`). The kernel resolves
  shared `effect_review` settings without requiring Code to duplicate those values in each request.
- **Isolation is separate.** Host/Sandbox selection writes no guard field, and a Review write
  writes no Sandbox field. The header and Run Controls therefore report both axes rather
  than naming a combined posture (`packages/code/src/features/run/isolation.ts`,
  `packages/code/src/features/run/review.ts`,
  `packages/code/src/adapters/execution-safety.ts`). The containment half belongs to
  [sandbox-and-toolchains](sandbox.md).

---

## 5. Invariants

Numbered, declarative, falsifiable. "Unpinned" means no test was found that fails if the rule is
broken.

1. **An undecidable command is never within-workspace.** `withinWorkspace` returns `false`
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
    guarded host-command review → generic undecidable → outside-workspace → credential-and-dangerous
    Auto-ask/Approval-deny → credential file → non-shell allow → environment-prefixed dangerous
    Auto-ask/Approval-deny → environment review → allow list → dangerous Auto-ask/Approval-deny →
    unbounded-paths ask → default ask.**
    `packages/kernel/src/guard/shell-guard.ts`. Pinned pair-by-pair:
    `packages/kernel/tests/unit/guard.test.ts`, plus
    `packages/kernel/tests/integration/guard-auto-review.test.ts` for the credential-file position.

    An explicit unsandbox host-command ask carries `escalate: "human"` in `on`; Auto alone passes
    `allowHostJudge: true` and can send it to the judge, without session coverage or session approval.
    Production:
    `packages/kernel/src/guard/shell-guard.ts` (`createShellGuard`). Test:
    `packages/kernel/tests/integration/guard-auto-review.test.ts` (Auto explicit unsandbox review,
    including real shell dispatch, judge denial and session-coverage exclusion).

20. **The guard only ever narrows.** The sole `allow` verdicts are `non_bash` (rule 6) and
    `allow_list` (rule 8). `packages/kernel/src/guard/shell-guard.ts`.
    Pinned by exhaustion of the `matched` vocabulary in
    `packages/kernel/tests/unit/guard-audit.test.ts`.

21. **An empty `denied_commands` array never turns an unanalyzable command into a denial.**
    `packages/kernel/src/guard/shell-guard.ts` tests `denied.length > 0`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts`.

22. **A non-empty deny list turns *any* unanalyzable command into a denial** — it is not downgraded
    to an ask that a judge or session allow list could answer.
    `packages/kernel/src/guard/shell-guard.ts`. Pinned:
    `packages/kernel/tests/unit/guard.test.ts`, and as a property over six commands.

23. **An `undecidable` ask carries `escalate: "human"` on Host except when Auto supplied
    `allowHostJudge`.** Contained undecidability and Host Auto remain ordinary asks, never silent
    policy allows. Explicit unsandbox matches `host_command` first and is reviewable by Auto, unless
    a deny-list rule already refused it.
    Production: `createShellGuard` in `packages/kernel/src/guard/shell-guard.ts`. Test:
    `packages/kernel/tests/integration/guard-auto-review.test.ts` (placement and dangerous cascade)
    and `packages/kernel/tests/unit/guard-audit.test.ts`.

24. **An `escalate: "human"` request bypasses both automatic answerers — the LLM judge and the
    session allow list.** `packages/kernel/src/guard/resolver.ts` (the escalate arm
    returns before the allow-list check). Pinned:
    `packages/kernel/tests/unit/guard-audit.test.ts`. Auto never takes this path. Approval uses it
    for grey-zone asks (unsandbox, Host undecidable), not for dangerous matches, which deny.
    Pinned:
    `packages/kernel/tests/integration/judge.test.ts` (`sends a known privilege_elevation ask to Auto
    instead of a human`, `sends mixed forced removal and privilege elevation to Auto instead of a
    human`).

25. **An escalated ask with no human channel denies and emits a warn record**, rather than denying
    in silence. `packages/kernel/src/guard/resolver.ts`. Pinned:
    `packages/kernel/tests/unit/guard-audit.test.ts`.

26. **Allow/deny entries use normalized/comparison forms**, never raw segment text. In-workspace
    POSIX directory handling follows §4.5. Normalization strips env-assignment prefixes but preserves
    them separately: deny matching still sees the bare command, while any prefix prevents static
    allow-list approval. Credential and dangerous classifications run before environment review, so
    `CI=1 cat .env` and `CI=1 rm -rf build` cannot acquire the generic environment route.
    `packages/kernel/src/guard/shell-guard.ts`. Pinned by
    `packages/kernel/tests/integration/guard-auto-review.test.ts` and
    `packages/kernel/tests/unit/guard.test.ts`.

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

40. **Mode `auto` builds a reviewer when a model resolves; `guard_judge` is optional guidance and
    overrides.** Unavailable models deny to the calling agent and never fall back to a human.
    Production: `packages/kernel/src/guard/resolver.ts`. Test: `packages/kernel/tests/unit/guard.test.ts`.

41. **A technical Judge failure is not memoized and never invokes human fallback, even with
    `on_unsure: "ask"`.** Invalid responses have up to three correction retries per stage inside
    the ordinary Loop before denial. The calling run receives a technical failure message rather
    than the static review trigger as an explanation. Production: `createCommandReview` in
    `packages/kernel/src/guard/command-review.ts`, `createGuardResolver` in
    `packages/kernel/src/guard/resolver.ts` and `applyGuard` in `packages/tools/src/core.ts`.
    Test: `packages/kernel/tests/unit/command-review.test.ts`,
    `packages/kernel/tests/integration/judge-host.test.ts` and
    `packages/tools/tests/integration/guard-dispatch.test.ts`.

42. **A judge that cannot be constructed denies Auto asks; `on_unsure: "ask"` does not open a
    human prompt.** `packages/kernel/src/guard/resolver.ts`. Pinned:
    `packages/kernel/tests/unit/guard-audit.test.ts` and
    `packages/kernel/tests/integration/guard-session-auto.test.ts`.

43. **Auto never reaches the human channel.** An omitted `on_unsure` remains `"deny"` in the
    schema; Auto ignores `"ask"` and refuses unsure to the calling agent. Approval still asks a
    person only for grey-zone asks.
    `packages/loop/src/runtime/capabilities/tools-settings.ts`. Pinned:
    `packages/kernel/tests/unit/guard-audit.test.ts`.

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
    answer from that scope cannot approve even once. Production:
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
    `undefined` — `deniedHit` (`packages/kernel/src/guard/shell-guard.ts`) and the
    `undecidable` branch's `denied.length > 0` check (invariant 21) both evaluate identically
    for `denied = []` and `denied = undefined`, so an operator's explicit `denied_commands: []` is
    truly indistinguishable, in every observable outcome, from never writing the key. `allowed`
    differs in exactly one place: the terminal `default` ruling's `reason` text branches on
    `allowed === undefined` directly, so `allowed_commands: []` produces `"command not
    in the allowed commands list"` where an omitted key produces `"no allowed commands list
    configured"` — same `ask` verdict, different sentence. That sentence is not merely internal: it
    is carried on the ruling's `reason` field (`packages/kernel/src/guard/shell-guard.ts`) and
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
    bypass command policy.** For `shell`, only the first argv item of a segment is a
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

62. **One policy decides, and one channel reviews a command.** A command `ask` that applicable
    session consent does not cover is reviewed by `createCommandReview` with the complete call. No
    effect classifier, operation rule, probe or compiled envelope intervenes between the policy and
    the Judge, and `createGuardResolver` builds one `createShellGuard` per resolution rather than
    re-running an attested variant. Production: `createGuardRuntimeResolver` and `buildGuard` in
    `packages/kernel/src/guard/resolver.ts`. Test:
    `packages/kernel/tests/integration/command-guard-routing.test.ts` ("sends the complete call to
    the Judge without an effect review", "decides by policy or Judge, never by operation name").

63. **A command never enters the configuration effect path.** `createGuardResolver` reads no
    `effect_review.rollout`, builds no effect registry, and calls no `reviewEffects`; `git.push` and
    `github.pr.open_or_update` no longer exist as authorization rules in the descriptor vocabulary.
    Production: `packages/kernel/src/guard/resolver.ts` and
    `packages/kernel/src/guard/effects/registry.ts`. Test:
    `packages/kernel/tests/integration/command-guard-routing.test.ts` ("keeps command routing
    independent of the configuration rollout stage").

64. **A deterministic deny is never promoted.** A `denied_commands` hit and the conservative denial
    of an opaque command under a non-empty deny list both rule `deny`, and no secondary attestation
    converts that ruling into an `ask`. Production: `createShellGuard` in
    `packages/kernel/src/guard/shell-guard.ts`. Test:
    `packages/kernel/tests/integration/guard-auto-review.test.ts` and
    `packages/kernel/tests/integration/command-guard-routing.test.ts` ("keeps a denied segment above
    an allow-listed composite without consulting the Judge", "keeps a conservative denial for an
    opaque command with a non-empty deny list").

65. **File-tool configuration mutation requires the restricted reviewer.** An admitted global or workspace
    authoring or operational target is writable only when the run carries the `reviewMutation` port.
    Without it the file tool refuses the protected target before any guard or Judge call, and a
    generic command approval never becomes configuration approval. Private targets remain denied.
    Production: `protectWorkspaceConfiguration` and `dispatch` in
    `packages/tools/src/core.ts`. Test: `packages/tools/tests/integration/api.test.ts` ("refuses
    canonical authoring through a generic guard approval and admits it only through the restricted
    writer", "keeps private configuration unreadable and reviews operational copy targets").

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
| Analyzer cannot parse the command | deny with a nonempty deny list; otherwise explicit unsandbox reaches `host_command`, then generic Host human-escalated or contained reviewable ask | `packages/kernel/src/guard/shell-guard.ts` |
| A tool family the context builder does not know | no paths, no shell facts → rule 6 `non_bash` `allow` | `packages/tools/src/guard/context.ts`, `packages/kernel/src/guard/shell-guard.ts` |
| `CLARVIS_AGENT_TOOLS_ENABLED` unset | no toolset at all, so no guard is even constructed | `packages/loop/src/runtime/capabilities/tools.ts` |
| Host supplies no `resolveGuard` | calls receive no policy guard and proceed without command review, including `require_escalated` shell | `packages/loop/src/runtime/capabilities/tools.ts`; `packages/tools/src/core.ts` |
| Host supplies no audit logger | `NOOP_LOGGER`; rulings still happen, nothing is recorded | `packages/kernel/src/guard/resolver.ts`; test `packages/kernel/tests/unit/guard-audit.test.ts` |
| `guard-judge.md` unreadable / blank / >32 KiB | silently treated as absent, next scope wins | `packages/code/src/adapters/guard-judge-prompt.ts` |
| `auto` chosen in Run Controls without a usable model | persisted as `"on"` with a notification | `packages/code/src/views/config/RunControlsPanel.tsx` (`applyGuard`) |

An unappealable static `deny` carries the guard's reason. When an `ask` reaches a reviewer but is not
approved by a valid semantic decision, the tool error instead
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
| `packages/kernel/src/file-kernel.ts` | `createGuardResolver` | Host/Sandbox construction site |
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
  - The **32 KiB guidance cap** treats oversized input as absent instead of truncating instructions.
    The Kernel supplies its invariant policy independently. Combined global/workspace guidance must
    fit the same bound; otherwise only the operator-global guidance remains
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
  independent Isolation control ([sandbox-and-toolchains](sandbox.md)); and the prompt-cache economics
  behind the `1h` TTL ([prompt-cache-and-prefix-stability](../cross-cutting/prompt-cache.md)).
## Single command-review path

One deterministic policy decides `allow`, `deny` or `ask`; an Auto `ask` that session consent does
not cover reaches `createCommandReview` with the complete call, independent of Git/GitHub operation,
segment count or effect classification. Nothing between the policy and the Judge revises that
ruling: `createGuardResolver` builds one `createShellGuard`, and `deny` never becomes `ask`.
Operation names such as `git.push` or `github.pr.open_or_update` are not authorization rules, so a
recognised operation cannot be refused before review, and an unclassified composition cannot enter a
different route. The configuration file reviewer, its authority envelope, exact grants and structured
failures are owned by [effect review](effect-review.md). Production: `createGuardResolver` in
[resolver.ts](../../packages/kernel/src/guard/resolver.ts), `buildGuard` in
[shell-guard.ts](../../packages/kernel/src/guard/shell-guard.ts) and `createCommandReview`.
Test: [command-guard-routing.test.ts](../../packages/kernel/tests/integration/command-guard-routing.test.ts)
and [guard-session-auto.test.ts](../../packages/kernel/tests/integration/guard-session-auto.test.ts).

Native `createGuardHumanApproval` deduplicates identical in-flight requests per current allowlist
scope. Canonical full request identity preserves differences in authority/context while ignoring JSON
property order. Success and failure both remove pending entries; no human answer becomes a reusable
semantic verdict. Replacing the scope cannot share the previous question or accept its late answer.
Production: [human-approval.ts](../../packages/kernel/src/guard/human-approval.ts), `createGuardHumanApproval`.
Test: [human-approval.test.ts](../../packages/kernel/tests/unit/human-approval.test.ts) pins eight callers,
no settled-answer memoization and controller replacement.
