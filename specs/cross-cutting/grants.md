# Grants, agent profiles and which tools an agent actually sees

> Implemented at `packages/capability/src`, `packages/loop/src/validation` and
> `packages/loop/src/runtime`, `packages/kernel/src/config/builtin-agents`, plus the capability
> packages that contribute their own grants (`skills`, `workflows`, `tasks`). Every
> claim below is anchored to a file and line. Open questions are collected in the final section.

## 1. Purpose

A `Grant` is the one string vocabulary an `AgentProfile` uses to ask for a
capability's behaviour (`packages/capability/src/api.ts:320-326`). The engine owns
four such strings itself (`BuiltinGrant`, `packages/capability/src/api.ts:317-318`);
everything else is contributed at boot by whichever capability package wants a
grant to exist, before any request is validated
(`packages/capability/src/contract.ts:75-80`, `packages/capability/src/registry.ts:62-72`).
This is the seam that lets `@clarvis/loop` stay ignorant of `use_skills`,
`workflow` or the seven `tasks.*` grants while still refusing a
profile that names an undeclared one
(`packages/loop/src/validation/request/grant-registry.ts:22-39`).

The problem this subsystem solves is: given one `AgentProfile` (a model, a
`tools` allow-list and a `grants` array authored by a human or shipped as a
built-in), decide (a) which of `@clarvis/tools`' coding tools this agent's
toolset actually contains, (b) whether this agent can spawn children at all,
and (c) whether each optional capability (skills, ask-user,
workflows, tasks) contributes its own tools to this particular agent. The
grant string is the single input to all three decisions, and each decision is
made independently, by a different piece of code, at a different point in the
run's lifecycle (request validation, run-shape derivation, and per-agent
capability activation).

## 2. Surface

### 2.1 The grant type and its four built-ins

| Symbol | Signature | File:line |
|---|---|---|
| `BuiltinGrant` | `"ask_user" \| "read_workspace" \| "edit_workspace" \| "run_commands"` | `packages/capability/src/api.ts:317-318` |
| `Grant` | `BuiltinGrant \| (string & {})` — deliberately open | `packages/capability/src/api.ts:320-326` |
| `AgentProfile.grants` | `Grant[] \| undefined` | `packages/capability/src/api.ts:392-409` |
| `AgentProfile.tools` | `string[]` (MCP `server.tool` names; unrelated to grants) | `packages/capability/src/api.ts:392-409` |
| `AgentProfile.can_spawn` | `string[] \| undefined` — profile names this agent may spawn | `packages/capability/src/api.ts:392-409` |
| `AgentProfile.default_spawn` | `string \| undefined` | `packages/capability/src/api.ts:392-409` |
| `BUILTIN_GRANT_NAMES` | `["ask_user","read_workspace","edit_workspace","run_commands"]`, static discovery aid on `grantSchema.options` | `packages/loop/src/validation/request/grant-registry.ts:9-19`, `packages/loop/src/validation/request/profile-schemas.ts:119-122` |

### 2.2 Capability grant contribution

| Symbol | Signature | File:line |
|---|---|---|
| `CapabilityGrantDeclaration` | `{ readonly name: string; readonly entryCanSpawn?: boolean }` | `packages/capability/src/contract.ts:75-80` |
| `Capability.grants` | `readonly CapabilityGrantDeclaration[] \| undefined` | `packages/capability/src/contract.ts:137` |
| `CapabilityRegistry.registerGrant(declaration)` | throws on empty name; second registration of the same name is a silent no-op if identical, else throws | `packages/capability/src/registry.ts:62-71` |
| `CapabilityRegistry.grants()` | `readonly CapabilityGrantDeclaration[]`, registration order | `packages/capability/src/registry.ts:73-75` |
| `composeCapabilityRegistry(base, declarations)` | copies a registry, appending per-run grant declarations without mutating the host's long-lived one | `packages/capability/src/registry.ts:86-94` |
| `requireKnownGrants(data, registry?)` | throws `ValidationError("invalid_profile", …)` on the first grant not in `BUILTIN_GRANT_NAMES ∪ registry.grants()` | `packages/loop/src/validation/request/grant-registry.ts:22-39` |
| `RunCapabilityContext.entryGrants` | `readonly string[]` — the run's entry profile's own grants, sourced as `shape.entryProfile.grants ?? []` | `packages/capability/src/contract.ts:87`; sourced at `packages/loop/src/runtime/orchestrator.ts:222-230` |
| `SubagentCapabilitiesFactory` | `(grants: readonly string[] \| undefined) => AgentActivation` — the grant-gated per-subagent factory threaded into the spawn path | `packages/capability/src/contract.ts:337-339` |

### 2.3 Every grant name that actually exists in this repository

| Grant | Owner | Declares `entryCanSpawn` | File:line |
|---|---|---|---|
| `ask_user` | engine (`BuiltinGrant`) | no | `packages/capability/src/api.ts:317-318` |
| `read_workspace` | engine (`BuiltinGrant`) | no | `packages/capability/src/api.ts:317-318` |
| `edit_workspace` | engine (`BuiltinGrant`) | no | `packages/capability/src/api.ts:317-318` |
| `run_commands` | engine (`BuiltinGrant`) | no | `packages/capability/src/api.ts:317-318` |
| `use_skills` | `@clarvis/skills` | no | `packages/skills/src/capability.ts:55,92` |
| `workflow` | `@clarvis/workflows` | **yes** | `packages/workflows/src/capability.ts:53-61,137` |
| `tasks.read` | `@clarvis/tasks` | no | `packages/tasks/src/toolset.ts:12`, registered `packages/tasks/src/capability.ts:1486` |
| `tasks.create` | `@clarvis/tasks` | no | `packages/tasks/src/toolset.ts:13` |
| `tasks.assign` | `@clarvis/tasks` | no | `packages/tasks/src/toolset.ts:14` |
| `tasks.comment` | `@clarvis/tasks` | no | `packages/tasks/src/toolset.ts:15` |
| `tasks.progress` | `@clarvis/tasks` | no | `packages/tasks/src/toolset.ts:16` |
| `tasks.review` | `@clarvis/tasks` | no | `packages/tasks/src/toolset.ts:17` |
| `tasks.complete` | `@clarvis/tasks` | no | `packages/tasks/src/toolset.ts:18` |

