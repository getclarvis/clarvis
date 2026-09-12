# `@clarvis/kernel`

The in-process implementation of `@clarvis/protocol` over `@clarvis/loop`.
It is the Clarvis server core: applications can use it directly or consume the same typed services
through its RPC transports, including the independently owned local workspace host.

`@clarvis/code` uses this package as its backend, and it is the only backend.

Workspace dependencies: `@clarvis/protocol` (the contract it implements), `@clarvis/loop` (the engine),
`@clarvis/capability`, `@clarvis/goal`, `@clarvis/mcp-client`, `@clarvis/memory`, `@clarvis/paths`, `@clarvis/plan`, `@clarvis/skills`,
`@clarvis/tools`, `@clarvis/trace`, `@clarvis/tasks` and `@clarvis/workflows`. It injects
host-owned capabilities into runs, so the engine never imports those product layers.
Clients remain independent of the engine through six deliberately bounded public entrypoints. Each
public symbol has one thematic owner; the root is not a compatibility barrel for lower packages.

| Entry                       | Responsibility                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@clarvis/kernel`           | in-process kernel, kernel services/errors, client/server/transports and wire metadata                                         |
| `@clarvis/kernel/bootstrap` | file-backed construction, authenticated local host/launcher, owner-scoped stores, stdio hosting, bootstrap logger/environment |
| `@clarvis/kernel/config`    | config stores/schemas, agents, models, plugins, workflows and settings composition                                            |
| `@clarvis/kernel/policy`    | guard, sanitization, tool identity, event mapping/policy/spans and ingest state                                               |
| `@clarvis/kernel/local`     | shell/process/executable helpers and local filesystem/git adapters                                                            |
| `@clarvis/kernel/logger`    | logger constructor and types without loading file-kernel bootstrap                                                            |

> Private, unversioned workspace. The root manifest owns the Clarvis product version; this package
> may change during the beta period.

## Contract

Construction, configuration, runs, and transport are specified in the four kernel specs under the
[`hosts` map](../../specs/README.md#hosts--the-kernel-the-terminal-ui-and-the-http-facade). The
kernel also owns host-side composition described by
[`plugins.md`](../../specs/hosts/plugins.md),
[`extension-profiles.md`](../../specs/hosts/extension-profiles.md),
[`model-catalog.md`](../../specs/hosts/model-catalog.md), and
[`sessions.md`](../../specs/hosts/sessions.md), plus the kernel halves of capability specs named in
their package READMEs. Shared-prompt resolution, workspace trust for `shared-agent.md`, and
independence from agent overlays are specified in
[`agent-system-prompt.md`](../../specs/engine/agent-system-prompt.md).

## Hosted observation infrastructure

`src/hosting/admission.ts` separates physical conversation occupancy from interactive control and
revokes volatile consent scopes on disconnect, takeover or conversation close.
Native and container guard decisions share the host lookup of the current interactive command
allowlist. The guest consults `runtime.guard_approval` for each human consent check and never retains
a human approval locally. Retired scopes reject late answers, including one-time approval, and the
judge caches only its own final decisions. Native configuration can retire an individual live session,
aborting its pending approval and active native work without revoking another conversation.
`createFileKernel` accepts `sessionAllowlistFor` and exposes host-only native routing/revocation
through `nativeConfiguration`; these controls are not model-callable services.
`src/hosting/projection.ts` provides bounded append-only observation storage with immutable,
byte-paginated snapshots. It uses the existing run event coalescer and keeps structural events;
storage/quota failures prevent new snapshots. `src/hosting/execution.ts` keeps the sole managed-run
consumer alive without subscribers, cuts snapshot/tail observations and waits for physical closure
plus host reconciliation, terminal index commit and admission release before successful observer
closure. Failure of this terminal transaction rejects closure and retains conservative occupancy.
A slow observer loses only its own bounded stream.
The root entry's `readHostedSnapshot` incrementally decodes those pages with the live event codec,
checks byte/sequence continuity through the immutable cut and releases the snapshot on abandonment.
`src/hosting/registry.ts` provides shared admission, controller epochs and connection-independent
handoff receipts over injected turn/persistence ports.
An internal continuation policy can admit another stage after the complete terminal barrier, using
authority captured from the actual controller. Its reservation is single-use, preserves the session,
and loses to admitted human work. Disconnect, conversation close, takeover and background handoff
revoke future authority. Preparation and failure notification are bounded; old-stage cleanup cannot
revoke its successor. No public peer or extra observation is synthesized for the automatic stage.
Handoff failures classify their operation identity as refused before admission or uncertain after
admission; receipt absence alone never permits replay. A definite refusal does not consume the
operation identity, allowing clients to retry after resolving its cause.
The existing RPC catalog exposes that registry through an explicitly hosted connection.
Attachment transfers snapshot metadata and subscribes to
sequenced tail, result, elicitation and physical-closure notifications.
An operator can explicitly acquire or take over control for an existing observation without
creating another snapshot or stream. Only that observation receives the new controller epoch;
the previous controller is fenced.
Disconnect rejects the local observation without fabricating a failed execution result.
`src/hosting/sessions.ts` coordinates
versioned conversation writes, committed turn intent, pending context and single-count usage over
the canonical file session store. Its short internal `transact` operation also owns persistent goal
state. `src/goals/repository.ts` uses that same transaction, with no second store. Public session
saves cannot insert, remove or rewrite `goal_state`; the host's `HostSessionStore.saveHost` commit
port is absent from the RPC catalog. Goal state and its archived conversation bindings are strictly
validated within a 1 MiB allocation. Preparation releases the mutation lock while resolving the
execution, so a durable pause can invalidate its snapshot before intent publication. Duplicate
preparations remain bounded and mutually exclusive. The goal domain and persistence contracts are
specified in [goals](../../specs/capabilities/goals.md); repository tests do not qualify automatic
continuation or the complete product journey.
`prepareHostedGoalTurn` composes a mandatory goal capability, finite stop-mode request budget,
atomic turn/goal intent, revision-fenced terminal evidence and the internal continuation policy.
Evidence validation releases the session lock so user controls remain available; the terminal write
rechecks those controls and charges usage once. The host also checks the persisted absolute deadline
before every physical model call. An already-started call may finish and remains chargeable, while
settlement refuses a late completion and records the still-current goal as usage limited. Its
composition test executes an initial stage and
two automatic continuations through the real loop and SDK, retaining the serialized prefix and
agent affinity. `createFileRunHost` registers that policy through ordinary immutable run preparation
and exposes connection-scoped `goals` controls over the existing RPC catalog. Creation and resume
persist an operation receipt with the reserved execution ID before the internal hosted start; replay
returns that receipt without another run. Native and compatible container hosts expose this surface;
headless hosts return explicit unavailability. The IPC integration test
performs creation, checkpoint continuation and completion through the real FileKernel. Code's
`/goal` commands observe these host-owned stages through the same service. The guest bridge runs the
canonical capability against closed host operations; real engine, complete local/remote,
real-provider and installed-artifact qualification require separate evidence.
`createGoalRuntimePort` implements the bound model operations over that private repository. It
revalidates execution/revision after asynchronous evidence reads and again in the short transaction.
Notifications follow successful durable publication; a notification failure does not roll back state.
`createGoalEvidenceSource` derives bounded references from existing tool traces and current artifact
bytes. Tool identity follows the actual trace mapper's flat-name versus qualified-MCP convention;
goal controls and polling never enter the evidence catalog. Shell checks require exit zero even when
transport succeeded, newer contradictory results invalidate older successes, and confined artifact
reads recheck their digest. Qualitative relevance remains model judgment.
The goal capability composition test exercises `get_goal`/`update_goal` with the actual loop, plan,
SDK transport and durable host port under controlled responses. A manually admitted continuation retains its
plan, catalog, cache identity and complete serialized prefix; blocking or refused plan review keeps
pending tasks. This is separate from qualification of the hosting controller and real providers.
The hosted continuation test also pauses while a provider response is pending, settles its checkpoint,
and resumes through the real SDK. A changed goal reminder follows the complete tool exchange, preserving
call/result correlation in the persisted context and subsequent request.
`settleGoalSession` uses the coordinator's host-only settlement callback to persist goal status,
turn closure and confirmed usage together. Unknown usage remains explicit in the goal audit;
late measurements update the original binding once, including after archival. `measureGoalRunUsage`
normalizes either aggregate or agent detail without charging independent memory runs or cache writes.
`addRunUsage` in `src/sessions/usage.ts`, exposed through `./policy`,
owns token/cache/pricing accumulation for both the host and Code presentation adapters. The private
`runtimeStatusSchema` shares runtime variants between discovery storage and local-host transport
while each boundary supplies its own field limits. That store durably replaces its canonical document and keeps its
summary rebuildable. `createFileRunHost` composes these services with a FileKernel and an authenticated
RPC server. Its caller supplies private durable storage and the local token verifier. Operator
connections can use local subscription controls when the bootstrap explicitly exposes them; a
remote-facing bootstrap can retain hosted goal authority while withholding the machine-local
inspection, browser and restart service. Observer connections receive non-sensitive reads.
Conversation runs use the same hosted registry for public starts and internal goal admission;
offline compaction and disposable cleanup share
a maintenance reservation. `InProcessKernel.prepareRun` resolves the entry, model and skill before
intent publication and keeps later workflow leaders on the same bounded configuration snapshot.
Prepared launches retain ordinary execution-id, owner and Extension Profile leases.
Goal controls retain host-created conversation authority between stages. Disconnect, close and
takeover retire it without releasing physical work. Pending controls/continuations block maintenance;
starts revalidate process authority after asynchronous preparation. `readRunTrace` is a host-only,
owner-scoped evidence port and never enters the client protocol.
`serveLocalFileKernel` composes a separately launched host with a private lease, credential,
generation-aware discovery index and idle shutdown. Disabled workspace memory permits idle
retirement even when the host supports memory; pending jobs and queue inspection failures still
prevent automatic retirement. `connectOrLaunchLocalKernel` authenticates the
discovered generation or launches the application-selected artifact without inheriting TUI stdio.
Discovery retiring during a read is treated as absent; privacy and other I/O failures still reject.
It compares a non-secret identity of resolved tool/loop policy before reusing a live host. Changed
policy requires reconnecting with the original policy and explicitly requesting an idle restart;
refusal preserves admitted work. A live host with the same wire and operator policy is replaced when
its artifact differs and it accepts an idle restart; active work refuses the transition. A wire mismatch
still requires the original compatible installation. The kernel binary accepts
the private `--local-host` bootstrap mode; ordinary stdio hosting remains available. New generations
retain terminal discovery metadata and mark previously live references unknown without restoring
execution or consent. An operator can explicitly resolve an old unknown entry after verifying all
of its processes and containers stopped. The host first archives the canonical conversation with
an audit receipt, then publishes physical closure without inventing a run outcome. A failed write
retains uncertainty. Acknowledgement removes discovery/projection state while preserving the session
audit; maintenance can proceed once all physical work is resolved. New inference requires a new
conversation. Code composes its companion entry and uses the same RPC through its workspace
manager; installed-artifact retention and platform qualification remain application responsibilities.
Process integration tests verify survival after a launching client exits with MockLLM; they do not
qualify a subscription/TUI journey or native Windows/macOS behavior. The ownership, limits and
validation scope are specified in [hosted runs](../../specs/hosts/hosted-runs.md).

`serveRemoteFileKernelOverStdio` is the process-owned counterpart for a caller-authenticated remote
channel such as SSH. It acquires the same canonical workspace lease and durable host state, binds
the sole stdio peer as the operator, keeps hosted runs and goals available, and deliberately omits
machine-local inspection, browser, retry and restart controls. The caller must authenticate the
remote machine/user before launch; this bootstrap neither publishes a listener nor creates a
Clarvis connection credential. EOF or a broken pipe closes the physical host and releases its
lease. The remote stdio integration test exercises the real framed transport and FileKernel with
controlled responses; it does not establish SSH, TUI or provider behavior.
`connectRemoteKernelOverSsh` launches OpenSSH with argv and no local shell, disables port, agent and
X11 forwarding, validates the destination and every remote command token, filters the child
environment to home/path, platform process-discovery and local SSH authentication inputs, bounds
retained stderr, negotiates the ordinary hello and owns exactly that SSH process. Provider keys,
Clarvis OAuth values and unrelated environment variables cannot reach OpenSSH or its `SendEnv`
processing. OpenSSH joins remote command arguments through the
remote shell, so unsafe tokens are refused before spawn. The server advertises its default session
namespace because a client on another operating system cannot derive it from remote path semantics.
The pinned server also owns the canonical workspace identity used by hello, so a symlink or lexical
alias in the launch request is not compared again after remote canonicalization.
OpenSSH owns encryption, integrity, host-key checks and user authentication. It reads the operator's
normal configuration, default identities and local `ssh-agent`; using the agent for login does not
forward its socket. Clarvis leaves `StrictHostKeyChecking` to OpenSSH configuration, forces
`BatchMode=yes`, and provides no identity-file or password prompt. Operators should verify the host
key and make a noninteractive key, certificate or agent identity available before TUI launch.
The process integration test uses a fake SSH executable and a real child FileKernel; it establishes
transport and lifecycle behavior without claiming network SSH interoperability.

## File-backed kernel

`createFileKernel` is the standard local entrypoint. It loads workspace and
global Clarvis configuration, resolves provider secrets, builds loop
dependencies and returns an asynchronous kernel client.

Its sandbox inspection probes only Clarvis's fixed native-backend canary. Discovered toolchains are
reported from passive executable-path resolution and are never launched by `ConfigService` merely to
populate diagnostics.

It also binds remote MCP OAuth persistence to the global `state/mcp-oauth.json` path. A local host
may provide `openMcpAuthorizationUrl` to grant browser-opening authority; a remote or intentionally
headless host omits it and fails explicitly if a server requires interactive authorization. The
kernel never moves OAuth tokens through settings, requests or protocol DTOs.

For the local Code host it also owns the complete subscription subsystem described in
[`subscription-providers.md`](../../specs/hosts/subscription-providers.md): reviewed ChatGPT and Grok
registration references, global `subscriptions.json`, bounded device attempts, rotation-safe
refresh, revocation, entitled catalogs, and token-opaque physical request authorities. The project
owner explicitly enables both public-client references for the local product; that is a Clarvis
product decision, not provider endorsement. Synthetic registrations exercise transport behavior in
tests. Provider `user-agent` identity uses the root-owned Clarvis product version. ChatGPT and Grok
separately send adapter-owned compatibility revisions (`0.153.2` and `1.0.6`, respectively) in the
catalog version fields their services gate; those values are not the Clarvis product version. The
ordinary remote composition uses the unavailable implementation. The authenticated local
`createFileRunHost` composition exposes subscription control only to its operator role.

`createFileKernel` is the single-workspace entrypoint. It derives stable project and workspace
identities directly from Git and owns that canonical workspace until close. There is no project-level
kernel cache, worktree registry, switching transaction, or occupancy lease.

The package also exposes the host-side isolated runtime. `RuntimeLaunchSpec`
binds immutable identity, image, revision, method and limit authority; `assertRuntimeLaunchSpec` and
`createRuntimeSupervisor` reject invalid, unavailable or mismatched guests without replaying work on
the host. The private execution RPC and worker, model/capability brokers, checkpoints,
selected-workspace mount policy and the Podman/Docker adapters remain below the host kernel rather
than becoming a second public `KernelClient`. The concrete engine CLI ports are exported only from
`@clarvis/kernel/local`, keeping process control off the native eager path. The contract is in the
owning [`isolated-agent-runtime` spec](../../specs/hosts/isolated-agent-runtime.md).
The strict `runtime` settings block is global-only: a workspace declaration remains withheld even
after workspace trust approval. Native startup performs no runtime-factory work. Docker and Podman
accept the simple `{ "backend": "docker" }` or `{ "backend": "podman" }` selection and fill
product-owned limits and `outbound` network; Docker also defaults required-Sandbox fallback.
Executable, context or Podman connection, digest, network, limits and Docker fallback remain
advanced overrides. Docker also accepts an advanced operator-owned `recipe` with a safe name, an
absolute POSIX-shell script path under global `runtime-recipes/` and an optional `none`/`outbound`
build network. Podman has no recipe and no sandbox fallback. All configured limits, including CPU
count, must be positive safe integers. Acquiring a missing release or candidate image has a bounded
15-minute pull deadline; short inspection commands keep their separate command deadline.
Container preparation starts only when a run first needs it, coalesces
concurrent starts and reuses the ready generation. An operational Docker startup failure latches a
native Sandbox fallback for later runs and reports that transition once; image-integrity, recipe,
policy and handshake failures remain fail-closed, and a started run is never replayed through
another placement. A failed recipe cannot silently fall back to an environment that omits the
requested dependencies. Cancelling an active run asks the guest to settle that same `runtime.start`
request instead of cancelling its transport frame; if the attached process or private channel
nevertheless dies, that generation is retired and the next run lazily starts a fresh one.
Mid-run steering crosses the private `runtime.steer` operation into a guest-owned run queue and is
acknowledged only after the real loop drains it, matching native `RunHandle.steer`. Transfer to the
guest leaves the host acknowledgement pending; a late refusal reports undelivered steering without
replacing a completed run's result. Authority revocation and snapshot disposal still run if the
control pump fails. Explicit
compaction uses the same RPC method with a different exact discriminant but enters its own queue, so
its optional request never becomes transcript content. Unknown fields, malformed message content and
late run IDs are rejected at the guest boundary.
Omitting `network` selects ordinary Docker or Podman bridge
routing that can reach public, host and LAN destinations and can therefore transmit readable
workspace data. `none` remains the explicit offline mode; `internet` is refused until public-only
egress can actually be enforced. The headless
guest entry builds the real loop against `/workspace`, proxies model calls and the completed trace
record to host authority, and may report only a non-terminal reconstruction checkpoint. It applies
the same command guard to guest shell calls and preserves the host's tools enablement, confinement
and grant ceiling, including a host composition that omits tools. Preview authority additionally
requires enabled tools, an `exec` ceiling and the selected profile's `run_commands` grant.
Closed guard-audit events cross
the private channel and are identity-rebound before the host logger accepts them. The host placement
adapter owns the later durable terminal barrier. Plans remain in the canonical owner-scoped host
store behind `runtime.plans` revision `v2`. Host mutations require the current run's plan binding;
read/list do not change it. Retention deletion additionally requires a matching durable completed
run record, a canonical completed/discard plan and host-selected CAS. Large arguments and results
use 128 KiB binary chunks encoded as base64, preserving the 8 MiB document and 32 MiB list-page
contracts without widening shared RPC frames. Transfer count and aggregate payload reservations
are bounded before provider effects, and unfinished transfers are released on run revocation.
The guest receives a host-path-free skill catalog and
can disclose only an admitted skill body or bounded text resource through the read-only
`runtime.skills` method. The model-facing body operation accepts only a skill name, while a separate
strict resource operation requires its relative path and byte offset; active plugins'
already-admitted bootstrap bodies are projected with that same run snapshot, while neither host
skill roots nor arbitrary host paths enter the guest. Memory
providers and stores also stay on the host: the guest receives the seed plus exactly the four
canonical read tools through `runtime.memory`. It never receives `write_memory`, `edit_memory` or
`delete_memory`, and the host broker rejects a forged mutation even when the selected provider is
writable. After the completed trace is durable on the host, the guest's lifecycle callback asks the
host to execute the canonical post-run enqueue there. The resulting dedicated indexing pass uses
the file host's direct Loop executor, not the container coordinator, so Memory mutation remains a
host-only operation throughout.

Container composition also preserves configured lifecycle hooks, Tasks and Workflows. Hook selection,
ordering and command hooks remain on the host through admitted callbacks; the guest cannot supply a
command or replace policy. A hook targeting a `stdio` MCP server calls back into the active container
through `runtime.hook_mcp`, using that run's guest-owned connection and environment, including before
the ordinary tool pool opens. There is no host execution fallback when that call fails. HTTP/SSE
MCP hooks retain their host connections and remote effects. Tasks uses its canonical guest capability
and strict request schema over a host-owned provider port, retaining binding, write gates and provider
errors. Admiral scheduling and its shared
leader/subagent budget stay together in the guest, while the host assembles each leader request and
admits execution to the same generation. An unknown host capability that cannot be projected refuses
container placement instead of silently disappearing. Model leases include exact profile, vision and
resolved automatic-judge models. Text and reasoning deltas cross the bounded protocol incrementally,
including partial output before a provider failure; the terminal result is separate. These bridges
require runtime protocol revision 12 and a rebuilt compatible worker image. Remote filesystem skills
are disclosed by name and resource tools, using opaque locators rather than advertised guest
directories. Helper guidance requires preparing read resources in the writable workspace before
guarded execution. Embedded builtins retain their no-file disclosure. Each run carries the
host's resolved non-secret loop defaults and ceilings, validated through the canonical environment
schema. Missing, coerced or extra policy fields are refused; owner, logging and retention settings
stay on the host.

The host model broker accepts only inline base64 images, either raw bytes encoded as base64 or
`data:image/...;base64,...` URLs, within its existing serialized-request byte bound. It checks both
user content and tool-result images before invoking the provider. Remote media URLs are refused
even when a model would strip them: the SDK asset downloader must not grant the guest additional
host-network access. Admitted inline data remains unchanged.

The `runtime.goal` bridge admits only a factory-owned capability bound to the current session,
entry instance, execution and objective revision. It refuses duplicates, workflow composition and
forged names. The guest receives the binding and uses the canonical goal tools and gates; each host
operation revalidates scope and persisted state, including cancellation inside the transaction.
Progress, checkpoint, candidate, completion validation, blocking and reads cannot grant user controls
or another run. Prior guest trace events reach the host before goal operations read their evidence.
An admitted goal raises the capability message allowance from 256 KiB to 1152 KiB, enough for one
bounded current goal and its discovery catalog; session archives and receipts never cross. Existing
call-count, aggregate replay and RPC limits remain enforced. Strict codecs reject missing/stale guest
projections, and old worker images fail protocol admission without host execution fallback.

Docker and Podman share attachment, bootstrap, private RPC, previews and shutdown in
`container-session.ts`. Engine-specific identity, rootless setup, mounts and policy inspection
remain in their backends. Bootstrap has a 30-second response deadline. A run may cancel its own
initialization wait while another run retains the shared acquisition. Host shutdown signals the
generation and awaits cleanup; image downloads, recipe build leases and engine preparation observe
that signal. Interrupted creation is reconciled against its generation label before deleting an
immutable container ID.

Private RPC admission limits both directions to 256 outstanding requests, and inbound requests also
share a 128 MiB serialized-message budget until handler and response settlement. Matching late cancellations
are accepted through 256 completion identities; malformed or mismatched cancellations still close
the channel. Capability brokers retain at most 16,384 attempted call identities per run and 8 MiB
of replay responses plus pending response reservations. Non-idempotent calls retain only replay
fencing metadata, and repeated IDs cannot substitute different arguments.

Ordinary HTTP/SSE MCP tools and resources also use host-owned connections through the closed
`runtime.mcp` grant. The host pins enabled server declarations and the owner; the guest supplies
only a server name or a run-owned lease and a catalog-admitted operation. Environment-backed headers,
bearer tokens and the OAuth coordinator/store remain on the host. Typed pending/deferred connection
failures retain native run behavior, and remote elicitation returns through `runtime.mcp_elicit` to
the live guest's serialized input port. Run teardown releases the leases. Stdio remains guest-local,
and HTTP/SSE still has remote effects even with container network `none`.

Isolated container guests have no host-exec channel. `shell` and `monitor_start` with
`sandbox_permissions: "require_escalated"` fail closed in the guest: Isolation Docker/Podman is the
sandbox, and the machine host is not available from that placement. Git credentials for container
runs come from the recipe and mounts, not from a tool.

Before each admitted provider/model pair reaches the adapter, the host uses the shared
`resolveProvider` on its captured registry, including model overrides, and reconstructs the model's
capability set. Image removal remains adapter serialization-only. Model envelopes preserve per-call
retry and Retry-After limits, including zero retries, while typed provider failures preserve recovery
and failed-attempt usage without transmitting stacks, causes, headers or response bodies. The broker
uses bounded FIFO admission configured by the host model concurrency/queue settings, not container
CPU allocation; the host provider admission policy still owns physical requests.

The selected canonical workspace is mounted read-write at guest `/workspace`; guest changes are
therefore visible on the host immediately. Clarvis does not create a second workspace copy or own an
apply/merge phase. If the selected workspace is a linked Git worktree, that worktree is the copy the
operator chose: the kernel also mounts its discovered Git common directory read-write at the same
absolute guest path so the existing `.git` pointer works. Primary Git checkouts and non-Git folders
need no extra metadata mount. Clarvis never commits, merges or removes the worktree; those remain
ordinary operator Git actions.

At generation launch the container composition overlays existing Clarvis workspace control paths
read-only. It prepares the canonical Plans and Memory directories first when their host bridges are
active, so later host writes remain visible without giving the guest write access. Existing
workspace settings, agents, skills, workflows, plugins, Extension Profiles, guard/memory policy and
shared `.agents` skills/plugins receive the same read-only treatment. A symlink in a reserved path
or any of its workspace-relative ancestors, an intermediate non-directory, or a special-file leaf
fails closed before the engine is called. This protects host-owned capability state, but it does
not make the project checkout read-only: any unprotected workspace path remains intentionally
writable.

The production `Containerfile.runtime` never copies this checkout, installs workspace packages, or
compiles source. It copies the standalone worker and its license inventory from the canonical
`ghcr.io/getclarvis/clarvis-runtime-artifact@sha256:<digest>` carrier, then adds the guest toolchain
on a separately digest-pinned Debian slim base. The final image contains Git, CA certificates and
the checksum-verified `mise` 2026.8.2 binary, but no preinstalled Node, npm, Python, Rust or compiler.
Agents with `run_commands` are told to use `mise x <tool>@<version> -- <command>` for missing
toolchains. Downloads and installs never enter the selected workspace or mutable image root. Both
engines mount `/mise` from a labelled local volume scoped to owner, project, workspace, effective
user and exact image; normal container removal preserves it for later Clarvis sessions using that
same identity. Podman runs as its rootless operator-mapped root, keeps the base read-only and bounds
non-executable `/tmp` without requiring XFS storage quotas. It relabels only admitted workspace,
read-only overlay and linked-worktree Git binds for shared SELinux container access; SELinux stays
enabled, and those labels persist on the selected host files. This supplies mise-supported developer tools;
it is not an unrestricted guest `apt`/`dnf` path and cannot mutate the read-only base image. A
release builds that source carrier once with `Containerfile.runtime-development`, publishes both
carrier and runnable multi-platform image, and records their immutable identities in
`runtime-release.json`. Both images carry the product version, source revision, private runtime
protocol revision and MIT license labels. The Docker and Podman backends require that protocol label
and repeat the same revision in the private bootstrap handshake.

Development deliberately uses the other path and then the same final Containerfile:

```bash
bun run runtime:build:dev -- clarvis-runtime:development
bun run runtime:build:dev -- --engine podman clarvis-runtime:development
```

That command builds a local source carrier from the frozen root lockfile and marks the final image
as development. `./dev-install.sh` runs the same builder once per installed engine. A missing
engine is skipped, so a Docker-only or Podman-only host still completes; when every installed
engine fails to build, installation fails closed. To compose a final image from a released carrier, use:

```bash
bun run runtime:build -- \
  ghcr.io/getclarvis/clarvis-runtime-artifact@sha256:<digest> \
  clarvis-runtime:local
