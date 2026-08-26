# Marketplaces

> Publish and browse curated plugin listings without treating a catalog as permission to run code.

## Add a marketplace and install a plugin

Type `/extensions/market`, then follow the complete activation sequence:

1. Press `a` and enter the marketplace repository's Git URL.
2. Select a listing and press Enter to install it.
3. Clarvis opens the Plugins screen. Select the installed plugin and press `e` to enable it.
4. If it contributes hooks, open `/extensions/hooks`, inspect each exact definition, and press `t`
   to approve the ones you accept.

Press `r` in the marketplace browser to refetch configured catalogs. A listing is only a pointer to
a source repository: appearing in a marketplace grants no trust, enables nothing, and approves no
hook.

::: warning Local TUI behavior
Marketplace browsing runs Git on the machine that displays the TUI. Use this flow with the local
Clarvis TUI. A future remote host may separate the display machine from the machine that installs
plugins.
:::

## Publish a marketplace

Create a Git repository with `marketplace.json` at its root:

```json
{
  "name": "acme-extensions",
  "displayName": "Acme Extensions",
  "description": "Reviewed Clarvis plugins for Acme projects.",
  "plugins": [
    {
      "name": "quality-kit",
      "source": "https://github.com/acme/quality-kit.git",
      "description": "Review-oriented agents, skills, and checks.",
      "displayName": "Quality Kit",
      "homepage": "https://github.com/acme/quality-kit",
      "category": "Quality"
    },
    {
      "name": "repo-tools",
      "source": "https://github.com/acme/clarvis-plugins.git",
      "path": "plugins/repo-tools",
      "description": "Repository maintenance helpers."
    }
  ]
}
```

Each usable listing needs `name` and `source`. Use `path` when the plugin occupies a subdirectory of
its source repository; it must be a relative path that stays inside that repository. `displayName`,
`description`, `homepage`, and `category` are presentation fields.

HTTPS, SSH, and scp-style SSH sources can be installed from the browser. A relative local source may
be displayed for compatibility, but Clarvis does not offer an install action for it. Use a remote Git
source for a marketplace intended for other users.

Like plugin manifests, marketplace documents are read tolerantly. Unknown fields and recoverable
presentation problems are reported as notes rather than silently becoming behavior. Listings with no
usable `name` or `source` are dropped.

## Configure a marketplace manually

The TUI writes marketplace URLs to your global settings. You may instead edit
`~/.clarvis/settings.json`:

```json
{
  "marketplaces": ["https://github.com/acme/clarvis-marketplace.git"]
}
```

A workspace may declare its own `marketplaces` list in `.clarvis/settings.json`. Clarvis withholds
that list until you approve the repository with `/workspace-trust`.

## See also

- [Plugins](/guide/plugins)
- [Hooks](/guide/hooks)
- [Extensions reference](/reference/extensions)
