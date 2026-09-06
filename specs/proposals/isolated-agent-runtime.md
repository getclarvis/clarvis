# Proposal: Isolated agent runtime with OCI engine backends

**Status:** Superseded design record; not the current runtime contract
**Date:** 2026-09-04
**Target repository:** `getclarvis/clarvis`; repository links resolve from this document
**Source baseline:** `5c999dd4c5ca`
**Preferred first engine:** Docker through a selected Linux Docker context; Podman remains a
conforming explicit adapter
**Validation scheduling:** On 2026-09-05 the current-source Docker canary passed through Colima,
including a mise-installed Node runtime, public npm install and host-loopback service preview; the
owner deferred live Podman and complete TUI proofs. The model bridge in that canary was synthetic.
Prepared environments and synthetic fixtures do not count as substitutes for the remaining live
surfaces.
**Proposed owners:** `@clarvis/kernel`, `@clarvis/protocol`, `@clarvis/code`, `@clarvis/paths`,
`@clarvis/tools`, with focused integration changes in provider and capability composition

> This proposal is retained only to explain the discarded copy/review/apply design. Every statement
> below that describes a temporary workspace copy, private Git metadata, `workspace_merge`, staged
> apply, or retained runtime checkout is historical and is not implemented. The current contract and
> production/test evidence live in
> [`specs/hosts/isolated-agent-runtime.md`](../hosts/isolated-agent-runtime.md).

### Superseding architecture decision (2026-09-06)

The container is a disposable **agent execution worker**, not a second Clarvis host. It contains
the agent loop and subagents, the local tools needed for execution, and a direct writable bind of
the workspace Clarvis already selected. Everything else remains authoritative on the host.

In particular, the host owns the TUI and public `KernelClient`, configuration, approvals,
credentials, provider traffic, sessions, traces, memory, plans, tasks, workflows, runtime records,
and capability mutation. The guest can use host-owned capabilities only through a closed,
generation-bound execution RPC. It never receives `~/.clarvis`, a host state directory, provider
credentials, or the engine socket. Workspace control paths are overlaid read-only while the rest of
the selected workspace is writable.

If Clarvis starts inside a linked Git worktree, that worktree is already the separate copy: Clarvis
mounts it and the required shared Git metadata, but does not create another copy or own commit,
merge, apply, or worktree removal. Primary checkouts and non-Git folders are mounted directly too.
Guest changes are visible on the host immediately. At run settlement the host durably commits the
session, trace, capability state and latest accepted checkpoint; workspace writes are not a staged
terminal participant.

The copy/review/apply implementation described in the remainder of this file was removed because it
conflicted with host Memory writes during a pending elicitation and duplicated Git's worktree model.
The host-authoritative worker and direct-mount contract is specified operationally in the owning
host spec linked above.

## 1. Product contract

Clarvis can run its agent execution worker inside a disposable Linux container while the TUI and
authoritative kernel services stay on the user's machine. The container is the agent's execution
machine: the loop and subagents, file tools, shell commands, Git, toolchains, hooks, local MCP
servers, and execution-local capability executables run there against a temporary workspace copy.

The agent can install dependencies and modify its container environment. Its authority over the
user's machine is bounded by grants enforced outside the container: host capability methods,
authenticated services, networking, preview ports, change export, and explicitly supported host
operations. Installing a tool does not make it part of durable Clarvis state.

The accepted default image is a bootstrap rather than an omnibus development environment. It ships
the standalone Clarvis worker, Git, CA certificates and mise, with no preinstalled language runtime
or compiler. A shell-capable agent installs an exact missing toolchain through mise into disposable
runtime scratch. Promoted internal images may add reviewed project-specific toolchains without
changing this default.

Native execution remains available. Selecting a container never silently falls back to native
execution. Missing engine support or an unenforceable requested grant prevents launch.

The first implementation targets one local user, one selected workspace copy, and one container per
runtime session. A runtime session can contain multiple conversation runs and their subagents.
Subagents sharing that container share its filesystem and privileges; this is not isolation between
agents. The host remains the only owner of durable product state. Independent task machines and
remote hosting are later extensions.

### 1.1 Two independent concepts

| Concept           | Selection                                                    | Responsibility                                     |
| ----------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| Runtime backend   | Native or container; remote reserved for future design       | Where agent execution and execution-local tools run |
| Command sandbox   | Existing native sandbox policy, when applicable              | Additional restrictions on individual subprocesses |
| Container engine  | Podman first; another adapter only after conformance testing | Creates, inspects, stops, and removes containers   |
| Extension Profile | Existing contract                                            | Which plugins and skills are active                |

A runtime selection is not an Extension Profile. A Podman backend does not become another branch
inside `sandboxCommand`: wrapping only shell commands would leave the kernel and other execution
surfaces on the host.

The first container profile uses its outer policy without nesting Bubblewrap inside it. The host
must deliberately resolve that profile rather than treating a missing inner sandbox as degraded
native execution. Existing native settings and guards retain their documented behavior in native
mode; a later inner sandbox is an independent, explicitly advertised feature.

### 1.2 Scope and limits

This design does not promise confidentiality for files deliberately exposed to a networked agent,
integrity of files deliberately mounted writable, protection from every container/kernel escape,
or truthful reports from a compromised runtime. It provides a smaller, explicit external authority
boundary and covers more agent-executed code with that boundary.

Native Linux containers share a kernel with their Linux host. On macOS, the proposed Linux runtime
requires a VM and cannot validate native macOS behavior. Hardware access, host applications, native
platform SDKs, and projects requiring an engine socket remain reasons to select native execution or
a separately designed capability. No engine socket forwarding is part of this proposal.

## 2. Engine choice: Podman first on Linux

