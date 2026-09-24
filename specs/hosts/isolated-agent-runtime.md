# Isolated Container Kernel

## Purpose

Docker and Podman are process placements for one complete Clarvis Kernel. The TUI connects through
the public `KernelClient` contract to a Kernel whose loop, tools, sessions, Plans, Memory,
Workflows and Goals all execute inside the selected Container. The selected host workspace is bound
read-write at `/workspace`; Clarvis configuration, credentials and provider API calls remain on the
host.

Container is selected before any Kernel is constructed. A selected Container never falls back to
Host or Sandbox. An idle isolation save re-resolves the destination, closes the current connection,
admits the replacement, and only then publishes its effective runtime. A refused or failed
replacement remains saved and pending reconnect; it cannot continue executing through the old
placement.

Production: `connectLocalContainerKernel` in
`packages/kernel/src/hosting/connect-local-container.ts`;
`WorkspaceClientManager.create` in
`packages/code/src/adapters/workspace-client-manager.ts`.
Test: `packages/code/tests/component/workspace-client-manager.test.ts`;
`packages/kernel/tests/integration/container-kernel.e2e.test.ts`.

## Process and transport topology

The application process owns a launcher instance and the Docker or Podman CLI process created with
attach and interactive pipes, without a TTY. Exactly one Kernel process runs in the Container. The
launcher owns inspection, immutable image and artifact selection, mounts, external namespace lease,
model authority, shutdown and removal of the disposable Container. It does not own runs or domain
stores.

The physical stdio pair begins in each direction with `CLARVIS-CONTAINER/1\n`. Frames contain a
one-byte channel, a four-byte big-endian payload length and 1 to 65,536 bytes. Channel 1 carries the
public Kernel transport, channel 2 carries only `container.initialize` and
`container.shutdown`, and channel 3 carries only `model.call` plus `model.delta`
notifications. The multiplexer treats payloads as bytes and reuses the stdio request, response,
notification and cancellation codec on every virtual stream.

The physical queue is bounded to 32 MiB and 1,024 frames. A slow virtual reader applies
backpressure; invalid channels, zero or oversized lengths, prefix mismatch and partial EOF close all
lanes. JSON framing retains an 8 MiB line limit, 64 MiB logical-message limit, 128 MiB queue and 128
inbound requests per lane.

Production: `createContainerChannel` in
`packages/kernel/src/hosting/container-channel.ts`; `createStdioTransport` and
`serveKernelOverStdio` in `packages/kernel/src/transport/stdio.ts`.
Test: `packages/kernel/tests/contract/container-channel.test.ts`;
`packages/kernel/tests/contract/stdio-response-sent.test.ts`;
`packages/kernel/tests/integration/container-launcher.test.ts`.

## Bootstrap and identity

The host first resolves the canonical workspace, operator identity, namespace, base, artifact,
engine and effective limits. The exact local base image ID, ABI and base revision are admitted before
any preflight or volume preparer can execute. It creates and inspects the Container before attaching.
From attach through ready and the public hello, boot shares one absolute 30-second deadline rather
than restarting it for each phase. Base acquisition and artifact preparation have cancelable
ten-minute deadlines; an operator recipe build remains a separately cancelable 30-minute
preparation.

Initialization is strict, single-use and limited to 8 MiB, with configuration limited to 4 MiB. It
contains the generation UUID, public project and workspace DTOs, bare namespace hash, admitted
owner, inspected engine and host platform, network mode, local base image ID, base ABI, artifact and
configuration digests, frozen configuration and a secret-free model lease. Paths are fixed by the
entrypoint and cannot be supplied in the message.

The guest verifies the configuration digest, artifact target, base ABI and wire, broker and channel
versions before constructing services. The ready reply repeats generation and digests. The launcher
then opens model dispatch and performs public wire version 11 hello. Memory recovery starts once,
after the first successful hello response is sent.

Production: `parseContainerInitialize` in
`packages/kernel/src/hosting/container-contract.ts`; `serveContainerKernel` in
`packages/kernel/src/hosting/container-bootstrap.ts`; `connectContainerKernel` in
`packages/kernel/src/hosting/container-launcher.ts`.
Test: `packages/kernel/tests/contract/container-contract.test.ts`;
`packages/kernel/tests/integration/container-launcher.test.ts`;
`packages/kernel/tests/contract/transport-codecs.test.ts`.

