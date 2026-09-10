# How a host extends the engine: registration, folding and optional packages

> Implemented at `packages/loop/src/...` and `packages/capability/src/...`. Every claim below is
> anchored to a file and a named symbol or test. Open questions are collected in the final section.

## 1. Purpose

`@clarvis/loop` is extended by a host through **capabilities**, never by the host editing the
engine. A capability composes through a fixed four-level chain —
`Capability.forRun(ctx)` → `RunCapability.forAgent(scope)` → `AgentCapability.attach(bc)` →
`AgentLoopContribution` (`packages/capability/src/contract.ts`) — and the engine's own job is
to assemble the deps a host needs (`buildExecuteRunDeps`,
`packages/loop/src/runtime/build-run-deps.ts`), fold what activates for one run
(`orchestrator.ts`, `compose.ts`), and expose the whole seam through five narrow public
entrypoints so a host never has an "internal" back door into the package
(`packages/loop/package.json`).

The subsystem exists to let three coding-adjacent features — the coding toolset
(`@clarvis/tools`), skill discovery (`@clarvis/skills`) and workspace hooks (`@clarvis/hooks`) —
ship as genuinely optional Bun `optionalDependencies` of the engine
(`packages/loop/package.json`), while feature packages that sit *above* the engine (memory,
plan, workflows and tasks) register their settings and capabilities into the same
machinery from the kernel side without the engine ever importing or naming them
(delegated to [kernel-config-and-agents](../hosts/kernel-config.md)). The mechanism that keeps both directions honest is the
same: nothing on the engine's **eager** configuration path (the modules reached merely by
`import "@clarvis/loop"`) may statically load a package that a host is entitled to omit, or name a
package that sits above it. Five architecture test files exist purely to keep that mechanical
property true as the codebase changes
(`packages/loop/tests/architecture/{optional-package-boundary,optional-package-loading,
no-feature-names,no-internal-entrypoint,builtin-capability-names}.test.ts`).

## 2. Surface

### 2.1 The five public entrypoints (`packages/loop/package.json`)

| Subpath | Source file | Carries |
| --- | --- | --- |
| `.` | `src/lib.ts` | Curated main API: `executeRun`, `buildExecuteRunDeps`, `createHostModelCallAdmission`/`createHostExtensionAdmission` (the two host-gate factories, `packages/loop/src/lib.ts`, re-exporting `packages/loop/src/runtime/build-run-deps.ts`), the capability contract types, `createAskUserCapability`, providers, trace/message/error types, `VERSION`. No optional-package value import: the imports of `@clarvis/skills` and `@clarvis/skills/capability` in `packages/loop/src/lib.ts` are type-only and erased at compile time. |
| `./capabilities/tools` | `src/capabilities-tools.ts` | The opt-in tools capability, guard analyzers, and `@clarvis/tools`/`@clarvis/tools/sandbox` re-exports. The **one** entry deliberately outside the optional-free rule — choosing it opts into loading `@clarvis/tools` (`packages/loop/src/capabilities-tools.ts`). |
| `./host` | `src/host.ts` | Host-facing re-exports across the groups in §2.1a; the surface `@clarvis/kernel` builds config on top of (`packages/loop/src/host.ts`). |
| `./workflows` | `src/workflows.ts` | Exactly one export, `createElicitSerializer` — the narrow adapter `@clarvis/workflows` needs; supervision (`registerBackgroundChild` etc.) was deliberately moved out to `@clarvis/supervision` (`packages/loop/src/workflows.ts`). |
| `./testing` | `src/testing/index.ts` | Mock LLM/MCP, engine-owned real-loop test infrastructure, and `validateBody`, for integration tests (`packages/loop/src/testing/index.ts`, exports). |

`./internal` **does not exist**: no `internal.ts` file, no `exports["./internal"]` entry, and no
importer anywhere in the monorepo
(`packages/loop/tests/architecture/no-internal-entrypoint.test.ts`).

The `VERSION` on the `.` row is a module of its own and reports the Clarvis product version, not an
independent Loop release. `packages/loop/src/version.ts` statically imports the root
`../../../package.json` and exports its `version`. Static import is what makes the root-owned value
bundle-safe while preserving the same relative path from `src` and `dist`. Its only Loop consumer is
the re-export from `packages/loop/src/lib.ts`; no package outside `@clarvis/loop` reads it. The
`VERSION` suite in `packages/loop/tests/unit/version.test.ts` pins it to the root manifest and to a
plain SemVer-shaped string a consumer can put on a wire.

### 2.1a `./host`'s re-export groups (`packages/loop/src/host.ts`)

`host.ts` re-exports the symbols below as thin pass-throughs to
its owning module (no logic of its own lives in `host.ts`). No other document in this corpus
enumerates the whole surface — [loop-request-and-settings-schema](request-and-settings-schema.md) §2.3
accounts only for the ten config symbols the kernel reads through it — so it is enumerated here
rather than left thin:

| Group | Symbols | Source |
| --- | --- | --- |
| Agent frontmatter | `agentFrontmatterSchema`, `agentPromptOf`, `normalizeTools`, `splitAgentFrontmatter`, `AgentFrontmatter` | `settings/agent-frontmatter.js` (`packages/loop/src/host.ts`) |
| Marketplace manifest | `marketplaceSchema`, `pluginGitSelectorIssue`, `pluginGitUrlIssue`, `pluginNpmSourceIssue`, `Marketplace`, `MarketplaceEntry` | `settings/marketplace-schema.js` (`packages/loop/src/host.ts`) |
| Plugin-agent files | `parsePluginManifest`, `readPluginAgentFiles`, `PluginAgentFile`, `PluginAgentFilesResult` | `settings/plugin-agents.js` (`packages/loop/src/host.ts`) |
| Plugin resource limits | `PLUGIN_RESOURCE_LIMITS`, `readBoundedPluginText`, `BoundedPluginTextResult` | `settings/plugin-resources.js` (`packages/loop/src/host.ts`) |
| Plugin-manifest schema/typos | `pluginSettingsFragment`, `suspectedManifestTypos`, `unknownManifestKeys`, `PluginManifest`, `SuspectedManifestTypo` | `settings/plugin-schema.js` (`packages/loop/src/host.ts`) |
| Settings merge | `mergeProviders`, `mergeSettings`, `SettingsScope` | `settings/settings-merge.js` (`packages/loop/src/host.ts`) |
| Capability settings | `readCapabilitySettings`, `settingsSchemaFor` | `settings/capability-settings.js` (`packages/loop/src/host.ts`) |
| Settings schema | `mcpServerSettingsSchema`, `mcpServerPluginSchema`, `pluginNameField`, `pluginRefField`, `settingsSchema`, `McpServerSettings`, `SettingsFile`, plus `settingsServerToEngine` | `settings/settings-schema.js`, `settings/engine-server.js` (`packages/loop/src/host.ts`) |
| Guard/sandbox config | `defaultGuardMode`, `GuardConfig`, `ResolvedSandboxSettings`, `SandboxSettings` | `runtime/capabilities/tools-settings.js` (`packages/loop/src/host.ts`) |
| Request-schema helpers | `parseModelRef`, `resolveProvider`, `providerConfigSchema`, `grantSchema`, `BUILTIN_GRANT_NAMES`, `profileReadinessIssues`, `ReadinessIssue`, `ReadinessProfile` | `@clarvis/capability`, `validation/request-schema.js`, `validation/request/grant-registry.js`, `validation/profile-readiness.js` (`packages/loop/src/host.ts`) |
| Wire names / misc helpers | `deriveEventSpan`, `EventSpan`, `CONTROL_PLANE_TOOL_NAMES`, `SUBMIT_RESULT_TOOL_NAME`, `boundPromise`, `contentToText`, `errorText`, `isWellFormedHttpUrl`, `readJsonFile`, `ownerFromWorkspace`, `loadEnv` | various (`packages/loop/src/host.ts`) |
| Extension admission / run-deps construction | `createExtensionAdmissionController`, `ExtensionCallUnavailableError`, `ExtensionAdmissionController`, `ExtensionAdmissionOptions`, `ExtensionAdmissionSnapshot`, `MCPStatus`, `NamespacedTool`, `ToolTransport`, `buildExecuteRunDeps`, `createHostExtensionAdmission`, `createHostModelCallAdmission`, `hooksEffective`, `BuildRunDepsOptions`, `BuiltRunDeps`, `HostExtensionAdmission`, `HostModelCallAdmission`, `SkillRootInput`, `PluginBootstrapSkill` | `@clarvis/capability`, `./runtime/build-run-deps.ts`, `./runtime/capabilities/skills-settings.ts` (`packages/loop/src/host.ts`) |
| Host logging / product version | `createLogger`, `CreateLoggerOptions`, `Logger`, `VERSION` | `./logger.ts`, `./version.ts` (`packages/loop/src/host.ts`) |

