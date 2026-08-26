# Scopes and workspace trust

> Decide whether a preference belongs to you or one project, and review repository-controlled code
> before Clarvis lets it run.

## Choose the narrowest useful scope

Clarvis separates personal defaults from project-specific behavior:

| Scope     | Default location      | Use it for                                                                 |
| --------- | --------------------- | -------------------------------------------------------------------------- |
| Global    | `~/.clarvis/`         | Your providers, defaults, agents, skills, workflows, plugins, and settings |
| Workspace | `<project>/.clarvis/` | Overrides and extensions that should travel with one repository            |

If `CLARVIS_HOME` is set, it replaces `~/.clarvis` for Clarvis-owned personal files. It does not move
the workspace `.clarvis` directory or `.agents` interoperability directories.

Use the scope control shown in a settings panel before saving. Prefer global scope for credentials
and personal defaults. Prefer workspace scope only when collaborators should receive the same
project behavior.

## Understand precedence

Effective configuration starts with product defaults, then personal configuration, then workspace
configuration. A workspace value normally wins for the same scalar choice. Maps and ordered lists
may merge according to their own field rules; the settings panels show the effective value and its
source when that distinction matters.

The same pattern applies to user-authored content:

- a workspace agent overrides a personal agent with the same name;
- a workspace Clarvis skill overrides personal and interoperable skills with the same name;
- a workspace plugin shadows a personal plugin with the same name;
- later plugins in `enabledPlugins` outrank earlier plugins, but operator settings outrank every
  plugin contribution.

Controls changed for the next run do not rewrite an already-active run. Check the scope and the
header before starting work when you are switching between repositories.

## Review workspace trust

A cloned repository should not gain authority merely by containing configuration. Clarvis
fingerprints the workspace path and the parts of its configuration that can execute code, select an
executable provider, or change an agent's system instructions.

Type `/workspace-trust` to approve or revoke the current fingerprint. Clarvis requests a new review
when the protected surface changes. If a repository declares nothing in that surface, it is inert
and there is nothing to approve.

Until approval, Clarvis withholds these workspace contributions and continues with trusted personal
configuration:

- hooks and MCP servers;
- plugin enablement and marketplace sources;
- executable or plugin providers for Memory and Plans;
- a Tasks provider;
- workspace agent files.

Subscription-backed provider declarations are a stronger exception: workspace files never gain the
ability to reuse or redirect your personal subscription credentials, even after workspace approval.
Configure subscription providers globally.

Approval is intentionally specific. Workspace approval does not enable a plugin that is absent from
`enabledPlugins`, and it does not approve any plugin hook. Review plugin hooks one definition at a
time in `/extensions/hooks`.

::: warning Trust is not a review of every setting
Workspace trust protects the executable and provider-selecting surface above. Other project settings
still participate in normal precedence. In particular, review workspace sandbox and command-review
settings yourself; they are not made safe merely because the trust command reports an inert
workspace.
:::

## Keep secrets personal

Do not commit credentials to workspace settings. Configure provider credentials through
`/settings/providers`, or reference environment variables where a format supports `${NAME}`.
Workspace approval never turns a repository file into an appropriate secret store.

Use `/storage` to inspect whether Clarvis credential files are present and their permission posture
without revealing paths, sizes, or contents. POSIX stores apply owner-only mode bits; Windows relies
on the user's profile access controls.

## See also

- [Configuration reference](/reference/configuration)
- [Safety and control](/guide/safety)
- [Security](/operations/security)
- [Plugins](/guide/plugins)
- [Extensions reference](/reference/extensions)
