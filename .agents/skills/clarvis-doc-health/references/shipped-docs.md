# Keep the shipped Clarvis guide current

The product skill is named **clarvis-docs**. Its maintained source is
[SKILL.md](../../../../packages/kernel/assets/skills/.system/clarvis-docs/SKILL.md) and the sibling
reference pages. Update those assets, never the operator's installed copy. The maintenance workflow
belongs in `clarvis-doc-health`; do not insert repository Git/CI instructions into the product guide.

## Route by meaning

Read the entrypoint and affected pages, not just files whose names occur in the patch. The following
map is a starting point; reconcile it with the current asset tree and
[spec index](../../../../specs/README.md) when surfaces change.

| Changed behavior                                                                         | Shipped page to inspect                                                                                                                 | Owning contract starting points                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Locations, scope, precedence, global/workspace ownership                                 | [paths.md](../../../../packages/kernel/assets/skills/.system/clarvis-docs/references/paths.md)                                          | [paths](../../../../specs/foundations/paths.md), [Kernel config](../../../../specs/hosts/kernel-config.md)                                                                                                                  |
| File/shell access, grants, sandbox and approval authority                                | [authority.md](../../../../packages/kernel/assets/skills/.system/clarvis-docs/references/authority.md)                                  | [self-configuration](../../../../specs/hosts/self-configuration.md), [tools](../../../../specs/execution/tools-contract.md), [sandbox](../../../../specs/execution/sandbox.md)                                              |
| Settings/schema, defaults, providers/models, memory and operator controls                | [settings.md](../../../../packages/kernel/assets/skills/.system/clarvis-docs/references/settings.md)                                    | [Kernel config](../../../../specs/hosts/kernel-config.md), [subscriptions](../../../../specs/hosts/subscription-providers.md), [settings panels](../../../../specs/hosts/code-settings-panels.md), affected capability spec |
| Agents, skills, plugins, workflow definitions, discovery/trust/selection                 | [extensions.md](../../../../packages/kernel/assets/skills/.system/clarvis-docs/references/extensions.md)                                | [Extension Profiles](../../../../specs/hosts/extension-profiles.md), [plugins](../../../../specs/hosts/plugins.md), [skills](../../../../specs/execution/skills.md), affected capability spec                               |
| Validation errors, missing capabilities, reconnect/refresh, saved versus effective state | [troubleshooting.md](../../../../packages/kernel/assets/skills/.system/clarvis-docs/references/troubleshooting.md), plus the topic page | The contract owning the failure and recovery; [self-configuration](../../../../specs/hosts/self-configuration.md) for guide/resource lifecycle                                                                              |
| New documented topic or resource rename/removal                                          | Entrypoint routing and all inbound resource references                                                                                  | Relevant owning contract and asset/distribution boundaries below                                                                                                                                                            |

For example, a change to when a newly written skill becomes discoverable can affect paths,
extensions and troubleshooting even if its code diff only touches a catalog service. A private
symbol rename with no consumer-facing change may leave product prose intact while requiring spec
citation updates. Record that distinction instead of forcing an unnecessary product-guide edit.

## Update the guidance, not just its index

Verify exact field names, accepted values, defaults, scope, secret handling, availability, persisted
versus effective state, when a new run/reconnect is needed, and actionable failure recovery against
current source and owning tests. An entrypoint link without the new instructions is incomplete.
Remove replaced advice from every affected reference page. Keep a compact task-oriented guide;
do not copy implementation inventories or entire specs into it.

The installed tree must stand alone: no `packages/`, `specs/`, `tooling/`, local proposals or source
checkout instructions as prerequisites. Internal skill-resource references must resolve within the
shipped tree. Keep the reserved skill identity and invocation metadata unless the product contract
explicitly changes them. Loading documentation does not grant tool authority.

New resources need entrypoint routing and a distribution review. Inspect the resource allowlist in
`system-docs-assets.test.ts`, release file membership in `release-manifest.ts`, and the source lookup,
publication and snapshot rules in `system-docs.ts` and `system-docs-provider.ts`. Derive identities
through the existing build/publication machinery; do not hand-edit an installed ownership marker or
write into the user's global skill directory.

## Validate at the changed boundary

Resolve scripts and reuse enclosing checks that already ran on identical inputs. Run each command
block from the repository root. For edits to the existing Markdown asset contents, the focused
Kernel checks are:

```bash
cd packages/kernel
bun test tests/integration/system-docs-assets.test.ts tests/integration/system-docs-publication.test.ts tests/integration/system-docs-eligibility.test.ts --timeout 60000
```

These files cover a self-contained resource tree, complete publication/repair, source/release asset
verification, captured resource stability and reserved-name eligibility. Review any new command or
configuration example against the owning schema/parser; run the relevant existing behavioral tests
when a disputed claim requires them. The asset test does not validate the truth of every sentence.

When resource membership, publisher, release manifest or install/update routing changes, also run
the affected distribution tests. Current starting points are:

```bash
cd packages/code
bun test tests/integration/system-docs-cli.test.ts tests/integration/release-manifest.test.ts tests/integration/candidate-install.test.ts --timeout 60000
```

Read the [Code README](../../../../packages/code/README.md) and
[distribution contract](../../../../specs/cross-cutting/distribution-and-updates.md) before changing
that path. Packaging/install implementation changes or an explicitly requested distributable
qualification also require the relevant archive/install smokes from
[release health](../../clarvis-release-health/SKILL.md). A prose-only correction does not by itself
require a complete release preflight. Never count a unit fixture as a built-archive qualification.

Use disposable roots for publication/install checks and follow the repository's temporary-file
cleanup rules. Record the exact commands, exit outcomes and unverified boundaries. If a check is
blocked, preserve that gap; do not replace it with a claim that the current installed guide updated.
The next appropriate product reconciliation distributes changed source assets; editing the repo
alone does not prove that an already running host or installed release uses them.
