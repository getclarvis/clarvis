# The transport-agnostic kernel to UI contract

> Implemented at `packages/protocol/src/**` (19 files) plus
> `packages/kernel/src/transport/operations.ts` as the consumer table. Nontrivial claims below carry
> checkable source or test evidence, preferably at the owning symbol. Open questions are collected
> in the final section.

## 1. Purpose

`@clarvis/protocol` is the single package a UI depends on to talk to a Clarvis kernel: it is "wire
DTOs and the `KernelClient` interface", stated verbatim in the package's own doc comment
(`packages/protocol/src/index.ts:1-9`). It carries **no dependency on `@clarvis/loop`**
(`packages/protocol/src/index.ts:6`), so a UI client (`@clarvis/code`) programs against this contract and never imports the
engine. The package's `package.json` declares zero `dependencies`, `devDependencies`,
`optionalDependencies` or `peerDependencies` (`packages/protocol/package.json:1-33` — no dependency
key of any kind appears); it is a pure leaf.

The problem this solves, as the file-level doc comments state it repeatedly: today the contract is
implemented in-process (`createInProcessKernel`, referenced only in comments here since kernel
implementation is out of scope), but every interface is written so that "swapping stdio ↔ HTTP is
only a matter of which transport the client was built on" (`packages/protocol/src/client.ts:5-6`). Concretely this means:
a `KernelClient` service method never itself opens a socket — `packages/protocol/src/transport.ts:1-10`
states the transport seam is a request/response-plus-notifications shape, "JSON-RPC-shaped, with
Clarvis's own method vocabulary — not MCP's". Serialized DTO fields are JSON-shaped; service,
transport, cancellation and live-handle interfaces deliberately also contain methods, promises,
signals and an async iterable. Opaque payload escape hatches are typed `unknown`, for example
`KernelError.details` at `packages/protocol/src/common.ts:105`.

The package achieves its "transport-agnostic" claim not just by convention but by construction: it
declares 198 non-reexport type-level exports across its 18 sibling modules — 152 `export interface`
declarations (`rg -c "^export interface\\b" packages/protocol/src/*.ts`) plus 46 `export type <Name>
= ...` aliases (e.g. `packages/protocol/src/common.ts:11`'s `Scope`, `packages/protocol/src/runs.ts:118`'s `RunStatus`, `packages/protocol/src/tasks.ts:3`'s
`TaskStageDto`) — and `packages/protocol/src/index.ts:12-29` re-exports all 18 sibling modules with `export type *`.
TypeScript erases the whole surface at compile time — the package produces **zero runtime values**,
confirmed independently below (§7).

## 2. Surface

### 2.1 Module list

All 19 source files, each opened directly:

| File | Lines | Owns |
|---|---|---|
| `index.ts` | 29 | Barrel: `export type *` from the 18 modules below |
| `common.ts` | 109 | `Scope`, `Principal`, `ProjectRef`, `WorkspaceRef`, `Pagination`/`Page`, `CursorPagination`/`CursorPage`, `Timestamp`, `JsonSchema`, `KernelErrorCode`, `KernelError`, `Unsubscribe` |
| `runs.ts` | 823 | `RunService`, `RunHandle`, `StartRunParams`, `RunEvent` (39-value discriminated union), messages, usage, Extension Profile identity, guard/memory/plans modes, elicitation types |
| `config.ts` | 489 | `ConfigService`, `SettingsData`/`SettingsView` (incl. `WorkspaceTrustVerdict`, `known_grants`), the `SandboxConfig`/`SandboxInspection` doctor cluster, `SettingsRepairPlan` (2-variant union), `AgentSummary`/`AgentDoc`/`AgentOverlay`/`AgentBudget`, context docs — see §3.10/§3.11 |
| `plugins.ts` | 177 | `PluginService`, `PluginView`, `PluginContributions`, normalized install sources and atomic lifecycle DTOs |
| `extension-profiles.ts` | 253 | `ExtensionProfileService`, exact inventory and plugin/skill references, definitions, composition previews, resolved snapshots, deltas, diagnostics, deletion, and persisted run identity |
| `secrets.ts` | 31 | `SecretService` |
| `models.ts` | 82 | `ModelCatalogService`, `ModelCatalog`, `CatalogProvider`, `CatalogModel` |
| `provider-auth.ts` | 43 | token-free subscription schemes, states, device authorization and `ProviderAuthService` |
| `workspace.ts` | 44 | `WorkspaceService`, `WorkspaceEntry` |
| `memory.ts` | 209 | `MemoryService`, health/reindex/jobs DTOs, `MemoryIngestDetail` |
| `plans.ts` | 197 | `PlansService`, `PlanDocumentDto`, `PlanTaskDto`, `PlanRef` |
| `workflows.ts` | 121 | `WorkflowsService`, `WorkflowNode`, `WorkflowSequence`, `WorkflowSummary`/`WorkflowDetail` |
| `skills.ts` | 115 | `SkillsService`, `SkillSummary`, `SkillProvenance`, `SkillPresentation`, `SkillToolDependency` |
| `sessions.ts` | 138 | `SessionService`, `Session`, `SessionSummary`, `SessionTurn`, cache-detail-aware `SessionTotals`, Agent Profile binding, and Extension Profile snapshot identity |
| `tasks.ts` | 223 | `TasksService`, all `Task*Dto` shapes, `ActiveTaskRequestDto`/`ActiveTaskBindingDto` |
| `storage.ts` | 62 | `StorageService`, bounded inventory DTOs and cleanup request/result shapes |
| `transport.ts` | 68 | `KernelTransport`, `KernelRequestOptions`, `KernelAbortSignal` |
| `client.ts` | 120 | `KernelClient`, `KernelCapabilities`, `RuntimeStatus`, `ConnectOptions` |

(`packages/protocol/src/index.ts` — one `export type *` line per module above.)

### 2.2 `KernelClient` — the object a UI programs against

Defined in `packages/protocol/src/client.ts`. Aggregates 4 readonly fields, 15 named services and one method:

| Member | Type | Line |
|---|---|---|
| `capabilities` | `KernelCapabilities` | `KernelClient.capabilities` |
| `principal` | `Principal \| undefined` | `KernelClient.principal` |
| `project` | `ProjectRef` | `KernelClient.project` |
| `workspace` | `WorkspaceRef` | `KernelClient.workspace` |
| `runs` | `RunService` | `KernelClient.runs` |
| `config` | `ConfigService` | `KernelClient.config` |
| `plugins` | `PluginService` | `KernelClient.plugins` |
| `extensionProfiles` | `ExtensionProfileService` | `KernelClient.extensionProfiles` |
| `secrets` | `SecretService` | `KernelClient.secrets` |
| `models` | `ModelCatalogService` | `KernelClient.models` |
| `providerAuth` | `ProviderAuthService` | `KernelClient.providerAuth` |
| `files` | `WorkspaceService` | `KernelClient.files` |
| `memory` | `MemoryService` | `KernelClient.memory` |
| `plans` | `PlansService` | `KernelClient.plans` |
| `workflows` | `WorkflowsService` | `KernelClient.workflows` |
| `skills` | `SkillsService` | `KernelClient.skills` |
| `sessions` | `SessionService` | `KernelClient.sessions` |
| `tasks` | `TasksService` | `KernelClient.tasks` |
| `storage` | `StorageService` | `KernelClient.storage` |
| `close(): Promise<void>` | method | `KernelClient.close` |

`KernelCapabilities` has the four booleans `memory`, `skills`, `agent_tools`, and `tasks`, plus the
optional host-reported `runtime`. Native placement carries only `kind` and `host_platform`.
Container placement additionally reports generation, selected Docker/Podman engine and version,
host/guest platform, local immutable image digest, private runtime protocol revision, effective
network grant and lifecycle. This is an informational projection, not a client-controlled launch
input. The private runtime revision is distinct from the concrete transport's
`CLARVIS_WIRE_VERSION` handshake (`packages/kernel/src/transport/wire.ts`).

Production: `KernelCapabilities` and `RuntimeStatus` in `packages/protocol/src/client.ts`;
`createFileKernel` in `packages/kernel/src/file-kernel.ts`. Test:
`packages/kernel/tests/contract/transport-codecs.test.ts` and
`packages/code/tests/unit/header-projection.test.ts`.

`ConnectOptions`: `workspace?: WorkspaceRef | string`, `auth?: string`,
`clientInfo?: { name: string; version?: string }`. Nothing in `client.ts` defines a `connect()`
function — `ConnectOptions` is a shape a transport-specific connector elsewhere accepts; the type
alone lives here.

### 2.3 The 15 services, method by method

Every signature below is the one declared in its file.

#### `RunService` (`packages/protocol/src/runs.ts`)

| Method | Signature | Declaration |
|---|---|---|
| `start` | `(params: StartRunParams) => Promise<RunHandle>` | `RunService.start` |
| `compact` | `(execution_id, request?, options?) => Promise<RunCompactionResult>` | `RunService.compact` |
| `context` | `(execution_id, target_window_tokens?) => Promise<context estimate>` | `RunService.context` |
| `get` | `(execution_id: string) => Promise<RunDetail>` | `RunService.get` |
| `list` | `(page?: Pagination) => Promise<Page<RunSummary>>` | `RunService.list` |
| `delete` | `(execution_id: string) => Promise<void>` | `RunService.delete` |

`RunHandle` in `packages/protocol/src/runs.ts`, the live object `start` returns:

| Member | Signature | Declaration |
|---|---|---|
| `execution_id` | `readonly string` | `RunHandle.execution_id` |
| `events` | `readonly AsyncIterable<RunEvent>` | `RunHandle.events` |
| `steer` | `(message: Message \| string) => Promise<void>` | `RunHandle.steer` |
| `compact` | `(request?: string) => Promise<void>` | `RunHandle.compact` |
| `cancel` | `() => Promise<void>` | `RunHandle.cancel` |
| `respond` | `(response: ElicitationResponse) => Promise<void>` | `RunHandle.respond` |
| `onElicit` | `(handler: (req: ElicitationRequest) => void) => void` | `RunHandle.onElicit` |
| `done` | `readonly Promise<RunResult>` | `RunHandle.done` |
| `buffered?` | `() => { buffered_items; buffered_bytes; dropped }` | `RunHandle.buffered` |
| `closed` | `readonly Promise<void>` | `RunHandle.closed` |

