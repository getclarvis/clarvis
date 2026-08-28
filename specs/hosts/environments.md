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
`packages/kernel/src/environments/environment-manager.ts:736`, `:930`.)

The immutable virtual `builtin:default` activates the exact `{ scope, source, name }` references in
`enabledPlugins`; plugin skills follow those active plugins, and standalone skills use all four
standard roots with their ordinary last-root-wins precedence. A same-name install in another scope
or filesystem convention is never substituted. (`defaultStandaloneSelection` and the builtin
branches in `resolved`, `packages/kernel/src/environments/environment-manager.ts`; exact inventory
cases in `packages/kernel/tests/integration/environment-manager.test.ts`.)

The kernel owns discovery, resolution, trust, and snapshot identity. `@clarvis/skills` receives only
resolved roots and exact `include` lists, while the loop sees roots plus opaque host metadata rather
than an Environment domain object. (`skillRoots` in
`packages/kernel/src/environments/environment-manager.ts:930`; `HostRunDeps.hostMetadata` in
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
| `EnvironmentPreview` | Current/target snapshots, exact delta, expiring apply token, and workspace-trust requirement. |
| `EnvironmentService` | `list`, `current`, `get`, `preview`, `previewClear`, `select`, preview-bound `clearSelection`, `create`, revision-bound `update`, and `clone`. |

`KernelClient.environments` exposes that service beside the other kernel services
(`KernelClient.environments`, `packages/protocol/src/client.ts:68`). The in-process kernel accepts an injected service and gives
embedders an immutable builtin-only fallback (`createBuiltinEnvironmentService` in
`packages/kernel/src/kernel.ts:267`); the file kernel supplies the file-backed manager
(`packages/kernel/src/file-kernel.ts:357`, `:857`). The same ten operations are generated for local
and remote clients by the shared operation catalog (`ENVIRONMENT_OPERATIONS` entries in
`packages/kernel/src/transport/operations.ts:355`).

Code exposes the surface under Extensions as **Environment**, never as a generic profile. The view
lists and diagnoses definitions, creates empty definitions, clones a resolved set, previews the
delta, selects a local or global default, and reconnects the backend
(`EnvironmentBrowser` in `packages/code/src/views/config/EnvironmentBrowser.tsx:123`). The plugin
browser edits the active custom definition with revision CAS; under `builtin:default` it preserves
the exact global `enabledPlugins` write (`plugins.open` registration in
`packages/code/src/app/commands.tsx:816`).

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
`packages/kernel/src/environments/environment-manager.ts:68`, `:242`, `:273`.)

Each scope admits at most 128 definition files and 256 total directory entries. Create operations
hold a scope-wide catalog lease before the per-definition lease, re-read both limits inside that
transaction, and create only when the exact target is observably absent. An unreadable, symlinked,
or non-regular existing entry is never replaced. (`definitionNames`, `underLease`, and
`writeDefinition` in `packages/kernel/src/environments/environment-manager.ts`.)

Selection documents are strict `{ "schema_version": 1, "environment": EnvironmentRef }` JSON
written atomically. A global selection cannot point at a workspace definition
(`selectionSchema`, `selectionFromFile`, and `writeSelection` in
`packages/kernel/src/environments/environment-manager.ts:117`, `:523`, `:1069`). Definition writes
are formatted JSON and updates compare the exact-byte SHA-256 revision returned by the prior read.
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
CLI selectors (`packages/kernel/src/environments/environment-manager.ts:548`, `:570`). A bare name
chooses an existing workspace definition before the global one; if that workspace file exists but
is invalid, it remains the selected invalid definition and does not fall through
(`packages/kernel/tests/integration/environment-manager.test.ts:278`).

Resolution inventories all four plugin roots — global/workspace crossed with
`.agents/plugins`/`.clarvis/plugins` — and matches every Environment reference exactly
(`pluginInventory` and the `installedByRef` lookup in
`packages/kernel/src/environments/environment-manager.ts`). No scope or source shadows, falls back
to, or substitutes for another. Selecting two distinct installations with the same runtime name is
invalid because their agents and MCP namespaces would collide. Missing or invalid references remain
in the resolved view as inactive issues; no extension outside the allow-list enters a custom
Environment.