One symbol in the last-but-one group is not this package's at all, and passes through a second
pass-through to get here. `ownerFromWorkspace` reaches `host.ts` from `./workspace.ts`
(`packages/loop/src/host.ts`), a module that only re-exports it
from `@clarvis/paths` (`packages/loop/src/workspace.ts`) — named there as the shared filesystem leaf
every writer of `.clarvis` sources its path helpers from (`packages/loop/src/workspace.ts`). The
engine adds nothing: the implementation is `packages/paths/src/roots.ts`, owned by
[paths-and-directory-vocabulary](../foundations/paths.md). Nothing takes it by this route. All
consumers import it straight from `@clarvis/paths` instead — `packages/kernel/src/file-kernel.ts`,
`packages/kernel/src/kernel.ts`, `packages/code/src/adapters/workspace-client-manager.ts`, and
the kernel's own re-export at `packages/kernel/src/bootstrap.ts` — so the `./host` path is a
published surface with no importer, not a seam anything depends on.

### 2.2 `buildExecuteRunDeps` (`packages/loop/src/runtime/build-run-deps.ts`)

```ts
buildExecuteRunDeps(options: BuildRunDepsOptions): Promise<BuiltRunDeps>
```

`BuildRunDepsOptions` (`packages/loop/src/runtime/build-run-deps.ts`):

