# The kernel wire: framing, methods, codecs, client and server

> Implemented at `packages/kernel/src/transport/**`. Every claim below is anchored to a file and
> symbol or exact range. Open questions are collected in the final section.

## 1. Purpose

`packages/kernel/src/transport/` is the RPC seam between a Clarvis *kernel* and a *client* of the
`KernelClient` contract. It is JSON-RPC-*shaped* but carries Clarvis's own method vocabulary rather
than MCP's (`packages/protocol/src/transport.ts`, `packages/kernel/src/transport/wire.ts`).
The transport modules divide the job: `wire.ts` names the methods and notification payloads, `operations.ts`
is the single table mapping every method onto a protocol service call, `server.ts` dispatches a
connection's requests and pumps a run's events out as notifications, `client.ts` builds a
`RemoteKernel` façade whose service methods are wire requests, `stdio.ts` frames all of it as
newline-delimited JSON over a stream pair, `loopback.ts` is the same seam with `JSON` round-tripping
instead of a pipe, `local.ts` reuses the stream framing on reconnectable local IPC, and
`run-event-codec.ts` re-validates every inbound run event against a closed
schema registry.

The design property the modules exist to hold is that a method string is spelled **once**. `M` in
`wire.ts` is not a literal table: every entry reads its value out of `OPERATIONS` or
`SPECIAL_OPERATIONS` (`packages/kernel/src/transport/wire.ts`), and both the client proxy
(`createServiceProxy` in `packages/kernel/src/transport/operations.ts`) and the server dispatch map (`packages/kernel/src/transport/server.ts`) are built
from that same catalog. A wire name therefore cannot drift between the two halves.

The second property is that both directions of the boundary are treated as untrusted. Inbound frames
go through a strict structural decoder that returns `null` rather than coercing
(`packages/kernel/src/transport/stdio.ts`); inbound run events go through per-discriminator `zod` schemas that are all
`.strict()` (`RUN_EVENT_SCHEMAS` in `packages/kernel/src/transport/run-event-codec.ts`); inbound request parameter envelopes are checked against
the key set the operation's own encoder produces (`decodeOperationParams` in
`packages/kernel/src/transport/operations.ts`); and an error travelling
outbound is size-bounded, control-character-stripped and secret-redacted before it is serialized
(`packages/kernel/src/transport/stdio.ts`).

Runtime status variants are defined once by the private `runtimeStatusSchema` factory. The hosted
discovery decoder supplies strict non-empty identifiers up to 256 characters and index-bounded text;
the local-host operator client retains its 4,096-character transport fields. Sharing the structure
does not weaken either boundary or place Zod in Protocol. Unknown fields and runtime/lifecycle values
remain invalid. Production: [status-schema.ts](../../packages/kernel/src/runtime/status-schema.ts),
[state.ts](../../packages/kernel/src/hosting/state.ts) and
[local-host-client.ts](../../packages/kernel/src/transport/local-host-client.ts).
Test: [runtime-status-conformance.test.ts](../../packages/kernel/tests/contract/runtime-status-conformance.test.ts)
passes every current variant/lifecycle through both actual boundaries and preserves their distinct
identifier and text bounds.

## 2. Surface

### 2.1 Exported from `@clarvis/kernel`

Re-exported by `packages/kernel/src/index.ts`:

| Symbol | Kind | Declared at | What it is |
| --- | --- | --- | --- |
| `createKernelServer(kernel, opts?)` | value | `packages/kernel/src/transport/server.ts` | Builds the server side over an `InProcessKernel` |
| `KernelServer`, `KernelConnection`, `KernelServerOptions`, `KernelAuthorizationContext`, `KernelConnectionContext`, `NotificationSender`, `TransportDisconnect` | types | `packages/kernel/src/transport/server.ts` | Server-side shapes |
| `connectKernelClient(transport, opts?)` | value | `packages/kernel/src/transport/client.ts` | Performs `hello`, returns a `RemoteKernel` |
| `RemoteKernel`, `ConnectKernelClientOptions` | types | `packages/kernel/src/transport/client.ts` | Client-side shapes |
| `createLoopbackTransport(server, logger?)` | value | `packages/kernel/src/transport/loopback.ts` | In-process transport |
| `createStdioTransport(io, logger?)` | value | `packages/kernel/src/transport/stdio.ts` | Client-side NDJSON transport |
| `connectLocalKernelTransport(endpoint, options?)` | value | `packages/kernel/src/transport/local.ts` | Reconnectable Unix-socket/named-pipe client using the same NDJSON codec |
| `listenLocalKernel(server, endpoint, options?)` | value | `packages/kernel/src/transport/local.ts` | Bounded local IPC listener; authentication and authorization stay on its server |
| `LocalKernelListener`, `LocalKernelListenerOptions` | types | `packages/kernel/src/transport/local.ts` | Endpoint lifetime and connection/handshake bounds |
| `serveKernelOverStdio(server, io, logger?)` | value | `packages/kernel/src/transport/stdio.ts` | Server-side NDJSON pump |
| `WIRE_METHODS` (`M`), `WIRE_NOTIFICATIONS` (`N`) | values | `packages/kernel/src/transport/wire.ts` | Named method / notification constants |
| `KERNEL_OPERATIONS` (`OPERATIONS`), `SPECIAL_OPERATIONS`, `KNOWN_METHODS` | values | `packages/kernel/src/transport/operations.ts` (same-named symbols) | The operation catalog |
| `KernelOperation`, `KernelOperationMetadata`, `KernelServices` | types | `packages/kernel/src/transport/operations.ts` (same-named symbols) | Catalog shapes |

Exported from their module but **not** re-exported by `src/index.ts`: `CLARVIS_WIRE_VERSION`
(`packages/kernel/src/transport/wire.ts`), `MAX_WIRE_FRAME_BYTES` and `decodeFrame` (`packages/kernel/src/transport/stdio.ts`), `ORDINARY_OPERATIONS`,
`decodeOperationParams`, `createServiceProxy` (`packages/kernel/src/transport/operations.ts`, same-named symbols), `decodeRunEvent`
(`packages/kernel/src/transport/run-event-codec.ts`). The tests reach them by relative path
(`packages/kernel/tests/contract/stdio-codec.test.ts`, `packages/kernel/tests/contract/transport-codecs.test.ts`).

`RemoteKernel.listAgents()` (`packages/kernel/src/transport/client.ts`) is documented on the interface as "a convenience
alias for `config.listAgents`", but its implementation (`packages/kernel/src/transport/client.ts`) is a direct
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
(`packages/protocol/src/transport.ts`.) `KernelRequestOptions` carries exactly one field,
`signal` (`packages/protocol/src/transport.ts`).

### 2.3 The operation catalog

`KernelOperation` in `packages/kernel/src/transport/operations.ts` has five members: `method` (the
sole declaration of the wire name), `metadata`, `encode(...args)` producing the named parameter
envelope, an optional `requestOptions(...args)` extracting transport-only metadata that must not be
serialized, and `invoke(services, params, signal?)` calling the matching service method.

`KernelOperationMetadata` is `{ access: "read" | "write"; sensitivity?: "files" | "plugins" |
"secrets" | "provider_auth" | "tasks" }` (`KernelOperationMetadata` in
`packages/kernel/src/transport/operations.ts`), built by the `read()`/`write()` helpers in that file.

`serviceOperations<Service, Excluded>` in `packages/kernel/src/transport/operations.ts` is the type-level completeness device:
`ServiceOperations` maps **every** async method key of the service (minus explicit exclusions) to an
operation whose argument tuple and result are inferred from the service method
(`OperationFor` and `ServiceOperations` in the same file). `runs` excludes `"start"` and `"compact"`;
`config.subscribe` is not an async method so it is excluded by the
`AsyncMethodKeys` filter itself. The two run
methods use the special streaming/control operation path.

`KNOWN_METHODS` flattens every ordinary and special request from the same catalog. Hosted-run
CRUD uses `OPERATIONS.hosting`; admission, attach and observation controls use special operations.
There is no
worktree service or worktree operation: checkout selection happens before kernel construction.
Production: `packages/kernel/src/transport/operations.ts` (`OPERATIONS`, `SPECIAL_OPERATIONS`,
`ORDINARY_OPERATIONS`, `KNOWN_METHODS`). Test:
`packages/kernel/tests/contract/transport-codecs.test.ts` (transport operation descriptors).

The special operations and their metadata:

| Method | `access` | `sensitivity` |
| --- | --- | --- |
| `hello` | read | — |
| `hosting.start` | write | — |
| `hosting.attach` | read; acquiring/taking control additionally requires registry operator authority | — |
| `hosting.steer` | write | — |
| `hosting.compact` | write | — |
| `hosting.cancel` | write | — |
| `hosting.respond` | write | — |
| `runs.start` | write | — |
| `runs.steer` | write | — |
| `runs.compact` | write | — |
| `runs.cancel` | write | — |
| `runs.respond` | write | — |
| `config.subscribe` | read | — |
| `config.unsubscribe` | read | — |

`M` names the special operations and selected ordinary aliases (`packages/kernel/src/transport/wire.ts`);
the remaining ordinary methods are reached through the service proxies. The
whole DTO vocabulary each method carries belongs to **protocol-kernel-contract**.

Ordinary operations' individual `access`/`sensitivity` pairing is declared by
`OPERATIONS` in `packages/kernel/src/transport/operations.ts`.
Six service groups carry a `sensitivity` tag on every operation (`plugins`, `extensionProfiles`,
`secrets`, `providerAuth`, `files`, `tasks`). Extension Profiles deliberately shares the `plugins`
sensitivity because selecting or editing one changes the active executable extension set. Models uses `provider_auth` only for its two entitled-catalog
operations; `hosting`, `runs`, `config`, `memory`, `plans`, `workflows`, `skills`,
`sessions` and `storage` carry access metadata without a sensitivity tag:

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
| extensionProfiles | `extensionProfiles.list` | read | `plugins` |
| extensionProfiles | `extensionProfiles.current` | read | `plugins` |
| extensionProfiles | `extensionProfiles.get` | read | `plugins` |
| extensionProfiles | `extensionProfiles.inventory` | read | `plugins` |
| extensionProfiles | `extensionProfiles.preview` | read | `plugins` |
| extensionProfiles | `extensionProfiles.previewClear` | read | `plugins` |
| extensionProfiles | `extensionProfiles.previewComposition` | read | `plugins` |
| extensionProfiles | `extensionProfiles.select` | write | `plugins` |
| extensionProfiles | `extensionProfiles.clearSelection` | write | `plugins` |
| extensionProfiles | `extensionProfiles.applyComposition` | write | `plugins` |
| extensionProfiles | `extensionProfiles.create` | write | `plugins` |
| extensionProfiles | `extensionProfiles.update` | write | `plugins` |
| extensionProfiles | `extensionProfiles.delete` | write | `plugins` |
| extensionProfiles | `extensionProfiles.clone` | write | `plugins` |
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

