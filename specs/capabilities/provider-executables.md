# Replacing a capability: provider registries, executables and the RPC protocol

> Implemented at `packages/capability/src/capability-executables.ts`,
> `packages/kernel/src/capability-executables/session-manager.ts`,
> `packages/memory/src/{provider-registry,provider,wiki-provider,file-provider,mcp-provider,executable-provider}.ts`,
> `packages/plan/src/{provider,provider-config}.ts`,
> `packages/code/src/adapters/capability-providers.ts` and
> `packages/code/src/views/config/CapabilityProvidersPanel.tsx`, plus a narrow cross-reference into
> `packages/memory/src/factory.ts` and `packages/memory/src/capability.ts` (§7) to describe how the
> one caller outside this document's own modules invokes `resolveMemoryProvider`. Every claim below is
> anchored to a file and line. Open questions are collected in the final section.

## 1. Purpose

Two Clarvis capabilities — memory (`@clarvis/memory`) and plans (`@clarvis/plan`) — each have a
**built-in implementation** (a markdown wiki, a markdown plan file) but are also each declared as a
**substitutable provider**: an operator's `settings.json` can point either capability at something
else entirely, without the loop, the model-facing tool vocabulary, or an agent's profile changing at
all. `packages/memory/src/provider.ts:1-11` states the shape directly: "A provider supplies the
*content* of memory... It never supplies the *vocabulary*... That is what lets a workspace swap its
memory without rewriting a prompt, moving a grant, or changing anything an agent profile says."

One provider kind, `executable`, is the general mechanism this document covers: a **language-neutral
JSON-RPC subprocess protocol**, defined once in `@clarvis/capability`
(`packages/capability/src/capability-executables.ts`), so any process — Python, a Go binary, a shell
script wrapping a real database — can stand in for a capability's built-in store. The kernel owns a
single long-lived subprocess pool for this protocol
(`packages/kernel/src/capability-executables/session-manager.ts`), shared by both memory and plans.
A plugin may *offer* such an executable in its manifest (`capabilityExecutables:` —
`packages/loop/src/settings/plugin-schema.ts:75-80`), but only an operator's own settings selects it
for a capability (`packages/memory/src/provider-registry.ts:64-72`,
`packages/plan/src/provider.ts:25-29`) — installing or enabling a plugin never activates its
provider by itself.