Podman is a suitable first adapter because its Linux CLI supports daemonless operation and running
containers as an ordinary user. The proposal uses the CLI directly and does not require Podman
Desktop or a general engine API listener. [Podman overview](https://docs.podman.io/en/latest/markdown/podman.1.html).

| Option                           | Operational implications                                                  | Proposal decision                                         |
| -------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| Rootless Podman on Linux         | Local CLI, user namespaces, no required persistent central daemon         | First reference implementation                            |
| Rootless Docker Engine on Linux  | Client plus a per-user daemon in a user namespace                         | Conforming alternative after the reference adapter        |
| Podman Machine on macOS          | Host CLI communicates with a Linux VM; engine state and images live there | macOS candidate, gated separately                         |
| Docker Engine through Colima     | Docker client communicates with an engine in a Colima Linux VM            | macOS candidate, gated by the same conformance suite      |
| Docker Desktop                   | Includes a VM and desktop integration                                     | Optional user-provided engine, not a product prerequisite |

Podman requires a VM on macOS and Windows. A rootless machine-management command does not by itself
prove that the selected engine connection is rootless; inspection must verify the connection's
actual mode. [Podman machine](https://docs.podman.io/en/latest/markdown/podman-machine.1.html),
[machine configuration](https://docs.podman.io/en/latest/markdown/podman-machine-set.1.html).

Docker Engine and Docker Desktop are different deployment choices. Docker Engine also supports
rootless mode; a Docker backend must not be rejected on a claim that Docker necessarily requires
host-root containers. [Docker Engine](https://docs.docker.com/engine/),
[Docker rootless mode](https://docs.docker.com/engine/security/rootless/).

Both adapters run the same reviewed guest image and protocol; engine selection changes the host
control plane, not the intended guest payload. "Smaller" is a measurement question. Compare
installation and image bytes, idle engine/VM RSS, cold and warm startup, workspace I/O, and
shutdown. No performance advantage is established here. On macOS, VM allocation and image contents
may dominate the difference between engines. Docker Desktop runs its engine in a Linux VM, Podman
uses Podman Machine, and Colima can provide Docker without requiring Docker Desktop.
[Docker Desktop permissions and VM boundary](https://docs.docker.com/desktop/setup/install/mac-permission-requirements/),
[Podman Machine](https://podman-desktop.io/docs/installation/macos-install),
[Colima runtimes](https://github.com/abiosoft/colima#runtimes).

Clarvis does not bundle, install, start, stop, or reconfigure an engine as part of ordinary runtime
selection. The operator chooses an existing engine connection. If both are available, Clarvis uses
the configured engine rather than guessing which one is lighter or silently switching between
different effective policies.

Using Podman does not require Kubernetes, Compose, a registry service, or a published Clarvis image.
A reviewed Containerfile and local image build are sufficient for the first implementation.

## 3. Current source and implementation seams

These are current-source anchors, not evidence that the proposed container behavior exists.

| Existing behavior                             | Production                                                                                                                                                                                                                                           | Existing test or contract                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport-neutral UI services                 | `KernelClient` in [protocol client](../../packages/protocol/src/client.ts)                                                                                                                                                                           | [protocol README](../../packages/protocol/README.md), [public contract fixture](../../packages/protocol/tests/contract/public-contract.fixture.ts)         |
| Versioned requests, events, and stdio framing | `connectKernelClient` in [client](../../packages/kernel/src/transport/client.ts), `createStdioTransport` in [stdio](../../packages/kernel/src/transport/stdio.ts), and `CLARVIS_WIRE_VERSION` in [wire](../../packages/kernel/src/transport/wire.ts) | [transport spec](../hosts/kernel-transport.md), [codec tests](../../packages/kernel/tests/contract/transport-codecs.test.ts)                               |
| File-backed kernel over stdio                 | `serveFileKernelOverStdio` in [serve.ts](../../packages/kernel/src/serve.ts)                                                                                                                                                                         | [serve tests](../../packages/kernel/tests/integration/serve.test.ts), [stdio integration](../../packages/kernel/tests/integration/stdio-transport.test.ts) |
| TUI still creates a kernel in process         | `WorkspaceClientManager.create` in [workspace client manager](../../packages/code/src/adapters/workspace-client-manager.ts)                                                                                                                          | [Code bootstrap](../hosts/code-bootstrap.md), [kernel composition](../hosts/kernel-composition.md)                                                         |
| Only shell and monitor use the native wrapper | `sandboxCommand` in [sandbox.ts](../../packages/tools/src/sandbox.ts)                                                                                                                                                                                | [sandbox spec](../execution/sandbox.md), [sandbox tests](../../packages/tools/tests/integration/sandbox.test.ts)                                           |
| Remote subscription login is unavailable      | `createKernelServer` substitutes `createUnavailableProviderAuthService` in [server.ts](../../packages/kernel/src/transport/server.ts)                                                                                                                | [subscription contract](../hosts/subscription-providers.md)                                                                                                |
| Workspace identity depends on canonical paths | `discoverGitWorkspace` in [git-workspace.ts](../../packages/kernel/src/git-workspace.ts)                                                                                                                                                             | [kernel composition](../hosts/kernel-composition.md)                                                                                                       |
| User-entered shell executes locally           | `runLocalBash` in [local-shell.ts](../../packages/code/src/adapters/local-shell.ts)                                                                                                                                                                  | [Code README](../../packages/code/README.md)                                                                                                               |
| Guard-reviewed direct execution exists        | `hostVcs` in [host-vcs.ts](../../packages/tools/src/tools/host-vcs.ts)                                                                                                                                                                               | [command guard](../execution/command-guard.md), [tools README](../../packages/tools/README.md)                                                             |

The stdio integration currently uses byte streams within the test process. It is not a real TUI,
child-process, engine, or VM canary. Shipping a container backend requires all those additional
boundaries to be exercised.

## 4. Ownership and architecture

```text
HOST: trusted application and authority
  TUI -> public KernelClient -> host kernel/control plane
             |                    +-> config, approvals, credentials, models
             |                    +-> sessions, traces, memory, plans
             |                    +-> tasks, workflows, runtime records
             |                    +-> source checkout and change application
             |
             +-> runtime supervisor -> Podman CLI -> selected engine / machine
                          |                               |
                          | closed execution RPC          | starts / inspects / stops
                          v                               v
CONTAINER: disposable agent execution worker
  agent loop + subagents
  file/shell/Git/hooks/local MCP/toolchains
  writable /workspace -> host-prepared temporary copy
                          |
                          +-> model and host-capability requests -> HOST
```

The TUI always connects to the host's ordinary `KernelClient` facade. The private guest channel is
an implementation detail of the host runtime backend and is not another public `KernelClient`
transport. The supervisor initially lives in the Code host process. A separate long-lived daemon is
not required. Reliable orphan termination has its own external enforcement requirement in section 9.

### 4.1 Component ownership

| Owner                         | Proposed responsibility                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `protocol`                    | Public host-facing runtime status and `KernelClient` DTOs; no engine or private guest protocol implementation |
| `kernel`                      | Host control plane, execution session port, engine adapter, brokers, durable state, workspace copy/apply and lifecycle policy |
| `code`                        | Runtime selection/status, launch and change review, reconnect/reset UX, and host-specific adapters            |
| `paths`                       | Host Clarvis state plus runtime registry, temporary-copy, baseline and journal path construction              |
| `tools`                       | Execution-local tools in the guest and host-capability adapters with explicit ownership                       |
| `loop` and subagents          | Execute in the guest from host-supplied inputs and report events/checkpoints; no engine-name branches          |
| Capability packages          | Keep canonical stores and coordination on the host; expose bounded tool methods to the guest                  |

Start with a bounded kernel runtime subpath if it satisfies the existing package rules. Do not add
a workspace solely because this proposal names a new abstraction. A later package extraction must
name its lifecycle/security owner, consumers, public contract, README, and permitted edges under
[package architecture](../cross-cutting/package-architecture.md).

Keep engine discovery and guest bootstrap off the native CLI's eager import path. Building the
host-side adapter must not start an in-process execution kernel merely to supply login or config.

### 4.2 Session port

The following is illustrative TypeScript, not a new exported API:

```ts
interface RuntimeBackend {
  inspect(): Promise<RuntimeAvailability>;
  start(spec: RuntimeLaunchSpec): Promise<RuntimeSession>;
}

interface RuntimeSession {
  readonly info: RuntimeInfo;
  startRun(input: HostRunEnvelope): Promise<ExecutionHandle>;
  steer(runId: string, input: HostSteerInput): Promise<void>;
  cancel(runId: string): Promise<void>;
  stop(): Promise<void>;
}

interface ExecutionHostBridge {
  openModel(request: GuestModelRequest): AsyncIterable<HostModelEvent>;
  invokeCapability(request: GuestCapabilityRequest): Promise<HostCapabilityResult>;
  appendCheckpoint(checkpoint: GuestRunCheckpoint): Promise<HostCheckpointAck>;
}
```

`RuntimeAvailability` distinguishes missing engine, stopped machine, unsupported platform,
unsupported policy, and operational failure. `RuntimeInfo` reports the host/runtime platforms,
engine version, immutable image identity, effective limits, grants, and lifecycle state.

`RuntimeLaunchSpec` is an immutable, host-resolved value binding owner, project, workspace, runtime
instance, image, configuration/extension revisions, and grants. The guest cannot replace it.
Changing a grant requires a new host review and runtime generation; editing repository settings
cannot widen the current grant or choose arbitrary engine arguments.

`HostRunEnvelope` contains only the bounded prompt/context, selected agent definition, selected model,
tool schemas and opaque state revisions needed for that run. It contains no host path, secret,
credential, durable store, reusable approval, allowance or policy document. Effective resource and
network policy is applied by the host to the engine, outside the guest. The host owns the canonical
run handle and accepts guest events only for the bound generation and run.

### 4.3 Selection and defaults

Native remains the default when no `runtime` settings block selects a container. Selecting a
container without an available, conforming engine fails with an actionable error and never falls
back to native. The same host-owned placement applies to interactive and print launches; print mode
requires every interaction it may need to have a non-interactive disposition.

The proposed operator-owned settings shape is:

```json
{
  "runtime": {
    "backend": "docker",
    "image_digest": "sha256:<64 lowercase hex characters>",
    "limits": {
      "cpu_count": 2,
      "memory_bytes": 2147483648,
      "process_count": 256,
      "output_bytes": 4194304,
      "storage_bytes": 1073741824
    },
    "executable": "/absolute/path/to/docker",
    "connection": "colima"
  }
}
```

The omitted `network` field is parsed as `outbound`. This is ordinary routable Docker bridge or
Podman slirp access and may reach host/LAN services; it is not the proposed public-only `internet`
mode. Set `network` to `none` for an offline guest. The current adapters refuse `internet` because
they do not yet enforce its stricter destination exclusions.

This proposed setting belongs only to the host's global configuration. Workspace settings,
plugins, guest messages, and run requests cannot choose the engine, add engine arguments, or widen
launch policy, even after workspace trust approval. The host resolves the image, machine
connection, numeric limits, and service grants and shows the effective launch plan before the first
grant is admitted. Persisted grants are scoped to the canonical workspace and policy revision;
compatible later launches may reuse them without repeating review. A configuration preference is
not itself a credential or broader filesystem grant.

The implementation exposes both `docker` and `podman` explicitly. Docker is the operational default
CLI for image construction, while runtime placement always uses the exact configured backend,
executable and connection. Automatic engine selection remains absent; Clarvis does not silently
switch engines when their guarantees or availability differ.

The UI explains any unavailable requested mode. Effective `outbound`, whether explicit or defaulted,
is the broader ordinary route and is never mislabeled as repaired `internet` enforcement. Native
launch performs no engine probe, VM start, image download, or runtime directory provisioning.

## 5. Host authority and communication

### 5.1 Transport

Keep the existing `KernelClient` vocabulary between the TUI and host. Define a separate, private
execution protocol between the host and guest. Start with attached stdin/stdout without a PTY;
stderr carries bounded diagnostics. A guest startup banner or tool output must never enter stdout's
protocol frames. No public TCP port is required.

The host-to-guest method family is closed to bootstrap, start, steer, cancel and shutdown. The
guest-to-host method family is closed to model requests, declared host-capability calls, run events
and checkpoints. It is not a generic filesystem, command, `KernelClient`, or service-discovery RPC.
Existing framed-transport patterns may be reused after defining their owning session semantics.
Do not assume `notify()` implements reverse RPC, or rely on passing additional
file descriptors through every engine: Podman's remote client does not support `--preserve-fds`.
[Podman run](https://docs.podman.io/en/latest/markdown/podman-run.1.html).

Both directions validate method, envelope, payload, request identity, sizes, and queue bounds.
Retain cancellation, result-versus-stream-end ordering, and backpressure semantics. No mutation is
automatically replayed after a disconnect. A retryable broker mutation needs a scoped idempotency
contract; reconnecting a stream is not permission to repeat it.

Every message is bound to the runtime generation and, when applicable, the run and tool-call ID.
The host admits only methods present in the immutable run envelope. A compromised guest dispatcher
therefore cannot obtain another host method by forging a tool definition or changing its local
registry.

### 5.2 Credentials and authenticated services

Renewable provider credentials, host SSH/Git credentials, engine credentials, and global OAuth
stores remain on the host. Do not mount the global Clarvis directory or forward the host environment.
An arbitrary package script inside a writable runtime must be treated as able to read guest
credentials and tamper with guest processes. Read-only mounts do not provide secret confidentiality.

The model broker performs authenticated requests on the host and streams responses to the guest's
provider adapter. It binds allowed provider/model operations, fixed destinations, concurrency,
bounded input/output, spending reservations, expiry, and cancellation to a host-owned lease.
Refresh and device login remain host-owned. Provider headers and tokens never enter guest settings,
guest logs, the model prompt, or the public KernelClient DTOs. An unrestricted authenticated fetch
proxy is forbidden. Destination checks also apply after redirects and DNS resolution.

For each LLM call, the container sends only a logical provider scheme, selected model, opaque
request/conversation identities and the inference body over the private runtime RPC. The host checks
that request against its private lease, obtains the API key or Subscription credential, chooses the
fixed endpoint and authenticated headers, performs the HTTPS exchange and streams back bounded,
sanitized response events. The credential, cookie, refresh state, authenticated headers, spending
lease and grant-policy object never enter the container through files, mounts, environment, logs or
RPC. Agent prompts, model identifiers and local tool availability are execution inputs, not copies
of the host authority policy; the guest cannot turn them into broader host access.

Host-observed provider usage and grant decisions are authoritative for external spending and
authorization. Guest-reported usage, completion, tests, and traces remain execution reports, not
proof that the guest respected a limit or an approval.

Public package installs need no host credential. Private registries, authenticated Git, and remote
MCP each require an explicit service grant and purpose-specific broker, or a separately disclosed
limited guest credential. Limited credential injection is outside the first strict profile.
Unsupported authenticated integrations report unavailable instead of inheriting the user's keys.

A broker grant conveys real authority: an agent can spend its model allowance or invoke granted
integration operations without learning the underlying secret. Revocation must take effect at the
host even if the guest ignores cancellation.

### 5.3 Configuration, extensions, and approvals

The TUI's `KernelClient` facade terminates on the host. Every public service remains host-owned,
including files used by the TUI, sessions, traces, memory, plans, tasks, workflows, skills, config,
provider login, secrets and grant decisions. Starting or controlling a run may delegate execution
to the guest, but service authority and durable results do not move with it.

The agent receives schemas for the host capabilities granted to the run. Calling one sends the
validated arguments to the owning host service. The host checks the generation, run, call identity,
declared method, argument schema, revision, cancellation state and any idempotency requirement before
executing it. Memory, plan, task and workflow paths and stores never cross the boundary. The same
rule applies to future host capabilities: adding a tool schema does not grant a general host API.

Project config and selected global definitions are materialized as a sanitized runtime snapshot.
Provision selected plugin/skill contents and their exact identities, not the host's entire plugin
inventory. Host executable paths must be resolved to guest-compatible declarations or rejected.
Workspace trust and Extension Profile fingerprint rules still apply. Changes to trusted host config
require the host's revision-bound operations; mutable guest copies cannot approve themselves.

Host-affecting decisions bind the exact action, workspace/runtime generation, grant revision,
request id, expiry, and one-time consumption. Only host UI responses or pre-existing host policy
can authorize them. A guest's `approved: true` field has no authority.

Existing guards remain useful for normal tool mistakes. If the guest can modify its own kernel,
those guards are not a security boundary against that guest. The accepted container mode has no
live workspace mount. A guest can still damage its temporary copy, so host change validation and
application remain security boundaries.

## 6. Workspace, identity, and durable state

### 6.1 Host-prepared isolated workspace

The host creates a standalone temporary working copy with private Git metadata and mounts only that
copy at guest `/workspace`. The real checkout and its parent are never mounted into the container,
including read-only. The copy is stored outside the container layer under a host-owned runtime path,
so replacing the container does not delete the work in progress.

Capture the user's actual starting files, including dirty tracked changes and explicitly included
untracked files. Do not replace that state with a clean `HEAD` checkout. The host records a private
baseline manifest containing path, type, mode and content revisions. Exclusions, submodules, Git LFS
materialization, symlinks, nested mounts and special files require defined capture behavior. Unsafe
or unsupported entries refuse capture instead of silently broadening the mount.

Use independent objects or a portable bundle when constructing Git history; do not retain writable
shared metadata, filesystem hardlinks, or object-store alternates back to the source repository.
Git remotes and credential helpers are removed or replaced with explicitly brokered operations.

Clarvis-owned control content is not ordinary source input. Workspace plan and memory stores,
machine state and any host authority files are reserved from direct guest access even when their
current backing path is below `.clarvis`. The host may materialize a bounded, immutable agent,
skill, prompt or configuration snapshot required for execution, but that snapshot is neither the
canonical store nor an approval source.

### 6.2 Change review and application

The guest works freely inside the isolated copy. The host records a pre-run copy revision and scans
the copy after guest execution completes, fails, is cancelled or is interrupted; it does not trust
the guest to report whether files changed. If that run changed any eligible workspace file and the
copy can be scanned safely, the host derives the complete accumulated change set relative to the
last applied baseline. It validates relative paths, regular-file payloads, symlink targets, modes,
additions/deletions, binary content, hardlinks and size limits before exposing a review. Git
metadata and Clarvis control/state paths are never source-change payloads. A scan or validation
failure writes nothing to the real checkout, retains the copy and reports a typed host error.

Every modifying run raises one host-owned elicitation with kind `workspace_merge` before the public
run completes. Its prompt asks whether Clarvis may merge all reviewed guest-workspace changes into
the real host workspace. The review shows every eligible addition, modification and deletion and is
bound to a host-owned change-set ID, baseline revision and content digest. “All” means the entire
validated source change set currently pending in the copy; it never includes container layers,
installed tools, caches, Git metadata or Clarvis state.

The elicitation is created, persisted and resolved by the host through the existing `RunHandle`
interaction. The guest cannot create an authoritative merge request, accept it or learn reusable
approval data. While it is pending, the agent execution may already be stopped and the container may
be replaced; the run remains open in a host phase equivalent to `awaiting_workspace_merge`. A TUI
disconnect preserves the pending elicitation and presents it again on resume.

Implementation adds a typed workspace-change detail to `ElicitationRequest`; clients must not parse
the human prompt. The detail identifies the opaque change set, baseline and digest and lets the TUI
inspect the complete host-held file/diff review before enabling `accept`. The normal
`ElicitationResponse` actions remain sufficient.

- `accept` revalidates the exact reviewed set and applies all of it as one recoverable host
  transaction. After success, the host advances the copy baseline, records the applied result and
  completes the run.
- `decline` writes nothing to the real checkout and retains the copy and change set as pending host
  runtime data, then completes the run with a declined-application outcome. A later modifying run
  reviews the complete accumulated unmerged set again.
- `cancel` marks the run cancelled without applying and also retains the pending copy. Discard is a
  separate explicit retention action outside the elicitation.

A run that made no new eligible workspace change raises no merge elicitation. It may complete even
when an older declined change set remains pending. No mode silently applies changes or interprets
successful agent execution as host-write approval.

Applying a file requires its current host base revision to match the captured baseline. A concurrent
host edit produces a conflict and preserves both versions. Multi-file application uses a recoverable
host transaction with an explicit result; it never performs a preview followed by blind writes.
The apply path does not execute repository hooks, filters, credential helpers or exported scripts on
the host. Review binds exact content hashes and expires when either input changes. If revalidation
fails after `accept`, no unreviewed content is applied; the host records the conflict, retains the
copy and change set, and completes the elicitation with a typed application failure.

“Merge” is the product wording for applying this reviewed tree delta. It does not run `git merge`,
create a commit or invoke repository code on the host.

### 6.3 Host state, checkpoints, and recreation

The host assigns stable owner/project/workspace identities before path translation. `/workspace`
is a guest location, not a global identity. Runtime instance IDs change on recreation; logical
workspace IDs do not. Bind every broker request, volume, and client connection to those identities.

Keep three lifetimes separate:

| Content                                                        | Placement and lifetime                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Config, credentials, grants, sessions, traces, memory, plans, tasks, workflows and runtime records | Existing host-owned Clarvis paths and stores; never guest-mounted or guest-writable |
| Baseline, temporary workspace copy, change journal and pending change set | Host runtime storage; survives container replacement until explicit retention       |
| Package caches, installed tools, scratch, processes and writable image layer | Guest-local and disposable; reuse is an optimization only                            |

With the default path vocabulary, `~/.clarvis/state/sessions`, `~/.clarvis/state/traces` and
workflow/runtime machinery remain on the host. Memory and plan documents and machinery retain their
existing host-owned `@clarvis/paths` locations even when authored content lives below the selected
checkout. Tasks remain behind their host provider. None of these directories is copied or mounted
as a guest state surface; the agent sees only selected values and tools over the bridge.

The host persists accepted run events and checkpoints throughout execution. A terminal run state is
not published to the TUI as `done`, `failed` or `cancelled` until the host has atomically committed
and synced the corresponding session, trace and capability-owned workflow/task state, persisted any
required workspace-merge elicitation and its resolution, and acknowledged the terminal checkpoint.
The guest cannot mark its own report durable.

After a transport or container failure, the host records the run as interrupted at the last accepted
checkpoint. A replacement guest receives a fresh bounded run envelope reconstructed from host state
and the retained workspace copy. The host does not replay an unacknowledged mutating tool call unless
that tool has an explicit idempotency contract. Process state, global installs and guest caches are
not reconstructed.

There is no durable engine-managed Clarvis state volume and no guest `CLARVIS_HOME` containing
sessions, traces, memory, plans, tasks or workflows. Do not silently share writable executable caches
across workspaces. Stopping, resetting, or deleting a container never deletes host Clarvis state or
an unapplied workspace copy. Existing explicit retention paths remain owners of durable deletion.
New pre-release formats need no legacy migration readers.

## 7. Container policy and Podman adaptation

### 7.1 Required isolation posture

Require rootless engine execution for the initial profile. Container UID 0 may install packages
inside the user namespace; it is not permission to run a privileged container. Validate mapping and
workspace write ownership together. The proposal does not promise every system package works.

The effective launch must have:

- private process, mount, IPC, and network boundaries; no host namespace sharing;
- no privileged mode, engine socket, SSH-agent socket, host device, or undeclared host mount;
- an explicit reduced capability set, seccomp policy, and supported host MAC enforcement;
- bounded CPU, memory, process count, scratch, output, and retained logs;
- finite writable-layer/cache storage limits where enforceable, with unsupported limits reported;
- only the declared guest environment and immutable launch configuration.

Image/user defaults and ambient engine settings must not silently add mounts, networking, devices,
hooks, proxy credentials, or services. The adapter selects a fixed executable and explicit local
connection through argv, scrubs routing overrides from its environment, and inspects effective
configuration before starting the guest. Creation precedes start so admission cannot occur after
untrusted code has already executed. This protects against unintended configuration drift; a
malicious host engine or administrator remains outside the threat model.

Policy capability support is measured by canaries, not inferred from the engine name or a successful
`podman --version`. Exact engine/VM/runtime versions and policy revisions are part of evidence.

### 7.2 Fedora/Linux and macOS details

Rootless bind mounts require a tested UID/GID strategy. Apply it only to Clarvis-owned temporary
runtime storage. Do not run recursive `chown`, Podman's `:U`, or SELinux relabeling against the
user's checkout. A compatible host-prepared copy must resolve ownership and labeling before launch.
[Podman volume and security options](https://docs.podman.io/en/latest/markdown/podman-run.1.html).

On macOS, pin an explicitly selected Podman machine connection. The strict profile requires reviewed
VM shares limited to designated Clarvis runtime storage containing the temporary copy, not the real
checkout or an implicit home-directory share. Inspect the machine configuration and engine rootless mode. Prefer a dedicated opted-in
machine when a shared machine cannot meet that posture; do not reset or reconfigure another
application's machine. VM creation, downloads, autostart, and host setup are separate operator actions.
[Machine initialization and shares](https://docs.podman.io/en/latest/markdown/podman-machine-init.1.html).

Windows keeps native application compatibility and receives an explicit unavailable status until
its CLI, VM paths, process lifecycle, and isolation canaries pass. Linux execution in WSL/Podman
machine is not evidence for native Windows execution. Engine adapters use argv and named platform
predicates rather than POSIX shell interpolation.

### 7.3 Image and installation contract

Build a headless runtime image from a reviewed Containerfile and the released standalone carrier.
The production Containerfile consumes only the canonical carrier digest; current source enters only
the distinct development carrier and then follows the same final composition. Pin the Debian slim
base by digest, the Clarvis artifact identity, the repository's Bun version, and guest architecture.
Resolve tags to an immutable identity before launch; a runtime record never identifies its image
only as `latest`.

The accepted baseline includes Git, CA certificates and a fixed mise binary, not Bun/Node, Python,
Rust or build utilities as separately callable tools. Mise's amd64 and arm64 archives are selected by
architecture and verified against source-owned SHA-256 values before its binary and license cross
into the final stage. A shell-capable agent uses
`mise x <tool>@<version> -- <command>` to install exact toolchains under the executable `/mise`
tmpfs. That scratch is private to the runtime, bounded by the engine launch, absent from the retained
workspace, and discarded at stop. `/tmp` remains a distinct non-executable scratch mount. A
read-only guest root is not advertised as supporting `apt` or unrestricted system-package
installation.

The live baseline canary covers mise installing Node 24.20.0 and that Node running a public npm
install. Pip, Cargo, source compilation and arbitrary mise backends remain tool-specific behavior,
not implied support. Reusable heavier images require the same explicit review and promotion as any
other runtime artifact.

Image construction runs without workspace/credential mounts. Project build instructions remain
untrusted guest work. Reusable custom images require explicit promotion; do not automatically commit
an active container that may contain project data or credentials. Local builds are sufficient;
registry publication and release infrastructure require a separate product decision.

## 8. Network and host-service grants

Separate guest tool networking from host-brokered model access. The `none` guest network policy can
still permit an explicitly granted model service over stdio.

| Proposed network mode | Contract                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `none`                | Guest tools have no external network path                                                                          |
| `internet`            | Public outbound traffic; deny host, VM services, private/LAN, link-local/metadata, and ungranted peer destinations |
| `outbound`            | Ordinary routable outbound access, which may reach host/LAN services; explicit broader grant                       |

`internet` remains the stricter proposed public-only profile. It requires policy outside the mutable
guest. Default NAT, a rootless networking helper, and removal of a hostname alias do not establish
this contract. The adapter must account for IPv4/IPv6, direct IPs, DNS rebinding/redirects, host
public addresses, local routing, and alternative routes. DNS is a bounded resolver service, not
unrestricted access to its private network.
[Container networking](https://docs.docker.com/engine/network/).

The enforcement mechanism is an implementation spike and a release blocker for `internet`. A
controlled egress gateway or user-space network broker may satisfy it if the guest has no alternate
path. A proxy environment variable alone cannot. The implemented product decision defaults an
omitted container network to `outbound` so registry and toolchain installation work without extra
configuration. This is deliberately the broader ordinary route: use `none` for offline execution,
never label `outbound` as internet-only, and treat it as able to transmit readable workspace content
or reach host/LAN services.

No host port is published by default. The implemented `runtime.preview` v1 grant accepts only a
guest TCP port and display scheme. Its guest `expose_port` tool is available only with
`run_commands`; the host probes through a fixed runtime executable, binds `127.0.0.1`, prefers the
same port with an ephemeral fallback, relays raw TCP through fixed engine argv, and expires every
listener with the runtime. It does not expose the engine API or let the guest choose the host
address, host port, executable or engine arguments. Reaching a host database or authenticated
service still needs its own destination/operation grant. Generic host shell, filesystem RPC, and raw
authenticated request forwarding remain outside the broker.

The existing `host_vcs` fallback must be unavailable as a host escape in container mode. A future
host Git capability must specify bounded operations and enforce its approvals in the host broker.
The guest cannot request arbitrary engine flags or create a container through the supervisor.

## 9. Lifecycle, failure handling, and TUI behavior

```text
unavailable / stopped
        -> inspecting -> preparing -> starting -> ready
                                              -> failed
ready -> stopping -> stopped
ready -> disconnected -> failed / stopped
```

Preparation resolves grants, image, workspace identity, volumes, and policy. The first model call
waits for wire negotiation and effective-policy validation. Cancellation during preparation unwinds
only resources created by that attempt and preserves user data. Pin runtime selection until close;
switching to native or another engine requires an explicit new launch.

The host may keep a healthy container across turns so installed tools remain available, but this is
only a cache optimization. Correctness assumes the container can disappear after any checkpoint.
Run cancellation stops the run's process tree and monitors according to their contract. Closing the
runtime revokes broker leases first, requests graceful shutdown, then uses bounded engine stop/kill
if needed. Stop is idempotent and distinct from deleting volumes or unapplied work.

Transport loss fails live handles and prevents new privileged requests. The existing kernel cancels
connection-owned runs, but that is cooperative guest behavior. Killing an attached CLI does not
prove the container stopped. Strict orphan termination requires an external lease monitor outside
the writable guest, with a bounded expiry and engine-level cleanup. Its placement and lifetime must
be validated before claiming cleanup after host-supervisor failure. An in-guest heartbeat is not
sufficient enforcement against a compromised guest.

A future generation-bound supervision fence uses monotonic renewal deadlines and checks every
authority dispatch independently of idle timers. Launch requires an armed monitor outside the
guest before the host exposes any authority. Monitoring continues until the engine confirms the
container is absent. Transient engine outages retain revoked authority and a cleanup-pending record;
they never count as successful cleanup. Parent death, simultaneous host/monitor loss, VM restart,
and a container that ignores graceful termination are required acceptance scenarios.

On next launch, reconcile only recorded Clarvis-owned IDs against the host registry and engine
inspection. Labels alone do not authorize deletion. Preserve stopped instances with unknown state
and host-owned unapplied copies. Never use global engine prune, delete unrelated containers, or stop
a shared VM as cleanup. A temporarily unavailable engine leaves resources pending cleanup with an
explicit status; it does not make deletion or successful shutdown true.

The TUI displays native/container placement, guest OS, engine, workspace mode, effective network
grant, and startup failure. It remains responsive while the image or VM starts. Existing `!` commands
remain user-requested host commands and must be visibly labeled as host execution in container mode;
they cannot be generated or dispatched by guest protocol events. A future guest terminal is a
separate explicit interaction. Browser opening and attachments use bounded host adapters.

Runtime reset removes only the selected container generation and warns that installed guest tools,
processes and caches are discarded. Host sessions, traces, plans, memory, tasks, workflows and the
temporary workspace copy remain until their separate retention or change-review action. Session
resume reconstructs conversation context from host state and remounts the retained copy, but it does
not recreate a live process, guarantee restored tool installations, or automatically retry an
interrupted mutation.

When a run changes the isolated workspace, the TUI shows the host-generated `workspace_merge`
elicitation after agent execution and before terminal completion. It must provide an inspectable
all-file review and the `accept`, `decline` and `cancel` outcomes above. This interaction never
depends on the guest remaining alive.

## 10. Required invariants and acceptance evidence

The source contract and deterministic coverage are implemented in
[`isolated-agent-runtime.md`](../hosts/isolated-agent-runtime.md). The scenarios below remain the
required live acceptance matrix. A source or synthetic test proves its bounded contract, but does
not replace an engine, PTY, platform, network or process-loss canary named in this table.

| ID    | Invariant                                       | Required test                                                                                                                             |
| ----- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| IR-01 | No silent native fallback                       | Missing engine, failed VM, image mismatch, unsupported policy, and handshake mismatch execute no host agent work                          |
| IR-02 | External authority is host-owned                | A guest forges approvals, edits config, reuses expired grants, and changes runtime IDs; all requests are denied                           |
| IR-03 | No ambient credential/engine exposure           | Guest scripts inspect env, mounts, processes, files, and sockets; host canary secrets and engine control remain unavailable               |
| IR-04 | Whole agent execution graph resides in the guest | Loop, subagent, file/shell/Git, hook, local MCP and execution-local capability each demonstrate guest-only markers                         |
| IR-05 | Guest receives only the temporary copy          | Real checkout, siblings, home, host temp, state, devices and sockets remain absent; exercise links, nested mounts and path replacement     |
| IR-06 | Identity survives path translation              | Two copies both mounted at `/workspace` retain separate host histories, state and grants across recreation                               |
| IR-07 | Network modes mean what they say                | Real public success plus host/LAN/metadata/peer denial, IPv4/IPv6 and DNS cases; unsupported enforcement refuses launch                   |
| IR-08 | Resource limits and cleanup are external        | Controlled memory/process/output/storage stress and killed TUI/supervisor; no host exhaustion or surviving expired runtime                |
| IR-09 | Host state survives guest loss                  | Kill the guest after checkpoints and at terminal settlement; host sessions, traces, plans, memory, tasks, workflows and copy reconstruct it |
| IR-10 | Stream failures cannot authorize or replay      | Malformed/oversized frames, saturation, early EOF, late results, cancellation and reconnect retain existing ordering and denial semantics |
| IR-11 | Host checkout is never a guest mount             | Inspect effective engine mounts and VM shares; no launch path can select the real checkout or host Clarvis state                           |
| IR-12 | Change application preserves user edits         | Dirty/untracked baseline, control-path exclusion, concurrent host edit, binaries, deletes, executable bits, symlink escape and interrupted apply |
| IR-13 | UI placement and lifecycle are truthful         | Real PTY startup, host `!` labeling, grant dialog, provider login, cancellation, crash, reset, and resume                                 |
| IR-14 | Images and caches cannot cross authority scopes | Pinned artifact handshake, rejected ungranted mounts, no automatic image promotion or mutable cross-workspace executable cache            |
| IR-15 | Public services remain host-owned               | Guest cannot open host paths/stores; memory, plan, task and workflow access succeeds only through exact declared capability methods        |
| IR-16 | Terminal state requires host durability         | Drop the guest before/during/after terminal checkpoint; TUI never observes completion before synced host persistence                       |
| IR-17 | Every modifying run asks before host apply       | Detect writes independently of guest reports; exactly one all-change elicitation, none for unchanged runs, accept/decline/cancel, resume and stale-host conflict |

Use unit/contract tests for pure launch policy, codec, identity, and state-machine behavior. Use
integration tests for actual engine effects. Use synthetic credentials and controlled fixture
services for denial tests; do not inspect a user's real secrets. Package-install canaries explicitly
separate local package execution from external registry availability.

Acceptance reports name source revision, image digest, Bun/engine/OCI runtime versions, host and
guest OS/architecture, VM provider where applicable, and effective policy. Linux canaries cannot
prove macOS bind-mount behavior. A test skipped because a machine is absent remains unverified.

Real TUI work follows [TUI E2E validation](../../.agents/skills/clarvis-tui-e2e-validation/SKILL.md)
and [performance validation](../../.agents/skills/clarvis-performance-validation/SKILL.md), with a
current artifact and the boot smoke when boot behavior changes. Measure input readiness, kernel
readiness, first streamed response, warm launch, cold image/VM launch, dependency I/O, and total
host-plus-VM memory separately. Native startup must not pay container discovery/import costs.

## 11. Historical implementation sequence and decisions that required evidence

1. **Process boundary:** the public `KernelClient` and canonical stores remain on the host; the
   implementation adds only the narrow execution session and bridge. It does not create a guest
   state dependency or a second public kernel.
2. **Host-owned workspace copy:** the implementation captures dirty and untracked starting state,
   creates private Git metadata, excludes Clarvis control paths, persists the baseline, mounts only
   the temporary copy, and performs independent per-run review and transactional apply.
3. **Durable run bridge:** guest records and checkpoints cross into host stores before the terminal
   settlement barrier. Reconstruction never authorizes mutation replay.
4. **Host authority boundary:** model access, host-only elicitation, loopback preview, canonical Plans
   operations and read-only admitted Skills disclosure use exact, generation-bound leases. The guest
   applies the same command guard from stripped settings and the host validates and identity-rebinds
   its closed audit events. Memory, Tasks, Workflows, plugin bootstrap skills and executable skill
   roots remain unavailable unless a later iteration adds their purpose-specific method and guest
   adapter.
5. **OCI engine adapters and artifact boundary:** Docker is the default local adapter and passed the
   bounded Colima canary plus a current-source real-PTY TUI run through a real ChatGPT subscription;
   Podman implements the parallel rootless contract but remains live-unproven.
   Production images consume only the released standalone carrier by digest, while development has
   an explicit source-carrier path that feeds the same final Containerfile.
6. **Supported isolated profile:** `none` and the broader `outbound` modes are admitted; omission
   defaults to `outbound`. The minimal image bootstraps exact toolchains through mise, and a
   shell-capable agent may expose a service only through the bounded host-loopback broker.
   Internet-only enforcement, an external orphan monitor, measured storage enforcement, native
   Linux, Docker Desktop, Podman Machine and Windows qualification remain unavailable, so the
   implementation makes no corresponding support claim.

The original implementation order was:

1. **Introduce the process boundary:** keep the public `KernelClient`, all canonical stores and
   capability coordination on the host. Add only the narrow execution session and bridge. Do not
   create a guest-state dependency or a second public kernel.
2. **Host-owned workspace copy:** capture dirty/untracked starting state, create private Git metadata,
   exclude Clarvis control paths, persist the baseline and mount only the temporary copy. Add
   independent per-run change detection, the mandatory all-change elicitation and conflict-aware
   apply/pending/discard behavior before enabling successful container admission.
3. **Durable run bridge:** persist events and checkpoints on the host, add the terminal settlement
   barrier and prove reconstruction after process/container loss without replaying mutations.
4. **Host capability boundary:** broker model access and exact memory/plan/task/workflow methods;
   prove that forged methods, paths, revisions, identities and approvals are denied before real
   account access is admitted.
5. **Podman prototype:** exercise one rootless Linux engine with a locally built image, the isolated
   copy, `none` or explicitly granted `outbound` networking, install/reset/recreation canaries and
   real TUI operation. Mark stricter network/cleanup guarantees unavailable until proven.
6. **Supported isolated profile:** finish internet-only enforcement, resource/storage policy and
   external orphan cleanup; qualify macOS Podman machine, limited runtime shares, architecture and
   I/O. Run Docker against the same adapter conformance suite when retained as a backend.

Docker is the operational default because its Colima path is the engine integration proven in this
iteration; that is not a cross-platform benchmark. Outstanding implementation decisions are the
minimum supported versions, exact UID/capability/MAC recipe, network enforcement mechanism,
externally enforced storage limits, external lease-monitor placement, macOS Podman machine sharing
recipe, compressed registry size, and numeric performance/resource defaults. The local Docker image
was measured at 137,470,980 bytes, but that does not establish registry transfer size or another
architecture. Each remaining claim needs measured evidence before support is stated. None permits
silently weakening the contract.

Remote runtime hosting, generic host command execution, private package credential injection,
cross-agent container isolation, background execution after TUI exit, and automatic runtime-image
pull/upgrade are outside the first implementation scope. Tag-triggered immutable GHCR publication is
implemented as a release gate but remains externally unverified until an authorized release runs.

## 12. Documentation disposition

The implemented behavior is owned by
[`specs/hosts/isolated-agent-runtime.md`](../hosts/isolated-agent-runtime.md), indexed from the spec
router and cited by the affected package READMEs. This proposal remains the architecture decision
record and live acceptance matrix; it is not the operational source of truth.

Updated owner READMEs: [kernel](../../packages/kernel/README.md),
[protocol](../../packages/protocol/README.md), [code](../../packages/code/README.md),
[paths](../../packages/paths/README.md). Reviewed without change:
[loop](../../packages/loop/README.md), [tools](../../packages/tools/README.md), and
[server](../../packages/server/README.md), because the standalone dependency composition preserves
the Loop and tools public/runtime behavior and the server's MCP-over-HTTP facade is not the private
execution transport.

Reviewed contracts: [spec index](../README.md), [known issues](../known-issues.md),
[protocol](../hosts/protocol.md), [kernel transport](../hosts/kernel-transport.md),
[kernel composition](../hosts/kernel-composition.md), [Code bootstrap](../hosts/code-bootstrap.md),
[subscriptions](../hosts/subscription-providers.md), [sandbox](../execution/sandbox.md),
[tools](../execution/tools-contract.md), [command guard](../execution/command-guard.md),
[security](../cross-cutting/security.md), [paths](../foundations/paths.md),
[sessions](../hosts/sessions.md), [storage](../hosts/storage.md),
[package architecture](../cross-cutting/package-architecture.md), and
[build/CI](../cross-cutting/build-and-ci.md), and
[distribution](../cross-cutting/distribution-and-updates.md).

No package or dependency edge changed, so generated graph facts remain unchanged. External EN/PT
public guides in `getclarvis/docs` remain unchanged. The current macOS/Colima TUI/subscription canary
now qualifies that one bounded journey, but the external repository still needs a separately
reviewed update before publication covering setup, grants, credentials, networking, lifecycle,
recovery and the explicitly unqualified platforms and capability surfaces.
