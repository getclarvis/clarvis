# Configuration

> Understand where Clarvis reads user-owned configuration, how scopes combine, and which settings
> belong in each file.

## Configuration locations

Global configuration applies across workspaces:

```text
~/.clarvis/
├── settings.json
├── guard-judge.md
├── memory-policy.md
├── agents/
├── skills/
└── workflows/
```

Set `$CLARVIS_HOME` to replace `~/.clarvis`. Workspace configuration lives inside the current
project:

```text
.clarvis/
├── settings.json
├── guard-judge.md
├── memory-policy.md
├── agents/
├── skills/
└── workflows/
```

Clarvis-owned session, trace, credential, cache, and diagnostic state is stored separately from
these authored files. Use `/storage` to inspect and clean supported disposable state.

## Precedence

The general order is built-in defaults, enabled plugin contributions, global configuration, then
workspace configuration. Higher scopes win.

- Scalar defaults and most feature blocks use the nearest scope that defines them.
- Providers and MCP servers merge by name; a higher scope replaces a same-named entry.
- Enabled plugin and marketplace lists combine without duplicate entries.
- Hooks combine in scope order.
- Agent and workflow files resolve by name; workspace wins over global.

Sandbox settings merge by field. Scalar choices and `toolchains.include` use the nearest defined
value. `pass_env`, `toolchains.exclude`, and `toolchains.extra_paths` combine across scopes, while
`toolchains.excluded_paths` removes inherited extra paths. An empty workspace array therefore does
not erase an inherited union field.

Workspace executable configuration remains withheld until `/workspace-trust` approves its current
fingerprint.

## Edit settings safely

Prefer the built-in views for ordinary changes:

- `/settings/providers` manages providers and credentials.
- `/model` selects the default model.
- `/effort` selects default reasoning effort.
- `/settings/agents` manages agent files.
- `/settings/defaults` manages vision and run-budget defaults.
- `/settings/memory` manages execution memory.
- `/settings/sandbox` manages Bubblewrap.
- `/settings/controls` manages safety, review, memory, and planning.
- `/extensions` manages extension surfaces.

`settings.json` is strict JSON. Unknown keys, comments, trailing commas, and invalid nested values
make that scope invalid. `/doctor` reports the problem and can offer a revision-checked repair.

## Core settings

This example shows a valid safety and workflow configuration. Merge it with any existing top-level
object rather than creating a second JSON document.

```json
{
  "default_reasoning_effort": "high",
  "guard": {
    "type": "shell",
    "mode": "on",
    "allowed_commands": ["git status", "bun test"],
    "denied_commands": ["git push --force*", "rm -rf /*"]
  },
  "sandbox": {
    "type": "bubblewrap",
    "enabled": true,
    "availability": "required",
    "filesystem": "workspace-write",
    "network": "host",
    "toolchains": {
      "mode": "auto"
    }
  },
  "plans": {
    "mode": "review",
    "retention": "keep",
    "pending_task_nudges": 3
  },
  "workflows": {
    "max_concurrency": 4,
    "budget_tokens": 640000000
  }
}
```

Frequently used top-level keys are:

| Key                        | Purpose                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| `providers`                | Named model-provider connections.                                     |
| `default_model`            | Lead model in `provider/model` form.                                  |
| `default_vision_model`     | Optional model for reading images when the selected model cannot.     |
| `default_reasoning_effort` | Lead effort from `off` through `max`.                                 |
| `budget`                   | Default run token, timeout, and boundary behavior.                    |
| `agents`                   | Limits for live and retained sub-agents and their buffered output.    |
| `guard`                    | Command allow, deny, and review policy.                               |
| `sandbox`                  | Bubblewrap availability, filesystem, network, and environment policy. |
| `memory`                   | Execution-memory activation, model, budgets, and provider.            |
| `plans`                    | Planning mode, retention, and provider.                               |
| `tasks`                    | External task provider and its separately disabled-by-default writes. |
| `workflows`                | Workflow concurrency and aggregate token budget.                      |
| `hooks`                    | Lifecycle commands.                                                   |
| `mcpServers`               | External MCP server declarations.                                     |
| `enabledPlugins`           | Installed plugins to activate, in precedence order.                   |
| `marketplaces`             | Plugin marketplace Git URLs.                                          |

::: warning
Do not store raw API keys or subscription tokens in `settings.json`. Use the Providers credential
flow or an environment-variable reference.
:::

## Increase run budget and iteration limits

Clarvis does not expose one token budget for an entire session. It budgets one **run** at a time; a
session is the durable conversation and may contain many runs. If you want one task to spend more
tokens, change the run default. If you want an agent to take more model turns, change that agent's
`iteration_limit`.

### Increase the default run budget

Open `/settings/defaults`, press **Ctrl+T** to choose global or workspace scope, then edit:

