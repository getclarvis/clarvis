# Extension Profiles: deterministic activation snapshots

> Implemented by `packages/protocol/src/extension-profiles.ts`,
> `packages/kernel/src/extension-profiles/extension-profile-manager.ts`, the Extension Profile composition in
> `packages/kernel/src/file-kernel.ts`, and the control surface in
> `packages/code/src/views/config/ExtensionProfileBrowser.tsx`. Exact skill filtering is delegated to
> `packages/skills/src/{types,config,registry}.ts`; persisted run identity crosses
> `packages/loop`, `packages/trace`, `packages/kernel`, and `packages/code`.

## 1. Purpose

An **Extension Profile** selects which already-installed extensions compose the active Clarvis kernel. It
does not install plugins, copy `settings.json`, select a model or Agent Profile, carry secrets,
change grants/sandbox/memory, pin plugin versions, or inherit from another Extension Profile. A custom
Extension Profile is a complete allow-list of exact plugin installations and standalone skills; plugin
contributions remain atomic. (`ExtensionProfileDefinition` in
`packages/protocol/src/extension-profiles.ts`; `resolved` and `skillRoots` in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`.)

The immutable virtual `builtin:default` activates the exact `{ scope, source, name }` references in
`enabledPlugins`; plugin skills follow those active plugins, and standalone skills use all four
standard roots with their ordinary last-root-wins precedence. A same-name install in another scope
or filesystem convention is never substituted. (`defaultStandaloneSelection` and the builtin
branches in `resolved`, `packages/kernel/src/extension-profiles/extension-profile-manager.ts`; exact inventory
cases in `packages/kernel/tests/integration/extension-profile-manager.test.ts`.)

The kernel owns discovery, resolution, trust, and snapshot identity. `@clarvis/skills` receives only
resolved roots and exact `include` lists, while the loop sees roots plus opaque host metadata rather
than an Extension Profile domain object. (`skillRoots` in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`; `HostRunDeps.hostMetadata` in
`packages/loop/src/runtime/execute-run.ts`.)

## 2. Surface

`@clarvis/protocol` publishes the complete transport-neutral surface in
`packages/protocol/src/extension-profiles.ts` (`ExtensionProfileService` and its DTOs):

| Type or method | Contract |
| --- | --- |
| `ExtensionProfileRef` | Definition identity: `builtin`, `global`, or `workspace` plus name. |
| `ExtensionProfilePluginRef` | Exact installed plugin: `global | workspace`, `agents | clarvis`, plus name. |
| `ExtensionProfileSkillRef` | Exact standalone source: `user | workspace`, `agents | clarvis`, plus name. |
| `ExtensionProfileDefinition` | Version-one description and complete `plugins` / `skills` allow-lists. |
| `ResolvedExtensionProfile` | Immutable resolution snapshot, status, fingerprint, resolved contributions, issues, and counts. |
| `ExtensionProfileInventory` | Every exact installed plugin and discovered standalone skill, projected inactive for composition. |
| `ExtensionProfilePreview` | Current/target snapshots, exact delta, expiring apply token, and workspace-trust requirement. |
| `ExtensionProfileCompositionPreview` | Current, authored, and normally effective snapshots plus one definition-and-selection apply token. |
| `ExtensionProfileService` | `list`, `current`, `get`, `inventory`, `preview`, `previewClear`, `previewComposition`, `select`, preview-bound `clearSelection`, `applyComposition`, `create`, revision-bound `update`/`delete`, and `clone`. |

`KernelClient.extensionProfiles` exposes that service beside the other kernel services
(`KernelClient.extensionProfiles`, `packages/protocol/src/client.ts`). The in-process kernel accepts an injected service and gives
embedders an immutable builtin-only fallback (`createBuiltinExtensionProfileService` in
`packages/kernel/src/kernel.ts`); the file kernel supplies the file-backed manager
(`packages/kernel/src/file-kernel.ts`). The same fourteen operations are generated for local
and remote clients by the shared operation catalog (`OPERATIONS.extensionProfiles` entries in
`packages/kernel/src/transport/operations.ts`).

Code exposes the surface under Extensions as **Extension Profile**, explicitly distinct from the
**Agent Profile** that selects an agent definition for a run. The
primary route guides scope, definition/clone choice, exact inventory, capability review, and one
composition apply. The focused view lists and diagnoses definitions, routes creation/customization
into that composer, previews direct selection/clear deltas, and reconnects the backend
(`ExtensionsHub` and `ExtensionProfileBrowser` in `packages/code/src/views/config`). The focused Plugins
browser composes installation and exact membership through the current Extension Profile; its configure
action returns to the guided composer primed with the selected exact ref (`marketplace.open`
registration in `packages/code/src/app/commands.tsx`).

## 3. Data and formats

### 3.1 Definition and selection paths