```

Docker is the default builder; `--engine podman` selects the compatible Podman CLI explicitly.
The shared live canary in `tests/integration/local-docker-runtime.e2e.test.ts` also accepts
`CLARVIS_PODMAN_RUNTIME_CANARY=1`, `CLARVIS_PODMAN_RUNTIME_CONNECTION=local`, and
`CLARVIS_PODMAN_RUNTIME_IMAGE_DIGEST=sha256:<local-image-id>`. Run it from the repository root with
`bun test --cwd packages/kernel tests/integration/local-docker-runtime.e2e.test.ts --timeout 60000`.
Also run `tests/integration/runtime-podman-isolation.e2e.test.ts` with the same environment to verify
effective cgroup/security policy, rootless file ownership, offline mode, cache reuse and workspace
partitioning across fresh containers. The shared run canary selects the actual Podman control and
runtime composition; the Docker recipe and rootful DAC canaries remain separate. The Podman engine must be accessible outside any host
sandbox that blocks its rootless runtime directory. Admission failures are failures, not skipped
coverage of guest execution. The build helper, first-use image resolver and Podman adapter
canonicalize complete unprefixed local image IDs to `sha256:` without accepting short IDs or
mutable tags.

By default Docker resolves `docker` from `PATH` and uses `DOCKER_CONTEXT` or the active Docker
context; `executable` and `connection` override those choices. Its backend requires a Linux engine,
uses the resulting local image ID as `runtime.image_digest`, makes the image root read-only,
bounds the non-executable `/tmp`, and admits the selected workspace bind, its exact read-only
overlays, optional linked-worktree Git metadata, plus the labelled workspace/image-specific `/mise`
volume. Bind source and target values are encoded as complete fields for the engines' `--mount` CSV
parser, so commas in valid host or guest paths do not split the mount declaration. It deliberately
uses a private bridge rather than host networking. The cache is partitioned
by effective UID/GID as well as workspace and image. Rootful Docker runs as the invoking operator's
numeric UID/GID; rootless Docker uses its operator-mapped root. Rootful `userns-remap` is refused
because the bind identity cannot be preserved. A bounded, networkless initializer with only the cache
mounted seeds immutable image mise content and assigns ownership; only its `data` subdirectory reaches
the guest. Effective user and volume-subpath inspection must match admission. The volume is
engine-owned rebuildable cache, is not covered by `storage_bytes`, is not exposed as a host-path
bind or reused by another workspace identity, and is not removed with the disposable container.
`storage_bytes` also does not bound the direct host workspace bind. An agent with `run_commands` can
ask `expose_port` to publish an
already-listening guest TCP port: the host binds only `127.0.0.1`, prefers the same port with an
ephemeral fallback, relays through a fixed
engine `exec` argv, caps mappings/connections, and closes them with the runtime. The guest never gets
the engine socket or chooses a host address, host port, executable or engine arguments. An installed
release resolves its same-version `runtime-release.json` only on the first Docker or Podman run and
may pull only the digest-pinned GHCR reference it names. Local source development selects the local
`clarvis-runtime:development` tag and never pulls it; `./dev-install.sh` builds that tag into each
available Docker or Podman store. An explicit candidate source installation
supplies its same-tag candidate image through the Code resolver, pinned to its source revision and
protocol, and the selected engine pulls that digest; no runtime path promotes or publishes an image.
When `runtime.recipe` is present, the same lazy resolver first pins that base image ID, captures at
most 1 MiB from the absolute non-symlink, single-linked script inside the operator-owned global
`runtime-recipes/` directory, verifies a stable regular UTF-8 file, and derives a cache key from
recipe schema, name, network, script digest, builder policy and base image ID. A
cross-process host lease coalesces the first build. Docker receives a private generated context
containing only the captured script and fixed build-control files, no checkout or Clarvis
credentials; proxy build args are explicitly blank. The script runs as `/bin/sh -eu` in a BuildKit
bind mount and therefore does not remain as an image layer. The derived image must retain exact
recipe/protocol labels and is launched only by its inspected immutable local ID. A matching local
image is reused across Clarvis processes; changing the script, builder policy or base creates a new
identity. A ready runtime does not watch the recipe file: captured changes take effect on the next
cold Docker generation. This is an operator build authority, not a guest tool, registry publication
path, secret-delivery channel, or commit of a running agent container. Its bytes are sent to the
selected engine, and Clarvis supplies no build-secret input; credentials embedded in script
commands, installed files or output may persist outside Clarvis.

Normal runtime close stops and force-removes only that generation's disposable engine container
after closing its preview listeners. Removal failure is returned and a later close retries the
removal without repeating guest shutdown. The coordinator retains failed generations, reports an
aggregate shutdown failure and lets subsequent `close()` calls retry them, including retired
generations with the same configuration key. The outer kernel lifecycle likewise retains failed
resources for retry and never reopens admission; other file-host resources still close if runtime
cleanup fails. The selected workspace remains untouched by runtime
cleanup, while Docker intentionally retains the separately labelled `/mise` cache. A crash can
still leave an engine container because external orphan reconciliation is not implemented.

As part of that bootstrap, the kernel constructs one provider-aware planning runtime. The plans
capability and owner-scoped `PlansService` resolve through the exact same `PlanFactory`. Markdown is
the default and uses `planStoreFor`; operator settings may instead select a direct language-neutral
executable or an enabled plugin offering `capabilityExecutables.plans`.

The Tasks composition follows the same single-runtime rule. One `TaskProviderFactory` resolves both
the run capability and owner-scoped `TasksService`, qualifies plugin MCP servers once, enforces
workspace trust, and binds every MCP lease to the authenticated owner. The external provider stays
authoritative; the kernel persists only the task/provider binding in run capability state. Tasks
protocol v2 also pins a remote `provider_instance_id`, invalidates private caches when referenced
secrets rotate, and shares one bounded/single-flight capability probe path between runs and the
control plane.

```ts
import { createFileKernel } from "@clarvis/kernel/bootstrap";

