# Isolated agent runtime

## 1. Current status

Clarvis owns a fail-closed isolated execution backend beneath the host kernel. Runtime selection is
a host composition decision rather than a public `KernelClient` service: native startup does not
inspect an engine, while a configured Podman or Docker backend mounts the workspace already selected
by the host, admits effective engine policy, negotiates a private worker channel, and keeps durable
and authenticated authority on the host.

This document is the current contract and records only behavior implemented in source.

The builtin `/clarvis-configure` flow has an explicit host-only
[native configuration contract](self-configuration.md). A separate human elicitation admits its
limited configuration file tools for the currently open TUI session. That run never enters the
runtime coordinator, launches a container or invokes a sandbox. It executes no extensions and
does not change placement for subsequent ordinary runs. Resume requires new approval.
Production: `createNativeConfigurationRuns` in
[native-configuration.ts](../../packages/kernel/src/configuration/native-configuration.ts).
Test: [native-configuration.test.ts](../../packages/kernel/tests/integration/native-configuration.test.ts).

Runtime configuration is a strict kernel-owned settings block. Native is the default. Docker accepts
the simple `{ "backend": "docker" }` choice; the kernel defaults it to 2 CPUs, 4 GiB memory, 256
processes, 16 MiB output, 4 GiB storage, ordinary `outbound` networking and required-Sandbox
fallback. Executable, Docker context, image digest, network, limits and fallback remain advanced
overrides. Docker additionally accepts a global operator recipe with a safe name, an absolute script
path under global `runtime-recipes/` and `none`/`outbound` build network; Podman retains the explicit
immutable digest, executable, connection and complete-limit contract. `outbound` may reach host/LAN
peers and transmit readable workspace content; it does not mean public-only internet. The workspace
scope can display a requested `runtime` block but can never
contribute it to the effective merge, including after workspace approval. `createFileKernel` reads
the current global selection at run admission, performs no engine work on native or application
startup, and injects the same placement-neutral lazy executor into ordinary and workflow-owned runs.
The settings schema enforces the launch contract's positive safe integers for every resource limit,
including CPU count; fractional CPU allocations are refused before persistence.

Production: `runtimeSettingsSchema` in `packages/kernel/src/runtime/settings.ts`;
`stripWorkspaceSubscriptionProviders` in `packages/kernel/src/config/workspace-trust.ts`;
`createFileKernel` in `packages/kernel/src/file-kernel.ts`; `createLazyRuntimeCoordinator` in
`packages/kernel/src/runtime/lazy-runtime.ts`; `RunExecutor` in
`packages/kernel/src/runs/run-service.ts`.

Test: `packages/kernel/tests/unit/runtime-settings.test.ts`;
`packages/kernel/tests/unit/lazy-runtime.test.ts`;
`packages/kernel/tests/integration/workspace-trust.test.ts`;
`packages/kernel/tests/integration/file-kernel.test.ts`.

Every complete Code kernel path, including `--print` and `--refresh-models`, enters through the
workspace manager and the independent Code host entry, which supplies the concrete local factory
lazily. Only the first container run
imports the selected engine process adapter and, for Docker, resolves either the local development
tag, the explicitly installed candidate's image, or that exact installed version's digest-pinned release image; application startup performs
neither import, network request nor engine probe. When configured, a Docker recipe is also captured,
resolved and built on this lazy path before the runtime generation is launched. An uncached
identity emits one path-free first-use preparation message through the existing runtime-placement
notice while lifecycle remains `starting`. The factory then composes one authority router, runtime
generation, engine backend and placement adapter. Each run receives a random opaque model
lease, exact profile, vision and resolved automatic-judge models from its immutable run snapshot,
host-side provider execution, a bounded
elicitation grant, a loopback-only preview grant when a selected profile carries `run_commands`, and
an optional prior trace record for continuation. Preview also requires enabled host tools and an
`exec` ceiling. When present, the canonical host `PlanFactory`,
admitted host skills snapshot, active plugin bootstrap declarations and `MemoryFactory` are
projected through exact per-run grants. Plans stay host-owned; Skills disclose only admitted
content; Memory discloses a bounded seed and the four canonical read operations while provider
state and every mutating memory operation stay on the host. Neither store paths nor host skill paths
are sent to the guest. Model and capability leases and the immutable per-run projection are revoked
when that run settles, even if a control-delivery pump rejects. Revocation cannot be undone by a late
model call recreating its lease.

An explicit candidate source launcher supplies the exact RC tag and source revision. Code fetches
only that tag's bounded `runtime-candidate.json` from the source repository and accepts the
`source-v1` contract only when product version, source revision, protocol and candidate image namespace
match. Candidate identity failures carry `runtime_image_integrity`, preventing silent sandbox fallback.
The installer pulls the candidate image before launcher activation; runtime initialization resolves
and pulls the immutable reference through the existing Docker control. Image acquisition uses a
bounded 15-minute operation-specific timeout; inspection keeps the short control-command timeout.
Podman configuration remains
explicit. Production: `packages/code/src/adapters/runtime-candidate.ts` (`parseRuntimeCandidate`)
and `packages/code/src/adapters/runtime-image.ts` (`resolveClarvisRuntimeImage`).
Test: `packages/code/tests/unit/runtime-image.test.ts` (same-RC selection and identity drift).

Production: `WorkspaceClientManager.create` in
`packages/code/src/adapters/workspace-client-manager.ts` and `main` in
`packages/code/src/local-host.ts`; `createLocalPodmanRuntime` in `packages/kernel/src/runtime/local-podman-runtime.ts` and
`createLocalContainerRuntime` in `packages/kernel/src/runtime/local-container-runtime.ts`;
`createLocalDockerRuntime` in `packages/kernel/src/runtime/local-docker-runtime.ts`;
`resolveDockerRuntimeRecipe` in `packages/kernel/src/runtime/runtime-recipe.ts`;
`resolveClarvisRuntimeImage` in `packages/code/src/adapters/runtime-image.ts`.

Test: `packages/code/tests/architecture/architecture-boundary.test.ts`;
`packages/kernel/tests/unit/local-docker-runtime.test.ts` (image acquisition timeout propagation);
`packages/code/tests/unit/runtime-image.test.ts`;
`packages/kernel/tests/unit/runtime-recipe.test.ts`;
`packages/kernel/tests/integration/runtime-recipe.e2e.test.ts` (explicitly gated live Docker/Colima
canary); and
`packages/kernel/tests/integration/local-podman-runtime.test.ts` (host Memory and plugin-bootstrap
projection).

## 2. Immutable admission

`RuntimeLaunchSpec` binds the runtime generation, owner, project and workspace identities, the
canonical workspace root, existing workspace-relative read-only overlays, optional linked-worktree
Git common directory, immutable image digest, configuration and Extension Profile revisions,
network authority, resource limits, and the closed set of callable host capability methods.
`assertRuntimeLaunchSpec` rejects incomplete identity, mutable image tags, non-positive or
non-integral limits, duplicate or open-ended methods, relative workspace/overlay paths, overlays
that are not strict descendants of the selected workspace, duplicate overlays, and Git metadata
that is relative, a filesystem root, or overlaps the workspace.

`createRuntimeSupervisor` inspects the configured backend before starting it. An unavailable engine
produces a typed launch error and calls no start path at that layer. It admits one generation at a
time and verifies the returned generation and image identity. A mismatch stops the new session
before returning a `handshake_mismatch`. The returned stop operation is idempotent. A normal Docker
or Podman close first stops and then force-removes only that generation's disposable engine
container. If removal fails, a later close retries removal without replaying guest shutdown. The
selected workspace and any Docker `/mise` cache remain outside the disposable container.

