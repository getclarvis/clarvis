# Extension Environments: deterministic activation snapshots

> Implemented by `packages/protocol/src/environments.ts`,
> `packages/kernel/src/environments/environment-manager.ts`, the Environment composition in
> `packages/kernel/src/file-kernel.ts`, and the control surface in
> `packages/code/src/views/config/EnvironmentBrowser.tsx`. Exact skill filtering is delegated to
> `packages/skills/src/{types,config,registry}.ts`; persisted run identity crosses
> `packages/loop`, `packages/trace`, `packages/kernel`, and `packages/code`.

## 1. Purpose

An **Environment** selects which already-installed extensions compose the active Clarvis kernel. It
does not install plugins, copy `settings.json`, select a model or agent profile, carry secrets,
change grants/sandbox/memory, pin plugin versions, or inherit from another Environment. A custom
Environment is a complete allow-list of exact plugin installations and standalone skills; plugin
contributions remain atomic. (`EnvironmentDefinition` in
`packages/protocol/src/environments.ts:36`; `resolved` and `skillRoots` in
`packages/kernel/src/environments/environment-manager.ts`.)

The immutable virtual `builtin:default` activates the exact `{ scope, source, name }` references in
`enabledPlugins`; plugin skills follow those active plugins, and standalone skills use all four
standard roots with their ordinary last-root-wins precedence. A same-name install in another scope
or filesystem convention is never substituted. (`defaultStandaloneSelection` and the builtin
branches in `resolved`, `packages/kernel/src/environments/environment-manager.ts`; exact inventory
cases in `packages/kernel/tests/integration/environment-manager.test.ts`.)

The kernel owns discovery, resolution, trust, and snapshot identity. `@clarvis/skills` receives only
resolved roots and exact `include` lists, while the loop sees roots plus opaque host metadata rather
than an Environment domain object. (`skillRoots` in
`packages/kernel/src/environments/environment-manager.ts`; `HostRunDeps.hostMetadata` in
`packages/loop/src/runtime/execute-run.ts:76`.)

## 2. Surface

`@clarvis/protocol` publishes the complete transport-neutral surface in
`packages/protocol/src/environments.ts` (`EnvironmentService` and its DTOs):

| Type or method | Contract |
| --- | --- |
| `EnvironmentRef` | Definition identity: `builtin`, `global`, or `workspace` plus name. |
| `EnvironmentPluginRef` | Exact installed plugin: `global|workspace`, `agents|clarvis`, plus name. |
| `EnvironmentSkillRef` | Exact standalone source: `user|workspace`, `agents|clarvis`, plus name. |
| `EnvironmentDefinition` | Version-one description and complete `plugins` / `skills` allow-lists. |
| `ResolvedEnvironment` | Immutable resolution snapshot, status, fingerprint, resolved contributions, issues, and counts. |
| `EnvironmentInventory` | Every exact installed plugin and discovered standalone skill, projected inactive for composition. |
| `EnvironmentPreview` | Current/target snapshots, exact delta, expiring apply token, and workspace-trust requirement. |
| `EnvironmentCompositionPreview` | Current, authored, and normally effective snapshots plus one definition-and-selection apply token. |
| `EnvironmentService` | `list`, `current`, `get`, `inventory`, `preview`, `previewClear`, `previewComposition`, `select`, preview-bound `clearSelection`, `applyComposition`, `create`, revision-bound `update`/`delete`, and `clone`. |

`KernelClient.environments` exposes that service beside the other kernel services
(`KernelClient.environments`, `packages/protocol/src/client.ts:68`). The in-process kernel accepts an injected service and gives
embedders an immutable builtin-only fallback (`createBuiltinEnvironmentService` in
`packages/kernel/src/kernel.ts:267`); the file kernel supplies the file-backed manager
(`packages/kernel/src/file-kernel.ts:357`, `:857`). The same fourteen operations are generated for local
and remote clients by the shared operation catalog (`ENVIRONMENT_OPERATIONS` entries in
`packages/kernel/src/transport/operations.ts`).

