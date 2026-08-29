# The transport-agnostic kernel to UI contract

> Implemented at `packages/protocol/src/**` (19 files) plus
> `packages/kernel/src/transport/operations.ts` as the consumer table. Every claim below is anchored
> to a file and line. Open questions are collected in the final section.

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
a `KernelClient` service method never itself opens a socket or reads a file — `packages/protocol/src/transport.ts:1-10`
states the transport seam is a request/response-plus-notifications shape, "JSON-RPC-shaped, with
Clarvis's own method vocabulary — not MCP's" — and every DTO in the other 16 files is defined so it
can cross that wire as plain JSON (all interfaces here use only `string`, `number`, `boolean`,
arrays, records and nested interfaces of the same kind; the sole escape hatches are opaque `unknown`
fields explicitly documented as such, e.g. `KernelError.details` at `packages/protocol/src/common.ts:105`).

The package achieves its "transport-agnostic" claim not just by convention but by construction: it
declares 186 non-reexport type-level exports across its 18 sibling modules — 145 `export interface`
declarations (`grep -cE "^export interface\b" packages/protocol/src/*.ts`) plus 41 `export type <Name>
= ...` aliases (e.g. `packages/protocol/src/common.ts:11`'s `Scope`, `packages/protocol/src/runs.ts:117`'s `RunStatus`, `packages/protocol/src/tasks.ts:3`'s
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
| `runs.ts` | 805 | `RunService`, `RunHandle`, `StartRunParams`, `RunEvent` (38-variant union), messages, usage, Environment identity, guard/memory/plans modes, elicitation types |
| `config.ts` | 490 | `ConfigService`, `SettingsData`/`SettingsView` (incl. `WorkspaceTrustVerdict`, `known_grants`), the `SandboxConfig`/`SandboxInspection` doctor cluster, `SettingsRepairPlan` (2-variant union), `AgentSummary`/`AgentDoc`/`AgentOverlay`/`AgentBudget`, context docs — see §3.11/§3.12 |
| `plugins.ts` | 128 | `PluginService`, `PluginView`, `PluginContributions`, atomic install/lifecycle DTOs |
| `environments.ts` | 250 | `EnvironmentService`, exact inventory and plugin/skill references, definitions, composition previews, resolved snapshots, deltas, diagnostics, deletion, and persisted run identity |
| `secrets.ts` | 31 | `SecretService` |
| `models.ts` | 82 | `ModelCatalogService`, `ModelCatalog`, `CatalogProvider`, `CatalogModel` |
| `provider-auth.ts` | 43 | token-free subscription schemes, states, device authorization and `ProviderAuthService` |
| `workspace.ts` | 44 | `WorkspaceService`, `WorkspaceEntry` |
| `memory.ts` | 209 | `MemoryService`, health/reindex/jobs DTOs, `MemoryIngestDetail` |
| `plans.ts` | 197 | `PlansService`, `PlanDocumentDto`, `PlanTaskDto`, `PlanRef` |
| `workflows.ts` | 101 | `WorkflowsService`, `WorkflowNode`, `WorkflowSummary`/`WorkflowDetail` |
| `skills.ts` | 104 | `SkillsService`, `SkillSummary`, `SkillProvenance`, `SkillPresentation` |
| `sessions.ts` | 126 | `SessionService`, `Session`, `SessionSummary`, `SessionTurn` and their Environment snapshot identity |
| `tasks.ts` | 223 | `TasksService`, all `Task*Dto` shapes, `ActiveTaskRequestDto`/`ActiveTaskBindingDto` |
| `storage.ts` | 62 | `StorageService`, bounded inventory DTOs and cleanup request/result shapes |
| `transport.ts` | 68 | `KernelTransport`, `KernelRequestOptions`, `KernelAbortSignal` |
| `client.ts` | 94 | `KernelClient`, `KernelCapabilities`, `ConnectOptions` |

(`packages/protocol/src/index.ts` — one `export type *` line per module above.)

### 2.2 `KernelClient` — the object a UI programs against

Defined in `packages/protocol/src/client.ts`. Aggregates 4 readonly fields, 15 named services and one method:

| Member | Type | Line |
|---|---|---|
| `capabilities` | `KernelCapabilities` | `packages/protocol/src/client.ts:53` |
| `principal` | `Principal \| undefined` | `packages/protocol/src/client.ts:55` |
| `project` | `ProjectRef` | `packages/protocol/src/client.ts:57` |
| `workspace` | `WorkspaceRef` | `packages/protocol/src/client.ts:59` |
| `runs` | `RunService` | `packages/protocol/src/client.ts:62` |
| `config` | `ConfigService` | `packages/protocol/src/client.ts:64` |
| `plugins` | `PluginService` | `packages/protocol/src/client.ts:66` |
| `environments` | `EnvironmentService` | `packages/protocol/src/client.ts:68` |
| `secrets` | `SecretService` | `packages/protocol/src/client.ts:70` |
| `models` | `ModelCatalogService` | `packages/protocol/src/client.ts:72` |
| `providerAuth` | `ProviderAuthService` | `packages/protocol/src/client.ts` (`KernelClient.providerAuth`) |
| `files` | `WorkspaceService` | `packages/protocol/src/client.ts:72` |
| `memory` | `MemoryService` | `packages/protocol/src/client.ts:74` |
| `plans` | `PlansService` | `packages/protocol/src/client.ts:76` |
| `workflows` | `WorkflowsService` | `packages/protocol/src/client.ts:78` |
| `skills` | `SkillsService` | `packages/protocol/src/client.ts:80` |
| `sessions` | `SessionService` | `packages/protocol/src/client.ts:82` |
| `tasks` | `TasksService` | `packages/protocol/src/client.ts:86` |
| `storage` | `StorageService` | `KernelClient.storage` in `packages/protocol/src/client.ts` |
| `close(): Promise<void>` | method | `packages/protocol/src/client.ts:89` |

`KernelCapabilities` (`packages/protocol/src/client.ts:25-36`): `memory`, `skills`, `agent_tools`,
`tasks` — four booleans and nothing else. It also carried `guard` and a
`kernel_version`/`protocol_version` pair "for compatibility checks"; no host derived `guard`, no
production code ever set either version to anything but `"0.0.0"`, and no conditional anywhere read
any of the three, so all three have been removed. The wire's own `CLARVIS_WIRE_VERSION`
(`packages/kernel/src/transport/wire.ts`) is the version handshake that does exist.

`ConnectOptions` (`packages/protocol/src/client.ts:39-46`): `workspace?: WorkspaceRef | string`, `auth?: string`,
`clientInfo?: { name: string; version?: string }`. Nothing in `client.ts` defines a `connect()`
function — `ConnectOptions` is a shape a transport-specific connector elsewhere accepts; the type
alone lives here.

### 2.3 The 15 services, method by method

Every signature below is the one declared in its file.

#### `RunService` (`packages/protocol/src/runs.ts:705-733`)

| Method | Signature | Line |
|---|---|---|
| `start` | `(params: StartRunParams) => Promise<RunHandle>` | `packages/protocol/src/runs.ts:711` |
| `compact` | `(execution_id, request?, options?) => Promise<RunCompactionResult>` | `packages/protocol/src/runs.ts` |
| `context` | `(execution_id, target_window_tokens?) => Promise<context estimate>` | `packages/protocol/src/runs.ts` |
| `get` | `(execution_id: string) => Promise<RunDetail>` | `packages/protocol/src/runs.ts:718` |
| `list` | `(page?: Pagination) => Promise<Page<RunSummary>>` | `packages/protocol/src/runs.ts:725` |
| `delete` | `(execution_id: string) => Promise<void>` | `packages/protocol/src/runs.ts:732` |

`RunHandle` (`packages/protocol/src/runs.ts:653-702`), the live object `start` returns:

| Member | Signature | Line |
|---|---|---|
| `execution_id` | `readonly string` | `packages/protocol/src/runs.ts:654` |
| `events` | `readonly AsyncIterable<RunEvent>` | `packages/protocol/src/runs.ts:660` |
| `steer` | `(message: Message \| string) => Promise<void>` | `packages/protocol/src/runs.ts:667` |
| `compact` | `(request?: string) => Promise<void>` | `packages/protocol/src/runs.ts:674` |
| `cancel` | `() => Promise<void>` | `packages/protocol/src/runs.ts:677` |
| `respond` | `(response: ElicitationResponse) => Promise<void>` | `packages/protocol/src/runs.ts:684` |
| `onElicit` | `(handler: (req: ElicitationRequest) => void) => void` | `packages/protocol/src/runs.ts:691` |
| `done` | `readonly Promise<RunResult>` | `packages/protocol/src/runs.ts:694` |
| `buffered?` | `() => { buffered_items; buffered_bytes; dropped }` | `packages/protocol/src/runs.ts` (`RunHandle.buffered`) |
| `closed` | `readonly Promise<void>` | `packages/protocol/src/runs.ts:701` |

`done` resolves when execution ends and "does not imply that `events` has closed" (`packages/protocol/src/runs.ts:693`);
`closed` resolves only "after execution and bounded post-run event delivery both finish"
(`packages/protocol/src/runs.ts:697`) — the doc comment states this exists so a host can key a lifecycle lease off it
"without becoming a second consumer of the single-consumer `RunHandle.events` stream" (`packages/protocol/src/runs.ts:698-699`).
The optional `buffered()` member exposes O(1) local queue counters for bounded diagnostics. Its
absence remains valid for transports that cannot report them, and reading it neither consumes nor
copies `events` (`packages/protocol/src/runs.ts`, `RunHandle.buffered`).

#### `ConfigService` (`packages/protocol/src/config.ts:362-490`)

| Method | Signature | Line |
|---|---|---|
| `getSettings` | `() => Promise<SettingsView>` | `packages/protocol/src/config.ts:364` |
| `previewSettingsRepair` | `(scope: Scope) => Promise<SettingsRepairPlan \| null>` | `packages/protocol/src/config.ts:371` |
| `repairSettings` | `(scope: Scope, expectedRevision: string) => Promise<SettingsView>` | `packages/protocol/src/config.ts:379` |
| `approveWorkspace` | `() => Promise<SettingsView>` | `packages/protocol/src/config.ts:393` |
| `revokeWorkspace` | `() => Promise<SettingsView>` | `packages/protocol/src/config.ts:400` |
| `workspaceTrustError` | `() => Promise<string \| null>` | `packages/protocol/src/config.ts:403` |
| `updateSettings` | `(scope, patch: Partial<SettingsData>, expectedRevision: string \| null) => Promise<SettingsView>` | `packages/protocol/src/config.ts:414` |
| `inspectSandbox` | `(options?: { refresh?: boolean }) => Promise<SandboxInspection>` | `packages/protocol/src/config.ts:421` |
| `listAgents` | `() => Promise<AgentSummary[]>` | `packages/protocol/src/config.ts:430` |
| `getAgent` | `(scope: Scope \| "builtin", name: string) => Promise<AgentDoc>` | `packages/protocol/src/config.ts:442` |
| `writeAgent` | `(scope, name, doc: AgentWrite) => Promise<AgentSummary>` | `packages/protocol/src/config.ts:451` |
| `deleteAgent` | `(scope, name) => Promise<void>` | `packages/protocol/src/config.ts:459` |
| `renameAgent` | `(scope, oldName, newName) => Promise<AgentSummary>` | `packages/protocol/src/config.ts:469` |
| `getContext` | `(scope) => Promise<ContextDoc \| null>` | `packages/protocol/src/config.ts:476` |
| `subscribe` | `(kinds: ConfigChangeKind[], listener) => Unsubscribe` | `packages/protocol/src/config.ts:489` |

#### `PluginService` (`packages/protocol/src/plugins.ts:91-128`)

| Method | Signature | Line |
|---|---|---|
| `list` | `() => Promise<PluginView[]>` | `packages/protocol/src/plugins.ts:93` |
| `install` | `(url, subdir?, target?: { source }) => Promise<PluginView>` | `PluginService.install` |
| `update` | `(ref: PluginRef) => Promise<PluginView>` | `PluginService.update` |
| `uninstall` | `(ref: PluginRef) => Promise<void>` | `PluginService.uninstall` |

#### `EnvironmentService` (`packages/protocol/src/environments.ts`, symbol `EnvironmentService`)

| Method | Signature | Line |
|---|---|---|
| `list` | `() => Promise<EnvironmentDefinitionView[]>` | `EnvironmentService.list` |
| `current` | `() => Promise<ResolvedEnvironment>` | `EnvironmentService.current` |
| `get` | `(ref: EnvironmentRef) => Promise<ResolvedEnvironment>` | `EnvironmentService.get` |
| `inventory` | `() => Promise<EnvironmentInventory>` | `EnvironmentService.inventory` |
| `preview` | `(ref, { selection_scope }) => Promise<EnvironmentPreview>` | `EnvironmentService.preview` |
| `previewClear` | `(scope: EnvironmentSelectionScope) => Promise<EnvironmentPreview>` | `EnvironmentService.previewClear` |
| `previewComposition` | `(input: EnvironmentCompositionInput) => Promise<EnvironmentCompositionPreview>` | `EnvironmentService.previewComposition` |
| `select` | `(ref, { selection_scope, preview_token, approve_workspace? }) => Promise<EnvironmentApplyResult>` | `EnvironmentService.select` |
| `clearSelection` | `(scope, { preview_token }) => Promise<EnvironmentApplyResult>` | `EnvironmentService.clearSelection` |
| `applyComposition` | `(input, { preview_token, approve_workspace? }) => Promise<EnvironmentCompositionApplyResult>` | `EnvironmentService.applyComposition` |
| `create` | `(input: EnvironmentDefinitionInput) => Promise<EnvironmentDefinitionView>` | `EnvironmentService.create` |
| `update` | `(input: EnvironmentDefinitionInput & { expected_revision }) => Promise<EnvironmentDefinitionView>` | `EnvironmentService.update` |
| `delete` | `(ref, { expected_revision }) => Promise<void>` | `EnvironmentService.delete` |
| `clone` | `(source, target) => Promise<EnvironmentDefinitionView>` | `EnvironmentService.clone` |

The service selects already-installed inventory and has no install operation. `inventory` exposes
all exact inactive composer candidates. `preview` and
`previewClear` return the exact entering/leaving extension surface plus a single-use token;
`preview` also names the intended persisted selection scope. `select` and `clearSelection` bind the
persisted mutation to that preview. `previewComposition`/`applyComposition` bind a complete
definition and its intended selection to the same reviewed authored/effective fingerprints. The full behavioral and
trust contract is owned by
[Extension Environments](environments.md).

#### `SecretService` (`packages/protocol/src/secrets.ts:13-31`)

| Method | Signature | Line |
|---|---|---|
| `listNames` | `() => Promise<string[]>` | `packages/protocol/src/secrets.ts:15` |
| `set` | `(name: string, value: string) => Promise<void>` | `packages/protocol/src/secrets.ts:23` |
| `delete` | `(name: string) => Promise<void>` | `packages/protocol/src/secrets.ts:30` |

Doc comment states values "only ever flow client → kernel; listing returns names, never values"
(`packages/protocol/src/secrets.ts:4`), and warns that secrets "travel over the transport on `set`... a hosted kernel needs
TLS plus at-rest protection" (`packages/protocol/src/secrets.ts:8-9`).

#### `ModelCatalogService` (`packages/protocol/src/models.ts:64-74`)

| Method | Signature | Line |
|---|---|---|
| `get` | `() => Promise<ModelCatalog>` | `packages/protocol/src/models.ts:66` |
| `refresh` | `() => Promise<ModelCatalog>` | `packages/protocol/src/models.ts:73` |
| `getEntitled` | `(scheme: SubscriptionScheme) => Promise<CatalogProvider>` | `packages/protocol/src/models.ts` |
| `refreshEntitled` | `(scheme: SubscriptionScheme) => Promise<CatalogProvider>` | `packages/protocol/src/models.ts` |

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

#### `WorkflowsService` (`packages/protocol/src/workflows.ts:79-101`)

| Method | Signature | Line |
|---|---|---|
| `get` | `(id: string) => Promise<WorkflowDetail>` | `packages/protocol/src/workflows.ts:85` |
| `list` | `(page?: Pagination) => Promise<Page<WorkflowSummary>>` | `packages/protocol/src/workflows.ts:92` |
| `delete` | `(id: string) => Promise<void>` | `packages/protocol/src/workflows.ts:100` |

No `start` method: the doc comment states "a workflow is started through `RunService.start` like any
run — the kernel routes it as a workflow when the entry agent profile carries the `workflow` grant"
(`packages/protocol/src/workflows.ts:71-74`). This service adds only "the tree structure (the edges + a rollup)"
(`packages/protocol/src/workflows.ts:11-12`) over runs that are individually reachable through `RunService.get`.

#### `SkillsService` (`packages/protocol/src/skills.ts:91-104`)

| Method | Signature | Line |
|---|---|---|
| `list` | `() => Promise<SkillSummary[]>` | `packages/protocol/src/skills.ts:93` |
| `getPrompt` | `(name: string, args?: { task?: string }) => Promise<Message[]>` | `packages/protocol/src/skills.ts:103` |

#### `SessionService` (`packages/protocol/src/sessions.ts:92-121`)

| Method | Signature | Line |
|---|---|---|
| `listPage` | `(page?: CursorPagination) => Promise<CursorPage<SessionSummary>>` | `packages/protocol/src/sessions.ts:94` |
| `list` | `() => Promise<Session[]>` | `packages/protocol/src/sessions.ts:97` |
| `get` | `(id: string) => Promise<Session \| null>` | `packages/protocol/src/sessions.ts:105` |
| `save` | `(session: Session) => Promise<void>` | `packages/protocol/src/sessions.ts:112` |
| `delete` | `(id: string) => Promise<boolean>` | `packages/protocol/src/sessions.ts:120` |

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
It also declared a `correlationId` — "an opaque, purely informational tag both sides may log
verbatim" — which no transport ever wrote and no sink ever read; it has been removed.

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

### 3.3 `RunEvent` — the 38-variant discriminated union

Defined at `packages/protocol/src/runs.ts:291-601` as one large union type. Every variant, its distinguishing fields, and
line:

| `type` | Extra fields (beyond `at`/attribution) | Line |
|---|---|---|
| `run_started` | `lead_model?`, `subagent_model?` | `packages/protocol/src/runs.ts:292` |
| `run_ended` | `status`, `reason?`, `code?` | `packages/protocol/src/runs.ts:294-309` |
| `iteration_started` | `iteration`, `model?` | `packages/protocol/src/runs.ts:310` |
| `iteration_completed` | `iteration`, `model?`, `response`, `response_phase?: "commentary"\|"final_answer"`, `input_tokens`, `output_tokens`, `cached_tokens?` | `packages/protocol/src/runs.ts` |
| `tool_call_started` | `call_id`, `tool`, `server`, `arguments?` | `packages/protocol/src/runs.ts:333-339` |
| `tool_call` | `call_id?`, `tool`, `server`, `arguments?`, `ok`, `result?`, `error?`, `diff?`, `guard?` | `packages/protocol/src/runs.ts` |
| `tool_output_delta` | `call_id`, `chunk` | `packages/protocol/src/runs.ts:356-360` |

`guard`, when present, is the strict `CommandGuardReview` object with mode,
allowed/denied outcome, and answerer. The run-event codec accepts exactly those
fields and enum values. Production: `CommandGuardReview`/the `tool_call` variant
in `packages/protocol/src/runs.ts` and `commandGuardReview` in
`packages/kernel/src/transport/run-event-codec.ts`. Test: `"preserves the
terminal shell auto-guard verdict"` in
`packages/kernel/tests/contract/transport-codecs.test.ts`.
| `tool_input_delta` | `call_id`, `tool`, `chars` | `packages/protocol/src/runs.ts:377-382` |
| `reasoning` | `iteration`, `text` | `packages/protocol/src/runs.ts:383` |
| `text_delta` | `iteration`, `channel: "text" \| "reasoning"`, `text`, `reset` | `packages/protocol/src/runs.ts:384-393` |
| `model_error` | `iteration`, `kind`, `message` | `packages/protocol/src/runs.ts:394` |
| `model_retry` | `iteration`, `kind`, `attempt`, `max_retries`, `delay_ms`, `status?`, `retry_after_ms?` | `packages/protocol/src/runs.ts:405-414` |
| `delegation_created` | `delegation_id`, `task_id?`, `title`, `task`, `profile?`, `tools?` | `packages/protocol/src/runs.ts:416-424` |
| `delegation_started` | `delegation_id`, `task_id?`, `model?` | `packages/protocol/src/runs.ts:426-431` |
| `delegation_completed` \| `delegation_failed` | `delegation_id`, `task_id?`, `status`, `summary?` | `packages/protocol/src/runs.ts:432-440` |
| `workflow_run_started` | `run_id`, `parent_run_id`, `profile?`, `title`, `task`, `round_id?`, `pass?`, `item_index?`, `replica?`, `replica_count?` | `packages/protocol/src/runs.ts:442-454` |
| `workflow_title_updated` | `run_id`, `title` | `packages/protocol/src/runs.ts:457-461` |
| `workflow_run_progress` | `run_id`, `parent_run_id`, `iterations`, `input_tokens`, `output_tokens`, `cached_tokens?` | `packages/protocol/src/runs.ts:463-478` |
| `workflow_run_completed` | `run_id`, `parent_run_id`, `status` | `packages/protocol/src/runs.ts:480-485` |
| `workflow_run_failed` | `run_id`, `parent_run_id`, `status`, `error?` | `packages/protocol/src/runs.ts:486-493` |
| `plan_created` | `PlanProjection` fields | `packages/protocol/src/runs.ts:494` |
| `plan_updated` | `change: PlanUpdateChange` + `PlanProjection` fields | `packages/protocol/src/runs.ts:495` |
| — `PlanUpdateChange`'s 4 values | `content` (objective/context/tasks body edit) · `task` (a task marker/detail change) · `status` (the plan's status changed) · `recovery` (state restored on continuation) — all glossed at the type's own doc comment. It had three more — `approval`, `retention`, `external_edit` — that `@clarvis/plan` never emitted; they are gone | `packages/protocol/src/runs.ts:258-268` |
| `plan_removed` | `id`, `path?`, `revision`, `spec_revision` + partial `PlanProjection` | `packages/protocol/src/runs.ts:496-503` |
| `plan_review_requested` | `PlanProjection` fields | `packages/protocol/src/runs.ts:504` |
| `plan_review_resolved` | `outcome: "approved" \| "changes_requested" \| "cancelled"` + `PlanProjection` fields | `packages/protocol/src/runs.ts:505-509` |
| `soft_limit_check` | `dimension: "tokens" \| "iterations"`, `used`, `limit`, `outcome` | `packages/protocol/src/runs.ts:510-517` |
| `compaction_started` | `mode: "scheduled" | "forced"` | `packages/protocol/src/runs.ts` (`RunEvent`) |
| `compaction` | `operation`, `fallback_reason?`, `freed_chars?`, `contribution_count?`, `requested?: true`, `user_contribution_count?` | `packages/protocol/src/runs.ts` (`RunEvent`) |
| `vision_analysis` | `model`, `image_count`, `status: "completed" \| "failed"`, `result` | `packages/protocol/src/runs.ts:533-540` |
| `compaction_skipped` | `reason` (5-member union) | `packages/protocol/src/runs.ts:541-549` |
| `elicitation_requested` | `agent?`, `subagent_id?`, `question`, `options?` | `packages/protocol/src/runs.ts:550-557` |
| `elicitation_resolved` | `agent?`, `subagent_id?`, `question`, `outcome`, `answer?`, `options?` | `packages/protocol/src/runs.ts:558-568` |
| `steering_applied` | `message` | `packages/protocol/src/runs.ts:569` |
| `memory_ingest` | `detail: MemoryIngestDetail` | `packages/protocol/src/runs.ts:570` |
| `capability_event` | `capability`, `kind`, `projection`, `detail?`, `truncated` | `packages/protocol/src/runs.ts:581-590` |
| `events_dropped` | `dropped` | `packages/protocol/src/runs.ts:600` |
| `mcp_degraded` | `servers: { name; reason }[]` | `packages/protocol/src/runs.ts:601` |