`createLazyRuntimeCoordinator` owns placement across runs. It coalesces concurrent first launches,
reuses one ready generation only while both configuration and Extension Profile revisions remain
unchanged and its attached engine process/private channel remains open, retires an idle superseded
or dead generation, lazily creates a fresh generation for the next run, and closes every runtime
host on kernel shutdown. A run that observed a dead generation still returns its own failure and is
never replayed. Failed cleanup retains the owned slot independently of the reusable-slot index;
`close()` reports aggregate failures and clears its in-flight promise so a later close retries even
a retired generation sharing the current configuration key. The outer kernel lifecycle retains a
failed disposer as well, and the file host still closes unrelated dependencies when runtime cleanup
fails. For Docker only, an operational pre-execution failure
(`engine_missing`, `engine_stopped`, unsupported host, or another startup failure) activates and
latches the configured default required native Sandbox fallback, publishes one explanation, and
uses it for later runs until retry or configuration change. Image-integrity, launch-policy,
recipe-validation/build, effective-policy and handshake mismatches never fall back. Running without
the operator's requested recipe is not an operationally equivalent degraded placement. An error
after `executeRun` starts is returned as that run's failure and is never replayed through native
execution.

Production: `RuntimeLaunchSpec` and `RuntimeLaunchError` in
`packages/kernel/src/runtime/types.ts`; `assertRuntimeLaunchSpec` in
`packages/kernel/src/runtime/launch-policy.ts`; `createRuntimeSupervisor` in
`packages/kernel/src/runtime/supervisor.ts`; `createLazyRuntimeCoordinator` in
`packages/kernel/src/runtime/lazy-runtime.ts`; `effectiveSandboxSettings` in
`packages/kernel/src/sandbox/policy.ts`.

Test: `packages/kernel/tests/unit/runtime-launch-policy.test.ts`;
`packages/kernel/tests/unit/runtime-supervisor.test.ts`;
`packages/kernel/tests/unit/lazy-runtime.test.ts` (including dead-generation replacement);
`packages/kernel/tests/unit/lifecycle.test.ts`;
`packages/kernel/tests/integration/file-kernel.test.ts` (public close retry after failed removal);
`packages/kernel/tests/integration/sandbox-policy.test.ts`.

## 3. Direct selected workspace

The kernel discovers and canonicalizes the workspace before runtime selection. A non-Git directory
and a primary Git checkout are mounted directly and read-write at guest `/workspace`. A linked Git
worktree is already the operator's separate checkout, so Clarvis mounts that same worktree rather
than making a second copy. It additionally mounts the discovered Git common directory read-write at
the same absolute path inside the guest so the worktree's existing `.git` pointer remains valid.
That mount exposes the repository's shared objects, refs and worktree metadata to the guest; choosing
the worktree is therefore also the operator's decision to grant that repository metadata.

Guest workspace writes are immediately visible on the host. Clarvis does not pause the container,
stage a baseline, raise a workspace-merge elicitation, apply a transaction, commit, merge, or remove
a worktree. The operator uses ordinary Git status/review/commit/merge and worktree lifecycle during
or after the Clarvis session. When stronger source separation is wanted, the operator starts Clarvis
inside a worktree; requiring Git would deny container isolation to non-Git directories, so it is not
a runtime prerequisite.

The host keeps Clarvis control data authoritative with nested read-only binds for reserved paths
that exist when the generation launches. When Plans or Memory bridging is active, the host prepares
its canonical workspace root before launch so later host writes remain visible through an already
read-only guest mount. Existing workspace settings, agents, skills, workflows, plugins, Extension
Profiles, guard and memory policy, shared `.agents` skills/plugins, and applicable plan/memory roots
are likewise overlaid read-only. A symlink in a reserved path or any workspace-relative ancestor,
an intermediate non-directory, or a special-file leaf refuses admission before the engine is
called. Host-global skill/plugin paths and provider/store paths are never mounted; their admitted
content crosses only the purpose-specific bridges in section 5.

This is deliberately weaker source isolation than an unmounted copy: the guest can change any
unprotected path in the selected workspace and can transmit readable workspace data when outbound
networking is enabled. It is still a separate process/filesystem/credential boundary: the image
root is read-only, host credentials and engine socket are absent, host capabilities are brokered,
and only the selected workspace, declared read-only overlays, optional Git metadata and `/mise`
storage are admitted. `storage_bytes` does not limit writes through the host workspace bind.

Production: `discoverGitWorkspace` in `packages/kernel/src/git-workspace.ts`;
`createFileKernel` in `packages/kernel/src/file-kernel.ts`; `readOnlyWorkspacePaths` and
`createLocalContainerRuntime` in `packages/kernel/src/runtime/local-container-runtime.ts`;
`prepareRuntimeCapabilityRoot` in
`packages/kernel/src/runtime/runtime-workspace-control.ts`; `createArgs` and effective mount
inspection in `packages/kernel/src/runtime/docker-backend.ts` and
`packages/kernel/src/runtime/podman-backend.ts`; `safetyDescription` in
`packages/code/src/adapters/execution-safety.ts`; `RunControlsPanel` in
`packages/code/src/views/config/RunControlsPanel.tsx`.

Test: `packages/kernel/tests/integration/git-workspace.test.ts`;
`packages/kernel/tests/unit/lazy-runtime.test.ts`;
`packages/kernel/tests/integration/local-podman-runtime.test.ts`;
`packages/kernel/tests/unit/runtime-docker-backend.test.ts`;
`packages/kernel/tests/unit/runtime-podman-backend.test.ts`;
`packages/kernel/tests/integration/local-docker-runtime.e2e.test.ts` (explicitly gated live
Docker/Colima canary); `packages/code/tests/unit/execution-safety.test.ts`;
`packages/code/tests/integration/run-controls-render.test.tsx`.

## 4. Host state and container lifetime

Every canonical workspace has a `runtimes/` subtree in its machine-state root, but it contains only
host-accepted per-run checkpoints beneath an encoded generation directory. Runtime workspace copies,
registries, baselines, apply journals, transaction staging and lifecycle records do not exist. The
selected workspace or worktree remains where the operator put it and is never removed as runtime
cleanup.

One container generation is reused for compatible runs in the same live kernel. On orderly kernel
or TUI close, Clarvis closes preview listeners, stops that exact generation and force-removes its
container. A failed removal remains retryable. A host crash can still leave an engine container;
external orphan reconciliation is not implemented. Both engines retain their separately labelled
`/mise` volume across container and Clarvis-session replacement for the same owner, project,
workspace, image and effective user identity. `miseCacheIdentity` and the bounded initializer in
`packages/kernel/src/runtime/container-mise-cache.ts` own this shared policy.

Production: `WorkspaceStatePaths` and `workspaceStatePaths` in
`packages/paths/src/workspace-state.ts`; `launchIsolatedRuntime` in
`packages/kernel/src/runtime/runtime-controller.ts`; `createRuntimeSupervisor` in
`packages/kernel/src/runtime/supervisor.ts`; `stop` in
`packages/kernel/src/runtime/docker-backend.ts` and
`packages/kernel/src/runtime/podman-backend.ts`.

Test: `packages/paths/tests/component/workspace-state.test.ts` (`workspaceStatePaths`);
`packages/kernel/tests/integration/runtime-controller.test.ts`;
`packages/kernel/tests/unit/runtime-docker-backend.test.ts`;
`packages/kernel/tests/unit/runtime-podman-backend.test.ts`.

## 5. Private execution and authority

`createExecutionPeer` owns a separate attached-stdio protocol with closed directional vocabularies.
Every request, result, incremental model event and cancellation is generation-bound and, where applicable, run- and
call-bound. Unknown methods, malformed or oversized physical frames, mismatched results and
transport loss close the channel without replay. A request cancelled through its own transport
signal leaves a bounded identity tombstone, so its one matching late terminal result is consumed
without poisoning the reusable channel; any unmatched or identity-mismatched late result still
closes it. An active run is cancelled through the separate `runtime.cancel` operation after
`runtime.start` is sent, while the host keeps that start request pending until the guest settles.
`serveExecutionWorker` gives guest execution only the narrow model, capability, event and checkpoint
bridge.

Inbound request IDs increase strictly within each direction. Admission checks both the 256-request
limit and 128 MiB aggregate serialized-message budget before allocating a controller or invoking a
handler. A request retains admission until its handler and response write settle, even when a
cancelled handler ignores abort. Saturation refuses only the excess request with `resource_exhausted`;
admitted handlers retain their ownership and cancellation state. Local outgoing calls have a separate 256-pending
limit. Receivers retain the last 256 completed request identities, so a matching cancellation that
races with a written response is harmless; unknown or mismatched late cancellation remains an
error. Completion tombstones contain only identity, never payload or result.