const kernel = await createFileKernel({
  workspaceRoot: process.cwd(),
  memory: true,
});

try {
  const agents = await kernel.config.listAgents();
  const settings = await kernel.config.getSettings();
  console.log({ agents, settings });
} finally {
  await kernel.close();
}
```

Configuration is read from the workspace `.clarvis` directory and the global
Clarvis directory. The kernel owns validation and persistence; clients use the
services defined by `@clarvis/protocol`.

Before composing extensions, the file kernel resolves one process-pinned Extension Profile. The immutable
`builtin:default` activates the exact plugin references in `enabledPlugins` and applies four-root
standalone-skill discovery; a custom definition is a complete qualified allow-list and never
inherits that builtin activation list. Plugin identity is always `{ scope, source, name }`, where
`source` distinguishes `.agents/plugins` from `.clarvis/plugins`; no same-name install shadows or
substitutes for another. Workspace
definitions are shareable authored files, selections stay machine-local, and selection/definition
changes require reconnect. Global plugins live in operator-owned inventories and need no additional
workspace approval after installation. Every `scope: "workspace"` plugin checkout enters one
workspace-wide trust fingerprint whether selected yet or not; approving that fingerprint once
covers all of them. In a mixed Extension Profile, global plugins remain active while an unapproved
workspace-owned sibling stays withheld.
The first catalog read materializes an absent global `extension-profiles/` directory with the private
directory mode; it treats an absent workspace catalog as empty without creating repository content.
Preview tokens resolve the target through normal workspace-over-global precedence and bind both
selection documents; definition and selection mutations serialize through local leases. The pinned
manager also exposes every exact plugin and standalone-skill origin as inactive composer inventory.
`previewComposition` binds a complete draft, prior definition revision, both selection revisions,
authored fingerprint, and effective fingerprint; `applyComposition` revalidates and writes the
definition plus selection as one recoverable transaction. Trust-write failure restores both prior
documents, while an unchanged workspace selection shadowing a global-default write is neither
activated nor newly approved. The pinned fingerprint includes resolved plugin manifests and
companion declarations, agent files, bounded packaged-skill manifests, canonical raw-streamed
resource digests plus effective sidecar-derived catalog metadata, and the content, size, mode, and
package-relative path of every directly referenced package-local MCP, hook, or capability process
file, plus selected standalone skill bodies and raw-streamed resources. Skill resources are capped
at 8 MiB per file and 32 MiB aggregate per packaged plugin or standalone skill; process-file
admission is bounded separately per file, per plugin, and by file count. Ordinary contribution
projections reuse the pinned parsed snapshot instead of rescanning and rehashing every accessor.
Run admission never revalidates that filesystem snapshot. The kernel gives the loop a
`SkillRootSnapshotProvider`; its roots are consumed while run dependencies are built, catalog
metadata and bodies are materialized then, and resource paths are restricted to that initial
allow-list. Monitoring is armed for every identity file, including the selected sidecar, before a
post-capture digest comparison. A mismatch flips the same in-memory availability latch, withholds the
affected skill, and emits `onSkillDrift` for an informational host UI instead of failing dependency
construction or delaying a run. `ExtensionProfileManager.observeSkillCatalog` then polls those paths
asynchronously; later drift has the same non-blocking withdrawal behavior. Builtin and custom
standalone roots carry exact `include` lists for only the skills captured in that snapshot. If any
packaged skill in a plugin cannot be captured within its bounds, that plugin's entire skill-root
surface is withheld while its independently valid non-skill contributions remain.
`PluginContributions.observeRuntimeFiles` applies the same asynchronous latch to captured
package-local MCP, hook, and capability executable files. An explicitly local executable declaration
must resolve to a confined regular file at pin time; symlinks are monitored by their declaration path,
and later replacement withdraws the executable projections without a run-admission rehash.
Workspace-trust transitions recompose the extension snapshot and atomically replace the loop's exact
skill catalog only while no run is active. Approval refreshes the trust surface through the production
file-kernel adapter before consent is recorded. Selected plugin update/uninstall still leaves the old
parsed process snapshot in use until reconnect.
Every run records the resolved Extension Profile id and fingerprint. An MCP namespace whose winning
declaration still comes from an active plugin is attached to every run and marked `auto_tools`: its
discovered tools become available to every effective agent for that run even when the persisted
Agent Profile names none. This is part of atomic plugin activation, not an Agent Profile mutation. A global
or workspace declaration that replaces the same namespace remains explicitly selected by the Agent Profile and never
inherits the plugin's automatic grant.

Multi-owner hosts must continue to pass owner-aware stores explicitly. The
kernel publishes the standard file-backed composition without silently enabling
it:

```ts
import { createFileKernel, createOwnerScopedFileStores } from "@clarvis/kernel/bootstrap";