`done` resolves when execution ends and does not imply that `events` has closed; `closed` resolves
only after execution and bounded post-run event delivery both finish. The `RunHandle.done` and
`RunHandle.closed` doc comments state that this lets a host key a lifecycle lease off `closed`
without becoming a second consumer of the single-consumer `RunHandle.events` stream.
The optional `buffered()` member exposes O(1) local queue counters for bounded diagnostics. Its
absence remains valid for transports that cannot report them, and reading it neither consumes nor
copies `events` (`packages/protocol/src/runs.ts`, `RunHandle.buffered`).

#### `ConfigService` (`packages/protocol/src/config.ts:361-489`)

| Method | Signature | Line |
|---|---|---|
| `getSettings` | `() => Promise<SettingsView>` | `packages/protocol/src/config.ts:363` |
| `previewSettingsRepair` | `(scope: Scope) => Promise<SettingsRepairPlan \| null>` | `packages/protocol/src/config.ts:370` |
| `repairSettings` | `(scope: Scope, expectedRevision: string) => Promise<SettingsView>` | `packages/protocol/src/config.ts:378` |
| `approveWorkspace` | `() => Promise<SettingsView>` | `packages/protocol/src/config.ts:392` |
| `revokeWorkspace` | `() => Promise<SettingsView>` | `packages/protocol/src/config.ts:399` |
| `workspaceTrustError` | `() => Promise<string \| null>` | `packages/protocol/src/config.ts:402` |
| `updateSettings` | `(scope, patch: Partial<SettingsData>, expectedRevision: string \| null) => Promise<SettingsView>` | `packages/protocol/src/config.ts:413-417` |
| `inspectSandbox` | `(options?: { refresh?: boolean }) => Promise<SandboxInspection>` | `packages/protocol/src/config.ts:420` |
| `listAgents` | `() => Promise<AgentSummary[]>` | `packages/protocol/src/config.ts:429` |
| `getAgent` | `(scope: Scope \| "builtin", name: string) => Promise<AgentDoc>` | `packages/protocol/src/config.ts:441` |
| `writeAgent` | `(scope, name, doc: AgentWrite) => Promise<AgentSummary>` | `packages/protocol/src/config.ts:450` |
| `deleteAgent` | `(scope, name) => Promise<void>` | `packages/protocol/src/config.ts:458` |
| `renameAgent` | `(scope, oldName, newName) => Promise<AgentSummary>` | `packages/protocol/src/config.ts:468` |
| `getContext` | `(scope) => Promise<ContextDoc \| null>` | `packages/protocol/src/config.ts:475` |
| `subscribe` | `(kinds: ConfigChangeKind[], listener) => Unsubscribe` | `packages/protocol/src/config.ts:488` |

#### `PluginService` (`packages/protocol/src/plugins.ts:143-176`)

| Method | Signature | Line |
|---|---|---|
| `list` | `() => Promise<PluginView[]>` | `packages/protocol/src/plugins.ts:146` |
| `install` | `(url, subdir?, target?: { source }) => Promise<PluginView>` | `PluginService.install` |
| `installSource` | `(source: PluginInstallSource, target?: { source }) => Promise<PluginView>` | `PluginService.installSource` |
| `update` | `(ref: PluginRef) => Promise<PluginView>` | `PluginService.update` |
| `uninstall` | `(ref: PluginRef) => Promise<void>` | `PluginService.uninstall` |

#### `ExtensionProfileService` (`packages/protocol/src/extension-profiles.ts`, symbol `ExtensionProfileService`)

| Method | Signature | Line |
|---|---|---|
| `list` | `() => Promise<ExtensionProfileDefinitionView[]>` | `ExtensionProfileService.list` |
| `current` | `() => Promise<ResolvedExtensionProfile>` | `ExtensionProfileService.current` |
| `get` | `(ref: ExtensionProfileRef) => Promise<ResolvedExtensionProfile>` | `ExtensionProfileService.get` |
| `inventory` | `() => Promise<ExtensionProfileInventory>` | `ExtensionProfileService.inventory` |
| `preview` | `(ref, { selection_scope }) => Promise<ExtensionProfilePreview>` | `ExtensionProfileService.preview` |
| `previewClear` | `(scope: ExtensionProfileSelectionScope) => Promise<ExtensionProfilePreview>` | `ExtensionProfileService.previewClear` |
| `previewComposition` | `(input: ExtensionProfileCompositionInput) => Promise<ExtensionProfileCompositionPreview>` | `ExtensionProfileService.previewComposition` |
| `select` | `(ref, { selection_scope, preview_token, approve_workspace? }) => Promise<ExtensionProfileApplyResult>` | `ExtensionProfileService.select` |
| `clearSelection` | `(scope, { preview_token }) => Promise<ExtensionProfileApplyResult>` | `ExtensionProfileService.clearSelection` |
| `applyComposition` | `(input, { preview_token, approve_workspace? }) => Promise<ExtensionProfileCompositionApplyResult>` | `ExtensionProfileService.applyComposition` |
| `create` | `(input: ExtensionProfileDefinitionInput) => Promise<ExtensionProfileDefinitionView>` | `ExtensionProfileService.create` |
| `update` | `(input: ExtensionProfileDefinitionInput & { expected_revision }) => Promise<ExtensionProfileDefinitionView>` | `ExtensionProfileService.update` |
| `delete` | `(ref, { expected_revision }) => Promise<void>` | `ExtensionProfileService.delete` |
| `clone` | `(source, target) => Promise<ExtensionProfileDefinitionView>` | `ExtensionProfileService.clone` |

`ExtensionProfilePreview.requires_workspace_trust` is true only when the effective target selects
repository-owned `scope: "workspace"` plugins whose exact executable surface is not currently
trusted. The verdict covers the complete workspace plugin inventory rather than one plugin or
Extension Profile. Global installed plugins carry operator installation consent and do not set this flag.

The service selects already-installed inventory and has no install operation. `inventory` exposes
all exact inactive composer candidates. `preview` and
`previewClear` return the exact entering/leaving extension surface plus a single-use token;
`preview` also names the intended persisted selection scope. `select` and `clearSelection` bind the
persisted mutation to that preview. `previewComposition`/`applyComposition` bind a complete
definition and its intended selection to the same reviewed authored/effective fingerprints. The full behavioral and
trust contract is owned by
[Extension Profiles](extension-profiles.md).

#### `SecretService` (`packages/protocol/src/secrets.ts:13-31`)

| Method | Signature | Line |
|---|---|---|
| `listNames` | `() => Promise<string[]>` | `packages/protocol/src/secrets.ts:15` |
| `set` | `(name: string, value: string) => Promise<void>` | `packages/protocol/src/secrets.ts:23` |
| `delete` | `(name: string) => Promise<void>` | `packages/protocol/src/secrets.ts:30` |

Doc comment states values "only ever flow client → kernel; listing returns names, never values"
(`packages/protocol/src/secrets.ts:4`), and warns that secrets "travel over the transport on `set`... a hosted kernel needs
TLS plus at-rest protection" (`packages/protocol/src/secrets.ts:8-9`).

#### `ModelCatalogService` (`packages/protocol/src/models.ts:66-82`)

| Method | Signature | Line |
|---|---|---|
| `get` | `() => Promise<ModelCatalog>` | `packages/protocol/src/models.ts:68` |
| `refresh` | `() => Promise<ModelCatalog>` | `packages/protocol/src/models.ts:75` |
| `getEntitled` | `(scheme: SubscriptionScheme) => Promise<CatalogProvider>` | `packages/protocol/src/models.ts:78` |
| `refreshEntitled` | `(scheme: SubscriptionScheme) => Promise<CatalogProvider>` | `packages/protocol/src/models.ts:81` |

#### `WorkspaceService` (`packages/protocol/src/workspace.ts:19-44`)

| Method | Signature | Line |
|---|---|---|
| `listFiles` | `(query?: { prefix?, glob?, limit? }) => Promise<WorkspaceEntry[]>` | `packages/protocol/src/workspace.ts:27` |
| `readFile` | `(path: string) => Promise<{ path: string; content: string }>` | `packages/protocol/src/workspace.ts:35` |
| `readImage` | `(path: string) => Promise<{ path: string; mime: string; data: string }>` | `packages/protocol/src/workspace.ts:43` |

#### `MemoryService` (`packages/protocol/src/memory.ts:108-151`)

| Method | Signature | Line |
|---|---|---|
| `health` | `() => Promise<MemoryHealthReport>` | `packages/protocol/src/memory.ts:114` |
| `reindex` | `() => Promise<MemoryReindexResult>` | `packages/protocol/src/memory.ts:129` |
| `jobs` | `(filter?: MemoryJobFilter) => Promise<{ jobs: MemoryJob[]; counts }>` | `packages/protocol/src/memory.ts:139` |
| `retryJob` | `(runId: string) => Promise<MemoryJob \| null>` | `packages/protocol/src/memory.ts:150` |

Deliberately narrow: the doc comment says browsing/reading/searching/editing/revision history "left
with the memory browser they existed to draw — the wiki is markdown on disk, and the only thing that
writes it is the agent" (`packages/protocol/src/memory.ts:4-7`). Methods reject with `capability_disabled` when memory is
not configured (`packages/protocol/src/memory.ts:9-10`).

#### `PlansService` (`packages/protocol/src/plans.ts:136-173`)

| Method | Signature | Line |
|---|---|---|
| `list` | `(input?: PlanListInput) => Promise<PlanListResult>` | `packages/protocol/src/plans.ts:144` |
| `read` | `(id: string) => Promise<PlanDocumentDto>` | `packages/protocol/src/plans.ts:152` |
| `setRetention` | `(id: string, retention: PlanRetention) => Promise<PlanDocumentDto>` | `packages/protocol/src/plans.ts:161` |
| `delete` | `(id: string) => Promise<{ id: string; deleted: boolean }>` | `packages/protocol/src/plans.ts:172` |

`delete`'s doc comment: "throws when the plan is still live (`active` or `awaiting_approval`); only
terminal plans may be deleted" (`packages/protocol/src/plans.ts:169-170`).

#### `WorkflowsService` (`packages/protocol/src/workflows.ts`)

| Method | Signature | Declaration |
|---|---|---|
| `get` | `(id: string) => Promise<WorkflowDetail>` | `WorkflowsService.get` |
| `list` | `(page?: Pagination) => Promise<Page<WorkflowSummary>>` | `WorkflowsService.list` |
| `delete` | `(id: string) => Promise<void>` | `WorkflowsService.delete` |

