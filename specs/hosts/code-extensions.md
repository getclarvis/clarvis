# Extensions journey and plugin marketplace

> Owned by `@clarvis/code`, with installation and Environment transactions implemented by
> `@clarvis/kernel` behind `@clarvis/protocol`. The exact plugin and snapshot contracts remain in
> [plugins.md](plugins.md) and [environments.md](environments.md).

## 1. Purpose

Extensions are one product journey with distinct authorities: marketplaces advertise sources,
`PluginService` owns installed inventory, and `EnvironmentService` owns the exact active snapshot.
Code presents those authorities together without collapsing their persisted contracts.

There are two deliberate entry modes:

- `/extensions` is the only public slash route. It opens the guided five-step Environment composer.
- its home exposes internal Environments, Plugins, and MCP surfaces for focused inspection and
  maintenance. They are return-stack children, not public `/extensions/...` commands.

The Plugins surface replaces the former split Marketplace, installed Plugins, and Hook approval
screens. A plugin is an atomic extension: its agents, skills, MCP servers, hooks, and capability
executables are selected and consented together.

- **Production:** `ExtensionsHub`, `MarketplaceBrowser`, `EnvironmentBrowser`, and `McpBrowser` in
  `packages/code/src/views/config/`; registrations `extensions`, `marketplace.open`,
  `environments.open`, and `mcp.browse` in `packages/code/src/app/commands.tsx`.
- **Test:** `packages/code/tests/integration/app-commands.test.tsx` (single public route and factory
  composition) and `packages/code/tests/integration/app-shell-render.test.tsx` (exact route and
  return-stack cases).

## 2. Guided Environment composer

The composer follows the decision-first structure of first boot:

| Step | Decision | Persistent effect |
| --- | --- | --- |
| 1 — Scope | workspace-local selection or global default | none while staged |
| 2 — Environment | edit, clone, or create a definition | none while staged |
| 3 — Plugins and skills | exact plugin origins and standalone skills | a marketplace checkout may be installed; membership stays staged |
| 4 — Capabilities | inspect agents, skills, MCP, hooks, and executables | exact preview token only |
| 5 — Apply | inspect the complete delta and reconnect | definition, selection, trust when required, then reconnect |

The draft is a complete allow-list, never an overlay. Same-name alternatives keep their qualified
`scope/source/name` identity. A global definition cannot select workspace inventory. Plugin skills
are not individual toggles; standalone skills are.

Installing from inside Step 3 persists the checkout because that operation has its own explicit
consent, but it does not bypass the Environment draft. The operator is already editing a complete
snapshot, so the installed plugin enters only when Step 5 applies the reviewed composition. Closing
the wizard never silently uninstalls that checkout.

Escape always means back. Escape from a retained picker finishes that choice; Escape from an edited
Environment asks before discarding the draft; Escape during a mutation is absorbed until the safe
boundary. No `b`, `y`, or hidden Escape alias duplicates those outcomes.

- **Production:** `ExtensionSetupDraft`, `openExtensionPicker`, `installAndStage`, `resolveReview`,
  `apply`, `backFromExtensions`, and `spec` in
  `packages/code/src/views/config/ExtensionsHub.tsx`; `EnvironmentService.previewComposition` and
  `applyComposition` in `packages/protocol/src/environments.ts`.
- **Test:** `packages/code/tests/integration/extensions-hub-render.test.tsx` (complete journey,
  discard confirmation, install staging, origin replacement, long delta, and active-run cases).

## 3. Plugins surface

### 3.1 Collection navigation

Plugins is a two-dimensional browser. Left/right changes the collection, up/down changes the plugin
row, `/` searches the current collection, and Enter opens the selected plugin detail.

Collections are ordered as:

1. **All** — exact installed inventory plus listings whose name has no installed origin;
2. **Installed (N)** — every installed origin, active or inactive;
3. one collection per exact marketplace URL, labelled by its presentation name;
4. **Workspace (N)** — exact workspace plugin inventory;
5. **Add Marketplace** — an action surface for a Git catalog URL.

The listing projection carries `marketplaceUrl` in addition to the marketplace label. Two catalogs
with the same presentation name therefore never share a collection accidentally. On narrow
terminals the collection bar retains a centered window and reports hidden collections on either
side.

Search is fuzzy and collection-local. Changing collection resets the row selection but retains the
query, which makes the same capability easy to compare across sources. The list uses 36 retained
slots; a catalog never mounts one renderable or timer per plugin.

- **Production:** `MarketplaceListing.marketplaceUrl` and `createMarketplaceAdapter.listings` in
  `packages/code/src/adapters/marketplace.ts`; `collections`, `collectionRows`, `changeCollection`,
  `collectionBar`, and `StableWindowedList` in
  `packages/code/src/views/config/MarketplaceBrowser.tsx`.
