# Isolated agent runtime

## 1. Current status

Clarvis owns a fail-closed isolated execution backend beneath the host kernel. Runtime selection is
a host composition decision rather than a public `KernelClient` service: native startup does not
inspect an engine, while a configured Podman or Docker backend prepares a retained workspace, admits
effective engine policy, negotiates a private worker channel, and keeps durable and authenticated
authority on the host.

The complete accepted target contract and staged acceptance matrix remain in
[the implementation proposal](../proposals/isolated-agent-runtime.md). This document records only
behavior already implemented in source.

Runtime configuration is a strict kernel-owned settings block. Native is the default. Docker accepts
the simple `{ "backend": "docker" }` choice; the kernel defaults it to 2 CPUs, 4 GiB memory, 256
processes, 16 MiB output, 4 GiB storage, ordinary `outbound` networking and required-Sandbox
fallback. Executable, Docker context, image digest, network, limits and fallback remain advanced
overrides. Podman retains the explicit immutable digest, executable, connection and complete-limit
contract. `outbound` may reach host/LAN peers and transmit readable workspace content; it does not
mean public-only internet. The workspace scope can display a requested `runtime` block but can never
contribute it to the effective merge, including after workspace approval. `createFileKernel` reads
the current global selection at run admission, performs no engine work on native or application
startup, and injects the same placement-neutral lazy executor into ordinary and workflow-owned runs.

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
workspace manager, which supplies the concrete local factory lazily. Only the first container run
imports the selected engine process adapter and, for Docker, resolves either the local development
tag or that exact installed version's digest-pinned release image; application startup performs
neither import, network request nor engine probe. The factory then composes one authority router,
retained generation, engine backend and placement adapter. Each run receives a random opaque model
lease, exact models from its immutable profile snapshot, host-side provider execution, a bounded
elicitation grant, a loopback-only preview grant when a selected profile carries `run_commands`, and
an optional prior trace record for continuation. When present, the canonical host `PlanFactory` and
the admitted host skills snapshot are projected through exact Plans and read-only Skills grants;
neither store paths nor host skill paths are sent to the guest. Model and capability leases are
revoked when that run settles.

Production: `WorkspaceClientManager.create` in
`packages/code/src/adapters/workspace-client-manager.ts`; `createLocalPodmanRuntime` and
`createLocalContainerRuntime` in `packages/kernel/src/runtime/local-podman-runtime.ts`;
`createLocalDockerRuntime` in `packages/kernel/src/runtime/local-docker-runtime.ts`;
`resolveClarvisRuntimeImage` in `packages/code/src/adapters/runtime-image.ts`.

Test: `packages/code/tests/architecture/architecture-boundary.test.ts`;
`packages/code/tests/unit/runtime-image.test.ts`; and
`packages/kernel/tests/integration/local-podman-runtime.test.ts`.

## 2. Immutable admission

`RuntimeLaunchSpec` binds the runtime generation, owner, project and workspace identities, source
and retained workspace locations, immutable image digest, configuration and Extension Profile
revisions, network authority, resource limits, and the closed set of callable host capability
methods. `assertRuntimeLaunchSpec` rejects incomplete identity, mutable image tags, non-positive or
non-integral limits, duplicate or open-ended methods, relative paths, and any retained copy that
contains or is contained by the source checkout.

`createRuntimeSupervisor` inspects the configured backend before starting it. An unavailable engine
produces a typed launch error and calls no start path at that layer. It admits one generation at a
time and verifies the returned generation and image identity. A mismatch stops the new session
before returning a `handshake_mismatch`. The returned stop operation is idempotent. A normal Docker
or Podman close first stops and then force-removes only that generation's disposable engine
container; the retained workspace copy remains host-owned and recoverable.

