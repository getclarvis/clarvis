# Settings service, config stores, the shipped agent fleet and overlays

> Implemented at `packages/kernel/src/config/**`, `packages/kernel/tests/**`,
> `packages/protocol/src/config.ts` and the loop/paths modules they call. Every claim below is
> anchored to a file and line. Open questions are collected in the final section.

## 1. Purpose

`packages/kernel/src/config/` is the kernel's configuration subsystem. It answers three questions for
every host over the kernel: *what does `settings.json` say*, *what agents exist and which one will
actually run*, and *may this workspace's declarations execute at all*.

The subsystem is split in two layers on purpose. A **`ConfigStore`**
(`packages/kernel/src/config/config-store.ts:46`) owns raw persistence and is **synchronous**; a
**`ConfigService`** (`packages/kernel/src/config/config-service.ts:328`) wraps it in the async
protocol surface and owns all validation — settings are parsed against `kernelSettingsSchema`, agent
frontmatter against `agentFrontmatterSchema`, agent names against a path guard. The store
documentation states the division explicitly: "Validation of settings and agent frontmatter is the
service's job, not the store's" (`packages/kernel/src/config/config-store.ts:44`). Two stores exist:
file-backed (`packages/kernel/src/config/file-config-store.ts:354`) and in-memory (`packages/kernel/src/config/memory-config-store.ts:43`).

The agent fleet is shipped **as TypeScript data**, not as files scaffolded into a user's directory:
`BUILTIN_AGENTS` at `packages/kernel/src/config/builtin-agents/index.ts:25` is the five profiles, and
`packages/kernel/tests/integration/builtin-fleet.test.ts:61` asserts that listing the fleet does not
even create the agents directory. A config file of the same name **overlays** a shipped agent field by
field (`packages/kernel/src/config/agent-overlay.ts:76`); an overlay that cannot be validated is refused and the shipped agent
runs unchanged (`packages/kernel/src/config/agent-overlay.ts:142`).

## 2. Surface

### 2.1 Public exports (`packages/kernel/src/config.ts`, the `./config` entrypoint)

| Symbol | Kind | Defined at |
| --- | --- | --- |
| `parseAgentFrontmatter(raw, mode?)` | fn | `packages/kernel/src/config/frontmatter.ts:16` |
| `createConfigService(store, options?)` | fn | `packages/kernel/src/config/config-service.ts:328` |
| `createMemoryConfigStore(seed?)` | fn | `packages/kernel/src/config/memory-config-store.ts:43` |
| `MemoryConfigSeed` | type | `packages/kernel/src/config/memory-config-store.ts:14` |
| `createFileConfigStore(opts)` | fn | `packages/kernel/src/config/file-config-store.ts:354` |
| `FileConfigStoreOptions` | type | `packages/kernel/src/config/file-config-store.ts:57` |
| `kernelSettingsSchema` | value | `packages/kernel/src/config/capability-registry.ts:33` |
| `SettingsFile` (alias of `KernelSettingsFile`) | type | `packages/kernel/src/config/capability-registry.ts:46` |
| `WORKSPACE_RISK_FIELDS`, `stripWorkspaceRiskFields` | value/fn | `packages/kernel/src/config/workspace-trust.ts:38`, `:97` |
| `StrippedWorkspaceSettings`, `WorkspaceRiskField` | types | `packages/kernel/src/config/workspace-trust.ts:55`, `:49` |
| `ConfigStore`, `SettingsSnapshot`, `AgentOverlay`, `AgentRecord`, `AgentInput`, `ContextRecord` | types | `packages/kernel/src/config/config-store.ts:46,169,207,238,274,287` |
| `compareAgentDisplayOrder`, `resolveAgentsByName` | fns | `packages/kernel/src/config/agent-resolution.ts:35`, `:56` |
| `BUILTIN_AGENTS`, `BUILTIN_AGENT_NAMES`, `DEFAULT_ENTRY_AGENT`, `isBuiltinAgent`, `readBuiltinAgent` | values/fns | `packages/kernel/src/config/builtin-agents/index.ts:25,39,42,58,53` |
| `BuiltinAgent` | type | `packages/kernel/src/config/builtin-agents/types.ts:10` |
| `resolveEffectiveAgent`, `builtinAgentRecord`, `AgentOverlayLayers` | fns/type | `packages/kernel/src/config/agent-overlay.ts:122,26,97` |
| `PROVIDER_KINDS`, model-catalog constructors, refresh/projection helpers, and model/catalog types | values/fns/types | `packages/kernel/src/models/model-catalog.ts`; owned by [model-catalog.md](model-catalog.md) |
| `PLANS_DEFAULTS`, `PlansSettingsBlock`, `parseModelRef` | value/types/fn | re-exported from `@clarvis/plan/settings` and `@clarvis/capability` |
| bounded JSON/plugin readers, plugin/MCP/settings schemas and helpers, and their public types | values/fns/types | re-exported from `@clarvis/loop/host`; owned by [plugins.md](plugins.md) and [request-and-settings-schema.md](../engine/request-and-settings-schema.md) |
| `DISCOVERY_SCHEMA`, `FINDINGS_SCHEMA`, `VERDICT_SCHEMA`, `WORKFLOW_RESULT_SCHEMAS`, `WorkflowResultSchema` | values/type | re-exported from `@clarvis/workflows` |

Not exported from `./config` but exported from their module and imported by tests:
`MAX_SETTINGS_DOCUMENT_BYTES`, `MAX_AGENT_DOCUMENT_BYTES`, `MAX_AGENT_DOCUMENTS_PER_SCOPE`,
`MAX_CONTEXT_DOCUMENT_BYTES` (`packages/kernel/src/config/file-config-store.ts:218-223`), `settingsDocumentRevision` and
`SettingsRevisionConflictError` (`packages/kernel/src/config/config-store.ts:20`, `:25`), `kernelCapabilityRegistry`
(`packages/kernel/src/config/capability-registry.ts:21`), and the workspace-trust internals `workspaceTrustFingerprint`,
`workspaceTrustVerdict`, `canonicalWorkspaceKey`, `readWorkspaceTrustFile`, `writeWorkspaceTrust`,
`workspaceTrustSchema` (`packages/kernel/src/config/workspace-trust.ts:295,380,347,363,406,320`).

### 2.2 `ConfigService` methods (protocol contract at `packages/protocol/src/config.ts:363`)

| Method | Implementation | Throws (kernel error code) |
| --- | --- | --- |
| `getSettings()` | `packages/kernel/src/config/config-service.ts:344` | — |
| `previewSettingsRepair(scope)` | `packages/kernel/src/config/config-service.ts:349` | — (returns `null`) |
| `repairSettings(scope, expectedRevision)` | `packages/kernel/src/config/config-service.ts:360` | `conflict` (`:366`, `:377`) |
| `approveWorkspace()` | `packages/kernel/src/config/config-service.ts:394` | — |
| `revokeWorkspace()` | `packages/kernel/src/config/config-service.ts:399` | — |
| `workspaceTrustError()` | `packages/kernel/src/config/config-service.ts:404` | — |
| `updateSettings(scope, patch, expectedRevision)` | `packages/kernel/src/config/config-service.ts:428` | `invalid_request` (`:437`), `conflict` (`:445`) |
| `inspectSandbox(options?)` | `packages/kernel/src/config/config-service.ts:462` | `unavailable` (`:464`) |
| `listAgents()` | `packages/kernel/src/config/config-service.ts:475` | — |
| `getAgent(scope \| "builtin", name)` | `packages/kernel/src/config/config-service.ts:488` | `invalid_request` (`:489`), `not_found` (`:491`) |
| `writeAgent(scope, name, doc)` | `packages/kernel/src/config/config-service.ts:509` | `invalid_request` (`:510`/`:514`), `conflict` (`:109`) |
| `deleteAgent(scope, name)` | `packages/kernel/src/config/config-service.ts:528` | `invalid_request` |
| `renameAgent(scope, oldName, newName)` | `packages/kernel/src/config/config-service.ts:553` | `invalid_request` (`:557`), `not_found` (`:561`), `conflict` (`:563`, `:109`) |
| `getContext(scope)` | `packages/kernel/src/config/config-service.ts:581` | — |
| `subscribe(kinds, listener)` | `packages/kernel/src/config/config-service.ts:594` | — |

`createConfigService` takes two optional host collaborators (`packages/kernel/src/config/config-service.ts:27`):
`inspectSandbox` (absent ⇒ `inspectSandbox()` rejects `unavailable`) and `knownGrants` (absent ⇒
`SettingsView.known_grants` is left **absent rather than empty**, `packages/kernel/src/config/config-service.ts:338`). The kernel
supplies both at `packages/kernel/src/kernel.ts:783`. The positive path — a supplied `inspectSandbox`
resolving through the service — is pinned at
`packages/kernel/tests/contract/config-service.test.ts:67`; the absent-collaborator path is the one
cited above at `:450` in Section 6.

### 2.3 `ConfigStore` port (`packages/kernel/src/config/config-store.ts:46`)

| Member | Signature | Required |
| --- | --- | --- |
| `readSettings()` | `→ SettingsSnapshot` | yes (`:46`) |
| `readSettingsDocument(scope)` | `→ SettingsDocument \| null` | yes (`:48`) |
| `compareAndSwapSettingsDocument(scope, expectedRevision, repair)` | `→ SettingsSnapshot` | yes (`:57`) |
| `writeSettings(scope, data)` | `→ SettingsSnapshot` | yes (`:69`) |
| `mutateSettings(scope, expectedRevision, mutate)` | `→ SettingsSnapshot` | yes (`:89`) |
| `listAgents()` | `→ AgentRecord[]` | yes (`:104`) |
| `readAgent(scope \| "builtin", name)` | `→ AgentRecord \| null` | yes (`:117`) |
| `readEffectiveAgent(name)` | `→ AgentRecord \| null` | yes (`:124`) |
| `writeAgent(scope, name, input)` / `deleteAgent(scope, name)` | | yes (`:130`, `:132`) |
| `readContext(scope)` | `→ ContextRecord \| null` | yes (`:139`) |
| `setWorkspaceTrust?(approve)` | `→ SettingsSnapshot` | **optional** (`:149`) |
| `workspaceTrustError?()` | `→ string \| null` | **optional** (`:152`) |
| `watch?(listener)` | `→ Unsubscribe` | **optional** (`:160`) |