No `start` method: the `WorkflowsService` doc comment states that a workflow is started through
`RunService.start` like any run — the kernel routes it as a workflow when the entry agent profile
carries the `workflow` grant. This service adds only the tree structure (the edges plus a rollup)
over runs that are individually reachable through `RunService.get`.
`WorkflowDetail.sequence` optionally adds the latest durable Admiral-controlled round checkpoint;
absence means a legacy record or a workflow that used no controlled round sequence.

#### `SkillsService` (`packages/protocol/src/skills.ts:102-115`)

| Method | Signature | Line |
|---|---|---|
| `list` | `() => Promise<SkillSummary[]>` | `packages/protocol/src/skills.ts:104` |
| `getPrompt` | `(name: string, args?: { task?: string }) => Promise<Message[]>` | `packages/protocol/src/skills.ts:114` |

#### `SessionService` (`packages/protocol/src/sessions.ts:109-138`)

| Method | Signature | Line |
|---|---|---|
| `listPage` | `(page?: CursorPagination) => Promise<CursorPage<SessionSummary>>` | `packages/protocol/src/sessions.ts:111` |
| `list` | `() => Promise<Session[]>` | `packages/protocol/src/sessions.ts:114` |
| `get` | `(id: string) => Promise<Session \| null>` | `packages/protocol/src/sessions.ts:122` |
| `save` | `(session: Session) => Promise<void>` | `packages/protocol/src/sessions.ts:129` |
| `delete` | `(id: string) => Promise<boolean>` | `packages/protocol/src/sessions.ts:137` |

Both `Session` and `SessionSummary` carry `SessionTotals` as
`{ input: number; output: number; cached?: number; cost_usd?: number }`. `cached` is present only
when every contributing positive-input run reported its cache split; numeric `0` is therefore a
measured zero, while absence means a client cannot honestly subtract cached input or derive a hit
rate. Production: `packages/protocol/src/sessions.ts` (`SessionTotals`). Test:
`packages/protocol/tests/contract/public-contract.fixture.ts` (`unknownCacheSessionTotals`).

#### `StorageService` (`packages/protocol/src/storage.ts`)

| Method | Signature |
|---|---|
| `inspect` | `() => Promise<StorageSnapshot>` |
| `cleanup` | `(request: StorageCleanupRequest) => Promise<StorageCleanupResult>` |

`StorageSnapshot` contains only bounded category counts/bytes, a truncation flag and the
`present`/`owner_only` posture of credential files. It contains no pathname or persisted content.
`StorageCleanupRequest.categories` is closed to `temporary | cache` and carries an explicit
`dry_run`; see [`storage.md`](storage.md).

#### `TasksService` (`packages/protocol/src/tasks.ts:190-209`)

| Method | Signature | Line |
|---|---|---|
| `status` | `(options?: TaskCallOptions) => Promise<TaskProviderStatusDto>` | `packages/protocol/src/tasks.ts:191` |
| `capabilities` | `(options?) => Promise<TaskProviderCapabilitiesDto>` | `packages/protocol/src/tasks.ts:192` |
| `listContainers` | `(input: ListTaskContainersDto, options?) => Promise<TaskContainerPageDto>` | `packages/protocol/src/tasks.ts:193-196` |
| `search` | `(input: SearchTasksDto, options?) => Promise<TaskPageDto>` | `packages/protocol/src/tasks.ts:197` |
| `get` | `(ref: TaskRefDto, options?) => Promise<TaskDocumentDto>` | `packages/protocol/src/tasks.ts:198` |
| `searchActors` | `(input: SearchTaskActorsDto, options?) => Promise<TaskActorPageDto>` | `packages/protocol/src/tasks.ts:199` |
| `create` | `(input: CreateTaskDto, options?) => Promise<TaskDocumentDto>` | `packages/protocol/src/tasks.ts:200` |
| `assign` | `(input: AssignTaskDto, options?) => Promise<TaskDocumentDto>` | `packages/protocol/src/tasks.ts:201` |
| `previewTransition` | `(input: PreviewTaskTransitionDto, options?) => Promise<TaskTransitionPreviewDto>` | `packages/protocol/src/tasks.ts:202-205` |
| `transition` | `(input: TransitionTaskDto, options?) => Promise<TaskDocumentDto>` | `packages/protocol/src/tasks.ts:206` |
| `comment` | `(input: CommentTaskDto, options?) => Promise<TaskDocumentDto>` | `packages/protocol/src/tasks.ts:207` |
| `attachArtifact` | `(input: AttachTaskArtifactDto, options?) => Promise<TaskDocumentDto>` | `packages/protocol/src/tasks.ts:208` |

Every method except `status`/`capabilities` takes an `options?: TaskCallOptions` carrying only a
`signal` (`packages/protocol/src/tasks.ts:186-188`) — the type's own comment: "cancellation is local transport metadata and
is never serialized as params" (`packages/protocol/src/tasks.ts:185`).

### 2.4 `KernelTransport` — the seam a client sits on

Defined at `packages/protocol/src/transport.ts:29-68`, not part of `KernelClient` itself:

| Member | Signature | Line |
|---|---|---|
| `request<T>` | `(method: string, params?: unknown, options?: KernelRequestOptions) => Promise<T>` | `packages/protocol/src/transport.ts:37-41` |
| `notify` | `(method: string, params?: unknown) => void` | `packages/protocol/src/transport.ts:49` |
| `onNotification` | `(method: string, handler: (params: unknown) => void) => () => void` | `packages/protocol/src/transport.ts:58` |
| `onClose?` | `(handler: (reason?: unknown) => void) => () => void` | `packages/protocol/src/transport.ts:64` |
| `close` | `() => Promise<void>` | `packages/protocol/src/transport.ts:67` |

`KernelRequestOptions` (`packages/protocol/src/transport.ts:24-27`) carries exactly one field, `signal`.
It is local cancellation metadata; task operations explicitly keep it out of serialized parameters
through `TaskCallOptions` (`packages/protocol/src/tasks.ts:185-188`).

## 3. Data and formats

### 3.1 Foundational shared types (`common.ts`)

| Type | Shape | Line |
|---|---|---|
| `Scope` | `"global" \| "workspace"` | `packages/protocol/src/common.ts:11` |
| `Principal` | `{ readonly id: string; readonly display?: string }` | `packages/protocol/src/common.ts:22-26` |
| `ProjectRef` | `{ readonly id: string; readonly label?: string }` | `packages/protocol/src/common.ts:29-33` |
| `WorkspaceRef` | `{ id, projectId, label, kind: "primary" \| "external_worktree", path? }` | `packages/protocol/src/common.ts` |
| `Pagination` | `{ limit?: number; offset?: number }` | `packages/protocol/src/common.ts:55-58` |
| `Page<T>` | `{ items: T[]; total: number; limit: number; offset: number }` | `packages/protocol/src/common.ts:61-66` |
| `CursorPagination` | `{ limit?: number; cursor?: string }` | `packages/protocol/src/common.ts:69-72` |
| `CursorPage<T>` | `{ items: T[]; next_cursor?: string }` | `packages/protocol/src/common.ts:75-78` |
| `Timestamp` | `number` (epoch ms) | `packages/protocol/src/common.ts:81` |
| `JsonSchema` | `Record<string, unknown>` | `packages/protocol/src/common.ts:84` |
| `KernelErrorCode` | 11-member string union (below) | `packages/protocol/src/common.ts:87-98` |
| `KernelError` | `{ code, message, details?: unknown }` | `packages/protocol/src/common.ts:101-106` |
| `Unsubscribe` | `() => void` | `packages/protocol/src/common.ts:109` |

Two distinct pagination shapes coexist by design: offset/limit `Page<T>` for `RunService.list` and
`WorkflowsService.list` (whose contents are relatively stable), versus opaque-cursor `CursorPage<T>`
for `SessionService.listPage` and `PlansService.list` — described at the type's own definition as "for
stores whose contents change over time" (`packages/protocol/src/common.ts:68`). `PlanListInput`/`PlanListResult`
(`packages/protocol/src/plans.ts:113-130`) roll their own cursor field (`cursor?: string`, `next_cursor?: string`) rather
than embedding `CursorPagination`/`CursorPage<T>` directly — the shapes are structurally identical but
not the same declared type.

### 3.2 `KernelErrorCode` — the 11 stable error codes

`packages/protocol/src/common.ts:87-98`:

```
"unauthorized" | "not_found" | "invalid_request" | "conflict" | "unavailable" |
"unsupported" | "cancelled" | "capability_disabled" | "continuation_unavailable" |
"resource_exhausted" | "internal"
```

`KernelError` (`packages/protocol/src/common.ts:101-106`) wraps a code with a `message: string` and optional `details:
unknown` ("machine detail — validation issues, provider error, …", `packages/protocol/src/common.ts:104`).

### 3.3 `RunEvent` — the 39-variant discriminated union

Defined as `RunEvent` in `packages/protocol/src/runs.ts`, one large union type. Every variant and its
distinguishing fields:

| `type` | Extra fields (beyond `at`/attribution) | Source |
|---|---|---|
| `run_started` | `lead_model?`, `subagent_model?` | `packages/protocol/src/runs.ts:329` |
| `run_ended` | `status`, `reason?`, `code?` | `packages/protocol/src/runs.ts:330-346` |
| `iteration_started` | `iteration`, `model?` | `packages/protocol/src/runs.ts:347` |
| `iteration_completed` | `iteration`, `model?`, `response`, `response_phase?: "commentary"\|"final_answer"`, `input_tokens`, `output_tokens`, `cached_tokens?` | `packages/protocol/src/runs.ts:348-371` |
| `tool_call_started` | `call_id`, `tool`, `server`, `arguments?` | `packages/protocol/src/runs.ts:372-378` |
| `tool_call` | `call_id?`, `tool`, `server`, `arguments?`, `ok`, `result?`, `error?`, `diff?`, `guard?` | `packages/protocol/src/runs.ts:379-391` |
| `tool_output_delta` | `call_id`, `chunk` | `packages/protocol/src/runs.ts:397-401` |