Both public stdio and private RPC use the shared 64 MiB logical JSON bound. A message exceeding its
physical frame cap is encoded as contiguous 256 KiB binary fragments with canonical base64,
zero-based byte offsets and an exact declared total. Only one partial message exists per direction;
interleaving, changed totals, malformed fragments, invalid complete JSON or a 30-second absolute
transfer deadline close the peer. Teardown releases partial content. Outgoing queue reservation is
synchronous and bounded at 128 MiB of serialized JSON. Serialization, logical-size and local queue
refusals occur before any bytes or cancellation identity are published. They reject only that call;
an excessive handler result is replaced by a bounded error. Physical write failure still closes
the shared channel. Production: `createJsonMessageWriter` and `JsonMessageDecoder` in
[json-message.ts](../../packages/kernel/src/core/json-message.ts), `createExecutionPeer` in
[execution-rpc.ts](../../packages/kernel/src/runtime/execution-rpc.ts). Test:
[json-message.test.ts](../../packages/kernel/tests/contract/json-message.test.ts),
[runtime-execution-rpc.test.ts](../../packages/kernel/tests/contract/runtime-execution-rpc.test.ts)
(`fragments large model messages and isolates a local refusal from another run`), and
[runtime-capability-composition.test.ts](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts)
(`preserves admitted images, accumulated context and final trace through the real guest loop`).

Model leases use the same 64 MiB input ceiling; `limits.output_bytes` bounds generated output,
not admitted model context or image input. Transport envelopes count against the logical limit.
Production: `brokerFor` in
[local-container-runtime.ts](../../packages/kernel/src/runtime/local-container-runtime.ts).
Test: `preserves admitted images, accumulated context and final trace through the real guest loop`
in [runtime-capability-composition.test.ts](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts),
using a 1 MiB output budget and the full 10 MiB composer image input budget.

Each capability broker retains at most 16,384 distinct attempted call IDs and 8 MiB of idempotent
response payloads plus pending response reservations per run. Non-idempotent calls keep only
method, argument fingerprint and completion metadata and cannot be replayed. An idempotent replay
requires identical method, revision and arguments; conflicting or unfinished identities report
`outcome_unknown`. Count and replay-byte capacity is reserved before invocation; saturation reports
`resource_exhausted` before effects. Revocation clears replay history and all grant-owned transfers,
and a late completion cannot repopulate it.

Production: `createExecutionPeer` in
[`execution-rpc.ts`](../../packages/kernel/src/runtime/execution-rpc.ts) and
`createCapabilityBroker` in
[`authority-brokers.ts`](../../packages/kernel/src/runtime/authority-brokers.ts).
Test: count/byte floods, real unanswered elicitations and response/cancel races in
[`runtime-execution-rpc.test.ts`](../../packages/kernel/tests/contract/runtime-execution-rpc.test.ts),
and call-history, replay-byte reservations and argument identity in
[`runtime-authority-brokers.test.ts`](../../packages/kernel/tests/unit/runtime-authority-brokers.test.ts).

`createGuestLoopExecutor` is the headless guest payload. It builds the real loop and local tool
surface against `/workspace`, gives it only a declared scratch environment, replaces model traffic
with the private host bridge, and sends the completed execution record back for insertion into the
host trace store before reporting a reconstruction checkpoint. The standalone build entry imports
the npm modules that Bun must close into the executable, supplies those modules to the Loop's
source-internal Ajv composition seam, and starts `guest-main` without a TUI or public kernel
transport. Ordinary Loop hosts keep the existing lazy `createRequire` fallback, so merely reaching
validation on the native TUI boot path still does not load Ajv.

Docker and Podman use `connectContainerSession` for attachment, stderr bounds, bootstrap identity,
RPC operations, preview ownership and shutdown. Their adapters retain image/effective-policy
inspection, user mapping, SELinux options and engine-specific creation arguments.
Bootstrap observes a generation signal and a 30-second response deadline (the injectable host seam
permits at most 120 seconds), independently of frame-write timeouts. Early attachment exit, excessive
stderr, timeout and cancellation close the peer and kill attachment before backend cleanup.
A cancelled create probes its generation label before deleting the immutable container ID; a
failed inspection or removal reports unconfirmed cleanup, and a different generation is preserved.
Production: `connectContainerSession` and `cleanupInterruptedContainerCreate` in
[container-session.ts](../../packages/kernel/src/runtime/container-session.ts), composed by
`createDockerRuntimeBackend` and `createPodmanRuntimeBackend`.
Test: silent-worker deadline/cancellation and existing policy/session regressions in
[runtime-docker-backend.test.ts](../../packages/kernel/tests/unit/runtime-docker-backend.test.ts)
and [runtime-podman-backend.test.ts](../../packages/kernel/tests/unit/runtime-podman-backend.test.ts);
generation-fenced cleanup in
[runtime-initialization.test.ts](../../packages/kernel/tests/unit/runtime-initialization.test.ts).

Each run's initialization wait observes its own abort signal without aborting the shared factory.
Coordinator shutdown aborts generation acquisition and awaits the factory's physical cleanup before
closing ready slots. A late ready host is closed without executing a run or advertising readiness.
Runtime factories must honor the generation signal and clean partial resources before rejecting.
Cancellation never selects Docker's native fallback. The concrete compositions propagate the signal
through context/image resolution, pull, recipe engine commands, contended recipe leases and bootstrap;
the original engine control remains available for cleanup after cancellation.
Production: `waitForInitialization` and `createLazyRuntimeCoordinator` in
[lazy-runtime.ts](../../packages/kernel/src/runtime/lazy-runtime.ts),
`initializationControl` in [initialization-control.ts](../../packages/kernel/src/runtime/initialization-control.ts),
`resolveDockerRuntimeRecipe` in [runtime-recipe.ts](../../packages/kernel/src/runtime/runtime-recipe.ts),
and `resolveClarvisRuntimeImage` in [runtime-image.ts](../../packages/code/src/adapters/runtime-image.ts).
Test: shared waiter cancellation and shutdown cleanup in
[lazy-runtime.test.ts](../../packages/kernel/tests/unit/lazy-runtime.test.ts), acquisition cancellation in
[local-docker-runtime.test.ts](../../packages/kernel/tests/unit/local-docker-runtime.test.ts), and
lease cancellation in [local-lease.test.ts](../../packages/paths/tests/contract/local-lease.test.ts).

The worker also routes the closed `runtime.steer` control operation to the active guest executor.
The payload is exactly either `{kind: "steer", message}` or `{kind: "compact", request}`: unknown
fields, malformed message content and inactive run IDs are refused. `createGuestLoopExecutor`
registers the two run-scoped queues before its first asynchronous preparation step, passes them to
the real `executeRun`, and closes them when that run settles. Steering retains native delivery
semantics—the RPC resolves only after the loop drains the message—while compaction is acknowledged
on enqueue and remains a separate control source rather than transcript content. The host queue's
`take` transfers messages without acknowledging them; delivery settles only after the guest RPC
confirms a real drain. A late refusal settles steering as undelivered without replacing an otherwise
successful run result. Protocol revision 9 requires resolved host loop and tool-policy snapshots, host-owned human
command consent, canonical skill disclosure and multipart plan bridge in addition to guest MCP hook execution, host-owned remote MCP with reverse elicitation,
typed provider failures and incremental host model events;
older worker images fail admission and must be rebuilt.

Model progress frames are exclusive to `host.model`, monotonically sequenced, correlated to the
pending call and bounded by the existing frame/queue/byte limits. `streamHostModelCall` drains text
and reasoning deltas while the provider is running, then emits a separate terminal result. Partial
output is delivered before a provider error, and cancellation does not wait forever for a provider
that ignores abort. Only exact provider/model pairs are admitted, including `vision_model` and the
effective automatic judge's explicit or default model; auxiliary models do not broaden provider
authority.

