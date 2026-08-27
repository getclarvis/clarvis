# The memory capability: seven tools, write policy, settings and control plane

> Implemented at
> `packages/memory/src/{capability,tools,toolset, tool-contract,handler,policy,settings,config,schemas,seed,review,types,index}.ts`
> and `packages/kernel/src/memory/{memory-service,memory-errors,memory-server-port}.ts`. Every claim
> below is anchored to a file and line. Open questions are collected in the final section.

## 1. Purpose

This subsystem is the seam between the memory wiki (the document store, delegated to
[capabilities/memory-store.md](memory-store.md)) and an engine run: it is what makes a workspace's markdown wiki show up to a
model as an `<memory>` context block plus seven callable tools, and what stops a run — or the
autonomous indexer that shares the same tool surface — from granting itself the owner's authority
over a document.

`createMemoryCapability` (`packages/memory/src/capability.ts:106`) builds a `Capability` the host
folds into a run's `deps.capabilities`. Per run it decides whether memory is active at all
(`forRun`, packages/memory/src/capability.ts:115), and when it is, assembles three things every agent scope in the run
sees: a seed block carrying the compiled `PROFILE.md`, a `## Memory` system-prompt section whose
wording differs for the entry agent versus every subagent, and a toolset — read tools for
everyone, write tools for the entry agent only. `tools.ts` is where the seven tool bodies actually
live, host-agnostic (`MemoryToolDef`), so the same module backs both an in-run agent and a
kernel-exposed control plane. `policy.ts` is the one rule table that keeps a model-facing write
from ever granting itself what only a human owner may grant: pinning a document or marking it
`confirmed`. `settings.ts`/`schemas.ts` are the `memory:` block and the per-run `memory` request
param the kernel's eager configuration path loads before any run exists. The kernel's
`memory-service.ts`/`memory-errors.ts`/`memory-server-port.ts` are the non-model-facing control
plane: health, reindex, job listing/retry over the protocol wire, and (for an `mcp`-kind provider)
the bridge from a memory tool call to an MCP connection lease.

## 2. Surface

### 2.1 The seven model-facing tools

Declared once, canonically, in `MEMORY_TOOL_CONTRACTS` (`packages/memory/src/tool-contract.ts:17`)
and built as executable bodies by `createMemoryTools` (`packages/memory/src/tools.ts:209`, returned
list order at packages/memory/src/tools.ts:405-413):

| Tool | Schema (all `.strict()`) | Required | Effect |
|---|---|---|---|
| `list_memories` | `{ prefix?: string }` | none | read |
| `query_memories` | `{ query: string; limit?: number(1-20, default 5); prefix?: string; kinds?: ("profile"\|"topic"\|"memory")[] }` | `query` | read |
| `read_memory` | `{ paths: string[](1-5 items) }` | `paths` | read |
| `grep_memories` | `{ query: string; regex?: boolean(default false); limit?: number(1-50, default 20) }` | `query` | read |
| `write_memory` | `{ path: memoryWritablePathSchema; content: string(1..documentBytes) }` | `path`, `content` | mutate |
| `edit_memory` | `{ path: memoryWritablePathSchema; old_string: string; new_string: string }` | `path`, `old_string`, `new_string` | mutate |
| `delete_memory` | `{ path: memoryLeafPathSchema }` | `path` | mutate |

Source: packages/memory/src/tool-contract.ts:18-141. `memoryToolParameters(name)` (packages/memory/src/tool-contract.ts:146) derives the
advertised JSON Schema from the same zod schema that validates at execution, stripping `$schema`
and closing `additionalProperties: false` (also duplicated in `jsonSchemaOf`, packages/memory/src/tools.ts:69-75 — the
same derivation, once per module). Confirmed by
`packages/memory/tests/component/tools.test.ts:263-282`: every tool's `parameters` is a closed
object schema with the exact zod-required fields as `required`, and by `:300-305` that a
schema-inexpressible refinement (`delete_memory` on `PROFILE.md`) still fails at execute time with
`Invalid arguments`.

`createMemoryTools`'s test-observed name order (packages/memory/tests/component/tools.test.ts:18-28) is
`delete_memory, edit_memory, grep_memories, list_memories, query_memories, read_memory,
write_memory` when sorted; the *declared* order returned by the function is `list_memories,
query_memories, read_memory, grep_memories, write_memory, edit_memory, delete_memory`
(packages/memory/src/tools.ts:405-413), and a dedicated test pins `query_memories` ahead of `grep_memories` in that
order (packages/memory/tests/component/tools.test.ts:30-35, "ranked search before literal search").