`createLazyRuntimeCoordinator` owns placement across runs. It coalesces concurrent first launches,
reuses one ready generation only while both configuration and Extension Profile revisions remain
unchanged, retires an idle superseded generation and
closes every retained host on kernel shutdown. For Docker only, an operational pre-execution failure
(`engine_missing`, `engine_stopped`, unsupported host, or another startup failure) activates and
latches the configured default required native Sandbox fallback, publishes one explanation, and
uses it for later runs until retry or configuration change. Image-integrity, launch-policy,
effective-policy and handshake mismatches never fall back. An error after `executeRun` starts is
returned as that run's failure and is never replayed through native execution.

Production: `RuntimeLaunchSpec` and `RuntimeLaunchError` in
`packages/kernel/src/runtime/types.ts`; `assertRuntimeLaunchSpec` in
`packages/kernel/src/runtime/launch-policy.ts`; `createRuntimeSupervisor` in
`packages/kernel/src/runtime/supervisor.ts`; `createLazyRuntimeCoordinator` in
`packages/kernel/src/runtime/lazy-runtime.ts`; `effectiveSandboxSettings` in
`packages/kernel/src/sandbox/policy.ts`.

Test: `packages/kernel/tests/unit/runtime-launch-policy.test.ts`;
`packages/kernel/tests/unit/runtime-supervisor.test.ts`;
`packages/kernel/tests/unit/lazy-runtime.test.ts`;
`packages/kernel/tests/integration/sandbox-policy.test.ts`.

## 3. Host-prepared workspace copy and change detection

`captureRuntimeWorkspace` walks the user's actual working tree rather than reconstructing a clean
Git revision, so eligible dirty tracked and untracked files become the runtime baseline. It excludes
Git metadata plus the canonical Clarvis and shared-agent control directories, rejects special files,
hardlinks, nested devices, unresolved or escaping symlinks and configured size/count overflow, and
copies through a fresh staging directory. Regular files are byte-copied rather than hardlinked,
executable modes and confined relative symlinks are preserved, and a second scan must reproduce the
baseline digest before the staging directory becomes the retained copy.

`scanRuntimeWorkspace` deterministically hashes path, type, mode and content or symlink target under
the same bounds. `diffRuntimeWorkspace` compares a host-held baseline to a fresh scan and reports the
complete accumulated additions, modifications and deletions without accepting a guest report.

Production: `captureRuntimeWorkspace`, `scanRuntimeWorkspace` and `diffRuntimeWorkspace` in
`packages/kernel/src/runtime/workspace-copy.ts`.

Test: `packages/kernel/tests/integration/runtime-workspace-copy.test.ts`.

`prepareRuntimeWorkspace` serializes creation through a crash-recoverable local registry lease,
captures the copy, durably writes its baseline and generation record, and publishes the generation
in the per-workspace registry only after those files exist. A failed publication removes only the
new generation. `loadRuntimeWorkspace` bounds and validates the persisted JSON, rebinds every
identity and path to the requested canonical workspace, verifies the manifest's canonical digest,
and rescans a prepared copy before reconstructing it. Two source workspaces therefore remain
separate even when their guests will both call the mount `/workspace`.

Production: `prepareRuntimeWorkspace` and `loadRuntimeWorkspace` in
`packages/kernel/src/runtime/runtime-store.ts`; `isWorkspaceManifest` in
`packages/kernel/src/runtime/workspace-copy.ts`.

Test: `packages/kernel/tests/integration/runtime-store.test.ts`.

`reviewRuntimeWorkspace` produces one opaque digest identity over the complete accumulated delta.
`applyRuntimeWorkspaceReview` re-scans both the host checkout and retained copy, refuses a changed
host baseline or stale guest review, independently verifies the staged backup and replacement bytes,
then records each next operation durably before touching the checkout. Additions, modifications,
deletions, executable modes and symlinks apply as one recoverable transaction. A synchronous failure
rolls every touched path back; an interrupted process is recovered from the same journal. Once all
source operations are durable, a distinct `settling` phase makes baseline/record advancement
idempotent: recovery completes that advancement instead of undoing already accepted changes.

