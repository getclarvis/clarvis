# Agents

> Choose the right built-in agent, customize it safely, or create a focused agent for work you
> repeat.

## Choose from the built-in fleet

Clarvis is ready with five agents; no files need to be generated.

| Agent      | Best for                                                                               |
| ---------- | -------------------------------------------------------------------------------------- |
| `marshall` | General coding work. Investigates, implements, and delegates bounded work when useful. |
| `admiral`  | Running reusable workflows and coordinating independent leader runs.                   |
| `coder`    | One bounded implementation task. Intended primarily as a sub-agent.                    |
| `explorer` | Read-only investigation with concrete evidence.                                        |
| `planner`  | Read-only decomposition, dependencies, risks, and definition of done.                  |

Open `/agent` to change the active agent. **Enter** changes only the current session. Press **S** in
the picker to save the selected agent as a global or workspace default. A workspace default wins
over a global default.

## Create an agent

The built-in editor creates the file and starts from a read-only template:

1. Open `/settings/agents`.
2. Press **Ctrl+T** and choose global or workspace scope.
3. Press **A**, enter a name such as `reviewer`, and press **Enter**.
4. Open the new agent and review its description, grants, tools, model, iteration limit, spawn
   policy, and instruction prompt.
5. Press **Ctrl+S** after changing a field.
6. If you created it in workspace scope, approve the new executable configuration with
   `/workspace-trust`.
7. Open `/agent`, select `reviewer`, and press **Enter** to use it in the current session. Press
   **S** there only if it should become a persistent default.

The initial template can read the workspace but cannot edit it or run commands. Add permissions
only when the agent's job needs them.

### Create the file yourself

Agent definitions are Markdown files named after the agent. There is no generic `agent.md`: the
filename is the agent name. To create a workspace agent named `reviewer` manually:

```bash
mkdir -p .clarvis/agents
$EDITOR .clarvis/agents/reviewer.md
```

Put this complete definition in `.clarvis/agents/reviewer.md`:

```md
---
description: Reviews changes without modifying the workspace.
tools: []
grants:
  - read_workspace
  - use_skills
iteration_limit: 12
---

You are a read-only reviewer. Inspect the requested surface, verify claims against current source,
and report findings in severity order with precise file references. Do not edit files or run
mutating commands.
```

Approve a workspace agent with `/workspace-trust`, then select it through `/agent`. It inherits the
configured default model when used as the Lead. A declared `model: provider/model` wins when the
profile is spawned as a sub-agent; the configured user default remains authoritative for the Lead.

Common fields are:

| Field              | Meaning                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `description`      | Human-facing purpose shown in the agent picker.                                 |
| `model`            | Optional sub-agent model; the user default wins for the Lead.                   |
| `tools`            | MCP tools by dotted name, such as `project.search`.                             |
| `grants`           | Built-in capabilities such as workspace access, commands, skills, or workflows. |
| `can_spawn`        | Agents this lead may start.                                                     |
| `default_spawn`    | Default child; it must also appear in `can_spawn`.                              |
| `iteration_limit`  | Soft Lead checkpoint in `escalate`; otherwise a hard per-agent cap.             |
| `reasoning_effort` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.                   |
| `budget`           | Optional run-budget policy.                                                     |

The Markdown body after the closing `---` is the agent's instruction prompt. Frontmatter controls
runtime capabilities; the body explains how the agent should use them.

Built-in workspace tools come from grants:

| Grant            | Capability                                                       |
| ---------------- | ---------------------------------------------------------------- |
| `read_workspace` | Read-only workspace inspection.                                  |
| `edit_workspace` | File mutation and read access.                                   |
| `run_commands`   | Shell commands plus edit and read access.                        |
| `ask_user`       | Ask the operator for input; meaningful only for the entry agent. |
| `use_skills`     | Discover and load skills.                                        |
| `workflow`       | Run workflow-manager capabilities from an entry agent.           |

