# Plugin manifests, contributions, marketplaces and dialect translation

> Implemented across `packages/loop/src/settings`, `packages/kernel/src/plugins`, the kernel's
> plugin ports/adapters, and `packages/code/src/adapters`. Every claim below is anchored to a file
> and line. Open questions are collected in the final section.

## 1. Purpose

A **plugin** is a directory on disk carrying a `plugin.json` manifest, and optionally an `agents/`
tree, a `skills/` tree, a hooks document, MCP server declarations and capability-executable
declarations. This subsystem locates that directory, reads the manifest, translates whatever it
expresses in another agent host's dialect, and projects the result into two different shapes: a
`PluginView` for the operator's panel (`packages/kernel/src/plugins/plugin-service.ts:318`) and the
run-time contributions a run consumes (`packages/kernel/src/plugins/plugin-contributions.ts:45`).
Both readers go through the same resolver, and the module docstring states why:
"a manifest cannot mean one thing to the panel that asks the operator to approve it and another to
the code that loads it" (`packages/kernel/src/plugins/plugin-manifest.ts:6`).

A **marketplace** is a git repository (or a `.agents/plugins/marketplace.json` document) listing
plugins by name and source. Reading a listing grants nothing: the schema's own docstring says
"Listing a plugin still grants it nothing: it has to be installed, enabled, and approved"
(`packages/loop/src/settings/marketplace-schema.ts:528`). Installing is `git clone --depth 1` of a
validated URL into a staging directory, then an atomic `rename` into the global install root
(`packages/kernel/src/adapters/git/plugin-fetcher.ts:135`,
`packages/kernel/src/adapters/filesystem/plugin-repository.ts:196`).
The TUI includes `https://github.com/getclarvis/marketplace.git` as its product-owned catalog source
without writing it to settings (`OFFICIAL_MARKETPLACE_URL` and `DEFAULT_MARKETPLACE_URLS`,
`packages/code/src/adapters/marketplace.ts:27-31`). This changes discovery only: every plugin in that
catalog still passes through the same explicit install, enablement and hook-approval gates.

The dominant design property throughout is **per-artifact degradation**: every way a plugin document
can fail to be read resolves to a *note* attached to the plugin or listing, not to the loss of the
whole artifact. `resolveHooks`'s docstring states it as a rule — "**No hooks source can cost a plugin
anything but its hooks**" (`packages/kernel/src/plugins/plugin-manifest.ts:538`) — and
`readMarketplaceDocument`'s as its mirror — "Tolerance degrades one listing, never the collection"
(`packages/loop/src/settings/marketplace-schema.ts:464`). Two things are exempt: an unusable
`agents/` surface, and an unusable install record, both of which drop the whole plugin
(`packages/kernel/src/plugins/plugin-contributions.ts:262-271`).

Installation and activation are separate. The installed inventory retains global and workspace
copies and both filesystem conventions even when their names match. The resolved
[Extension Environment](environments.md) supplies the exact qualified `{ scope, source, name }`
installations that may contribute; `source` is `agents` for `.agents/plugins` and `clarvis` for
`.clarvis/plugins`. `builtin:default` reads the same exact object shape from `enabledPlugins`. No
name-only reader, source fallback, or workspace-over-global substitution exists. A protocol plugin
listing uses the process-pinned `active_plugins` snapshot, or the same already-exact builtin list in
a minimal embedder, so its enabled badge cannot disagree with the contributions that run
(`enabledKeys` in `packages/kernel/src/plugins/plugin-service.ts`).
A selected plugin remains an atomic contribution unit: agents, MCP servers, capability executables,
skills, and eligible hooks follow the same plugin reference, while every hook still needs its own
definition approval. Its MCP servers do not require an authored agent profile to opt in: the kernel
attaches each active plugin namespace with `auto_tools`, and the loop admits the tools successfully
discovered from it to every effective agent in that run.

## 2. Surface

### 2.1 Loop-side schemas (`@clarvis/loop/host`)

| Symbol | Kind | Definition |
|---|---|---|
| `pluginManifestSchema` | value (**not** re-exported from `host.ts`) | `packages/loop/src/settings/plugin-schema.ts:44` |
| `PluginManifest` | type | `packages/loop/src/settings/plugin-schema.ts:93` |
| `unknownManifestKeys(document): string[]` | value | `packages/loop/src/settings/plugin-schema.ts:107` |
| `suspectedManifestTypos(document): SuspectedManifestTypo[]` | value | `packages/loop/src/settings/plugin-schema.ts:136` |
| `pluginSettingsFragment(manifest): SettingsFile` | value | `packages/loop/src/settings/plugin-schema.ts:161` |
| `parsePluginManifest(raw): PluginManifestParse` | value | `packages/loop/src/settings/plugin-agents.ts:158` |
| `readPluginAgentFiles(agentsDir): PluginAgentFilesResult` | value | `packages/loop/src/settings/plugin-agents.ts:30` |
| `PLUGIN_RESOURCE_LIMITS` | frozen value | `packages/loop/src/settings/plugin-resources.ts:11` |
| `readBoundedPluginText(path, maxBytes, label)` | value | `packages/loop/src/settings/plugin-resources.ts:38` |
| `marketplaceSchema` | value | `packages/loop/src/settings/marketplace-schema.ts:530` |
| `Marketplace`, `MarketplaceEntry` | types | `packages/loop/src/settings/marketplace-schema.ts:329`, `:302` |

The `host.ts` re-export list is `packages/loop/src/host.ts:15-37`. `pluginManifestSchema` itself is
absent from it — hosts reach the schema only through `parsePluginManifest`. `@clarvis/kernel/config`
re-exports a subset again (`packages/kernel/src/config.ts:58-77`), which is how `@clarvis/code`
imports `marketplaceSchema` (`packages/code/src/adapters/marketplace.ts:10`).

### 2.2 Kernel plugin modules

| Symbol | Signature | Definition |
|---|---|---|
| `readPluginManifestSource` | `(dir) => PluginManifestSource \| { error }` | `packages/kernel/src/plugins/plugin-manifest.ts:302` |
| `resolvePluginManifest` | `(dir, raw, manifestLocation?, effectivePluginName?) => ResolvedPluginManifest` | `packages/kernel/src/plugins/plugin-manifest.ts:938` |
| `pluginSkillRoots` | `(dir, declared, manifestLocation?) => { roots, notes }` | `packages/kernel/src/plugins/plugin-manifest.ts:162` |
| `hooksDocumentSchema` | zod union | `packages/kernel/src/plugins/hook-dialects.ts:164` |
| `convertHooksDocument` | `(document, pluginRoot, options?) => { hooks, notes }` | `packages/kernel/src/plugins/hook-dialects.ts:546` |
| `readPluginInstallRecord` | `(dir) => PluginInstallRecordRead` | `packages/kernel/src/plugins/plugin-install-record.ts:18` |
| `createPluginContributions` | `({ globalDir, home?, workspaceRoot?, logger? }) => PluginContributions` | `packages/kernel/src/plugins/plugin-contributions.ts` |
| `effectivePluginMcpName` | `(plugin, server) => \`${plugin}:${server}\`` | `packages/kernel/src/plugins/plugin-contributions.ts:90` |
| `createPluginService` | `(PluginServiceOptions) => PluginService` | `packages/kernel/src/plugins/plugin-service.ts:295` |
| `validateGitUrl` | `(raw) => string` (throws) | `packages/kernel/src/plugins/plugin-service.ts:46` |

`PluginContributions` (the run-time interface, `packages/kernel/src/plugins/plugin-contributions.ts:48`)
— every contribution method takes the resolved qualified selection and never reads settings itself:

| Method | Signature | Line |
|---|---|---|
| `skillRoots` | `(selection) => SkillRootInput[]` | `:52` |
| `skillBootstraps` | `(selection) => PluginBootstrapSkill[]` | `:62` |
| `settingsScopes` | `(selection) => SettingsScope[]` | `:64` |
| `mcpServers` | `(selection) => ResolvedPluginMcpContribution[]` | `:66` |
| `agents` | `(selection) => AgentRecord[]` | `:68` |
| `readAgent` | `(selection, qualifiedName) => AgentRecord \| null` | `:70` |
| `locateCapabilityExecutable` | `(selection, capability, plugin) => { root, declaration } \| { error }` | `:72` |
| `skillPlansMode` | `(selection, plugin, skill) => CapabilitySkillPlansMode \| undefined` | `:78` |

### 2.3 Protocol / wire

`PluginService` (`packages/protocol/src/plugins.ts`) with four methods, exact `PluginRef`/
`PluginSource` identity, and the DTOs `PluginView`, `PluginContributions`,
`PluginCapabilityExecutable`, and `PluginInstallTarget`, field by field:

`PluginCapabilityExecutable` (`:11-16`, 4 fields):

| Field | Type | Meaning |
|---|---|---|
| `capability` | `string` | the capability name the executable answers |
| `command` | `string` | the resolved command (platform override already applied) |
| `args` | `string[]` | the resolved argv |
| `platform_override` | `boolean` | whether the current platform's override, rather than the base declaration, supplied `command`/`args` |

`PluginContributions` (`:19-39`, 7 fields):

| Field | Type | Meaning |
|---|---|---|
| `agents` | `string[]` | agent names the plugin contributes |
| `broken_agents` | `string[]` | agent files present but unparseable (will not load) |
| `skills` | `string[]` | skill names the panel's scan found |
| `servers` | `string[]` | namespaced MCP server names (`<plugin>:<server>`) |
| `hooks` | `number` | count of hook entries, not their names |
| `capability_executables` | `PluginCapabilityExecutable[]` | declared capability services, sorted by capability name |
| `capability_run_policies?` | `{ plans?: { skills: Record<string, "off"\|"on"\|"review"> } }` | trusted per-skill Plans policy the plugin declares, for operator display |
| `executables` | `string[]` | pre-formatted `$ ...` lines: one per hook command, MCP server and capability executable |

`PluginView` (own fields plus `contributions`):

| Field | Type | Meaning |
|---|---|---|
| `name` | `string` | host-owned install identity (the directory name) |
| `scope` | `Scope` | `"global"` or `"workspace"` |
| `source` | `PluginSource` | `"agents"` or `"clarvis"`, the owning filesystem convention |
| `dir` | `string` | absolute install directory |
| `enabled` | `boolean` | this exact scope/source/name installation is active in the process-pinned Environment |
| `version?` | `string` | manifest `version` |
| `description?` | `string` | manifest `description` |
| `display_name?` | `string` | a manifest-asked display name; display data only |
| `short_description?` | `string` | manifest's one-line summary; display data only |
| `install_source?` | `string` | recorded Git origin, including a selected subdirectory |
| `revision?` | `string` | resolved Git revision of the installed checkout |
| `error?` | `string` | present when `plugin.json` is missing/invalid (the plugin will not load) |
| `notes?` | `string[]` | what the manifest declares that this kernel does not act on |
| `contributions` | `PluginContributions` | the projected contribution summary above |

Wire methods and their read/write metadata are in
`packages/kernel/src/transport/operations.ts:289-335`:

| Method | Params | Metadata |
|---|---|---|
| `plugins.list` | `{}` | `read("plugins")` |
| `plugins.install` | `{ url, subdir, target?: { source } }` | `write("plugins")` |
| `plugins.update` | `{ ref }` | `write("plugins")` |
| `plugins.uninstall` | `{ ref }` | `write("plugins")` |

### 2.4 Ports and adapters

`PluginRepository` (6 methods) and `PluginFetcher` (2 methods) are declared at
`packages/kernel/src/ports/plugin-repository.ts:64` and `:80`, over the value shapes
`StagedPlugin`, `InstalledPlugin` (which extends it with the exact `ref` only an inventory can
answer), and `PreparedPlugin`. `inspect()` returns the *staged* shape, so a prepared root it has
never installed cannot claim a scope or filesystem convention. The two shipped
implementations are
`createFilePluginRepository` (`packages/kernel/src/adapters/filesystem/plugin-repository.ts:146`)
and `createGitPluginFetcher` (`packages/kernel/src/adapters/git/plugin-fetcher.ts:95`); both are
injectable overrides on `PluginServiceOptions` (`packages/kernel/src/plugins/plugin-service.ts:282-285`).

