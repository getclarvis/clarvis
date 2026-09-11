# Agent system prompt

> **Package:** `@clarvis/loop` (composition), `@clarvis/kernel` (resolution, trust, overlay independence), `@clarvis/paths` (file locations), `@clarvis/code` (Settings → Agents), `@clarvis/skills` (catalog loading rule)
>
> **Ownership:** this document is the contract for the four-layer system head, the fleet-wide shared prompt, and how a user replaces or disables it. Profile identity remains an agent overlay. Capability sections remain capability-owned.

## 1. Purpose

Every agent — entry lead, spawned leaf, builtin, or user-created — receives two distinct instruction layers before any capability section:

- **Shared prompt** — fleet work policy common to every agent in the run.
- **Profile prompt** — identity and harness of marshall, admiral, coder, explorer, planner, or a user-authored agent.

Clarvis ships a comprehensive built-in operating prompt covering instruction precedence, durable authorization, autonomous completion, workspace discipline, Clarvis capabilities, verification, and communication. The operator can replace it globally, replace it for one workspace, disable it, or restore inheritance by deleting the override. Changing the shared prompt never rewrites or materializes profile files.

## 2. Surface

| Symbol | Role |
| --- | --- |
| `DEFAULT_SHARED_AGENT_PROMPT` | Built-in static policy text |
| `parseSharedPromptDocument` / `resolveSharedPrompt` | Pure parser and last-wins resolver |
| `sharedPromptForRun` | Request-field snapshot: omit ⇒ default, `""` ⇒ disabled |
| `buildSystemSections` | Ordered system head |
| `RunRequest.shared_prompt` | Snapshotted text stamped by the kernel assembler |
| `ConfigService.getSharedPrompt` / `writeSharedPrompt` / `deleteSharedPrompt` | Host CRUD |
| `GlobalPaths.sharedAgentPromptFile` / `WorkspacePaths.sharedAgentPromptFile` | `<global>/shared-agent.md` and `<ws>/.clarvis/shared-agent.md` |

Production: `packages/loop/src/runtime/prompts/shared-agent-prompt.ts`, `packages/loop/src/runtime/prompts/resolve-shared-prompt.ts`, `packages/loop/src/runtime/subagents/build-subagent-input.ts`, `packages/kernel/src/config/shared-prompt.ts`, `packages/paths/src/global.ts`, `packages/paths/src/workspace.ts`.

## 3. Data and formats

The override is a Markdown document with YAML frontmatter:

```markdown
---
mode: replace
---

# How you work

Your custom shared instructions...
```

Valid `mode` values:

- `replace` — the body replaces the inherited shared prompt wholesale. The body must be non-empty.
- `disabled` — no shared layer is injected. The body must be empty.

There is no `append`. Concatenation would make precedence and the cached prefix unpredictable.

Absence of the file means inherit. An empty file is not a silent disable.

The character ceiling is `INPUT_LIMITS.systemPromptChars`, the same generic system-prompt limit used by profile bodies.

## 4. Behavior

### 4.1 Composition order

`buildSystemSections` emits, skipping empty fields:

1. `# Environment` — dynamic, unchanged.
2. `sharedPrompt` — fleet policy.
3. `profilePrompt` — agent identity after overlay resolution. `basePrompt` remains a temporary alias of this field.
4. `capabilitySections` — skills, memory, tools, MCP, and other extensions.

Production: `buildSystemSections`. Test: `packages/loop/tests/unit/environment-section.test.ts`.

### 4.2 Resolution

Last-wins among *valid* layers: trusted workspace file, else global file, else `DEFAULT_SHARED_AGENT_PROMPT`. A winning `disabled` document omits the shared layer.

Invalid frontmatter, `replace` without a body, `disabled` with a body, an unreadable file, or an over-limit file is skipped whole. The resolver uses the next valid layer and records `{ scope, path, reason }`. It never concatenates fragments.

Production: `resolveSharedPrompt`. Test: `packages/loop/tests/unit/shared-agent-prompt.test.ts`.

### 4.3 Workspace trust

`shared-agent.md` is executable workspace instruction. Its digest is part of `workspaceTrustFingerprint`. An unapproved or changed workspace withholds the workspace file and falls back to global/builtin. A global override is operator configuration and does not depend on workspace trust. An operator write through ConfigService uses the same authorized-write path as agent files.

Production: `workspaceExecutableSurface`, `resolveStoreSharedPrompt`. Test: `packages/kernel/tests/component/shared-prompt.test.ts`.

### 4.4 Snapshot