`mutateSettings` is deliberately non-optional: "Keeping this mandatory prevents a new store from
silently weakening the service's concurrency guarantee" (`packages/kernel/src/config/config-store.ts:89`).

### 2.4 `FileConfigStoreOptions` (`packages/kernel/src/config/file-config-store.ts:57`)

| Field | Meaning |
| --- | --- |
| `workspaceRoot?` | its `.clarvis` becomes the workspace config dir, its root the context base (`:309-311`, `:335`) |
| `globalDir?` | defaults to `globalRoot()` (`:308`) |
| `workspaceConfigDir?` | explicit override of the `.clarvis` default (`:310`) |
| `plugins?` | `PluginContributions`; folds plugin settings fragments and `<plugin>:<agent>` files (`:609`, `:876`) |
| `extensionProfile?` | host-owned exact plugin resolver plus workspace Extension Profile trust surface; omitted hosts use the already-exact merged `enabledPlugins` references (`packages/kernel/src/config/file-config-store.ts:72-79`) |
| `logger?` | defaults to `NOOP_LOGGER` (`:306`) |

### 2.5 Settings schema composition

`kernelCapabilityRegistry` is a module-level constant with four registrations, in this order:
`memorySettingsSpec`, `plansSettingsSpec`, `workflowsSettingsSpec`, `tasksSettingsSpec`. There is no
worktree settings block: worktrees are a launch-time Code choice rather than a kernel capability.
`kernelSettingsSchema =
settingsSchemaFor(kernelCapabilityRegistry)` (`:33`), which extends the engine's `settingsSchema` with
one optional key per spec and re-applies `.strict()`
(`packages/loop/src/settings/capability-settings.ts:65-68`). The engine's own blocks are **not** in
this registry — "those are spread statically into `settingsSchema`" (`packages/kernel/src/config/capability-registry.ts:17`).

`KernelSettingsFile` (`packages/kernel/src/config/capability-registry.ts`) is the engine's
`SettingsFile` intersected with the four optional capability blocks. Production:
`packages/kernel/src/config/capability-registry.ts`. Test:
`packages/kernel/tests/integration/file-kernel.test.ts`; the absence of a worktree
lifecycle/settings capability is owned by [worktrees.md](../capabilities/worktrees.md).

## 3. Data and formats

### 3.1 On-disk layout

| Path | Owner | Cap |
| --- | --- | --- |
| `<globalDir>/settings.json` | `globalPaths().settingsFile` (`packages/paths/src/global.ts:119`) | 2 MiB (`packages/kernel/src/config/file-config-store.ts:219`) |
| `<globalDir>/agents/<name>.md` | `globalPaths().agentFile` (`packages/paths/src/global.ts:141`) | 256 KiB each (`:220`) |
| `<globalDir>/workspace-trust.json` | `globalPaths().workspaceTrustFile` (`packages/paths/src/global.ts:126`) | — |
| `<globalDir>/CLARVIS.md` then `AGENTS.md` | `globalPaths().contextCandidates` (`packages/paths/src/global.ts:139`) | 2 MiB (`:224`) |
| `<ws>/.clarvis/settings.json` | `join(workspaceConfigDir, "settings.json")` (`packages/kernel/src/config/file-config-store.ts:362-367`) | 2 MiB |
| `<ws>/.clarvis/agents/<name>.md` | `join(agentsDir, name + ".md")` (`packages/kernel/src/config/file-config-store.ts:374-378`) | 256 KiB each |
| `<ws>/CLARVIS.md` then `AGENTS.md` | `CONTEXT_FILENAMES` (`packages/paths/src/constants.ts:82`) | 2 MiB |
| `<settings.json>.lock` | settings lease, taken once in `rewriteUnderLease` (`packages/kernel/src/config/file-config-store.ts:827`) | — |

Additional bounds: at most 64 agent documents per scope (`MAX_AGENT_DOCUMENTS_PER_SCOPE`, `:171`), at
most 256 directory entries examined (`MAX_AGENT_DIRECTORY_ENTRIES`, `:172`), at most 8 MiB of agent
bytes in aggregate (`MAX_AGENT_DOCUMENTS_TOTAL_BYTES`, `:173`).

Settings are written pretty-printed with a trailing newline: `` `${JSON.stringify(next, null, 2)}\n` ``
(`packages/kernel/src/config/file-config-store.ts:883`, `:836`). Writes go through `writeFileAtomicSync`
(`packages/kernel/src/config/file-config-store.ts:398`), i.e. tmp file + `rename` with `DIR_MODE = 0o700`
(`packages/paths/src/constants.ts:40`) and `FILE_MODE = 0o600`
(`packages/paths/src/constants.ts:52`).

### 3.2 Agent markdown format

`writeAgent` serializes frontmatter with `yaml`'s `stringify`, trims the trailing newline, and wraps:

```
---
<yaml>
---

<body>
```

(`packages/kernel/src/config/file-config-store.ts:985-986`). The written text is immediately re-parsed with `parseAgentFile`
(`:926`) so the returned record is what a later read would produce. Round-trip pinned at
`packages/kernel/tests/integration/file-config-store.test.ts:154`.

### 3.3 Revisions