The mechanism solves one narrow problem: letting a capability's *content* be swapped for an external
system while keeping the tool names, descriptions and schemas the model sees byte-identical to the
built-in case. The resulting subprocess is launched directly with an argv vector — no shell parses
the command — but it is **not** placed in Clarvis's workspace sandbox: the kernel calls native
`Bun.spawn([command, ...args], { cwd, env, ... })` directly
(`packages/kernel/src/capability-executables/session-manager.ts:152-167`). Its declaration is resolved
against the environment snapshot supplied when the manager is constructed
(`packages/capability/src/capability-executables.ts:49-64`). The one motivating case the code states
in its own words is the `mcp` memory-provider kind's doc comment — "an organisation with a knowledge
base behind an API, and no appetite for a second copy of it inside a workspace"
(`packages/memory/src/mcp-provider.ts:5-7`) — which is a *tool-server* case (§4a's `"mcp"` arm), not
the subprocess `executable` kind this document is otherwise about; no comparable motivating text exists
for the subprocess case itself.

## 2. Surface

### 2a. The protocol contract — `@clarvis/capability/src/capability-executables.ts`

| Symbol | Kind | Line | What it is |
|---|---|---|---|
| `CAPABILITY_EXECUTABLE_PROTOCOL_VERSION` | const | `packages/capability/src/capability-executables.ts:6` | `1 as const` |
| `capabilityExecutablePlatformSchema` | zod schema | `packages/capability/src/capability-executables.ts:11-17` | `{ command?, args?, env? }`, `.strict()` |
| `capabilityExecutableDeclarationSchema` | zod schema | `packages/capability/src/capability-executables.ts:20-28` | `{ command, args=[], env={}, platforms?, timeout_ms=30_000 }`, `.strict()` |
| `capabilityExecutablesSchema` | zod schema | `packages/capability/src/capability-executables.ts:31-34` | `z.record(name, declaration)` — plugin-manifest map |
| `resolveCapabilityExecutable(declaration, platform, environment)` | function | `packages/capability/src/capability-executables.ts:49-64` | pure: declaration + host platform + env snapshot → `EffectiveCapabilityExecutable` |
| `CapabilityExecutableRpcError` | class (extends `Error`) | `packages/capability/src/capability-executables.ts:97-112` | carries `rpcCode` and a `.domainCode` getter over `data.code` |
| `EffectiveCapabilityExecutable` | interface | `packages/capability/src/capability-executables.ts:40-46` | `{ command, args, env, timeout_ms, platform }` — post-resolution |
| `CapabilityExecutableInitialization` | interface | `packages/capability/src/capability-executables.ts:67-71` | `{ protocol_version: 1, provider_kind, writable? }` |
| `CapabilityExecutableSession` | interface | `packages/capability/src/capability-executables.ts:74-79` | `{ providerKind, writable?, request(method, params, signal?), close() }` |
| `CapabilityExecutableSessionInput` | interface | `packages/capability/src/capability-executables.ts:82-89` | `{ capability, workspace, cwd, declaration, owner? }` |
| `CapabilityExecutablePort` | interface | `packages/capability/src/capability-executables.ts:92-94` | `{ session(input): Promise<CapabilityExecutableSession> }` — what a provider package depends on |

### 2b. The kernel's subprocess pool — `packages/kernel/src/capability-executables/session-manager.ts`

| Symbol | Line | What it is |
|---|---|---|
| `createCapabilityExecutableSessionManager(options)` | `packages/kernel/src/capability-executables/session-manager.ts:146-409` | builds a `CapabilityExecutableSessionManager` |
| `CapabilityExecutableSessionManagerOptions` | `packages/kernel/src/capability-executables/session-manager.ts:42-46` | `{ environment, platform?, logger? }` |
| `CapabilityExecutableSessionManager` | `packages/kernel/src/capability-executables/session-manager.ts:49-51` | `CapabilityExecutablePort & { close(): Promise<void> }` |

Re-exported from `@clarvis/kernel/local` (`packages/kernel/src/local.ts:36-39`); not on the kernel's
default `.` export.

### 2c. Memory's provider surface — `packages/memory/src/provider-registry.ts`, `provider.ts`

| Symbol | Line | What it is |
|---|---|---|
| `resolveMemoryProvider(config, ctx)` | `packages/memory/src/provider-registry.ts:134-257` | config (or `undefined` ⇒ wiki) + resolution context → `ProviderResolution` |
| `ProviderResolutionContext` | `packages/memory/src/provider-registry.ts:29-73` | `workspaceRoot, wiki?, seedMaxChars, executablePort?, owner, logger?, serverPort?, pluginPort?` |
| `MemoryPluginPort` | `packages/memory/src/provider-registry.ts:84-95` | `{ locate(plugin): { root, declaration } \| { error } }` |
| `ProviderResolution` | `packages/memory/src/provider-registry.ts:104-106` | `{ ok: true, provider, key, seedMaxChars } \| { ok: false, failure: { kind, reason } }` |
| `MEMORY_READ_TOOL_NAMES` | `packages/memory/src/provider.ts:29-34` | `["list_memories","read_memory","grep_memories","query_memories"]` |
| `MEMORY_WRITE_TOOL_NAMES` | `packages/memory/src/provider.ts:43` | `["write_memory","edit_memory","delete_memory"]` |
| `WIKI_PROVIDER_KIND` | `packages/memory/src/provider.ts:46` | `"wiki"` |
| `assertProviderVocabulary(provider)` | `packages/memory/src/provider.ts:66-71` | calls the per-half `check()` helper (`packages/memory/src/provider.ts:74-100`) twice — once for `readTools`, once for `writeTools` when present — which is where the actual name/description/schema-drift comparison and throw live |

Memory's four built-in provider implementations, by exported symbol (each detailed further in
§4a's subsections):

| Symbol | Line | What it is |
|---|---|---|
| `FILE_PROVIDER_KIND` | `packages/memory/src/file-provider.ts:19` | `"file"` |
| `FileMemoryProviderOptions` | `packages/memory/src/file-provider.ts:22-30` | `{ workspaceRoot, paths, maxPaths?, maxDocumentBytes?, maxAggregateBytes? }` |
| `createFileMemoryProvider(opts)` | `packages/memory/src/file-provider.ts:176-323` | builds the read-only, always-uncached file provider |
| `MCP_PROVIDER_KIND` | `packages/memory/src/mcp-provider.ts:33` | `"mcp"` |
| `MemoryServerPort` | `packages/memory/src/mcp-provider.ts:43-50` | `{ callTool(server, tool, args, signal?): Promise<{text, isError}> }` — the host's narrow tool-call seam |
| `MemoryServerPortResolver` | `packages/memory/src/mcp-provider.ts:59-61` | `{ forOwner(owner): MemoryServerPort }` |
| `McpToolMapping` | `packages/memory/src/mcp-provider.ts:71-79` | Clarvis operation name → remote tool name, four required + three optional-as-a-set |
| `McpMemoryProviderOptions` | `packages/memory/src/mcp-provider.ts:82-105` | `{ server, tools, seedTool?, port, logger? }` |
| `createMcpMemoryProvider(opts)` | `packages/memory/src/mcp-provider.ts:161-206` | builds the tool-server-backed provider; throws on a partial write mapping |
| `EXECUTABLE_MEMORY_PROVIDER_KIND` | `packages/memory/src/executable-provider.ts:20` | `"executable"` — exported but never assigned to a built provider's `kind` (see §4a) |
| `ExecutableMemoryProviderOptions` | `packages/memory/src/executable-provider.ts:22-28` | `{ declaration, cwd, workspaceRoot, owner, port }` |
| `createExecutableMemoryProvider(opts)` | `packages/memory/src/executable-provider.ts:64-95` | opens one session and wraps it in the seven memory tool names |

Settings-visible `memory.provider` shapes (`packages/memory/src/schemas.ts:72-138`,
`memoryProviderSchema`, a `z.discriminatedUnion("kind", …)`):

| `kind` | Extra fields | Line |
|---|---|---|
| `"wiki"` | none | `packages/memory/src/schemas.ts:74-79` |
| `"file"` | `paths: string[]` (min 1) | `packages/memory/src/schemas.ts:80-90` |
| `"executable"` | `capabilityExecutableDeclarationSchema` fields | `packages/memory/src/schemas.ts:94-96` |
| `"mcp"` | `server`, `tools: { list_memories, read_memory, grep_memories, query_memories, write_memory?, edit_memory?, delete_memory? }`, `seed_tool?` | `packages/memory/src/schemas.ts:97-121` |
| `"plugin"` | `plugin: string` | `packages/memory/src/schemas.ts:127-137` |

### 2d. Plan's provider surface — `packages/plan/src/provider.ts`, `provider-config.ts`

| Symbol | Line | What it is |
|---|---|---|
| `planProviderConfigSchema` | `packages/plan/src/provider-config.ts:5-9` | `z.discriminatedUnion("kind", [markdown, executable, plugin])` |
| `PlanProviderConfig` | `packages/plan/src/provider-config.ts:12` | inferred type |
| `PlanPluginPort` | `packages/plan/src/provider.ts:25-29` | `{ locate(plugin): { root, declaration } \| { error } }` |
| `ResolvedPlanStore` | `packages/plan/src/provider.ts:32-36` | `{ key, providerKind, store: PlanStore }` |
| `PlanFactory` | `packages/plan/src/provider.ts:39-43` | `{ storeFor(owner): Promise<ResolvedPlanStore>, evictOwner?(owner) }` |
| `createPlanFactory(options)` | `packages/plan/src/provider.ts:294-410` | builds the owner-scoped, settings-sensitive factory |
| `PlanProviderUnavailableError` | `packages/plan/src/provider.ts:55-57` | `CodedError`, code `plan_provider_unavailable` |
| `PlanProviderMismatchError` | `packages/plan/src/provider.ts:60-70` | `CodedError`, code `plan_provider_mismatch` |

`planProviderConfigSchema` variants (`packages/plan/src/provider-config.ts:5-9`): `{ kind: "markdown" }`,
`capabilityExecutableDeclarationSchema.extend({ kind: "executable" })`,
`{ kind: "plugin", plugin: string }`.

### 2e. Plugin manifest contribution — `packages/loop/src/settings/plugin-schema.ts`

`pluginManifestSchema` carries `capabilityExecutables: capabilityExecutablesSchema.optional()`
(`packages/loop/src/settings/plugin-schema.ts:75-80`), keyed by Clarvis capability name (`"memory"`, `"plans"`). Read by the
kernel's `PluginContributions.locateCapabilityExecutable(enabled, capability, plugin)`
(`packages/kernel/src/plugins/plugin-contributions.ts:67-72`, implemented at `:413-426`).

### 2f. `code`'s adapter and panel

| Symbol | File:line | What it is |
|---|---|---|
| `effectivePlanProvider`, `effectiveMemoryProvider` | `packages/code/src/adapters/capability-providers.ts:25-31` | block's `provider` or a built-in default (`{kind:"markdown"}` / `{kind:"wiki"}`) |
| `planProviderLabel`, `memoryProviderLabel` | `packages/code/src/adapters/capability-providers.ts:33-53` | one-line display strings per `kind` |
| `providerPluginOptions(plugins, capability, selected?)` | `packages/code/src/adapters/capability-providers.ts:88-117` | lists installed plugins offering `capability`, gated `not_installed \| broken \| disabled \| not_offered \| ready` |
| `knownPlanProviderKey(provider?)` | `packages/code/src/adapters/capability-providers.ts:123-129` | static identity string for `markdown`/`plugin` selections only; `executable` is "deliberately opaque" |
| `validatePlanProviderDraft`, `validateMemoryProviderDraft` | `packages/code/src/adapters/capability-providers.ts:155-242` | pre-save field-level draft validation |
| `CapabilityProvidersPanel(host, deps)` | `packages/code/src/views/config/CapabilityProvidersPanel.tsx:80` | Solid.js config-view component; also renders the Tasks provider panel (out of this document's scope) |
| `MCP_READ_DEFAULTS` | `packages/code/src/views/config/CapabilityProvidersPanel.tsx:64-69` | default `list_memories`/`read_memory`/`grep_memories`/`query_memories` → same-named remote tool, used to prefill a new MCP-provider draft's `tools` mapping |

The panel's own doc comment (`packages/code/src/views/config/CapabilityProvidersPanel.tsx:75-78`): "Everything shown here is derived
from settings and plugin manifests/trust; opening or navigating the panel never locates, preflights,
or imports code."

## 3. Data and formats

### 3a. The executable declaration (settings / plugin manifest JSON)

```jsonc
{
  "command": "python3",
  "args": ["-B", "server.py", "memory"],
  "env": { "BASE": "${HOST_VALUE}", "SHARED": "base" },
  "platforms": {
    "win32": { "command": "py", "args": ["-3", "-B", "server.py", "memory"], "env": { "SHARED": "windows" } }
  },
  "timeout_ms": 12345
}
```
Defaults when only `command` is given: `args: []`, `env: {}`, `timeout_ms: 30_000`
(`packages/capability/src/capability-executables.ts:20-28`, pinned by
`packages/capability/tests/unit/capability-executables.test.ts:12-19`).

**Resolution** (`resolveCapabilityExecutable`, `packages/capability/src/capability-executables.ts:49-64`): the platform
override's `command`/`args` *replace* the base ones wholesale; `env` *merges* (base then override,
override wins per key); every env **value** is passed through `resolveStringMapWith` so a
`${VAR}` template is substituted from the live `environment` map
(`packages/capability/src/capability-executables.ts:60`, `packages/capability/src/env-interpolate.ts:60-78`). An unresolved `${VAR}` throws
`MissingEnvVarsError` naming the missing names (`packages/capability/src/env-interpolate.ts:72-79`), which
`packages/capability/tests/unit/capability-executables.test.ts:56-62` exercises directly ("fails closed when an environment
interpolation is unresolved").

At spawn time, the resolved declaration env is layered **over the kernel's entire inherited
environment**; entries whose inherited value is `undefined` are the only ones removed
(`processEnvironment`, `packages/kernel/src/capability-executables/session-manager.ts:55-82`, used at
`:162`). This is not the safe-base or allowlist policy used for MCP children and hooks, and it means an
operator-configured capability executable receives every credential present in the kernel process.
The source records that trust-boundary asymmetry explicitly (`:55-73`), and
`packages/kernel/tests/integration/capability-executable-session-manager.test.ts:56-75` verifies both
an inherited value and a declaration value interpolated from that environment.

### 3b. The JSON-RPC wire format (subprocess stdin/stdout, newline-delimited)

Request (host → subprocess), written to `child.stdin`:
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol_version":1,"capability":"memory","workspace":"/abs/ws"}}
```
(`packages/kernel/src/capability-executables/session-manager.ts:276,316-320`.)

Success response (subprocess → host, one line, LF- or CRLF-terminated):
```json
{"jsonrpc":"2.0","id":1,"result":{"protocol_version":1,"provider_kind":"fixture","writable":true}}
```
Error response:
```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"fixture conflict","data":{"code":"plan_conflict"}}}
```
(`packages/kernel/src/capability-executables/session-manager.ts:106-120`, exercised by the fixture at
`packages/kernel/tests/helpers/capability-executable-fixture.ts`.)

Mandatory handshake: the host always calls `initialize` first with
`{ protocol_version: CAPABILITY_EXECUTABLE_PROTOCOL_VERSION, capability, workspace }`
(`packages/kernel/src/capability-executables/session-manager.ts:339-343`); the reply must carry `protocol_version === 1` and a non-empty
`provider_kind` string (`packages/kernel/src/capability-executables/session-manager.ts:127-134`), and, **only when `capability === "memory"`**,
a boolean `writable` (`packages/kernel/src/capability-executables/session-manager.ts:345-348`; the `"plans"` capability has no such requirement).
`close()` sends a best-effort `shutdown` call bounded by `SHUTDOWN_GRACE_MS = 2000` before killing the
process tree regardless of its outcome (`packages/kernel/src/capability-executables/session-manager.ts:322-336`).

### 3c. Memory-specific RPC methods (`packages/memory/src/executable-provider.ts`)

| Method | Params | Result |
|---|---|---|
| `memory/list_memories`, `memory/read_memory`, `memory/grep_memories`, `memory/query_memories`, `memory/write_memory`, `memory/edit_memory`, `memory/delete_memory` | `{ owner, ...toolArgs }` (`packages/memory/src/executable-provider.ts:52`) | `{ text: string, isError: boolean }` (`resultOf`, `packages/memory/src/executable-provider.ts:30-38`) |
| `memory/seed` | `{ owner, task }` | `string \| null` (`packages/memory/src/executable-provider.ts:79-87`) |

Only the read four are called if `session.writable !== true` — the write three are simply never
built into `MemoryProvider.writeTools` (`packages/memory/src/executable-provider.ts:74-78`).

### 3d. Plan-specific RPC methods (`packages/plan/src/provider.ts`)

| Method | Params | Result | Line |
|---|---|---|---|
| `plans/create` | `{ owner, document }` | a `PlanDocument` | `packages/plan/src/provider.ts:180` |
| `plans/read` | `{ owner, id }` | a `PlanDocument` | `packages/plan/src/provider.ts:187` |
| `plans/list` | `{ owner, input }` | `{ plans: PlanDocument[], next_cursor? }` | `packages/plan/src/provider.ts:198` |
| `plans/write` | `{ owner, id, document (sealed), expected: PlanCas }` | a `PlanDocument` | `packages/plan/src/provider.ts:169` |
| `plans/reconcile` | `{ owner, id, known: PlanCas, now? }` | a `PlanDocument` | `packages/plan/src/provider.ts:239` |
| `plans/delete` | `{ owner, id }` | `boolean` | `packages/plan/src/provider.ts:281` |

Every call is wrapped by `documentOf`, which re-validates the reply against
`planDocumentSchema` and throws `InvalidPlanError` on a shape mismatch (`packages/plan/src/provider.ts:109-114`).

### 3e. Identifiers

Two independent digests exist for two different purposes:

1. **Session identity** (kernel-side pooling): `sessionKey(input, executable)`
   (`packages/kernel/src/capability-executables/session-manager.ts:86-104`) is `sha256:` + a hash of
   `{capability, workspace, cwd, command, args, env (key-sorted), timeout_ms, platform}` — computed
   over the **effective** (post-platform-resolution) declaration. **`owner` is not part of the key.**
2. **Provider/store identity** (memory/plan-side memoization and continuation binding):
   - Memory's `providerKey(kind, value)` (`packages/memory/src/provider-registry.ts:109-124`) SHA-256-hashes a
     recursively key-sorted canonical JSON of the pre-resolution config.
   - Plan's `declarationKey(prefix, declaration)` (`packages/plan/src/provider.ts:139-142`) SHA-256-hashes
     `JSON.stringify(declaration)` (no field-order canonicalization) prefixed by `"executable"` or a
     `"plugin:<name>"` key.

### 3f. Owner multiplexing on one subprocess

Because `sessionKey` excludes `owner`, two different owners resolving the *same* effective
declaration on the *same* workspace/cwd share one subprocess — **except** the `"plans"` capability,
which is explicitly restricted: if an existing, non-closed session for the same key already carries a
different `owner`, `session()` throws `"plans executable session already belongs to owner '<x>'
(v1 allows one owner)"` (`packages/kernel/src/capability-executables/session-manager.ts:346-357`), pinned by
`packages/kernel/tests/integration/capability-executable-session-manager.test.ts:170-178`. Memory has
no such check — its executable provider disambiguates by sending `owner` as an RPC parameter on every
call instead (`packages/memory/src/executable-provider.ts:48-58,74,80`).