For each admitted pair, `hostModelBroker` resolves the captured host registry through the shared
`resolveProvider(provider, registry, model)` before calling the adapter. This preserves `apiKeyEnv`,
`baseUrl`, shallow provider/model header and body overrides, and model prompt-cache settings. It
reconstructs `capabilities` from that model's captured entry, including an explicit empty set; the
guest cannot substitute provider configuration or claim vision support. Unsupported images are
stripped only by adapter serialization, without rewriting the loop's retained message prefix.
`modelBody` forwards `maxRetries` and `maxRetryAfterMs` unchanged when present, including zero
retries, so profile policy and output-token reservations remain effective.

Only host `ProviderError`s answering `host.model` carry the closed provider-error variant. It
contains the finite failure kind, optional bounded HTTP status and Retry-After delay, stream-start
flag, and optional nonnegative safe-integer partial/accumulated usage counters. The message is
sanitized and bounded; stacks, causes, headers and response bodies are excluded. Only the guest's
pending model call reconstructs `ProviderError`, preserving context-overflow and forced-choice
recovery and failed-attempt accounting. No guest-originated error gains that host authority.

Model requests use bounded FIFO admission with the host's
`CLARVIS_MAX_CONCURRENT_MODEL_CALLS` and `CLARVIS_MAX_QUEUED_MODEL_CALLS`; container CPU allocation
is not a model concurrency threshold. Queue overflow is explicit, queued cancellation does not
execute, expiry is checked after admission, and revocation aborts both waiting and active calls.
The existing host model-admission decorator still governs physical provider requests.

Production: `hostModelBroker` in
[`local-container-runtime.ts`](../../packages/kernel/src/runtime/local-container-runtime.ts), `modelBody`
in [`guest-loop-executor.ts`](../../packages/kernel/src/runtime/guest-loop-executor.ts),
`encodeRuntimeProviderError` and `decodeRuntimeProviderError` in
[`provider-error.ts`](../../packages/kernel/src/runtime/provider-error.ts), `createExecutionPeer`
in [`execution-rpc.ts`](../../packages/kernel/src/runtime/execution-rpc.ts), and `createModelBroker`
in [`authority-brokers.ts`](../../packages/kernel/src/runtime/authority-brokers.ts).
Test: typed failure round-trips and malformed variants in
[`runtime-execution-rpc.test.ts`](../../packages/kernel/tests/contract/runtime-execution-rpc.test.ts),
queued drain/cancel/revoke/expiry in
[`runtime-authority-brokers.test.ts`](../../packages/kernel/tests/unit/runtime-authority-brokers.test.ts),
and real SDK endpoint/authentication/vision/retry plus guest overflow/usage and two-CPU concurrency
cases in
[`runtime-capability-composition.test.ts`](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts).

Ordinary HTTP/SSE MCP acquisition and tool/resource operations use `runtime.mcp` revision `v1`
through a host-owned connection manager. The closed request names only an enabled server from the
captured run snapshot or a run-owned lease UUID. It cannot supply a URL, credential, owner or stdio
command. Acquired leases use owner-scoped sharing and a bounded live-lease allowance; tools and
resource operations must exist in the discovered catalog. Descriptors, instructions and results
cross the channel, but resolved environment-backed headers, bearer tokens and saved OAuth stay
with the host's authorization coordinator/store. Authored declaration templates are still part of
the run request, so this is not a mechanism for hiding literal secrets authored in that request.
HTTP/SSE remote effects remain possible with container network `none`.

Acquisition preserves typed authorization-pending, background-admission-deferred and connection-failed
outcomes, keeping native optional/required server behavior. `runtime.mcp_elicit` sends a remote
question back to the matching live guest lease and its existing serialized elicitation relay,
including compute-clock pauses and cancellation. A closed lease cannot elicit or execute another
operation. Run disposal aborts acquisitions and releases leases, including late successful
acquisitions after cancellation. Stdio acquisition uses the guest's local manager without a host
fallback. This introduces a production `kernel` → `mcp-client` dependency for the shared connection
and error contracts, not a reverse dependency or a second transport implementation.

Production: `createHostRemoteMcpBridge` and `createGuestMcpConnections` in
[`remote-mcp.ts`](../../packages/kernel/src/runtime/remote-mcp.ts), `elicitMcp` in
[`guest-loop-executor.ts`](../../packages/kernel/src/runtime/guest-loop-executor.ts), and
`serveExecutionWorker` in
[`execution-worker.ts`](../../packages/kernel/src/runtime/execution-worker.ts).
Test: snapshot/owner/catalog checks, typed failures and late lease cleanup in
[`runtime-remote-mcp.test.ts`](../../packages/kernel/tests/unit/runtime-remote-mcp.test.ts),
live-run elicitation and cancellation in
[`runtime-execution-worker.test.ts`](../../packages/kernel/tests/integration/runtime-execution-worker.test.ts),
and HTTP/SSE bearer, environment header, saved OAuth and guest-relay cases in
[`runtime-capability-composition.test.ts`](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts).

Container placement preserves admitted capability composition rather than replacing it with a
smaller guest registry. Configured hook lifecycle callbacks activate on the host and cross
`runtime.hooks` only by admitted index, method and strict event context. Host commands, plugin
environment filtering and HTTP/SSE MCP hook connections remain host-owned; the guest cannot supply
a command.
Native hook ordering, denial, rewriting and downstream tool/guard validation remain effective.

A `stdio` MCP hook returns from that host policy callback through `runtime.hook_mcp` to the active
guest run. Its payload is exactly `{server, tool, input}`: it cannot supply a process command,
environment, directory, endpoint or owner. The generation/run identity is bound by the private
channel, and inactive runs are refused. `createGuestHookMcpCaller` captures only enabled `stdio`
declarations from that run's server snapshot, uses its guest connection manager with owner-scoped
sharing and releases the lease on success, failure or cancellation. This caller is available before
`executeRun` begins, so `session_start` and `run_start` do not depend on the ordinary tool pool being
open. It uses the same guest environment and filesystem boundary as ordinary MCP tools; dependencies
and paths must be valid inside the container. Call and run cancellation abort acquisition/execution,
and guest teardown aborts outstanding hook calls before disposing the connection manager. Neither a
failed acquisition nor a failed tool call falls back to host execution. Hook errors retain the native
fail-open contract; this does not authorize a host retry. HTTP/SSE hooks retain host connections and
remote effects. The policy callback still awaits each gate result, preserving mixed command/MCP
ordering and argument rewrites without recursively entering model tool dispatch.

Production: `createGuestHookMcpCaller` in
[`packages/kernel/src/runtime/hook-mcp.ts`](../../packages/kernel/src/runtime/hook-mcp.ts),
`callHookMcp` in
[`packages/kernel/src/runtime/guest-loop-executor.ts`](../../packages/kernel/src/runtime/guest-loop-executor.ts),
and `serveExecutionWorker` in
[`packages/kernel/src/runtime/execution-worker.ts`](../../packages/kernel/src/runtime/execution-worker.ts).
Test: lease, payload and cancellation cases in
[`packages/kernel/tests/unit/runtime-hook-mcp.test.ts`](../../packages/kernel/tests/unit/runtime-hook-mcp.test.ts),
nested RPC and active-run identity cases in
[`packages/kernel/tests/integration/runtime-execution-worker.test.ts`](../../packages/kernel/tests/integration/runtime-execution-worker.test.ts),
host/guest transport selection in
[`packages/kernel/tests/integration/runtime-capability-composition.test.ts`](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts),
and the opt-in real Docker/Podman boundary canary in
[`packages/kernel/tests/integration/runtime-mcp-hooks.e2e.test.ts`](../../packages/kernel/tests/integration/runtime-mcp-hooks.e2e.test.ts).
That canary verifies early and terminal hooks, gate rewrites, writable mounted workspace output and
inaccessible synthetic host files outside the mount; `tooling/ci/qualify-runtime.sh` runs it for both
engines against the built image. Passing deterministic tests alone does not establish that evidence.

Tasks registers its canonical capability and `task` schema in the guest over `runtime.tasks`.
The host pins provider and run identity, binding/continuation mode, write settings and grants,
validates canonical provider inputs, and preserves typed provider failures and retry metadata.