Code exposes the surface under Extensions as **Environment**, never as a generic profile. The
primary route guides scope, definition/clone choice, exact inventory, capability review, and one
composition apply. The focused view lists and diagnoses definitions, routes creation/customization
into that composer, previews direct selection/clear deltas, and reconnects the backend
(`ExtensionsHub` and `EnvironmentBrowser` in `packages/code/src/views/config`). The focused Plugins
browser composes installation and exact membership through the current Environment; its configure
action returns to the guided composer primed with the selected exact ref (`marketplace.open`
registration in `packages/code/src/app/commands.tsx`).

## 3. Data and formats

### 3.1 Definition and selection paths

| Data | Path | Ownership |
| --- | --- | --- |
| Global definition | `<global>/environments/<name>.json` | operator-authored, reusable |
| Workspace definition | `<workspace>/.clarvis/environments/<name>.json` | repository-shareable authored content |
| Global selection | `<global>/state/environment.json` | machine-local operator state |
| Workspace selection | `<global>/state/workspaces/<segment>/local/environment.json` | machine-local per-workspace state |

The path vocabulary is constructed only by `globalPaths`, `workspacePaths`, and
`workspaceStatePaths` (`packages/paths/src/global.ts:41`, `:79`, `:124`, `:136`;
`packages/paths/src/workspace.ts:51`, `:115`; `packages/paths/src/workspace-state.ts:55`, `:195`).
Definitions may therefore be committed, while merely cloning a repository does not select one.
Listing definitions materializes an absent global catalog with `DIR_MODE`, but an absent workspace
catalog contributes no definitions and is not created as a read side effect. Both an initial
`opendir` absence and an `ENOENT` raised later by bounded directory iteration follow that same rule
(`missingDefinitionCatalog`, `definitionNames`, and `list` in
`packages/kernel/src/environments/environment-manager.ts`).

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
`packages/kernel/src/environments/environment-manager.ts`.)

Each scope admits at most 128 definition files and 256 total directory entries. Create operations
hold a scope-wide catalog lease before the per-definition lease, re-read both limits inside that
transaction, and create only when the exact target is observably absent. An unreadable, symlinked,
or non-regular existing entry is never replaced. (`definitionNames`, `underLease`, and
`writeDefinition` in `packages/kernel/src/environments/environment-manager.ts`.)

Selection documents are strict `{ "schema_version": 1, "environment": EnvironmentRef }` JSON
written atomically. A global selection cannot point at a workspace definition
(`selectionSchema`, `selectionFromFile`, and `writeSelection` in
`packages/kernel/src/environments/environment-manager.ts`). Definition writes
are formatted JSON and updates compare the exact-byte SHA-256 revision returned by the prior read.
Deletion accepts only authored global/workspace refs and the exact expected revision. Under both
selection leases it refuses the process-pinned Environment and any definition still selected by
either global or workspace state, then removes only that exact regular file (`EnvironmentService.delete`
and `withDefinitionMutation` in `packages/kernel/src/environments/environment-manager.ts`).
Definition and selection mutations perform that comparison under crash-recoverable local leases, so
cooperating Clarvis processes cannot both win a stale write (`underLease`, `underDefinitionLease`,
`underSelectionLeases`, and `writeDefinition` in
`packages/kernel/src/environments/environment-manager.ts`; `acquireLocalLeaseSync` in
`packages/paths/src/local-lease.ts`).

### 3.3 Persisted execution identity

Every run carries only `{ id, fingerprint }` under opaque `host_metadata.environment`; trace
journals, recovered records, JSON records, protocol run results, session turns, and bounded session
summaries preserve that pair. (`EnvironmentRunRef` in `packages/protocol/src/environments.ts:136`;
`hostMetadata` composition in `packages/kernel/src/file-kernel.ts:813`; record persistence in
`packages/trace/src/{record-builder,journal,json-trace-store}.ts`; result projection in
`storedToDetail` in `packages/kernel/src/runs/map-result.ts:164`; session summary projection in
`packages/kernel/src/sessions/session-service.ts:255`.) Host metadata is sanitized before durable
storage and does not carry the Environment definition or secrets
(`packages/trace/src/json-trace-store.ts:805`).

## 4. Behavior

### 4.1 Selection precedence and resolution