## 4. Behavior

### 4a. Resolving a memory provider — `resolveMemoryProvider` (`packages/memory/src/provider-registry.ts:134-257`)

| `config?.kind` | Precondition checked | On success | On failure |
|---|---|---|---|
| `undefined` / `"wiki"` | `ctx.wiki` defined | dynamic `import("./wiki-provider.ts")`, wraps `ctx.wiki` | `{ok:false, failure:{kind:"wiki", reason:"no wiki is available for this owner"}}` (`:142-144`) |
| `"file"` | none | dynamic `import("./file-provider.ts")`, `createFileMemoryProvider({workspaceRoot, paths})` | n/a (constructor may still throw; caught below) |
| `"executable"` | discriminant re-check `config?.kind !== "executable"` (`:166-167`, reason `"executable provider needs a command"`); then `ctx.executablePort` defined | dynamic `import("./executable-provider.ts")`, opens a session via `ctx.executablePort` | `{reason:"this host cannot start executables"}` (`:170`) |
| `"mcp"` | discriminant re-check `config?.kind !== "mcp"` (`:188-192`, reason `"mcp provider needs a server and mapping"`); then `ctx.serverPort` defined | dynamic `import("./mcp-provider.ts")` | `{reason:"this host cannot reach tool servers for memory"}` (`:196-198`) |
| `"plugin"` | discriminant re-check `config?.kind !== "plugin"` (`:215-216`, reason `"plugin provider needs a plugin name"`); then `ctx.pluginPort` and `ctx.executablePort` both defined; `pluginPort.locate` succeeds | dynamic `import("./executable-provider.ts")` (same module as `"executable"`), using the located `{root, declaration}` | `{reason:"this host has no plugins"}` / `{reason:"this host cannot start executables"}` / `located.error` (`:218-227`) |
| anything else | — | — | `{reason: "unsupported memory provider '<kind>'"}` (`:245-258`; unreachable given the zod discriminated union, kept for a plugin-contributed future kind) |