Workflows uses the same guest-native scheduler, child registry and shared subtree output budget.
The trusted `workflowContextOf` and `workflowOutputBudgetOf` factory-identity projections let the
kernel retain host composition without serializing executable closures. `runtime.workflows` prepares
each bounded leader request through the host assembler once, then admits that child to the same
generation; a child cannot choose arbitrary host dependencies or retain a manager grant. Host
callbacks persist sequence progress and ledger spend. Unrecognized host capabilities refuse placement
as `unsupported_policy` instead of disappearing silently.

Production: `createHostHooksBridge` and `createGuestHooksCapabilities` in
`packages/kernel/src/runtime/hooks-bridge.ts`; `createHostTasksGrant` and `createGuestTaskResolver`
in `packages/kernel/src/runtime/tasks-bridge.ts`; `createHostWorkflowBridge`,
`createGuestWorkflowCapabilities` and `consumeGuestWorkflowEvent` in
`packages/kernel/src/runtime/workflows-bridge.ts`; `runtimeModelPairs` in
`packages/kernel/src/runtime/local-container-runtime.ts`; `streamHostModelCall` in
`packages/kernel/src/runtime/model-stream.ts`; `createIsolatedRunExecutor` in
`packages/kernel/src/runtime/isolated-run-executor.ts`; `createSteerQueue` in
`packages/kernel/src/runs/steer-queue.ts`.

Test: `packages/kernel/tests/integration/runtime-capability-composition.test.ts`;
`packages/kernel/tests/unit/runtime-tasks-bridge.test.ts`;
`packages/kernel/tests/integration/runtime-model-stream.test.ts`;
`packages/kernel/tests/integration/isolated-run-executor.test.ts`;
`packages/kernel/tests/unit/lazy-runtime.test.ts`.

Guest command execution retains the host-selected guard contract without exposing host policy
authority. The host strips provider secrets before sending the bounded guard settings; the guest
reconstructs `createGuardResolver`, preserves the host's `CLARVIS_AGENT_TOOLS_ENABLED`,
`CLARVIS_AGENT_TOOLS_CONFINE` and `CLARVIS_AGENT_TOOLS_MAX_GRANT`, and emits only the closed
guard-audit vocabulary. `forwardGuestGuardAudit` validates that event again and replaces its
claimed run and owner identities with the authenticated host values before logging. The outer OCI
policy is the containment boundary; this profile does not pretend to run a second Bubblewrap or
Seatbelt sandbox inside the container.

The required non-secret `toolPolicy` envelope also captures whether the host composed the `tools`
capability at all. Missing or invalid policy is refused. Guest tools use the shared per-agent grant
checks; preview is projected only with enabled tools and an `exec` ceiling and still requires
`run_commands`. Production: `validRuntimeToolPolicy` in
[`tool-policy.ts`](../../packages/kernel/src/runtime/tool-policy.ts), `createLocalContainerRuntime`
in [`local-container-runtime.ts`](../../packages/kernel/src/runtime/local-container-runtime.ts), and
`createGuestLoopExecutor` in
[`guest-loop-executor.ts`](../../packages/kernel/src/runtime/guest-loop-executor.ts).
Test: native/guest policy parity and host opt-out in
[`runtime-capability-composition.test.ts`](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts),
and malformed policy refusal in
[`runtime-guest-loop.test.ts`](../../packages/kernel/tests/integration/runtime-guest-loop.test.ts).

The required `loopPolicy` snapshot preserves resolved operator defaults and ceilings for validation,
elicitation, budgets, retries, compaction, delegation, capability lifecycle and MCP. Every canonical
environment key has an explicit compile-time ownership classification. The guest projection excludes
host identity, diagnostics and retention; tool authority remains in its capability-aware snapshot.
The canonical `envSchema` validates cross-field constraints again on receipt. Missing resolved
defaults, coercible wire values and unadmitted fields are refused instead of restoring broader
defaults. Optional unset fields retain their absence.
Production: `runtimeLoopPolicy`, `validRuntimeLoopPolicy` and `guestLoopEnvironment` in
[loop-policy.ts](../../packages/kernel/src/runtime/loop-policy.ts), composed by
`createLocalContainerRuntime` and consumed by `createGuestLoopExecutor`.
Test: [runtime-loop-policy.test.ts](../../packages/kernel/tests/unit/runtime-loop-policy.test.ts)
and the native/guest elicitation-deadline and retry-ceiling cases in
[runtime-capability-composition.test.ts](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts).

Plans use a separate exact-method bridge rather than moving the store. The host binds
`runtime.plans` to the authenticated run owner and admits only resolve/create/read/list/replace,
reconcile/revise/delete payloads with closed schemas; the guest `PlanFactory` proxies those
operations and cannot choose another owner or a host path. A mutation addresses only the plan
created by this run or bound through its host-selected continuation ref; read/list never rebind.
Delete additionally requires the durable current run record to be completed and name the same
provider, plan, final revisions and completed/discard policy as the canonical document. The host
supplies the current CAS even if the guest omits one; concurrent changes prevent deletion.

`runtime.plans` revision `v2` preserves the canonical 8 MiB document and 32 MiB list-page limits
through opaque run-local transfers. The closed `transfer_start`, `transfer_append`, `transfer_commit`,
`transfer_read` and `transfer_release` operations carry exact offsets and base64 chunks of at most
128 KiB decoded bytes. Uploads require full chunks except the final remainder, complete byte counts
and valid UTF-8/JSON before the original operation schema is checked; transfer operations cannot be
nested. The JSON allowance is six times the canonical source limit plus 1 MiB of metadata: 49 MiB
for document requests/results and 193 MiB for list results. Extension frontmatter travels as bounded
YAML inside that JSON so aliases retain their canonical graph representation rather than expanding
shared metadata into larger JSON trees. The decoded document is schema-validated on both sides.
The run admits at most four transfer or
provider-response reservations and 242 MiB of aggregate payload reservations, including active
uploads, pending provider calls and retained downloads. Serialization has bounded temporary copies;
this is a payload budget, not a process RSS ceiling. Response capacity is reserved before provider
effects, so capacity refusal cannot occur after a valid mutation commits. Final reads, explicit
release and run revocation free transfer state; guest cleanup releases partial transfers on failure.
The shared capability message bound stays 256 KiB and the RPC frame bound stays 4 MiB.

Production: `createHostPlansGrant` and `createGuestPlanFactory` in
[`plan-bridge.ts`](../../packages/kernel/src/runtime/plan-bridge.ts), and `createPlanTransferGrant`
and `callPlanTransfer` in [`plan-transfer.ts`](../../packages/kernel/src/runtime/plan-transfer.ts),
and `encodePlanWireDocument` / `decodePlanWireDocument` in
[`plan-wire.ts`](../../packages/kernel/src/runtime/plan-wire.ts).
Test: host binding, terminal retention and CAS races in
[`runtime-plan-bridge.test.ts`](../../packages/kernel/tests/unit/runtime-plan-bridge.test.ts),
large canonical documents, aliased metadata, list pages, transfer saturation, cancellation and revocation in
[`runtime-plan-transfer.test.ts`](../../packages/kernel/tests/contract/runtime-plan-transfer.test.ts),
and real guest keep/discard teardown in
[`runtime-capability-composition.test.ts`](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts).

Human command consent uses the non-replayable `runtime.guard_approval` bridge. Its closed operations
are `covers` and `ask`, scoped to the current host run. The host derives shell facts from the displayed
command, resolves the current interactive allowlist on every call and rejects answers from a retired
scope. The guest stores no human consent or allowlist; `runtime.elicit` remains the general question
channel. The judge retains only its own clean final verdicts, never a human fallback response.
Detach, takeover, disconnect and conversation close revoke native and guest consent equally.
Production: `createGuardHumanApproval` in
[human-approval.ts](../../packages/kernel/src/guard/human-approval.ts), `createHostGuardApprovalGrant`
and `createGuestGuardApproval` in
[guard-approval-bridge.ts](../../packages/kernel/src/runtime/guard-approval-bridge.ts), and
`createGuardResolver` in [resolver.ts](../../packages/kernel/src/guard/resolver.ts).
Test: [runtime-guard-approval.test.ts](../../packages/kernel/tests/component/runtime-guard-approval.test.ts)
and [runtime-guard-revocation.test.ts](../../packages/kernel/tests/integration/runtime-guard-revocation.test.ts).

