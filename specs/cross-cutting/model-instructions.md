# Model instructions and tool guidance

> Owned jointly by the packages that assemble prompts and advertise tools. This document routes
> their instruction contracts; it does not replace their schemas, handlers or security gates.

## 1. Purpose

Give a model enough information to choose and use the available harness without carrying a generic
handbook into every call. Concision must not remove scope, authority, prerequisites, state meanings
or recovery instructions. These contracts are model-independent; deterministic tests verify their
content and runtime seams, not the accuracy of every large or small model.

## 2. Surface

The owned tool inventory has 70 declarations across the following surfaces. This is an inventory,
not a single request payload: grants, agent role, capability activation and host posture select what
a model actually sees. MCP resource tools are instantiated per connection; third-party tool names
and user-authored extensions are not a fixed inventory.

| Surface | Declarations | Source owner |
| --- | ---: | --- |
| Coding, files, search, shell and monitors | 23 | `toolDescriptors` in [tools/registry.ts](../../packages/tools/src/tools/registry.ts) |
| Independent and tracked child spawning | 2 | [lead-tools.ts](../../packages/loop/src/runtime/subagents/lead-tools.ts) |
| Child listing, polling, waiting, steering and stopping | 5 | `buildTools` in [agents.ts](../../packages/loop/src/runtime/capabilities/agents.ts) |
| Human question and structured completion | 2 | [ask-user-tool.ts](../../packages/loop/src/runtime/tools/ask-user-tool.ts), [submit-result-tool.ts](../../packages/loop/src/runtime/tools/submit-result-tool.ts) |
| Plans | 5 | [plan/tools.ts](../../packages/plan/src/tools.ts) |
| Memory | 7 | `MEMORY_TOOL_CONTRACTS` in [tool-contract.ts](../../packages/memory/src/tool-contract.ts) |
| External tasks | 10 | `TASK_TOOLS` in [toolset.ts](../../packages/tasks/src/toolset.ts) |
| Workflow spawning and sequence control | 6 | [tool.ts](../../packages/workflows/src/tool.ts), [work-items.ts](../../packages/workflows/src/work-items.ts), [run-round.ts](../../packages/workflows/src/run-round.ts), [run-workflow.ts](../../packages/workflows/src/run-workflow.ts) |
| Skill loading and resource reads | 2 | `loadSkillTool` and `readSkillResourceTool` in [skills/tool.ts](../../packages/skills/src/tool.ts) |
| Public MCP run and controls | 4 | [server/mcp/tools.ts](../../packages/server/src/mcp/tools.ts) |
| MCP resource listing and reading | 2 | [mcp-client/resources.ts](../../packages/mcp-client/src/resources.ts) |
| Auxiliary guard decision and workflow title | 2 | [guard/judge.ts](../../packages/kernel/src/guard/judge.ts), [workflow-title.ts](../../packages/kernel/src/workflows/workflow-title.ts) |

Prompt assembly also includes the five [built-in agents](../../packages/kernel/src/config/builtin-agents/index.ts),
the three [built-in workflows](../../packages/workflows/src/builtin-workflows/index.ts),
[compaction](../../packages/loop/src/runtime/context/compaction-prompt.ts),
[vision prepass](../../packages/loop/src/runtime/vision-prepass.ts),
[plan state and gate messages](../../packages/plan/src/capability/messages.ts),
[memory seed](../../packages/memory/src/seed.ts), [memory policy](../../packages/memory/src/capability.ts)
and [indexer instructions](../../packages/memory/src/indexer/request.ts),
[skill catalogs/bootstrap instructions](../../packages/skills/src/tool.ts),
[MCP instructions](../../packages/loop/src/runtime/mcp-instructions.ts),
the [host guard prompt](../../packages/code/src/adapters/guard-judge-prompt.ts) and workflow-title prompt.
The [entry seed](../../packages/loop/src/runtime/entry-seed.ts) composes active capability sections;
the [kernel config contract](../hosts/kernel-config.md) owns operator context and profile overrides.
Hooks contribute configured lifecycle results under the [hooks contract](../execution/hooks.md),
not a second built-in agent persona.

## 3. Data and formats

- Agent bodies contain role, collaboration limits and the minimum handoff/completion contract.
  Grants and schemas determine availability; naming a tool in prose does not grant it.
- Tool descriptions answer when to use the operation, what returns, and what to do after a bounded
  or rejected result. Parameter descriptions carry local constraints that a type alone cannot show.
- Runtime messages carry current state, identifiers, revisions and actionable recovery. Static
  prompts do not invent current values or repeat a complete catalog of optional tools.
- Foreign content retains its owner and scope. This audit does not rewrite user agent overlays,
  configured hooks, installed skills, external MCP schemas or server instructions.

