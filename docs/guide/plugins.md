# Plugins

> Bundle agents, skills, MCP servers, hooks, and optional capability services into one extension
> that remains inactive until you enable it.

## Manage plugins in the TUI

Type `/extensions/plugins` to open the plugin browser.

1. Press `a`, then enter an HTTPS, SSH, or `file://` Git URL to install a plugin.
2. Select the plugin and inspect every contribution shown in its detail panel.
3. Press `e` to enable it. Clarvis reloads the backend so its contributions are available now; if
   that reload fails, run `/reconnect`.
4. If the plugin contributes hooks, open `/extensions/hooks`, review each exact definition, and
   press `t` for each hook you accept.

Press `u` to update a Git-installed plugin. Press `d` to uninstall a global plugin. Workspace plugins
are part of the repository, so remove them from the repository instead.

::: warning Three separate gates
Installing stores the code. Enabling activates the plugin's contributions. Approving allows one
exact hook definition to run. Completing one step never implies either of the others.
:::

## Create a plugin

A conventional plugin can be as small as this:

```text
quality-kit/
├── plugin.json
├── agents/
│   └── reviewer.md
├── skills/
│   └── quality-check/
│       └── SKILL.md
└── hooks/
    └── hooks.json
```

Put `plugin.json` at the plugin root. Names use lowercase letters, numbers, underscores, and hyphens.
A Git install uses the manifest `name` as its install directory. For an already installed multi-host
layout, the directory is the runtime namespace; Clarvis can derive a missing manifest name from it:

```json
{
  "name": "quality-kit",
  "version": "0.0.1",
  "description": "Review-oriented agents, skills, and checks.",
  "author": {
    "name": "Acme Engineering"
  },
  "mcpServers": {
    "checks": {
      "type": "stdio",
      "command": "quality-kit-mcp",
      "args": ["--stdio"],
      "resources": false
    }
  },
  "hooks": [
    {
      "event": "pre_finalize",
      "command": "bun run lint",
      "timeout_ms": 60000,
      "on_failure": "deny"
    }
  ],
  "bootstrapSkill": "quality-check",
  "capabilityRunPolicies": {
    "plans": {
      "skills": {
        "quality-check": "review"
      }
    }
  }
}
```

The only required manifest field is `name`. If present, `version` must be semantic versioning. You
may declare hooks inline as above; when the manifest declares no hooks, Clarvis also looks for
`hooks/hooks.json`. Relative files and directories named by a manifest must remain inside the plugin.

For a multi-host plugin, Clarvis accepts a root `plugin.json` and manifests under directories shaped
like `.<host>-plugin/plugin.json`. A `.clarvis-plugin/plugin.json` is authoritative when present.
Otherwise Clarvis selects the single readable manifest that declares the richest supported
contribution surface; it never merges two host manifests. Put skill roots in `skills` as one relative
directory or a list of up to four. Put MCP servers inline, name a companion document with
`mcpServers`, or omit that key and use `.mcp.json` or `mcp.json` by convention.

Compatible event-keyed hook documents may be wrapped in a `hooks` object, referenced by path, or
placed at `hooks/hooks.json`. Clarvis translates their event names, tool matchers, plugin-root
placeholders, timeouts, and supported verdicts into the same reviewed hook definitions used by a
native manifest. Anything that cannot be translated is reported in the plugin browser instead of
silently widening a matcher.

`bootstrapSkill` names one skill from this plugin whose body should be available before the model
responds. The `review` plan policy asks for planning review on that skill when both the skill and the
selected Plans provider come from this plugin.

## Understand names and overrides

Clarvis qualifies contributions that must be globally unique:

- agents become `<plugin>:<agent>`;
- MCP servers become `<plugin>:<server>`, and their tools become
  `<plugin>:<server>.<tool>`;
- skills keep their skill name and follow normal skill precedence.

For example, the manifest above contributes the MCP namespace `quality-kit:checks`. An agent named
`reviewer.md` is addressed as `quality-kit:reviewer`.

Personal plugins live under `~/.clarvis/plugins/<name>`. A repository may carry a workspace plugin at
`.clarvis/plugins/<name>`; it shadows a personal plugin with the same name. Plugin precedence follows
the order of `enabledPlugins`, with later plugins overriding earlier ones, while your global and
workspace settings always outrank plugin contributions.

## Know what Clarvis accepts

`settings.json` is strict: an unknown top-level setting is an error. `plugin.json` is intentionally
tolerant so a cross-tool plugin is not rejected only because it carries foreign metadata. Clarvis
reports unknown manifest keys but does not act on them. A misspelled key can therefore leave a
contribution inactive even though the plugin loads; review the notes in the plugin browser.

::: warning Enable only code you trust
Plugins may contribute executable MCP servers, agents with their own grants, capability services,
and hooks that run with your privileges. Workspace configuration that enables plugins is withheld
until `/workspace-trust` approval, and every plugin hook still requires its own exact approval.
:::

## See also

- [Marketplaces](/guide/marketplaces)
- [Hooks](/guide/hooks)
- [Skills](/guide/skills)
- [MCP servers](/guide/mcp-servers)
- [Extensions reference](/reference/extensions)