Skills use a read-only companion bridge.
At generation admission the host projects name, description, scope, safe provenance and MCP
dependency names only, replaces filesystem locations with opaque `runtime-skill:<name>` locators, and withholds
dependency URLs and host filesystem metadata. Builtins preserve their `builtin` source and `builtin:`
locators, precede external catalog entries and advertise no file or execution directory.
External entries carry `resourceAccess: "remote"` in the guest's skill metadata. Their catalog
advertises loading by name and `read_skill_resource`, with no filesystem path. Body disclosure
states that no skill directory is mounted, suppresses package-root execution hints, and directs
helper use through complete resource reads and preparation in a writable workspace directory before
the ordinary guarded shell. Relative resource names are never advertised as guest filesystem paths.
Production: `skillInfo` and `createHostSkillsGrant` in
[skills-bridge.ts](../../packages/kernel/src/runtime/skills-bridge.ts), and `formatSkillBody` in
[disclosure.ts](../../packages/skills/src/disclosure.ts).
Test: remote catalog/body access and builtin parity in
[runtime-skills-bridge.test.ts](../../packages/kernel/tests/unit/runtime-skills-bridge.test.ts).
The real-container journey in
[local-docker-runtime.e2e.test.ts](../../packages/kernel/tests/integration/local-docker-runtime.e2e.test.ts)
reads a helper and its relative dependency through the skill bridge, prepares their directory tree
inside the writable workspace, and verifies the helper's output through the guarded shell.
`runtime.skills` revision `v2` returns canonical model-facing text, formatted on the host through
`@clarvis/skills/capability` after safe metadata projection. It discloses only bodies and
bounded text resources for names present in that admitted catalog, rejecting traversal, unknown
names and additional fields. Active plugins' bootstrap declarations are resolved against that same
admitted provider snapshot and only their bounded bodies are added to the guest prompt; inactive or
foreign-root declarations are not projected, and no skill root is mounted or serialized. A body
request is exactly `{operation: "load", name}`. A resource request is the separate exact
`{operation: "resource", name, resource, offset}` shape with an explicit byte cursor and a safe
relative path. The model-facing contracts mirror that separation as `load_skill({name})` and
`read_skill_resource({name, resource, offset})`; aliases, omitted fields and additional fields are
rejected before host provider access. `formatSkillResourceChunk` applies the same byte size, character
and exact continuation checks as the native handler. `formatSkillResourceLegacy` bounds an
offset-zero whole-resource read without advertising an unsupported next cursor.
Production: [disclosure.ts](../../packages/skills/src/disclosure.ts) and
[skills-bridge.ts](../../packages/kernel/src/runtime/skills-bridge.ts). Test:
[runtime-skills-bridge.test.ts](../../packages/kernel/tests/unit/runtime-skills-bridge.test.ts) compares
native/guest builtin disclosure, catalog priority, invalid pages and whole-resource fallback.

Memory uses the exact `runtime.memory` companion bridge. The host resolves the selected provider,
keeps its configuration, credentials, store and policy private, and serializes only a
provider-opaque digest, seed bound and the fixed `list_memories`, `query_memories`, `read_memory` and
`grep_memories` vocabulary. The guest builds only those canonical tools. `write_memory`,
`edit_memory` and `delete_memory` are absent from its tool definitions and prompt, and the host
grant rejects a forged mutation even when the selected provider is writable. After the guest sends
the completed trace record to the host, its lifecycle callback asks the host to execute the
canonical post-run enqueue. The resulting dedicated indexing pass remains on the file host's direct
Loop executor rather than re-entering the container coordinator, so the guest never receives
memory-store or mutation authority.

Production and development have intentionally different artifact acquisition paths. The production
`Containerfile.runtime` accepts only a canonical
`ghcr.io/getclarvis/clarvis-runtime-artifact@sha256:<digest>` carrier and a digest-pinned Debian base;
it copies only `/clarvis-runtime` and `/licenses` from that carrier, never repository source,
workspace manifests, `node_modules`, or build tools. Its final stage adds only Git, CA certificates,
the checksum-verified mise 2026.8.2 binary and mise's license. Node, npm, Python, Rust, compilers,
curl and archive utilities are absent from that final stage. The source-owned mise version and
Linux amd64/arm64 SHA-256 values select one verified upstream archive in a throwaway download stage.
Agents with `run_commands` receive a prompt explaining `mise x <tool>@<version> -- <command>`;
installed toolchains stay outside both the read-only root and selected workspace. Both engines supply
`/mise` from their host-created local cache volume. This is
a developer-tool bootstrap, not a general guest system-package manager: the guest cannot mutate the
read-only Debian root through `apt` or `dnf`.
`Containerfile.runtime-development` is the sole source-building carrier: it copies every workspace
manifest before `bun install --frozen-lockfile`, then compiles `tooling/runtime/guest-entry.ts` to one
standalone executable. The normal development command builds that local carrier and feeds it through
the exact production Containerfile. Docker is the default CLI; Podman is an explicit compatible
selector. Every mode returns the local immutable image ID, and runtime launch still occurs only from
the separately configured local image ID.

Docker recipe customization is a separate host runtime operation, not part of either release-image
pipeline. `runtime.recipe` has the strict shape `{name, script, network?}` and is global-only with the
rest of runtime placement. `name` is a bounded safe label, `script` must be an absolute path that
resolves inside the global operator-owned `runtime-recipes/` directory, and build networking
defaults to `outbound`; `internet` and arbitrary Dockerfile/engine args are not accepted. At the
first cold Docker launch, `resolveDockerRuntimeRecipe` opens the final path without following a
symlink, verifies its single-linked opened inode still resolves inside that directory, and captures
a stable non-empty regular UTF-8 file no larger than 1 MiB. It hashes the captured descriptor bytes,
then combines that digest with recipe schema/name/network, the fixed builder-policy digest and the
inspected immutable base image ID. Changing any input selects another derived-image tag. A ready
generation does not watch the operator script; edits are
captured when the next cold Docker generation resolves its image.

The host acquires a heartbeat-backed cross-process lease from the global runtime-recipe state tree,
then rechecks the cache so two Clarvis processes do not both perform the normal first build. Its
generated private context contains only `.dockerignore`, a fixed `Containerfile`, and the captured
`recipe.sh`; it contains no workspace, settings, credentials or arbitrary Dockerfile. Proxy build
arguments are explicitly blank. A fixed BuildKit bind mount runs the bytes with `/bin/sh -eu`, then
removes package-manager caches in that same layer, so the recipe file itself is not copied into an
image layer. The operator script runs as root with its configured build network and can therefore
install system or mise content deliberately; this authority belongs to the operator who edited the
global setting, never to the model or guest. The recipe is not a secret channel: Clarvis exposes no
build-secret input, and credentials embedded in its bytes, commands, installed files or output may
persist at the selected engine.

The derived image inherits the minimal base and adds only layers produced by that script. Exact OCI
labels bind the recipe schema, safe name, script digest, builder digest, cache key and base ID; the
resolver rejects a pre-existing mismatched tag and re-inspects the completed image before returning
its local `sha256` ID. Matching images are reused across application sessions. Recipe capture, base
identity, build, label or retention failures use `runtime_recipe_invalid`, `runtime_recipe_failed` or
`handshake_mismatch` and remain fail-closed; they never substitute the uncustomized base or native
Sandbox. No recipe path publishes, pushes, commits a running guest container or changes the
canonical released runtime image.

