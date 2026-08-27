# Hooks

> Run your own checks at Clarvis lifecycle events, and decide exactly which plugin hooks may run.

## Review hooks in the TUI

Type `/extensions/hooks` to see two groups:

- **Plugin hooks** shows the exact command, event, and fingerprint contributed by each installed
  plugin. Select a definition and press `t` to approve it. Press `x` to revoke an approval.
- **Your hooks** shows the global and workspace hooks declared in `settings.json`. These are
  read-only in the browser because you authored them directly.

Plugin enablement and hook approval are separate decisions. Enabling a plugin does not approve its
hooks, and approving a hook does not enable the plugin. An approval belongs to the exact hook
definition: if that definition changes, Clarvis requires a new review.

## Add an operator hook

Put personal hooks in `~/.clarvis/settings.json`, or project-specific hooks in
`.clarvis/settings.json` at the workspace root. This example runs the project's test command before
an agent may finish:

```json
{
  "hooks": [
    {
      "event": "pre_finalize",
      "command": "bun run test",
      "timeout_ms": 60000,
      "on_failure": "deny"
    }
  ]
}
```

A successful command may write nothing to stdout. To return an explicit verdict, write exactly one
JSON object to stdout:

```json
{ "kind": "deny", "message": "The project tests must pass before this run can finish." }
```

Write diagnostic logs to stderr. Extra text on stdout makes the verdict invalid.

## Scope a hook to tool calls

`match` is available only for `pre_tool_use` and `post_tool_use`. Tool patterns are exact names or
globs, and every argument pattern is a JavaScript regular expression that must match:

```json
{
  "hooks": [
    {
      "event": "pre_tool_use",
      "match": {
        "tool": "shell",
        "args": {
          "command": "(^|\\s)deploy(\\s|$)"
        }
      },
      "command": "bun run tooling/review-deploy.ts",
      "timeout_ms": 5000,
      "on_failure": "deny"
    }
  ]
}
```

The referenced `tooling/review-deploy.ts` can deny the matched call with a clear reason:

```ts
const input = (await Bun.stdin.json()) as {
  tool_input?: { command?: unknown };
};

const command =
  typeof input.tool_input?.command === "string" ? input.tool_input.command : "deploy command";

console.error(`blocked agent-initiated deployment: ${command}`);
process.stdout.write(
  JSON.stringify({
    kind: "deny",
    message: "Run deployments from a separate operator-controlled process.",
  }),
);
```

The hook command receives one JSON object on stdin. A tool event includes `tool_name` and
`tool_input`; all events include `protocol`, `hook_event_name`, and `cwd`.

For hook documents shared with another host, `hook_event_name` and `tool_name` use the compatible
external spellings. Built-in tools therefore arrive with names such as `Bash`, `Read`, and `Skill`,
while an MCP tool arrives as `mcp__<server>__<tool>`. A skill load also adds `skill` beside its native
`name` input. Use `CLARVIS_HOOK_TOOL` for the Clarvis wire name and
`CLARVIS_HOOK_TOOL_FULL_NAME` for an MCP tool's stable dotted name when your script needs Clarvis's
own identity.

Gate hooks may return `pass`, `deny`, or `advise`. A `pre_tool_use` hook may also return `rewrite`
with a complete replacement `arguments` object. `session_start` and `pre_compact` hooks may return
`context` text. Observer events run for notification only and cannot block the run. A
`user_prompt_expansion` observer fires once before a user-invoked skill command starts; it does not
fire for an ordinary prompt or a later model-initiated skill load.

::: warning Hooks run with your privileges
Hook commands run from the workspace with normal filesystem and network access; they do not run in
the agent sandbox. Clarvis removes provider credentials and secret-shaped environment variables,
but that filtering is not process isolation. Treat every hook command as executable code you chose
to run. A `match` narrows when a hook runs; it is not a security boundary.
:::

## Approve workspace execution

Hooks from `.clarvis/settings.json` remain visible but do not run until you approve that workspace.
Type `/workspace-trust` to review and approve its executable configuration. The same trust decision
also covers workspace MCP servers, enabled plugins, marketplaces, executable capability providers,
a Tasks provider, and workspace agents. Subscription-provider declarations are never activated from
workspace settings, even after approval; configure them globally.

This workspace-level decision is separate from per-hook plugin approval. A plugin hook runs only
when the plugin is enabled, the workspace configuration that enables it is trusted when applicable,
and that exact hook definition is approved.

## See also

- [Plugins](/guide/plugins)
- [MCP servers](/guide/mcp-servers)
- [Extensions reference](/reference/extensions)
