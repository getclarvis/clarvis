# Settings navigation, provider/model screens and shared configuration toolkit

> Implemented at `packages/code/src/views/config/**`, `packages/code/src/features/providers/**` and
> `packages/code/src/adapters/{settings,mcp-capabilities, mcp-capabilities-bridge,zod-summary}.ts`.
> Every claim below is anchored to a file and line. Open questions are collected in the final
> section.

## 1. Purpose

This subsystem is the **configuration surface of `@clarvis/code`**: the shared machinery every
configuration screen is built from, plus the screens that edit providers and models. The unified
Extensions catalog and its focused Environment, plugin, marketplace and MCP experiences are owned by
[code-extensions.md](code-extensions.md).

The shared machinery is three things. `createViewHost` builds the `ViewHost` object a screen is handed
— a level (breadcrumb) stack, a global/workspace scope toggle with an unsaved-changes guard, a dirty
latch, save/cancel handler registration, and an armed two-step confirm
(`packages/code/src/views/config/create-view-host.ts:54`). `createFieldEditor` is a single-slot modal
editor covering text, masked secret, number, pick, enum and multiline inputs
(`packages/code/src/views/config/field-editor.tsx:98`). `HubMenu` is the flat Settings menu
(`packages/code/src/views/config/hub-menu.tsx:24`), over the same item list used by the
`/settings <child>` deep-link router and inline subcommand hints
(`packages/code/src/views/config/SettingsHub.tsx`, `SETTINGS_ITEMS`; consumed by
`packages/code/src/app/commands.tsx`, `settings.open`).

The largest screen is Providers. It is a facade (`ProvidersPanel`) that owns lifecycle and shared
state, and three private level modules that own the three drill depths: L0 the provider list, L1 one
provider's credentials/request maps/models, L2 one model's limits, prompt cache and request maps
(`ProvidersPanel` in `packages/code/src/views/config/ProvidersPanel.tsx`). The editing itself is done by a headless
controller in `packages/code/src/features/providers/controller.ts:149`, which stages a draft, tracks
dirtiness against a snapshot of what was loaded, validates through the settings adapter, and writes
settings + secrets + key-source preferences on save. Underneath everything, `createSettingsAdapter`
(`packages/code/src/adapters/settings.ts:247`) is the UI's read/write/validate view over the kernel's
`ConfigService`, and `packages/code/src/adapters/mcp-capabilities.ts` is the pure reconciliation of
declared MCP servers against a live tool/prompt listing that `McpBrowser` renders.

---

## 2. Surface

### 2.1 `views/config/view-host.tsx` — the compatibility barrel

It re-exports the toolkit a config screen imports and adds one component of its own.

| Export | Kind | Source |
|---|---|---|
| `createViewHost`, `ViewHostBundle`, `ViewHostControls` | re-export | `./create-view-host.ts` (`packages/code/src/views/config/view-host.tsx:12`) |
| `createFieldEditor`, `FieldEditState`, `FieldEditor`, `PickItem` | re-export | `./field-editor.tsx` (`packages/code/src/views/config/view-host.tsx:14`) |
| `SourceBadge`, `SelectableRow`, `EmptyHint`, `LoadingHint`, `ErrorBanner`, `FieldRow`, `ToggleRow`, `SectionHeader`, `StatusRow`, `SettingRow`, `DetailLines`, `Dash`, `DetailRow` | re-export | `../../ui/primitives/index.ts` (`packages/code/src/views/config/view-host.tsx:21`) |
| `bindLevelKeys`, `SelectableList`, `ViewFrame` | re-export | `../../ui/patterns/index.ts` (`packages/code/src/views/config/view-host.tsx:37`) |
| `LevelView` | type re-export | `ui/patterns/level-host.tsx` (`packages/code/src/views/config/view-host.tsx:39`) |
| `LevelHost(props)` | component | `packages/code/src/views/config/view-host.tsx` (`LevelHost`) |

`LevelHost` binds the generic `packages/code/src/ui/patterns/level-host.tsx` (`LevelHost`) pattern to
the catalog picker: it passes a `renderPicker` that mounts `CatalogPicker` with the host's keymap,
`active` accessor and optional `firstRunPicker` branding flag
(`packages/code/src/views/config/view-host.tsx`, `LevelHost`).

```ts
function LevelHost(props: {
  host: ViewHost;
  levels: LevelView[];
  editor?: FieldEditor;
  picker?: () => CatalogPickerSpec | null;
  firstRunPicker?: boolean;
}): JSX.Element
```

### 2.2 `create-view-host.ts`

```ts
function createViewHost(opts: {
  interaction: Interaction;
  active?: Accessor<boolean>;
  close: () => void;
  back?: () => void;
  dispatch: (name: string) => void;
  initialScope?: Scope;
}): ViewHostBundle              // packages/code/src/views/config/create-view-host.ts:54
```

`ViewHostBundle` = `{ host: ViewHost; controls: ViewHostControls }` (`packages/code/src/views/config/create-view-host.ts:41`).

| `ViewHostControls` member | Contract | Line |
|---|---|---|
| `runSave(): Promise<void>` | runs the registered save handler; single-flight (a second call while in flight returns the same promise) | `:177` |
| `scopeBound: Accessor<boolean>` | whether the mounted view ever called `host.bindScope` | `:21`, set at `:156` |
| `escape(): void` | dirty-checked close: pop a level, else confirm a discard, else cancel + back/close | `:194` |
| `dispose(): void` | forced teardown: settles a pending confirm as `false`, runs the cancel handler, drops the save handler, **no dirty check** | `:211` |

The `ViewHost` the screen receives is defined at `packages/code/src/keys/commands.ts:31` and carries
`interaction`, `active`, `close`, `dispatch`, `level.{depth,push,pop,retitle}`, `breadcrumb`, `scope`,
`toggleScope`, `bindScope`, `dirty`, `markDirty`, `onSave`, `onCancel`, `confirm`, `pendingConfirm`.

### 2.3 `field-editor.tsx`

`FieldEditState` is a four-arm union — `text`, `secret`, `pick`, `multiline`
(`packages/code/src/views/config/field-editor.tsx:26`). `FieldEditor` (`:51`) exposes:

| Method | Signature | Notes |
|---|---|---|
| `start` | `(label, current, commit, opts?: { alwaysCommit?: boolean })` | commits only on change unless `alwaysCommit` (`:156`) |
| `startSecret` | `(label, commit)` | masked; raw value never rendered (`:200`) |
| `startNumber` | `(label, current, { min?, max?, commit, notify })` | rejects non-finite and out-of-range, floors the value (`:258`) |
| `startPick` | `(label, items, commit, opts?: { onManual?: () => void })` | opens `CatalogPicker` over an arbitrary list (`:348`) |
| `startEnum` | `(label, options: readonly (string \| PickItem)[], current, commit)` | pre-selects `current` (`:357`) |
| `startMultiline` | `(label, current, commit)` | textarea; applied with `ctrl+s` (`:374`) |
| `editing` | `Accessor<FieldEditState \| null>` | render `EditInput` while non-null (`:52`) |
| `EditInput` | `() => JSX.Element` | (`:428`) |

`PickItem` = `{ label: string; value: string; detail?: string }` (`:19`).

### 2.4 `key-entry.ts`

```ts
function promptForApiKey(fe: FieldEditor, envVar: string, deps: KeyEntryDeps): void  // packages/code/src/views/config/key-entry.ts:21
interface KeyEntryDeps { notify(message: string): void; usageNote?: string; commit(value: string): void }  // :5
```

### 2.5 `validation.ts`

A thin re-export of `issueSet`, `mapProviderIssues`, `IssueLevel`, `IssueSet`, `PanelIssue` from
`packages/code/src/features/issues.ts` (`packages/code/src/views/config/validation.ts:8`); the implementations are at
`packages/code/src/features/issues.ts:29` and `:45`.

### 2.6 Settings hub and extension child routes

```ts
interface HubMenuItem { id: string; label: string; desc: string; cmd: string }   // packages/code/src/views/config/hub-menu.tsx:10
function HubMenu(host, deps: { title; items; openChild(cmd: string): void })      // packages/code/src/views/config/hub-menu.tsx:24
```

`SettingsHub.ITEMS` (`packages/code/src/views/config/SettingsHub.tsx:7`) — nine entries, in order:

| id | label | cmd |
|---|---|---|
| `providers` | Providers | `providers.open` |
| `capability-providers` | Feature backends | `capability-providers.open` |
| `agents` | Agents | `agents.open` |
| `defaults` | Defaults | `defaults.open` |
| `memory` | Memory | `memory.config` |
| `sandbox` | Sandbox | `sandbox.config` |
| `theme` | Theme | `theme.open` |
| `keyboard` | Keyboard | `keyboard.open` |
| `controls` | Run controls | `controls.open` |

`ExtensionsHub` is a five-step guided setup rather than a `HubMenu`. `/extensions` is its only slash
route; internal Environments, Plugins, and MCP children open from the intro and return through the
view stack. Its scope, Environment, exact catalog, capability review, Apply sequence, and focused
children are specified in [code-extensions.md](code-extensions.md)
(`packages/code/src/views/config/ExtensionsHub.tsx`, `ExtensionsHub`).

### 2.7 Screen dependency interfaces

| Screen | Deps interface | Line |
|---|---|---|
| `ExtensionsHub(host, deps)` | `ExtensionsHubDeps` projections and lifecycle actions | `packages/code/src/views/config/ExtensionsHub.tsx` (`ExtensionsHubDeps`) |
| `ProvidersPanel(host, deps)` | `ProvidersDeps { settings, keys, code, notify, catalog, modelsService?, providerAuth?, copyText?, openUrl?, bootstrap?, onBootstrapComplete? }` | `packages/code/src/views/config/ProvidersPanel.tsx` (`ProvidersDeps`) |
| `DefaultsPanel(host, deps)` | `DefaultsDeps { settings, env, notify }` | `packages/code/src/views/config/DefaultsPanel.tsx:20` |
| `McpBrowser(host, deps)` | `McpBrowserDeps { nodes, refresh, editConfig, notify }` | `packages/code/src/views/config/McpBrowser.tsx:22` |
| `EnvironmentBrowser(host, deps)` | `EnvironmentBrowserDeps { environments, reconnect, runActive, notify, configure }` | `packages/code/src/views/config/EnvironmentBrowser.tsx` (`EnvironmentBrowserDeps`) |
| `MarketplaceBrowser(host, deps)` | `MarketplaceBrowserDeps { listings, sources, plugins, environment, loading, install, installUrl, configure, update, uninstall, refresh, addSource, notify }` | `packages/code/src/views/config/MarketplaceBrowser.tsx` (`MarketplaceBrowserDeps`) |

### 2.8 Providers levels (private modules, no package entrypoint)

| Factory | Returns | Line |
|---|---|---|
| `createProviderListLevel(ctx)` | `{ title, body, spec, openAdd }` | `packages/code/src/views/config/providers/list-level.tsx:15` |
| `createProviderDetailLevel(ctx)` | `{ title, body, spec, modelIds }` | `packages/code/src/views/config/providers/detail-level.tsx:47` |
| `createProviderModelLevel(ctx)` | `{ body, spec }` | `packages/code/src/views/config/providers/model-level.tsx:26` |

Shared state passes through `ProvidersViewContext` (`packages/code/src/views/config/providers/context.ts:15`), which
carries the host, the controller, catalog, notify, editor, map editor, bootstrap flags, the four
cursor signals (`sel`, `detailRow`, `modelRow`, `drill`), the current `modelId`, the ordinary editor
transitions, and the optional subscription projections/transitions (`subscriptionRows`,
`openSubscription`, `subscriptionStatus`, `manageSubscription`).

Two pinned field-order constants, and the map that indexes the first of them:

```ts
PROVIDER_DETAIL_FIELDS = ["name","kind","base_url","env var","API key","source","headers","body"]  // packages/code/src/views/config/providers/detail-level.tsx:17
PROVIDER_ISSUE_DETAIL_FIELD = { name:"name", base_url:"base_url", api_key_env:"env var" }          // packages/code/src/views/config/providers/detail-level.tsx:38
MODEL_FIELDS = ["context_window_tokens","max_output_tokens","prompt_cache","headers","body"]        // packages/code/src/views/config/providers/model-level.tsx:12
```

### 2.9 `features/providers/**`

| Export | Kind | Line |
|---|---|---|
| `ProvidersCommandDeps` | host services passed to the Providers view, including optional subscription auth/catalog and copy/open integrations | `packages/code/src/features/providers/commands.ts:11` |
| `registerProvidersCommands(commands, deps)` | registers internal `providers.open` as the `settings` hub child, with no standalone slash token | `packages/code/src/features/providers/commands.ts:24` |
| `ProvidersEvent` | 7-arm union of controller events | `packages/code/src/features/providers/events.ts:8` |
| `presentProvidersEvent(event): Notice` | event → terminal text + tone | `packages/code/src/features/providers/events.ts:23` |
| `createProvidersController(deps): ProvidersController` | headless provider draft/save controller | `packages/code/src/features/providers/controller.ts:149` |
| `ProvidersControllerDeps` | `createProvidersController`'s dependency-injection shape (`settings`, `keys`, `code`, `catalog`, `scope`, `markDirty`, `emit`, `onReconnect?`, `manageDefaultModel?`) | `packages/code/src/features/providers/controller.ts:24` |
| `ProvidersController` | reactive provider/model/key draft surface, including `addSubscriptionProvider` for an entitled provider | `packages/code/src/features/providers/controller.ts:60` |
| `ProviderKind` (re-export) | re-exported from wherever it is truly declared, for callers that only need the kind literal | `packages/code/src/features/providers/controller.ts:659` |
| `KEY_SOURCES`, `SOURCE_MEANING` | `["auto","env","keyfile"]` and their one-line meanings | `packages/code/src/features/providers/controller.ts:40`, `:42` |
| `ProviderKeyStatus` | `"not-required" \| "staged" \| "environment" \| "keyfile" \| "missing"` | `packages/code/src/features/providers/controller.ts:49` |
| `ModelRemovalBlock` | `{kind:"default-model"} \| {kind:"agent-references"}` | `packages/code/src/features/providers/controller.ts:52` |
| `ProviderMapField` | `"headers" \| "body"` | `packages/code/src/features/providers/controller.ts:57` |
| `headerSuggestions`, `bodySuggestions`, `headerKeyProblem`, `headerValueProblem`, `bodyKeyProblem`, `headersFootnote`, `bodyFootnote` | request-map authoring rules | `packages/code/src/features/providers/request-params.ts:64,145,162,177,194,207,226` |

### 2.10 `adapters/settings.ts`

`SettingsAdapter` (`packages/code/src/adapters/settings.ts:121`) is the boundary every settings screen writes through:

| Member | Purpose | Line |
|---|---|---|
| `version` | signal bumped on every successful write / reload / trust change / repair | `:259` |
| `read(scope)` | that scope's file as loaded | `:283` |
| `corrupt(scope)` | the scope's parse error, or `null` | `:291` |
| `planRepair` / `applyRepair` | destructive repair preview and application | `:428`, `:435` |
| `effective()` | the merged view | `:295` |
| `withheldWorkspaceFields()` | workspace fields the kernel refused to merge | `:299` |
| `workspaceTrust()` / `setWorkspaceTrust(approve)` | `"inert" \| "trusted" \| "unapproved" \| "changed"` | `:303`, `:314` |
| `origin(key)` | which scope supplies `key`; a withheld workspace field does not count | `:324` |
| `effectiveProviders()` | per-provider origin `global` / `workspace` / `shadow` | `:332` |
| `knownGrants()` | kernel-reported grant list or `undefined` | `:342` |
| `sources()` | the on-disk `settings.json` path for each scope, `workspace` optional | `:164`, `:346` |
| `write(scope, patch)` | CAS write, schema-validated before it leaves | `:387` |
| `validateProviders(s, resolveAgainst?)` | provider/model/default_model field validation | `:442` |
| `refs(name)` / `modelRefs(fullId)` | who cites a provider / a model | `:521`, `:537` |
| `envStatus(varName)` | `"set" \| "keyfile" \| "unset"` | `:544` |
| `declaredMcpServers()` | parses `mcpServers` from the merged view | `:550` |
| `reload()` / `inspectSandbox(opts?)` | refresh; sandbox probe passthrough | `:418`, `:575` |