The kernel assembler stamps `shared_prompt` onto the run request once: the winning text, or `""` when disabled. Entry seed, `spawn_subagent`, `delegate_task`, and `runSubagent` reuse that value. They do not re-read the file. A later run sees the latest file.

Production: `stampedSharedPrompt`, `createSettingsRunAssembler`, `createEntryInput`, `buildRunSubagentInput`. Test: `packages/kernel/tests/component/shared-prompt.test.ts`, `packages/loop/tests/integration/specialized-subagents.test.ts`.

### 4.5 Overlays and custom agents

A profile overlay replaces only that agent's `profilePrompt`. Builtin and user-created agents receive the same snapshotted shared prompt unless the layer is disabled.

### 4.6 Settings → Agents

The Agents panel lists Shared prompt ahead of agent rows. It shows effective source (`builtin`, `global`, `workspace`, `disabled`) and layer status (`inherited`, `active`, `rejected`). Edit, disable, and reset (delete the scoped file) act on the current settings scope. Opening a scope with no override starts from the current effective prompt with `mode: replace`. Cancel does not write. A rejected override is shown as rejected, never as active.

Production: `packages/code/src/views/config/AgentsPanel.tsx`, `packages/code/src/adapters/agents-store.ts`. Test: `packages/code/tests/integration/agents-panel-render.test.tsx`.

### 4.7 Skills catalog

The skills section still owns discovery and loading. It additionally tells the model: if the user names a skill, load it before acting; otherwise use judgement; the user's current instructions take precedence; if a skill is why the run must pause, identify the relevant `SKILL.md` rule.

Production: `renderSkillsSection`. Test: `packages/skills/tests/unit/tool.test.ts`.

## 5. Invariants

1. The system head order is Environment → sharedPrompt → profilePrompt → capabilitySections for entry and subagents.
   - Production: `buildSystemSections`
   - Test: `packages/loop/tests/unit/environment-section.test.ts`
2. Entry, leaves, overlays, and custom agents share one snapshotted shared prompt for the run.
   - Production: `RunShape.sharedPrompt`, `buildRunSubagentInput`
   - Test: `packages/kernel/tests/component/shared-prompt.test.ts`
3. An untrusted workspace never injects its `shared-agent.md`.
   - Production: `workspaceSharedPromptTrusted`
   - Test: `packages/kernel/tests/component/shared-prompt.test.ts`
4. Invalid layers fall back to a complete valid source and surface a diagnostic.
   - Production: `resolveSharedPrompt`
   - Test: `packages/loop/tests/unit/shared-agent-prompt.test.ts`
5. `DEFAULT_SHARED_AGENT_PROMPT` provides the complete built-in operating contract, stays within the generic system-prompt character limit, and does not interpolate run state. It has no separate token budget.
   - Production: `DEFAULT_SHARED_AGENT_PROMPT`, `INPUT_LIMITS.systemPromptChars`
   - Test: `packages/loop/tests/unit/shared-agent-prompt.test.ts`
6. Builtin profile bodies add role-specific collaboration and harness guidance without duplicating the shared operating policy.
   - Production: `packages/kernel/src/config/builtin-agents/`
   - Test: `packages/kernel/tests/component/builtin-agents.test.ts`
7. Source and diagnostics are host-facing; they are not copied into the model prompt.
   - Production: `ResolvedSharedPrompt`
   - Test: `packages/loop/tests/unit/shared-agent-prompt.test.ts`

## 6. Failure modes and degradation

| Failure | Degradation |
| --- | --- |
| Missing file | Inherit the next layer |
| Empty file / missing `mode` | Reject the layer; inherit |
| Invalid YAML or unknown mode | Reject the layer; inherit |
| `replace` with empty body / `disabled` with body | Reject the layer; inherit |
| Unreadable or over-limit file | Reject the layer; inherit |
| Untrusted workspace file | Withhold; inherit global/builtin |
| Explicit `disabled` | Omit the shared layer entirely |

## 7. Coupling

- `@clarvis/paths` owns the two file paths. Consumers must not join `"shared-agent.md"` by hand.
- `@clarvis/loop` owns the default text, parser, resolver, and system-head order. It does not read the files.
- `@clarvis/kernel` reads files, applies trust, stamps `RunRequest.shared_prompt`, and exposes ConfigService.
- `@clarvis/protocol` carries `SharedPromptView` / `SharedPromptWrite`.
- `@clarvis/code` edits the document in Settings → Agents.
- `@clarvis/skills` owns skill-loading guidance in its own section.
- Prompt-cache: Environment stays first because it is dynamic. The shared prompt is static for the run and sits immediately after it. Compaction does not duplicate the shared prompt into the summarizer.

## 8. Open questions

None. `append` is deliberately out of scope for this contract.
