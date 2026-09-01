# The kernel wire: framing, methods, codecs, client and server

> Implemented at `packages/kernel/src/transport/**`. Every claim below is anchored to a file and
> line. Open questions are collected in the final section.

## 1. Purpose

`packages/kernel/src/transport/` is the RPC seam between a Clarvis *kernel* and a *client* of the
`KernelClient` contract. It is JSON-RPC-*shaped* but carries Clarvis's own method vocabulary rather
than MCP's (`packages/protocol/src/transport.ts:1-9`, `packages/kernel/src/transport/wire.ts:17-26`).
Seven modules divide the job: `wire.ts` names the methods and notification payloads, `operations.ts`
is the single table mapping every method onto a protocol service call, `server.ts` dispatches a
connection's requests and pumps a run's events out as notifications, `client.ts` builds a
`RemoteKernel` façade whose service methods are wire requests, `stdio.ts` frames all of it as
newline-delimited JSON over a stream pair, `loopback.ts` is the same seam with `JSON` round-tripping
instead of a pipe, and `run-event-codec.ts` re-validates every inbound run event against a closed
schema registry.

The design property the modules exist to hold is that a method string is spelled **once**. `M` in
`wire.ts` is not a literal table: every entry reads its value out of `OPERATIONS` or
`SPECIAL_OPERATIONS` (`packages/kernel/src/transport/wire.ts:27-60`), and both the client proxy
(`createServiceProxy`, `packages/kernel/src/transport/operations.ts:921-938`) and the server dispatch map (`packages/kernel/src/transport/server.ts:328`) are built
from that same catalog. A wire name therefore cannot drift between the two halves.

The second property is that both directions of the boundary are treated as untrusted. Inbound frames
go through a strict structural decoder that returns `null` rather than coercing
(`packages/kernel/src/transport/stdio.ts:126-162`); inbound run events go through per-discriminator `zod` schemas that are all
`.strict()` (`packages/kernel/src/transport/run-event-codec.ts:76-410`); inbound request parameter envelopes are checked against
the key set the operation's own encoder produces (`packages/kernel/src/transport/operations.ts:896-917`); and an error travelling
outbound is size-bounded, control-character-stripped and secret-redacted before it is serialized
(`packages/kernel/src/transport/stdio.ts:349-381`).

## 2. Surface

### 2.1 Exported from `@clarvis/kernel`

Re-exported by `packages/kernel/src/index.ts:58-87`:

| Symbol | Kind | Declared at | What it is |
| --- | --- | --- | --- |
| `createKernelServer(kernel, opts?)` | value | `packages/kernel/src/transport/server.ts:280` | Builds the server side over an `InProcessKernel` |
| `KernelServer`, `KernelConnection`, `KernelServerOptions`, `KernelAuthorizationContext`, `KernelConnectionContext`, `NotificationSender`, `TransportDisconnect` | types | `packages/kernel/src/transport/server.ts:202,183,214,232,244,31,50` | Server-side shapes |
| `connectKernelClient(transport, opts?)` | value | `packages/kernel/src/transport/client.ts:144` | Performs `hello`, returns a `RemoteKernel` |
| `RemoteKernel`, `ConnectKernelClientOptions` | types | `packages/kernel/src/transport/client.ts:55-74,76-93` | Client-side shapes |
| `createLoopbackTransport(server, logger?)` | value | `packages/kernel/src/transport/loopback.ts:22` | In-process transport |
| `createStdioTransport(io, logger?)` | value | `packages/kernel/src/transport/stdio.ts:405` | Client-side NDJSON transport |
| `serveKernelOverStdio(server, io, logger?)` | value | `packages/kernel/src/transport/stdio.ts:528` | Server-side NDJSON pump |
| `WIRE_METHODS` (`M`), `WIRE_NOTIFICATIONS` (`N`) | values | `packages/kernel/src/transport/wire.ts:27,70` | Named method / notification constants |
| `KERNEL_OPERATIONS` (`OPERATIONS`), `SPECIAL_OPERATIONS`, `KNOWN_METHODS` | values | `packages/kernel/src/transport/operations.ts:150,856,889-892` | The operation catalog |
| `KernelOperation`, `KernelOperationMetadata`, `KernelServices` | types | `packages/kernel/src/transport/operations.ts:51,43,23` | Catalog shapes |

Exported from their module but **not** re-exported by `src/index.ts`: `CLARVIS_WIRE_VERSION`
(`packages/kernel/src/transport/wire.ts:15`), `MAX_WIRE_FRAME_BYTES` and `decodeFrame` (`packages/kernel/src/transport/stdio.ts:42,126`), `ORDINARY_OPERATIONS`,
`decodeOperationParams`, `createServiceProxy` (`packages/kernel/src/transport/operations.ts:870,900-917,921-938`), `decodeRunEvent`
(`packages/kernel/src/transport/run-event-codec.ts:413`). The tests reach them by relative path
(`packages/kernel/tests/contract/stdio-codec.test.ts:5-10`, `packages/kernel/tests/contract/transport-codecs.test.ts:3-14`).

`RemoteKernel.listAgents()` (`packages/kernel/src/transport/client.ts:67-69`) is documented on the interface as "a convenience
alias for `config.listAgents`", but its implementation (`packages/kernel/src/transport/client.ts:562-563`) is a direct
`transport.request(M.listAgents, {})` — it bypasses the `config` service proxy entirely rather than
delegating to `config.listAgents()`.

### 2.2 The transport port

The transport the client programs against is declared in `@clarvis/protocol`, not here:

```ts
request<T>(method: string, params?: unknown, options?: KernelRequestOptions): Promise<T>
notify(method: string, params?: unknown): void
onNotification(method: string, handler: (params: unknown) => void): () => void
onClose?(handler: (reason?: unknown) => void): () => void
close(): Promise<void>
```
(`packages/protocol/src/transport.ts:29-68`.) `KernelRequestOptions` carries exactly one field,
`signal` (`packages/protocol/src/transport.ts:24-27`).

### 2.3 The operation catalog

`KernelOperation` (`packages/kernel/src/transport/operations.ts:49-64`) has five members: `method` (the sole declaration of the
wire name, `:49`), `metadata` (`:51`), `encode(...args)` producing the named parameter envelope
(`:53`), an optional `requestOptions(...args)` extracting transport-only metadata that must not be
serialized (`:55`), and `invoke(services, params, signal?)` calling the matching service method
(`:57-61`).

`KernelOperationMetadata` is `{ access: "read" | "write"; sensitivity?: "files" | "plugins" |
"secrets" | "provider_auth" | "tasks" }` (`KernelOperationMetadata` in
`packages/kernel/src/transport/operations.ts`), built by the `read()`/`write()` helpers
at `packages/kernel/src/transport/operations.ts:99-107`.

`serviceOperations<Service, Excluded>` (`packages/kernel/src/transport/operations.ts:87-97`) is the type-level completeness device:
`ServiceOperations` maps **every** async method key of the service (minus explicit exclusions) to an
operation whose argument tuple and result are inferred from the service method
(`packages/kernel/src/transport/operations.ts:66-84`). `runs` excludes `"start"` and `"compact"`;
`config.subscribe` is not an async method so it is excluded by the
`AsyncMethodKeys` filter itself (`packages/kernel/src/transport/operations.ts:66-70`). The two run
methods use the special streaming/control operation path.

**93 request methods exist**: 85 ordinary plus 8 special, flattened into `KNOWN_METHODS`.
Ordinary counts per service: runs 4, config 14, plugins 7, environments 13, secrets 3, models 4,
provider-auth 5, files 3, memory 4, plans 4, workflows 3, skills 2, sessions 5, tasks 12, storage 2. There is no
worktree service or worktree operation: checkout selection happens before kernel construction.
Production: `packages/kernel/src/transport/operations.ts` (`OPERATIONS`, `SPECIAL_OPERATIONS`,
`ORDINARY_OPERATIONS`, `KNOWN_METHODS`). Test:
`packages/kernel/tests/contract/transport-codecs.test.ts` (transport operation descriptors).

The 8 special operations and their metadata:

| Method | `access` | `sensitivity` |
| --- | --- | --- |
| `hello` | read | — |
| `runs.start` | write | — |
| `runs.steer` | write | — |
| `runs.compact` | write | — |
| `runs.cancel` | write | — |
| `runs.respond` | write | — |
| `config.subscribe` | read | — |
| `config.unsubscribe` | read | — |

`M` names 30 of the 93 (`packages/kernel/src/transport/wire.ts`); the rest are reached only through the service proxies. The
whole DTO vocabulary each method carries belongs to **protocol-kernel-contract**.

The 85 ordinary operations' individual `access`/`sensitivity` pairing is declared by
`OPERATIONS` in `packages/kernel/src/transport/operations.ts`.
Six service groups carry a `sensitivity` tag on every operation (`plugins`, `environments`,
`secrets`, `providerAuth`, `files`, `tasks`). Environments deliberately shares the `plugins`
sensitivity because selecting or editing one changes the active executable extension set. Models uses `provider_auth` only for its two entitled-catalog
operations; the other eight groups (`runs`, `config`, `memory`, `plans`, `workflows`, `skills`,
`sessions`, `storage`) never carry one:

| Service | Method | `access` | `sensitivity` |
| --- | --- | --- | --- |
| runs | `runs.get` | read | — |
| runs | `runs.context` | read | — |
| runs | `runs.list` | read | — |
| runs | `runs.delete` | write | — |
| config | `config.getSettings` | read | — |
| config | `config.previewSettingsRepair` | read | — |
| config | `config.repairSettings` | write | — |
| config | `config.updateSettings` | write | — |
| config | `config.inspectSandbox` | read | — |
| config | `config.approveWorkspace` | write | — |
| config | `config.revokeWorkspace` | write | — |
| config | `config.workspaceTrustError` | read | — |
| config | `config.listAgents` | read | — |
| config | `config.getAgent` | read | — |
| config | `config.writeAgent` | write | — |
| config | `config.deleteAgent` | write | — |
| config | `config.renameAgent` | write | — |
| config | `config.getContext` | read | — |
| plugins | `plugins.list` | read | `plugins` |
| plugins | `plugins.install` | write | `plugins` |
| plugins | `plugins.update` | write | `plugins` |
| plugins | `plugins.uninstall` | write | `plugins` |
| environments | `environments.list` | read | `plugins` |
| environments | `environments.current` | read | `plugins` |
| environments | `environments.get` | read | `plugins` |
| environments | `environments.inventory` | read | `plugins` |
| environments | `environments.preview` | read | `plugins` |
| environments | `environments.previewClear` | read | `plugins` |
| environments | `environments.previewComposition` | read | `plugins` |
| environments | `environments.select` | write | `plugins` |
| environments | `environments.clearSelection` | write | `plugins` |
| environments | `environments.applyComposition` | write | `plugins` |
| environments | `environments.create` | write | `plugins` |
| environments | `environments.update` | write | `plugins` |
| environments | `environments.delete` | write | `plugins` |
| environments | `environments.clone` | write | `plugins` |
| secrets | `secrets.listNames` | read | `secrets` |
| secrets | `secrets.set` | write | `secrets` |
| secrets | `secrets.delete` | write | `secrets` |
| models | `models.get` | read | — |
| models | `models.refresh` | write | — |
| models | `models.getEntitled` | read | `provider_auth` |
| models | `models.refreshEntitled` | write | `provider_auth` |
| providerAuth | `providerAuth.list` | read | `provider_auth` |
| providerAuth | `providerAuth.startDevice` | write | `provider_auth` |
| providerAuth | `providerAuth.wait` | read | `provider_auth` |
| providerAuth | `providerAuth.cancel` | write | `provider_auth` |
| providerAuth | `providerAuth.disconnect` | write | `provider_auth` |
| files | `files.listFiles` | read | `files` |
| files | `files.readFile` | read | `files` |
| files | `files.readImage` | read | `files` |
| memory | `memory.health` | read | — |
| memory | `memory.reindex` | write | — |
| memory | `memory.jobs` | read | — |
| memory | `memory.retryJob` | write | — |
| plans | `plans.list` | read | — |
| plans | `plans.read` | read | — |
| plans | `plans.setRetention` | write | — |
| plans | `plans.delete` | write | — |
| workflows | `workflows.get` | read | — |
| workflows | `workflows.delete` | write | — |
| skills | `skills.list` | read | — |
| skills | `skills.getPrompt` | read | — |
| sessions | `sessions.listPage` | read | — |
| sessions | `sessions.list` | read | — |
| sessions | `sessions.get` | read | — |
| sessions | `sessions.save` | write | — |
| sessions | `sessions.delete` | write | — |
| storage | `storage.inspect` | read | — |
| storage | `storage.cleanup` | write | — |
| tasks | `tasks.status` | read | `tasks` |
| tasks | `tasks.capabilities` | read | `tasks` |
| tasks | `tasks.listContainers` | read | `tasks` |
| tasks | `tasks.search` | read | `tasks` |
| tasks | `tasks.get` | read | `tasks` |
| tasks | `tasks.searchActors` | read | `tasks` |
| tasks | `tasks.create` | write | `tasks` |
| tasks | `tasks.assign` | write | `tasks` |
| tasks | `tasks.previewTransition` | read | `tasks` |
| tasks | `tasks.transition` | write | `tasks` |
| tasks | `tasks.comment` | write | `tasks` |
| tasks | `tasks.attachArtifact` | write | `tasks` |