const stores = createOwnerScopedFileStores({ workspaceRoot });
const kernel = await createFileKernel({
  workspaceRoot,
  ownershipMode: "multi",
  planStoreFor: stores.planStoreFor,
  memoryStoreFor: stores.memoryStoreFor,
});
```

The factory passes raw owner ids to `@clarvis/paths`, whose owner-derived
builders encode them at the path boundary. Content and machinery layouts remain
paired beneath the same encoded owner. Each store remains stable while its owner
is resident; a hosted owner acquired through `acquireOwner` is retired after its
last lease and the configured idle interval, at which point its memory worker,
plan cache and host-owned file-store references are released. Compatibility
callers using `forOwner` deliberately pin their scope until kernel shutdown.
Configuration remains shared and operator-owned.

Model-facing plan reads and lists accept null for omitted options (active plan, first page and
default filters). The plan capability normalizes those options before its typed provider/bridge
calls; empty IDs and cursors remain invalid, and mutation CAS/review rules stay in force.

The memory factory follows the same owner boundary: it caches one background
index worker per activated owner, binds tool-server access to that owner, and
keys ingest subscriptions by owner plus run ID. Stopping the kernel stops every
worker; a worker never drains another owner's store or lease.

## Lower-level composition

Use `createInProcessKernel` when the host already owns loop dependencies,
configuration storage or service adapters:

```ts
import { createInProcessKernel } from "@clarvis/kernel";
import { createMemoryConfigStore } from "@clarvis/kernel/config";

const kernel = createInProcessKernel({
  deps,
  workspaceRoot: process.cwd(),
  project: { id: "prj_example" },
  workspace: {
    id: "ws_example",
    projectId: "prj_example",
    label: "primary",
    kind: "primary",
  },
  configStore: createMemoryConfigStore(),
});

