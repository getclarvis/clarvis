# `@clarvis/protocol`

Reviewer configuration carries bounded `guidance`, model, fallback, timeout and retry overrides.
The strict host schema rejects unknown fields; guidance never replaces the host policy.

The transport-agnostic contract between a Clarvis kernel and its UI clients.
This package contains wire DTOs and TypeScript interfaces only.

It deliberately has no dependency on `@clarvis/loop`, no transport
implementation and no server logic. A UI can depend on this package without
importing the agent engine.

> Draft, private, unversioned workspace. The root manifest owns the Clarvis product version; this
> package may change during the beta period.

## Contract

Wire DTOs, service interfaces, capability advertisement, and the transport seam are specified in
[`hosts/protocol.md`](../../specs/hosts/protocol.md). The concrete Clarvis wire and codecs belong to
the kernel and are specified separately in
[`hosts/kernel-transport.md`](../../specs/hosts/kernel-transport.md).

## The client contract

`GoalRun.settlement_preparation` carries host-owned non-final settlement inputs for restart recovery.
It preserves measured usage and activity uncertainty, not completion authority. Client session saves
cannot alter it because it belongs to the protected Goal state.
`GoalUsage.cost_usd`, when present, is the host-priced subtotal of observed calls. The host credits
it with the stage's tokens to the same Session cost total used for ordinary runs; an absent price
does not mean zero cost.

Host-owned `Session.operator_intents` may carry `steering_target`, the execution selected by the host
before delivery. It scopes consumption recovery after restart; client saves cannot rewrite it and
it grants no authority to replay work or approve effects.

Goal stage causes include `finalization_conflict` for a completion snapshot race. This is distinct
from `control_failure`; only the host may decide continuation after physical closure, current
authority checks and budget reconciliation. The DTO alone grants no execution authority.

Goal run records may carry `activity_unavailable`. It distinguishes an unavailable host observation
from a measured absence of progress; clients must not infer `progress_observed: false` from it.
The field grants no continuation, completion or budget authority.

`RunResult` distinguishes a stage checkpoint with `disposition: "checkpoint"` and a bounded
`checkpoint: { summary, next_step }`. It is separate from both run status and a validated final
`result`. Missing disposition retains the ordinary final path; this DTO grants no continuation
authority. Live transport and restored run details carry the same handoff.
The successful `run_ended` event also carries optional `disposition: "final" | "checkpoint"`.
Clients use it to distinguish stage closure from final completion in live and restored transcripts;
its absence means ordinary final completion. Failure and cancellation remain separate statuses.

A failed run's `error` carries the stable `code` and a sanitized `message`, plus the provider's own
classification (`kind`) and requested backoff (`retry_after_ms`) when the failure came from a
provider. `provider_error` is what every provider kind reports unless it earns its own code, so those
two bounded fields are the only way a consumer can tell a retryable fault from a credential, request,
quota or content-policy refusal without parsing prose. Nothing else from the engine's error details
crosses.

A UI programs against one `KernelClient`, obtained from a concrete client implementation.

```ts
import type { KernelClient } from "@clarvis/protocol";

async function listAgents(client: KernelClient): Promise<void> {
  const agents = await client.config.listAgents();
  const runs = await client.runs.list();
  console.log({ agents, runs });
}
```

Concrete clients and transports live outside this package. `@clarvis/kernel`
implements an in-process client, a loopback client, stdio transport and a reconnectable local IPC
adapter using the same RPC framing.

## Services

File-tool configuration uses ordinary runs and concrete `configuration_review` elicitation when required.
Host-owned authority is separate from model-provided parameters and saved transcript content.
`LocalHostStatus.skills_revision` notifies attached clients when the host publishes a skill catalog
generation, allowing command listings to refresh without reconnecting. See
[self-configuration.md](../../specs/hosts/self-configuration.md).

Managed `RunHandle` implementations can return an unsubscribe function from `onElicit` and expose
`onElicitSettled`, which reports by id every question the kernel retired — answered, expired, or torn
down with the run — so a frontend removes that prompt instead of answering it. Hosted observations
carry sequenced event frames and reuse run control methods; they are separate from the single source
event consumer.