### 2.4 Notifications

`N` (`packages/kernel/src/transport/wire.ts`) — five server→client pushes, none of which has a response frame:

| Constant | Wire name | Payload interface | Declared at |
| --- | --- | --- | --- |
| `runEvent` | `run.event` | `RunEventNote { execution_id, event }` | `packages/kernel/src/transport/wire.ts:115-119` |
| `runElicitation` | `run.elicitation` | `RunElicitationNote { request }` | `packages/kernel/src/transport/wire.ts:128-130` |
| `runResult` | `run.result` | `RunResultNote { execution_id, result }` | `packages/kernel/src/transport/wire.ts:139-142` |
| `runStreamEnd` | `run.stream_end` | `RunStreamEndNote { execution_id }` | `packages/kernel/src/transport/wire.ts:145-147` |
| `configChange` | `config.change` | `ConfigChangeNote { subscription_id, change }` | `packages/kernel/src/transport/wire.ts:153-156` |

`run.elicitation` carries no `execution_id` of its own — the run is identified by
`request.execution_id` (`packages/kernel/src/transport/wire.ts:121-127`, consumed at `packages/kernel/src/transport/client.ts:306`).

### 2.5 Server options

`KernelServerOptions` (`packages/kernel/src/transport/server.ts:214-229`):

| Field | Effect |
| --- | --- |
| `capabilities?: Partial<KernelCapabilities>` | Merged over `kernel.capabilities` and advertised in `hello` (`packages/kernel/src/transport/server.ts:288`) |
| `authorize?(ctx): boolean \| Promise<boolean>` | Consulted before every operation **except** `hello` (`packages/kernel/src/transport/server.ts:438-447`, `457-468`) |
| `resolveConnection?(params): KernelConnectionContext` | Host authentication / owner binding, run inside the `hello` case (`packages/kernel/src/transport/server.ts:498-506`) |
| `notificationTimeoutMs?: number` | Per-notification sink budget; defaults to 30 000 (`packages/kernel/src/transport/server.ts:33,284`) and must be positive and finite or the constructor throws `RangeError` (`packages/kernel/src/transport/server.ts:285-287`) |

`KernelConnectionContext` (`packages/kernel/src/transport/server.ts:244-257`) supplies `principal?`, `workspace`, `project`,
`services` ("Complete workspace-scoped service set; never borrowed from the primary kernel",
`packages/kernel/src/transport/server.ts:251`), `capabilities?` and `close?`.

### 2.6 Client connect options

`ConnectKernelClientOptions` (`packages/kernel/src/transport/client.ts:78-93`):

| Field | Effect |
| --- | --- |
| `clientInfo?: { name, version? }` | Echoed into `HelloParams.clientInfo` for the kernel's bookkeeping (`packages/kernel/src/transport/client.ts:80`) |
| `workspace?: string` | Workspace to bind to; the kernel decides how to resolve it (`packages/kernel/src/transport/client.ts:82`) |
| `auth?: string` | Opaque auth token, forwarded when the transport requires one (`packages/kernel/src/transport/client.ts:84`) |
| `logger?: Logger` | Where a **detached** wire operation's failure is reported — an unsubscribe, cancel or close that never lands. Its doc comment notes it replaced seven `process.emitWarning` call sites in this file (`packages/kernel/src/transport/client.ts:86-92`) |

## 3. Data and formats

### 3.1 Frame shapes

The wire is newline-delimited JSON. Four frame types (`packages/kernel/src/transport/stdio.ts:13-39`):

| `t` | Fields | Direction | Response? |
| --- | --- | --- | --- |
| `req` | `id: number`, `method: string`, `params?: unknown` | client→server | yes, a `res` with the same `id` |
| `res` | `id: number`, exactly one of `result` / `error` | server→client | — |
| `note` | `method: string`, `params?: unknown` | server→client | no |
| `cancel` | `id: number` | client→server | no |

`ErrorEnvelope` is `{ code: KernelErrorCode; message: string; details?: unknown }` (`packages/kernel/src/transport/stdio.ts:8-12`).

Real frames, from the reassembly test (`packages/kernel/tests/contract/stdio-codec.test.ts:40-42`):

```
{"t":"note","method":"probe.note","params":{"part":1}}
{"t":"res","id":1,"result":{"ok":true}}
{"t":"req","id":1,"method":"probe.slow"}
```

### 3.2 Structural validity

`decodeFrame` (`packages/kernel/src/transport/stdio.ts:126-162`) is total and returns `null` on anything it does not recognise:

- the value must be a non-array object with a string `t` (`:127`);
- `req` permits only the keys `t,id,method,params` — `hasOnly` rejects an extra field, while the
  optional `params` key may be absent (`:129`, helper at `:112-115`);
- an id must be a **safe positive integer** (`validId`, `:117-119`);
- a method must be a non-empty string of at most 256 characters (`validMethod`, `:121-123`);
- `cancel` admits only `t,id` (`:135-139`); `note` permits only `t,method,params`, with `params`
  optional (`:140-144`);
- `res` must carry exactly one of `result`/`error` — `hasResult === hasError` is a rejection
  (`:148-150`), tested for both the neither and the both case
  (`packages/kernel/tests/contract/stdio-codec.test.ts:53-54`);
- an error envelope must have only `code,message,details`, a `code` drawn from the eleven
  `KernelErrorCode` members, and a `message` string of at most 16 384 characters (`:152-160`).

`ERROR_CODE_MEMBERS` (`packages/kernel/src/transport/stdio.ts:49-61`) is pinned to the protocol union by
`satisfies Record<KernelErrorCode, true>`, so adding a code in
`packages/protocol/src/common.ts:87-98` without adding it here is a compile error.

### 3.3 Size and queue budgets

| Constant | Value | Declared at |
| --- | --- | --- |
| `MAX_WIRE_FRAME_BYTES` | 8 MiB | `packages/kernel/src/transport/stdio.ts:42` |
| `MAX_WRITER_QUEUE_FRAMES` | 1 024 | `packages/kernel/src/transport/stdio.ts:43` |
| `MAX_WRITER_QUEUE_BYTES` | 16 MiB | `packages/kernel/src/transport/stdio.ts:44` |
| `WRITER_TIMEOUT_MS` | 30 000 | `packages/kernel/src/transport/stdio.ts:45` |
| `MAX_ERROR_MESSAGE_CHARS` | 16 384 | `packages/kernel/src/transport/stdio.ts:46` |
| `MAX_ERROR_DETAILS_BYTES` | 64 KiB | `packages/kernel/src/transport/stdio.ts:47` |
| `MAX_CLASSIFICATION_VALUE_CHARS` | 1 024 | `packages/kernel/src/transport/stdio.ts:48` |
| `DEFAULT_NOTIFICATION_TIMEOUT_MS` | 30 000 | `packages/kernel/src/transport/server.ts:33` |
| `MAX_NOTIFICATION_QUEUE_FRAMES` | 1 024 | `packages/kernel/src/transport/server.ts:34` |
| `MAX_NOTIFICATION_QUEUE_BYTES` | 16 MiB | `packages/kernel/src/transport/server.ts:35` |
| client run-event buffer | 1 024 events / 8 MiB | `packages/kernel/src/runs/coalesce-events.ts:10,13`, used at `packages/kernel/src/transport/client.ts:389-394` |

### 3.4 Handshake payloads

`HelloParams` = `{ wire_version: 2; clientInfo?: { name, version? }; workspace?: string; auth?:
string }` (`packages/kernel/src/transport/wire.ts:85-94`). `CLARVIS_WIRE_VERSION = 2` (`packages/kernel/src/transport/wire.ts:15`).

`HelloResult` = `{ wire_version: 2; capabilities: KernelCapabilities; project: ProjectRef;
workspace: WorkspaceRef; principal?: Principal }` (`packages/kernel/src/transport/wire.ts:103-109`). A concrete instance appears in
`packages/kernel/tests/contract/transport-codecs.test.ts:16-33`.

### 3.5 Request ids

Client-side ids are a per-transport monotonic counter, `++seq` starting at 1 (`packages/kernel/src/transport/stdio.ts:409,470`).
They are transport-private: nothing above `stdio.ts` sees them, and the loopback has none at all.

Run identities are minted client-side before the start request is sent: `params.execution_id ??
randomUUID()` (`packages/kernel/src/transport/client.ts:381`). Config subscription ids are
`randomUUID()` per `subscribe` call (`packages/kernel/src/transport/client.ts:503-508`).

### 3.6 The run-event registry

`RUN_EVENT_SCHEMAS` (`packages/kernel/src/transport/run-event-codec.ts:76-427`) holds **38** entries, one per `RunEvent`
discriminator, closed by `satisfies Record<RunEvent["type"], z.ZodType>` (`:409`). Shared fragments:
`attributed` = `{ at, agent, subagent_id? }` (`:8-12`), `planProjection` (`:30-39`), `planTask`
(`:15-27`), `memoryIngestDetail` as a five-phase discriminated union (`:41-67`). Every object schema
is `.strict()`.