The active reference is selected in this order:

1. process-local `--env` / `CreateFileKernelOptions.environmentSelector`;
2. workspace-local selection;
3. global default selection;
4. `builtin:default`.

`selectedNow` implements the persisted precedence and `selectorRef` implements qualified and bare
CLI selectors in `packages/kernel/src/environments/environment-manager.ts`. A bare name
chooses an existing workspace definition before the global one; if that workspace file exists but
is invalid, it remains the selected invalid definition and does not fall through
(`does not let an invalid workspace definition fall through a bare CLI selector` in
`packages/kernel/tests/integration/environment-manager.test.ts`).

Resolution inventories all four plugin roots — global/workspace crossed with
`.agents/plugins`/`.clarvis/plugins` — and matches every Environment reference exactly
(`pluginInventory` and the `installedByRef` lookup in
`packages/kernel/src/environments/environment-manager.ts`). No scope or source shadows, falls back
to, or substitutes for another. Selecting two distinct installations with the same runtime name is
invalid because their agents and MCP namespaces would collide. Missing or invalid references remain
in the resolved view as inactive issues; no extension outside the allow-list enters a custom
Environment.

Standalone skills are inventoried separately in the four established roots. Builtin and custom
Environments emit only active, atomically captured winners with exact `include` filters; invalid or
inactive skills never re-enter through a broad root. `@clarvis/skills` normalizes that list and
filters after manifest resolution, so precedence and manifest-name validation remain unchanged
(`skillRoots` in `packages/kernel/src/environments/environment-manager.ts`;
`normalizeInclude`, `packages/skills/src/config.ts:129`; `scanRoot`,
`packages/skills/src/registry.ts:349`). Plugin skill roots are admitted only through active plugins,
and a plugin's agents, MCP servers, capability executables, hooks, and skills are one activation
unit (`pluginInventory` in `packages/kernel/src/environments/environment-manager.ts`). Active
plugin MCP servers are attached independently of authored agent tool lists and marked `auto_tools`;
after each server opens, all tools it advertised join every effective per-run agent while the
persisted profile remains unchanged (`createSettingsRunAssembler`, `addAutomaticMcpTools`). Plugin
hooks enter with that same atomic contribution; workspace-authored executable content remains gated
by the workspace fingerprint approval described below.

An exact empty root set is intentional: the loop exposes an empty skills provider without appending
standard roots and without reporting a discovery failure. This keeps a custom Environment with no
standalone or plugin skills truly empty (`emptySkillsProvider` and `dynamicSkills` in
`packages/loop/src/runtime/build-run-deps.ts`; test
`packages/loop/tests/integration/execute-run-entrypoints.test.ts:283`).

### 4.2 Status and snapshot

`ready` means every selected reference resolved and applicable trust is present; missing inventory,
an invalid plugin, or unapproved workspace executables produces `degraded`; an invalid selection or
definition produces `invalid` (`resolved` in
`packages/kernel/src/environments/environment-manager.ts`).
No state silently substitutes `builtin:default`.