`N` (`packages/kernel/src/transport/wire.ts`) names server→client pushes, none with a response frame:

| Constant | Wire name | Payload interface | Declared at |
| --- | --- | --- | --- |
| `runEvent` | `run.event` | `RunEventNote { execution_id, event }` | `packages/kernel/src/transport/wire.ts` |
| `runElicitation` | `run.elicitation` | `RunElicitationNote { request }` | `packages/kernel/src/transport/wire.ts` |
| `runResult` | `run.result` | `RunResultNote { execution_id, result }` | `packages/kernel/src/transport/wire.ts` |
| `runStreamEnd` | `run.stream_end` | `RunStreamEndNote { execution_id }` | `packages/kernel/src/transport/wire.ts` |
| `configChange` | `config.change` | `ConfigChangeNote { subscription_id, change }` | `packages/kernel/src/transport/wire.ts` |
| `hostedObservation` | `hosting.observation` | `HostedObservationNote { subscription_id, kind, ... }` | [hosting-codec.ts](../../packages/kernel/src/transport/hosting-codec.ts) |

`run.elicitation` carries no `execution_id` of its own — the run is identified by
`request.execution_id` (`packages/kernel/src/transport/wire.ts`, consumed at `packages/kernel/src/transport/client.ts`).

### 2.5 Server options

`KernelServerOptions` (`packages/kernel/src/transport/server.ts`):

| Field | Effect |
| --- | --- |
| `capabilities?: Partial<KernelCapabilities>` | Merged over `kernel.capabilities` and advertised in `hello` (`packages/kernel/src/transport/server.ts`) |
| `authorize?(ctx): boolean \| Promise<boolean>` | Consulted before every operation **except** `hello` (`packages/kernel/src/transport/server.ts`, request authorization branch) |
| `resolveConnection?(params): KernelConnectionContext` | Host authentication / owner binding, run inside the `hello` case (`packages/kernel/src/transport/server.ts`) |
| `notificationTimeoutMs?: number` | Per-notification sink budget; defaults to 30 000 (`packages/kernel/src/transport/server.ts`) and must be positive and finite or the constructor throws `RangeError` (`packages/kernel/src/transport/server.ts`) |

`KernelConnectionContext` (`packages/kernel/src/transport/server.ts`) supplies `principal?`, `workspace`, `project`,
`services` ("Complete workspace-scoped service set; never borrowed from the primary kernel",
`packages/kernel/src/transport/server.ts`), `capabilities?` and `close?`.

### 2.6 Client connect options

`ConnectKernelClientOptions` (`packages/kernel/src/transport/client.ts`):

| Field | Effect |
| --- | --- |
| `clientInfo?: { name, version? }` | Echoed into `HelloParams.clientInfo` for the kernel's bookkeeping (`packages/kernel/src/transport/client.ts`) |
| `workspace?: string` | Workspace to bind to; the kernel decides how to resolve it (`packages/kernel/src/transport/client.ts`) |
| `auth?: string` | Opaque auth token, forwarded when the transport requires one (`packages/kernel/src/transport/client.ts`) |
| `logger?: Logger` | Where a **detached** wire operation's failure is reported — an unsubscribe, cancel or close that never lands. Its doc comment notes it replaced seven `process.emitWarning` call sites in this file (`packages/kernel/src/transport/client.ts`) |

## 3. Data and formats

### 3.1 Frame shapes

The wire is newline-delimited JSON. Four frame types (`packages/kernel/src/transport/stdio.ts`):

| `t` | Fields | Direction | Response? |
| --- | --- | --- | --- |
| `req` | `id: number`, `method: string`, `params?: unknown` | client→server | yes, a `res` with the same `id` |
| `res` | `id: number`, exactly one of `result` / `error` | server→client | — |
| `note` | `method: string`, `params?: unknown` | server→client | no |
| `cancel` | `id: number` | client→server | no |

`ErrorEnvelope` is `{ code: KernelErrorCode; message: string; details?: unknown }` (`packages/kernel/src/transport/stdio.ts`).

`hosting.resolveRecovery` is an ordinary write operation carrying a closed `{input}` envelope;
the registry validates the nested generation, revision and physical-closure confirmation and permits
only an authenticated operator. Production: `SERVICE_OPERATIONS` in
[operations.ts](../../packages/kernel/src/transport/operations.ts). Test:
`operator recovery preserves the session audit and unlocks maintenance over local IPC` in
[file-run-host.test.ts](../../packages/kernel/tests/integration/file-run-host.test.ts).

Real frames, from the reassembly test (`packages/kernel/tests/contract/stdio-codec.test.ts`):

```
{"t":"note","method":"probe.note","params":{"part":1}}
{"t":"res","id":1,"result":{"ok":true}}
{"t":"req","id":1,"method":"probe.slow"}
```

### 3.2 Structural validity

`decodeFrame` (`packages/kernel/src/transport/stdio.ts`) is total and returns `null` on anything it does not recognise:

- the value must be a non-array object with a string `t`;
- `req` permits only the keys `t,id,method,params` — `hasOnly` rejects an extra field, while the
  optional `params` key may be absent (helper);
- an id must be a **safe positive integer** (`validId`);
- a method must be a non-empty string of at most 256 characters (`validMethod`);
- `cancel` admits only `t,id`; `note` permits only `t,method,params`, with `params`
  optional;
- `res` must carry exactly one of `result`/`error` — `hasResult === hasError` is a rejection, tested for both the neither and the both case
  (`packages/kernel/tests/contract/stdio-codec.test.ts`);
- an error envelope must have only `code,message,details`, a `code` drawn from the eleven
  `KernelErrorCode` members, and a `message` string of at most 16 384 characters.

`ERROR_CODE_MEMBERS` (`packages/kernel/src/transport/stdio.ts`) is pinned to the protocol union by
`satisfies Record<KernelErrorCode, true>`, so adding a code in
`packages/protocol/src/common.ts` without adding it here is a compile error.

### 3.3 Size and queue budgets

| Constant | Value | Declared at |
| --- | --- | --- |
| `MAX_WIRE_FRAME_BYTES` | 8 MiB | `packages/kernel/src/transport/stdio.ts` |
| `MAX_WRITER_QUEUE_FRAMES` | 1 024 | `packages/kernel/src/transport/stdio.ts` |
| `MAX_JSON_MESSAGE_BYTES` | 64 MiB logical JSON | `packages/kernel/src/core/json-message.ts` |
| `MAX_JSON_QUEUE_BYTES` | 128 MiB serialized queued/inbound data | `packages/kernel/src/core/json-message.ts` |
| `TRANSFER_TIMEOUT_MS` | 30 000 | `packages/kernel/src/core/json-message.ts` |
| `MAX_ERROR_MESSAGE_CHARS` | 16 384 | `packages/kernel/src/transport/stdio.ts` |
| `MAX_ERROR_DETAILS_BYTES` | 64 KiB | `packages/kernel/src/transport/stdio.ts` |
| `MAX_CLASSIFICATION_VALUE_CHARS` | 1 024 | `packages/kernel/src/transport/stdio.ts` |
| `DEFAULT_NOTIFICATION_TIMEOUT_MS` | 30 000 | `packages/kernel/src/transport/server.ts` |
| `MAX_NOTIFICATION_QUEUE_FRAMES` | 1 024 | `packages/kernel/src/transport/server.ts` |
| `MAX_NOTIFICATION_QUEUE_BYTES` | 16 MiB | `packages/kernel/src/transport/server.ts` |
| client run-event buffer | 1 024 events / 8 MiB | `packages/kernel/src/runs/coalesce-events.ts`, used at `packages/kernel/src/transport/client.ts` |

### 3.4 Handshake payloads

`HelloParams` = `{ wire_version: 6; clientInfo?: { name, version? }; workspace?: string; auth?:
string }` (`packages/kernel/src/transport/wire.ts`, `HelloParams`). `CLARVIS_WIRE_VERSION = 5`
(`packages/kernel/src/transport/wire.ts`, `CLARVIS_WIRE_VERSION`).

`HelloResult` = `{ wire_version: 6; capabilities: KernelCapabilities; project: ProjectRef;
workspace: WorkspaceRef; principal?: Principal }` (`packages/kernel/src/transport/wire.ts`,
`HelloResult`). A concrete instance appears in
`packages/kernel/tests/contract/transport-codecs.test.ts`.

### 3.5 Request ids

Client-side ids are a per-transport monotonic counter, `++seq` starting at 1 (`packages/kernel/src/transport/stdio.ts`).
They are transport-private: nothing above `stdio.ts` sees them, and the loopback has none at all.

Run identities are minted client-side before the start request is sent: `params.execution_id ??
randomUUID()` (`packages/kernel/src/transport/client.ts`). Config subscription ids are
`randomUUID()` per `subscribe` call (`packages/kernel/src/transport/client.ts`).

### 3.6 The run-event registry

`RUN_EVENT_SCHEMAS` in `packages/kernel/src/transport/run-event-codec.ts` holds **39** entries, one per `RunEvent`
discriminator, closed by `satisfies Record<RunEvent["type"], z.ZodType>`. Shared fragments:
`attributed` = `{ at, agent, subagent_id? }`, `planProjection`, `planTask`, `memoryIngestDetail` as a five-phase discriminated union. Every object schema
is `.strict()`.