Production: the surface owners above, `buildEntrySeed`, and the capability contributions. Selection
and prefix rules are specified in [grants](grants.md), [capability composition](../engine/capability-composition.md)
and [prompt caching](prompt-cache.md). Instruction edits must not reposition non-volatile live context.

## 4. Behavior

The built-in leads choose delegation only when it adds value and give children a self-contained
brief: necessary context, bounded scope, constraints and expected result. Children do not inherit
the caller's conversation and share its workspace. Concurrent reads can conflict with writes too.
Leaves return missing-context or authority blockers; they cannot invent access to a parent question
tool or spawn tools. Completion uses `submit_result` when exposed, otherwise final text.

Background handles, steering acknowledgements and first-child wakeups are not successful work
results. `await_agents` can wake while other children still run; inspect the returned state and
outcomes. A returned delegated plan task still needs lead review and an explicit terminal state.
Structured completion can be rejected by validation or a gate, so correct the reported condition
before retrying. Live-child and pending-task gates are recovery boundaries, not directions to
cancel useful work or fabricate completion.

Workflow scheduling protects declared conflicts within a batch, not across unrelated work or a
manager's own writes. A checkpoint requires its current revision and an explicit decision; a paused
sequence is not complete. Built-in verdict briefs supply the exact `finding_id` and distinguish
static inspection from checks a read-only verifier cannot run. Their acceptance predicate counts
refutations: `verify.accepted` meets that threshold; `verify.rejected` means not refuted, **not
confirmed**. Failed, missing or inconclusive evidence remains uncertain. Failed or cancelled leaders
may already have written files; workflow failure is not a workspace rollback.

Memory keeps its existing scoped/on-demand guidance. Skills load a named or description-matching
body through `load_skill`, then bundled files through `read_skill_resource`. Their write-authority,
resource paths, pagination and bootstrap exceptions are load-bearing rather than removable
verbosity. The same applies to guard decision isolation, Isolation Sandbox `require_escalated` /
`host_command` review, resource data limits and human-question semantics; their handlers and
authority contracts are unchanged by the instruction review.

## 5. Invariants

1. **Small role prompts retain the harness contract.** All five profiles state tool availability,
   delegated context isolation, shared workspace and conditional structured completion; leads keep
   supervision and leaves keep blocker handoff. Production: `MARSHALL`, `ADMIRAL`, `CODER`,
   `EXPLORER`, `PLANNER` in `packages/kernel/src/config/builtin-agents/`. Test:
   `packages/kernel/tests/component/builtin-agents.test.ts`. Per-profile text-estimate ceilings are
   280, 410, 160, 160 and 180 tokens respectively, with a 1150-token fleet ceiling. The estimate is
   `ceil(characters / 4)`, not provider tokenization; a run does not inject all five bodies together.
2. **Descriptions preserve usable command and recovery details.** Persistent commands route to
   `monitor_start`, not shell `&`; truncation names the lost end and continuation path; patch examples
   are executable. Production: descriptors under `packages/tools/src/tools/`. Test:
   `packages/tools/tests/component/core.test.ts`, `tool-surface.test.ts` in that directory, and
   `packages/tools/tests/integration/apply-patch.test.ts`. The complete advertised coding descriptor
   JSON ceiling is 21,000 characters; the regex contract suites retain the detailed engine evidence.
3. **Completion guidance agrees with gates.** A handle, returned task or rejected submission is not
   completion. Production: `buildSpawnSubagentTool`, `buildDelegateTaskTool`, `buildSubmitResultTool`,
   `createAgentsRunCapability` and `PENDING_TASKS_NOTE`. Test:
   `packages/loop/tests/unit/lead-tools.test.ts`, `submit-result-tool.test.ts`,
   `agents-capability.test.ts`, and `packages/plan/tests/unit/plan-messages.test.ts`; the existing
   delegation and finalization component suites exercise the actual gates.
4. **Built-in workflow verification receives its schema-required identity and preserves uncertainty.**
   Production: `BUILTIN_WORKFLOWS` and `VERDICT_SCHEMA` under `packages/workflows/src/`. Test:
   `packages/workflows/tests/unit/builtin-workflows.test.ts` interpolates every built-in round,
   checks finding identity, read-only limits and synthesis semantics; `schemas.test.ts` and the
   round tests cover validation/aggregation. The full three-definition JSON ceiling is 11,000
   characters; profiles, round structure, fanout and predicates are not changed to meet that bound.