`resolveActive` pins one contribution snapshot for the process. Each active plugin digest covers its
resolved manifest (including MCP/hook companion semantics), bounded agent files, the raw bytes of
packaged skill manifests/resources under the skills package's own limits, install record, resolved source revision, and every directly referenced
package-local MCP, hook, or capability process file's content, size, executable mode, and relative
path. If any skill in one plugin cannot be captured, that plugin's whole skill-root surface is
withheld so a constant unavailable sentinel cannot mask sibling drift; independently valid
non-skill contributions remain. The process-file surface is capped at 256 files, 8 MiB per file, and 32 MiB per plugin
(`snapshotPluginExecutables`, `snapshot`, and `pin` in `packages/kernel/src/plugins`; `identity` and
`resolveActive` in `packages/kernel/src/environments/environment-manager.ts`). Ordinary settings,
MCP and agent projections reuse those pinned parsed loadables and perform only an exact selection
check. Skill-root projections repeat exact selected-content validation at the lazy read boundary.
Immediately before each run
lease, `EnvironmentManager.assertRunSnapshot` rehashes all selected plugin and standalone-skill
bytes. Drift rejects that run with `unavailable` until reconnect, before any executable contribution
can enter execution under the old fingerprint. Capability executable location retains its own full
check at the executable boundary. Selected standalone skill digests cover effective catalog
metadata, the manifest, and every bounded resource body; their full drift check occurs both at run
admission and every `skillRoots` projection. The fingerprint
also covers the qualified Environment id, definition revision, status, issues, and applicable trust
state/fingerprint. Hook definitions are part of the plugin manifest digest, but independent
hook-approval state is excluded from Environment identity. Selection mutations return
`reconnect_required`; definition writes leave the current snapshot pinned and require the host to
reconnect when the active definition changed. They never alter an in-flight or later run on the
existing kernel. Code reconnects after selection and after a lifecycle mutation touches a selected
plugin (`EnvironmentBrowser.apply` and `recomposeSelectedPlugin` in `packages/code/src`).

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
(`deltaOf` in `packages/kernel/src/environments/environment-manager.ts`;
`EnvironmentBrowser.apply`, `packages/code/src/views/config/EnvironmentBrowser.tsx:165`). A preview
token is single-use, expires after five minutes, and binds the mutation kind, selected reference,
persisted selection scope, both exact selection-document revisions, and resolved target fingerprint.
Both `preview` and `previewClear` resolve normal precedence without changing state: a global write
already shadowed by a workspace selection previews that unchanged effective Environment. Either
selection document can determine the effective target, so a changed target, selection, or fallback
fails with `conflict` (`selectedAfterWrite`, `preview`,
`previewClear`, `EnvironmentService.select`, and `EnvironmentService.clearSelection` in
`packages/kernel/src/environments/environment-manager.ts`).

The guided composer reads `EnvironmentService.inventory()` once per coalesced refresh and stages a
complete definition in Code memory. `previewComposition` binds that definition's canonical bytes,
its expected prior revision (or exact absence), both selection-document revisions, the authored
snapshot fingerprint, and the normally effective target fingerprint. `applyComposition` consumes
the token once, revalidates those facts under catalog/definition/selection leases, and writes the
definition plus intended selection as one recoverable operation. No conflict writes a substitute
definition or a different selection; trust approval failure restores both prior documents. A
workspace-local selection that already shadows a new global default remains the effective target.
If that unchanged target is untrusted, the global write neither activates it nor grants new trust
(`inventory`, `previewComposition`, `applyComposition`, `restoreDefinition`, and
`restoreSelection` in `packages/kernel/src/environments/environment-manager.ts`; composition cases
in `packages/kernel/tests/integration/environment-manager.test.ts`).

A selected workspace definition containing plugins enters the existing workspace executable
surface with its reference, exact definition revision, and qualified plugin list. Any file change
therefore changes the workspace-trust fingerprint and requires a fresh approval before those plugins
become active. A verdict for the currently selected workspace Environment never authorizes switching
to another executable Environment; the target selection receives its own approval
(`workspaceTrustSurface` and `workspaceTargetNeedsApproval` in
`packages/kernel/src/environments/environment-manager.ts`; `workspaceExecutableSurface` in
`packages/kernel/src/config/workspace-trust.ts`). The selection write and trust approval are one
recoverable operation: an approval failure restores the exact prior selection bytes. Plugin hooks
are part of the selected plugin unit rather than a second approval projection
(`EnvironmentService.select`, `restoreSelection`, and `pluginSettingsContributions`; test
`packages/kernel/tests/integration/environment-manager.test.ts` "restores the prior selection").

Approving or revoking workspace trust recomposes the selected workspace (or `builtin:default`
workspace-derived) plugin set immediately when the kernel is idle. The same transition returns
`conflict` while a run is active, before the trust store is changed, so no in-flight snapshot gains
or retains executable contributions under a different verdict
(`assertWorkspaceTrustTransitionAllowed` and the trust-transition branch of `resolveActive`).
Code then reads `EnvironmentService.current()` and replaces its process snapshot cache before the
trust operation resolves to the caller (`mutateTrust` in
`packages/code/src/adapters/kernel-run-client.ts`).