| Data | Path | Ownership |
| --- | --- | --- |
| Global definition | `<global>/extension-profiles/<name>.json` | operator-authored, reusable |
| Workspace definition | `<workspace>/.clarvis/extension-profiles/<name>.json` | repository-shareable authored content |
| Global selection | `<global>/state/extension-profile.json` | machine-local operator state |
| Workspace selection | `<global>/state/workspaces/<segment>/local/extension-profile.json` | machine-local per-workspace state |

The path vocabulary is constructed only by `globalPaths`, `workspacePaths`, and
`workspaceStatePaths` (`packages/paths/src/global.ts`;
`packages/paths/src/workspace.ts`; `packages/paths/src/workspace-state.ts`).
Definitions may therefore be committed, while merely cloning a repository does not select one.
Listing definitions materializes an absent global catalog with `DIR_MODE`, but an absent workspace
catalog contributes no definitions and is not created as a read side effect. Both an initial
`opendir` absence and an `ENOENT` raised later by bounded directory iteration follow that same rule
(`missingDefinitionCatalog`, `definitionNames`, and `list` in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`).

### 3.2 Version-one definition

```json
{
  "schema_version": 1,
  "description": "Research with browser and documentation",
  "plugins": [
    { "scope": "global", "source": "agents", "name": "browser" },
    { "scope": "global", "source": "clarvis", "name": "github" }
  ],
  "skills": [
    { "scope": "user", "source": "clarvis", "name": "deep-research" }
  ]
}
```

Names are safe 1-128-character identifiers; definitions are strict JSON, at most 1 MiB, with at
most 64 plugins and 256 standalone skills. Duplicate plugin names across scopes and duplicate skill
names across roots are rejected because the downstream catalogs merge by unqualified name. A global
definition may reference only global plugins and user-scoped skills. (`definitionSchema`,
`readBounded`, and `parseDefinition` in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`.)

Each scope admits at most 128 definition files and 256 total directory entries. Create operations
hold a scope-wide catalog lease before the per-definition lease, re-read both limits inside that
transaction, and create only when the exact target is observably absent. An unreadable, symlinked,
or non-regular existing entry is never replaced. (`definitionNames`, `underLease`, and
`writeDefinition` in `packages/kernel/src/extension-profiles/extension-profile-manager.ts`.)

Selection documents are strict `{ "schema_version": 1, "extension_profile": ExtensionProfileRef }` JSON
written atomically. A global selection cannot point at a workspace definition
(`selectionSchema`, `selectionFromFile`, and `writeSelection` in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`). Definition writes
are formatted JSON and updates compare the exact-byte SHA-256 revision returned by the prior read.
Deletion accepts only authored global/workspace refs and the exact expected revision. Under both
selection leases it refuses the process-pinned Extension Profile and any definition still selected by
either global or workspace state, then removes only that exact regular file (`ExtensionProfileService.delete`
and `withDefinitionMutation` in `packages/kernel/src/extension-profiles/extension-profile-manager.ts`).
Definition and selection mutations perform that comparison under crash-recoverable local leases, so
cooperating Clarvis processes cannot both win a stale write (`underLease`, `underDefinitionLease`,
`underSelectionLeases`, and `writeDefinition` in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`; `acquireLocalLeaseSync` in
`packages/paths/src/local-lease.ts`).

### 3.3 Persisted execution identity

Every run carries only `{ id, fingerprint }` under opaque `host_metadata.extension_profile`; trace
journals, recovered records, JSON records, protocol run results, session turns, and bounded session
summaries preserve that pair. (`ExtensionProfileRunRef` in `packages/protocol/src/extension-profiles.ts`;
`hostMetadata` composition in `packages/kernel/src/file-kernel.ts`; record persistence in
`packages/trace/src/{record-builder,journal,json-trace-store}.ts`; result projection in
`storedToDetail` in `packages/kernel/src/runs/map-result.ts`; session summary projection in
`toSummary` in `packages/kernel/src/sessions/session-service.ts`.) Host metadata is sanitized before durable
storage and does not carry the Extension Profile definition or secrets
(`packages/trace/src/json-trace-store.ts`).

## 4. Behavior

### 4.1 Selection precedence and resolution

The active reference is selected in this order:

1. process-local `--extension-profile` / `CreateFileKernelOptions.extensionProfileSelector`;
2. workspace-local selection;
3. global default selection;
4. `builtin:default`.

`selectedNow` implements the persisted precedence and `selectorRef` implements qualified and bare
CLI selectors in `packages/kernel/src/extension-profiles/extension-profile-manager.ts`. A bare name
chooses an existing workspace definition before the global one; if that workspace file exists but
is invalid, it remains the selected invalid definition and does not fall through
(`does not let an invalid workspace definition fall through a bare CLI selector` in
`packages/kernel/tests/integration/extension-profile-manager.test.ts`).