The complete discriminator list: `run_started`, `run_ended`, `iteration_started`,
`iteration_completed`, `tool_call_started`, `tool_call`, `tool_output_delta`, `tool_input_delta`,
`reasoning`, `text_delta`, `model_error`, `model_retry`, `delegation_created`, `delegation_started`,
`delegation_completed`, `delegation_failed`, `workflow_run_started`, `workflow_title_updated`,
`workflow_run_progress`, `workflow_run_completed`, `workflow_run_failed`, `plan_created`,
`plan_updated`, `plan_removed`, `plan_review_requested`, `plan_review_resolved`, `soft_limit_check`,
`compaction_started`, `compaction`, `vision_analysis`, `compaction_skipped`, `elicitation_requested`,
`elicitation_resolved`, `steering_applied`, `memory_ingest`, `capability_event`, `events_dropped`,
`mcp_degraded` (`packages/kernel/src/transport/run-event-codec.ts:77-409`). *Which* events exist and why belongs to
**kernel-run-service-and-events**.

## 4. Behavior

### 4.1 Connect and handshake (`connectKernelClient`)

In the order the function runs (`packages/kernel/src/transport/client.ts:144-409`):

1. Allocate per-connection state: `clientRuns`, `configSubs`, `notificationOffs`
   (`:148-153`).
2. Register `transport.onClose` **before** anything else, so a disconnect during the handshake is
   observed (`:202-207`). Its handler sets `closed`, settles every live run `unavailable`, clears the
   subscription maps and detaches the observers.
3. Register the five notification observers, each with its own validator (`:210-327`).
4. Build `HelloParams` and issue `M.hello` (`:361-369`).
5. On a throw: mark closed, clear subscriptions, detach observers, `await transport.close()` inside a
   `try/catch` whose comment reads "Teardown is secondary and no client was returned", then rethrow
   the **original** error (`:370-380`).
6. On a structurally invalid result: same teardown, then throw
   `` `kernel selected an invalid or unsupported Clarvis wire contract '${selected}'` `` (`:381-408`).
   The checks are `hasOnly` over the five permitted keys, `wire_version === 2`, `capabilities` /
   `project` / `workspace` objects, string `project.id`, `workspace.id`, `workspace.projectId`,
   `workspace.label`, a `workspace.kind` in `primary | external_worktree`, and a
   `principal` that, if present, is an object with a string `id`.
7. Build the thirteen ordinary service proxies, the subscribe-aware `config` wrapper, and the streaming `runs`
   (`:507-607`), and return the `RemoteKernel` carrying `hello.capabilities`, `hello.project`,
   `hello.workspace` and, when present, `hello.principal` (`:609-638`).

### 4.2 Server-side dispatch (`KernelConnection.handle`)

`packages/kernel/src/transport/server.ts:424-608`, in order:

| Step | Line | Effect |
| --- | --- | --- |
| `assertConnectionOpen()` | `:425` (helper `:314-316`) | Throws `unavailable` "kernel connection is closed" |
| Pre-hello gate | `:426-428` | Any method but `hello` before `helloCompleted` throws `unauthorized` |
| Ordinary lookup | `:429` | `ordinary` map built once at `:294` from `ORDINARY_OPERATIONS` |
| Envelope decode | `:431-437` | `decodeOperationParams`; `null` → `invalid_request` "has an invalid parameter envelope" |
| Authorize | `:438-445` | `opts.authorize({ method, metadata, principal?, workspace })` |
| Re-check open | `:446` | The authorize hop may have awaited across a `close()` |
| Deny | `:447` | `unauthorized` `operation '<m>' is not allowed` |
| Invoke | `:448-449` | `operation.invoke(services(), p, signal)`; an `undefined` result becomes `{}` |
| Special envelope | `:452` | `specialParams` — object required, keys from a per-method allowlist (`:330-341`) |
| Special authorize | `:454-468` | Same policy hop, skipped for `hello` (`:457`) |
| Switch | server special-operation switch | The eight special cases; `default` throws `invalid_request` `unknown method '<m>'` |

`services()` throws `unauthorized` "connection has not completed hello" when no context is bound
(`:318-323`), which is the second guard behind the pre-hello gate.

`specialParams`'s per-method allowed-key table (`packages/kernel/src/transport/server.ts:330-341`) in full:

| Method | Allowed keys |
| --- | --- |
| `hello` | `wire_version`, `clientInfo`, `workspace`, `auth` |
| `runsStart` | `params` |
| `runsSteer` | `execution_id`, `message` |
| `runsCompact` | `execution_id`, `request`, `options` |
| `runsCancel` | `execution_id` |
| `runsRespond` | `execution_id`, `response` |
| `configSubscribe` | `kinds`, `subscription_id` |
| `configUnsubscribe` | `subscription_id` |

A method not in this table (there is none among the eight special operations) would fall to an empty
allowed set, rejecting any key at all (`packages/kernel/src/transport/server.ts:342-344`).