Production: `reviewRuntimeWorkspace`, `applyRuntimeWorkspaceReview` and
`recoverRuntimeWorkspaceApply` in `packages/kernel/src/runtime/workspace-apply.ts`;
`commitRuntimeBaseline` in `packages/kernel/src/runtime/runtime-store.ts`.

Test: `packages/kernel/tests/integration/runtime-workspace-apply.test.ts`.

`settleRuntimeWorkspace` is the only implemented authority that composes review with apply. An
unchanged run raises nothing. Every modifying run raises exactly one host-only `workspace_merge`
elicitation carrying the opaque change-set identity, baseline/content digests and every changed path
with action, type, mode and content metadata. `accept` applies the same revalidated review;
`decline` and `cancel` write nothing and retain the copy. The engine-facing elicitation callback
refuses the reserved kind, so a guest cannot forge the authoritative interaction.

The TUI transports and renders the typed detail, lists every reviewed path, and presents one
required `merge` choice with no initial selection. It separately labels decline as keeping changes
pending and cancel as cancelling the run. Enter on an untouched review cannot accept it.

Production: `settleRuntimeWorkspace` in
`packages/kernel/src/runtime/workspace-settlement.ts`; `ElicitBridge.hostElicit` in
`packages/kernel/src/runs/elicit-bridge.ts`; `WorkspaceMergeElicitationDetail` in
`packages/protocol/src/runs.ts`; `parseElicitForm` and `ElicitBlock` in `packages/code/src`.

Test: `packages/kernel/tests/unit/elicit-bridge.test.ts`;
`packages/kernel/tests/contract/transport-codecs.test.ts`;
`packages/kernel/tests/integration/runtime-workspace-apply.test.ts`;
`packages/code/tests/unit/elicitation.test.ts`;
`packages/code/tests/integration/elicit-block-render.test.tsx`.

## 4. Retained host paths

Every canonical workspace has a `runtimes/` subtree in its existing machine-state root. It contains
a registry plus one encoded generation directory. A generation owns its temporary workspace copy,
baseline manifest, append-only journal and lifecycle record. The builders encode runtime IDs and
place every result outside the source checkout; no consumer spells these paths independently.

Production: `WorkspaceStatePaths` and `workspaceStatePaths` in
`packages/paths/src/workspace-state.ts`.

Test: `packages/paths/tests/component/workspace-state.test.ts` (`workspaceStatePaths`).

## 5. Private execution and authority

`createExecutionPeer` owns a separate attached-stdio protocol with closed directional vocabularies.
Every request, result and cancellation is generation-bound and, where applicable, run- and
call-bound. Unknown methods, malformed or oversized frames, saturation, mismatched or late results,
and transport loss close the channel without replay. `serveExecutionWorker` gives guest execution
only the narrow model, capability, event and checkpoint bridge.

`createGuestLoopExecutor` is the headless guest payload. It builds the real loop and local tool
surface against `/workspace`, gives it only a declared scratch environment, replaces model traffic
with the private host bridge, and sends the completed execution record back for insertion into the
host trace store before reporting a reconstruction checkpoint. The standalone build entry imports
the npm modules that Bun must close into the executable, supplies those modules to the Loop's
source-internal Ajv composition seam, and starts `guest-main` without a TUI or public kernel
transport. Ordinary Loop hosts keep the existing lazy `createRequire` fallback, so merely reaching
validation on the native TUI boot path still does not load Ajv.

Guest command execution retains the host-selected guard contract without exposing host policy
authority. The host strips provider secrets before sending the bounded guard settings; the guest
reconstructs `createGuardResolver`, caps built-in tools at `exec`, and emits only the closed
guard-audit vocabulary. `forwardGuestGuardAudit` validates that event again and replaces its
claimed run and owner identities with the authenticated host values before logging. The outer OCI
policy is the containment boundary; this profile does not pretend to run a second Bubblewrap or
Seatbelt sandbox inside the container.