## Native composition

`createNativeKernel` is the common native service graph. File hosting supplies file-backed
operator configuration and provider effects. Container hosting supplies a strict in-memory
`ContainerConfiguration`, a model provider connected to channel 3, an empty connection manager,
builtin tools, and fixed `skills=false`, `hooks=false`, `allowHostEscalation=false`.
The composition also contributes a required system section through the native capability seam. It
states that the run is in a Container Kernel, names the admitted Docker or Podman engine and network
mode, and identifies the guest workspace root. The host path backing the bind remains private; the
section explicitly distinguishes host-brokered model requests from network access available to
guest tools. Entry agents, delegated children, workflows, Goals and Memory indexing inherit the same
generation-fixed facts.

Plans use the Markdown provider. Memory uses local wiki or admitted workspace-relative file paths
and keeps native seed, write, delete and index behavior. Workflows, leaders, Goals, sessions,
journals and continuation execute inside the same Kernel. Disabled Plans or Memory retain their
native disabled semantics. Goal plus manager Workflow remains subject to the ordinary Goals
contract.

Goal Steward uses that same guest-native Goal hosting path and injected model execution resolver.
Its read-only tools inspect the guest workspace; credentials and provider adapters remain on the host.
Production: `goalStewardRuntime`, `createStewardExecutionRuntime` and `prepareHostedGoalTurn`.
Test: `native Goal pauses, survives Kernel recreation, and resumes explicitly` in
[container-kernel-host.test.ts](../../packages/kernel/tests/integration/container-kernel-host.test.ts)
exercises native composition with a controlled broker; physical engine qualification remains separate.

Legacy Goal auto/guided formulation is also native to the guest Kernel. Its semantic run uses the same
admitted workspace root, canonical read-only Tools capability, owner-scoped trace store, runtime
placement and logical model resolver as other guest runs. The host broker accepts the distinct
`goal` call purpose but receives no prompt policy, provider selection or tool authority from the
guest DTO. Configuration projection carries only the non-contributable `goals.agent` model/limit
policy already admitted by the host. No host-filesystem bridge substitutes for guest workspace
reads, and external MCP, skills, hooks, Tasks, Plans, Memory, Workflows, Goal controls and delegation
remain absent from formulation.

The public `goals.formulate` request/result/receipt crosses the same version 11 Kernel transport as
Host/Sandbox. Goal state, sessions and formulation traces remain in canonical owner-scoped stores,
so idle placement changes retain receipts and provenance. A legacy formulation run is not a conversation
turn, and an interrupted Container does not invent a receipt or replay an unknown creation.

Production: `createContainerNativeKernel` in
`packages/kernel/src/hosting/container-native.ts`, `createKernelGoalAgentRuntime` in
`packages/kernel/src/goals/agent-runtime.ts`, and purpose validation in
`packages/kernel/src/hosting/container-model-contract.ts`.
Test: `packages/kernel/tests/integration/goal-formulate-service.test.ts` establishes the common native
service/runtime seam; Container process and real-engine formulation remain distributable canary
evidence rather than an inference from that test.

Tasks is unavailable because its only provider is MCP. Plugins, external Skills, external Hooks,
generic MCP and executable or plugin capability providers are neither loaded nor exposed. An
explicit Task, Skill, external grant, incompatible profile or external active Plans or Memory
provider fails before inference or provider startup. Merely having inactive host settings for such
providers does not block an otherwise native run.

Production: `createContainerNativeKernel` in
`packages/kernel/src/hosting/container-native.ts`; `createNativeKernel` in
`packages/kernel/src/native-kernel.ts`; `projectContainerConfiguration` in
`packages/kernel/src/config/container-projection.ts`.
Test: `packages/kernel/tests/integration/container-kernel-host.test.ts`;
`packages/kernel/tests/unit/container-projection.test.ts`;
`packages/code/tests/integration/container-run-host.test.ts`.

## Configuration and application facade