When a saved session resumes under a different `{ id, fingerprint }`, Code preserves the session,
adds a visible warning, and marks the status instead of pretending continuity under the same
extension snapshot (Environment comparison in `resumeSession`,
`packages/code/src/run-host.ts:1282`). Newly started turns are
stamped with the current process snapshot (`createSession.beginTurn`,
`packages/code/src/adapters/session.ts:122`).

## 5. Invariants

### INV-314 — Install and activation remain separate

An Environment resolver never clones, updates, removes, or otherwise installs a plugin; it selects
only the installed inventory. Plugin lifecycle remains on `PluginService`.

- **Production:** `pluginInventory` in
  `packages/kernel/src/environments/environment-manager.ts`; `EnvironmentService` in
  `packages/protocol/src/environments.ts:178` has no install operation.
- **Test:** `packages/kernel/tests/integration/environment-manager.test.ts` constructs all four
  inventories before exact activation and proves an unrelated install stays inactive.

### INV-315 — Custom definitions are complete allow-lists with exact installation identity

The builtin activation list does not leak into a custom Environment, and no `{ scope, source, name }`
reference silently means another scope or source.

- **Production:** custom branches and exact `installedByRef` lookup in `resolved` in
  `packages/kernel/src/environments/environment-manager.ts`.
- **Test:** `packages/kernel/tests/integration/environment-manager.test.ts` proves exact global
  `.agents`/`.clarvis` selection despite same-named alternatives and proves unselected installs are
  absent.

### INV-316 — Invalid state fails closed

An invalid selection or definition activates neither custom plugins nor standalone skills and never
falls back to builtin.

- **Production:** `validDefinition`, `pluginViews`, and `skillViews` gates in
  `packages/kernel/src/environments/environment-manager.ts`.
- **Test:** `fails closed for an invalid persisted selection` and `does not let an invalid workspace
  definition fall through a bare CLI selector` in
  `packages/kernel/tests/integration/environment-manager.test.ts` pin both invalid cases.

### INV-317 — A kernel uses one immutable resolved snapshot

Definition/selection changes require reconnection; a stale preview cannot authorize different
bytes, contribution drift is rejected at every foreground and memory-indexer run-admission boundary,
and an already running kernel retains its original fingerprint. Exact lazy skill catalog, body, and
resource reads repeat full selected-content validation rather than falling back to a last-good scan;
only atomically captured plugin skill surfaces and exact builtin/custom standalone includes reach
the runtime. Read-only/control-plane projections use the pinned parse and cannot consume drifted bytes. Trust
transitions may recompose only at an idle boundary.

- **Production:** `PluginContributions.pin`, `assertUnchanged`,
  `snapshotPluginExecutables`, `EnvironmentManager.assertRunSnapshot`,
  `assertPinnedStandaloneSkills`, `EnvironmentManager.skillRoots`, `withRunLease`, the memory
  factory's host executor, pinned `resolveActive`, revision CAS,
  and preview fingerprint comparison in `packages/kernel/src`.
- **Test:** the stale-preview, global-precedence, contribution-fingerprint, and trust-transition
  cases in `packages/kernel/tests/integration/environment-manager.test.ts`, including process-file
  fingerprint drift; the MCP/hook/capability process-file drift cases in
  `packages/kernel/tests/integration/plugin-contributions.test.ts`, including invalid-sibling
  withholding; builtin exact-root filtering in `environment-manager.test.ts`; lazy exact-root rejection in
  `packages/loop/tests/integration/execute-run-entrypoints.test.ts`; the run-lease helper and memory
  factory executor tests; and the selected lifecycle case
  in `packages/kernel/tests/integration/run-service.smoke.test.ts`.

### INV-318 — Workspace executable activation participates in workspace trust

A repository-authored Environment with plugins is inactive until its current executable surface is
trusted; selection can approve only the exact previewed fingerprint.

- **Production:** `workspaceTrustSurface`, `preview`, `select`, and
  `assertWorkspaceTrustTransitionAllowed` in
  `packages/kernel/src/environments/environment-manager.ts` and the file config store.