Resolution inventories all four plugin roots — global/workspace crossed with
`.agents/plugins`/`.clarvis/plugins` — and matches every Extension Profile reference exactly
(`pluginInventory` and the `installedByRef` lookup in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`). No scope or source shadows, falls back
to, or substitutes for another. Selecting two distinct installations with the same runtime name is
invalid because their agents and MCP namespaces would collide. Missing or invalid references remain
in the resolved view as inactive issues; no extension outside the allow-list enters a custom
Extension Profile.

Standalone skills are inventoried separately in the four established roots. Builtin and custom
Extension Profiles emit only active, atomically captured winners with exact `include` filters; invalid or
inactive skills never re-enter through a broad root. `@clarvis/skills` normalizes that list and
filters after manifest resolution, so precedence and manifest-name validation remain unchanged
(`skillRoots` in `packages/kernel/src/extension-profiles/extension-profile-manager.ts`;
`normalizeInclude`, `packages/skills/src/config.ts`; `scanRoot`,
`packages/skills/src/registry.ts`). Plugin skill roots are admitted only through active plugins,
and a plugin's agents, MCP servers, capability executables, hooks, and skills are one activation
unit (`pluginInventory` in `packages/kernel/src/extension-profiles/extension-profile-manager.ts`). Active
plugin MCP servers are attached independently of authored agent tool lists and marked `auto_tools`;
after each server opens, all tools it advertised join every effective per-run agent while the
persisted Agent Profile remains unchanged (`createSettingsRunAssembler`, `addAutomaticMcpTools`). Plugin
hooks enter with that same atomic contribution; workspace-authored executable content remains gated
by the workspace fingerprint approval described below.

An admitted plugin skill root carries host approval for bundled-helper execution, but approval is
projected per discovered skill: `buildResolvedSkill` exposes only that skill's exact `dir` as
`SkillInfo.executionRoot`, never the collection root or plugin checkout. The loop consumes those
exact skill directories when it resolves command execution roots. Production: `skillRoots` in
`packages/kernel/src/plugins/plugin-contributions.ts`, `buildResolvedSkill` in
`packages/skills/src/registry.ts`, and `resolveSkillExecutionRoots` composition in
`packages/loop/src/runtime/build-run-deps.ts`. Test: "exposes only the selected skill directory when
its root approves helper execution" in `packages/skills/tests/integration/api.test.ts`.

An exact empty root set is intentional: the loop exposes an empty skills provider without appending
standard roots and without reporting a discovery failure. This keeps a custom Extension Profile with no
standalone or plugin skills empty of scanned extensions (`emptySkillsProvider` and `dynamicSkills` in
`packages/loop/src/runtime/build-run-deps.ts`; test
`packages/loop/tests/integration/execute-run-entrypoints.test.ts`).

The file kernel subsequently composes product-owned builtin guidance, including `clarvis-configure`,
through `withBuiltinSkills`. It is independent of Extension Profile selection and remains available
with an empty custom profile while skills are enabled. Production:
[builtin-skills.ts](../../packages/kernel/src/skills/builtin-skills.ts). Test:
[builtin-skills.test.ts](../../packages/kernel/tests/integration/builtin-skills.test.ts).
The dedicated [native configuration route](self-configuration.md) executes no extensions and does
not acquire their run lease; ordinary execution retains the pinned snapshot contract below.
Its shipped guide demonstrates exact plugin versus standalone skill scopes with a nonempty
definition. Native file authoring does not select that definition: activation still uses the
preview-bound service and a new kernel snapshot. Workflow definitions themselves are independent
of this selection; a standalone workflow launcher follows the normal skill allow-list.
Production: `CONFIGURATION_EXAMPLES` in
[configuration-examples.ts](../../packages/kernel/src/skills/configuration-examples.ts).
Test: `authors a nonempty Extension Profile, previews selection, and activates the launcher on
reconnect` in
[configuration-guidance.test.ts](../../packages/kernel/tests/integration/configuration-guidance.test.ts).

### 4.2 Status and snapshot

`ready` means every selected reference resolved and applicable trust is present; missing inventory,
an invalid plugin, or unapproved workspace executables produces `degraded`; an invalid selection or
definition produces `invalid` (`resolved` in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`).
No state silently substitutes `builtin:default`.