The host projects schema version 2 configuration once per generation. The schema recursively rejects
unknown fields and contains effective defaults, builtin/global/workspace Agent Profiles, prompts,
context, Memory policy, local Plans and Memory settings, native Workflow definitions, logical model
metadata, loop policy and tool ceiling. It excludes provider endpoints, credentials, MCP, Tasks,
plugins, hooks, skills, engine settings, process environment and subscription state. A version 1
projection or legacy tool-confinement field is rejected before the guest executes. Production:
`parseContainerConfiguration` in `packages/kernel/src/config/container-projection.ts` and
`projectContainerConfiguration` in the same file. Test:
`packages/kernel/tests/unit/container-projection.test.ts`.

The projection is canonical-JSON hashed and immutable. Guest configuration reads come from
`createContainerConfigStore`; all writes and trust changes are unsupported. Workspace changes to
`.clarvis/settings.json`, agents or workflow definitions do not recompose the current generation.
An operator save remains host-side and is shown as pending reconnect. `/model` immediately requests
an idle reload after its committed save; success admits the selected model into a new generation,
while failure leaves the save explicitly pending. Reload refuses while a hosted run is physically
active. Memory shutdown releases an in-flight claim back to the shared durable queue without
spending an attempt, and the replacement Kernel recovers pending work. A persisted `unknown` outcome
remains recoverable but does not claim current physical work. Secret and subscription revocation synchronously fences the
matching broker authority, including automatic subscription invalidation; it does not wait for a
future reload.

The Code facade routes runs, hosting, sessions, goals, plans, memory, workflows, files and storage to
the guest. It routes config, secrets, models and provider authentication to
`createOperatorServices` in the application process. Plugins, Skills and Tasks expose empty or
unavailable views and reject mutations. The immutable guest Extension Profile remains
`builtin:container`. `localHost` is absent.

Production: `composeContainerClient` in
`packages/code/src/adapters/container-client.ts`; `createOperatorServices` in
`packages/kernel/src/config/operator-services.ts`;
`createContainerConfigStore` in
`packages/kernel/src/config/container-projection.ts`.
Test: `packages/code/tests/integration/container-client.test.ts`;
`packages/kernel/tests/integration/operator-services.test.ts`;
`packages/kernel/tests/integration/kernel-service-overrides.test.ts`.

## Logical models and host broker

The guest resolves every entry, child, vision, compaction and Memory model through
`ModelExecutionResolver`. Logical metadata contains provider and model names, kind, context and
output limits, capabilities, reasoning efforts and prompt-cache mode. It contains no endpoint or
authentication configuration. When the resolver is present, a run with a non-empty provider
configuration is invalid and legacy provider resolution is not called. Host and Sandbox retain the
existing resolver path when this port is absent. If logical metadata omits a maximum output size,
the guest resolves the model context window as the conservative call ceiling; Workflow aggregate
budgets therefore cannot construct a request above the broker's independently enforced bound.

The host creates one 256-bit lease for a generation, bound to the physical channel, owner, namespace,
generation and exact logical model pairs. It expires within 24 hours. The broker independently
limits concurrency, queue length, input and response bytes, timeouts, retries and an aggregate token
ceiling. It reserves conservatively before dispatch, charges reported usage from all attempts
without double-counting cache subsets, and retains the reservation when usage or outcome is unknown.

`model.call` accepts a closed DTO. The host resolves the actual provider and account, constructs
`LLMCallParams` field by field, and streams text, tool-input and retry events in increasing
sequence. Remote media and file paths are refused. Duplicate call IDs never dispatch again. EOF,
shutdown, expiry, credential revocation and generation replacement revoke queued, active and future
calls without account fallback.
The tool schema preserves native `NamespacedTool` identity: builtin tools carry the established empty
`mcpName` marker, while their full, wire and local names remain nonempty and bounded. Accepting that
marker does not add an MCP catalog or external dispatch path to the guest.

Production: `createContainerModelBroker` in
`packages/kernel/src/runtime/model-broker-host.ts`;
`createContainerModelProvider` in
`packages/kernel/src/runtime/model-broker-client.ts`;
`ModelExecutionResolver` in `packages/capability/src/model-execution.ts`.
Test: `packages/kernel/tests/unit/container-model-broker.test.ts`;
`packages/kernel/tests/integration/container-model-stream.test.ts`;
`packages/loop/tests/integration/model-execution-injection.test.ts`;
`packages/loop/tests/unit/model-execution.test.ts`.

## Filesystem and persistence