Only `workflow` sets `entryCanSpawn: true`
(`packages/workflows/src/capability.ts:52-60`), which is what makes a
`workflow`-granted entry agent get a supervision registry even with an empty
`can_spawn` (§4.3). Deep semantics of each capability's own tools (`load_skill`,
`run_leader` and its
siblings, the ten `tasks.*` tools) belong to that capability's own document —
this document covers only the grant string that gates them.

### 2.4 Coding-toolset ceiling: env var and the grant→capability mapping

| Symbol | Signature | File:line |
|---|---|---|
| `CLARVIS_AGENT_TOOLS_ENABLED` | boolean, default `true` | `packages/capability/src/env.ts:111` |
| `CLARVIS_AGENT_TOOLS_CONFINE` | boolean, default `true` | `packages/capability/src/env.ts:112` |
| `CLARVIS_AGENT_TOOLS_MAX_GRANT` | `"none" \| "read" \| "edit" \| "exec"`, default `"edit"` at the loop/env-schema level | `packages/capability/src/env.ts:113` |
| `agentToolCaps(grants, ceiling)` | `(grants: readonly string[] \| undefined, ceiling: GrantCeiling) => { canRead, canMutate, canExec }` | `packages/loop/src/runtime/tools/builtin/grants.ts:39-54` |
| `agentToolsActive(env, grants)` | `boolean` — true iff `CLARVIS_AGENT_TOOLS_ENABLED` and the grants clear the `read` ceiling | `packages/loop/src/runtime/tools/builtin/grants.ts:64-67` |
| `AGENT_TOOL_NAMES` / `READ_ONLY_TOOL_NAMES` / `EDIT_TOOL_NAMES` / `EXEC_TOOL_NAMES` / `FILE_MUTATING_TOOL_NAMES` | derived tool-name sets | `packages/loop/src/runtime/tools/builtin/names.ts:4-52` |
| `createAgentToolset(opts)` | builds the per-agent `{ defs, names, dispatch }` gated by `canMutate`/`canExec` | `packages/loop/src/runtime/tools/builtin/toolset.ts:165-202` |
| `createAgentToolsCapability(opts?)` | the `tools` capability (`AGENT_TOOLS_CAPABILITY_NAME = "tools"`) | `packages/loop/src/runtime/capabilities/tools.ts:46,127-155` |

`@clarvis/code` sets the ceiling default to `"exec"` for its own process
(`packages/code/src/index.tsx`, `runInteractive`:
`process.env.CLARVIS_AGENT_TOOLS_MAX_GRANT ??= "exec"`),
above the loop's own schema default of `"edit"` (`packages/capability/src/env.ts:113`).

### 2.5 Built-in agent profiles' grant/spawn arrays

| Agent | `grants` | `can_spawn` | `default_spawn` | Production |
|---|---|---|---|---|
| `marshall` (default entry) | `edit_workspace, read_workspace, ask_user, run_commands, use_skills` | `coder, explorer, planner` | `coder` | `packages/kernel/src/config/builtin-agents/marshall.ts` |
| `admiral` | `workflow, read_workspace, edit_workspace, run_commands, ask_user, use_skills` | `coder, explorer, planner, marshall` | `coder` | `ADMIRAL.frontmatter` in `packages/kernel/src/config/builtin-agents/admiral.ts` |
| `coder` | `edit_workspace, run_commands, use_skills` | *(absent)* | *(absent)* | `CODER.frontmatter` in `packages/kernel/src/config/builtin-agents/coder.ts` |
| `explorer` | `read_workspace, use_skills` | *(absent)* | *(absent)* | `EXPLORER.frontmatter` in `packages/kernel/src/config/builtin-agents/explorer.ts` |
| `planner` | `read_workspace, use_skills` | *(absent)* | *(absent)* | `PLANNER.frontmatter` in `packages/kernel/src/config/builtin-agents/planner.ts` |

None of the three sub-agent profiles declares `can_spawn`
(`CODER.frontmatter`, `EXPLORER.frontmatter`, and `PLANNER.frontmatter` under
`packages/kernel/src/config/builtin-agents/` — no `can_spawn` key is present), which is
the data-level instance of "spawned children never inherit spawn" (§4.3).
`admiral.can_spawn` includes `"marshall"` as a `delegate_task` sub-agent target
(§4.4), which is a separate mechanism from workflow leader selection (§4.6) —
the two must not be conflated.

A shipped agent's `can_spawn`/`default_spawn` pair is not free-form data: every
name in a shipped agent's `can_spawn` must itself be a shipped agent name, and
a present `default_spawn` must be a member of that same `can_spawn` and must
never equal the agent's own name (`packages/kernel/tests/component/builtin-agents.test.ts`,
`test("every profile a shipped agent may spawn is itself shipped", …)`).

## 3. Data and formats

### 3.1 `grantSchema` — the syntactic shape of one grant string

```ts
// packages/loop/src/validation/request/profile-schemas.ts:119-122
export const grantSchema = Object.assign(
  z.string().min(1, "grants[] must each be a non-empty string").max(INPUT_LIMITS.toolNameChars),
  { options: BUILTIN_GRANT_NAMES },
);
```

