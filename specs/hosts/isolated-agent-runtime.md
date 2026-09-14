# Isolated Container Kernel

## Purpose

Docker and Podman are process placements for one complete Clarvis Kernel. The TUI connects through
the public `KernelClient` contract to a Kernel whose loop, tools, sessions, Plans, Memory,
Workflows and Goals all execute inside the selected Container. The selected host workspace is bound
read-write at `/workspace`; Clarvis configuration, credentials and provider API calls remain on the
host.

Container is selected before any Kernel is constructed. A selected Container never falls back to
Host or Sandbox, and changing placement closes the current connection before another generation can
start.

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
engine and effective limits. It creates and inspects the Container before attaching. From attach
through ready and the public hello, boot has a 30-second deadline. Base and artifact preparation have
a separate cancelable ten-minute deadline; an operator recipe build remains a separately bounded
30-minute preparation.

Initialization is strict, single-use and limited to 8 MiB, with configuration limited to 4 MiB. It
contains the generation UUID, public project and workspace DTOs, bare namespace hash, admitted
owner, inspected engine and host platform, network mode, local base image ID, base ABI, artifact and
configuration digests, frozen configuration and a secret-free model lease. Paths are fixed by the
entrypoint and cannot be supplied in the message.

The guest verifies the configuration digest, artifact target, base ABI and wire, broker and channel
versions before constructing services. The ready reply repeats generation and digests. The launcher
then opens model dispatch and performs public wire version 10 hello. Memory recovery starts once,
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

Plans use the Markdown provider. Memory uses local wiki or admitted workspace-relative file paths
and keeps native seed, write, delete and index behavior. Workflows, leaders, Goals, sessions,
journals and continuation execute inside the same Kernel. Disabled Plans or Memory retain their
native disabled semantics. Goal plus manager Workflow remains subject to the ordinary Goals
contract.

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

The host projects schema version 1 configuration once per generation. The schema recursively rejects
unknown fields and contains effective defaults, builtin/global/workspace Agent Profiles, prompts,
context, Memory policy, local Plans and Memory settings, native Workflow definitions, logical model
metadata, loop policy and tool ceiling. It excludes provider endpoints, credentials, MCP, Tasks,
plugins, hooks, skills, engine settings, process environment and subscription state.

The projection is canonical-JSON hashed and immutable. Guest configuration reads come from
`createContainerConfigStore`; all writes and trust changes are unsupported. Workspace changes to
`.clarvis/settings.json`, agents or workflow definitions do not recompose the current generation.
An operator save remains host-side and is shown as pending reconnect. Reload refuses while hosted
runs or Memory indexing are active.

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
existing resolver path when this port is absent.

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

Production: `createContainerModelBroker` in
`packages/kernel/src/runtime/model-broker-host.ts`;
`createContainerModelProvider` in
`packages/kernel/src/runtime/model-broker-client.ts`;
`ModelExecutionResolver` in `packages/capability/src/model-execution.ts`.
Test: `packages/kernel/tests/unit/container-model-broker.test.ts`;
`packages/kernel/tests/integration/container-model-stream.test.ts`;
`packages/loop/tests/integration/model-execution-injection.test.ts`.

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
| `/workspace/.agents` and protected roots | prepared empty masks | read-only |
| Git directory and common directory | canonical host metadata | read-only |
| `/opt/clarvis` | artifact digest volume, `payload` subpath | read-only |
| `/mise` | admitted cache volume, `data` subpath | read-write |
| `/tmp` | bounded tmpfs | read-write, noexec, nosuid, nodev |

The launcher requires the nested targets `.clarvis` and `.agents` to exist as directories before
engine create. A non-Git workspace additionally requires an existing empty `.git` directory for its
read-only mask. Docker and Podman can otherwise create a missing nested target in the host bind with
engine ownership; Clarvis returns `unsupported_policy` instead of changing the workspace to launch.

The two data volumes have exact names and labels for schema, namespace and role. Existing label,
schema, readiness or ownership disagreement fails closed. Existing nonempty partial initialization
requires recovery. No close or update deletes data volumes. Workspace content is shared with the
host, while Container Plans, Memory and machine state intentionally remain separate from Host and
Sandbox state.

Production: `resolveContainerVolumeIdentity` and `prepareContainerVolumes` in
`packages/kernel/src/runtime/container-volumes.ts`; `containerDataVolumeNames` and
`containerLaunchPaths` in `packages/paths/src/container.ts`;
`prepareRuntimeMounts` in `packages/kernel/src/runtime/container-mounts.ts`.
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
`--reject-unresolved`. The host verifies the archive before transfer. A networkless ephemeral
preparer verifies the same archive hash before extraction and publishes readiness last. Kernel
Containers only receive the immutable payload subpath.

Published `runtime-release.json` schema 2 maps each Linux target to an immutable OCI base origin
and digest plus a downloadable artifact basename, hash and size. Updating Clarvis code creates a new
artifact without rebuilding the base.

Production: `runtimeBaseBuildPlan` in `tooling/runtime/build-image.ts`;
`runtimeArtifactBuildPlan` in `tooling/runtime/build-artifact.ts`;
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

The host inspects the exact local image ID, ABI labels, created Container identity, labels, mounts,
user and effective security policy before attaching. A remote engine that cannot share the selected
workspace is unsupported. Linux uses the invoking nonroot numeric UID and GID. Qualified
Docker/Podman VM engines use fixed nonroot 1000:1000 after bind-access preflight.

Production: `createContainerKernelBackend` in
`packages/kernel/src/runtime/container-kernel-backend.ts`;
`createDockerKernelBackend` and `createPodmanKernelBackend` in the corresponding runtime
adapters.
Test: `packages/kernel/tests/integration/container-kernel.e2e.test.ts`;
`packages/kernel/tests/unit/container-volumes.test.ts`.

## Lifecycle

The launcher moves through cold, inspecting, preparing, starting, ready, stopping and stopped.
Failed boot becomes failed; lost ready transport becomes disconnected and starts shutdown. Close
first stops admissions and revokes the model lease, requests `container.shutdown`, lets native
services drain, waits 30 seconds, then asks the engine to stop with ten seconds grace and kills only
the exact admitted process if required. It removes only that disposable Container and releases the
host lease after physical death is confirmed.

Closing the TUI closes the Container. Detaching an observation does not promise survival beyond the
connection, and the TUI refuses its exit-after-background action. `!command` is also unavailable
because it would run on the application host; agent shell tools still run inside the Container.
Reconnect waits for exact previous-process reconciliation, starts a new generation in the same
namespace and does not replay unknown mutations or inference.

Production: `launchContainerKernel` in
`packages/kernel/src/hosting/container-host-launcher.ts`;
`connectContainerKernel` in
`packages/kernel/src/hosting/container-launcher.ts`;
`createRunHost` in `packages/code/src/run-host.ts`.
Test: `packages/kernel/tests/integration/container-launcher.test.ts`;
`packages/code/tests/integration/container-run-host.test.ts`;
`packages/kernel/tests/integration/container-kernel.e2e.test.ts`.