5. **Cross-field requirements are visible before the first call.** Task review needs evidence,
   artifacts or `no_evidence_reason`; requesting publication fallback does not bypass its human
   gate. Installed workflow names carry their own required argument keys, not an ambiguous union.
   Production: `taskToolInputSchemas`/`TASK_TOOLS` in `packages/tasks/src/toolset.ts` and
   `buildRunWorkflowTool` in `packages/workflows/src/run-workflow.ts`. Test:
   `packages/tasks/tests/unit/tool-guidance.test.ts`, the task capability component suite, and
   `packages/workflows/tests/unit/run-workflow.test.ts`.
6. **Compaction preserves authority and continuity without executing transcript instructions.**
   Production: `DEFAULT_COMPACTION_PROMPT` and `COMPACTION_UPDATE_INSTRUCTION` in
   `packages/loop/src/runtime/context/compaction-prompt.ts`. Test:
   `packages/loop/tests/unit/compaction-guidance.test.ts` (combined 1500-character ceiling) and
   `llm-compaction.test.ts` (merged-anchor request). The vision prepass likewise treats images as
   data and marks unreadable details; its request remains tool-less, pinned in
   `packages/loop/tests/integration/image-vision-routing.test.ts`.
7. **Truncation is not silent instruction completeness.** MCP sections preserve attribution and
   append a truncation marker inside the existing 32,768-code-point ceiling. Production:
   `renderMcpInstructions` in `packages/loop/src/runtime/mcp-instructions.ts`. Test:
   `packages/loop/tests/unit/mcp-instructions.test.ts`, including astral Unicode input.
8. **MCP controls distinguish instructions from outcomes.** Run transport timeout/progress options
   are not tool arguments; steering acknowledgement is not completion; question responses use the
   active session's elicitation and requested schema. Production: descriptors in
   `packages/server/src/mcp/tools.ts` and `handleSteerTool` in `control-tools.ts`. Test:
   `packages/server/tests/component/control-tools.test.ts` and the run/elicitation component suites.

## 6. Failure modes and degradation

Text budgets can catch accidental expansion but cannot prove that wording is sufficient. Reducing
bytes by dropping a prerequisite, claiming unavailable tools, or confusing a state transition is a
regression even below budget. Conversely, a small role-body increase can restore a missing harness
contract while tool and workflow payloads shrink.

Malformed calls, permission gates, optimistic revision conflicts, incomplete output, missing evidence
and runtime budget exhaustion remain governed by their owning specs and handlers. Descriptions do
not weaken them. External instructions can still be large, stale or contradictory; attribution and
bounds do not semantically certify third-party content or grant extra authority.

## 7. Coupling

The owning package READMEs reviewed and updated for these changes are [kernel](../../packages/kernel/README.md),
[loop](../../packages/loop/README.md), [tools](../../packages/tools/README.md),
[plan](../../packages/plan/README.md), [workflows](../../packages/workflows/README.md),
[tasks](../../packages/tasks/README.md) and [server](../../packages/server/README.md).
Focused owners are [kernel config](../hosts/kernel-config.md), [tool dispatch](../engine/tool-dispatch.md),
[delegation](../engine/delegation-and-subagents.md), [compaction](../engine/context-compaction.md),
[vision](../engine/vision-routing.md), [tool surface](../execution/tools-contract.md),
[reads/search](../execution/tools-read-and-search.md), [mutation](../execution/tools-mutation.md),
[shell/monitor](../execution/tools-shell-and-monitor.md), [planning](../capabilities/plan-capability.md),
[workflow scheduling](../capabilities/workflows-scheduling.md), [workflow service](../capabilities/workflows-service.md),
[tasks](../capabilities/tasks-capability.md) and [MCP facade](../hosts/server-mcp.md).

Reviewed without changing their contracts: memory [README](../../packages/memory/README.md),
[capability](../capabilities/memory-capability.md) and [indexer](../capabilities/memory-indexer.md);
skills [README](../../packages/skills/README.md) and [spec](../execution/skills.md);
MCP client [README](../../packages/mcp-client/README.md) and [spec](../foundations/mcp-client.md);
[command guard](../execution/command-guard.md), [hooks](../execution/hooks.md),
[security](security.md), [prompt cache](prompt-cache.md) and [known issues](../known-issues.md).
Their scoped loading, trust and runtime contracts remain necessary; this is not a rewrite of every
unchanged string. No new package or dependency edge is introduced. Public guides remain owned by
`getclarvis/docs`; no public API or command changed here and no external guide update is required.

## 8. Open questions

There is no cross-provider, large-versus-small-model success-rate claim from these deterministic
tests. Such a claim needs a fixed task set, actual exposed-tool payloads, equal budgets and observed
completion/error rates on the selected models. Byte counts and static phrase assertions are not a
substitute. Native Windows/macOS checks likewise require their own environments.