Free functions: `patchPlansSettings` (`:183`), `resolveContextWindow` (`:218`), plus re-exports of
`mergeProviders` / `mergeSettings` / `SettingsFile` from `@clarvis/kernel/config` (`:83`).

### 2.11 `adapters/mcp-capabilities.ts`

| Export | Line |
|---|---|
| `ServerStatus = MCPStatus \| "declared"` | `:9` |
| `LiveTool`, `LivePrompt`, `PromptMessage`, `McpServerDecl` | `:12`, `:24`, `:40`, `:46` |
| `parseMcpServers(record)` | `:64` |
| `classifyCapability(name, kind, profiles?)` → `Classified` | `:96`, type at `:81` |
| `ServerNode` | `:114` |
| `BACKEND_NAME = "kernel"` | `:125` |
| `reconcile(decls, tools, prompts, backend, profiles?)` | `:139` |
| `promptMessagesToContent(messages)` | `:200` |
| `SchemaArgRow`, `schemaArgRows(inputSchema)` | `:223`, `:231` |
| `synthSampleArgs(inputSchema)` | `:254` |
| `mcpServerSettingsSchema` (re-export of `@clarvis/kernel/config`) | `:6` |

### 2.12 `adapters/mcp-capabilities-bridge.ts`

The live half of MCP capability presentation: it owns the `refresh()`/`dispose()` lifecycle over
`adapters/mcp-capabilities.ts`'s pure `reconcile`, and — beyond what `McpBrowser` renders — registers
one host slash command per downstream MCP prompt and per skill, keeping that registration in sync
across refreshes.

| Export | Kind | Line |
|---|---|---|
| `McpClientCaps` | interface: `listTools`, `listPrompts`, `getPrompt(name, args)`, `connectionStatus()` — the subset of an MCP client the bridge needs | `:17` |
| `McpEffects` | interface: `submitPromptTurn`, `submitSkillRun`, `activeProfile`, `openMcpServers`, `collectArgs` — host callbacks a triggered prompt/skill invokes | `:25` |
| `McpCapabilities` | interface: `nodes` (an `Accessor<ServerNode[]>`), `refresh()`, `skillAgent(name)`, `dispose()` | `:38` |
| `McpCapabilitiesDeps` | interface: `client`, `commands` (`Pick<Commands, "promptCommand" \| "skillCommand">`), `effects`, `declared()`, `profiles()`, optional `refreshSlowMs` | `:51` |
| `createMcpCapabilities(deps)` → `McpCapabilities` | function | `:87` |

`reportListFailure<T>(surface, error)` (`:82`) is module-private (not exported): it logs
`mcp.list.failed` with the failing `surface` (`"tools" \| "prompts"`) at `warn` and returns `[]`, so
that half of a refresh reads as "no tools"/"no prompts" rather than throwing — see §6.

`McpClientCaps` is implemented for the shipped kernel connection by
`createKernelCapabilitiesClient` (`packages/code/src/adapters/kernel-capabilities-client.ts:13`),
whose own comment (`:7`–`:11`) states that "downstream MCP tools were never surfaced at catalog time
(the kernel connects to them only during a run) … So `listTools` is empty and the backend is always
\"connected\"" — out of scope here, cited only as the bridge's real caller-supplied client.

---

## 3. Data and formats

### 3.1 What the Providers panel writes

The controller writes a whole `SettingsFile` patch containing `providers` and — only in first-run mode
— `default_model` (`packages/code/src/features/providers/controller.ts:564`):

```ts
const next: SettingsFile = {
  providers: providers(),
  ...(deps.manageDefaultModel ? { default_model: defaultModel() } : {}),
};
```

`manageDefaultModel` is set only when `ProvidersPanel` is opened with `bootstrap: true`
(`ProvidersPanel` in `packages/code/src/views/config/ProvidersPanel.tsx`), so an ordinary provider save never co-writes `default_model`; the test
pinning that is `packages/code/tests/unit/providers-controller.test.ts:326`, which asserts the written
file is exactly `{ providers: [...] }`.

A newly seeded model entry has this shape (`packages/code/src/features/providers/controller.ts:329`):

```ts
{
  context_window_tokens: hit?.context_window_tokens ?? 128000,   // DEFAULT_WINDOW, packages/code/src/features/providers/controller.ts:38
  max_output_tokens?: number,                                    // only when the catalog hit has one
  capabilities?: string[],                                       // only when the hit lists any
  reasoning_efforts?: string[],                                  // provider-published selectable levels
  prompt_cache?: "explicit" | "implicit",                        // derivePromptCacheMode(hit?.cost, kind)
}
```

`derivePromptCacheMode` comes from `@clarvis/kernel/config` (`packages/code/src/features/providers/controller.ts:2`); the derivation itself
belongs to [hosts/model-catalog.md](model-catalog.md). What is in scope here is *where* it is called:
`addModelFromCatalog` (`packages/code/src/features/providers/controller.ts:332`) copies
`reasoning_efforts` with the other catalog facts and derives `prompt_cache` once, at authoring time in this
controller, and writes it into `settings.json` alongside the model. Its TSDoc (`:306`–`:319`) states
this reverses an earlier design where the value was "stamped per run request inside the kernel, which
made the 1.6 MB bundled catalog a hard dependency of every run", and that storing it instead "is read
identically by a memory continuation pass and the run it indexes, which is what keeps their two
prefixes byte-identical."

A blank provider is `{ name: "provider-N", kind: "openai-compatible" }` where `N` starts at
`providers().length + 1` and is incremented until unused (`packages/code/src/features/providers/controller.ts:287`). A blank model is
`{ context_window_tokens: 128000 }` (`packages/code/src/features/providers/controller.ts:352`).

`addSubscriptionProvider(entitled)` persists only an ordinary provider identity — `{ name,
kind: entitled.kind }` — using `chatgpt` or `grok` and a numeric suffix on collision. Entitled models
then enter through `addModelFromCatalog`, so model facts become ordinary durable settings while
subscription credentials and device-attempt state remain behind `ProviderAuthService`, never in the
provider patch. Production: `packages/code/src/features/providers/controller.ts`
(`addSubscriptionProvider`, `addModelFromCatalog`) and `ProvidersPanel.loadEntitled`. Test:
`packages/code/tests/integration/providers-key-render.test.tsx` (first-run ChatGPT and coexistence
with Grok persisted shapes).

`prompt_cache` cycles through `[undefined, "explicit", "implicit", "off"]`
(`packages/code/src/views/config/providers/model-level.tsx:23`); `undefined` **deletes** the key, which is how "(auto)" is expressed
(`packages/code/src/features/providers/controller.ts:496`).

`headers` / `body` are staged whole. An empty or `undefined` map deletes the key rather than leaving
`{}` (`packages/code/src/features/providers/controller.ts:436`). For `headers` the editor's `unknown` values are cast to
`Record<string, string>` at exactly one line (`packages/code/src/features/providers/controller.ts:440`), safe only because the map is
opened with a `rejectValue` that refuses non-text (`openMap` in
`packages/code/src/views/config/ProvidersPanel.tsx`).

### 3.2 Suggestion tables for request maps

`request-params.ts` carries four literal tables:

| Table | Contents | Line |
|---|---|---|
| `AUTH_HEADER` | `openai-compatible`/`openai` → `Authorization`; `anthropic` → `x-api-key`; `google` → `x-goog-api-key` | `:37` |
| `COMMON_HEADER_SUGGESTIONS` | `HTTP-Referer`, `X-Title`, `OpenAI-Organization`, `OpenAI-Project`, `anthropic-beta` | `:45` |
| `BODY_ROOT_SUGGESTIONS` | 17 keys, `provider` first (staged as `{ order: [], allow_fallbacks: false }`) | `:75` |
| `BODY_PROVIDER_SUGGESTIONS` | `order`, `allow_fallbacks`, `only`, `ignore`, `require_parameters`, `data_collection`, `quantizations`, `sort`, `max_price` | `:100` |
| `BODY_REASONING_SUGGESTIONS` | `effort`, `max_tokens`, `exclude`, `enabled` | `:121` |

`bodySuggestions(path)` (`:145`–`:150`) is path-routed, not one flat table: `path.length === 0`
returns `BODY_ROOT_SUGGESTIONS`, `path === ["provider"]` returns `BODY_PROVIDER_SUGGESTIONS`,
`path === ["reasoning"]` returns `BODY_REASONING_SUGGESTIONS`, and every other path gets `[]`. Its own
TSDoc names this deliberate: the two parameters the routing actually turns on, `order` and
`allow_fallbacks`, "live inside `provider` and would be invisible from the root."

`headerKeyProblem` accepts only `/^[A-Za-z0-9!#$%&'*+.^_\`|~-]+$/` (`:163`). `headerValueProblem`
strips every well-formed `${VAR}` with `envRefPattern()` from `@clarvis/kernel/policy` and rejects a
residual `${` (`:179`). `bodyKeyProblem` guards **only** `path.length === 0` against
`FORBIDDEN_PROVIDER_BODY_KEYS` (`:194`).

### 3.3 MCP reconciliation output

`reconcile` returns `[backendNode, ...downstream]` (`packages/code/src/adapters/mcp-capabilities.ts:192`):

- `backendNode` is `{ name: "kernel", origin: "control-plane", status: <backend>, tools: [], prompts: <skill prompts> }`
  (`:168`). Its `tools` array is always empty — control-plane tools are classified out (`:101`) and
  never bucketed.
- one `downstream` node per name in the union of live-bucket names and declared names, sorted by name
  (`:178`), with `status: live ? "connected" : "declared"` (`:184`).

Name classification (`classifyCapability`, `:96`): tools split on `.`, prompts on `:`; a bare prompt
that matches a known profile name is `profile-prompt`, otherwise `skill`; a bare tool name is
`downstream` with no server.

`schemaArgRows` flattens `inputSchema.properties` into `{name, type (default `"any"`), required,
description}` (`:231`). `synthSampleArgs` walks `inputSchema.required` — falling back to *all*
properties when the schema declares none required (`:259`) — and emits `0` for number/integer, `false`
for boolean, `[]` for array, `{}` for object, `"<key>"` otherwise (`:262`).

### 3.4 Settings write pipeline shape

`write` is a compare-and-swap through the config service. It captures `sourceRevision(scope)` — the
`revision` field of the matching `view.sources` entry (`packages/code/src/adapters/settings.ts:287`) — inside the queued
operation and passes it to `config.updateSettings(scope, patch, expectedRevision)`
(`:408`). The revision is a 64-hex string in practice
(`packages/code/tests/integration/settings.test.ts:257` asserts `/^[a-f0-9]{64}$/`).

Diagnostic events emitted here (field names are a contract):

| Event | Fields | Line |
|---|---|---|
| `settings.save.rejected` | `scope`, `issue_count`, `fields`, `reason` (`unparsable` \| `invalid`) | `:68` |
| `settings.save.refused` | `scope`, `keys`, `error` | `:377` |
| `settings.resync.failed` | `scope`, `error` | `:383` |
| `settings.save.applied` | `scope`, `keys` | `:413` |
| `settings.model_ref.unparsed` | `site`, `error` (sampled) | `:76` |

`issueFields` joins at most 12 distinct issue paths, `"(root)"` for an empty path
(`:47`). `zodIssueSummary` renders the first two issues and a `(+N more)` suffix
(`packages/code/src/adapters/zod-summary.ts:10`).

### 3.5 `SettingsRepair` — the destructive-repair persisted shape

`SettingsRepair` (`packages/code/src/adapters/settings.ts:113`–`:115`) is a two-variant type over the kernel's
`SettingsRepairPlan`, each variant widened with the scope's own file `path`:

- `{ action: "strip", ... , path }` — the plan drops the offending keys from otherwise-parsable JSON.
- `{ action: "reset", ... , path }` — the plan replaces an unparsable file outright with `{}`.

Both readings come from the type's own TSDoc (`:108`–`:111`).

`planRepair(scope)` (`:428`–`:432`) asks the kernel for a preview via
`config.previewSettingsRepair(scope)` and stamps the scope's on-disk path onto whichever variant
comes back, or returns `null` when the kernel reports nothing to repair. `applyRepair(repair)`
(`:435`–`:440`) is queued through `publishInOrder` like every other publishing operation (§3.4) and
calls `config.repairSettings(repair.scope, repair.revision)`, replacing the cached `view` with
whatever the kernel returns and bumping `version`.

---

## 4. Behavior

### 4.1 Opening a config view (shell side)

`overlay-host.mountView` builds the pair and owns the three view-level commands
(`packages/code/src/views/overlay-host.ts:154`):

| Command id | Binding | Enabled when | Runs |
|---|---|---|---|
| `view.save` | `ctrl+s` | `host.dirty() && !host.pendingConfirm()` (`:184`) | `controls.runSave()`, notifying on rejection (`:187`) |
| `view.scope.toggle` | `ctrl+t` | `controls.scopeBound() && !host.pendingConfirm()` (`:202`) | `host.toggleScope()` |
| `view.escape` | `escape` at `LAYER.OVERLAY` | always | `controls.escape()`; Ctrl+C remains global |

`controls.dispose()` runs only from the frame's own `dispose` (`packages/code/src/views/overlay-host.ts:257`).

### 4.2 `createViewHost` state machine

Scope toggle (`packages/code/src/views/config/create-view-host.ts:134`):

| State | Event | Next | Effect |
|---|---|---|---|
| `scopeMode = "retarget"` (default, `:71`) | `toggleScope` | scope flips | `scopeLoad?.()` |
| `scopeMode = "reload"`, `dirty() === false` | `toggleScope` | scope flips | `scopeLoad?.()` |
| `scopeMode = "reload"`, `dirty() === true` | `toggleScope` | unchanged | arms confirm "Unsaved changes — switching scope discards them. Switch?" (`:141`); on `yes` flips + loads |

Pinned by `packages/code/tests/unit/view-host-scope.test.ts:32` (retarget keeps a dirty draft, no
confirm), `:41` (reload+clean re-reads), `:50` (reload+dirty confirms; `n` keeps, `y` discards and
reloads).

Escape (`packages/code/src/views/config/create-view-host.ts:194`), in order: a pending confirm swallows it → `level.pop()` if depth
> 0 → if dirty, arm "Discard unsaved changes?" and only on yes run cancel + `back ?? close` → else run
cancel + `back ?? close`. `runCancel` nulls the handler before invoking it (`:171`), so escape-then-
dispose cannot double-invoke — pinned at `packages/code/tests/unit/view-host-scope.test.ts:114` and `:125`.

`runSave` is single-flight: a second call while in flight returns the identical promise, and a retry
after settlement runs the handler again (`packages/code/src/views/config/create-view-host.ts:177`; pinned at
`packages/code/tests/unit/view-host-scope.test.ts:90`, which asserts `duplicate === first`).