`guard`, when present, is the strict `CommandGuardReview` object with mode,
allowed/denied outcome, and answerer. The run-event codec accepts exactly those
fields and enum values. Production: `CommandGuardReview`/the `tool_call` variant
in `packages/protocol/src/runs.ts` and `commandGuardReview` in
`packages/kernel/src/transport/run-event-codec.ts`. Test: `"preserves the
terminal shell auto-guard verdict"` in
`packages/kernel/tests/contract/transport-codecs.test.ts`.
| `tool_input_delta` | `call_id`, `tool`, `chars`, `stream_chars?`, `complete?: true` | `packages/protocol/src/runs.ts` (`RunEvent`) |
| `reasoning` | `iteration`, `text` | `packages/protocol/src/runs.ts:424` |
| `text_delta` | `iteration`, `channel: "text" \| "reasoning"`, `text`, `reset` | `packages/protocol/src/runs.ts:425-434` |
| `model_error` | `iteration`, `kind`, `message` | `packages/protocol/src/runs.ts:435` |
| `model_retry` | `iteration`, `kind`, `attempt`, `max_retries`, `delay_ms`, `status?`, `retry_after_ms?` | `packages/protocol/src/runs.ts:446-455` |
| `delegation_created` | `delegation_id`, `task_id?`, `title`, `task`, `profile?`, `tools?` | `packages/protocol/src/runs.ts:456-465` |
| `delegation_started` | `delegation_id`, `task_id?`, `model?` | `packages/protocol/src/runs.ts:466-472` |
| `delegation_completed` \| `delegation_failed` | `delegation_id`, `task_id?`, `status`, `summary?` | `packages/protocol/src/runs.ts:473-481` |
| `workflow_run_started` | `run_id`, `parent_run_id`, `profile?`, `title`, `task`, `round_id?`, `pass?`, `item_index?`, `replica?`, `replica_count?` | `packages/protocol/src/runs.ts:482-495` |
| `workflow_title_updated` | `run_id`, `title` | `packages/protocol/src/runs.ts:496-502` |
| `workflow_sequence_state` | `run_id`, `session_id`, six-state `status`, `revision`, current/proposed round/pass, `leaders_started`, `max_total_leaders`, `reason?` | `RunEvent` in `packages/protocol/src/runs.ts` |
| `workflow_run_progress` | `run_id`, `parent_run_id`, `iterations`, `input_tokens`, `output_tokens`, `cached_tokens?` | `RunEvent` |
| `workflow_run_completed` | `run_id`, `parent_run_id`, `status` | `RunEvent` |
| `workflow_run_failed` | `run_id`, `parent_run_id`, `status`, `error?` | `RunEvent` |
| `plan_created` | `PlanProjection` fields | `RunEvent` |
| `plan_updated` | `change: PlanUpdateChange` + `PlanProjection` fields | `RunEvent` |
| — `PlanUpdateChange`'s 4 values | `content` (objective/context/tasks body edit) · `task` (a task marker/detail change) · `status` (the plan's status changed) · `recovery` (state restored on continuation) — all glossed at the type's own doc comment | `packages/protocol/src/runs.ts:287-298` |
| `plan_removed` | `id`, `path?`, `revision`, `spec_revision` + partial `PlanProjection` | `RunEvent` |
| `plan_review_requested` | `PlanProjection` fields | `RunEvent` |
| `plan_review_resolved` | `outcome: "approved" \| "changes_requested" \| "cancelled"` + `PlanProjection` fields | `RunEvent` |
| `soft_limit_check` | `dimension: "tokens" \| "iterations"`, `used`, `limit`, `outcome` | `RunEvent` |
| `compaction_started` | `mode: "scheduled" \| "forced"` | `RunEvent` |
| `compaction` | `operation`, `fallback_reason?`, `freed_chars?`, `contribution_count?`, `requested?: true`, `user_contribution_count?` | `RunEvent` |
| `vision_analysis` | `model`, `image_count`, `status: "completed" \| "failed"`, `result` | `RunEvent` |
| `compaction_skipped` | `reason` (5-member union) | `RunEvent` |
| `elicitation_requested` | `agent?`, `subagent_id?`, `question`, `options?` | `RunEvent` |
| `elicitation_resolved` | `agent?`, `subagent_id?`, `question`, `outcome`, `answer?`, `options?` | `RunEvent` |
| `steering_applied` | `message` | `RunEvent` |
| `memory_ingest` | `detail: MemoryIngestDetail` | `RunEvent` |
| `capability_event` | `capability`, `kind`, `projection`, `detail?`, `truncated` | `RunEvent` |
| `events_dropped` | `dropped` | `RunEvent` |
| `mcp_degraded` | `servers: { name; reason }[]` | `RunEvent` |

Counted directly from the union source, the union has exactly **38 top-level alternation arms**. Of
those, 37 each declare exactly one `type`
string literal, and one arm declares two — `type: "delegation_completed" | "delegation_failed"`
(`packages/protocol/src/runs.ts:474`) covers both `delegation_completed` and `delegation_failed` in a single object shape,
since the two share every other field. 37 + 2 = **39 distinct `type` values**, which is exactly the
set the table above enumerates.

Durability is not inferable from the union alone. The kernel's exhaustive `RUN_EVENT_POLICY`, checked
with `satisfies Record<RunEvent["type"], RunEventPolicy>`, currently marks 15 values live-only:
`tool_output_delta`, `tool_input_delta`, `text_delta`, `workflow_title_updated`,
`workflow_sequence_state`, `workflow_run_progress`, all five plan events, `compaction_started`, `memory_ingest`,
`capability_event`, and `events_dropped` (`packages/kernel/src/runs/event-policy.ts:50-95`). Every
other value is persisted. This agrees with the protocol comments that call deltas streamed-only
(`packages/protocol/src/runs.ts:392-405`), workflow title/progress live-only
(`workflow_title_updated`/`workflow_run_progress` variants), and `events_dropped` streamed-only.
`elicitation_resolved` is explicitly the opposite: its `RunEvent` doc comment says it is persisted
for resume reconstruction and not shown live.

`tool_input_delta.chars` is cumulative for one `call_id`; optional `stream_chars` is cumulative
across text, reasoning, and tool-input characters in the physical provider attempt. The latter is
liveness evidence, not argument progress, and may advance while `chars` remains zero. This is not
one wire event per provider fragment. `complete: true` means the provider closed that call's argument stream, not that the tool
started or finished. Those transitions remain `tool_call_started` and terminal `tool_call`.
Another call's first input event cannot close an earlier one because providers may compose tool calls
in parallel. Production: `RunEvent` in `packages/protocol/src/runs.ts`. Test:
`packages/kernel/tests/contract/transport-codecs.test.ts` and
`packages/code/tests/unit/streaming-delta.test.ts`.

### 3.4 `StartRunParams` (`packages/protocol/src/runs.ts:70-115`)

| Field | Type | Notes |
|---|---|---|
| `execution_id?` | `string` | "Client-chosen id for idempotency + continuation; the kernel echoes it" (`packages/protocol/src/runs.ts:71-72`) |
| `messages` | `Message[]` | required |
| `agent?` | `string` | Agent Profile id; "the kernel translates it to the engine's profile/entry concept" (`packages/protocol/src/runs.ts:74-80`) |
| `continue_from?` | `string` | resume / steer-after-end |
| `prompt_cache_key?` | `string` | provider prompt-cache hint |
| `prompt_cache_ttl?` | `"5m" \| "1h"` | kernel derives it when omitted (`packages/protocol/src/runs.ts:86-94`) |
| `guard_mode?` | `GuardMode` | `"off" \| "on" \| "auto"` (`packages/protocol/src/runs.ts:45-46`) |
| `guard_judge?` | `GuardJudge` | caller-owned judge prompt/model/timeout |
| `memory?` | `MemoryMode` | `"on" \| "off"` (`packages/protocol/src/runs.ts:61`) |
| `plans?` | `PlansMode` | `"off" \| "on" \| "review"` (`packages/protocol/src/runs.ts:63-67`) |
| `task?` | `ActiveTaskRequestDto` | binds one external task |
| `skill?` | `{ name: string; task?: string }` | the `/skill` flow |
| `output_schema?` | `JsonSchema` | structured-output request |

### 3.5 `PlanProjection` and CAS revision pair