- **Test:** the preview/approval, switching, and idle trust-recomposition cases in
  `packages/kernel/tests/integration/environment-manager.test.ts`; the extension-surface case in
  `packages/kernel/tests/integration/workspace-trust.test.ts` pins file changes to the trust hash and
  proves active-run rejection occurs before the trust store is changed.

### INV-319 — Execution history identifies its extension snapshot without secrets

Runs, persisted traces, session turns, and session summaries retain Environment id plus fingerprint;
durable host metadata is sanitized.

- **Production:** `executeRun` host metadata in `packages/loop/src/runtime/execute-run.ts:300`;
  `buildRecord` in `packages/trace/src/record-builder.ts:38`; `storedToDetail` in
  `packages/kernel/src/runs/map-result.ts:164`; session projection in
  `packages/code/src/adapters/session-store.ts:334`.
- **Test:** `packages/loop/tests/component/execute-run.test.ts:53`,
  `packages/trace/tests/integration/json-trace-store.test.ts:193`,
  `packages/kernel/tests/unit/map-result.test.ts`, and
  `packages/code/tests/component/session-store.test.ts:98` cover the four seams and redaction.

### INV-320 — The loop and skills package do not own Environment policy

The loop accepts opaque host metadata and resolved roots; the skills package only applies exact
root filters. Neither imports the kernel Environment manager or protocol service.

- **Production:** `HostRunDeps.hostMetadata` in `packages/loop/src/runtime/execute-run.ts:76` and
  `SkillRootInput.include` in `packages/skills/src/types.ts:28`.
- **Test:** `packages/loop/tests/component/execute-run.test.ts:53`,
  `packages/skills/tests/integration/discovery.test.ts:86`, and the existing optional-package
  architecture suites under `packages/loop/tests/architecture/`.

### INV-321 — Definition creation is bounded, serialized, and non-overwriting

Two processes cannot both create past a catalog limit, and creation never replaces an entry whose
absence cannot be established safely.

- **Production:** `definitionNames` and `writeDefinition` in
  `packages/kernel/src/environments/environment-manager.ts` enforce catalog and
  per-definition leases, both limits, exact absence, and atomic publication.
- **Test:** `serializes catalog creates and enforces both catalog resource bounds` in
  `packages/kernel/tests/integration/environment-manager.test.ts` holds the catalog lease and
  proves both bounds; `never replaces an existing definition entry it cannot read safely` proves a
  non-regular target survives unchanged.

### INV-322 — Hook definitions are part of the atomic plugin snapshot

The selected plugin manifest, including every hook definition and executable declaration, and every
directly referenced package-local process file are hashed into the Environment identity. No mutable
per-hook approval projection or changed process byte can alter execution eligibility underneath an
unchanged `{ id, fingerprint }`.

- **Production:** `PluginContributions.pin` and `contributionSnapshot` in
  `packages/kernel/src/plugins/plugin-contributions.ts`; `snapshotPluginExecutables` in
  `packages/kernel/src/plugins/plugin-executable-snapshot.ts`.
- **Test:** `packages/kernel/tests/integration/environment-manager.test.ts` (content, skill, and
  process-file fingerprint drift) and
  `packages/kernel/tests/integration/plugin-contributions.test.ts` (selected hooks compose with
  their plugin and all three process projections reject changed bytes).

### INV-323 — Missing catalogs are safe and workspace reads are side-effect-free

The first definition listing creates an absent global catalog with private directory permissions.
An absent workspace catalog is an empty inventory and is never created merely by opening the view;
an absence reported during either directory open or bounded iteration has the same outcome.

- **Production:** `missingDefinitionCatalog`, `definitionNames`, and `list` in
  `packages/kernel/src/environments/environment-manager.ts`.