// Release durable memory-queue recovery after this host is ready for users.
kernel.startMemoryRecovery();
```

Construction never starts memory-index inference. Interactive hosts call
`startMemoryRecovery()` after first paint; server hosts call it after their transport/readiness
boundary. Owners already resident start once at that point, and owners activated later start as
they are built. A primary run still pokes its worker after enqueuing its own job.

An embedding that isolates filesystem fixtures may pass `home` to relocate only the shared
`.agents/plugins` inventory used by the in-process plugin service. Production file kernels omit it
and use the operator's normal home; `globalConfigDir` continues to own `.clarvis` independently.

The package exports constructors for individual services, file and in-memory
configuration stores, secret storage, model catalogs, guard resolution and
engine-to-protocol mapping.

The operator-scoped `StorageService` walks Clarvis-owned roots with entry/depth bounds, reports
logical category totals without exposing persisted content, paths or credential sizes, and applies
only explicitly requested cleanup of stale temporary artifacts and rebuildable cache. A truncated
inventory remains previewable but cannot authorize an apply. Workspace
bootstrap also sweeps inactive workspace spill/run scratch state and repairs recognized spill modes
to `0600` on POSIX.

The kernel owns the persistent subprocess pool for capability executables. It resolves direct
argv from workspace settings or selected declarations from installed plugins, initializes JSON-RPC
sessions lazily, multiplexes calls, and closes every child with the kernel lifecycle. Services run
outside the Clarvis process and may be written in any language; see
[`specs/capabilities/provider-executables.md`](../../specs/capabilities/provider-executables.md).

Packaged capability services are authorized by installation, Extension Profile selection and provider
selection. A selected plugin is one atomic extension unit: its agents, skills, MCP servers, hook
declarations and capability executables become eligible together. Installing from Code's focused
Marketplace is the explicit consent action, so a globally installed plugin needs no additional
workspace approval when a workspace Extension Profile selects it. Workspace trust remains a separate
exact-snapshot gate for the complete inventory of executable plugin content inherited from
`scope: "workspace"` checkouts. One workspace approval covers that whole inventory rather than each
plugin or Extension Profile separately.

`PluginService.installSource` admits three marketplace fetch forms. Git sources may select a
confined subdirectory and one validated ref or full SHA; local directories are copied into managed
inventory under file/count/depth bounds with symlinks and special entries refused; npm packages are
installed into staging with lifecycle scripts, audits and funding requests disabled before the
validated plugin is atomically installed. Catalog installs carry the listing name as an expected
identity: an explicitly named manifest must match it, while a foreign manifest with no name receives
that stable identity instead of a generic staging basename. Direct installs with no expected identity
must declare a name. The view reports managed updateability separately; local/npm and unmanaged
installs cannot surface a Git update action. Manifest views preserve the upstream `author`, homepage,
repository, license, keywords, and complete bounded `interface` metadata. Those fields are display
data only and never become execution authority.

Plugin `.mcp.json` companions accept a direct server map or a wrapper under `mcpServers` or
`mcp_servers`. HTTP entries infer their transport from `url`; `http_headers` normalizes to
`headers`; OAuth camelCase fields normalize to the engine's snake_case seam. Invalid individual MCP
entries are withheld without removing healthy siblings or the plugin's non-MCP contributions.

Every kernel Git operation that selects a plugin checkout through a clone destination, `cwd`, or `-C`
removes Git's repository-local environment first. A kernel launched by a parent repository's hook
therefore cannot redirect plugin fetch, update, origin, or revision operations through `GIT_DIR`, a
temporary index, work tree, object store, common directory, or local Git config. The generic process
runner does not impose this policy; each Git-owning adapter applies it before invoking the runner.
`GIT_CEILING_DIRECTORIES` is removed as well so a parent cannot stop discovery before the selected
repository root.

A symbolic link may contribute an external checkout to any `.agents/plugins` or
`.clarvis/plugins` inventory, but Clarvis treats that entry as discovery-only. It does not advertise
an install source or run managed update against the linked target; the repository and Git adapters
both refuse replacement/update so Clarvis cannot discard edits in a checkout it does not own.

Plugin admission is all-or-nothing only for artifacts that define the plugin as a whole: its selected
manifest, install record and bounded agent tree. A declared or conventional hooks/MCP companion that
is absent, malformed, oversized or outside the plugin costs only that contribution and produces an
operator-visible note. Manifests and companion documents are descriptor-read before JSON parsing
with a 2 MiB ceiling; install records are capped at 64 KiB. The shared plugin-agent limits add bounded
depth, directory/entry/file counts, 256 KiB per file and 8 MiB aggregate source. Install-root
enumeration is also bounded and fails explicitly instead of returning a partial catalog.

A Clarvis-specific dot-directory manifest is authoritative. Without one, the resolver scores the
root and shape-matched host manifests by supported contribution directives, selects one document
deterministically, and never merges manifests. Relative skill, hook and MCP paths resolve from that
manifest's directory before the plugin root and remain confined to the install root. An absent
`mcpServers` declaration falls through to `.mcp.json` and then `mcp.json`. When an event-keyed hook
document from another host starts a command with `./` or `.\`, the dialect adapter anchors that
executable to the plugin's install root; the hook process still runs with the workspace as its
working directory.

For a shape-matched borrowed-host manifest, `resolveBorrowedUserConfig` recognizes at most 128
`userConfig` definitions whose `type` is exactly `"string"`; a referenced key is 1–128 characters
from `[A-Za-z0-9_.-]`. It translates only a whole stdio
environment value `${user_config.key}` on destination `DEST_ENV` into `${DEST_ENV}`, delegating the
actual value to Clarvis's existing environment/key lookup. It never consumes a manifest default or
secret/sensitivity metadata. Embedded, argv/header, non-string, undeclared, native-manifest, or
`expandVariables: false` uses withhold only the offending MCP server and preserve its siblings and
the rest of the plugin.

A manifest's `skills` locations may name collection directories or individual skill directories.
Before enforcing the four-effective-root limit, the kernel collapses an exhaustive list of direct
siblings to its parent collection only when no undeclared directory or symlink could become visible.
The shared 24-root plugin budget remains unchanged.

Skill helper execution is approved per discovered skill directory, never for its collection or the
whole plugin checkout: plugin roots carry the host approval marker, and `buildResolvedSkill`
publishes that skill's own `dir` as its `executionRoot`. Skill-resource fingerprints use
`hashBoundedFile` to stream raw bytes into SHA-256 without decoding or retaining the complete file,
capped by `MAX_SKILL_RESOURCE_FILE_BYTES` at 8 MiB per resource and
`MAX_SKILL_RESOURCE_SNAPSHOT_BYTES` at 32 MiB aggregate. The aggregate is per plugin for packaged
skills (`PLUGIN_SKILL_RESOURCE_LIMITS`) and per skill for standalone Extension Profile inventory
(`standaloneCatalog`).

Plugins may also package a per-skill Plans mode. The kernel applies it only when the skill originates
from the enabled plugin and that plugin is the selected Plans provider; explicit run parameters take
precedence. This lets authoring skills run with Plans off and implementation skills enter review
without a client-side settings workaround.

## Remote-ready transport

The goal facade validates availability, receipts and bounded conversation state on the wire,
including the physical run's session/workspace binding. `goals.subscribe` installs a live
subscription before its acknowledgement; its `goals.change` notification carries only the affected
session ID. Consumers reread canonical state. Goal writes and physical lifecycle transitions emit
these invalidations without transferring execution authority. Registrations are bounded to eight
per connection and 128 per host, and pending installations are released on disconnect.
See [kernel transport](../../specs/hosts/kernel-transport.md) for response validation and disposal.

Public stdio and private execution RPC share a 64 MiB logical JSON limit. Larger-than-frame
messages use contiguous 256 KiB binary fragments, canonical base64 and a 30-second transfer deadline;
the physical frame limits remain 8 MiB and 4 MiB respectively. Serialized queued data is bounded at
128 MiB per direction. Oversized or unserializable local requests fail before sending bytes and
preserve other runs; excess handler results return a bounded error. Invalid inbound fragments and
physical transport failures close the connection. These limits cover composer images, model context,
continuation records and final traces; they do not promise unlimited conversation size.

The transport layer maps the same kernel services to Clarvis wire methods:

- `createKernelServer` exposes a kernel over a connection.
- `connectKernelClient` builds a remote `KernelClient`.
- `createLoopbackTransport` connects both sides in process.
- `createStdioTransport` and `serveKernelOverStdio` provide stdio framing.
- `connectLocalKernelTransport` and `listenLocalKernel` reuse that framing over reconnectable Unix
  sockets or Windows named pipes. The listener bounds clients and hello deadlines; its caller must
  supply authenticated resolution and operation authorization on `createKernelServer`.
- `serveFileKernelOverStdio` combines a file kernel and stdio server.

The `clarvis-kernel` binary starts the file-backed stdio server. The protocol is
Clarvis's own request/notification contract, not MCP.

Transports may implement `KernelTransport.onClose` to report explicit closure,
EOF or connection errors. For ordinary connection-owned runs, remote clients use this signal
to settle handles with `unavailable` instead of leaving `RunHandle.done` pending.
Hosted observations reject their unfinished promises without fabricating a run result;
closing a subscriber does not prove physical completion or release the registry's run lease.
The stdio, local IPC and loopback transports implement the connection lifecycle.

The independent file host additionally advertises operator-only `localHost` controls through that
same catalog: bounded runtime/profile state, claimed browser handoffs, explicit runtime retry and
quiescent restart. These operations belong to the authenticated application channel; the private
container execution RPC never exposes them. Code supplies the companion application's composition.
Preparation failures enter the durable run index as sanitized plain error DTOs, so an invalid
request does not poison later admissions with an unserializable exception object.

Run elicitation is buffered until a client registers `RunHandle.onElicit`.
Questions raised during startup therefore survive the asynchronous
`runs.start` boundary.

`RunHandle.steer` acknowledges a message only after the loop drains it from the run-scoped steering
source. If the run closes first, the pending call rejects with `not_found`; a host can therefore
distinguish applied steering from an accepted-but-undelivered queue entry and restore the user's
input.

Managed and remote run handles expose their bounded event stream's current item, estimated-byte and
dropped-event counters through the protocol's optional `buffered()` diagnostic surface. The stream
maintains these values incrementally, so a memory ledger does not walk or duplicate the queue.

`RunHandle.compact(request?)` queues an entry-agent compaction for the next iteration preamble. It
has its own control queue rather than using steering, so the optional preservation request never
becomes transcript content. Workflow runs attach the queue to the manager only. The owner-scoped
`RunService.compact` also accepts a settled execution: guided compaction summarizes and atomically
replaces its persisted `final_context`, while a `mechanical_target_tokens` request evicts older
paired context until it fits that window. `RunService.context` exposes only the estimated size and
fit verdict, never the private context body.

When the queued pipeline actually begins, the kernel projects `compaction_started` as a non-droppable
live-only run event. The persisted terminal event records the applied operation and preserves a
summary-to-eviction `fallback_reason`; replay therefore retains what happened without reviving an
already-finished spinner.

## Guards and control plane

The kernel owns command-approval policy through `createGuardResolver` and
`createShellGuard`. It also provides first-class services for configuration,
plugins, secrets, models, provider authentication, files, memory, plans, workflows, skills,
sessions, tasks, storage, Extension Profiles and runs — the fifteen `KernelClient` services. These are control-plane APIs rather
than model-callable MCP tools.

A run's effective mode is the per-run `guard_mode` param, else the `guard.mode`
settings block, else `on` (`resolveGuardMode`). The three modes differ only in
what happens to an **ask** verdict — `off` skips the ruling, `on` relays it to a
human, `auto` has an LLM answer it. A **deny** is enforced before any of that, in
every mode, and `denied_commands` outranks `allowed_commands`.

**The judge prompt is supplied by the host, per run, and the kernel never reads a
file for it.** `auto` builds a judge only when the run carries a `guard_judge`;
without one `routesToHuman` reports true and the run behaves exactly as `on`
(`resolver.ts`). That is deliberate — it makes a misconfigured `auto` degrade to
asking a human rather than to approving silently — but it also means "I set mode
to auto and nothing changed" is the expected symptom of a missing prompt, not a
bug. `@clarvis/code` is what resolves that prompt from `guard-judge.md`
(workspace, then global, then a built-in default, winner-takes-all); see its
README. `@clarvis/server` deliberately does not accept `guard_mode` at all, so a
caller cannot switch off the operator's guard.

The resolver snapshots host-owned placement once per run: enabled native sandbox means
contained-or-fail-closed, including legacy optional availability; Docker/Podman guests also count
as contained. Host and disabled native policies do not. Explicit per-call unsandbox is reviewed as
Host, with native network restrictions omitted; Auto may judge it, while `on` requires a human.
Undecidable contained commands remain ordinary asks that Auto may judge; ordinary Host
undecidable commands still require a human, and a nonempty deny list rejects either. No unmatched
contained silent-allow rule is installed. Forced `rm` and `sudo` ask after allowlist checks.

POSIX Git presentation globals normalize for matching, while validated `cd <in-workspace>` and
Git `-C` directory operands receive comparison-only handling for straight `&&` chains.
Assignment-only `NAME=value` segments are skipped for allow-list comparison, and sequential
literal `$NAME` bindings are inlined by the POSIX analyzer before that match. Session
approval keys keep their original normalized identities; unsupported control flow and PowerShell
retain ordinary matching. Paths still participate in denial.

Judge JSON contains trusted per-call analysis facts plus `operator_message`: at most 4 KiB of
start/continue user text, selected newest-first and retained chronologically with a UTF-8-safe
prefix cut. Assistant text, images, tool results and mid-run steers are absent. Child runs supply
their own brief. The memo key is the actual reviewed JSON, so changed raw commands, cwd or facts
cannot reuse a normalized-only ruling. Native `network` stays `host | none`; container `none` is
reported as `none`, and outbound/internet modes are omitted rather than mislabeled as host network.
See [command guard](../../specs/execution/command-guard.md) for the tools/kernel/Code contract.

A resolved judge reports which channel ultimately answered. An `allow` or `deny` is attributed to
the judge; `unsure`, a provider failure, or a malformed response routes to the human channel when
the default `on_unsure: "ask"` policy and an interactive host permit it. Without that channel — or
with `on_unsure: "deny"` — the same inconclusive outcomes still fail closed. Failed and malformed
attempts are not memoized, so fixing a transient provider problem restores automatic review without
restarting the session.

A `shell` or `monitor_start` call with `sandbox_permissions: "require_escalated"` under Isolation
Sandbox is a `host_command` ask, after deny-list matches and undecidability with a nonempty deny
list are rejected. The resolver passes `allowHostJudge: true` to `createShellGuard` only in Auto;
otherwise this ask carries `escalate: "human"`. Auto's judge may allow or deny the host effect;
unsure, failed and malformed responses follow `on_unsure` (`ask` by default, configured `deny`
respected). An absent usable model routes to a human. Host-command asks bypass volatile session
coverage and never offer `allow_session`, even on human fallback; clean exact-call judge memoization
remains separate. Isolation Host already runs unsandboxed, so the field does not add
a second prompt. Mode `off` supplies no guard and proceeds without command review, honoring the
operator's explicit choice. Isolated container guests reject the field instead of forwarding it to
the host.

The resolver returns the final answer together with its answerer, and the kernel
projects the resulting `tool_call.guard` unchanged to `RunEvent`. This makes the
auto-guard verdict visible after replay rather than leaving it only in audit logs.

## The settings schema

The kernel publishes exactly one, `kernelSettingsSchema`: the engine's blocks
plus the ones its capability registry contributes: memory, plans, goals, workflows, tasks and
runtime placement.
Registration happens at module load in `config/capability-registry.ts`, **before**
any `settings.json` is read — a block registered afterwards reads as an
unrecognized key.

The strict `goals` block configures creation defaults: `max_net_tokens` optionally overrides the
finite entry budget for the whole objective; `max_auto_continuations` defaults to 8 and
`max_no_progress_checkpoints` to 3. `deadline_at` is an optional absolute Unix timestamp in
milliseconds. Workspace configuration replaces the whole global block, following plan/workflow
scope precedence. `createFileRunHost` resolves those defaults through the effective configuration
only for creation or replacement, after receipt lookup. Explicit control limits take precedence.
Existing goals retain their limits through configuration changes, replay and resume; changing them
requires the operator's goal edit. The model and plugins cannot supply this block as a run parameter.

The engine's bare `settingsSchema` is deliberately **not** re-exported. Validating
a real `settings.json` with it reads a registered capability's block as an
unrecognized key, which is how `@clarvis/code` came to reject every write to a
scope carrying a `workflows` block, and to delete that block on the repair path.

When the assembler projects the `agents:` settings block onto a run, it preserves
`max_total_buffer_bytes` alongside the per-child limits. The supervision package remains the policy
owner and derives the effective per-child buffer slice; the kernel does not materialize or widen the
32-MiB aggregate ceiling itself.

Every settings source exposes an exact-byte revision. Ordinary saves and settings repair are kernel
compare-and-swap operations under the same local-filesystem, same-host process lease: a client
supplies the revision it read, and a concurrent edit returns `conflict` without overwriting either
source.
`previewSettingsRepair` reads the scope's exact bytes and returns a
strip/reset plan with their SHA-256 revision. `repairSettings` acquires the
file store's settings lock, verifies that revision, recomputes the repair under
the lock and writes atomically. A concurrent edit or removal returns `conflict`
without a write. The scope remains configuration scope (`global` or
`workspace`); it is shared operator configuration rather than owner-scoped run
state. The lease is not a distributed-lock claim for NFS or multi-host storage.

## Builtin configuration skill

Invoke `/clarvis-configure <task>` in Code to start a dedicated native configuration run after human
elicitation. Its `configure_clarvis` tool provides `list`, `read`, `write`, `edit` and `delete` for
authored files in the four global/workspace Clarvis and `.agents` roots. `edit` replaces exactly one
matching snippet against the last read revision. Keys, subscriptions, auth, trust and private state
are excluded. The run executes on the host without sandbox/container or extension/shell execution.
Consent lasts only in the currently open TUI session; resume or reconnect requires approval again.
It is published as one standalone transcript agent: every `configure_clarvis` read or mutation is
visible as a normal tool call, live and after replay, and no child agent is spawned. The transcript
labels the concrete list/read/write/edit/delete action and its scoped authored path while keeping
content, revisions and edit snippets out of trace storage. An approved
workspace (including an initially inert workspace) retains trust across these operator-authorized
workspace mutations only when the resulting revision matches the authorized target and every other
executable input remains unchanged. Concurrent drift leaves the resulting surface withheld; an
already unapproved or changed workspace is never approved by file consent.
See [self-configuration.md](../../specs/hosts/self-configuration.md) for the path policy, volatile
identity and explicit filesystem limits. Normal turns retain their configured runtime.

The file kernel includes `clarvis-configure`, a user-invocable skill with its body in
[`src/skills/clarvis-configure.ts`](src/skills/clarvis-configure.ts). It ships in the executable,
requires no `SKILL.md` or first-run scaffolding, and remains available with an empty custom
Extension Profile. Agents carrying `use_skills` can load it through `load_skill`; clients can invoke
it through the ordinary skills service. `/clarvis-configure` is the only path that starts the
privileged configure run. A `$clarvis-configure` mention in an already-open turn stays literal text:
it does not dump the guide and does not request `configuration_access`. Loading it during an ordinary
turn grants no configuration authority: the guide directs changes to `/clarvis-configure`, and native
file-mutation tools reject workspace `.clarvis` and `.agents` targets before guard review. Disabling
skills through the host or environment also disables this builtin.

The guide covers configuration scopes, Agent Profiles and subagents, grants and host ceilings,
models, Extension Profiles, plugins, MCP, hooks, memory, plans, goals, tasks, workflows, runtime,
remote SSH, `/loop` scheduling and background runs. For remote connections it distinguishes the
local TUI from the remote installation, delegates keys/host verification to OpenSSH, requires login
preparation outside the TUI and records the disabled forwarding/machine-control boundaries. It
distinguishes TUI-owned, in-memory schedules from runs
that continue in the workspace host, and explains attachment, cancellation and consent lifetime.
Its [TypeScript examples](src/skills/configuration-examples.ts) are rendered verbatim in the guide
and exercised against the product loaders. They include a complete workflow with its brief and
Admiral launcher, a nonempty Extension Profile with exact plugin/skill identities, and settings
fragments for the configurable services. Workflow files are loaded on the next manager run;
Extension Profile selection uses the operator's preview/confirmation and `/reconnect reload` flow
when the host is idle. Plain `/reconnect` restores a connection to the same host without applying
pinned configuration. The configuration tool authors files; installation, selection, workspace
trust, credentials, UI preferences, loop registration and background controls retain their operator
interfaces. A working default model is needed to enter this mode.
Loading it grants no configuration, filesystem or credential authority. Its reserved name cannot
be replaced by an installed skill. Discovery and resources for other skills retain their existing
snapshot and confinement rules. See [the skills contract](../../specs/execution/skills.md).

## The agent fleet ships as data

Clarvis ships five agents — `marshall`, `admiral`, `coder`, `explorer`, `planner` — as TypeScript in
`src/config/builtin-agents/`. They are not templates copied into a user's configuration on first
run: there is no scaffolding step, and a host whose configuration directory is empty already has all
five. That is what lets `@clarvis/code` reach its first prompt, and `@clarvis/server` serve a
request, against a directory nothing has ever written to. `DEFAULT_ENTRY_AGENT` (`marshall`) is what
`createFileKernel` hands the run assembler, so a request naming no agent still resolves.

The two shipped leaders, `marshall` and `admiral`, each declare a 200-iteration soft session limit;
the `coder`, `explorer`, and `planner` children remain capped at 30 iterations. The explicit lead
value matches the product default instead of shadowing it with the former 50-iteration profile cap.

The builtin bodies define roles and the minimum harness handoff contract, not a generic engineering
handbook. All five condition instructions on the tools actually exposed, distinguish a delegated
brief from caller conversation, acknowledge the shared workspace, and select `submit_result` only
when present. Marshall covers independent versus tracked delegation, background handles, review of
returned work and live-child finalization. Admiral adds the workflow spawn ladder, revision-matched
checkpoints, batch-local conflict protection and partial writes after failure. Leaves state their
limitations and return blockers instead of assuming missing authority or context. Detailed argument
and recovery instructions stay beside their tools; see
[`model-instructions.md`](../../specs/cross-cutting/model-instructions.md).

`builtin-agents.test.ts` applies the engine's text estimate (one token per four
characters) and caps the complete five-body payload at 1150 estimated tokens, with per-profile caps.
This is a regression budget, not a claim about any provider's exact tokenizer.

`BUILTIN_AGENTS` is ordered, and `compareAgentDisplayOrder` is the single owner of that order:
the shipped fleet first, in the product's order, then every other name ascending. It ranks by
**name**, so a customized `marshall` keeps its place. `ConfigService.listAgents` sorts with it, so
the order is a contract every client sees rather than something each one re-derives.

A config file of the same name **overlays** a shipped agent field by field
(`resolveEffectiveAgent`): the file's frontmatter keys win, a non-empty body — or a `base_prompt` —
replaces the prompt, and everything unmentioned keeps following the shipped default. An overlay
whose YAML does not parse, or whose frontmatter fails `agentFrontmatterSchema`, is **refused**: the
shipped agent runs unchanged and the record carries `AgentOverlay.reason`. A typo therefore costs a
user their customization, never their fleet. There is no equivalent tolerance for an agent Clarvis
does not ship — fallback is only possible where a default exists.

Three surfaces keep this straight, and confusing them is the way to break it:

- `listAgents()` returns the agent that will **run** — one record per shipped name, already
  resolved, carrying its `overlay`.
- `readAgent(scope, name)` returns one **layer** verbatim, and takes `"builtin"` for the shipped
  agent ignoring any file. An editor must open the bytes the user wrote; the cross-scope conflict
  check must be able to ask whether a _file_ exists.
- `readEffectiveAgent(name)` is what the run assembler calls, for the entry agent and for every
  transitive `can_spawn` child alike.

An untrusted workspace contributes no layer at all, exactly as it contributes no entry to
`listAgents` — otherwise a cloned repository could rewrite a shipped agent's system prompt by
shipping `.clarvis/agents/marshall.md`.

File configuration is admitted through descriptor-backed bounded reads: a settings or context
document is at most 2 MiB, one agent document 256 KiB, and one scope exposes at most 64 agent files
and 8 MiB of aggregate agent source while examining at most 256 directory entries. Oversized
settings remain visible as an errored source, oversized agents never enter the executable catalog,
and direct reads/writes fail explicitly. The same descriptor is sized and read, with one extra byte
of lookahead, so a file that grows between `stat` and `read` cannot bypass the ceiling.

The read-only workspace service applies the same rule before returning a file to a UI: text is
limited to 8 MiB and images to 7 MiB before base64 expansion. Its picker walks directory handles
incrementally, stops after 4,000 files or 20,000 examined entries, and clamps caller limits; one
huge directory or image therefore cannot become a multi-gigabyte protocol response.

## Run events reach a client by two paths

Both land as protocol `RunEvent`s: the engine trace, mapped by
`engineEventToProto`, and the capability channel, mapped by
`capabilityEventToProto`.

`engineEventToProto` preserves cumulative argument `tool_input_delta.chars`, the optional distinct
provider-liveness total `stream_chars`, and optional `complete: true`. The latter ends argument
composition only; it does not synthesize
`tool_call_started` or a terminal result. The separate minimal `tool_call_announced` is persisted,
non-coalescible and non-droppable. `engineEventToProto` preserves its iteration and attempt in both
live delivery and `RunDetail` replay; all input deltas remain live-only.

The engine trace is an open event vocabulary. `engineEventToProto` recognizes a capability-owned
persisted event through that package's public structural guard before narrowing the remaining event
to the engine built-ins. Workflow leader lifecycle edges use this path: the workflows package owns
their projectors and narrowing, while the kernel owns only their protocol DTO mapping.

Rehydration reads **only the persisted trace**, so any event a restored session
must show has to map in `engineEventToProto` too — an event that travels only the
capability channel is live-only, which is why a rehydrated session in `code`
restores no plan block.

Plan documents are deliberately not in the trace at all: the record's `plan_ref`
names the file, and clients read it back through `PlansService`.

The internal transport negotiates the exact `CLARVIS_WIRE_VERSION` declared in
[`wire.ts`](src/transport/wire.ts). This is independent of the guest execution RPC revision. Hello is
mandatory before every read, control or mutation even for in-process/default-owner connections;
request envelopes reject unknown fields, physical stdio frames are capped at 8 MiB, and logical
messages are capped at 64 MiB. The serialized writer has bounded count/bytes plus a 30-second
transfer timeout. `run.result` settles execution independently
from `run.stream_end`, which closes the event channel only after its tail. In-process and remote run
streams use the same 1,024-event policy and exhaustive coalescing/drop registry. Capability events
cross the closed protocol union only after sanitization and a 64-KiB bound. Established plan
projections additionally pass a closed runtime schema; every other declared projection uses the
generic `capability_event` envelope, so its payload cannot spoof a builtin discriminator or
timestamp.

File-backed session catalogs page bounded summary sidecars in exact `updated_at`/id order. A large
or legacy catalog is scanned in slices bounded by both entry count and inspected bytes, keeps only
the requested top-K candidates in a page-sized heap, and observes transport cancellation between
slices; it therefore remains responsive without weakening cursor stability or retaining the complete
catalog in memory.

Workflow catalogs follow the same body/sidecar split. `workflows.list` scans only bounded 8-KiB
summary sidecars on its normal path, yields every 64 records or 512 KiB inspected, and retains at
most `offset + limit` rows in a top-K heap; limits are 1–200 and offsets 0–2,000. Legacy bodies are
read only to repair a missing/corrupt sidecar, while the compatibility full-record `WorkflowStore.list`
refuses more than 200 records or 32 MiB. A workflow record retains at most 256 manager/leader edges;
large task, error and reason text is UTF-8 bounded with an explicit truncation marker. Event-driven
snapshots are coalesced over 50 ms instead of synchronously serializing the growing tree per event,
and the terminal snapshot is synchronously flushed from managed-run settlement before `done` and
`closed` can finish.

The same record persists the latest manager-owned round checkpoint. Every transition emits
`workflow_sequence_state` and updates `WorkflowDetail.sequence`, including `awaiting_manager` with
its revision and proposed next round. The event is structural and non-droppable in the run stream;
the persisted projection lets the Workflows tree show the decision point after the live stream is
gone. If the manager is cancelled, fails or is crash-reconciled while that sequence is still
`running_round` or `awaiting_manager`, the terminal snapshot closes it as `cancelled` or `failed`,
increments its revision and removes the impossible next-round proposal. A defensive completed exit
closes the same impossible state as `stopped`. Legacy and ad-hoc-only records simply omit the field.

Executable workflow definitions are resolved separately for every manager run. The kernel starts
with the `audit`, `implement` and `research` definitions exported by `@clarvis/workflows`, then applies
valid global and workspace documents by name. Effective precedence is
`workspace > global > built-in`; a malformed document is logged and leaves the lower-precedence
definition available. The kernel never materializes a built-in as a user-owned file.

Workflow leaders are isolated auxiliary runs. Their requests force both planning and memory off,
and their engine deps exclude the memory capability. The manager keeps the ordinary primary-run
memory surface and is the only run in that workflow that enqueues an index job. A leader failure,
unfinished edge, or refused leader reservation makes the aggregate workflow record failed while
preserving the manager edge's own completed status. Because the manager's `workflow` capability is
injected only for that primary run, its later memory pass uses the isolated digest path instead of
trying an invalid continuation with an undeclared grant.

The service also constructs one cumulative leader counter per manager from
`workflows.max_total_leaders`. It is shared by ad-hoc leaders, work-item batches and round sequences;
completion does not refund capacity. The workflow capability's per-run coordinator starts only the
first authored round, exposes the checkpoint tools to Admiral, and requires a revision-matched
decision before each later authored round or repeat pass.

Primary and auxiliary token ledgers are likewise constructed anew inside every manager execution,
not accumulated across session turns. Auxiliary claims account for both the configured leader
concurrency and the engine's concurrent `delegate_task` capacity. Ordinary manager children cap each
model call at that fair share; leaders claim their subtree only after semaphore admission, and their
root/subagent model calls partition it again. A model with no explicit output cap therefore cannot
let one call reserve the entire workflow budget before its siblings start.

A settled run no longer remains leased for the memory indexer's multi-minute retry schedule. Its
event stream waits five idle seconds for the usual immediate terminal notice, renews only within a
15-second absolute window, and hard-caps every override at one minute. The durable memory job keeps
retrying after the stream closes; only the transient client projection is released.
Each physical indexer pass reacquires the same Extension Profile run lease before calling the loop, so a
durable retry cannot consume host skills or extension bytes after the foreground lease has closed.

File-backed agent operations validate agent names at the service boundary.
Names may contain letters, numbers, underscores and hyphens; path separators
and traversal segments are rejected before filesystem access.

## Observability

`createFileKernel` builds one logger (`opts.logger`, else `createLogger(CLARVIS_LOG_LEVEL, { service:
"@clarvis/kernel" })`) and hands `componentLogger(<component>)` to every collaborator it constructs —
`config`, `guard`, `plugins`, `plan`, `memory`, `tasks`, `trace`, `kernel`.
`CLARVIS_LOG=config=debug` therefore turns one subsystem on without
raising the global level. `createInProcessKernel` takes a `logger` of its own and passes it to the
plugin service, the model catalog and each owner's runs/sessions with `{ owner }` bound.

**The audit channel is a second logger, not a level.** `createAuditLogger(root, env.CLARVIS_LOG_AUDIT)`
derives a child pinned at `info` over the same destination, and only command-guard decisions use it.
`CLARVIS_LOG_LEVEL=warn` is a legitimate production setting and must not silence the record of what a
run was allowed to execute. It is configurable by environment only — never `settings.json`, whose
workspace scope is a file inside the agent's own working tree.

| Level | `event`                                                        | Fields                                                                                          |
| ----- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| info  | `guard.decision` _(audit)_                                     | `verdict`, `matched`, `mode`, `tool`, `reason`, `escalate`, `command_digest`, `run_id`, `owner` |
| info  | `guard.resolved` _(audit)_                                     | `mode`, `source`, `judge_configured`, `human_channel`                                           |
| info  | `guard.elicit.answered` _(audit)_                              | `answer`, `answerer`                                                                            |
| warn  | `guard.escalation.no_channel` _(audit)_                        | `run_id`                                                                                        |
| info  | `kernel.boot.started`                                          | `workspace_root`, `global_dir`, `ownership_mode`, `memory_enabled`, `default_model`             |
| info  | `kernel.config.scopes`                                         | `global_present`, `workspace_present`, `workspace_trust`, `plugin_scopes`, `enabled_plugins`    |
| error | `kernel.config.rejected`                                       | `scope`, `path`, `at`, `message`, `schema`                                                      |
| warn  | `kernel.config.document_discarded`                             | `scope`, `path`, `reason`                                                                       |
| warn  | `kernel.config.agents_unreadable`                              | `scope`, `dir`, `cause`                                                                         |
| debug | `kernel.capabilities.registered`                               | `specs`, `grants`                                                                               |
| info  | `kernel.capability.composed`                                   | `capability`, `enabled`, `reason`                                                               |
| warn  | `kernel.plugin.skipped`                                        | `plugin`, `scope`, `phase`, `cause`                                                             |
| info  | `kernel.models.catalog`                                        | `source`, `providers`, `models`                                                                 |
| warn  | `kernel.models.cache_invalid`                                  | `path`, `cause`                                                                                 |
| info  | `kernel.boot.ready`                                            | `duration_ms`, `recovered_runs`, `capabilities`                                                 |
| info  | `runs.recovered_interrupted`                                   | `recovered`, `examined`, `quarantined`, `degraded`, `exhausted`                                 |
| warn  | `runs.recovery_failed`                                         | `cause`                                                                                         |
| debug | `runs.event.unmapped`                                          | `path`, `kind`, `capability`, `reason`                                                          |
| debug | `runs.rehydrated`                                              | `execution_id`, `events_total`, `events_mapped`, `events_dropped`                               |
| debug | `sessions.rehydrate`                                           | `session_id`, `found`, `turns`, `pending`                                                       |
| warn  | `local.process.failed`                                         | `command`, `exit_code`, `duration_ms`, `stdout_chars`, `stderr_chars`                           |
| warn  | `local.git.failed`                                             | `op`, `repo_host`, `cause`                                                                      |
| warn  | `transport.frame_dropped`                                      | `direction`, `reason`, `bytes`                                                                  |
| warn  | `transport.{notify,cancel,subscribe,unsubscribe,close}_failed` | `operation`, `cause`                                                                            |
| warn  | `lifecycle.late_close_failed`                                  | `operation`, `cause`                                                                            |
| warn  | `capexec.session.failed`                                       | `capability`, `cause`                                                                           |

Six properties are load-bearing rather than incidental:

- **`guard.decision` never carries the command.** It carries the first 16 hex of its SHA-256, which
  is enough to tell "the same command was approved twice" from "two different commands were" and
  nothing more. A command line routinely holds a token or a private path, and this record is the one
  designed to be durable. The guard itself stays a pure function: `createShellGuard` takes an
  `onDecision` observer that cannot change a verdict, and `createGuardResolver` — which already holds
  the run's identity — does the binding.
- **`matched` is the machine contract, not `reason`.** The six-way rule vocabulary
  (`deny_list`/`allow_list`/`undecidable`/`outside_workspace`/`credential_file`/`non_bash`/`default`)
  is greppable; the sentence beside it is prose and free to change.
- **`kernel.config.rejected` is the diagnostic that already existed and had no channel.** The precise
  `invalid <path>: <at>: <message>` was built and attached as `SettingsSource.error`, visible only to
  a client that called `config.getSettings()` — which is why a `settings.json` this schema refuses
  looked, to everything else, like a workspace with no settings at all. It is rate-limited per
  distinct `(scope, path, at, message)`: the same bad file is re-read on every snapshot.
  `kernel.config.document_discarded` is the worse case, because that path is about to _overwrite_ the
  document it folded onto `{}`.
- **`runs.event.unmapped` is the rehydration hazard made visible.** `engineEventToProto` returns
  `null` for anything it does not recognize and `map-result.ts` filters those away, so a format skew
  between writer and reader deletes events from a restored session with no signal at either end. It
  is a log and not a mapping change — a client's event union is closed, and forwarding an
  unrecognized shape into it is the worse failure. Counter-sampled through `createSampler()` and
  guarded by `levelEnabled`, because a rehydration replays a whole run's trace in one loop.
  `runs.rehydrated` is its aggregate half.
- **`serveFileKernelOverStdio` refuses a logger bound to its own wire.**
  `CreateLoggerOptions.destination = 1` exists and serve options pass straight through to
  `createFileKernel`, so
  `createLogger(level, { destination: 1 })` used to interleave pino records with the NDJSON frames.
  The check reads pino's stream symbol by description (this package does not depend on pino) and
  compares its `fd` to the output stream's; an unrecognized backend reports no descriptor and the
  serve proceeds exactly as before.
- **The nine `process.emitWarning` call sites are gone.** No package installs a
  `process.on("warning")` handler, so those records reached the host's raw stderr — over the terminal
  a TUI owns, and interleaved as non-JSON lines with pino JSON in a container. Every
  `detachObserved`/`bestEffort` observer now goes through `observationSink(logger, event)`.

**There is no `logging:` settings block, and there will not be one.** Every boot event above happens
before or during the settings read, so a block could not configure the logging of its own rejection.

## Test ownership

The suite is classified by its primary boundary while the architecture migration proceeds:

- `tests/unit/` owns pure mapping, event policy and state-machine decisions, guard policy,
  prompt-cache configuration, workflow routing policy and other deterministic request projections.
- `tests/component/` owns kernel services and assembly over typed fakes or in-memory collaborators:
  memory, skills, planning, the memory MCP port, settings-to-run assembly and executable facade
  composition.
- `tests/contract/` applies shared configuration-service behavior to its interchangeable stores.
- `tests/integration/` owns real filesystem, process, git, loop, plan, stdio and loopback boundaries,
  plus file-kernel and owner/composition wiring. Memory capability/loop behavior belongs to
  `@clarvis/memory`; this package keeps one composition-root sentinel only.
- `tests/architecture/` owns static enforcement of the six-entry public surface and the
  cross-package workspace-layout invariant.
- `tests/helpers/` contains executable fixtures only. They run under the repository's pinned Bun
  runtime; the kernel test suite does not require a second language runtime. Helpers are not test
  entrypoints and own no behavior matrix.

`tests/unit/managed-run.test.ts` is the single owner of run-handle buffering, drain-acknowledged
steering and close-before-drain refusal, explicit
compaction, cancellation, elicitation replay, memory-ingest grace/renewal, dropped-event reporting
and lifecycle admission. The ordinary run and workflow-manager integrations intentionally do not repeat that
matrix; they retain only their distinct loop/service wiring smokes. The managed-run clock seam is an
internal test seam and is not exported from a package entrypoint.

`tests/contract/transport-codecs.test.ts` owns the descriptor-driven request/dispatch matrix and the
remote run codec; its complete service fake records calls without implementing another copy of each
service's CRUD semantics. `tests/contract/stdio-codec.test.ts` owns NDJSON framing, error envelopes
and EOF. Loopback and stdio integrations each retain a representative real-kernel flow, while service
behavior remains with the service/component suites.

Guard units begin at the `ShellFacts`/`PathFact` boundary the kernel actually consumes. POSIX and
PowerShell parsing/canonicalization belong to `@clarvis/tools`; this package keeps one integration per
dialect to prove analyzer facts cross into kernel deny policy without replaying either parser matrix.

`tests/integration/memory-capability.test.ts` proves only the kernel-owned join: the kernel registry
accepts the memory run parameter, the deps-level capability reaches an ordinary run, and its
`seedMarker` remains registered when `memory: "off"` makes the capability inactive. Seed/tool
composition, durable enqueue, cancellation learning, ingest notices and broker settlement are owned
by `@clarvis/memory`.

The default `test` command runs every tier in one Bun invocation. `test:coverage` runs every
source-executing tier with coverage and then executes architecture checks once without counting them
as source behavior coverage. Each tier also has a targeted `test:<level>` command.

## Development

Run commands from the monorepo root:

```bash
bun --filter @clarvis/kernel build
bun --filter @clarvis/kernel typecheck
bun --filter @clarvis/kernel test
bun --filter @clarvis/kernel lint
bun --filter @clarvis/kernel format:check
```

When a dependency's public TypeScript surface changes, rebuild it before
typechecking this package. The package requires Bun 1.4.0 or newer.

## Prompt-cache continuity

Live and restored run results retain a checkpoint's disposition and bounded summary/next-step
handoff separately from a final text or schema value. The SDK composition test in
`tests/integration/checkpoint-composition.test.ts` exercises an open discard plan, kernel reopen,
unchanged cache identity and serialized prefix, then final schema validation and plan retention.
The test supplies explicit continuation; automatic goal admission belongs to the hosted controller.
Successful `run_ended` events preserve disposition through trace replay and the versioned RPC codec.
The codec refuses disposition on unsuccessful events; it never derives completion from tool names.
Goal iteration preparation reads the bound host state before the next request. A future-only pause
is therefore visible after an ordinary tool batch without model polling, while the current stage
may still checkpoint and settle. SDK composition tests preserve the preceding request prefix, tool
exchange, catalog and cache identity through that transition.

Hosted session preparation persists the leader instance before the first call. The same session and instance fields cross native/guest execution. `@clarvis/kernel/bootstrap` exposes host subscription manager/adapter construction for bounded transport observation; credentials remain under host authority. Kernel integration tests compose the real plan, loop and SDK through persisted continuation.
For a goal stage, the host observes its provider port directly, including child, compaction and
retry consumption. A pending call, a cancelled call without usage, or an unreported attempt leaves
accounting unknown and prevents continuation. A failed stage with confirmed exhausted goal spend
settles as `budget_limited`, preserving its physical outcome and any measured overrun; newer user
pause/cancel controls still prevail. Missing cache detail alone counts the full input
conservatively. Zero-initialized loop or guest totals cannot override that observation.
The [goal-file-host.test.ts](tests/integration/goal-file-host.test.ts) integration suite exercises IPC, the actual file host, SDK and HTTP
with controlled responses: two automatic continuations with a delegated plan, prefix/identity
preservation, pause/resume, cancellation and absent usage. It is separate from live-provider,
container-engine and installed-artifact qualification.
The companion [plan review test](tests/integration/goal-file-host-plan.test.ts) answers actual IPC
elicitations: approval permits delegated work and two checkpoints; cancellation or requested changes
prevents workspace writes and preserves the unapproved plan even with discard retention.
The [compaction test](tests/integration/goal-file-host-compaction.test.ts) queues compaction through
the active hosted handle. The real SDK summary call is included in goal/session consumption; one
rolling anchor, current goal and plan survive into automatic continuation. SDK requests preserve the
historical prefix before and after the deliberate compaction boundary.
The optional [goal-file-host.e2e.test.ts](tests/integration/goal-file-host.e2e.test.ts) runs the same
automatic journey in a real Docker or Podman engine using the existing runtime canary opt-in,
image-digest and connection settings. It records the loaded guest binary hash, each stage and
request, reconciled consumption and verified resource cleanup under `build/goal-file-host-e2e/`.
Those controlled-HTTP results do not qualify a live provider or the installed TUI.
Workflow leaders retain the manager's session identity and use their reserved child execution ID
as their own persisted agent instance. Two leaders of the same profile therefore have distinct
cache keys, separate from the manager, in both direct and prepared host assembly.
The captured SDK requests also cover transport retry, two same-profile children, physical-call
cancellation, guard-policy resume and the actual indexing pass. Restricting indexing dispatch
preserves the complete advertised catalog while rejecting inherited workspace tools.
Memory passes receive the same composed capability registry as foreground runs and
carry the source's registered request parameters. Planning is replaced in place by
`createPlansCatalogCapability`, preserving its tools and delegation schema while
removing source-plan gates and lifecycle. Indexing a paused checkpoint therefore
cannot fail, finalize or discard its open plan. The real file-host/SDK regression in
`tests/integration/goal-file-host-memory.test.ts` covers that boundary and catalog
identity in all three planning modes.

The SDK composition tests declare `@clarvis/llm` as a development dependency. Runtime provider
construction remains owned by the loop's host services; the dependency does not add an eager
provider import to the kernel.

See the [prompt-cache contract](../../specs/cross-cutting/prompt-cache.md) for replay, identity
validation and separate deterministic, live-provider and installed-artifact qualification.
