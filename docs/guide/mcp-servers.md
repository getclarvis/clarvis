# MCP servers

> Connect local or remote Model Context Protocol servers and make their tools, prompts, and resources
> available to your agents.

## Inspect connected servers

Type `/extensions/mcp` to open the read-only MCP browser.

1. Select a server and press Enter to inspect its tools and prompts.
2. Select a tool to inspect its input schema.
3. Select a prompt and press `i` to invoke it.
4. Press `r` to refresh connection state, or `e` to show the exact settings file and server entry to
   edit.

The browser distinguishes connected, declared, lost, and unavailable servers, so it is the quickest
place to confirm that a configuration is live.

## Configure servers

Add an `mcpServers` map to `~/.clarvis/settings.json` for personal servers or
`.clarvis/settings.json` for project-specific servers. Each map key becomes the server name:

```json
{
  "mcpServers": {
    "workspace-tools": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "tooling/local-mcp.ts"],
      "env": {
        "SERVICE_TOKEN": "${SERVICE_TOKEN}"
      },
      "resources": true
    },
    "remote-docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      }
    }
  }
}
```

Replace the example command and URL with servers you control. Keep credentials in environment
variables: `${NAME}` references are resolved when Clarvis connects, so secrets do not need to be
stored in `settings.json`.

### Choose the transport

- `stdio` requires `command`. It may also use `args`, `env`, `shared`, and `resources`; it must not
  use `url` or `headers`.
- `http` and `sse` require a well-formed `http://` or `https://` URL. They may use `headers` and
  `resources`; they must not use `command`, `args`, `env`, or `shared`.
- Omitting `type` selects `stdio`.

Set `shared: true` only when one long-lived stdio process can safely serve overlapping runs. A shared
connection does not support MCP elicitation, so do not use it for a server that authenticates by
asking the operator a question.

Resource support is on by default. When a server advertises resources, Clarvis adds
`<server>.list_resources` and `<server>.read_resource`; set `resources: false` to suppress them.

### Authorize a remote server

When an HTTP or SSE server requests OAuth, the local interactive CLI and local `--print` mode open
the authorization page in your default browser. Clarvis accepts only HTTPS authorization pages
(plus HTTP on a loopback host), verifies a one-time state value, exchanges the callback with PKCE,
and retries the connection. Time spent waiting for you does not consume the MCP connection timeout.

Registrations and tokens are stored outside settings in
`~/.clarvis/state/mcp-oauth.json`, isolated by workspace, owner, and canonical server URL. Clarvis
creates that file with private permissions on platforms that support them and does not place its
contents in prompts, traces, or logs. A remote/headless kernel has no browser authority and fails
explicitly if interactive authorization is required; configure an explicit header-based credential
for that host instead.

## Reference a server from an agent

Tools use the name `<server>.<tool>`. For example, a `search` tool from `remote-docs` is
`remote-docs.search`.

Servers contributed by a plugin receive the plugin namespace:

```text
quality-kit:checks.lint
```

Here `quality-kit` is the plugin, `checks` is the server, and `lint` is the tool. Use that full name
in agent tool lists and hook match patterns.

::: warning Workspace trust applies
An unapproved repository may declare MCP servers, but Clarvis withholds them instead of launching or
connecting to them. Type `/workspace-trust` to review the repository's executable configuration.
Approval is for the workspace, not for an individual server.
:::

## See also

- [Hooks](/guide/hooks)
- [Plugins](/guide/plugins)
- [Extensions reference](/reference/extensions)