- **When budget is exceeded**: `escalate` asks whether to continue; `stop` ends the run at the wall.
- **Total token limit**: cumulative input plus output tokens across the whole run, not one model
  response.

Press **Ctrl+S**. The new value applies to the next run. For example, this raises the soft threshold
to 50 million tokens:

```json
{
  "budget": {
    "on_exceed": "escalate",
    "total_token_limit": 50000000
  }
}
```

The product default is 40 million tokens per run and the default host ceiling is 200 million. An
agent definition may declare its own `budget`; when that agent is the entry agent, its value replaces
the complete top-level budget. The two budget objects are not merged field by field.

`timeout_ms` and `max_escalations` are valid budget fields but are not exposed by the Defaults view.
`timeout_ms` is an inactivity timeout rather than a total wall-clock duration. `max_escalations`
applies only to `escalate`; `stop` forbids that field and requires `total_token_limit`. Add the
advanced fields directly when needed:

```json
{
  "budget": {
    "on_exceed": "escalate",
    "total_token_limit": 50000000,
    "timeout_ms": 600000,
    "max_escalations": 8
  }
}
```

### Increase an agent's iteration limit

Open `/settings/agents`, press **Ctrl+T** for the intended scope, open the agent, edit **Iteration
limit**, and press **Ctrl+S**. A workspace override for Marshall that changes only this field is:

```md
---
iteration_limit: 75
---
```

Save it as `.clarvis/agents/marshall.md`. The blank body preserves Marshall's built-in prompt; only
the iteration limit changes. New agents use the same field in their own Markdown definition. The
host fallback is 50 iterations and the default host ceiling is 100; a built-in or custom profile may
declare a lower value. In `escalate` mode the entry agent's limit is a checkpoint that can ask to
continue. It remains a hard cap for spawned sub-agents, and `stop` mode makes it a hard wall.

### Raise a host ceiling

Values above a host ceiling are rejected. If you intentionally need a larger ceiling, set it in the
environment that starts Clarvis and keep the corresponding setting at or below it:

```bash
CLARVIS_TOKEN_CEILING=400000000 \
CLARVIS_ITERATION_CEILING=200 \
clarvis
```

These environment variables affect that Clarvis process. Configure them persistently in your shell
or launcher if agent files or settings rely on the higher values across restarts. Raising a ceiling
does not itself raise the active budget or iteration limit.

The other default ceilings are 600,000 ms for `timeout_ms` and 20 for `max_escalations`; their
environment names are `CLARVIS_TIMEOUT_CEILING_MS` and `CLARVIS_ESCALATION_CEILING`.

## Reload changes

Many settings apply to the next run. Use `/reconnect` when Clarvis tells you a provider, plugin, or
backend-level change needs a reload. Agent changes made through the UI refresh the available fleet.

## Prompt and memory control

These operator-authored controls have different jobs and precedence rules. Use the narrowest one
that matches the behavior you want to change.

### Memory editorial policy

Tell Clarvis what knowledge is worth recording with plain Markdown:

```text
~/.clarvis/memory-policy.md
<workspace>/.clarvis/memory-policy.md
```

The global policy applies everywhere and the workspace policy refines it for one project. When both
are present, Clarvis uses the global file first and then the workspace file; one does not replace the
other. Changes take effect on the next memory-indexing pass without a restart.

Write editorial guidance rather than storage instructions:

```md
Keep exact commands when a non-obvious flag is the point of the note.
Record why a workaround exists, not only the workaround.
Do not record customer names or fixture contents from this workspace.
```

This policy controls what is worth remembering. Clarvis still owns the memory structure and storage
mechanics.

### Command-review judge

Write the complete policy as plain Markdown:

```text
<workspace>/.clarvis/guard-judge.md
~/.clarvis/guard-judge.md
```

The non-blank workspace file wins, then the non-blank global file, then the built-in prompt. These
files replace one another; they are never concatenated.

### Context compaction

Compaction prompts belong to an agent definition, not to `settings.json` or a standalone Markdown
file:

```md
---
compaction:
  prompt: |
    Preserve accepted decisions, concrete file paths, validation evidence, unresolved risks, and the
    exact next action.
---
```

Resolve the effective agent first: trusted workspace file, otherwise global file, otherwise the
built-in agent. A declared `compaction.prompt` replaces the built-in summarization prompt for that
agent; omission keeps the built-in prompt. `compaction.prompt_mode: none` selects mechanical
eviction and cannot be combined with a custom prompt.

## See also

- [Scopes and workspace trust](/explanation/scopes-and-trust)
- [Providers and models](/guide/providers-and-models)
- [Plans](/guide/plans)
- [Safety and control](/guide/safety)
- [Agents](/guide/agents)
- [MCP servers](/guide/mcp-servers)
- [Hooks](/guide/hooks)