A surface that can put a question in front of a human declares how long it may stay open on the run
request (`StartRunParams.elicit_policy`, `ElicitWindowPolicy.ask_user_window_ms`). The kernel then
publishes `ElicitationRequest.window_ms` for the model's own `ask_user` question only, and the
frontend arms that window with `RunHandle.present({ id, presenter })` once the question is really on
screen; the answer is an `ElicitationPresentationAck` carrying the remaining projection, and a
duplicate confirmation never restarts it. An elapsed window is never an answer:
`elicitation_resolved` carries `no_response: "window_elapsed"`, distinct from the operational
`wait_bound_elapsed`. See [elicitation](../../specs/cross-cutting/elicitation.md).

`KernelClient` carries the connected `project`/`workspace` identity and groups asynchronous
services:

| Service             | Responsibility                                                                         |
| ------------------- | -------------------------------------------------------------------------------------- |
| `runs`              | Start, stream, steer, compact live or settled context, inspect and delete runs.        |
| `config`            | Settings, agent documents and context documents.                                       |
| `extensionProfiles` | Exact inventory, definition, composition preview and selection of active extensions.   |
| `plugins`           | Installed plugins, atomic contributions, capability services and lifecycle operations. |
| `secrets`           | Server-side provider secret names and writes.                                          |
| `models`            | Model metadata and pricing catalog.                                                    |
| `providerAuth`      | Token-free local subscription status, device login and disconnect control.             |
| `files`             | Read-only workspace file and image access.                                             |
| `changes`           | Read-only workspace change inventory and unified patch detail.                         |
| `memory`            | Owner-facing execution-memory review and curation.                                     |
| `plans`             | History from the workspace's selected plan provider.                                   |
| `workflows`         | Agentic workflows: a manager run fanning out leaders.                                  |
| `skills`            | Skill listing and prompt rendering.                                                    |
| `sessions`          | Workspace-scoped conversation/session records.                                         |
| `goals`             | Availability, durable goal state, authenticated controls and operation receipts.       |
| `tasks`             | Provider-neutral external task discovery, mutation and transition previews.            |
| `storage`           | Metadata-only local inventory and confirmed cleanup of disposable artifacts.           |

`ModelCatalog.source` can be `cache`, `bundle`, or `projection`. The last denotes immutable logical
execution metadata without provider endpoints or credential names; it does not grant refresh or
subscription authority. See [the catalog contract](../../specs/hosts/protocol.md).

All DTOs are protocol-owned projections. Engine-internal trace, memory and
configuration types do not cross this boundary.
The live-only `tool_control_released` run event identifies a yielded shell call and the exact
control token to revoke when its process settles.
`PlanDocumentDto` carries the provider's parsed controlled fields and ordered extra sections beside
its canonical Markdown, so clients can present complete plan content without parsing the storage format.

`goals` is always present on the client facade. `KernelCapabilities.goals` is optional; absence or
false means unsupported, and the facade exposes that through `goals.availability()` without sending
an unknown operation to an older host. User mutations carry session identity, CAS revision and an
operation ID. A start receipt retains its reserved execution ID across replay. Authenticated native
conversation hosts expose these controls; headless hosts remain unavailable. The concrete transport
and host validate authority separately from the DTO. See [goals](../../specs/capabilities/goals.md).

`goals.subscribe(sessionId, listener)` returns a promise for a disposer. Await it before reading
the initial state. Notifications contain the session ID and may carry bounded ephemeral Goal
formulation activity (`thinking`, `reading`, `searching` or `idle`); activity is presentation-only
and may retain the last workspace action while the model thinks. It is never durable Goal state.
Notifications without activity request another canonical read.
Neither form grants execution authority or announces a completion commit independently of the state.
The host bounds subscriptions and releases them when the connection closes.