Tag publication builds native `linux/amd64` and `linux/arm64` carrier/final pairs, pushes immutable
per-platform identities, creates two multi-platform GHCR indexes, and emits the strict
`runtime-release.json` mapping of product version, full source commit, protocol revision, platform
set, carrier/final digests, and build/base image digests. The release workflow verifies the tag
against the root product version before its first registry push, attests both OCI subjects, and makes
the portable release publication depend on that manifest. Manual workflow dispatch builds no
runtime image and cannot publish one. The separate candidate workflow builds the same production
Containerfile from an explicitly admitted candidate carrier. Candidate carrier/output namespaces
cannot be used by the default release build mode or the stable manifest parser. Both architectures
run the Docker and rootless Podman integration canaries before candidate index publication.
Production: `tooling/runtime/build-image.ts` (`runtimeImageBuildPlan`),
`.github/workflows/candidate.yml`, `tooling/ci/qualify-runtime.sh`. Test:
`tooling/tests/unit/candidate.test.ts`, `tooling/tests/unit/distribution-workflows.test.ts`, and
`packages/kernel/tests/integration/local-docker-runtime.e2e.test.ts`.

Model leases keep destinations and credentials host-side and enforce provider/model, expiry,
concurrency and byte allowances. Capability grants enforce exact method, revision, argument schema,
cancellation and call identity; only completed explicitly idempotent results may be reused.

Production: `createExecutionPeer` in `packages/kernel/src/runtime/execution-rpc.ts`;
`serveExecutionWorker` in `packages/kernel/src/runtime/execution-worker.ts`; brokers in
`packages/kernel/src/runtime/authority-brokers.ts`; `createRuntimeHostHandlers` in
`packages/kernel/src/runtime/host-execution-bridge.ts`; `createGuestLoopExecutor` in
`packages/kernel/src/runtime/guest-loop-executor.ts`; `RUNTIME_PROTOCOL_REVISION` in
`packages/kernel/src/runtime/protocol-revision.ts`; `createGuestGuardAuditLogger` and
`forwardGuestGuardAudit` in `packages/kernel/src/runtime/guard-audit-bridge.ts`;
`createRuntimePreviewCapability` in `packages/kernel/src/runtime/preview-capability.ts`;
`createHostPlansGrant` and `createGuestPlanFactory` in
`packages/kernel/src/runtime/plan-bridge.ts`; `createRuntimeSkillCatalog`,
`createRuntimeSkillBootstraps`, `createHostSkillsGrant` and `createGuestSkillsCapability` in
`packages/kernel/src/runtime/skills-bridge.ts`;
`createHostMemoryBridge`, `validRuntimeMemoryDescriptor` and `createGuestMemoryCapability` in
`packages/kernel/src/runtime/memory-bridge.ts`; `prepareMemoryRuntime` in
`packages/memory/src/capability.ts`; `executeExtensionProfileRun` and the `MemoryFactory`
construction in `packages/kernel/src/file-kernel.ts`;
`installBundledAjvModules` in
`packages/loop/src/validation/ajv.ts`; `tooling/runtime/guest-entry.ts`; both root runtime
Containerfiles; `runtimeImageBuildPlan` in `tooling/runtime/build-image.ts`;
`resolveDockerRuntimeRecipe` in `packages/kernel/src/runtime/runtime-recipe.ts`;
`createRuntimeReleaseManifest` in `tooling/runtime/release-manifest.ts`;
`.github/workflows/release.yml`.

Test: `packages/kernel/tests/contract/runtime-execution-rpc.test.ts`;
`packages/kernel/tests/unit/runtime-authority-brokers.test.ts`;
`packages/kernel/tests/unit/guard.test.ts` (`mise x` bootstrap admission);
`packages/kernel/tests/integration/runtime-execution-worker.test.ts`;
`packages/kernel/tests/integration/runtime-guest-loop.test.ts`;
`packages/kernel/tests/unit/runtime-guard-audit-bridge.test.ts`;
`packages/kernel/tests/unit/runtime-plan-bridge.test.ts`;
`packages/kernel/tests/unit/runtime-skills-bridge.test.ts`;
`packages/kernel/tests/unit/runtime-memory-bridge.test.ts` (including forged-mutation refusal);
`packages/memory/tests/component/factory.test.ts` (`routes every indexer pass through the host-owned
run executor`);
`packages/loop/tests/architecture/eager-validator-boundary.test.ts`;
`packages/kernel/tests/unit/runtime-recipe.test.ts`;
`packages/kernel/tests/integration/runtime-recipe.e2e.test.ts` (explicitly gated);
`tooling/tests/architecture/runtime-containerfiles.test.ts`;
`tooling/tests/unit/runtime-image-build.test.ts`;
`tooling/tests/unit/runtime-release-manifest.test.ts`;
`tooling/tests/unit/release-assets.test.ts`;
`tooling/tests/unit/release-readiness.test.ts`.

## 6. Checkpoints and terminal settlement

The host persists bounded monotonic checkpoints per generation and run. The guest can report a
non-terminal reconstruction checkpoint only after its complete execution record has crossed into
the host trace store. When Memory is active, its guest lifecycle callback can request the canonical
host `onRunEnd` only after that durable trace is readable by the host bridge; enqueueing and indexing
stay on the host. After the guest result returns, the isolated run adapter, not the guest, writes the
next terminal checkpoint only after session, trace and capability participants complete their
durable commit. Workspace writes are already live through the direct bind and are not a staged
terminal participant or an implied atomic transaction.

Production: `appendRuntimeCheckpoint`, `loadRuntimeCheckpoint` and `settleRuntimeTerminal` in
`packages/kernel/src/runtime/runtime-checkpoints.ts`; `createIsolatedRunExecutor` in
`packages/kernel/src/runtime/isolated-run-executor.ts`.

Test: `packages/kernel/tests/integration/runtime-checkpoints.test.ts`;
`packages/kernel/tests/integration/isolated-run-executor.test.ts`;
`packages/kernel/tests/integration/runtime-guest-loop.test.ts` (trace-before-memory-finish ordering).

## 7. Workspace and container engines

Both backends receive the same host-admitted mount specification: one read-write selected workspace
at `/workspace`, zero or more workspace-relative read-only overlays, and the optional read-write Git
common directory for a linked worktree. They create the container first, inspect the effective
mount sources, destinations, types and write modes, and refuse attach if the engine widened or
changed that set. `container-policy.ts` owns the common effective-policy validator; engine adapters
normalize only identity, capability and cache-subpath facts. Both require the admitted generation,
network, read-only root, unprivileged mode, exact CPU/memory/process limits and mount set, empty added
capabilities, an explicitly enabled `no-new-privileges`, and exactly one bounded non-executable `/tmp`.
Missing fields, disabled or conflicting privilege options, widened scratch mounts and limits refuse
attachment and trigger cleanup. Production: `readContainerInspection` and `validContainerPolicy` in
[container-policy.ts](../../packages/kernel/src/runtime/container-policy.ts). Test: the shared
[container-policy-cases.ts](../../packages/kernel/tests/helpers/container-policy-cases.ts) matrix is
executed by both [runtime-docker-backend.test.ts](../../packages/kernel/tests/unit/runtime-docker-backend.test.ts)
and [runtime-podman-backend.test.ts](../../packages/kernel/tests/unit/runtime-podman-backend.test.ts).

The Podman backend verifies rootless mode and the engine-resolved local image `Id` (not its distinct
manifest `Digest`). It canonicalizes a complete lowercase hexadecimal ID to `sha256:` and rejects
short, malformed or mismatched identities. It runs as operator-mapped `0:0`, explicitly pins Podman's
rootless user namespace (`--userns=host` within rootless Podman, not host root), drops all capabilities,
applies `no-new-privileges`, selects `none` or private bridge `outbound`, and makes the base
filesystem read-only with a bounded non-executable `/tmp`. Automatic extra read-write tmpfs mounts
are disabled; no driver-specific `overlay.size` quota is requested. Before attach,
`validEffectiveInspect` checks the user and user namespace, rootfs mode, empty effective/bounding capabilities,
no-new-privileges, CPU/memory/process limits, exact scratch mount and admitted bind/volume set.
Podman serializes empty capability sets as null or empty arrays; missing fields are refused.
Its concrete CLI port requires an absolute executable, explicit connection/environment, argv
execution and output/time bounds and is exported only from `@clarvis/kernel/local`.

Podman requests shared SELinux relabeling only on the admitted workspace, read-only overlays and
optional Git common directory. This changes labels recursively on those selected host files and
keeps SELinux enforcement active; it never relabels global extension or credential roots. The
rootless operator must own the selected writable workspace files. The engine-private cache uses the
same schema-2 identity and initializer as Docker: initialization uses a full-volume `nocopy` mount,
and the guest receives only `subpath=data`. The initializer consumes first-use copying before guest
attachment. The engine-reported `SubPath` must match admission, and the live isolation canary
verifies that the initialization marker cannot be observed through `/mise`.