The whole `switch` is wrapped in one `try/catch`: any thrown error from a provider constructor or the
plugin-locate call becomes `{ok:false, failure:{kind, reason: err.message}}` rather than propagating
(`:260-265`) — **`resolveMemoryProvider` never throws**, per its own doc comment
(`:127-133`, "never throws for a declaration this build does not support, so a host can report the
reason instead of crashing a run"). Every arm's `Precondition checked` column lists only the
port/context checks; the discriminant re-checks above are a second, narrower layer each non-`wiki`/
`file` arm adds for the case where `config` narrowed on `kind` from the outer `switch` but is not
actually the expected variant (structurally unreachable given the discriminated union, but present as
a defensive check with its own failure reason).

**The `"executable"` provider's resulting `kind` is the subprocess's own declaration, not the
constant.** `createExecutableMemoryProvider` sets `MemoryProvider.kind` to `session.providerKind` —
the `provider_kind` string the child self-reported at `initialize` (§3b) — never to the module's
exported `EXECUTABLE_MEMORY_PROVIDER_KIND` (`"executable"`), which the module exports but never
assigns to a built provider (`packages/memory/src/executable-provider.ts:75` vs. the unused constant at
`packages/memory/src/executable-provider.ts:20`). This is exactly the `"fixture"` value used as the worked wire-format
example in §3b.

#### The file provider (`file-provider.ts`)

The one read-only, no-subprocess memory-provider kind. `confine(workspaceRoot, declared)`
(`packages/memory/src/file-provider.ts:73-79`) rejects an absolute declared path and rejects any path whose
workspace-relative resolution escapes the root (`rel.startsWith("..")`); `loadAll` then re-checks the
*target* the same way after a `realpath` (`:126-132`), so a symlink that only resolves to an
escaping target outside the workspace is caught even when the declared path itself looked confined.
Three byte limits are validated at construction via `providerLimit` against
`MEMORY_STORAGE_LIMITS` — `maxPaths` (default 64), `maxDocumentBytes` (default 1 MiB),
`maxAggregateBytes` (default 8 MiB) (`FILE_MEMORY_DEFAULT_LIMITS`, `:32-36`; validation calls,
`:176-197`) — and each of `list_memories`/`read_memory`/`grep_memories`/`query_memories`/`seed`
appends its own `"[... incomplete: provider byte budget reached]"` marker when a limit truncated the
read (`:204-323`). The provider declares no `writeTools` and schedules no post-run indexing
(`packages/memory/src/file-provider.ts:6-8`), and — per its own doc comment — **every call re-reads from disk**: "a
cached copy would answer with what was true at run start" (`:171-175`).

#### The MCP provider (`mcp-provider.ts`)

Reaches a tool server the host already knows how to call, rather than a subprocess. It declares its
own structural port, `MemoryServerPort` (`:43-50`) — `callTool(server, tool, args, signal?)` — plus
`MemoryServerPortResolver` (`:59-61`) for binding one to an owner; the module's own doc comment states
it "names no MCP type and imports no MCP package" (`:10-16`). `McpToolMapping` (`:71-79`) maps each of
the seven Clarvis operation names to a remote tool name. `writeHalfOf` (`:144-148`) enforces "all
three or none": `createMcpMemoryProvider` throws a constructor `Error` naming the offending partial
set when the mapping declares some but not all of `write_memory`/`edit_memory`/`delete_memory`
(`:161-168`). A failed `seed` call is logged, never thrown into the run: `seedFailed` emits
`event: "memory.seed.provider_failed"` (`:171-176`); an `isError: true` result logs a fixed string
rather than the tool's own response text, so nothing there needs sanitizing (`:191-193`), while a
*thrown* seed error runs the caught message through `sanitizeErrorMessage` before logging it
(`:196-198`).

### 4b. Resolving a plan store — `PlanFactory.storeFor(owner)` (`packages/plan/src/provider.ts:321-402`)

1. Load and zod-parse `loadProvider() ?? {kind:"markdown"}`; a thrown loader or a schema failure
   becomes `PlanProviderUnavailableError` (`:315-326`).
2. `kind === "markdown"` → memoized per-owner Markdown store (`:328-336`); no executable port needed.
3. Otherwise `options.executablePort` must exist, or `PlanProviderUnavailableError` (`:337-341`).
4. `kind === "executable"`: strip `kind`, re-parse as `CapabilityExecutableDeclaration`, `cwd =
   workspaceRoot`, cache key from `declarationKey("executable", declaration)` (`:347-352`).
5. `kind === "plugin"`: requires `options.pluginPort`; `pluginPort.locate(plugin)` supplies
   `{root, declaration}` or an error message; `cwd = root`; cache key
   `declarationKey("plugin:<name>", declaration)` (`:353-365`).
6. `memoized(owner, cacheKey\0owner, build)` opens (or reuses) an executable session and wraps it in
   `executableStore(...)`, which lazily re-opens a session per RPC call via
   `options.port.session({...})` rather than holding a reference — the actual subprocess reuse lives
   entirely in the kernel's session manager, keyed as in §3e (`:150-159`).
7. A build failure is wrapped as `PlanProviderUnavailableError` with `condition: "plan provider
   executable could not be initialized"` (`:387-393`), and the failed promise is evicted from the
   `stores` cache so a later call retries rather than replaying the same rejection forever
   (`:303-309`).
8. **Eviction bookkeeping**: `memoized` also records every cache key it ever built for an owner in a
   second map, `keysByOwner: Map<owner, Set<key>>` (populated at `:300-302`). `PlanFactory.evictOwner`
   (`:396-401`) reads that set and deletes every one of that owner's entries from `stores` in one
   pass — "forget every inactive cached provider resolution for one owner" (§2d's one-line gloss) is
   this bookkeeping, not a scan of `stores` by value.
9. **`update`/`revise` are not RPC methods of their own.** Both first call `this.read(id)` (the
   `plans/read` RPC), then compare the result against the caller's `expected` triple
   (`revision`/`digest`/`spec_digest`) **client-side**, throwing `PlanConflictError("Plan changed
   since it was read", "cas")` on a mismatch before ever reaching the shared `write()` helper
   (`update`: `:212-220`; `revise`: `:242-250`). `revise` additionally throws `PlanSealedError` via
   `isPlanSealed(current)` (`:251`) before applying anything. Only after these local checks pass does
   either method apply the mutation/revision in-process (`applyPlanRevisions`/`nextRevision`), reseal
   the document (`seal`, `renderPlan`/`specDigest`), and send the *result* through the single
   `plans/write` RPC (`:227`, `:260`) — an executable plan provider never sees the raw mutation or
   revision operation, only the final resealed document plus the CAS triple it must match.

### 4c. The kernel's subprocess session lifecycle (`createCapabilityExecutableSessionManager` in `packages/kernel/src/capability-executables/session-manager.ts`)

| State | Trigger | Effect |
|---|---|---|
| (none) → spawning | `session(input)` called, no live entry for the key | `capabilityExecutableDeclarationSchema.parse`, `resolveCapabilityExecutable`, then native `Bun.spawn([command, ...args], {cwd, env, detached: ownProcessGroup(platform), stdin:"pipe", stdout:"pipe", stderr:"pipe"})` |
| spawning → initializing | process spawned | `build()`'s promise is cached into the `sessions` map by the *caller*, `session()`, at construction time—before `initialize` is even sent; `build()` itself then sends `initialize` per §3b |
| initializing → ready | valid `initialize` result | inside `build()`'s `initialize` continuation, `resolve(session)` settles the *same* promise already cached in `sessions`—a second caller awaiting that cached promise before this point is not "ready" yet, only pending |
| ready → ready | second `session()` call, same key, capability ≠ `"plans"` or same owner | returns the cached session unchanged |
| ready → terminated | a malformed/oversized/non-object/mismatched-id JSON-RPC line on stdout, JSON-RPC response with both/neither of `result`/`error`, subprocess exit or stream error, a call timeout, or an aborted `AbortSignal` | `terminate(error)`: rejects every pending call with that error and sends `SIGTERM` to the process tree via `killTree` |
| terminated | subsequent `session()` for the same key | the cached (`closed`) entry is deleted from the map and a fresh process is built via `build()` |
| any → closing | `manager.close()` | `closing=true`; every live/pending session is awaited then `.close()`'d; a `session()` call after this rejects with `"capability executable manager is closing"` |

Out-of-order responses are multiplexed by numeric `id` against a `Map<number, PendingCall>`, each
with its own timer (default `executable.timeout_ms`) and optional `AbortSignal` listener. Writes are
sent and flushed through Bun's native subprocess stdin, while independent async readers bound and
frame stdout and stderr. Clarvis supports Bun as its sole application runtime, so this persistent
channel uses Bun's subprocess and stream lifecycle directly. A native spawn construction failure
rejects the session promise directly without ever reaching `initialize`.
Production: `build` in `packages/kernel/src/capability-executables/session-manager.ts`. Test:
`packages/kernel/tests/integration/capability-executable-session-manager.test.ts` uses the Bun-native
`packages/kernel/tests/helpers/capability-executable-fixture.ts` and pins initialization,
multiplexing, repeated requests, failures, restart, and shutdown.

A session that fails to start (rejects) is logged once at `warn` with
`event: "capexec.session.failed"` and the message "a capability executable session did not start; the
capability falls back to its built-in provider for this call" (`:361-369`) — but note (§6) that no
*code* actually performs that fallback; see the discrepancy flagged there.

### 4d. `code` panel: how a provider selection is edited

`CapabilityProvidersPanel` reads the scoped settings block (`scopedPlanBlock`/`scopedMemoryBlock`,
`packages/code/src/views/config/CapabilityProvidersPanel.tsx:98-101`), clones it into a draft signal on `load()`
(`:117-131`), and computes provider pickers from `PLAN_KINDS`/`MEMORY_KINDS` constant lists
(`:47-60`, `MCP_READ_DEFAULTS` at `:64-69` prefilling a new MCP draft's `tools` mapping) crossed with
`providerPluginOptions` for the `"plugin"` kind. Saving runs
`validatePlanProviderDraft`/`validateMemoryProviderDraft` against the draft before it is written back
to the settings file (`packages/code/src/adapters/capability-providers.ts:155-242`); no executable is ever spawned, located on
disk, or imported by the panel itself.

The panel also computes an **effective** block (`effectivePlanBlock`/`effectiveMemoryBlock`,
`packages/code/src/views/config/CapabilityProvidersPanel.tsx:104-115`), distinct from the scoped/draft one: at workspace scope it
falls back to the global block when the workspace has none, so the display can show the
*currently-active* provider even while the draft being edited is scoped to the workspace alone. Only
the scoped block is ever cloned into the draft or written back.

**Draft validation rules** (`validatePlanProviderDraft`/`validateMemoryProviderDraft`,
`packages/code/src/adapters/capability-providers.ts:155-242`):

| Field | Condition | Message |
|---|---|---|
| `pending_task_nudges` (plan) | integer, `>= 0` | "pending_task_nudges must be a non-negative integer" (`:156-162`) |
| `command` (plan/memory `executable`) | non-empty after trim | "command is required" (`executableIssue`, `:144-145`) |
| `args` (plan/memory `executable`) | every element a string | "args must contain only strings" (`:146-148`) |
| `timeout_ms` (plan/memory `executable`) | positive integer, if present | "timeout_ms must be a positive integer" (`:149-152`) |
| `paths` (memory `file`) | at least one non-empty path | "at least one non-empty path is required" (`:205-208`) |
| `server`, `tools.{list_memories,read_memory,grep_memories,query_memories}` (memory `mcp`) | non-empty | "`<field>` is required" (`:212-222`) |
| `tools.{write_memory,edit_memory,delete_memory}` (memory `mcp`) | all three present or all three absent | "write_memory, edit_memory and delete_memory must all be present or all be absent" (`:223-237`) |
| `plugin` (plan/memory `plugin`) | non-empty | "plugin is required" (`:165`, `:240`) |
| `budgets.seed_chars` (memory) | integer `>= 500`, if present | "seed_chars must be an integer of at least 500" (`:171-179`) |
| `budgets.digest_tokens` (memory) | integer `>= 500`, if present | "digest_tokens must be an integer of at least 500" (`:180-188`) |
| `budgets.max_index_ops` (memory) | integer `1..50`, if present | "max_index_ops must be an integer from 1 to 50" (`:189-199`) |

The MCP write-half all-or-none rule is therefore checked in **two independent places**: the panel's
own client-side draft validation above (`packages/code/src/adapters/capability-providers.ts:223-237`) and, again, inside
`createMcpMemoryProvider` itself at resolution time (`packages/memory/src/mcp-provider.ts:162-168`) — a draft that
somehow bypassed the panel (a hand-edited `settings.json`) still fails at resolution rather than
silently narrowing to a read-only provider.

## 5. Invariants

**INV-096.** The provider registry (`provider-registry.ts`) reaches every provider implementation
module (`wiki-provider.js`, `file-provider.js`, `mcp-provider.js`, `executable-provider.js`) only
through a dynamic `import()`, never a static `import`/`export … from`, and the registry's own static
value-imports name nothing but types from those modules.
Production: `packages/memory/src/provider-registry.ts:145,154,172,200,228` (the five `import()` call
sites — `executable-provider.js` appears twice, at `:172` for the `"executable"` kind and `:228` for
`"plugin"`) plus the file's top-level `import type` block (`:18-26`, no value import).
Test: `packages/memory/tests/architecture/provider-eager-boundary.test.ts:58,63,70` (per-file dynamic
membership, "imports nothing but types", and the deduplicated dynamic-set-equals-`IMPLEMENTATIONS`
check respectively). Why it matters, in the module's own words
(`packages/memory/src/provider-registry.ts:9-16`): "a registry that *value-imported* its implementations would pull every
provider's code, eventually including a plugin's, into every import of the kernel."

**INV-145.** `src/settings.ts` imports only from `./provider-config.ts` and never from `./provider.ts`
or anything path-matching `file-repository`; `src/provider-config.ts` in turn never imports
`./provider.ts` or `node:fs` — the settings entry stays disconnected from the executable-provider
implementation.
Production: `packages/plan/src/settings.ts:11` (`import { planProviderConfigSchema } from
"./provider-config.ts"`, the only `@clarvis/plan`-internal import in the file), and
`packages/plan/src/provider-config.ts:1-9` (imports only `zod` and
`capabilityExecutableDeclarationSchema` from `@clarvis/capability`).
Test: `packages/plan/tests/architecture/settings-provider-boundary.test.ts:5-14`, which reads both
files' text and asserts the four string-containment/non-containment conditions verbatim.

**INV-P1 (derived).** `resolveCapabilityExecutable` never consults the filesystem or a shell — it is
a pure function of `(declaration, platform, environment)`.
Production: `packages/capability/src/capability-executables.ts:49-64` (no I/O in the function body;
the only side effect is `resolveStringMapWith`, itself pure over the passed-in `environment` map,
`packages/capability/src/env-interpolate.ts:60-78`).
Test: unpinned directly by name, but exercised end-to-end by
`packages/capability/tests/unit/capability-executables.test.ts:21-47` (platform + env resolution with
no filesystem or process access available in the test).

**INV-P2 (derived).** A subprocess is always spawned through Bun's argv form as exactly
`[executable.command, ...executable.args]` — no command string is handed to a shell for
interpretation. This prevents shell expansion; it does not provide an OS sandbox.
Production: `packages/kernel/src/capability-executables/session-manager.ts:161-168`.
Test: `packages/kernel/tests/integration/capability-executable-session-manager.test.ts:56-78`
("spawns without a shell..."), which passes an argv element `"$(never-execute)"` and asserts
(`:76`) that a file named `never-execute` is never created — i.e. the string was never
shell-expanded.

**INV-P2b (derived).** Capability executables run as direct host subprocesses at the supplied `cwd`,
without the workspace shell sandbox, and inherit the kernel's whole environment with declaration
values layered over it.
Production: `packages/kernel/src/capability-executables/session-manager.ts:55-82`, `:152-167`.
Test: `packages/kernel/tests/integration/capability-executable-session-manager.test.ts:56-76`
(observes the real cwd, literal shell syntax, an inherited value and an interpolated declaration
value inside the child).

**INV-P3 (derived).** The `initialize` handshake's `protocol_version` must equal
`CAPABILITY_EXECUTABLE_PROTOCOL_VERSION` (currently `1`) exactly, and its `provider_kind` must be a
non-empty string; `writable`, if present, must be boolean; for `capability === "memory"` specifically,
`writable` must be present at all.
Production: `packages/kernel/src/capability-executables/session-manager.ts:122-143` (`initializationOf`), `:345-348` (the memory-only
`writable` requirement).
Test: `packages/kernel/tests/integration/capability-executable-session-manager.test.ts:147-168`
(`test.each` over `null`/`version`/`kind`/`writable` failure modes).

**INV-P4 (derived).** A session is keyed by the *effective* declaration and context
(`capability, workspace, cwd, command, args, env, timeout_ms, platform`) but **not** by `owner`;
concurrent calls sharing that key reuse one subprocess and multiplex responses by request `id`,
except the `"plans"` capability, which refuses a second distinct `owner` on an existing session.
Production: `packages/kernel/src/capability-executables/session-manager.ts:86-104` (key excludes `owner`), `:369-380` (the plans-only owner
check).
Test: `packages/kernel/tests/integration/capability-executable-session-manager.test.ts:41-54` ("keeps one initialized process and
multiplexes out-of-order responses") and `:170-178` ("plans v1 rejects a second concurrent owner").

**INV-P5 (derived).** A mutation the subprocess performed before dying is never replayed by the
session manager on restart — process death after a successful side effect surfaces as a rejected
call, and a fresh session starts clean rather than retrying the RPC.
Production: `packages/kernel/src/capability-executables/session-manager.ts:190-195` (`terminate` only rejects pending calls; it never resends
anything), `:359` (a fresh `build()` on the next `session()` call).
Test: `packages/kernel/tests/integration/capability-executable-session-manager.test.ts:118-128` ("never replays a mutation after
process death" — the fixture writes to a marker file and then exits nonzero; the test asserts the
marker shows exactly one mutation even after a second session is opened and reads a counter back).

## 6. Failure modes and degradation

| Failure | Where detected | Effect |
|---|---|---|
| Unresolved `${VAR}` in a declaration's `env` | `resolveStringMapWith`, `packages/capability/src/env-interpolate.ts:72-79` | throws `MissingEnvVarsError` naming every missing name; propagates out of `resolveCapabilityExecutable` and thus out of `session()` before any process is spawned (`packages/capability/tests/unit/capability-executables.test.ts:56-62`) |
| `Bun.spawn()` itself throws (e.g. bad `command`) | `build` in `packages/kernel/src/capability-executables/session-manager.ts` | the `session()` promise rejects directly; no `initialize` is ever attempted |
| Subprocess writes non-JSON, a non-object, an array, or a response with an unrecognized/duplicate-typed `id` | `handleLine`, `packages/kernel/src/capability-executables/session-manager.ts:197-231` | `terminate(new Error(...))`: every pending call (including the malformed one's own trigger) rejects with that error; the process is `SIGTERM`'d |
| Stdout line (or unterminated buffer) exceeds `MAX_PROTOCOL_LINE_BYTES` (1 MiB) | `packages/kernel/src/capability-executables/session-manager.ts:236-248` | same `terminate` path, message "...exceeded the maximum JSON line size" |
| Stderr accumulates past `MAX_STDERR_BYTES` (64 KiB) | `readStderr` in `packages/kernel/src/capability-executables/session-manager.ts` | silently stops appending (no truncation marker); already-captured stderr is still surfaced in the subprocess-exit diagnostic |
| Process exits or a stream reader fails while calls are pending | the `child.exited`, stdout, and stderr promise handlers in `build` | `terminate` with a message naming `code`/`signal` and, if any, the trimmed stderr tail |
| A call exceeds `executable.timeout_ms` (or the explicit override passed to `request`) | `packages/kernel/src/capability-executables/session-manager.ts:285-290` | `terminate(new Error("...timed out after <n>ms"))` — **the whole session dies**, not just that call |
| `AbortSignal` already aborted, or aborted while pending | `packages/kernel/src/capability-executables/session-manager.ts:255-259,270-274` | same `terminate` path with the abort reason as the error |
| JSON-RPC `error` object malformed (not an object, or fields of the wrong type) | `rpcError`, `packages/kernel/src/capability-executables/session-manager.ts:110-120` | still produces a `CapabilityExecutableRpcError`, defaulting `message`/`code` and dropping `domainCode` rather than throwing a second error |
| A capability's `close()` best-effort `shutdown` RPC itself throws | `packages/kernel/src/capability-executables/session-manager.ts:324-328` | swallowed (`catch {}`) — the `finally` still marks the session ended and `SIGTERM`s the tree |
| Memory: no `executablePort`/`serverPort`/`pluginPort` supplied for a declared `executable`/`mcp`/`plugin` kind | `packages/memory/src/provider-registry.ts:169-170,194-198,218-222` | `resolveMemoryProvider` returns `{ok:false, failure:{...}}` — never throws (§4a) |
| Plan: no `executablePort`/`pluginPort` for a declared `executable`/`plugin` kind | `packages/plan/src/provider.ts:344-348,354-358` | `storeFor` **throws** `PlanProviderUnavailableError` — unlike memory, plan's failure posture propagates rather than degrading gracefully |
| Plan: RPC domain error codes `plan_not_found` / `plan_conflict` (reason `locked` vs `cas`) / `plan_sealed` / `plan_invalid` | `mapRpcError`, `packages/plan/src/provider.ts:116-137` | mapped to the matching typed `PlanNotFoundError`/`PlanConflictError`/`PlanSealedError`/`InvalidPlanError`; any other `domainCode` (or a non-RPC error) rethrows unchanged |
| Plan: executable/plugin resolution succeeds but a later call fails | `createPlanFactory`'s `memoized`, `packages/plan/src/provider.ts:310-316` | the failed cache entry is evicted so a subsequent `storeFor` retries construction rather than permanently caching a rejection |
| A session build fails asynchronously after `session()` already returned the pending promise | `packages/kernel/src/capability-executables/session-manager.ts:384-394` | logged once (`event: "capexec.session.failed"`, `warn`) with the claim that "the capability falls back to its built-in provider for this call" — **see below**; separately, the failed entry is evicted from the `sessions` map (`:393`), so the *next* `session()` call for the same key gets a fresh spawn attempt rather than replaying the same rejection forever — this mirrors, but is a distinct mechanism from, the plan-factory cache eviction on the row above and in §4b step 7 |

**Flagged discrepancy (not a code defect claim, a traceability gap):** the log message at
`packages/kernel/src/capability-executables/session-manager.ts:391` asserts a fallback-to-built-in behavior, but the session manager itself has
no notion of "the built-in provider" — that decision, if it exists, would have to live in whichever
capability (`memory` or `plan`) called `session()` in the first place. Neither
`provider-registry.ts`'s `"executable"`/`"plugin"` arms (`:165-186,214-244`) nor
`plan/src/provider.ts`'s executable/plugin path (`:337-394`) contains a catch that falls back to the
wiki or to Markdown on a session failure — a rejected `session()` there propagates as
`{ok:false, failure:{...}}` (memory) or a thrown `PlanProviderUnavailableError` (plan), which the
model-facing agent will not silently swap for a different memory content or the Markdown plan store.
Whether some caller upstream (in the loop or kernel wiring) performs that fallback is out of this
document's scope — see §8.

## 7. Coupling

**Depends on:**
- `@clarvis/capability` (types + the protocol module itself): `capability-executables.ts`,
  `env-interpolate.ts`/`env-ref.ts` (for `${VAR}` substitution — shared with `@clarvis/mcp-client`,
  `@clarvis/llm` and `@clarvis/hooks`'s credential denylist per `packages/capability/src/env-interpolate.ts:5-9`),
  `CapabilityExecutableRpcError`, `CodedError` (used by plan's provider errors). Static value import
  in `packages/memory/src/schemas.ts:6`, `packages/plan/src/provider-config.ts:2`,
  `packages/plan/src/provider.ts:2-8`.
- `@clarvis/tools/shell`: `killTree`, `ownProcessGroup`
  (`packages/kernel/src/capability-executables/session-manager.ts:15`) — the same process-tree
  primitives a `shell` tool call and a workspace hook subprocess use
  (`packages/tools/src/lib/process.ts:46,78`), so a capability executable is torn down exactly like
  any other Clarvis-spawned child.
- Bun's native subprocess API and `node:crypto` (session-manager spawn, streaming stdio, and key
  digest).

**What forces the direction:**
- `provider-eager-boundary.test.ts` (INV-096) and `settings-provider-boundary.test.ts` (INV-145) are
  the mechanical enforcement: either would fail — with a green typecheck, green lint, green suite
  otherwise — the moment `provider-registry.ts` or `plan/settings.ts` gained a static value import of
  an implementation module. No import-graph structure alone would catch this; only the text-scanning
  architecture tests do.
- `CapabilityExecutablePort`/`CapabilityExecutableSessionInput` are declared in `@clarvis/capability`,
  not in the kernel or in memory/plan — both `packages/memory/src/provider-registry.ts:22-26` and
  `packages/plan/src/provider.ts:2-8` import them as **types only** from `@clarvis/capability`, so
  neither package depends on `@clarvis/kernel` to know what a session looks like; the kernel is the
  one and only runtime implementer, injected in via `ProviderResolutionContext.executablePort` /
  `CreatePlanFactoryOptions.executablePort` — a structural (duck-typed) port, not a class import.
- `MemoryPluginPort`/`PlanPluginPort` are likewise declared inside `@clarvis/memory`/`@clarvis/plan`
  themselves (`packages/memory/src/provider-registry.ts:84-95`, `packages/plan/src/provider.ts:25-29`), not shared from
  `@clarvis/capability` — each package owns its own narrow locate-shape, and the kernel's
  `PluginContributions.locateCapabilityExecutable` (`packages/kernel/src/plugins/plugin-contributions.ts:67-72`) satisfies both
  structurally.

**Depended on by:**
- `@clarvis/kernel`'s `file-kernel.ts` constructs exactly **one**
  `createCapabilityExecutableSessionManager` instance per kernel
  (`packages/kernel/src/file-kernel.ts:423-425`) and passes it as `executablePort` to *both*
  `createPlanningRuntime` (`:675-676`, via `packages/kernel/src/plans/planning-runtime.ts:44,60-61`)
  and `createMemoryFactory` (`:870-871`) — one subprocess pool serves both capabilities, keyed apart
  by the `capability` field in `CapabilityExecutableSessionInput` (§3e).
- `@clarvis/kernel`'s `PluginContributions.locateCapabilityExecutable`
  (`packages/kernel/src/plugins/plugin-contributions.ts:413-426`) is the sole implementer of both
  `MemoryPluginPort`/`PlanPluginPort`'s `locate`, reading `manifest.capabilityExecutables?.[capability]`
  off a plugin already checked for being **enabled** (`:409-411`) and **installed** (`:412-414`) — plugin
  installation/enabling itself is out of this document's scope (delegated to
  [hosts/plugins.md](../hosts/plugins.md)).
- `@clarvis/code`'s `capability-providers.ts` and `CapabilityProvidersPanel.tsx` consume only the
  **wire projection** of a plugin's offer (`PluginCapabilityExecutable` —
  `packages/protocol/src/plugins.ts:10-15`, built by
  `packages/kernel/src/plugins/plugin-service.ts:124-137`). That projection's per-capability entries
  (`capabilityExecutablesOf`, `packages/kernel/src/plugins/plugin-service.ts:125-137`) and the human-readable `$ plugin:capability
  <argv>` detail line (`executablesOf`, `:107-122`) each re-apply the declaration's `platforms`
  override themselves — but, unlike `resolveCapabilityExecutable` (§3a), only for `command`/`args`;
  neither function touches `env` (`:114-119`, `:130-135`). The TUI never imports
  `@clarvis/capability`'s executable types nor talks to a live session; it edits settings JSON only.
- Within `@clarvis/memory` itself, `MemoryFactory.providerFor` (`packages/memory/src/factory.ts:456-472`)
  is the one caller that invokes `resolveMemoryProvider` outside the registry's own tests, and it is
  **not memoized**: every call re-resolves the declared provider from scratch — including, for an
  `executable`/`plugin` kind, a fresh `createExecutableMemoryProvider` call — so a new `MemoryProvider`
  object (new tool closures) is built on every invocation even though the underlying subprocess is
  still deduplicated by the kernel session manager's own content-hash key (§3e). The memory capability
  (`packages/memory/src/capability.ts:115-120`) resolves through `factory.forOwnerControlPlane` (not
  `forOwner`) and then, when `providerFor` exists, calls it once per run at `forRun()` time; a
  resolution failure there is not traced further by this document's scope.

**Not coupled, by design:**
- `@clarvis/memory/src/mcp-provider.ts` names no MCP type and imports no MCP package — it declares its
  own narrow `MemoryServerPort` (`packages/memory/src/mcp-provider.ts:43-50`), satisfied structurally by the kernel; full
  detail is in the [foundations/mcp-client.md](../foundations/mcp-client.md) document, not this one.
- Neither `provider-registry.ts` nor `plan/src/provider.ts` imports `@clarvis/kernel` — the dependency
  arrow runs kernel → memory/plan, never the reverse (consistent with the top-level dependency graph:
  `@clarvis/memory`/`@clarvis/plan` sit below `@clarvis/kernel`).

## 8. Open questions

- **Whether anything actually implements the "falls back to its built-in provider" claim** in the
  session-manager's own warning log (`packages/kernel/src/capability-executables/session-manager.ts:391`). Within this document's scope, no
  caller in `provider-registry.ts` or `plan/src/provider.ts` catches a `session()` rejection and
  substitutes the wiki/Markdown store — a failure there surfaces as `{ok:false}` (memory) or a thrown
  `PlanProviderUnavailableError` (plan). Whether a *host* (the loop's capability composition, or
  something in `@clarvis/kernel` outside `capability-executables/`) performs that substitution is
  outside this document's scope.
- **Whether a capability executable's declared `env` values are folded into the hooks subprocess
  credential denylist.** `packages/kernel/src/file-kernel.ts:520-534` (`loadSecretNames`) derives the
  denylist from `keys.json`, `providers[].api_key_env`, and provider/model `headers` only — it never
  reads `manifest.capabilityExecutables` or a workspace's `memory.provider`/`plans.provider` blocks.
  Given that a capability executable's `env` can itself carry a `${VAR}` reference to a real secret
  (per §3a), whether that secret is excluded from a hook's own environment by the same mechanism is
  not established by the code this document's scope covers — it belongs to [execution/hooks.md](../execution/hooks.md) and/or
  [cross-cutting/security.md](../cross-cutting/security.md) to confirm or refute.
- **The kernel-side `PluginContributions.locateCapabilityExecutable`'s full trust/installation
  logic** (`packages/kernel/src/plugins/plugin-contributions.ts:413-426`, e.g. what `dirFor`/`loadableOf`/`enabled.includes` do)
  is delegated to [hosts/plugins.md](../hosts/plugins.md) per this document's scope; only the shape of what it returns
  to memory/plan (`{root, declaration} | {error}`) is covered here.
- **What "Plans v1 allows one owner" implies for a later v2** was stated only as a code comment and
  an error message string, with no version-2 behaviour anywhere to describe. **Resolved 2026-08-22 as
  far as the code can settle it**, on `CapabilityExecutableSessionInput.owner`. What the restriction
  is *not* is a protocol limitation: the session pool keys on
  `(capability, workspace, cwd, command, args, env, timeout, platform)` and deliberately not on
  `owner`, and **both** consumers put `owner` in every JSON-RPC request they send — `plans` at
  `packages/plan/src/provider.ts`'s `session.request(method, { owner, ...params })` and `memory` at
  `packages/memory/src/executable-provider.ts`'s `session.request(\`memory/${name}\`, { owner, ...args })`
  — so an executable can already separate the work itself. The `plans`-only refusal in the session
  manager is therefore conservatism, and `memory` shares one session across owners with no equivalent
  check. What it costs is now written down: under multi-owner the second owner's plan-provider
  resolution throws and stays unavailable for that process, because the provider memoizes per owner
  while the pool does not. **Still open**, and now a stated choice rather than an absent one: delete
  the check, or give `memory` one. Nothing in the tree indicates which.
- **Whether `MAX_STDERR_BYTES` truncation is ever surfaced to an operator** beyond being embedded in
  a terminate/close error message — no test asserts on truncated-stderr content specifically, only
  that a `close` event's diagnostic includes whatever stderr had accumulated
  (`packages/kernel/src/capability-executables/session-manager.ts:259-269`).
- Full behavior of `@clarvis/memory`'s built-in wiki provider (`wiki-provider.ts`) and of the memory
  wiki tree itself belongs to the three memory documents, not this one; it is described here only
  insofar as it participates in the provider-registry dispatch (§4a). The `file` and `mcp` provider
  kinds are covered in more depth (§4a's subsections) because, unlike the wiki, they exist *only* as
  provider-registry dispatch targets — there is no separate memory document for either.
- Full behavior of the plan Markdown store/format (`newPlan`, `renderPlan`, `applyPlanRevisions`,
  the CAS triple) belongs to the two plan documents; only the `executable`/`plugin` branch of
  `PlanFactory.storeFor` is this document's concern.
