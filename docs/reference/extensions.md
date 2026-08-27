# Extensions reference

> Exact locations, configuration fields, namespaces, and activation gates for hooks, MCP servers,
> skills, plugins, and marketplaces.

## Locations and precedence

| Extension            | Personal location                   | Workspace location                | Precedence                                        |
| -------------------- | ----------------------------------- | --------------------------------- | ------------------------------------------------- |
| Settings             | `~/.clarvis/settings.json`          | `.clarvis/settings.json`          | Workspace overrides personal settings             |
| Skills               | `~/.clarvis/skills/<name>/SKILL.md` | `.clarvis/skills/<name>/SKILL.md` | Workspace Clarvis skills win                      |
| Interoperable skills | `~/.agents/skills/<name>/SKILL.md`  | `.agents/skills/<name>/SKILL.md`  | Lower than Clarvis skill roots                    |
| Plugins              | `~/.clarvis/plugins/<name>/`        | `.clarvis/plugins/<name>/`        | Workspace plugin shadows the same personal plugin |
| Agents               | `~/.clarvis/agents/<name>.md`       | `.clarvis/agents/<name>.md`       | Workspace agent overrides the same personal agent |

Within enabled plugins, later names in `enabledPlugins` have higher precedence. Plugin contributions
remain below personal and workspace settings.

## Activation and trust

| Surface              | What makes it active                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| Personal hook        | Presence in personal `settings.json`                                          |
| Workspace hook       | Workspace approval through `/workspace-trust`                                 |
| Personal MCP server  | Presence in personal `settings.json`                                          |
| Workspace MCP server | Workspace approval through `/workspace-trust`                                 |
| Plugin contribution  | Plugin installed and present in `enabledPlugins`                              |
| Plugin hook          | Plugin enabled **and** exact hook fingerprint approved in `/extensions/hooks` |
| Marketplace listing  | Never active by itself; install, enable, then approve hooks                   |
| Workspace agent      | Workspace approval through `/workspace-trust`                                 |
| Standalone skill     | Discovered from a skill root; slash visibility follows `user-invocable`       |

Workspace trust covers executable or provider-selecting values declared by a repository: `hooks`,
`mcpServers`, `enabledPlugins`, `marketplaces`, `memory.provider`, `plans.provider`, `tasks.provider`,
and workspace agents. Until approval, Clarvis withholds those values and continues with trusted
personal configuration. Subscription-provider declarations are a permanent exception: Clarvis
removes them from workspace settings before merge, and approval never grants credential or redirect
authority. Configure them globally; a workspace may only select a model already enabled there.

## `settings.json`

`settings.json` is strict. Unknown top-level fields are rejected instead of being ignored. The
extension-related fields are:

| Field            | Shape                               | Purpose                                           |
| ---------------- | ----------------------------------- | ------------------------------------------------- |
| `hooks`          | Hook object array                   | Operator-authored lifecycle commands              |
| `mcpServers`     | Map of server name to server object | Local and remote MCP connections                  |
| `marketplaces`   | Git URL array                       | Additional catalogs shown by `/extensions/market` |
| `enabledPlugins` | Plugin-name array                   | Enabled plugins, in ascending precedence order    |

### MCP server object

| Field       | Type                      | Applies to    | Notes                                                |
| ----------- | ------------------------- | ------------- | ---------------------------------------------------- |
| `type`      | `stdio`, `http`, or `sse` | All           | Defaults to `stdio`                                  |
| `command`   | String                    | `stdio`       | Required                                             |
| `args`      | String array              | `stdio`       | Optional argv after the command                      |
| `env`       | String map                | `stdio`       | Supports `${VAR}` interpolation                      |
| `shared`    | Boolean                   | `stdio`       | Reuses one process across runs; disables elicitation |
| `url`       | HTTP(S) URL               | `http`, `sse` | Required                                             |
| `headers`   | String map                | `http`, `sse` | Supports `${VAR}` interpolation                      |
| `resources` | Boolean                   | All           | Defaults on; `false` suppresses resource tools       |

`stdio` forbids `url` and `headers`. Remote transports forbid `command`, `args`, `env`, and `shared`.