A third port, `ProcessRunner` (`packages/kernel/src/ports/process-runner.ts:28`, request/result
shapes at `:2`/`:18`), has exactly one implementation: `createNodeProcessRunner`
(`packages/kernel/src/adapters/process/node-process-runner.ts:62`). `createPluginService` falls back
to it when no `opts.processRunner` override is supplied
(`packages/kernel/src/plugins/plugin-service.ts:297`: `opts.processRunner ?? createNodeProcessRunner(logger)`),
and `createGitPluginFetcher` takes the same instance by injection rather than calling
`node:child_process` itself (§7.1). The adapter wraps `spawn` (`:72-76`, stdio `["ignore","pipe","pipe"]`,
argv-only — no shell) in a `Promise` that settles exactly once through a shared `finish` closure
(`:82-89`): a `close` event resolves with `{ exitCode, stdout, stderr }`, an `error` event and an
already-aborted or later-aborted `request.signal` both reject with a `cancellationError` (`:51-56`,
`:90-93`), and a `request.timeoutMs` — when given — `SIGTERM`s the child and rejects with `"<command>
timed out after <ms>ms"` (`:110-118`); the timer is `unref()`'d so a pending timeout never keeps the
host process alive. A non-zero close additionally calls `reportFailure` (`:21-40`), which logs
`local.process.failed` with the command, exit code, duration and byte *counts* of stdout/stderr —
never their content, and never `args`: the function's own doc comment states why: "a plugin fetch
carries a repository URL, and a URL can carry credentials. `stderr` is likewise absent — it is
third-party output and the field name is redacted by the diagnostic sink anyway" (`:16-19`). A clean
exit logs nothing. The runner takes `NOOP_LOGGER` as its default (`:63`), so a caller that supplies no
logger gets identical behavior with no diagnostic emitted — pinned by
`packages/kernel/tests/integration/local-observability.test.ts:33-40` ("stays usable with no logger at
all").

### 2.5 Settings keys

| Key | Schema | Line |
|---|---|---|
| `enabledPlugins` | `array({ scope, source, name }.strict()).max(256)` | `pluginRefField` and `settingsSchema` in `packages/loop/src/settings/settings-schema.ts` |
| `marketplaces` | `array(string.min(1).max(4096)).max(64)` | `packages/loop/src/settings/settings-schema.ts:274`, limits `packages/loop/src/validation/input-limits.ts:18,22` |

Both are `WORKSPACE_RISK_FIELDS` entries (`packages/kernel/src/config/workspace-trust.ts:40-41`), so
an unapproved workspace's `settings.json` contributes neither.

`enabledPlugins` is the activation input only for `builtin:default`; custom Environment files are
the complete allow-list and are not a settings overlay. Strings and partial plugin references are
invalid. `marketplaces` continues to affect discovery only.

### 2.6 `@clarvis/code` adapters and views

| Symbol | Line |
|---|---|
| `toPluginView`, `loadPlugins`, `createPluginsStore`, `PluginsStore` | `packages/code/src/adapters/plugins.ts:53, 105, 117, 93` |
| `OFFICIAL_MARKETPLACE_URL`, `MarketplaceListing`, `MarketplaceSource`, `MarketplaceAdapter`, `createMarketplaceAdapter`, `addMarketplaceSource` | `packages/code/src/adapters/marketplace.ts:28, 34, 40, 47, 252, 324` |
| `validateGitUrl`, `gitCloneAsync` (client-side duplicates) | `packages/code/src/adapters/plugin-install.ts:73, 136` |
| `MarketplaceBrowser` | `packages/code/src/views/config/MarketplaceBrowser.tsx` (`MarketplaceBrowser`) |

`toPluginView` (`packages/code/src/adapters/plugins.ts`) is a one-way, field-by-field
snake_case→camelCase rename with no identity inference: `display_name`→`displayName`,
`short_description`→`shortDescription`, `install_source`→`installSource`, and inside `contributions`,
`broken_agents`→`brokenAgents`. `capability_executables` entries are remapped one field at a time
(`platform_override`→`platformOverride`, `:74-79`). `capability_run_policies?.plans` is **not**
carried across verbatim: it is flattened from `{ skills: Record<name, mode> }` into a sorted
`skillPlanPolicies: { skill, mode }[]` array (`Object.entries(...).map(...).sort(...)`, `:81-86`),
present only when the plugin declares a Plans policy. Every other optional `PluginView` field is
copied only when defined, via a spread guard (`:60-66`).

## 3. Data and formats

### 3.1 On-disk layout

| Path | Holds | Cited at |
|---|---|---|
| `<home>/.agents/plugins/<name>/` | shared global plugin inventory; default managed-install target | `agentsPluginsDirs` in `packages/paths/src/workspace.ts` |
| `<global>/plugins/<name>/` | Clarvis-native global plugin inventory | `packages/paths/src/global.ts` |
| `<ws>/.agents/plugins/<name>/` | shared workspace plugin inventory | `agentsPluginsDirs` in `packages/paths/src/workspace.ts` |
| `<ws>/.clarvis/plugins/<name>/` | Clarvis-native workspace plugin inventory | `packages/paths/src/workspace.ts` |
| `<global>/state/plugin-data/<source>/<name>/` | persistent data for a global portable plugin instance | `packages/kernel/src/plugins/plugin-runtime.ts` |
| `<global>/state/workspaces/<segment>/plugin-data/<source>/<name>/` | persistent data for a workspace portable plugin instance | `packages/kernel/src/plugins/plugin-runtime.ts` |
| `<plugin>/plugin.json` | root manifest candidate | `packages/kernel/src/plugins/plugin-manifest.ts:29` |
| `<plugin>/.clarvis-plugin/plugin.json` | authoritative Clarvis manifest when present | `:32`, `:292-300` |
| `<plugin>/.<host>-plugin/plugin.json` | another host's candidate, matched by regex `^\.[A-Za-z0-9_-]+-plugin$` | `:44` |
| `<plugin>/.mcp.json` | first conventional MCP companion | `:102` |
| `<plugin>/mcp.json` | fallback conventional MCP companion | `:102` |
| `<plugin>/hooks/hooks.json` | conventional hooks document | `:99` |
| `<plugin>/skills/` | default skills root | `:105` |
| `<plugin>/agents/**/*.md` | agent surface | `packages/kernel/src/plugins/plugin-contributions.ts:262` |
| `<plugin>/install-record.json` | install provenance sidecar, mode `0o600` | `packages/kernel/src/plugins/plugin-install-record.ts:5`, `packages/kernel/src/adapters/filesystem/plugin-repository.ts:36-39` |
| `<root>/marketplace.json` | a source's own catalog | `packages/paths/src/constants.ts:27` |
| `<root>/.agents/plugins/marketplace.json` | cross-runtime catalog | `packages/paths/src/workspace.ts:154` |

Each inventory entry may be a physical immediate directory or a symbolic link whose current target
is a directory. `directoryNames` in
`packages/kernel/src/adapters/filesystem/plugin-repository.ts` follows only that outer inventory
link; all manifest, skill, MCP, hook, agent, and executable readers still realpath-confine their
paths to the resolved package root. A dangling link, link loop, or link to a non-directory is not an
installed plugin. A linked checkout is discovery-only: `inspectPlugin` marks it `linked`, does not
advertise its recorded install source, and never classifies the target as a managed Git checkout.
Both `PluginFetcher.update` and repository replacement reject it before any Git or filesystem
mutation. Tests: `packages/kernel/tests/integration/plugin-service.test.ts` ("discovers a plugin
linked into the shared .agents inventory" and "refuses a linked Git checkout").

### 3.2 `plugin.json` schema

`pluginManifestSchema` (`packages/loop/src/settings/plugin-schema.ts:44`) is `.loose()` (`:90`).

| Key | Shape | Line |
|---|---|---|
| `name` | `pluginNameField` — **the only required key** | `:46` |
| `version` | non-empty string, optional | `pluginManifestSchema` in `packages/loop/src/settings/plugin-schema.ts` |
| `description` | non-empty string, optional | `:55` |
| `author` | string **or** `{ name, … }.loose()`, transformed to the name | `:60`, field `:15-21` |
| `mcpServers` | `record(string, mcpServerPluginSchema)` — or a path string, resolved before validation | `:65` |
| `capabilityExecutables` | `capabilityExecutablesSchema` | `:75` |
| `capabilityRunPolicies` | `capabilityRunPoliciesSchema` | `:81` |
| `hooks` | `array(hookSchema).max(64)` (spread from `capabilityPluginFields`) | `packages/loop/src/runtime/capabilities/hooks.ts:42-49` |
| `bootstrapSkill` | `string().min(1)` | `packages/loop/src/runtime/capabilities/skills-settings.ts:39-41` |
| `guard`, `sandbox` | `z.undefined()` with an explanatory error — **forbidden** | `packages/loop/src/runtime/capabilities/tools-settings.ts:181-189` |

`pluginNameField` is `^[a-z0-9_-]+$`, non-empty, and refuses `__proto__` / `constructor` /
`prototype` (`packages/loop/src/settings/settings-schema.ts:44-55`, reserved set at `:28`). Its
error string states the reason: those "corrupt the trust map instead of storing an approval" (`:53`).

`skills` is deliberately **not** a schema key — it is read directly off the raw document by
`pluginSkillRoots` (`packages/kernel/src/plugins/plugin-manifest.ts:853`) and then excluded from the
"keys Clarvis does not act on" note (`:857`).

#### 3.2.1 Agent Plugins v1 and Codex package dialects

A root `plugin.json` whose `$schema` starts with `https://agent-plugins.org/schemas/` is a portable
Agent Plugin, not a loose native manifest. Only the canonical v1 schema
`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` is accepted; another published-version
URL fails the plugin instead of being guessed. A portable manifest must be at the package root and
is authoritative over any `.<host>-plugin/plugin.json`. Known v1 identity fields are validated,
unknown top-level fields are ignored with notes, and a non-object `extensions` value is ignored as
the v1 schema requires. Production: `claimsAgentPluginFormat`, `agentPluginManifestSchema`, and
`normalizeAgentManifest` in `packages/kernel/src/plugins/plugin-manifest.ts`. Test: the `Agent
Plugins v1 package` cases in `packages/kernel/tests/integration/plugin-manifest.test.ts`.

Portable components use the v1 fixed locations and their own failure boundaries:

- skills are immediate child directories of root `skills/`, require exact `SKILL.md`, validate the
  full portable Agent Skills frontmatter subset (identity, license, compatibility, metadata, and
  space-separated `allowed-tools`), and cannot escape the package through a symlink;
- MCP is read only from root `mcp.json` with the canonical v1 MCP schema. An invalid top-level MCP
  document disables MCP for that plugin without removing its skills; an invalid server, including
  one that exceeds a Clarvis host bound after normalization, removes only that server;
- stdio, streamable HTTP, and SSE declarations normalize to Clarvis transports. Stdio receives
  persistent `PLUGIN_ROOT` and `PLUGIN_DATA`, expands those two placeholders once in `args`, `env`,
  and `cwd`, and disables Clarvis's ordinary environment interpolation afterward. URLs and headers
  remain literal;
- `PLUGIN_DATA` is created outside the checkout, qualified by the exact plugin scope/source/name,
  before an active contribution resolves. It survives a managed update because the checkout is not
  its owner.

Production: `pluginSkillScanRoots`, `normalizeAgentMcp`, `normalizeAgentMcpServer`, and
`expandAgentPluginValue` in `packages/kernel/src/plugins/plugin-manifest.ts`;
`ensurePluginDataDir` in `packages/kernel/src/plugins/plugin-runtime.ts`; and the
`expandVariables`/`cwd` path through `@clarvis/loop` and `@clarvis/mcp-client`. Tests:
`packages/kernel/tests/integration/{plugin-manifest,plugin-contributions}.test.ts`,
`packages/kernel/tests/unit/plugin-runtime.test.ts`, and
`packages/mcp-client/tests/component/transport-builder.test.ts`.

A Codex-style package with `.codex-plugin/plugin.json`, root `.mcp.json`, `agents/`, and `skills/`
remains a supported borrowed-host dialect even when it does not claim the portable v1 root schema.
Manifest-relative paths are resolved from `.codex-plugin/` and confined to the plugin root; the
package is installable in either `.agents/plugins` or `.clarvis/plugins` inventory. Test:
`packages/kernel/tests/integration/plugin-contributions.test.ts` (the `codex-kit` fixture).

### 3.3 Resource limits

`PLUGIN_RESOURCE_LIMITS` (`packages/loop/src/settings/plugin-resources.ts:11-24`):

| Key | Value | What it bounds |
|---|---|---|
| `agentDepth` | 8 | traversal depth under `agents/` |
| `agentDirectories` | 128 | directories traversed |
| `agentEntries` | 2 048 | dirents read |
| `agentFiles` | 256 | `.md` files |
| `agentFileBytes` | 256 KiB | one agent file |
| `agentAggregateBytes` | 8 MiB | all agent files together |
| `manifestLocationEntries` | 256 | dirents scanned looking for `.<host>-plugin/` |
| `installRootEntries` | 2 048 | dirents in one install root |
| `skillDirectoryEntries` | 512 | (consumed by `@clarvis/skills`) |
| `manifestBytes` | 2 MiB | `plugin.json`, and any `mcpServers` companion |
| `hookDocumentBytes` | 2 MiB | one hooks document |
| `installRecordBytes` | 64 KiB | `install-record.json` |

The docstring notes the aggregate agent ceiling is "deliberately lower than `files * fileBytes`"
(`:8-9`). `@clarvis/code`'s marketplace reader keeps a separate but equal 2 MiB ceiling
(`packages/code/src/adapters/marketplace.ts:25`).

Two further budgets live in the kernel: `MAX_PLUGIN_SKILL_ROOTS = 4` effective roots per plugin
(`MAX_PLUGIN_SKILL_ROOTS` in `packages/kernel/src/plugins/plugin-manifest.ts`) and
`PLUGIN_SKILL_ROOT_BUDGET = MAX_SKILL_ROOTS - 8` = 24 across all enabled plugins
(`packages/kernel/src/plugins/plugin-contributions.ts:154`, `MAX_SKILL_ROOTS = 32` at
`packages/skills/src/limits.ts:2`). The docstring names the blast radius: `@clarvis/skills` refuses a
scan above its ceiling and the engine turns that refusal into an *empty* skills provider, so
overspending "does not cost the last plugin its skills, it costs the workspace all of them"
(`packages/kernel/src/plugins/plugin-contributions.ts:138-154`). The reserve is double the four
roots `clarvisSkillRoots` actually returns (`.agents` and `.clarvis`, user and workspace scope each,
`packages/skills/src/preset.ts:40-45`), so that adding a host root cannot silently narrow the plugin
budget in the same release.

An authored list may contain more than four locations. `compactSkillRoots` collapses direct-skill
siblings to their parent only when the list exhausts every real child directory and the parent has
no symlink; otherwise the authored paths remain separate. Compaction itself refuses more than
`PLUGIN_RESOURCE_LIMITS.skillDirectoryEntries` candidates. The cap therefore applies to effective
scan roots without widening the declared contribution surface.

### 3.4 `install-record.json`

Three optional string fields, `source` / `revision` / `subdir` (`INSTALL_RECORD_SCHEMA` in
`packages/kernel/src/plugins/plugin-install-record.ts`), written pretty-printed with a trailing
newline at mode `0o600` (`recordInstall` in
`packages/kernel/src/adapters/filesystem/plugin-repository.ts`).
Reading it distinguishes three outcomes: absent → `{ ok: true, record: {}, present: false }`
(an unmanaged local plugin), present-and-valid → `{ ok: true, present: true }`, present-and-invalid →
`{ ok: false, error }` (`readPluginInstallRecord`). Pinned by `bounds install metadata and exercises
repository replacement and removal failures` and the bounded-record cases in
`packages/kernel/tests/integration/plugin-install-record.test.ts`.

### 3.5 No per-hook approval state

Plugin hooks have no independent persisted approval document. A selected plugin contributes its
normalized hook definitions as part of the same atomic extension unit as its agents, skills, MCP
servers, and capability executables. The manifest and companion bytes, including hooks, participate
in the Environment content digest; a change therefore produces a different snapshot fingerprint
rather than mutating eligibility under an unchanged identity (`pluginContentDigest` in
`packages/kernel/src/environments/environment-manager.ts`; `pluginSettingsContributions` in
`packages/kernel/src/plugins/plugin-contributions.ts`).

### 3.6 `marketplace.json`

`marketplaceSchema` is `z.object({}).loose().transform(readMarketplaceDocument)`
(`packages/loop/src/settings/marketplace-schema.ts:530`), so **the only refusal is a non-object**
(pinned: `packages/code/tests/integration/marketplace-schema.test.ts:40-44`).

Root keys acted on: `name`, `description`, `displayName`, `plugins`
(`packages/loop/src/settings/marketplace-schema.ts:96-101`). Listing keys acted on: `name`, `source`,
`path`, `description`, `homepage`, `displayName`, `category` (`:85-93`).

`MarketplaceEntry` (`:302-321`) carries `name`, `source`, `path?`, `description`, `homepage?`,
`displayName?`, `category?`, `installable`, `notes`. The docstring: "A listing is a pointer, never a
grant of trust: everything on it is display data, and `installable` is the only field that gates an
action" (`:298-301`).

Defaults supplied rather than refused: `DEFAULT_MARKETPLACE_NAME = "unnamed marketplace"` (`:18`),
`DEFAULT_ENTRY_DESCRIPTION = "no description provided by this marketplace"` (`:21`). Bounds:
`MAX_LISTINGS = 1000` (`:9`), `MAX_NOTES = 40` (`:12`), `MAX_LISTED_KEYS = 20` (`:15`).

A real foreign-dialect catalog is committed at
`packages/code/tests/fixtures/marketplaces/foreign-dialect.json`; it carries root `owner` and
`metadata` blocks, per-listing `policy` / `strict` / `screenshots` / `starterPrompts` keys, an
`interface` presentation block, three source spellings (https, `{source:"local",path}`, bare
`./plugins/shipper`, `{source:"registry"}`, scp-ssh), and is asserted to lose no listing
(`packages/code/tests/integration/marketplace-schema.test.ts:223-234`).

## 4. Behavior

### 4.1 Locating a manifest — `readPluginManifestSource`

`readPluginManifestSource` implements this deterministic selection rule:

1. A readable root `plugin.json` claiming an Agent Plugins schema is authoritative. This preserves
   the portable package contract; an unsupported claimed version fails later instead of silently
   switching to a host-specific manifest.
2. Otherwise, if `.clarvis-plugin/plugin.json` is present and readable, it is authoritative because
   its author explicitly targeted Clarvis.
3. Otherwise the root `plugin.json` and every name-sorted `.<host>-plugin/plugin.json` candidate are
   read. The candidate with the greatest count of non-empty Clarvis-supported contribution keys is
   selected: `skills`, `mcpServers`, `hooks`, `bootstrapSkill`, `capabilityExecutables` and
   `capabilityRunPolicies` (`MANIFEST_CONTRIBUTION_KEYS` and `manifestContributionScore`, `:233-278`).
   Root-then-sorted-host order breaks ties, and documents are never merged (`:314-340`).

Every probe uses `readBoundedPluginText`. A missing location is ordinary; an unreadable candidate is
fatal rather than becoming a way for another document to hide it (`:287-300`, `:317-328`). With no
candidate, the error names every searched location (`:342-344`). The discovery scan is bounded at
`manifestLocationEntries`; overflow returns an error instead of a partial list (`:56-95`).

The selection contract is pinned in `packages/kernel/tests/integration/plugin-manifest.test.ts`:
portable root authority, Clarvis-specific authority, richest-compatible selection, generic root
identities not hiding contributed behavior, deterministic ties, relative paths from the selected
candidate, and non-matching dot-directories.

### 4.2 Resolving a manifest — `resolvePluginManifest`

`resolvePluginManifest` first enforces the byte/JSON/object boundary, then branches by dialect.
`normalizeAgentManifest` applies the strict portable contract described in §3.2.1. Every other
manifest follows the native/borrowed-host normalization below, in order:

| # | Step | Function | Line |
|---|---|---|---|
| 0 | byte ceiling on the raw text | inline | `:944-948` |
| 1 | `JSON.parse`; refuse a non-object | inline | `:950-958` |
| 2 | compute `PluginDirs` (root + selected manifest directory) | `pluginDirsFor` | `:961`, def `:407-413` |
| 3 | inline declared or conventional `mcpServers` | `resolveMcpServers` | `:963`, def `:763-778` |
| 4 | drop unusable `mcpServers` entries | `sanitizeMcpServers` | `:964`, def `:798-820` |
| 5 | derive the surviving server names and effective host-owned plugin identity | inline | `:965-977` |
| 6 | resolve `hooks` from exactly one source, translating MCP matchers with that identity | `resolveHooks` | `:978-983`, def `:650-687` |
| 7 | take `interface` off and read display metadata | `resolvePresentation` | `:984-985`, def `:840-864` |
| 8 | supply `name` from the directory, `description` from the short description | `supplyDefaults` | `:986`, def `:898-922` |
| 9 | note suspected misspellings | `suspectedManifestTypos` | `:989-992` |
| 10 | note the `skills` declaration's own problems | `pluginSkillRoots(...).notes` | `:994` |
| 11 | note remaining unknown keys, excluding `skills` and the misspelled ones | `unknownManifestKeys` | `:996-1002` |
| 12 | validate the rewritten document | `parsePluginManifest` | `:1004-1018` |

Note ordering is a stated contract: "Suspected misspellings come first. They are the only entries
that describe a mistake rather than a difference" (`:385-387`); pinned at
`packages/kernel/tests/integration/plugin-manifest.test.ts:128-134`, which asserts `notes[0]` is the "did you mean" line and that the
misspelled key does **not** also appear in the foreign-key list.

Steps 3–8 mutate the parsed document **in place** before step 12 validates it. That is what keeps
`PluginManifest["hooks"]` a plain array whatever dialect it arrived in
(`packages/kernel/src/plugins/hook-dialects.ts:21-24`). Resolving MCP before hooks is also
load-bearing: it lets a translated hook target the exact `<plugin>:<server>.<tool>` identity that
the runtime dispatches, using the install identity supplied by the host rather than display data.

### 4.3 Path confinement — `companionPath` / `pluginDirs`

`companionPath` (`packages/kernel/src/plugins/plugin-manifest.ts:366-375`) resolves a declared path
against `dirs.base` first — but only if the result both stays inside `dirs.root` **and already
exists** (`:370-373`) — otherwise against `dirs.root`. `confined` compares the *resolved* path
against `root` or `root + sep` (`:367-374`), so `a/../../b` is refused on the same rule as `../b` and
an absolute path never escapes the root.

`pluginDirsFor` (`:407-413`) sets `base` to the manifest's own directory, but falls back to `root`
if that directory is itself outside the root.

Confinement is **lexical**, and the docstring says so: "A symlink *inside* the plugin that points
outside it is still followed, which is the same open parent-directory weakness recorded for
workspace-confined writes" (`:361-364`).

Pinned: `packages/kernel/tests/integration/plugin-manifest.test.ts:954-1016` (four refusal cases + one accepted nested case),
`:1051-1063` (a `.alpha-plugin` manifest's `../skills/` resolves to the plugin's `skills/` with **no**
"outside the plugin" note), `:1081-1085` (`../../elsewhere` is still refused from either base).

### 4.4 `skills` → skill roots — `pluginSkillRoots` / `pluginSkillScanRoots`

`pluginSkillRoots` and `compactSkillRoots` in
`packages/kernel/src/plugins/plugin-manifest.ts`.

| Declared value | Result | Evidence |
|---|---|---|
| absent | `[<dir>/skills]`, no notes | fallback branch in `pluginSkillRoots` |
| a string | treated as a one-element list | declaration normalization in `pluginSkillRoots` |
| neither string nor array | fallback + "not a path or a list of paths" | invalid-declaration branch |
| a non-string / blank element | skipped + "is not a path" | element validation loop |
| ends in `.md` (case-insensitive) | skipped + "names a file" | file-declaration branch |
| escapes the plugin | skipped + "resolves outside the plugin" | `companionPath` result branch |
| duplicate of an earlier root | silently de-duplicated | resolved-root insertion branch |
| a location directly contains `SKILL.md` | accepted as one individual skill root | `pluginSkillRoots` + `listSkillDirs` |
| exhaustive direct-skill siblings | compacted to their parent only when no undeclared directory or symlink can become visible | `compactSkillRoots` |
| more than 4 effective roots survive | truncated to 4 + "only the first 4 of N" | `pluginSkillRoots` after compaction |
| nothing survived | fallback + "nothing declared could be scanned" | final fallback branch |

The scalar, invalid, confinement, duplicate, fallback and cap rows are pinned by their named cases
under "foreign manifest fields" in
`packages/kernel/tests/integration/plugin-manifest.test.ts`. Exact compaction is pinned by
"compacts exhaustive direct-skill siblings before applying the root budget"; refusal to widen is
pinned by "does not compact a group when that would admit an undeclared sibling". End-to-end plugin
presentation is pinned by `packages/kernel/tests/integration/plugin-service.test.ts`, case "list:
serves every direct skill from an exhaustive grouped declaration". The default and a usable custom
location produce no note.

For `format: "agent-plugin-v1"`, `pluginSkillScanRoots` keeps the resolved fixed root but attaches
`discovery: "immediate"`, `manifestName: "exact"`, `validation: "agent-skills"`, and the package
confinement root. Native and borrowed-host manifests retain the flexible behavior in the table.

### 4.5 `mcpServers` — path inlining and per-entry sanitizing

`resolveMcpServers` (`packages/kernel/src/plugins/plugin-manifest.ts:763-778`) accepts an inline map
unchanged, inlines the document named by a string declaration, or — when the key is absent — probes
`.mcp.json` and then `mcp.json`. A missing conventional file moves to the next name; a malformed one
adds a note and still moves to the next (`:715-778`). Any selected companion is resolved beside the
manifest first and then at the plugin root, read under `manifestBytes`, required to contain an
`mcpServers` object and re-serialized with the manifest before it is accepted (`:728-760`). This
prevents a small companion from making the final manifest exceed its resource ceiling.

Declared paths and conventional discovery are pinned at
`packages/kernel/tests/integration/plugin-manifest.test.ts:260-360`; the combined-layout regression
at `:362-404` proves skills, conventional MCP servers and translated hooks survive together.

`sanitizeMcpServers` (`packages/kernel/src/plugins/plugin-manifest.ts:798-820`) then validates each
entry against `mcpServerPluginSchema` individually, keeps the ones that pass, notes each one that
does not, and deletes the key entirely if nothing survives (`:802-820`). Its docstring names the
blast radius it exists to bound: the schema "reports that per *record*, so one such entry used to
fail the whole manifest and take the plugin's agents, hooks and skills with it" (`:786-796`). Pinned:
`packages/kernel/tests/integration/plugin-manifest.test.ts:550-578`.

`mcpServerPluginSchema` is the **tolerant** twin of `mcpServerSettingsSchema` — same base fields and
same `refineMcpServer`, but without `.strict()`
(`packages/loop/src/settings/settings-schema.ts:197` vs `:221`). Its docstring records the measured
cost of strictness: "Measured on a public catalog of 196 plugins, that single rule broke 24 of them
and cost 82 skills that had nothing to do with MCP" (`:212-214`). That the two schemas genuinely
differ is pinned at `packages/kernel/tests/integration/plugin-manifest.test.ts:473-478`. Unknown keys are dropped, not carried
(`packages/loop/src/settings/settings-schema.ts:216-219`).

### 4.6 `hooks` — source selection and translation

`resolveHooks` (`packages/kernel/src/plugins/plugin-manifest.ts:650-687`) runs `harvestDeclared`
first, then `harvestConvention` only if the first yielded **zero** hooks.

| `document.hooks` | Read as | Line |
|---|---|---|
| non-empty array of all strings | a list of files to read and concatenate | `:579-588` |
| any other array | Clarvis's own hook array, left for the schema | `:590` |
| a string | one named file | `:593` |
| an object | an inline event map | `:595-597` |
| anything else | nothing | `:598` |

State table for source selection:

| `harvestDeclared` result | Convention file present? | Outcome | Note emitted | Line |
|---|---|---|---|---|
| ≥1 hook | yes, and not the file the manifest named | manifest wins | "`hooks/hooks.json` not read — the manifest declares its own hooks, which take precedence" | `:661-672` |
| ≥1 hook | yes, and *is* the file the manifest named | manifest wins | none | `:663-665` via `isConventionPath` |
| ≥1 hook | no | manifest wins | none | `:661-672` |
| 0 hooks, key present | yields ≥1 | convention wins | "the manifest declares none, so `hooks/hooks.json` was read instead" | `:675-682` |
| 0 hooks, key absent | yields ≥1 | convention wins | none | `:675-682` |
| 0 hooks | 0 hooks | key deleted | any harvest notes | `:685-686` |

The "empty declaration falls through" rule is stated with its trigger: "a real plugin was found
carrying exactly that (`"hooks": {}`) while its commands lived in the convention file" (`:644-648`).
Pinned for both `{}` and `[]` at `packages/kernel/tests/integration/plugin-manifest.test.ts:821-860`.

The convention file is looked for **beside the manifest first** when the manifest lives in a
dot-directory (`conventionHooksPath`, `:428-435`), pinned at
`packages/kernel/tests/integration/plugin-manifest.test.ts:1261-1275`. A read, parse or conversion
failure in either source returns only empty hooks plus notes, so the rest of the plugin remains
loadable (`harvestFile` / `harvestDocument`, `:484-551`).

#### 4.6.1 `convertHooksDocument`

`packages/kernel/src/plugins/hook-dialects.ts:546-622`. Per event key:

1. Normalize the event name (strip non-alphanumerics, lowercase — `:66-68`) and look it up in
   `EVENTS_BY_NORMALIZED_NAME` (`:71-76`), which is the **inversion** of
   `EXTERNAL_HOOK_EVENT_NAMES` (`:52-54`). An unmapped name yields a note and no hooks (`:554-559`).
   The round trip over every entry of the table is pinned at
   `packages/kernel/tests/integration/plugin-manifest.test.ts:1078-1092`.
2. If the target event is in `OBSERVER_HOOK_EVENTS` and any group carries commands, note that the
   commands run but "a verdict of theirs cannot block anything" (`:560-572`).
3. Per group: if the event is `pre_tool_use`/`post_tool_use` (`TOOL_SCOPED`, `:110`), translate the
   matcher; otherwise no filter, plus a note if a matcher was written anyway (`:573-600`).
4. Per entry: skip a `type` other than `"command"`; note an `async: true` request; convert `timeout`
   seconds → ms, clamped to `MAX_HOOK_TIMEOUT_MS` (`translateTimeout`); substitute plugin-root
   placeholders, then anchor a leading `./` or `.\` executable to the plugin install root
   (`substituteRoot` / `resolveRelativeCommand`).

`UserPromptExpansion` maps exactly to `user_prompt_expansion`, and the external tool name `Skill`
maps exactly to `load_skill`; the regression is
`packages/kernel/tests/integration/plugin-manifest.test.ts:1004-1019`.

`translateTimeout`'s docstring records the failure it fixes: an unbounded converted value produced a
hook the manifest schema refused, and "because the whole `hooks` array is validated together that
refusal **took the entire plugin down**" (`:87-90`). Pinned at `packages/kernel/tests/integration/plugin-manifest.test.ts:897-932`,
where the second test asserts every surviving hook satisfies `hookSchema`.

#### 4.6.2 Matcher translation

`translateMatcher` (`packages/kernel/src/plugins/hook-dialects.ts:495-521`) strips `^`/`$` from the
**whole** matcher first, then tests the catch-all (`:499-500`). A catch-all alternative still refuses
the group because keeping it would widen the filter (`:485-493`, `:507`). An inexpressible or
counterpart-free alternative is dropped when another exact alternative survives; only a matcher
with no survivors is refused (`:503-520`). Pinned at
`packages/kernel/tests/integration/plugin-manifest.test.ts:734-749`, `:764-790`.

`translateToolName` (`:405-458`), in order:

| Input shape | Result | Line |
|---|---|---|
| `mcp__<server>__<tool>` (plain halves) | `<server>.<tool>`, or `<plugin>:<server>.<tool>` when this plugin owns the server | `:420-435` |
| `mcp__.*` or `mcp__*` | `*.*` | `:409-411` |
| `mcp__<server>__.*` | dotted server wildcard, qualified when plugin-owned | `:420-435` |
| `mcp__plugin_.*<server>.*` | force-qualified `<plugin>:<server>.*` | `:412-418` |
| `mcp__<server-prefix>.*` | `<server-prefix>*`, qualified when it identifies a plugin-owned server | `:438-445` |
| any other `mcp__…` | `inexpressible` | `:446` |
| plain `^[A-Za-z0-9_-]+$` in `EXTERNAL_TOOLS_WITHOUT_COUNTERPART` | `no_counterpart` | `:449-452` |
| plain name | `EXTERNAL_TOOL_NAMES[normalized] ?? part` | `:449-452` |
| `<a>.<b>` (already namespaced) | passes through | `:455` |
| anything else | `inexpressible` | `:457` |

The alias table applies **only** to a name carrying no pattern syntax; the docstring explains that
`normalizeToolName` strips every non-alphanumeric character, so without the restriction `Edit.*`
would normalize to `edit` and "silently become the single exact name `edit_file`" (`:391-403`).
Plugin-owned namespace behavior, including the host-owned install identity, is pinned at
`packages/kernel/tests/integration/plugin-manifest.test.ts:692-732`.

Group-level outcomes (`:575-595`):

| Reading | Effect |
|---|---|
| `refused: "inexpressible"` | group skipped, "skipped rather than guessed at" |
| `refused: "no_counterpart"` | group skipped, "skipped rather than widened to every call" |
| `match: null` | hook emitted with no `match` |
| `dropped: [...]` non-empty | hook emitted with the surviving names, plus a note naming the dropped ones |

The rationale is in the docstring: keeping the hook without its filter "would *widen* what it fires
on, which on a gate event turns a narrow rule into one that judges every call" (`:479-483`).

Deliberately **not** accepted: the `<server>.*` glob form, because in a regex dialect `Edit.*` is far
likelier a prefix match than a namespaced glob (`:322-330`).

#### 4.6.3 `${…}` plugin-root substitution — `substituteRoot`

`packages/kernel/src/plugins/hook-dialects.ts:259-308`. A plugin root is any variable name matching `^[A-Za-z0-9_]*PLUGIN_ROOT$`
(`:181`); the bare form uses a negative lookahead so `$PLUGIN_ROOTS` and `$MY_PLUGIN_ROOT_DIR` are
left alone (`:191`, pinned `packages/kernel/tests/integration/plugin-manifest.test.ts:537-541`).

| Written | Substituted | Line |
|---|---|---|
| `$NAME` (bare, suffix-matched) | plugin root | `:271-274` |
| `${NAME}` | plugin root | `:298` |
| `${NAME:-…}`, `${NAME-…}`, `${NAME:=…}`, `${NAME=…}`, `${NAME:?…}`, `${NAME?…}` | plugin root (all six collapse — the root is always set) | `:202`, `:298`, docstring `:196-201` |
| `${NAME:+word}`, `${NAME+word}` | `word`, itself recursively substituted | `:205`, `:300-301` |
| `${NAME#…}`, `${NAME%…}`, `${NAME/…}` | left exactly as written | `:302-303` |
| `${OTHER:-${PLUGIN_ROOT}}` | descends into the default | `:296-297` |
| `${unbalanced/go` | left as written | `:282-286` |

The default-expansion case has a measured trigger in the docstring: "the one plugin that wrote it
that way was a security guard whose own unset-root branch fails **open** — so the placeholder this
function missed was the difference between a gate and nothing at all" (`:242-247`). All eleven
spellings are pinned at `packages/kernel/tests/integration/plugin-manifest.test.ts:505-548`.

Substitution happens at translation time, not by exporting a variable, "so the operator reviewing the
definition reads the real path, and so the resolved path is part of that hook's fingerprint"
(`:255-257`).

A translated external command whose leading executable is explicitly relative (`./hooks/check` or
`.\hooks\check.cmd`) is resolved against the plugin install root and quoted before it enters the
ordinary Clarvis hook array (`packages/kernel/src/plugins/hook-dialects.ts:611-616,632-649`). Hook
execution still keeps the workspace as its working directory (`packages/hooks/src/runner.ts:294-301`),
so anchoring the plugin's own executable does not move project-relative behavior into the plugin
checkout. A path that would leave the install root is not rewritten. Native Clarvis hook arrays
bypass the dialect converter and remain byte-for-byte as declared. Pinned at
`packages/kernel/tests/integration/plugin-manifest.test.ts:880-904,1291-1310`.

### 4.7 Presentation and supplied defaults

`resolvePresentation` (`:721-745`) consumes the `interface` key (`delete` at `:727`) so it stops
being reported as unacted-on, reads `displayName` and `shortDescription` after trimming, and notes a
block that is not an object or that carries neither field. Everything else in the block (icons,
colours) is dropped silently — "it is not a directive" (`:717-719`). Pinned at
`packages/kernel/tests/integration/plugin-manifest.test.ts:294-345`.

`supplyDefaults` (`:779-803`) fills `name` from `basename(dir)` — but only if that basename would
itself validate, checked by round-tripping it through `parsePluginManifest` (`derivableName`,
`:757-760`) — and `description` from the presentation block's `shortDescription`. Both emit a note.
Nothing else is supplied: "A description is only ever *moved*, never invented" (`:773-776`). Pinned
at `packages/kernel/tests/integration/plugin-manifest.test.ts:347-390`, including the case where the directory could never be a legal
name (`.staging-1`) and the schema error stands.

### 4.8 Loading a plugin for a run — `loadableOf`

`loadableOf` in `packages/kernel/src/plugins/plugin-contributions.ts`, in order, each failure logging
`kernel.plugin.skipped` with a `phase` and returning `undefined`:

| # | Step | `phase` | Line |
|---|---|---|---|
| 1 | find the exact scope/source/name directory | `dir` | `dirFor` |
| 2 | read the manifest source | `manifest` | `:246-249` |
| 3 | create the persistent source-qualified runtime-data directory | — | `ensurePluginDataDir` |
| 4 | resolve the manifest with that runtime directory | `manifest` | `resolvePluginManifest` |
| 5 | read the whole `agents/` surface | `agents` | `readPluginAgentFiles` |
| 6 | read the install record | `install_record` | `readPluginInstallRecord` |

`dirFor` selects the root named by the qualified reference exactly
(`packages/kernel/src/plugins/plugin-contributions.ts`). An Environment asking for
`global/agents/browser` therefore cannot execute `global/clarvis/browser` or either workspace
installation. The same rule applies to `builtin:default`; there is no name-only selection path.

The log line's message states the consequence: "an enabled plugin contributes nothing this run; its
agents, hooks, MCP servers and skills are all absent" (`:178`). The docstring records what it
replaced: "a manifest that did not parse, an agents tree over its limit and an absent install were
all the same silent `undefined`" (`:165-168`). Five skip cases plus one silence case are pinned at
`packages/kernel/tests/integration/plugin-contributions.test.ts:257-318`.

`loadables()` de-duplicates repeated qualified references. Definition validation rejects a custom
Environment that would activate two same-named installations because downstream agent/MCP/skill
namespaces remain plugin-name based.

#### 4.8.1 Per-contribution behaviour

- **`skillRoots`** (`:310-353`) filters declared roots to those that `statSync` says are directories,
  reports a plugin with none, then spends the shared 24-root budget, truncating and reporting when a
  plugin does not fit. `installScope: "workspace"` maps to skills-scope `"workspace"`, `"global"` to
  `"user"` (`:349`); `source` is `plugin:<name>` (`:350`). Pinned:
  `packages/kernel/tests/integration/plugin-contributions.test.ts:55-68`, and end-to-end through the kernel at
  `packages/kernel/tests/integration/plugin-skills-install.test.ts:92-101`, which asserts that every
  contributed skill retains global scope and `plugin:<install-name>` provenance.
- **`skillBootstraps`** (`:355-361`) does **not** check that the roots exist; the interface docstring
  says a plugin with no skills root contributes no skills either, so the name cannot resolve and the
  loop reports the miss (`:52-55`).
- **`settingsScopes`** builds `pluginSettingsFragment(manifest)`, replaces `mcpServers` with the
  `<plugin>:<server>`-namespaced map, and carries every normalized hook definition of that selected
  plugin. No second mutable approval projection filters the snapshot.
- **`mcpServers`** (`:383-385`) attaches `pluginVersion` (from the manifest) and `resolvedRevision`
  (from the install record, or `git rev-parse HEAD` as a fallback for unmanaged plugins —
  `revisionOf`, `:210-222`).
- **`agents`** (`:387-393`) parses each file's frontmatter leniently and names it `<plugin>:<agent>`
  with `scope: "plugin"` (`toAgentRecord`, `:295-307`).
- **`readAgent`** (`:395-406`) requires the plugin to be in `enabled` and matches the file by exact
  `<agent>.md` name.
- **`locateCapabilityExecutable`** (`:408-422`) checks enablement, then installation, then the
  manifest, then the named capability — four distinct error strings.
- **`skillPlansMode`** (`:424-427`) returns `manifest.capabilityRunPolicies?.plans?.skills[skill]`
  for an enabled plugin only.

### 4.9 Merging plugin settings

`createFileConfigStore`'s `snapshot()` (`packages/kernel/src/config/file-config-store.ts:673-717`):

1. Read global and workspace scopes; strip `WORKSPACE_RISK_FIELDS` from workspace if it is not
   trusted (`:560-569`).
2. Merge **operator scopes alone** to obtain exact `enabledPlugins` references.
3. Ask the Environment manager for the process-pinned qualified plugin selection; an alternate host
   without that collaborator keeps those same exact references.
4. Ask plugin contributions for `settingsScopes(enabledPlugins)`, then merge
   `[...pluginScopes, ...operatorScopes]` — plugin scopes **first**.

Since the merge is last-wins by scope order, an operator always overrides a plugin. Within the
`hooks` key, `hooksSettingsSpec.merge` re-sorts by origin so that *all* operator hooks precede *all*
plugin hooks, then truncates to `MAX_HOOKS_PER_RUN = 128`
(`packages/loop/src/runtime/capabilities/hooks.ts:58-62`; limits at
`packages/capability/src/hooks-config.ts:216-217`).

`pluginSettingsFragment` (`packages/loop/src/settings/plugin-schema.ts:161-172`) carries `mcpServers`
plus every built-in settings spec marked `pluginContributable`. Across the whole repository exactly
one spec sets it `true` — `hooksSettingsSpec`
(`packages/loop/src/runtime/capabilities/hooks.ts:63`). The built-in `agentTools`, `sandbox` and
`agents` specs set it `false`; the host-registered Memory, Plans, Tasks and Workflows specs likewise
declare `false` and cannot add a plugin-manifest surface.

### 4.10 Install / update / uninstall

`install` in `packages/kernel/src/plugins/plugin-service.ts`:

1. `validateGitUrl(url)` (`:382`).
2. Register an `AbortController` with the kernel lifecycle (`:384`).
3. `fetcher.fetch(safe, subdir, signal)` — `mkdtemp` under the global dir, `git clone --depth 1
   --no-recurse-submodules --quiet -- <source> <staging>/repo`, `git rev-parse HEAD`, then select the
   subdir (`packages/kernel/src/adapters/git/plugin-fetcher.ts:130-155`).
4. `repository.inspect(prepared.root)` then `readManifest`; no manifest → `invalid_request`
   `refusing to install: <error>` (`packages/kernel/src/plugins/plugin-service.ts:389-390`).
5. `repository.install(root, manifest.name, target.source, prepared)` — the target defaults to the
   global `.agents/plugins` inventory and may explicitly be `clarvis`; refuse only if the exact
   target convention already carries that name, `mkdir` the install root at `0o700`, write the
   install record, and `rename` the staging root into place.
6. `finally`: `prepared.dispose()` (removes the staging tree) and release the lifecycle handle
   (`packages/kernel/src/plugins/plugin-service.ts:392-395`).

**The plugin's install directory is its manifest `name`, never the repository or subdir name.** Pinned
at `packages/kernel/tests/integration/plugin-service.test.ts:448-458`, which installs `plugins/brainstorm` from a repo and asserts the
installed tree carries neither `.git` nor `plugins/`.

Managed lifecycle is global-only for both sources. Workspace `.agents/plugins` and
`.clarvis/plugins` directories are visible and activatable, but update/uninstall refuses them because
the repository owns those trees. Removing or replacing a checkout does not remove its persistent
`pluginDataRoot/<source>/<name>` directory. Production:
`createFilePluginRepository` in
`packages/kernel/src/adapters/filesystem/plugin-repository.ts` and `pluginDataDir` in
`packages/kernel/src/plugins/plugin-runtime.ts`. Tests:
`packages/kernel/tests/integration/plugin-service.test.ts` and
`packages/kernel/tests/unit/plugin-runtime.test.ts`.

`update`: only an exact **globally** installed, non-linked plugin; its `source` selects the same
global inventory for lookup/replacement. A linked external checkout is visible and activatable but
has no managed install source, receives no update affordance in Code, and is rejected independently
by both the fetcher and repository replacement. When the checkout is
still a git repo, `git fetch --depth 1 --quiet origin HEAD` + `git reset --hard --quiet FETCH_HEAD`
in place and no `PreparedPlugin` is returned (`packages/kernel/src/adapters/git/plugin-fetcher.ts:168-170`); when it is not a checkout
but has a recorded `source`, the plugin is re-fetched and atomically **replaced** (`:162-167`,
`packages/kernel/src/adapters/filesystem/plugin-repository.ts`); when it is neither, `invalid_request` `'<name>' was not installed
from git` (`packages/kernel/src/adapters/git/plugin-fetcher.ts:164`). An update whose new manifest names a different plugin is refused
(`packages/kernel/src/plugins/plugin-service.ts:417-422`).

The in-place branch (`fetch` + `reset --hard` directly against the live plugin directory, not a
staged copy) has no rollback logic of its own: `reportGitFailure` logs, on *any* failing git
subcommand across clone/fetch/reset, "the plugin is neither installed nor updated and the previous
checkout is untouched" (`packages/kernel/src/adapters/git/plugin-fetcher.ts:62`). For a failed `clone` this is trivially true (nothing
was written outside the fresh staging directory), but for a failed `reset --hard` **after** a
successful `fetch` in the in-place branch, the claim rests entirely on this log message — there is no
staging, snapshot or restore around the two-command sequence, and no test in this document's scope
exercises a `reset --hard` that fails after its `fetch` succeeded to confirm the working checkout is
actually left unmodified. Treat "untouched" here as an assertion the code makes about itself, not as
an independently verified guarantee.

`replace` renames the old directory aside to `.plugin-replaced-<name>-<uuid>`, renames the new one
in, and restores the backup if that fails (`packages/kernel/src/adapters/filesystem/plugin-repository.ts:205-213`).

`uninstall` (`packages/kernel/src/plugins/plugin-service.ts:440-444`) removes the global directory or throws `not_found`.
For an exact plugin selected by the process Environment, update/replacement and uninstall enter a
kernel-owned exclusion boundary: an active run returns `conflict`, and run start cannot race the
filesystem mutation. A successful mutation marks the kernel snapshot stale and later run starts
return `unavailable` until reconnect. Unselected exact installations retain ordinary independent
lifecycle behavior (`mutateInstalled` and `withSelectedMutation` in
`packages/kernel/src/plugins/plugin-service.ts` and `packages/kernel/src/kernel.ts`; pinned by the
selected lifecycle case in `packages/kernel/tests/integration/run-service.smoke.test.ts`).

`validateGitUrl` (`packages/kernel/src/plugins/plugin-service.ts:46-68`) refusal order: empty → leading `-` (git flag) → `ext::`
anywhere (arbitrary command) → local filesystem path → `http://`/`git://` cleartext → finally accept
only `https://`, `file://`, or an scp/ssh spelling. Pinned at `packages/kernel/tests/integration/plugin-service.test.ts:227-243` and,
for the byte-identical `@clarvis/code` copy, at `packages/code/tests/integration/plugin-install.test.ts:13-45`.

### 4.11 Building the operator view — `viewFor`

`viewFor` in `packages/kernel/src/plugins/plugin-service.ts`. `list()` maps every record from all
four inventories and therefore retains every same-named installation. `enabled` is an exact
`{ scope, source, name }` membership test against the pinned Environment. Notes are
`[...manifestNotes, ...skillNotes]`.
`skillNamesOf` (`:204-241`) runs the **same** `createAgentSkills` scan a run would, over the same
roots, and keeps the catalog's warnings: the docstring records that the panel used to list every
child directory with a `SKILL.md`, which "disagreed by one skill on the first real plugin they were
compared on — listed in the panel, absent from the model's catalog, with nothing anywhere saying so"
(`:187-192`), and that silencing warnings made a plugin shipping twenty skills read as "18 skills"
(`:198-199`). At most `MAX_SKILL_REJECTION_NOTES = 3` rejections are named, then a count (`:146`,
`:231-236`).

`partitionAgents` (`:92-102`) splits agent files into `agents` and `broken_agents` by whether the
leniently-parsed frontmatter satisfies `agentFrontmatterSchema` (`:86-88`). `executablesOf`
(`:107-123`) renders one `$ ` line per hook command, per MCP server (stdio argv or URL) and per
capability executable (with the current platform's override applied).

#### 4.12.1 Capability-executable projection — `capabilityExecutablesOf`

`capabilityExecutablesOf` (`packages/kernel/src/plugins/plugin-service.ts:126-140`) is the machine-readable twin of the
`executablesOf` display lines: for each entry of `manifest.capabilityExecutables`, it selects
`declaration.platforms?.[process.platform]` as the current-platform override (falling back to the
declaration's own `command`/`args` when there is none), and maps the result to
`{ capability, command, args, platform_override }`. The output is **sorted by capability name**
(`.sort((a, b) => a.capability.localeCompare(b.capability))`, `:140`), independent of manifest
authoring order. `executablesOf` performs the identical override selection for its `$` lines
(`:114-122`) rather than reusing `capabilityExecutablesOf`'s result. `contributionsOf` (`:246-265`)
folds the sorted array into the wire `PluginContributions.capability_executables`, and copies
`manifest.capabilityRunPolicies` verbatim into `.capability_run_policies` when present. The sort is
pinned directly: `packages/kernel/tests/integration/plugin-service.test.ts:130-155`, "projects every
capability executable in sorted capability order" — two capabilities declared as `plans` then
`memory` in the manifest come back `memory` then `plans`.

### 4.13 Marketplace reading (`@clarvis/code`)

`createMarketplaceAdapter` (`packages/code/src/adapters/marketplace.ts:252-308`):

- Sources are `[...defaults, ...deps.urls(), ...discovered]`, de-duplicated in first-seen order
  (`:260-263`). `defaults` is the official catalog unless a test supplies an override; `discovered`
  comes from `discoverAgentsCatalogs` (`:236-238`), which reads `agentsMarketplaceFiles()` in
  workspace-then-user order, de-duplicates and keeps only the ones that exist.
- `read(id)` dispatches on `isAgentsMarketplaceFile(id)`: a local document is read in place, anything
  else is cloned (`:265-266`).
- `fetchMarketplace` (`:212-226`) validates the URL, `mkdtemp` in the OS temp dir, `gitCloneAsync`,
  then takes the **first** existing document of `[<root>/marketplace.json,
  <root>/.agents/plugins/marketplace.json]` (`documentsIn`, `:62-64`), and always removes the
  checkout in `finally`.
- `load()` skips a source that already has a cached `marketplace`, but retries one that errored
  (`:294`); `refresh()` clears both the cache and the discovered list (`:303-306`). Pinned at
  `packages/code/tests/integration/marketplace.test.ts:166-180`.
- `listings()` de-duplicates on `url \0 name`, so two marketplaces offering the same plugin name both
  appear (`:273-280`, pinned `packages/code/tests/integration/marketplace.test.ts:182-207`), and sorts by name (`:288`).

`readMarketplace` (`:163-188`) applies the 2 MiB ceiling before reading, then
`confineLocalSources(dirname(file), catalog)` (`:141-152`), which adds a note — never a gate — for a
non-installable listing whose `resolve(root, entry.source)` leaves `realpath(root)`.

`staysInside` (`:103-114`) answers `true` only for `ENOENT`/`ENOTDIR`; every other `realpath` failure
answers `false` **and** emits `marketplace.containment.unknown` at `warn`. The docstring names the
attack it closes: the target comes from the marketplace document, "so its author could make the
resolution fail cheaply (a symlink cycle, an overlong path) and thereby delete the containment note
about their own listing… a note an untrusted party can suppress is not a note" (`:84-92`). Pinned at
`packages/code/tests/integration/marketplace.test.ts:328-392`, including an `ELOOP` symlink cycle asserting exactly one diagnostic.

### 4.14 Marketplace document reading (`readMarketplaceDocument`)

`packages/loop/src/settings/marketplace-schema.ts:468-511`. Root: `name` (defaulted + noted),
`description`, `displayName` (top-level, else read out of a nested presentation block by
`authoredTextVia`), then listings, then foreign-key notes.

`readEntry` (`:363-433`) drops a listing for exactly two reasons — no usable `name` (`:370-373`) and
an unresolvable `source` (`:376-379`). Everything else is supplied and noted: "dropping a whole
listing over a missing one-line summary would empty a catalog that is otherwise perfectly readable"
(`:357-361`).

When no `description` is authored and `authoredTextVia(source, SUMMARY_KEYS)` finds no summary
either, the supplied default is **not** the bare `DEFAULT_ENTRY_DESCRIPTION` if a `category` was
read: it becomes `` `${DEFAULT_ENTRY_DESCRIPTION} (category: ${category})` `` — "no description
provided by this marketplace (category: &lt;category&gt;)" — while a listing with no category at all
still gets the bare default (`:399-408`). Pinned:
`packages/code/tests/integration/marketplace-schema.test.ts:250-263`, "a foreign listing with no
description keeps its place, taking its summary or its category".

`readSource` (`:258-293`) state table:

| Input | `source` | `installable` | note |
|---|---|---|---|
| string matching `^[A-Za-z]…://` or `user@host:` | as written | `true` | — |
| string that is not a relative subpath | as written | `false` | "would resolve outside the marketplace root" |
| any other string | as written | `false` | `LOCAL_SOURCE_NOTE` |
| `{ source: "local", path }`, path relative | `path` | `false` | `LOCAL_SOURCE_NOTE` |
| `{ source: "local" }`, no path | `"local"` | `false` | "names a local source with no path" |
| `{ source: "local", path }`, path escapes | `path` | `false` | "would resolve outside the marketplace root" |
| `{ source: <other kind> }` | `path ?? kind` | `false` | "names source kind '<kind>', which Clarvis has no fetcher for" |

A `path` that is present but unreadable additionally forces `installable: false` and drops the field
(`:386-392`), pinned at `packages/code/tests/integration/marketplace-schema.test.ts:93-110` and `:351-363`.

`authoredTextVia` (`:220-237`) looks for the first non-empty string under a list of key spellings,
first at the top level, then inside any of `interface`/`presentation`/`display`/`metadata`/`meta`
(`:193-199`), and returns the key it read from. The two spelling lists are load-bearing constants:
`SUMMARY_KEYS = ["description", "shortDescription", "short_description", "summary", "tagline"]`
(`:184-190`) and `DISPLAY_NAME_KEYS = ["displayName", "display_name", "title"]` (`:202`). `actedKeys` (`:442-448`) widens the known-key set by
whatever was actually consumed, so a key a value was read out of stops being reported as unacted-on —
the docstring calls the alternative "a note that contradicts the behaviour beside it" (`:215-218`).
Pinned at `packages/code/tests/integration/marketplace-schema.test.ts:294-298` and `:324-334`.

`foreignKeyNotes` (`:130-151`) bounds both the listed keys and the per-key suggestions, because "the
keys come from a document Clarvis did not write, so an unbounded join is as much a denial of service
as an unbounded count" (`:125-128`). Pinned at `packages/code/tests/integration/marketplace-schema.test.ts:336-349`.

## 5. Invariants

All of the following are derived directly from this document's own source and tests.

1. **The install directory is the host-owned runtime identity.** A native Git install creates that
   directory from the normalized manifest `name`; an already installed foreign layout uses its
   directory name for namespaces even when presentation metadata differs, and may supply a missing
   manifest name from that directory. A replacement update cannot rename the existing install.
   Production: `packages/kernel/src/plugins/plugin-service.ts:386-399`, `:411-428`;
   `packages/kernel/src/plugins/plugin-contributions.ts:243-275`;
   `packages/kernel/src/plugins/plugin-manifest.ts:866-921`, `:938-983`. Test:
   `packages/kernel/tests/integration/plugin-manifest.test.ts:711-732` and
   `packages/kernel/tests/integration/plugin-service.test.ts:405-430`, `:448-458`.

2. **`name` is the only required manifest key.** `packages/loop/src/settings/plugin-schema.ts:46-59`.
   Pinned: `packages/loop/tests/unit/plugin-schema.test.ts:37-40`
   (`{name:"demo"}` passes, `{version:"1.0.0"}` fails).

3. **The manifest schema is `.loose()`; an unrecognized key is reported, never fatal.**
   `packages/loop/src/settings/plugin-schema.ts:90`, reported via `unknownManifestKeys` (`:107`).
   Pinned: `packages/loop/tests/unit/plugin-schema.test.ts:53-66`,
   `packages/kernel/tests/integration/plugin-manifest.test.ts:136-141`.

4. **A plugin may not contribute `guard` or `sandbox`.** Declared as `z.undefined()` carrying the
   reason (`packages/loop/src/runtime/capabilities/tools-settings.ts:181-189`). The forbidden reason
   text states it: "guard is a singleton and the last writer wins, so a plugin could silently disarm
   the workspace's own guard" (`:176-177`). Pinned:
   `packages/loop/tests/unit/plugin-schema.test.ts:25-29`.

5. **`hooks` is the only `pluginContributable` built-in settings block.**
   `packages/loop/src/runtime/capabilities/hooks.ts:63`; every other spec in the repository declares
   `pluginContributable: false`. Consumed by `pluginSettingsFragment`
   (`packages/loop/src/settings/plugin-schema.ts:166-170`). Pinned indirectly:
   `packages/loop/tests/unit/plugin-schema.test.ts:164-181` asserts the fragment carries only
   `mcpServers` + `hooks` and never `bootstrapSkill`.

6. **A *registered* (non-built-in) capability may not declare any plugin-manifest surface.**
   `settingsSchemaFor` throws at registration when a registered spec sets `pluginContributable`,
   `pluginDescription` or `pluginForbiddenReason`
   (`packages/loop/src/settings/capability-settings.ts:52-63`). Unpinned by a test in this document's scope.

7. **`bootstrapSkill` never reaches merged settings.** It is not `pluginContributable` and the
   docstring states both consequences — it never travels `settingsScopes`, and it is not part of the
   executable surface (`packages/loop/src/runtime/capabilities/skills-settings.ts:25-32`,
   field at `:39-41`). Pinned: `packages/loop/tests/unit/plugin-schema.test.ts:179-181`.

8. **A plugin name is `^[a-z0-9_-]+$` and never a prototype-polluting key.**
   `packages/loop/src/settings/settings-schema.ts:44-55`. Pinned:
   `packages/loop/tests/unit/plugin-schema.test.ts:31-35` and, for marketplace listings,
   `packages/code/tests/integration/marketplace-schema.test.ts:74-86`.

9. **A Clarvis-specific manifest is authoritative; otherwise exactly one richest compatible
   candidate wins deterministically.** `readPluginManifestSource` first probes
   `.clarvis-plugin/plugin.json`, then scores root and name-sorted host candidates without merging
   them (`packages/kernel/src/plugins/plugin-manifest.ts:233-345`). Pinned:
   `packages/kernel/tests/integration/plugin-manifest.test.ts:61-119`.

10. **A manifest candidate that exists but cannot be read stops selection.**
    `packages/kernel/src/plugins/plugin-manifest.ts:287-310`, `:317-328`. Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:114-119`, `:253-257`.

11. **Both readers of a manifest go through `resolvePluginManifest`.** The install/panel path
    (`packages/kernel/src/plugins/plugin-service.ts:81`) and the run path
    (`packages/kernel/src/plugins/plugin-contributions.ts:257`). Unpinned as a structural rule; the
    consequences are pinned separately in both suites.

12. **Every path a manifest names is confined to the plugin root, decided on the *resolved* path.**
    `companionPath` (`packages/kernel/src/plugins/plugin-manifest.ts:366-375`). Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:1155-1201` (relative climb, climb through a subdirectory, absolute path,
    and an accepted nested path).

13. **A relative path in a dot-directory manifest resolves from that directory first, and still
    cannot escape the root.** `pluginDirsFor` (`:407-413`) + `companionPath`'s two-base attempt
    (`:370-374`). Pinned: `packages/kernel/tests/integration/plugin-manifest.test.ts:1236-1288`.

14. **No hooks source can cost a plugin anything but its hooks.** Every failure path in
    `harvestFile` / `harvestConvention` / `harvestDocument` returns `{ hooks: [], notes: [...] }`
    (`packages/kernel/src/plugins/plugin-manifest.ts:484-551`). Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:861-950` — missing file, non-JSON, over the byte ceiling, wrong shape,
    unusable convention file, all with `error` undefined.

15. **One hooks source wins outright; two are never merged, and the loser is named.**
    `resolveHooks` (`:650-687`). Pinned: `packages/kernel/tests/integration/plugin-manifest.test.ts:811-860`.

16. **An empty `hooks` declaration (`{}` or `[]`) falls through to the convention file.**
    `:661` tests `fromManifest.hooks.length > 0`. Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:848-860`.

17. **A declared or conventional `mcpServers` document that cannot be used costs only the
    servers.** `inlineMcpServersDocument` returns notes for every non-absence failure
    (`packages/kernel/src/plugins/plugin-manifest.ts:715-760`). Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:260-360` and, for the run path,
    `packages/kernel/tests/integration/plugin-contributions.test.ts:152-165`
    which asserts the agents and skill roots survive.

18. **A companion is never inlined if doing so pushes the manifest past `manifestBytes`.**
    `packages/kernel/src/plugins/plugin-manifest.ts:755-758`. Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:1214-1230`.

19. **An unusable MCP server entry is dropped alone; the key is removed only if nothing survives.**
    `sanitizeMcpServers` (`packages/kernel/src/plugins/plugin-manifest.ts:798-820`). Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:550-578`.

20. **`mcpServerPluginSchema` is tolerant and `mcpServerSettingsSchema` is strict; the difference is
    load-bearing.** `packages/loop/src/settings/settings-schema.ts:197` vs `:221`. Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:473-478`.

21. **A `skills` declaration never leaves a plugin with nowhere to look.** Every failure path in
    `pluginSkillRoots` returns the `<dir>/skills` fallback
    (`packages/kernel/src/plugins/plugin-manifest.ts:167-178`, `:211-218`). Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:184-250`.

22. **A plugin contributes at most 4 effective skill roots, and all enabled plugins at most 24. A
    direct-skill list may be compacted only when the parent scan is exactly equivalent to the
    declarations.**
    **Production:** `MAX_PLUGIN_SKILL_ROOTS`, `compactSkillRoots` and `isExactSiblingSkillGroup` in
    `packages/kernel/src/plugins/plugin-manifest.ts`, plus `PLUGIN_SKILL_ROOT_BUDGET` in
    `packages/kernel/src/plugins/plugin-contributions.ts`. **Test:** the plugin-manifest cases "caps
    how many locations one plugin may contribute", "compacts exhaustive direct-skill siblings" and
    "does not compact a group when that would admit an undeclared sibling"; the shared budget is
    pinned by `packages/kernel/tests/integration/plugin-contributions.test.ts`, case "bounds plugin
    skill roots and projects an optional bootstrap skill".

23. **Presentation metadata is display data only and never widens what a plugin may do.**
    `PluginPresentation`'s docstring (`packages/kernel/src/plugins/plugin-manifest.ts:440-449`); the same statement is repeated on
    the wire DTO (`packages/protocol/src/plugins.ts:53-58`). Nothing in
    `plugin-contributions.ts` reads `presentation`. Unpinned as a negative.

24. **Suspected misspellings are reported ahead of merely-foreign keys, and a key reported as a
    misspelling is not also reported as foreign.** `packages/kernel/src/plugins/plugin-manifest.ts:989-1002`. Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:128-134`.

25. **A short key gets a tighter typo budget than a long one.** `typoBudget` returns 1 for ≤4
    characters, else 2 (`packages/loop/src/settings/typo-suggestion.ts:49-50`). Pinned:
    `packages/loop/tests/unit/plugin-schema.test.ts:97-105`.

26. **An external hook event with no Clarvis counterpart is reported, never approximated.**
    `packages/kernel/src/plugins/hook-dialects.ts:554-559`; the event table is inverted from `EXTERNAL_HOOK_EVENT_NAMES` rather
    than written out (`:52-54`). Pinned: `packages/kernel/tests/integration/plugin-manifest.test.ts:1021-1028` (`Notification`) and
    `:1079-1092` (every named event round-trips).

27. **The external-event correspondence is one-to-one, so inverting it loses nothing.** Pinned
    directly: `packages/kernel/tests/integration/plugin-manifest.test.ts:1079-1092`.

28. **A hook whose Clarvis event cannot act on its verdict is noted.** `OBSERVER_ONLY` check at
    `packages/kernel/src/plugins/hook-dialects.ts:560-572`. Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:1030-1037`.

29. **An entirely untranslatable matcher drops the group; a mixed matcher keeps its exact surviving
    alternatives and reports the rest.** `packages/kernel/src/plugins/hook-dialects.ts:495-521`.
    Pinned: `packages/kernel/tests/integration/plugin-manifest.test.ts:734-790`.

30. **A catch-all matcher means no filter; a catch-all inside an alternation is refused.**
    `packages/kernel/src/plugins/hook-dialects.ts:499-507`. Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:782-790`, `:791-799`.

31. **The foreign tool-alias table applies only to a name carrying no pattern syntax.**
    `packages/kernel/src/plugins/hook-dialects.ts:409-452` gates the alias branch on
    `PLAIN_TOOL_NAME`. Pinned: `packages/kernel/tests/integration/plugin-manifest.test.ts:782-790`.

32. **Every foreign tool name maps onto a tool this host actually dispatches.** Enforced across
    package boundaries: `packages/kernel/tests/architecture/external-tool-names.test.ts:19-29` checks
    `EXTERNAL_TOOL_NAMES` targets against `@clarvis/tools`'s registry and checks that nothing in
    `EXTERNAL_TOOLS_WITHOUT_COUNTERPART` actually exists here.

33. **A timeout past the ceiling is clamped, never emitted as a schema-invalid hook.**
    `translateTimeout` (`packages/kernel/src/plugins/hook-dialects.ts:94-107`). Pinned: `packages/kernel/tests/integration/plugin-manifest.test.ts:1095-1130`, the
    second of which asserts `hookSchema.safeParse` succeeds for every produced hook.

34. **A plugin-root placeholder is expanded, not pattern-matched, and a suffix-collision is left
    alone.** `substituteRoot` (`packages/kernel/src/plugins/hook-dialects.ts:259-308`), `BARE_PLUGIN_ROOT`'s lookahead (`:191`).
    Pinned: `packages/kernel/tests/integration/plugin-manifest.test.ts:505-548`.

35. **A selected plugin contributes every normalized hook in its atomic settings fragment.**
    `pluginSettingsContributions` in
    `packages/kernel/src/plugins/plugin-contributions.ts`. Pinned:
    `packages/kernel/tests/integration/plugin-contributions.test.ts` (selected hook composition).

36. **Changing hook or companion bytes changes the Environment fingerprint.**
    `pluginContentDigest` in `packages/kernel/src/environments/environment-manager.ts` hashes every
    resolved contribution. Pinned: `packages/kernel/tests/integration/environment-manager.test.ts`
    (root MCP and plugin-content digest drift cases).

37. **A hook that arrives from an external file is normalized under the same plugin snapshot as an
    inline one.** `packages/kernel/src/plugins/hook-dialects.ts` and
    `packages/kernel/src/plugins/plugin-manifest.ts`. Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts` (external hook conversion cases).

38. **The plugin protocol exposes lifecycle for the atomic plugin, not approval for internal
    contributions.** `PluginService` in `packages/protocol/src/plugins.ts` and the plugin operation
    registrations in `packages/kernel/src/transport/operations.ts`. Pinned:
    `packages/kernel/tests/contract/transport-codecs.test.ts`.

39. **Focused Marketplace install is the consent action for the complete plugin.**
    `installAndActivatePlugin` in `packages/code/src/app/commands.tsx`. Pinned:
    `packages/code/tests/integration/app-commands.test.tsx` (atomic install and reload case).

40. **An unusable `agents/` surface or install record omits the plugin's entire executable surface.**
    `loadableOf` returns `undefined` at both steps (`packages/kernel/src/plugins/plugin-contributions.ts:262-271`), and the
    agent walk is explicitly atomic — "callers must never execute a prefix returned before the
    failure" (`packages/loop/src/settings/plugin-agents.ts:26-28`). Pinned:
    `packages/kernel/tests/integration/plugin-contributions.test.ts:211-239`, which asserts `settingsScopes`, `mcpServers` and `agents`
    all come back empty for an oversized agent file and an oversized install record.

41. **The `agents/` walk is deterministic in file set and ordering.** Entries are sorted per directory
    (`packages/loop/src/settings/plugin-agents.ts:93`) and names are normalized to forward slashes (`:112`). The docstring says
    forking it "would make a plugin approved in one host read as `changed`/`unapproved` in the other"
    (`:27-28`). Pinned: `packages/loop/tests/integration/plugin-agents.test.ts:20-34`.

42. **A missing `agents/` directory is an empty success, not a failure.** `packages/loop/src/settings/plugin-agents.ts:56-58`,
    `:78-80`. Unpinned directly; exercised by every fixture with no `agents/`.

43. **`readBoundedPluginText` opens once and sizes and reads the same descriptor.**
    `packages/loop/src/settings/plugin-resources.ts:38-84`; the docstring states "Replacement cannot
    switch the inode after validation, and growth between `fstat` and `read` cannot bypass the
    ceiling", with `O_NONBLOCK` against a FIFO and `O_NOFOLLOW` where available (`:32-37`, `:45-46`).
    The one-byte read-ahead (`maxBytes + 1`, `:66`, `:73`) is what catches a sparse file. Pinned by
    the sparse-file tests: `packages/loop/tests/integration/plugin-agents.test.ts:36-45`, `packages/kernel/tests/integration/plugin-manifest.test.ts:98-103`.

44. **A plugin contributes only when its exact scoped installation belongs to the process-pinned
    Environment, and later bytes cannot enter under that snapshot.** Every `PluginContributions`
    method takes the resolved selection; `pin` captures its exact loadables and digest, while
    `assertPinnedSnapshot` rejects drift before any later lookup. Production:
    `packages/kernel/src/plugins/plugin-contributions.ts`; composition in
    `packages/kernel/src/environments/environment-manager.ts`. Test:
    `packages/kernel/tests/integration/environment-manager.test.ts` and
    `packages/kernel/tests/integration/plugin-contributions.test.ts`.

44a. **Every directly referenced package-local process file is part of the plugin snapshot.**
    `snapshotPluginExecutables` resolves confined regular files from MCP stdio argv/cwd, the current
    platform capability argv, and translated absolute hook words; it hashes content and executable
    mode under bounded file, count, and aggregate budgets. Production:
    `packages/kernel/src/plugins/plugin-executable-snapshot.ts` and `contributionSnapshot` in
    `packages/kernel/src/plugins/plugin-contributions.ts`. Test: the process-file fingerprint and
    drift cases in
    `packages/kernel/tests/integration/{environment-manager,plugin-contributions}.test.ts`.

45. **A plugin cannot enable another plugin.** Custom Environments are complete external
    allow-lists; `builtin:default` derives exact `enabledPlugins` refs from operator scopes alone before
    any plugin settings fragment is merged. Production:
    `packages/kernel/src/config/file-config-store.ts:673-688` and
    `packages/kernel/src/environments/environment-manager.ts` (`resolved`). Test:
    `packages/kernel/tests/integration/environment-manager.test.ts`.

46. **Plugin settings scopes are merged *before* operator scopes, so an operator always wins.**
    `packages/kernel/src/config/file-config-store.ts:650-653`; within `hooks`, `hooksSettingsSpec.merge` re-orders operator-first
    regardless (`packages/loop/src/runtime/capabilities/hooks.ts:58-62`). Unpinned in this document's scope.

47. **`enabledPlugins` and `marketplaces` are workspace-risk fields.**
    `packages/kernel/src/config/workspace-trust.ts:40-41`. The test fixture states the consequence:
    "a repository cannot turn a plugin on by shipping a settings file"
    (`packages/kernel/tests/integration/plugin-skills-install.test.ts:71-73`).

48. **Installed inventory preserves all four same-name identities; substitution never occurs.**
    `listInstalledPlugins` returns every global/workspace and agents/clarvis record; exact
    contribution lookup honors the supplied scope/source/name, and a second selected installation
    with the same runtime name invalidates Environment resolution. Production:
    `packages/kernel/src/adapters/filesystem/plugin-repository.ts`,
    `packages/kernel/src/plugins/plugin-contributions.ts` (`dirFor`), and
    `packages/kernel/src/environments/environment-manager.ts` (`resolved`). Test:
    `packages/kernel/tests/integration/plugin-service.test.ts`,
    `packages/kernel/tests/integration/plugin-contributions.test.ts`, and the same-name case in
    `packages/kernel/tests/integration/environment-manager.test.ts`.

49. **A plugin's MCP servers are namespaced `<plugin>:<server>` by one host-owned function.**
    `effectivePluginMcpName` (`packages/kernel/src/plugins/plugin-contributions.ts:90-92`), used by `settingsScopes` (`:371-373`),
    `mcpServers` (`:229`) and `contributionsOf` (`packages/kernel/src/plugins/plugin-service.ts:255-257`). Pinned:
    `packages/kernel/tests/integration/plugin-contributions.test.ts:96-128`, where two plugins each declaring `tasks` produce
    `alpha:tasks` and `beta:tasks`.

49a. **Every winning MCP declaration of an active plugin is attached to the run and its successfully
    discovered tools are available to every effective agent without mutating the persisted profile.**
    The file config store records the winning origin after plugin < global < workspace merge; an
    operator declaration that replaces the same namespace is never marked `auto_tools`.
    Production: `mcpServerOrigins` in `packages/kernel/src/config/file-config-store.ts`,
    `createSettingsRunAssembler` (`pluginMcpServerNames` and `auto_tools`), file-kernel composition
    in `packages/kernel/src/file-kernel.ts`, and `addAutomaticMcpTools` in the loop.
    Test: the "attaches an active plugin server independently of persisted agent tools" case in
    `packages/kernel/tests/component/settings-assembler.test.ts`, its operator-override case,
    `packages/kernel/tests/integration/file-config-store.test.ts` (winning MCP origin),
    `packages/loop/tests/unit/automatic-mcp-tools.test.ts`, and the "host-composed automatic server
    tools" case in `packages/loop/tests/integration/open-tool-pool.test.ts`.

50. **Plugin MCP provenance carries version and resolved revision, never the manifest version alone
    as identity.** `revisionOf` prefers the install record and falls back to `git rev-parse HEAD`
    (`packages/kernel/src/plugins/plugin-contributions.ts:215-227`). Consumed as the Tasks provider's plugin identity
    (`packages/kernel/src/tasks/task-provider-factory.ts:214-221`). Pinned:
    `packages/kernel/tests/integration/plugin-contributions.test.ts:104-121`.

    **This precedence is the reverse of the panel's.** `revisionOf` above is
    record-first: `plugin.installRecord.revision`, falling back to `git rev-parse HEAD` only when
    the record carries none. `inspectPlugin` — which produces every `PluginView` the operator sees
    from `list()`/`global()`/`install()`/`update()` — is git-first:
    `gitValue(dir, ["config", "--get", "remote.origin.url"]) ?? recorded.source` and
    `gitValue(dir, ["rev-parse", "HEAD"]) ?? recorded.revision`
    (`packages/kernel/src/adapters/filesystem/plugin-repository.ts:107-112`), so live Git state wins
    over the recorded install whenever `.git` exists. A plugin checkout `git pull`-ed outside the
    kernel can therefore show a different `revision` in the panel than the one a run's MCP-provenance
    identity actually carries. No test in this document's scope exercises both readers against the
    same manually-advanced checkout; **why the two are asymmetric on purpose (display-freshness versus
    pinned provenance identity) is resolved in §8.**

51. **A capability executable requires installation, enablement *and* operator selection.**
    `locateCapabilityExecutable` refuses an unenabled plugin (`packages/kernel/src/plugins/plugin-contributions.ts:414-416`), and
    the kernel reaches it only through a `provider.kind === "plugin"` selection in settings
    (`packages/kernel/src/file-kernel.ts:642-645`, `:823-830`). The docstring: "the plugin cannot
    select itself" (`packages/kernel/src/file-kernel.ts:817-821`). Pinned:
    `packages/kernel/tests/integration/plugin-contributions.test.ts:167-188` and `packages/kernel/tests/integration/plugin-skills-install.test.ts:103-137`.

52. **A packaged skill's Plans policy applies only while its own plugin is the selected Plans
    provider.** `skillPlansMode` requires `skill.source === "plugin:" + selected.plugin`
    (`packages/kernel/src/file-kernel.ts:644`). Pinned: `packages/kernel/tests/integration/plugin-skills-install.test.ts:103-137`, which flips the provider
    to `markdown` and asserts `plansMode` becomes `undefined`.

53. **Install refuses a name already installed.** `packages/kernel/src/adapters/filesystem/plugin-repository.ts:188-193`. Pinned:
    `packages/kernel/tests/integration/plugin-service.test.ts:378-389`.

54. **A subdir must resolve inside the checkout and be a directory.** `pluginRoot`
    (`packages/kernel/src/adapters/git/plugin-fetcher.ts:67-81`). Pinned:
    `packages/kernel/tests/integration/plugin-service.test.ts:480-500`.

55. **The staging checkout is always disposed, on success and on failure.** `finally` in `install`
    and `update` (`packages/kernel/src/plugins/plugin-service.ts:392-395`, `:425-428`) and the `catch` in `fetch`
    (`packages/kernel/src/adapters/git/plugin-fetcher.ts:151-154`). Pinned: `packages/kernel/tests/integration/plugin-service.test.ts:345-346` asserts `disposed`.

56. **Plugin Git selects its own repository and cannot inherit repository-local routing from the
    process that launched Clarvis.** Before clone/fetch/reset, installed-checkout metadata, or an
    unmanaged-plugin revision probe starts, Git's complete `git rev-parse --local-env-vars` set is
    removed through `withoutGitRepositoryEnvironment`; transport inputs remain. Prompts and system
    config are additionally disabled with `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=""`, and
    `GIT_CONFIG_NOSYSTEM=1` for network operations (`packages/kernel/src/adapters/git/plugin-fetcher.ts:95-114`,
    mirrored client-side at `packages/code/src/adapters/plugin-install.ts:9-15`, `:117-121`; metadata at
    `packages/kernel/src/adapters/filesystem/plugin-repository.ts:43-50`; unmanaged revision at
    `packages/kernel/src/plugins/plugin-contributions.ts:215-227`). The fetch/clone timeout is 120 s
    (`packages/kernel/src/adapters/git/plugin-fetcher.ts:12`, `packages/code/src/adapters/plugin-install.ts:5`).
    Pinned by `packages/kernel/tests/integration/local-observability.test.ts:102-135` and the real
    poisoned-environment clone at `packages/code/tests/integration/plugin-install.test.ts:49-86`.

57. **A git remote is reduced to its host before anything is logged.** `repoHost`
    (`packages/kernel/src/adapters/git/plugin-fetcher.ts:36-44`) and `reportGitFailure` (`:54-64`); the docstring notes
    `https://user:token@host/repo` is a supported form that redaction of key-*shaped* strings does not
    cover (`:32-34`). Unpinned.

58. **A refused clone is reported with argv, exit code and an stderr *tail*, under a field name that
    is not `stderr`.** `packages/code/src/adapters/plugin-install.ts:34-52`; the comment says a field
    named exactly `stderr` "is withheld by the diagnostic sink's content classifier and would arrive
    as `[redacted]`" (`:29-32`). Pinned: `packages/code/tests/integration/plugin-install.test.ts:47-67`.

59. **`validateGitUrl` refuses a flag-shaped URL, `ext::`, cleartext `http`/`git`, and a local path.**
    `packages/kernel/src/plugins/plugin-service.ts:46-68`. Pinned twice:
    `packages/kernel/tests/integration/plugin-service.test.ts:227-243` and `packages/code/tests/integration/plugin-install.test.ts:13-45`.

60. **An install-root fanout past `installRootEntries` throws rather than returning a partial
    catalog.** `directoryNames` returns an error and `list()` converts it to `resource_exhausted`
    (`packages/kernel/src/adapters/filesystem/plugin-repository.ts:73-78`, `:165`). Pinned: `packages/kernel/tests/integration/plugin-service.test.ts:283-289`.

61. **A marketplace document is refused only when it is not an object.**
    `packages/loop/src/settings/marketplace-schema.ts:530`. Pinned:
    `packages/code/tests/integration/marketplace-schema.test.ts:40-44`.

62. **A listing is dropped only for a missing name or an unresolvable source; every other missing
    field is supplied and noted.** `readEntry` (`packages/loop/src/settings/marketplace-schema.ts:370-379` versus `:384-414`).
    Pinned: `packages/code/tests/integration/marketplace-schema.test.ts:112-126` and the foreign-catalog test at `:223-234`.

63. **Corrupting one listing costs exactly that listing.** Pinned directly:
    `packages/code/tests/integration/marketplace-schema.test.ts:278-286`.

64. **A listing carries no executable surface — hooks or servers written on one are notes only.**
    `readEntry` copies only the seven known fields (`packages/loop/src/settings/marketplace-schema.ts:420-432`). Pinned:
    `packages/code/tests/integration/marketplace-schema.test.ts:64-72`.

65. **Only a git-fetchable source is `installable`; a local source parses, is shown, and is never
    offered.** `readSource` (`packages/loop/src/settings/marketplace-schema.ts:258-293`), plus the UI gate on activation
    (`packages/code/src/views/config/MarketplaceBrowser.tsx:132`). Pinned:
    `packages/code/tests/integration/marketplace-schema.test.ts:158-221`, `:266-270`, and behaviourally at
    `packages/code/tests/integration/marketplace-browser-render.test.tsx:144-180`.

66. **A key a value was actually read out of stops being reported as one Clarvis does not act on.**
    `actedKeys` (`packages/loop/src/settings/marketplace-schema.ts:442-448`) applied at `:417` and `:502`. Pinned:
    `packages/code/tests/integration/marketplace-schema.test.ts:241-248`, `:294-298`, `:324-334`.

67. **Marketplace notes are bounded in count and in listed-key length.** `MAX_NOTES` / `boundNotes`
    (`packages/loop/src/settings/marketplace-schema.ts:451-456`) and `MAX_LISTED_KEYS` (`:133-135`). Pinned:
    `packages/code/tests/integration/marketplace-schema.test.ts:336-349`.

68. **An oversized catalog is truncated with a note, never refused.** `:488-496`. Pinned:
    `packages/code/tests/integration/marketplace-schema.test.ts:147-156`.

69. **A source's own `marketplace.json` outranks the `.agents` one it also publishes.** `documentsIn`
    order (`packages/code/src/adapters/marketplace.ts:62-64`). Pinned:
    `packages/code/tests/integration/marketplace.test.ts:287-306`.

70. **A local source whose containment cannot be decided is treated as escaping, and the failure is
    logged.** `staysInside` (`packages/code/src/adapters/marketplace.ts:103-114`) + `reportContainmentUnknown` (`:124-130`).
    Pinned: `packages/code/tests/integration/marketplace.test.ts:328-392`.

71. **The panel lists exactly the skills a run would serve, by running the same catalog scan.**
    `skillNamesOf` uses `createAgentSkills` over `pluginSkillRoots` (`packages/kernel/src/plugins/plugin-service.ts:204-241`).
    Pinned: `packages/kernel/tests/integration/plugin-service.test.ts:252-266` (a `skills/` subdirectory with no `SKILL.md` is not a
    skill) and `:268-281` (an over-budget fanout contributes no skills and does not break the plugin).

72. **A workspace plugin cannot be uninstalled from the UI.** `MarketplaceBrowser`'s `uninstall`
    path notifies instead. Pinned:
    `packages/code/tests/integration/marketplace-browser-render.test.tsx`.

73. **Every `PluginsStore` mutation reloads the exact installed list from the kernel.**
    `packages/code/src/adapters/plugins.ts`. Pinned:
    `packages/code/tests/component/plugins.test.ts`.

74. **`load()` caches a success and retries an error; `refresh()` clears everything.**
    `packages/code/src/adapters/marketplace.ts:290-306`. Pinned:
    `packages/code/tests/integration/marketplace.test.ts:166-180`.

75. **`addMarketplaceSource` writes to the `global` scope only for a new additional URL, and writes
    nothing for a duplicate.** `packages/code/src/adapters/marketplace.ts:324-336`. Pinned:
    `packages/code/tests/integration/marketplace.test.ts:408-435`.

76. **The official marketplace is a built-in first source, is de-duplicated against settings, and is
    never persisted by the add action.** `OFFICIAL_MARKETPLACE_URL`, `DEFAULT_MARKETPLACE_URLS` and
    `every` (`packages/code/src/adapters/marketplace.ts:27-31`, `:260-263`), plus the official-source
    refusal in `addMarketplaceSource` (`:328-331`). Pinned:
    `packages/code/tests/integration/marketplace.test.ts:72-80`, `:437-443`.

77. **An absent `mcpServers` key discovers `.mcp.json` before `mcp.json`, and a malformed first
    convention cannot hide a usable second one.** `MCP_CONVENTION_FILES` and `resolveMcpServers`
    (`packages/kernel/src/plugins/plugin-manifest.ts:101-102`, `:763-778`). Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:272-295`.

78. **A plugin-owned MCP hook matcher uses the same host-owned install namespace as runtime
    dispatch.** Both manifest readers pass their install identity to `resolvePluginManifest`
    (`packages/kernel/src/plugins/plugin-service.ts:74-86`,
    `packages/kernel/src/plugins/plugin-contributions.ts:245-258`); MCP resolution precedes hook
    conversion (`packages/kernel/src/plugins/plugin-manifest.ts:960-983`), and translation qualifies
    only an owned server (`packages/kernel/src/plugins/hook-dialects.ts:340-370`, `:405-458`). Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:692-732`.

79. **External `UserPromptExpansion` and `Skill` names map to exact Clarvis concepts, never an
    approximation.** The shared correspondence owns the event/tool aliases, and conversion consumes
    it (`packages/kernel/src/plugins/hook-dialects.ts:38-76`, `:449-452`). Pinned:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:1004-1019`.

80. **A translated external MCP hook receives the external server/tool spelling on stdin without
    leaking the Clarvis plugin namespace.** The runtime carries the canonical full name as a match
    alias, while serialization strips only the plugin segment and emits `mcp__<server>__<tool>`
    (`packages/hooks/src/event-serialization.ts:106-120`, `:213-220`). Pinned by
    `packages/hooks/tests/component/capability.test.ts:431-453`.

81. **A leading relative executable in a translated external hook is anchored to the plugin root;
    native Clarvis hook commands are not rewritten.** Production:
    `packages/kernel/src/plugins/hook-dialects.ts:611-616,632-649`; test:
    `packages/kernel/tests/integration/plugin-manifest.test.ts:880-904,1291-1310`.

82. **A portable Agent Plugin root manifest is authoritative and version-exact.** A root document
    claiming an Agent Plugins schema cannot be hidden by a host-specific manifest; the canonical v1
    URL is accepted and another claimed version fails rather than being interpreted as native.
    Production: `claimsAgentPluginFormat`, `readPluginManifestSource`, and
    `normalizeAgentManifest` in `packages/kernel/src/plugins/plugin-manifest.ts`. Test: the portable
    authority and unsupported-schema cases in
    `packages/kernel/tests/integration/plugin-manifest.test.ts`.

83. **Portable skills and MCP obey component-local failure boundaries.** Strict immediate-child
    Agent Skills discovery, complete portable frontmatter validation, and symlink confinement can
    drop only the offending skill surface; an invalid top-level `mcp.json` drops MCP only, and an
    invalid server or post-normalization host-bound violation drops only that server. Production:
    `pluginSkillScanRoots`, `normalizeAgentMcp`, and `mcpServerPluginSchema` validation in
    `packages/kernel/src/plugins/plugin-manifest.ts`, plus
    `assertRootValidation` in `packages/skills/src/registry.ts`. Test: the `Agent Plugins v1 package`
    cases in `packages/kernel/tests/integration/plugin-manifest.test.ts` and the Agent-plugin policy
    cases in `packages/skills/tests/integration/{discovery,scan}.test.ts`.

84. **Portable runtime placeholders are expanded exactly once under client ownership.** Only
    `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in stdio args/env/cwd are expanded; remote URL/header text
    and every other placeholder remain literal, and `expandVariables: false` prevents a second
    Clarvis interpolation pass. The persistent data directory is exact-ref-qualified and is created
    before the active manifest resolves. Production: `normalizeAgentMcpServer` and
    `ensurePluginDataDir`; transport propagation through `@clarvis/loop` and
    `@clarvis/mcp-client`. Test:
    `packages/kernel/tests/integration/plugin-manifest.test.ts`,
    `packages/kernel/tests/unit/plugin-runtime.test.ts`, and
    `packages/mcp-client/tests/component/transport-builder.test.ts`.

## 6. Failure modes and degradation

### 6.1 Manifest resolution — what is fatal to the *plugin*

Common parse failures and dialect-level manifest validation set `ResolvedPluginManifest.error`
(`resolvePluginManifest` and `normalizeAgentManifest` in
`packages/kernel/src/plugins/plugin-manifest.ts`):

| Condition | Error text | Line |
|---|---|---|
| raw text over `manifestBytes` | "plugin manifest exceeds the …-byte resource limit" | `:944-948` |
| not JSON | "invalid JSON: …" | `:950-955` |
| JSON but not an object | "a plugin manifest must be a JSON object" | `:956-958` |
| native/borrowed document fails `pluginManifestSchema` | `<issue.path>: <issue.message>`, or the resource message | `parsePluginManifest` branch |
| claimed Agent Plugins manifest is not root canonical v1 or fails its schema | exact portable-format/schema issue | `normalizeAgentManifest` |

Everything else — an absent hooks file, non-JSON hooks, an unrecognized hooks shape, a hooks path
outside the plugin, an oversized hooks document, a missing/unusable/oversized declared or
conventional native `mcpServers` companion, a portable `mcp.json` top-level failure,
an unusable individual server entry, an unreadable presentation block, an unscannable `skills`
location, unknown or misspelled keys — becomes a note. Each is pinned in
`packages/kernel/tests/integration/plugin-manifest.test.ts` (§5 invariants 14, 17, 19, 21).

### 6.2 Loading for a run — what is fatal to the *contribution*

`loadableOf` (`packages/kernel/src/plugins/plugin-contributions.ts:244-281`) drops the plugin
entirely for: no install directory, no readable manifest source, a manifest that did not resolve, an
`agents/` surface that failed its budgets, or an invalid install record. Each logs
`kernel.plugin.skipped { plugin, scope, phase, cause }` at `warn` (`:170-180`). A plugin whose skill
roots do not exist, or whose skill-root budget is spent, is reported at `phase: "skills"` and
contributes no roots — but still contributes agents, hooks and MCP servers (`:310-353`).

### 6.3 Kernel errors from the plugin service

| Code | Raised by | Line |
|---|---|---|
| `invalid_request` | manifest unusable at install; update naming a different plugin; subdir escaping the checkout; subdir not a directory; not installed from git; install-record over budget; name already installed | `packages/kernel/src/plugins/plugin-service.ts:390`, `:418`; `packages/kernel/src/adapters/git/plugin-fetcher.ts:72-79`, `:164`; `packages/kernel/src/adapters/filesystem/plugin-repository.ts:31-34`, `:189-192` |
| `not_found` | update/uninstall of a plugin not installed globally | `packages/kernel/src/plugins/plugin-service.ts` |
| `conflict` | selected plugin update/uninstall overlaps an active run or another selected-plugin mutation | `withSelectedMutation` in `packages/kernel/src/kernel.ts` |
| `unavailable` | a selected plugin changed successfully and the stale kernel has not reconnected | selected-plugin guard in `withOwnerRunLease` in `packages/kernel/src/kernel.ts` |
| `resource_exhausted` | install-root fanout | `packages/kernel/src/adapters/filesystem/plugin-repository.ts:165` |
| plain `Error` | `validateGitUrl` refusals; `git <cmd> failed: …` | `packages/kernel/src/plugins/plugin-service.ts:49-66`; `packages/kernel/src/adapters/git/plugin-fetcher.ts:84-87` |

### 6.4 Timeouts, retries, cancellation

- Git subprocesses: 120 s (`packages/kernel/src/adapters/git/plugin-fetcher.ts:12`, `packages/code/src/adapters/plugin-install.ts:5`). The client-side variant
  kills the process on timeout (`packages/code/src/adapters/plugin-install.ts:121`).
- Synchronous `git` reads inside `revisionOf` and `gitValue`: 5 s, output capped at
  `installRecordBytes` (`packages/kernel/src/plugins/plugin-contributions.ts:218-223`, `packages/kernel/src/adapters/filesystem/plugin-repository.ts:43-48`). Both treat
  any non-zero exit as "no value".
- An in-flight `install`/`update` registers an `AbortController` with the kernel lifecycle and is
  aborted on `close()` (`packages/kernel/src/plugins/plugin-service.ts:384`, `:410`). Pinned:
  `packages/kernel/tests/integration/plugin-service.test.ts:352-375`.
- **There is no retry anywhere in this subsystem.** A failed clone, fetch or reset propagates.
  `MarketplaceAdapter.load()` retries a previously-errored source only on the next `load()` call,
  which is a re-attempt rather than a retry policy (`packages/code/src/adapters/marketplace.ts:294`).
- **`ProcessRunner.run` settles exactly once**, guarded by a `settled` flag inside `finish()`
  (`packages/kernel/src/adapters/process/node-process-runner.ts:79-88`): whichever of `close`, `error`,
  abort or timeout fires first wins, and the timeout timer is cleared on any earlier settlement so a
  finished process never times out after the fact. Pinned by
  `packages/kernel/tests/integration/local-observability.test.ts:10-40` for the failure/success/no-logger
  cases; the timeout and cancellation branches have no dedicated test in that suite.

### 6.5 Silently tolerated

- Non-`.md` files under `agents/` are ignored (`packages/loop/src/settings/plugin-agents.ts:104`).
- `interface` keys beyond `displayName`/`shortDescription` are dropped with no note
  (`packages/kernel/src/plugins/plugin-manifest.ts:717-719`).
- `mcpServerPluginSchema` drops unknown per-server keys without a note
  (`packages/loop/src/settings/settings-schema.ts:216-219`) — the *entry* is noted only when the refinement rejects it.
- Duplicate skill-root declarations are de-duplicated with no note (`packages/kernel/src/plugins/plugin-manifest.ts:195`).
- `skillNamesOf` swallows a throw from `createAgentSkills` and returns empty
  (`packages/kernel/src/plugins/plugin-service.ts:238-240`).
- A `directoryNames` / agent-walk `ENOENT`/`ENOTDIR` mid-read is treated as an empty directory
  (`packages/kernel/src/adapters/filesystem/plugin-repository.ts:81-84`, `packages/loop/src/settings/plugin-agents.ts:78-80`).

## 7. Coupling

### 7.1 Outbound (runtime, static)

| From | To | What forces it |
|---|---|---|
| `packages/kernel/src/plugins/plugin-manifest.ts:13-21` | `@clarvis/loop/host` | value imports of `PLUGIN_RESOURCE_LIMITS`, `parsePluginManifest`, `readBoundedPluginText`, `mcpServerPluginSchema`, `suspectedManifestTypos`, `unknownManifestKeys` |
| `packages/kernel/src/plugins/hook-dialects.ts:28-36` | `@clarvis/capability` | the two correspondence tables, `MAX_HOOK_TIMEOUT_MS`, `OBSERVER_HOOK_EVENTS`, `normalizeToolName` |
| `packages/kernel/src/plugins/plugin-contributions.ts:20-21` | `@clarvis/paths`, `@clarvis/skills` | `globalPaths(...).pluginsDir` and `withoutGitRepositoryEnvironment`; `MAX_SKILL_ROOTS` |
| `packages/kernel/src/plugins/plugin-service.ts:8` | `@clarvis/skills` | `createAgentSkills` — the panel runs the real catalog scan |
| `packages/kernel/src/adapters/git/plugin-fetcher.ts:5` | `ports/process-runner.js` | git runs through the injected `ProcessRunner`, never `child_process` directly |
| `packages/kernel/src/plugins/plugin-service.ts:19` | `adapters/process/node-process-runner.js` | default `ProcessRunner` when the host supplies none (`:297`) — the same adapter class `createGitPluginFetcher` is handed by injection |
| `packages/code/src/adapters/marketplace.ts:10` | `@clarvis/kernel/config` | `marketplaceSchema` (which is `@clarvis/loop`'s, re-exported twice) |
| `packages/code/src/adapters/marketplace.ts:4-9` | `@clarvis/paths` | `MARKETPLACE_FILE`, `agentsMarketplaceFile(s)`, `isAgentsMarketplaceFile` |

`hook-dialects.ts`'s own docstring records why the translation is in the kernel and not in the two
places it might have gone: the engine's manifest schema is on an eager import path "where filesystem
I/O must not happen", and `@clarvis/hooks` "is an optional dependency the kernel does not have and
must not gain, or `builtins.hooks = false` would stop meaning what it says"
(`packages/kernel/src/plugins/hook-dialects.ts:15-21`).

`EXTERNAL_HOOK_EVENTS` is computed by inverting `EXTERNAL_HOOK_EVENT_NAMES` at module load
(`:52-54`) precisely so no second table can drift — the docstring names the failure mode: "a hook
would install, be approved and run, while reading an event name that never matches the one it was
translated from" (`:44-46`).

### 7.2 Inbound

| Consumer | What it uses | Line |
|---|---|---|
| `packages/kernel/src/file-kernel.ts:401-412` | constructs `PluginContributions` and hands it to the config store | |
| `packages/kernel/src/config/file-config-store.ts:648-653` | `settingsScopes` folded into the settings merge | |
| `packages/kernel/src/file-kernel.ts:624-628, 765-766` | `skillRoots`/`skillBootstraps` into `buildExecuteRunDeps` | |
| `packages/kernel/src/file-kernel.ts:635-664, 821-828` | `skillPlansMode`, `locateCapabilityExecutable` for Plans and Memory plugin providers | |
| `packages/kernel/src/tasks/task-provider-factory.ts:201-221` | `mcpServers` for provider identity | |
| `packages/kernel/src/kernel.ts:723` | `createPluginService` | |
| `packages/kernel/src/transport/operations.ts:289-335` | the seven wire methods | |
| `packages/code/src/app/commands.tsx` (`pluginsStore`, plugin/marketplace/extension view registrations, `installAndActivatePlugin`) | the store, the three browsers and the adapter | |

**`createPluginContributions` and `createPluginService` are two separately constructed object
graphs, not one "plugin subsystem".** `createFileKernel` builds `pluginContributions`
(`packages/kernel/src/file-kernel.ts:401-405`) and hands it to `createFileConfigStore`; `createInProcessKernel` — called
later, from inside `createFileKernel` — independently builds `createPluginService`
(`packages/kernel/src/kernel.ts`) with an `enabledPlugins` closure over the pinned
`SettingsSnapshot.active_plugins`. Both therefore receive the same resolved Environment identities,
but neither construction holds a reference to the other; each is passed the same global/home/
workspace roots independently at its composition site.

### 7.3 Type-only edges

`packages/kernel/src/ports/plugin-repository.ts:1-2` imports `PluginAgentFile` from
`@clarvis/loop/host` and `Scope` from `@clarvis/protocol` as **types only** — the port itself has no
runtime dependency. `packages/code/src/adapters/plugins.ts:2-6` imports only types from
`@clarvis/protocol`.

### 7.4 The direction the tests enforce

`packages/kernel/tests/architecture/external-tool-names.test.ts` is the only cross-package
architectural lock in this document's scope: it imports `@clarvis/capability`'s tables and
`@clarvis/tools`'s registry together and fails if a rename in either desynchronizes them
(`:19-34`). Nothing in this document's scope enforces the reverse — that `@clarvis/kernel/plugins`
must not import `@clarvis/hooks`, which the `hook-dialects.ts` docstring asserts as a rule
(`:18-21`).

### 7.5 A deliberate duplication

`validateGitUrl` exists twice, byte-for-byte identical in body and message text:
`packages/kernel/src/plugins/plugin-service.ts:46-68` and
`packages/code/src/adapters/plugin-install.ts:73-99`, each with its own copy of `LOCAL_PATH_RE`
(`:38` and `:61`) carrying the same docstring. `@clarvis/code` uses its own copy in
`fetchMarketplace` (`packages/code/src/adapters/marketplace.ts:14`, `:212`) because the marketplace
clone is a client-side seam that never goes through the kernel. Both copies are separately pinned
(`packages/kernel/tests/integration/plugin-service.test.ts:227-243`, `packages/code/tests/integration/plugin-install.test.ts:13-45`), so the duplication is guarded by
duplicated tests rather than by a drift lock.

## 8. Open questions

- ~~**Why the plugin-skill-root budget is `MAX_SKILL_ROOTS - 8` specifically.**~~ **Resolved by
  reading the other side.** The host contributes exactly **four** roots, not three categories:
  `clarvisSkillRoots` returns `.agents` and `.clarvis` at user and workspace scope each
  (`packages/skills/src/preset.ts:40`–`:45`). The reserve is therefore double what the host spends,
  and the docstring now says so along with why the margin is deliberate — adding a host root must not
  silently narrow what plugins may contribute, and the cost of being one short is not the marginal
  plugin's skills but every skill in the workspace, since the refusal degrades to an empty provider
  (`packages/kernel/src/plugins/plugin-contributions.ts:138`–`:154`). Still true: no test pins the
  shared budget; only the per-plugin cap of 4 is pinned
  (`packages/kernel/tests/integration/plugin-manifest.test.ts:207-213`).

- **Which agent hosts the dialect tables were derived from.** `packages/kernel/src/plugins/hook-dialects.ts:6-13` states this is
  deliberate: "Naming the hosts would date the file and invite a class per vendor". The public
  catalog measured at 196 plugins is cited repeatedly
  (`packages/loop/src/settings/settings-schema.ts:212-214`,
  `packages/capability/src/hooks-config.ts:106-109`,
  `packages/kernel/src/plugins/plugin-manifest.ts:137-141`) but never named, and the measurements are
  not reproducible from anything in the repository.

- ~~**`dependencies` in the manifest is declared and never read.**~~ **Resolved 2026-08-22 —
  removed from the schema, which is what makes it visible.** It validated as `array(pluginNameField)`
  and described the names as "other plugins that must be enabled for this one to work", and nothing
  in `plugin-contributions.ts`, `plugin-service.ts` or `file-config-store.ts` consulted it — so a
  plugin declaring a dependency installed and ran with that dependency absent, silently. That is the
  exact failure `pluginManifestSchema`'s own `.loose()` remark exists to prevent: recognizing a
  directive and then ignoring it is worse than not recognizing it, because only the second one is
  reported. Off the shape it lands in `unknownManifestKeys`, and the operator is told "manifest keys
  Clarvis does not act on: dependencies" — pinned by
  `packages/kernel/tests/integration/plugin-manifest.test.ts`. Enforcing dependencies remains
  unbuilt, and is now a decision with nothing pretending to stand in for it.

- **`code`'s marketplace has no kernel service, while plugin installation does.** Installation goes
  through `KernelClient.plugins.install`, whose contract says the service must be server-side because
  "a remote UI has no local git or fs" (`packages/protocol/src/plugins.ts:4`); the marketplace
  catalog clone spawns `git` on the machine `code` runs on
  (`packages/code/src/adapters/marketplace.ts`). **Recorded 2026-08-22 at `fetchMarketplace`**, with
  the consequence derived rather than the intent guessed: against an in-process kernel the two are
  indistinguishable — same machine, same disk — which is why the split has cost nothing; against a
  remote kernel it splits in the wrong place, since installing would reach the kernel's filesystem
  while adding a marketplace would clone onto the operator's laptop and validate a document
  describing plugins the kernel will never see. Whether the answer is a `MarketplaceService` on the
  protocol or a decision that catalogs are deliberately client-side is **not settled by the source and has not been
  decided**.

- **`PLUGIN_RESOURCE_LIMITS.skillDirectoryEntries` is not consumed anywhere in this document's scope.**
  It is declared at `packages/loop/src/settings/plugin-resources.ts:20` and exercised at
  `packages/kernel/tests/integration/plugin-service.test.ts:268-281`, where the enforcement happens inside `@clarvis/skills` —
  delegated to [execution/skills.md](../execution/skills.md).

- ~~**The panel's displayed revision and a run's MCP-provenance revision can disagree, with no test
  proving either side of it wrong... whether the asymmetry is intentional... is not stated.**~~
  **Resolved: each side's own local rationale is on record, and together they account for the
  asymmetry.** `inspectPlugin` (`packages/kernel/src/adapters/filesystem/plugin-repository.ts:107-112`) prefers live
  `git` state over the install record; `revisionOf` (`packages/kernel/src/plugins/plugin-contributions.ts:215-227`) prefers the
  install record over `git`, falling to a live `git rev-parse HEAD` only when "unmanaged local
  plugins have no install record" (`:208-209`'s comment). The protocol field `inspectPlugin` populates
  is itself documented as "Resolved Git revision of the **installed checkout**"
  (`packages/protocol/src/plugins.ts:65`, emphasis added) — i.e. the panel's job is to show what is
  *actually on disk right now*, so a plugin directory a user `git pull`-ed by hand outside Clarvis's
  own install flow shows its true current state rather than a possibly-stale record. `revisionOf`'s
  own comment states the opposite goal: "Resolve the installed snapshot **without treating the
  manifest version as source identity**" (`:208`) — its caller needs a value that stays **pinned** to
  what Clarvis itself installed/recorded, because it becomes the run's MCP-provenance identity
  (`packages/kernel/src/tasks/task-provider-factory.ts:294-304`, threading `resolvedRevision` into a
  `taskProviderKey`) — a value that must not silently change between two runs just because someone
  ran `git pull` in the plugin's checkout in between. So: the panel optimizes for "what is checked out
  now" (display), `revisionOf` optimizes for "what was installed" (stable per-run identity) — two
  different purposes for two different consumers, each stated in its own local comment, even though
  neither module cross-references the other's reasoning. No test exercises both readers against the
  same manually-advanced checkout to observe the resulting display/provenance mismatch directly, but
  the *design intent* behind the asymmetry is no longer undetermined.

- **The four `PluginContributions` skill/agent readers each call `loadableOf` afresh.** `skillRoots`,
  `agents`, `readAgent`, `locateCapabilityExecutable` and `skillPlansMode` all re-read the manifest,
  the agent tree and the install record from disk on every call
  (`packages/kernel/src/plugins/plugin-contributions.ts:285-295`, `:400-432`). The docstring says contributions are read "fresh
  on each call" (`:134-136`) but gives no cost model, and nothing measures it.

- **`code`'s marketplace clone bypasses the kernel entirely**
  (`packages/code/src/adapters/marketplace.ts:212-226` spawns git through `Bun.spawn`), while plugin
  *installation* goes through `KernelClient.plugins.install`. The protocol docstring says the plugin
  service "must be server-side (a remote UI has no local git or fs)"
  (`packages/protocol/src/plugins.ts:4`); the marketplace has no such service, so a remote kernel
  would leave the Marketplace browser reading the *client's* filesystem and network. Whether a
  `MarketplaceService` is planned is not settled by the source.

- **Delegated to sibling documents, and deliberately not described here:** hook *execution* and the stdin
  payload dialect ([execution/hooks.md](../execution/hooks.md)); `SKILL.md` parsing, grouping, precedence and the
  `MAX_SKILL_ROOTS` refusal itself ([execution/skills.md](../execution/skills.md)); the ownership and content of
  `EXTERNAL_HOOK_EVENT_NAMES` / `EXTERNAL_TOOL_NAMES` / `EXTERNAL_TOOLS_WITHOUT_COUNTERPART` as an
  interop contract ([cross-cutting/agent-interop.md](../cross-cutting/agent-interop.md)); the capability-executable subprocess
  protocol, session manager and provider registries ([capabilities/provider-executables.md](../capabilities/provider-executables.md)); settings
  merge order, CAS revisions and workspace trust as a whole ([hosts/kernel-config.md](kernel-config.md)); the config
  view-host, navigation and level-key primitives the three browsers are built on
  ([hosts/code-settings-panels.md](code-settings-panels.md)).