The Docker backend accepts only a Linux engine. It resolves the configured `sha256` image ID before
creation, selects `none` or the explicit `bridge` outbound network, makes the image root filesystem
read-only, provides bounded non-executable `/tmp`, drops every capability, applies
`no-new-privileges` and verifies the shared effective CPU/memory/process and scratch policy before attach. In addition to
the admitted binds, it mounts one Docker `local` volume at `/mise`. The host derives that volume's
opaque name from schema, owner, project, workspace, effective UID/GID and exact image ID; it creates and re-inspects
exact identity labels before container admission. A different workspace, image or user cannot reuse it.
Rootful Docker selects the invoking operator's numeric UID/GID, while rootless Docker selects
operator-mapped `0:0`. Rootful `userns-remap` is refused. Effective container `Config.User` must match
before attachment; a writable bind alone does not grant Unix write permission.
The schema-2 cache mounts only its `data` subdirectory with `volume-nocopy`. A bounded helper using
the exact admitted image, no network, no workspace bind and only `CHOWN` seeds image `/mise` content
and assigns its ownership on first use. Its initialization marker stays outside the guest-mounted
subdirectory. Later starts validate the marker and ownership without recursively rewriting guest
content. Older schema-1 volumes are retained but not reused or migrated. The engine must support
volume subpath mounting; an ineffective mount is refused before attach.
Docker Desktop and Colima are host implementations of the same Docker contract; neither gains
access to model credentials, which remain behind the host model lease. The guest may mutate the
volume, but the Clarvis host process never mounts or executes its contents; persistence carries the
same-workspace guest tool cache across Clarvis sessions. Docker's local volume driver supplies no
portable hard byte quota, so `storage_bytes` bounds `/tmp` and does not claim to bound `/mise` or the
selected workspace bind. On normal shutdown each backend attempts a graceful stop and then requires
force-removal of the exact generated container name without `--volumes`; removal failure is returned
and a later close retries that removal.

Both concrete CLI adapters delegate bounded process ownership to `createNodeContainerControl`;
engine context/connection and argv prefixes stay in their adapters. Cancellation sends `SIGTERM`,
retains the command deadline and escalates after a 500 ms grace. A deadline or output overflow kills
immediately. Capture never grows beyond its per-stream bound, including while termination is pending.
The command promise settles after physical exit and stream closure; inherited pipes have a bounded
post-exit drain and cannot turn truncated output into success. The shared process helpers own POSIX
group termination and Windows tree termination; detached creation is platform-gated.
Production: [node-container-control.ts](../../packages/kernel/src/adapters/process/node-container-control.ts)
and the engine ports in [types.ts](../../packages/kernel/src/runtime/types.ts).
Test: [node-container-control.test.ts](../../packages/kernel/tests/integration/node-container-control.test.ts)
checks routing, bounds, spawn errors, streams and real POSIX children that ignore `SIGTERM`.

Neither backend uses host networking or publishes a container port. `createRuntimePortPreview`
accepts only a numeric guest port and display scheme, probes the already-running guest through the
fixed `/usr/local/bin/clarvis-runtime preview-probe` argv, binds only host `127.0.0.1`, and relays raw
TCP through a fixed engine `exec` path. It prefers the same numeric host port, falls back to an
ephemeral loopback port on collision, caps one runtime at 16 distinct mappings and 32 simultaneous
connections, reuses a mapping idempotently, and closes listeners before container shutdown. The
guest cannot select a host address/port, executable or engine arguments and receives no engine
socket. `http`, `https` and `tcp` affect only the returned URL scheme; the broker does not terminate
TLS.

Production: `createPodmanRuntimeBackend` in `packages/kernel/src/runtime/podman-backend.ts`;
`createNodePodmanControl` in `packages/kernel/src/adapters/process/node-podman-control.ts`;
`createDockerRuntimeBackend` in `packages/kernel/src/runtime/docker-backend.ts`;
`miseCacheIdentity`, `prepareMiseCache` and `prepareCacheOwnership` in
`packages/kernel/src/runtime/container-mise-cache.ts`;
`resolveDockerRuntimeRecipe` in `packages/kernel/src/runtime/runtime-recipe.ts`;
`createNodeDockerControl` in `packages/kernel/src/adapters/process/node-docker-control.ts`;
`createRuntimePortPreview` and `createContainerRuntimePortPreview` in
`packages/kernel/src/runtime/port-preview.ts`; `runPreviewRelayCommand` in
`packages/kernel/src/runtime/preview-relay.ts`.

Test: `packages/kernel/tests/unit/runtime-podman-backend.test.ts`;
`packages/kernel/tests/unit/runtime-docker-backend.test.ts`;
`packages/kernel/tests/integration/runtime-docker-identity.e2e.test.ts` (explicitly gated Linux DAC
and persistent-cache canary, exercised through a Linux engine rather than macOS shared-file modes);
`packages/kernel/tests/unit/runtime-recipe.test.ts`;
`packages/kernel/tests/integration/runtime-recipe.e2e.test.ts`;
`packages/kernel/tests/integration/runtime-port-preview.test.ts`;
`packages/kernel/tests/integration/runtime-preview-relay.test.ts`;
`packages/kernel/tests/integration/local-docker-runtime.e2e.test.ts` (explicitly gated live
Docker/Colima or Podman canary);
`packages/kernel/tests/integration/runtime-podman-isolation.e2e.test.ts` (rootless identity, effective
security and cgroups, offline networking, scratch disposal and persistent cache partitioning).

## 8. Current evidence and explicit limits

The shared `local-docker-runtime.e2e.test.ts` canary selects `createLocalPodmanRuntime` and
`createNodePodmanControl` when `CLARVIS_PODMAN_RUNTIME_CANARY=1`, using the explicit
`CLARVIS_PODMAN_RUNTIME_CONNECTION` and `CLARVIS_PODMAN_RUNTIME_IMAGE_DIGEST` inputs. The existing
Docker inputs remain the default. Both selections exercise the same assertions with a synthetic
host LLM. Podman also has a live isolation/cache canary; recipes and the rootful DAC canary remain
Docker-specific.

The opt-in Docker/Colima canaries exercise a real Linux engine and worker with a synthetic host LLM:
linked Git worktrees, host skill/plugin/Memory reads, denial of Memory mutations, immediate workspace
writes, mise/npm outbound installation, host-loopback preview, steering, cancellation/recovery,
operator recipes and persistent cache reuse. The Linux DAC canary uses an engine-owned Linux
filesystem with ordinary 0755/0644 ownership rather than relying on macOS shared-filesystem modes.
It confirms that capability-free root cannot write those files but the selected operator UID/GID can.

Deterministic guest-loop composition tests cover host blocking hooks, canonical bound Tasks,
Admiral/leader execution and shared output budgets. Broker/RPC tests cover auxiliary-model admission,
incremental output before provider completion or failure, cancellation, strict progress identity and
bounded queues. Lifecycle tests cover rejected steering acknowledgements, unconditional authority
revocation and failed cleanup retained for retry. These are separate proof methods: a passing
synthetic canary is not proof of a live subscription, and a PTY subscription run is not proof of
every provider or platform. Exact artifact identities, commands and completed validation results
belong in the change's evidence/handoff, rather than a stale image digest in this contract.

Local qualification covers Docker through Colima and rootless Podman on native Linux/amd64 with
SELinux enforcing and Btrfs-backed storage. It does not qualify Docker Desktop, native rootful
Docker, Linux/arm64, Windows or Podman machine on macOS. External reconciliation after an abrupt host
failure is not implemented. Both engines' persistent `/mise` volumes and the selected workspace bind have no portable
hard `storage_bytes` quota. The read-write Git common mount grants repository-wide metadata, and
an outbound guest can transmit readable workspace content or reach host/LAN services. Public-only
`internet` enforcement remains unavailable and is refused; only `none` and the broader
`outbound` policy are admitted.