The complete discriminator list: `run_started`, `run_ended`, `iteration_started`,
`iteration_completed`, `tool_call_started`, `tool_call`, `tool_output_delta`, `tool_input_delta`,
`reasoning`, `text_delta`, `model_error`, `model_retry`, `delegation_created`, `delegation_started`,
`delegation_completed`, `delegation_failed`, `workflow_run_started`, `workflow_title_updated`,
`workflow_sequence_state`, `workflow_run_progress`, `workflow_run_completed`, `workflow_run_failed`, `plan_created`,
`plan_updated`, `plan_removed`, `plan_review_requested`, `plan_review_resolved`, `soft_limit_check`,
`compaction_started`, `compaction`, `vision_analysis`, `compaction_skipped`, `elicitation_requested`,
`elicitation_resolved`, `steering_applied`, `memory_ingest`, `capability_event`, `events_dropped`,
`mcp_degraded` (`RUN_EVENT_SCHEMAS`). *Which* events exist and why belongs to
**kernel-run-service-and-events**.

The strict `tool_input_delta` schema admits cumulative argument `chars`, optional cumulative
provider `stream_chars`, plus only the literal optional `complete: true`. The counts remain
distinct, and that flag closes argument composition; it does not stand in for
`tool_call_started` or terminal `tool_call`, and another call beginning says nothing about the first
because their streams may interleave. Production: `RUN_EVENT_SCHEMAS.tool_input_delta`. Test:
`packages/kernel/tests/contract/transport-codecs.test.ts`.

## 4. Behavior

### 4.1 Connect and handshake (`connectKernelClient`)

In the order the function runs (`packages/kernel/src/transport/client.ts`):

1. Allocate per-connection state: `clientRuns`, `configSubs`, `notificationOffs`.
2. Register `transport.onClose` **before** anything else, so a disconnect during the handshake is
   observed. Its handler sets `closed`, settles every live run `unavailable`, clears the
   subscription maps and detaches the observers.
3. Register the five notification observers, each with its own validator.
4. Build `HelloParams` and issue `M.hello`.
5. On a throw: mark closed, clear subscriptions, detach observers, `await transport.close()` inside a
   `try/catch` whose comment reads "Teardown is secondary and no client was returned", then rethrow
   the **original** error.
6. On a structurally invalid result: same teardown, then throw
   `` `kernel selected an invalid or unsupported Clarvis wire contract '${selected}'` ``.
   The checks are `hasOnly` over the permitted keys, `wire_version === 6`, `capabilities` /
   `project` / `workspace` objects, string `project.id`, `workspace.id`, `workspace.projectId`,
   `workspace.label`, a `workspace.kind` in `primary | external_worktree`, and a
   `principal` that, if present, is an object with a string `id`.
7. Build the ordinary service proxies, the subscribe-aware `config` wrapper, and the streaming `runs`, and return the `RemoteKernel` carrying `hello.capabilities`, `hello.project`,
   `hello.workspace` and, when present, `hello.principal`.
   A valid `capabilities.hosting.host_generation` additionally constructs the optional hosting
   client and registers its observation notification validator before any hosted admission.

### 4.2 Server-side dispatch (`KernelConnection.handle`)

`packages/kernel/src/transport/server.ts`, in order:

| Step | File | Effect |
| --- | --- | --- |
| `assertConnectionOpen()` | (helper) | Throws `unavailable` "kernel connection is closed" |
| Pre-hello gate | — | Any method but `hello` before `helloCompleted` throws `unauthorized` |
| Ordinary lookup | — | `ordinary` map built once from `ORDINARY_OPERATIONS` |
| Envelope decode | — | `decodeOperationParams`; `null` → `invalid_request` "has an invalid parameter envelope" |
| Authorize | — | `opts.authorize({ method, metadata, principal?, workspace })` |
| Re-check open | — | The authorize hop may have awaited across a `close()` |
| Deny | — | `unauthorized` `operation '<m>' is not allowed` |
| Invoke | — | `operation.invoke(services(), p, signal)`; an `undefined` result becomes `{}` |
| Special envelope | — | `specialParams` — object required, keys from a per-method allowlist |
| Special authorize | — | Same policy hop, skipped for `hello` |
| Switch | server special-operation switch | Cases declared by `SPECIAL_OPERATIONS`; `default` throws `invalid_request` `unknown method '<m>'` |

`services()` throws `unauthorized` "connection has not completed hello" when no context is bound, which is the second guard behind the pre-hello gate.

`specialParams`'s per-method allowed-key table (`packages/kernel/src/transport/server.ts`) in full:

| Method | Allowed keys |
| --- | --- |
| `hello` | `wire_version`, `clientInfo`, `workspace`, `auth` |
| `hostingStart`, `hostingAttach` | `input`, `subscription_id` |
| `hostingSteer` | `subscription_id`, `message` |
| `hostingCompact` | `subscription_id`, `request` |
| `hostingCancel` | `subscription_id` |
| `hostingRespond` | `subscription_id`, `response` |

`hosting.controlObservation` is an operator mutation in the ordinary service operation catalog.
It accepts `observation_id` and `control: "acquire" | "takeover"`, returning a `HostedRunRef`
without creating another subscription. Production: `OPERATIONS.hosting.controlObservation`
in [operations.ts](../../packages/kernel/src/transport/operations.ts). Test: existing-observation
takeover over loopback and local IPC in
[hosted-transport.test.ts](../../packages/kernel/tests/integration/hosted-transport.test.ts).
| `runsStart` | `params` |
| `runsSteer` | `execution_id`, `message` |
| `runsCompact` | `execution_id`, `request`, `options` |
| `runsCancel` | `execution_id` |
| `runsRespond` | `execution_id`, `response` |
| `configSubscribe` | `kinds`, `subscription_id` |
| `configUnsubscribe` | `subscription_id` |

`specialParams` derives the allowed set from this per-method table; an absent entry has an empty
set and therefore rejects any supplied key (`packages/kernel/src/transport/server.ts`).