- **Test:** `packages/code/tests/integration/marketplace-browser-render.test.tsx` (exact source,
  workspace, search, empty/error, and 196-listing cases).

### 3.2 Detail and lifecycle

The list never installs on its first Enter. Detail names the source and lifecycle, and for installed
plugins shows the exact inventory origin, active Environment state, declared capabilities,
executables, revision, and path.

An available listing's second Enter is one composed intent:

1. install a marketplace checkout into the shared `.agents/plugins` inventory, while direct Git
   installation keeps the explicit `.agents/plugins` or `.clarvis/plugins` choice;
2. add that exact returned ref to the current custom Environment, or to the builtin selection
   settings that define `builtin:default`;
3. reconnect at an idle boundary;
4. reload installed inventory and render it green only if the resolved Environment reports it
   active.

That action is the consent for the complete plugin. It does not open a second plugin or hook approval
screen. A failed membership write removes the just-installed checkout; a failed reconnect keeps the
persisted membership and reports that `/reconnect` is still required.

Enter on an installed detail opens the Environment composer primed with that exact plugin. `u`
confirms that an update may change skills, MCP servers, hooks, or executable services before the
kernel update/recompose path runs. `d` confirms uninstall, first removes active Environment
membership and reconnects, then removes the checkout. Workspace-owned checkouts must be edited in
the repository rather than deleted or updated through the host.

Selected plugin update/uninstall is refused while a run is active. A run keeps the content snapshot
and fingerprint captured at its start; no list refresh, update, trust transition, or Environment
change mutates it.

- **Production:** `installAndActivatePlugin`, `persistPluginMembership`, `updatePlugin`,
  `uninstallPlugin`, and `selectedPluginLifecycleBlock` in
  `packages/code/src/app/commands.tsx`; `pluginDetail`, `listingDetail`, `update`, and `uninstall` in
  `packages/code/src/views/config/MarketplaceBrowser.tsx`; lifecycle enforcement in
  `packages/kernel/src/plugins/plugin-service.ts`.
- **Test:** `packages/code/tests/integration/app-commands.test.tsx` (install remains active after
  reload), `packages/code/tests/integration/marketplace-browser-render.test.tsx` (details, update,
  uninstall, progress), and `packages/kernel/tests/integration/plugin-service.test.ts` (active-run
  lifecycle refusal).

### 3.3 Marketplace sources and direct Git

The official Clarvis marketplace is virtual and precedes configured and discovered sources. Adding
a marketplace writes only its URL to global settings and refreshes catalogs. It installs no plugin.
The Add Marketplace collection accepts a Git repository that publishes `marketplace.json` or
`.agents/marketplace.json`. `g` remains the explicit direct-plugin Git path and asks which compatible
inventory convention owns the checkout.

A failed source remains visible in All and in its own collection without erasing successful
catalogs. Refresh clears cached fetch results and retries every exact URL.

- **Production:** `OFFICIAL_MARKETPLACE_URL`, `createMarketplaceAdapter`, and
  `addMarketplaceSource` in `packages/code/src/adapters/marketplace.ts`; `addMarketplaceView` and
  `currentSourceError` in `MarketplaceBrowser`.
- **Test:** `packages/code/tests/integration/marketplace.test.ts` and
  `packages/code/tests/integration/marketplace-browser-render.test.tsx`.

## 4. Environment administration

The Environment browser is diagnostics and lifecycle administration, not a second composer. It
lists builtin/global/workspace definitions, exact status and fingerprint, counts, issues, selected
plugins and standalone skills. Creating, cloning, or configuring returns into the guided composer.

`builtin:default` is immutable. An inactive custom Environment with a known revision exposes `d`;
deletion is danger-confirmed and revision-bound. The active Environment, an Environment selected by
`--env`, or an entry without a safe expected revision cannot be deleted from Code.

Selection preview uses normal precedence. Apply and reconnect status stays footer-right with spinner
and elapsed time, so it remains visible when the exact delta is taller than the viewport.

- **Production:** `EnvironmentBrowser` in
  `packages/code/src/views/config/EnvironmentBrowser.tsx`; `EnvironmentService.delete` in
  `packages/protocol/src/environments.ts` and
  `packages/kernel/src/environments/environment-manager.ts`.
- **Test:** `packages/code/tests/integration/environment-browser-render.test.tsx` and
  `packages/kernel/tests/integration/environment-manager.test.ts`.

## 5. Trust and changed content

Plugin installation is explicit consent for that plugin's declared unit. Workspace trust is a
different boundary: cloning or entering a workspace can expose executable settings and selected
workspace plugin content that the operator did not just install.