`options` is described as "a static UI discovery aid" only
(`packages/loop/src/validation/request/grant-registry.ts:16`) — it lists only
the four built-ins; a capability-owned grant is syntactically valid here (any
non-empty string up to `INPUT_LIMITS.toolNameChars`) and is rejected later, at
`requireKnownGrants`, if the run's registry does not declare it
(`packages/loop/src/validation/request/grant-registry.ts:22-39`).

### 3.2 `AgentProfile.grants`' full description string (the authoritative contract text)

`packages/loop/src/validation/request/profile-schemas.ts:163-176` describes, in
one field, every grant semantics this document formalizes: `ask_user` is
"only honored on the entry agent" and inert on a sub-agent profile;
`read_workspace`/`edit_workspace`/`run_commands` are "capped by
CLARVIS_AGENT_TOOLS_MAX_GRANT"; `edit_workspace` "implies read"; `run_commands`
"implies edit"; and "capability-owned grants are admitted only when that
capability is registered for the run." The same description string closes with
a disclaimer that is not itself a grant rule but disambiguates the
vocabulary's boundary: "Receiving images is not a grant: a profile may be
seeded with turn images via `delegate_task` `image_refs`, and is eligible as
the automatic vision delegate, exactly when its model declares the 'vision'
capability" (same citation) — vision eligibility is model-declared, not
grant-gated, and is out of scope here; see [engine/vision-routing.md](../engine/vision-routing.md).

### 3.3 The `ReadinessContext`/`ReadinessProfile` shape (advisory pre-flight)

```ts
// packages/loop/src/validation/profile-readiness.ts:34-41
interface ReadinessProfile {
  model?: string;
  grants?: readonly string[];
  can_spawn?: readonly string[];
  default_spawn?: string;
  orchestration?: object;
  budget?: { on_exceed?: string; total_token_limit?: number };
}
// packages/loop/src/validation/profile-readiness.ts:44-64
interface ReadinessContext {
  profile: ReadinessProfile;
  registryNames: readonly string[];
  providerNames: readonly string[];
  defaultModel?: string;
  knownGrants?: readonly string[];
}
```

`knownGrants` is optional and the `unknown_grant` rule is skipped entirely when
it is absent (`packages/loop/src/validation/profile-readiness.ts:52-57,
177-190`) — a caller that supplies the built-ins plus its registry's
`grants()` gets true parity with `requireKnownGrants`; a caller that omits it
never reports a capability-owned grant as unknown.

### 3.4 `GrantCeiling` and `AgentToolCaps`

```ts
// packages/loop/src/runtime/tools/builtin/grants.ts:11-24
type GrantCeiling = "none" | "read" | "edit" | "exec";
interface AgentToolCaps { canRead: boolean; canMutate: boolean; canExec: boolean; }
```

`CEILING_RANK = { none: 0, read: 1, edit: 2, exec: 3 }`
(`packages/loop/src/runtime/tools/builtin/grants.ts:26`).

### 3.5 The coding-tool name sets (derived, not hand-maintained)

`@clarvis/tools`' own `toolDescriptors` table is the single source
(`packages/tools/src/tools/registry.ts:42-67`); the loop derives everything
else from it:

| Set | Derivation | Content (24 total tools) | File:line |
|---|---|---|---|
| `AGENT_TOOL_NAMES` | `tools.map(t => t.name)` | all 24 | `packages/loop/src/runtime/tools/builtin/names.ts:4` |
| `READ_ONLY_TOOL_NAMES` | `readOnlyTools.map(t => t.name)` | `read_file, read_image, read_files, list_dir, glob, grep, diff, file_stat, tree` (9) | `packages/loop/src/runtime/tools/builtin/names.ts:14`; source flags at `packages/tools/src/tools/registry.ts:43-45,51-54,65-66` |
| `EDIT_TOOL_NAMES` | `AGENT_TOOL_NAMES` minus `READ_ONLY_TOOL_NAMES` | `write_file, edit_file, multi_edit, apply_patch, replace, shell, host_vcs, monitor_start, monitor_poll, monitor_stop, monitor_list, move, copy, mkdir, remove` (15) | `packages/loop/src/runtime/tools/builtin/names.ts:19-21`; source flags `packages/tools/src/tools/registry.ts:46-50,55-64` |
| `EXEC_TOOL_NAMES` | hardcoded literal list, **not** derived from the tools package's own flags | `shell, host_vcs, monitor_start, monitor_poll, monitor_stop, monitor_list` (6) | `packages/loop/src/runtime/tools/builtin/names.ts:41-48` |
| `FILE_MUTATING_TOOL_NAMES` | `EDIT_TOOL_NAMES` minus sandbox command runners, retaining `host_vcs` for mutation presentation even though it is also exec-gated | `write_file, edit_file, multi_edit, apply_patch, replace, host_vcs, move, copy, mkdir, remove` (10) | `packages/loop/src/runtime/tools/builtin/names.ts` (`FILE_MUTATING_TOOL_NAMES`) |