The namespace is the full SHA-256 of canonical JSON containing schema 1, Container placement,
operator ID, canonical global root, project ID and canonical workspace root. Engine, generation,
artifact and credentials do not enter it. A host lease under
`state/container-hosts/<namespace>` serializes all engines and records only exact lifecycle
identity.

The guest mounts:

| Target | Source | Access |
| --- | --- | --- |
| `/workspace` | selected canonical host workspace | read-write |
| `/workspace/.clarvis` | namespace content volume, `data` subpath | read-write |
| `/var/lib/clarvis` | namespace state volume, `data` subpath | read-write |
| Plans and Memory content plus their machinery | exact canonical host workspace/state subdirectories overlaid below the private volumes | read-write |
| owner-scoped sessions, workflow records and traces | exact canonical host state subdirectories overlaid below the private state volume | read-write |
| `/workspace/.agents` and protected roots | prepared empty masks | read-only |
| Git directory and common directory | canonical host metadata; linked-worktree indirection rewritten to fixed POSIX guest targets | read-only |
| `/opt/clarvis` | artifact digest volume, `payload` subpath | read-only |
| `/mise` | admitted cache volume keyed by namespace and exact base image ID, `data` subpath | read-write |
| `/tmp` | bounded tmpfs | read-write, noexec, nosuid, nodev |

The launcher requires the nested targets `.clarvis` and `.agents` to exist as directories before
engine create. A non-Git workspace additionally requires an existing empty `.git` directory for its
read-only mask. Docker and Podman can otherwise create a missing nested target in the host bind with
engine ownership; Clarvis returns `unsupported_policy` instead of changing the workspace to launch.

The two data volumes have exact names and labels for schema, namespace and role. Existing label,
schema, readiness or ownership disagreement fails closed. Existing nonempty partial initialization
requires recovery. No close or update deletes data volumes. The volumes retain Container-only home,
hosted registry and physical lifecycle state. Plans, Memory, sessions (including Goals and persisted
conversation context), workflow records and traces use the same canonical host stores in
Host/Sandbox and Container, so an idle placement change preserves control and history. The launcher
binds only the exact owner/workspace subdirectories; settings, credentials, extension state and
other owners remain outside the guest. Trace records retain their existing owner-scoped global path,
while their cross-process locks use the workspace state tree. A bounded one-time preparer validates
the canonical mount roots and marks legacy private-volume domain directories as retired. Canonical
host data always wins; divergent legacy bytes stay hidden and cannot block a new generation.

Production: `resolveContainerVolumeIdentity` and `prepareContainerVolumes` in
`packages/kernel/src/runtime/container-volumes.ts`; `containerDataVolumeNames` and
`containerLaunchPaths` in `packages/paths/src/container.ts`;
`prepareRuntimeMounts` and `prepareContainerDomainMounts` in
`packages/kernel/src/runtime/container-mounts.ts`; `migrateContainerDomainState` in
`packages/kernel/src/runtime/container-volumes.ts`.
Test: `packages/kernel/tests/unit/container-volumes.test.ts`;
`packages/kernel/tests/unit/runtime-mounts.test.ts`;
`packages/paths/tests/unit/container.test.ts`.

## Base and compiled artifact

The OCI base contains Debian bookworm, Git, certificates, mise, archive utilities and the stable
artifact preparer. It has ABI `clarvis-linux-glibc-v1` and a content-derived base revision. It
contains no Clarvis Kernel version. A host-owned recipe may derive another base from it; recipe cache
identity includes base digest, ABI target and exact recipe bytes, never product version or artifact
digest.

The product artifact is `clarvis-kernel-<target>.tar.gz` for `linux-x64` or
`linux-arm64`. Its root has `manifest.json`, `bin/clarvis-kernel`, `LICENSE` and declared
licenses or assets. The strict manifest records product version, full source revision, dirty state,
target, ABI and wire, broker and channel versions, plus an ordered list of regular files and hashes.
The archive is limited to 512 MiB and extraction to 1 GiB, and rejects undeclared entries, traversal,
links, devices, sockets and special permissions.