Plans use a separate exact-method bridge rather than moving the store. The host binds
`runtime.plans` to the authenticated run owner and admits only resolve/create/read/list/replace,
reconcile/revise/delete payloads with closed schemas; the guest `PlanFactory` proxies those
operations and cannot choose another owner or a host path. Skills use a read-only companion bridge.
At generation admission the host projects name, description, scope, safe provenance and MCP
dependency names only, replaces every manifest location with `/runtime/skills/<name>`, and withholds
dependency URLs and host filesystem metadata. `runtime.skills` then discloses only bodies and
bounded text resources for names present in that admitted catalog, rejecting traversal, unknown
names and additional fields. The current bridge does not mount an approved skill execution root or
inject plugin bootstrap-skill bodies; those surfaces remain unavailable in container placement
rather than gaining ambient host filesystem access.

Production and development have intentionally different artifact acquisition paths. The production
`Containerfile.runtime` accepts only a canonical
`ghcr.io/getclarvis/clarvis-runtime-artifact@sha256:<digest>` carrier and a digest-pinned Debian base;
it copies only `/clarvis-runtime` and `/licenses` from that carrier, never repository source,
workspace manifests, `node_modules`, or build tools. Its final stage adds only Git, CA certificates,
the checksum-verified mise 2026.8.2 binary and mise's license. Node, npm, Python, Rust, compilers,
curl and archive utilities are absent from that final stage. The source-owned mise version and
Linux amd64/arm64 SHA-256 values select one verified upstream archive in a throwaway download stage.
Agents with `run_commands` receive a prompt explaining `mise x <tool>@<version> -- <command>`;
installed toolchains live in the executable `/mise` tmpfs, outside both the read-only image and the
retained workspace, and expire with the runtime. This is a developer-tool bootstrap, not a general
system-package manager: the guest cannot mutate the read-only Debian root through `apt` or `dnf`.
`Containerfile.runtime-development` is the sole source-building carrier: it copies every workspace
manifest before `bun install --frozen-lockfile`, then compiles `tooling/runtime/guest-entry.ts` to one
standalone executable. The normal development command builds that local carrier and feeds it through
the exact production Containerfile. Docker is the default CLI; Podman is an explicit compatible
selector. Every mode returns the local immutable image ID, and runtime launch still occurs only from
the separately configured local image ID.

Tag publication builds native `linux/amd64` and `linux/arm64` carrier/final pairs, pushes immutable
per-platform identities, creates two multi-platform GHCR indexes, and emits the strict
`runtime-release.json` mapping of product version, full source commit, protocol revision, platform
set, carrier/final digests, and build/base image digests. The release workflow verifies the tag
against the root product version before its first registry push, attests both OCI subjects, and makes
the portable release publication depend on that manifest. Manual workflow dispatch builds no
runtime image and cannot publish one.

Model leases keep destinations and credentials host-side and enforce provider/model, expiry,
concurrency and byte allowances. Capability grants enforce exact method, revision, argument schema,
cancellation and call identity; only completed explicitly idempotent results may be reused.

Production: `createExecutionPeer` in `packages/kernel/src/runtime/execution-rpc.ts`;
`serveExecutionWorker` in `packages/kernel/src/runtime/execution-worker.ts`; brokers in
`packages/kernel/src/runtime/authority-brokers.ts`; `createRuntimeHostHandlers` in
`packages/kernel/src/runtime/host-execution-bridge.ts`; `createGuestLoopExecutor` in
`packages/kernel/src/runtime/guest-loop-executor.ts`; `createGuestGuardAuditLogger` and
`forwardGuestGuardAudit` in `packages/kernel/src/runtime/guard-audit-bridge.ts`;
`createRuntimePreviewCapability` in `packages/kernel/src/runtime/preview-capability.ts`;
`createHostPlansGrant` and `createGuestPlanFactory` in
`packages/kernel/src/runtime/plan-bridge.ts`; `createRuntimeSkillCatalog`,
`createHostSkillsGrant` and `createGuestSkillsCapability` in
`packages/kernel/src/runtime/skills-bridge.ts`;
`installBundledAjvModules` in
`packages/loop/src/validation/ajv.ts`; `tooling/runtime/guest-entry.ts`; both root runtime
Containerfiles; `runtimeImageBuildPlan` in `tooling/runtime/build-image.ts`;
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
`packages/loop/tests/architecture/eager-validator-boundary.test.ts`;
`tooling/tests/architecture/runtime-containerfiles.test.ts`;
`tooling/tests/unit/runtime-image-build.test.ts`;
`tooling/tests/unit/runtime-release-manifest.test.ts`;
`tooling/tests/unit/release-assets.test.ts`;
`tooling/tests/unit/release-readiness.test.ts`.

