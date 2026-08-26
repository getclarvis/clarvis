# Commands

> Find the stable CLI flags, interactive slash commands, and keyboard routes used in ordinary
> Clarvis operation.

## CLI commands

| Command                                | Result                                                            |
| -------------------------------------- | ----------------------------------------------------------------- |
| `clarvis`                              | Open the interactive TUI in the current workspace.                |
| `clarvis -p "<prompt>"`                | Run one headless prompt and stream plain text.                    |
| `clarvis --agent <name> -p "<prompt>"` | Use a specific agent in print mode.                               |
| `clarvis --format md -p "<prompt>"`    | Emit a Markdown transcript in print mode.                         |
| `clarvis --continue`                   | Resume the current workspace's most recent session.               |
| `clarvis --resume <session-id>`        | Resume a specific saved session.                                  |
| `clarvis --list`                       | List saved sessions and exit.                                     |
| `clarvis --delete <session-id>`        | Delete a session and its runs.                                    |
| `clarvis --refresh-models`             | Refresh the models.dev catalog and exit.                          |
| `clarvis --worktree [name]`            | Create or reopen a dedicated Git worktree.                        |
| `clarvis --ascii`                      | Use plain ASCII glyphs.                                           |
| `clarvis --debug[=<level>]`            | Write bounded diagnostics at `error`, `warn`, `info`, or `debug`. |
| `clarvis --update`                     | Explicitly update a managed installation and exit.                |
| `clarvis --version`                    | Print the current version.                                        |
| `clarvis --help`                       | Print CLI help.                                                   |

`--agent` and `--format` apply only to print mode. Clarvis does not perform an automatic update check
at startup; `--update` is an explicit operator action.

::: warning
Headless mode cannot answer interactive command, plan, or workflow reviews. Requests are denied
instead of hanging.
:::

## Interactive commands

Type `/` to search the commands available in the current context.

| Command               | Result                                                               |
| --------------------- | -------------------------------------------------------------------- |
| `/help`               | Open actions, destinations, syntax, and effective keyboard controls. |
| `/agent`              | Pick the active agent or save a default.                             |
| `/clear`              | Archive the current session and start fresh.                         |
| `/sessions`           | Resume, export, or delete sessions.                                  |
| `/status`             | Show agent, model, tokens, and run state.                            |
| `/export`             | Export the complete persisted transcript.                            |
| `/compact [request]`  | Compact context before the next model call.                          |
| `/diff`               | Open the focused or latest diff.                                     |
| `/plans`              | Browse plan history.                                                 |
| `/planning/review`    | Require approval before plan execution in this workspace.            |
| `/planning/normal`    | Restore ordinary ungated plan execution.                             |
| `/workflow`           | Browse workflow runs and agent trees.                                |
| `/tasks`              | Browse external tasks when a task provider is available.             |
| `/model`              | Choose the default model.                                            |
| `/effort`             | Choose default reasoning effort.                                     |
| `/settings`           | Open the settings hub.                                               |
| `/extensions`         | Open the extensions hub.                                             |
| `/workspace-trust`    | Approve or revoke workspace executable configuration.                |
| `/storage`            | Inspect Clarvis-owned storage and preview safe cleanup.              |
| `/doctor`             | Run readiness checks and guided repairs.                             |
| `/reconnect`          | Rebuild the backend with current settings, keys, and environment.    |
| `/refresh`            | Refresh the models.dev catalog.                                      |
| `/debug [off\|level]` | Open, retune, or close bounded diagnostics.                          |
| `/quit`               | Quit Clarvis.                                                        |
| `/recover-memory`     | Rebuild the backend after the interactive memory fuse trips.         |

Settings and extensions support hierarchical routes such as `/settings/providers`,
`/settings/agents`, `/settings/controls`, `/extensions/plugins`, `/extensions/hooks`, and
`/extensions/mcp`.

Installed skills and connected MCP prompts may add their own slash commands dynamically.

## Input syntax

| Prefix | Meaning                                              |
| ------ | ---------------------------------------------------- |
| `/`    | Search or run a Clarvis command.                     |
| `@`    | Mention a workspace file; images become attachments. |
| `!`    | Run a direct local shell command.                    |

::: danger
`!` commands are direct operator commands. They do not use the agent's sandbox or command-review
policy.
:::

## Essential keyboard controls

| Key                   | Result                                                      |
| --------------------- | ----------------------------------------------------------- |
| **Enter**             | Submit a turn, steer a run, or activate the focused row.    |
| **Ctrl+J**            | Insert a newline in the composer.                           |
| **Escape**            | Clear the current draft or return one screen.               |
| **Ctrl+C**            | Cancel active work; when idle, enter the quit confirmation. |
| **Shift+Tab**         | Open the agent picker.                                      |
| **Alt+S**             | Open safety presets on enhanced terminal paths.             |
| **Ctrl+P**            | Open the current or latest plan.                            |
| **PageUp / PageDown** | Scroll the transcript by page.                              |

`/help` is authoritative for the current screen and terminal. Configure keyboard compatibility in
`/settings/keyboard`.

## See also

- [Daily use](/guide/daily-use)
- [Providers and models](/guide/providers-and-models)
- [Plans](/guide/plans)
- [Worktrees](/guide/worktrees)
- [Configuration](/reference/configuration)
- [Troubleshooting](/operations/troubleshooting)