Standalone skills are inventoried separately in the four established roots. Custom Environments
emit only selected roots with exact `include` filters; `@clarvis/skills` normalizes that list and
filters after manifest resolution, so precedence and manifest-name validation remain unchanged
(`skillRoots`, `packages/kernel/src/environments/environment-manager.ts:930`;
`normalizeInclude`, `packages/skills/src/config.ts:129`; `scanRoot`,
`packages/skills/src/registry.ts:349`). Plugin skill roots are admitted only through active plugins,
and a plugin's agents, MCP servers, capability executables, hooks, and skills are one activation
unit (`pluginInventory`, `packages/kernel/src/environments/environment-manager.ts:683`). Active
plugin MCP servers are attached independently of authored agent tool lists and marked `auto_tools`;
after each server opens, all tools it advertised join every effective per-run agent while the
persisted profile remains unchanged (`createSettingsRunAssembler`, `addAutomaticMcpTools`). Hook
execution still depends on its independent exact-definition approval count.

An exact empty root set is intentional: the loop exposes an empty skills provider without appending
standard roots and without reporting a discovery failure. This keeps a custom Environment with no
standalone or plugin skills truly empty (`emptySkillsProvider` and `dynamicSkills` in
`packages/loop/src/runtime/build-run-deps.ts`; test
`packages/loop/tests/integration/execute-run-entrypoints.test.ts:283`).

### 4.2 Status and snapshot