| Field | Type | Purpose |
| --- | --- | --- |
| `env` | `EnvConfig` | validated environment (from `@clarvis/capability`'s `loadEnv`) |
| `environment?` | `RuntimeEnvironment` | raw env for provider credentials/MCP interpolation/child processes; defaults to `process.env` |
| `logger` | `Logger` | required; per-component sub-loggers derived from it |
| `workspaceRoot` | `string` | must be non-blank or the call throws (`packages/loop/src/runtime/build-run-deps.ts`) |
| `traceDir?` | `string` | overrides the resolved trace store's directory |
| `extraSkillRoots?` | `SkillRootInput[] \| (() => SkillRootInput[])` | array form is static; function form is re-read (and rescanned only on signature change) every call (`packages/loop/src/runtime/build-run-deps.ts`) |
| `skillRoots?` | `SkillRootInput[] \| (() => SkillRootInput[]) \| SkillRootSnapshotProvider` | exact host-resolved roots; suppresses automatic standard-root appending, including for an intentional empty array, and is mutually exclusive with `extraSkillRoots`. The snapshot-provider form materializes bodies during dependency construction, arms host monitoring before verification, filters availability through a memory-only predicate, and may atomically replace the exact catalog only on an idle host-published trust event (`SkillRootSnapshotProvider`, `snapshotSkills`, and `buildExecuteRunDeps` in `packages/loop/src/runtime/build-run-deps.ts`) |
| `skillBootstraps?` | `() => readonly PluginBootstrapSkill[]` | function-only, so a plugin enabled after deps were built still takes effect (`packages/loop/src/runtime/build-run-deps.ts`) |
| `composeSkills?` | `(discovered: SkillsProvider \| undefined) => SkillsProvider` | host composition after discovery; called once only when both skill gates are enabled. The result is shared by the registered capability and owner-facing listings. Product-specific builtin content and name policy remain with the host. |
| `resolveHooks?` | `(ctx) => readonly HookConfig[] \| undefined` | host port for workspace hooks; omitted entirely means no hook ever runs (`packages/loop/src/runtime/build-run-deps.ts`) |
| `hookCredentialNames?` | `() => readonly string[]` | forwarded to the hooks capability's env denylist |
| `resolveGuard?`, `resolveSandbox?`, `resolveSecretNames?` | host ports for the tools capability |  |
| `builtins?` | `BuiltinCapabilityToggles` | `{ tools?, skills?, hooks? }`, each defaults **on** (`packages/loop/src/runtime/build-run-deps.ts`) |
| `capabilities?` | `Capability[]` | embedder/host capabilities, registered **after** the built-ins |
| `onConnectionEvent?` | `ConnectionEventSink` | pooled-connection health transitions |
| `mcpAuthorization?` | `MCPAuthorizationOptions` | persistent browser OAuth for remote MCP transports; absent means no auth provider is constructed (`packages/loop/src/runtime/build-run-deps.ts`) |
| `modelCallAdmission?`, `extensionAdmission?` | host-shared physical gates | if supplied, `dispose()` does not close them (`packages/loop/src/runtime/build-run-deps.ts`) |

Return shape `BuiltRunDeps` (`packages/loop/src/runtime/build-run-deps.ts`): `deps: ExecuteRunDeps`, `resolved:
ResolvedTraceStore`, `skills?: SkillsProvider`, `modelCallAdmission`, `extensionAdmission`,
`dispose(): Promise<void>`.

### 2.2a `createHostModelCallAdmission` / `createHostExtensionAdmission` (`packages/loop/src/runtime/build-run-deps.ts`)

Two exported factory functions, re-exported through the curated main entrypoint (`.`,
`packages/loop/src/lib.ts`) beside `buildExecuteRunDeps` — so §2.1's "carries" list for `.` is these two
functions plus everything already named there. Each takes a narrow `Pick<EnvConfig, ...>` subset
(the model-call gate: `CLARVIS_MAX_CONCURRENT_MODEL_CALLS`, `CLARVIS_MAX_QUEUED_MODEL_CALLS`,
`CLARVIS_MODEL_ABORT_SETTLE_MS`; the extension gate: `CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS`,
`CLARVIS_MAX_CONCURRENT_EXTENSION_RUN_END_CALLS`, `CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS_PER_OPERATION`,
`CLARVIS_LOG`, `CLARVIS_LOG_LEVEL`) plus an optional `Logger`, and construct the same
`HostModelCallAdmission`/`HostExtensionAdmission` gate `buildExecuteRunDeps` builds internally when
the caller supplies none (`packages/loop/src/runtime/build-run-deps.ts`) — the point being that a host owning several
kernels can build one gate once and inject it into every `buildExecuteRunDeps` call so the ceiling is
shared rather than per-kernel.

Two integration tests exercise them directly against `buildExecuteRunDeps`
(`packages/loop/tests/integration/execute-run-entrypoints.test.ts`): a gate built by `createHostModelCallAdmission`/
`createHostExtensionAdmission` and passed in comes back unchanged (`built.modelCallAdmission ===
shared`, `built.extensionAdmission === shared`), survives the returned `dispose()` un-closed (its
`snapshot().state` stays `"open"`), and closes only via its own `.close()` — a sharper, test-pinned
version of the one-line note already in the options table above ("if supplied, `dispose()` does not
close them").

### 2.3 The three feature flags and their environment gates

Computed once per call (`packages/loop/src/runtime/build-run-deps.ts`):

```ts
const useTools = builtins?.tools !== false;
const useSkills = builtins?.skills !== false;
const useHooks = hooksEffective(builtins?.hooks, env.CLARVIS_HOOKS_ENABLED, resolveHooks);
```

| Flag | Gated by | Environment default |
| --- | --- | --- |
| `useTools` | `builtins.tools` only | n/a |
| `useSkills` | `builtins.skills`; **additionally** re-checked against `env.CLARVIS_SKILLS_ENABLED` at the dynamic-import call site (`packages/loop/src/runtime/build-run-deps.ts`) | `CLARVIS_SKILLS_ENABLED` defaults `true` (`packages/capability/src/env.ts`) |
| `useHooks` | `builtins.hooks` **and** `env.CLARVIS_HOOKS_ENABLED` **and** a supplied `resolveHooks` | `CLARVIS_HOOKS_ENABLED` defaults `true` (`packages/capability/src/env.ts`) |

`useHooks` is triple-gated; `useSkills`'s guard is checked twice (once to decide whether to log
"disabled", once at the actual `import()` call), so a caller setting `builtins.skills = true` but
`CLARVIS_SKILLS_ENABLED=false` still gets no package load (`packages/loop/src/runtime/build-run-deps.ts`).
`CLARVIS_AGENT_TOOLS_ENABLED` is a **different**, per-run gate consulted inside the tools
capability's own `forRun` (`packages/loop/src/runtime/capabilities/tools.ts`), not by
`buildExecuteRunDeps` — a capability's per-run gate is distinct from the build-time toggle that
decides whether its package is even imported.

### 2.4 `importOptional` — the one dynamic-import chokepoint (`packages/loop/src/runtime/build-run-deps.ts`)

```ts
async function importOptional<T>(pkg: string, feature: string, logger: Logger,
  load: () => Promise<T>): Promise<T>
```

Awaits `load()` (the real `import(...)` call), logs `{event:"optional_package", outcome:"loaded"|
"load_failed"}` and, on failure, throws an actionable `Error` built at this seam
(`packages/loop/src/runtime/build-run-deps.ts`) — naming both the package to install and the
`builtins.<feature>=false` opt-out, never a raw `ModuleNotFoundError`.

`optional_package` has a **third** `outcome`, `"disabled"`, emitted not by `importOptional` but by
the separate `reportBuiltinDisabled(logger, pkg, feature)` (`packages/loop/src/runtime/build-run-deps.ts`) whenever
`useSkills`/`useHooks`/`useTools` is false — one call site per built-in
(`packages/loop/src/runtime/build-run-deps.ts`). So the full outcome enum a reader must know to interpret this
event is `"loaded"|"load_failed"|"disabled"`: turning a built-in off produces its own distinct
logged outcome, not simply the absence of a log line.

Five call sites, all in this one file — a scan of `packages/loop/src` turns up no other dynamic
`import()` call, only three TSDoc `{@link import(...)}` references
(`packages/loop/src/runtime/context/tool-spill.ts`, `packages/loop/src/runtime/tools/wire-names.ts`,
`packages/loop/src/runtime/vision-prepass.ts`). Four of the five name a `@clarvis/*` package; the
fifth is a local module:

| Call | File | Guard |
| --- | --- | --- |
| `import("@clarvis/skills")` | `packages/loop/src/runtime/build-run-deps.ts` | `if (useSkills && env.CLARVIS_SKILLS_ENABLED)` |
| `import("@clarvis/hooks/capability")` | `packages/loop/src/runtime/build-run-deps.ts` | `if (useHooks)` |
| `import("@clarvis/tools")` | `packages/loop/src/runtime/build-run-deps.ts` | `if (useTools)` |
| `import("./capabilities/tools.ts")` | `packages/loop/src/runtime/build-run-deps.ts` | `if (useTools)` (local dynamic import, not a `@clarvis/*` specifier) |
| `import("@clarvis/skills/capability")` | `packages/loop/src/runtime/build-run-deps.ts` | `if (useSkills)` |

### 2.5 Capability-composition helpers

| Symbol | File | Role |
| --- | --- | --- |
| `orderCapabilities` | `packages/loop/src/runtime/capability-order.ts` | stable-sorts activated `RunCapability[]` ascending by `order` (default `0`); registration order preserved among equal orders |
| `collectCapabilityToolMetadata` | `packages/loop/src/runtime/capability-tool-metadata.ts` | folds every **registered** `Capability`'s `reservedWireNames`/`toolEffects` (last-wins on effects) regardless of whether it activates this run |
| `projected` (re-export) | `packages/loop/src/runtime/capability-event.ts` | re-exports `@clarvis/capability`'s `projected` under one stable engine-side import path |
| `BUILTIN_CAPABILITY_NAMES` | `packages/loop/src/runtime/orchestrator.ts` | `{ tools: "tools", skills: "skills", hooks: HOOKS_CAPABILITY_NAME }` — a hand-duplicated literal (see §5, INV-068) |
| `foldContributions` | `packages/capability/src/compose.ts` | merges per-agent `AgentLoopContribution[]` into tools/handlers/gates/anchor/forcedChoice/outputBudget/hooks — owned by `@clarvis/capability`, delegated to [capability-contract-and-vocabulary](../foundations/capability.md) |

`collectCapabilityToolMetadata`'s last-wins effect merge is a deliberate contrast, not an
inconsistency, with the first-match handler-dispatch order the rest of this document describes: its
own doc comment states "Effect declarations retain registration-order, last-wins behavior to match
the former inline composition in the orchestrator" (`packages/loop/src/runtime/capability-tool-metadata.ts`), i.e. a
**later**-registered capability's `toolEffects` entry for a wire name silently overwrites an
**earlier** one's (`Object.assign(toolEffects, capability.toolEffects ?? {})`,
`packages/loop/src/runtime/capability-tool-metadata.ts`) — the opposite tie-break from handler dispatch, where an
**earlier** capability's handler shadows a later one's for the same tool.