Tool name strings verified individually at their definitions: `read_file`
(`packages/tools/src/tools/read-file.ts:32`), `read_image`
(`packages/tools/src/tools/read-image.ts:23`), `read_files` (`packages/tools/src/tools/read-files.ts:63`), `write_file`
(`packages/tools/src/tools/write-file.ts:28`), `edit_file` (`packages/tools/src/tools/edit-file.ts:239`), `multi_edit`
(`packages/tools/src/tools/multi-edit.ts:20`), `apply_patch` (`packages/tools/src/tools/apply-patch.ts:110`), `replace`
(`packages/tools/src/tools/replace.ts:122`), `list_dir` (`packages/tools/src/tools/list-dir.ts:25`), `glob` (`packages/tools/src/tools/glob.ts:28`), `grep`
(`packages/tools/src/tools/grep.ts:55`), `diff` (`packages/tools/src/tools/diff.ts:22`), `shell` (`packages/tools/src/tools/shell.ts:133`), `host_vcs` (`packages/tools/src/tools/host-vcs.ts:170`), `monitor_start`
(`packages/tools/src/tools/monitor.ts:178`), `monitor_poll` (`packages/tools/src/tools/monitor.ts:344`), `monitor_stop`
(`packages/tools/src/tools/monitor.ts:449`), `monitor_list` (`packages/tools/src/tools/monitor.ts:491`), `move` (`packages/tools/src/tools/move.ts:25`),
`copy` (`packages/tools/src/tools/copy.ts:26`), `mkdir` (`packages/tools/src/tools/mkdir.ts:21`), `remove` (`packages/tools/src/tools/remove.ts:20`),
`file_stat` (`packages/tools/src/tools/file-stat.ts:35`), `tree` (`packages/tools/src/tools/tree.ts:194`).

## 4. Behavior

### 4.1 Request-time grant validation (structural → semantic)

1. `parseRunRequest` parses `profiles[].grants` against `grantSchema` — any
   non-empty string, syntactically (`packages/loop/src/validation/request/profile-schemas.ts:119-122`).
2. The `registry` that validation checks against is **not** a static, boot-time
   object: `executeRun` builds it fresh on every call as
   `requestRegistry = composeCapabilityRegistry(deps.capabilityRegistry,
   allCapabilities.flatMap(capability => capability.grants ?? []))`, where
   `allCapabilities = [...(deps.capabilities ?? []), ...(capabilities ?? [])]`
   — the host's long-lived registry plus whatever `Capability` objects are
   actually wired into *this* call
   (`packages/loop/src/runtime/execute-run.ts:288-298`). The identical
   `profile.grants` array can therefore validate against one kernel
   construction and be rejected by another that wired fewer capabilities in;
   `runOrchestrator` performs the same flat-map independently when deriving
   `grantDeclarations` for `canSpawnChildren` (§4.3), falling back to it when
   `deps.grantDeclarations` is not precomputed
   (`packages/loop/src/runtime/orchestrator.ts:208-209`).
3. `validateBody` calls `requireKnownGrants(data, registry)` **before**
   `requireEntryShape`/`requireKnownSpawnTargets`/env-ceiling/provider checks
   (`packages/loop/src/validation/request-schema.ts:33-45`) — every grant on
   every profile must be in `BUILTIN_GRANT_NAMES ∪ registry.grants().map(d =>
   d.name)`, or the whole request is rejected with `ValidationError("invalid_profile", …)`
   naming the offending profile and grant
   (`packages/loop/src/validation/request/grant-registry.ts:22-39`).
4. No cross-field check at request-validation time enforces
   `CLARVIS_AGENT_TOOLS_MAX_GRANT`: a profile may declare `run_commands` even
   when the deployment ceiling is `"read"`; the grant is accepted and simply
   made inert later, at capability activation (§4.2). Grep of
   `packages/loop/src/validation/request/*.ts` for `MAX_GRANT` finds no
   reference outside the profile schema's description string
   (`packages/loop/src/validation/request/profile-schemas.ts:167`).

### 4.2 Per-agent coding-toolset activation (the `tools` capability)

For each agent (entry or spawned), `createAgentToolsRunCapability.forAgent(scope)`
(`packages/loop/src/runtime/capabilities/tools.ts:205-260`):

1. Computes `caps = agentToolCaps(scope.grants, ctx.env.CLARVIS_AGENT_TOOLS_MAX_GRANT)`.
   `agentToolCaps` (`packages/loop/src/runtime/tools/builtin/grants.ts:39-54`):
   - `wantsRead = has(read_workspace) || has(edit_workspace) || has(run_commands)`
   - `wantsMutate = has(edit_workspace) || has(run_commands)`
   - `wantsExec = has(run_commands)`
   - each `wants*` is further ANDed with `CEILING_RANK[ceiling] >= CEILING_RANK[read|edit|exec]`.
2. If `!caps.canRead`, `forAgent` returns `null` — this agent gets **no**
   coding toolset at all, not even a read-only one
   (`packages/loop/src/runtime/capabilities/tools.ts:207`).
3. Otherwise `createAgentToolset({ workspaceRoot, canMutate: caps.canMutate,
   canExec: caps.canExec, … })` is built
   (`packages/loop/src/runtime/tools/builtin/toolset.ts:201-202`):
   - `resolveConfig({ readOnly: !canMutate, … })` — `@clarvis/tools` itself
     restricts to `readOnlyTools` whenever `canMutate` is false
     (`packages/loop/src/runtime/tools/builtin/toolset.ts:121-141`,
     `packages/tools/src/core.ts:134-141`, `packages/tools/src/tools/registry.ts:83-92`).
   - Then, independently, `createAgentToolsetWithAdapter` filters out every
     `EXEC_TOOL_NAMES` member whenever `canExec` is false, even from an
     otherwise-full (`canMutate: true`) definition list
     (`packages/loop/src/runtime/tools/builtin/toolset.ts:169-172`).
   - Net effect per ceiling tier: `read` → the 9 read-only tools only; `edit` →
     read-only + the 9 non-exec members of `FILE_MUTATING_TOOL_NAMES`, with no `shell`, `host_vcs`,
     or `monitor_*`; `exec` → all 24. `host_vcs` stays in the mutation-presentation set but is also an
     exec tool because it crosses the sandbox boundary to run one guard-reviewed host executable
     (`packages/tools/src/tools/host-vcs.ts:160-176`).
