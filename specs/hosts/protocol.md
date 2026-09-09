# The transport-agnostic kernel to UI contract

> Implemented at `packages/protocol/src/**` plus
> `packages/kernel/src/transport/operations.ts` as the consumer table. Nontrivial claims below carry
> checkable source or test evidence, preferably at the owning symbol. Open questions are collected
> in the final section.

## 1. Purpose

`@clarvis/protocol` is the single package a UI depends on to talk to a Clarvis kernel: it is "wire
DTOs and the `KernelClient` interface", stated verbatim in the package's own doc comment
(`packages/protocol/src/index.ts`). It carries **no dependency on `@clarvis/loop`**
(`packages/protocol/src/index.ts`), so a UI client (`@clarvis/code`) programs against this contract and never imports the
engine. The package's `package.json` declares zero `dependencies`, `devDependencies`,
`optionalDependencies` or `peerDependencies` (`packages/protocol/package.json` — no dependency
key of any kind appears); it is a pure leaf.

The problem this solves, as the file-level doc comments state it repeatedly: today the contract is
implemented in-process (`createInProcessKernel`, referenced only in comments here since kernel
implementation is out of scope), but every interface is written so that "swapping stdio ↔ HTTP is
only a matter of which transport the client was built on" (`packages/protocol/src/client.ts`). Concretely this means:
a `KernelClient` service method never itself opens a socket — `packages/protocol/src/transport.ts`
states the transport seam is a request/response-plus-notifications shape, "JSON-RPC-shaped, with
Clarvis's own method vocabulary — not MCP's". Serialized DTO fields are JSON-shaped; service,
transport, cancellation and live-handle interfaces deliberately also contain methods, promises,
signals and an async iterable. Opaque payload escape hatches are typed `unknown`, for example
`KernelError.details` at `packages/protocol/src/common.ts`.

The package achieves its "transport-agnostic" claim by construction: its public declarations are
interfaces and type aliases, and `packages/protocol/src/index.ts` re-exports the sibling modules
with `export type *`.
TypeScript erases the whole surface at compile time — the package produces **zero runtime values**,
confirmed independently below (§7).

## 2. Surface

### 2.1 Module list

Source ownership:

| File | Owns |
| --- | --- |
| `index.ts` | Barrel: `export type *` from the modules below |
| `common.ts` | `Scope`, `Principal`, `ProjectRef`, `WorkspaceRef`, `Pagination`/`Page`, `CursorPagination`/`CursorPage`, `Timestamp`, `JsonSchema`, `KernelErrorCode`, `KernelError`, `Unsubscribe` |
| `runs.ts` | `RunService`, `RunHandle`, `StartRunParams`, `RunEvent` (39-value discriminated union), messages, usage, Extension Profile identity, guard/memory/plans modes, elicitation types |
| `hosting.ts` | Hosted-run identity, snapshot pages, handoff receipts, control epochs, attachments and the `HostingService` interface |
| `local-host.ts` | Optional local operator process state, bounded browser handoff DTOs and explicit runtime retry/restart controls |
| `config.ts` | `ConfigService`, `SettingsData`/`SettingsView` (incl. `WorkspaceTrustVerdict`, `known_grants`), the `SandboxConfig`/`SandboxInspection` doctor cluster, `SettingsRepairPlan` (2-variant union), `AgentSummary`/`AgentDoc`/`AgentOverlay`/`AgentBudget`, context docs — see §3.10/§3.11 |
| `plugins.ts` | `PluginService`, `PluginView`, `PluginContributions`, normalized install sources and atomic lifecycle DTOs |
| `extension-profiles.ts` | `ExtensionProfileService`, exact inventory and plugin/skill references, definitions, composition previews, resolved snapshots, deltas, diagnostics, deletion, and persisted run identity |
| `secrets.ts` | `SecretService` |
| `models.ts` | `ModelCatalogService`, `ModelCatalog`, `CatalogProvider`, `CatalogModel` |
| `provider-auth.ts` | token-free subscription schemes, states, device authorization and `ProviderAuthService` |
| `workspace.ts` | `WorkspaceService`, `WorkspaceEntry` |
| `memory.ts` | `MemoryService`, health/reindex/jobs DTOs, `MemoryIngestDetail` |
| `plans.ts` | `PlansService`, `PlanDocumentDto`, `PlanTaskDto`, `PlanRef` |
| `workflows.ts` | `WorkflowsService`, `WorkflowNode`, `WorkflowSequence`, `WorkflowSummary`/`WorkflowDetail` |
| `skills.ts` | `SkillsService`, `SkillSummary`, `SkillProvenance`, `SkillPresentation`, `SkillToolDependency` |
| `sessions.ts` | `SessionService`, `Session`, `SessionSummary`, `SessionTurn`, cache-detail-aware `SessionTotals`, Agent Profile binding, and Extension Profile snapshot identity |
| `tasks.ts` | `TasksService`, all `Task*Dto` shapes, `ActiveTaskRequestDto`/`ActiveTaskBindingDto` |
| `storage.ts` | `StorageService`, bounded inventory DTOs and cleanup request/result shapes |
| `transport.ts` | `KernelTransport`, `KernelRequestOptions`, `KernelAbortSignal` |
| `client.ts` | `KernelClient`, `KernelCapabilities`, `RuntimeStatus`, `ConnectOptions` |

(`packages/protocol/src/index.ts` — one `export type *` line per module above.)

`KernelClient.hosting` is an optional `HostingService`, advertised by
`KernelCapabilities.hosting.host_generation`. `connectKernelClient` exposes it only when that
generation is present in the handshake. Ordinary in-process/stdio composition does not enable it.

`KernelClient.localHost` additionally requires `capabilities.local_host` and hosted generation.
It is advertised only to an authenticated local operator. `LocalHostStatus` carries runtime state,
sequenced notices and restart state; `LocalHostBrowserRequest` carries a claimed URL with an id and
expiry. The service uses the same kernel operation catalog and never serializes application callbacks
or provider credentials. Runtime retry and restart remain explicit operations.