### 2.6 `runtime/capabilities/testing.ts` — contract-shaped fakes for capability unit tests

A different module from the `./testing` public entrypoint (§2.1's `src/testing/index.ts`, mock
LLM/MCP + `validateBody`): `runtime/capabilities/testing.ts` builds `fakeAgentScope` and
`fakeAgentBuildContext`, contract-shaped `AgentScope`/`AgentBuildContext` fakes wired to real but
cheap loop primitives — an in-memory trace (`createTrace()`), a disabled-compaction live context, a
1,000,000-token ledger and a 100-iteration counter, fresh convergence guards, and the engine's real
Ajv-backed `ToolArgValidator` (`packages/loop/src/runtime/capabilities/testing.ts`). `over` shallow-overrides any
field on either.

Two doc-comment rationales are load-bearing:

- `fakeArgValidator()` memoizes one shared `ToolArgValidator` module-wide rather than building it per
  call, "because each one carries its own Ajv instance and compiled-schema cache", and rather than at
  module load, "because importing this helper must not pay for one" (`packages/loop/src/runtime/capabilities/testing.ts`).
- `fakeAgentBuildContext`'s `validateArgs` is set **before** the `over` spread, because production
  always threads `argValidator.validate` onto every build context and `openCallEnvelope` *throws*
  when a handler supplies a `schema` without one — so a fake omitting it would make every
  schema-carrying tool (`ask_user`, `load_skill`) unreachable from a capability test, and
  `validateArgs?` being optional on the contract means TypeScript cannot catch the omission
  (`packages/loop/src/runtime/capabilities/testing.ts`).

At least three capability unit tests consume these builders directly (`ask-user-call.test.ts`,
`agents-capability.test.ts`, `delegation-handler.test.ts`). This module is also the concrete referent
of INV-075: `optional-package-boundary.test.ts`'s own doc comment explains that `@clarvis/skills`
"carries a hand-written copy of the engine's capability fakes instead of importing
`src/runtime/capabilities/testing.ts`" specifically because a test-only import of it would be an
undetected `devDependency` cycle that no build, install or consumer would ever see
(`packages/loop/tests/architecture/optional-package-boundary.test.ts`).

## 3. Data and formats

### 3.1 `settings-specs.ts` — the single registration point (`packages/loop/src/runtime/capabilities/settings-specs.ts`)

```ts
export const BUILTIN_SETTINGS_SPECS: readonly CapabilitySettingsSpec[] =
  [hooksSettingsSpec, agentToolsSettingsSpec, sandboxSettingsSpec, agentsSettingsSpec];

export const capabilitySettingsFields = {
  ...HOOKS_SETTINGS_FIELDS, ...AGENT_TOOLS_SETTINGS_FIELDS, ...AGENTS_SETTINGS_FIELDS,
};
export const capabilityRequestParamFields = {
  ...AGENT_TOOLS_REQUEST_PARAMS, ...AGENTS_REQUEST_PARAMS,
};
export const capabilityPluginFields = {
  ...HOOKS_PLUGIN_FIELDS, ...GUARD_PLUGIN_FIELDS, ...SKILLS_PLUGIN_FIELDS,
};
export const CAPABILITY_REQUEST_PARAM_KEYS: readonly string[] =
  requestParamKeys(BUILTIN_SETTINGS_SPECS);
```

Every one of `settings-schema.ts` (`packages/loop/src/settings/settings-schema.ts`), `settings-merge.ts`
(`packages/loop/src/settings/settings-merge.ts`), `plugin-schema.ts` (`packages/loop/src/settings/plugin-schema.ts`),
`request-schema.ts` (`packages/loop/src/validation/request/request-schema.ts`) and `capability-settings.ts`
(reads `settingsSchemaFor`/`readCapabilitySettings`, `packages/loop/src/settings/capability-settings.ts`)
compose from this one module and never touch a per-feature module directly — this is the "adding a
capability touches its own module and this one file" contract stated in the module's own doc
comment (`packages/loop/src/runtime/capabilities/settings-specs.ts`).

`settingsSchemaFor(registry?)` (`packages/loop/src/settings/capability-settings.ts`) is how a **host-registered**
spec (memory/plan/workflows/tasks — delegated to [kernel-config-and-agents](../hosts/kernel-config.md)) is admitted
into the schema **without the engine's built-in set changing**: it `.extend()`s `settingsSchema`
with one optional key per registered spec, throwing if a registered `key` collides with a built-in
block (`packages/loop/src/settings/capability-settings.ts`) or if it tries to declare any plugin-manifest surface
(`pluginContributable`/`pluginDescription`/`pluginForbiddenReason`, `packages/loop/src/settings/capability-settings.ts`)
— that surface is composed **statically** from the built-in specs alone, so a registered spec's
plugin fields would be read by nobody.

### 3.2 Settings blocks contributed by this scope's modules

| Block | Spec key | Merge | Plugin-contributable | Owner file |
| --- | --- | --- | --- | --- |
| `hooks` (array) | `hooks` | all-operator-then-all-plugin, capped `MAX_HOOKS_PER_RUN` | yes | `packages/loop/src/runtime/capabilities/hooks.ts` |
| `guard` | `guard` | last-wins | no (forbidden: "a plugin could silently disarm the workspace's own guard") | `packages/loop/src/runtime/capabilities/tools-settings.ts` |
| `sandbox` | `sandbox` | scalar last-wins, path lists union with `excluded_paths` subtracted from `extra_paths` | no | `packages/loop/src/runtime/capabilities/tools-settings.ts` |
| — (no settings block) | — | — | `bootstrapSkill` plugin field only, never `pluginContributable` | `packages/loop/src/runtime/capabilities/skills-settings.ts` |

`SKILLS_PLUGIN_FIELDS.bootstrapSkill` is deliberately **not** part of `pluginSettingsFragment` (it
never travels the `settingsScopes` path), and is not part of the plugin's executable surface — an
`inert` skills-only plugin needs no approval dialog and still gets its bootstrap skill
(`packages/loop/src/runtime/capabilities/skills-settings.ts`).

### 3.3 Registration-vs-activation identity: `Capability` vs `RunCapability`

`Capability` (registration level, `packages/capability/src/contract.ts`) carries
`seedMarker?: string`, `reservedWireNames?`, `toolEffects?`, all **collected from every registered
capability regardless of whether it activates this run**:

> "Collected from every REGISTERED capability (active or not) so a stale block in a continuation is
> stripped even when the capability is gated off on the current run." — `packages/capability/src/contract.ts`
> (`seedMarker`); the identical rationale repeats for `reservedWireNames` at `packages/capability/src/contract.ts`.

`RunCapability` (activation level, `packages/capability/src/contract.ts`) carries `order?`, `seedBlock?()`,
`systemSection?(id)`, `lifecycle?`, `forAgent(scope)`, `onRunEnd?`, `finalizeRun?`,
`guardTripCodes?`.

### 3.4 Seed marker and seed block, worked example

`packages/loop/tests/unit/entry-seed-markers.test.ts` spells a fixture marker directly
(`<cap-block>`) rather than importing a real capability's, because the rule is capability-agnostic.
Given `seedMarkers: ["<cap-block>"]`:

- A continuation-restored entry whose content starts with the marker and whose marker is **not**
  in this run's `seedBlocks` set is dropped (`packages/loop/tests/unit/entry-seed-markers.test.ts`, "still drops a
  block whose capability is no longer active").
- A continuation-restored entry whose marker **is** live is kept byte-for-byte; the freshly
  rendered block for that marker is **discarded**, not appended (`packages/loop/tests/unit/entry-seed-markers.test.ts`).
- A newly-active capability's block (marker not carried by the continuation) is appended **after**
  the restored history (`packages/loop/tests/unit/entry-seed-markers.test.ts`).

### 3.5 `run.composed` log line (`packages/loop/src/runtime/orchestrator.ts`)

```json
{
  "event": "run.composed",
  "capabilities": ["tools", "ask-user", "skills", "..."],
  "builtins": { "tools": true, "skills": true, "hooks": false },
  "tools": ["..."],
  "mcp_servers": ["..."],
  "entry_agent": "solo",
  "model": "anthropic/x",
  "mode": "lead-subagent",
  "seed_blocks": 1
}
```

`capabilities` is in **activation order** (`runCapabilities`, already sorted by
`orderCapabilities`) — dispatch order, because a capability's handlers shadow every later one's
(`packages/loop/src/runtime/orchestrator.ts`).

## 4. Behavior

### 4.1 `buildExecuteRunDeps` assembly order (`packages/loop/src/runtime/build-run-deps.ts`)

1. Reject a blank `workspaceRoot` and mutually-exclusive skill root inputs.
2. Compute per-component sub-loggers and set the paths-package logger.
3. Compute `useTools`/`useSkills`/`useHooks`.
4. Resolve the trace store.
5. If `mcpAuthorization` is present, build one OAuth coordinator; inject it into the MCP client
   factory, then build the connection manager. This stays independent of the optional
   feature-package imports: `@clarvis/mcp-client` is an ordinary engine dependency.
6. Build the retrying/logging/admission-wrapped AI SDK provider.
7. **Skills** (only if `useSkills && env.CLARVIS_SKILLS_ENABLED`): dynamically import
   `@clarvis/skills`, then build a static provider from an array, wrap a function form in
   `dynamicSkills`, or build one host-pinned provider through `snapshotSkills`. The last form
   materializes admitted bodies before any run, restricts resources to the captured allow-list, arms
   host monitoring before verification, and consults only `available(skill)` thereafter. An idle
   host-published trust event may replace the whole exact provider, but it never rescans at run
   admission. Function forms retain memoized-by-signature rescanning and last-good degradation.
   Exact `skillRoots` are used as-is; only the additional-root form receives the four standard roots
   (`SkillRootSnapshotProvider`, `snapshotSkills`, `dynamicSkills`, and `buildExecuteRunDeps` in
   `packages/loop/src/runtime/build-run-deps.ts`). An exact empty root set yields an intentional
   empty provider without a discovery warning (`emptySkillsProvider`; test `treats an exact empty
   skill-root set as an intentional empty Extension Profile` in
   `packages/loop/tests/integration/execute-run-entrypoints.test.ts`).
8. Build an empty `capabilities: Capability[]` array and a fresh `capabilityRegistry`.
9. **Hooks** (only if `useHooks`): dynamically import `@clarvis/hooks/capability`, push
   `createWorkspaceHooksCapability({...})` **first**.
10. **Tools** (only if `useTools`): dynamically import `@clarvis/tools` to install its warning
    sink (mapping tool warnings onto the host logger by level), then dynamically import
    `./capabilities/tools.ts` and push `createAgentToolsCapability({...})` **second**. When skills
    exist, the injected `resolveSkillExecutionRoots` takes a fresh cloned skill list, selects only
    entries carrying explicit `executionRoot`, de-duplicates those exact skill directories, and
    passes them to each run's toolsets (`packages/loop/src/runtime/build-run-deps.ts`).
11. Push `createAskUserCapability()` **unconditionally, third** — ask-user is the one
    built-in with **no** `builtins.*` toggle and no package-import gate at all; it is gated entirely
    downstream, at `forRun` on the entry profile's `ask_user` grant and at `forAgent` on
    `scope.entry` (non-entry/spawned agents and a scope missing `elicit`/`clock` get `null`)
    (`packages/loop/src/runtime/capabilities/ask-user.ts`).
12. **Skills capability** (only if `useSkills`): dynamically import `@clarvis/skills/capability`
    and push `createSkillsCapability(skills, {...bootstraps})` **fourth**.
13. Push every embedder-supplied `capabilities` entry **last, in caller order**.
14. Assemble `ExecuteRunDeps` and return `{ deps, resolved, skills, modelCallAdmission,
    extensionAdmission, dispose }`. Disposal settles both the connection pool and the OAuth callback
    coordinator before closing only the admission gates this call created.

So the **registration order** built-in capabilities always arrive in is: `hooks` (if enabled) →
`tools` (if enabled) → `ask-user` (always) → `skills` (if enabled) → host-supplied extras. This is
the order `foldContributions` later folds contributions in when none declares an explicit `order`
(§2.5), and it is also the order `reportRunComposition`'s `capabilities` array reflects
(§3.5) for any run whose activation does not reorder them via `RunCapability.order`.

### 4.2 Per-run activation (`packages/loop/src/runtime/orchestrator.ts`)

1. `allCapabilities = deps.capabilities ?? []` — the **full registered list**
   (`packages/loop/src/runtime/orchestrator.ts`).
2. `capabilityToolMetadata = collectCapabilityToolMetadata(allCapabilities)` — reserved names/tool
   effects computed over **registration**, not activation.
