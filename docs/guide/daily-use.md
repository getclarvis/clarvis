# Daily use

> Run focused tasks, steer work in progress, inspect results, and keep sessions organized without
> losing control of the workspace.

## Start in the right workspace

Clarvis treats the current directory as the workspace:

```bash
cd path/to/your-project
clarvis
```

Before asking for changes, check the workspace and safety indicators in the header. If the
repository contributes executable configuration, review it with `/workspace-trust`.

## Write a useful task

A strong request names the outcome, important boundaries, and the evidence you expect:

```text
Fix the empty-state regression in the account picker. Preserve the current visual style, add a
regression test, run the focused checks, and summarize the changed files.
```

Use `@` to mention a workspace file. Images selected through a mention are attached to the turn.
Type `/` to search commands and destinations.

::: tip
Begin unfamiliar work with a bounded read-only request. Once the evidence is clear, ask for the
change in the same session.
:::

## Steer or cancel active work

Submitting text while a run is active steers that run; it does not create a competing run:

```text
Keep the public API unchanged and focus the fix inside the adapter.
```

Press **Ctrl+C** to cancel active work. **Escape** clears a draft or closes the current screen; it
does not cancel a run. Clarvis shows the actions available on the current screen in the footer.

## Inspect the result

- `/diff` opens the focused or most recent diff.
- `/plans` browses retained plan history.
- **Ctrl+P** opens the current or latest plan.
- `/workflow` opens workflow run history and the manager-to-agent tree.
- `/status` shows the current agent, model, token use, and run state.
- `/export` writes the complete persisted transcript to a Markdown file.

Review claims against the displayed tool results and diffs before accepting consequential work.

## Keep sessions intentional

A session is the continuing conversation for one workspace. A run is one unit of agent work inside
that session.

- `/clear` archives the current session and starts a new one.
- `/sessions` resumes, exports, or deletes saved sessions.
- `clarvis --continue` resumes the most recently used session for the current workspace.
- `clarvis --list` lists saved sessions.
- `clarvis --resume <session-id>` resumes a specific session.

Use `/compact` when a long session should retain its important context in a smaller summary. Add an
optional instruction when something specific must survive:

```text
/compact Preserve the accepted API decision and every unresolved release blocker.
```

## Run a bounded headless task

For scripts or one-off output, use print mode:

```bash
clarvis --agent explorer --format md -p "Map the authentication flow. Do not edit files."
```

Headless mode cannot answer interactive approval requests; Clarvis denies them instead of waiting
forever. Use the interactive TUI for work that may require command, plan, or workflow approval.

::: warning
Input beginning with `!` runs a local shell command directly in the workspace. It is your command,
not an agent tool call, and does not pass through the agent's sandbox or command-review policy.
:::

## See also

- [Agents](/guide/agents)
- [Providers and models](/guide/providers-and-models)
- [Plans](/guide/plans)
- [Worktrees](/guide/worktrees)
- [Safety and control](/guide/safety)
- [Commands](/reference/commands)
- [Troubleshooting](/operations/troubleshooting)