4. `dispatch(name, …)` on the built toolset rejects any call whose `name` is
   not in the filtered `names` set with `{ isError: true, text: "Tool '<name>'
   is not available to this agent." }`
   (`packages/loop/src/runtime/tools/builtin/toolset.ts:177-183`) — a
   second, independent gate at call time, not just at advertisement time.

### 4.3 Whether an agent can spawn children at all

`canSpawnChildren(shape, declarations)`
(`packages/loop/src/runtime/spawn-shape.ts:18-29`):

```
if shape.isLead → true
else → (shape.entryProfile.grants ?? []).some(g ⇒ g ∈ {d.name | d ∈ declarations, d.entryCanSpawn === true})
```

`shape.isLead` is `(entry.can_spawn?.length ?? 0) > 0`
(`packages/loop/src/validation/request/run-shape.ts:19`,
mirrored at `packages/loop/src/runtime/run-shape.ts` via `deriveRequestShape`).
This is the **only** gate on whether the run gets a supervision registry
(`AgentRegistry`) and, with it, the five supervision tools
(`agent_list`/`agent_poll`/`agent_stop`/`agent_steer`/`await_agents`) — a solo
run's schema never contains them
(`packages/loop/src/runtime/spawn-shape.ts:14-17`). A non-lead entry (empty
`can_spawn`) becomes spawn-capable only by carrying a grant some registered
capability declared `entryCanSpawn: true` for — in this codebase, only
`workflow` (`packages/workflows/src/capability.ts:52-60`).

`createAgentsRunCapability` — the capability that actually contributes the
five supervision tools — is itself only added to the run's capability list
when this registry was created (`agents !== undefined`)
(`packages/loop/src/runtime/entry-inputs.ts:210-216`), and once added its own
`forAgent` gates solely on `if (!scope.entry) return null;` — no grant of any
kind is checked a second time at that point
(`packages/loop/src/runtime/capabilities/agents.ts:471`). So the grant (or
`can_spawn`) decides only whether the registry — and with it the capability —
exists at all for this run; once it exists, every entry agent gets all five
tools unconditionally, with no way for a profile author to grant spawning
without also granting supervision visibility, or vice versa.

### 4.4 Spawning a sub-agent (`delegate_task`): grant/topology at spawn time

1. The spawnable-profile registry is built **only** from the entry profile's
   own `can_spawn` list, never from a spawned child's:
   `spawnableRegistry = new Map(request.profiles.filter(p ⇒
   canSpawn.includes(p.name)).map(p ⇒ [p.name, registry.get(p.name)]))`
   (`packages/loop/src/runtime/run-shape.ts:79-83`). Since no shipped
   sub-agent profile declares its own `can_spawn`
   (`CODER.frontmatter`, `EXPLORER.frontmatter`, and `PLANNER.frontmatter` under
   `packages/kernel/src/config/builtin-agents/`), and since delegation targets are drawn only from this
   registry, tree depth is structurally bounded at 2 for the shipped fleet.