3. Concurrently, for each registered capability, call `capability.forRun(ctx)` under a bounded wall
   budget `CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS` (default `5000`ms, `packages/capability/src/env.ts`);
   a timeout or an `ExtensionCallUnavailableError` (host's extension gate saturated) both resolve to
   `null` for this run, logged, not thrown (`packages/loop/src/runtime/orchestrator.ts`).
4. Every non-null activation is wrapped by `admittedRunCapability` (`packages/loop/src/runtime/extension-admission.ts`),
   which re-routes `seedBlock`/`onRunEnd`/`finalizeRun`/every lifecycle-hook method through the
   host's `ExtensionAdmissionController`, keyed by the capability's **name** (not object identity, so
   a host that reconstructs the object every run does not bypass the per-operation ceiling —
   `packages/loop/src/runtime/extension-admission.ts`). Every wrapped call is admitted on the `"normal"` lane **except**
   `onRunEnd` (both the lifecycle-hook form, `packages/loop/src/runtime/extension-admission.ts`, and the `RunCapability`
   form) and `finalizeRun`, which are admitted on the distinct `"run_end"` lane —
   so a saturated `"normal"` gate cannot block the calls a run's teardown depends on.
5. `runCapabilities = orderCapabilities(<filtered, admitted, non-null activations>)`
   (`packages/loop/src/runtime/orchestrator.ts`); `hooks = runCapabilities.flatMap(c => c.lifecycle ?? [])`.
6. `seedBlocks` are computed by calling each **activated** capability's `seedBlock()` under the same
   setup-timeout budget, a timeout dropping the block with a warning (`packages/loop/src/runtime/orchestrator.ts`).
7. `seedMarkers = allCapabilities.map(c => c.seedMarker).filter(...)` — over the **registered**
   set, not the activated one (`packages/loop/src/runtime/orchestrator.ts`) — matching the contract's own rationale
   (§3.3).
8. `reportRunComposition` logs `run.composed` at `info` (§3.5).
9. `buildEntrySeed` (`packages/loop/src/runtime/entry-seed.ts`) consumes `seedBlocks`/`seedMarkers` to compose the
   entry agent's opening messages (§3.4).

MCP initialize instructions are necessarily composed later than those nine steps: the engine must
first open the run's MCP pool. `createMcpInstructionsRunCapability` groups the connected servers'
bounded instructions under exact server names and appends that prompt-only run capability to the
already-activated list passed to `runEntryAgent`. It contributes no tools or lifecycle hooks and is
available to the entry agent and spawned subagents; higher-priority instructions remain explicit in
the section. Production: `renderMcpInstructions` and `createMcpInstructionsRunCapability` in
`packages/loop/src/runtime/mcp-instructions.ts`, composed in
`packages/loop/src/runtime/orchestrator.ts`. Test:
`packages/loop/tests/unit/mcp-instructions.test.ts`.

### 4.3 Per-agent fold (`packages/loop/src/runtime/loop/run-agent.ts`)

1. `contributions = (input.agentCapabilities ?? []).map(c => c.attach(bc))`.
2. `folded = foldContributions(contributions)` (`@clarvis/capability`'s `packages/capability/src/compose.ts`) —
   throws on a duplicate tool wire name across contributions (`packages/capability/src/compose.ts`).
3. If any hook declares `preFinalize`, build one extra `hookGate` from
   `buildPreFinalizeGate` (`packages/loop/src/runtime/loop/run-agent.ts`).
4. `gates = [...folded.gates...(hookGate ? [hookGate] : [])]` — **capability-contributed gates
   run before the workspace-hooks preFinalize gate** (`packages/loop/src/runtime/loop/run-agent.ts`).
5. Tools/handlers assembled as `[...input.registry.tools...folded.tools...(contract ?
   [contract.tool] : [])]`, filtered by vision capability.
6. `mcpHandler` and the optional `submitHandler` are appended **after** every capability handler
    — `submit_result` must stay reachable even if a capability's dispatch chain
   refuses everything ahead of it.

### 4.4 Finalize gates and `force_tool_on_nudge`

`runGates` (`packages/loop/src/runtime/loop/loop-contract.ts`) runs the ordered `gates`
array, short-circuiting on the first non-`pass` `GateOutcome`, returning the gate's ordinal (its
only identity — `FinalizeGate` carries no name, `packages/loop/src/runtime/loop/loop-contract.ts`) alongside the outcome.

- `runGates(gates, {mode:"submit"...})` is called on a structured-submit attempt and
  `runGates(gates, {mode:"text", text})` on a text-only attempt (`packages/loop/src/runtime/loop/run-agent.ts`).
- A `"nudge"` outcome calls `noteGateNudged(gate, mode)` (`packages/loop/src/runtime/loop/run-agent.ts`), which — **if**
  `input.forceToolOnNudge === true` — sets a one-shot `forceToolNextIteration` flag, consumed once
  by `takeForcedChoice` on a later iteration (`packages/loop/src/runtime/loop/run-agent.ts`, doc comment).
- `forceToolOnNudge` is resolved as `entryProfile.orchestration?.force_tool_on_nudge ??
  deps.env.CLARVIS_DEFAULT_FORCE_TOOL_ON_NUDGE` (`packages/loop/src/runtime/entry-inputs.ts`);
  the field itself is `OrchestrationConfigInput.force_tool_on_nudge`
  (`packages/capability/src/api.ts`, whose own doc comment states the same loop-not-capability
  rationale: "a property of the agent's own loop, applied by the loop rather than by whichever
  capability raised the nudge"); the env default is `boolFromEnv(true)`
  (`packages/capability/src/env.ts`). It is a **loop-level** property applied to every gate's
  nudge, not a capability-specific one — the doc comment states this is deliberately not owned by
  "whichever capability owned the gate... because leaving it to a capability meant only one
  capability ever got it" (`packages/loop/src/runtime/loop/run-agent.ts`).
- `fastAcceptSubmit` (only when a structured `contract` is present) skips the whole gate sweep for a
  lone `submit_result` call when **every** gate's `fastAcceptOk?.() ?? true` holds
  (`packages/loop/src/runtime/loop/run-agent.ts`) — a gate that declares no `fastAcceptOk` is treated as trivially passable, so
  a capability that never implements it never blocks the fast path.

## 5. Invariants

**INV-068.** `BUILTIN_CAPABILITY_NAMES` (`packages/loop/src/runtime/orchestrator.ts`) is a
hand-duplicated literal — the orchestrator sits on the engine's eager configuration path and cannot
statically import `@clarvis/loop/capabilities/tools` or `@clarvis/skills/capability` (both
optional-package-reaching) without dragging an optional package onto that path — and it must equal,
name for name: `.tools` = `AGENT_TOOLS_CAPABILITY_NAME` (`packages/loop/src/runtime/capabilities/tools.ts`),
`.skills` = `SKILLS_CAPABILITY_NAME` (loaded dynamically from `@clarvis/skills/capability`), `.hooks`
= `HOOKS_CAPABILITY_NAME` (from `@clarvis/capability`, never optional).
Test: `packages/loop/tests/architecture/builtin-capability-names.test.ts`.

**INV-074.** The removed `@clarvis/loop/internal` entrypoint is absent from the package's export map
and its `src/internal.ts` file does not exist, and is imported from **no** package's source, test, or
script anywhere in the monorepo (scan of 100+ files).
Test: `packages/loop/tests/architecture/no-internal-entrypoint.test.ts`.

**INV-075.** No package the engine depends on (every `@clarvis/*` name in
`packages/loop/package.json`'s `dependencies` **and** `optionalDependencies`) imports `@clarvis/loop`
anywhere in its own `src/` or `tests/` trees — a scan reaching at least 5 dependency packages and
reading at least one file in each.
Test: `packages/loop/tests/architecture/optional-package-boundary.test.ts`.

**INV-076.** Importing any of the loop's non-feature entries (`lib.ts`, `host.ts`, `workflows.ts`) or
its capability settings-specs module never statically loads an optional feature package
(`@clarvis/hooks`, `@clarvis/skills`, `@clarvis/tools` — the complete `optionalDependencies` set,
`packages/loop/package.json`) — those load only through `importOptional`'s dynamic `import()`.
Test: `packages/loop/tests/architecture/optional-package-loading.test.ts`.

**INV-077.** The explicit `@clarvis/loop/capabilities/tools` subpath *does* statically load
`@clarvis/tools` — the deliberate carve-out.
Test: `packages/loop/tests/architecture/optional-package-loading.test.ts`.

**INV-078.** `@clarvis/memory`'s public capability entry (`src/capability.ts`), though it sits above
the engine, remains importable without pulling in any loop-optional package; the walk crosses into
`factory.ts` to prove the check is not vacuously shallow.
Test: `packages/loop/tests/architecture/optional-package-loading.test.ts`.

**INV-079.** The shared integration test harness (`tests/integration/_helpers.ts`) loads no optional
package by default.
Test: `packages/loop/tests/architecture/optional-package-loading.test.ts`.

**INV-080.** `runtime/build-run-deps.ts` runtime-loads `@clarvis/hooks/capability`, `@clarvis/skills`,
and `@clarvis/skills/capability` only through dynamic `import("...")` calls; its static references to
the two skills packages are explicitly `import type` and are erased — e.g.
`@clarvis/skills` itself at `packages/loop/src/runtime/build-run-deps.ts` and
`@clarvis/skills/capability`. The sibling `runtime/capabilities/skills-settings.ts` stays
off this path too: it re-exports `PluginBootstrapSkill` with `export type`, which the compiler erases,
by its own doc comment's account "the whole point of this module is that nothing on the
eager configuration path loads the optional `@clarvis/skills` package, and a value import would."
Test: `packages/loop/tests/architecture/optional-package-loading.test.ts`.

**INV-081.** The engine (`@clarvis/loop`'s `src/`, 250+ files together with `tests/`) never names
`@clarvis/memory` or its vocabulary (`MEMORY_`, `Memory[A-Z]`, "memory"/"memories") in production or
test source, outside one dedicated boundary audit (`optional-package-loading.test.ts`); English
senses ("in-memory", `process.memoryUsage`) are excluded from the match.
Test: `packages/loop/tests/architecture/no-feature-names.test.ts`.

**INV-082.** The engine declares no package dependency on `@clarvis/plan` in its manifest, and names
neither "plan(ning)" nor plan-identifier patterns (`PLAN_`, `Plan[A-Z]`) anywhere in production
`src/`.
Test: `packages/loop/tests/architecture/no-feature-names.test.ts`.

**INV-083.** `@clarvis/workflows` is exempt from the no-feature-names scan, because
`@clarvis/loop/workflows` is a sanctioned named adapter entry the engine itself publishes — the rule
targets features the engine composes invisibly, not a supported extension seam.
Test: not a separate assertion; stated in `packages/loop/tests/architecture/no-feature-names.test.ts` as the reason
`@clarvis/workflows` is out of scope.

**INV-CC-01.** (Locally derived; the number `INV-084` is already taken by
[prompt-cache-and-prefix-stability](../cross-cutting/prompt-cache.md), `specs/cross-cutting/prompt-cache.md`, for an unrelated
byte-identical-request-head rule.) `HARD_PACKAGES` and `OPTIONAL_PACKAGES` — the two package frontiers
`optional-package-loading.test.ts` walks from — are themselves **derived from the engine's own
manifest** (its `dependencies` and `optionalDependencies` blocks) rather than hand-listed, are
disjoint, and together equal the engine's complete `@clarvis/*` dependency set.
Test: `packages/loop/tests/architecture/optional-package-loading.test.ts`.

**INV-CC-02.** (Locally derived; the number `INV-085` is likewise already taken by
[prompt-cache-and-prefix-stability](../cross-cutting/prompt-cache.md), `specs/cross-cutting/prompt-cache.md`.) The `settings-specs.ts` walk that proves INV-076 is not vacuous: it actually reaches
`hooks.ts`, `tools-settings.ts` and `skills-settings.ts`, and crosses **into** `@clarvis/capability`'s
own source (more than 5 files under `capability/`) and `@clarvis/supervision`'s own source (more than
1 file under `supervision/`) rather than stopping at either package's barrel — the direct structural
analog of INV-078's non-vacuousness pin for the memory-capability walk.
Test: `packages/loop/tests/architecture/optional-package-loading.test.ts`.

**Additional invariants derived directly from the code in this scope, carrying no INV number of
their own:**

- **A capability's `seedMarker`/`reservedWireNames`/`toolEffects` are computed over every
  *registered* capability, never only the activated subset**, so a gated-off capability's tool
  names stay reserved. Its historical seed entries survive continuation in place; inactive
  registration does not authorize deleting previously sent history. Production:
  `packages/capability/src/contract.ts`;
  `packages/loop/src/runtime/orchestrator.ts`. Test:
  `packages/loop/tests/unit/entry-seed-markers.test.ts`
  (inactive capability history remains in place).
- **Skill discovery approval does not become plugin-root execution.** The tools resolver receives
  only `SkillInfo.executionRoot`; the skills registry exposes that field only for an approved root
  and sets it to the individual skill directory. Missing approval contributes no path, and a
  resolver integrity failure is not swallowed into an empty permission set. Production:
  `packages/skills/src/registry.ts`, `packages/loop/src/runtime/build-run-deps.ts`, and
  `packages/loop/src/runtime/capabilities/tools.ts`. Test:
  `packages/skills/tests/integration/api.test.ts` and
  `packages/tools/tests/integration/api.test.ts`.
- **MCP initialize instructions are prompt-only and post-connection.** A server that did not connect
  contributes nothing; a connected server's text is grouped under its exact identity and the whole
  section is bounded without splitting Unicode code points. Production:
  `packages/loop/src/runtime/mcp-instructions.ts` and
  `packages/loop/src/runtime/orchestrator.ts`. Test:
  `packages/loop/tests/unit/mcp-instructions.test.ts`.
- **Capability contributions fold in registration order, and dispatch is first-match**, so order is
  behaviour: an earlier capability's handler shadows a later one's for the same tool name.
  Production: `packages/capability/src/contract.ts` (`RunCapability.order`'s own doc:
  "Handler dispatch is first-match, so order is behaviour, not cosmetics"), `packages/capability/src/compose.ts`.
  Test: `packages/loop/tests/unit/capability-dispatch-order.test.ts` covers both halves together —
  `orderCapabilities`' ascending sort and its *stability* among equals, and `selectHandler` giving a
  call to the first matching handler rather than the most specific. The stability case matters more
  than it looks: an alphabetical tiebreaker added "for determinism" would be a plausible edit, it
  type-checks, and it silently reorders dispatch. The test's fixture is deliberately not in
  alphabetical order, so such an edit fails it.
- **A registered `CapabilitySettingsSpec` may not collide with a built-in settings key, and may not
  declare any plugin-manifest surface.** Production:
  `packages/loop/src/settings/capability-settings.ts` (throws in both cases). Test:
  `packages/loop/tests/unit/capability-settings.test.ts` pins the collision and each plugin
  field independently, including `pluginContributable: true` alone.
- **`importOptional` is the only load seam for an enabled built-in's failed optional-package load**;
  its inline error always names both the package and the `builtins.<feature>=false` opt-out.
  Production: `packages/loop/src/runtime/build-run-deps.ts`. Unpinned by a dedicated
  negative test in this document's scope (no test simulates a missing optional package).

## 6. Failure modes and degradation

| Condition | Effect | Cite |
| --- | --- | --- |
| Enabled built-in's optional package fails to `import()` | `buildExecuteRunDeps` **throws** an actionable `Error` naming the package and the opt-out | `packages/loop/src/runtime/build-run-deps.ts` |
| `workspaceRoot` blank | `buildExecuteRunDeps` throws before touching any built-in | `packages/loop/src/runtime/build-run-deps.ts`; test `packages/loop/tests/integration/execute-run-entrypoints.test.ts` |
| Both `skillRoots` and `extraSkillRoots` supplied | `buildExecuteRunDeps` throws before optional package construction | `packages/loop/src/runtime/build-run-deps.ts` |
| Exact `skillRoots` resolves to `[]` | An intentional empty provider is returned without a warning or standard-root fallback | `emptySkillsProvider`, `packages/loop/src/runtime/build-run-deps.ts`; test `packages/loop/tests/integration/execute-run-entrypoints.test.ts` |
| Skill discovery throws (initial, array roots) | Skills disabled for these deps; warned, not thrown | `packages/loop/src/runtime/build-run-deps.ts` |
| Skill discovery throws (function roots, rescan) | Falls back to last good scan, or an empty provider on first failure | `dynamicSkills`, `packages/loop/src/runtime/build-run-deps.ts`; test `packages/loop/tests/integration/execute-run-entrypoints.test.ts` |
| Root provider function throws | Treated as "no roots" for that rescan, logged at `debug` | `packages/loop/src/runtime/build-run-deps.ts` |
| Workspace path does not resolve at all | Skills come back `undefined` rather than throwing | test `packages/loop/tests/integration/execute-run-entrypoints.test.ts` |
| A capability's `forRun` exceeds `CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS` | Activation resolves `null` for this run; warned | `packages/loop/src/runtime/orchestrator.ts` |
| A capability's `forRun` throws `ExtensionCallUnavailableError` (host gate saturated) | Activation resolves `null`; warned, not thrown | `packages/loop/src/runtime/orchestrator.ts` |
| A capability's `seedBlock()` exceeds its setup budget | Block omitted from the seed; warned | `packages/loop/src/runtime/orchestrator.ts` |
| A capability's extension-admitted `seedBlock` hits a saturated host gate | The block degrades to `undefined`; logged `capability.extension_saturated` | `packages/loop/src/runtime/extension-admission.ts`; test `packages/loop/tests/unit/extension-admission.test.ts` |
| A capability's extension-admitted lifecycle method, `onRunEnd`, or `finalizeRun` hits a saturated host gate | The `ExtensionCallUnavailableError` propagates to the owning caller; this wrapper supplies no fallback | `packages/loop/src/runtime/extension-admission.ts` |
| A capability's `finalizeRun` throws or exceeds `CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS` | Its state slot is omitted from the run record; the run itself is unaffected | `packages/loop/src/runtime/execute-run.ts` |
| Two contributions declare the same tool wire name | `foldContributions` **throws** synchronously | `packages/capability/src/compose.ts` |
| More than one contribution supplies `anchor` or `forcedChoice` | `foldContributions` throws (per its own doc comment, `packages/capability/src/compose.ts`) | `packages/capability/src/compose.ts` |
| A registered `CapabilitySettingsSpec.key` collides with a built-in block | `settingsSchemaFor` throws at schema-build time | `packages/loop/src/settings/capability-settings.ts` |
| A registered spec declares plugin-manifest surface | `settingsSchemaFor` throws at registration | `packages/loop/src/settings/capability-settings.ts` |

## 7. Coupling

- **`@clarvis/loop` depends on** (hard): `@clarvis/capability`, `@clarvis/llm`, `@clarvis/mcp-client`,
  `@clarvis/paths`, `@clarvis/supervision`, `@clarvis/trace` (`packages/loop/package.json`) —
  forced by the manifest `dependencies` block and enforced acyclic by
  `optional-package-boundary.test.ts` (§5, INV-075).
- **`@clarvis/loop` optionally depends on**: `@clarvis/hooks`, `@clarvis/skills`, `@clarvis/tools`
  (`packages/loop/package.json`) — forced absent from the eager static graph by
  `optional-package-loading.test.ts` (INV-076), reachable only through `importOptional`'s dynamic
  `import()` (INV-080), with one deliberate static carve-out at the `capabilities/tools` subpath
  (INV-077).
- **Nothing the engine depends on may import the engine back** — a static, dynamic, side-effect or
  type-only edge from `@clarvis/hooks`/`@clarvis/skills`/`@clarvis/tools`/etc. into `@clarvis/loop`
  would close a cycle a warm incremental `tsc -b` would not catch; only the dedicated architecture
  test (which walks *in* from every dependency, the mirror of the walk that goes *out* from the
  engine) catches it (INV-075, `packages/loop/tests/architecture/optional-package-boundary.test.ts`).
- **The engine names no host-composed feature that sits above it** (`@clarvis/memory`,
  `@clarvis/plan`) — enforced by scanning both `src/` and `tests/` for the vocabulary and the bare
  package specifier (INV-081, INV-082). `@clarvis/workflows` is the one sanctioned exception because
  the engine itself publishes `./workflows` as a named adapter (INV-083).
- **The kernel is the actual host that registers non-built-in capabilities** (memory, plan,
  workflows and tasks) onto `settingsSchemaFor`'s registry and onto
  `BuildRunDepsOptions.capabilities` — this coupling is one-directional (kernel imports loop; loop
  never imports kernel) and is fully delegated to [kernel-config-and-agents](../hosts/kernel-config.md).
- **`foldContributions`, the `Capability`/`RunCapability`/`AgentCapability`/`AgentLoopContribution`
  types, and `FinalizeGate`/`GateOutcome` live in `@clarvis/capability`**, not in the loop — the
  engine (`orchestrator.ts`, `run-agent.ts`) only calls the fold and runs its result. This is a
  static, type- and value-level dependency in the direction `loop → capability` (never the reverse);
  deep contract semantics are delegated to [capability-contract-and-vocabulary](../foundations/capability.md).

## 8. Open questions

- **No test in this document's scope exercises `importOptional`'s thrown-error path directly**
  (e.g. by simulating a failed `import()` of `@clarvis/tools`) — its behavior is verified by direct
  reading of `packages/loop/src/runtime/build-run-deps.ts` rather than by a dedicated negative test.
- **Per-capability behavior of `tools`, `skills`, `hooks`, `ask-user`, `agents`/supervision, and
  `delegation`** is intentionally not detailed here beyond what is needed to explain the composition
  machinery — their own `RunCapability`/`AgentCapability` semantics and tool schemas belong to
  [execution/tools-contract.md](../execution/tools-contract.md), [execution/skills.md](../execution/skills.md),
  [execution/hooks.md](../execution/hooks.md), [cross-cutting/elicitation.md](../cross-cutting/elicitation.md),
  [foundations/supervision.md](../foundations/supervision.md) and
  [loop-delegation-and-subagents](delegation-and-subagents.md), and grant gating to
  [grants-and-tool-exposure](../cross-cutting/grants.md).
- **The kernel-side half of settings/capability registration** (which specs the kernel actually
  registers, in what order, and how `settingsSchemaFor`'s registry is populated at boot) is not
  covered here; it belongs to [kernel-config-and-agents](../hosts/kernel-config.md).