When the workspace trust verdict is `unapproved` or `changed`, Code proactively opens the Workspace
approval question before the ordinary shell. It names the exact Environment id and fingerprint,
counts affected plugins/MCP/hooks, and lists withheld risk categories. Enter approves that exact
snapshot while idle; `n` keeps it blocked and opens `/extensions` so the operator can remove content;
Escape keeps it blocked. `/workspace-trust` is the later fallback for reopening or revoking this
decision, not the primary onboarding path.

Approving or revoking trust cannot occur during a run. An idle transition recomposes the selected
Environment before future runs. A changed fingerprint never silently falls back to a broader
Environment.

- **Production:** `WorkspaceTrustPrompt` in
  `packages/code/src/views/config/WorkspaceTrustPrompt.tsx`; startup routing and
  `workspace.trust.prompt` in `packages/code/src/app/commands.tsx`; trust transition enforcement in
  `packages/kernel/src/environments/environment-manager.ts`.
- **Test:** `packages/code/tests/integration/app-shell-render.test.tsx` (proactive changed-workspace
  prompt) and `packages/kernel/tests/integration/environment-manager.test.ts` (idle recompose and
  active-run refusal).

## 6. Progress and responsive behavior

Installing, updating, uninstalling, resolving, applying, reconnecting, and trust approval use the
shared 200 ms spinner clock. Work status is always in the footer-right status slot with elapsed time;
content may also explain the phase, but no operation depends on a transient notification or an
off-screen last row. Local mutation keys are gated while work is pending.

At 80×24 the collection window, selected row or detail, and footer decision remain visible. Detail
and long Environment review bodies scroll independently. Marketplace source loads, Environment
inventory, and plugin scans run only on initial load or explicit refresh, never on arrow movement.

The production collection soak warms the retained renderer, then performs 100 right/left collection
round trips at 120×32 and 80×24. It requires zero growth in renderables, lifecycle owners, live key
layers, and key-layer registrations after warm-up. The extension-composer soak separately churns
196 retained rows and a pending install.

- **Production:** `footerStatus` and `useSpinnerClock` in `MarketplaceBrowser`,
  `EnvironmentBrowser`, `ExtensionsHub`, and `WorkspaceTrustPrompt`; benchmark cases in
  `packages/code/tooling/benchmarks/overlays.tsx`.
- **Test:** `marketplace-collections-retained-196-listings`,
  `extensions-setup-retained-196-listings`, and `extensions-setup-pending-install` through
  `bun run bench:code-overlays`.

## 7. Invariants

1. **EXT-1 — one public route.** `/extensions` is the only slash token; every focused surface is an
   internal child and Escape follows the return stack. Production: command registrations in
   `packages/code/src/app/commands.tsx`. Test: `app-commands.test.tsx` and
   `app-shell-render.test.tsx`.
2. **EXT-2 — exact source identity.** Marketplace collection identity uses the catalog URL; plugin
   and Environment identity uses `scope/source/name`. Presentation names cannot redirect either.
   Production: `MarketplaceListing.marketplaceUrl`, `MarketplaceCollection.id`, and protocol
   Environment refs. Test: marketplace collection and same-name origin cases.
3. **EXT-3 — focused install is atomic consent and activation.** A successful Marketplace install
   selects the exact returned plugin, reconnects, and stays active after reload, with no hook review
   gate. Production: `installAndActivatePlugin` and `pluginSettingsContributions`. Test:
   `app-commands.test.tsx` and `plugin-contributions.test.ts`.
4. **EXT-4 — an in-flight run is immutable.** Selected content update/uninstall, trust transitions,
   and Environment changes wait for an idle boundary. Production: plugin and Environment kernel
   lifecycle guards. Test: kernel plugin-service and environment-manager integration suites.
5. **EXT-5 — errors fail visibly.** Missing definitions, degraded exact refs, failed marketplace
   sources, and reconnect failure never substitute `builtin:default` or paint inactive inventory as
   active. Production: Environment resolver and Code error/status projections. Test: focused Code
   and kernel integration suites.
6. **EXT-6 — bounded retained navigation.** Marketplace row and collection movement performs no
   filesystem scan, network fetch, per-row timer allocation, or key-layer registration after warm-up.
   Production: retained list, shared spinner clock, explicit reload. Test:
   `marketplace-collections-retained-196-listings`.

## 8. Non-goals

Environment definitions do not own model/provider choice, agent profiles, grants, sandbox, guard,
memory, secrets, plugin versions, inheritance, or per-contribution masks. Marketplace ranking,
pagination, signed publisher identity, and automatic remote updates remain outside this iteration.