## 6. Checkpoints and terminal settlement

The host persists bounded monotonic checkpoints per generation and run. The guest can report a
non-terminal reconstruction checkpoint only after its complete execution record has crossed into
the host trace store. After the guest result returns, the isolated run adapter, not the guest,
writes the next terminal checkpoint only after session, trace, capability and workspace
participants complete their durable commit, including the host-owned workspace review outcome.

Production: `appendRuntimeCheckpoint`, `loadRuntimeCheckpoint` and `settleRuntimeTerminal` in
`packages/kernel/src/runtime/runtime-checkpoints.ts`; `createIsolatedRunExecutor` in
`packages/kernel/src/runtime/isolated-run-executor.ts`.

Test: `packages/kernel/tests/integration/runtime-checkpoints.test.ts`;
`packages/kernel/tests/integration/isolated-run-executor.test.ts`;
`packages/kernel/tests/integration/runtime-guest-loop.test.ts`.

## 7. Private Git and container engines

Git workspaces receive private objects through a temporary portable bundle, an index matching the
captured HEAD, no alternates or remotes, and disabled local credential helpers and hooks. The
Podman backend verifies rootless mode and the engine-resolved image digest, creates then inspects
effective policy before attach, mounts only the retained copy, drops capabilities, applies
no-new-privileges, selects `none` or slirp `outbound`, mounts an executable bounded `/mise` tmpfs,
and applies configured resource limits before verifying the guest generation/image handshake. Its
concrete CLI port requires an absolute executable, explicit connection/environment, argv execution
and output/time bounds and is exported only from `@clarvis/kernel/local`.

The Docker backend accepts only a Linux engine. It resolves the configured `sha256` image ID before
creation, selects `none` or the explicit `bridge` outbound network, makes the image root filesystem
read-only, mounts only the retained workspace, provides bounded non-executable `/tmp` and executable
ephemeral `/mise` scratch, drops every capability, applies `no-new-privileges` and verifies the
effective memory/process policy before attach. Docker Desktop and Colima are therefore host
implementations of the same Docker contract; neither gains access to model credentials, which remain
behind the host model lease. On normal shutdown each backend attempts a graceful stop and then
requires force-removal of the exact generated container name; removal failure leaves the runtime
record in `cleanup_pending` rather than reporting successful cleanup.

Neither backend uses host networking or publishes a container port. `createRuntimePortPreview`
accepts only a numeric guest port and display scheme, probes the already-running guest through the
fixed `/usr/local/bin/clarvis-runtime preview-probe` argv, binds only host `127.0.0.1`, and relays raw
TCP through a fixed engine `exec` path. It prefers the same numeric host port, falls back to an
ephemeral loopback port on collision, caps one runtime at 16 distinct mappings and 32 simultaneous
connections, reuses a mapping idempotently, and closes listeners before container shutdown. The
guest cannot select a host address/port, executable or engine arguments and receives no engine
socket. `http`, `https` and `tcp` affect only the returned URL scheme; the broker does not terminate
TLS.

Production: `createPrivateRuntimeGit` in `packages/kernel/src/runtime/private-git.ts`;
`createPodmanRuntimeBackend` in `packages/kernel/src/runtime/podman-backend.ts`;
`createNodePodmanControl` in `packages/kernel/src/adapters/process/node-podman-control.ts`;
`createDockerRuntimeBackend` in `packages/kernel/src/runtime/docker-backend.ts`;
`createNodeDockerControl` in `packages/kernel/src/adapters/process/node-docker-control.ts`;
`createRuntimePortPreview` and `createContainerRuntimePortPreview` in
`packages/kernel/src/runtime/port-preview.ts`; `runPreviewRelayCommand` in
`packages/kernel/src/runtime/preview-relay.ts`.