`tools` lists MCP tools by dotted `server.tool` name. It does not grant file or shell access.

::: warning
Permissions come from grants and selected tools, not from the prose prompt. Give a custom agent only
the access its job requires.
:::

## Override a built-in agent

A file with a built-in name customizes only the fields it contains. The filename selects the
built-in to customize. You can create these files through `/settings/agents` or place them in the
global or workspace `agents/` directory. These are complete, minimal examples for every built-in:

`.clarvis/agents/marshall.md`:

```md
---
iteration_limit: 60
compaction:
  prompt: |
    Preserve accepted decisions, current implementation state, failed approaches, unresolved risks,
    and the exact next action. Keep concrete file paths and validation results.
---
```

`.clarvis/agents/admiral.md`:

```md
---
iteration_limit: 60
---
```

`.clarvis/agents/coder.md`:

```md
---
iteration_limit: 40
---
```

`.clarvis/agents/explorer.md`:

```md
---
iteration_limit: 40
---
```

`.clarvis/agents/planner.md`:

```md
---
iteration_limit: 40
---
```

Omitted fields continue to follow the built-in definition. An empty list intentionally removes an
inherited list. The blank Markdown body after the closing `---` is significant: it preserves the
built-in prompt. A non-empty body or `base_prompt` replaces that prompt, so add one only when a full
prompt replacement is intentional.

A trusted workspace file shadows a same-named global file; those two files are not merged together.
The selected file is shallow-merged over the built-in definition. Advanced fields such as `budget`,
`compaction`, `retry`, and `call_timeout_ms` currently require direct file editing.

Unknown frontmatter keys are preserved for forward compatibility and do not change runtime
behavior. Check field spelling carefully; `/doctor` reports invalid values, but an unknown typo may
simply have no effect.

### Give one entry agent its own run budget

Use a profile budget when this agent should have a different boundary from the top-level default:

```md
---
description: Reviews one bounded change without modifying the workspace.
grants:
  - read_workspace
iteration_limit: 20
budget:
  on_exceed: stop
  total_token_limit: 100000
  timeout_ms: 300000
---

Review the requested change and report findings with precise evidence. Do not modify files.
```

This budget applies when the profile is the entry agent and replaces the top-level budget as a
whole. For a spawned sub-agent, `iteration_limit` remains its hard cap.

### Override the compaction prompt

The supported compaction-prompt override is `compaction.prompt` inside an agent definition, as shown
for Marshall above. There is no standalone `compaction-prompt.md` and no top-level
`settings.json` compaction prompt.

The effective agent layer is resolved first: a trusted workspace agent file wins over a same-named
global file; otherwise the global file is used; otherwise the built-in definition is used. Its
non-empty `compaction.prompt` replaces Clarvis's built-in summarization prompt for that agent. If it
is absent, the built-in summarization prompt remains active. Clarvis still adds the current Lead
objective or sub-agent task to the compaction request.

To disable LLM summarization for one agent and use mechanical eviction instead, use:

```md
---
compaction:
  prompt_mode: none
---
```

`prompt_mode: none` cannot be combined with `compaction.prompt`.

If an override is malformed, Clarvis keeps the built-in agent unchanged and reports the rejected
file in `/doctor`. A malformed new custom agent has no built-in fallback and is unavailable.

## Choose global or workspace scope

Use `~/.clarvis/agents/<name>.md` for an agent you want everywhere, or
`<workspace>/.clarvis/agents/<name>.md` for a project-specific definition. `$CLARVIS_HOME` replaces
`~/.clarvis` when set. A workspace definition wins over a same-named global definition after trust
approval.

You can also manage definitions in `/settings/agents`. A shipped agent can be reset to its built-in
definition or forked under a new name; it cannot be deleted or renamed in place.

## See also

- [Workflows](/guide/workflows)
- [Scopes and workspace trust](/explanation/scopes-and-trust)
- [Configuration](/reference/configuration)
- [Skills](/guide/skills)