`PlanProjection` (`packages/protocol/src/runs.ts:269-285`) carries `id`, `path?`, `title`, `status: PlanStatus`,
`retention: PlanRetention`, `revision: number` ("monotonic counter bumped on every write — the CAS
baseline", `packages/protocol/src/runs.ts:280-281`), `spec_revision: number` ("bumped only when the plan's substance changes;
approval binds to it", `packages/protocol/src/runs.ts:282-283`), and `tasks: PlanTaskDto[]`. `PlanDocumentDto` (`packages/protocol/src/plans.ts:79-111`)
is the full document carried by `PlansService.read`, superset of `PlanProjection`'s fields plus
`created_at`, `updated_at`, `created_by_run`, `approved_spec_revision?`, `objective`, `context`,
`validation: string[]`, `notes`, and the canonical `markdown: string`.

### 3.6 Example wire values from the package's own test fixture

`packages/protocol/tests/contract/public-contract.fixture.ts` builds literal values satisfying the
real types (not illustrative prose — every field below is copied from that file):

```ts
// packages/protocol/tests/contract/public-contract.fixture.ts:31-36
const capabilities = {
  memory: true, skills: true, agent_tools: true,
  tasks: true,
} satisfies KernelCapabilities;

// packages/protocol/tests/contract/public-contract.fixture.ts:52-58
const startParams = {
  execution_id: "run-1",
  messages: [{ role: "user", content: "Inspect the workspace" }],
  plans: "review",
  task: { id: "CLAR-42", provider_key: "tasks:mcp:v1:sha256:fixture", mode: "work" },
  output_schema: { type: "object" },
} satisfies StartRunParams;

// packages/protocol/tests/contract/public-contract.fixture.ts:60-68
const textDelta = {
  type: "text_delta", at: 1, agent: "lead",
  iteration: 1, channel: "text", text: "Working", reset: false,
} satisfies RunEvent;
```

The same fixture goes on to compile-pin several whole interfaces via `satisfies`, beyond the three
literals above: `SettingsRepairPlan`'s `strip` variant (`packages/protocol/tests/contract/public-contract.fixture.ts:70-75` — `{ scope: "workspace",
revision: "sha256", action: "strip", dropped: ["providers.invalid"] }`), `CreateTaskDto`
(`packages/protocol/tests/contract/public-contract.fixture.ts:77-82`), and — in one contiguous block — `RunHandle` (`packages/protocol/tests/contract/public-contract.fixture.ts:96-114`), `RunService`
(`packages/protocol/tests/contract/public-contract.fixture.ts:116-145`), `SecretService` (`packages/protocol/tests/contract/public-contract.fixture.ts:147-158`) and `KernelTransport`
(`packages/protocol/tests/contract/public-contract.fixture.ts:160-180`). None of these five are exercised elsewhere in this document outside the
`client` object covered in §5 invariant 3.

### 3.7 The message/content model (`runs.ts`)

Every `StartRunParams.messages` entry and every `RunDetail.messages` entry is a `Message`
(`packages/protocol/src/runs.ts:40-43`): `{ role: Role; content: MessageContent }`. `Role` is `"user" | "assistant"`
(`packages/protocol/src/runs.ts:15`). `MessageContent` (`packages/protocol/src/runs.ts:37`) is `string | ContentPart[]` — plain text, or a
mixed sequence of parts. `ContentPart` (`packages/protocol/src/runs.ts:34`) is `TextPart | ImagePart`: `TextPart`
(`packages/protocol/src/runs.ts:18-21`) is `{ type: "text"; text: string }`; `ImagePart` (`packages/protocol/src/runs.ts:24-31`) is `{ type:
"image"; mime: string; data?: string; ref?: string }`, where `data` is inline base64 bytes and
`ref` is "a workspace-relative ref the kernel resolves" (`packages/protocol/src/runs.ts:29-30`) — the two are alternatives
on the same part rather than separate variants.

### 3.8 Run status, usage and the top-level run DTOs (`runs.ts`)

| Type | Shape | Line |
|---|---|---|
| `RunStatus` | `"running" \| "completed" \| "failed" \| "cancelled"` | `packages/protocol/src/runs.ts:117-118` |
| `AgentRole` | `"lead" \| "subagent"` | `packages/protocol/src/runs.ts:258-259` |
| `PerAgentUsage` | `{ role: AgentRole \| "vision"; model; input_tokens; output_tokens; cached_tokens; cache_write_tokens; iterations? }` | `packages/protocol/src/runs.ts:126-143` |
| `RunUsage` | `{ iterations; elapsed_ms; input_tokens?; output_tokens?; cached_tokens?; by_agent?: PerAgentUsage[]; warnings? }` | `packages/protocol/src/runs.ts:145-159` |
| `RunResult` | `{ execution_id; status: RunStatus; result?; ended_reason?; usage?: RunUsage; error?: { code; message } }` | `packages/protocol/src/runs.ts:161-172` |
| `RunSummary` | `{ execution_id; owner?; status; created_at; ended_at? }` | `packages/protocol/src/runs.ts:201-214` |
| `RunDetail` (extends `RunSummary`) | `+ messages: Message[]; events: RunEvent[]; result?: RunResult; continue_from?; plan_ref?: PlanRef; active_task?: ActiveTaskBindingDto; extension_profile?: ExtensionProfileRunRef; recovery?: RunRecovery` | `packages/protocol/src/runs.ts:235-255` |

`PerAgentUsage.role`'s `"vision"` member is not an agent: its own doc comment calls it "the engine's
image-reading pre-pass, one completion on a model no agent runs on" (`packages/protocol/src/runs.ts:130-132`) — the same
escape-hatch shape as `capability_event`'s open string (§5 invariant 4), applied to cost attribution
rather than to the event union. `RunUsage.by_agent` is optional because "a live run's final result may
report per-agent detail... instead" of the flat totals (`packages/protocol/src/runs.ts:150-151`), which are themselves
"present on a stored run (`get`)" but optional on a live result.

`ExtensionProfileRunRef` is deliberately only `{ id, fingerprint }`. `RunDetail.extension_profile`,
`SessionTurn.extension_profile`, and `SessionSummary.last_extension_profile` retain that identity without
serializing a definition, settings, or secrets (`packages/protocol/src/extension-profiles.ts:136-138`,
`packages/protocol/src/runs.ts:249-250`, `packages/protocol/src/sessions.ts:54-55`, `:102-103`).

### 3.9 Elicitation types (`runs.ts`)

| Type | Shape | Declaration |
|---|---|---|
| `ElicitationCommandDetail` | `{ command: string; cwd: string; reason: string; warning? }` | `ElicitationCommandDetail` |
| `WorkspaceMergeElicitationDetail` | `{ change_set_id; baseline_revision; content_digest; changes[] }` | `WorkspaceMergeElicitationDetail` |
| `ElicitationRequest` | `{ id; execution_id; kind; prompt; schema?: JsonSchema; detail?: ElicitationCommandDetail \| WorkspaceMergeElicitationDetail }` | `ElicitationRequest` |
| `ElicitationResponse` | `{ id; action: "accept" \| "decline" \| "cancel"; content? }` | `ElicitationResponse` |

`ElicitationRequest.kind` includes `"ask_user"` (a free question), `"guard_confirm"` (a
command awaiting approval), `"plan_review"` (a proposed plan awaiting approval), `"workflow_review"`
(an installed workflow preflight), and `"workspace_merge"` (one host-owned complete isolated-copy
review) — plus a deliberately open `(string & {})` escape, "so a kernel may
add kinds without a protocol bump" (`ElicitationRequest.kind` in `packages/protocol/src/runs.ts`).
This is structurally the same open/closed pattern already noted for `capability_event` in §5
invariant 4, applied to elicitation instead of to the `RunEvent` union itself.
`ElicitationCommandDetail` exists so a client "render[s] this directly
(e.g. as highlighted code) and never parse[s] `prompt`, which stays the human-readable fallback"
(`ElicitationCommandDetail` in `packages/protocol/src/runs.ts`).
`WorkspaceMergeElicitationDetail` supplies the same parse-nothing rule for isolated changes: clients
read its opaque revisions and exhaustive typed change list rather than interpreting prompt prose.

### 3.10 `ConfigService` data shapes I: settings and sandbox (`config.ts`)

| Type | Shape | Line |
|---|---|---|
| `WorkspaceTrustVerdict` | `{ state: "inert" \| "unapproved" \| "trusted" \| "changed"; fingerprint?; approved? }` | `packages/protocol/src/config.ts:11-15` |
| `SettingsData` | `{ default_model?; providers?: ProviderConfig[]; mcp_servers?: Record<string, McpServerConfig>; guard?: GuardConfig; sandbox?: SandboxConfig; runtime?: RuntimeConfig; memory?: MemoryConfig; budget?; [block: string]: unknown }` | `SettingsData` in `packages/protocol/src/config.ts` |
| `RuntimeConfig` | native, or `{ backend: "podman" \| "docker"; image_digest; network?; limits; executable; connection }` | `RuntimeConfig` in `packages/protocol/src/config.ts` |
| `ProviderConfig` | `{ name; kind?; base_url?; api_key_env?; [k]: unknown }` | `packages/protocol/src/config.ts:39-48` |
| `McpServerConfig` | `{ command?; args?; url?; [k]: unknown }` | `packages/protocol/src/config.ts:57-62` |
| `GuardConfig` | `{ mode?: "off" \| "on" \| "auto"; allowed_commands?; denied_commands?; [k]: unknown }` | `packages/protocol/src/config.ts:65-70` |
| `MemoryConfig` | `{ enabled?; model?; [k]: unknown }` | `packages/protocol/src/config.ts:179-183` |
| `SandboxConfig` | `{ type: "native"; enabled?; availability?: "required" \| "optional"; filesystem?; network?; pass_env?; toolchains?: { mode?: "auto" \| "manual"; include?; exclude?; extra_paths?; excluded_paths? } }` | `packages/protocol/src/config.ts` (`SandboxConfig`) |
| `SandboxToolchainScope` | `"system" \| "auto" \| "global" \| "workspace"` | `packages/protocol/src/config.ts:110` |
| `SandboxInspection` | `{ backend: { type: "bubblewrap" \| "seatbelt" \| "unsupported"; available; mode: "fresh-proc" \| "host-proc" \| "seatbelt" \| "unavailable"; degraded; reason? }; toolchains: SandboxToolchainStatus[]; extra_paths: SandboxPathStatus[]; effective_path: string[] }` | `packages/protocol/src/config.ts` (`SandboxInspection`) |

`RuntimeConfig` is the host-operator input, not a run grant. Omitting a container `network` selects
the kernel's ordinary routable `outbound` default; this may reach host and LAN peers as well as the
public internet. `RuntimeStatus.network` in `client.ts` is required for container placement because
it reports the effective value after the kernel has resolved defaults. Neither type calls
`outbound` internet-only, and the protocol exposes no host-port or engine-argument mutation method.

Production: `RuntimeConfig` and `SettingsData` in `packages/protocol/src/config.ts`;
`RuntimeStatus` in `packages/protocol/src/client.ts`; `runtimeSettingsSchema` in
`packages/kernel/src/runtime/settings.ts`. Test: `runtime settings` in
`packages/kernel/tests/unit/runtime-settings.test.ts`; `runtime status` coverage in
`packages/kernel/tests/contract/transport-codecs.test.ts`.

`SandboxInspection.backend` identifies what the host actually probed: Bubblewrap uses `fresh-proc`
or degraded `host-proc`, Seatbelt uses `seatbelt`, and an unavailable selected/unsupported backend
uses `unavailable` (`packages/protocol/src/config.ts`, `SandboxInspection`). `SandboxToolchainScope`'s four
values name where a discovered toolchain (or read-only path) originates: `"system"` (already on the
host `PATH`), `"auto"` (found by discovery), or the `"global"` / `"workspace"` settings scope that
declared it (`packages/protocol/src/config.ts:105-110`). This is the return shape behind `ConfigService.inspectSandbox`,
whose §2.3 table row names only the method signature.

### 3.11 `ConfigService` data shapes II: repair plan and agents (`config.ts`)

`SettingsRepairPlan` (`packages/protocol/src/config.ts:251-265`) is a 2-variant discriminated union on `action`, both variants
carrying `scope: Scope` and `revision: string` (the SHA-256 the repair is bound to, per §4 item 4):
`"strip"` additionally carries `dropped: string[]` — "dotted paths the kernel will remove from
otherwise parseable JSON" (`packages/protocol/src/config.ts:257`) — and `"reset"` carries `reason: string`, "why no safe
field-level repair could be produced" (`packages/protocol/src/config.ts:264`). The package's own test fixture exercises the
`strip` variant literally: `{ scope: "workspace", revision: "sha256", action: "strip", dropped:
["providers.invalid"] }` (`packages/protocol/tests/contract/public-contract.fixture.ts:70-75`).

`AgentBudget` (`packages/protocol/src/config.ts:268-271`) is `{ on_exceed?: string; total_token_limit?: number }`.
`AgentSummary` (`packages/protocol/src/config.ts:292-311`) is `{ name; scope: Scope | "plugin" | "builtin"; model?;
description?; plugin?; grants?: string[]; can_spawn?: string[]; budget?: AgentBudget; overlay?:
AgentOverlay }` — `grants` being `undefined` specifically means "the frontmatter
could not be parsed" (`packages/protocol/src/config.ts:302-304`).

`SettingsView.known_grants?: readonly string[]` (`packages/protocol/src/config.ts:227-241`) lists "every capability grant an
agent profile in this workspace may name" and is populated only by the kernel, "an optional feature
package contributes its own grant, so the set is a property of what this kernel actually composed"
(`packages/protocol/src/config.ts:231-233`). Its own remark names the defect that motivated it: a stale `image` grant "left
by the vision-routing refactor... was reported 'runnable' by Doctor and the agent editor while every
run in the workspace was rejected before its first model call" (`packages/protocol/src/config.ts:234-237`). Absent when the
kernel did not report it, in which case "a client must then skip the check rather than assume a
vocabulary" (`packages/protocol/src/config.ts:238-239`).

### 3.12 `MemoryService` health and job DTOs (`memory.ts`)

| Type | Shape | Line |
|---|---|---|
| `MemoryHealthFinding` | `{ code: string; severity: MemoryHealthSeverity; path: string; message: string; suggested_action: string }` | `packages/protocol/src/memory.ts:27-38` |
| `MemoryHealthSeverity` | `"error" \| "warning" \| "info"` | `packages/protocol/src/memory.ts:25` |
| `MemoryHealthReport` | `{ generated_at; totals: { documents; topics; memories; pending_jobs; failed_jobs }; counts: Record<MemoryHealthSeverity, number>; findings: MemoryHealthFinding[]; truncated: boolean; skipped_codes: string[] }` | `packages/protocol/src/memory.ts:46-62` |
| `MemoryJobState` | `"pending" \| "running" \| "retry_wait" \| "completed" \| "failed"` | `packages/protocol/src/memory.ts:73` |
| `MemoryJobError` | `{ phase: string; message: string; at: Timestamp }` | `packages/protocol/src/memory.ts:76-82` |
| `MemoryJob` | `{ run_id; state: MemoryJobState; attempts; enqueued_at; updated_at; next_attempt_at?; last_error?: MemoryJobError; note? }` | `packages/protocol/src/memory.ts:85-99` |

`MemoryJobState`'s own comment: `"retry_wait"` is "a failed attempt serving out its backoff" and
`"failed"` is "terminal until an operator retries, and the job is kept as the evidence that something
needs attention" (`packages/protocol/src/memory.ts:67-69`). `MemoryJobError.phase` names one of `generate`/`validate`/
`apply`/`reindex`/`commit` (`packages/protocol/src/memory.ts:77`).

### 3.13 `TasksService` DTO field lists (`tasks.ts`)

| Type | Shape | Line |
|---|---|---|
| `TaskStageDto` | 8-value union: `backlog` \| `ready` \| `active` \| `blocked` \| `review` \| `done` \| `cancelled` \| `other` | `packages/protocol/src/tasks.ts:3-4` |
| `TaskActorDto` | `{ id; label; kind: "human" \| "team" \| "agent" \| "service" \| "unknown" }` | `packages/protocol/src/tasks.ts:24-28` |
| `TaskClaimDto` | `{ claimant: TaskActorDto; execution_id: string; claimed_at: string }` | `packages/protocol/src/tasks.ts:30-34` |
| `TaskProviderCapabilitiesDto` | `{ protocol_version: 2; provider_instance_id; provider_kind; read: { containers; search; get; actors }; write: { create; assign; comment; attach_artifact; intents: TaskTransitionIntentDto[] }; concurrency: "none" \| "revision" \| "exclusive_claim" }` | `packages/protocol/src/tasks.ts:57-70` |
| `TaskProviderStatusDto` | `{ state: "not_configured" \| "ready" \| "unavailable" \| "incompatible"; provider_key?; provider_kind?; server?; writes: "disabled" \| "enabled"; reason? }` | `packages/protocol/src/tasks.ts:72-79` |

`TaskContainerPageDto` (`{ items: TaskContainerRefDto[]; next_cursor? }`, `packages/protocol/src/tasks.ts:81-84`) and
`TaskPageDto` (`{ items: TaskSummaryDto[]; next_cursor? }`, `packages/protocol/src/tasks.ts:86-89`) are each a bespoke
`items` + `next_cursor` shape — a third pagination idiom alongside the offset/limit `Page<T>` and the
generic `CursorPage<T>` (§3.1), and structurally distinct from `PlansService`'s own bespoke
`cursor`/`next_cursor` fields (`packages/protocol/src/plans.ts:113-130`) despite serving the same purpose.

### 3.14 `PluginService`, `SkillsService` and `ModelCatalogService` data shapes

`PluginContributions` (`packages/protocol/src/plugins.ts:52-73`): `{ agents: string[]; broken_agents: string[]; skills:
string[]; servers: string[]; hooks: number; capability_executables: PluginCapabilityExecutable[];
capability_run_policies?: { plans?: { skills: Record<string, "off" | "on" | "review"> } };
executables: string[] }` — `hooks` is "count of hook entries (not their names)" and `executables` are
"concrete commands this plugin would run... pre-formatted for display" (`packages/protocol/src/plugins.ts:59-72`).
`PluginView.display_name`/`short_description` (`packages/protocol/src/plugins.ts:100-109`) are documented as "display data
only. A plugin cannot widen what it is allowed to do by describing itself well: trust stays with the
process-pinned Extension Profile and workspace trust boundary" (`packages/protocol/src/plugins.ts`,
`PluginView.display_name`).
`PluginView` also preserves the manifest's `author` object, homepage, repository, license, keywords,
and the full optional install-surface presentation bucket. `PluginInstallSource` is the closed union
of `{ kind: "git", url, subdir?, ref?, sha?, expected_name? }`,
`{ kind: "local", path, expected_name? }`, and
`{ kind: "npm", package, version?, registry?, expected_name? }`; source interpretation therefore crosses the wire
without asking the kernel to re-parse a marketplace dialect.
`PluginRef` is the strict `{ scope: "global"|"workspace", source: "agents"|"clarvis", name }`
identity shared by lifecycle, activation, and Extension Profile DTOs; `PluginView.source`
reports the same filesystem convention and `install_source` is separately reserved for Git origin.

`SkillSummary.dependencies?` carries bounded `SkillToolDependency[]` entries of `type: "mcp"` with
server `value` and optional descriptive transport/URL fields. It is diagnostic/catalog metadata,
not a server grant or an installation request. Production: `packages/protocol/src/skills.ts`. Test:
projection in `packages/kernel/tests/component/skills-service.test.ts`.

`ModelCost` (`packages/protocol/src/models.ts:11-20`): `{ input: number; output: number; cache_read?: number;
cache_write?: number }` — four price-per-token fields. `CatalogProvider.needs_base_url: boolean`
(`packages/protocol/src/models.ts:40-55`) is "`true` when this is an OpenAI-compatible endpoint with no `base_url` yet — the
UI must prompt for one" (`packages/protocol/src/models.ts:50-53`).

## 4. Behavior

`@clarvis/protocol` has no runtime behavior of its own — it is erased at compile time (§7). What
follows is the *contract* the code encodes as call/return shape, as stated in the doc comments
attached to each method:

1. A client obtains a `KernelClient` (construction is out of scope for this package — see
   `specs/hosts/kernel-transport.md`) whose `capabilities`, `principal`, `project`, `workspace` are
   populated "at connect time" (`packages/protocol/src/client.ts:53` doc comment on `capabilities`).
2. `runs.start(params)` returns a `RunHandle` immediately; the run's `events` stream, `done` and
   `closed` promises are the three ways a caller observes its outcome (`RunHandle` in
   `packages/protocol/src/runs.ts`).
3. While a run is live, a caller may call `steer`, `compact`, `cancel`, or `respond` to a pending
   elicitation on the same `RunHandle` — these are the only mutating operations scoped to one
   in-flight run; everything else in `KernelClient` is either a service-level CRUD call or a
   `subscribe`.
4. `ConfigService.updateSettings` and `repairSettings` both take an `expectedRevision`
   (`packages/protocol/src/config.ts:413-417`, `:378`) — the doc comment on `updateSettings` states "a mismatch is a typed
   conflict and never overwrites the concurrent edit" (`packages/protocol/src/config.ts:409-411`), and `repairSettings`
   "throws a `conflict` kernel error when the file changed or disappeared after preview; no bytes are
   overwritten in that case" (`packages/protocol/src/config.ts:373-378`). This is optimistic concurrency control expressed
   purely through the method signature and its doc comment — no implementation of the check lives in
   this package.
5. `TasksService`'s `assign`, `transition`, `comment`, and `attachArtifact` DTOs each carry an optional
   `expected_revision` (for example `AssignTaskDto.expected_revision?`,
   `packages/protocol/src/tasks.ts:134-139`). `PlansService.setRetention` and `.delete` do not expose a
   revision argument (`packages/protocol/src/plans.ts:136-173`); the protocol therefore does not claim
   client-bound CAS for those two operations.
6. `TasksService.transition`'s own DTO comment states it is "human control-plane transitions" that
   "exclude `start`, which belongs to a bound run" (`packages/protocol/src/tasks.ts:141`) — i.e. the `TaskTransitionIntentDto`
   union has a `"start"` member (`packages/protocol/src/tasks.ts:6`) that `TransitionTaskDto.intent` deliberately cannot
   carry (`Exclude<TaskTransitionIntentDto, "start">`, `packages/protocol/src/tasks.ts:145`), forcing that transition to
   happen only through a run's own binding.
7. `PreviewTaskTransitionDto`/`TaskTransitionPreviewDto` (`packages/protocol/src/tasks.ts:173-183`) gate `complete`/`reopen`
   behind a `confirmation_token` that `TransitionTaskDto.confirmation_token` is documented as
   "required for complete/reopen and minted by previewTransition" (`packages/protocol/src/tasks.ts:148-149`) — the same
   preview-token pattern, applied to exactly two transition intents.

### State implied by `PlanTaskStatus` (`packages/protocol/src/plans.ts:37-38`)

| Status | Meaning | Closes the task? |
|---|---|---|
| `pending` | not started | no |
| `in_progress` | working | no |
| `returned` | "a sub-agent's hand-back that still awaits the lead's judgment" | no — explicitly "not a closed state" (`packages/protocol/src/plans.ts:32-33`) |
| `done` | complete, carries `result` | yes |
| `abandoned` | complete, carries `reason` | yes |
| `failed` | complete, carries `error` | not stated as closing in this file's comment, but grouped with done/abandoned as requiring "a matching outcome field" (`packages/protocol/src/plans.ts:34-35`) |

### `PlanStatus` (`packages/protocol/src/plans.ts:19`)

`"awaiting_approval" | "active" | "completed" | "cancelled" | "failed"` — the doc comment states only
`completed`/`cancelled`/`failed` "may be deleted" (`packages/protocol/src/plans.ts:16-17`, matching
`PlansService.delete`'s own throw condition at `packages/protocol/src/plans.ts:169-170`).

## 5. Invariants

The following are derived directly from this package's own source and tests.

1. **The package's public surface is exhaustively type-only: every export is `interface`/`type`, and
   every sibling module is re-exported with `export type *`.**
   Production: `packages/protocol/src/index.ts:12-29` (18 `export type *` lines).
   Test/enforcement: `tooling/checks/coverage.ts:306-330`'s `findUnmeasuredSources` calls
   `looksExecutionFree` (`tooling/checks/coverage.ts:286-294`) on every module of a
   `TYPE_ONLY_PACKAGES` member (`tooling/checks/coverage.ts:54`, containing only `"protocol"`) and
   fails the coverage gate if any module contains a real `export const/function/class/enum/default`
   or a value re-export — independent of whether any test imported it. This is a build-tooling
   invariant, not a `bun test` assertion, but it runs as part of `check:pre-commit`.

2. **No file anywhere in `src/` or `tests/` imports a runtime value from `@clarvis/protocol` —
   every import is `import type` (or an `export type` re-export).**
   Verified directly by running it: a multiline ripgrep search for
   `import \{[^}]*\} from "@clarvis/protocol";` (a *value*-form brace import, as opposed to
   `import type { ... }`) across every `packages/*/src` and `packages/*/tests` tree returns **zero**
   matches, while the same search restricted to `import type` returns matches in every consumer
   (`code`, `kernel`, `server`). All three consumer tsconfigs enable `verbatimModuleSyntax`
   (`packages/code/tsconfig.json:14`, `packages/kernel/tsconfig.json:11`,
   `packages/server/tsconfig.json:11`), so their normal typechecks reject a future bare
   value-form import of an interface or alias. There is no separate architecture assertion that
   enumerates this property; compiler enforcement is the pin.

3. **`KernelClient` aggregates exactly 15 named services, not more or fewer.**
   Production: `packages/protocol/src/client.ts` — `runs`, `config`, `plugins`, `secrets`, `models`, `providerAuth`, `files`, `memory`,
   `plans`, `workflows`, `skills`, `sessions`, `tasks`, `storage`, `extensionProfiles` (15 fields, plus 4
   readonly identity fields and `close()`).
   Test: `packages/protocol/tests/contract/public-contract.fixture.ts:196-216` constructs a literal
   `satisfies KernelClient` naming every one of the 15 services plus `capabilities`/`project`/
   `workspace`/`close` — a fixture that would fail to typecheck (and thus fail `bun run test:contract`,
   which is literally `tsc -p tsconfig.json`, `packages/protocol/package.json:26`) if a service were
   missing or an extra one were required. The same fixture file separately compile-pins `RunHandle`,
   `RunService`, `SecretService` and `KernelTransport` in full via their own `satisfies` blocks
   (`packages/protocol/tests/contract/public-contract.fixture.ts:96-180`, §3.6) and `SettingsRepairPlan`/`CreateTaskDto` as single literals
   (`packages/protocol/tests/contract/public-contract.fixture.ts:70-75`, `:77-82`) — five further interfaces get compile-time pinning beyond the
   `KernelClient` aggregate and the lone `RunEvent` variant this invariant and invariant 4 discuss.
   Also pinned from the consumer side: `KernelServices` in
   `packages/kernel/src/transport/operations.ts` is a `Pick<KernelClient, ...>` naming the same 15 service keys
   (minus the 4 identity fields, which are not "services").

4. **`RunEvent` is closed to exactly 39 named variants; an open/unknown capability event is carried
   through the single `capability_event` escape variant rather than by widening the union.**
   Production: `RunEvent` in `packages/protocol/src/runs.ts`; the `capability_event` variant's own
   doc comment says capability event names are deliberately open at the capability boundary while
   this discriminated union stays closed for clients, so an extension cannot make an exhaustive
   protocol switch crash at runtime. The numeric count is unpinned by this package's
   own tests (the fixture exercises one variant, `text_delta`,
   `packages/protocol/tests/contract/public-contract.fixture.ts:60-68`), but the kernel's exhaustive
   `RUN_EVENT_POLICY` makes a new discriminator fail typechecking until its source, durability,
   mapping and backpressure behavior are classified (`packages/kernel/src/runs/event-policy.ts:50-95`).

5. **A `TransitionTaskDto` can never carry the `"start"` transition intent.**
   Production: `TaskTransitionIntentDto` (`packages/protocol/src/tasks.ts:6`) includes `"start"`;
   `TransitionTaskDto.intent` is typed `Exclude<TaskTransitionIntentDto, "start">` (`packages/protocol/src/tasks.ts:145`).
   The type's own comment: "Human control-plane transitions exclude `start`, which belongs to a bound
   run" (`packages/protocol/src/tasks.ts:141`). This is a compiler-enforced invariant (assigning `"start"` to that field is
   a type error) with no runtime test in this package; **unpinned** at the `bun test` layer, enforced
   only by `tsc`.

6. **`PlansService.list`/`SessionService.listPage` use opaque-cursor paging; `RunService.list`/
   `WorkflowsService.list` use offset/limit paging — the two families are never interchanged.**
   Production: `packages/protocol/src/plans.ts:144` (`PlanListInput.cursor?`, `packages/protocol/src/plans.ts:116`), `packages/protocol/src/sessions.ts:110`
   (`CursorPagination`, `packages/protocol/src/common.ts:69-72`) versus `RunService.list` and
   `WorkflowsService.list` (both `Pagination`, `packages/protocol/src/common.ts:55-58`). No cited
   rationale beyond the type comment "for stores whose
   contents change over time" (`packages/protocol/src/common.ts:68`); unpinned by any test in this package.

7. **Compaction start is an explicit `RunEvent` rather than inferred from a later outcome.**
   `compaction_started` carries attribution plus `mode`, while `compaction` may carry only the
   bounded `fallback_reason` values `summarization_failed` or `summary_not_effective`.
   Production: `packages/protocol/src/runs.ts` (`RunEvent`). Test:
   `packages/kernel/tests/contract/transport-codecs.test.ts` ("preserves compaction lifecycle and
   fallback attribution") round-trips both strict wire shapes.

8. **`PlanProjection.revision` and `.spec_revision` are two independently-bumped counters, and a
   human approval binds only to the second.**
   Production: `packages/protocol/src/runs.ts:280-283` — "Monotonic counter bumped on every write (the CAS baseline)" vs.
   "Counter bumped only when the plan's substance changes; approval binds to it." Restated
   identically at `packages/protocol/src/plans.ts:90-93` and again on `PlanDocumentDto.approved_spec_revision`
   (`packages/protocol/src/plans.ts:100-101`, "The `spec_revision` a human approved"). Consistent across three independent
   declarations in two files; unpinned by a test in this package (the CAS mechanics are plan-package
   territory — see `specs/hosts/protocol.md` §8 delegation note and the sibling plan-capability document).

9. **Extension Profile selection and composition are preview-bound, while execution history carries only
   its minimal identity.** `ExtensionProfileService.select`, `.clearSelection`, and
   `.applyComposition` require `preview_token`; composition and definition updates require an exact
   expected revision, and `ExtensionProfileRunRef` contains only `id` and `fingerprint`.
   Production: `ExtensionProfileRunRef`, `ExtensionProfileCompositionInput`, and `ExtensionProfileService` in
   `packages/protocol/src/extension-profiles.ts`. Test:
   `packages/protocol/tests/contract/public-contract.fixture.ts:196-216` compile-pins the service on
   `KernelClient`; runtime behavior is pinned by
   `packages/kernel/tests/integration/extension-profile-manager.test.ts` and owned by
   [Extension Profiles](extension-profiles.md#5-invariants).
10. **Marketplace dialect does not cross the kernel protocol boundary.** Clients project a listing
    into the closed `PluginInstallSource` union; kernels receive an explicit Git/local/npm source and
    apply acquisition policy there. Production: `PluginInstallSource` and
    `PluginService.installSource` in `packages/protocol/src/plugins.ts`. Test: service projection and
    install-source cases in `packages/code/tests/integration/app-commands.test.tsx` and
    `packages/kernel/tests/integration/plugin-service.test.ts`.
11. **Publisher identity and skill requirements survive the wire as metadata, never authority.**
    `PluginView.author` is distinct from presentation developer/display names, and
    `SkillSummary.dependencies` cannot add an MCP server. Production:
    `packages/protocol/src/{plugins,skills}.ts`. Test:
    `packages/kernel/tests/integration/plugin-service.test.ts` and
    `packages/kernel/tests/component/skills-service.test.ts`.
12. **The workflow checkpoint uses the same closed shape live and at rest.**
    `workflow_sequence_state` and `WorkflowSequence` carry the same six-state lifecycle, CAS
    revision, current/proposed round/pass and cumulative leader counters; `WorkflowDetail.sequence`
    is optional only for legacy/ad-hoc-only records. The live event is classified non-droppable but
    live-only because the workflow store, not the run journal, owns durable recovery.
    Production: `RunEvent` in `packages/protocol/src/runs.ts`, `WorkflowSequence` in
    `packages/protocol/src/workflows.ts`, and `RUN_EVENT_POLICY`.
    Test: `packages/kernel/tests/contract/transport-codecs.test.ts` (`preserves the workflow round
    checkpoint contract`) and `packages/kernel/tests/integration/workflows-service.test.ts` (`emits
    and persists every Admiral-controlled round checkpoint`).

## 6. Failure modes and degradation

This package defines no error *handling* — it defines the vocabulary a kernel is expected to return
errors in, and documents on individual methods where a specific code applies:

| Situation | Code / shape | Where documented |
|---|---|---|
| Generic kernel-level failure | `KernelError` with one of 11 `KernelErrorCode` values | `packages/protocol/src/common.ts:87-106` |
| A settings write raced a concurrent edit | `conflict` | `packages/protocol/src/config.ts:409-411` (`updateSettings`), `:373-378` (`repairSettings`) |
| Memory not configured on this kernel | `capability_disabled` (implied by `KernelErrorCode`, applied per `packages/protocol/src/memory.ts:9-10`'s doc comment "the methods reject with a `capability_disabled` / memory-disabled `KernelError`") | `packages/protocol/src/memory.ts:9-10` |
| Deleting a plan that is still `active`/`awaiting_approval` | throws (unspecified which `KernelErrorCode`, but the method's own doc says "throws when the plan is still live") | `packages/protocol/src/plans.ts:169-170` |
| A run ended on a failure | `RunResult.error?: { code: string; message: string }`, "present only on a `failed` run" | `packages/protocol/src/runs.ts:170-171` |
| A workflow leader failed | `workflow_run_failed`'s `error?: { code; message }` | `RunEvent` in `packages/protocol/src/runs.ts` |
| A run was rebuilt from a damaged crash journal | `RunDetail.recovery?: RunRecovery` — `skipped_lines` and `synthesized_tool_calls` counts, "present ... only when something was actually lost or synthesized, so its absence means the record is intact" | `packages/protocol/src/runs.ts:216-232`, `:251-255` |
| A settings scope file exists but fails to parse/validate | `SettingsSource.error?: string` — "the UI shows this instead of silently treating the scope as empty" | `packages/protocol/src/config.ts:186-197` |
| An Extension Profile selection or definition is invalid | `ResolvedExtensionProfile.status: "invalid"` plus typed `ExtensionProfileIssue[]`; no fallback is represented | `ExtensionProfileStatus`, `ExtensionProfileIssue`, and `ResolvedExtensionProfile` in `packages/protocol/src/extension-profiles.ts` |
| An Extension Profile reference is missing or a workspace executable surface is untrusted | `status: "degraded"` plus the exact `missing_plugin`, `missing_skill`, or `workspace_untrusted` issue | `ExtensionProfileIssueCode` in `packages/protocol/src/extension-profiles.ts` |
| An agent config file's frontmatter fails to parse | `AgentDoc.malformed?: string` — "the `frontmatter` above is then the lenient fallback (`{}`), not the file's real content" | `packages/protocol/src/config.ts:314-331` |
| An agent config file overlaying a shipped agent is unusable | `AgentOverlay.status: "rejected"` + `reason` — "the shipped default runs unchanged" | `packages/protocol/src/config.ts:282-289` |
| A repository's `settings.json` asked for fields it may not set on its own authority | `SettingsView.withheld_workspace_fields?: readonly string[]` | `packages/protocol/src/config.ts:200-242` |
| A capability event's own type is not in this protocol version | `capability_event` with `projection`/`truncated` fields rather than a widened `type` | `RunEvent.capability_event` |
| Live event consumer fell behind (backpressure) | `events_dropped` — "emitted at most once... only incremental variants are ever dropped, and their authoritative content still arrives" | `RunEvent.events_dropped` |
| MCP servers degraded for this run | persisted `mcp_degraded` event listing `{ name, reason }[]`; clients may present it ephemerally rather than as conversation content | `RunEvent.mcp_degraded` |
| A tool call the provider abandoned mid-stream never settles | not modeled by this package at all — the closest adjacent shape, `tool_call_started`, has no corresponding "abandoned" variant; only `tool_call` (`ok: boolean`) is authoritative |

Two properties the package states about *degradation of fidelity* rather than error per se:

- `events_dropped`'s own comment: dropping only ever affects incremental/live-only variants, and "the
  authoritative content still arrives — a `tool_call` carries its tool's full output and
  `iteration_completed.response` the final assistant text — so this reports fidelity of the *live*
  view, not data loss" (`events_dropped` in `RunEvent`).
- `RunRecovery`'s own comment: "counts only: the skipped lines themselves never cross the wire"
  (`packages/protocol/src/runs.ts:216-223`) — a client is told *how much* was lost, never *what*.

## 7. Coupling

### 7.1 Depends on

Nothing. `packages/protocol/package.json` has no `dependencies`/`devDependencies`/
`optionalDependencies`/`peerDependencies` key at all (`packages/protocol/package.json:1-33`, read in
full — no such key appears). Its own `.ts` files import nothing from any other package; every
`import type` among its 19 files points at a sibling module inside `packages/protocol/src/`
(`packages/protocol/src/{client,config,extension-profiles,memory,models,plugins,runs,sessions,skills,tasks,workflows}.ts`).
The remaining eight modules import nothing; `index.ts` only type-reexports siblings. There is no
cross-package source import in this package.

### 7.2 Depended on by

Every consumer reaches it **only as a type import**, verified directly (§5, invariant 2):

| Consumer | Value imports | Type imports | Forcing mechanism |
|---|---|---|---|
| `@clarvis/kernel` | 0 | 91 source/test files currently import the public barrel, all with `import type` | `packages/kernel/tsconfig.json:12-13` maps `@clarvis/protocol` to the package's own **source**, so `tsc` checks the implementation directly against these interfaces |
| `@clarvis/server` | 0 | 15 source/test files currently import the public barrel, all with `import type` | `packages/server/tests/architecture/dependency-boundary.test.ts` fixture-tests that the type import is an allowed boundary |
| `@clarvis/code` | 0 | 110 source/test files currently import the public barrel, all with `import type` | `packages/code/tests/architecture/dependency-boundary.test.ts` pins `code`'s Clarvis-namespaced manifest dependencies to `@clarvis/kernel`, `@clarvis/paths`, and `@clarvis/protocol` |

Both `code`'s and `server`'s dependency-boundary tests explicitly *permit* `@clarvis/protocol` (it is
absent from both files' `FORBIDDEN` arrays — `packages/code/tests/architecture/dependency-boundary.test.ts:13-22`,
`packages/server/tests/architecture/dependency-boundary.test.ts:5-11`) while forbidding `@clarvis/loop`
and every engine-layer package — i.e. the test suite encodes "may depend on protocol, may not depend
on the engine" as one design, not two.

### 7.3 What forces the type-only property, structurally

1. `verbatimModuleSyntax: true` in `packages/protocol/tsconfig.json:9` forces every re-export in
   `index.ts` to be spelled `export type *` rather than plain `export *` — a plain `export *` of an
   `interface`-only module would still compile under a looser setting, but under this one the
   compiler requires the `type` modifier once nothing in the module is a value.
2. `tooling/checks/coverage.ts`'s `TYPE_ONLY_PACKAGES` gate (§5, invariant 1) makes a *regression* —
   someone adding a real `export const` to any protocol module — fail the coverage step of
   `check:pre-commit`, independent of whether any test imports the new symbol.
3. `packages/kernel/tsconfig.json:12-13`'s `paths` mapping to **source** (not `dist`) means the kernel's
   own `tsc` run is the thing that would catch a signature mismatch between what `client.ts` promises
   and what `kernel.ts` actually implements — there is no build step in between that could paper over
   drift.

## 8. Open questions

- **Why two independent pagination families exist** (offset/limit vs. cursor) is stated as an
  intent ("stores whose contents change over time", `packages/protocol/src/common.ts:68`) but no test or runtime code in
  this package demonstrates a failure mode the offset/limit family would actually suffer under
  mutation — the reasoning is asserted in a comment, not shown.
- **A remote HTTP/WebSocket `KernelTransport` remains unimplemented.** The current kernel exports an
  in-process client, `createLoopbackTransport`, `createStdioTransport`, and
  `serveKernelOverStdio` (`packages/kernel/src/index.ts`). The HTTP-facing `@clarvis/server` exposes
  MCP rather than a `KernelTransport`; `Principal` and `ConnectOptions.auth` therefore remain
  forward-compatible hosted-kernel shapes rather than a transport exercised in this repository.
- **The exact set of `KernelErrorCode` values a given method can actually return** is not enumerated
  per-method anywhere in this package outside the handful of doc-comment mentions captured in §6 —
  most methods simply return `Promise<T>` with no declared error type, so a client cannot know from
  the type alone which of the 11 codes a given call might raise. This is presumably resolved by
  kernel-side documentation/behavior outside this document's scope.
- **The numeric `RunEvent` count is not pinned as 39.** No protocol-package test counts union arms,
  and its fixture constructs only `text_delta` (`packages/protocol/tests/contract/public-contract.fixture.ts:60-68`).
  Growth is nevertheless not silent inside the kernel: `RUN_EVENT_POLICY` exhaustively keys
  `RunEvent["type"]`, so a new value must first receive source, durability, mapping and backpressure
  classifications (`packages/kernel/src/runs/event-policy.ts:50-95`). Client exhaustiveness remains
  the responsibility of each consumer.
- **The one test file this package owns** (`tests/contract/public-contract.fixture.ts`) is exercised
  only via `tsc -p tsconfig.json` (`packages/protocol/package.json:26-28`) — there is no `bun test` runner invocation
  for `protocol` beyond that typecheck, and `test:coverage` is an alias for the same command
  (`packages/protocol/package.json:27`). This means "coverage" for this package, as reported by
  `tooling/checks/coverage.ts`, is entirely the `looksExecutionFree` static scan (§5, invariant 1),
  never an executed-line count — consistent with, but worth stating plainly: there is no runtime
  test of this package at all, by construction, because there is no runtime to test.
  **Recorded 2026-08-22**: this is a design the gate enforces rather than an unguarded assumption —
  `looksExecutionFree` runs over every module of a `TYPE_ONLY_PACKAGES` member and fails on a runtime
  export *even when a stale report happens to mention that module*, which
  `tooling/tests/unit/coverage.test.ts` pins directly. The report-staleness warning added to
  `coverage.ts` on the same date deliberately exempts such a package: its `test:coverage`
  writes no LCOV, so whatever file exists can never be refreshed and the warning would be permanent
  noise.