- **Test:** `packages/kernel/tests/integration/environment-manager.test.ts` ("materializes an empty
  global catalog without writing into the workspace").

### INV-324 — Guided composition is one preview-bound recoverable mutation

A composition apply can write only the definition bytes and normally effective selection reviewed
under its token. Definition, inventory, or selection drift fails before either write; approval
failure restores both prior documents.

- **Production:** `previewComposition`, `applyComposition`, `withDefinitionMutation`,
  `restoreDefinition`, and `restoreSelection` in
  `packages/kernel/src/environments/environment-manager.ts`.
- **Test:** the composition success, stale-definition, inventory-drift, shadowed-precedence,
  unchanged-untrusted-target, trust-rollback, and token-replay cases in
  `packages/kernel/tests/integration/environment-manager.test.ts`.

### INV-325 — Definition deletion is inactive, exact, and revision-bound

Deletion cannot name the builtin, cannot remove a definition selected at either precedence level,
and cannot remove bytes other than the revision the caller inspected.

- **Production:** `EnvironmentService.delete`, `withDefinitionMutation`, and
  `underSelectionLeases` in `packages/kernel/src/environments/environment-manager.ts`.
- **Test:** `packages/kernel/tests/integration/environment-manager.test.ts` (deletion lifecycle and
  stale revision cases) and `packages/code/tests/integration/environment-browser-render.test.tsx`
  (danger-confirmed inactive delete).

## 6. Failure modes and degradation

| Condition | Result |
| --- | --- |
| Missing selected definition | `invalid`, `missing_definition`; nothing custom activates. |
| Invalid JSON/schema/scope | `invalid`, `invalid_selection` or `invalid_definition`; no fallback. |
| Missing plugin or skill | `degraded` with the exact qualified missing reference; healthy selected entries remain active. |
| Invalid plugin manifest | `degraded`; that plugin is present but inactive. |
| Workspace trust absent | `degraded`, `workspace_untrusted`; selected workspace Environment plugins are inactive. |
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
| Selected plugin or standalone-skill content changes after snapshot resolution | control-plane projections remain pinned; the next run is refused at lease admission with `unavailable`, reconnect is required, and no changed contribution executes under the old fingerprint. |
| Workspace trust changes or selected plugin update/uninstall is requested during a run | `conflict`; the trust store and selected checkout remain unchanged. |
| A selected plugin update/uninstall completed but the kernel was not reconnected | new runs return `unavailable`; management remains available for reconnect/diagnosis. |
| Global definition catalog is absent | listing creates it with private directory permissions and continues with `builtin:default`. |
| Workspace definition catalog is absent | listing treats it as empty and does not create repository content. |
| Definition directory or file exceeds a resource bound | list/get reports an invalid entry; it never returns a partial silently usable definition. |

The failures are implemented by `readBounded`, `definitionNames`, `resolved`, `writeDefinition`, and
`EnvironmentService.select` in `packages/kernel/src/environments/environment-manager.ts`. The TUI
renders status, every issue, missing contribution, fingerprint, and source rather than reducing a
degraded Environment to an empty list (`fullDetail` and `normalBody` in
`packages/code/src/views/config/EnvironmentBrowser.tsx`).

## 7. Coupling

- `@clarvis/paths` owns definition and machine-local selection locations.
- `@clarvis/protocol` owns DTOs and the service interface without implementation dependencies.
- `@clarvis/kernel` owns installed inventory, definition parsing, selection, trust, resolution,
  hashing, previews, snapshots, and transport operations.
- `@clarvis/skills` owns generic root discovery and the exact `include` mechanism, not Environment
  selection.
- `@clarvis/loop` carries opaque host metadata into trace persistence and consumes already-resolved
  skill roots.
- `@clarvis/trace` persists sanitized host metadata without interpreting the Environment shape.
- `@clarvis/code` owns CLI selection, Environment UX, backend reconnection, session stamping, and
  resume mismatch warnings.

The package dependency graph is unchanged: the feature uses existing `kernel -> protocol|paths|skills|loop|trace`
and `code -> kernel|protocol|paths` edges. The loop's optional `skills` dependency remains behind its
existing lazy capability boundary; Environment resolution happens in the file-backed host before run
construction (`packages/kernel/src/file-kernel.ts:357-374`, `:590-593`).

## 8. Open questions

There are no unresolved version-one contract questions. Version pinning, Environment inheritance,
partial plugin contribution masks, model/provider selection, agent profiles, grants/sandbox,
memory, secrets, and automatic repository activation are deliberately out of scope. A user who
needs a variation clones an Environment and edits the complete allow-list; any expansion of that
scope requires a new schema version and an explicit product decision.