2. `validateDelegateTaskArgs` resolves `profile`: an explicit `obj.profile`
   must be a key of `profiles` (the spawnable registry) or the call is
   rejected with `unknown profile '<name>'`
   (`packages/loop/src/runtime/subagents/delegate-task.ts:105-112`); omitted,
   it falls back to `defaultProfile` (the entry's `default_spawn`) when that
   name is itself in the registry, else the sole spawnable profile, else the
   call is rejected as requiring a named profile
   (`packages/loop/src/runtime/subagents/delegate-task.ts:114-122`).
3. The spawned child's capability activation uses **its own** profile's
   grants, not the entry's: `ctx.capabilitiesFor?.(selectedProfile.grants)`
   (`packages/loop/src/runtime/subagents/delegate-task.ts:402`), typed as the
   `SubagentCapabilitiesFactory` declared at `packages/capability/src/contract.ts:337-339`
   and threaded in as `packages/loop/src/runtime/subagents/delegate-task.ts:213`'s `capabilitiesFor?:
   SubagentCapabilitiesFactory` field. It is folded per-agent through
   `capabilitiesForScope`/`activationForScope`
   (`packages/capability/src/compose.ts:42-50,63-71`) — the same generic
   per-agent gate every `RunCapability.forAgent(scope)` uses, `scope.grants`
   being the spawned profile's own array
   (`packages/loop/src/runtime/subagents/run-subagent.ts:161-162` sets
   `agent: "subagent"`; grants flow in via `agentCapabilities`, computed at
   step 3 above rather than re-derived inside `runAgent`).

### 4.5 Entry-only grant: `ask_user`

The ask-user capability gates on the run's **entry** grants (`ctx.entryGrants`, always
`shape.entryProfile.grants ?? []` — `packages/loop/src/runtime/orchestrator.ts:230`)
and additionally restrict `forAgent` to `scope.entry === true`, so even a
sub-agent profile that independently names the grant never receives the tool.
The internal `forRun`/`forAgent` derivation below goes one level deeper than
"which grant gates this tool" because entry-only visibility is the relevant invariant:

- `ask_user`: `forRun` returns `null` unless `ctx.entryGrants.includes("ask_user")`;
  `forAgent` returns `null` for any non-entry scope, or when the scope lacks a
  serialized `elicit`/`clock`
  (`packages/loop/src/runtime/capabilities/ask-user.ts:38-49`). The profile
  schema calls this grant "inert" on a sub-agent profile
  (`packages/loop/src/validation/request/profile-schemas.ts:165`), and the
  engine independently surfaces it as the static warning
  `subagent_ask_user_ignored` whenever any *spawnable* profile carries it
  (`packages/loop/src/runtime/usage-accounting.ts:45,54-56`) — see §6. At the
  tool-offering level itself, an integration test titled "ask_user tool
  injection is gated on the ask_user grant, not on user-input capability"
  asserts both directions directly: an entry profile without the grant is not
  offered `ask_user`, and one with the grant is
  (`packages/loop/tests/integration/ask-user-grant-gating.test.ts:19-56`).

### 4.6 `workflow`, `run_leader` and the boundary with `can_spawn`

`admiral`'s `can_spawn` array (`coder, explorer, planner, marshall`,
`ADMIRAL.frontmatter` in `packages/kernel/src/config/builtin-agents/admiral.ts`) governs its
`delegate_task` sub-agent targets exactly as in §4.4 — it is unrelated to which
profiles `run_leader`/`run_work_items`/`run_round` may launch as a leader.
Those tools enumerate `LeaderProfileInfo[]` supplied by the kernel's
`WorkflowPolicy.leaderProfiles()`
(`packages/kernel/src/application/workflow-policy.ts:11,48`,
`packages/workflows/src/tool.ts:24-47`) — a separate list, constructed by
kernel policy. This document only establishes that the two lists are
independently sourced; the workflow tool surface itself is
`@clarvis/workflows`' own item.

A leader run's request is not simply built from the launching manager's own
profile: `ADMIRAL.body` states the effective topology fact that a leader "cannot start leaders"
(`packages/kernel/src/config/builtin-agents/admiral.ts`), and the
kernel's workflow service carries this out mechanically —
`stripWorkflowGrant(body)` filters `"workflow"` out of every profile's
`grants` array on the assembled leader request, called immediately after
`assembleRunRequest` builds it
(`packages/kernel/src/workflows/workflows-service.ts:379`, the function itself
at `:720-729`, doc-commented "so a leader can never become a manager
(defense-in-depth beyond not injecting the capability into leaders)"). So a
leader can never itself call `run_leader` or spawn a further workflow level, even if its
launching manager's own profile — copied wholesale into the leader request
except for this one filtered field — carried `workflow`.

## 5. Invariants

1. **A profile's grant is accepted only if it is engine-built-in or
   registered by some capability in this run's registry, and the whole
   request is rejected otherwise.**
   Production: `packages/loop/src/validation/request/grant-registry.ts:22-39`.
   Test: `packages/loop/tests/unit/request-grant-registry.test.ts:10-26` (accepts
   every `BUILTIN_GRANT_NAMES` member; rejects `"manage_widgets"` with
   `invalid_profile` until a registry declares it, then accepts).

2. **`agentToolCaps` derives `canRead`/`canMutate`/`canExec` from
   `read_workspace`/`edit_workspace`/`run_commands` with the implication chain
   `run_commands ⇒ edit_workspace ⇒ read_workspace`, each further clamped by
   the ceiling's rank.**
   Production: `packages/loop/src/runtime/tools/builtin/grants.ts:39-54`.
   Test: `packages/loop/tests/unit/grants.test.ts:4-60` (empty/irrelevant
   grants → all false; `read_workspace` alone → read only; `edit_workspace` →
   read+mutate; `run_commands` → all three; ceiling of `"none"`/`"read"`/`"edit"`
   clamps `run_commands` down accordingly).

3. **A run's spawn-capability (whether it gets a supervision registry) is
   `isLead OR grants ∩ {declared entryCanSpawn grants} ≠ ∅` — nothing else.**
   Production: `packages/loop/src/runtime/spawn-shape.ts:18-29`.
   Test: `packages/loop/tests/unit/spawn-shape.test.ts:18-31` (non-lead with an
   unrelated or non-spawn-declared grant stays solo; a lead is always
   spawn-capable regardless of declarations; a non-lead carrying a grant
   declared `entryCanSpawn: true` becomes spawn-capable, an undeclared one
   does not).

4. **The engine's readiness pre-check (`unknown_grant`) and the hard
   `requireKnownGrants` validator agree exactly, rule for rule, when the
   readiness caller supplies the same known-grants set the registry would.**
   Production: `packages/loop/src/validation/profile-readiness.ts:177-190`
   (mirrors `requireKnownGrants`, skipped when `knownGrants` is omitted).
   Test: `packages/loop/tests/unit/profile-readiness.test.ts:106-206` — a
   parametrized table asserts every `PROFILE_READINESS_RULES` code (including
   `unknown_grant`) both makes `validateBody` throw on the matching request
   body and makes `profileReadinessIssues` flag the matching advisory context,
   and `it("covers every rule in the table exactly once", …)` (line 193) pins
   that the parity table and the rule table never drift apart.

5. **`ask_user` activates only for the run's entry agent, never for a spawned
   sub-agent, even when the sub-agent's own profile carries the grant.**
   Production: `packages/loop/src/runtime/capabilities/ask-user.ts:38-49`.
   Test (ask_user side, capability-visibility level):
   `packages/loop/tests/integration/ask-user-grant-gating.test.ts:19-56`
   (an entry profile without the grant is not offered `ask_user`; one with the
   grant is). Test (ask_user side, advisory level):
   `packages/loop/tests/integration/subagent-config-warnings.test.ts:93-101`
   (a spawnable sub-agent declaring `ask_user` still surfaces
   `subagent_ask_user_ignored` rather than gaining the tool — the warning
   exists precisely because the grant is inert there).

6. **`createAgentToolset`'s `dispatch` refuses any tool name outside its own
   ceiling-filtered `names` set, independent of whatever `@clarvis/tools`
   itself would allow; the exec partition includes both sandboxed `shell` and
   host-boundary `host_vcs`.**
   Production: `packages/loop/src/runtime/tools/builtin/toolset.ts:165-184`
   (the `!names.has(name)` branch returns an error result rather than
   forwarding to `resolved.dispatch`).
   Test: `packages/loop/tests/unit/toolset.test.ts`
   (`it.each(["shell","host_vcs","unknown"])("refuses unavailable tool %s without
   dispatching", …)` asserts `dispatch` resolves to `{ isError: true, text:
   "Tool '<name>' is not available to this agent." }` for both a
   ceiling-filtered tool and an unknown name, and that the underlying adapter
   is never called).

7. **A capability's own grant declaration is idempotent under re-registration
   with the identical shape, and throws on a re-registration that disagrees.**
   Production: `packages/capability/src/registry.ts:62-71`
   (`if (existing.entryCanSpawn === declaration.entryCanSpawn) return;` else
   throw `capability grant '<name>' is already registered differently`).
   Test: `packages/capability/tests/unit/registry.test.ts:46-55` (an identical
   repeat is a silent no-op) and `:57-64` (a disagreeing repeat throws
   `"already registered differently"`; an empty name throws `"non-empty"`).

8. **`composeCapabilityRegistry` never mutates the host's long-lived
   registry** — the composed copy carries the base's specs and grants plus the
   per-run declarations, and the base's own `specs()`/`grants()` are unchanged
   afterward.
   Production: `packages/capability/src/registry.ts:86-94`.
   Test: `packages/capability/tests/unit/registry.test.ts:66-82` (`it("composes
   an isolated per-run registry without mutating the base", …)` — the composed
   registry carries the base's one spec plus both new grant declarations,
   while `base.grants()` still equals `[{ name: "inspect" }]` afterward).

## 6. Failure modes and degradation

| Condition | What happens | File:line |
|---|---|---|
| Profile grant not in built-ins or the run's registry | Whole request rejected at validation: `ValidationError("invalid_profile", "profile '<name>'.grants contains undeclared grant '<grant>'.")` | `packages/loop/src/validation/request/grant-registry.ts:33-37` |
| Agent's grants clear no `read` ceiling (`!caps.canRead`) | `tools` capability's `forAgent` returns `null` — the agent gets no coding toolset, not a degraded one | `packages/loop/src/runtime/capabilities/tools.ts:205-207` |
| `CLARVIS_AGENT_TOOLS_ENABLED=false` | The whole `tools` capability's `forRun` returns `null` for every agent in the run, regardless of grants | `packages/loop/src/runtime/capabilities/tools.ts:130-131` |
| A spawnable sub-agent profile has no `tools` and no active built-in coding tools | Static usage warning `subagent_has_no_tools` (still runs; advisory only) | `packages/loop/src/runtime/usage-accounting.ts:44-52`; tested `packages/loop/tests/integration/subagent-config-warnings.test.ts:52-89` (builtin-aware: a read_workspace-only sub-agent does **not** warn; `CLARVIS_AGENT_TOOLS_ENABLED=false` makes that same grant inert and the warning reappears) |
| A spawnable sub-agent profile carries `ask_user` | Static usage warning `subagent_ask_user_ignored` (the grant itself stays syntactically legal and structurally inert, per §5 invariant 5) | `packages/loop/src/runtime/usage-accounting.ts:45,54-56`; tested `packages/loop/tests/integration/subagent-config-warnings.test.ts:92-108` |
| A `delegate_task` call names a `profile` not in the spawnable registry | Call rejected: `{ ok: false, message: "unknown profile '<name>'. Registered profiles: …" }` | `packages/loop/src/runtime/subagents/delegate-task.ts:105-112` |
| `delegate_task` omits `profile`, no usable default | Call rejected: `"profile is required — name the profile this Sub-agent should run as."` | `packages/loop/src/runtime/subagents/delegate-task.ts:118-122` |
| A tool call names something outside the agent's ceiling-filtered set | `dispatch` returns `{ isError: true, text: "Tool '<name>' is not available to this agent." }` rather than throwing | `packages/loop/src/runtime/tools/builtin/toolset.ts:177-183` |
| The abort signal fires mid-dispatch | `raceAbort` resolves to `{ isError: true, text: "Tool call aborted (run cancelled)." }`, listener always removed | `packages/loop/src/runtime/tools/builtin/toolset.ts:96-118` |

## 7. Coupling

- **`@clarvis/capability` is upstream of everything here.** `BuiltinGrant`,
  `Grant`, `CapabilityGrantDeclaration`, `CapabilityRegistry` and
  `activationForScope`/`capabilitiesForScope` all live there
  (`packages/capability/src/api.ts:317-326`, `packages/capability/src/contract.ts:75-80`,
  `packages/capability/src/registry.ts`, `packages/capability/src/compose.ts:42-71`), and every consumer (`loop`, `skills`,
  `workflows`, `tasks`) imports the type from it rather than
  redeclaring it — a static, compile-time edge.
- **`@clarvis/loop`'s `grant-registry.ts` is the only place `BUILTIN_GRANT_NAMES`
  is combined with a host's `CapabilityRegistry.grants()`.** This forces every
  host that wants a capability's grant to be legal to register that
  capability's grant declaration into the registry **before** calling
  `validateBody`/`parseRunRequest` — the comment on `CapabilityRegistry`
  itself states this ordering requirement
  (`packages/capability/src/registry.ts:16-17`: "Registration must happen
  before settings are parsed, or the block reads as an unrecognized key" — the
  settings case, the same ordering constraint applies to grants via
  `composeCapabilityRegistry`, `packages/capability/src/registry.ts:86-94`).
- **`packages/loop/src/runtime/tools/builtin/grants.ts` has no import of
  `@clarvis/tools`** (confirmed by its own file: only `EnvConfig` from
  `@clarvis/capability`, `packages/loop/src/runtime/tools/builtin/grants.ts:1`)
  — this is deliberate per its own doc comment ("dep-free grant logic, no
  @clarvis/tools import", `packages/loop/src/runtime/tools/builtin/grants.ts:58`),
  so the core loop can gate persona wording/accounting/vision on
  `agentToolsActive` without pulling in the optional `tools` package. Only
  `names.ts` and `toolset.ts` (also under `runtime/tools/builtin/`) import
  `@clarvis/tools` directly.
- **`spawn-shape.ts`'s `canSpawnChildren` depends only on `RunShape` and
  `CapabilityGrantDeclaration[]`** (`packages/loop/src/runtime/spawn-shape.ts:1-6`)
  — it does not know which capability declared a spawn grant, only that one
  did; this is what lets `workflow` (a package the loop treats as an optional
  capability) control whether the *engine's own* supervision registry exists,
  without the loop naming `@clarvis/workflows`.
- **`@clarvis/skills`, `@clarvis/workflows` and
  `@clarvis/tasks` each register their own grant(s) via `Capability.grants`**
  (`packages/skills/src/capability.ts:92`,
  `packages/workflows/src/capability.ts:137`,
  `packages/tasks/src/capability.ts:1486`) — a structural constraint of the
  `Capability` interface itself (`packages/capability/src/contract.ts:137`),
  not a convention; nothing forces a capability author to declare grants
  through any other channel because none exists.
- **The kernel (`packages/kernel/src/config/builtin-agents/*.ts`) is
  downstream of this whole vocabulary**: it authors the five shipped
  profiles' `grants`/`can_spawn`/`default_spawn` arrays as plain data, and
  those arrays are validated by the very `requireKnownGrants`/
  `requireKnownSpawnTargets` machinery documented here the moment a run
  starts — the kernel does not re-implement or bypass grant checking.
- **What depends on this document's subsystem, from outside**: `code`'s Run
  Controls / agent editor surfaces (which grant strings are legal, what
  `can_spawn` means) reads the same schema description text
  (`packages/loop/src/validation/request/profile-schemas.ts:163-193`) rather
  than a separate vocabulary — covered by the [hosts/code-domain-hubs.md](../hosts/code-domain-hubs.md) sibling document,
  not re-described here. That editor's `GRANT_CATALOG`
  (`packages/code/src/adapters/agents.ts:32`) is **not** a picker over every
  grant this document lists in §2.3: it holds exactly the four `BuiltinGrant`
  names plus a curated entry for two capability-owned grants (`use_skills`,
  `workflow`) — six total — and has no entry at all for the
  seven `tasks.*` grants `@clarvis/tasks` registers. Its own pinning test
  (`packages/code/tests/unit/agents.test.ts:58-61`) only checks that
  `GRANT_CATALOG` is a superset of `grantSchema.options`
  (`packages/loop/src/validation/request/profile-schemas.ts:119-122`), which is
  itself just `BUILTIN_GRANT_NAMES` — a "static UI discovery aid" per that
  schema's own remark, not the set of grants `requireKnownGrants` (§4.1) or
  `ConfigService.knownGrants()` (below) actually accepts on a real run. A
  profile carrying a `tasks.*` grant therefore renders in the built-in editor
  only through `grantBadges`' raw-id fallback, never as a selectable picker
  row; see `code-domain-hubs.md` invariant 17 for the corrected claim.
- **`@clarvis/kernel`'s own `ConfigService.knownGrants()` independently
  re-derives the same union** `executeRun` validates against, for UI-facing
  discovery: `[...BUILTIN_GRANT_NAMES, ...mergedRegistry.grants().map(g =>
  g.name), ...(runDeps.capabilities ?? []).flatMap(c => (c.grants ??
  []).map(g => g.name)), WORKFLOW_GRANT]`
  (`packages/kernel/src/kernel.ts:784-805`). The trailing hardcoded
  `WORKFLOW_GRANT` addendum exists because, per the function's own doc
  comment, "the workflows capability is injected into a manager's `executeRun`
  rather than into `runDeps`, deliberately — only an entry agent carrying this
  grant gets one. It is still a grant this kernel accepts, so a profile naming
  it is runnable and must not be reported otherwise." (same citation) — a
  fourth, independent re-derivation of the grant union beside `executeRun`'s
  own (§4.1) and `runOrchestrator`'s (§4.3).

## 8. Open questions

- **The exact runtime code path that computes `LeaderProfileInfo[]` inside
  `WorkflowPolicy.leaderProfiles()`** (`packages/kernel/src/application/workflow-policy.ts:48`)
  — i.e., which profiles are eligible to be launched as a leader, and whether
  that set is related to `can_spawn`, `admiral`'s own grants, or something
  else entirely — was not traced beyond confirming it is a separate,
  kernel-owned list (§4.6). Left to whichever sibling document owns
  `@clarvis/workflows`'/`@clarvis/kernel`'s workflow service.
- **Whether any request-time (not just runtime) cross-check exists tying
  `CLARVIS_AGENT_TOOLS_MAX_GRANT` to a profile's declared grants** — none is
  specified (§4.1, point 4); the absence itself is the finding, not an
  unexamined gap.
- **`INV-182`-style grant-based workflow routing** ("a run whose entry profile
  lacks the `workflow` grant is never routed through `WorkflowsService`") is
  covered by `packages/kernel/tests/integration/workflows-service.test.ts:509,527`;
  this document does not re-verify that kernel-side routing test, since the
  `WorkflowsService` itself belongs to a workflows/kernel sibling document — it is
  noted here only because it is a grant-gated routing decision.