`hosting.ts` additionally defines the hosted-run boundary: generation/sequence cursors, immutable
snapshot pages, execution metadata, control epochs, handoff receipts and `HostingService`.
`HostingService.resolveRecovery` is an operator-only confirmation of physical closure for old unknown
work, fenced by generation and revision. Its `HostedRecoveryResolution` is retained on both the
discovery reference and canonical session turn. The `archive` disposition parks the conversation; `continue` permits a successor after the same physical attestation. Neither invents a result or replays the interrupted execution. The durable audit precedes release of physical uncertainty and survives
discovery acknowledgement.
Handoff errors may carry `HostedHandoffFailureDetails`, binding an operation ID to `refused`
or `uncertain` admission. Only an explicit refusal permits a new handoff identity; an absent
classification or missing receipt preserves uncertainty.
`HostingService.controlObservation` acquires or takes over control for an observation already
owned by the connection, preserving its snapshot and stream. It returns the confirmed control
epoch; unrelated observations retain their previous authority.
`KernelClient.hosting` is optional and appears on a remote client only when `hello` advertises
`capabilities.hosting.host_generation`. It uses the kernel RPC catalog and sequenced observation
notifications. Ordinary in-process/stdio composition does not enable a persistent host.
Observation storage and its current implementation scope are specified in
[hosted runs](../../specs/hosts/hosted-runs.md).

`local-host.ts` defines the optional `KernelClient.localHost` operator service, advertised by
`capabilities.local_host`. It carries process state, browser-request claims and explicit runtime
retry/restart operations through the kernel RPC. The service contains no provider credentials;
opening an authorization URL does not approve authorization. Its availability requires hosting
and the local operator role.