`confirm` refuses to arm a second prompt over an armed one, resolving `false` immediately
(`packages/code/src/views/config/create-view-host.ts:103`). Disarming without a `yes` settles `false` via a deferred effect on
`armedConfirm.armed` (`:89`).

### 4.3 `createFieldEditor`

One slot: `editing` is a single signal, and every `start*` overwrites it (`packages/code/src/views/config/field-editor.tsx:103`).
Each modal mode registers its own `LAYER.MODAL` layer through `setLayer`, and `clearLayer` releases it
on commit or cancel (`:115`, `:120`). Two guard bindings — `ctrl+s` and `ctrl+t` bound to a no-op —
are spread into the text, secret and number layers (`:141`, applied at `:193`, `:251`, `:321`), so the
shell's save/scope keys cannot fire mid-edit; the multiline layer claims `ctrl+s` for its own apply
command and no-ops `ctrl+t` (`:416`–`:417`).

| Mode | Commit key | Cancel keys | Commit rule |
|---|---|---|---|
| text | `return` → `editor.commit` | `escape` | commits only if `value !== current`, unless `alwaysCommit` (`:156`) |
| secret | `return` → `editor.secret.save` | `escape` | always commits the accumulated plaintext; `left/right/up/down/home/end` bound to no-op (`:245`) |
| number | `return` | `escape` | blank → `commit(undefined)` only if `current !== undefined`; non-finite → notify and stay open; `< min` / `> max` → notify and stay open; else `Math.floor` and commit on change (`:262`–`:284`) |
| multiline | `ctrl+s` → `editor.multiline.apply` | `escape` | commits `multiline.plainText ?? current` (`:378`); textarea layer via `registerManagedTextareaLayer` (`:411`) |
| pick / enum | handled by `CatalogPicker` | its own close | `done(picked)` commits only when `picked !== st.initialValue` (`:550`) |

The secret input never holds the plaintext: `onContentChange` diffs how many leading mask glyphs
survived, splices the new characters onto the retained prefix, and rewrites the visible value as
`mask.repeat(value.length)` under a re-entrancy `guard` (`:481`–`:493`). `onCursorChange` pins the
cursor to the end and clears any selection (`:474`). Behaviour pinned in
`packages/code/tests/integration/secret-input-render.test.tsx:15` (bullets render, Enter commits
plaintext), `:39` (a key containing `*` commits intact in ASCII mode), `:63` (cursor keys pinned), `:90`
(backspace shortens, Esc does not commit).

`promptForApiKey` composes on top: the label is `API key → <envVar>` plus an optional
`(usageNote)` (`packages/code/src/views/config/key-entry.ts:22`), and a blank submission notifies `"empty — key unchanged"` without
calling `commit` (`:29`). Pinned at `packages/code/tests/unit/key-entry.test.ts:21,28,39,52`.

### 4.4 Hub navigation

`HubMenu` registers one level whose `nav.activate` calls `deps.openChild(item.cmd)`
(`packages/code/src/views/config/hub-menu.tsx:38`). The app wires Settings `openChild` to
`openWithReturn(cmd, "settings.open", preferredScope())` (`packages/code/src/app/commands.tsx`,
`settings.open`). `openWithReturn` opens the child with a `parent` route back to the hub
(`packages/code/src/app/commands.tsx`, `openWithReturn`). `hubRoute` turns `/settings <id>` into the same call and returns `false`
for an unknown id so the plain command falls through and opens the hub itself
(`packages/code/src/app/commands.tsx`, `hubRoute`). `hubSubcommands` derives the inline choice hints
from the same array (`packages/code/src/app/commands.tsx`, `hubSubcommands`) — so `SETTINGS_ITEMS` is
the single source for the Settings menu, router and hints. Extensions deliberately has no child
slash-routing array; its intro owns the internal return-stack actions
(`packages/code/src/app/commands.tsx`, `extensions.open`).

`providers.open` is deliberately an internal `settings` child (`slash: false`, `parent: "settings"`),
so its command route is `/settings/providers`; there is no standalone `/providers` command.
Production: `registerProvidersCommands` in `packages/code/src/features/providers/commands.ts` and
`SettingsHub.ITEMS`. Test: `packages/code/tests/integration/app-commands.test.tsx` (hub children have
one hierarchical slash route instead of duplicate aliases).

For a hierarchical parent, Enter on the exact typed token executes the parent view; Tab continues
to insert its child-completion prefix. A fuzzy or incomplete parent hit still completes instead of
executing. Production: `acceptAc` in `packages/code/src/views/InputDock.tsx`. Test:
`packages/code/tests/integration/app-shell-render.test.tsx` (exact hierarchical parent and Tab child
completion cases).