Production: `LocalHostService` in [local-host.ts](../../packages/protocol/src/local-host.ts),
`OPERATIONS.localHost` in [operations.ts](../../packages/kernel/src/transport/operations.ts),
`createLocalHostClient` in [local-host-client.ts](../../packages/kernel/src/transport/local-host-client.ts)
and `createFileRunHost` in [file-host.ts](../../packages/kernel/src/hosting/file-host.ts).
Test: [transport-codecs.test.ts](../../packages/kernel/tests/contract/transport-codecs.test.ts)
checks the shared catalog facade; authenticated role checks are exercised by
[file-run-host.test.ts](../../packages/kernel/tests/integration/file-run-host.test.ts).
Its DTOs describe an atomic snapshot/tail observation and independent handoff receipts; a lost
connection rejects the observation rather than manufacturing an execution result.
Production: [hosting.ts](../../packages/protocol/src/hosting.ts), `KernelClient` in
[client.ts](../../packages/protocol/src/client.ts) and `createHostingClient` in
[hosting-client.ts](../../packages/kernel/src/transport/hosting-client.ts).
Test: [hosted-transport.test.ts](../../packages/kernel/tests/integration/hosted-transport.test.ts).
The lifecycle and storage ownership are specified in [hosted runs](hosted-runs.md).
`Session.revision` carries the hosted coordinator's optimistic mutation revision; an unhosted
conversation has no assigned revision. Hosted reads materialize zero before ownership begins.
Production: `Session` in [sessions.ts](../../packages/protocol/src/sessions.ts) and
`createHostedSessionCoordinator` in [sessions.ts](../../packages/kernel/src/hosting/sessions.ts).
Test: [hosted-sessions.test.ts](../../packages/kernel/tests/integration/hosted-sessions.test.ts).
The write and accounting contract is in [sessions](sessions.md#host-owned-conversation-transactions).

### 2.2 `KernelClient` — the object a UI programs against

Defined in `packages/protocol/src/client.ts`. Aggregates identity/capability fields, named services,
optional hosted-run ownership and a close method:

| Member | Type | File |
| --- | --- | --- |
| `capabilities` | `KernelCapabilities` | `KernelClient.capabilities` |
| `principal` | `Principal \| undefined` | `KernelClient.principal` |
| `project` | `ProjectRef` | `KernelClient.project` |
| `workspace` | `WorkspaceRef` | `KernelClient.workspace` |
| `runs` | `RunService` | `KernelClient.runs` |
| `hosting?` | `HostingService` | `KernelClient.hosting`; requires the advertised host generation |
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
optional host-reported `runtime` and `hosting.host_generation`. Native placement reports `kind`,
`host_platform`, effective isolation, lifecycle and optional fallback origin.
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
| --- | --- | --- |
| `start` | `(params: StartRunParams) => Promise<RunHandle>` | `RunService.start` |
| `compact` | `(execution_id, request?, options?) => Promise<RunCompactionResult>` | `RunService.compact` |
| `context` | `(execution_id, target_window_tokens?) => Promise<context estimate>` | `RunService.context` |
| `get` | `(execution_id: string) => Promise<RunDetail>` | `RunService.get` |
| `list` | `(page?: Pagination) => Promise<Page<RunSummary>>` | `RunService.list` |
| `delete` | `(execution_id: string) => Promise<void>` | `RunService.delete` |

`RunHandle` in `packages/protocol/src/runs.ts`, the live object `start` returns:

| Member | Signature | Declaration |
| --- | --- | --- |
| `execution_id` | `readonly string` | `RunHandle.execution_id` |
| `events` | `readonly AsyncIterable<RunEvent>` | `RunHandle.events` |
| `steer` | `(message: Message \| string) => Promise<void>` | `RunHandle.steer` |
| `compact` | `(request?: string) => Promise<void>` | `RunHandle.compact` |
| `cancel` | `() => Promise<void>` | `RunHandle.cancel` |
| `respond` | `(response: ElicitationResponse) => Promise<void>` | `RunHandle.respond` |
| `onElicit` | `(handler: (req: ElicitationRequest) => void) => void \| (() => void)` | `RunHandle.onElicit`; managed handles return unsubscribe |
| `onElicitSettled?` | `(handler: (id: string) => void) => () => void` | `RunHandle.onElicitSettled`; answered or expired questions |
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

#### `ConfigService` (`packages/protocol/src/config.ts`)

| Method | Signature | File |
| --- | --- | --- |
| `getSettings` | `() => Promise<SettingsView>` | `packages/protocol/src/config.ts` |
| `previewSettingsRepair` | `(scope: Scope) => Promise<SettingsRepairPlan \| null>` | `packages/protocol/src/config.ts` |
| `repairSettings` | `(scope: Scope, expectedRevision: string) => Promise<SettingsView>` | `packages/protocol/src/config.ts` |
| `approveWorkspace` | `() => Promise<SettingsView>` | `packages/protocol/src/config.ts` |
| `revokeWorkspace` | `() => Promise<SettingsView>` | `packages/protocol/src/config.ts` |
| `workspaceTrustError` | `() => Promise<string \| null>` | `packages/protocol/src/config.ts` |
| `updateSettings` | `(scope, patch: Partial<SettingsData>, expectedRevision: string \| null) => Promise<SettingsView>` | `packages/protocol/src/config.ts` |
| `inspectSandbox` | `(options?: { refresh?: boolean }) => Promise<SandboxInspection>` | `packages/protocol/src/config.ts` |
| `listAgents` | `() => Promise<AgentSummary[]>` | `packages/protocol/src/config.ts` |
| `getAgent` | `(scope: Scope \| "builtin", name: string) => Promise<AgentDoc>` | `packages/protocol/src/config.ts` |
| `writeAgent` | `(scope, name, doc: AgentWrite) => Promise<AgentSummary>` | `packages/protocol/src/config.ts` |
| `deleteAgent` | `(scope, name) => Promise<void>` | `packages/protocol/src/config.ts` |
| `renameAgent` | `(scope, oldName, newName) => Promise<AgentSummary>` | `packages/protocol/src/config.ts` |
| `getContext` | `(scope) => Promise<ContextDoc \| null>` | `packages/protocol/src/config.ts` |
| `subscribe` | `(kinds: ConfigChangeKind[], listener) => Unsubscribe` | `packages/protocol/src/config.ts` |

#### `PluginService` (`packages/protocol/src/plugins.ts`)

| Method | Signature | File |
| --- | --- | --- |
| `list` | `() => Promise<PluginView[]>` | `packages/protocol/src/plugins.ts` |
| `install` | `(url, subdir?, target?: { source }) => Promise<PluginView>` | `PluginService.install` |
| `installSource` | `(source: PluginInstallSource, target?: { source }) => Promise<PluginView>` | `PluginService.installSource` |
| `update` | `(ref: PluginRef) => Promise<PluginView>` | `PluginService.update` |
| `uninstall` | `(ref: PluginRef) => Promise<void>` | `PluginService.uninstall` |

#### `ExtensionProfileService` (`packages/protocol/src/extension-profiles.ts`, symbol `ExtensionProfileService`)

| Method | Signature | File |
| --- | --- | --- |
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

#### `SecretService` (`packages/protocol/src/secrets.ts`)

| Method | Signature | File |
| --- | --- | --- |
| `listNames` | `() => Promise<string[]>` | `packages/protocol/src/secrets.ts` |
| `set` | `(name: string, value: string) => Promise<void>` | `packages/protocol/src/secrets.ts` |
| `delete` | `(name: string) => Promise<void>` | `packages/protocol/src/secrets.ts` |

Doc comment states values "only ever flow client → kernel; listing returns names, never values"
(`packages/protocol/src/secrets.ts`), and warns that secrets "travel over the transport on `set`... a hosted kernel needs
TLS plus at-rest protection" (`packages/protocol/src/secrets.ts`).

#### `ModelCatalogService` (`packages/protocol/src/models.ts`)

| Method | Signature | File |
| --- | --- | --- |
| `get` | `() => Promise<ModelCatalog>` | `packages/protocol/src/models.ts` |
| `refresh` | `() => Promise<ModelCatalog>` | `packages/protocol/src/models.ts` |
| `getEntitled` | `(scheme: SubscriptionScheme) => Promise<CatalogProvider>` | `packages/protocol/src/models.ts` |
| `refreshEntitled` | `(scheme: SubscriptionScheme) => Promise<CatalogProvider>` | `packages/protocol/src/models.ts` |

#### `WorkspaceService` (`packages/protocol/src/workspace.ts`)

| Method | Signature | File |
| --- | --- | --- |
| `listFiles` | `(query?: { prefix?, glob?, limit? }) => Promise<WorkspaceEntry[]>` | `packages/protocol/src/workspace.ts` |
| `readFile` | `(path: string) => Promise<{ path: string; content: string }>` | `packages/protocol/src/workspace.ts` |
| `readImage` | `(path: string) => Promise<{ path: string; mime: string; data: string }>` | `packages/protocol/src/workspace.ts` |

#### `MemoryService` (`packages/protocol/src/memory.ts`)

| Method | Signature | File |
| --- | --- | --- |
| `health` | `() => Promise<MemoryHealthReport>` | `packages/protocol/src/memory.ts` |
| `reindex` | `() => Promise<MemoryReindexResult>` | `packages/protocol/src/memory.ts` |
| `jobs` | `(filter?: MemoryJobFilter) => Promise<{ jobs: MemoryJob[]; counts }>` | `packages/protocol/src/memory.ts` |
| `retryJob` | `(runId: string) => Promise<MemoryJob \| null>` | `packages/protocol/src/memory.ts` |

Deliberately narrow: the doc comment says browsing/reading/searching/editing/revision history "left
with the memory browser they existed to draw — the wiki is markdown on disk, and the only thing that
writes it is the agent" (`packages/protocol/src/memory.ts`). Methods reject with `capability_disabled` when memory is
not configured (`packages/protocol/src/memory.ts`).

#### `PlansService` (`packages/protocol/src/plans.ts`)

| Method | Signature | File |
| --- | --- | --- |
| `list` | `(input?: PlanListInput) => Promise<PlanListResult>` | `packages/protocol/src/plans.ts` |
| `read` | `(id: string) => Promise<PlanDocumentDto>` | `packages/protocol/src/plans.ts` |
| `setRetention` | `(id: string, retention: PlanRetention) => Promise<PlanDocumentDto>` | `packages/protocol/src/plans.ts` |
| `delete` | `(id: string) => Promise<{ id: string; deleted: boolean }>` | `packages/protocol/src/plans.ts` |

`delete`'s doc comment: "throws when the plan is still live (`active` or `awaiting_approval`); only
terminal plans may be deleted" (`packages/protocol/src/plans.ts`).

#### `WorkflowsService` (`packages/protocol/src/workflows.ts`)

| Method | Signature | Declaration |
| --- | --- | --- |
| `get` | `(id: string) => Promise<WorkflowDetail>` | `WorkflowsService.get` |
| `list` | `(page?: Pagination) => Promise<Page<WorkflowSummary>>` | `WorkflowsService.list` |
| `delete` | `(id: string) => Promise<void>` | `WorkflowsService.delete` |

No `start` method: the `WorkflowsService` doc comment states that a workflow is started through
`RunService.start` like any run — the kernel routes it as a workflow when the entry agent profile
carries the `workflow` grant. This service adds only the tree structure (the edges plus a rollup)
over runs that are individually reachable through `RunService.get`.
`WorkflowDetail.sequence` optionally adds the latest durable Admiral-controlled round checkpoint;
absence means a legacy record or a workflow that used no controlled round sequence.

#### `SkillsService` (`packages/protocol/src/skills.ts`)

| Method | Signature | File |
| --- | --- | --- |
| `list` | `() => Promise<SkillSummary[]>` | `packages/protocol/src/skills.ts` |
| `getPrompt` | `(name: string, args?: { task?: string }) => Promise<Message[]>` | `packages/protocol/src/skills.ts` |

#### `SessionService` (`packages/protocol/src/sessions.ts`)

| Method | Signature | File |
| --- | --- | --- |
| `listPage` | `(page?: CursorPagination) => Promise<CursorPage<SessionSummary>>` | `packages/protocol/src/sessions.ts` |
| `list` | `() => Promise<Session[]>` | `packages/protocol/src/sessions.ts` |
| `get` | `(id: string) => Promise<Session \| null>` | `packages/protocol/src/sessions.ts` |
| `save` | `(session: Session) => Promise<void>` | `packages/protocol/src/sessions.ts` |
| `delete` | `(id: string) => Promise<boolean>` | `packages/protocol/src/sessions.ts` |

Both `Session` and `SessionSummary` carry `SessionTotals` as
`{ input: number; output: number; cached?: number; cost_usd?: number }`. `cached` is present only
when every contributing positive-input run reported its cache split; numeric `0` is therefore a
measured zero, while absence means a client cannot honestly subtract cached input or derive a hit
rate. Production: `packages/protocol/src/sessions.ts` (`SessionTotals`). Test:
`packages/protocol/tests/contract/public-contract.fixture.ts` (`unknownCacheSessionTotals`).

#### `StorageService` (`packages/protocol/src/storage.ts`)

| Method | Signature |
| --- | --- |
| `inspect` | `() => Promise<StorageSnapshot>` |
| `cleanup` | `(request: StorageCleanupRequest) => Promise<StorageCleanupResult>` |

`StorageSnapshot` contains only bounded category counts/bytes, a truncation flag and the
`present`/`owner_only` posture of credential files. It contains no pathname or persisted content.
`StorageCleanupRequest.categories` is closed to `temporary | cache` and carries an explicit
`dry_run`; see [`storage.md`](storage.md).

#### `TasksService` (`packages/protocol/src/tasks.ts`)

| Method | Signature | File |
| --- | --- | --- |
| `status` | `(options?: TaskCallOptions) => Promise<TaskProviderStatusDto>` | `packages/protocol/src/tasks.ts` |
| `capabilities` | `(options?) => Promise<TaskProviderCapabilitiesDto>` | `packages/protocol/src/tasks.ts` |
| `listContainers` | `(input: ListTaskContainersDto, options?) => Promise<TaskContainerPageDto>` | `packages/protocol/src/tasks.ts` |
| `search` | `(input: SearchTasksDto, options?) => Promise<TaskPageDto>` | `packages/protocol/src/tasks.ts` |
| `get` | `(ref: TaskRefDto, options?) => Promise<TaskDocumentDto>` | `packages/protocol/src/tasks.ts` |
| `searchActors` | `(input: SearchTaskActorsDto, options?) => Promise<TaskActorPageDto>` | `packages/protocol/src/tasks.ts` |
| `create` | `(input: CreateTaskDto, options?) => Promise<TaskDocumentDto>` | `packages/protocol/src/tasks.ts` |
| `assign` | `(input: AssignTaskDto, options?) => Promise<TaskDocumentDto>` | `packages/protocol/src/tasks.ts` |
| `previewTransition` | `(input: PreviewTaskTransitionDto, options?) => Promise<TaskTransitionPreviewDto>` | `packages/protocol/src/tasks.ts` |
| `transition` | `(input: TransitionTaskDto, options?) => Promise<TaskDocumentDto>` | `packages/protocol/src/tasks.ts` |
| `comment` | `(input: CommentTaskDto, options?) => Promise<TaskDocumentDto>` | `packages/protocol/src/tasks.ts` |
| `attachArtifact` | `(input: AttachTaskArtifactDto, options?) => Promise<TaskDocumentDto>` | `packages/protocol/src/tasks.ts` |

Every method except `status`/`capabilities` takes an `options?: TaskCallOptions` carrying only a
`signal` (`packages/protocol/src/tasks.ts`) — the type's own comment: "cancellation is local transport metadata and
is never serialized as params" (`packages/protocol/src/tasks.ts`).

### 2.4 `KernelTransport` — the seam a client sits on

Defined at `packages/protocol/src/transport.ts`, not part of `KernelClient` itself:

| Member | Signature | File |
| --- | --- | --- |
| `request<T>` | `(method: string, params?: unknown, options?: KernelRequestOptions) => Promise<T>` | `packages/protocol/src/transport.ts` |
| `notify` | `(method: string, params?: unknown) => void` | `packages/protocol/src/transport.ts` |
| `onNotification` | `(method: string, handler: (params: unknown) => void) => () => void` | `packages/protocol/src/transport.ts` |
| `onClose?` | `(handler: (reason?: unknown) => void) => () => void` | `packages/protocol/src/transport.ts` |
| `close` | `() => Promise<void>` | `packages/protocol/src/transport.ts` |

`KernelRequestOptions` (`packages/protocol/src/transport.ts`) carries exactly one field, `signal`.
It is local cancellation metadata; task operations explicitly keep it out of serialized parameters
through `TaskCallOptions` (`packages/protocol/src/tasks.ts`).

## 3. Data and formats

### 3.1 Foundational shared types (`common.ts`)

| Type | Shape | File |
| --- | --- | --- |
| `Scope` | `"global" \| "workspace"` | `packages/protocol/src/common.ts` |
| `Principal` | `{ readonly id: string; readonly display?: string }` | `packages/protocol/src/common.ts` |
| `ProjectRef` | `{ readonly id: string; readonly label?: string }` | `packages/protocol/src/common.ts` |
| `WorkspaceRef` | `{ id, projectId, label, kind: "primary" \| "external_worktree", path? }` | `packages/protocol/src/common.ts` |
| `Pagination` | `{ limit?: number; offset?: number }` | `packages/protocol/src/common.ts` |
| `Page<T>` | `{ items: T[]; total: number; limit: number; offset: number }` | `packages/protocol/src/common.ts` |
| `CursorPagination` | `{ limit?: number; cursor?: string }` | `packages/protocol/src/common.ts` |
| `CursorPage<T>` | `{ items: T[]; next_cursor?: string }` | `packages/protocol/src/common.ts` |
| `Timestamp` | `number` (epoch ms) | `packages/protocol/src/common.ts` |
| `JsonSchema` | `Record<string, unknown>` | `packages/protocol/src/common.ts` |
| `KernelErrorCode` | 11-member string union (below) | `packages/protocol/src/common.ts` |
| `KernelError` | `{ code, message, details?: unknown }` | `packages/protocol/src/common.ts` |
| `Unsubscribe` | `() => void` | `packages/protocol/src/common.ts` |

Two distinct pagination shapes coexist by design: offset/limit `Page<T>` for `RunService.list` and
`WorkflowsService.list` (whose contents are relatively stable), versus opaque-cursor `CursorPage<T>`
for `SessionService.listPage` and `PlansService.list` — described at the type's own definition as "for
stores whose contents change over time" (`packages/protocol/src/common.ts`). `PlanListInput`/`PlanListResult`
(`packages/protocol/src/plans.ts`) roll their own cursor field (`cursor?: string`, `next_cursor?: string`) rather
than embedding `CursorPagination`/`CursorPage<T>` directly — the shapes are structurally identical but
not the same declared type.

### 3.2 `KernelErrorCode` — the 11 stable error codes

`packages/protocol/src/common.ts`:

```
"unauthorized" | "not_found" | "invalid_request" | "conflict" | "unavailable" |
"unsupported" | "cancelled" | "capability_disabled" | "continuation_unavailable" |
"resource_exhausted" | "internal"
```

`KernelError` (`packages/protocol/src/common.ts`) wraps a code with a `message: string` and optional `details:
unknown` ("machine detail — validation issues, provider error, …", `packages/protocol/src/common.ts`).

### 3.3 `RunEvent` — the 39-variant discriminated union

Defined as `RunEvent` in `packages/protocol/src/runs.ts`, one large union type. Every variant and its
distinguishing fields:

| `type` | Extra fields (beyond `at`/attribution) | Source |
| --- | --- | --- |
| `run_started` | `lead_model?`, `subagent_model?` | `packages/protocol/src/runs.ts` |
| `run_ended` | `status`, `reason?`, `code?` | `packages/protocol/src/runs.ts` |
| `iteration_started` | `iteration`, `model?` | `packages/protocol/src/runs.ts` |
| `iteration_completed` | `iteration`, `model?`, `response`, `response_phase?: "commentary"\|"final_answer"`, `input_tokens`, `output_tokens`, `cached_tokens?` | `packages/protocol/src/runs.ts` |
| `tool_call_started` | `call_id`, `tool`, `server`, `arguments?` | `packages/protocol/src/runs.ts` |
| `tool_call` | `call_id?`, `tool`, `server`, `arguments?`, `ok`, `result?`, `error?`, `diff?`, `guard?` | `packages/protocol/src/runs.ts` |
| `tool_output_delta` | `call_id`, `chunk` | `packages/protocol/src/runs.ts` |

`guard`, when present, is the strict `CommandGuardReview` object with mode,
allowed/denied outcome, and answerer. The run-event codec accepts exactly those
fields and enum values. Production: `CommandGuardReview`/the `tool_call` variant
in `packages/protocol/src/runs.ts` and `commandGuardReview` in
`packages/kernel/src/transport/run-event-codec.ts`. Test: `"preserves the
terminal shell auto-guard verdict"` in
`packages/kernel/tests/contract/transport-codecs.test.ts`.
| `tool_input_delta` | `call_id`, `tool`, `chars`, `stream_chars?`, `complete?: true` | `packages/protocol/src/runs.ts` (`RunEvent`) |
| `reasoning` | `iteration`, `text` | `packages/protocol/src/runs.ts` |
| `text_delta` | `iteration`, `channel: "text" \| "reasoning"`, `text`, `reset` | `packages/protocol/src/runs.ts` |
| `model_error` | `iteration`, `kind`, `message` | `packages/protocol/src/runs.ts` |
| `model_retry` | `iteration`, `kind`, `attempt`, `max_retries`, `delay_ms`, `status?`, `retry_after_ms?` | `packages/protocol/src/runs.ts` |
| `delegation_created` | `delegation_id`, `task_id?`, `title`, `task`, `profile?`, `tools?` | `packages/protocol/src/runs.ts` |
| `delegation_started` | `delegation_id`, `task_id?`, `model?` | `packages/protocol/src/runs.ts` |
| `delegation_completed` \| `delegation_failed` | `delegation_id`, `task_id?`, `status`, `summary?` | `packages/protocol/src/runs.ts` |
| `workflow_run_started` | `run_id`, `parent_run_id`, `profile?`, `title`, `task`, `round_id?`, `pass?`, `item_index?`, `replica?`, `replica_count?` | `packages/protocol/src/runs.ts` |
| `workflow_title_updated` | `run_id`, `title` | `packages/protocol/src/runs.ts` |
| `workflow_sequence_state` | `run_id`, `session_id`, six-state `status`, `revision`, current/proposed round/pass, `leaders_started`, `max_total_leaders`, `reason?` | `RunEvent` in `packages/protocol/src/runs.ts` |
| `workflow_run_progress` | `run_id`, `parent_run_id`, `iterations`, `input_tokens`, `output_tokens`, `cached_tokens?` | `RunEvent` |
| `workflow_run_completed` | `run_id`, `parent_run_id`, `status` | `RunEvent` |
| `workflow_run_failed` | `run_id`, `parent_run_id`, `status`, `error?` | `RunEvent` |
| `plan_created` | `PlanProjection` fields | `RunEvent` |
| `plan_updated` | `change: PlanUpdateChange` + `PlanProjection` fields | `RunEvent` |
| — `PlanUpdateChange`'s 4 values | `content` (objective/context/tasks body edit) · `task` (a task marker/detail change) · `status` (the plan's status changed) · `recovery` (state restored on continuation) — all glossed at the type's own doc comment | `packages/protocol/src/runs.ts` |
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
(`packages/protocol/src/runs.ts`) covers both `delegation_completed` and `delegation_failed` in a single object shape,
since the two share every other field. 37 + 2 = **39 distinct `type` values**, which is exactly the
set the table above enumerates.