Hosted conversation reads include `Session.revision`; the hosted coordinator requires that
observed revision for saves and automatic turn admission. An authenticated operator submission is serialized against current state instead of rejected for a stale display revision. The ordinary file-store contract does not itself
enforce turn/totals ownership. Its optional `Session.goal_state` is host-owned even on ordinary
file-store saves: clients cannot insert, remove or revert it. `goals.ts` defines the independent
goal DTOs, user controls and service contract; defining those types alone does not advertise the
service on a host. Optional `GoalState.creation_intent` is an admitted formulating request: it is
not a Goal and does not authorize implementation. A goal run's optional `progress` contains its latest bounded annotation, separate
from checkpoint disposition and a completion candidate. Optional Steward DTO fields expose its
compact status, pending clarification, bounded review history and separate consumption without importing domain runtime.
They are host-owned audit data, never commands. Lifecycle and mutation rules are specified in
[sessions](../../specs/hosts/sessions.md#host-owned-conversation-transactions).

`ExtensionProfileService` is the control plane for deterministic activation of already-installed
extensions. Custom definitions are complete allow-lists of exact `{ scope, source, name }` plugin
installations and standalone skills; `builtin:default` is immutable builtin activation behavior.
`.agents/plugins` and `.clarvis/plugins` are equally representable. Selection and clear
mutations require scope-bound delta previews. Guided composition reads the qualified installed
inventory, resolves a complete draft, and applies its definition plus selection through one
single-use preview token; the service still never installs anything. Global operator-owned plugins
need no workspace approval, while `requires_workspace_trust` identifies a target carrying
repository-owned `scope: "workspace"` plugins when their single workspace-wide inventory
fingerprint is not trusted. The full format, selection precedence, snapshot and trust contract is in
[`hosts/extension-profiles.md`](../../specs/hosts/extension-profiles.md).

Marketplace installation uses `PluginInstallSource`, a closed union for Git (optional subdirectory,
ref or SHA), confined local directories, and npm packages (optional version and credential-free
HTTPS registry). A source may carry `expected_name`, binding a marketplace listing to the installed
manifest identity and supplying a stable name only when a foreign manifest omits one.
`PluginService.installSource` keeps source interpretation on the client/catalog side and fetch policy
in the kernel. `PluginView.updateable` distinguishes managed Git origins from local, npm, workspace,
and unmanaged installations. `PluginView` preserves the original manifest
publisher/legal/discovery fields and the complete install-surface `interface` projection; it never
substitutes Clarvis as author. `SkillSummary.dependencies` exposes bounded MCP requirements read
from a skill sidecar.

`StorageService` never returns file paths, credential contents or credential sizes. Its cleanup
surface accepts only `temporary` and `cache`, supports dry-run previews, and leaves durable history,
configuration, plans, memory and credentials outside the deletion vocabulary.

`iteration_completed.response_phase` optionally projects the provider-declared assistant lifecycle
phase (`commentary` or `final_answer`). The response text remains authoritative; clients must not
invent prose when the field is absent.

`tool_call_announced` supplies durable actor/call/tool identity with iteration and physical attempt,
without argument contents. The kernel's exact-version transport includes this discriminator;
announcement is neither execution nor approval. UI state never enters this DTO.

`tool_input_delta` is cumulative, not one event per provider fragment. `chars` is call-scoped
argument progress; optional `stream_chars` is the distinct physical provider-stream character
total and may advance while arguments remain unavailable. Its optional `complete: true` closes only
the argument-composition phase; `tool_call_started` still owns actual
execution start and terminal `tool_call` still owns the tool outcome.
A live builtin `shell` may carry `control: { tool_execution_id, actions: ["interrupt"] }`
on start. The operator interrupts that invocation through `RunHandle.interruptTool`
and receives `accepted`, `already_requested`, or `not_running`. The terminal may then
carry `interruption: { source: "operator" }` with `ok: false`. Absence of these
fields keeps the previous contract. A client must not infer that a
prior call ended merely because another tool input starts, because providers may compose calls in
parallel.

`SessionTotals.cached` is likewise optional by meaning, not merely by transport compatibility: a
number, including zero, is a complete measured cache-read total; absence means at least one
contributing run did not report the split. Clients must then keep input gross and omit any derived
cache-hit rate.

Subscription authentication and entitled-catalog DTOs are specified in
[`subscription-providers.md`](../../specs/hosts/subscription-providers.md). They intentionally expose
neither renewable credentials nor provider account header identifiers.

Workflow nodes keep human identity and instructions distinct: `title` is the bounded label used by
lists and trees, while a leader's optional `task` is the complete instruction shown only on demand.
`workflow_run_started` carries both for live projection. The live-only `workflow_title_updated`
event replaces the manager's provisional execution-id label when the parallel metadata call returns;
the workflow store persists that title, so list/get do not depend on replaying the live event.

`WorkflowDetail.sequence` is the latest durable Admiral-controlled round checkpoint. It distinguishes
`running_round` from `awaiting_manager`, carries a compare-and-set `revision`, the current and
proposed round/pass, and cumulative `leaders_started/max_total_leaders`. The matching
`workflow_sequence_state` run event updates the live projection immediately. The field is optional
for legacy records and workflows that used only ad-hoc leaders.

### Revision-bound settings writes and repair

Every `SettingsSource` carries the SHA-256 revision of the exact source bytes, or `null` when the
scope does not exist. `ConfigService.updateSettings` requires that observed revision and performs a
compare-and-swap merge in the kernel. Concurrent editors therefore receive a typed `conflict` and
never overwrite one another. A client serializes its own saves, but the revision remains the
cross-process authority.

`ConfigService.previewSettingsRepair(scope)` returns `null` for a healthy or
absent scope, otherwise a `SettingsRepairPlan`: either invalid dotted paths to
`strip`, or a reason the file must be `reset`. Every plan carries the SHA-256
`revision` of the exact source bytes inspected by the kernel.

After explicit user confirmation, a client passes that revision to
`repairSettings(scope, expectedRevision)`. The kernel recomputes the repair at
write time and returns the refreshed `SettingsView`. If the source changed or
disappeared after preview, the operation rejects with `conflict` and overwrites
nothing. Clients never need to read or parse the server-side path themselves.

## Transport seam

`KernelTransport` is a small request/notification interface:

```ts
interface KernelTransport {
  request<T>(method: string, params?: unknown, options?: KernelRequestOptions): Promise<T>;
  notify(method: string, params?: unknown): void;
  onNotification(method: string, handler: (params: unknown) => void): () => void;
  close(): Promise<void>;
}
```

The framing is JSON-RPC-shaped, but the methods use Clarvis's own vocabulary. This is not MCP.
Stdio, HTTP and WebSocket transports can implement the same interface without changing a UI.

`KernelRequestOptions` carries only an optional `signal`. Cancellation is local transport metadata;
the concrete transport decides how to interrupt the request without serializing the signal into the
wire parameters.

The opening hello requires the exact `CLARVIS_WIRE_VERSION` declared by the kernel's
[`wire.ts`](../kernel/src/transport/wire.ts).
Unknown versions and malformed or extra envelope fields fail closed. Stdio uses strict
newline-delimited frames capped at 8 MiB and a
serialized bounded writer; malformed JSON, oversized frames and stalled/backpressured output close
the connection instead of being skipped.

Ordinary connection-owned runs have two independent notifications: `run.result` settles `RunHandle.done`, while
`run.stream_end` closes the ordered event iterable after its bounded tail drains and settles
`RunHandle.closed`. A result never silently discards a final event. Hosts use `closed` to release
run and owner leases without attaching a second consumer to the single-consumer `events` stream.
Remote client buffers cap at 1,024 events, coalesce compatible deltas, discard only variants
classified as droppable by kernel policy, and cancel/fail the run if structural events alone
saturate the buffer. A handle may also expose `buffered()`: optional O(1) counters for buffered
items, estimated bytes and dropped events. The counters are diagnostic metadata, not another event
consumer and not a transport compatibility requirement. Hosted runs use `hosting.observation`
with distinct event-end, result and physical-closure notes. Losing that observation rejects its
unfinished promises without recording an execution failure; the host retains physical ownership
until teardown and reconciliation complete. See [hosted runs](../../specs/hosts/hosted-runs.md#hosted-kernel-rpc).

Capability-owned event names do not reopen the public `RunEvent` discriminator. The kernel maps
them to the closed `capability_event` variant with bounded, sanitized detail, so an exhaustive
client does not crash when a new capability is installed.

Compaction has an explicit lifecycle on that closed union. `compaction_started` is live-only and
names `scheduled` versus `forced`; the terminal `compaction` event is durable and may carry
`fallback_reason` when summarization degraded to eviction. Clients must not reconstruct an active
operation from replay because start signals are intentionally absent there.

## Contract boundaries

- Deep configuration blocks remain intentionally loose; the kernel owns schema
  validation.
- Secret values may be sent to the kernel but are never returned by list calls.
- Workspace paths are server-side concerns for remote kernels.
- Plan refs identify their backend through `provider_key`; `path` is display-only and optional.
- Task refs identify their backend through `provider_key`; they never carry a repository or path.
- Task mutation DTOs carry a caller request ID, while the authenticated kernel derives owner,
  actor, execution identity and the provider idempotency key.
- Optional features are announced through `KernelCapabilities`.

## Runtime projection

`SandboxInspection.filesystem` reports Host or Sandbox placement, host-visible read scope,
the write boundary, and the effective workspace posture; `effective_network` reports the enforced
network mode. The kernel resolves this doctor snapshot and the UI presents it alongside backend
availability. The optional handshake runtime projection identifies native Host or Sandbox placement
and a ready lifecycle. It is informational; the selected Kernel host owns execution policy.

## Development

The package has no runtime behavior to execute. Its contract suite is compile-time only:
`tests/contract/public-contract.fixture.ts` imports the public type barrel and uses `satisfies` to
exercise representative DTOs, services, handles, transports and a complete `KernelClient`. The
normal `tsconfig.json` includes those fixtures; `tsconfig.build.json` still emits only `src`.

Run commands from the monorepo root:

```bash
bun --filter @clarvis/protocol build
bun --filter @clarvis/protocol typecheck
bun --filter @clarvis/protocol test
bun --filter @clarvis/protocol lint
bun --filter @clarvis/protocol format:check
```

The package requires Bun 1.4.0 or newer.

## Prompt-cache continuity

Run start carries `session_id` and `agent_instance_id`; the hosted session persists `agent_instance_id`. These identify a conversation and one agent instance rather than a profile or physical request. Clients preserve them across turns and resume; a separately created instance gets another ID.

See the [prompt-cache contract](../../specs/cross-cutting/prompt-cache.md) for replay, identity
validation and separate deterministic, live-provider and installed-artifact qualification.

`Session.operator_intents` and `operator_sequence` are bounded host-owned submission receipts and
the conversation's monotonic acceptance sequence. They are separate from admitted `turns`.
`Message.steering_id` correlates steering with the optional `steering_applied.id`; it is not model
message content. Goal receipts distinguish a recorded pending recovery from admitted work.

`GoalControlAction.edit.resume_operation_id` explicitly links a limit correction to a retained resume. Usage gaps optionally carry bounded `call_ids` and a sequence fingerprint.

Accepted pending input can be resumed through `HostingService.resumePending(sessionId)` using the
current authenticated operator connection. The Kernel reads canonical receipts and uses its existing
idempotent admission queue; it restores no old consent or physical-closure claim. Code requests this
when reopening an idle conversation and attaches to the admitted run. Recovery failure leaves the
saved history readable. A restart without a new controller still waits for authority.