`createMemoryTools(args: CreateMemoryToolsArgs)`'s exported parameter surface (packages/memory/src/tools.ts:116-150)
is: `store` (the backing `MemoryStore`) and `reindex` (the deterministic link-block reindex run
inside each mutation's own batch), plus two provenance-and-policy fields with real defaults —
`source?: MemoryRevisionSource` (packages/memory/src/tools.ts:132), defaulting to `{ kind: "tool", tool: <wire name> }`
(an agent editing memory in its own run), versus the per-run indexer's own `{ kind: "indexer",
run_id }` (packages/memory/src/tools.ts:121-131); and `intent?: MemoryWriteIntent` (packages/memory/src/tools.ts:140), defaulting to
`"agent_tool"` (packages/memory/src/tools.ts:133-139) — this is exactly what `checkWrite` (§4.5) receives as `intent`,
so it decides which branch of the write policy a caller is judged under. `mutationFence?:
MemoryMutationFence` (packages/memory/src/tools.ts:149) is the background indexer's queue-claim lease, covered in §4.4.

### 2.2 `MemoryToolset` — the loop-facing adapter (`toolset.ts`)

```
interface MemoryToolset {
  defs: NamespacedTool[];
  names: Set<string>;
  callLimit: number;
  dispatch(name, args, signal?): Promise<{ isError: boolean; text: string }>;
}
buildMemoryToolset(tools: MemoryToolDef[], callLimit: number): MemoryToolset
```
`packages/memory/src/toolset.ts:17-62`. `defs` maps each `MemoryToolDef` to a `NamespacedTool` with
`fullName === wireName === toolName === t.name` and `mcpName: ""` (packages/memory/src/toolset.ts:42-49) — bare wire
names, no MCP namespacing, "same convention as `load_skill`" (packages/memory/src/toolset.ts:3-4). `dispatch` on an
unknown name returns `{ isError: true, text: "unknown memory tool '<name>'" }`
(packages/memory/src/toolset.ts:56-58) rather than throwing.

### 2.3 `buildMemoryToolsHandler` (`packages/memory/src/handler.ts:19`)

```
interface MemoryToolsHandlerDeps { base: HandlerBase; toolset: MemoryToolset; onMutation?(m: Mutation): void }
buildMemoryToolsHandler(deps): ToolHandler
```
Returns a `ToolHandler` whose `matches` is `toolset.names.has(call.name)` (packages/memory/src/handler.ts:23) and whose
`handle` enforces `toolset.callLimit` with a **per-handler-instance** closure counter `calls`
(packages/memory/src/handler.ts:21, 35-46) — confirmed distinct per instance even over a *shared* toolset by
`packages/memory/tests/component/toolset-handler.test.ts:102-116`.

`onMutation?(m: Mutation)` (packages/memory/src/handler.ts:15, importing `isMutatingTool`/`Mutation` from
`./indexer/pyramid.ts`, packages/memory/src/handler.ts:8) fires **only** when a dispatched call both succeeds
(`!result.isError`) and names a mutating tool (`isMutatingTool(call.name)`), and only when
`args.path` is a `string` — the payload is `{ tool: call.name, path }` (packages/memory/src/handler.ts:55-58). This is
how the background indexer learns what it changed without re-deriving it from tool results.
Within this document's own scope, `createMemoryRunCapability` never supplies `onMutation` when it
builds either handler (packages/memory/src/capability.ts:280, 283) — the field is declared here but unexercised by this
document's own wiring; see §8.

### 2.4 `createMemoryCapability` (`packages/memory/src/capability.ts:106`)

```
createMemoryCapability(factory?: MemoryFactory, opts?: MemoryCapabilityOptions): Capability
interface MemoryCapabilityOptions { enqueueOnRunEnd?: boolean }  // default true
```
The returned `Capability` (packages/memory/src/capability.ts:110-153):

| Field | Value |
|---|---|
| `name` | `MEMORY_CAPABILITY_NAME` = `"memory"` |
| `seedMarker` | `SEED_OPEN_TAG` = `"<memory>"` |
| `reservedWireNames` | the 7 tool names (`MEMORY_TOOL_WIRE_NAMES`, packages/memory/src/capability.ts:70-73) |
| `toolEffects` | `list_memories/query_memories/read_memory/grep_memories → "read"`, `write_memory/edit_memory/delete_memory → "mutate"` (packages/memory/src/capability.ts:74-77) |
| `forRun(ctx)` | see §4 |

### 2.5 Settings surface (`settings.ts`, `schemas.ts`)

| Export | Value / shape | Location |
|---|---|---|
| `MEMORY_CAPABILITY_NAME` | `"memory"` | packages/memory/src/settings.ts:24 |
| `MEMORY_INGEST_EVENT` | `"ingest"` | packages/memory/src/settings.ts:27 |
| `MEMORY_SETTINGS_FIELDS.memory` | `memoryConfigSchema.optional()` | packages/memory/src/settings.ts:45-55 |
| `MEMORY_REQUEST_PARAMS.memory` | `z.enum(["on","off"]).optional()`, custom error `"memory must be 'on' or 'off'"` | packages/memory/src/settings.ts:34-42, 58-60 |
| `MemorySettingsBlock` | `z.input<typeof memoryConfigSchema>` (pre-defaults; `enabled` optional) | packages/memory/src/settings.ts:69 |
| `memorySettingsSpec` | `{ key: "memory", schema: memoryConfigSchema, merge: "lastWins", pluginContributable: false, requestParams: MEMORY_REQUEST_PARAMS }` | packages/memory/src/settings.ts:75-81 |

The `memory:` settings block (`memoryConfigSchema`, packages/memory/src/schemas.ts:154-162, `.strict()`):

| Field | Type | Default |
|---|---|---|
| `enabled` | `boolean` | `MEMORY_DEFAULTS.enabled` = `true` (packages/memory/src/config.ts:21) |
| `model` | `string` (optional) | none — hosts default to a cheap model |
| `budgets` | `budgetsSchema.partial()` (optional) | merged over `DEFAULT_BUDGETS` |
| `provider` | `memoryProviderSchema` (optional, discriminated on `kind`: `wiki`\|`file`\|`executable`\|`mcp`\|`plugin`) | absent = built-in wiki |

`memoryProviderSchema` (packages/memory/src/schemas.ts:72-138) is a five-variant `z.discriminatedUnion("kind", …)`,
each variant `.strict()` so an unrecognized kind is rejected here rather than at first use:
- `{ kind: "wiki" }` — the built-in markdown wiki (packages/memory/src/schemas.ts:73-79).
- `{ kind: "file", paths: string[] }` — one or more workspace-relative paths (`min(1)`, at least
  one entry), concatenated into the entry block in order; read-only doctrine, not a wiki
  (packages/memory/src/schemas.ts:80-91).
- `{ kind: "executable", ... }` — extends `capabilityExecutableDeclarationSchema` with
  `kind: z.literal("executable")`: a persistent language-neutral JSON-RPC provider process
  (packages/memory/src/schemas.ts:92-94).
- `{ kind: "mcp", server: string, tools: {...}, seed_tool?: string }` — `server` names an entry in
  the host's `mcpServers`; `tools` is a `.strict()` object requiring the four read operation names
  (`list_memories`/`read_memory`/`grep_memories`/`query_memories`) and declaring each of the three
  write mappings optional; `seed_tool` names the server tool producing the entry block, omitted for
  a provider with none (packages/memory/src/schemas.ts:95-121). The schema accepts a partial write
  mapping, but `createMcpMemoryProvider` rejects it during provider construction: all three write
  mappings or none are required (packages/memory/src/mcp-provider.ts:137-168).
- `{ kind: "plugin", plugin: string }` — an installed and enabled plugin offering a selected
  provider (packages/memory/src/schemas.ts:122-133).

This shape governs whether the write tools even exist for a non-wiki provider — see §4.2's
`provider.writeTools === undefined` branch.

`budgetsSchema` (packages/memory/src/schemas.ts:52-56): `seed_chars: number.min(500)`, `digest_tokens:
number.min(500)`, `max_index_ops: number.min(1).max(50)`. Defaults (packages/memory/src/config.ts:23-37):
`seed_chars: 6000, digest_tokens: 4000, max_index_ops: 16`.

`MEMORY_DEFAULTS.history` (packages/memory/src/config.ts:39-53) is a sibling default block in the same `as const`
object: `keep_revisions: 20`, `keep_days: 90`, `min_revisions: 3` — how much superseded revision
content is kept so an automatic change can be undone, with the doc comment noting `min_revisions`
is a floor that outranks the other two bounds. Unlike `budgets`, it has **no** corresponding field
in `memoryConfigSchema` (packages/memory/src/schemas.ts:154-162 declares only `enabled`/`model`/`budgets`/`provider`) —
it is not settable via the `memory:` block, and is read directly off the constant by
`packages/memory/src/file-store/revisions.ts:107` (owned by the sibling [capabilities/memory-store.md](memory-store.md) document).

Path schemas gating `write_memory`/`edit_memory`/`delete_memory` (packages/memory/src/schemas.ts:13-41):
- `relPath`: relative POSIX `.md` path, no leading `/`, no `\`, no `.`/`..`/empty segments.
- `memoryLeafPathSchema`: `relPath` + at least 3 segments + ends `/MEMORY.md`.
- `memoryWritablePathSchema`: `relPath` that is `PROFILE.md`, OR ≥2 segments ending `/TOPIC.md`, OR
  a valid leaf path.

### 2.6 Kernel-facing control plane (`packages/kernel/src/memory/*`)

`createMemoryService(cfg: { factory: MemoryFactory | undefined; owner: string })` →
`MemoryService` (`packages/kernel/src/memory/memory-service.ts:68`), implementing the protocol
interface at `packages/protocol/src/memory.ts:108-151`:

| Method | Returns | Notes |
|---|---|---|
| `health()` | `MemoryHealthReport` | delegates to `Memory.health()`; findings ordered most-severe-first |
| `reindex()` | `{ reindexed: string[] }` | delegates to `Memory.reindex()` under the tree's exclusive lock |
| `jobs(filter?)` | `{ jobs: MemoryJob[]; counts }` | `limit` clamped to `MAX_LIMIT = 100` (packages/kernel/src/memory/memory-service.ts:15) |
| `retryJob(runId)` | `MemoryJob \| null` | revives a failed job with a fresh attempt budget |

Every method resolves the owner's `Memory` through `MemoryFactory.forOwnerControlPlane`, and throws
`memoryError("MEMORY_NOT_CONFIGURED", …)` (`kernel_code: "capability_disabled"`) when the factory is
absent or resolves nothing (packages/kernel/src/memory/memory-service.ts:77-83). `mapMemoryFailure` (packages/kernel/src/memory/memory-errors.ts:72-82)
translates a package-thrown error carrying `code: "memory_recovery_required"` or
`"memory_path_invalid"` into `MEMORY_RECOVERY_REQUIRED` (`unavailable`) or `MEMORY_INVALID_PATH`
(`invalid_request`) respectively (packages/kernel/src/memory/memory-errors.ts:35-45); anything else falls through to
`toKernelError`.

Two mechanisms are common to every method rather than incidental to one. `guard(context, fn)`
(packages/kernel/src/memory/memory-service.ts:93-99) wraps every method body in a `try/catch`, resolving `mem()` and funnelling
any thrown error through `mapMemoryFailure` — it is the one place a package error becomes a tagged
kernel exception. `toJob(j: MemoryIndexJob)` (packages/kernel/src/memory/memory-service.ts:23-37) is the wire projection every
job-returning method uses: `next_attempt_at` is included only when `j.not_before` is set, `last_error`
only from the last `history` entry, and the run's `snapshot` is deliberately **not** projected — the
doc comment calls it "the run's payload, often large, and nothing in a queue view needs it"
(packages/kernel/src/memory/memory-service.ts:17-21).

`MemoryService` is deliberately narrow in what it does **not** expose: browsing, reading, searching,
editing and revision history are not control-plane methods at all. The protocol's own doc comment
says why the surface stops at health/reindex/jobs: those are "left with the memory browser they
existed to draw — the wiki is markdown on disk, and the only thing that writes it is the agent"
(`packages/protocol/src/memory.ts:4-7`).

`createMemoryServerPort(deps: MemoryServerPortDeps): MemoryServerPortResolver`
(`packages/kernel/src/memory/memory-server-port.ts:50`) is the bridge an `mcp`-kind provider calls
through: `forOwner(owner).callTool(server, tool, args, signal)` looks the named server up in the
host's declared `mcpServers` (re-read per call, packages/kernel/src/memory/memory-server-port.ts:55-58), acquires a pooled
connection lease scoped to `owner`, calls the tool, converts the result with `contentToText`, and
always releases the lease in a `finally` via `bestEffort` (packages/kernel/src/memory/memory-server-port.ts:78-87). Every
failure — unknown server, a failed `callTool`, a thrown error — is returned as `{ isError: true }`
rather than thrown (packages/kernel/src/memory/memory-server-port.ts:56-79).

## 3. Data and formats

### 3.1 `MemoryToolResult` (`packages/memory/src/types.ts:147-150`), `MemoryToolDef` (`packages/memory/src/types.ts:157-162`)

```
interface MemoryToolResult { text: string; isError: boolean }
interface MemoryToolDef {
  name: string; description: string; parameters: Record<string, unknown>;
  execute(args, signal?): Promise<MemoryToolResult>;   // never throws
}
```
Every tool body is built by `tool()` (packages/memory/src/tools.ts:89-112), which parses `args` against the tool's zod
schema first (`fail("Invalid arguments: <path>: <message>")` on the first issue, packages/memory/src/tools.ts:98-104)
and wraps the run in `try/catch` (`fail("Tool failed: <message>")`, packages/memory/src/tools.ts:105-109) — so a
`MemoryToolDef.execute` can never throw regardless of what its body does. Successes and failures
are both passed through `sanitizeText` (`ok`/`fail`, packages/memory/src/tools.ts:40-54) so a document that happened to
echo a secret is redacted before the model sees it.

### 3.2 The seed block (`seed.ts`)

`SEED_OPEN_TAG = "<memory>"`, closing tag `"</memory>"` (private), `SEED_MAX_CHARS = 6000`
(packages/memory/src/seed.ts:18-23). `wrapMemorySeed(raw, maxChars = SEED_MAX_CHARS)` (packages/memory/src/seed.ts:84-92) is the single
place that: trims, escapes any `<memory>`/`</memory>` substring the provider's own content
contained (`escapeSeedTags`, packages/memory/src/seed.ts:76-78, into `&lt;`/`&gt;`), runs `sanitizeText`, truncates to
fit `maxChars - tag lengths - 2`, and wraps. Example shape:
```
<memory>
Notes from past runs on this workspace, indexed below. […] Use the memory
tools (list_memories / read_memory / grep_memories) to drill into a topic.

<PROFILE.md body, trimmed>
</memory>
```
(preamble text at packages/memory/src/seed.ts:36-39; wrapping at packages/memory/src/capability.ts:212-223 via `provider.seed(...)` then
`wrapMemorySeed`). `capability.ts`'s `systemSection` appends an HTML-comment identity line
`\n\n<!-- memory-provider:<providerDigest> -->` (packages/memory/src/capability.ts:263), where `providerDigest` is
either the 64-hex-char suffix of a `kind:digest`-shaped `providerKey`, or a fresh SHA-256 of the
whole key (packages/memory/src/capability.ts:207-209).

`buildSeed(args: BuildSeedArgs)` (`packages/memory/src/seed.ts:41-73`) is what actually produces the raw content the
wiki provider hands to `wrapMemorySeed` above: it reads `PROFILE.md` via `args.store.readBounded`
when the store offers it (capped at `MEMORY_STORAGE_LIMITS.prefixBytes`), falling back to a plain
`args.store.read` when it does not (packages/memory/src/seed.ts:60-63). It returns `null` — no seed at all — when
`PROFILE.md` is absent, when the trimmed body is empty (packages/memory/src/seed.ts:70), and, as a distinct edge case,
when the bounded read was truncated **and** the truncated bytes fail to parse as frontmatter
(`if (bounded?.truncated === true && parsed.unparsable) return null;`, packages/memory/src/seed.ts:67) — a bounded read
that cut off mid-frontmatter is discarded rather than served garbled. On success it returns
`${PREAMBLE}\n\n${profile}` (packages/memory/src/seed.ts:72). `BuildSeedArgs.task` is accepted but "presently unused
(the seed is always the whole PROFILE index)" (packages/memory/src/seed.ts:49) — retained for future task-aware
seeding.

### 3.3 `DocFrontmatter` (`packages/memory/src/types.ts:109-128`)

```
interface DocFrontmatter {
  description: string; tags: string[];
  authority?: "observed" | "confirmed" | "contested";  // absent = "observed"
  pinned?: boolean;      // absent = false; never settable by automation
  extra?: string[];      // unrecognized frontmatter lines, round-tripped verbatim
}
```

### 3.4 `PolicyDecision` (`packages/memory/src/policy.ts:46-52`)

```
interface PolicyDecision {
  allowed: boolean;
  code?: "pinned_replace" | "pinned_delete" | "authority_escalation" | "authority_revocation";
  reason?: string;   // one line, safe to show an agent or an owner
}
```

### 3.5 Protocol DTOs consumed/produced by the kernel service (`packages/protocol/src/memory.ts`)

`MemoryHealthReport` (packages/protocol/src/memory.ts:46-62): `generated_at`, `totals {documents, topics, memories,
pending_jobs, failed_jobs}`, `counts` by severity, `findings[]` (each `{code, severity, path,
message, suggested_action}`), `truncated`, `skipped_codes`. `MemoryJob` (packages/protocol/src/memory.ts:85-99): `run_id,
state ("pending"|"running"|"retry_wait"|"completed"|"failed"), attempts, enqueued_at, updated_at,
next_attempt_at?, last_error? {phase, message, at}, note?`. `MemoryIngestDetail` (packages/protocol/src/memory.ts:161-209)
is a discriminated union on `phase`: `"started" | "queued" | "done" | "failed" | "blocked"`, each
carrying `execution_id` and phase-specific fields (`written`/`deleted`/`reindexed`/`skipped`/`note`/
`indexer_run_id` on `"done"`, etc.) — the wire shape of every notice `MEMORY_INGEST_EVENT` carries.

### 3.6 Storage caps referenced by the tool layer (`packages/memory/src/storage-limits.ts:7-19`, delegated in full to
[capabilities/memory-store.md](memory-store.md), but bounding this layer's schemas): `documentBytes = 2 MiB` (caps
`write_memory`/`edit_memory` content/strings), `prefixBytes = 64 KiB` (caps a bounded `read_memory`/
seed read via `readBounded`).

### 3.7 `ReviewDigest`/`reviewDigest` (`review.ts`)

`reviewDigest(docs)` (packages/memory/src/review.ts:50-60) is the cheap, LLM-free tree overview a host UI renders; it
is pure over an already-fetched listing so the facade owns the one `list()` call. It assembles
three fields: `totals` from `summarizeTotals` (packages/memory/src/review.ts:22-30), which counts `topics` and
`memories` by `DocKind` and reports `documents: docs.length` — the doc comment notes `documents`
therefore exceeds `topics + memories` by exactly one when `PROFILE.md` exists; `recent`, the
`RECENT_LIMIT = 10` (packages/memory/src/review.ts:13) most-recently-updated documents sorted by `updated_at`
descending; and `undescribed`, every path for which `isUndescribed` (packages/memory/src/review.ts:39-41) — a blank or
absent `description` — holds. `reviewDigest` is not itself re-exported from `src/index.ts` or
`./capability` (see §8); it backs `Memory.review()`, owned by the sibling [capabilities/memory-store.md](memory-store.md) document.

## 4. Behavior

### 4.1 `forRun(ctx)` — per-run activation (`packages/memory/src/capability.ts:115-151`)

1. If `ctx.requestParam("memory") === "off"` → return `null` (no seed, no tools, no ingest); this is
   the **request-level** override read through `RunCapabilityContext.requestParam`, since `memory`
   is a param `memorySettingsSpec` registers, not a field of the engine's own request type
   (packages/memory/src/capability.ts:90-93, 116).
2. Resolve `memory = factory?.forOwnerControlPlane(ctx.owner)` (packages/memory/src/capability.ts:117) — **not**
   `forOwner`, so a workspace with no indexer model still keeps its seed, tools and enqueue; only
   *learning* (the background worker) requires `forOwner`'s stricter gate
   (packages/memory/src/capability.ts:95-104, mirrored in the kernel's own `mem()` at packages/kernel/src/memory/memory-service.ts:77-83).
3. If `factory.providerFor` exists (a provider-aware factory): await it. `undefined` → `null`.
   `!resolved.ok` → log `memory_provider_unavailable` and return `null` — "the run continues with
   no memory at all — it is never silently served from a different store than the one declared"
   (packages/memory/src/capability.ts:119-129, quoting the log message). Otherwise build the run capability over
   `resolved.provider`/`resolved.key`/`resolved.seedMaxChars`.
4. Else (no `providerFor`, plain `MemoryFactory`): if `memory === undefined` → `null`; otherwise
   build over `wikiMemoryProvider(memory)` with key `"wiki:local"` and `SEED_MAX_CHARS`
   (packages/memory/src/capability.ts:141-150).

### 4.2 `createMemoryRunCapability` — assembling the per-run surface (packages/memory/src/capability.ts:180-354)

- Builds two `MemoryToolset`s: `readToolset` over `provider.readTools` (call limit
  `ctx.env.CLARVIS_MEMORY_TOOL_CALL_LIMIT`, default `12`, packages/memory/src/capability.ts:199-202,
  `packages/capability/src/env.ts:125`) and `writeToolset` over `provider.writeTools ?? []` with an
  **unbounded** call limit `WRITE_CALL_LIMIT = Number.MAX_SAFE_INTEGER` — "writes are not
  rate-limited — the agent should record freely" (packages/memory/src/capability.ts:176-178, 205).
- Each provider tool is passed through `canonical()` (packages/memory/src/capability.ts:189-198), which — when the tool
  name matches a `MEMORY_TOOL_CONTRACTS` entry — overwrites the provider's own `description` and
  `parameters` with the canonical contract's, regardless of what the provider itself declared.
- `seedBlock()` (packages/memory/src/capability.ts:212-223): calls `provider.seed(firstUserText(...))`, wraps a
  non-null result with `wrapMemorySeed`, and on any thrown error logs `memory_seed_failed` and
  returns `undefined` — the run continues with no memory block rather than failing.
- `systemSection(id)` (packages/memory/src/capability.ts:255-274): always emits the `## Memory` navigation paragraph
  plus the provider-identity comment; **only when `id.entry`** does it append the write-policy
  paragraph ("Do NOT call write_memory, edit_memory or delete_memory on your own initiative. […]
  write only when the user asks you to remember, record or correct something…").
- `forAgent(scope)` (packages/memory/src/capability.ts:275-288): always attaches the read toolset's tools + handler;
  **only when `scope.entry`** also attaches the write toolset's tools + handler. A subagent
  therefore gets exactly the 4 read tools; the entry agent gets all 7
  (pinned by `packages/memory/tests/architecture/capability-flag-surface.test.ts:85-91`).
- `onRunEnd` is present **iff** `opts.enqueueOnRunEnd !== false` **and** `memory !== undefined`
  (packages/memory/src/capability.ts:289-352):
  - If `provider.writeTools === undefined` (a read-only provider): `onRunEnd` emits a single
    `MEMORY_INGEST_EVENT` notice `{ phase: "done", skipped: true, note: "provider-read-only" }` and
    resolves — no enqueue is attempted (packages/memory/src/capability.ts:291-306).
  - Otherwise: subscribes to the run's eventual settlement via
    `factory.subscribeToRun(ctx.owner, record.id, emitNotice)` **before** calling
    `enqueueFinishedRun` (ordering is explicit in the doc comment: the durable worker can drain a
    job on its own timer, so subscribing after the enqueue risks missing an already-settled
    result — packages/memory/src/capability.ts:308-321), awaits the enqueue write, unsubscribes immediately if the
    enqueue itself reports `phase: "failed"` (packages/memory/src/capability.ts:345-348), and finally calls
    `factory.poke(ctx.owner)` **without awaiting it** (packages/memory/src/capability.ts:350) — draining costs an
    inference call and happens off the response path.

### 4.3 Read-tool dispatch (`packages/memory/src/tools.ts:214-310`)

The four read tools share the constants `DESCRIPTION_MAX = 120` and `READ_MAX_CHARS = 8000`
(packages/memory/src/tools.ts:29-30):

| Tool | Behavior | Cite |
|---|---|---|
| `list_memories` | Filters `store.list()` by `a.prefix` when given; formats each hit as `path · kind · description` (description truncated to `DESCRIPTION_MAX`, omitted entirely when blank); an empty result after filtering returns the distinct message `"No memory documents yet. Use write_memory to record the first durable learning."` rather than an empty list | packages/memory/src/tools.ts:214-237 |
| `read_memory` | For each of up to 5 `paths`, reads via `store.readBounded` capped at `min(prefixBytes, READ_MAX_CHARS * 4)` when the store offers it, else falls back to `store.read`; a missing document renders as `## <path>\n(not found)`; a found one is truncated to `READ_MAX_CHARS` and, if the bounded read itself was truncated, appended with `"\n[document truncated for display]"`; results join with `\n\n---\n\n` | packages/memory/src/tools.ts:239-265 |
| `grep_memories` | Formats hits as `path:line: text`, one per line; no hits returns `"No matches. Memory may simply not cover this yet."` | packages/memory/src/tools.ts:267-278 |
| `query_memories` | Distinguishes a query with **zero searchable terms** (`"That query carried no searchable terms. Try naming the topic or a command."`) from one with **zero hits** (`"No relevant documents. Memory may simply not cover this yet."`); each hit renders `path · score(2dp) · title`, then an optional description line and an optional snippet line, blocks joined by `\n\n---\n\n` | packages/memory/src/tools.ts:280-310 |

Confirmed by `packages/memory/tests/component/tools.test.ts` ("list_memories shows path, kind and
description", "read_memory returns full bodies and marks missing paths", among others).

### 4.4 Write-tool dispatch (`tools.ts`)

Each of `write_memory`/`edit_memory`/`delete_memory` runs its body under `store.exclusive(tx => …)`
(packages/memory/src/tools.ts:318-403):

| Tool | Reads first | `checkWrite` call | On refusal | On success |
|---|---|---|---|---|
| `write_memory` | `tx.read(path)` | `operation: current===null?"create":"replace"`, `existing`/`next` from `parseFrontmatter` | `fail("<path>: <reason>")` | `tx.batch({source}, write + reindex)`; warns if no `description:`; appends `reindexNote` |
| `edit_memory` | `tx.read(path)`; refuses if `old_string` occurs 0 or >1 times | `operation: "edit"` | as above, or the occurrence-count fail | same batch shape |
| `delete_memory` | `tx.read(path)`; refuses if absent | `operation: "delete"` (no `next`) | as above | `tx.batch({source}, delete + reindex)` |

Every mutating tool then runs through `fencedMutation(tx, args.mutationFence, mutate)`
(packages/memory/src/tools.ts:153-170): if a `mutationFence` is supplied (the background indexer's queue-claim lease),
it checks `fence.before(tx)` immediately before the mutation and `fence.after(tx)` immediately
after, both on the same `MemoryUnitOfWork`; a `false` from either yields
`fail(LOST_INDEX_CLAIM)` ("The memory index claim is no longer current; stale mutation refused.",
packages/memory/src/tools.ts:31, 334/371/399). On a thrown error mid-mutation, `fence.after` still runs before
re-throwing — "a backend fault must not leave the worker believing its fence stayed current merely
because its write also failed" (packages/memory/src/tools.ts:163-169). Ordinary run/control-plane calls omit the fence
entirely, so this path is a no-op for them.

`edit_memory`'s `operation` is always `"edit"`, never `"replace"` — this is what keeps a surgical
edit to a pinned document allowed under `checkWrite` (tools.ts doc comment at 206-207; policy.ts
rule at 4.5 below).

### 4.5 `checkWrite` (`packages/memory/src/policy.ts:86-142`)

| `intent` | Result |
|---|---|
| `"owner"` or `"reindex"` | `ALLOW` unconditionally, first line (packages/memory/src/policy.ts:94) |
| any other intent, `existing.pinned === true`, `operation === "delete"` | refuse, `pinned_delete` |
| any other intent, `existing.pinned === true`, `operation === "replace"` | refuse, `pinned_replace` |
| any other intent, `existing.pinned === true`, `operation === "edit"` | not refused merely for being an edit to pinned content; the subsequent `next` checks can still refuse removal of the pin or an authority escalation |
| `next` supplied, `existing.pinned === true` and `next.pinned !== true` | refuse, `authority_revocation` |
| `next` supplied, `next.pinned === true` and `existing?.pinned !== true` | refuse, `authority_escalation` |
| `next` supplied, `next.authority === "confirmed"` and `existing?.authority !== "confirmed"` | refuse, `authority_escalation` |
| none of the above | `ALLOW` |

`next` is only consulted when the caller supplies it (packages/memory/src/policy.ts:83-84, 115): a caller that cannot
say what frontmatter results (e.g. `delete_memory`, which passes no `next`) is judged on the pin
rules alone. Lowering `authority` (`confirmed → contested`/`observed`) is never refused — the
`authority_escalation` check only fires on a rise to `confirmed` (packages/memory/src/policy.ts:132-138).

## 5. Invariants

**INV-090.** The package's public facade (`src/index.ts`) re-exports `sanitizeText` (by identity,
from `@clarvis/capability`, packages/memory/src/index.ts:64) and deliberately does **not** re-export `sanitizeDeep`.
Production: `packages/memory/src/index.ts:64`. Test:
`packages/memory/tests/architecture/barrel.test.ts:15-22`. Prevents "restores a weaker default
under memory's name" (packages/memory/tests/architecture/barrel.test.ts:7-11 comment).

The same barrel (`src/index.ts`) never names `capability.ts`, `tools.ts`, `toolset.ts`,
`tool-contract.ts`, `handler.ts` or `settings.ts` in any `export` statement — everything this
document describes reaches a consumer only through the `./capability` and `./settings` subpath
exports the package declares (`packages/memory/package.json`'s `exports` map lists exactly `.`,
`./schemas`, `./capability`, `./settings`, `./testing` and `./package.json`, with no `./tools` or
`./toolset` subpath of their own). The plain `.` entry stays a leaf-facing library surface (store,
schemas, digest, health, journal, query, revisions, drain, job-broker, seed constants, etc.) with no
engine/capability coupling.

**INV-091.** Setting `enqueueOnRunEnd: false` changes **only** whether `onRunEnd` is present on the
built `RunCapability` — `seedMarker`, `seedBlock`, both agents' system sections, and both agents'
tool lists are byte-identical to the `true` case. Production: `packages/memory/src/capability.ts:
289-352` (the conditional spread that adds/omits `onRunEnd` alone). Test:
`packages/memory/tests/architecture/capability-flag-surface.test.ts:78-83` (`wireSurfaceOf`
equality) and `:94-103` (`Object.hasOwn(...,"onRunEnd")` differs and only that).

**INV-092.** The comparison in INV-091 is over a non-vacuous surface: the seed marker/block are
defined, the entry system section contains `"## Memory"`, the entry agent has 7 tools and the
subagent has 4. Test: `packages/memory/tests/architecture/capability-flag-surface.test.ts:85-91`.

Why INV-091/092 hold `seedBlock` to the same standard as `onRunEnd`, per the test file's own header
comment: an indexing pass continues the run it indexes and so registers this capability twice —
once for real, once with the enqueue suppressed so the pass does not queue itself forever — and
that only works while the pass is served from the provider's prefix cache, with `seedMarker`,
`seedBlock`, `systemSection` and the tool array all ahead of the appended instruction. Widening the
flag to also suppress `seedBlock` would look like a tidy optimisation, but a downstream consumer
(`buildEntrySeed`, outside this document's scope) decides whether to keep a carried seed block by
checking whether the capability's `seedMarker` is still *live* — a capability that emits no block
at all has no live marker, so the carried block is dropped out of the middle of the transcript and
every token behind it is re-billed by the provider's prefix cache. The engine measured one such
boundary at **115,432 tokens**. Cite: `packages/memory/tests/architecture/capability-flag-surface.test.ts:11-18`.

**INV-097.** `memorySettingsSpec` serves the store's own `memoryConfigSchema` by identity (not a
duplicate), registers under `MEMORY_CAPABILITY_NAME`, is `merge: "lastWins"` and not
plugin-contributable, and declares the `memory` request param whose `.parse()` accepts only
`"on"`/`"off"`/`undefined` and rejects anything else with a message containing `"memory must be
'on' or 'off'"`. Production: `packages/memory/src/settings.ts:34-42, 75-81`. Test:
`packages/memory/tests/architecture/settings-ownership.test.ts:26-49`.

**INV-098.** `src/settings.ts` (on the kernel's eager configuration path) value-imports only
`./schemas.ts` and `zod`, names neither `./factory.ts` nor `./capability.ts` even as a bare string,
and carries no `Logger` reference or `log`-named schema key. Production:
`packages/memory/src/settings.ts:1-81` (imports at 19-21). Test:
`packages/memory/tests/architecture/settings-ownership.test.ts:70-89` (regex-scans the source for
value imports, and string-scans for `"./factory.ts"`/`"./capability.ts"`/`"Logger"`).

`settings.ts`'s own module doc comment states the mechanism INV-097/098 exist to hold: the module
"used to live inside `@clarvis/loop`" purely so the engine's own settings schema could spread it
statically, which forced the block's schema and the capability's name to be declared twice and
pinned equal by a drift test; it moved here once the settings schema learned to accept blocks
registered at runtime — "the same route `@clarvis/plan` and `@clarvis/workflows` already take"
(`packages/memory/src/settings.ts:4-11`).

**INV-099.** `checkWrite` allows the `owner` intent to `replace` or `delete` a pinned document
unconditionally. Production: `packages/memory/src/policy.ts:94` (early return before any pin/
authority check). Test: `packages/memory/tests/unit/write-policy.test.ts:10-14`.

**INV-100.** The `reindex` intent is allowed to `replace` a pinned index file. Production:
`packages/memory/src/policy.ts:94` (same early return covers `"reindex"`). Test: `packages/memory/tests/unit/write-policy.test.ts:16-20`.

**INV-101.** Any non-owner, non-reindex intent (`indexer`, `agent_tool`) is refused a `replace` or
`delete` of pinned content, returning `code: "pinned_replace"`/`"pinned_delete"`. Production:
`packages/memory/src/policy.ts:96-113`. Test: `packages/memory/tests/unit/write-policy.test.ts:23-33`, plus component-level confirmation at
`packages/memory/tests/component/tools.test.ts:170-188` (write refused with "pin"/"confirmed" in
the message, document never created).

**INV-102.** A surgical `edit` of a pinned document is not refused merely because the document is
pinned, regardless of automation intent; the later frontmatter checks still refuse an edit that
removes the pin or grants authority. Production: `packages/memory/src/policy.ts:96-138` (the pin
block tests only `"delete"`/`"replace"`, while the subsequent checks inspect `next`).
Test: `packages/memory/tests/unit/write-policy.test.ts:35-41`; component evidence at `packages/memory/tests/component/tools.test.ts:235-245` ("a surgical edit
to a pinned document still works", pin retained in the result).

**INV-103.** No automation intent may set `pinned: true` or `authority: "confirmed"` on a document
that did not already have it — refused with `code: "authority_escalation"` — whether the write is a
`create`, `replace`, or comes from the indexer or a model-facing tool. Production:
`packages/memory/src/policy.ts:115-138`. Test: `packages/memory/tests/unit/write-policy.test.ts:43-85`; component-level at
`packages/memory/tests/component/tools.test.ts:170-201` (both direct `write_memory` self-pinning and a smuggled marker through
`edit_memory`'s substring replacement are refused).

**INV-104.** No automation intent may remove an existing `pinned: true` (an edit or replace that
drops the pin is refused with `code: "authority_revocation"`), closing the two-call bypass of
"unpin via edit, then replace freely". Production: `packages/memory/src/policy.ts:116-124`. Test:
`packages/memory/tests/unit/write-policy.test.ts:87-97`; component-level at `packages/memory/tests/component/tools.test.ts:203-233` (an edit that removes the
`pinned: true` line, and one that removes the closing `---` entirely and would parse as unpinned,
are both refused, document unchanged in both cases).

**INV-105.** An edit that leaves an existing pin exactly as it was is allowed, and automation may
retain authority a document already had. Production: `packages/memory/src/policy.ts:116, 132` (both checks only fire on
a *change* — `next.pinned !== true` / `next.authority !== "confirmed"` compared against the
opposite existing value). Test: `packages/memory/tests/unit/write-policy.test.ts:99-104` (pin retained → allowed),
`:106-116` (`confirmed → confirmed` → allowed); component confirmation at `packages/memory/tests/component/tools.test.ts:247-259`
("write_memory may still replace a confirmed document that keeps the marker").

**INV-106.** Automation may lower an existing `authority: "confirmed"` to `"contested"` or
`"observed"` — authority may be lowered (including removal, which defaults to `"observed"`) but
never raised by automation. Production:
`packages/memory/src/policy.ts:132-138` (the escalation check fires only when `next.authority === "confirmed"` and the
existing value is not; a lowering `next` never matches). Test: `packages/memory/tests/unit/write-policy.test.ts:118-133`.

**INV-107.** The entry agent's system section explicitly tells it not to call `write_memory` on its
own initiative, and never contains the phrase "as you go". Production:
`packages/memory/src/capability.ts:267-271` (the entry-only paragraph). Test:
`packages/memory/tests/architecture/write-policy.test.ts:60-65`.

**INV-108.** The system section names exactly the two legitimate authorisations for a memory write
— "the user asking" (rendered as "when the user asks") and the "dedicated pass" — and still tells
every agent scope how to read the wiki (`query_memories`). Production: `packages/memory/src/capability.ts:255-274`.
Test: `packages/memory/tests/architecture/write-policy.test.ts:66-76`.

**INV-109.** The system section for a subagent scope never mentions any write tool
(`write_memory`/`edit_memory`/`delete_memory`), and the `<memory>` seed block likewise never
mentions one for any scope, pointing only at navigation tools. Production:
`packages/memory/src/capability.ts:255-264` (subagent branch returns before the write paragraph); `packages/memory/src/seed.ts:36-39`
(`PREAMBLE` names only `list_memories`/`read_memory`/`grep_memories`). Test:
`packages/memory/tests/architecture/write-policy.test.ts:78-81` (subagent system-section half), `:84-89` (seed-block half).

**INV-110.** The indexer's own continuation instruction reciprocates exactly what the entry system
section (INV-107/108) and the seed block (INV-109) defer to — closing the three-way consistency the
test file's own header comment describes (the system section, the seed preamble and this instruction
all having to agree, or the pass "quietly stops recording anything, with every suite green"). Full
statement of the instruction's own content owned by
[capabilities/memory-indexer.md](memory-indexer.md) §5. Test (this document's half of the three-way
check): `packages/memory/tests/architecture/write-policy.test.ts:92-103`.

### Further invariants derived directly from the code (not in the owned INV range but load-bearing
here)

**A.** `MemoryToolDef.execute` never throws: argument validation failure and any thrown error
inside the tool body both resolve to a `fail(...)` result. Production: `packages/memory/src/tools.ts:97-110`. Test:
`packages/memory/tests/component/tools.test.ts:120-124` (a path-traversal argument comes back as an
error result, "never throwing").

**B.** A `buildMemoryToolsHandler`'s call budget is scoped to the handler instance, not the
toolset — two handlers sharing one toolset each get their own budget. Production:
`packages/memory/src/handler.ts:21,35,46` (`calls` is a closure-local `let`, one per call to `buildMemoryToolsHandler`).
Test: `packages/memory/tests/component/toolset-handler.test.ts:102-116`.

**C.** The read-tool call budget is finite (`CLARVIS_MEMORY_TOOL_CALL_LIMIT`, default 12) while the
write-tool budget is effectively unlimited (`Number.MAX_SAFE_INTEGER`). Production:
`packages/memory/src/capability.ts:178, 199-206`; default at `packages/capability/src/env.ts:125`. Unpinned by a
component test specific to this pairing (the budget-exhaustion test in
`packages/memory/tests/component/toolset-handler.test.ts:86-100` exercises the mechanism generically, not this specific
read/write asymmetry) — **unpinned**.

**D.** `canonical()` overwrites a provider's own `description`/`parameters` with the canonical
`MEMORY_TOOL_CONTRACTS` entry whenever the tool's name matches one, independent of
`assertProviderVocabulary`'s separate construction-time check. Production: `packages/memory/src/capability.ts:189-198`.
Unpinned by any test in scope — no test in `tests/architecture` or `tests/component`
constructs a provider whose tool descriptors differ from canonical and asserts the override
— **unpinned**.

## 6. Failure modes and degradation

| Condition | Behavior | Cite |
|---|---|---|
| `ctx.requestParam("memory") === "off"` | `forRun` returns `null`: no seed, no tools, no ingest for this run | packages/memory/src/capability.ts:116 |
| `factory` absent, or `factory.forOwnerControlPlane` resolves nothing | `forRun` returns `null` | packages/memory/src/capability.ts:117, 141 |
| `factory.providerFor` resolves `undefined` | `forRun` returns `null` | packages/memory/src/capability.ts:120-121 |
| `factory.providerFor` resolves `{ ok: false, failure }` | logs `memory_provider_unavailable` (with `cause`/`provider` fields) and returns `null` — never silently falls back to a different store | packages/memory/src/capability.ts:122-129 |
| `provider.seed(...)` throws | `seedBlock()` logs `memory_seed_failed` and returns `undefined` — run proceeds with no memory block | packages/memory/src/capability.ts:216-222 |
| A write/edit/delete tool's argument schema rejects | `fail("Invalid arguments: <path>: <message>")`, first zod issue only | packages/memory/src/tools.ts:98-104 |
| A tool body throws | `fail("Tool failed: <message>")` | packages/memory/src/tools.ts:105-109 |
| `grep_memories` regex too complex (backreference, lookaround, a quantifier applied to a group, or a pattern carrying more than three of `* + ? { \|`) | Not honoured — falls back to a keyword search rather than failing | packages/memory/src/tool-contract.ts:59-63 |
| `checkWrite` refuses | `fail("<path>: <reason>")`, a stable `code` on the `PolicyDecision` for programmatic dispatch | packages/memory/src/tools.ts:327/364/392, packages/memory/src/policy.ts:46-52 |
| `edit_memory`'s `old_string` occurs 0 times | `fail("old_string not found in <path>")` | packages/memory/src/tools.ts:355 |
| `edit_memory`'s `old_string` occurs >1 times | `fail("old_string occurs N× in <path> — make it unique")` | packages/memory/src/tools.ts:356 |
| A `mutationFence.before`/`.after` check fails | `fail(LOST_INDEX_CLAIM)` — "the memory index claim is no longer current" | packages/memory/src/tools.ts:158, 161, 334/371/399 |
| A fenced mutation throws mid-batch | `fence.after` still runs (to keep the worker's view of its own fence current) before the error is re-thrown | packages/memory/src/tools.ts:163-169 |
| Read-tool call budget exhausted | Handler refuses softly: `fail("Memory tool budget for this run is exhausted (<n> calls). Proceed with what the memory block and prior results already gave you, or inspect the workspace directly.")`, tool never invoked | packages/memory/src/handler.ts:35-45 |
| Unknown tool name reaches `dispatch` | `{ isError: true, text: "unknown memory tool '<name>'" }` | packages/memory/src/toolset.ts:56-58 |
| No `MemoryFactory` configured, at the kernel control plane | Every `MemoryService` method throws `MEMORY_NOT_CONFIGURED` (`capability_disabled`) | packages/kernel/src/memory/memory-service.ts:77-83 |
| A package error carries `code: "memory_recovery_required"` / `"memory_path_invalid"` | Mapped to `MEMORY_RECOVERY_REQUIRED` (`unavailable`) / `MEMORY_INVALID_PATH` (`invalid_request`) | packages/kernel/src/memory/memory-errors.ts:42-45, 72-82 |
| `mcp`-kind provider: named server not in current `mcpServers` | `{ text: "no MCP server named '<server>' is configured", isError: true }` | packages/kernel/src/memory/memory-server-port.ts:56-58 |
| `mcp`-kind provider: only some write mappings are declared | Provider construction throws a `partial write half` error; provider resolution catches it and returns an unavailable-provider failure rather than advertising a partial write vocabulary | packages/memory/src/mcp-provider.ts:161-168, packages/memory/src/provider-registry.ts:251-255 |
| `mcp`-kind provider: `callTool` reports `!ok` | `{ text: res.error?.message ?? "'<tool>' failed", isError: true }` | packages/kernel/src/memory/memory-server-port.ts:68 |
| `mcp`-kind provider: any thrown error during the call | `{ text: <message>, isError: true }` | packages/kernel/src/memory/memory-server-port.ts:78-79 |
| `mcp`-kind provider: lease release throws | Swallowed via `bestEffort` (`operation: "memory_mcp_lease_release"`) | packages/kernel/src/memory/memory-server-port.ts:82-86 |

Nothing in this subsystem retries a failed write or a failed tool call itself; retry policy for the
durable index job queue is out of scope here (delegated to [capabilities/memory-indexer.md](memory-indexer.md)).

## 7. Coupling

**Depends on** (runtime, static imports):
- `./seed.ts`, `./memory-contract.ts` (type), `./wiki-provider.ts` — the fallback provider when a
  factory has no `providerFor` (packages/memory/src/capability.ts:9-11).
- `@clarvis/capability` — `Capability`/`RunCapability`/`RunCapabilityContext`/`ToolEffect` types and
  `handlerBaseOf` value (packages/memory/src/capability.ts:13-21); `sanitizeText` (packages/memory/src/tools.ts:16, packages/memory/src/seed.ts:9); `openCallEnvelope`/
  `HandlerBase`/`HandlerVerdict`/`ToolHandler` (packages/memory/src/handler.ts:1-6); `NamespacedTool` type (packages/memory/src/toolset.ts:10);
  `capabilityExecutableDeclarationSchema` (packages/memory/src/schemas.ts:6). This is a **hard, non-optional** dependency
  of `@clarvis/memory` (a leaf package `@clarvis/loop` itself depends on).
- `./ingest.ts` (`enqueueFinishedRun`, `MemoryIngestNotice` type), `./factory.ts` (`MemoryFactory`
  type), `./run-snapshot.ts` (`firstUserText`), `./handler.ts`, `./settings.ts`, `./toolset.ts`,
  `./provider.ts`, `./tool-contract.ts` — all sibling modules of the same package
  (packages/memory/src/capability.ts:22-37), most of them owned by the sibling document [capabilities/memory-indexer.md](memory-indexer.md) (`ingest.js`,
  `run-snapshot.js`, `factory.js`) or [capabilities/memory-store.md](memory-store.md) (nothing directly here, but transitively via
  `Memory`).
- `./indexer/pyramid.ts` (`isMutatingTool`, `Mutation` type) — owned by [capabilities/memory-indexer.md](memory-indexer.md);
  `packages/memory/src/handler.ts:8` is this document's one reach into that sibling's module, used only to decide whether a
  successful mutation should be reported via `onMutation`.
- `packages/kernel/src/memory/memory-service.ts` imports `MemoryFactory` from
  `@clarvis/memory/capability` and `Memory`/`MemoryIndexJob` from `@clarvis/memory` (memory-service.ts:
  1-2) and `MemoryHealthReport`/`MemoryJob`/`MemoryJobFilter`/`MemoryJobState`/`MemoryReindexResult`/
  `MemoryService` from `@clarvis/protocol` (packages/kernel/src/memory/memory-service.ts:3-10) — the kernel is the sole
  translator between the package's domain shapes and the protocol's wire DTOs; `@clarvis/protocol`
  itself has **no** dependency on `@clarvis/memory` (memory.ts is self-contained, only importing
  `Timestamp` from `./common.ts`).
- `packages/kernel/src/memory/memory-server-port.ts` imports `MemoryServerPort`/
  `MemoryServerPortResolver` from `@clarvis/memory/capability` (packages/kernel/src/memory/memory-server-port.ts:10) and
  `bestEffort`/`contentToText`/`McpServerConfig` from `@clarvis/capability` (packages/kernel/src/memory/memory-server-port.ts:9)
  — it is deliberately built in the kernel rather than the memory package "because nothing on the
  engine's eager configuration path may reach it" and because this module is "the only place that
  knows both" the memory package's structural port and the kernel's MCP connection pool
  (packages/kernel/src/memory/memory-server-port.ts:1-8 doc comment).

**Forces the direction:**
- `packages/memory/tests/architecture/settings-ownership.test.ts:70-89` fails the build if `settings.ts` ever value-imports
  `./factory.ts`, `./capability.ts`, or a `Logger` — this is what keeps the kernel's eager
  `capability-registry.ts` import of `memorySettingsSpec` (`packages/kernel/src/config/
  packages/kernel/src/config/capability-registry.ts:3,22`) from dragging in the whole memory package on every kernel boot,
  independent of `builtins.memory`.
- `packages/memory/src/factory.ts` (sibling document) constructs `createMemoryCapability` nowhere
  itself; the **host** does. `packages/kernel/src/file-kernel.ts:891` calls
  `createMemoryCapability(memoryFactory)` unconditionally — even with `memoryFactory === undefined`
  — "because the engine collects `seedMarker` from every **registered** capability, active or not,
  which is what strips a stale `<memory>` block from a continuation whose run has memory switched
  off" (packages/kernel/src/file-kernel.ts:808-813). `packages/kernel/src/memory/pass-deps.ts:39` builds a **second** instance with
  `{ enqueueOnRunEnd: false }` for the deps an indexing pass continues under, which is exactly the
  scenario INV-091/092 exist to protect.
- `packages/kernel/src/kernel.ts:445` constructs `createMemoryService({ factory: opts.memoryFactory,
  owner: scope.owner })` per connection scope, and `packages/kernel/src/kernel.ts:743` reports `memory:
  opts.memoryFactory !== undefined` on the capability-availability surface — so the kernel, not this
  package, decides whether a client is told memory exists at all.

**What depends on this document** (not traced further here, out of scope): the kernel's
`memory-ingest-phase.ts` (`packages/kernel/src/runs/memory-ingest-phase.ts`, owned by
[capabilities/memory-indexer.md](memory-indexer.md)) and `code`'s `MemoryConfigPanel`/`memory-mode` adapter (owned by
[hosts/code-domain-hubs.md](../hosts/code-domain-hubs.md)) both consume the `MEMORY_INGEST_EVENT` wire shape and `MemoryService` this document
defines.

## 8. Open questions

- **`MemoryToolsHandlerDeps.onMutation` is declared but never supplied within this document's own
  scope.** `createMemoryRunCapability`'s `forAgent` builds both the read and write handlers with a
  bare `{ base, toolset }` (packages/memory/src/capability.ts:280, 283) — neither passes `onMutation`. Whether some
  other caller of `buildMemoryToolsHandler` supplies it (the per-run indexer, owned by the sibling
  [capabilities/memory-indexer.md](memory-indexer.md) document, is the plausible candidate given the mechanism reaches into
  `./indexer/pyramid.ts`) is outside this document's scope.
- **Read/write call-budget asymmetry is unpinned.** `CLARVIS_MEMORY_TOOL_CALL_LIMIT` (default 12)
  bounds read tools while write tools carry `Number.MAX_SAFE_INTEGER` (packages/memory/src/capability.ts:178, 199-206),
  but no test in `packages/memory/tests` exercises this specific pairing end-to-end (the generic
  budget-exhaustion mechanism is tested at `packages/memory/tests/component/toolset-handler.test.ts:86-100`, but always against a
  single synthetic toolset, not the read/write split as wired by `createMemoryRunCapability`). See
  Invariant C above.
- **`canonical()`'s override of a provider's own tool description/parameters is unpinned.** No test
  in scope constructs a `MemoryProvider` whose tool descriptors diverge from
  `MEMORY_TOOL_CONTRACTS` and checks that `createMemoryRunCapability` overrides them rather than
  passing the provider's own values through. See Invariant D above. Whether this is dead code (every
  provider always matches canonically already, per `assertProviderVocabulary`'s separate check in
  `packages/memory/src/provider.ts:66-101`) or a genuine defense against a provider that passes the vocabulary check but
  supplies different prose is not stated anywhere in the code or its comments.
  `assertProviderVocabulary` throws at construction on a wrong tool *name* or non-canonical
  descriptor (packages/memory/src/provider.ts:82-99), which would make `canonical()`'s override appear unreachable for
  any provider that passed construction — but `canonical()` is unconditional regardless, and the
  provider-registry call sites are outside this document's scope, so whether
  `assertProviderVocabulary` is invoked before every `createMemoryRunCapability` call is unconfirmed
  (that wiring lives in `factory.ts`/`provider-registry.ts`, owned by sibling documents).
- **`review.ts`'s `reviewDigest` is not part of any public export path this document's scope covers.**
  It backs `Memory.review()` (`packages/protocol/src/memory.ts:29`, sibling document [capabilities/memory-store.md](memory-store.md)) but is not itself
  re-exported from `packages/memory/src/index.ts` or `./capability`. Whether any host actually calls
  `Memory.review()` is outside this document's scope.
  `MemoryToolResult`/`GrepHit`/most of `types.ts`'s persistence-facing interfaces (`MemoryTx`,
  `MemoryBatch`, `MemoryUnitOfWork`, `MemoryStore`, `MemoryMutationFence`, etc.) are used by this
  document's tool bodies but their *implementation* (the file store, the batch/journal machinery) is
  explicitly delegated to [capabilities/memory-store.md](memory-store.md) — only the type declarations needed to describe
  `tools.ts`'s call sites are in scope here, not the store's internals.
- **Whether a provider other than the built-in wiki is ever exercised against this document's write
  policy in production** (i.e., whether `checkWrite`'s `"agent_tool"`/`"indexer"` intents are ever
  invoked over an `mcp`/`file`/`executable`/`plugin`-kind provider's own write tools) is not visible
  from this document's scope — `provider.ts`'s `MEMORY_WRITE_TOOL_NAMES` is optional per provider, and
  whether e.g. an `mcp`-kind provider ever supplies `write_memory` in practice is a
  [capabilities/provider-executables.md](provider-executables.md) question.
- **The exact wording threshold for INV-108's "user asking" phrase** is matched by the test as the
  substring `"when the user asks"` (packages/memory/tests/architecture/write-policy.test.ts:69), which appears in the production text
  as `"write only when the user asks you to remember, record or correct something"`
  (packages/memory/src/capability.ts:269-270) — the test does not pin the fuller sentence, only the substring, so a
  future edit narrowing to a different phrasing containing that substring would still pass; whether
  that is an intentional looseness or an oversight is not stated in the code.