Durability is not inferable from the union alone. The kernel's exhaustive `RUN_EVENT_POLICY`, checked
with `satisfies Record<RunEvent["type"], RunEventPolicy>`, currently marks 15 values live-only:
`tool_output_delta`, `tool_input_delta`, `text_delta`, `workflow_title_updated`,
`workflow_sequence_state`, `workflow_run_progress`, all five plan events, `compaction_started`, `memory_ingest`,
`capability_event`, and `events_dropped` (`packages/kernel/src/runs/event-policy.ts`). Every
other value is persisted. This agrees with the protocol comments that call deltas streamed-only
(`packages/protocol/src/runs.ts`), workflow title/progress live-only
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

### 3.4 `StartRunParams` (`packages/protocol/src/runs.ts`)

| Field | Type | Notes |
| --- | --- | --- |
| `execution_id?` | `string` | "Client-chosen id for idempotency + continuation; the kernel echoes it" (`packages/protocol/src/runs.ts`) |
| `messages` | `Message[]` | required |
| `agent?` | `string` | Agent Profile id; "the kernel translates it to the engine's profile/entry concept" (`packages/protocol/src/runs.ts`) |
| `continue_from?` | `string` | resume / steer-after-end |
| `prompt_cache_key?` | `string` | provider prompt-cache hint |
| `configuration_session_id?` | `string` | volatile owner-scoped nonce for the currently open session; generate anew on open/resume, never persist or derive from cache/continuation ids; omission requires consent per run |
| `prompt_cache_ttl?` | `"5m" \| "1h"` | kernel derives it when omitted (`packages/protocol/src/runs.ts`) |
| `guard_mode?` | `GuardMode` | `"off" \| "on" \| "auto"` (`packages/protocol/src/runs.ts`) |
| `guard_judge?` | `GuardJudge` | caller-owned judge prompt/model/timeout |
| `memory?` | `MemoryMode` | `"on" \| "off"` (`packages/protocol/src/runs.ts`) |
| `plans?` | `PlansMode` | `"off" \| "on" \| "review"` (`packages/protocol/src/runs.ts`) |
| `task?` | `ActiveTaskRequestDto` | binds one external task |
| `skill?` | `{ name: string; task?: string }` | the `/skill` flow |
| `output_schema?` | `JsonSchema` | structured-output request |

