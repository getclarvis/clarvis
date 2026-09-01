# `@clarvis/protocol`

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
implements an in-process client, a loopback client and stdio transport.

## Services

`KernelClient` carries the connected `project`/`workspace` identity and groups fifteen asynchronous
services:

| Service        | Responsibility                                                                         |
| -------------- | -------------------------------------------------------------------------------------- |
| `runs`         | Start, stream, steer, compact live or settled context, inspect and delete runs.        |
| `config`       | Settings, agent documents and context documents.                                       |
| `environments` | Exact inventory, definition, composition preview and selection of active extensions.   |
| `plugins`      | Installed plugins, atomic contributions, capability services and lifecycle operations. |
| `secrets`      | Server-side provider secret names and writes.                                          |
| `models`       | Model metadata and pricing catalog.                                                    |
| `providerAuth` | Token-free local subscription status, device login and disconnect control.             |
| `files`        | Read-only workspace file and image access.                                             |
| `memory`       | Owner-facing execution-memory review and curation.                                     |
| `plans`        | History from the workspace's selected plan provider.                                   |
| `workflows`    | Agentic workflows: a manager run fanning out leaders.                                  |
| `skills`       | Skill listing and prompt rendering.                                                    |
| `sessions`     | Workspace-scoped conversation/session records.                                         |
| `tasks`        | Provider-neutral external task discovery, mutation and transition previews.            |
| `storage`      | Metadata-only local inventory and confirmed cleanup of disposable artifacts.           |

All DTOs are protocol-owned projections. Engine-internal trace, memory and
configuration types do not cross this boundary.

`EnvironmentService` is the control plane for deterministic activation of already-installed
extensions. Custom definitions are complete allow-lists of exact `{ scope, source, name }` plugin
installations and standalone skills; `builtin:default` is immutable builtin activation behavior.
`.agents/plugins` and `.clarvis/plugins` are equally representable. Selection and clear
mutations require scope-bound delta previews. Guided composition reads the qualified installed
inventory, resolves a complete draft, and applies its definition plus selection through one
single-use preview token; the service still never installs anything. Global operator-owned plugins
need no workspace approval, while `requires_workspace_trust` identifies a target carrying
repository-owned `scope: "workspace"` plugins when their single workspace-wide inventory
fingerprint is not trusted. The full format, selection precedence, snapshot and trust contract is in
[`hosts/environments.md`](../../specs/hosts/environments.md).

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

Wire contract 2 is negotiated exactly in the opening hello. Unknown versions and malformed or
extra envelope fields fail closed. Stdio uses strict newline-delimited frames capped at 8 MiB and a
serialized bounded writer; malformed JSON, oversized frames and stalled/backpressured output close
the connection instead of being skipped.

Run completion has two independent notifications: `run.result` settles `RunHandle.done`, while
`run.stream_end` closes the ordered event iterable after its bounded tail drains and settles
`RunHandle.closed`. A result never silently discards a final event. Hosts use `closed` to release
run and owner leases without attaching a second consumer to the single-consumer `events` stream.
Remote client buffers cap at 1,024 events, coalesce compatible deltas, discard only variants
classified as droppable by kernel policy, and cancel/fail the run if structural events alone
saturate the buffer. A handle may also expose `buffered()`: optional O(1) counters for buffered
items, estimated bytes and dropped events. The counters are diagnostic metadata, not another event
consumer and not a transport compatibility requirement.

Capability-owned event names do not reopen the public `RunEvent` discriminator. The kernel maps
them to the closed `capability_event` variant with bounded, sanitized detail, so an exhaustive
client does not crash when a new capability is installed.

Compaction has an explicit lifecycle on that closed union. `compaction_started` is live-only and
names `scheduled` versus `forced`; the terminal `compaction` event is durable and may carry
`fallback_reason` when summarization degraded to eviction. Clients must not reconstruct an active
operation from replay because start signals are intentionally absent there.

The terminal `tool_call` variant optionally carries `guard`, a strict
`CommandGuardReview` with the final mode, allowed/denied outcome, and answerer.
It is absent for older and unguarded calls and is part of replay when present.

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