The builder compiles with Bun using `--compile --env=disable`,
`--no-compile-autoload-dotenv`, `--no-compile-autoload-bunfig`,
`--no-compile-autoload-tsconfig`, `--no-compile-autoload-package-json` and
`--reject-unresolved`. The build Container keeps its root and source checkout read-only and provides
only a 768 MiB `/tmp` tmpfs with `rw`, `nosuid`, `nodev` and `noexec` for Bun's compiler scratch;
Podman implicit tmpfs behavior is disabled so that exact declared mount owns the writable surface.
The entry statically installs the loop's lazy Ajv modules before serving the Kernel, and the
real-engine canary constructs run-time tool validation instead of treating hello as proof of the
compiled dependency closure. The host verifies the archive before transfer. A networkless ephemeral
preparer is created under a deterministic name, inspected for exact policy and mounts before start,
verifies the same archive hash before extraction, and publishes readiness last. An uncertain create
or cancellation is reconciled and removed by exact inspected ID. Kernel Containers only receive the
immutable payload subpath. A labeled cache whose physical verification fails is recreated only after
an exact engine query proves that no Container consumes the volume, its exact removal succeeds and
the engine confirms the name is absent.

Published `runtime-release.json` schema 2 maps each Linux target to an immutable OCI base origin
and digest plus a downloadable artifact basename, hash and size. Updating Clarvis code creates a new
artifact without rebuilding the base.

Production: `runtimeBaseBuildPlan` in `tooling/runtime/build-image.ts`;
`runtimeArtifactBuildPlan` in `tooling/runtime/build-artifact.ts`;
`installBundledAjvModules` in `packages/loop/src/validation/ajv.ts`;
`validateRuntimeArtifact` and `prepareRuntimeArtifactVolume` in
`packages/kernel/src/runtime/runtime-artifact.ts`;
`parseRuntimeReleaseManifest` in `tooling/runtime/release-manifest.ts`.
Test: `tooling/tests/unit/runtime-artifact.test.ts`;
`tooling/tests/architecture/container-native-composition.test.ts`;
`packages/kernel/tests/integration/container-kernel.e2e.test.ts`.

## Effective launch policy

The final Container has a read-only root, nonroot admitted user, all capabilities dropped,
no-new-privileges, bounded PIDs, memory, CPU and tmpfs, fixed cwd and entrypoint, an allowlisted
environment, no engine socket and no implicit mounts. `network=none` or outbound bridge are the
only modes. Model inference over the host pipe remains available under `network=none`; guest tools
cannot use direct network access in that mode.
The tools capability receives explicit Container filesystem placement when the native guest graph
is built. Its immutable run policy describes guest mount scope; it never imports the native
Sandbox's broad host read policy or treats disabled host escalation as a substitute for placement.
An unmounted host path remains outside the guest namespace. Production:
`createContainerNativeKernel` in
[container-native.ts](../../packages/kernel/src/hosting/container-native.ts),
`createAgentToolsCapability` in
[tools.ts](../../packages/loop/src/runtime/capabilities/tools.ts), and
`resolveFilesystemPolicy` in [sandbox.ts](../../packages/tools/src/sandbox.ts). Test:
[container-kernel-host.test.ts](../../packages/kernel/tests/integration/container-kernel-host.test.ts)
(`Container native graph yields and stops a run-owned shell session`, `Container native graph refuses shell escalation to the host`) and the real engine
[container-kernel.e2e.test.ts](../../packages/kernel/tests/integration/container-kernel.e2e.test.ts)
guest filesystem check for an unmounted host path, writable workspace and read-only Git metadata.

The guest's file tools use the same `AgentFilesystem` interface as Host and Sandbox, with local
execution inside the guest Kernel. No host filesystem worker or generic host read/write RPC is
created for Container calls. The host-owned classified configuration reviewer is absent there.
Production: `dispatch` in [core.ts](../../packages/tools/src/core.ts) and
`createContainerNativeKernel` in
[container-native.ts](../../packages/kernel/src/hosting/container-native.ts). Test:
[container-kernel-host.test.ts](../../packages/kernel/tests/integration/container-kernel-host.test.ts)
and the opt-in real-engine file-tool mount canary in
[container-filesystem.test.ts](../../packages/tools/tests/integration/container-filesystem.test.ts),
plus the guest filesystem check in
[container-kernel.e2e.test.ts](../../packages/kernel/tests/integration/container-kernel.e2e.test.ts).