Remote HTTP/SSE servers may request OAuth during connection, catalog discovery, or a later request.
Local interactive and `--print` hosts open the authorization page, require HTTPS for every OAuth
endpoint and redirect except loopback HTTP, validate state, use PKCE, and repeat the refused request
once after the callback. Configured MCP headers apply only to resource requests on their configured
origin; OAuth exchanges do not inherit them, even on that origin, and SDK-defined authorization
headers take precedence. Credentials live in
`~/.clarvis/state/mcp-oauth.json`, keyed by workspace, owner, and canonical server URL; they are not
settings. A host without a browser opener reports that interactive authorization is unavailable.

### Hook object

| Field        | Type                    | Notes                                                                   |
| ------------ | ----------------------- | ----------------------------------------------------------------------- |
| `event`      | Event name              | Required                                                                |
| `command`    | String                  | Required shell command                                                  |
| `match.tool` | String or string array  | Exact name or `*` glob; tool events only                                |
| `match.args` | String map              | JavaScript regex per argument; all entries must match; tool events only |
| `timeout_ms` | Integer from 1 to 60000 | Optional timeout                                                        |
| `on_failure` | `pass` or `deny`        | `deny` is valid only for gate events                                    |

Events:

| Class              | Events                                                                                            | Effect                                     |
| ------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Gate               | `pre_tool_use`, `post_tool_use`, `pre_finalize`, `pre_delegate_task`                              | May pass, advise, or deny                  |
| Observer           | `run_start`, `run_end`, `subagent_complete`, `model_call_error`, `budget_exhausted`, `user_steer` | Output cannot block the run                |
| Context            | `session_start`                                                                                   | May add pinned entry context               |
| Compaction context | `pre_compact`                                                                                     | May add context to that summarization pass |
| Prompt observer    | `user_prompt_expansion`                                                                           | Observes a user-invoked skill command      |

Only `pre_tool_use` may replace pending tool arguments with a `rewrite` verdict. A single settings or
plugin source may declare up to 64 hooks; a run uses at most 128 merged hooks, with operator hooks
before plugin hooks.

Compatible hook payloads spell built-in tools as external names such as `Bash`, `Read`, and `Skill`,
and MCP tools as `mcp__<server>__<tool>`. `CLARVIS_HOOK_TOOL` retains the Clarvis wire name;
`CLARVIS_HOOK_TOOL_FULL_NAME` carries the stable dotted MCP name when one exists.

## `SKILL.md`

Every skill is a directory containing `SKILL.md` with YAML frontmatter and a Markdown body.

| Field            | Required | Notes                                                       |
| ---------------- | -------- | ----------------------------------------------------------- |
| `name`           | Yes      | Letters, numbers, `.`, `_`, and `-`; maximum 128 characters |
| `description`    | Yes      | Short discovery text                                        |
| `agent`          | No       | Agent for slash invocation; may use `<plugin>:<agent>`      |
| `version`        | No       | Skill version metadata                                      |
| `license`        | No       | License metadata                                            |
| `argument-hint`  | No       | String or string array shown for the slash argument         |
| `user-invocable` | No       | Defaults to `true`                                          |
| `allowed-tools`  | No       | Compatibility metadata; does not change runtime permissions |
| `tools`          | No       | Alias of `allowed-tools`                                    |

The body may use `$ARGUMENTS` or `{{args}}`. Conventional resource directories are `scripts`,
`references`, `assets`, and `examples`. An `agents` sidecar directory is presentation metadata for
the host and is never exposed as a skill resource.

## `plugin.json`

`plugin.json` is tolerant: Clarvis reports unknown fields but does not act on them. `name` is the only
required field after normalization. A native Git install uses it as the directory name; an existing
foreign layout may omit it, in which case Clarvis derives it from the install directory. That
directory is always the host-owned runtime namespace.

Clarvis first uses `.clarvis-plugin/plugin.json` when it exists. Otherwise it examines a root
`plugin.json` plus directories shaped like `.<host>-plugin/plugin.json`, selects the single readable
manifest with the most supported contribution directives, and uses root-then-name order to break a
tie. Manifests are never merged.