`resolveActive` pins one contribution snapshot for the process, except that an idle workspace-trust
transition deliberately recomposes the selected trust-dependent contribution set. Each active
plugin digest covers its resolved manifest (including MCP/hook companion semantics), bounded agent
files, packaged skill manifests, install record, resolved source revision, and every directly
referenced package-local MCP, hook, or capability process file's content, size, executable mode, and
relative path. Packaged
skill resources are hashed as streamed raw bytes by `hashBoundedFile`, capped at 8 MiB per file and
32 MiB aggregate across the plugin; the canonical identity records relative path, digest, byte
count, and executable mode. If any skill in one plugin cannot be captured, that plugin's whole
skill-root surface is withheld so a constant unavailable sentinel cannot mask sibling drift;
independently valid non-skill contributions remain. The process-file surface separately remains
capped at 256 files, 8 MiB per file, and 32 MiB per plugin (`PLUGIN_SKILL_RESOURCE_LIMITS`,
`skillSurface`, `snapshotPluginExecutables`, `snapshot`, and `pin` in
`packages/kernel/src/plugins`; `identity` and `resolveActive` in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`). Ordinary settings,
MCP and agent projections reuse those pinned parsed loadables and perform only an exact selection
check. Skill roots are projected from the pinned parse without another filesystem pass. The file
kernel supplies them through `SkillRootSnapshotProvider`; `snapshotSkills` consumes those roots while
run dependencies are constructed, materializes catalog metadata and bodies, and records the initial
resource-path allow-list. An idle trust recomposition is the only event that publishes a replacement
root set to that provider. Run admission then acquires only its in-memory lease: it performs no skill
discovery, filesystem traversal, or hashing.

After the registry is captured, `ExtensionProfileManager.observeSkillCatalog` arms `watchFile` polling on
every admitted identity file: manifest, selected sidecar, and resources. Before the capture becomes
visible, `verifySkillCatalog` re-reads the bounded identities and compares them with the pinned
digests. A mismatch in that interval uses the same memory latch and `onSkillDrift` notice as a later
watch callback; it withholds only the affected skill and does not fail dependency construction. The
ongoing maintenance is asynchronous and outside every run. Its callback does not recompute an
Extension Profile, fail the kernel, or reject work. `snapshotSkills` immediately filters a latched skill
from catalog/body access and refuses its resources. Code relays the notice through
`WorkspaceClientManager.subscribeExtensionProfileDrift` and renders a transient warning outside transcript
history. The next run continues with every unaffected skill. A reconnect is the explicit operation
that captures the changed version, while an idle trust transition atomically replaces the catalog
with the new trust-dependent roots. Package-local executable files use the same asynchronous model:
`observeRuntimeFiles` withdraws the plugin's MCP/hook/capability projections through
`runtimeAvailable`, without a run-admission or capability-location rehash. Explicitly local
declarations that are absent or do not resolve to a confined regular file are rejected during pin;
watchers bind the declaration path and compare inode/device identity as well as metadata so symlink
retargeting cannot preserve availability. Selected standalone skill
digests cover effective catalog
metadata — including sidecar MCP tool dependencies that decide catalog availability — and the
manifest; `standaloneCatalog` hashes each resource through the same raw streaming
`hashBoundedFile` path, with the same 8 MiB per-file limit and a 32 MiB aggregate limit per
standalone skill. Plugin skill digests include the same dependency projection. Those digests define
the version recorded by the process fingerprint; later sidecar changes do not alter the in-memory
catalog, and later identity-file changes cause withdrawal when the asynchronous monitor observes
them. Production: `standaloneCatalog`, `pinnedSkillRoots`, `observeSkillCatalog`,
`verifySkillCatalog`, `skillAvailable`, and `onSkillRootsChanged` in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`; `skillSurface`,
`verifyPinnedSkillCatalog`, and `pinnedSkillRoots` in
`packages/kernel/src/plugins/plugin-contributions.ts`; `snapshotSkills` in
`packages/loop/src/runtime/build-run-deps.ts`. Test: asynchronous withdrawal in
`packages/kernel/tests/integration/extension-profile-manager.test.ts`, end-to-end non-blocking admission in
`packages/kernel/tests/integration/file-kernel.test.ts`, and exact provider filtering and idle trust
replacement in
`packages/loop/tests/integration/execute-run-entrypoints.test.ts`.
The fingerprint
also covers the qualified Extension Profile id, definition revision, status, issues, and applicable trust
state/fingerprint. Hook definitions are part of the plugin manifest digest, but independent
hook-approval state is excluded from Extension Profile identity. Selection mutations return
`reconnect_required`; definition writes leave the current snapshot pinned and require the host to
reconnect when the active definition changed. They never alter an in-flight or later run on the
existing kernel. Code reconnects after selection and after a lifecycle mutation touches a selected
plugin (`ExtensionProfileBrowser.apply` and `recomposeSelectedPlugin` in `packages/code/src`).

Installing a plugin never selects it. Updating or uninstalling a selected plugin is refused while a
run is active by the kernel service boundary, not only by the TUI; the boundary also prevents a new
run from entering while the selected checkout mutation holds its lease. After a successful selected
mutation, that kernel refuses every later run with `unavailable` until reconnect, so an idle caller
cannot keep using the stale fingerprint. Code reconnects the kernel so the next resolved fingerprint
and status match the changed inventory. Installing a previously missing selected ref also reconnects
it (`withSelectedMutation` in `packages/kernel/src/{kernel,plugins/plugin-service}.ts`;
`selectedPluginLifecycleBlock` and `recomposeSelectedPlugin` in
`packages/code/src/app/commands.tsx`).

### 4.3 Preview, composition, trust, and resume

Before an interactive selection or local-selection clear, Code asks the kernel for an exact delta
of plugins, standalone and plugin skills, MCP servers, and hook counts, then requires explicit
confirmation
(`deltaOf` in `packages/kernel/src/extension-profiles/extension-profile-manager.ts`;
`ExtensionProfileBrowser.apply`, `packages/code/src/views/config/ExtensionProfileBrowser.tsx`). A preview
token is single-use, expires after five minutes, and binds the mutation kind, selected reference,
persisted selection scope, both exact selection-document revisions, and resolved target fingerprint.
Both `preview` and `previewClear` resolve normal precedence without changing state: a global write
already shadowed by a workspace selection previews that unchanged effective Extension Profile. Either
selection document can determine the effective target, so a changed target, selection, or fallback
fails with `conflict` (`selectedAfterWrite`, `preview`,
`previewClear`, `ExtensionProfileService.select`, and `ExtensionProfileService.clearSelection` in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`).

The guided composer reads `ExtensionProfileService.inventory()` once per coalesced refresh and stages a
complete definition in Code memory. `previewComposition` binds that definition's canonical bytes,
its expected prior revision (or exact absence), both selection-document revisions, the authored
snapshot fingerprint, and the normally effective target fingerprint. `applyComposition` consumes
the token once, revalidates those facts under catalog/definition/selection leases, and writes the
definition plus intended selection as one recoverable operation. No conflict writes a substitute
definition or a different selection; trust approval failure restores both prior documents. A
workspace-local selection that already shadows a new global default remains the effective target.
If that unchanged target is untrusted, the global write neither activates it nor grants new trust
(`inventory`, `previewComposition`, `applyComposition`, `restoreDefinition`, and
`restoreSelection` in `packages/kernel/src/extension-profiles/extension-profile-manager.ts`; composition cases
in `packages/kernel/tests/integration/extension-profile-manager.test.ts`).

The workspace executable surface inventories every installed `scope: "workspace"` plugin from both
repository-owned conventions, whether the current Extension Profile selects it yet or not. Each entry
contains its exact qualified ref and atomic contribution digest. A global plugin lives in an
operator-owned inventory: installing it through the TUI is its approval, and selecting it from a
workspace Extension Profile requires no additional workspace approval. Repository-owned plugins are
different: after the first-paint composer, Code asks automatically as soon as the complete app has
the resolved trust state. Repository plugins stay inactive while that state is resolving. The one
verdict covers the complete workspace fingerprint, every inventoried workspace plugin and every
later Extension Profile selection while their bytes remain unchanged; there is no per-plugin or
per-Extension Profile approval. Adding, removing, repairing, or changing a repository plugin is observed
by a fresh explicit approval or the next kernel connection, which changes the workspace fingerprint
and returns the verdict to `changed`. Ordinary settings reads reuse the process-captured trust
surface and never walk that inventory in front of a run. Until approval, only selected
workspace-owned plugins remain inactive; global plugins in
the same Extension Profile remain admitted
(`workspaceTrustSurface` and `workspaceTargetNeedsApproval` in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`; `workspaceExecutableSurface` in
`packages/kernel/src/config/workspace-trust.ts`). A selection may still carry the workspace approval
when the proactive question was declined, and an approval failure restores the exact prior selection
bytes. Plugin hooks are part of the selected plugin unit rather than a second approval projection
(`ExtensionProfileService.select`, `restoreSelection`, and `PluginContributions.settingsScopes`; test
`packages/kernel/tests/integration/extension-profile-manager.test.ts` "restores the prior selection").

Approving or revoking workspace trust recomposes the selected workspace (or `builtin:default`
workspace-derived) plugin set and atomically replaces its exact skill catalog when the kernel is
idle. The same transition returns
`conflict` while a run is active, before the trust store is changed, so no in-flight snapshot gains
or retains executable contributions under a different verdict
(`assertWorkspaceTrustTransitionAllowed` and the trust-transition branch of `resolveActive`).
`approveWorkspace` requests a fresh surface and the production file-kernel adapter forwards that
request to `ExtensionProfileManager.workspaceTrustSurface`, so consent cannot record a previously cached
plugin digest.
Code then reads `ExtensionProfileService.current()` and replaces its process snapshot cache before the
trust operation resolves to the caller (`mutateTrust` in
`packages/code/src/adapters/kernel-run-client.ts`).

When a saved session resumes under a different `{ id, fingerprint }`, Code preserves the session,
adds a visible warning, and marks the status instead of pretending continuity under the same
extension snapshot (Extension Profile comparison in `resumeSession`,
`packages/code/src/run-host.ts`). Newly started turns are
stamped with the current process snapshot (`createSession.beginTurn` in
`packages/code/src/adapters/session.ts`).

## 5. Invariants

### INV-314 — Install and activation remain separate

An Extension Profile resolver never clones, updates, removes, or otherwise installs a plugin; it selects
only the installed inventory. Plugin lifecycle remains on `PluginService`.

- **Production:** `pluginInventory` in
  `packages/kernel/src/extension-profiles/extension-profile-manager.ts`; `ExtensionProfileService` in
  `packages/protocol/src/extension-profiles.ts` has no install operation.
- **Test:** `packages/kernel/tests/integration/extension-profile-manager.test.ts` constructs all four
  inventories before exact activation and proves an unrelated install stays inactive.

### INV-315 — Custom definitions are complete allow-lists with exact installation identity

The builtin activation list does not leak into a custom Extension Profile, and no `{ scope, source, name }`
reference silently means another scope or source.

- **Production:** custom branches and exact `installedByRef` lookup in `resolved` in
  `packages/kernel/src/extension-profiles/extension-profile-manager.ts`.
- **Test:** `packages/kernel/tests/integration/extension-profile-manager.test.ts` proves exact global
  `.agents`/`.clarvis` selection despite same-named alternatives and proves unselected installs are
  absent.

### INV-316 — Invalid state fails closed

An invalid selection or definition activates neither custom plugins nor standalone skills and never
falls back to builtin.

- **Production:** `validDefinition`, `pluginViews`, and `skillViews` gates in
  `packages/kernel/src/extension-profiles/extension-profile-manager.ts`.
- **Test:** `fails closed for an invalid persisted selection` and `does not let an invalid workspace
  definition fall through a bare CLI selector` in
  `packages/kernel/tests/integration/extension-profile-manager.test.ts` pin both invalid cases.

### INV-317 — A kernel uses one immutable resolved snapshot

Definition/selection changes require reconnection; a stale preview cannot authorize different
bytes, and an already running kernel retains its original fingerprint except for the explicit idle
trust recomposition. Run admission is deliberately
independent of extension filesystem size: it does not discover, stat, or hash skills. Only atomically
captured plugin skill surfaces and exact builtin/custom standalone includes enter the one registry
owned by the dependencies; catalog bodies are materialized there, and resource names are constrained
to that captured allow-list. The host arms monitoring for manifest, selected sidecar, and resources
before verifying the capture against the pin. A capture-window mismatch or later asynchronous change
withdraws one skill by flipping a memory latch. Withdrawal never makes the Extension Profile or run
admission unavailable; Code informs the user outside transcript history, unaffected skills continue,
and reconnect captures the changed version. Skill resources enter initial identity through raw
streaming hashes capped at 8 MiB per file and 32 MiB aggregate (per plugin for packaged skills, per
skill for standalone inventory), and an approved plugin root exposes only each discovered skill
directory for helper execution. Read-only/control-plane projections use the pinned parse. Trust transitions may recompose
only at an idle boundary and synchronously replace the exact skill catalog; explicit approval
refreshes the trust surface through the file-kernel adapter before recording consent, while ordinary
settings reads reuse its cached process snapshot.

- **Production:** `PluginContributions.pin`, `pinnedSkillRoots`,
  `PLUGIN_SKILL_RESOURCE_LIMITS`, `skillSurface`, `hashBoundedFile`, `snapshotPluginExecutables`,
  `standaloneCatalog`, `ExtensionProfileManager.observeSkillCatalog`,
  `ExtensionProfileManager.verifySkillCatalog`, `ExtensionProfileManager.skillAvailable`,
  `ExtensionProfileManager.onSkillRootsChanged`, `PluginContributions.verifyPinnedSkillCatalog`,
  `SkillRootSnapshotProvider`, `snapshotSkills`, `withRunLease`,
  the memory factory's host executor, pinned `resolveActive`, revision CAS,
  and preview fingerprint comparison in `packages/kernel/src`; `hashBoundedFile` and the two
  `MAX_SKILL_RESOURCE_*` snapshot limits in `packages/skills/src`.
- **Test:** the stale-preview, global-precedence, contribution-fingerprint, standalone-resource
  withdrawal, and trust-transition
  cases in `packages/kernel/tests/integration/extension-profile-manager.test.ts`, including process-file
  fingerprint drift; the MCP/hook/capability process-file drift cases in
  `packages/kernel/tests/integration/plugin-contributions.test.ts`, including invalid-sibling and
  aggregate-resource withholding; standalone aggregate-resource withholding and builtin exact-root
  filtering in `extension-profile-manager.test.ts`;
  exact-root capture, post-watch verification, idle trust replacement, and withdrawal in
  `packages/loop/tests/integration/execute-run-entrypoints.test.ts`; run admission after drift in
  `packages/kernel/tests/integration/file-kernel.test.ts`; the transient Code notice in
  `packages/code/tests/integration/app-shell-render.test.tsx`;
  the run-lease helper and memory factory executor tests; and the selected lifecycle case in
  `packages/kernel/tests/integration/run-service.smoke.test.ts`.

### INV-318 — Workspace executable activation participates in workspace trust

All repository-owned `scope: "workspace"` plugins share one content-addressed workspace approval,
including installed checkouts not yet selected by an Extension Profile. Code asks proactively at session
start. Global plugins installed into operator-owned inventories are already consented and remain
outside this gate.

- **Production:** cached and explicit-refresh paths in `workspaceTrustSurface`, `preview`, `select`,
  `assertWorkspaceTrustTransitionAllowed`, and `onSkillRootsChanged` in
  `packages/kernel/src/extension-profiles/extension-profile-manager.ts`; option forwarding in
  `packages/kernel/src/file-kernel.ts`; and the file config store approval adapter.
- **Test:** the complete pre-selection inventory fingerprint, global-plugin-without-workspace-
  approval, mixed-scope partial-admission, one-approval Extension Profile switching, proactive Code prompt,
  idle trust-recomposition, approval-refresh forwarding, and trust-driven skill-catalog replacement
  cases in
  `packages/kernel/tests/integration/extension-profile-manager.test.ts`; the extension-surface case in
  `packages/kernel/tests/integration/workspace-trust.test.ts` pins explicit-refresh changes to the
  trust hash and proves active-run rejection occurs before the trust store is changed.

### INV-319 — Execution history identifies its extension snapshot without secrets

Runs, persisted traces, session turns, and session summaries retain Extension Profile id plus fingerprint;
durable host metadata is sanitized.

- **Production:** `executeRun` host metadata in `packages/loop/src/runtime/execute-run.ts`;
  `buildRecord` in `packages/trace/src/record-builder.ts`; `storedToDetail` in
  `packages/kernel/src/runs/map-result.ts`; session projection in `metaToSession` in
  `packages/code/src/adapters/session-store.ts`.
- **Test:** `packages/loop/tests/component/execute-run.test.ts`,
  `packages/trace/tests/integration/json-trace-store.test.ts`,
  `packages/kernel/tests/unit/map-result.test.ts`, and
  `packages/code/tests/component/session-store.test.ts` cover the four seams and redaction.

### INV-320 — The loop and skills package do not own Extension Profile policy

The loop accepts opaque host metadata and resolved roots; the skills package only applies exact
root filters. Neither imports the kernel Extension Profile manager or protocol service.

- **Production:** `HostRunDeps.hostMetadata` in `packages/loop/src/runtime/execute-run.ts` and
  `SkillRootInput.include` in `packages/skills/src/types.ts`.
- **Test:** `packages/loop/tests/component/execute-run.test.ts`,
  `packages/skills/tests/integration/discovery.test.ts`, and the existing optional-package
  architecture suites under `packages/loop/tests/architecture/`.

### INV-321 — Definition creation is bounded, serialized, and non-overwriting

Two processes cannot both create past a catalog limit, and creation never replaces an entry whose
absence cannot be established safely.

- **Production:** `definitionNames` and `writeDefinition` in
  `packages/kernel/src/extension-profiles/extension-profile-manager.ts` enforce catalog and
  per-definition leases, both limits, exact absence, and atomic publication.
- **Test:** `serializes catalog creates and enforces both catalog resource bounds` in
  `packages/kernel/tests/integration/extension-profile-manager.test.ts` holds the catalog lease and
  proves both bounds; `never replaces an existing definition entry it cannot read safely` proves a
  non-regular target survives unchanged.

### INV-322 — Hook definitions are part of the atomic plugin snapshot

The selected plugin manifest, including every hook definition and executable declaration, and every
directly referenced package-local process file are hashed into the Extension Profile identity. No mutable
per-hook approval projection or changed process byte can alter execution eligibility underneath an
unchanged `{ id, fingerprint }`.

- **Production:** `PluginContributions.pin` and `contributionSnapshot` in
  `packages/kernel/src/plugins/plugin-contributions.ts`; `snapshotPluginExecutables` in
  `packages/kernel/src/plugins/plugin-executable-snapshot.ts`.
- **Test:** `packages/kernel/tests/integration/extension-profile-manager.test.ts` (content, skill, and
  process-file fingerprint drift) and
  `packages/kernel/tests/integration/plugin-contributions.test.ts` (selected hooks compose with
  their plugin and all three process projections reject changed bytes).

### INV-323 — Missing catalogs are safe and workspace reads are side-effect-free

The first definition listing creates an absent global catalog with private directory permissions.
An absent workspace catalog is an empty inventory and is never created merely by opening the view;
an absence reported during either directory open or bounded iteration has the same outcome.

- **Production:** `missingDefinitionCatalog`, `definitionNames`, and `list` in
  `packages/kernel/src/extension-profiles/extension-profile-manager.ts`.
- **Test:** `packages/kernel/tests/integration/extension-profile-manager.test.ts` ("materializes an empty
  global catalog without writing into the workspace").

### INV-324 — Guided composition is one preview-bound recoverable mutation

A composition apply can write only the definition bytes and normally effective selection reviewed
under its token. Definition, inventory, or selection drift fails before either write; approval
failure restores both prior documents.

- **Production:** `previewComposition`, `applyComposition`, `withDefinitionMutation`,
  `restoreDefinition`, and `restoreSelection` in
  `packages/kernel/src/extension-profiles/extension-profile-manager.ts`.
- **Test:** the composition success, stale-definition, inventory-drift, shadowed-precedence,
  unchanged-untrusted-target, trust-rollback, and token-replay cases in
  `packages/kernel/tests/integration/extension-profile-manager.test.ts`.

### INV-325 — Definition deletion is inactive, exact, and revision-bound

Deletion cannot name the builtin, cannot remove a definition selected at either precedence level,
and cannot remove bytes other than the revision the caller inspected.

- **Production:** `ExtensionProfileService.delete`, `withDefinitionMutation`, and
  `underSelectionLeases` in `packages/kernel/src/extension-profiles/extension-profile-manager.ts`.
- **Test:** `packages/kernel/tests/integration/extension-profile-manager.test.ts` (deletion lifecycle and
  stale revision cases) and `packages/code/tests/integration/extension-profile-browser-render.test.tsx`
  (danger-confirmed inactive delete).

## 6. Failure modes and degradation

| Condition | Result |
| --- | --- |
| Missing selected definition | `invalid`, `missing_definition`; nothing custom activates. |
| Invalid JSON/schema/scope | `invalid`, `invalid_selection` or `invalid_definition`; no fallback. |
| Missing plugin or skill | `degraded` with the exact qualified missing reference; healthy selected entries remain active. |
| Invalid plugin manifest | `degraded`; that plugin is present but inactive. |
| Workspace trust absent | `degraded`, `workspace_untrusted`; selected `scope: "workspace"` plugins are inactive. Global installed plugins do not require this verdict. |
| Definition changed after read or another Clarvis writer holds its definition/catalog lease | revision-bound mutation returns `conflict`. |
| Definition catalog reached 128 definitions or 256 entries | `create` returns `resource_exhausted`; no partial file is written. |
| Existing target is unreadable or non-regular | `create` returns `unavailable` and never replaces it. |
| Delete targets the builtin, an active/selected definition, or a stale revision | `invalid_request` or `conflict`; no file is removed. |
| Target, selection bytes/scope, or precedence fallback changed after preview | `select` or `clearSelection` returns `conflict`; no selection is changed. |
| Draft definition, expected definition revision, selection bytes, or resolved inventory changed after composition preview | `applyComposition` returns `conflict`; neither definition nor selection is written. |
| Active CLI override | persisted `select` and `clearSelection` return `conflict`; edit/reconnect may still reload the same CLI-selected definition. |
| Malformed service input from an embedder or transport | `invalid_request`; no path is constructed or file touched. |
| Workspace approval storage fails after a selection write | the exact prior selection is restored and the approval error is returned. |
| Workspace approval storage fails during composition | the exact prior definition and selection are restored and the approval error is returned. |
| A selected skill manifest or captured resource changes after snapshot resolution | the asynchronous monitor withdraws that skill when observed, Code shows an informational transient warning, unaffected skills remain available, and runs are never rejected or delayed; reconnect captures the new version. |
| Workspace trust changes or selected plugin update/uninstall is requested during a run | `conflict`; the trust store and selected checkout remain unchanged. |
| A selected plugin update/uninstall completed but the kernel was not reconnected | the old parsed process snapshot remains active; changed monitored skills are withdrawn when observed, and reconnect activates the new selection bytes. |
| Global definition catalog is absent | listing creates it with private directory permissions and continues with `builtin:default`. |
| Workspace definition catalog is absent | listing treats it as empty and does not create repository content. |
| Definition directory or file exceeds a resource bound | list/get reports an invalid entry; it never returns a partial silently usable definition. |

The failures are implemented by `readBounded`, `definitionNames`, `resolved`, `writeDefinition`, and
`ExtensionProfileService.select` in `packages/kernel/src/extension-profiles/extension-profile-manager.ts`. The TUI
renders status, every issue, missing contribution, fingerprint, and source rather than reducing a
degraded Extension Profile to an empty list (`fullDetail` and `normalBody` in
`packages/code/src/views/config/ExtensionProfileBrowser.tsx`).

## 7. Coupling

- `@clarvis/paths` owns definition and machine-local selection locations.
- `@clarvis/protocol` owns DTOs and the service interface without implementation dependencies.
- `@clarvis/kernel` owns installed inventory, definition parsing, selection, trust, resolution,
  hashing, previews, snapshots, and transport operations.
- `@clarvis/skills` owns generic root discovery and the exact `include` mechanism, not Extension Profile
  selection.
- `@clarvis/loop` carries opaque host metadata into trace persistence and consumes already-resolved
  skill roots.
- `@clarvis/trace` persists sanitized host metadata without interpreting the Extension Profile shape.
- `@clarvis/code` owns CLI selection, Extension Profile UX, backend reconnection, session stamping, and
  resume mismatch warnings.

The package dependency graph is unchanged: the feature uses existing `kernel -> protocol|paths|skills|loop|trace`
and `code -> kernel|protocol|paths` edges. The loop's optional `skills` dependency remains behind its
existing lazy capability boundary; Extension Profile resolution happens in the file-backed host before run
construction (`packages/kernel/src/file-kernel.ts`).

## 8. Open questions

There are no unresolved version-one contract questions. Version pinning, Extension Profile inheritance,
partial plugin contribution masks, model/provider selection, Agent Profiles, grants/sandbox,
memory, secrets, and automatic repository activation are deliberately out of scope. A user who
needs a variation clones an Extension Profile and edits the complete allow-list; any expansion of that
scope requires a new schema version and an explicit product decision.