`hello` (`:471-515`): one-shot (`helloStarted` → `invalid_request` "hello has already started on this
connection", `:472-478`); `wire_version !== 2` → `unsupported` (`:479-484`); malformed identity
fields → `invalid_request` "hello has invalid identity parameters" (`:485-497`); then
`resolveConnection` (or the default context built at `:289-293`); if the connection closed while
resolving, the resolved context's `close?.()` is called and `unavailable` is thrown (`:502-505`);
otherwise `context` is bound, `helloCompleted` set, and the result assembled with
`context.capabilities ?? capabilities` (`:506-514`).

### 4.3 Starting and pumping a run

`runs.start` on the server (`packages/kernel/src/transport/server.ts:517-533`): call `services().runs.start(p.params)`; if the
connection closed while awaiting, cancel the handle and throw `unavailable` (`:522-525`); otherwise
record `{ handle, resultSettled: false, streamSettled: false }` in `live`, call `pump(handle)`, and
answer `{ execution_id }`.

`pump` (`packages/kernel/src/transport/server.ts:349-413`) attaches four things to the handle:

1. `onElicit` → `N.runElicitation` with `{ request }` (`:363-368`).
2. An async loop over `handle.events` awaiting `notifications.notify(N.runEvent, …)` per event, whose
   `finally` marks `streamSettled`, releases the `live` entry if both halves settled, and sends
   `N.runStreamEnd` (`:369-385`).
3. `handle.done` → `N.runResult`. A rejected `done` is still sent as a result, synthesized as
   `status: "failed"` with `code: "internal"` and a `sanitizeErrorMessage`'d message
   (`:386-408`).
4. `handle.closed` → drop the `live` entry unconditionally (`:409-412`).

`liveOrThrow` (`packages/kernel/src/transport/server.ts`, `liveOrThrow`) governs
`runs.steer`, `runs.cancel`, and `runs.respond`: it treats a missing connection-local entry or one
whose result has settled as `not_found` `no live run '<id>'`. The integration test named "rejects
control requests for an execution not live on that connection" pins those three methods.

`runs.compact` deliberately follows a different route (`packages/kernel/src/transport/server.ts`,
the `M.runsCompact` case). It accepts `request?` plus
`options?: { mechanical_target_tokens?: number }`. While an entry remains in this connection's
`live` map, ordinary compaction is sent to `handle.compact` and returns `queued`; a mechanical target
is rejected because mechanical fitting requires a settled run. Once no connection-local entry
remains, the call delegates to the owner-bound `RunService.compact`, which can compact or
mechanically fit the persisted final context. That service returns `not_found` when no persisted run
exists; during the narrow terminal interval in which a `live` entry still exists but its compaction
channel has already closed, the handle itself can also report `not_found`. Production:
`packages/kernel/src/runs/run-service.ts`, `createRunService`'s `compact`. Test:
`packages/kernel/tests/integration/transport.test.ts`, "routes settled compaction through the
owner-bound run service"; the underlying persisted mechanical fit is also pinned by
`packages/kernel/tests/unit/run-service-lifecycle.test.ts`, "inspects and mechanically fits a
settled continuation before a model switch".

**A workflow (manager) run is started, steered, cancelled and responded to through this exact same
path.** There is no separate wire method for starting a workflow: the kernel routes a manager run
through `runs.start` by the entry profile's `workflow` grant, and it lands in the same `live` map, so
its steer/compact/cancel/respond dispatch through the same `runs.*` special-operation cases above
(`packages/kernel/src/transport/server.ts:300-308`, `:549-590`). The client side is symmetric: `streamingStart` (§4.4) is the same function a
workflow's start goes through, "since the kernel routes a manager run through `runs.start`"
(`packages/kernel/src/transport/client.ts:367-380`, `:485-496`). Only `workflows.get`/`workflows.list`/`workflows.delete` remain
workflow-specific operations (`packages/kernel/src/transport/operations.ts:634-658`) — everything else a workflow needs (event
streaming, elicitation, steer/compact/cancel/respond) is the run machinery this section and §4.4-4.5
document, unmodified.

### 4.4 Client-side run handle

`streamingStart` (`packages/kernel/src/transport/client.ts:377-470`):

1. `executionId = params.execution_id ?? randomUUID()` (`:424`).
2. A duplicate live id throws an `Error` carrying `code: "conflict"` **before** any request is sent
   (`:425-431`).
3. Build the bounded event stream (`:432-451`). Saturation and abandonment each fire a detached
   `runs.cancel` for this execution (`:439-450`).
4. Register the `ClientRun` in `clientRuns` *before* issuing `runs.start` (`:454-462`) — which is what
   lets a notification emitted during the start call find its run.
5. `await transport.request(methods.start, { params: { ...params, execution_id } })` (`:464`). On a
   throw, `done` resolves as a `failed` result carrying `kerr.code ?? "internal"` and `kerr.message ??
   "run failed"`, the stream closes, `closed` resolves and the entry is deleted (`:465-476`).
6. Return the handle whose `steer`/`compact`/`cancel`/`respond` each issue the matching wire request
   with `execution_id` attached (`:480-494`), and whose `onElicit` flushes `pendingElicits` on
   attachment (`:495-501`).

The service-level `RemoteKernel.runs.compact(executionId, request?, options?)` is a separate wrapper
around the same special method and forwards `options` when supplied
(`packages/kernel/src/transport/client.ts`, the `runs.compact` wrapper). A streaming
`RunHandle.compact(request?)` has no options parameter; mechanical fitting is therefore available
only through the service-level call for a settled run.

### 4.5 Notification demultiplexing (client)

| Notification | Validation | Routing |
| --- | --- | --- |
| `run.event` | `hasOnly(["execution_id","event"])`, string id, `decodeRunEvent(params.event) !== null` (`packages/kernel/src/transport/client.ts:223-236`) | `clientRuns.get(id)?.stream.push(event)` |
| `run.result` | `hasOnly(["execution_id","result"])`, `result.execution_id === execution_id`, status in `completed\|failed\|cancelled` (`:236-254`) | resolve `done`, set `resultReceived`, delete the entry if the stream already ended |
| `run.stream_end` | `hasOnly(["execution_id"])` (`:255-271`) | close the stream, resolve `closed`, delete the entry if the result already arrived |
| `run.elicitation` | `hasOnly(["request"])`; string `request.id`/`execution_id`/`kind`/`prompt`; when `detail` is present, `isCommandDetail` requires exactly `command`, `cwd`, `reason`, `warning?`, with the first three strings and `warning` absent or a string (`packages/kernel/src/transport/client.ts`, `isCommandDetail` and the `N.runElicitation` observer) | buffer into `pendingElicits` when no handler yet, else fan out |
| `config.change` | `hasOnly(["subscription_id","change"])`, change `hasOnly(["kind","scope","at"])`, kind in `settings\|agents\|context`, finite `at`, scope `global\|workspace` or absent (`:310-328`) | `configSubs.get(id)?.(change)` |

Every failure calls `protocolViolation(message)` (`:209-220`), which is fail-closed: mark closed,
settle every live run `unavailable` with the message `kernel wire protocol violation: <message>`,
clear subscriptions, detach observers, and close the transport through `detachObserved`.

### 4.6 Subscriptions

Client-side config subscriptions mint a UUID, register the
local listener **first**, fire the subscribe request detached, and return a disposer that is
idempotent (`disposed` flag), deletes the local listener immediately, then — detached — awaits the
original subscribe promise, returns silently if it rejected, returns if the client is closed, and
otherwise issues the unsubscribe. Production: `packages/kernel/src/transport/client.ts`
(`subscribeConfig`). Test: `packages/kernel/tests/integration/transport.test.ts` (immediate
unsubscribe after delayed authorization).

Server-side config subscriptions share one `subs` map keyed by id. A duplicate id is `conflict`;
unsubscribing an unknown id is a silent no-op. Production:
`packages/kernel/src/transport/server.ts` (config subscribe/unsubscribe cases). Test:
`packages/kernel/tests/integration/transport.test.ts`.

### 4.7 NDJSON reading

`readFrames` (`packages/kernel/src/transport/stdio.ts:171-222`) sets `utf8` encoding, accumulates into a string buffer, tracks
`bufferBytes`, and once `invalid` is latched ignores every later chunk (`:182`). Per chunk: if the
buffer exceeds the cap with no newline in it, drop as `oversize_unterminated` and terminate (`:185-190`).
Then per complete line: blank lines are skipped (`:196`), an over-cap line is `oversize` (`:197-202`),
a `JSON.parse` throw is `invalid_json` (`:203-211`), a `decodeFrame` `null` is `invalid_shape`
(`:212-218`), and only a decoded frame reaches `onFrame` (`:219`).

### 4.8 NDJSON writing

`createFrameWriter` (`packages/kernel/src/transport/stdio.ts:260-346`) serializes writes behind a `tail` promise and applies, in
order, on every `send`:

| Check | Line | Outcome |
| --- | --- | --- |
| writer closed | `:280` | reject with the shared `closedError` |
| a prior failure latched | `:281` | reject with that failure |
| `JSON.stringify` throws | `:282-291` | log `outbound/serialization`, latch, reject |
| line > 8 MiB | `:292-298` | log `outbound/oversize`, latch, reject |
| queue full (1 024 frames or 16 MiB) | `:299-304` | log `outbound/queue_full`, latch, reject |
| stalled write | `:318-323` | after 30 s reject `wire writer stalled for 30000ms` and latch |
| stream write error | `:324-330` | latch and reject |

`fail` invokes `onFailure` exactly once (`:272-276`). The queued write re-checks `closed` and
`failure` **inside** the promise (`:310-317`), which is why a frame queued before `close()` is never
written. The `tail` swallows both outcomes (`:333-336`) so a later queued send still makes progress.

### 4.9 Server pump over stdio

`serveKernelOverStdio` (`packages/kernel/src/transport/stdio.ts`, `serveKernelOverStdio`). `close()` aborts every tracked controller with
`new Error("transport closed")`, clears the map, closes the writer and closes the connection
(`:536-543`). `disconnect()` additionally destroys **both** streams, with the in-source note that
"Normal `close()` leaves caller-owned streams alone. A failed wire cannot: closing both sides is what
makes the peer's `onClose` settle live handles" (`:544-550`). Per inbound frame (`:558-579`):

| Frame | Effect |
| --- | --- |
| anything, after `closed` | ignored (`:559`) |
| `cancel` | `controllers.get(id)?.abort(new Error("request cancelled"))` (`:560-563`) |
| not `req` | ignored — including `note` (`:564`) |
| `req` with an id already in flight | `close()` and return, **without dispatching** (`:565-568`) |
| `req` | new `AbortController`, dispatch `conn.handle(method, params, signal)`, answer `res` with `result` or `toEnvelope(err)`, `.catch(close)`, `finally` delete the controller (`:569-578`) |

### 4.10 Client transport state machine

`terminate` (`packages/kernel/src/transport/stdio.ts:418-433`) is idempotent (`closed` guard) and, once: builds an `unavailable`
error from the reason, rejects every pending request after detaching its abort listener, clears the
map, closes the writer and fans out to every `onClose` handler before clearing that set. It is wired
to `readFrames`'s invalid callback (`packages/kernel/src/transport/stdio.ts:451`) and to `input.end`, `input.error`,
`input.close` and `output.error` (`packages/kernel/src/transport/stdio.ts:454-457`).

| State | Event | Next | Effect |
| --- | --- | --- | --- |
| open | `request(m,p)` | open | `++seq`, register pending, `writer.send({t:"req",…})`; a send rejection calls `terminate` (`:471-490`) |
| open | `request` with an already-aborted signal | open | reject `cancelled` "request cancelled" immediately, no frame (`:468-470`) |
| open | signal aborts | open | delete the pending entry, send `{t:"cancel",id}`, reject `cancelled` (`:474-481`) |
| open | `res` with a known id | open | resolve `result`, or reject `fromEnvelope(error)` (`:440-446`) |
| open | `res` with an unknown id | open | silently ignored (`:442`) |
| open | `note` | open | fan out to that method's handlers (`:447-449`) |
| open | any invalid frame / EOF / stream error | closed | `terminate`: all pending reject `unavailable` |
| closed | `request` | closed | reject `unavailable` "transport closed" (`:465-467`) |
| closed | `notify` | closed | no-op (`:493`) |
| closed | `close()` | closed | idempotent (`:510-512`) |

### 4.11 Notification channel (server)

`createNotificationChannel` (`packages/kernel/src/transport/server.ts:58-177`) is a serialized, bounded queue with three states
`open | failed | closed` (`:65`). `notify` (`:145-172`) returns a resolved promise when not open,
measures the frame with `JSON.stringify({method, params})` and fails the channel if that throws
(`:147-153`), fails it if the frame alone exceeds 16 MiB or the queue is at 1 024 frames / 16 MiB
(`:154-161`), otherwise enqueues and starts the drain if idle. `drain` (`:88-142`) races the sink's
delivery against a `timeoutMs` timer and an interrupt, and any outcome other than `delivered` other
than `interrupted` calls `stop("failed", reason)` (`:134-137`). `stop` (`:76-86`) fires every
interrupt, drains and resolves every queued notification, and on `failed` calls `onFailure` — which
is `failConnection` (`:299-301`), which closes the connection and then calls the transport's
`disconnect` inside a `try/catch` whose comment reads "A broken transport close cannot keep the
kernel connection alive" (`:623-630`).

`packages/kernel/tests/integration/transport.test.ts:567-631` pins that both a *rejecting* and a *stalling* sink
disconnect once, close the host context once, and are called exactly once — the circuit opens
permanently rather than retaining one pending delivery per event.
`packages/kernel/tests/integration/transport.test.ts:656-722` pins that `connection.close()` releases a run's event
stream without waiting on an infinite send.

### 4.12 Connection teardown

`KernelConnection.close` (`packages/kernel/src/transport/server.ts:609-621`) is idempotent and, in order: close the notification
channel, `off()` every subscription and clear the map, `cancel()` every live handle and clear `live`,
call `context?.close?.()` (releasing the host lease), then release the lifecycle registration. The
connection registers itself with `kernel.lifecycle` at connect time (`packages/kernel/src/transport/server.ts:631`), so closing the
kernel closes every open connection.

### 4.13 Loopback

`createLoopbackTransport` (`packages/kernel/src/transport/loopback.ts:22-81`) opens exactly one `server.connect` for its lifetime
(`:39-42`) and deep-clones every payload crossing the seam with `JSON.parse(JSON.stringify(v))`,
guarding `undefined` (`:26-27`). `request` clones params in and result out (`:45-56`); `notify`
dispatches into `conn.handle` detached and discards the result (`:57-62`); `close` is idempotent and
fans out to `onClose` (`:32-38`, `:77-79`).

## 5. Invariants

INV-205–INV-224 are the numbered invariants this document owns; INV-T* are derived here.

**INV-205.** `decodeFrame` fail-closes: `null` for a non-object or primitive, for a `req` with an
extra field, and for a `res` carrying neither or both of `result`/`error`; a request pending when
such a frame — or one past `MAX_WIRE_FRAME_BYTES` — arrives rejects `unavailable`.
Production: `packages/kernel/src/transport/stdio.ts:126-162`, `packages/kernel/src/transport/stdio.ts:185-218`, `packages/kernel/src/transport/stdio.ts:418-433`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts:49-65`.

**INV-206.** A server-thrown error crosses the wire with its `code`, `message` and `details` intact,
domain codes such as `resource_exhausted` included.
Production: `toEnvelope` `packages/kernel/src/transport/stdio.ts:372-381`, `fromEnvelope` `packages/kernel/src/transport/stdio.ts:384-389`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts:67-91`, `:93-117`.

**INV-207.** An untrusted server error is normalized before crossing: ANSI escapes and terminal
control bytes stripped, the message bounded to 16 384 characters, a credential-shaped detail key
(e.g. `authorization`) redacted to `"Bearer [redacted]"`, and a code the server did not construct
through `kernelError` collapsed to `internal`.
Production: `terminalSafe` `packages/kernel/src/transport/stdio.ts:64-71`, `safeErrorDetails` `packages/kernel/src/transport/stdio.ts:349-369`, `toEnvelope`
`packages/kernel/src/transport/stdio.ts:377-378`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts:119-152`. The underlying two rule sets
(`sanitizeDeep`/`sanitizeErrorMessage`) belong to
[cross-cutting/security.md](../cross-cutting/security.md) §5; this invariant is the wire's own
application of them.

**INV-208.** When oversized `details` must be truncated, the reconciliation flags survive:
`outcome_unknown` (boolean) plus the string keys `task_code`, `memory_code`,
`current_revision`, `expectedRevision`, `actualRevision`, each `terminalSafe`'d and sliced to 1 024
characters, and a `truncated: true` marker is added.
Production: `PRESERVED_ERROR_STRING_DETAILS` `packages/kernel/src/transport/stdio.ts:73-80`, `preservedErrorDetails`
`packages/kernel/src/transport/stdio.ts:83-106`, `packages/kernel/src/transport/stdio.ts:359-364`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts:154-188`.

**INV-209.** A request queued before `close()` is never written to the output stream.
Production: `packages/kernel/src/transport/stdio.ts:310-317` (the in-promise `closed` re-check) and `terminate`'s `writer.close()`
at `packages/kernel/src/transport/stdio.ts:430`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts:190-206`.

**INV-210.** A frame that cannot be JSON-serialized fails its request cleanly with `unavailable`
rather than crashing the transport.
Production: `packages/kernel/src/transport/stdio.ts:282-291` (reject) → `packages/kernel/src/transport/stdio.ts:489` `.catch(terminate)` → `packages/kernel/src/transport/stdio.ts:421-424`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts:208-219`.

**INV-211.** Every request still pending at input EOF is rejected `unavailable`.
Production: `packages/kernel/src/transport/stdio.ts:454` (`input.once("end", …)`) → `packages/kernel/src/transport/stdio.ts:425-428`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts:221-230`.

**INV-212.** Cancelling one in-flight request rejects only that request with `cancelled`, propagates
the abort to the server handler's own signal, and does not close the connection.
Production: client `onAbort` `packages/kernel/src/transport/stdio.ts:474-481`; server `cancel` handling `packages/kernel/src/transport/stdio.ts:560-563`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts:232-266`.

**INV-213.** A duplicate in-flight request id is fatal to the server connection: the handler is
invoked once, the first call's signal is aborted, and the connection closes.
Production: `packages/kernel/src/transport/stdio.ts:565-568` combined with `close()`'s controller abort at `packages/kernel/src/transport/stdio.ts:539`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts:268-297`.

**INV-214.** `transport.frame_dropped` names the specific bound: inbound
`oversize_unterminated` / `oversize` / `invalid_json` / `invalid_shape`, outbound `oversize` and
`queue_full`.
Production: `reportFrameDropped` `packages/kernel/src/transport/stdio.ts:237-247`; call sites `packages/kernel/src/transport/stdio.ts:187,199,208,215,288,295,301`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts:313-370`. The sixth reason, `serialization`
(`packages/kernel/src/transport/stdio.ts:288`), is **not** asserted by any `frame_dropped` test.

`reportFrameDropped`'s own TSDoc is explicit that this detail never crosses the wire: "Every one of
these also terminates the connection, so the peer sees *something*. What it never sees is which of
five bounds was hit, and on the outbound side neither does the caller — a saturated writer rejects
one `send` with a sentence nobody reads" (`packages/kernel/src/transport/stdio.ts:232-236`). The `reason` field is local-only,
recorded in this process's own log.

**INV-215.** The client handshake rejects a `hello` result with the wrong `wire_version`, an
unexpected extra field, or an invalid nested `workspace.kind`, and closes the transport exactly once
in every case.
Production: `packages/kernel/src/transport/client.ts:382-409`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts:98-112`.

**INV-216.** When the handshake itself rejects, the transport is still closed exactly once and every
notification observer is detached.
Production: `packages/kernel/src/transport/client.ts:371-381` with `detachTransportObservers` `packages/kernel/src/transport/client.ts:190-194`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts:114-125`.

**INV-217.** `KNOWN_METHODS` holds no duplicate, and every ordinary operation's `invoke` genuinely
reaches the matching service method in catalog order.
Production: `packages/kernel/src/transport/operations.ts:149-853`, each operation's `invoke`, and
`ORDINARY_OPERATIONS`/`KNOWN_METHODS` at `:869-892`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts:129-145` (each fake service method throws
`RECORDED_OPERATION`, `packages/kernel/tests/helpers/recording-kernel-services.ts:5,16-19`).

**INV-218.** A transport-level cancellation signal reaches the signal-aware service call for
`sessions.listPage` and `workflows.list` unchanged — via a locally-cast widened method signature that
never appears on the public wire `SessionService` contract.
Production: `listSessionPage` `packages/kernel/src/transport/operations.ts:121-132`, `listWorkflows` `packages/kernel/src/transport/operations.ts:134-147`,
wired at `packages/kernel/src/transport/operations.ts:677-688` and `:641-650`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts:185-211` (session and workflow catalog
cases); `packages/kernel/tests/integration/session-service.test.ts:168-183` corroborates from the
service side — the session service itself honors an aborted signal mid-scan, not merely relays it.

**INV-219.** A remote run's `done` settles independently of `events`/`closed`: events keep arriving
until `run.stream_end`, at which point `closed` resolves; a `runs.start` rejection settles `done` as
`failed` carrying the transport's own error code, with `closed` resolved and `events` empty.
Production: `packages/kernel/src/transport/client.ts:237-272` and `packages/kernel/src/transport/client.ts:466-477`; server side `packages/kernel/src/transport/server.ts:369-408`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts:215-244`, `:246-271`.

**INV-220.** Starting a run whose execution id is already live is rejected `conflict` and does not
replace the first handle.
Production: `packages/kernel/src/transport/client.ts:426-432`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts:273-289`.

**INV-221.** `steer`/`compact`/`cancel`/`respond` each forward with the handle's own `execution_id`
under the stable names `runs.steer`, `runs.compact`, `runs.cancel`, `runs.respond`.
Production: `packages/kernel/src/transport/client.ts:481-495`, names bound at `packages/kernel/src/transport/client.ts:513-519`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts:291-332`.

**INV-222.** An elicitation emitted before `runs.start` resolves is buffered and delivered to a
handler registered afterwards.
Production: registration of the `ClientRun` before the start request (`packages/kernel/src/transport/client.ts:455-465`), the
buffer at `packages/kernel/src/transport/client.ts:308`, the flush at `packages/kernel/src/transport/client.ts:500-501`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts:334-360`.

**INV-223.** On transport disconnect every live run handle settles `failed` with an `unavailable`
error carrying the disconnect reason.
Production: `settleRunsUnavailable` `packages/kernel/src/transport/client.ts:171-188`, wired at `packages/kernel/src/transport/client.ts:203-208`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts:362-374`.

**INV-224.** A malformed run-event notification fails the run's `done` as `unavailable` with a
"protocol violation" message and closes the transport — for a bad field type, an incomplete
required-field set, and an inherited object key (`toString`, `constructor`, `__proto__`) used as the
discriminator.
Production: `decodeRunEvent` `packages/kernel/src/transport/run-event-codec.ts:413-423` (the `Object.hasOwn` guard at `:418` is
what rejects inherited keys), `protocolViolation` `packages/kernel/src/transport/client.ts:210-221`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts:376-442`.

**INV-T1.** A wire method name is declared exactly once, in `KernelOperation.method`; `M` reads its
values from the catalog rather than restating them.
Production: `packages/kernel/src/transport/wire.ts:27-60` (every value is an `OPERATIONS.*.method` or `SPECIAL_OPERATIONS.*.method`),
`packages/kernel/src/transport/operations.ts:50-51`. Pinned indirectly by the uniqueness assertion at
`packages/kernel/tests/contract/transport-codecs.test.ts:130`; no test asserts that `M` cannot contain a literal.

**INV-T2.** The `res` error envelope's `code` set is pinned to the protocol union at compile time.
Production: `packages/kernel/src/transport/stdio.ts:49-61` (`satisfies Record<KernelErrorCode, true>`) against
`packages/protocol/src/common.ts:87-98`. Compile-time only; unpinned by a test.

**INV-T3.** `RUN_EVENT_SCHEMAS` must carry an entry for every `RunEvent` discriminator.
Production: `packages/kernel/src/transport/run-event-codec.ts:410` (`satisfies Record<RunEvent["type"], z.ZodType>`). Compile-time
only — it constrains the **keys**, not the payload shape (see §8).

**INV-T4.** A request parameter envelope may carry no key the operation's own encoder does not
produce; the allowed key set is derived once per operation by invoking `encode` with `undefined`
placeholders and memoized in a `WeakMap`.
Production: `decodeOperationParams` `packages/kernel/src/transport/operations.ts:896-917`, enforced at `packages/kernel/src/transport/server.ts:461-480`.
Test: `packages/kernel/tests/integration/transport.test.ts:433-447` (`listAgents` with `{ unexpected: true }` →
`invalid_request`).

**INV-T5.** A special operation's parameters are checked against a per-method allowlist and must be a
non-array object.
Production: `specialParams` `packages/kernel/src/transport/server.ts:359-379`.
Test: `packages/kernel/tests/integration/transport.test.ts:469-474` (a string body and an extra key on `runs.cancel`
both `invalid_request`).

**INV-T6.** No ordinary or special operation is served before `hello` completes.
Production: `packages/kernel/src/transport/server.ts:426-428`, backed by `services()` `packages/kernel/src/transport/server.ts:318-323`.
Test: `packages/kernel/tests/integration/transport.test.ts:435-447`.

**INV-T7.** `hello` binds a connection exactly once; a second `hello` is `invalid_request` and does
not re-run `resolveConnection`.
Production: `helloStarted` `packages/kernel/src/transport/server.ts:472-478`.
Test: `packages/kernel/tests/integration/transport.test.ts:401-433` (asserts `resolutions === 1`).

**INV-T8.** A `hello` whose `wire_version` is missing or not `2` is `unsupported`.
Production: `packages/kernel/src/transport/server.ts:479-484`.
Test: `packages/kernel/tests/integration/transport.test.ts:449-459`.

**INV-T9.** `hello` identity fields are validated before `resolveConnection` runs.
Production: `packages/kernel/src/transport/server.ts:485-497` precedes `:498-501`.
Test: `packages/kernel/tests/integration/transport.test.ts:485-495`.

**INV-T10.** Owner services come only from the host-resolved `hello` context, never from a
caller-supplied workspace parameter.
Production: `packages/kernel/src/transport/server.ts:302-303,318-323,506`; `KernelConnectionContext.services` documented as "never
borrowed from the primary kernel" (`packages/kernel/src/transport/server.ts:251`).
Test: `packages/kernel/tests/integration/transport.test.ts:349-399` — a session saved through the wire is readable
under the *authenticated* owner and `null` under the caller-requested one.

**INV-T11.** `opts.authorize` sees the catalog's `metadata`, is not consulted for `hello`, and an
unknown method is `invalid_request` rather than a policy question.
Production: `packages/kernel/src/transport/server.ts:438-447`, `packages/kernel/src/transport/server.ts:457-468` (the `special !== SPECIAL_OPERATIONS.hello`
guard), `packages/kernel/src/transport/server.ts:605-606`.
Test: `packages/kernel/tests/integration/transport.test.ts:497-517`.

**INV-T12.** A config subscription whose authorization completes after the connection closed is
never installed, and an authorization hop cannot resurrect a closed connection.
Production: the post-await `assertConnectionOpen()` at `packages/kernel/src/transport/server.ts:446` and `:466`.
Test: `packages/kernel/tests/integration/transport.test.ts` (asserts no subscription was installed).

**INV-T13.** Config subscription ids are unique per connection: a duplicate is `conflict`, and an
unknown unsubscribe is an idempotent no-op.
Production: `packages/kernel/src/transport/server.ts` (config subscription map).
Test: `packages/kernel/tests/integration/transport.test.ts`.

**INV-T14.** `runs.steer`, `runs.cancel`, and `runs.respond` are connection-live-only and return
`not_found` when their execution is absent or result-settled on that connection. `runs.compact` is
hybrid: it targets a connection-local handle while one remains, rejects mechanical fitting there,
and otherwise delegates to the owner-bound `RunService.compact` so a settled persisted run can be
compacted. A fully settled compact target that is absent from owner persistence is `not_found`; a
terminal live handle whose compaction channel has already closed may report the same code before its
connection entry is released.
Production: `packages/kernel/src/transport/server.ts`, `liveOrThrow` and the `M.runsCompact` case;
`packages/kernel/src/runs/run-service.ts`, `createRunService`'s `compact`.
Test: `packages/kernel/tests/integration/transport.test.ts`, "rejects control requests for an
execution not live on that connection" and "routes settled compaction through the owner-bound run
service"; `packages/kernel/tests/unit/run-service-lifecycle.test.ts`, "inspects and mechanically fits
a settled continuation before a model switch".

**INV-T15.** A failing notification sink opens the circuit permanently and disconnects exactly once;
a client's live handles then settle `unavailable`.
Production: `createNotificationChannel` `packages/kernel/src/transport/server.ts:76-86,134-137`, `failConnection` `packages/kernel/src/transport/server.ts:623-630`.
Test: `packages/kernel/tests/integration/transport.test.ts:567-631`, `:633-654`.

**INV-T16.** `connection.close()` does not wait on an in-flight notification send; the run's event
stream is released and the handle cancelled.
Production: `stop`'s interrupt fan-out `packages/kernel/src/transport/server.ts:79-80`, `close` `packages/kernel/src/transport/server.ts:609-621`.
Test: `packages/kernel/tests/integration/transport.test.ts:656-722`.

**INV-T17.** The loopback transport deep-clones every payload in both directions, so neither side can
retain a mutable reference into the other's state.
Production: `packages/kernel/src/transport/loopback.ts:26-27,40,50-55,58`.
Test: `packages/kernel/tests/unit/loopback-transport.test.ts:5-37` (mutating the caller's object after `notify`
leaves the observed params at the pre-mutation value).

**INV-T18.** `transport/` must not import file-backed composition (`/adapters/`, `file-kernel`).
Production: the absence of such imports in `transport/*.ts`.
Test: `packages/kernel/tests/architecture/dependency-direction.test.ts:40-45`.

**INV-T19.** An ordinary operation whose service returns `undefined` answers `{}` on the wire.
Production: `packages/kernel/src/transport/server.ts:449`. Unpinned by a direct assertion.

**INV-T20.** `serveFileKernelOverStdio` refuses at construction a logger writing to the same file
descriptor as the NDJSON wire.
Production: `refuseLoggerOnWire` `packages/kernel/src/serve.ts:81-90`, called first at `packages/kernel/src/serve.ts:103`.
Test: `packages/kernel/tests/integration/serve.test.ts:34` — `describe("serveFileKernelOverStdio refuses a logger
bound to its own wire", …)`. The composition around it belongs to the kernel-bootstrap document.

**INV-T21.** A Tasks operation's client-supplied `AbortSignal` is extracted by the operation's own
`requestOptions`, not by widening the parameter envelope: `taskRequestOptions` turns a caller's
`{ signal }` into the transport `request`'s third argument (`packages/kernel/src/transport/operations.ts:109-115`), wired on every
one of the twelve Tasks operations (`packages/kernel/src/transport/operations.ts:720,727,734,745,756,764,775,786,797,808,819,830`).
This is distinct from INV-218's mechanism, under which `sessions.listPage`/`workflows.list` thread a
signal into `invoke` server-side with no client-side `requestOptions` involved at all. Opaque
cursor/id fields inside a Tasks operation's `input` (e.g. `next_cursor`) pass through the wire
unmodified.
Production: `taskRequestOptions` `packages/kernel/src/transport/operations.ts:109-115`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts:445-483` — `tasks.create`'s `request_id`/
`provider_key` round-trip byte-for-byte, and `tasks.search` both preserves an opaque `next_cursor`
and forwards a caller's `AbortSignal` as `options: { signal }` on the wire request.

**INV-T22.** Every Environment service method is an ordinary operation and is classified with
`sensitivity: "plugins"`; observation methods are reads, while selection and definition mutations
are writes. This lets a remote host apply the same executable-extension authorization boundary to
plugins and Environments without inspecting payloads. Production:
`packages/kernel/src/transport/operations.ts` (`OPERATIONS.environments`). Test:
`packages/kernel/tests/contract/transport-codecs.test.ts` ("classifies every Environment operation
as plugin-sensitive with exact read/write access").

## 6. Failure modes and degradation

### 6.1 Error codes emitted by this subsystem

| Code | Raised at | Situation |
| --- | --- | --- |
| `unavailable` | `packages/kernel/src/transport/server.ts:315` | any dispatch on a closed connection |
| `unavailable` | `packages/kernel/src/transport/server.ts:504`, `:524` | connection closed while `hello` / `runs.start` was awaiting |
| `unavailable` | `packages/kernel/src/transport/stdio.ts:421-424`, `:466` | transport terminated, or a request after close |
| `unavailable` | `packages/kernel/src/transport/client.ts:178` | a live run settled by disconnect or protocol violation |
| `unauthorized` | `packages/kernel/src/transport/server.ts:320`, `:427` | call before `hello` completed |
| `unauthorized` | `packages/kernel/src/transport/server.ts:447`, `:467` | host policy denied the operation |
| `invalid_request` | `packages/kernel/src/transport/server.ts:328`, `:344` | special params not an object / unknown key |
| `invalid_request` | `packages/kernel/src/transport/server.ts:434` | ordinary parameter envelope refused |
| `invalid_request` | `packages/kernel/src/transport/server.ts:474`, `:496` | second `hello`, or bad identity fields |
| `invalid_request` | `packages/kernel/src/transport/server.ts`, `M.runsCompact`; `packages/kernel/src/runs/run-service.ts`, `createRunService`'s `compact` | mechanical target supplied for a connection-live run, or a non-positive/non-integer target supplied after delegation |
| `invalid_request` | `packages/kernel/src/transport/server.ts:606` | unknown method |
| `unsupported` | `packages/kernel/src/transport/server.ts:481` | `wire_version` not 2 |
| `conflict` | `packages/kernel/src/transport/server.ts` (config subscribe case) | duplicate subscription id |
| `conflict` | `packages/kernel/src/transport/client.ts:430` | duplicate live execution id, client-side |
| `not_found` | `packages/kernel/src/transport/server.ts`, `liveOrThrow` | steer/cancel/respond target absent or result-settled on this connection |
| `not_found` | `packages/kernel/src/transport/server.ts`, `M.runsCompact`; `packages/kernel/src/runs/run-service.ts`, `createRunService`'s `compact` | compact target absent from owner persistence after connection-live release, or a terminal live handle whose compaction channel has already closed |
| `cancelled` | `packages/kernel/src/transport/stdio.ts:469`, `:480` | request aborted before or during flight |
| `internal` | `packages/kernel/src/transport/stdio.ts:377` | any thrown value whose `code` is not a `KernelErrorCode` |
| `internal` | `packages/kernel/src/transport/server.ts:399` | a rejected `handle.done`, reported as a failed `RunResult` |

### 6.2 What degrades vs. what fails hard

**Fails hard (connection dies).** Any structurally invalid inbound frame, an over-cap frame, a
non-JSON line, a duplicate in-flight request id, an unserializable or over-cap outbound frame, a
saturated writer queue, a 30 s stalled write, an inbound EOF or stream error. All of these route to
`terminate`/`disconnect` and settle every pending request `unavailable`
(`packages/kernel/src/transport/stdio.ts:185-218`, `:280-330`, `:418-433`, `:544-550`, `:565-568`).

**Fails hard (client side).** Any notification whose payload fails validation — including a run event
whose schema does not accept it — calls `protocolViolation`, which closes the transport
(`packages/kernel/src/transport/client.ts:210-221`, `:223-360`). This is the fail-closed choice: an unrecognised event is never
dropped silently.

**Fails hard (one connection, not the process).** A notification sink that rejects, stalls past
`notificationTimeoutMs`, produces an unserializable payload, or overflows the queue permanently
opens the circuit and disconnects that connection (`packages/kernel/src/transport/server.ts:134-137`, `:147-161`).

**Degrades.** A `res` for an unknown id is ignored (`packages/kernel/src/transport/stdio.ts:442`). A `note` on the server's input is
ignored (`packages/kernel/src/transport/stdio.ts:564`). An unsubscribe for an unknown id is a no-op (`packages/kernel/src/transport/server.ts:573`, `:600`).
`safeErrorDetails` returns `undefined` and drops the details entirely if bounding or sanitizing
throws (`packages/kernel/src/transport/stdio.ts:366-368`); `preservedErrorDetails` returns `{}` on any property-descriptor throw
(`packages/kernel/src/transport/stdio.ts:102-104`). Error details are bounded to depth 16, 1 024 nodes and 64 KiB before any
recursive sanitizer sees them (`packages/kernel/src/transport/stdio.ts:352-357`, `packages/kernel/src/core/bounded-json.ts:23-27`).

**Detached, logged, never retried.** Subscribe, unsubscribe, saturation-cancel, abandonment-cancel
and loopback `notify` all go through `detachObserved` with an `observationSink`
(`packages/kernel/src/transport/client.ts`, `connectKernelClient`'s `protocolViolation`,
`streamingStart`, and `config.subscribe`; `packages/kernel/src/transport/loopback.ts`,
`createLoopbackTransport`'s `notify`).
The sink stamps a fixed event name and the message "a detached kernel operation failed; nothing
retries it, and whatever it was releasing may still be held" (`packages/kernel/src/core/observed.ts:30-38`). Names
used here: `transport.close_failed`, `transport.cancel_failed`, `transport.subscribe_failed`,
`transport.unsubscribe_failed`, `transport.notify_failed`.

**Client run-event backpressure.** The client's stream is bounded at 1 024 events / 8 MiB
(`packages/kernel/src/transport/client.ts:434-435`); when it saturates on non-droppable items, or when the consumer abandons the
iterator, the client cancels the run remotely (`packages/kernel/src/transport/client.ts:440-451`). The coalescing/droppability
policy itself belongs to **kernel-run-service-and-events**.

**No retries anywhere.** Neither transport retries a frame, a request or a notification.

### 6.3 Both host policy hooks fail open, and the trust model that bounds them

`KernelServerOptions` declares two hooks a host may supply, and neither is required. Absence is
resolved to *permit* in both cases:

- **`authorize`.** The guard is written `opts.authorize === undefined || (await opts.authorize({…}))`
  — identically on the ordinary path (`packages/kernel/src/transport/server.ts:438-445`) and the
  special path (`:458-465`) — so `allowed` is `true` before any policy runs. The `unauthorized` throw
  at `:447` / `:467` that §6.1 records is therefore unreachable in every configuration this
  repository builds.
- **`resolveConnection`.** With none supplied, the connection is bound to `defaultContext` at
  `connect` time rather than at `hello` (`:302-303`), and `hello` takes that same value instead of
  calling out (`:498-501`). `defaultContext` is the server's own kernel: `kernel.project`,
  `kernel.workspace`, and services assembled as `{ ...kernel.operatorServices, providerAuth:
  createUnavailableProviderAuthService(), ...kernel.defaultOwnerServices }`
  (`packages/kernel/src/transport/server.ts`, `defaultContext`). The explicit replacement is a
  security boundary: subscription credentials and authorization controls are not projected onto a
  default remote connection. `providerAuth.list` reports both supported schemes unavailable and
  authorization attempts fail, while the other operator and default-owner services remain bound to
  this kernel. Test: `packages/kernel/tests/integration/transport.test.ts`, "keeps subscription
  authentication explicitly unavailable on a remote connection".

**Nothing in the repository supplies either.** `authorize` appears in `packages/*/src` only where it
is declared and called (`packages/kernel/src/transport/server.ts:218`, `:439-440`, `:459-460`); its
sole exerciser is INV-T11's test (`packages/kernel/tests/integration/transport.test.ts:497-517`).
`resolveConnection` is likewise referenced only by its implementation and transport tests; the
current single-workspace host builds `createFileKernel` directly and has no project-host connection
resolver (`packages/code/src/adapters/workspace-client-manager.ts:32-62`).
`KernelOperationMetadata.sensitivity`, the marker that would let a policy tell `secrets.*` from
`models.get`, is written by the `read()` / `write()` helpers
(`packages/kernel/src/transport/operations.ts:99-107`) and carried onto `KernelAuthorizationContext`
(`packages/kernel/src/transport/server.ts:235`) — and read by nothing. No `src` file in any package
branches on it.

**A `hello` `auth` token is accepted and then dropped.** `auth` is in the special-params allowlist
(`:331`), is type-checked as a string (`:487`), and is documented on `HelloParams` as "Opaque auth
token, when the transport requires one" (`packages/kernel/src/transport/wire.ts:92-93`). On the
`defaultContext` branch nothing reads it (`:498-501`), and `hello` answers with a successful
`HelloResult` carrying no `principal` (`:508-514`). The client accepts that answer — `principal` is
optional in its handshake validation (`packages/kernel/src/transport/client.ts:394-395`). A client
that presents a credential therefore cannot distinguish a kernel that authenticated it from one that
ignored it. **Resolved 2026-08-22**: the code now says. `KernelServerOptions.authorize` and
`KernelServerOptions.resolveConnection` each carry a `@remarks` stating that no production host
supplies one, what that leaves open (`secrets.set` reachable by any connection that completed
`hello`; a credential accepted, type-checked and dropped), and why it is inert rather than an
exposure — the tree builds no hosted case for this wire. The two remarks name each other, because a
host wiring one without the other has authenticated callers it cannot restrain, or restraints on a
caller it never identified. What is unbuilt is the seam's readiness, not a live hole; building it is
the owner's decision and remains open.

**What `secrets.set` carries.** The catalog's most sensitive operation puts the raw value straight
into the wire parameter object — `encode: (name, value) => ({ name, value })`
(`packages/kernel/src/transport/operations.ts:478`) — and `invoke` hands both to
`services.secrets.set` (`:479`), which reaches `createFileSecretStore`'s `set`
(`packages/kernel/src/secrets/secret-store.ts:111-117`) and rewrites the whole file through
`writeFileAtomicSync` (`:104-106`) at `0o600` inside a `0o700` directory
(`packages/paths/src/constants.ts:52`, `:40`). No redaction touches it: `sanitizeDeep`/`terminalSafe`
are reached only from `safeErrorDetails`, on the outbound **error** path
(`packages/kernel/src/transport/stdio.ts:348-369`, `:372-381`); request params go to `conn.handle`
exactly as decoded (`:571-572`); and the one log line about a frame records direction, reason and
byte count, never content (`:239-247`). The reachability path is the ordinary one: `hello`, then any
`secrets.set` request frame — INV-T6's pre-`hello` gate (`:426-428`) is the only thing in front of
it.

**The trust model the code actually implements.** The exposure is bounded by what a peer must
already hold to open a connection at all, and the source states the posture rather than leaving it
to inference. `SecretService`'s module doc records both the direction and the deployment it is
scoped to: "Values only ever flow client → kernel; listing returns names, never values" and "Secrets
travel over the transport on `set`. That is fine over local stdio (same user/host); a hosted kernel
needs TLS plus at-rest protection" (`packages/protocol/src/secrets.ts:4-9`). The catalog matches the
first half — `listNames` / `set` / `delete` and no `get`
(`packages/kernel/src/transport/operations.ts:468-487`) — so a peer that can write a secret still
cannot read one back over the wire.

The second half holds because the wire has exactly one production host. `serveFileKernelOverStdio`
is the only `createKernelServer` call outside tests and passes `capabilities` alone
(`packages/kernel/src/serve.ts:105-107`); its streams default to the process's own `process.stdin` /
`process.stdout` (`:111-112`); and its only caller is the `clarvis-kernel` binary
(`packages/kernel/src/bin.ts:20`, declared at `packages/kernel/package.json:45`). `packages/kernel/src`
contains no socket, listener or HTTP server for this wire, so the peer is whoever was handed that
process's pipes. Neither client of the kernel uses the transport at all: `@clarvis/code` wraps one
in-process `createFileKernel` result as a `KernelClient`
(`packages/code/src/adapters/workspace-client-manager.ts:32-62`) and `@clarvis/server` builds a
`createFileKernel` directly (`packages/server/src/bin.ts:318`) behind a facade structurally narrowed
to `runs.start`, with "no reachable path to config, secrets, files or cross-owner run listing"
(`packages/server/src/host/run-host.ts:7-10`) — §7.2 records that neither package references any
transport symbol.

**The accurate statement is therefore the narrow one.** The fail-open default is real, and today it
is not reachable by an untrusted peer: the wire's only production deployment is a pipe between two
processes of the same user, which the OS already protects, and across which the secret is no better
protected than `keys.json` itself — a file that peer can read and write directly. What the absence
costs is not confidentiality today but the seam's readiness. `authorize` and `resolveConnection` are
the only two places authentication and authorization can live on this wire; both default to
permitting; neither is required at construction, so `createKernelServer` cannot refuse a host that
omits them; and the one machine-readable marker a policy would key on has no reader. A host that
puts `createKernelServer` behind a socket and forgets either hook gets a fully unauthenticated
kernel with no construction-time error and no runtime signal — which is the case
`packages/protocol/src/secrets.ts:8-9` names as needing TLS and at-rest protection, and which
nothing in the tree builds yet.

## 7. Coupling

### 7.1 Outbound (what this subsystem depends on)

| Target | Kind | Forced by |
| --- | --- | --- |
| `@clarvis/protocol` (`KernelTransport`, `KernelClient`, all service interfaces, `RunEvent`, `KernelError*`) | type-only | `packages/kernel/src/transport/operations.ts:1-19`, `packages/kernel/src/transport/client.ts:4-29`, `packages/kernel/src/transport/server.ts:1-11`, `packages/kernel/src/transport/stdio.ts:3`, `packages/kernel/src/transport/wire.ts:1-11`, `packages/kernel/src/transport/loopback.ts:1`, `packages/kernel/src/transport/run-event-codec.ts:1` — every one is `import type` |
| `zod` | runtime | `packages/kernel/src/transport/run-event-codec.ts:2` — the only third-party runtime dependency in `transport/` |
| `@clarvis/capability` (`NOOP_LOGGER`, `Logger`, `sanitizeDeep`, `sanitizeErrorMessage`, `detachObserved`, `suppressSecondaryRejection`) | runtime | `packages/kernel/src/transport/stdio.ts:2`, `packages/kernel/src/transport/server.ts:13`, `packages/kernel/src/transport/client.ts:2`, `packages/kernel/src/transport/loopback.ts:2` |
| `node:crypto` (`randomUUID`) | runtime | `packages/kernel/src/transport/client.ts:1` |
| `node:stream` (`Readable`, `Writable`) | type-only | `packages/kernel/src/transport/stdio.ts:1` |
| `../core/bounded-json.ts` | runtime | `packages/kernel/src/transport/stdio.ts:4` |
| `../core/errors.ts` (`kernelError`) | runtime | `packages/kernel/src/transport/server.ts:14` |
| `../core/event-stream.ts` | runtime | `packages/kernel/src/transport/client.ts:30` |
| `../core/observed.ts` | runtime | `packages/kernel/src/transport/client.ts:3`, `packages/kernel/src/transport/loopback.ts:3` |
| `../runs/coalesce-events.ts` | runtime | `packages/kernel/src/transport/client.ts:44-51` |
| `../kernel.ts` (`InProcessKernel`) | **type-only** | `packages/kernel/src/transport/server.ts:12` — the kernel instance arrives as an argument, so `server.ts` holds no runtime edge to kernel composition |

`operations.ts` imports the fifteen service interfaces purely as types and derives `KernelServices`
as a `Pick` of `KernelClient` (`packages/kernel/src/transport/operations.ts:22-38`). That `Pick` is the type constraint that forces
the catalog to stay exhaustive: `serviceOperations<Service>` demands an entry for every async method
of the service it is given (`packages/kernel/src/transport/operations.ts:82-97`).

### 7.2 Inbound (what depends on this subsystem)

| Consumer | Edge |
| --- | --- |
| `packages/kernel/src/index.ts:63-87` | re-exports the public surface |
| `packages/kernel/src/serve.ts:3-4` | `createKernelServer` + `serveKernelOverStdio`, the stdio host |
| `packages/kernel/src/bin.ts:5` | the `clarvis-kernel` binary, through `serveFileKernelOverStdio` |
| `tests/contract/*`, `tests/integration/transport.test.ts`, `tests/integration/stdio-transport.test.ts`, `tests/unit/loopback-transport.test.ts` | the only exercisers of the client half in-repo |

`packages/code` and `packages/server` contain **no** reference to `connectKernelClient`,
`createLoopbackTransport`, `createKernelServer`, `createStdioTransport` or `serveKernelOverStdio`
(searched across both packages' `src`).

### 7.3 The direction the code forces

- `transport/` may not import `/adapters/` or `file-kernel`
  (`packages/kernel/tests/architecture/dependency-direction.test.ts:40-45`), so the wire is composable over any
  kernel instance.
- `server.ts` takes `InProcessKernel` only as a type and reads five members from it —
  `capabilities`, `project`, `workspace`, `operatorServices`, `defaultOwnerServices`
  (`packages/kernel/src/transport/server.ts:288-293`) — plus `lifecycle.register` (`packages/kernel/src/transport/server.ts:631`, contract at
  `packages/kernel/src/application/lifecycle.ts:14-25`).
- `client.ts` never imports `server.ts`, and `server.ts` never imports `client.ts`; the two meet only
  through `wire.ts` and `operations.ts`.
- `loopback.ts` and `stdio.ts` both import `KernelServer` as a **type** (`packages/kernel/src/transport/loopback.ts:4`,
  `packages/kernel/src/transport/stdio.ts:5`), so a transport can host any structurally compatible server.

## 8. Open questions

~~**A confirmed schema drift: `run_ended.code` is rejected by the client codec.**~~ **Resolved
2026-08-22.** The diagnosis held exactly as written. The protocol declared `code?: string`
(`packages/protocol/src/runs.ts:296-312`), the kernel's engine mapper emitted it whenever the trace
entry carried one (`packages/kernel/src/runs/map-events.ts:403-409`), and
`RUN_EVENT_SCHEMAS.run_ended` was `.strict()` over `type/at/status/reason` alone — so a failed run's
error code decoded to `null`, the client read that as a protocol violation, and one field nobody had
ever round-tripped settled every live run `unavailable` and closed the transport. The schema now
declares `code: text.optional()` (`packages/kernel/src/transport/run-event-codec.ts:91`), and
`packages/kernel/tests/contract/transport-codecs.test.ts:377` — "carries a failed run's error code
instead of killing the connection" — holds both halves: the event survives `decodeRunEvent`
unchanged, and the transport's `closeCount` stays `0`. The field's own remark now states what it is
for (`packages/protocol/src/runs.ts:301-310`): a resumed session is rebuilt from the persisted trace
alone, so without it a run that failed came back saying only that it had failed. **Why** it reached
the protocol without the codec is still not in the code, and no longer needs to be.

The sentence of the original that is now false — deliberately — is "the compiler cannot see this". It
could not, because `satisfies Record<RunEvent["type"], z.ZodType>`
(`packages/kernel/src/transport/run-event-codec.ts:410`) constrains the table's key set and never a
payload's shape. `CodecFieldDrift` (`:455`-`:467`, reasoning at `:443`-`:454`) now compares every
variant's declared field names against its schema's inferred ones in **both** directions, and
`AssertNoDrift` (`:469`, instantiated at `:470`) fails to compile on any mismatch, naming the variant
and the drifted field. A field added to `RunEvent` and forgotten in the codec — or the reverse — is a
build error rather than a session that ends the first time the field appears on the wire.

The trap for whoever edits that type next is recorded at the type itself (`:425`-`:434`).
`Extract<RunEvent, { type: K }>` is the obvious spelling of "the variant whose discriminator is `K`"
and it is the wrong one: a member may declare a *union* discriminator, a union is not assignable to
one of its own literals, so `Extract` answers `never`, `keyof never` widens to
`string | number | symbol`, and the guard reports drift on a variant that has none. `RunEventVariant`
(`:435`-`:441`) asks instead whether `K` is one of the member's own types, which is the question that
survives a shared member. One correction to that remark, which names two such members: `RunEvent`
carries exactly one today — `delegation_completed | delegation_failed`
(`packages/protocol/src/runs.ts:436`). The "workflow pair" it also names does not exist; every
`workflow_*` member declares a single literal (`:442`, `:457`, `:470`, `:480`, `:487`), and the codec
gives each its own schema. The trap is real and the guard is right to avoid `Extract`; only the
count is off.

**`notify`'s cross-transport asymmetry is dead surface, not an undecided design.** `createStdioTransport.notify`
writes a `note` frame (`packages/kernel/src/transport/stdio.ts:492-495`) that `serveKernelOverStdio` discards, because it
only handles `cancel` and `req` (`packages/kernel/src/transport/stdio.ts:560-564`, itself documented: "Non-`req` frames on the
input are ignored"). `createLoopbackTransport.notify` instead dispatches straight into `conn.handle`
(`packages/kernel/src/transport/loopback.ts:57-62`) — the *same* dispatch path `request()` uses — so, unlike stdio, it would
actually execute whatever real `KernelServer` operation the method name happens to name, with side
effects, before discarding the result. This is a genuinely divergent implementation of one interface
member, but it has no live consequence today: a repo-wide search of `packages/kernel/src`,
`packages/code/src` and `packages/server/src` for a client-side call to `KernelTransport.notify`
(as opposed to the unrelated `deps.notify`/UI toast helper of the same name in `@clarvis/code`, or the
*server-side* `notifications.notify` used to push `run.event`/`config.change`/etc. — `packages/kernel/src/transport/server.ts:365-584`)
finds none; the only exerciser is `packages/kernel/tests/unit/loopback-transport.test.ts:27`'s isolated unit test. §7 of
this document already establishes that `connectKernelClient`/`createLoopbackTransport`/`createStdioTransport`
are used only by kernel tests, with no in-repo production consumer at all — so this is not two live
readings of an intended feature; it is two independently-written implementations of an unused
interface member that nothing ever forced to agree. If a client→server notification channel is ever
wired to a real caller, the two transports' current behavior would have to be reconciled (most likely
by giving stdio's server side a `note`-handling branch symmetric with loopback's, or by having
loopback refuse an unknown notification method the way stdio silently drops it) — but that is future
work, not a fact this corpus can settle today.

**Validation depth across the five notifications tracks whether each payload's type is closed, not an
arbitrary asymmetry.** `run.event` is validated by a strict `zod` discriminated-union schema because
`RunEvent`'s variants are a closed set with no open member
(`packages/kernel/src/transport/run-event-codec.ts:413` decoding the type at `packages/protocol/src/runs.ts`'s closed
`RunEvent` union). `config.change` applies `hasOnly` to its nested payload because `ConfigChange` is a
closed, fixed-key shape over a closed enum (`ConfigChangeKind`, `packages/protocol/src/config.ts`).
`run.elicitation` applies `hasOnly` only at the top level and checks four scalar fields of `request`
without constraining its key set (`packages/kernel/src/transport/client.ts:292-301`) precisely because `ElicitationRequest`
is declared open on purpose: `kind` is `"ask_user" | "guard_confirm" | "plan_review" | "workflow_review"
| (string & {})`, documented "so a kernel may add kinds without a protocol bump"
(`packages/protocol/src/runs.ts:619-626`), and `schema` is `JsonSchema = Record<string, unknown>`, documented "a JSON
Schema passed through opaquely" (`packages/protocol/src/common.ts:82-83`). Applying a closed `hasOnly` to `request`
today would reject a future `kind`'s legitimate extra fields, defeating the exact extensibility `kind`
was made open for — so the omission is the correct reading, not an arbitrary weakening.

~~**One narrower residual is not explained by either the open-`kind` or opaque-`schema` reasoning:
`ElicitationRequest.detail` gets no structural check at all — not even `isRecord`.**~~ **Resolved
2026-08-22.** The residual was correctly identified, and the argument for closing it was weaker than
the case deserved. `detail` (`ElicitationCommandDetail`, `packages/protocol/src/runs.ts:607-616`,
`command`/`cwd`/`reason`/`warning?`) shares neither property that keeps the request around it open,
so a nested `hasOnly` costs nothing in forward-compatibility — but "it costs nothing" is not why it
has to be there. `detail` is what a human reads when approving a command, and clients are told to
render it directly rather than parse `prompt` (`:629-634`), so a `detail` whose `command` is absent
or not a string reaches an approval dialog as `undefined` and the approval is then given for a
command nobody was shown. That is the reasoning now recorded at `isCommandDetail`
(`packages/kernel/src/transport/client.ts:273-283`), which checks the closed key set and every
member's type (`:283-289`) and is consulted only when `detail` is present (`:299`). `kind` and
`schema` stay untouched, for exactly the reasons above. Five malformed shapes — not a record, a
missing `command`, a non-string `command`, a non-string `warning`, an unknown key — close the
transport fail-closed under `it.each` at
`packages/kernel/tests/contract/transport-codecs.test.ts:455` ("closes fail-closed on a
guard_confirm detail with %s"), with a well-formed `detail` delivered intact at `:381` and a
control at `:440` asserting that an unknown `kind` and an opaque `schema` still pass through
unexamined.

**`transport.frame_dropped` with `reason: "serialization"` is unpinned.** It is emitted at
`packages/kernel/src/transport/stdio.ts:288` and is the only one of the six reasons absent from the drop-reason suite
(`packages/kernel/tests/contract/stdio-codec.test.ts:313-370`). INV-210 covers the *behaviour* (a clean
`unavailable`) but not the log record.

**`decodeOperationParams` validates only the key set** — it checks no required key is missing and no
value's type (`packages/kernel/src/transport/operations.ts:900-917`); `invoke` then casts
(`packages/kernel/src/transport/operations.ts:154` and throughout). The TSDoc's claim that "domain
services remain responsible for their nested DTOs" (`:896-899`) is not merely asserted: it is verified true
for at least two representative operations, one on each side of the read/write split. `runs.start`'s
`invoke` passes the cast params straight into `startReserved` → `assembleRunRequest` →
`executeRun({ rawBody, … })` (`packages/kernel/src/runs/run-service.ts:103-107`), and `executeRun` calls
`validateBody(rawBody, deps.env, requestRegistry)` before doing anything else with it
(`packages/loop/src/runtime/execute-run.ts:298`) — a real schema pass, exercised by
`packages/loop/tests/component/request-schema-facade.test.ts` and others. `config.updateSettings`'s
`invoke` reaches `ConfigService.updateSettings`, whose merge closure runs
`kernelSettingsSchema.safeParse(next)` and throws `invalid_request` on failure
(`packages/kernel/src/config/config-service.ts:428-438`). So the two-layer design the TSDoc describes is real,
not aspirational: the transport layer's job is exactly and only the closed top-level envelope (which
`decodeOperationParams` does check), and the domain service one layer down is where wrong-typed values
are actually rejected — with its own dedicated tests, not the transport's. No test *at the
`operations.ts` layer* pairs a well-keyed envelope with wrong-typed values, but that absence reflects
where the corpus's tests are organized (one layer down, per operation), not an unsettled question about
whether such validation happens at all.

**The `MAX_NOTIFICATION_QUEUE_BYTES` (16 MiB) vs. `MAX_WIRE_FRAME_BYTES` (8 MiB) gap is not a
coordinated ratio between comparable bounds** — the two constants are scoped to different layers with
different jobs, which is why nothing pins a 2× relationship between them. `MAX_WIRE_FRAME_BYTES`
(`packages/kernel/src/transport/stdio.ts:42`) is the stdio wire's universal per-frame ceiling, applied identically to
every frame type — `req`, `res` and `note` alike (`:185-200` on read, `:293` on write) — because it
bounds what a single NDJSON line may cost to buffer and parse. `MAX_NOTIFICATION_QUEUE_BYTES`
(`packages/kernel/src/transport/server.ts:35`) instead bounds the **notification backpressure channel's cumulative
pending backlog** — `pendingBytes + bytes > MAX_NOTIFICATION_QUEUE_BYTES` (`:157`) sums *every still-undelivered*
notification, not just the one being enqueued — and this channel is shared verbatim by both
transports: loopback has no wire frame, no buffer, and no `MAX_WIRE_FRAME_BYTES` concept at all
(`packages/kernel/src/transport/loopback.ts:36-39` dispatches synchronously into `conn.handle`, no serialization step), so the
notification channel's own byte cap is the *only* size bound loopback ever applies. Setting it to
match the stdio-specific wire cap would import an 8 MiB ceiling with no wire underneath it to justify.
The one place the gap has an observable, if minor, consequence: over stdio, a single notification
between 8 and 16 MiB passes the `notify()`-level admission check (`bytes > MAX_NOTIFICATION_QUEUE_BYTES`,
`:155`, false) and is queued, occupying backpressure budget, before failing later when `drain()`
reaches it and the stdio writer's own `MAX_WIRE_FRAME_BYTES` check rejects it
(`packages/kernel/src/transport/stdio.ts:293-295`) — rather than being rejected immediately at `notify()` time with
"notification backpressure queue is full" (`packages/kernel/src/transport/server.ts:158`). Both paths still fail the
connection; only the failure's timing and reported reason differ.

**Not exercised by any in-repo consumer.** `connectKernelClient`, `createLoopbackTransport` and
`createStdioTransport` are used only by kernel tests; the shipped clients (`@clarvis/code`,
`@clarvis/server`) reach the kernel some other way. The consequence — that every claim in §4.1, §4.4
and §4.5 is pinned by tests rather than by production traffic — is a fact about the repository, not a
judgement about the design.

**Deliberately delegated.**
- The DTO shapes every method carries, and `KernelClient`'s fifteen services →
  **protocol-kernel-contract**.
- Which run events exist, what they mean, and the coalescing/droppability policy behind
  `DEFAULT_RUN_EVENT_BUFFER` → **kernel-run-service-and-events**.
- The redaction rule set behind `sanitizeDeep`/`sanitizeErrorMessage` and what "credential-shaped"
  means → **security-confinement-and-redaction**.
- `createFileKernel`, the Code host's single-workspace lifetime wrapper, and the composition
  `src/serve.ts` sits in → the kernel bootstrap/composition item. None supplies a transport
  `resolveConnection` hook.