Test: `packages/kernel/tests/integration/runtime-private-git.test.ts`;
`packages/kernel/tests/unit/runtime-podman-backend.test.ts`;
`packages/kernel/tests/unit/runtime-docker-backend.test.ts`;
`packages/kernel/tests/integration/runtime-port-preview.test.ts`;
`packages/kernel/tests/integration/runtime-preview-relay.test.ts`;
`packages/kernel/tests/integration/local-docker-runtime.e2e.test.ts` (explicitly gated live
Docker/Colima canary).

## 8. Current evidence and explicit limits

The gated full current-source TUI canary passed on this macOS host through Docker Engine 29.2.1 and
its `colima` context. It built the standalone worker, constructed the final image from the local
carrier, and measured local image ID
`sha256:9914c57477f53889d8032c24552253cd1d292305d2eeee16421ba055695f7065` at
137,470,980 bytes. Opening the TUI produced no engine container. The first submission lazily created
one generation from that exact ID with protocol revision 2, a read-only root, `Privileged=false`,
`no-new-privileges`, every capability dropped, bridge networking, 4 GiB memory, 256 processes and
exactly one writable bind: the retained host copy at guest `/workspace`. Its environment contained
only image defaults plus the opaque runtime generation and image digest; no host model credential
crossed the boundary.

The real guest then called the host's already-authenticated `chatgpt/gpt-5.6-terra` subscription and
returned the independently checkable sum `121011` in the TUI. A second prompt made that model call
guest `shell` with `mise x node@22 -- node --version`; `Review: Approval` paused at the command
decision, one explicit `allow once` admitted it, and the transcript returned `v22.23.2`. Direct
container canaries also reached GitHub over the default `outbound` network and returned npm 10.9.8
from the same ephemeral mise installation. A third model turn used `monitor_start`, then
`expose_port(9090, http)`. Clarvis returned `http://127.0.0.1:9090/`; a host request received
`PORT_9090_E2E_OK`, and `lsof` showed only `127.0.0.1:9090` listening. `Ctrl+G` opened the independent
Review picker and `Ctrl+E` expanded the Task editor in the same real PTY. Graceful TUI exit returned
zero, closed the loopback listener and removed that generation's container; the retained workspace
remained outside it.

After the final API-hygiene-only edit, the development pipeline rebuilt the worker and final image as
`sha256:9c9db126e730dfb22f8cdb6904efc45d4bd9eb557b4a3bdb103a641447c6e71e`, still 137,470,980
bytes with protocol revision 2. A bounded final-source TUI canary again observed no Clarvis container
before submission, opened Review with `Ctrl+G`, expanded and collapsed the Task editor with
`Ctrl+E`, and used the selected `chatgpt/gpt-5.6-terra` subscription through the newly created
container to return the independently checkable sum `129481`. Normal exit returned zero and
`docker ps -a` found no container with that generation's exact name.

Together these canaries prove the current-source macOS/Colima Docker journey, lazy launch,
subscription model broker, interactive Approval guard, mise tool execution, outbound connectivity,
loopback preview and normal container cleanup. They do not prove workspace-change settlement through
the UI, crash-orphan
cleanup, native Linux or Linux/arm64 execution, Docker Desktop, Podman, Windows, another engine
version, plugin bootstrap-skill injection, or execution of bundled skill helpers.

Live Podman remains unavailable because its freshly created AppleHV machine failed before the engine
booted. `internet` is refused because internet-only egress enforcement is not implemented; only
`none` and the explicitly broader `outbound` can be admitted. External orphan cleanup after
simultaneous host failure, macOS Podman Machine share qualification, Windows support, released GHCR
publication, remote attestation verification, and measured resource/performance claims remain
unavailable rather than silently weakened.
