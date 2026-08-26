# Troubleshooting

> Diagnose readiness, reconnect stale services, recover from memory pressure, and collect bounded
> diagnostics without guessing which file to edit.

## Start with Doctor

Type `/doctor` whenever Clarvis can open but cannot start useful work. Doctor separates required
failures, recommended fixes, and informational checks for configuration, providers, credentials,
agents, defaults, safety, subscriptions, the backend, and diagnostics.

1. Select a failing row and press Enter to open its repair action.
2. Press `d` to show detailed results.
3. Press `r` to rerun checks, `c` to reconnect the backend, or `u` to refresh the model catalog.
4. Press `k` when terminal keys are the problem and run the keyboard diagnostic.

Doctor can remove invalid keys from a readable `settings.json`. If the file cannot be parsed, it can
offer to reset that scope to `{}`. Both repairs show the affected path and require confirmation;
inspect the proposed loss before accepting it.

## Reconnect after configuration changes

Use `/reconnect` when saved credentials, provider state, enabled plugins, MCP servers, or other
backend-owned configuration appears stale. Reconnect rebuilds the backend with the current
environment and saved keys; it does not clear the session transcript.

If reconnect still fails, open `/doctor` and resolve the first required check before changing more
settings.

## Recover sessions and transcript content

- `/sessions` lists sessions for the current workspace and lets you resume one.
- `/status` reports the current agent, model, run state, tokens, and cost.
- `/export` writes the complete persisted transcript, including content folded out of the live TUI.
- `/clear` archives the current session and starts a fresh one.

Use export before clearing when the current transcript contains evidence you may need later.

## Recover from memory pressure

If the memory fuse trips, Clarvis aborts active work and blocks new work instead of terminating the
TUI. Type `/recover-memory` to rebuild the backend, then wait for the cooling state to clear. If a
large live transcript remains the dominant cost, `/clear` starts a fresh session; export first when
you need the full record.

Do not repeatedly submit work while recovery is active. Only recovery, clear, and quit actions remain
available until the fuse returns to a healthy state.

## Inspect local storage safely

Type `/storage` for a metadata-only inventory of Clarvis-owned state. It reports total and reclaimable
space plus credential-file permission posture without showing credential contents.

Press `c` to preview cleanup. Clarvis only offers stale temporary data and rebuildable cache, then
asks for confirmation before deleting anything. It does not use this action to delete sessions,
configuration, plugins, or credentials. If the bounded inventory is incomplete, cleanup refuses to
continue.

## Capture diagnostics

Use the smallest useful diagnostic level:

```text
/debug info
```

Accepted levels are `error`, `warn`, `info`, and `debug`. Bare `/debug` selects `debug`; `/debug off`
closes a diagnostic session opened from the TUI. Clarvis reports the exact output path when the
session opens, and Doctor shows whether diagnostics are active.

A session opened after startup can capture the TUI from that point forward. For a boot or backend
startup failure, relaunch with `--debug=info` so diagnostics exist before those components start.
Diagnostic files are bounded, rotated, use owner-only mode bits on POSIX, and redact prompt, tool,
and credential-shaped payloads. Windows relies on the user's profile access controls. Review any
excerpt yourself before sharing it.

When reporting a problem, include the Clarvis version, `/status` output, the shortest reproduction,
the expected and observed behavior, and a sanitized diagnostic excerpt around the failure.

## See also

- [Getting started](/getting-started)
- [Daily use](/guide/daily-use)
- [Configuration reference](/reference/configuration)
- [Security](/operations/security)