`preferredScope()` is `read("workspace") !== undefined ? "workspace" : "global"`
(`packages/code/src/app/commands.tsx:254`); its TSDoc states the mechanism it replaced ("This used to test whether
`<ws>/.clarvis` **existed**", `:240`).

### 4.5 Providers panel composition

`ProvidersPanel` in `packages/code/src/views/config/ProvidersPanel.tsx`, in order:

1. `bootstrap = deps.bootstrap === true`; a field editor is created bound to the host's keymap and
   `active` (the `bootstrap` and `editor` declarations).
2. The controller is constructed with `manageDefaultModel: bootstrap` and — only when there is
   **no** `onBootstrapComplete` — an `onReconnect` that dispatches `backend.reconnect`; the panel
   always owns it and disposes it in `onCleanup` (the `ctrl` declaration and cleanup callback).
3. Provider/model cursor and picker signals, subscription-status/device-attempt signals, a
   device-action feedback signal, and one-second unref'd device-code countdown timer are created
   beside a `createMapEditor` bound to the same editor and level stack. The shared spinner clock runs
   only while a copy or browser action is pending.
4. `host.bindScope({ mode: "reload", load: ctrl.load })`, `host.onCancel(ctrl.clearPending)`, then an
   immediate `ctrl.load()` (the three host lifecycle registrations).
5. The three level factories are built over one `ProvidersViewContext`, including the subscription
   rows/status/actions consumed by L0 and L1.
6. `onMount` refreshes subscription status; in bootstrap mode with zero providers,
   `list.openAdd()` also fires immediately. Cleanup clears the countdown and cancels any active
   bounded device attempt through `ProviderAuthService.cancel`; it also invalidates pending platform
   completions and clears the feedback timer.
7. `host.onSave` runs `ctrl.save()` and, on a `"validation"` result, moves the cursor to the first
   issue via `jumpToIssue` (the `host.onSave` handler).
8. `bindLevelKeys` re-registers the level layer whenever depth changes, suspended while a picker is
   open (the `bindLevelKeys` call).
9. The rendered `LevelHost` receives `firstRunPicker={bootstrap}`. That flag reaches only this host's
   `CatalogPicker`; ordinary Providers and every other settings picker remain unbranded.

Level selection in `specFor(depth)` — **the map-editor check comes first, before any depth test**:

| Condition | Spec |
|---|---|
| `maps.active()` | `maps.levelSpec()` |
| depth 0 | `list.spec()` |
| depth 1 | `detail.spec()` |
| otherwise | `model.spec()` |

The rendered `levels` array passed to `LevelHost` mirrors it: index 0 list, index 1 detail, index 2 the map editor
guarded by `when: () => maps.active()`, index 3 the model level guarded by
`when: () => !maps.active() && host.level.depth() >= 2`. `packages/code/src/ui/patterns/level-host.tsx:39` selects the
first level whose `when()` is true, else the one whose index equals the depth.

`jumpToIssue` has two branches. At depth 0 it does
`providers().findIndex(p => p.name === issue.provider)` and moves `sel` to that provider's row. At
depth 1, when `issue.provider === current()?.name`, it looks the issue's `field` up in
`PROVIDER_ISSUE_DETAIL_FIELD` and takes the row from `PROVIDER_DETAIL_FIELDS.indexOf` of the label it
names — the row is **derived from** the pinned array, not a second copy of its head. An unmapped field
moves nothing.

### 4.6 L0 — provider list (`list-level.tsx`)

Rows are `name / kind / model count / credential status / origin`, with a trailing
`  default model` marker on the provider that owns `effectiveDefaultModel()`'s provider prefix
(`:163`, prefix computed at `:23`). Credential status text/colour comes from `presentKeyStatus`
(`:29`): `not-required` → em dash, `staged` → "Unsaved key" (warn), `environment` → "Shell
environment" (add), `keyfile` → "Saved key" (add), `missing` → "Missing key" (del).
For `openai-codex` and `xai-grok`, that credential cell is instead the fixed green label
`Subscription`; API-key readiness is not inferred for subscription credentials.

Level spec (`:187`): `nav.count = providers().length`, `activate = "open"` → `activate()` which sets
`drill`, zeroes `detailRow` and pushes the provider name as a breadcrumb (`:104`). Verbs: `add`
(`openPicker`) and `delete` (guarded by `sel() < providers().length`) (`:194`).

A trailing line shows the selected provider's own validation issue, if any: `issueMessage()`
(`:43`–`:49`) reads `ctrl.validation()`, finds the first issue whose `provider` matches the currently
selected row's name, and renders `<name>: <message>` beneath the list.

`openPicker` (`:57`):

| Condition | Behaviour |
|---|---|
| `!catalogReady(catalog)` | show the two subscription rows plus manual entry; absence of the public catalog does not hide subscription login (`:58-77`) |
| bootstrap and no providers yet | picker titled `Set up Clarvis ⟩ Step 1 of 2 ⟩ Provider` (`:67`) |
| otherwise | picker titled `Add provider — models.dev catalog` |
| `showAll()` false (bootstrap default) | subscription rows, `recommendedProviderRows(...)`, then a synthetic `__all_providers__` row |
| pick `openai-codex` / `xai-grok` | close this picker and call `openSubscription`; never seed from the public catalog |
| pick `__all_providers__` | `setShowAll(true)` and stay open (`:88`) |
| pick a provider id | `seedProviderFromCatalog`, clear `manualBootstrapProvider`, drill in, push breadcrumb, then chain into `openModelPicker(cp, config)` (`:92`–`:100`) |
| `onManual` | close picker, `addBlank()` (`:82`) |

`addBlank` sets `manualBootstrapProvider` when in bootstrap (`:51`) so the detail level can show the
manual-setup copy.

`remove` builds a reason list from `ctrl.providerRefs(name)` — "cited by agents: …" and "owns the
default_model" — and confirms with labels `delete` / `keep` before `deleteProviderAt`
(`:111`–`:133`).

The title is `"Providers"` when empty, else `Providers ⟩ <keyedCount> of <n> ready` (`:181`).

### 4.7 L1 — provider detail (`detail-level.tsx`)

For ordinary API-key providers, row indices are named constants `ENV_ROW=3`, `API_KEY_ROW=4`,
`SOURCE_ROW=5`, `HEADERS_ROW=6`, `BODY_ROW=7`; model rows start at
`PROVIDER_DETAIL_FIELDS.length`. For `openai-codex` and `xai-grok`, `fieldCount()` is `3`: only
provider name, the fixed API type, and subscription state precede the model rows. Base URL,
credential-variable/value/source, request headers, and request body are not rendered or navigable.
`nav.count` is `fieldCount() + modelIds().length`.

`activate()` dispatch (`:108`):

| Row | Action |
|---|---|
| 0 | `editProviderField("name")` — commits trimmed; on a non-empty name also `host.level.retitle` (`:103`) |
| 1 | `editKind()` — enum over `PROVIDER_KINDS` for ordinary providers; subscriptions refuse mutation because their kind is fixed by the authenticated scheme |
| 2 on a subscription | connect/reauthenticate, or confirm removal of local subscription credentials when connected |
| 2 on an ordinary provider | `editProviderField("base_url")` — empty trims to `undefined` (`:101`) |
| 3 (`ENV_ROW`) | `renameEnvVar()` — text editor seeded with `api_key_env ?? suggestedEnvVar` (`:80`) |
| 4 (`API_KEY_ROW`) | `setKeyValue()` — with an env var, straight to the secret prompt; without one, name the variable first and chain into the secret (`:62`–`:74`) |
| 5 (`SOURCE_ROW`) | `editSource()` — refuses with "name the env var first — set the key" when `api_key_env` is unset (`:45`); else enum over `KEY_SOURCES` with `SOURCE_MEANING` details (`:50`) |
| 6 / 7 | `ctx.openMap("headers" \| "body", "provider")` |
| ≥ `fieldCount()` | drill into `modelIds()[row - fieldCount()]`: set `modelId`, zero `modelRow`, push the id |

Pinned: `packages/code/tests/integration/providers-key-render.test.tsx:159` (Enter on a saved API-key
row opens the *secret* editor, not the env-var editor), `:196` (Enter on the env-var row renames),
`:220` (named-but-empty goes straight to the secret), `:249` (unset names the var first, chained),
`:273` (source row opens the enum).

Credential-value copy (`:186`): staged → `••••• staged — saves with Save changes`; `set` → `✓ from
shell env`; `keyfile` → `✓ saved in keys.json`; `unset` → `✗ no value yet`; no env var → `— not
configured`. The selected-row hint varies with the same state (`:202`).

Three of the eight rows carry inline validation markers: `issues = issueSet(() =>
mapProviderIssues(ctrl.validation(), current()?.name))` (`:41`) is wired onto the `FieldRow`s for
`name`, `base_url` and `api_key_env` via `issue={issues.for("name" | "base_url" | "api_key_env")}`
(`:231`, `:239`, `:245`). Row 1 (`kind`) receives no `issue=` prop at all — see §8 item 4 on why a
`kind`-field issue can never occur.

Verbs: `add models` and `remove model` (guarded by `detailRow() >= fieldCount()`).

`addModels()` (`packages/code/src/views/config/providers/detail-level.tsx`) resolution order:

1. subscription provider → `openSubscription(kind)`, which reconnects when necessary or loads the
   authenticated entitled catalog when already connected; it never resolves the configurable
   provider name against models.dev.
2. manual-bootstrap provider with zero models → `manualModelEntry` that finishes bootstrap on the new id.
3. catalog not ready → `manualModelEntry()`.
4. `ctrl.resolveCatalogProvider(p)` hit → `openModelPicker(resolved)`.
5. no hit → a "No catalog match — pick a source provider" picker over the whole catalog, whose manual row falls back to `manualModelEntry`.

Pinned by "adding models with no catalog goes straight to manual entry", "adding models resolves the
matching catalog provider directly, skipping the source picker", "adding models with no direct
catalog match offers a source-provider picker", and "adding models to a connected subscription opens
its entitled catalog" in `packages/code/tests/integration/providers-key-render.test.tsx`.

`removeModel()` refuses through `ctx.modelRemovalBlocked(id)` first, then confirms with `remove` /
`keep` labels (`:162`).

The title becomes `Set up Clarvis ⟩ Step 1 of 2 ⟩ Manual provider` only while
`manualBootstrapProvider() && modelIds().length === 0` (`:306`).

### 4.8 L2 — model detail (`model-level.tsx`)

`nav.count = MODEL_FIELDS.length` (`:156`). `activate()` (`:42`) clamps the row into range, then:

| Field | Action |
|---|---|
| `headers` / `body` | `ctx.openMap(field, "model")` (`:45`) |
| `prompt_cache` | advance one step in `PROMPT_CACHE_CYCLE`, stage it, and notify `Prompt cache: <next ?? "automatic"> (<scope> settings, unsaved)` (`:49`–`:54`) |
| `context_window_tokens` / `max_output_tokens` | `editor.startNumber` with `min: 1` (`:58`) |

One verb, `f` → `fillFromCatalog`, shown only while `fillHit() !== undefined` (`:166`).
`fillFromCatalog` (`:69`) writes, in this order: context window (if present), max output (if present),
capabilities (if non-empty), and — only when the entry's `prompt_cache` is still `undefined` —
`derivePromptCacheMode(catalogHit()?.cost, provider.kind)`. That exact ordering is pinned as an array
equality in `packages/code/tests/component/providers-level-contracts.test.ts:155`:
`["context_window_tokens","max_output_tokens","capabilities","prompt_cache"]`.

The two catalog memos are deliberately different lookups: `fillHit` uses
`ctrl.fillModelFromCatalog` (kind-then-anything fallback, `packages/code/src/features/providers/controller.ts:508`), while `catalogHit`
uses `ctrl.catalogModelFor` — the model under **this provider's own name only**
(`packages/code/src/features/providers/controller.ts:512`). `promptCacheNote()` reads `catalogHit` (`packages/code/src/views/config/providers/model-level.tsx:84`) and prints four
distinct sentences, including the special case "catalog: explicit ⟩ not derived on this kind" for an
`openai-compatible` provider (`:87`). Pinned at `packages/code/tests/integration/providers-key-render.test.tsx:969` and `:990`.

When there is no catalog hit, the footer line names `PANEL_VERBS.add.key` rather than a literal
(`packages/code/src/views/config/providers/model-level.tsx:146`).

### 4.9 The map editor path

`openMap(field, target)` in `packages/code/src/views/config/ProvidersPanel.tsx` captures the provider index and model id at call
time, builds a reactive `read` and a `write` that routes to `ctrl.setProviderMap` or
`ctrl.setModelMap`, and opens `maps` with different rules per field:

| Field | `rejectKey` | `rejectValue` | `suggest` | `footnote` |
|---|---|---|---|---|
| `headers` (`kind: "text"`) | `headerKeyProblem` | `headerValueProblem` | `headerSuggestions(kind)` | `headersFootnote(target)` |
| `body` (`kind: "json"`) | `bodyKeyProblem` | — | `bodySuggestions` | `bodyFootnote(kind, path)` |

`mapCell` renders the count as `—` / `N entry` / `N entries` (`:267`).

The map editor has no `close`: it derives its state from the host's level depth
(`packages/code/src/ui/patterns/map-editor.tsx:280` states the mechanism). The Providers tests exercise this from both
sides — one escape unwinds one drill inside `body`, and a further escape returns to the provider
detail (`packages/code/tests/integration/providers-key-render.test.tsx:1104` and `:1107`); escaping a *model's* headers map returns to the
model level, not the provider's (`:1169`).

Two edge behaviours of the shared map editor bound directly on what a Providers save actually writes:
`persist()` (`packages/code/src/ui/patterns/map-editor.tsx:358`–`:365`) compares a `JSON.stringify` of the rebuilt root against the
current value and writes nothing when they are equal, so opening `headers`/`body` and escaping
without a change never marks the panel dirty; `persistPruned()` (`:383`–`:385`) additionally strips
every nested object left empty, but only at the two edges where that can only be leftover — removing
an entry, and closing the editor — never mid-edit, which is what lets a suggestion whose template is
`{}` (e.g. `reasoning`) stay staged and drillable until the user actually leaves it empty.

### 4.10 First-run (bootstrap) flow

The dedicated `setup.providers` route always passes `bootstrap: true`; the ordinary Providers route
also enters the same flow when `registerProvidersCommands` sees zero configured providers. Both lazy
loaders await `loadCatalog()` concurrently with the panel import before mounting, because the
bootstrap `onMount` opens a picker whose catalog/no-catalog branch is selected once. The request is
still deferred until one of those routes is requested.
Production: `setup.providers` in `packages/code/src/app/commands.tsx` and
`registerProvidersCommands` in `packages/code/src/features/providers/commands.ts`. Test:
`packages/code/tests/integration/app-commands.test.tsx` (lazy catalog request and first-run picker
mount tests).

Bootstrap passes `firstRunPicker` through the configuration `LevelHost`. `CatalogPicker` mounts the
same complete eight-row Clarvis banner above every bootstrap picker only while
`firstRunSplashFits` passes (76×24 or larger), and `ListPicker` subtracts those nine intro rows
(banner plus separation) from its visible-row budget. Smaller terminals mount no intro and return all
of those rows to the catalog. Production: `packages/code/src/views/config/ProvidersPanel.tsx`
(`ProvidersPanel` return), `packages/code/src/views/config/view-host.tsx` (`LevelHost`),
`packages/code/src/views/config/CatalogPicker.tsx` (`CatalogPicker`), and
`packages/code/src/views/overlays/ListPicker.tsx` (`rowBudget`). Tests:
`packages/code/tests/integration/providers-key-render.test.tsx` (provider and model steps) and
`packages/code/tests/integration/catalog-picker-render.test.tsx` (large and small frames).

| Step | Trigger | Effect |
|---|---|---|
| open | `onMount` with zero providers | `list.openAdd()` (`ProvidersPanel` in `packages/code/src/views/config/ProvidersPanel.tsx`) |
| 1 | pick a catalog provider | seed it, drill in, chain into `openModelPicker` (`packages/code/src/views/config/providers/list-level.tsx:94`) |
| 1 subscription | pick ChatGPT or Grok | authenticate when needed, load that account's entitled catalog, create/reuse the provider for that scheme, then chain into `openModelPicker` |
| 1' | pick manual entry | `addBlank()` with `manualBootstrapProvider = true` (`packages/code/src/views/config/providers/list-level.tsx:51`) |
| 2 | pick a model, when `choosingFirstModel` | add from catalog, close the picker, `finishBootstrap` (`openModelPicker` in `packages/code/src/views/config/ProvidersPanel.tsx`) |
| 2' | manual model id | `addBlankModel`, then `finishBootstrap` via the `onAdded` callback (`manualModelEntry` in `packages/code/src/views/config/ProvidersPanel.tsx`) |
| finish | `finishBootstrap(provider, id)` | `setDefaultModel("<provider>/<id>")`; if `api_key_env` is unset and no value is already staged, prompt for the key and save afterwards; otherwise save now |
| save | `saveBootstrap` | `ctrl.save()`; on `"ok"` notify `Setup complete — <ref> is ready`, call `onBootstrapComplete({ model, reconnectRequired })`, then `host.close()` (`saveBootstrap` in `packages/code/src/views/config/ProvidersPanel.tsx`) |
| retry | **Ctrl+S** after a failed or cancelled save | recover the selected provider/model from the staged `default_model` and re-enter `finishBootstrap`, reusing a staged key instead of abandoning the onboarding completion callback |

`reconnectRequired` is computed **before** the save in `finishBootstrap`, from
`pendingKeys().size > 0 || pendingSources().size > 0` — after a successful save both maps are empty. Pinned end-to-end
at `packages/code/tests/integration/providers-key-render.test.tsx:746` (catalog path: writes `default_model: "alpha/m1"` plus the
seeded model, `completed === [{ model: "alpha/m1", reconnectRequired: true }]`, `closed === [1]`,
`host.dirty() === false`) and the manual-path test (tagged model id:
`default_model: "provider-1/qwen2.5-coder:7b"`,
`reconnectRequired: false`). The same suite pins retry after a settings failure with the original
staged credential.

While `choosingFirstModel`, closing the model picker does **not** fall back to the ordinary
"'<name>' ready — N models" notice; it warns "Choose a model to finish setup"
(`openModelPicker` in `packages/code/src/views/config/ProvidersPanel.tsx`). Outside bootstrap the picker stays open across picks
(`stayOpen: !choosingFirstModel`) and toggles membership in `onPick`.

### 4.10a Subscription authentication and entitled models

`subscriptionRows()` always projects ChatGPT (`openai-codex`) and Grok (`xai-grok`). In workspace
scope their detail directs the operator to global scope and `openSubscription` refuses activation;
personal subscription settings never enter the workspace draft. A missing `ProviderAuthService`
reads as unavailable; otherwise status comes from `providerAuth.list()` and
distinguishes checking, connected (including an optional plan label), expired/reauthentication
required, and the remaining service states. A connected row goes directly to
`ModelCatalogService.getEntitled`; any other available row begins `startDevice`.

The device picker is compact, stays open, and contains only four actions: copy the public user code,
open the public verification URL, copy that URL, or cancel. The displayed countdown is derived from
`expires_at`; the attempt id is retained only for polling/cancellation and is never rendered. Once
one copy action starts, its row shows the shared animated spinner with `Copying to clipboard…`.
Browser opening follows the same pattern with `Opening browser…`. Success changes that same row to
`✓ Copied to clipboard` or `✓ Browser opened` for 2.4 seconds; a later device action supersedes the
earlier feedback, and closing the attempt invalidates any late completion. A failure restores the
ordinary row immediately and reports the adapter error. Once
`wait(attempt_id)` settles, the active attempt and picker are cleared before any result handling.
Only `state === "connected"` claims success and loads entitled models; `expired` asks the operator to
start again, and every other non-connected result says the login did not complete. Closing the picker
or unmounting the panel cancels the active attempt.

An entitled catalog creates at most one provider for its scheme, using `chatgpt` or `grok` as the
base name and a numeric suffix on collision, then uses the ordinary model picker and durable model
shape. A catalog failure after authentication does not disconnect or replace the account: it keeps
or creates the scheme provider and offers an explicit unverified manual-model fallback. Subscription
bootstrap passes that fallback model through `finishBootstrap`, so it writes `default_model` and
reaches Ready like an entitled pick. Subscription
detail is a three-row prefix (name, fixed API type, subscription state); activating a connected state
uses a danger confirmation before `providerAuth.disconnect`, which removes local subscription
credentials but does not silently delete the provider settings. Its `add models` action returns to
this same entitled-catalog path and retains the existing provider-detail level under the picker.

Production: subscription functions and cleanup in `packages/code/src/views/config/ProvidersPanel.tsx`,
`addSubscriptionProvider` in `packages/code/src/features/providers/controller.ts`, and subscription
branches in `providers/list-level.tsx` and `providers/detail-level.tsx`. Tests:
`packages/code/tests/integration/providers-key-render.test.tsx` (first-run login, coexistence,
credential-field omission, disconnect, public-value actions, cancellation, failures, and manual
entitlement fallback, including bootstrap completion and workspace-scope refusal).

### 4.11 Providers controller — load / dirty / save

`load()` (`packages/code/src/features/providers/controller.ts:181`) copies the scope's providers, reads `default_model`, clears both
pending maps, records `savedSnapshot = snapshot()`, and clears the dirty mark.

`snapshot()` (`:192`) serializes `{ providers, ...(manageDefaultModel ? { default_model } : {}) }`.
`refreshDirty()` (`:207`) sets dirty when the snapshot differs **or** either pending map is non-empty.
Two tests pin the pair: `packages/code/tests/unit/providers-controller.test.ts:206` (a value edited back to its original clears
the mark) and `:220` (a staged credential keeps it dirty anyway, because a key never lands in
`settings.json`).

`save()` (`:558`) sequence:

| Step | Condition | Result |
|---|---|---|
| 1 | `disposed()` | return `"ok"` without doing anything |
| 2 | `!validation().ok` | emit `validation_failed` with the first issue, return `"validation"`; nothing is written (`:561`) |
| 3 | — | `await settings.write(scope, next)` (`:569`) |
| 4 | for each staged key | `await keys.set(envVar, value)`, then drop it from `pendingKeys`; on throw emit `key_save_failed` and return `"key-error"` (`:573`) |
| 5 | for each staged source | `code.writeKeySource(scope, envVar, source)`, then drop it; on throw emit `source_save_failed` and return `"source-error"` (`:587`) |
| 6 | — | bump `keysRev`, clear dirty, emit `saved`, and call `onReconnect` iff any key or source was staged (`:602`) |

`disposed()` is re-checked after **every** await (`:570`, `:576`, `:588`, `:601`), so a panel torn
down mid-save neither writes secrets nor emits into a dead view — pinned at
`packages/code/tests/unit/providers-controller.test.ts:341`. Error paths pinned at `:366` (key-error, staged key retained) and
`:408` (source-error after keys already saved).

`keysRev` exists because `deps.keys` / `deps.code` are mutated outside Solid's reactivity; bumping it
forces `envStatusOf` and `sourceOf` to re-derive (`:155`–`:160`, read at `:227` and `:232`).

`validation()` is a memo that hands the settings adapter the current scope's file with the draft
providers spliced in, resolved against `mergeProviders(global, workspace)` where the edited scope
contributes the draft (`:516`–`:532`).

`resolveCatalogProvider` (`:236`) matches by name **and** kind first, then falls back to the first
catalog provider of the same kind whose `base_url` or `api_key_env` matches; `suggestedEnvVar` (`:251`)
prefers the catalog's `api_key_env` and otherwise uppercases/sanitizes the provider name into
`<NAME>_API_KEY`, defaulting to `PROVIDER_API_KEY` when the name sanitizes to empty.

`keyUsageNote` (`:261`) returns `"source=env - keys.json is ignored"` for `env`, nothing for
`keyfile`, and `"shell env overrides this (source=auto)"` for `auto` when the env var is set.

### 4.12 Event presentation

`ProvidersEvent` (`packages/code/src/features/providers/events.ts:8`) is a 7-arm union; `presentProvidersEvent` (`packages/code/src/features/providers/events.ts:23`–`:61`) maps
each variant to a `Notice`:

| Variant | Fields | Message template | Tone |
|---|---|---|---|
| `key_staged` | `envVar` | `key staged for <envVar> — save to reconnect` | default |
| `source_staged` | `envVar`, `source`, `meaning` | `key source for <envVar>: <source> — <meaning> (saves on ^s)` | default |
| `model_added` | `id`, `contextWindow` | `added <id> — ctx <contextWindow>` | default |
| `validation_failed` | `issue` | `cannot save — <issue.message>` | `error` |
| `key_save_failed` | `envVar`, `error` | `key save failed for <envVar>: <errorText>` | `error` |
| `source_save_failed` | `envVar`, `error` | `source save failed for <envVar>: <errorText>` | `error` |
| `saved` | `scope`, `reconnecting` | `saved <scope> providers` (+ ` — reconnecting backend` when `reconnecting`) | `"success"` |

Only the three named carry a tone; the rest default. `ProvidersPanel` funnels every event through it
into `deps.notify` (the controller `emit` in `ProvidersPanel`). Every variant's message text is pinned, plus an
exhaustiveness canary over the union, at `packages/code/tests/unit/providers-events.test.ts`.

### 4.13 DefaultsPanel

Three rows, indices clamped to `[0,2]` (`packages/code/src/views/config/DefaultsPanel.tsx:41`), `nav.count = 3` (`:108`):

| Row | Field | Editor |
|---|---|---|
| 0 | `default_vision_model` | `modelPickerSpec` with `requireCapability: "vision"` (`:65`) |
| 1 | `budget.on_exceed` | `startEnum(["stop","escalate"])` seeded from the draft or `env.budgetOnExceed` (`:79`) |
| 2 | `budget.total_token_limit` | `startNumber` with `min: 1`, `max: env.tokenCeiling` (`:89`) |

`save()` writes exactly `{ default_vision_model, budget }` (`:53`), so it never touches
`default_model` or `default_reasoning_effort` — pinned at
`packages/code/tests/integration/defaults-panel-render.test.tsx:197`, which asserts the written patch
is `{ default_vision_model: undefined, budget: undefined }`, and `:105`, which asserts the frame
contains neither "Default model" nor "Reasoning effort". Row 2's commit writes back only
`total_token_limit` and no longer co-writes `on_exceed` (`:98`). When neither scope declares a token
limit, the effective cell shows `env.tokenDefault`; the kernel's real fallback is never presented as
"unlimited". `readEnvView` obtains that value from `CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT`.

### 4.13a `createMcpCapabilities` — the live MCP capability bridge

`createMcpCapabilities(deps)` (`packages/code/src/adapters/mcp-capabilities-bridge.ts:87`) holds one
Solid signal, `nodes`, and two mutable maps: `registered` (per slash-command key → `{fingerprint,
off}`) and `skillAgents` (per bare skill name → the agent it runs on, `:88`–`:90`). It is constructed
once by `packages/code/src/app/commands.tsx` (`mcpCaps`) and fed to both `McpBrowser` (its
`nodes`/`refresh` in the `mcp.browse` registration) and the autocomplete layer's `skillAgent`
lookup (consumed at `packages/code/src/views/input/autocomplete.ts:126`).

**`refreshOnce()`** (`:95`) reads `deps.client.connectionStatus()`; only when it is `"connected"` does
it `Promise.all` the client's `listTools()`/`listPrompts()`, each `.catch`-guarded by
`reportListFailure` (§2.12) so one rejecting half never sinks the other (`:100`–`:107`). Immediately
after that await, `if (disposed || refreshQueued) return;` (`:109`) discards the pass without ever
calling `setNodes` — a newer `refresh()` request that queued while this listing was in flight makes
this pass's result stale on arrival, and the caller (`refresh()`) will loop again with a fresh listing
rather than let an outdated one publish. Otherwise it re-reads `deps.profiles()`/`deps.declared()`
fresh at commit time, calls `reconcile` (`adapters/mcp-capabilities.ts`, §2.11) into `setNodes`, and
runs `syncPromptCommands(prompts, profiles)` (`:110`–`:112`).

**`refresh()`** (`:115`) is single-flight with trailing coalescing. A call while `refreshActive` is
set only flips `refreshQueued = true`, counts `mcp.refresh.coalesced`, and returns the *same* in-flight
promise (`:118`–`:122`); it never starts a second physical listing. The owning call runs a `do…while`
loop — clear `refreshQueued`, `await diagnosticAsync("mcp.refresh", refreshOnce, {slowMs:
deps.refreshSlowMs})`, repeat while `refreshQueued && !disposed` (`:123`–`:136`) — so however many
`refresh()` calls arrive during one pass, exactly one further pass runs afterward, using whatever
`declared()`/`profiles()` return at that later point; a refresh that never settles cannot accumulate
queued *physical* requests, only the `refreshQueued` flag toggles. `diagnosticCount("mcp.refresh.requested")`
fires on every call (`:117`); `deps.refreshSlowMs` is the seam that shortens `diagnosticAsync`'s
pending-operation warning (`async.pending`, `core/diagnostic-events.ts:174`) for a test that cannot
wait out the real default — no production registration site passes it (`app/commands.tsx:1289`
omits it), matching the sibling `refreshSlowMs` seam on `WorkflowsHubDeps`
described in [hosts/code-domain-hubs.md](code-domain-hubs.md) §8 item 10.

**`syncPromptCommands(prompts, profiles)`** (`:140`) walks the live prompt list and, per entry, calls
`classifyCapability(p.name, "prompt", profiles)` (§3.3). For a `"skill"` origin it builds a `local`-keyed
slash command: the registration key is `skill::<local>`; `skillAgents` is set to `p.agent` when the
prompt names one, deleted otherwise (`:148`–`:149`); a `spec: LivePrompt` is assembled carrying only
the fields that are actually defined (`displayName`, `agent`, `plansMode` are each spread in only when
present, `:150`–`:157`), and `JSON.stringify(spec)` is its fingerprint. If a command is already
registered under that key with the *same* fingerprint, nothing happens (`:159`–`:160`) — re-listing an
unchanged skill neither disposes nor re-registers its command, so its closure over the prior `spec`
survives across a refresh. Otherwise the old registration (if any) is disposed and
`deps.commands.skillCommand(local, spec, handler)` registers the new one (`:161`–`:175`). The handler
dispatches on `spec.agent`: when set, it calls `deps.effects.submitSkillRun(local, args, spec.agent)`
and never touches `getPrompt` (`:163`–`:166`); otherwise it awaits `deps.client.getPrompt(local,
{task: args})`, bails if `disposed` became true while awaiting (`:168`), and calls
`deps.effects.submitPromptTurn(messages, display, skillMeta)` where `display` is `` `/${local}
${args}` `` or bare `` `/${local}` `` and `skillMeta` carries `name`, `task` only when `args.length >
0`, and `plansMode` only when the spec has one (`:169`–`:173`).

`skillAgents` is only a fallback input to `classifySlashSubmit`; the classifier first resolves the
registered slash catalog. A skill that collides with `/plan` or another registered command may
remain represented in this metadata map, but it cannot shadow that command. Production:
`syncPromptCommands` in `packages/code/src/adapters/mcp-capabilities-bridge.ts` and
`classifySlashSubmit` in `packages/code/src/views/input/autocomplete.ts`. Test:
`packages/code/tests/unit/autocomplete.test.ts` and
`packages/code/tests/integration/app-shell-render.test.tsx`.

For a `"downstream"` origin with a `server` (`:178`), the key is `` `${server}:${local}` ``
(`promptKey`, `:61`); the spec carries only `name`/`description`/`arguments`; the same
fingerprint-dedupe applies (`:184`–`:187`); the registered handler (`:188`) collects arguments through
`deps.effects.collectArgs(server, spec)` only when `spec.arguments` is non-empty, bails on `disposed`
or a `null` (cancelled) collection (`:192`), then calls `deps.client.getPrompt(promptKey(server,
local), args)` and — unless disposed meanwhile — `submitPromptTurn(messages, `/${server}:${local}`)`
with no skill metadata (`:195`–`:197`).

After the pass, every previously `registered` key **not** touched this round (`!seen.has(key)`) is
deregistered: its `off()` runs, it is removed from `registered`, and — for a `skill::`-prefixed key —
its entry is dropped from `skillAgents` too (`:201`–`:207`). This is the deregistration half of the
per-refresh lifecycle the module's own TSDoc names: it "registers a slash command for each downstream
prompt and skill (deregistering ones that disappear on the next `refresh`)" (`:66`–`:69`).

**`dispose()`** (`:210`) is idempotent (`if (disposed) return`, `:211`). It flips `disposed`, clears
`refreshQueued`, calls every registered `off()` in **reverse** registration order inside its own
`try {} catch {}` so one throwing teardown does not skip the rest (`:214`–`:218`), then clears both
maps and resets `nodes` to `[]` (`:219`–`:221`). Because `refreshOnce`'s post-await check and
`refresh()`'s loop condition both test `disposed`, a refresh already in flight when `dispose()` runs
can finish its physical `listTools`/`listPrompts` calls but never registers a command or publishes
nodes afterward.

### 4.14 McpBrowser

Three read-only levels (`packages/code/src/views/config/McpBrowser.tsx:392`, each `readOnly: true`). `refresh()` runs once at
construction (`:62`), setting `loading` and clearing or setting `listError`.

| Depth | nav | verbs |
|---|---|---|
| 0 servers | count `nodes().length`, activate "open" (`:121`) | `e` "where to edit" (passes the server name only for a `downstream` node, `:135`), `refresh` (`ctrl+r`) |
| 1 tools+prompts | count `tools.length + prompts.length`, activate "detail" (`:142`) | `i` "invoke prompt" guarded by `onPromptRow` (`:150`), `e` "where to edit" |
| 2 item | — | `i` "invoke" guarded by `itemKind() === "prompt"` (`:156`) |

`onPromptRow` (`:69`) requires `prompts.length > 0` in addition to `detailSel() >= tools.length`; its
inline comment states the failure it fixes: `0 >= 0` on an empty server made the action advertise
itself and do nothing. Invoking dispatches the command `"<server>:<prompt>"` and notifies
(`:107`, `:116`).

Server rows carry a status glyph, name, transport type, status word and a capability summary; the
control-plane node shows `"control-plane hidden"` instead of counts (`:188`), a `shared` badge appears
when the declaration says so (`:213`), and a fixed legend line is always trailing (`:220`). Section
labels `backend` and `downstream (aggregated by the kernel)` are emitted inside the row renderer
(`:193`, `:198`) and counted separately into `contentRows` by `headerCount()` (`:166`).

Tool detail renders the `schemaArgRows` table, falls back to `"no arguments"` or a raw JSON dump when
the table is empty (`:338`), and then renders a live `renderToolPreview(server, tool,
synthSampleArgs(inputSchema))` block (`:349`). Pinned at
`packages/code/tests/integration/mcp-browser-render.test.tsx:68` (sections, legend, read-only badge,
both verbs), `:127` (argument table not a JSON dump), `:150`/`:160` (`[e]` naming), `:194`/`:211`
(invoke), `:233` (control-plane explanation), `:244` (declared-but-empty explanation), `:289` ("no
arguments").

### 4.14a Guided Extensions setup and focused browsers

The five-step setup, its focused Environment/Plugins/MCP browsers,
composition transaction, exact scrollable previews, and responsive/performance rules are specified in
[code-extensions.md](code-extensions.md). This document retains only the shared `ViewHost`, field
editor and key-binding machinery those views consume
(`packages/code/src/views/config/ExtensionsHub.tsx`, `ExtensionsHub`;
`packages/code/src/views/config/EnvironmentBrowser.tsx`, `EnvironmentBrowser`;
`packages/code/src/views/config/MarketplaceBrowser.tsx`, `MarketplaceBrowser`).

### 4.16 Settings adapter

Every state-publishing operation goes through one FIFO, `publishInOrder`
(`packages/code/src/adapters/settings.ts:271`): `write`, `reload`, `setWorkspaceTrust` and `applyRepair` all queue on
`publicationTail`, and a failure is the caller's error while the queue continues. Pinned at
`packages/code/tests/integration/settings.test.ts:264` ("state-publishing settings operations share one invocation-ordered queue") and
`:328` ("a slow agent reload cannot overwrite a later trust refresh").

`write(scope, patch)` (`:387`) in order:

1. `structuredClone(patch)` and compute the sorted `keys` string for diagnostics (`:388`).
2. Inside the queued operation: refuse if `corrupt(scope)` — record `settings.save.rejected` with reason `unparsable` and throw `"<scope> settings.json is invalid (…) — fix it by hand before saving"` (`:392`).
3. Merge `{...current, ...patch}` and validate against `kernelSettingsSchema`; on failure record `reason: "invalid"` with the issue paths and throw `refusing to save invalid settings: <zodIssueSummary>` (`:400`).
4. Capture `expectedRevision = sourceRevision(scope)` — after the awaits above, i.e. after the previous queued save has landed (`:406`).
5. `config.updateSettings(...)`; on throw, `resyncAfterRefusedWrite` re-reads settings **and** agents and bumps the version, then **rethrows the original error** (`:409`).
6. On success record `settings.save.applied` and bump the version (`:413`).

`setWorkspaceTrust` re-reads the agent list alongside the settings view (`:314`), because the same
verdict gates both.

`validateProviders` (`:442`) issues, in order: `providers` empty; per provider `name` missing /
not matching `^[a-z0-9_-]+$` / duplicate; `openai-compatible` without a well-formed http(s)
`base_url`; `api_key_env` not matching `^[A-Za-z_][A-Za-z0-9_]*$`; each model's
`context_window_tokens` not a positive integer. Then `default_model` must resolve — the *model* must
exist, not merely its provider, except that a provider with no `models` map or an empty one is
accepted (`:495`). The inline comment at `:486` states the defect that rule fixes.

`origin(key)` returns `"workspace"` only when the workspace file defines the key **and** it is not in
`withheldWorkspaceFields()` (`:325`).

`envStatus` composes `keyOrigin(source, envPresent, filePresent)` from
`packages/code/src/adapters/provider-secrets.ts:14` and renames its `"env"` result to `"set"`
(`packages/code/src/adapters/settings.ts:546`).

---

## 5. Invariants

Numbered; each carries the production site and the test that pins it.

**INV-253 (owned).** `@clarvis/code`'s manifest contains no export-map entry whose path includes the
substring `"providers"` — the three provider level modules gain no package entrypoint and stay private
to `ProvidersPanel`.
Production: `packages/code/package.json` (no `exports` key at all today, lines 1–47).
Test: `packages/code/tests/architecture/providers-panel-boundary.test.ts:9`.

**INV-264 (owned).** The `ProvidersPanel.tsx` module namespace exposes exactly `["ProvidersPanel"]`;
`createProviderListLevel` / `createProviderDetailLevel` / `createProviderModelLevel` exist and are
callable from their own modules but are not re-exported through the facade.
Production: `ProvidersPanel` in `packages/code/src/views/config/ProvidersPanel.tsx` (the only `export function`).
Test: `packages/code/tests/component/providers-panel-surface.test.ts:9`–`:15`.

**INV-265 (owned).** The provider screens' field order is a pinned contract:
`PROVIDER_DETAIL_FIELDS` is exactly
`["name","kind","base_url","env var","API key","source","headers","body"]`, `MODEL_FIELDS` is exactly
`["context_window_tokens","max_output_tokens","prompt_cache","headers","body"]`, and the L0 list
level's navigation count reflects only provider rows — `default_model` is not a row there. The
eight-field array is the ordinary-provider prefix; subscription providers intentionally replace it
with the three-row prefix `name`, fixed `kind`, `Subscription` before their model rows.
Production: `packages/code/src/views/config/providers/detail-level.tsx:17`, `packages/code/src/views/config/providers/model-level.tsx:12`, `packages/code/src/views/config/providers/list-level.tsx:189`.
Test: `packages/code/tests/component/providers-level-contracts.test.ts:67` (L0 counts 0 and 2), `:99`
(the eight detail fields), `:118` (`nav.count === PROVIDER_DETAIL_FIELDS.length + 2`), `:122` (the five
model fields). `:79` additionally pins the issue-field correspondence that reads the array. Reinforced from the render side by
`packages/code/tests/integration/providers-key-render.test.tsx:370` ("the provider list has no
default_model editor") and `:392`.

**INV-298 (owned).** The provider detail screen's navigation is
`fieldCount() + <configured model count>` rows, in that order: `fieldCount()` is
`PROVIDER_DETAIL_FIELDS.length` for an ordinary provider and `3` for a subscription. Thus every
provider-local field precedes the provider's models, and a row index at or past the active
`fieldCount()` addresses a model and nothing else. The same helper owns the count, activation,
rendered model-row offset, and remove-model gate.
Production: `fieldCount`, `activate`, the model-row projection, and `spec` in
`packages/code/src/views/config/providers/detail-level.tsx`.
Test: `packages/code/tests/component/providers-level-contracts.test.ts:98` ("L1 keeps credential/map
rows before the provider's model rows"), `:118` — a provider with two models yields
`PROVIDER_DETAIL_FIELDS.length + 2`; the subscription prefix and field omissions are pinned by
`packages/code/tests/integration/providers-key-render.test.tsx` ("subscription detail omits API-key
and endpoint fields").

**INV-299 (owned).** The model screen's `f` verb ("fill from catalog") is offered only while the
catalog has a hit for the current model, and one press writes, in exactly this order,
`context_window_tokens`, `max_output_tokens`, capabilities, and — only when the model carries no
explicit `prompt_cache` — a derived prompt-cache mode. The order is asserted as an array equality, so
reordering the writes is a visible diff rather than a silent behaviour change (§4 above records why
the order matters: `derivePromptCacheMode` reads `catalogHit`, a different lookup from `fillHit`).
Production: `packages/code/src/views/config/providers/model-level.tsx:69-81` (`fillFromCatalog`),
`:162-168` (the verb and its `when`).
Test: `packages/code/tests/component/providers-level-contracts.test.ts:121`, assertions `:152-160`.

**INV-P1.** `runSave` is single-flight: two calls issued while the handler is unresolved return the
identical promise object and invoke the handler once; a call after settlement invokes it again.
Production: `packages/code/src/views/config/create-view-host.ts:177`. Test: `packages/code/tests/unit/view-host-scope.test.ts:90` (asserts
`duplicate === first`).

**INV-P2.** `controls.escape()` is the only dirty-checked close; `controls.dispose()` discards unsaved
edits with no check, and the two together invoke the registered cancel handler exactly once.
Production: `packages/code/src/views/config/create-view-host.ts:194`, `:211`, `runCancel` at `:171`.
Test: `packages/code/tests/unit/view-host-scope.test.ts:79` (dispose runs cancel once, twice is a no-op), `:114`
(escape then dispose does not double-invoke), `:125` (dirty escape after the confirm still runs it
once).

**INV-P3.** A scope toggle in `mode: "reload"` over a dirty draft never changes the scope until the
user confirms; in the default `retarget` mode a dirty draft survives the toggle with no prompt.
Production: `packages/code/src/views/config/create-view-host.ts:134`–`:151`.
Test: `packages/code/tests/unit/view-host-scope.test.ts:32`, `:41`, `:50`.

**INV-P4.** `view.scope.toggle` is enabled only for a view that actually bound a scope.
Production: `packages/code/src/views/overlay-host.ts:202` reading `controls.scopeBound()`, set at `packages/code/src/views/config/create-view-host.ts:156`.
Test: unpinned — no test asserts the enabled predicate.

**INV-P5.** An ordinary (non-bootstrap) provider save never writes `default_model`.
Production: `packages/code/src/features/providers/controller.ts:566` gated by `deps.manageDefaultModel`, itself `bootstrap`
(`ProvidersPanel` in `packages/code/src/views/config/ProvidersPanel.tsx`).
Test: `packages/code/tests/unit/providers-controller.test.ts:326` asserts the written file is exactly
`{ providers: [...] }` even with a `default_model` present in the scope.

**INV-P6.** The dirty mark is a difference against what was loaded, not a latch: a field edited back
to its original clears it; a staged credential or key source keeps it set regardless.
Production: `packages/code/src/features/providers/controller.ts:207` (`refreshDirty`), snapshot at `:192`.
Test: `packages/code/tests/unit/providers-controller.test.ts:206`, `:220`.

**INV-P7.** A disposed providers controller neither writes staged secrets, nor reconnects, nor emits.
Production: the `disposed()` re-checks at `packages/code/src/features/providers/controller.ts:558,569,575,587,600`, and the
`createDisposeGuard` gate at `packages/code/src/features/dispose-guard.ts:21`.
Test: `packages/code/tests/unit/providers-controller.test.ts:341`.

**INV-P8.** `save()` is ordered settings → keys → key sources, and stops at the first failure, leaving
the still-unsaved staged items in their pending maps.
Production: `packages/code/src/features/providers/controller.ts:568`, `:572`, `:586`.
Test: `packages/code/tests/unit/providers-controller.test.ts:365` (key-error retains the staged key), `:408`
(source-error occurs after keys were already saved).

**INV-P9.** A provider field the panel does not model survives a load-edit-save round trip
(`headers`, `body`, model `prompt_cache`, model `headers`/`body`).
Production: `load` copies each provider shallowly (`packages/code/src/features/providers/controller.ts:183`) and `mutate` re-copies
(`:219`).
Test: `packages/code/tests/unit/providers-controller.test.ts:758` ("T10").

**INV-P10.** `catalogModelFor` looks a model up **only** under the configured provider's own catalog
name, never through `fillModelFromCatalog`'s kind/any fallback, because its result is what
`derivePromptCacheMode` and the prompt-cache note are computed from.
Production: `packages/code/src/features/providers/controller.ts:512`; consumers `packages/code/src/views/config/providers/model-level.tsx:34`, `:78`, `:84`.
Test: `packages/code/tests/unit/providers-controller.test.ts:847`; render-side at
`packages/code/tests/integration/providers-key-render.test.tsx:969`, `:990`.

**INV-P11.** `fillFromCatalog` writes at most four fields, in the fixed order context window → max
output → capabilities → prompt cache, and stamps `prompt_cache` only when the entry has none.
Production: `packages/code/src/views/config/providers/model-level.tsx:69`–`:81`.
Test: `packages/code/tests/component/providers-level-contracts.test.ts:155`.

**INV-P12.** Setting a model's `prompt_cache` to `undefined` deletes the key rather than storing a
sentinel — `"(auto)"` is an *absent* key.
Production: `packages/code/src/features/providers/controller.ts:496`. Test: `packages/code/tests/unit/providers-controller.test.ts:734`.

**INV-P13.** An empty `headers` / `body` map deletes its key rather than persisting `{}`.
Production: `packages/code/src/features/providers/controller.ts:436` (`applyMap`).
Test: `packages/code/tests/unit/providers-controller.test.ts:794`, `:816`.

**INV-P14.** A blank API-key submission never overwrites an existing key.
Production: `packages/code/src/views/config/key-entry.ts:29`. Test: `packages/code/tests/unit/key-entry.test.ts:39`.

**INV-P15.** The secret field never renders the plaintext and never lets the cursor leave the end of
the buffer, so a masked value cannot be corrupted by editing in the middle.
Production: `packages/code/src/views/config/field-editor.tsx:472`–`:493` (cursor pin and mask diff), `:245` (arrow/home/end bound to
no-op).
Test: `packages/code/tests/integration/secret-input-render.test.tsx:15`, `:39`, `:63`, `:90`.

**INV-P16.** `startEnum` opens pre-selected on the current value and committing that same value is a
no-op, so opening and confirming an enum never dirties a panel.
Production: `packages/code/src/views/config/field-editor.tsx:365` (initial index) and `:550` (`picked !== st.initialValue`).
Test: `packages/code/tests/integration/field-editor-pick-render.test.tsx:49`, `:68`.

**INV-P17.** A text or number field commits only on change unless `alwaysCommit` is passed.
Production: `packages/code/src/views/config/field-editor.tsx:156`, `:284`.
Test: `packages/code/tests/integration/field-editor-pick-render.test.tsx:93`, `:104`.

**INV-P18.** While a modal field edit is open, the shell's `ctrl+s` (save) and `ctrl+t` (scope) never
reach the shell. The text, secret and number modes spread `GUARDS` — both keys bound to a no-op — into
their `LAYER.MODAL` layer; the multiline mode instead claims `ctrl+s` for its own apply command and
binds `ctrl+t` to a no-op.
Production: `packages/code/src/views/config/field-editor.tsx:141` (`GUARDS`), spread at `:193`, `:251`, `:321`; multiline at
`:416`–`:417`.
Test: unpinned.

**INV-P19.** Level key bindings are released whenever a field edit, a confirm, an inactive frame, or
an explicitly suspended overlay is in effect.
Production: `packages/code/src/ui/patterns/bind-level-keys.ts:26`–`:31`; providers pass
`suspend: () => picker() !== null` (the `bindLevelKeys` call in
`packages/code/src/views/config/ProvidersPanel.tsx`) and marketplace passes `editor`
(`packages/code/src/views/config/MarketplaceBrowser.tsx`, `bindLevelKeys`). Test:
`packages/code/tests/integration/marketplace-browser-render.test.tsx` (add-source URL input).

**INV-P20.** In `ProvidersPanel.specFor`, the map editor's spec wins over every depth-based spec.
Production: `specFor` in `packages/code/src/views/config/ProvidersPanel.tsx`. Test: exercised indirectly by
`packages/code/tests/integration/providers-key-render.test.tsx:1048` and `:1082`, which assert map-level verbs (`[a] add`,
`[d] delete`) and map bodies at depths ≥ 2.

**INV-P21.** A model referenced by `default_model` or by an agent profile cannot be removed; the
refusal names the reason.
Production: `packages/code/src/features/providers/controller.ts:379` (`modelRemovalBlocked`), presented by
`presentModelRemovalBlock` in `packages/code/src/views/config/ProvidersPanel.tsx`.
Test: `packages/code/tests/unit/providers-controller.test.ts:260`; render-side
`packages/code/tests/integration/providers-key-render.test.tsx:508`.

**INV-P22.** `reconcile` always returns the `kernel` control-plane node first, gives it zero tools,
and attaches skill prompts to it; downstream nodes are sorted by name.
Production: `packages/code/src/adapters/mcp-capabilities.ts:168`, `:172`, `:173`, `:178`, `:192`.
Test: `packages/code/tests/unit/mcp-capabilities.test.ts:85`, `:110`, `:132`.

**INV-P23.** A configured MCP server that has never connected still appears, with status `declared`.
Production: `packages/code/src/adapters/mcp-capabilities.ts:184`.
Test: `packages/code/tests/unit/mcp-capabilities.test.ts:97`; render-side `packages/code/tests/integration/mcp-browser-render.test.tsx:244`.

**INV-P24.** A settings write is refused, with a durable diagnostic, when the target scope is
unparsable or when the merged document fails `kernelSettingsSchema` — the file on disk is untouched
either way.
Production: `packages/code/src/adapters/settings.ts:392`, `:400`.
Test: `packages/code/tests/integration/settings.test.ts:421`, `:462`, `:477`, `:811`, `:835`.

**INV-P25.** A refused write never adopts its own field into the cached snapshot, and re-reads the
snapshot from disk; failing to re-read does not mask the original refusal, which is still thrown.
Production: `packages/code/src/adapters/settings.ts:372`–`:412`.
Test: `packages/code/tests/integration/settings.test.ts:361` (conflict re-syncs and the external edit stands),
`:174` (a failing re-read still reports the original refusal).

**INV-P26.** Every state-publishing settings operation shares one invocation-ordered queue, so a slow
reload cannot overwrite a newer mutation.
Production: `packages/code/src/adapters/settings.ts:271`.
Test: `packages/code/tests/integration/settings.test.ts:264`, `:328`, `:231`.

**INV-P27.** `origin(key)` never reports `"workspace"` for a field the kernel withheld from the merge.
Production: `packages/code/src/adapters/settings.ts:325`.
Test: `packages/code/tests/integration/settings.test.ts:620`, `:629`, `:636` cover the ordinary cases; the withheld
branch is unpinned.

**INV-P28.** `default_model` validation requires the *model* to exist, not just the provider — except
that a provider declaring no models at all is accepted.
Production: `packages/code/src/adapters/settings.ts:492`–`:499`.
Test: `packages/code/tests/integration/settings.test.ts:156`, `:701`.

**INV-P29.** No `body` key the suggestion tables offer is one the request assembles for itself.
Production: `packages/code/src/features/providers/request-params.ts:75`, `:100`, `:121` against `FORBIDDEN_PROVIDER_BODY_KEYS`.
Test: `packages/code/tests/unit/request-params.test.ts:35`.

**INV-P30.** The credential header offered for a provider kind is the one that kind's SDK actually
authenticates with, and no kind is offered a header that would override nothing.
Production: `packages/code/src/features/providers/request-params.ts:37` (`AUTH_HEADER`), used at `:67`.
Test: `packages/code/tests/unit/request-params.test.ts:92`, `:101`.

**INV-P31.** `bodyKeyProblem` guards only the root of `body`; a `messages` key nested under a
provider-owned object is accepted.
Production: `packages/code/src/features/providers/request-params.ts:195`. Test: `packages/code/tests/unit/request-params.test.ts:53`.

**INV-P32.** A header value may contain any number of well-formed `${VAR}` references; only a residual
unterminated `${` is refused.
Production: `packages/code/src/features/providers/request-params.ts:179`. Test: `packages/code/tests/unit/request-params.test.ts:61`; render-side
`packages/code/tests/integration/providers-key-render.test.tsx:1192`.

**INV-P33.** A `body` authored on a kind with no request-body seam is warned about where it is
authored.
Production: `packages/code/src/features/providers/request-params.ts:227`. Test: `packages/code/tests/unit/request-params.test.ts:79`; render-side
`packages/code/tests/integration/providers-key-render.test.tsx:1175`.

**INV-P34.** `DefaultsPanel.save` writes only `default_vision_model` and `budget`.
Production: `packages/code/src/views/config/DefaultsPanel.tsx:53`. Test:
`packages/code/tests/integration/defaults-panel-render.test.tsx:197`, `:105`.

**INV-P35.** `McpBrowser`'s `[i] invoke prompt` verb is offered only on an actual prompt row, never on
an empty server's phantom row 0.
Production: `packages/code/src/views/config/McpBrowser.tsx:69` (`prompts.length > 0 &&` …).
Test: unpinned as such; `packages/code/tests/integration/mcp-browser-render.test.tsx:194` exercises the positive case only.

**INV-P36.** A workspace-scoped plugin can never be uninstalled from the browser.
Production: `packages/code/src/views/config/MarketplaceBrowser.tsx` (`uninstall`). Test:
`packages/code/tests/integration/marketplace-browser-render.test.tsx` (workspace lifecycle policy).

**INV-P37.** A marketplace listing this host cannot fetch from is never installed, whether by the
`activate` verb or otherwise.
Production: `packages/code/src/views/config/MarketplaceBrowser.tsx` (`runPrimary`). Test:
`packages/code/tests/integration/marketplace-browser-render.test.tsx` (unavailable local entry).

**INV-P38.** `SETTINGS_ITEMS` is the single source for the Settings menu, deep-link router and inline
subcommand hints. Extensions has only one public route; guided setup steps and internal focused
children remain owned by `ExtensionsHub` and its command registration.
Production: `packages/code/src/views/config/hub-items.ts`, `packages/code/src/views/config/SettingsHub.tsx`,
`packages/code/src/views/config/ExtensionsHub.tsx` (`SetupStep`, `spec`) and
`packages/code/src/app/commands.tsx` (`settings.open`, `extensions.open`). Test:
`packages/code/tests/integration/settings-hub-render.test.tsx` and
`packages/code/tests/integration/app-commands.test.tsx` (hub routing).

**INV-P39.** `McpCapabilities.refresh()` calls are single-flight: any call issued while one is already
in flight coalesces onto that same promise and only sets a trailing flag, never starting a second
physical `listTools`/`listPrompts` pair; a refresh that never settles cannot accumulate queued
physical requests no matter how many times `refresh()` is called.
Production: `packages/code/src/adapters/mcp-capabilities-bridge.ts:115`–`:138` (the `refreshActive`
guard and `do…while refreshQueued` loop).
Test: `packages/code/tests/component/mcp-bridge.test.ts:392` ("overlapping refreshes are single-flight
and coalesce into one trailing response"), `:439` ("a never-settling MCP refresh does not accumulate
physical requests").

**INV-P40.** `dispose()` is idempotent, deregisters every registered slash command in reverse
registration order (one throwing teardown does not skip the rest), and a refresh already in flight
when `dispose()` runs may still complete its physical listing but can no longer register a command or
publish nodes once it does.
Production: `packages/code/src/adapters/mcp-capabilities-bridge.ts:210`–`:222` (`dispose`), the
post-await `disposed || refreshQueued` check in `refreshOnce` (`:109`) and the `!disposed` loop
condition in `refresh` (`:132`).
Test: `packages/code/tests/component/mcp-bridge.test.ts:541` ("dispose unregisters commands and
invalidates a refresh still in flight").

**INV-P41.** A skill or downstream prompt whose reconciled spec is byte-identical (by
`JSON.stringify`) to what is already registered under its key keeps its existing command and closure;
only a changed fingerprint disposes the old registration and installs a new one.
Production: `packages/code/src/adapters/mcp-capabilities-bridge.ts:159`–`:160` (skill branch), `:185`–`:186` (downstream branch).
Test: unpinned — `packages/code/tests/component/mcp-bridge.test.ts:500` ("changed metadata for the
same skill replaces its command and closure") exercises the *changed* branch only; no test asserts the
no-op branch when a re-list's spec is unchanged.

**INV-P42.** A subscription device attempt has one visible lifetime: successful, expired,
non-terminal, failed, explicitly cancelled, and unmounted paths all clear the public code/URL picker;
closing or unmounting also asks the kernel to cancel the active attempt. A late result from an older
attempt cannot close or advance the current one because both success and failure handlers compare
the captured attempt id with `activeAttemptId` before acting.
Production: `clearDevice`, `cancelDevice`, `showDevice`, and the panel cleanup in
`packages/code/src/views/config/ProvidersPanel.tsx`. Test:
`packages/code/tests/integration/providers-key-render.test.tsx` (unmount cancellation, expired and
non-terminal outcomes, and start/poll failure cleanup).

**INV-P43.** A provider route begins the catalogue request only after the route is requested and does
not mount `ProvidersPanel` until that request and the dynamic module import have both settled.
Production: `registerProvidersCommands` in `packages/code/src/features/providers/commands.ts` and
`setup.providers` in `packages/code/src/app/commands.tsx`. Test:
`packages/code/tests/integration/app-commands.test.tsx` (catalog-backed load boundary and first-run
picker wait).

**INV-P44.** A bootstrap **Ctrl+S** retry re-enters `finishBootstrap` for the staged default model;
an already staged credential is reused, and successful retry still calls `onBootstrapComplete` and
closes the provider panel.
Production: `finishBootstrap` and the `host.onSave` handler in
`packages/code/src/views/config/ProvidersPanel.tsx`. Test:
`packages/code/tests/integration/providers-key-render.test.tsx` ("first-run save retries complete
setup with the staged credential").

**INV-P45.** A personal subscription cannot start from workspace scope, and an entitled-catalog
failure during bootstrap completes through the same manual-model `finishBootstrap` path.
Production: `subscriptionRows`, `openSubscription`, and `loadEntitled` in
`packages/code/src/views/config/ProvidersPanel.tsx`. Test:
`packages/code/tests/integration/providers-key-render.test.tsx` (workspace refusal and first-run
manual entitlement completion).

**INV-P46.** An absent settings token limit renders the host's effective default, not `unlimited`.
Production: `readEnvView` in `packages/code/src/adapters/agent-files.ts` and `DefaultsPanel` in
`packages/code/src/views/config/DefaultsPanel.tsx`. Test:
`packages/code/tests/unit/agent-files.test.ts` (`tokenDefault`) and
`packages/code/tests/integration/defaults-panel-render.test.tsx` (effective token row).

**INV-P47.** Copying a subscription's public device code or verification URL, or opening that URL in
the browser, keeps the picker open and renders progress plus success on the activated row itself. A
newer device action or a cleared attempt invalidates earlier feedback, so a late completion cannot
repaint a different login.
Production: `showDevice` and `clearDevice` in
`packages/code/src/views/config/ProvidersPanel.tsx`. Test:
`packages/code/tests/integration/providers-key-render.test.tsx` (pending and successful in-place
clipboard/browser feedback).

**INV-P48.** An Environment selection is never applied from the browser without an exact preview
and explicit confirmation, never while a run is active, and never reported active until backend
reconnection succeeds. Production: `applyPending` in
`packages/code/src/views/config/EnvironmentBrowser.tsx`. Test:
`packages/code/tests/integration/environment-browser-render.test.tsx`.

**INV-P49.** The focused Plugins browser never toggles raw settings directly. Its Environment action
passes the exact selected installation and current Environment to the guided composer; focused
Marketplace install composes installation, exact membership and reconnect as one consent action.
Production: `MarketplaceBrowser` and `marketplace.open` in
`packages/code/src/app/commands.tsx`. Test:
`packages/code/tests/integration/marketplace-browser-render.test.tsx` and
`packages/code/tests/integration/app-commands.test.tsx`.

**INV-P50.** Enter executes an exact hierarchical parent token while Tab retains child completion;
an incomplete token never executes the fuzzy top hit. Production: `acceptAc` in
`packages/code/src/views/InputDock.tsx`. Test:
`packages/code/tests/integration/app-shell-render.test.tsx` (exact parent, Tab completion, and typo
cases).

---

## 6. Failure modes and degradation

| Situation | Handling | Cite |
|---|---|---|
| No models.dev catalog when adding a provider | open the reduced picker with subscription rows and manual entry; do not pretend the subscription catalog is the public catalog | `packages/code/src/views/config/providers/list-level.tsx:58-77` |
| Subscription auth is absent or reports `authorization_available: false` | the row remains visible as unavailable; activation warns "Integration not enabled in this build" and starts nothing | `openSubscription` in `packages/code/src/views/config/ProvidersPanel.tsx` |
| A subscription row is activated in workspace scope | activation warns that subscriptions are global-only and starts no authorization attempt | `subscriptionRows` and `openSubscription` in `packages/code/src/views/config/ProvidersPanel.tsx` |
| Connected subscription has no entitled-catalog service | notify "Subscription model catalog is unavailable in this client"; do not invent a model or disconnect the account | `loadEntitled` in `packages/code/src/views/config/ProvidersPanel.tsx` |
| Entitled-catalog fetch throws | keep/create the scheme provider and offer an "Unverified entitlement — manual model" fallback | `loadEntitled` in `packages/code/src/views/config/ProvidersPanel.tsx` |
| Clipboard/browser integration is absent or returns false during device login | keep the picker open and warn/error; only the public user code or verification URL is ever handed to those callbacks | `showDevice` in `packages/code/src/views/config/ProvidersPanel.tsx` |
| Device login expires, returns another non-connected state, or polling throws | clear the public authorization picker; warn for expiry/non-completion or report the polling error; never claim connection | `showDevice` wait handlers in `packages/code/src/views/config/ProvidersPanel.tsx` |
| No catalog when adding models | fall straight through to manual model-id entry | `packages/code/src/views/config/providers/detail-level.tsx:158` |
| Catalog has no entry matching the provider | offer a "No catalog match — pick a source provider" picker whose manual row still reaches manual entry | `packages/code/src/views/config/providers/detail-level.tsx:165` |
| Model not in the catalog on L2 | the `f` verb is hidden (`when: () => fillHit() !== undefined`) and the body says so | `packages/code/src/views/config/providers/model-level.tsx:166`, `:142` |
| Save blocked by validation | `save()` returns `"validation"`, emits `validation_failed` (tone `error`), writes nothing; the panel then moves the cursor to the first issue's field | `packages/code/src/features/providers/controller.ts:560`, the `host.onSave` handler in `packages/code/src/views/config/ProvidersPanel.tsx` |
| Secret store throws mid-save | `"key-error"`, notice `key save failed for <VAR>: <text>`, remaining keys and all sources are skipped, staged value retained | `packages/code/src/features/providers/controller.ts:581` |
| Key-source write throws | `"source-error"`, notice `source save failed for <VAR>: <text>`, no reconnect | `packages/code/src/features/providers/controller.ts:595` |
| Controller disposed mid-save | returns `"ok"` silently and stops before writing secrets or emitting | `packages/code/src/features/providers/controller.ts:569`,`:575`,`:587`,`:600` |
| Bootstrap save rejects | `detachObserved`'s error arm notifies `Setup failed — <text>`; the panel stays open and **Ctrl+S** retries the staged provider/model through `finishBootstrap` | `saveBootstrap` and the save handler in `packages/code/src/views/config/ProvidersPanel.tsx` |
| Bootstrap model picker closed with no model | notify "Choose a model to finish setup" (warn); setup does not complete | `openModelPicker` in `packages/code/src/views/config/ProvidersPanel.tsx` |
| Header/body key or value rejected | the map editor's `rejectKey`/`rejectValue` returns a sentence and the entry is not staged | `packages/code/src/features/providers/request-params.ts:162`, `:177`; render-side `packages/code/tests/integration/providers-key-render.test.tsx:1192` |
| Blank API-key submission | notify "empty — key unchanged"; `commit` never runs | `packages/code/src/views/config/key-entry.ts:29` |
| Non-finite / out-of-range number | notify and keep the editor open (no `clearLayer`, no `setEditing(null)`) | `packages/code/src/views/config/field-editor.tsx:269`–`:281` |
| MCP refresh rejects | the error is stored in `listError` and rendered as a persistent banner *in place of* the empty state | `packages/code/src/views/config/McpBrowser.tsx:58`; test `packages/code/tests/integration/mcp-browser-render.test.tsx:105` |
| MCP refresh never settles | `loading` stays true and the loading hint shows, not "no MCP servers" | `packages/code/src/views/config/McpBrowser.tsx:54`; test `:84` |
| MCP `listTools`/`listPrompts` rejects | `reportListFailure` logs `mcp.list.failed` and substitutes `[]`, so one failing half does not crash the refresh | `packages/code/src/adapters/mcp-capabilities-bridge.ts:82` |
| An `mcpServers` entry fails its schema | dropped silently from the parsed list | `packages/code/src/adapters/mcp-capabilities.ts:69` |
| Uninstalling a workspace plugin | refused with a notify, no confirm | `packages/code/src/views/config/MarketplaceBrowser.tsx` (`uninstall`) |
| Environment target is invalid or degraded | preview/detail preserves the exact status and issues; no silent default is shown | `packages/code/src/views/config/EnvironmentBrowser.tsx` (`exactDelta`, `fullDetail`) |
| Environment changes while a run is active | all selection/clear verbs are hidden and the view says to finish the run first | `packages/code/src/views/config/EnvironmentBrowser.tsx` (`runActive`) |
| Preview expires or target revision changes | `select` rejects; the browser reports the conflict and leaves the current kernel active | `packages/code/src/views/config/EnvironmentBrowser.tsx` (`applyPending`); [Environment failure modes](environments.md#6-failure-modes-and-degradation) |
| Composition preview expires or definition/inventory/selection drifts | `applyComposition` rejects; the guided setup retains the draft, returns to capability review, and writes no substitute | `packages/code/src/views/config/ExtensionsHub.tsx` (`apply`); [Environment failure modes](environments.md#6-failure-modes-and-degradation) |
| Backend reconnect fails after selection | selection remains persisted; warning tells the operator to run `/reconnect`, never claims the target is active | `packages/code/src/views/config/EnvironmentBrowser.tsx` (`applyPending`) |
| A marketplace source failed to fetch | Plugins keeps successful listings and renders the failed source in All and its exact source collection; guided setup keeps exact installed inventory and reports the failed-source count | `packages/code/src/views/config/MarketplaceBrowser.tsx` (`currentSourceError`); `packages/code/src/views/config/ExtensionsHub.tsx` (`setupIntro`) |
| No marketplace listing is available | the current collection renders a dedicated empty state and points to left/right or Add Marketplace recovery | `packages/code/src/views/config/MarketplaceBrowser.tsx` (`list`) |
| Target scope's `settings.json` unparsable | `write` throws "…is invalid (…) — fix it by hand before saving" after recording `settings.save.rejected` with `reason: "unparsable"` | `packages/code/src/adapters/settings.ts:392` |
| Merged document fails the kernel schema | `write` throws `refusing to save invalid settings: <first two issues> (+N more)` | `packages/code/src/adapters/settings.ts:400`, `packages/code/src/adapters/zod-summary.ts:10` |
| CAS conflict / kernel refusal | `resyncAfterRefusedWrite` logs, re-reads settings + agents, bumps `version`, and rethrows the original error | `packages/code/src/adapters/settings.ts:372` |
| The re-read itself fails | `settings.resync.failed` is logged; the original refusal is still what the caller sees | `packages/code/src/adapters/settings.ts:382`; test `packages/code/tests/integration/settings.test.ts:174` |
| A model reference cannot be parsed | `noteUnparsedModelRef` samples a diagnostic and the caller falls back (context window → fallback; `default_model` → not known; `refs` → no match) | `packages/code/src/adapters/settings.ts:75`, used at `:231`, `:501`, `:526` |

---

## 7. Coupling

### 7.1 What forces the direction, inward

| From | To | Kind | Forcing site |
|---|---|---|---|
| `model-level.tsx` | `@clarvis/kernel/config` (`cacheModeOf`, `derivePromptCacheMode`) | runtime, static | `packages/code/src/views/config/providers/model-level.tsx:3` |
| `controller.ts` | `@clarvis/kernel/config` (`derivePromptCacheMode`) | runtime, static | `packages/code/src/features/providers/controller.ts:2` |
| `request-params.ts` | `@clarvis/kernel/policy` (`envRefPattern`, `FORBIDDEN_PROVIDER_BODY_KEYS`) | runtime, static | `packages/code/src/features/providers/request-params.ts:20` |
| `adapters/mcp-capabilities.ts` | `@clarvis/kernel/config` (`mcpServerSettingsSchema`), `@clarvis/kernel/policy` (`CONTROL_PLANE_TOOL_NAMES`) | runtime, static | `:2`, `:3` |
| `adapters/settings.ts` | `@clarvis/kernel/config` (`kernelSettingsSchema`, `mergeProviders`, `mergeSettings`, `parseModelRef`, `isWellFormedHttpUrl`, `PLANS_DEFAULTS`) | runtime, static | `packages/code/src/adapters/settings.ts:3` |
| `adapters/settings.ts` | `@clarvis/protocol` (`ConfigService`, `SettingsData`, `SettingsRepairPlan`, `SandboxInspection`) | type-only | `packages/code/src/adapters/settings.ts:13` |
| `EnvironmentBrowser.tsx` | `@clarvis/protocol` (`EnvironmentService` and Environment DTOs) | type-only | `packages/code/src/views/config/EnvironmentBrowser.tsx:1-7` |
| `adapters/models-catalog.ts` | `@clarvis/protocol` catalog DTOs + `@clarvis/kernel/config` `parseModelRef` | runtime + type | `packages/code/src/adapters/models-catalog.ts:1`, `:2` |

Every one of those is one of the six sanctioned kernel entrypoints (INV-251) — full statement owned
by [hosts/code-bootstrap.md](code-bootstrap.md) §5.

### 7.2 Internal edges

- `ProvidersPanel` → the three level modules (the level-factory imports in
  `packages/code/src/views/config/ProvidersPanel.tsx`), one-way: the level
  modules import only `context.ts` back (`packages/code/src/views/config/providers/list-level.tsx:12`, `packages/code/src/views/config/providers/detail-level.tsx:15`,
  `packages/code/src/views/config/providers/model-level.tsx:10`), and `context.ts` imports no level.
- Every config screen reaches the UI toolkit through `views/config/view-host.tsx`, which is the only
  file that names `ui/primitives/index.ts` and `ui/patterns/index.ts` for them (`packages/code/src/views/config/view-host.tsx:21`,
  `:37`). `packages/code/src/views/config/validation.ts:8` plays the same role for `features/issues.ts`.
- `ProvidersPanel` is constructed by `packages/code/src/features/providers/commands.ts:31`; that module is the seam that
  decides `bootstrap` from the effective provider count (`:38`). The panel itself never reads settings
  directly — only `ProvidersDeps.settings` through the controller and `validation()`.
- `features/providers/controller.ts` has **no** import of anything under `views/`; the view→controller
  edge is one-directional and the controller is exercised headlessly at
  `packages/code/tests/unit/providers-controller.test.ts:3`.
- `create-view-host.ts` depends on `views/confirm.ts` (`useArmedConfirm`, `:6`) and on
  `core/tasks.ts`'s `detachObserved` (`:2`); the shell that drives it is `packages/code/src/views/overlay-host.ts:154`.
- `McpBrowser` renders through `views/tools/registry.tsx`'s `renderToolPreview`
  (`packages/code/src/views/config/McpBrowser.tsx:9`) — the browser reuses the transcript's own renderers rather than a second set.
- `adapters/settings.ts` imports `adapters/mcp-capabilities.ts` for `parseMcpServers`
  (`packages/code/src/adapters/settings.ts:22`), not the reverse.
- `adapters/mcp-capabilities-bridge.ts` imports `classifyCapability`/`reconcile` and their supporting
  types from `adapters/mcp-capabilities.ts` (`packages/code/src/adapters/mcp-capabilities-bridge.ts:5`–`:13`); the
  reverse never happens, so the pure reconciler has no knowledge of the live bridge built over it.
  `McpBrowser` consumes only the bridge's `McpCapabilities.nodes`/`refresh` (`packages/code/src/app/commands.tsx`, `mcp.browse`), never
  `reconcile` directly, and `McpClientCaps` is implemented in production by
  `adapters/kernel-capabilities-client.ts:13`; `index.tsx:1217` constructs it as `capabilities`, whose
  value `AppBackend.client`'s getter re-exposes (`views/App.tsx:166`, `index.tsx:1601`–`:1603`), which
  `App.tsx:682` passes on as `mcpClient` and `app/commands.tsx:1290` finally hands to
  `createMcpCapabilities` as `client`.

### 7.3 What depends on this subsystem

- `app/commands.tsx` registers every screen here as a view command and owns their dependency wiring:
  `defaults.open`, `environments.open`, `plugins.open`, `hooks.open`, `marketplace.open`
  (`:786`), `mcp.browse` (`:1304`), `settings.open` (`:918`), `extensions.open` (`:1327`).
- `views/overlay-host.ts` depends on `ViewHostControls`' exact shape — `runSave`, `scopeBound`,
  `escape`, `dispose` (`packages/code/src/views/overlay-host.ts:176`–`:257`).
- `CapabilityProvidersPanel`, `AgentsPanel`, `RunControlsPanel`, `MemoryConfigPanel`,
  `SandboxConfigPanel`, `TasksHub`, `WorkflowsHub`, `SessionsHub`, `ThemeView`,
  `KeyboardView`, `DoctorView`, `ModelView`, `EffortView` all consume `view-host.tsx`'s toolkit; they
  belong to sibling documents ([hosts/code-domain-hubs.md](code-domain-hubs.md), [hosts/model-catalog.md](model-catalog.md),
  [execution/sandbox.md](../execution/sandbox.md), [capabilities/provider-executables.md](../capabilities/provider-executables.md)).

### 7.4 Delegated out

- **Catalog data** — `adapters/models-catalog.ts`, `catalog-pick.ts`, `CatalogPicker.tsx`,
  `pick-model.ts`, `ModelView`, `EffortView`, and `derivePromptCacheMode` / `cacheModeOf` themselves:
  [hosts/model-catalog.md](model-catalog.md).
- **Extension product experience** — guided discovery, exact composition, capability review,
  responsive detail and the focused browsers are owned by
  [code-extensions.md](code-extensions.md). Plugin install mechanics remain in
  [plugins.md](plugins.md); Environment resolution, formats, trust and snapshot identity remain in
  [environments.md](environments.md).
- **Domain hubs** — [hosts/code-domain-hubs.md](code-domain-hubs.md).
- **Key registration, layers, footer projection** — `keys/**` and `ui/patterns/**`:
  [hosts/code-keyboard.md](code-keyboard.md). `LevelSpec`, `registerLevel`, `verb`, `PANEL_VERBS`,
  `bindLevelKeys` and `createMapEditor` are cited here as consumed contracts only.

---

## 8. Open questions

1. **INV-253 is vacuously true today.** `packages/code/package.json` declares no `exports` field at
   all (lines 1–47), so the boundary test's `Object.keys(manifest.exports ?? {})` filters an empty
   object. The test would not catch a `providers` entrypoint added *together with* the package's first
   export map only if that entry were spelled differently — it does catch the literal case — but as
   written it currently asserts nothing about a manifest that has no export map. Whether the intent
   was "no provider entrypoint" or "no export map at all here" is not determinable.

2. ~~**An open, documented footer defect**, whose cause "is not determinable from the
   source".~~ **Resolved 2026-08-22, and the recorded diagnosis was wrong in an instructive way.** The
   symptom was real: the shipped Providers panel omitted `add` and `delete` from the footer even
   though both were present in Context Help and there was ample width. The cause was not
   `overlay-host.mountView`'s `LAYER.LIST` layer, which the harness comment named as "the nearest
   untested difference". It was `tierLimit`, the footer's flat cap on segment **count**
   (`packages/code/src/ui/patterns/active-actions.ts:108`-`:113`, reasoning at `:84`-`:107`). The
   panel offers nine footer candidates; a rung admits a fixed number of them and `help` reserves one
   seat, so on any terminal wide enough to print all nine the level's own verbs were still dropped —
   essentials are seated first regardless of group, so they were the ones that lost.

   The entry's most useful lesson is that the harness's own "ruled out with evidence: the footer's
   segment cap" (`packages/code/tests/integration/providers-footer-verbs.test.tsx:49`-`:67`) was a
   **false negative**. Raising the cap changed nothing in that harness because it never had enough
   candidates to reach the cap, so the experiment could not have failed. Two later attempts got the
   number wrong the same way: raising only the `>= 140` rung moved the defect into the 100-139 band
   rather than closing it, and raising the `>= 100` rung to 8 was derived against a fixture reshaped
   down to eight candidates and still dropped `delete` against the real nine. The panel's nine
   segments measure 120 columns, so from 122 up the row physically fits them all, and `delete` was
   being dropped at 132 columns with 29 to spare.

   The rungs at and above 100 are now one rung at 10, so above that width `fits` alone decides.
   `packages/code/tests/unit/band-monotonic.test.ts` holds it as a property rather than a number:
   "above 100 columns nothing is dropped for any reason but width" (`:113`) walks every width from
   100 to 200 and asserts, for each candidate the budget left out, that seating it would have
   overflowed the row — deliberately scoped to `>= 100`, because below that the low rungs are an
   editorial cap and the property does not hold. Beside it, "the Providers footer keeps add and
   delete from the width its row first fits" (`:132`) derives the boundary from the measured row
   width instead of naming one, and "a panel keeps its own verbs at full width" (`:90`) now spans
   130-200 rather than the two widths that missed the narrower band.

3. ~~**The Settings hub test name disagrees with the item list.**~~ **Resolved:** the render test is
   driven directly from `SettingsHub.ITEMS`, asserts that every declared label is present, and is
   titled "lists every settings destination ITEMS declares". It therefore follows the current nine
   rows, including Keyboard, without maintaining a second list.
   Production: `packages/code/src/views/config/SettingsHub.tsx` (`ITEMS`). Test:
   `packages/code/tests/integration/settings-hub-render.test.tsx`.

4. ~~**`ProvidersPanel.jumpToIssue` keeps a second, hand-written row table.**~~ **Resolved:** the
   duplicate is gone and the unreachable entry with it. `jumpToIssue` maps the issue's `field` onto a
   `PROVIDER_DETAIL_FIELDS` **label** and derives the row with `indexOf`
   (`jumpToIssue` in `packages/code/src/views/config/ProvidersPanel.tsx`), so INV-265's pin on the array
   now covers the jump too. The correspondence has one owner beside the array it indexes
   (`PROVIDER_ISSUE_DETAIL_FIELD`, `packages/code/src/views/config/providers/detail-level.tsx:38`-`:45`)
   and carries only the three fields `validateProviders` can actually issue
   (`packages/code/src/adapters/settings.ts:442`-`:511`) — `name`, `base_url`, `api_key_env`. `kind`
   was dead by oversight rather than reserved: it is absent, and its absence is asserted
   (`packages/code/tests/component/providers-level-contracts.test.ts:78`-`:96`). A label rather than
   an index because `api_key_env`'s row is spelled `env var` in the array, so the two vocabularies
   genuinely differ and the mapping is the thing worth owning.

5. ~~**`ProvidersController.mutate` has no `src` caller.**~~ **Resolved by removal:** `mutate` is no
   longer a member of `ProvidersController` and no longer appears in the object
   `createProvidersController` returns, so nothing outside the module can reach it. The function
   itself is alive and load-bearing as a module-private helper
   (`packages/code/src/features/providers/controller.ts:218`) with twelve internal call sites
   (`:284`, `:292`, `:302`, and nine more). `defaultModelSource`, `defaultModelResolves` and
   `effectiveDefaultModelResolves` were resolved the same way earlier and are gone from the
   controller entirely.

6. ~~**`ProvidersDeps.controller` injection has no production caller.**~~ **Resolved by removal:** the
   escape hatch is gone. `ProvidersDeps` no longer carries a `controller` field
   (`ProvidersDeps` and `ProvidersPanel` in `packages/code/src/views/config/ProvidersPanel.tsx`), and the panel always constructs its own controller — which is
   what `packages/code/src/features/providers/commands.ts` already relied on, never having passed one.

7. **`ViewHost.bindScope`'s `mode: "retarget"` has no in-scope user.** The `host.bindScope` call in
   `packages/code/src/views/config/ProvidersPanel.tsx` and
   `packages/code/src/views/config/DefaultsPanel.tsx:49` both bind `"reload"`. `"retarget"` is the default when `bindScope` is never
   called (`packages/code/src/views/config/create-view-host.ts:71`), and its dirty-preserving branch is pinned only by
   `packages/code/tests/unit/view-host-scope.test.ts:32`, which never calls `bindScope`. Which screens intend `"retarget"` is a
   question for [hosts/code-domain-hubs.md](code-domain-hubs.md).

8. ~~**Two picker paths coexist and nothing states which is canonical.**~~ **Resolved:** they are not
   two competing implementations of one feature but two purpose-built wrappers over the same
   `CatalogPicker` view, and neither can absorb the other's job.

   `FieldEditor`'s `mode === "pick"` (`packages/code/src/views/config/field-editor.tsx:328`–`:349`,
   `:551`–`:572`) is a **single-commit-then-close** abstraction: `onPick` always calls `done(id)`,
   which unconditionally `setEditing(null)`s before invoking the caller's `commit` — there is no way
   for a caller of `FieldEditor.startPick` to keep the picker open past one selection. That is exactly
   what the map editor's `[a] add` needs (`packages/code/src/ui/patterns/map-editor.tsx:511`–`:526`):
   add one key to a map, close, return to the map-editor level.

   The panel's own `picker` signal (`picker` and `openModelPicker` in `ProvidersPanel.tsx`;
   `providers/list-level.tsx:65`–`:101`; `providers/detail-level.tsx:147`) exists because two of its
   three call sites need behaviour `FieldEditor`'s wrapper cannot express: (1) `openModelPicker` passes
   `stayOpen: true` plus a live `counter`/`counterLabel` (`openModelPicker` in `ProvidersPanel.tsx`,
   `CatalogPickerSpec` and `counterExtra` in `CatalogPicker.tsx`) for a persistent multi-select
   "add/remove" picker —
   `FieldEditor`'s spec has no `stayOpen`/`counter` fields at all, and its `onPick` always closes; (2)
   `list-level.tsx`'s add-provider picker chains **directly into a second, different picker**
   (`openModelPicker`) from inside its own `onPick`, and its "browse all providers" sentinel row
   flips a local `showAll` signal without ever closing the picker in between (`:82`–`:101`) — again
   something `FieldEditor`'s always-close-after-one-pick contract cannot represent. `bindLevelKeys`
   (`packages/code/src/ui/patterns/bind-level-keys.ts:24`–`:28`) suppresses the underlying level's own
   key layer whenever *either* `editor.editing() !== null` *or* the panel's own `suspend: () => picker()
   !== null` (the `bindLevelKeys` call in `ProvidersPanel.tsx`) is true, and `LevelHost` mounts the two as independent optional
   slots at different tree positions — `editor.editing()`'s `CatalogPicker` inside the active
   `ViewFrame` (`packages/code/src/ui/patterns/level-host.tsx:47`–`:52`), the panel's `picker`-driven
   one as a sibling outside it (`:53`–`:55`) — so in practice only one is ever reachable by keyboard at
   a time even though both are optional props on the same `LevelHost`. The code never states this
   division in one place, but each half's own local reasoning (the `stayOpen`/`counter` fields; the
   chained-picker/`showAll` flow) fully accounts for why the panel could not have routed its pickers
   through `FieldEditor.startPick` instead.

9. **Why the map editor's cast to `Record<string, string>` is confined to one line** is stated as a
   safety argument in `packages/code/src/features/providers/controller.ts:421`–`:430`, but nothing enforces that the `rejectValue` is
   always supplied — a future caller of `setProviderMap` that skipped it would violate the stated
   precondition silently. No test covers that path.

10. **`INV-P4`, `INV-P18`, `INV-P19` (the `suspend` wiring), `INV-P27`'s withheld branch, `INV-P35`
    and `INV-P41` are unpinned.** Each is a rule the code clearly implements with no test that would
    fail if it were removed. `INV-P35` in particular fixes a stated defect
    (`packages/code/src/views/config/McpBrowser.tsx:71`–`:73`) whose regression nothing would catch.

11. **`headerCount()` in `McpBrowser`** (`:166`) computes the number of section-label rows by
    counting nodes named `kernel` and adding one when `nodes[1]` is not the backend. It is fed only to
    `contentRows` for list sizing. Whether it is correct for a node list with more than one
    control-plane entry — which `reconcile` cannot currently produce (`:192` always emits exactly one)
    — is untestable as written, and no test asserts the sizing.

12. **`McpEffects.activeProfile` has no reader.** It is declared on the interface
    (`packages/code/src/adapters/mcp-capabilities-bridge.ts:32`) and implemented at the one production
    construction site (`packages/code/src/app/commands.tsx`, `mcpEffects.activeProfile`), but a
    grep of `mcp-capabilities-bridge.ts` finds no call to `deps.effects.activeProfile` anywhere in
    `refreshOnce`, `syncPromptCommands` or either registered command handler, and no other module reads
    it off `mcpEffects` either. Whether it is a planned seam or a leftover from an earlier shape of the
    bridge is not settled by the source.

13. **Rationale for design choices is generally not in the code.** Where a reason *is* stated it is
    quoted and cited (the `onPromptRow` guard, the marketplace `editor` binding, the dirty-latch
    fix, `preferredScope`, the `catalogModelFor`/`fillModelFromCatalog` split, the `AUTH_HEADER`
    table, the `body` seam warning, `modelRow` vs `detailRow` at `packages/code/src/views/config/providers/context.ts:35`). For everything else
    — the code records the outcome and not the reason. Two of the named cases are now stated:
    **the three private modules** are three *levels* (list, detail, model) that are all mounted at
    once and navigated between rather than three sections of one screen, which is why a shared
    context exists at all and why `detailRow` and `modelRow` are separate signals
    (`packages/code/src/views/config/providers/context.ts:14`–`:27`). **Why `default_model` moved out
    of the provider list into `/model` remains unstated in the code**; what is observable is that it
    is a *settings-wide* value with no provider to belong to — the provider list only reports which
    provider currently owns it (`packages/code/src/views/config/providers/list-level.tsx:118`) — and
    that first-run setup is the one flow that still stages it alongside a provider
    (`packages/code/src/features/providers/controller.ts:34`).