`hello` : one-shot (`helloStarted` → `invalid_request` "hello has already started on this
connection"); `wire_version !== CLARVIS_WIRE_VERSION` → `unsupported`; malformed identity
fields → `invalid_request` "hello has invalid identity parameters"; then
`resolveConnection` (or the default context built); if the connection closed while
resolving, the resolved context's `close?.()` is called and `unavailable` is thrown;
otherwise `context` is bound, `helloCompleted` set, and the result assembled with
`context.capabilities ?? capabilities`.

`CLARVIS_WIRE_VERSION` in [wire.ts](../../packages/kernel/src/transport/wire.ts) is the single
revision authority for the kernel RPC over both stdio and local sockets. It is independent of the
private execution RPC revision used between host and guest. Supporting hosted runs additionally
requires the advertised `hosting.host_generation`; opening a transport does not enable that service.
Production: `createKernelServer` and `connectKernelClient` in
[server.ts](../../packages/kernel/src/transport/server.ts) and
[client.ts](../../packages/kernel/src/transport/client.ts). Test: `invalid credentials and
incompatible wire revisions do not receive services` in
[local-transport.test.ts](../../packages/kernel/tests/integration/local-transport.test.ts), and
the hosted-service cases in [hosted-transport.test.ts](../../packages/kernel/tests/integration/hosted-transport.test.ts).

### 4.3 Starting and pumping a run

`runs.start` on the server (`packages/kernel/src/transport/server.ts`): call `services().runs.start(p.params)`; if the
connection closed while awaiting, cancel the handle and throw `unavailable`; otherwise
record `{ handle, resultSettled: false, streamSettled: false }` in `live`, call `pump(handle)`, and
answer `{ execution_id }`.

`pump` (`packages/kernel/src/transport/server.ts`) attaches four things to the handle:

1. `onElicit` → `N.runElicitation` with `{ request }`.
2. An async loop over `handle.events` awaiting `notifications.notify(N.runEvent, …)` per event, whose
   `finally` marks `streamSettled`, releases the `live` entry if both halves settled, and sends
   `N.runStreamEnd`.
3. `handle.done` → `N.runResult`. A rejected `done` is still sent as a result, synthesized as
   `status: "failed"` with `code: "internal"` and a `sanitizeErrorMessage`'d message.
4. `handle.closed` → drop the `live` entry unconditionally.

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
(`packages/kernel/src/transport/server.ts`). The client side is symmetric: `streamingStart` (§4.4) is the same function a
workflow's start goes through, "since the kernel routes a manager run through `runs.start`"
(`packages/kernel/src/transport/client.ts`). Only `workflows.get`/`workflows.list`/`workflows.delete` remain
workflow-specific operations (`OPERATIONS.workflows` in `packages/kernel/src/transport/operations.ts`) — everything else a workflow needs (event
streaming, elicitation, steer/compact/cancel/respond) is the run machinery this section and §4.4-4.5
document, unmodified.

### 4.4 Client-side run handle

`streamingStart` (`packages/kernel/src/transport/client.ts`):

1. `executionId = params.execution_id ?? randomUUID()`.
2. A duplicate live id throws an `Error` carrying `code: "conflict"` **before** any request is sent.
3. Build the bounded event stream. Saturation and abandonment each fire a detached
   `runs.cancel` for this execution.
4. Register the `ClientRun` in `clientRuns` *before* issuing `runs.start` — which is what
   lets a notification emitted during the start call find its run.
5. `await transport.request(methods.start, { params: {...params, execution_id } })`. On a
   throw, `done` resolves as a `failed` result carrying `kerr.code ?? "internal"` and `kerr.message ??
   "run failed"`, the stream closes, `closed` resolves and the entry is deleted.
6. Return the handle whose `steer`/`compact`/`cancel`/`respond` each issue the matching wire request
   with `execution_id` attached, and whose `onElicit` flushes `pendingElicits` on
   attachment.

The service-level `RemoteKernel.runs.compact(executionId, request?, options?)` is a separate wrapper
around the same special method and forwards `options` when supplied
(`packages/kernel/src/transport/client.ts`, the `runs.compact` wrapper). A streaming
`RunHandle.compact(request?)` has no options parameter; mechanical fitting is therefore available
only through the service-level call for a settled run.

### 4.5 Notification demultiplexing (client)

| Notification | Validation | Routing |
| --- | --- | --- |
| `run.event` | `hasOnly(["execution_id","event"])`, string id, `decodeRunEvent(params.event) !== null` (`packages/kernel/src/transport/client.ts`) | `clientRuns.get(id)?.stream.push(event)` |
| `run.result` | `hasOnly(["execution_id","result"])`, `result.execution_id === execution_id`, status in `completed\|failed\|cancelled` | resolve `done`, set `resultReceived`, delete the entry if the stream already ended |
| `run.stream_end` | `hasOnly(["execution_id"])` | close the stream, resolve `closed`, delete the entry if the result already arrived |
| `run.elicitation` | `hasOnly(["request"])`; string `request.id`/`execution_id`/`kind`/`prompt`; when `detail` is present, `isCommandDetail` requires exactly `command`, `cwd`, `reason`, `warning?`, with the first three strings and `warning` absent or a string (`packages/kernel/src/transport/client.ts`, `isCommandDetail` and the `N.runElicitation` observer) | buffer into `pendingElicits` when no handler yet, else fan out |
| `config.change` | `hasOnly(["subscription_id","change"])`, change `hasOnly(["kind","scope","at"])`, kind in `settings\|agents\|context`, finite `at`, scope `global\|workspace` or absent | `configSubs.get(id)?.(change)` |

Every failure calls `protocolViolation(message)`, which is fail-closed: mark closed,
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

`readFrames` (`packages/kernel/src/transport/stdio.ts`) sets `utf8` encoding, accumulates into a string buffer, tracks
`bufferBytes`, and once `invalid` is latched ignores every later chunk. Per chunk: if the
buffer exceeds the cap with no newline in it, drop as `oversize_unterminated` and terminate.
Then per complete line: blank lines are skipped, an over-cap line is `oversize`,
a `JSON.parse` throw is `invalid_json`. `JsonMessageDecoder` reassembles fragmented logical messages
before `decodeFrame` validates their operation envelope. A `decodeFrame` `null` is `invalid_shape`,
and only a complete decoded frame reaches `onFrame`.

### 4.8 NDJSON writing

`createFrameWriter` delegates to `createJsonMessageWriter` in
[json-message.ts](../../packages/kernel/src/core/json-message.ts). The shared logical bound is 64 MiB
of serialized JSON, including envelopes. Messages that exceed the physical line cap use contiguous
256 KiB binary fragments encoded as canonical base64 inside
`{$clarvis_message: {offset, bytes, data}}`. The decoder validates exact keys, contiguous offsets,
stable total, canonical chunk size and complete JSON. One assembly per direction is allowed, with
an absolute 30-second deadline; close releases its buffer and timer. Writers serialize whole
messages, so fragments cannot interleave with later requests, responses or cancellations.

| Check | Outcome |
| --- | --- |
| writer closed or prior physical failure | reject |
| JSON serialization fails | synchronously refuse the unsent call with `invalid_request` |
| logical message exceeds 64 MiB | synchronously refuse with `resource_exhausted` |
| queue full (1 024 messages or 128 MiB serialized JSON) | synchronously refuse with `resource_exhausted` |
| logical transfer stalls | after 30 seconds fail the connection |
| malformed inbound fragment or stream write error | fail the connection |

Local admission refusals preserve the connection and its other requests. A refusal precedes pending
request registration, so a simultaneous local abort cannot publish an unknown cancellation identity.
An excessive handler result produces a bounded error response, waiting for admitted writes to drain
if needed. Physical failures invoke `onFailure` once; queued messages re-check closure before writing.
Test: [json-message.test.ts](../../packages/kernel/tests/contract/json-message.test.ts) and
[stdio-codec.test.ts](../../packages/kernel/tests/contract/stdio-codec.test.ts), including
`transfers the full composer image budget and isolates oversized requests and results`.

### 4.9 Server pump over stdio

`serveKernelOverStdio` (`packages/kernel/src/transport/stdio.ts`, `serveKernelOverStdio`). `close()` aborts every tracked controller with
`new Error("transport closed")`, clears the map, closes the writer and closes the connection. `disconnect()` additionally destroys **both** streams, with the in-source note that
"Normal `close()` leaves caller-owned streams alone. A failed wire cannot: closing both sides is what
makes the peer's `onClose` settle live handles". Per inbound frame :

| Frame | Effect |
| --- | --- |
| anything, after `closed` | ignored |
| `cancel` | `controllers.get(id)?.abort(new Error("request cancelled"))` |
| not `req` | ignored — including `note` |
| `req` with an id already in flight | Disconnect both streams and return, **without dispatching** |
| `req` exceeding 128 in-flight requests or 128 MiB of aggregate serialized request bytes | Return `resource_exhausted` before allocating a controller or invoking a handler; retain other requests |
| admitted `req` | new `AbortController`, dispatch `conn.handle(method, params, signal)`, answer `res` with `result` or `toEnvelope(err)`, `.catch(close)`, `finally` release the controller and byte reservation |

The reservation remains charged through response delivery. Cancellation does not release it before
the handler settles. Input EOF, error and close all disconnect the server side. Production:
`serveKernelOverStdio` in [stdio.ts](../../packages/kernel/src/transport/stdio.ts). Test: `bounds
inbound %s before invoking another handler` and duplicate-id/cancellation cases in
[stdio-codec.test.ts](../../packages/kernel/tests/contract/stdio-codec.test.ts).

### Reconnectable local IPC

`listenLocalKernel` supplies the existing `serveKernelOverStdio` pump with a local duplex socket;
`connectLocalKernelTransport` supplies the same socket to `createStdioTransport`. There is no second
request vocabulary or frame parser. The listener defaults to four clients and a ten-second successful
hello deadline. The client connection timeout defaults to five seconds. Invalid bounds fail before
opening a channel. Listener close releases sockets and connections, not the kernel's own lifetime.

The Unix socket directory must be owned by the current account with mode `0700` and cannot be a
symlink. The adapter never removes an occupied endpoint before listen. Windows uses named pipes
without the `readableAll`/`writableAll` relaxations. A local host composition must supply both
`resolveConnection` and `authorize` to authenticate the account and limit operations; filesystem
placement by itself is not authorization. This adapter alone does not detach or preserve a run.

RPC defines the calls and notifications; local IPC supplies their byte streams. The adapter never
forwards kernel frames to the guest's [private execution RPC](isolated-agent-runtime.md#5-private-execution-and-authority).
`createKernelServer` accepts the kernel catalog only; the local-transport service test rejects
`host.capability` on this endpoint. Hosted-run ownership, durable handoff and observation recovery
belong to [the hosting service](hosted-runs.md#hosted-kernel-rpc), independently of the socket lifetime.

Production: `listenLocalKernel` and `connectLocalKernelTransport` in
[local.ts](../../packages/kernel/src/transport/local.ts). Test:
[local-transport.test.ts](../../packages/kernel/tests/integration/local-transport.test.ts) runs
the existing kernel client/server, a real local connection, a simulated-provider run, reconnection,
credential/version refusal, client limits, handshake expiry and malformed-frame recovery. Native
Windows/macOS IPC qualification is separate from exercising these tests on another platform.

### 4.10 Client transport state machine

Hosted observations use this same transport and catalog. Their connection-local dispatch and
client reconstruction are implemented by `createHostingDispatcher` and `createHostingClient` in
[hosting-server.ts](../../packages/kernel/src/transport/hosting-server.ts) and
[hosting-client.ts](../../packages/kernel/src/transport/hosting-client.ts). Their snapshot cut,
sequence validation, control fencing and reconnect behavior are specified in
[hosted runs](hosted-runs.md#hosted-kernel-rpc). Production: the `hosted` composition in `createKernelServer`
and `connectKernelClient`. Test: the loopback/local parity, early-tail, malformed-tail, lost-handoff,
elicitation and unpromoted-disconnect cases in
[hosted-transport.test.ts](../../packages/kernel/tests/integration/hosted-transport.test.ts).

`terminate` (`packages/kernel/src/transport/stdio.ts`) is idempotent (`closed` guard) and, once: builds an `unavailable`
error from the reason, rejects every pending request after detaching its abort listener, clears the
map, closes the writer and fans out to every `onClose` handler before clearing that set. It is wired
to `readFrames`'s invalid callback (`packages/kernel/src/transport/stdio.ts`) and to `input.end`, `input.error`,
`input.close` and `output.error` (`packages/kernel/src/transport/stdio.ts`).

| State | Event | Next | Effect |
| --- | --- | --- | --- |
| open | `request(m,p)` | open | `++seq`, register pending, `writer.send({t:"req",…})`; a send rejection calls `terminate` |
| open | `request` with an already-aborted signal | open | reject `cancelled` "request cancelled" immediately, no frame |
| open | signal aborts | open | delete the pending entry, send `{t:"cancel",id}`, reject `cancelled` |
| open | `res` with a known id | open | resolve `result`, or reject `fromEnvelope(error)` |
| open | `res` with an unknown id | open | silently ignored |
| open | `note` | open | fan out to that method's handlers |
| open | any invalid frame / EOF / stream error | closed | `terminate`: all pending reject `unavailable` |
| closed | `request` | closed | reject `unavailable` "transport closed" |
| closed | `notify` | closed | no-op |
| closed | `close()` | closed | idempotent |

### 4.11 Notification channel (server)

`createNotificationChannel` (`packages/kernel/src/transport/server.ts`) is a serialized, bounded queue with three states
`open | failed | closed`. `notify` returns a resolved promise when not open,
measures the frame with `JSON.stringify({method, params})` and fails the channel if that throws, fails it if the frame alone exceeds 16 MiB or the queue is at 1 024 frames / 16 MiB, otherwise enqueues and starts the drain if idle. `drain` races the sink's
delivery against a `timeoutMs` timer and an interrupt, and any outcome other than `delivered` other
than `interrupted` calls `stop("failed", reason)`. `stop` fires every
interrupt, drains and resolves every queued notification, and on `failed` calls `onFailure` — which
is `failConnection`, which closes the connection and then calls the transport's
`disconnect` inside a `try/catch` whose comment reads "A broken transport close cannot keep the
kernel connection alive".

`packages/kernel/tests/integration/transport.test.ts` pins that both a *rejecting* and a *stalling* sink
disconnect once, close the host context once, and are called exactly once — the circuit opens
permanently rather than retaining one pending delivery per event.
`packages/kernel/tests/integration/transport.test.ts` pins that `connection.close()` releases a run's event
stream without waiting on an infinite send.

### 4.12 Connection teardown

`KernelConnection.close` (`packages/kernel/src/transport/server.ts`) is idempotent and, in order: close the notification
channel, release hosted observations, `off()` every config subscription and clear the map,
`cancel()` every ordinary connection-owned live handle and clear `live`,
call `context?.close?.()` (releasing the host lease), then release the lifecycle registration. The
connection registers itself with `kernel.lifecycle` at connect time (`packages/kernel/src/transport/server.ts`), so closing the
kernel closes every open connection.
The injected hosted context separately applies the registry's disconnect policy. Its promoted
executions never enter this per-connection `live` map.

### 4.13 Loopback

`createLoopbackTransport` (`packages/kernel/src/transport/loopback.ts`) opens exactly one `server.connect` for its lifetime
 and deep-clones every payload crossing the seam with `JSON.parse(JSON.stringify(v))`,
guarding `undefined`. `request` clones params in and result out; `notify`
dispatches into `conn.handle` detached and discards the result; `close` is idempotent and
fans out to `onClose`.

## 5. Invariants

INV-205–INV-224 are the numbered invariants this document owns; INV-T* are derived here.

**INV-205.** `decodeFrame` fail-closes: `null` for a non-object or primitive, for a `req` with an
extra field, and for a `res` carrying neither or both of `result`/`error`; a request pending when
such a frame — or one past `MAX_WIRE_FRAME_BYTES` — arrives rejects `unavailable`.
Production: `packages/kernel/src/transport/stdio.ts`, `packages/kernel/src/transport/stdio.ts`, `packages/kernel/src/transport/stdio.ts`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts`.

**INV-206.** A server-thrown error crosses the wire with its `code`, `message` and `details` intact,
domain codes such as `resource_exhausted` included.
Production: `toEnvelope` `packages/kernel/src/transport/stdio.ts`, `fromEnvelope` `packages/kernel/src/transport/stdio.ts`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts`.

**INV-207.** An untrusted server error is normalized before crossing: ANSI escapes and terminal
control bytes stripped, the message bounded to 16 384 characters, a credential-shaped detail key
(e.g. `authorization`) redacted to `"Bearer [redacted]"`, and a code the server did not construct
through `kernelError` collapsed to `internal`.
Production: `terminalSafe` `packages/kernel/src/transport/stdio.ts`, `safeErrorDetails` `packages/kernel/src/transport/stdio.ts`, `toEnvelope`
`packages/kernel/src/transport/stdio.ts`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts`. The underlying two rule sets
(`sanitizeDeep`/`sanitizeErrorMessage`) belong to
[cross-cutting/security.md](../cross-cutting/security.md) §5; this invariant is the wire's own
application of them.

**INV-208.** When oversized `details` must be truncated, the reconciliation flags survive:
`outcome_unknown` (boolean) plus the string keys `task_code`, `memory_code`,
`current_revision`, `expectedRevision`, `actualRevision`, each `terminalSafe`'d and sliced to 1 024
characters, and a `truncated: true` marker is added.
Production: `PRESERVED_ERROR_STRING_DETAILS` `packages/kernel/src/transport/stdio.ts`, `preservedErrorDetails`
`packages/kernel/src/transport/stdio.ts`, `packages/kernel/src/transport/stdio.ts`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts`.

**INV-209.** A request queued before `close()` is never written to the output stream.
Production: `packages/kernel/src/transport/stdio.ts` (the in-promise `closed` re-check) and `terminate`'s `writer.close()`
at `packages/kernel/src/transport/stdio.ts`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts`.

**INV-210.** A frame that cannot be JSON-serialized fails its request cleanly with `unavailable`
rather than crashing the transport.
Production: `packages/kernel/src/transport/stdio.ts` (reject) → `packages/kernel/src/transport/stdio.ts` `.catch(terminate)` → `packages/kernel/src/transport/stdio.ts`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts`.

**INV-211.** Every request still pending at input EOF is rejected `unavailable`.
Production: `packages/kernel/src/transport/stdio.ts` (`input.once("end", …)`) → `packages/kernel/src/transport/stdio.ts`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts`.

**INV-212.** Cancelling one in-flight request rejects only that request with `cancelled`, propagates
the abort to the server handler's own signal, and does not close the connection.
Production: client `onAbort` `packages/kernel/src/transport/stdio.ts`; server `cancel` handling `packages/kernel/src/transport/stdio.ts`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts`.

**INV-213.** A duplicate in-flight request id is fatal to the server connection: the handler is
invoked once, the first call's signal is aborted, and the connection closes.
Production: `packages/kernel/src/transport/stdio.ts` combined with `close()`'s controller abort at `packages/kernel/src/transport/stdio.ts`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts`.

**INV-214.** `transport.frame_dropped` names the specific bound: inbound
`oversize_unterminated` / `oversize` / `invalid_json` / `invalid_shape`, outbound
`invalid_request` or `resource_exhausted` for local message admission refusal.
Production: `reportFrameDropped` `packages/kernel/src/transport/stdio.ts`; call sites `packages/kernel/src/transport/stdio.ts`.
Test: `packages/kernel/tests/contract/stdio-codec.test.ts`.

The diagnostic `reason` is local-only. An unsent request's admission error reaches its caller
without closing the connection or publishing a cancellation identity.

**INV-215.** The client handshake rejects a `hello` result with the wrong `wire_version`, an
unexpected extra field, or an invalid nested `workspace.kind`, and closes the transport exactly once
in every case.
Production: `packages/kernel/src/transport/client.ts`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts`.

**INV-216.** When the handshake itself rejects, the transport is still closed exactly once and every
notification observer is detached.
Production: `packages/kernel/src/transport/client.ts` with `detachTransportObservers` `packages/kernel/src/transport/client.ts`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts`.

**INV-217.** `KNOWN_METHODS` holds no duplicate, and every ordinary operation's `invoke` genuinely
reaches the matching service method in catalog order.
Production: `OPERATIONS`, each operation's `invoke`, and `ORDINARY_OPERATIONS`/`KNOWN_METHODS` in
`packages/kernel/src/transport/operations.ts`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts` (each fake service method throws
`RECORDED_OPERATION`, `packages/kernel/tests/helpers/recording-kernel-services.ts`).

**INV-218.** A transport-level cancellation signal reaches the signal-aware service call for
`sessions.listPage` and `workflows.list` unchanged — via a locally-cast widened method signature that
never appears on the public wire `SessionService` contract.
Production: `listSessionPage` and `listWorkflows` in
`packages/kernel/src/transport/operations.ts`, wired at `OPERATIONS.sessions.listPage` and
`OPERATIONS.workflows.list`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts` (session and workflow catalog
cases); `packages/kernel/tests/integration/session-service.test.ts` corroborates from the
service side — the session service itself honors an aborted signal mid-scan, not merely relays it.

**INV-219.** A remote run's `done` settles independently of `events`/`closed`: events keep arriving
until `run.stream_end`, at which point `closed` resolves; a `runs.start` rejection settles `done` as
`failed` carrying the transport's own error code, with `closed` resolved and `events` empty.
Production: `packages/kernel/src/transport/client.ts` and `packages/kernel/src/transport/client.ts`; server side `packages/kernel/src/transport/server.ts`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts`.

**INV-220.** Starting a run whose execution id is already live is rejected `conflict` and does not
replace the first handle.
Production: `packages/kernel/src/transport/client.ts`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts`.

**INV-221.** `steer`/`compact`/`cancel`/`respond` each forward with the handle's own `execution_id`
under the stable names `runs.steer`, `runs.compact`, `runs.cancel`, `runs.respond`.
Production: `packages/kernel/src/transport/client.ts`, names bound at `packages/kernel/src/transport/client.ts`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts`.

**INV-222.** An elicitation emitted before `runs.start` resolves is buffered and delivered to a
handler registered afterwards.
Production: registration of the `ClientRun` before the start request (`packages/kernel/src/transport/client.ts`), the
buffer at `packages/kernel/src/transport/client.ts`, the flush at `packages/kernel/src/transport/client.ts`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts`.

**INV-223.** On transport disconnect every live run handle settles `failed` with an `unavailable`
error carrying the disconnect reason.
Production: `settleRunsUnavailable` `packages/kernel/src/transport/client.ts`, wired at `packages/kernel/src/transport/client.ts`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts`.

**INV-224.** A malformed run-event notification fails the run's `done` as `unavailable` with a
"protocol violation" message and closes the transport — for a bad field type, an incomplete
required-field set, and an inherited object key (`toString`, `constructor`, `__proto__`) used as the
discriminator.
Production: `decodeRunEvent` in `packages/kernel/src/transport/run-event-codec.ts` (its `Object.hasOwn` guard is
what rejects inherited keys), `protocolViolation` `packages/kernel/src/transport/client.ts`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts`.

**INV-T1.** A wire method name is declared exactly once, in `KernelOperation.method`; `M` reads its
values from the catalog rather than restating them.
Production: `packages/kernel/src/transport/wire.ts` (every value is an `OPERATIONS.*.method` or `SPECIAL_OPERATIONS.*.method`),
`KernelOperation.method` in `packages/kernel/src/transport/operations.ts`. Pinned indirectly by the uniqueness assertion at
`packages/kernel/tests/contract/transport-codecs.test.ts`; no test asserts that `M` cannot contain a literal.

**INV-T2.** The `res` error envelope's `code` set is pinned to the protocol union at compile time.
Production: `packages/kernel/src/transport/stdio.ts` (`satisfies Record<KernelErrorCode, true>`) against
`packages/protocol/src/common.ts`. Compile-time only; unpinned by a test.

**INV-T3.** `RUN_EVENT_SCHEMAS` must carry an entry for every `RunEvent` discriminator.
Production: `RUN_EVENT_SCHEMAS` in `packages/kernel/src/transport/run-event-codec.ts`
(`satisfies Record<RunEvent["type"], z.ZodType>`). Compile-time
only — it constrains the **keys**, not the payload shape (see §8).

**INV-T3b.** `tool_input_delta.stream_chars`, when present, is finite;
`tool_input_delta.complete`, when present, is exactly `true`; extra lifecycle fields are
rejected by the strict codec. Production: `RUN_EVENT_SCHEMAS.tool_input_delta`. Test:
`packages/kernel/tests/contract/transport-codecs.test.ts`.

**INV-T3a.** The workflow checkpoint event is strict on both keys and values: its status is one of
the six protocol states; revision, pass and count fields are non-negative integers; the lifetime
limit is positive and not below the started count; current/proposed round/pass and reason are
optional; extra fields are rejected.
Production: `RUN_EVENT_SCHEMAS.workflow_sequence_state`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts` (`preserves the workflow round
checkpoint contract`).

**INV-T4.** A request parameter envelope may carry no key the operation's own encoder does not
produce; the allowed key set is derived once per operation by invoking `encode` with `undefined`
placeholders and memoized in a `WeakMap`.
Production: `decodeOperationParams` in `packages/kernel/src/transport/operations.ts`, enforced at `packages/kernel/src/transport/server.ts`.
Test: `packages/kernel/tests/integration/transport.test.ts` (`listAgents` with `{ unexpected: true }` →
`invalid_request`).

**INV-T5.** A special operation's parameters are checked against a per-method allowlist and must be a
non-array object.
Production: `specialParams` `packages/kernel/src/transport/server.ts`.
Test: `packages/kernel/tests/integration/transport.test.ts` (a string body and an extra key on `runs.cancel`
both `invalid_request`).

**INV-T6.** No ordinary or special operation is served before `hello` completes.
Production: `packages/kernel/src/transport/server.ts`, backed by `services()` `packages/kernel/src/transport/server.ts`.
Test: `packages/kernel/tests/integration/transport.test.ts`.

**INV-T7.** `hello` binds a connection exactly once; a second `hello` is `invalid_request` and does
not re-run `resolveConnection`.
Production: `helloStarted` `packages/kernel/src/transport/server.ts`.
Test: `packages/kernel/tests/integration/transport.test.ts` (asserts `resolutions === 1`).

**INV-T8.** A `hello` whose `wire_version` is missing or differs from `CLARVIS_WIRE_VERSION` is `unsupported`.
Production: `packages/kernel/src/transport/server.ts` (`createKernelServer`) and
`packages/kernel/src/transport/wire.ts` (`CLARVIS_WIRE_VERSION`).
Test: `packages/kernel/tests/integration/transport.test.ts`.

**INV-T9.** `hello` identity fields are validated before `resolveConnection` runs.
Production: `packages/kernel/src/transport/server.ts` precedes.
Test: `packages/kernel/tests/integration/transport.test.ts`.

**INV-T10.** Owner services come only from the host-resolved `hello` context, never from a
caller-supplied workspace parameter.
Production: `packages/kernel/src/transport/server.ts`; `KernelConnectionContext.services` documented as "never
borrowed from the primary kernel" (`packages/kernel/src/transport/server.ts`).
Test: `packages/kernel/tests/integration/transport.test.ts` — a session saved through the wire is readable
under the *authenticated* owner and `null` under the caller-requested one.

**INV-T11.** `opts.authorize` sees the catalog's `metadata`, is not consulted for `hello`, and an
unknown method is `invalid_request` rather than a policy question.
Production: `packages/kernel/src/transport/server.ts`, `packages/kernel/src/transport/server.ts` (the `special !== SPECIAL_OPERATIONS.hello`
guard), `packages/kernel/src/transport/server.ts`.
Test: `packages/kernel/tests/integration/transport.test.ts`.

**INV-T12.** A config subscription whose authorization completes after the connection closed is
never installed, and an authorization hop cannot resurrect a closed connection.
Production: the post-await `assertConnectionOpen()` at `packages/kernel/src/transport/server.ts`.
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
a client's ordinary connection-owned handles then settle `unavailable`. Hosted observations reject
their unfinished waits without inventing a root result, as specified in [hosted runs](hosted-runs.md#hosted-kernel-rpc).
Production: `createNotificationChannel` `packages/kernel/src/transport/server.ts`, `failConnection` `packages/kernel/src/transport/server.ts`.
Test: `packages/kernel/tests/integration/transport.test.ts`.

**INV-T16.** `connection.close()` does not wait on an in-flight notification send; an ordinary
connection-owned run's event stream is released and its handle cancelled. Hosted runs instead
release the connection's observation and apply the registry's committed disconnect policy.
Production: `stop`'s interrupt fan-out `packages/kernel/src/transport/server.ts`, `close` `packages/kernel/src/transport/server.ts`.
Test: `packages/kernel/tests/integration/transport.test.ts`.

**INV-T17.** The loopback transport deep-clones every payload in both directions, so neither side can
retain a mutable reference into the other's state.
Production: `packages/kernel/src/transport/loopback.ts`.
Test: `packages/kernel/tests/unit/loopback-transport.test.ts` (mutating the caller's object after `notify`
leaves the observed params at the pre-mutation value).

**INV-T18.** `transport/` must not import file-backed composition (`/adapters/`, `file-kernel`).
Production: the absence of such imports in `transport/*.ts`.
Test: `packages/kernel/tests/architecture/dependency-direction.test.ts`.

**INV-T19.** An ordinary operation whose service returns `undefined` answers `{}` on the wire.
Production: `packages/kernel/src/transport/server.ts`. Unpinned by a direct assertion.

**INV-T20.** `serveFileKernelOverStdio` refuses at construction a logger writing to the same file
descriptor as the NDJSON wire.
Production: `refuseLoggerOnWire` `packages/kernel/src/serve.ts`, called first at `packages/kernel/src/serve.ts`.
Test: `packages/kernel/tests/integration/serve.test.ts` — `describe("serveFileKernelOverStdio refuses a logger
bound to its own wire", …)`. The composition around it belongs to the kernel-bootstrap document.

**INV-T21.** A Tasks operation's client-supplied `AbortSignal` is extracted by the operation's own
`requestOptions`, not by widening the parameter envelope: `taskRequestOptions` turns a caller's
`{ signal }` into the transport `request`'s third argument, wired on every operation under
`OPERATIONS.tasks` in `packages/kernel/src/transport/operations.ts`.
This is distinct from INV-218's mechanism, under which `sessions.listPage`/`workflows.list` thread a
signal into `invoke` server-side with no client-side `requestOptions` involved at all. Opaque
cursor/id fields inside a Tasks operation's `input` (e.g. `next_cursor`) pass through the wire
unmodified.
Production: `taskRequestOptions` in `packages/kernel/src/transport/operations.ts`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts` — `tasks.create`'s `request_id`/
`provider_key` round-trip byte-for-byte, and `tasks.search` both preserves an opaque `next_cursor`
and forwards a caller's `AbortSignal` as `options: { signal }` on the wire request.

**INV-T22.** Every Extension Profile service method is an ordinary operation and is classified with
`sensitivity: "plugins"`; observation methods are reads, while selection and definition mutations
are writes. This lets a remote host apply the same executable-extension authorization boundary to
plugins and Extension Profiles without inspecting payloads. Production:
`packages/kernel/src/transport/operations.ts` (`OPERATIONS.extensionProfiles`). Test:
`packages/kernel/tests/contract/transport-codecs.test.ts` ("classifies every Extension Profile operation
as plugin-sensitive with exact read/write access").

## 6. Failure modes and degradation

### 6.1 Error codes emitted by this subsystem

| Code | Raised at | Situation |
| --- | --- | --- |
| `unavailable` | `packages/kernel/src/transport/server.ts` | any dispatch on a closed connection |
| `unavailable` | `packages/kernel/src/transport/server.ts` | connection closed while `hello` / `runs.start` was awaiting |
| `unavailable` | `packages/kernel/src/transport/stdio.ts` | transport terminated, or a request after close |
| `unavailable` | `packages/kernel/src/transport/client.ts` | a live run settled by disconnect or protocol violation |
| `unauthorized` | `packages/kernel/src/transport/server.ts` | call before `hello` completed |
| `unauthorized` | `packages/kernel/src/transport/server.ts` | host policy denied the operation |
| `invalid_request` | `packages/kernel/src/transport/server.ts` | special params not an object / unknown key |
| `invalid_request` | `packages/kernel/src/transport/server.ts` | ordinary parameter envelope refused |
| `invalid_request` | `packages/kernel/src/transport/server.ts` | second `hello`, or bad identity fields |
| `invalid_request` | `packages/kernel/src/transport/server.ts`, `M.runsCompact`; `packages/kernel/src/runs/run-service.ts`, `createRunService`'s `compact` | mechanical target supplied for a connection-live run, or a non-positive/non-integer target supplied after delegation |
| `invalid_request` | `packages/kernel/src/transport/server.ts` | unknown method |
| `unsupported` | `packages/kernel/src/transport/server.ts` (`createKernelServer`) | `wire_version` differs from `CLARVIS_WIRE_VERSION` |
| `conflict` | `packages/kernel/src/transport/server.ts` (config subscribe case) | duplicate subscription id |
| `conflict` | `packages/kernel/src/transport/client.ts` | duplicate live execution id, client-side |
| `not_found` | `packages/kernel/src/transport/server.ts`, `liveOrThrow` | steer/cancel/respond target absent or result-settled on this connection |
| `not_found` | `packages/kernel/src/transport/server.ts`, `M.runsCompact`; `packages/kernel/src/runs/run-service.ts`, `createRunService`'s `compact` | compact target absent from owner persistence after connection-live release, or a terminal live handle whose compaction channel has already closed |
| `cancelled` | `packages/kernel/src/transport/stdio.ts` | request aborted before or during flight |
| `internal` | `packages/kernel/src/transport/stdio.ts` | any thrown value whose `code` is not a `KernelErrorCode` |
| `internal` | `packages/kernel/src/transport/server.ts` | a rejected `handle.done`, reported as a failed `RunResult` |

### 6.2 What degrades vs. what fails hard

**Fails hard (connection dies).** Any structurally invalid inbound frame, an over-cap frame, a
non-JSON line, an invalid or interleaved message fragment, a duplicate in-flight request id, a
30 s stalled transfer, an inbound EOF or stream error. All of these route to
`terminate`/`disconnect` and settle every pending request `unavailable`
(`packages/kernel/src/transport/stdio.ts`).

**Refuses one request.** Local serialization, logical-size and queue admission failures do not send
bytes or close the connection. An excessive handler result returns a bounded error; inbound
request saturation also refuses just the excess request while retaining admitted work.

**Fails hard (client side).** Any notification whose payload fails validation — including a run event
whose schema does not accept it — calls `protocolViolation`, which closes the transport
(`packages/kernel/src/transport/client.ts`). This is the fail-closed choice: an unrecognised event is never
dropped silently.

**Fails hard (one connection, not the process).** A notification sink that rejects, stalls past
`notificationTimeoutMs`, produces an unserializable payload, or overflows the queue permanently
opens the circuit and disconnects that connection (`packages/kernel/src/transport/server.ts`).

**Degrades.** A `res` for an unknown id is ignored (`packages/kernel/src/transport/stdio.ts`). A `note` on the server's input is
ignored (`packages/kernel/src/transport/stdio.ts`). An unsubscribe for an unknown id is a no-op (`packages/kernel/src/transport/server.ts`).
`safeErrorDetails` returns `undefined` and drops the details entirely if bounding or sanitizing
throws (`packages/kernel/src/transport/stdio.ts`); `preservedErrorDetails` returns `{}` on any property-descriptor throw
(`packages/kernel/src/transport/stdio.ts`). Error details are bounded to depth 16, 1 024 nodes and 64 KiB before any
recursive sanitizer sees them (`packages/kernel/src/transport/stdio.ts`, `packages/kernel/src/core/bounded-json.ts`).

**Detached, logged, never retried.** Subscribe, unsubscribe, saturation-cancel, abandonment-cancel
and loopback `notify` all go through `detachObserved` with an `observationSink`
(`packages/kernel/src/transport/client.ts`, `connectKernelClient`'s `protocolViolation`,
`streamingStart`, and `config.subscribe`; `packages/kernel/src/transport/loopback.ts`,
`createLoopbackTransport`'s `notify`).
The sink stamps a fixed event name and the message "a detached kernel operation failed; nothing
retries it, and whatever it was releasing may still be held" (`packages/kernel/src/core/observed.ts`). Names
used here: `transport.close_failed`, `transport.cancel_failed`, `transport.subscribe_failed`,
`transport.unsubscribe_failed`, `transport.notify_failed`.

**Client run-event backpressure.** The client's stream is bounded at 1 024 events / 8 MiB
(`packages/kernel/src/transport/client.ts`); when it saturates on non-droppable items, or when the consumer abandons the
iterator, the client cancels the run remotely (`packages/kernel/src/transport/client.ts`). The coalescing/droppability
policy itself belongs to **kernel-run-service-and-events**.

**No retries anywhere.** Neither transport retries a frame, a request or a notification.

### 6.3 Authentication and operation policy

The generic server keeps both policy hooks optional for process-owned stdio embedding.
Without `resolveConnection`, hello validates but does not authenticate its optional token and
returns no principal. Its default services explicitly replace local subscription controls with
`createUnavailableProviderAuthService`. Without `authorize`, operations are permitted after hello.
A socket embedder must provide both identity resolution and operation authorization.

`createFileRunHost` supplies both hooks. Its required verifier resolves only an operator or observer
role; the host fixes owner/workspace independently of request fields. Every operation checks the live
connection role and the catalog's `access` and `sensitivity`. Operators can use the local kernel
services, including the host's subscription manager. Observers can use only non-sensitive reads;
knowing an execution id grants no control. Disconnect removes that connection's role before cleanup.
Its hosting service also prevents ordinary starts and unfenced active-run compaction from bypassing
conversation admission. The owning contract is
[hosted file composition](hosted-runs.md#file-kernel-composition).

Production: `KernelServerOptions`, `defaultContext` and both dispatch paths in
[server.ts](../../packages/kernel/src/transport/server.ts);
`createFileRunHost` in [file-host.ts](../../packages/kernel/src/hosting/file-host.ts).
Test: [transport.test.ts](../../packages/kernel/tests/integration/transport.test.ts) pins the generic
authorization hook and disabled remote subscription control;
[file-run-host.test.ts](../../packages/kernel/tests/integration/file-run-host.test.ts) verifies
authenticated file-host connections, observer restrictions and coordinated admission over a real
local socket.

Secret values flow only from client to kernel on `secrets.set`; listing exposes names and there is no
wire getter. These input bytes are intentionally preserved, while framing logs record metadata only.
Authentication/authorization do not encrypt a transport. The stdio binary trusts the process pipes;
`serveLocalFileKernel` protects the private endpoint/credential store and fences requests by its
lease; `connectOrLaunchLocalKernel` authenticates discovery through the same RPC handshake.
Code's workspace manager connects to that process composition. Its state belongs outside guest mounts and
agent-readable roots. The generic server must not be exposed on a network by assuming that a successful
unauthenticated hello established a principal.

Production: `OPERATIONS.secrets` in
[operations.ts](../../packages/kernel/src/transport/operations.ts),
`serveFileKernelOverStdio` in [serve.ts](../../packages/kernel/src/serve.ts), and the
`SecretService` contract in [secrets.ts](../../packages/protocol/src/secrets.ts). The caller-supplied
authentication requirement of the IPC listener remains in
[local.ts](../../packages/kernel/src/transport/local.ts).
The independent host implementation and process-level evidence are owned by
[hosted runs](hosted-runs.md#independent-process-composition); adding a launcher does not add another
wire protocol or replay interrupted mutations.

## 7. Coupling

### 7.1 Outbound (what this subsystem depends on)

| Target | Kind | Forced by |
| --- | --- | --- |
| `@clarvis/protocol` (`KernelTransport`, `KernelClient`, all service interfaces, `RunEvent`, `KernelError*`) | type-only | imports in `packages/kernel/src/transport/operations.ts`, `packages/kernel/src/transport/client.ts`, `packages/kernel/src/transport/server.ts`, `packages/kernel/src/transport/stdio.ts`, `packages/kernel/src/transport/wire.ts`, `packages/kernel/src/transport/loopback.ts`, and `packages/kernel/src/transport/run-event-codec.ts` — every one is `import type` |
| `zod` | runtime | `packages/kernel/src/transport/run-event-codec.ts` — the only third-party runtime dependency in `transport/` |
| `@clarvis/capability` (`NOOP_LOGGER`, `Logger`, `sanitizeDeep`, `sanitizeErrorMessage`, `detachObserved`, `suppressSecondaryRejection`) | runtime | `packages/kernel/src/transport/stdio.ts`, `packages/kernel/src/transport/server.ts`, `packages/kernel/src/transport/client.ts`, `packages/kernel/src/transport/loopback.ts` |
| `node:crypto` (`randomUUID`) | runtime | `packages/kernel/src/transport/client.ts` |
| `node:stream` (`Readable`, `Writable`) | type-only | `packages/kernel/src/transport/stdio.ts` |
| `../core/bounded-json.ts` | runtime | `packages/kernel/src/transport/stdio.ts` |
| `../core/errors.ts` (`kernelError`) | runtime | `packages/kernel/src/transport/server.ts` |
| `../core/event-stream.ts` | runtime | `packages/kernel/src/transport/client.ts` |
| `../core/observed.ts` | runtime | `packages/kernel/src/transport/client.ts`, `packages/kernel/src/transport/loopback.ts` |
| `../runs/coalesce-events.ts` | runtime | `packages/kernel/src/transport/client.ts` |
| `../kernel.ts` (`InProcessKernel`) | **type-only** | `packages/kernel/src/transport/server.ts` — the kernel instance arrives as an argument, so `server.ts` holds no runtime edge to kernel composition |

`operations.ts` imports the fifteen service interfaces purely as types and derives `KernelServices`
as a `Pick` of `KernelClient` (`KernelServices` in `packages/kernel/src/transport/operations.ts`). That `Pick` is the type constraint that forces
the catalog to stay exhaustive: `serviceOperations<Service>` demands an entry for every async method
of the service it is given (`ServiceOperations` and `serviceOperations` in the same file).

### 7.2 Inbound (what depends on this subsystem)

| Consumer | Edge |
| --- | --- |
| `packages/kernel/src/index.ts` | re-exports the public surface |
| `packages/kernel/src/serve.ts` | `createKernelServer` + `serveKernelOverStdio`, the stdio host |
| `packages/kernel/src/hosting/file-host.ts` | authenticated FileKernel, session coordinator and hosted registry through the same RPC server |
| `packages/kernel/src/bin.ts` | the `clarvis-kernel` binary, through `serveFileKernelOverStdio` |
| `tests/contract/*`, `tests/integration/transport.test.ts`, `tests/integration/stdio-transport.test.ts`, `tests/unit/loopback-transport.test.ts` | the only exercisers of the client half in-repo |

`packages/code` and `packages/server` contain **no** reference to `connectKernelClient`,
`createLoopbackTransport`, `createKernelServer`, `createStdioTransport` or `serveKernelOverStdio`
(searched across both packages' `src`).

### 7.3 The direction the code forces

- `transport/` may not import `/adapters/` or `file-kernel`
  (`packages/kernel/tests/architecture/dependency-direction.test.ts`), so the wire is composable over any
  kernel instance.
- `server.ts` takes `InProcessKernel` only as a type and reads five members from it —
  `capabilities`, `project`, `workspace`, `operatorServices`, `defaultOwnerServices`
  (`packages/kernel/src/transport/server.ts`) — plus `lifecycle.register` (`packages/kernel/src/transport/server.ts`, contract at
  `packages/kernel/src/application/lifecycle.ts`).
- `client.ts` never imports `server.ts`, and `server.ts` never imports `client.ts`; the two meet only
  through `wire.ts` and `operations.ts`.
- `loopback.ts` and `stdio.ts` both import `KernelServer` as a **type** (`packages/kernel/src/transport/loopback.ts`,
  `packages/kernel/src/transport/stdio.ts`), so a transport can host any structurally compatible server.

## 8. Open questions

~~**A confirmed schema drift: `run_ended.code` is rejected by the client codec.**~~ **Resolved.**
The diagnosis held exactly as written. The protocol declared `code?: string`
(`run_ended` in `RunEvent`), the kernel's engine mapper emitted it whenever the trace
entry carried one (`packages/kernel/src/runs/map-events.ts`), and
`RUN_EVENT_SCHEMAS.run_ended` was `.strict()` over `type/at/status/reason` alone — so a failed run's
error code decoded to `null`, the client read that as a protocol violation, and one field nobody had
ever round-tripped settled every live run `unavailable` and closed the transport. The
`RUN_EVENT_SCHEMAS.run_ended` schema now declares `code: text.optional()`, and
`packages/kernel/tests/contract/transport-codecs.test.ts` — "carries a failed run's error code
instead of killing the connection" — holds both halves: the event survives `decodeRunEvent`
unchanged, and the transport's `closeCount` stays `0`. The field's own remark now states what it is
for (`run_ended.code` in `RunEvent`): a resumed session is rebuilt from the persisted trace
alone, so without it a run that failed came back saying only that it had failed. **Why** it reached
the protocol without the codec is still not in the code, and no longer needs to be.

The sentence of the original that is now false — deliberately — is "the compiler cannot see this". It
could not, because `satisfies Record<RunEvent["type"], z.ZodType>`
on `RUN_EVENT_SCHEMAS` constrains the table's key set and never a payload's shape.
`CodecFieldDrift` now compares every
variant's declared field names against its schema's inferred ones in **both** directions, and
`AssertNoDrift` fails to compile on any mismatch, naming the variant
and the drifted field. A field added to `RunEvent` and forgotten in the codec — or the reverse — is a
build error rather than a session that ends the first time the field appears on the wire.

The trap for whoever edits that type next is recorded on `RunEventVariant`.
`Extract<RunEvent, { type: K }>` is the obvious spelling of "the variant whose discriminator is `K`"
and it is the wrong one: a member may declare a *union* discriminator, a union is not assignable to
one of its own literals, so `Extract` answers `never`, `keyof never` widens to
`string | number | symbol`, and the guard reports drift on a variant that has none. `RunEventVariant`
 asks instead whether `K` is one of the member's own types, which is the question that
survives a shared member. One correction to that remark, which names two such members: `RunEvent`
carries exactly one today — `delegation_completed | delegation_failed`
(`RunEvent` in `packages/protocol/src/runs.ts`). The "workflow pair" it also names does not exist; every
`workflow_*` member declares a single literal, and the codec
gives each its own schema. The trap is real and the guard is right to avoid `Extract`; only the
count is off.

**`notify`'s cross-transport asymmetry is dead surface, not an undecided design.** `createStdioTransport.notify`
writes a `note` frame (`packages/kernel/src/transport/stdio.ts`) that `serveKernelOverStdio` discards, because it
only handles `cancel` and `req` (`packages/kernel/src/transport/stdio.ts`, itself documented: "Non-`req` frames on the
input are ignored"). `createLoopbackTransport.notify` instead dispatches straight into `conn.handle`
(`packages/kernel/src/transport/loopback.ts`) — the *same* dispatch path `request()` uses — so, unlike stdio, it would
actually execute whatever real `KernelServer` operation the method name happens to name, with side
effects, before discarding the result. This is a genuinely divergent implementation of one interface
member, but it has no live consequence today: a repo-wide search of `packages/kernel/src`,
`packages/code/src` and `packages/server/src` for a client-side call to `KernelTransport.notify`
(as opposed to the unrelated `deps.notify`/UI toast helper of the same name in `@clarvis/code`, or the
*server-side* `notifications.notify` used to push `run.event`/`config.change`/etc. — `packages/kernel/src/transport/server.ts`)
finds none; the only exerciser is `packages/kernel/tests/unit/loopback-transport.test.ts`'s isolated unit test. §7 of
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
(`decodeRunEvent` decoding the type at `packages/protocol/src/runs.ts`'s closed
`RunEvent` union). `config.change` applies `hasOnly` to its nested payload because `ConfigChange` is a
closed, fixed-key shape over a closed enum (`ConfigChangeKind`, `packages/protocol/src/config.ts`).
`run.elicitation` applies `hasOnly` only at the top level and checks four scalar fields of `request`
without constraining its key set (`packages/kernel/src/transport/client.ts`) precisely because `ElicitationRequest`
is declared open on purpose: `kind` is `"ask_user" | "guard_confirm" | "plan_review" | "workflow_review"
| (string & {})`, documented "so a kernel may add kinds without a protocol bump" |
(`ElicitationRequest.kind` in `packages/protocol/src/runs.ts`), and `schema` is `JsonSchema = Record<string, unknown>`, documented "a JSON
Schema passed through opaquely" (`packages/protocol/src/common.ts`). Applying a closed `hasOnly` to `request`
today would reject a future `kind`'s legitimate extra fields, defeating the exact extensibility `kind`
was made open for — so the omission is the correct reading, not an arbitrary weakening.

~~**One narrower residual is not explained by either the open-`kind` or opaque-`schema` reasoning:
`ElicitationRequest.detail` gets no structural check at all — not even `isRecord`.**~~ **Resolved.**
The residual was correctly identified, and the argument for closing it was weaker than
the case deserved. `detail` (`ElicitationCommandDetail` in `packages/protocol/src/runs.ts`, carrying
`command`/`cwd`/`reason`/`warning?`) shares neither property that keeps the request around it open,
so a nested `hasOnly` costs nothing in forward-compatibility — but "it costs nothing" is not why it
has to be there. `detail` is what a human reads when approving a command, and its TSDoc tells clients
to render it directly rather than parse `prompt`, so a `detail` whose `command` is absent
or not a string reaches an approval dialog as `undefined` and the approval is then given for a
command nobody was shown. That is the reasoning now recorded at `isCommandDetail`
(`packages/kernel/src/transport/client.ts`), which checks the closed key set and every
member's type and is consulted only when `detail` is present. `kind` and
`schema` stay untouched, for exactly the reasons above. Five malformed shapes — not a record, a
missing `command`, a non-string `command`, a non-string `warning`, an unknown key — close the
transport fail-closed under `it.each` at
`packages/kernel/tests/contract/transport-codecs.test.ts` ("closes fail-closed on a
guard_confirm detail with %s"), with a well-formed `detail` delivered intact and a
control asserting that an unknown `kind` and an opaque `schema` still pass through
unexamined.

**`transport.frame_dropped` with `reason: "serialization"` is unpinned.** It is emitted at
`packages/kernel/src/transport/stdio.ts` and is the only one of the six reasons absent from the drop-reason suite
(`packages/kernel/tests/contract/stdio-codec.test.ts`). INV-210 covers the *behaviour* (a clean
`unavailable`) but not the log record.

**`decodeOperationParams` validates only the key set** — it checks no required key is missing and no
value's type; `invoke` then casts (`decodeOperationParams` and `OPERATIONS` in
`packages/kernel/src/transport/operations.ts`). The function's TSDoc claim that "domain services
remain responsible for their nested DTOs" is not merely asserted: it is verified true
for at least two representative operations, one on each side of the read/write split. `runs.start`'s
`invoke` passes the cast params straight into `startReserved` → `assembleRunRequest` →
`executeRun({ rawBody, … })` (`packages/kernel/src/runs/run-service.ts`), and `executeRun` calls
`validateBody(rawBody, deps.env, requestRegistry)` before doing anything else with it
(`packages/loop/src/runtime/execute-run.ts`) — a real schema pass, exercised by
`packages/loop/tests/component/request-schema-facade.test.ts` and others. `config.updateSettings`'s
`invoke` reaches `ConfigService.updateSettings`, whose merge closure runs
`kernelSettingsSchema.safeParse(next)` and throws `invalid_request` on failure
(`packages/kernel/src/config/config-service.ts`). So the two-layer design the TSDoc describes is real,
not aspirational: the transport layer's job is exactly and only the closed top-level envelope (which
`decodeOperationParams` does check), and the domain service one layer down is where wrong-typed values
are actually rejected — with its own dedicated tests, not the transport's. No test *at the
`operations.ts` layer* pairs a well-keyed envelope with wrong-typed values, but that absence reflects
where the corpus's tests are organized (one layer down, per operation), not an unsettled question about
whether such validation happens at all.

The notification channel retains its independent 16 MiB aggregate backpressure budget in
`createKernelServer`. This also applies to loopback, which has no physical framing. On stdio,
notifications within that channel budget can exceed the 8 MiB physical frame cap and travel as
fragments under the common 64 MiB logical-message contract. Exhausting the notification stream's
own budget still fails that connection rather than silently dropping ordered events.
Production: `createKernelServer` in [server.ts](../../packages/kernel/src/transport/server.ts) and
`createStdioTransport` in [stdio.ts](../../packages/kernel/src/transport/stdio.ts). Test:
[stdio-codec.test.ts](../../packages/kernel/tests/contract/stdio-codec.test.ts).

**Deliberately delegated.**
- The DTO shapes every method carries, and `KernelClient`'s fifteen services →
  **protocol-kernel-contract**.
- Which run events exist, what they mean, and the coalescing/droppability policy behind
  `DEFAULT_RUN_EVENT_BUFFER` → **kernel-run-service-and-events**.
- The redaction rule set behind `sanitizeDeep`/`sanitizeErrorMessage` and what "credential-shaped"
  means → **security-confinement-and-redaction**.
- `createFileKernel`, the Code host's single-workspace lifetime wrapper and the authenticated
  `createFileRunHost` composition → [kernel composition](kernel-composition.md) and
  [hosted runs](hosted-runs.md). The hosted file composition supplies both connection policy hooks.