`settingsDocumentRevision(raw)` is `sha256(...).digest("hex")` over **bytes**
(`packages/kernel/src/config/config-store.ts:20-22`). The file store hashes the exact file bytes read through a descriptor
(`packages/kernel/src/config/file-config-store.ts:406-407`), so a malformed byte sequence is compared as written rather than
after lossy UTF-8 decoding — pinned by
`packages/kernel/tests/integration/file-config-store.test.ts:126` ("compares malformed settings by
original bytes rather than replacement characters", writing `0x80` then `0x81`). The memory store
hashes `JSON.stringify(current)` instead (`packages/kernel/src/config/memory-config-store.ts:68`, `:92`, `:97`, `:113`). Test
asserts the hex shape `/^[a-f0-9]{64}$/` at `packages/kernel/tests/integration/file-config-store.test.ts:90`.

### 3.4 `SettingsRepairPlan` (protocol `packages/protocol/src/config.ts:253`)

Two shapes, both carrying `scope` and `revision`:

```json
{ "scope": "workspace", "revision": "<sha256hex>", "action": "strip", "dropped": ["providers.0"] }
{ "scope": "workspace", "revision": "<sha256hex>", "action": "reset", "reason": "settings JSON must be an object" }
```

Both examples are literal test expectations (`packages/kernel/tests/contract/config-service.test.ts:287`,
`:264`).

### 3.5 `workspace-trust.json`

Schema at `packages/kernel/src/config/workspace-trust.ts:261`: `{ workspaces: Record<string, Array<{ fingerprint, approved_at }>> }`,
`.strict()`, array `.min(1)`, `fingerprint` matching `/^sha256:[0-9a-f]{64}$/` (`:248`), `approved_at`
a non-empty string, written as an ISO timestamp (`:347`). Written atomically with 2-space JSON
(`:363`). The key is the **realpath** of the workspace root (`canonicalWorkspaceKey`, `:284`).

The fingerprint is `sha256:` + hex over `JSON.stringify(canonical(surface))`, where
`canonical` sorts object keys recursively and drops `undefined` (`:154-164`) and the surface is
`{ settings?, agents?, extensions? }` (`WorkspaceExecutableSurface` in
`packages/kernel/src/config/workspace-trust.ts:193-200`), agents sorted by name with per-file
`sha256:` digests. `extensions` is supplied by the Extension Profile manager only when a workspace
contains repository-owned plugins; it includes every installed `scope: "workspace"` plugin's exact
qualified ref and atomic contribution digest, whether selected by an Extension Profile yet or not.
Consequently adding, removing, repairing, or changing any repository plugin invalidates the single
workspace approval even if `settings.json` and agent files are unchanged. Extension Profile switches do
not require another approval while that inventory remains unchanged.

### 3.6 `WORKSPACE_RISK_FIELDS` (`packages/kernel/src/config/workspace-trust.ts:38`)

`["hooks", "mcpServers", "enabledPlugins", "marketplaces", "memory.provider", "plans.provider",
"tasks.provider"]`. The first four are stripped when `declaresSomething` is true — i.e. absent, `[]`
and `{}` do **not** count (`:89-94`). `memory.provider` / `plans.provider` are stripped only when
`provider.kind` is `"executable"` or `"plugin"` (`:100-101`); `tasks.provider` is stripped (and takes
the whole `tasks` block with it, `:120`) whenever `tasks.provider` is an object (`:106-112`). Pinned
by `packages/kernel/tests/integration/workspace-trust.test.ts:54-72` (covers every field) and `:74-80`
(built-in `kind: "wiki"` / `kind: "markdown"` providers survive).

### 3.7 The five shipped agents

| Name | `grants` | `can_spawn` | `default_spawn` | `iteration_limit` | other |
| --- | --- | --- | --- | --- | --- |
| `marshall` | `edit_workspace, read_workspace, ask_user, run_commands, use_skills` (`packages/kernel/src/config/builtin-agents/marshall.ts`) | `coder, explorer, planner` | `coder` | 200 | — |
| `admiral` | `workflow, read_workspace, edit_workspace, run_commands, ask_user, use_skills` (`packages/kernel/src/config/builtin-agents/admiral.ts:16-23`) | `coder, explorer, planner, marshall` (`:24`) | `coder` (`:25`) | 200 (`:26`) | `reasoning_effort: "high"` (`:27`) |
| `coder` | `edit_workspace, run_commands, use_skills` (`packages/kernel/src/config/builtin-agents/coder.ts:16`) | — | — | 30 (`:17`) | — |
| `explorer` | `read_workspace, use_skills` (`packages/kernel/src/config/builtin-agents/explorer.ts:16`) | — | — | 30 (`:17`) | — |
| `planner` | `read_workspace, use_skills` (`packages/kernel/src/config/builtin-agents/planner.ts:16`) | — | — | 30 (`:17`) | — |

None declares `model` — pinned at `packages/kernel/tests/component/builtin-agents.test.ts:73` ("declares
no model, so the fleet inherits the workspace's default"). Every one carries a string `description`
(`:52`) and a non-empty body (`:49`).

The two leaders' explicit 200-iteration values are pinned by
`packages/kernel/tests/component/builtin-agents.test.ts` ("uses the full lead-session soft iteration
allowance"); the three child profiles stay at 30 so increasing a primary lead session does not
silently enlarge every delegated run.

## 4. Behavior

### 4.1 Reading settings — `snapshot()` (`packages/kernel/src/config/file-config-store.ts:679-726`)

1. `readScopeSettings("global")` and `readScopeSettings("workspace")` (`:616-617`, inside `operatorLayers`). Each reads the
   document once through a bounded descriptor (`:403-408`), `JSON.parse`es it (`:445-450`), and validates with
   `kernelSettingsSchema` (`:452-461`). A failure at any of the three stages produces `{ error }` and
   **no** `value`, so the scope contributes nothing to the merge (`:432-461`).
2. If the workspace scope parsed and is **not** trusted, `stripWorkspaceRiskFields` runs and its
   `settings` half replaces the workspace layer (`:623-643`).
3. `enabledRefs` is computed by merging the *operator* scopes only. Every item is already an exact
   `{ scope, source, name }` installation. When the host supplied `extensionProfile`, its
   `resolvePlugins(enabledRefs, trust)` applies the pinned Extension Profile; otherwise the exact list is
   used directly (`:648-651`, `:683-686`).
4. `pluginScopes = opts.plugins.settingsScopes(enabledPlugins)` folds only those exact resolved
   installations. `SettingsSnapshot.active_plugins` reports the same list (`:687-690`, `:723`).
5. The final merge order is `[...pluginScopes, ...operatorScopes]` (`:687-690`), and `mergeSettings` takes
   scopes "in ascending precedence (a later scope outranks an earlier one)"
   (`packages/loop/src/settings/settings-merge.ts:163`). So: **plugin < global < workspace**.
6. `mcpServerOrigins` walks that same ordered scope list and records the last declaration origin for
   each MCP namespace. The run assembler uses this internal provenance to grant `auto_tools` only
   when the winning declaration is still plugin-owned; a same-name operator override remains
   profile-selected (`mcpServerOrigins` in `file-config-store.ts`; `createSettingsRunAssembler` in
   `packages/kernel/src/runs/settings-assembler.ts`).
7. `scopes` reports each scope's **raw** parsed value, unstripped (`:691-694`), so a UI can show what
   was refused. `sources` carries `{scope, path, exists, revision, error?}` per scope (`:695-709`).
8. `withheld_workspace_fields` is set only when something was actually withheld. In addition to
   risky settings keys it reports the pseudo-field `extension_profile` while a plugin-activating workspace
   Extension Profile is unapproved or changed.
   `workspace_trust` and `active_plugins` are always present on the file store
   (`packages/kernel/src/config/file-config-store.ts:710-725`).

`mergeSettings` folds only keys that have a strategy plus the registry's spec keys
(`packages/loop/src/settings/settings-merge.ts:173-180`), so `merged` never carries a key neither the
engine nor a registered capability owns.

### 4.2 Writing settings — `updateSettings`

| Step | Where |
| --- | --- |
| Service builds a `merge` closure: shallow `{...current, ...patch}`, then `kernelSettingsSchema.safeParse` | `packages/kernel/src/config/config-service.ts:433-440` |
| Invalid ⇒ throw `invalid_request` carrying `firstIssue` + all Zod issues; nothing is written | `packages/kernel/src/config/config-service.ts:437` |
| Service calls `store.mutateSettings(scope, expectedRevision, merge)` | `packages/kernel/src/config/config-service.ts:442` |
| File store: `requireScope`, `mkdirSync(dirname, {recursive, mode: 0o700})`, acquire `<path>.lock` | `packages/kernel/src/config/file-config-store.ts:825-827` |
| Inside the lease: re-read the document, compare its revision to `expectedRevision`; mismatch ⇒ `SettingsRevisionConflictError` | `packages/kernel/src/config/file-config-store.ts:829-833` |
| `mutate(settingsFromDocument(document, …))` — the projection reuses the **already-read bytes**, never a second read | `packages/kernel/src/config/file-config-store.ts:897-900`, `:784-800` |
| Write atomically inside `withOperatorWrite` | `packages/kernel/src/config/file-config-store.ts:834-837` |
| `lease.release()` in `finally`, then `snapshot()` **after** the write wrapper returns | `packages/kernel/src/config/file-config-store.ts:838-841` |
| Service catches `SettingsRevisionConflictError` and rethrows `conflict` with `{scope, expectedRevision, actualRevision}` | `packages/kernel/src/config/config-service.ts:444-449` |

The single-read property is pinned by spying on `fs.openSync` and asserting exactly one open of the
settings path (`packages/kernel/tests/integration/file-config-store.test.ts:400-419`, `:421-442`). The
"mutate sees disk, not a cached view" property is pinned at `:478-500`. A throwing `mutate` writes nothing
and leaves no lockfile (`:502-516`).

`settingsFromDocument` deliberately folds an absent / unparsable / schema-invalid document onto `{}`
(`packages/kernel/src/config/file-config-store.ts:789`, `:795`, `:800`) and logs `kernel.config.document_discarded` in the latter
two cases. Tests: `packages/kernel/tests/integration/file-config-store.test.ts:444-454` (absent), `:456-476` (both invalid forms — and the file
is left byte-identical because the test's `mutate` throws), `:680-711` (the two log reasons).

### 4.3 Repair — `previewSettingsRepair` / `repairSettings`

`deriveSettingsRepair(scope, raw, revision)` (`packages/kernel/src/config/config-service.ts:212`) decides:

| Input condition | Plan | Where |
| --- | --- | --- |
| `JSON.parse` throws | `reset`, `reason` = the parse error message | `:206-215` |
| parsed value is not a plain object | `reset`, `reason` = `"settings JSON must be an object"` | `:218-228` |
| `stripInvalidSettings` returned `null` | `reset`, `reason` = first Zod issue or `"settings could not be repaired safely"` | `:231-242` |
| strip produced no drops | `null` — nothing to repair | `:243` |
| otherwise | `strip`, `dropped` = dotted paths | `:245` |

`stripInvalidSettings` (`:168`) loops **at most 64 rounds** (`:171`). Each round re-parses; an
`unrecognized_keys` issue deletes every named key from the parent object (`:176-183`), any other issue
calls `removeLeaf`, which climbs from the issue path toward the root until it finds an array index or
an own object key it can delete (`:149-165`). Exhausting 64 rounds, or failing to remove anything,
returns `null` and downgrades the plan to `reset`.

`repairSettings` re-derives the repair **inside** `compareAndSwapSettingsDocument`, from the bytes the
CAS just validated (`packages/kernel/src/config/config-service.ts:363-373`). If re-derivation yields `null` — the source became
valid — it throws `conflict` from inside the callback, which abandons the write (`:352`).
`SettingsRevisionConflictError` is translated to `conflict` with both revisions (`:363`).

The file store's CAS is the same shape as `mutateSettings`: lock, re-read, compare, `repair(raw)`,
`withOperatorWrite` + atomic write, release — the shared `rewriteUnderLease` skeleton (`packages/kernel/src/config/file-config-store.ts:820-842`), entered at `:851-855`.

### 4.4 Agent name guard

`AGENT_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/` plus a rejection of any `..` substring
(`packages/kernel/src/config/config-service.ts:65`, `:68`, `:79`). The docstring states the two reasons in the code itself: dots
are admitted because "a skill names the agent it runs on with a field whose own pattern allows `.`"
(`:50-53`), and `:` is excluded because a plugin agent is `<plugin>:<agent>` and "admitting `:` here
would let a write claim a plugin-qualified name that no write path can legitimately target"
(`:55-58`). It is also explicitly "the path guard" (`:60`).

Applied on `writeAgent` (`:496`), `getAgent` (`:475`), `deleteAgent` (`:515`), and **both** names of
`renameAgent` (`:540-541`).

### 4.5 Cross-scope uniqueness

`requireNoCrossScopeConflict(store, scope, name)` (`packages/kernel/src/config/config-service.ts:106`) reads the *other* scope
with `store.readAgent` and throws `conflict` with `{name, scope, conflictingScope}` if a record exists
there (`:109-113`). Its own docstring records the limitation: "This check-then-write is not atomic
across processes… Agent writes have no lock/CAS today" (`:97-102`).

Consequences the tests pin (`packages/kernel/tests/contract/config-service.test.ts:385`, run
`describe.each` over **both** stores):

- writing a name held by the other scope ⇒ `conflict`, and the target is still `not_found` (`:388-398`);
- overwriting in the *same* scope is fine (`:400-406`);
- a legacy conflict created by writing directly to the store (bypassing the service) makes **both**
  copies un-writable through the service, while each stays readable with its own content (`:408-422`).

### 4.6 `renameAgent` (`packages/kernel/src/config/config-service.ts:553`)

Order of checks: name guard on both names → `newName !== oldName` (`invalid_request`, `:542`) →
source exists (`not_found`, `:545`) → target free in the same scope (`conflict`, `:549`) → target free
in the other scope (`conflict`, `:552`). Then **write-new, delete-old** (`:553-557`) — not an atomic
filesystem transaction; the docstring names the crash residue as "a same-scope leftover, not a new
cross-scope conflict" (`:533-537`). Tests at `packages/kernel/tests/contract/config-service.test.ts:424-437`, `:439-448`, `:450-459`, `:461-466`,
`:468-474`.

### 4.7 The three agent reads

| Read | Returns | Used by |
| --- | --- | --- |
| `listAgents()` (`packages/kernel/src/config/config-store.ts:106`) | one record per **shipped** name, already resolved through `resolveEffectiveAgent`, plus every non-builtin file record once per scope, plus plugin agents | `ConfigService.listAgents` (`packages/kernel/src/config/config-service.ts:476`), `createAgentWorkflowPolicy` (`packages/kernel/src/application/workflow-policy.ts:45`, `:49`) |
| `readAgent(scope\|"builtin", name)` (`packages/kernel/src/config/config-store.ts:119`) | one **layer** verbatim, unresolved | `ConfigService.getAgent` (`packages/kernel/src/config/config-service.ts:490`), the cross-scope conflict check (`packages/kernel/src/config/config-service.ts:108`) |
| `readEffectiveAgent(name)` (`packages/kernel/src/config/config-store.ts:126`) | what a run enters | `createSettingsRunAssembler` (`packages/kernel/src/runs/settings-assembler.ts:412`, `:424`) |

`readAgent` is "deliberately layer-precise rather than effective: an editor must open the bytes the
user wrote, and the cross-scope conflict check must be able to ask whether a *file* exists"
(`packages/kernel/src/config/config-store.ts:114-117`). Pinned end-to-end at
`packages/kernel/tests/integration/builtin-fleet.test.ts:122` — after an overlay writing only
`iteration_limit: 80`, `getAgent("global","marshall")` returns exactly `{ iteration_limit: 80 }` and an
empty body, while `readEffectiveAgent` returns the merged record (`:111-115`).

File-store specifics: `listAgents` skips the workspace scope entirely when untrusted (`:928-934`); it maps
`BUILTIN_AGENT_NAMES` through `resolveEffectiveAgent` (`:954-959`) and then appends the non-builtin
file records (`:960`) and the plugin agents (`:961`). `readAgent` handles `"builtin"` first (`:968-972`),
then the file, then — only for a name containing `:` — the plugin contribution (`:973-977`).
`readEffectiveAgent` routes a `:`-qualified name straight to plugins (`:990-993`) and otherwise
resolves workspace-over-global, contributing **no** workspace layer when untrusted (`:994-997`).

**The service-side projection.** `listAgents()` (`packages/kernel/src/config/config-service.ts:475-476`) maps every
`store.listAgents()` record through `recordToSummary`, then sorts with
`compareAgentDisplayOrder`; `getAgent` (`:488-492`) maps the one record `store.readAgent` returns
through `recordToDoc`. Both projections lift fields only when present, never as empty defaults:

- `recordToSummary` (`packages/kernel/src/config/config-service.ts:285-301`) spreads `model`, `description`, `plugin`,
  `grants`, `can_spawn`, `budget` and `overlay` onto the `AgentSummary` only when each is defined
  on the record or derivable from its frontmatter — `grants`/`can_spawn` come from `strArray`
  (`:250-253`, `undefined` for anything that is not an array), and `budget` from `budgetFrom`
  (`:261-269`), which keeps only a well-typed `on_exceed` string and/or `total_token_limit` number
  and returns `undefined` when neither is present.
- `recordToDoc` (`packages/kernel/src/config/config-service.ts:304-312`) carries `malformed` through only when the record has
  one (`:296`).

Pinned: `packages/kernel/tests/contract/config-service.test.ts:213-231` ("projects grants/can_spawn/budget from frontmatter onto the
summary") and `:233-242` ("omits grants/can_spawn/budget when the frontmatter declares none").

### 4.8 Overlay resolution — `resolveEffectiveAgent` (`packages/kernel/src/config/agent-overlay.ts:122`)

```
builtin = readBuiltinAgent(name)
file    = layers.workspace ?? layers.global ?? null        // packages/kernel/src/config/agent-overlay.ts:127
```

| builtin | file | Result | Where |
| --- | --- | --- | --- |
| absent | absent | `null` | `:128` |
| absent | present | the file record, **returned by identity**, malformed or not | `:128`; test `packages/kernel/tests/component/agent-overlay.test.ts:25`, `:126` |
| present | absent | `builtinAgentRecord(builtin)`, `scope: "builtin"`, no `overlay` | `:131`; test `packages/kernel/tests/component/agent-overlay.test.ts:13` |
| present | valid | `mergeOverlay(record, file)` + `overlay {scope, status:"applied"}` | `:143`; test `:35` |
| present | invalid | the shipped record unchanged + `overlay {scope, status:"rejected", reason}` | `:144`; test `:97`, `:111` |

`shadowed: ["global"]` is added exactly when both layers are present (`:133-134`; test `:82`).

`overlayRejection` (`:46`) treats two failures alike: a `malformed` record (whose frontmatter is the
lenient `{}`), and frontmatter that fails `agentFrontmatterSchema`. The reason string is
`` `${issue.path.join(".") || "frontmatter"}: ${issue.message}` `` (`:53`).

`mergeOverlay` (`:76`):

- frontmatter is a **shallow, last-wins** spread of builtin then overlay (`:78`), so an empty list is
  a removal (test `packages/kernel/tests/component/agent-overlay.test.ts:68`);
- `base_prompt` is destructured out of the overlay and `delete`d from the merged frontmatter (`:77`,
  `:79`);
- the prompt is the overlay's trimmed body if non-empty, else its trimmed `base_prompt`, else the
  builtin's body (`:80-86`; test `:60`);
- the record's `scope` becomes the **overlay's** scope (`:89`), and `model`/`description` are
  re-lifted from the merged frontmatter (`:92`; test `:75`).

### 4.9 Ordering and precedence

`compareAgentDisplayOrder` (`packages/kernel/src/config/agent-resolution.ts:35`) ranks by **name** against
`BUILTIN_RANK` — the index of the name in `BUILTIN_AGENT_NAMES` (`:19`) — falling back to
`Number.MAX_SAFE_INTEGER` and then `localeCompare`. So `["zulu","planner","alpha","marshall","coder"]`
sorts to `["marshall","coder","planner","alpha","zulu"]`
(`packages/kernel/tests/component/builtin-agents.test.ts:77`). `ConfigService.listAgents` applies it
(`packages/kernel/src/config/config-service.ts:476`).

`resolveAgentsByName` (`packages/kernel/src/config/agent-resolution.ts:56`) collapses duplicates by `scopeRank`: workspace 3 >
global 2 > plugin 1 > builtin 0 (`:16`), `>=` so a later entry of equal rank wins (`:64`), and the
output keeps first-occurrence order (`:61`, `:66`).

### 4.10 Workspace trust state machine

`workspaceTrustVerdict(fingerprint, key, trust)` (`packages/kernel/src/config/workspace-trust.ts:324`):

| State of input | Verdict | Where |
| --- | --- | --- |
| `fingerprint === undefined` (no executable surface) | `{state:"inert"}` | `:322` |
| no entries for `key` | `{state:"unapproved", fingerprint}` | `:325` |
| some entry matches `fingerprint` | `{state:"trusted", fingerprint}` | `:326-328` |
| entries exist, none match | `{state:"changed", fingerprint, approved: latest.fingerprint}` | `:329` |

`workspaceTrusted` treats `inert` and `trusted` as permitting contribution (`packages/kernel/src/config/file-config-store.ts:534`).
`workspaceVerdict` recomputes on **every call** (`:468-474`), and an unreadable trust store yields
`unapproved` because `readWorkspaceTrustFile` returns `{error}` with no `trust`
(`packages/kernel/src/config/workspace-trust.ts:312`) and `workspaceTrustVerdict` sees `undefined`.

`(state, event) → (state, effect)` as the tests exercise it
(`packages/kernel/tests/integration/workspace-trust.test.ts`):

| State | Event | Next | Effect |
| --- | --- | --- | --- |
| any | workspace declares no risky field, agent file, or installed `scope: "workspace"` plugin | `inert` | nothing withheld |
| `unapproved` | `getSettings()` | `unapproved` | risky fields withheld, raw file still on `scopes.workspace` (`:81`, `:92`) |
| `unapproved` | `approveWorkspace()` | `trusted` | fields merge; `withheld_workspace_fields` absent (`:134`) |
| `trusted` | the approved file is edited on disk | `changed` | fields withheld again (`:146`) |
| `trusted`/`unapproved` | `revokeWorkspace()` | `unapproved` | every approval for the key deleted (`:159`; `packages/kernel/src/config/workspace-trust.ts:417-419`) |
| `trusted` | operator write through the service | `trusted` | approval re-recorded over the new surface (`:199`) |
| `unapproved` | operator write through the service | `unapproved` | **no** approval (`:218`) |

`withOperatorWrite` (`packages/kernel/src/config/file-config-store.ts:581`) implements the last two rows: it captures
`workspaceTrusted(...)` **before** the write and only re-approves if that was already true (`:526-528`).
Its failure to record the carried approval is swallowed (`:531-533`) — the docstring's stated reason is
that "the settings or agent file has already been written, so rethrowing… reports a failed save for a
write that in fact landed" (`:515-521`).

`approveCurrentSurface(true)` is a no-op when the surface is inert (`:491`), so approving an inert
workspace writes nothing.

`writeWorkspaceTrust` (`packages/kernel/src/config/workspace-trust.ts:350-371`) also deduplicates on re-approval: when the
fingerprint being approved already appears among the workspace's recorded entries, `workspaces[key]`
is left as the existing array rather than getting a new `{fingerprint, approved_at}` record appended
(`:357-360`, `existing.some(e => e.fingerprint === fingerprint) ? existing : [...existing, ...]`).
**Unpinned** — no test in this document's scope re-approves an already-approved fingerprint and asserts the
stored array is unchanged (see also Section 8 item 6).

### 4.11 In-memory store differences

| Aspect | File store | Memory store |
| --- | --- | --- |
| merge | plugin < global < workspace via `mergeSettings` + registry (`:595`) | plain shallow `{...global, ...workspace}` (`packages/kernel/src/config/memory-config-store.ts:57`) |
| `sources.path` | real path | `` `memory:${scope}` `` (`:60`) |
| trust | `setWorkspaceTrust`/`workspaceTrustError` present (`:753`, `:757`) | **absent** — service falls back to `store.readSettings()` and `null` (`packages/kernel/src/config/config-service.ts:395`, `:405`) |
| `watch` | absent — service returns a no-op unsubscribe (`packages/kernel/src/config/config-service.ts:595`) | present; emits on `writeSettings`, `compareAndSwap…`, `writeAgent`, `deleteAgent` (`:99`, `:104`, `:115`, `:147`, `:152`) |
| builtins | yes (`:843`) | yes (`:123`) — "A test store without them would disagree with every real host about what an empty configuration contains" (`packages/kernel/src/config/memory-config-store.ts:39-40`) |
| validation | none (schema validation is the service's) | none (`packages/kernel/src/config/memory-config-store.ts:35`) |

### 4.12 Reading context — `readContext`/`getContext`

`ConfigStore.readContext(scope)` (`packages/kernel/src/config/config-store.ts:141`) is a full store member with its own
resource bound and a first-match-wins candidate order, same as any other read on this port.

- **Candidates.** For `"global"`, `contextCandidates(scope)` is
  `globalPaths().contextCandidates` (`packages/kernel/src/config/file-config-store.ts:379-381`, sourced from
  `packages/paths/src/global.ts:135`). For `"workspace"` it is `CONTEXT_FILENAMES.map(name =>
  join(opts.workspaceRoot, name))` when a `workspaceRoot` was supplied, else `undefined`
  (`packages/kernel/src/config/file-config-store.ts:382-385`). `CONTEXT_FILENAMES` is `["CLARVIS.md", "AGENTS.md"]`
  (`packages/paths/src/constants.ts:82`) — `CLARVIS.md` is tried first.
- **First-existing-wins.** `readContext` walks the candidates in order and returns the first
  whose path `existsSync`s, reading it through `readBoundedText` bounded by
  `MAX_CONTEXT_DOCUMENT_BYTES` (`packages/kernel/src/config/file-config-store.ts:1003-1012`).
- **`null` results.** The scope returns `null` outright when it has no candidate list at all —
  the workspace scope with no `workspaceRoot` (`:936-937`) — and also when every candidate was
  checked and none exists (`:945-946`).
- **`ContextRecord.path`.** The file store's record always carries the matched candidate's path
  (`:940-944`); the memory store's never does — it looks up `context[scope]` directly and returns
  `{scope, content}` with no `path` (`packages/kernel/src/config/memory-config-store.ts:157-158`), matching the type's own
  documented asymmetry (`packages/kernel/src/config/config-store.ts:284-285`).
- **`ConfigService.getContext`** (`packages/kernel/src/config/config-service.ts:581-583`) is a thin wrapper: `null` passes
  through, otherwise `path` defaults to `""` when the store's record carried none.

The selection is pinned across the config/run boundary by
`packages/kernel/tests/component/settings-assembler.test.ts:87-124`: no file leaves the agent prompt
unchanged, `AGENTS.md` is used as the fallback, and seeding both candidates puts only `CLARVIS.md` in
the assembled entry profile. The lower-level empty-scope and oversized-file cases remain covered by
`packages/kernel/tests/integration/file-config-store.test.ts:79-80`, `:184`, and `:375-383`.

## 5. Invariants

Each entry: **rule** — production anchor — test anchor.

1. **INV-196 — merged settings put the workspace over the global scope, and each scope's own value
   stays separately visible.** `packages/kernel/src/config/file-config-store.ts:687-694` orders `[...pluginScopes, global, workspace]`
   into `mergeSettings`, whose contract is ascending precedence
   (`packages/loop/src/settings/settings-merge.ts:163`); `scopes` reports raw layers
   (`packages/kernel/src/config/file-config-store.ts:691-694`). Pinned: `packages/kernel/tests/contract/config-service.test.ts:20-37`.

2. **INV-197 — `updateSettings` rejects an invalid patch with `invalid_request` and a stale revision
   with `conflict`, and the stale write never overwrites the concurrent writer.**
   `packages/kernel/src/config/config-service.ts:437`, `:442-449`; the store compares before mutating
   (`packages/kernel/src/config/file-config-store.ts:829-833`, `packages/kernel/src/config/memory-config-store.ts:112-116`). Pinned:
   `packages/kernel/tests/contract/config-service.test.ts:32`, `:39` (the last assertion at `:61` reads back the concurrent writer's
   value).

3. **INV-198 — every name-guarded path rejects a name that could escape the agents directory, and a
   dotted name is accepted on all of them.** `packages/kernel/src/config/config-service.ts:79` (`AGENT_NAME_RE` + `..`), applied
   at `:475`, `:496`, `:515`, `:540-541`. Pinned: `packages/kernel/tests/contract/config-service.test.ts:113-126`, `:128-143`, `:145-187` — the
   `:145-187` table covers traversal, both separators, absolute paths, `C:coder`, `plugin:coder`, a space,
   a newline, a NUL, `%2F` and `café`, against all four methods. The basic legal-name round trip these
   guards sit in front of — `writeAgent` → `getAgent` → `listAgents` → `deleteAgent` all succeeding on
   an ordinary name — is pinned separately at `packages/kernel/tests/contract/config-service.test.ts:92-111`.

4. **INV-199 — a rejected traversal name never reaches disk.** The guard runs before any store call
   (`packages/kernel/src/config/config-service.ts:510`). Pinned: `packages/kernel/tests/contract/config-service.test.ts:182` on the **file** store, asserting
   `listAgents()` minus builtins is empty afterward.

5. **INV-200 — unknown agent frontmatter keys survive a write verbatim.** The service validates with
   `agentFrontmatterSchema` but passes `doc.frontmatter` through unchanged
   (`packages/kernel/src/config/config-service.ts:512`, `:516-519`); the schema is `.loose()`
   (`packages/loop/src/settings/agent-frontmatter.ts:128`, documented at `:79`). Pinned:
   `packages/kernel/tests/contract/config-service.test.ts:191` (`x-house-style`, a nested `presentation` object).

6. **INV-201 — an agent name is unique across `global` and `workspace` together, and a pre-existing
   cross-scope duplicate makes both copies un-writable through the service while both stay readable.**
   `packages/kernel/src/config/config-service.ts:106-115`, called at `:511` and `:566`. Pinned:
   `packages/kernel/tests/contract/config-service.test.ts:385` (`describe.each` over memory **and** file stores), `:388-398`, `:408-422`.

7. **INV-202 — `renameAgent` moves within a scope; it rejects same-scope and cross-scope collisions
   (leaving the source intact), 404s a missing source, and rejects a rename to the same name.**
   `packages/kernel/src/config/config-service.ts:556`, `:559`, `:563`, `:566`. Pinned: `packages/kernel/tests/contract/config-service.test.ts:424-437`, `:439-448`,
   `:450-459`, `:461-466`, `:468-474`.

8. **INV-203 — repair is CAS-guarded and field-scoped.** `previewSettingsRepair`/`repairSettings` bind
   to the SHA-256 of exact bytes (`packages/kernel/src/config/config-service.ts:350`, `:363`); a source that became valid, or
   changed, is a `conflict` and mutates nothing (`:352`, `:363`). `stripInvalidSettings` removes only
   the invalid leaf and falls back to `reset` past 64 rounds (`:171`, `:189`). Pinned:
   `packages/kernel/tests/contract/config-service.test.ts:257-269` (absent source), `:271-285` (non-object ⇒ reset), `:287-298` (array member),
   `:300-316` (object field, siblings untouched), `:318-332` (65 invalid members ⇒ reset), `:334-349` (already
   valid ⇒ conflict); and on the file store `packages/kernel/tests/integration/file-config-store.test.ts:83`, `:99`, `:112`, `:126`,
   `:133`.

9. **INV-204 — `writeAgent` validates frontmatter before the store is asked to write anything.**
   `packages/kernel/src/config/config-service.ts:512-515` precedes `:516`. Pinned: `packages/kernel/tests/contract/config-service.test.ts:360-372` — after a
   rejected `model: 123`, `getAgent` reports `not_found`.

10. **A shipped agent appears exactly once in `listAgents`, already resolved.**
    `packages/kernel/src/config/file-config-store.ts:937-944` maps `BUILTIN_AGENT_NAMES` through `resolveEffectiveAgent` and then
    appends only `!isBuiltinAgent` file records. Pinned: `packages/kernel/tests/integration/builtin-fleet.test.ts:119`
    (`listed.filter(a => a.name === "marshall")` has length 1).

11. **Listing the fleet performs no write.** `readBuiltinAgent` is a `Map` lookup
    (`packages/kernel/src/config/builtin-agents/index.ts:53`) and nothing on the read path creates a directory. Pinned:
    `packages/kernel/tests/integration/builtin-fleet.test.ts:61` — `existsSync(globalPaths(globalDir).agentsDir)` is `false` after
    `listAgents()`.

12. **`BUILTIN_AGENT_NAMES` is derived from `BUILTIN_AGENTS`, never restated.**
    `packages/kernel/src/config/builtin-agents/index.ts:39`. Pinned (membership and order):
    `packages/kernel/tests/component/builtin-agents.test.ts:42`, which also pins
    `DEFAULT_ENTRY_AGENT === "marshall"`.

13. **Every `can_spawn` and `default_spawn` inside the fleet names a shipped agent, and
    `default_spawn` is in `can_spawn` and is not the agent itself.** The frontmatter data at
    `packages/kernel/src/config/builtin-agents/marshall.ts:24-25` / `packages/kernel/src/config/builtin-agents/admiral.ts:24-25`. Pinned:
    `packages/kernel/tests/component/builtin-agents.test.ts:61` — its docstring states the failure it prevents: "A `can_spawn` naming
    an agent nothing defines is skipped by the run assembler, silently."

14. **A shipped agent declares no `model`.** `packages/kernel/src/config/builtin-agents/marshall.ts:13-27` and the four siblings carry no
    `model` key. Pinned: `packages/kernel/tests/component/builtin-agents.test.ts:73`.

15. **`admiral` is the only shipped profile carrying the `workflow` grant.** `packages/kernel/src/config/builtin-agents/admiral.ts:17`. Pinned:
    `packages/kernel/tests/component/builtin-agents.test.ts:97`, whose title states the mechanism: "the only thing that routes a run
    as a workflow"; the reader is `packages/kernel/src/application/workflow-policy.ts:65`.

16. **`admiral`'s prompt embeds the product's own workflow result schemas.** `admiral.ts` body JSON
    fences. Pinned: `packages/kernel/tests/component/builtin-agents.test.ts:118`, which parses every ```` ```json ```` block from the
    body, strips `description` fields, and compares against `WORKFLOW_RESULT_SCHEMAS`.

17. **`builtinAgentRecord` hands out a defensive copy of the frontmatter.**
    `packages/kernel/src/config/agent-overlay.ts:27` spreads before returning. Partially pinned: `packages/kernel/tests/component/builtin-agents.test.ts:88`
    asserts `readBuiltinAgent("coder")` returns the *same* object twice (i.e. the source is shared) —
    the copy itself is **unpinned**.

18. **An overlay that does not validate never changes what runs, and says why.**
    `packages/kernel/src/config/agent-overlay.ts:46`, `:142-144`. Pinned: `packages/kernel/tests/component/agent-overlay.test.ts:97`, `:111`, and end-to-end at
    `packages/kernel/tests/integration/builtin-fleet.test.ts:127` (a broken `marshall.md` leaves the run's profile carrying
    its normal grants).

19. **Tolerance exists only where a default exists.** For a name Clarvis does not ship,
    `resolveEffectiveAgent` returns the file record even when `malformed` (`packages/kernel/src/config/agent-overlay.ts:128`).
    Pinned: `packages/kernel/tests/component/agent-overlay.test.ts:126`.

20. **INV-268 — an untrusted workspace contributes neither risky settings nor agent files.**
    Settings: `packages/kernel/src/config/file-config-store.ts:598-644`. Agents: `listAgents` skips the scope
    (`:928-934`), `readEffectiveAgent` passes `null` for the workspace layer (`:990-997`), and both read the
    same verdict through `agentFilesTrusted` (`:760-767`, over `workspaceTrusted` at `:532-536`) —
    deliberately the *same* verdict as the executable settings fields, because "an agent's markdown
    body becomes a system prompt section verbatim" (`:919-926`). Pinned for settings:
    `packages/kernel/tests/integration/workspace-trust.test.ts:45-72`, `:122-163`, `:175-186`.
    **The agent half is pinned too**:
    `packages/kernel/tests/integration/file-kernel.test.ts:105-155` seeds `.clarvis/agents/coder.md` on
    disk and asserts that before `config.approveWorkspace()` the listed `coder` is the **shipped**
    one — `scope: "builtin"`, no `overlay`, not the file's `description` — with
    `settings.workspace_trust.state === "unapproved"` (`:139-143`), and that after approval the same
    name resolves `scope: "workspace"` with `overlay: {scope: "workspace", status: "applied"}` and
    the file's own description and body (`:145-153`). The test states the reason at `:132-138`: a
    file placed on disk "is indistinguishable from arriving with a clone — so it is withheld until
    approved". `coder` being a shipped name is what makes the assertion sharp: the question is never
    whether the agent is listed, only whether the repository's file overlays it.

21. **Approval binds to the surface, not to the path.** The fingerprint covers the risky settings,
    agent file digests, *and* every installed `scope: "workspace"` plugin's qualified ref and atomic
    contribution digest before Extension Profile selection. Global operator-owned plugins do not enter this surface
    (`WorkspaceExecutableSurface` and `workspaceExecutableSurface` in
    `packages/kernel/src/config/workspace-trust.ts`) and the verdict is recomputed per call
    (`packages/kernel/src/config/file-config-store.ts:508`). The withheld projection names that
    extension surface as `extension_profile` until trusted. Pinned by the complete pre-selection inventory
    and content-drift case in `packages/kernel/tests/integration/extension-profile-manager.test.ts`, plus
    the extension-surface hashing case in `workspace-trust.test.ts`.

22. **The trust key is the resolved realpath.** `canonicalWorkspaceKey` (`packages/kernel/src/config/workspace-trust.ts:290`)
    with a `try/catch` falling back to the input. **Unpinned** — no test exercises a symlinked
    workspace root.

23. **An unreadable `workspace-trust.json` is never overwritten and never reads as trusted.**
    `writeWorkspaceTrust` throws rather than clobbering (`packages/kernel/src/config/workspace-trust.ts:357-359`);
    `readWorkspaceTrustFile` returns `{error}` with no `trust` (`:305`) so the verdict falls to
    `unapproved`. **Unpinned.**

24. **An empty risky value is not a declared surface.** `declaresSomething` returns `false` for
    `undefined`, `null`, `[]` and `{}` (`packages/kernel/src/config/workspace-trust.ts:90-95`). Pinned indirectly:
    `packages/kernel/tests/integration/workspace-trust.test.ts:170` asserts a workspace with only `default_model` is `inert`; the empty
    `[]`/`{}` cases themselves are **unpinned**.

25. **`stripWorkspaceRiskFields` never mutates its input and returns the same object when nothing is
    withheld.** `packages/kernel/src/config/workspace-trust.ts:117`, `:118-135`. Pinned: `packages/kernel/tests/integration/workspace-trust.test.ts:36` (identity)
    and `:43` (input `hooks` still present afterward).

26. **The view a write returns reflects the approval that write carried.** `snapshot()` is taken after
    `withOperatorWrite` returns, never inside it (`packages/kernel/src/config/file-config-store.ts:837-858`). Pinned:
    `packages/kernel/tests/integration/workspace-trust.test.ts:355-378`.

27. **Settings mutation is serialized by a local lease and derives its input from the bytes whose
    revision it checked.** `packages/kernel/src/config/file-config-store.ts:842-853`, `:801-817` (`settingsFromDocument` reuses the
    already-read document; its docstring: "a second read would reintroduce a TOCTOU window inside the
    settings lease", `:797-799`). Pinned: `packages/kernel/tests/integration/file-config-store.test.ts:400-419`, `:421-442`, `:478-500`, `:502-516`,
    `:533-562` (stale-but-dead holder reclaimed), `:565-594` (stale-but-live holder not reclaimed, throws
    `/locked by another process/`), `:597-621` (release cannot unlink an ABA successor).

28. **Configuration reads are byte-bounded, and the bound is enforced twice: once before the body is
    read, and once after.** `readBoundedBytes` `fstat`s the descriptor before allocating and throws
    immediately when the reported size already exceeds `maxBytes` (`packages/kernel/src/config/file-config-store.ts:236-237`).
    It then reads at most `maxBytes + 1` bytes and re-checks `total > maxBytes` on what was actually
    read (`:196`) — the function's own doc comment calls this "closing size-race gaps" (`:183`), i.e.
    the second check is what catches a file that grows between the `fstat` and the read, which the
    pre-check alone cannot see. Pinned: `packages/kernel/tests/integration/file-config-store.test.ts:284` asserts `fs.readSync` is never
    called for an oversized sparse settings file (the pre-check); `:283` bounds the agent catalog at
    `MAX_AGENT_DOCUMENTS_PER_SCOPE`; `:296`, `:308`, `:318` cover oversized agent, context and
    agent-write. **No test in this document's scope grows a file between the `fstat` and the read**, so the
    post-read recheck's race-closing half is exercised only by the static size cases above, not by an
    actual race.

29. **A malformed agent file is loaded leniently *and* reported.** `parseAgentFile` parses lenient,
    then re-parses strict purely to fill `malformed` (`packages/kernel/src/config/file-config-store.ts:740-758`). Pinned:
    `packages/kernel/tests/integration/file-config-store.test.ts:303-323` — `broken.malformed` contains `"malformed YAML frontmatter"`, its
    `frontmatter` is `{}`, and a healthy sibling has no `malformed`.

30. **A refused settings document is logged, once per minute per distinct fact, on the `Logger`
    port.** `reportRejected` behind `createRateLimiter()` (`packages/kernel/src/config/file-config-store.ts:111`, `:356`), event
    `kernel.config.rejected` at level `error` with `schema: "kernelSettingsSchema"` (`:103`). Pinned:
    `packages/kernel/tests/integration/file-config-store.test.ts:635-648` (key + file named), `:650-657` (`at: "(json)"`), `:659-669`
    (`at: "(read)"`), `:671-678` (five reads ⇒ one record).

31. **A mutation that discards an unreadable document warns, distinguishing `json` from `schema`.**
    `reportDiscarded` (`packages/kernel/src/config/file-config-store.ts:129-139`, called at `:811`, `:816`). Pinned:
    `packages/kernel/tests/integration/file-config-store.test.ts:680-711`.

32. **An unreadable agents directory is distinguishable from an empty one.**
    `reportAgentsUnreadable` (`packages/kernel/src/config/file-config-store.ts:152-157`, called at `:285-292`). Pinned:
    `packages/kernel/tests/integration/file-config-store.test.ts:713-725` (skips on win32 and as root).

33. **`kernelSettingsSchema` admits the registered capability blocks that the engine's bare schema
    rejects, and is still strict about anything else.** `packages/kernel/src/config/capability-registry.ts:33` over
    `settingsSchemaFor` (`packages/loop/src/settings/capability-settings.ts:65-68`, which
    `.extend(...).strict()`). Pinned:
    `packages/kernel/tests/integration/capability-settings-schema.test.ts:23` (`workflows` accepted,
    defaults applied), `:33` (unrecognized key still rejected), `:39` (a block violating its own
    schema rejected), `:50` (`memory`), `:62` (strict inside `memory`).

34. **A capability settings block round-trips through `updateSettings` to disk and back.**
    `packages/kernel/src/config/config-service.ts:428` → `packages/kernel/src/config/file-config-store.ts:897`. Pinned:
    `packages/kernel/tests/integration/capability-settings-schema.test.ts:70`, and `:90` pins that patching an unrelated key leaves an
    existing `workflows` block valid.

35. **The registry is populated at module load, before any settings file can be read.**
    `packages/kernel/src/config/capability-registry.ts:21-26` are top-level statements in the module `file-config-store.ts`
    imports at its line 1. The stated consequence is in the source: "a block registered after settings
    were parsed is not in the schema, so its key reads as an unrecognized one and the file is
    rejected" (`packages/kernel/src/config/capability-registry.ts:14-17`). **Unpinned** — no test forces a late registration.

36. **The kernel merges its own registry over a host's rather than falling back to it.**
    `packages/kernel/src/kernel.ts:391-406`. Pinned:
    `packages/kernel/tests/integration/kernel-capability-registry.test.ts:73` (empty host registry) and
    `:89` (host spec carried alongside), `:126` (host grant preserved).

37. **`known_grants` is absent, not empty, when the host supplied no vocabulary.**
    `packages/kernel/src/config/config-service.ts:340` returns the view unchanged when `knownGrants` is `undefined`. **Unpinned**
    as a negative; the positive composition is at `packages/kernel/src/kernel.ts:794`.

38. **`subscribe` filters to the requested kinds and a store without `watch` yields a no-op
    unsubscribe.** `packages/kernel/src/config/config-service.ts:595-598`. Pinned: `packages/kernel/tests/contract/config-service.test.ts:237` (an `agents`
    subscriber sees only `"agents"`, and nothing after `off()`); the no-op branch is **unpinned**.

39. **`AgentSummary`/`AgentDoc` projection lifts a field only when it is present, never as an empty
    default.** `recordToSummary` (`packages/kernel/src/config/config-service.ts:286-301`) spreads `model`, `description`,
    `plugin`, `grants`, `can_spawn`, `budget` and `overlay` conditionally; `strArray` (`:251-253`)
    and `budgetFrom` (`:261-269`) each return `undefined` — not `[]` or `{}` — for anything not of
    the expected shape, so an absent or malformed `grants`/`can_spawn`/`budget` is omitted from the
    summary rather than represented empty. `recordToDoc` (`:290-298`) carries `malformed` through
    only when the record has one (`:296`). Pinned: `packages/kernel/tests/contract/config-service.test.ts:213-231` ("projects
    grants/can_spawn/budget from frontmatter onto the summary"), `:233-242` ("omits grants/can_spawn/budget
    when the frontmatter declares none").

40. **The shipped leads distinguish independent spawning from tracked delegation.** Marshall uses
    `spawn_subagent`, which has no `task_id`, for independent work and uses `delegate_task` only with
    an exact existing task id. Admiral may use the same tools for a narrow lookup but is directed to
    prefer workflows and `run_leader` for substantive or reusable fan-out. Production:
    `packages/kernel/src/config/builtin-agents/marshall.ts` and
    `packages/kernel/src/config/builtin-agents/admiral.ts` (`body`). Test:
    `packages/kernel/tests/component/builtin-agents.test.ts` (`uses separate tools` and
    `may spawn a narrow Sub-agent`).

41. **The shipped Admiral owns continuation across workflow round boundaries.** Its prompt requires
    `workflow_status` followed by a revision-matched `workflow_decide` after each authored round,
    treats repeat passes as proposals rather than runtime commands, and directs a generic workflow
    demonstration to the smallest one-round smoke shape instead of inferring `research` or `audit`.
    It also treats `max_total_leaders` as a lifetime guardrail, never a target to refill through a
    different spawn tool. Production: `packages/kernel/src/config/builtin-agents/admiral.ts`
    (`body`). Test: `packages/kernel/tests/component/builtin-agents.test.ts` (`owns every next-round
    decision and keeps generic demonstrations one-round`).

42. **Extension Profile plugin selection is exact and feeds every plugin contribution consumer from one
    resolved list.** `snapshot().active_plugins`, plugin settings fragments, plugin agents, and the
    file kernel's other plugin contribution lookups all use qualified `{ scope, source, name }`
    references. There is no name-only fallback when no Extension Profile collaborator is supplied.
    Production: `packages/kernel/src/config/file-config-store.ts:650-684`,
    `packages/kernel/src/plugins/plugin-contributions.ts` (`settingsScopes`), and
    `packages/kernel/src/file-kernel.ts`. Test:
    `packages/kernel/tests/integration/extension-profile-manager.test.ts` (same-name exact scope/source)
    and `packages/kernel/tests/integration/plugin-contributions.test.ts`.

## 6. Failure modes and degradation

| Condition | Handler | Outcome |
| --- | --- | --- |
| Settings patch fails the schema | `packages/kernel/src/config/config-service.ts:436` | `invalid_request` with `firstIssue(...)` as message and all Zod issues as `details`; nothing written |
| Revision mismatch on write or repair | `packages/kernel/src/config/config-service.ts:444`, `:376` | `conflict`, `details = {scope, expectedRevision, actualRevision}` |
| Repair applied to a source that became valid | `packages/kernel/src/config/config-service.ts:366` | `conflict` thrown from *inside* the CAS callback ⇒ the write is abandoned |
| Ill-formed agent name | `packages/kernel/src/config/config-service.ts:80` | `invalid_request`; store never called |
| Cross-scope name collision | `packages/kernel/src/config/config-service.ts:109` | `conflict` with `{name, scope, conflictingScope}` |
| Missing agent on `getAgent`/`renameAgent` | `packages/kernel/src/config/config-service.ts:491`, `:561` | `not_found` |
| No sandbox probe configured | `packages/kernel/src/config/config-service.ts:464` | rejects `unavailable` |
| Store lacks `setWorkspaceTrust` | `packages/kernel/src/config/config-service.ts:395` | **degrades**: re-reads settings, "the same answer an inert workspace gets" (`:390-392`); pinned on the memory store at `packages/kernel/tests/contract/config-service.test.ts:351-358` |
| Store lacks `watch` | `packages/kernel/src/config/config-service.ts:595` | **degrades** to a no-op unsubscribe |
| Scope not configured on the file store | `packages/kernel/src/config/file-config-store.ts:786-788` | plain `Error: config store has no '<scope>' scope configured`; `rewriteUnderLease` throws it **before** taking the lock (`:842-844`), pinned `packages/kernel/tests/integration/file-config-store.test.ts:518-531` |
| Settings lock held by a live holder past 2 s | `packages/kernel/src/config/file-config-store.ts:331` | plain `Error: settings are locked by another process (<path>)` |
| Settings file > 2 MiB / agent > 256 KiB / context > 2 MiB | `ConfigResourceLimitError` (`packages/kernel/src/config/file-config-store.ts:226-231`) | on a *read of a snapshot* it becomes the scope's `SettingsSource.error` (`:432-441`); on `readAgent`/`readContext`/`writeAgent` it **throws** |
| Agent directory > 256 entries or > 64 `.md` files | `boundedAgentNames` (`:224`, `:229`) | **silently truncated** with `overflow: true`; `listAgents` (`:843-878`) never reads `page.overflow` at all, so it ignores the flag; `workspaceAgentFiles` turns it into a `<resource-limit>` sentinel that changes the trust fingerprint (`:443-444`) |
| One agent file unreadable/oversized during `listAgents` | `packages/kernel/src/config/file-config-store.ts:930-931` (`catch { continue; }`) | **silently skipped**, no log |
| Aggregate agent bytes > 8 MiB during `listAgents` | `:860` | `break` out of the current scope's loop only; other scopes continue |
| Agents directory exists but cannot be enumerated | `:235-242` | returns `{names: [], overflow: false}` **and** logs `kernel.config.agents_unreadable` at `warn` |
| `settings.json` unparsable or schema-invalid | `readScopeSettings` (`:399-400`, `:410-411`) | the scope contributes nothing; the reason rides on `SettingsSource.error`; logged `kernel.config.rejected` at `error` |
| Same on a **mutation** path | `settingsFromDocument` (`:722`-`:733`) | folded onto `{}` — the file's keys do not survive the write — logged `kernel.config.document_discarded` at `warn` |
| Malformed agent YAML | `parseAgentFile` (`:660-664`) | lenient `{}` frontmatter **plus** a `malformed` message; a shipped agent's overlay is refused (`packages/kernel/src/config/agent-overlay.ts:47`) |
| `workspace-trust.json` unreadable | `readWorkspaceTrustFile` (`packages/kernel/src/config/workspace-trust.ts:363-368`) | verdict falls to `unapproved`; `workspaceTrustError()` names it (`packages/kernel/src/config/file-config-store.ts:884`); `writeWorkspaceTrust` refuses to overwrite (`packages/kernel/src/config/workspace-trust.ts:412-415`) |
| Recording the carried approval fails after an operator write | `packages/kernel/src/config/file-config-store.ts:588` | **swallowed** — the write already landed |
| A `SettingsRevisionConflictError` or `ConfigResourceLimitError` escaping uncaught | `toKernelError` (`packages/kernel/src/core/errors.ts:52`) | name containing `Conflict` ⇒ `conflict`; `ConfigResourceLimitError` matches neither branch ⇒ `internal`, and `details` is dropped (`:62-63`) |

There are no retries anywhere in this subsystem except the settings-lock acquisition loop, which
retries every 5 ms up to 2 s (`packages/kernel/src/config/file-config-store.ts:182-193`, `:326-333`) using a blocking
`Atomics.wait` (`:258`) because the `ConfigStore` methods are synchronous.

`acquireSettingsLock`'s own doc comment states the lock's scope: "This is local-filesystem,
same-host coordination. It does not claim distributed locking over NFS or another multi-host shared
filesystem" (`packages/kernel/src/config/file-config-store.ts:322-323`) — a workspace root that is itself a network mount gets
no cross-host mutual exclusion from this lease.

## 7. Coupling

### 7.1 Outbound (what this subsystem imports)

| Target | Kind | Forced by |
| --- | --- | --- |
| `@clarvis/protocol` | type-only | `packages/kernel/src/config/config-service.ts:3-17`, `packages/kernel/src/config/config-store.ts:1-9`, `packages/kernel/src/config/agent-resolution.ts:1`, `packages/kernel/src/config/workspace-trust.ts:6` — all `import type` |
| `@clarvis/loop/host` | **runtime value** | `agentFrontmatterSchema` (`packages/kernel/src/config/config-service.ts:2`, `packages/kernel/src/config/agent-overlay.ts:1`), `settingsSchemaFor` (`packages/kernel/src/config/capability-registry.ts:2`), `splitAgentFrontmatter` + `mergeSettings` (`packages/kernel/src/config/file-config-store.ts:25`, `packages/kernel/src/config/frontmatter.ts:1`), `readJsonFile` (`packages/kernel/src/config/workspace-trust.ts:5`) |
| `@clarvis/capability` | **runtime value** | `createCapabilityRegistry` (`packages/kernel/src/config/capability-registry.ts:1`), `createRateLimiter`/`NOOP_LOGGER` (`packages/kernel/src/config/file-config-store.ts:2`) |
| `@clarvis/memory/settings`, `@clarvis/plan/settings`, `@clarvis/workflows`, `@clarvis/tasks/settings` | **runtime value** | the four `register(...)` calls in `packages/kernel/src/config/capability-registry.ts` |
| `@clarvis/paths` | **runtime value** | `globalPaths`, `workspacePaths`, `ensureWorkspaceDir`, `writeFileAtomicSync`, `acquireLocalLeaseSync`, `CONTEXT_FILENAMES`, `globalRoot` (`packages/kernel/src/config/file-config-store.ts:15-24`, `packages/kernel/src/config/workspace-trust.ts:3`) |
| `yaml` | **runtime value** | `stringifyYaml` in `writeAgent` (`packages/kernel/src/config/file-config-store.ts:14`, `:985`) |
| `zod` | **runtime value** | `workspaceTrustSchema` (`packages/kernel/src/config/workspace-trust.ts:4`, `:248-265`) |
| `node:fs`, `node:path`, `node:crypto` | runtime | `packages/kernel/src/config/file-config-store.ts:3-13`, `packages/kernel/src/config/config-store.ts:10`, `packages/kernel/src/config/workspace-trust.ts:1-2` |
| `../core/errors.ts` | runtime | `kernelError` (`packages/kernel/src/config/config-service.ts:18`) |
| `../plugins/plugin-contributions.ts` | type-only | `packages/kernel/src/config/file-config-store.ts:37` (`import type PluginContributions`) |

The `@clarvis/loop/host` and capability-package edges are **static and eager**: importing
`packages/kernel/src/config.ts` loads the four settings specs and constructs `kernelSettingsSchema` at
module evaluation.

`readJsonFile` itself (`packages/loop/src/json-file.ts:68-103`) is the one bounded,
schema-validating reader every trust and settings sidecar in this document goes through — it is not
specific to `workspace-trust.ts`, which is merely this document's own caller. Given a path and a zod
schema it never throws: it reads the file through a raw `fd` (`openSync`/`readSync`/`closeSync`,
`packages/loop/src/json-file.ts:15-37`) capped at `MAX_JSON_CONTROL_FILE_BYTES` — `2 * 1024 * 1024`
(2 MiB), justified in its own doc comment as "trust/settings sidecars are control documents, never
arbitrary data blobs" (`:12`) — rejecting a file whose reported *or* actually-read size exceeds that
bound before ever handing bytes to `JSON.parse`; parses the result; and validates it against the
caller's schema with `safeParse`. Its `ReadJsonFileResult<T>` (`:48-57`) is a discriminated union: `{
ok: true, value }` on success, or `{ ok: false, kind, detail, error, at?, missing? }` on one of three
failure kinds (`ReadJsonFileFailureKind`, `:10`) — `unreadable` (I/O error, `error-text.js`'s
`errorText` rendering the cause), `parse` (invalid JSON), or `schema` (parsed JSON that fails the
schema, `detail`/`at` naming the first zod issue and its field path). A missing file is folded into
the `unreadable` kind but flagged `missing: true` (from the underlying `ENOENT` code), which is what
lets every caller in this document tell "the file has never been written" apart from "the file is
there and broken": `readWorkspaceTrustFile` in
`packages/kernel/src/config/workspace-trust.ts` folds a missing sidecar to an empty store and only a
genuine read/parse/schema failure to `{ error }`; `@clarvis/code`'s `loadFile`
(`packages/code/src/adapters/code-config.ts:66-71`, outside this document's scope) makes the identical
choice for its own config file. `packages/loop/tests/integration/json-file.test.ts` pins the byte
ceiling, the three failure kinds, and the `missing` flag.

### 7.2 Inbound (what depends on this subsystem)

| Consumer | What it takes | Anchor |
| --- | --- | --- |
| `kernel.ts` | `createConfigService`, `ConfigStore` type, `kernelCapabilityRegistry` | `packages/kernel/src/kernel.ts:51-52`, `:14`, `:394`, `:402`, `:783` |
| `file-kernel.ts` | `createFileConfigStore`, `DEFAULT_ENTRY_AGENT`, `SettingsSnapshot` | `packages/kernel/src/file-kernel.ts:50-52` |
| `runs/settings-assembler.ts` | `AgentRecord`, `ConfigStore`, `readEffectiveAgent` | `packages/kernel/src/runs/settings-assembler.ts:10`, `:364`, `:412,424` |
| `application/workflow-policy.ts` | `resolveAgentsByName`, `ConfigStore` | `packages/kernel/src/application/workflow-policy.ts:3-4`, `:45`, `:49` |
| `mcp/effective-servers.ts`, `sandbox/policy.ts`, `tasks/task-provider-factory.ts` | `ConfigStore`/`SettingsSnapshot` types | `:3`, `:7`, `:14` respectively |
| `plugins/plugin-service.ts` | `parseAgentFrontmatter` | `packages/kernel/src/plugins/plugin-service.ts:27`, `:104` |
| `plugins/plugin-contributions.ts` | `AgentRecord` type | `packages/kernel/src/plugins/plugin-contributions.ts:27`; it also exposes `settingsScopes`/`agents`/`readAgent` (`:94`, `:98`, `:100`), consumed at `packages/kernel/src/config/file-config-store.ts:688`, `:961`, `:976,992` |
| `@clarvis/code` | `resolveAgentsByName`, `AgentSummary.overlay.shadowed` | `packages/code/src/adapters/kernel-run-client.ts:211`, `packages/code/src/adapters/agents-store.ts:40-52` |

The direction is forced structurally: `config/` imports nothing from `runs/`, `plugins/` (values),
`workflows/` or `transport/`, and the plugin edge is inverted through the `PluginContributions`
type-only import plus an injected `opts.plugins` object.

### 7.3 Explicitly delegated to sibling documents

- The engine's bare `settingsSchema`, `SettingsFile`, `mergeSettings` strategies and
  `agentFrontmatterSchema` internals — **loop-request-and-settings-schema**.
- `PluginContributions`, manifest parsing, `<plugin>:<agent>` records and marketplaces —
  **plugins-and-marketplace**.
- What each grant means per profile — **grants-and-tool-exposure**.
- The Agents panel, `findAgentConflicts`, agent editors — **code-domain-hubs**.
- `createSettingsRunAssembler`'s profile-graph expansion — the runs/assembly document.

## 8. Open questions

1. ~~**Two doc comments disagree about merge direction.**~~ **Resolved:** the protocol-side comment
   was the stale one and now reads the same direction as the kernel's
   (`packages/protocol/src/config.ts:204`-`:208`, `packages/kernel/src/config/config-store.ts:170`),
   which is what the implementation does — `mergeSettings([...pluginScopes, ...operatorScopes], …)`
   (`packages/kernel/src/config/file-config-store.ts:669`) over layers in ascending precedence
   (`packages/loop/src/settings/settings-merge.ts:163`). The client author's copy is the one that had
   been wrong, which is the reason it was the one corrected.

2. **`SettingsData.mcp_servers` (snake_case, `packages/protocol/src/config.ts:29`) is not the key anything
   writes.** The engine's schema key is `mcpServers`
   (`packages/loop/src/settings/settings-schema.ts:388-397`) and that is what
   `WORKSPACE_RISK_FIELDS` strips (`packages/kernel/src/config/workspace-trust.ts:40`). The snake_case field compiles only
   because of the interface's index signature (`packages/protocol/src/config.ts:37`). Whether it is dead or a
   planned rename is not stated.

3. **A plugin-shipped agent can never be opened through `ConfigService.getAgent`.** The store supports
   it (`packages/kernel/src/config/file-config-store.ts:965-978`, and `packages/kernel/tests/integration/file-config-store.test.ts:187` pins the store-level
   fallback), but the service's `requireAgentName` rejects any `:` (`packages/kernel/src/config/config-service.ts:79`, and
   `packages/kernel/tests/contract/config-service.test.ts:156` pins `plugin:coder` as rejected). Whether plugin agents are meant to
   be readable through some other route is not visible here.

4. **No test covers an untrusted workspace's `agents/` directory.** The gate exists
   (`packages/kernel/src/config/file-config-store.ts:914`, `:978`) and the docstring at `:966-971` states what it prevents, but
   `workspace-trust.test.ts` exercises only settings fields. Likewise nothing exercises the agent-file
   half of `workspaceTrustFingerprint` (`packages/kernel/src/config/workspace-trust.ts:224`).

5. **`workspace-trust.ts`'s exported helpers have no direct unit tests.**
   `workspaceTrustFingerprint`, `workspaceTrustVerdict`, `canonicalWorkspaceKey`,
   `readWorkspaceTrustFile`, `writeWorkspaceTrust` and `workspaceTrustSchema` are reached only through
   `createFileConfigStore` in `workspace-trust.test.ts`. The `changed` verdict's `approved` field, the
   `now` injection point (`packages/kernel/src/config/workspace-trust.ts:354`), the symlink canonicalization and the
   refuse-to-overwrite branch are all unexercised — and so is `writeWorkspaceTrust`'s re-approval
   dedup: re-approving a fingerprint already present in `workspaces[key]` leaves that array
   unchanged rather than appending a duplicate entry (`:357-360`, see also Section 4.10).

6. **`resolveAgentsByName` and `parseAgentFrontmatter` have no kernel test.**
   `resolveAgentsByName` is tested only transitively via `packages/code/tests/integration/doctor.test.ts`;
   `parseAgentFrontmatter`'s only caller is `packages/kernel/src/plugins/plugin-service.ts:104`. `scopeRank`'s `"builtin"`
   arm is documented as unreachable in practice ("In practice `builtin` never has to lose this
   comparison", `packages/kernel/src/config/agent-resolution.ts:8`) and nothing tests it.

7. **`stripWorkspaceRiskFields`'s `withheld` order.** The filter preserves `WORKSPACE_RISK_FIELDS`
   order (`packages/kernel/src/config/workspace-trust.ts:104`) and the "covers every declared risk field" test compares against
   that same constant (`packages/kernel/tests/integration/workspace-trust.test.ts:68`), so the test cannot detect a reordering of the
   constant itself. Whether the order is a contract for clients is not stated.

8. **`getAgent("builtin", name)` returns `scope: "builtin"` from the *argument*, not the record.**
   `recordToDoc(record, scope)` (`packages/kernel/src/config/config-service.ts:492`, `:304-312`). For `"builtin"` the two always
   coincide today, but the projection would report the requested scope even if a store returned a
   record from a different layer. No test probes that.

9. **`AgentRecord.plugin` is projected onto `AgentSummary` (`packages/kernel/src/config/config-service.ts:295`) but is never set
    by either shipped store** — only by `plugins/plugin-contributions.ts`, which is a sibling document's
    surface. Whether `AgentSummary.plugin` can appear without plugins configured is therefore not
    determinable here.

10. **No rationale is recoverable for the specific numeric bounds** — 2 MiB / 256 KiB / 64 / 256 /
    8 MiB (`packages/kernel/src/config/file-config-store.ts:218-222`), the 64 repair rounds (`packages/kernel/src/config/config-service.ts:171`), or the
    10 s / 2 s / 5 ms lock constants (`:160-166`). The code names what they bound, never why those
    values.

11. **`SETTINGS_LOCK_STALE_MS`'s interaction with `acquireLocalLeaseSync`** is only partly visible:
    the lease's reclaim policy lives in `packages/paths/src/local-lease.ts:1093-1100` and its
    liveness proof is that package's concern. The kernel-side docstring
    (`packages/kernel/src/config/file-config-store.ts:163-168`) asserts "the shared primitive additionally proves that its
    same-host process is dead", which `packages/kernel/tests/integration/file-config-store.test.ts:533-562` / `:565-594` demonstrate but do not
    explain.