`ready` means every selected reference resolved and applicable trust is present; missing inventory,
an invalid plugin, or unapproved workspace executables produces `degraded`; an invalid selection or
definition produces `invalid` (`resolved`, packages/kernel/src/environments/environment-manager.ts:736`).
No state silently substitutes `builtin:default`.

The first `resolveActive` result is pinned for the manager's lifetime. Its fingerprint covers the
qualified Environment id, definition revision, status, active plugin inventory digests, selected
skill digests, issues, and applicable trust state (`identity` and `resolveActive` in
`packages/kernel/src/environments/environment-manager.ts:848`, `:1347`). Hook definitions are part
of the plugin manifest digest, but independent hook-approval state is excluded from Environment
identity. Selection mutations return `reconnect_required`; definition writes leave the current
snapshot pinned and require the host to reconnect when the active definition changed. They never
alter an in-flight or later run on the existing kernel. Code reconnects after selection and after a
lifecycle mutation touches a selected plugin (`EnvironmentBrowser.apply` and
`recomposeSelectedPlugin` in `packages/code/src`).

Installing a plugin never selects it. Updating or uninstalling a selected plugin is refused while a
run is active; while idle, the lifecycle mutation reconnects the kernel so the next resolved
fingerprint and status match the changed inventory. Installing a previously missing selected ref
also reconnects it (`selectedPluginLifecycleBlock` and `recomposeSelectedPlugin` in
`packages/code/src/app/commands.tsx`).

### 4.3 Preview, trust, and resume

Before an interactive selection or local-selection clear, Code asks the kernel for an exact delta
of plugins, standalone and plugin skills, MCP servers, and hook counts, then requires explicit
confirmation
(`deltaOf`, `packages/kernel/src/environments/environment-manager.ts:348`;
`EnvironmentBrowser.apply`, `packages/code/src/views/config/EnvironmentBrowser.tsx:165`). A preview
token is single-use, expires after five minutes, and binds the mutation kind, selected reference,
persisted selection scope, exact selection-document revision, and resolved target fingerprint.
`previewClear` resolves the exact precedence fallback without changing state and binds both
selection documents because either can determine that fallback; a changed target, selection, or
fallback fails with `conflict` (`preview`,
`previewClear`, `EnvironmentService.select`, and `EnvironmentService.clearSelection` in
`packages/kernel/src/environments/environment-manager.ts`).

A selected workspace definition containing plugins enters the existing workspace executable
surface with its reference, exact definition revision, and qualified plugin list. Any file change
therefore changes the workspace-trust fingerprint and requires a fresh approval before those plugins
become active. A verdict for the currently selected workspace Environment never authorizes switching
to another executable Environment; the target selection receives its own approval
(`workspaceTrustSurface`, `workspaceTargetNeedsApproval`,
`packages/kernel/src/environments/environment-manager.ts:947`; `workspaceExecutableSurface` in
`packages/kernel/src/config/workspace-trust.ts:242`). The selection write and trust approval are one
recoverable operation: an approval failure restores the exact prior selection bytes. Hook approvals
remain separate (`EnvironmentService.select` and `restoreSelection` in
`packages/kernel/src/environments/environment-manager.ts`; test
`packages/kernel/tests/integration/environment-manager.test.ts` "restores the prior selection").

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
  `packages/kernel/src/environments/environment-manager.ts:683`; `EnvironmentService` in
  `packages/protocol/src/environments.ts:178` has no install operation.
- **Test:** `packages/kernel/tests/integration/environment-manager.test.ts` constructs all four
  inventories before exact activation and proves an unrelated install stays inactive.

### INV-315 — Custom definitions are complete allow-lists with exact installation identity

The builtin activation list does not leak into a custom Environment, and no `{ scope, source, name }`
reference silently means another scope or source.

- **Production:** custom branches and exact `installedByRef` lookup in `resolved`,
  `packages/kernel/src/environments/environment-manager.ts:760`, `:786`.
- **Test:** `packages/kernel/tests/integration/environment-manager.test.ts` proves exact global
  `.agents`/`.clarvis` selection despite same-named alternatives and proves unselected installs are
  absent.

### INV-316 — Invalid state fails closed

An invalid selection or definition activates neither custom plugins nor standalone skills and never
falls back to builtin.

- **Production:** `validDefinition`, `pluginViews`, and `skillViews` gates in
  `packages/kernel/src/environments/environment-manager.ts:757`, `:784`, `:825`.
- **Test:** `packages/kernel/tests/integration/environment-manager.test.ts:241` and `:278` pin invalid
  persisted and CLI-selected workspace cases.

### INV-317 — A kernel uses one immutable resolved snapshot

Definition/selection changes require reconnection; a stale preview cannot authorize different
bytes, and an already running kernel retains its original fingerprint.

- **Production:** pinned `resolveActive`, revision CAS, and preview fingerprint comparison in
  `packages/kernel/src/environments/environment-manager.ts:1347`, `:1089`, `:1172`.
- **Test:** `packages/kernel/tests/integration/environment-manager.test.ts:331` changes a definition
  after preview and verifies conflict plus the still-pinned current snapshot.

### INV-318 — Workspace executable activation participates in workspace trust

A repository-authored Environment with plugins is inactive until its current executable surface is
trusted; selection can approve only the exact previewed fingerprint.

- **Production:** `workspaceTrustSurface`, `preview`, and `select` in
  `packages/kernel/src/environments/environment-manager.ts:947`, `:1005`, `:1172`.
- **Test:** `packages/kernel/tests/integration/environment-manager.test.ts:437` proves
  preview/approval and a matching post-reconnect fingerprint; `:482` proves switching executable
  workspace Environments asks again; `packages/kernel/tests/integration/workspace-trust.test.ts:216`
  pins file changes in the extension surface to the trust hash.

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
  `packages/kernel/src/environments/environment-manager.ts:299`, `:1089` enforce catalog and
  per-definition leases, both limits, exact absence, and atomic publication.
- **Test:** `packages/kernel/tests/integration/environment-manager.test.ts:626` holds the catalog
  lease and fills the 128-definition bound; `:656` proves a non-regular target survives unchanged.

### INV-322 — Hook approval is independent from Environment identity

The plugin manifest, including its hook definitions, identifies the extension snapshot. Approving
or revoking one unchanged definition changes its execution eligibility and displayed count without
changing the Environment fingerprint.

- **Production:** `pluginInventory` reports approval in the view at
  `packages/kernel/src/environments/environment-manager.ts:718`, while its identity digest includes
  manifest bytes and install provenance, not the approval projection, at `:724`.
- **Test:** `packages/kernel/tests/integration/environment-manager.test.ts:670` changes hook approval,
  observes the count change, and pins the unchanged fingerprint.

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
| Target, selection bytes/scope, or precedence fallback changed after preview | `select` or `clearSelection` returns `conflict`; no selection is changed. |
| Active CLI override | persisted `select` and `clearSelection` return `conflict`; edit/reconnect may still reload the same CLI-selected definition. |
| Malformed service input from an embedder or transport | `invalid_request`; no path is constructed or file touched. |
| Workspace approval storage fails after a selection write | the exact prior selection is restored and the approval error is returned. |
| Definition directory or file exceeds a resource bound | list/get reports an invalid entry; it never returns a partial silently usable definition. |

The failures are implemented by `readBounded`, `definitionNames`, `resolved`, `writeDefinition`, and
`EnvironmentService.select` in `packages/kernel/src/environments/environment-manager.ts`. The TUI
renders status, every issue, missing contribution, fingerprint, and source rather than reducing a
degraded Environment to an empty list (`rowsFor`,
`packages/code/src/views/config/EnvironmentBrowser.tsx:64`).

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