The host inspects the exact local image ID, ABI labels, created Container identity, labels, mounts,
user and effective security policy before attaching. Effective policy requires a complete
capability drop, no additions for the Kernel, one exactly enabled no-new-privileges option and the
exact tmpfs option set. Podman's inspected tmpfs set also includes its canonical `rprivate` and
`tmpcopyup` options; those two engine-added values are required there rather than accepted as
arbitrary extras. Data, artifact and mise preparers are likewise inspected before start with
only their declared mounts and, where required, the single `CHOWN` addition. A remote engine that
cannot share the selected workspace is unsupported. Linux uses the invoking nonroot numeric UID and GID. Qualified
Docker/Podman VM engines use fixed nonroot 1000:1000 after bind-access preflight.

Production: `createContainerKernelBackend` in
`packages/kernel/src/runtime/container-kernel-backend.ts`;
`inspectContainerBaseImage` in `packages/kernel/src/runtime/runtime-image.ts`;
`runContainerPreparer` in `packages/kernel/src/runtime/container-preparer.ts`;
`createDockerKernelBackend` and `createPodmanKernelBackend` in the corresponding runtime
adapters.
Test: `packages/kernel/tests/integration/container-kernel.e2e.test.ts`;
`packages/kernel/tests/unit/container-volumes.test.ts`;
`packages/kernel/tests/unit/container-kernel-backend.test.ts`;
`packages/kernel/tests/unit/connect-local-container.test.ts`;
`packages/kernel/tests/unit/runtime-artifact-volume.test.ts`.

## Lifecycle

The launcher moves through cold, inspecting, preparing, starting, ready, stopping and stopped.
Failed boot becomes failed; lost ready transport becomes disconnected and starts shutdown. Close
first stops admissions and revokes the model lease, requests `container.shutdown`, lets native
services drain, waits 30 seconds, then asks the engine to stop with ten seconds grace and kills only
the exact admitted process if required. It removes only that disposable Container and releases the
host lease after physical death is confirmed.

Create, inspect, stop and remove uncertainty fails closed. A lost create response is reconciled by
the deterministic name plus exact generation/namespace labels; an ambiguous inspect never proves
absence. A failed engine stop triggers the bounded kill path instead of an unbounded wait. Physical
channel closure starts the same idempotent cleanup even when no client explicitly calls `close()`.
Hosted-run cleanup unlinks one projection and prunes its generation directory only when empty, so a
completed run neither raises a directory-removal error nor removes sibling projections.
The local connector projects its inspecting-engine, resolving-runtime, inspecting-workspace,
preparing-workspace, preparing-artifact, preparing-state and starting-Kernel boundaries through a
typed, payload-free progress callback. Code renders these phases in its existing startup composer;
engine output, configuration and credentials never enter that surface.

Closing the TUI closes the Container. Detaching an observation does not promise survival beyond the
connection, and the TUI refuses its exit-after-background action. `!command` is also unavailable
because it would run on the application host; agent shell tools still run inside the Container.
Reconnect waits for exact previous-process reconciliation, starts a new generation in the same
namespace and does not replay unknown mutations or inference.
A new TUI may immediately recover a same-host lease whose launcher PID has ended after a one-second
freshness bound. It validates, stops and removes only the exact registered Container before booting;
a live launcher PID still identifies another active TUI and remains an explicit ownership conflict.
An interactive startup conflict exposes a separate operator action to terminate the exact registered
Container. That action validates the registry, namespace, generation and engine labels, requests the
bounded stop/kill lifecycle, then waits for the owning launcher to confirm removal and release its
host lease before retrying. Retry by itself never terminates the owner, headless entrypoints never
select the action, and ambiguous ownership remains a conflict.

Production: `launchContainerKernel` in
`packages/kernel/src/hosting/container-host-launcher.ts`;
`connectContainerKernel` in
`packages/kernel/src/hosting/container-launcher.ts`;
`createRunHost` in `packages/code/src/run-host.ts`.
Test: `packages/kernel/tests/integration/container-launcher.test.ts`;
`packages/kernel/tests/unit/container-bootstrap.test.ts`;
`packages/kernel/tests/unit/connect-local-container.test.ts`;
`packages/kernel/tests/unit/container-kernel-backend.test.ts`;
`packages/code/tests/integration/splash-render.test.tsx`;
`packages/code/tests/integration/container-run-host.test.ts`;
`packages/kernel/tests/integration/container-kernel.e2e.test.ts`.