| Field                   | Type                                            | Purpose                                                    |
| ----------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| `name`                  | Lowercase identifier                            | Plugin identity and namespace                              |
| `version`               | Semantic version string                         | Optional display version                                   |
| `description`           | Non-empty string                                | Optional summary                                           |
| `author`                | String or `{ "name": "..." }`                   | Optional author display                                    |
| `skills`                | Relative directory or directory array           | Up to four plugin skill roots                              |
| `mcpServers`            | MCP server map or relative document path        | Plugin-provided servers                                    |
| `hooks`                 | Hook array, document, or relative document path | Plugin-provided hooks                                      |
| `bootstrapSkill`        | Skill name                                      | Injects one plugin-owned methodology skill before response |
| `capabilityExecutables` | Capability-to-executable map                    | Optional persistent capability services                    |
| `capabilityRunPolicies` | Plans skill-policy map                          | `off`, `on`, or `review` for plugin skill runs             |

Relative paths resolve from the selected manifest's directory first and remain confined to the
plugin root. Conventional contribution directories are `agents/` and `skills/`. If `mcpServers` is
absent, Clarvis tries `.mcp.json` and then `mcp.json`. If the manifest contributes no hooks, Clarvis
also reads `hooks/hooks.json`. Compatible event-keyed hook documents may be inline, wrapped in a
`hooks` object, or named by one or more relative paths. In a translated event-keyed document, a
leading command such as `./hooks/session-start.cmd` is anchored to the plugin root while the hook's
working directory remains the workspace. Native Clarvis hook arrays are kept exactly as declared.

### Capability executable declaration

```json
{
  "capabilityExecutables": {
    "memory": {
      "command": "quality-memory",
      "args": ["serve"],
      "env": {
        "DATABASE_URL": "${DATABASE_URL}"
      },
      "timeout_ms": 30000,
      "platforms": {
        "win32": {
          "command": "quality-memory.exe"
        }
      }
    }
  }
}
```

`command` is required. `args` and `env` default to empty collections, and `timeout_ms` defaults to
30000 milliseconds. A capability service remains inert until the plugin is enabled and selected as
the provider for that capability.

## `marketplace.json`

A Clarvis installation includes `https://github.com/getclarvis/marketplace.git` as its official
marketplace source. The source is available without a settings entry, but its catalog is fetched
only for browsing and none of its plugins are installed, enabled, or approved automatically.
`settings.json` may add other marketplace sources.

A marketplace repository publishes `marketplace.json` at its root:

| Root field    | Required | Purpose                                              |
| ------------- | -------- | ---------------------------------------------------- |
| `name`        | No       | Catalog identifier; Clarvis supplies one when absent |
| `displayName` | No       | Human-facing title                                   |
| `description` | No       | Catalog summary                                      |
| `plugins`     | No       | Listing array; defaults to empty                     |

| Listing field | Required | Purpose                                                     |
| ------------- | -------- | ----------------------------------------------------------- |
| `name`        | Yes      | Plugin name                                                 |
| `source`      | Yes      | Remote Git URL, SSH source, or display-only relative source |
| `path`        | No       | Relative plugin subdirectory inside a remote source         |
| `description` | No       | Listing summary                                             |
| `displayName` | No       | Human-facing plugin title                                   |
| `homepage`    | No       | Project page                                                |
| `category`    | No       | Presentation grouping                                       |

Marketplace files are tolerant and report unknown or defaulted fields. A listing without a usable
`name` or `source` is omitted. Relative sources are visible but cannot be installed from the TUI.

## Namespaces

| Contribution        | Effective name                                       |
| ------------------- | ---------------------------------------------------- |
| Settings MCP server | `<server>`                                           |
| Settings MCP tool   | `<server>.<tool>`                                    |
| Plugin MCP server   | `<plugin>:<server>`                                  |
| Plugin MCP tool     | `<plugin>:<server>.<tool>`                           |
| Plugin agent        | `<plugin>:<agent>`                                   |
| Plugin skill        | Authored skill name; normal skill precedence applies |

## See also

- [Hooks](/guide/hooks)
- [MCP servers](/guide/mcp-servers)
- [Skills](/guide/skills)
- [Plugins](/guide/plugins)
- [Marketplaces](/guide/marketplaces)
- [Clarvis on GitHub](https://github.com/getclarvis/clarvis)
