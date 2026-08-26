# Getting started

> Start Clarvis in a project, complete the first-run setup, choose a safety posture, run a useful
> task, and learn the few controls that keep you in charge of the session.

## Open the project you want Clarvis to work on

Start from the project directory that should become the active workspace:

```bash
cd path/to/your-project
clarvis
```

Clarvis operates on the current directory. The selected workspace owns its project-specific
settings, agent customizations, workflows, and session history.

## Complete the first-run setup

On a fresh configuration, Clarvis opens a short setup instead of an empty transcript:

1. Press **Enter** to begin.
2. Choose a recommended provider, select **Browse all providers** to search the complete catalog,
   or select **manual entry...** for a local server or private gateway.
3. Follow the matching path below. Setup saves as soon as the first provider and model are complete;
   you do not need to press **Ctrl+S** in this first-run flow.
4. Wait for the **Clarvis is ready** screen, verify the displayed agent and model, then press
   **Enter** to open the workspace.

### API provider from the catalog

1. Select the provider and press **Enter**.
2. Select the model you want to use first.
3. Enter the requested API key if the configured environment or credential store does not already
   provide it. Clarvis stores a typed value in its credential store and does not render it back into
   the terminal.
4. Wait while Clarvis saves the provider and makes `provider/model` the global default.

### ChatGPT or Grok subscription

This beta path depends on provider and account eligibility and does not imply provider endorsement
of Clarvis. If the subscription row is unavailable, use an API provider or a compatible local
endpoint instead.

1. Select the subscription row and start the displayed device flow.
2. Open or copy the verification URL, then enter the public device code on the provider's site.
3. Return to Clarvis and wait for the models available to that account.
4. Select the model you want to make available. Clarvis completes setup after saving the entitled
   model.

### Local server or private gateway

1. Select **manual entry...**.
2. Give the connection a stable provider name, such as `local-lab`.
3. Choose the API type. Use `openai-compatible` for an endpoint that implements that API.
4. Set the complete API root, such as `http://127.0.0.1:11434/v1`.
5. Configure a credential environment variable only when the endpoint requires one.
6. Press **A** from the provider detail, enter the exact server model ID such as
   `qwen2.5-coder:7b`, and press **Enter**. Provider-native tags after `:` are supported.

The resulting model reference is `local-lab/qwen2.5-coder:7b`. The manual flow starts with a
128,000-token context window; review the model later in `/settings/providers` if the server publishes
a different limit.

Setup makes the selected model your default, enables the ordinary command-review, memory, and
planning defaults, and selects `marshall` as the initial lead agent. It does not create agent or
workflow files: the standard fleet and built-in workflows are already available.

If the provider catalog cannot be loaded, exit setup, run `clarvis --refresh-models`, and start
`clarvis` again. A custom or local provider remains available through **manual entry...** even when
the public catalog is unavailable.

If Clarvis finds an existing configuration that cannot start a run, it opens a focused repair screen
for the first blocking issue. `/doctor` remains available later when you want the complete readiness
report.

## Review the safety posture

Before requesting a change, check which safety preset is active. On an enhanced keyboard path,
**Alt+S** opens the safety-preset picker. You can always reach the same controls through
`/settings/controls`.

The presets combine two independent choices: whether commands run inside the sandbox, and whether a
human or model reviews risky commands. `free` and `judged` run outside the sandbox and therefore
require an additional danger confirmation before Clarvis applies them.

For a fuller explanation of sandboxing, command review, and the available presets, continue to
[Safety and control](/guide/safety). For settings fields and precedence, use the
[configuration reference](/reference/configuration).

## Give Clarvis a first task

The composer accepts ordinary language. Start with a bounded, read-only request so you can see how
the transcript, tools, and approvals work together:

```text
Review this repository and explain how its test suite is organized. Do not edit files.
```

Press **Enter** to send. While the run is active, the composer changes from a new-task input to a
steering input. A follow-up such as this joins the same run instead of starting a second one:

```text
Focus on the integration tests and call out any obvious coverage gaps.
```

When you are ready to make a change, state the outcome, important constraints, and how you expect it
to be verified:

```text
Add validation for empty display names. Preserve the existing error style, run the focused tests,
and summarize the files you changed.
```

Clarvis may ask you to approve a command, answer a question, or review a proposed plan. Read the
request and its effects before accepting it; the agent continues from your decision.

## Use the essential controls

The active footer shows the bindings that apply to the current screen. These defaults are the ones
worth learning first:

| Control    | What it does                                                                        |
| ---------- | ----------------------------------------------------------------------------------- |
| **Enter**  | Send a new task or steer the active run.                                            |
| **Ctrl+J** | Insert a newline in the composer.                                                   |
| **Escape** | Clear a draft, close the current layer, or return to its parent.                    |
| **Ctrl+C** | Cancel active work; when idle, use the displayed confirmation to quit.              |
| **Alt+S**  | Open safety presets when the terminal supports the enhanced keyboard path.          |
| `/help`    | Open the full-page reference for actions, destinations, syntax, and effective keys. |

Type a bare `/` to browse available commands. The list is contextual, so it shows only routes and
actions that are currently usable. If a terminal cannot deliver an enhanced key reliably, use the
slash route or visible footer action instead.

## Continue or start fresh

Clarvis persists sessions for the current workspace.

- `/sessions` opens the session browser.
- `clarvis --continue` resumes the most recently used session for the current workspace.
- `/status` shows the active agent, model, run state, and usage.
- `/export` writes the complete persisted transcript to a file.
- `/clear` archives the current session and starts a fresh one.

Use `/compact` when you deliberately want to reduce the context carried into the next model call.
You can add a short instruction, such as `/compact preserve the API decisions and unresolved test
failure`, to tell the agent what the summary must retain.

## Choose what to learn next

- [Daily use](/guide/daily-use): steering, plans, sessions, transcripts, and the normal operator
  loop.
- [Safety and control](/guide/safety): workspace trust, sandboxing, command review, and presets.
- [Configuration](/reference/configuration): settings fields, scopes, defaults, and precedence.
- [Providers and models](/guide/providers-and-models): add API or subscription providers, manage
  models, and choose model and effort defaults.
- [Plans](/guide/plans) and [worktrees](/guide/worktrees): retain an execution record and isolate a
  branch in its own checkout.
- [Agents](/guide/agents): switch the current lead, customize a shipped agent, or create your own.
- [Skills](/guide/skills): give agents reusable, on-demand instructions.
- [Workflows](/guide/workflows): define repeatable multi-agent execution and inspect runs with
  `/workflow`.
- [MCP servers](/guide/mcp-servers) and [Hooks](/guide/hooks): connect tools and lifecycle
  automation.
- [Plugins](/guide/plugins) and [Marketplaces](/guide/marketplaces): install packaged extensions.
