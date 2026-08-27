# Marketplaces

> Publish and browse curated plugin listings without treating a catalog as permission to run code.

## Browse the official marketplace and install a plugin

Type `/extensions/market`. Clarvis loads the official
[`getclarvis/marketplace`](https://github.com/getclarvis/marketplace) catalog automatically; you do
not need to add its URL to settings. Then follow the complete activation sequence:

1. Select a listing and press Enter to install it.
2. Clarvis opens the Plugins screen. Select the installed plugin and press `e` to enable it.
3. If it contributes hooks, open `/extensions/hooks`, inspect each exact definition, and press `t`
   to approve the ones you accept.

Press `a` to add another marketplace by Git URL. Press `r` to refetch the official and added
catalogs. A listing is only a pointer to a source repository: appearing in a marketplace installs
nothing, grants no trust, enables nothing, and approves no hook.

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

To contribute a plugin to the official catalog, follow the contribution process in
[`getclarvis/marketplace`](https://github.com/getclarvis/marketplace/blob/main/CONTRIBUTING.md). The
official repository records review metadata and the exact upstream revision inspected for each accepted entry.
The plugin code stays in its upstream repository; `path` identifies a subdirectory only when needed.

## Configure an additional marketplace manually

The official marketplace is built in and is not written to settings. The TUI writes URLs for
additional marketplaces to your global settings. You may instead edit
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