The configuration nonce stays on the host side of run admission. Its lifecycle and
`configuration_access` elicitation are specified in [self-configuration.md](self-configuration.md).
Production: `StartRunParams` in [runs.ts](../../packages/protocol/src/runs.ts) and
`createNativeConfigurationRuns` in
[native-configuration.ts](../../packages/kernel/src/configuration/native-configuration.ts).
Test: [native-configuration.test.ts](../../packages/kernel/tests/unit/native-configuration.test.ts)
and the live-session/resume test in [run-host.test.ts](../../packages/code/tests/component/run-host.test.ts).

### 3.5 `PlanProjection` and CAS revision pair

`PlanProjection` (`packages/protocol/src/runs.ts`) carries `id`, `path?`, `title`, `status: PlanStatus`,
`retention: PlanRetention`, `revision: number` ("monotonic counter bumped on every write — the CAS
baseline", `packages/protocol/src/runs.ts`), `spec_revision: number` ("bumped only when the plan's substance changes;
approval binds to it", `packages/protocol/src/runs.ts`), and `tasks: PlanTaskDto[]`. `PlanDocumentDto` (`packages/protocol/src/plans.ts`)
is the full document carried by `PlansService.read`, superset of `PlanProjection`'s fields plus
`created_at`, `updated_at`, `created_by_run`, `approved_spec_revision?`, `objective`, `context`,
`validation: string[]`, `notes`, and the canonical `markdown: string`.

### 3.6 Example wire values from the package's own test fixture

`packages/protocol/tests/contract/public-contract.fixture.ts` builds literal values satisfying the
real types (not illustrative prose — every field below is copied from that file):

```ts
// packages/protocol/tests/contract/public-contract.fixture.ts
const capabilities = {
  memory: true, skills: true, agent_tools: true,
  tasks: true,
} satisfies KernelCapabilities;

// packages/protocol/tests/contract/public-contract.fixture.ts
const startParams = {
  execution_id: "run-1",
  messages: [{ role: "user", content: "Inspect the workspace" }],
  plans: "review",
  task: { id: "CLAR-42", provider_key: "tasks:mcp:v1:sha256:fixture", mode: "work" },
  output_schema: { type: "object" },
} satisfies StartRunParams;

// packages/protocol/tests/contract/public-contract.fixture.ts
const textDelta = {
  type: "text_delta", at: 1, agent: "lead",
  iteration: 1, channel: "text", text: "Working", reset: false,
} satisfies RunEvent;
```

The same fixture goes on to compile-pin several whole interfaces via `satisfies`, beyond the three
literals above: `SettingsRepairPlan`'s `strip` variant (`packages/protocol/tests/contract/public-contract.fixture.ts` — `{ scope: "workspace",
revision: "sha256", action: "strip", dropped: ["providers.invalid"] }`), `CreateTaskDto`
(`packages/protocol/tests/contract/public-contract.fixture.ts`), and — in one contiguous block — `RunHandle` (`packages/protocol/tests/contract/public-contract.fixture.ts`), `RunService`
(`packages/protocol/tests/contract/public-contract.fixture.ts`), `SecretService` (`packages/protocol/tests/contract/public-contract.fixture.ts`) and `KernelTransport`
(`packages/protocol/tests/contract/public-contract.fixture.ts`). None of these five are exercised elsewhere in this document outside the
`client` object covered in §5 invariant 3.

### 3.7 The message/content model (`runs.ts`)

Every `StartRunParams.messages` entry and every `RunDetail.messages` entry is a `Message`
(`packages/protocol/src/runs.ts`): `{ role: Role; content: MessageContent }`. `Role` is `"user" | "assistant"`
(`packages/protocol/src/runs.ts`). `MessageContent` (`packages/protocol/src/runs.ts`) is `string | ContentPart[]` — plain text, or a
mixed sequence of parts. `ContentPart` (`packages/protocol/src/runs.ts`) is `TextPart | ImagePart`: `TextPart`
(`packages/protocol/src/runs.ts`) is `{ type: "text"; text: string }`; `ImagePart` (`packages/protocol/src/runs.ts`) is `{ type:
"image"; mime: string; data?: string; ref?: string }`, where `data` is inline base64 bytes and
`ref` is "a workspace-relative ref the kernel resolves" (`packages/protocol/src/runs.ts`) — the two are alternatives
on the same part rather than separate variants.

### 3.8 Run status, usage and the top-level run DTOs (`runs.ts`)

| Type | Shape | File |
| --- | --- | --- |
| `RunStatus` | `"running" \| "completed" \| "failed" \| "cancelled"` | `packages/protocol/src/runs.ts` |
| `AgentRole` | `"lead" \| "subagent"` | `packages/protocol/src/runs.ts` |
| `PerAgentUsage` | `{ role: AgentRole \| "vision"; model; input_tokens; output_tokens; cached_tokens; cache_write_tokens; iterations? }` | `packages/protocol/src/runs.ts` |
| `RunUsage` | `{ iterations; elapsed_ms; input_tokens?; output_tokens?; cached_tokens?; by_agent?: PerAgentUsage[]; warnings? }` | `packages/protocol/src/runs.ts` |
| `RunResult` | `{ execution_id; status: RunStatus; result?; ended_reason?; usage?: RunUsage; error?: { code; message } }` | `packages/protocol/src/runs.ts` |
| `RunSummary` | `{ execution_id; owner?; status; created_at; ended_at? }` | `packages/protocol/src/runs.ts` |
| `RunDetail` (extends `RunSummary`) | `+ messages: Message[]; events: RunEvent[]; result?: RunResult; continue_from?; plan_ref?: PlanRef; active_task?: ActiveTaskBindingDto; extension_profile?: ExtensionProfileRunRef; recovery?: RunRecovery` | `packages/protocol/src/runs.ts` |

`PerAgentUsage.role`'s `"vision"` member is not an agent: its own doc comment calls it "the engine's
image-reading pre-pass, one completion on a model no agent runs on" (`packages/protocol/src/runs.ts`) — the same
escape-hatch shape as `capability_event`'s open string (§5 invariant 4), applied to cost attribution
rather than to the event union. `RunUsage.by_agent` is optional because "a live run's final result may
report per-agent detail... instead" of the flat totals (`packages/protocol/src/runs.ts`), which are themselves
"present on a stored run (`get`)" but optional on a live result.

`ExtensionProfileRunRef` is deliberately only `{ id, fingerprint }`. `RunDetail.extension_profile`,
`SessionTurn.extension_profile`, and `SessionSummary.last_extension_profile` retain that identity without
serializing a definition, settings, or secrets (`packages/protocol/src/extension-profiles.ts`,
`packages/protocol/src/runs.ts`, `packages/protocol/src/sessions.ts`).

### 3.9 Elicitation types (`runs.ts`)

| Type | Shape | Declaration |
| --- | --- | --- |
| `ElicitationCommandDetail` | `{ command: string; cwd: string; reason: string; warning? }` | `ElicitationCommandDetail` |
| `ElicitationRequest` | `{ id; execution_id; kind; prompt; schema?: JsonSchema; detail?: ElicitationCommandDetail }` | `ElicitationRequest` |
| `ElicitationResponse` | `{ id; action: "accept" \| "decline" \| "cancel"; content? }` | `ElicitationResponse` |

`ElicitationRequest.kind` includes `"ask_user"` (a free question), `"guard_confirm"` (a
command awaiting approval), `"plan_review"` (a proposed plan awaiting approval), `"workflow_review"`
(an installed workflow preflight) — plus a deliberately open `(string & {})` escape, "so a kernel may
add kinds without a protocol bump" (`ElicitationRequest.kind` in `packages/protocol/src/runs.ts`).
This is structurally the same open/closed pattern already noted for `capability_event` in §5
invariant 4, applied to elicitation instead of to the `RunEvent` union itself.
`ElicitationCommandDetail` exists so a client "render[s] this directly
(e.g. as highlighted code) and never parse[s] `prompt`, which stays the human-readable fallback"
(`ElicitationCommandDetail` in `packages/protocol/src/runs.ts`).

### 3.10 `ConfigService` data shapes I: settings and sandbox (`config.ts`)

| Type | Shape | File |
| --- | --- | --- |
| `WorkspaceTrustVerdict` | `{ state: "inert" \| "unapproved" \| "trusted" \| "changed"; fingerprint?; approved? }` | `packages/protocol/src/config.ts` |
| `SettingsData` | `{ default_model?; providers?: ProviderConfig[]; mcp_servers?: Record<string, McpServerConfig>; guard?: GuardConfig; sandbox?: SandboxConfig; runtime?: RuntimeConfig; memory?: MemoryConfig; budget?; [block: string]: unknown }` | `SettingsData` in `packages/protocol/src/config.ts` |
| `RuntimeConfig` | native, strict explicit Podman, or simple/advanced Docker including optional `recipe` | `RuntimeConfig`, `RuntimeRecipeConfig` in `packages/protocol/src/config.ts` |
| `ProviderConfig` | `{ name; kind?; base_url?; api_key_env?; [k]: unknown }` | `packages/protocol/src/config.ts` |
| `McpServerConfig` | `{ command?; args?; url?; [k]: unknown }` | `packages/protocol/src/config.ts` |
| `GuardConfig` | `{ mode?: "off" \| "on" \| "auto"; allowed_commands?; denied_commands?; [k]: unknown }` | `packages/protocol/src/config.ts` |
| `MemoryConfig` | `{ enabled?; model?; [k]: unknown }` | `packages/protocol/src/config.ts` |
| `SandboxConfig` | `{ type: "native"; enabled?; availability?: "required" \| "optional"; filesystem?; network?; pass_env?; toolchains?: { mode?: "auto" \| "manual"; include?; exclude?; extra_paths?; excluded_paths? } }` | `packages/protocol/src/config.ts` (`SandboxConfig`) |
| `SandboxToolchainScope` | `"system" \| "auto" \| "global" \| "workspace"` | `packages/protocol/src/config.ts` |
| `SandboxInspection` | `{ backend: { type: "bubblewrap" \| "seatbelt" \| "unsupported"; available; mode: "fresh-proc" \| "host-proc" \| "seatbelt" \| "unavailable"; degraded; reason? }; toolchains: SandboxToolchainStatus[]; extra_paths: SandboxPathStatus[]; effective_path: string[] }` | `packages/protocol/src/config.ts` (`SandboxInspection`) |

`RuntimeConfig` is the host-operator input, not a run grant. Omitting a container `network` selects
the kernel's ordinary routable `outbound` default; this may reach host and LAN peers as well as the
public internet. `RuntimeStatus.network` in `client.ts` is required for container placement because
it reports the effective value after the kernel has resolved defaults. Neither type calls
`outbound` internet-only, and the protocol exposes no host-port or engine-argument mutation method.
Docker's optional `RuntimeRecipeConfig` contains only `{name, script, network?}`: a safe diagnostic
name, an absolute path under the global operator recipe directory and `none`/`outbound` build
networking. It is persisted operator input;
the protocol exposes no operation that executes, edits, publishes or delegates a recipe to a guest.

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
declared it (`packages/protocol/src/config.ts`). This is the return shape behind `ConfigService.inspectSandbox`,
whose §2.3 table row names only the method signature.

### 3.11 `ConfigService` data shapes II: repair plan and agents (`config.ts`)

`SettingsRepairPlan` (`packages/protocol/src/config.ts`) is a 2-variant discriminated union on `action`, both variants
carrying `scope: Scope` and `revision: string` (the SHA-256 the repair is bound to, per §4 item 4):
`"strip"` additionally carries `dropped: string[]` — "dotted paths the kernel will remove from
otherwise parseable JSON" (`packages/protocol/src/config.ts`) — and `"reset"` carries `reason: string`, "why no safe
field-level repair could be produced" (`packages/protocol/src/config.ts`). The package's own test fixture exercises the
`strip` variant literally: `{ scope: "workspace", revision: "sha256", action: "strip", dropped:
["providers.invalid"] }` (`packages/protocol/tests/contract/public-contract.fixture.ts`).

`AgentBudget` (`packages/protocol/src/config.ts`) is `{ on_exceed?: string; total_token_limit?: number }`.
`AgentSummary` (`packages/protocol/src/config.ts`) is `{ name; scope: Scope | "plugin" | "builtin"; model?;
description?; plugin?; grants?: string[]; can_spawn?: string[]; budget?: AgentBudget; overlay?:
AgentOverlay }` — `grants` being `undefined` specifically means "the frontmatter
could not be parsed" (`packages/protocol/src/config.ts`).

`SettingsView.known_grants?: readonly string[]` (`packages/protocol/src/config.ts`) lists "every capability grant an
agent profile in this workspace may name" and is populated only by the kernel, "an optional feature
package contributes its own grant, so the set is a property of what this kernel actually composed"
(`packages/protocol/src/config.ts`). Its own remark names the defect that motivated it: a stale `image` grant "left
by the vision-routing refactor... was reported 'runnable' by Doctor and the agent editor while every
run in the workspace was rejected before its first model call" (`packages/protocol/src/config.ts`). Absent when the
kernel did not report it, in which case "a client must then skip the check rather than assume a
vocabulary" (`packages/protocol/src/config.ts`).

### 3.12 `MemoryService` health and job DTOs (`memory.ts`)

| Type | Shape | File |
| --- | --- | --- |
| `MemoryHealthFinding` | `{ code: string; severity: MemoryHealthSeverity; path: string; message: string; suggested_action: string }` | `packages/protocol/src/memory.ts` |
| `MemoryHealthSeverity` | `"error" \| "warning" \| "info"` | `packages/protocol/src/memory.ts` |
| `MemoryHealthReport` | `{ generated_at; totals: { documents; topics; memories; pending_jobs; failed_jobs }; counts: Record<MemoryHealthSeverity, number>; findings: MemoryHealthFinding[]; truncated: boolean; skipped_codes: string[] }` | `packages/protocol/src/memory.ts` |
| `MemoryJobState` | `"pending" \| "running" \| "retry_wait" \| "completed" \| "failed"` | `packages/protocol/src/memory.ts` |
| `MemoryJobError` | `{ phase: string; message: string; at: Timestamp }` | `packages/protocol/src/memory.ts` |
| `MemoryJob` | `{ run_id; state: MemoryJobState; attempts; enqueued_at; updated_at; next_attempt_at?; last_error?: MemoryJobError; note? }` | `packages/protocol/src/memory.ts` |

`MemoryJobState`'s own comment: `"retry_wait"` is "a failed attempt serving out its backoff" and
`"failed"` is "terminal until an operator retries, and the job is kept as the evidence that something
needs attention" (`packages/protocol/src/memory.ts`). `MemoryJobError.phase` names one of `generate`/`validate`/
`apply`/`reindex`/`commit` (`packages/protocol/src/memory.ts`).

### 3.13 `TasksService` DTO field lists (`tasks.ts`)

| Type | Shape | File |
| --- | --- | --- |
| `TaskStageDto` | 8-value union: `backlog` \| `ready` \| `active` \| `blocked` \| `review` \| `done` \| `cancelled` \| `other` | `packages/protocol/src/tasks.ts` |
| `TaskActorDto` | `{ id; label; kind: "human" \| "team" \| "agent" \| "service" \| "unknown" }` | `packages/protocol/src/tasks.ts` |
| `TaskClaimDto` | `{ claimant: TaskActorDto; execution_id: string; claimed_at: string }` | `packages/protocol/src/tasks.ts` |
| `TaskProviderCapabilitiesDto` | `{ protocol_version: 2; provider_instance_id; provider_kind; read: { containers; search; get; actors }; write: { create; assign; comment; attach_artifact; intents: TaskTransitionIntentDto[] }; concurrency: "none" \| "revision" \| "exclusive_claim" }` | `packages/protocol/src/tasks.ts` |
| `TaskProviderStatusDto` | `{ state: "not_configured" \| "ready" \| "unavailable" \| "incompatible"; provider_key?; provider_kind?; server?; writes: "disabled" \| "enabled"; reason? }` | `packages/protocol/src/tasks.ts` |

`TaskContainerPageDto` (`{ items: TaskContainerRefDto[]; next_cursor? }`, `packages/protocol/src/tasks.ts`) and
`TaskPageDto` (`{ items: TaskSummaryDto[]; next_cursor? }`, `packages/protocol/src/tasks.ts`) are each a bespoke
`items` + `next_cursor` shape — a third pagination idiom alongside the offset/limit `Page<T>` and the
generic `CursorPage<T>` (§3.1), and structurally distinct from `PlansService`'s own bespoke
`cursor`/`next_cursor` fields (`packages/protocol/src/plans.ts`) despite serving the same purpose.

### 3.14 `PluginService`, `SkillsService` and `ModelCatalogService` data shapes

`PluginContributions` (`packages/protocol/src/plugins.ts`): `{ agents: string[]; broken_agents: string[]; skills:
string[]; servers: string[]; hooks: number; capability_executables: PluginCapabilityExecutable[];
capability_run_policies?: { plans?: { skills: Record<string, "off" | "on" | "review"> } };
executables: string[] }` — `hooks` is "count of hook entries (not their names)" and `executables` are
"concrete commands this plugin would run... pre-formatted for display" (`packages/protocol/src/plugins.ts`).
`PluginView.display_name`/`short_description` (`packages/protocol/src/plugins.ts`) are documented as "display data
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

`ModelCost` (`packages/protocol/src/models.ts`): `{ input: number; output: number; cache_read?: number;
cache_write?: number }` — four price-per-token fields. `CatalogProvider.needs_base_url: boolean`
(`packages/protocol/src/models.ts`) is "`true` when this is an OpenAI-compatible endpoint with no `base_url` yet — the
UI must prompt for one" (`packages/protocol/src/models.ts`).

## 4. Behavior

`@clarvis/protocol` has no runtime behavior of its own — it is erased at compile time (§7). What
follows is the *contract* the code encodes as call/return shape, as stated in the doc comments
attached to each method:

1. A client obtains a `KernelClient` (construction is out of scope for this package — see
   `specs/hosts/kernel-transport.md`) whose `capabilities`, `principal`, `project`, `workspace` are
   populated "at connect time" (`packages/protocol/src/client.ts` doc comment on `capabilities`).
2. `runs.start(params)` returns a `RunHandle` immediately; the run's `events` stream, `done` and
   `closed` promises are the three ways a caller observes its outcome (`RunHandle` in
   `packages/protocol/src/runs.ts`).
3. While a run is live, a caller may call `steer`, `compact`, `cancel`, or `respond` to a pending
   elicitation on the same `RunHandle` — these are the only mutating operations scoped to one
   in-flight run; everything else in `KernelClient` is either a service-level CRUD call or a
   `subscribe`.
4. `ConfigService.updateSettings` and `repairSettings` both take an `expectedRevision`
   (`packages/protocol/src/config.ts`) — the doc comment on `updateSettings` states "a mismatch is a typed
   conflict and never overwrites the concurrent edit" (`packages/protocol/src/config.ts`), and `repairSettings`
   "throws a `conflict` kernel error when the file changed or disappeared after preview; no bytes are
   overwritten in that case" (`packages/protocol/src/config.ts`). This is optimistic concurrency control expressed
   purely through the method signature and its doc comment — no implementation of the check lives in
   this package.
5. `TasksService`'s `assign`, `transition`, `comment`, and `attachArtifact` DTOs each carry an optional
   `expected_revision` (for example `AssignTaskDto.expected_revision?`,
   `packages/protocol/src/tasks.ts`). `PlansService.setRetention` and `.delete` do not expose a
   revision argument (`packages/protocol/src/plans.ts`); the protocol therefore does not claim
   client-bound CAS for those two operations.
6. `TasksService.transition`'s own DTO comment states it is "human control-plane transitions" that
   "exclude `start`, which belongs to a bound run" (`packages/protocol/src/tasks.ts`) — i.e. the `TaskTransitionIntentDto`
   union has a `"start"` member (`packages/protocol/src/tasks.ts`) that `TransitionTaskDto.intent` deliberately cannot
   carry (`Exclude<TaskTransitionIntentDto, "start">`, `packages/protocol/src/tasks.ts`), forcing that transition to
   happen only through a run's own binding.
7. `PreviewTaskTransitionDto`/`TaskTransitionPreviewDto` (`packages/protocol/src/tasks.ts`) gate `complete`/`reopen`
   behind a `confirmation_token` that `TransitionTaskDto.confirmation_token` is documented as
   "required for complete/reopen and minted by previewTransition" (`packages/protocol/src/tasks.ts`) — the same
   preview-token pattern, applied to exactly two transition intents.

### State implied by `PlanTaskStatus` (`packages/protocol/src/plans.ts`)

| Status | Meaning | Closes the task? |
| --- | --- | --- |
| `pending` | not started | no |
| `in_progress` | working | no |
| `returned` | "a sub-agent's hand-back that still awaits the lead's judgment" | no — explicitly "not a closed state" (`packages/protocol/src/plans.ts`) |
| `done` | complete, carries `result` | yes |
| `abandoned` | complete, carries `reason` | yes |
| `failed` | complete, carries `error` | not stated as closing in this file's comment, but grouped with done/abandoned as requiring "a matching outcome field" (`packages/protocol/src/plans.ts`) |

### `PlanStatus` (`packages/protocol/src/plans.ts`)

`"awaiting_approval" | "active" | "completed" | "cancelled" | "failed"` — the doc comment states only
`completed`/`cancelled`/`failed` "may be deleted" (`packages/protocol/src/plans.ts`, matching
`PlansService.delete`'s own throw condition at `packages/protocol/src/plans.ts`).

## 5. Invariants

The following are derived directly from this package's own source and tests.

1. **The package's public surface is exhaustively type-only: every export is `interface`/`type`, and
   every sibling module is re-exported with `export type *`.**
   Production: `packages/protocol/src/index.ts` (18 `export type *` lines).
   Test/enforcement: `tooling/checks/coverage.ts`'s `findUnmeasuredSources` calls
   `looksExecutionFree` (`tooling/checks/coverage.ts`) on every module of a
   `TYPE_ONLY_PACKAGES` member (`tooling/checks/coverage.ts`, containing only `"protocol"`) and
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
   (`packages/code/tsconfig.json`, `packages/kernel/tsconfig.json`,
   `packages/server/tsconfig.json`), so their normal typechecks reject a future bare
   value-form import of an interface or alias. There is no separate architecture assertion that
   enumerates this property; compiler enforcement is the pin.

3. **`KernelClient` aggregates exactly 15 named services, not more or fewer.**
   Production: `packages/protocol/src/client.ts` — `runs`, `config`, `plugins`, `secrets`, `models`, `providerAuth`, `files`, `memory`,
   `plans`, `workflows`, `skills`, `sessions`, `tasks`, `storage`, `extensionProfiles` (15 fields, plus 4
   readonly identity fields and `close()`).
   Test: `packages/protocol/tests/contract/public-contract.fixture.ts` constructs a literal
   `satisfies KernelClient` naming every one of the 15 services plus `capabilities`/`project`/
   `workspace`/`close` — a fixture that would fail to typecheck (and thus fail `bun run test:contract`,
   which is literally `tsc -p tsconfig.json`, `packages/protocol/package.json`) if a service were
   missing or an extra one were required. The same fixture file separately compile-pins `RunHandle`,
   `RunService`, `SecretService` and `KernelTransport` in full via their own `satisfies` blocks
   (`packages/protocol/tests/contract/public-contract.fixture.ts`, §3.6) and `SettingsRepairPlan`/`CreateTaskDto` as single literals
   (`packages/protocol/tests/contract/public-contract.fixture.ts`) — five further interfaces get compile-time pinning beyond the
   `KernelClient` aggregate and the lone `RunEvent` variant this invariant and invariant 4 discuss.
   Also pinned from the consumer side: `KernelServices` in
   `packages/kernel/src/transport/operations.ts` is a `Pick<KernelClient...>` naming the same 15 service keys
   (minus the 4 identity fields, which are not "services").

4. **`RunEvent` is closed to exactly 39 named variants; an open/unknown capability event is carried
   through the single `capability_event` escape variant rather than by widening the union.**
   Production: `RunEvent` in `packages/protocol/src/runs.ts`; the `capability_event` variant's own
   doc comment says capability event names are deliberately open at the capability boundary while
   this discriminated union stays closed for clients, so an extension cannot make an exhaustive
   protocol switch crash at runtime. The numeric count is unpinned by this package's
   own tests (the fixture exercises one variant, `text_delta`,
   `packages/protocol/tests/contract/public-contract.fixture.ts`), but the kernel's exhaustive
   `RUN_EVENT_POLICY` makes a new discriminator fail typechecking until its source, durability,
   mapping and backpressure behavior are classified (`packages/kernel/src/runs/event-policy.ts`).

5. **A `TransitionTaskDto` can never carry the `"start"` transition intent.**
   Production: `TaskTransitionIntentDto` (`packages/protocol/src/tasks.ts`) includes `"start"`;
   `TransitionTaskDto.intent` is typed `Exclude<TaskTransitionIntentDto, "start">` (`packages/protocol/src/tasks.ts`).
   The type's own comment: "Human control-plane transitions exclude `start`, which belongs to a bound
   run" (`packages/protocol/src/tasks.ts`). This is a compiler-enforced invariant (assigning `"start"` to that field is
   a type error) with no runtime test in this package; **unpinned** at the `bun test` layer, enforced
   only by `tsc`.

6. **`PlansService.list`/`SessionService.listPage` use opaque-cursor paging; `RunService.list`/
   `WorkflowsService.list` use offset/limit paging — the two families are never interchanged.**
   Production: `packages/protocol/src/plans.ts` (`PlanListInput.cursor?`, `packages/protocol/src/plans.ts`), `packages/protocol/src/sessions.ts`
   (`CursorPagination`, `packages/protocol/src/common.ts`) versus `RunService.list` and
   `WorkflowsService.list` (both `Pagination`, `packages/protocol/src/common.ts`). No cited
   rationale beyond the type comment "for stores whose
   contents change over time" (`packages/protocol/src/common.ts`); unpinned by any test in this package.

7. **Compaction start is an explicit `RunEvent` rather than inferred from a later outcome.**
   `compaction_started` carries attribution plus `mode`, while `compaction` may carry only the
   bounded `fallback_reason` values `summarization_failed` or `summary_not_effective`.
   Production: `packages/protocol/src/runs.ts` (`RunEvent`). Test:
   `packages/kernel/tests/contract/transport-codecs.test.ts` ("preserves compaction lifecycle and
   fallback attribution") round-trips both strict wire shapes.

8. **`PlanProjection.revision` and `.spec_revision` are two independently-bumped counters, and a
   human approval binds only to the second.**
   Production: `packages/protocol/src/runs.ts` — "Monotonic counter bumped on every write (the CAS baseline)" vs.
   "Counter bumped only when the plan's substance changes; approval binds to it." Restated
   identically at `packages/protocol/src/plans.ts` and again on `PlanDocumentDto.approved_spec_revision`
   (`packages/protocol/src/plans.ts`, "The `spec_revision` a human approved"). Consistent across three independent
   declarations in two files; unpinned by a test in this package (the CAS mechanics are plan-package
   territory — see `specs/hosts/protocol.md` §8 delegation note and the sibling plan-capability document).

9. **Extension Profile selection and composition are preview-bound, while execution history carries only
   its minimal identity.** `ExtensionProfileService.select`, `.clearSelection`, and
   `.applyComposition` require `preview_token`; composition and definition updates require an exact
   expected revision, and `ExtensionProfileRunRef` contains only `id` and `fingerprint`.
   Production: `ExtensionProfileRunRef`, `ExtensionProfileCompositionInput`, and `ExtensionProfileService` in
   `packages/protocol/src/extension-profiles.ts`. Test:
   `packages/protocol/tests/contract/public-contract.fixture.ts` compile-pins the service on
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
| --- | --- | --- |
| Generic kernel-level failure | `KernelError` with one of 11 `KernelErrorCode` values | `packages/protocol/src/common.ts` |
| A settings write raced a concurrent edit | `conflict` | `packages/protocol/src/config.ts` (`updateSettings`) (`repairSettings`) |
| Memory not configured on this kernel | `capability_disabled` (implied by `KernelErrorCode`, applied per `packages/protocol/src/memory.ts`'s doc comment "the methods reject with a `capability_disabled` / memory-disabled `KernelError`") | `packages/protocol/src/memory.ts` |
| Deleting a plan that is still `active`/`awaiting_approval` | throws (unspecified which `KernelErrorCode`, but the method's own doc says "throws when the plan is still live") | `packages/protocol/src/plans.ts` |
| A run ended on a failure | `RunResult.error?: { code: string; message: string }`, "present only on a `failed` run" | `packages/protocol/src/runs.ts` |
| A workflow leader failed | `workflow_run_failed`'s `error?: { code; message }` | `RunEvent` in `packages/protocol/src/runs.ts` |
| A run was rebuilt from a damaged crash journal | `RunDetail.recovery?: RunRecovery` — `skipped_lines` and `synthesized_tool_calls` counts, "present ... only when something was actually lost or synthesized, so its absence means the record is intact" | `packages/protocol/src/runs.ts` |
| A settings scope file exists but fails to parse/validate | `SettingsSource.error?: string` — "the UI shows this instead of silently treating the scope as empty" | `packages/protocol/src/config.ts` |
| An Extension Profile selection or definition is invalid | `ResolvedExtensionProfile.status: "invalid"` plus typed `ExtensionProfileIssue[]`; no fallback is represented | `ExtensionProfileStatus`, `ExtensionProfileIssue`, and `ResolvedExtensionProfile` in `packages/protocol/src/extension-profiles.ts` |
| An Extension Profile reference is missing or a workspace executable surface is untrusted | `status: "degraded"` plus the exact `missing_plugin`, `missing_skill`, or `workspace_untrusted` issue | `ExtensionProfileIssueCode` in `packages/protocol/src/extension-profiles.ts` |
| An agent config file's frontmatter fails to parse | `AgentDoc.malformed?: string` — "the `frontmatter` above is then the lenient fallback (`{}`), not the file's real content" | `packages/protocol/src/config.ts` |
| An agent config file overlaying a shipped agent is unusable | `AgentOverlay.status: "rejected"` + `reason` — "the shipped default runs unchanged" | `packages/protocol/src/config.ts` |
| A repository's `settings.json` asked for fields it may not set on its own authority | `SettingsView.withheld_workspace_fields?: readonly string[]` | `packages/protocol/src/config.ts` |
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
  (`packages/protocol/src/runs.ts`) — a client is told *how much* was lost, never *what*.

## 7. Coupling

### 7.1 Depends on

Nothing. `packages/protocol/package.json` has no `dependencies`/`devDependencies`/
`optionalDependencies`/`peerDependencies` key at all (`packages/protocol/package.json`, read in
full — no such key appears). Its own `.ts` files import nothing from any other package; every
`import type` in the package points at a sibling module inside `packages/protocol/src/`
(`packages/protocol/src/{client,config,extension-profiles,memory,models,plugins,runs,sessions,skills,tasks,workflows}.ts`).
The remaining eight modules import nothing; `index.ts` only type-reexports siblings. There is no
cross-package source import in this package.

### 7.2 Depended on by

Every consumer reaches it **only as a type import**, verified directly (§5, invariant 2):

| Consumer | Value imports | Type imports | Forcing mechanism |
| --- | --- | --- | --- |
| `@clarvis/kernel` | 0 | 91 source/test files currently import the public barrel, all with `import type` | `packages/kernel/tsconfig.json` maps `@clarvis/protocol` to the package's own **source**, so `tsc` checks the implementation directly against these interfaces |
| `@clarvis/server` | 0 | 15 source/test files currently import the public barrel, all with `import type` | `packages/server/tests/architecture/dependency-boundary.test.ts` fixture-tests that the type import is an allowed boundary |
| `@clarvis/code` | 0 | 110 source/test files currently import the public barrel, all with `import type` | `packages/code/tests/architecture/dependency-boundary.test.ts` pins `code`'s Clarvis-namespaced manifest dependencies to `@clarvis/kernel`, `@clarvis/paths`, and `@clarvis/protocol` |

Both `code`'s and `server`'s dependency-boundary tests explicitly *permit* `@clarvis/protocol` (it is
absent from both files' `FORBIDDEN` arrays — `packages/code/tests/architecture/dependency-boundary.test.ts`,
`packages/server/tests/architecture/dependency-boundary.test.ts`) while forbidding `@clarvis/loop`
and every engine-layer package — i.e. the test suite encodes "may depend on protocol, may not depend
on the engine" as one design, not two.

### 7.3 What forces the type-only property, structurally

1. `verbatimModuleSyntax: true` in `packages/protocol/tsconfig.json` forces every re-export in
   `index.ts` to be spelled `export type *` rather than plain `export *` — a plain `export *` of an
   `interface`-only module would still compile under a looser setting, but under this one the
   compiler requires the `type` modifier once nothing in the module is a value.
2. `tooling/checks/coverage.ts`'s `TYPE_ONLY_PACKAGES` gate (§5, invariant 1) makes a *regression* —
   someone adding a real `export const` to any protocol module — fail the coverage step of
   `check:pre-commit`, independent of whether any test imports the new symbol.
3. `packages/kernel/tsconfig.json`'s `paths` mapping to **source** (not `dist`) means the kernel's
   own `tsc` run is the thing that would catch a signature mismatch between what `client.ts` promises
   and what `kernel.ts` actually implements — there is no build step in between that could paper over
   drift.

## 8. Open questions

- **Why two independent pagination families exist** (offset/limit vs. cursor) is stated as an
  intent ("stores whose contents change over time", `packages/protocol/src/common.ts`) but no test or runtime code in
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
  and its fixture constructs only `text_delta` (`packages/protocol/tests/contract/public-contract.fixture.ts`).
  Growth is nevertheless not silent inside the kernel: `RUN_EVENT_POLICY` exhaustively keys
  `RunEvent["type"]`, so a new value must first receive source, durability, mapping and backpressure
  classifications (`packages/kernel/src/runs/event-policy.ts`). Client exhaustiveness remains
  the responsibility of each consumer.
- **The one test file this package owns** (`tests/contract/public-contract.fixture.ts`) is exercised
  only via `tsc -p tsconfig.json` (`packages/protocol/package.json`) — there is no `bun test` runner invocation
  for `protocol` beyond that typecheck, and `test:coverage` is an alias for the same command
  (`packages/protocol/package.json`). This means "coverage" for this package, as reported by
  `tooling/checks/coverage.ts`, is entirely the `looksExecutionFree` static scan (§5, invariant 1),
  never an executed-line count — consistent with, but worth stating plainly: there is no runtime
  test of this package at all, by construction, because there is no runtime to test.
  **Recorded**: this is a design the gate enforces rather than an unguarded assumption —
  `looksExecutionFree` runs over every module of a `TYPE_ONLY_PACKAGES` member and fails on a runtime
  export *even when a stale report happens to mention that module*, which
  `tooling/tests/unit/coverage.test.ts` pins directly. The report-staleness warning added to
  `coverage.ts` deliberately exempts such a package: its `test:coverage`
  writes no LCOV, so whatever file exists can never be refreshed and the warning would be permanent
  noise.