Counted directly from the union source (`sed -n '291,601p' runs.ts | grep -cE '^\s*\|\s*(\{|\(Attributed|\()'`):
the union has exactly **36 top-level alternation arms**. Of those, 35 each declare exactly one `type`
string literal, and one arm declares two — `type: "delegation_completed" | "delegation_failed"`
(`packages/protocol/src/runs.ts:433`) covers both `delegation_completed` and `delegation_failed` in a single object shape,
since the two share every other field. 36 + 2 = **38 distinct `type` values**, which is exactly the
set the table above enumerates.

Several variants are marked live-only in their own doc comments — never present in a stored
`RunDetail.events`: `tool_output_delta` ("streamed only — never part of a stored run's `events`",
`packages/protocol/src/runs.ts:352-353`), `tool_input_delta` (`packages/protocol/src/runs.ts:363`), `workflow_run_progress` ("live-only — NOT
written to the manager's trace, so it does not rehydrate", `packages/protocol/src/runs.ts:468-469`),
`workflow_title_updated` ("live-only replacement", `packages/protocol/src/runs.ts:456`),
`compaction_started` (the current pass, not a historical fact), and `events_dropped`
("streamed only... emitted at most once, as the last event before the stream ends",
`packages/protocol/src/runs.ts:592-593`). `elicitation_resolved`'s own comment reads "for resume reconstruction; not shown
live" (`packages/protocol/src/runs.ts:558`) — the opposite direction from the others.

### 3.4 `StartRunParams` (`packages/protocol/src/runs.ts:69-114`)

| Field | Type | Notes |
|---|---|---|
| `execution_id?` | `string` | "Client-chosen id for idempotency + continuation; the kernel echoes it" (`packages/protocol/src/runs.ts:70`) |
| `messages` | `Message[]` | required |
| `agent?` | `string` | "the kernel translates it to the engine's profile/entry concept" (`packages/protocol/src/runs.ts:76`) |
| `continue_from?` | `string` | resume / steer-after-end |
| `prompt_cache_key?` | `string` | provider prompt-cache hint |
| `prompt_cache_ttl?` | `"5m" \| "1h"` | kernel derives it when omitted (`packages/protocol/src/runs.ts:87-92`) |
| `guard_mode?` | `GuardMode` | `"off" \| "on" \| "auto"` (`packages/protocol/src/runs.ts:45`) |
| `guard_judge?` | `GuardJudge` | caller-owned judge prompt/model/timeout |
| `memory?` | `MemoryMode` | `"on" \| "off"` (`packages/protocol/src/runs.ts:60`) |
| `plans?` | `PlansMode` | `"off" \| "on" \| "review"` (`packages/protocol/src/runs.ts:66`) |
| `task?` | `ActiveTaskRequestDto` | binds one external task |
| `skill?` | `{ name: string; task?: string }` | the `/skill` flow |
| `output_schema?` | `JsonSchema` | structured-output request |

### 3.5 `PlanProjection` and CAS revision pair

`PlanProjection` (`packages/protocol/src/runs.ts:239-255`) carries `id`, `path?`, `title`, `status: PlanStatus`,
`retention: PlanRetention`, `revision: number` ("monotonic counter bumped on every write — the CAS
baseline", `packages/protocol/src/runs.ts:250`), `spec_revision: number` ("bumped only when the plan's substance changes;
approval binds to it", `packages/protocol/src/runs.ts:252`), and `tasks: PlanTaskDto[]`. `PlanDocumentDto` (`packages/protocol/src/plans.ts:79-111`)
is the full document carried by `PlansService.read`, superset of `PlanProjection`'s fields plus
`created_at`, `updated_at`, `created_by_run`, `approved_spec_revision?`, `objective`, `context`,
`validation: string[]`, `notes`, and the canonical `markdown: string`.

### 3.6 Example wire values from the package's own test fixture

`packages/protocol/tests/contract/public-contract.fixture.ts` builds literal values satisfying the
real types (not illustrative prose — every field below is copied from that file):

```ts
// packages/protocol/tests/contract/public-contract.fixture.ts:28-34
const capabilities = {
  memory: true, skills: true, agent_tools: true,
  tasks: true,
} satisfies KernelCapabilities;

// packages/protocol/tests/contract/public-contract.fixture.ts:48-54
const startParams = {
  execution_id: "run-1",
  messages: [{ role: "user", content: "Inspect the workspace" }],
  plans: "review",
  task: { id: "CLAR-42", provider_key: "tasks:mcp:v1:sha256:fixture", mode: "work" },
  output_schema: { type: "object" },
} satisfies StartRunParams;

// packages/protocol/tests/contract/public-contract.fixture.ts:56-64
const textDelta = {
  type: "text_delta", at: 1, agent: "lead",
  iteration: 1, channel: "text", text: "Working", reset: false,
} satisfies RunEvent;
```

The same fixture goes on to compile-pin several whole interfaces via `satisfies`, beyond the three
literals above: `SettingsRepairPlan`'s `strip` variant (`packages/protocol/tests/contract/public-contract.fixture.ts:63-68` — `{ scope: "workspace",
revision: "sha256", action: "strip", dropped: ["providers.invalid"] }`), `CreateTaskDto`
(`packages/protocol/tests/contract/public-contract.fixture.ts:70-75`), and — in one contiguous block — `RunHandle` (`packages/protocol/tests/contract/public-contract.fixture.ts:89-107`), `RunService`
(`packages/protocol/tests/contract/public-contract.fixture.ts:109-129`), `SecretService` (`packages/protocol/tests/contract/public-contract.fixture.ts:131-142`) and `KernelTransport`
(`packages/protocol/tests/contract/public-contract.fixture.ts:144-164`). None of these five are exercised elsewhere in this document outside the
`client` object covered in §5 invariant 3.

### 3.7 The message/content model (`runs.ts`)

Every `StartRunParams.messages` entry and every `RunDetail.messages` entry is a `Message`
(`packages/protocol/src/runs.ts:39-42`): `{ role: Role; content: MessageContent }`. `Role` is `"user" | "assistant"`
(`packages/protocol/src/runs.ts:14`). `MessageContent` (`packages/protocol/src/runs.ts:36`) is `string | ContentPart[]` — plain text, or a
mixed sequence of parts. `ContentPart` (`packages/protocol/src/runs.ts:33`) is `TextPart | ImagePart`: `TextPart`
(`packages/protocol/src/runs.ts:17-20`) is `{ type: "text"; text: string }`; `ImagePart` (`packages/protocol/src/runs.ts:23-30`) is `{ type:
"image"; mime: string; data?: string; ref?: string }`, where `data` is inline base64 bytes and
`ref` is "a workspace-relative ref the kernel resolves" (`packages/protocol/src/runs.ts:28-29`) — the two are alternatives
on the same part rather than separate variants.

### 3.8 Run status, usage and the top-level run DTOs (`runs.ts`)

| Type | Shape | Line |
|---|---|---|
| `RunStatus` | `"running" \| "completed" \| "failed" \| "cancelled"` | `packages/protocol/src/runs.ts:117` |
| `AgentRole` | `"lead" \| "subagent"` | `packages/protocol/src/runs.ts:229` |
| `PerAgentUsage` | `{ role: AgentRole \| "vision"; model; input_tokens; output_tokens; cached_tokens; cache_write_tokens; iterations? }` | `packages/protocol/src/runs.ts:125-142` |
| `RunUsage` | `{ iterations; elapsed_ms; input_tokens?; output_tokens?; cached_tokens?; by_agent?: PerAgentUsage[]; warnings? }` | `packages/protocol/src/runs.ts:145-158` |
| `RunResult` | `{ execution_id; status: RunStatus; result?; ended_reason?; usage?: RunUsage; error?: { code; message } }` | `packages/protocol/src/runs.ts:161-171` |
| `RunSummary` | `{ execution_id; owner?; status; created_at; ended_at? }` | `packages/protocol/src/runs.ts:174-186` |
| `RunDetail` (extends `RunSummary`) | `+ messages: Message[]; events: RunEvent[]; result?: RunResult; continue_from?; plan_ref?: PlanRef; active_task?: ActiveTaskBindingDto; environment?: EnvironmentRunRef; recovery?: RunRecovery` | `packages/protocol/src/runs.ts:235-255` |

`PerAgentUsage.role`'s `"vision"` member is not an agent: its own doc comment calls it "the engine's
image-reading pre-pass, one completion on a model no agent runs on" (`packages/protocol/src/runs.ts:129-131`) — the same
escape-hatch shape as `capability_event`'s open string (§5 invariant 4), applied to cost attribution
rather than to the event union. `RunUsage.by_agent` is optional because "a live run's final result may
report per-agent detail... instead" of the flat totals (`packages/protocol/src/runs.ts:149-150`), which are themselves
"present on a stored run (`get`)" but optional on a live result.

`EnvironmentRunRef` is deliberately only `{ id, fingerprint }`. `RunDetail.environment`,
`SessionTurn.environment`, and `SessionSummary.last_environment` retain that identity without
serializing a definition, settings, or secrets (`packages/protocol/src/environments.ts:134-138`,
`packages/protocol/src/runs.ts:249-250`, `packages/protocol/src/sessions.ts:43-44`, `:91-92`).

### 3.9 Elicitation types (`runs.ts`)

| Type | Shape | Line |
|---|---|---|
| `ElicitationCommandDetail` | `{ command: string; cwd: string; reason: string; warning? }` | `packages/protocol/src/runs.ts:604-613` |
| `ElicitationRequest` | `{ id; execution_id; kind; prompt; schema?: JsonSchema; detail?: ElicitationCommandDetail }` | `packages/protocol/src/runs.ts:616-635` |
| `ElicitationResponse` | `{ id; action: "accept" \| "decline" \| "cancel"; content? }` | `packages/protocol/src/runs.ts:638-645` |

`ElicitationRequest.kind` is a 4-member union — `"ask_user"` (a free question), `"guard_confirm"` (a
command awaiting approval), `"plan_review"` (a proposed plan awaiting approval), `"workflow_review"`
(an installed workflow preflight) — plus a deliberately open `(string & {})` escape, "so a kernel may
add kinds without a protocol bump" (`packages/protocol/src/runs.ts:623-624`). This is structurally the same open/closed
pattern already noted for `capability_event` in §5 invariant 4, applied to elicitation instead of to
the `RunEvent` union itself. `ElicitationCommandDetail` exists so a client "render[s] this directly
(e.g. as highlighted code) and never parse[s] `prompt`, which stays the human-readable fallback"
(`packages/protocol/src/runs.ts:630-632`).

### 3.10 `ConfigService` data shapes I: settings and sandbox (`config.ts`)

| Type | Shape | Line |
|---|---|---|
| `WorkspaceTrustVerdict` | `{ state: "inert" \| "unapproved" \| "trusted" \| "changed"; fingerprint?; approved? }` | `packages/protocol/src/config.ts:11-15` |
| `SettingsData` | `{ default_model?; providers?: ProviderConfig[]; mcp_servers?: Record<string, McpServerConfig>; guard?: GuardConfig; sandbox?: SandboxConfig; memory?: MemoryConfig; budget?; profiles?: Record<string, unknown>; [block: string]: unknown }` | `packages/protocol/src/config.ts:23-38` |
| `ProviderConfig` | `{ name; kind?; base_url?; api_key_env?; [k]: unknown }` | `packages/protocol/src/config.ts:41-50` |
| `McpServerConfig` | `{ command?; args?; url?; [k]: unknown }` | `packages/protocol/src/config.ts:59-64` |
| `GuardConfig` | `{ mode?: "off" \| "on" \| "auto"; allowed_commands?; denied_commands?; [k]: unknown }` | `packages/protocol/src/config.ts:67-72` |
| `MemoryConfig` | `{ enabled?; model?; [k]: unknown }` | `packages/protocol/src/config.ts:180-184` |
| `SandboxConfig` | `{ type: "native"; enabled?; availability?: "required" \| "optional"; filesystem?; network?; pass_env?; toolchains?: { mode?: "auto" \| "manual"; include?; exclude?; extra_paths?; excluded_paths? } }` | `packages/protocol/src/config.ts` (`SandboxConfig`) |
| `SandboxToolchainScope` | `"system" \| "auto" \| "global" \| "workspace"` | `packages/protocol/src/config.ts:112` |
| `SandboxInspection` | `{ backend: { type: "bubblewrap" \| "seatbelt" \| "unsupported"; available; mode: "fresh-proc" \| "host-proc" \| "seatbelt" \| "unavailable"; degraded; reason? }; toolchains: SandboxToolchainStatus[]; extra_paths: SandboxPathStatus[]; effective_path: string[] }` | `packages/protocol/src/config.ts` (`SandboxInspection`) |

`SandboxInspection.backend` identifies what the host actually probed: Bubblewrap uses `fresh-proc`
or degraded `host-proc`, Seatbelt uses `seatbelt`, and an unavailable selected/unsupported backend
uses `unavailable` (`packages/protocol/src/config.ts`, `SandboxInspection`). `SandboxToolchainScope`'s four
values name where a discovered toolchain (or read-only path) originates: `"system"` (already on the
host `PATH`), `"auto"` (found by discovery), or the `"global"` / `"workspace"` settings scope that
declared it (`packages/protocol/src/config.ts:107-111`). This is the return shape behind `ConfigService.inspectSandbox`,
whose §2.3 table row names only the method signature.

### 3.11 `ConfigService` data shapes II: repair plan and agents (`config.ts`)

`SettingsRepairPlan` (`packages/protocol/src/config.ts:252-266`) is a 2-variant discriminated union on `action`, both variants
carrying `scope: Scope` and `revision: string` (the SHA-256 the repair is bound to, per §4 item 4):
`"strip"` additionally carries `dropped: string[]` — "dotted paths the kernel will remove from
otherwise parseable JSON" (`packages/protocol/src/config.ts:257`) — and `"reset"` carries `reason: string`, "why no safe
field-level repair could be produced" (`packages/protocol/src/config.ts:264`). The package's own test fixture exercises the
`strip` variant literally: `{ scope: "workspace", revision: "sha256", action: "strip", dropped:
["providers.invalid"] }` (`packages/protocol/tests/contract/public-contract.fixture.ts:63-68`).

`AgentBudget` (`packages/protocol/src/config.ts:269-272`) is `{ on_exceed?: string; total_token_limit?: number }`.
`AgentSummary` (`packages/protocol/src/config.ts:293-312`) is `{ name; scope: Scope | "plugin" | "builtin"; model?;
description?; plugin?; grants?: string[]; can_spawn?: string[]; budget?: AgentBudget; overlay?:
AgentOverlay }` — `grants` being `undefined` specifically means "the frontmatter
could not be parsed" (`packages/protocol/src/config.ts:303`).

`SettingsView.known_grants?: readonly string[]` (`packages/protocol/src/config.ts:228-242`) lists "every capability grant an
agent profile in this workspace may name" and is populated only by the kernel, "an optional feature
package contributes its own grant, so the set is a property of what this kernel actually composed"
(`packages/protocol/src/config.ts:232-234`). Its own remark names the defect that motivated it: a stale `image` grant "left
by the vision-routing refactor... was reported 'runnable' by Doctor and the agent editor while every
run in the workspace was rejected before its first model call" (`packages/protocol/src/config.ts:235-238`). Absent when the
kernel did not report it, in which case "a client must then skip the check rather than assume a
vocabulary" (`packages/protocol/src/config.ts:239-240`).

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

### 3.14 `TasksService` DTO field lists (`tasks.ts`)

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

### 3.15 `PluginService` and `ModelCatalogService` data shapes (`plugins.ts`, `models.ts`)

`PluginContributions` (`packages/protocol/src/plugins.ts:19-39`): `{ agents: string[]; broken_agents: string[]; skills:
string[]; servers: string[]; hooks: number; capability_executables: PluginCapabilityExecutable[];
capability_run_policies?: { plans?: { skills: Record<string, "off" | "on" | "review"> } };
executables: string[] }` — `hooks` is "count of hook entries (not their names)" and `executables` are
"concrete commands this plugin would run... pre-formatted for display" (`packages/protocol/src/plugins.ts:25,33-38`).
`PluginView.display_name`/`short_description` (`packages/protocol/src/plugins.ts:53-62`) are documented as "display data
only. A plugin cannot widen what it is allowed to do by describing itself well: trust stays with the
process-pinned Environment and workspace trust boundary" (`packages/protocol/src/plugins.ts`,
`PluginView.display_name`).
`PluginRef` is the strict `{ scope: "global"|"workspace", source: "agents"|"clarvis", name }`
identity shared by lifecycle, activation, and Environment DTOs; `PluginView.source`
reports the same filesystem convention and `install_source` is separately reserved for Git origin.

`ModelCost` (`packages/protocol/src/models.ts:9-18`): `{ input: number; output: number; cache_read?: number;
cache_write?: number }` — four price-per-token fields. `CatalogProvider.needs_base_url: boolean`
(`packages/protocol/src/models.ts:49-52`) is "`true` when this is an OpenAI-compatible endpoint with no `base_url` yet — the
UI must prompt for one" (`packages/protocol/src/models.ts:49-51`).

## 4. Behavior

`@clarvis/protocol` has no runtime behavior of its own — it is erased at compile time (§7). What
follows is the *contract* the code encodes as call/return shape, as stated in the doc comments
attached to each method:

1. A client obtains a `KernelClient` (construction is out of scope for this package — see
   `specs/hosts/kernel-transport.md`) whose `capabilities`, `principal`, `project`, `workspace` are
   populated "at connect time" (`packages/protocol/src/client.ts:52` doc comment on `capabilities`).
2. `runs.start(params)` returns a `RunHandle` immediately; the run's `events` stream, `done` and
   `closed` promises are the three ways a caller observes its outcome (`packages/protocol/src/runs.ts:653-702`).
3. While a run is live, a caller may call `steer`, `compact`, `cancel`, or `respond` to a pending
   elicitation on the same `RunHandle` (`packages/protocol/src/runs.ts:667-691`) — these are the only mutating operations
   scoped to one in-flight run; everything else in `KernelClient` is either a service-level CRUD call
   or a `subscribe`.
4. `ConfigService.updateSettings` and `repairSettings` both take an `expectedRevision`
   (`packages/protocol/src/config.ts:414-418`, `:379`) — the doc comment on `updateSettings` states "a mismatch is a typed
   conflict and never overwrites the concurrent edit" (`packages/protocol/src/config.ts:411-412`), and `repairSettings`
   "throws a `conflict` kernel error when the file changed or disappeared after preview; no bytes are
   overwritten in that case" (`packages/protocol/src/config.ts:376-377`). This is optimistic concurrency control expressed
   purely through the method signature and its doc comment — no implementation of the check lives in
   this package.
5. `PlansService.setRetention`/`delete` and `TasksService`'s write methods (`assign`, `transition`,
   `comment`, `attachArtifact`) all thread an `expected_revision`/`expectedRevision` field through
   their DTOs (e.g. `AssignTaskDto.expected_revision?`, `packages/protocol/src/tasks.ts:138`) — the same CAS pattern applied
   per-domain.
6. `TasksService.transition`'s own DTO comment states it is "human control-plane transitions" that
   "exclude `start`, which belongs to a bound run" (`packages/protocol/src/tasks.ts:141`) — i.e. the `TaskTransitionIntentDto`
   union has a `"start"` member (`packages/protocol/src/tasks.ts:6`) that `TransitionTaskDto.intent` deliberately cannot
   carry (`Exclude<TaskTransitionIntentDto, "start">`, `packages/protocol/src/tasks.ts:145`), forcing that transition to
   happen only through a run's own binding.
8. `PreviewTaskTransitionDto`/`TaskTransitionPreviewDto` (`packages/protocol/src/tasks.ts:173-183`) gate `complete`/`reopen`
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
   Test/enforcement: `tooling/checks/coverage.ts:323-330`'s `findUnmeasuredSources` calls
   `looksExecutionFree` (`tooling/checks/coverage.ts:297-305`) on every module of a
   `TYPE_ONLY_PACKAGES` member (`tooling/checks/coverage.ts:55`, containing only `"protocol"`) and
   fails the coverage gate if any module contains a real `export const/function/class/enum/default`
   or a value re-export — independent of whether any test imported it. This is a build-tooling
   invariant, not a `bun test` assertion, but it runs as part of `check:pre-commit`.

2. **No file anywhere in `src/` or `tests/` imports a runtime value from `@clarvis/protocol` —
   every import is `import type` (or an `export type` re-export).**
   Verified directly by running it: a multiline ripgrep search for
   `import \{[^}]*\} from "@clarvis/protocol";` (a *value*-form brace import, as opposed to
   `import type { ... }`) across every `packages/*/src` and `packages/*/tests` tree returns **zero**
   matches, while the same search restricted to `import type` returns matches in every consumer
   (`code`, `kernel`, `server`). No test in the repository pins this as an assertion; it is
   demonstrated only by static absence. **Unpinned** — a future `import { X } from "@clarvis/protocol"`
   would compile (TypeScript's `verbatimModuleSyntax: true`, `packages/protocol/tsconfig.json:8`, forces the
   *source* file to declare `export type`, but does not stop a *consumer* from writing a bare
   `import { X }` for a symbol that happens to be a type — it would simply fail at the point the
   consumer's own `verbatimModuleSyntax` setting, if any, rejects mixing a type-only import as a
   value import, or fail silently at bundling since there is nothing to import).

3. **`KernelClient` aggregates exactly 15 named services, not more or fewer.**
   Production: `packages/protocol/src/client.ts` — `runs`, `config`, `plugins`, `secrets`, `models`, `providerAuth`, `files`, `memory`,
   `plans`, `workflows`, `skills`, `sessions`, `tasks`, `storage`, `environments` (15 fields, plus 4
   readonly identity fields and `close()`).
   Test: `packages/protocol/tests/contract/public-contract.fixture.ts:176-210` constructs a literal
   `satisfies KernelClient` naming every one of the 15 services plus `capabilities`/`project`/
   `workspace`/`close` — a fixture that would fail to typecheck (and thus fail `bun run test:contract`,
   which is literally `tsc -p tsconfig.json`, `packages/protocol/package.json:26`) if a service were
   missing or an extra one were required. The same fixture file separately compile-pins `RunHandle`,
   `RunService`, `SecretService` and `KernelTransport` in full via their own `satisfies` blocks
   (`packages/protocol/tests/contract/public-contract.fixture.ts:89-164`, §3.6) and `SettingsRepairPlan`/`CreateTaskDto` as single literals
   (`packages/protocol/tests/contract/public-contract.fixture.ts:63-68`, `:70-75`) — five further interfaces get compile-time pinning beyond the
   `KernelClient` aggregate and the lone `RunEvent` variant this invariant and invariant 4 discuss.
   Also pinned from the consumer side: `packages/kernel/src/transport/operations.ts:21-37` defines
   `KernelServices` as a `Pick<KernelClient, ...>` naming the same 15 service keys
   (minus the 4 identity fields, which are not "services").

4. **`RunEvent` is closed to exactly 38 named variants; an open/unknown capability event is carried
   through the single `capability_event` escape variant rather than by widening the union.**
   Production: the union at `packages/protocol/src/runs.ts:291-601`; the escape variant's own doc comment: "Capability event
   names are deliberately open at the capability boundary, while this discriminated union is
   deliberately closed for clients... an extension cannot make an exhaustive protocol switch crash at
   runtime" (`packages/protocol/src/runs.ts:575-579`). Unpinned by an automated count-check in this package's own tests (the
   fixture only exercises one variant, `text_delta`, `packages/protocol/tests/contract/public-contract.fixture.ts:53-61`)
   — the 38 count is stable only by manual enumeration of the union source (§3.3 above).

5. **A `TransitionTaskDto` can never carry the `"start"` transition intent.**
   Production: `TaskTransitionIntentDto` (`packages/protocol/src/tasks.ts:6`) includes `"start"`;
   `TransitionTaskDto.intent` is typed `Exclude<TaskTransitionIntentDto, "start">` (`packages/protocol/src/tasks.ts:145`).
   The type's own comment: "Human control-plane transitions exclude `start`, which belongs to a bound
   run" (`packages/protocol/src/tasks.ts:141`). This is a compiler-enforced invariant (assigning `"start"` to that field is
   a type error) with no runtime test in this package; **unpinned** at the `bun test` layer, enforced
   only by `tsc`.

6. **`PlansService.list`/`SessionService.listPage` use opaque-cursor paging; `RunService.list`/
   `WorkflowsService.list` use offset/limit paging — the two families are never interchanged.**
   Production: `packages/protocol/src/plans.ts:144` (`PlanListInput.cursor?`, `packages/protocol/src/plans.ts:116`), `packages/protocol/src/sessions.ts:94`
   (`CursorPagination`, `packages/protocol/src/common.ts:69-72`) versus `packages/protocol/src/runs.ts:725` and `packages/protocol/src/workflows.ts:92` (both
   `Pagination`, `packages/protocol/src/common.ts:55-58`). No cited rationale beyond the type comment "for stores whose
   contents change over time" (`packages/protocol/src/common.ts:68`); unpinned by any test in this package.

7. **Compaction start is an explicit `RunEvent` rather than inferred from a later outcome.**
   `compaction_started` carries attribution plus `mode`, while `compaction` may carry only the
   bounded `fallback_reason` values `summarization_failed` or `summary_not_effective`.
   Production: `packages/protocol/src/runs.ts` (`RunEvent`). Test:
   `packages/kernel/tests/contract/transport-codecs.test.ts` ("preserves compaction lifecycle and
   fallback attribution") round-trips both strict wire shapes.

8. **`PlanProjection.revision` and `.spec_revision` are two independently-bumped counters, and a
   human approval binds only to the second.**
   Production: `packages/protocol/src/runs.ts:250-253` — "Monotonic counter bumped on every write (the CAS baseline)" vs.
   "Counter bumped only when the plan's substance changes; approval binds to it." Restated
   identically at `packages/protocol/src/plans.ts:90-93` and again on `PlanDocumentDto.approved_spec_revision`
   (`packages/protocol/src/plans.ts:100-101`, "The `spec_revision` a human approved"). Consistent across three independent
   declarations in two files; unpinned by a test in this package (the CAS mechanics are plan-package
   territory — see `specs/hosts/protocol.md` §8 delegation note and the sibling plan-capability document).

9. **Environment selection and composition are preview-bound, while execution history carries only
   its minimal identity.** `EnvironmentService.select`, `.clearSelection`, and
   `.applyComposition` require `preview_token`; composition and definition updates require an exact
   expected revision, and `EnvironmentRunRef` contains only `id` and `fingerprint`.
   Production: `EnvironmentRunRef`, `EnvironmentCompositionInput`, and `EnvironmentService` in
   `packages/protocol/src/environments.ts`. Test:
   `packages/protocol/tests/contract/public-contract.fixture.ts:176-210` compile-pins the service on
   `KernelClient`; runtime behavior is pinned by
   `packages/kernel/tests/integration/environment-manager.test.ts` and owned by
   [Extension Environments](environments.md#5-invariants).

## 6. Failure modes and degradation

This package defines no error *handling* — it defines the vocabulary a kernel is expected to return
errors in, and documents on individual methods where a specific code applies:

| Situation | Code / shape | Where documented |
|---|---|---|
| Generic kernel-level failure | `KernelError` with one of 11 `KernelErrorCode` values | `packages/protocol/src/common.ts:87-106` |
| A settings write raced a concurrent edit | `conflict` | `packages/protocol/src/config.ts:411-412` (`updateSettings`), `:376-377` (`repairSettings`) |
| Memory not configured on this kernel | `capability_disabled` (implied by `KernelErrorCode`, applied per `packages/protocol/src/memory.ts:9-10`'s doc comment "the methods reject with a `capability_disabled` / memory-disabled `KernelError`") | `packages/protocol/src/memory.ts:9-10` |
| Deleting a plan that is still `active`/`awaiting_approval` | throws (unspecified which `KernelErrorCode`, but the method's own doc says "throws when the plan is still live") | `packages/protocol/src/plans.ts:169-170` |
| A run ended on a failure | `RunResult.error?: { code: string; message: string }`, "present only on a `failed` run" | `packages/protocol/src/runs.ts:169-170` |
| A workflow leader failed | `workflow_run_failed`'s `error?: { code; message }` | `packages/protocol/src/runs.ts:492` |
| A run was rebuilt from a damaged crash journal | `RunDetail.recovery?: RunRecovery` — `skipped_lines` and `synthesized_tool_calls` counts, "present ... only when something was actually lost or synthesized, so its absence means the record is intact" | `packages/protocol/src/runs.ts:188-204`, `:221-225` |
| A settings scope file exists but fails to parse/validate | `SettingsSource.error?: string` — "the UI shows this instead of silently treating the scope as empty" | `packages/protocol/src/config.ts:193-197` |
| An Environment selection or definition is invalid | `ResolvedEnvironment.status: "invalid"` plus typed `EnvironmentIssue[]`; no fallback is represented | `packages/protocol/src/environments.ts:55-76`, `:116-132` |
| An Environment reference is missing or a workspace executable surface is untrusted | `status: "degraded"` plus the exact `missing_plugin`, `missing_skill`, or `workspace_untrusted` issue | `packages/protocol/src/environments.ts:55-76` |
| An agent config file's frontmatter fails to parse | `AgentDoc.malformed?: string` — "the `frontmatter` above is then the lenient fallback (`{}`), not the file's real content" | `packages/protocol/src/config.ts:323-331` |
| An agent config file overlaying a shipped agent is unusable | `AgentOverlay.status: "rejected"` + `reason` — "the shipped default runs unchanged" | `packages/protocol/src/config.ts:274-290` |
| A repository's `settings.json` asked for fields it may not set on its own authority | `SettingsView.withheld_workspace_fields?: readonly string[]` | `packages/protocol/src/config.ts:211-220` |
| A capability event's own type is not in this protocol version | `capability_event` with `projection`/`truncated` fields rather than a widened `type` | `packages/protocol/src/runs.ts:571-590` |
| Live event consumer fell behind (backpressure) | `events_dropped` — "emitted at most once... only incremental variants are ever dropped, and their authoritative content still arrives" | `packages/protocol/src/runs.ts:591-600` |
| MCP servers degraded for this run | `mcp_degraded` event listing `{ name, reason }[]` | `packages/protocol/src/runs.ts:601` |
| A tool call the provider abandoned mid-stream never settles | not modeled by this package at all — the closest adjacent shape, `tool_call_started`, has no corresponding "abandoned" variant; only `tool_call` (`ok: boolean`) is authoritative |

Two properties the package states about *degradation of fidelity* rather than error per se:

- `events_dropped`'s own comment: dropping only ever affects incremental/live-only variants, and "the
  authoritative content still arrives — a `tool_call` carries its tool's full output and
  `iteration_completed.response` the final assistant text — so this reports fidelity of the *live*
  view, not data loss" (`packages/protocol/src/runs.ts:596-598`).
- `RunRecovery`'s own comment: "counts only: the skipped lines themselves never cross the wire"
  (`packages/protocol/src/runs.ts:194`) — a client is told *how much* was lost, never *what*.

## 7. Coupling

### 7.1 Depends on

Nothing. `packages/protocol/package.json` has no `dependencies`/`devDependencies`/
`optionalDependencies`/`peerDependencies` key at all (`packages/protocol/package.json:1-33`, read in
full — no such key appears). Its own `.ts` files import nothing from any other package; every
`import type` among its 19 files (`packages/protocol/src/client.ts:9-24`, `packages/protocol/src/runs.ts:8-12`, `packages/protocol/src/config.ts:8`, `packages/protocol/src/environments.ts:10-11`, `packages/protocol/src/memory.ts:16`,
`packages/protocol/src/sessions.ts:14-16`, `packages/protocol/src/tasks.ts:1`, `packages/protocol/src/workflows.ts:14-15`, `packages/protocol/src/skills.ts:10`) points at a sibling module
inside `packages/protocol/src/`. `common.ts` is the one exception: as the vocabulary root, it imports
nothing at all (`grep -n "import" packages/protocol/src/common.ts` returns no matches) — every other
type in the package is built from what `common.ts` itself declares.

### 7.2 Depended on by

Every consumer reaches it **only as a type import**, verified directly (§5, invariant 2):

| Consumer | Value imports | Type imports | Forcing mechanism |
|---|---|---|---|
| `@clarvis/kernel` | 0 | present in `kernel.ts`, `tasks/task-service.ts`, `tasks/map-task-dtos.ts`, `plans/plans-service.ts`, `workflows/workflows-service.ts`, `models/model-catalog.ts`, `memory/memory-service.ts`, `transport/{wire,operations,client,server}.ts`, `application/scope-policy.ts`, `sessions/session-service.ts`, `config/{config-store,config-service}.ts`, `runs/{run-service,map-result}.ts` (all `import type` blocks, confirmed by the multiline-brace-import check in §5) | `packages/kernel/tsconfig.json:11` maps the bare specifier `@clarvis/protocol` to the package's own **source** (`../protocol/src/index.ts`), not `dist` — so `tsc` type-checks the kernel directly against this package's interfaces |
| `@clarvis/server` | 0 | `mcp/run-tool.ts`, `mcp/notify.ts`, `mcp/elicitation.ts` | same pattern; `packages/server/tests/architecture/dependency-boundary.test.ts:31-46` fixture-tests that `import type` from `@clarvis/protocol` is a recognized, allowed import form |
| `@clarvis/code` | 0 | `run-host.ts`, `adapters/{models-catalog,message-content,session-store,kernel-run-client,plugins,settings,session}.ts`, `views/config/{WorkflowsHub,TasksHub}.tsx`, `features/tasks/controller.ts`, `app/commands.tsx` | `packages/code/tests/architecture/dependency-boundary.test.ts` pins `code`'s Clarvis-namespaced manifest dependencies to exactly `["@clarvis/kernel", "@clarvis/paths", "@clarvis/protocol"]` |

Both `code`'s and `server`'s dependency-boundary tests explicitly *permit* `@clarvis/protocol` (it is
absent from both files' `FORBIDDEN` arrays — `packages/code/tests/architecture/dependency-boundary.test.ts:13-21`,
`packages/server/tests/architecture/dependency-boundary.test.ts:5-11`) while forbidding `@clarvis/loop`
and every engine-layer package — i.e. the test suite encodes "may depend on protocol, may not depend
on the engine" as one design, not two.

### 7.3 What forces the type-only property, structurally

1. `verbatimModuleSyntax: true` in `packages/protocol/tsconfig.json:8` forces every re-export in
   `index.ts` to be spelled `export type *` rather than plain `export *` — a plain `export *` of an
   `interface`-only module would still compile under a looser setting, but under this one the
   compiler requires the `type` modifier once nothing in the module is a value.
2. `tooling/checks/coverage.ts`'s `TYPE_ONLY_PACKAGES` gate (§5, invariant 1) makes a *regression* —
   someone adding a real `export const` to any protocol module — fail the coverage step of
   `check:pre-commit`, independent of whether any test imports the new symbol.
3. `packages/kernel/tsconfig.json:12`'s `paths` mapping to **source** (not `dist`) means the kernel's
   own `tsc` run is the thing that would catch a signature mismatch between what `client.ts` promises
   and what `kernel.ts` actually implements — there is no build step in between that could paper over
   drift.

## 8. Open questions

- **Why two independent pagination families exist** (offset/limit vs. cursor) is stated as an
  intent ("stores whose contents change over time", `packages/protocol/src/common.ts:68`) but no test or runtime code in
  this package demonstrates a failure mode the offset/limit family would actually suffer under
  mutation — the reasoning is asserted in a comment, not shown.
- **How a concrete transport (stdio / HTTP) actually implements `KernelTransport`** — framing,
  method-name → operation dispatch, the wire codec for `RunEvent` — is explicitly delegated by this
  document's own scope statement to [hosts/kernel-transport.md](kernel-transport.md) (`specs/hosts/kernel-transport.md`,
  referenced but not read, per the delegation boundary this document was given). `operations.ts` was read
  only as far as needed to confirm the 15-service `KernelServices` `Pick` and the `runs.start`
  exclusion (`packages/kernel/src/transport/operations.ts:21-37`, `:147`) — its full method-table content is that sibling document's
  territory.
- **Whether any hosted/multi-tenant kernel actually exists yet** that would make `Principal`,
  `auth?: string` on `ConnectOptions`, or the "hosted kernel" language throughout the doc comments
  concrete — every doc comment describing hosted behavior (e.g. `packages/protocol/src/client.ts:16-20`, `packages/protocol/src/secrets.ts:9`,
  `packages/protocol/src/workspace.ts:5-6`) is phrased as a design accommodation ("on a hosted kernel...") rather than a
  reference to working code, and this document's own scope gives no evidence either way.
- **The exact set of `KernelErrorCode` values a given method can actually return** is not enumerated
  per-method anywhere in this package outside the handful of doc-comment mentions captured in §6 —
  most methods simply return `Promise<T>` with no declared error type, so a client cannot know from
  the type alone which of the 11 codes a given call might raise. This is presumably resolved by
  kernel-side documentation/behavior outside this document's scope.
- **Whether `RunEvent`'s 38-variant count is actively guarded against silent growth** — no test in
  `packages/protocol/tests/` counts the union's arms; the count in §3.3/§5 is a manual read of
  `packages/protocol/src/runs.ts:291-601`, and the only variant any test constructs is a
  `text_delta` literal (`packages/protocol/tests/contract/public-contract.fixture.ts:53-61`), so
  nothing in this package's own test suite would fail if a 39th variant were added without
  corresponding client-side handling.
- **The one test file this package owns** (`tests/contract/public-contract.fixture.ts`) is exercised
  only via `tsc -p tsconfig.json` (`packages/protocol/package.json:26`) — there is no `bun test` runner invocation
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
