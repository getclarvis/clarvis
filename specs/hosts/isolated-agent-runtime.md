# Isolated agent runtime

## 1. Scope and security promise

Docker and Podman are explicit **Container** placements. They execute a deliberately smaller Clarvis
runtime: the loop and builtin core tools run in a Linux guest, while model calls are mediated by the
host. Container is not a second form of native Sandbox and does not compose the host's extension or
product-capability graph.

The security promise is integrity of the host outside the selected workspace. The selected workspace
is the operator-chosen mutation domain and remains read-write. Outbound network access, when enabled,
can observe and cause remote effects and can exfiltrate readable workspace content. Container does
not protect the workspace from destructive commands.

Production: `packages/kernel/src/runtime/container-core-policy.ts` (`ContainerCorePolicy`),
`packages/kernel/src/runs/prepare-run.ts` (`admitContainerCoreRun`), and
`packages/kernel/src/runtime/local-container-runtime.ts` (`createLocalContainerRuntime`). Test:
`packages/kernel/tests/unit/container-core-policy.test.ts`,
`packages/kernel/tests/unit/container-core-policy.test.ts`, and
`packages/code/tests/unit/isolation.test.ts`.

## 2. Closed core policy

The host owns one non-extensible policy description:

```ts
interface ContainerCorePolicy {
  readonly revision: 1;
  readonly toolPolicy: RuntimeToolPolicy;
  readonly network: "none" | "outbound";
  readonly gitMetadata: "absent" | "read-only";
  readonly commandReview: "off";
  readonly hostFeatures: "none";
}
```

`hostFeatures: "none"` is an enumeration, not an omitted list which an older client could widen.
`internet` remains accepted by the settings DTO only so unsupported-policy admission can explain the
refusal; it never becomes an admitted policy. `none` and `outbound` remain an independent network
axis.

The three method vocabularies are distinct and exact:

| Direction/purpose | Exact methods |
| --- | --- |
| Host lifecycle to guest | `runtime.bootstrap`, `runtime.start`, `runtime.steer`, `runtime.interrupt_tool`, `runtime.cancel`, `runtime.shutdown` |
| Guest execution to host | `host.model`, `host.capability`, `host.event`, `host.checkpoint` |
| Capability broker grants | `runtime.elicit` |

`runtime.elicit` backs intentional agent/operator dialogue such as `ask_user`. It is not Command
Review and carries only the bounded `ElicitParams` plus optional timeout. Model streaming is returned
through `host.model`; trace traffic uses `host.event`; checkpoints use `host.checkpoint`. None of
those are capability methods. `runtime.hook_mcp`, `runtime.mcp_elicit`, feature methods and
`host_vcs` do not exist.

Production: `packages/kernel/src/runtime/execution-rpc.ts` (`HOST_EXECUTION_METHODS`,
`GUEST_EXECUTION_METHODS`), `packages/kernel/src/runtime/container-core-policy.ts`
(`CONTAINER_CORE_CAPABILITY_METHODS`), and `packages/kernel/src/runtime/execution-worker.ts`
(`serveExecutionWorker`). Test: `packages/kernel/tests/contract/runtime-execution-rpc.test.ts`,
`packages/kernel/tests/integration/runtime-execution-worker.test.ts`, and
`packages/kernel/tests/unit/container-core-policy.test.ts`.

## 3. Admission before any work

`prepareKernelRun` captures settings, assembles the request/profile graph, resolves placement from
host-owned settings and then calls `admitContainerCoreRun`. This happens before Workflow/Goal
selection, run lease reservation, engine acquisition, bridge opening or model inference. Code hides
incompatible controls for usability, but every client reaches the same kernel admission.

The assembler uses `operator_merged` settings for Container so Plugin settings fragments never enter
the request. Admission then returns a strict copy with:

- `servers: []`;
- no `skill`, `task`, `plans`, `memory`, `guard_mode` or `guard_judge`;
- no Plugin seed, bootstrap, Hook, MCP server or capability executable;
- no host-backed Plans, Memory, Tasks, Workflows, Goal, configuration or preview;
- profiles limited to builtin core grants or compatible user/workspace profiles;
- no MCP tools and only `ask_user`, `read_workspace`, `edit_workspace`, `run_commands` grants.

`marshall`, `coder`, `explorer` and `planner` have an explicit host-owned Container projection which
removes their builtin `use_skills` grant while retaining compatible delegation. `admiral` is refused
because it depends on Workflow. A Plugin Agent is always refused. A user/workspace profile is not
silently rewritten: any MCP tool, `use_skills`, `workflow`, `tasks.*` or other non-core grant rejects
the request. Its complete `can_spawn`/`default_spawn` graph must also resolve to compatible profiles.
An unresolved `$name` remains ordinary text; an explicit `skill` parameter or a `$skill` which really
resolves is incompatible.

Explicit `task`, Plans, Memory, Workflow, Goal, `guard_mode: "on" | "auto"` or any `guard_judge`
returns `kernelError("unsupported", ...)` with closed details
`{ placement: "container", capability }` and the message:

```text
<Capability> is unavailable in Isolation Container. Use Isolation Sandbox or Host.
```

Host-wide registered capabilities and inherited settings which the request did not ask to use are
projected inactive rather than blocking Container. This distinction prevents registration of a new
native capability from widening or accidentally disabling Container. A custom `assembleRunRequest`
implementation still goes through conservative kernel validation.

Production: `packages/kernel/src/runs/prepare-run.ts` (`prepareKernelRun`,
`admitContainerCoreRun`), `packages/kernel/src/runs/settings-assembler.ts`
(`createSettingsRunAssembler`), and `packages/kernel/src/config/config-store.ts`
(`ConfigSnapshot.operator_merged`). Test:
`packages/kernel/tests/unit/container-core-policy.test.ts` and
`packages/kernel/tests/component/settings-assembler.test.ts`.

## 4. Host and guest composition

### 4.1 Host

The Container host composition creates only:

- an exact model lease and model broker;
- a capability broker containing only `runtime.elicit`;
- lifecycle/control channels;
- trace events, durable checkpoints and terminal settlement.

It does not iterate the generic host capability registry. It does not construct or invoke Hooks,
remote MCP, Hook MCP, Skills, Plans, Memory, Tasks, Workflows, Goal, configuration, effect review,
Command Review or preview adapters. No feature process or callback starts before, during or after a
Container run. Host/Sandbox retain their normal capability composition.

The guest receives synthetic provider routing records only. Those records contain a logical provider
name and a fixed non-routable broker placeholder needed by the loop's request validator; real
provider kind, endpoint, headers, options and credentials remain in the host model lease. The model
broker authorizes only provider/model pairs already present in the admitted request and bounds input,
output, concurrency and queueing.

Production: `packages/kernel/src/runtime/local-container-runtime.ts`
(`containerGuestRawBody`, `hostModelBroker`, `createLocalContainerRuntime`) and
`packages/kernel/src/runtime/authority-brokers.ts` (`createModelBroker`,
`createCapabilityBroker`). Test: `packages/kernel/tests/unit/local-docker-runtime.test.ts`,
`packages/kernel/tests/unit/runtime-authority-brokers.test.ts`, and
`packages/kernel/tests/integration/local-podman-runtime.test.ts`.

### 4.2 Guest

`GuestRunEnvelope` contains only `rawBody`, `modelLeaseId`, `toolPolicy`, `loopPolicy` and an optional
feature-free prior execution. Its validator rejects legacy `hostCapabilities`, `skillCatalog`,
`skillBootstraps`, `memory`, `hooks`, `workflow`, `goal`, `parentRunId` and `outputBudgets` fields.
The raw request is strict: empty MCP servers, compatible core profiles/tools/grants and synthetic
routing providers only.

`createGuestLoopExecutor` builds the loop with builtin core tools and no Skills, Hooks, Tasks, Plans,
Memory, Workflow, Goal or MCP connection manager. It sets `allowHostEscalation: false`, so
`sandbox_permissions: "require_escalated"` returns a denied tool result without elicitation or a host
process. There is no host shell, arbitrary argv/path/endpoint broker or placement fallback.

Production: `packages/kernel/src/runtime/guest-loop-executor.ts` (`GuestRunEnvelope`,
`createGuestLoopExecutor`) and `packages/loop/src/runtime/capabilities/tools.ts`
(`createAgentToolsCapability`). Test: `packages/kernel/tests/integration/runtime-guest-loop.test.ts` and
`packages/kernel/tests/integration/local-docker-runtime.e2e.test.ts`.

## 5. Private protocol and image identity

The runtime protocol revision is **14**. Bootstrap has an exact shape: generation, immutable image
digest, protocol revision and the exact capability-method tuple `runtime.elicit`. Unknown bootstrap
fields, an old revision, a different digest/generation or a widened capability list fail the
handshake. Docker and Podman require the matching image label before attachment.

The production and development Containerfiles and `tooling/runtime/build-image.ts` carry the same
revision. Runtime images remain qualified by immutable image ID; tags are resolved before admission.
The guest does not negotiate optional features.

Production: `packages/kernel/src/runtime/protocol-revision.ts`,
`packages/kernel/src/runtime/execution-worker.ts`, `tooling/runtime/build-image.ts`,
`Containerfile.runtime`, and `Containerfile.runtime-development`. Test:
`packages/kernel/tests/integration/runtime-execution-worker.test.ts`,
`packages/kernel/tests/unit/runtime-docker-backend.test.ts`, and
`packages/kernel/tests/unit/runtime-podman-backend.test.ts`.

## 6. Filesystem boundary

### 6.1 Workspace and control roots

The selected canonical workspace is the only host bind mounted read-write and appears at
`/workspace`. Before engine creation the host creates three empty directories under a private
host-temporary root. Two are mounted read-only over the complete workspace `.clarvis` and `.agents`
roots, making every known or future child opaque. No synthetic Markdown or policy guidance is placed
in a mask.

Every workspace-relative target and ancestor is checked with `lstat`; a symlink, non-directory
control root or private source under the selected workspace rejects Container. Current OCI engines
materialize an absent nested target in the parent host bind, so both control roots must already exist
as directories; otherwise the backend refuses before container creation and leaves the workspace
unchanged. The private mask root is removed after launch failure or runtime teardown; there is no
writable degradation.

`RuntimeLaunchSpec.controlRootMasks` has exactly two typed descriptors in fixed order. Each contains
canonical `source`, exact guest `target`, `type: "directory"` and `readOnly: true`. Additional,
missing, reordered, writable or workspace-backed masks fail launch validation or effective inspect.

Production: `packages/paths/src/workspace.ts` (`workspacePaths`, `agentsWorkspaceDir`),
`packages/kernel/src/runtime/local-container-runtime.ts` (`inspectReservedWorkspacePath`,
`prepareRuntimeMounts`), `packages/kernel/src/runtime/container-policy.ts`
(`assertMaterializedProtectedTargets`), and `packages/kernel/src/runtime/launch-policy.ts`
(`assertRuntimeLaunchSpec`). Test: `packages/kernel/tests/unit/runtime-mounts.test.ts` and
`packages/kernel/tests/unit/runtime-launch-policy.test.ts`.

### 6.2 Git metadata

Worktree files remain read-write, but all Git metadata is read-only:

- a normal checkout overlays its canonical `.git` directory at `/workspace/.git` read-only;
- a linked worktree overlays the `.git` indirection file read-only, mounts the exact canonical
  worktree gitDir at the absolute path named by that file and mounts its canonical commonDir,
  all read-only;
- current OCI engines would materialize an absent nested `/workspace/.git` target in the host bind,
  so a non-Git workspace is refused before container creation instead of creating host metadata.

The host validates the linked `.git` and `commondir` bytes against `discoverGitWorkspace`; relative,
non-canonical, missing or inconsistent metadata fails closed. No Git config, credential helper,
agent socket or host HOME is added. `git status`, `git diff`, `git log` and `git show` can read the
admitted repository when its local configuration needs no host-only executable. `git add`, commit,
ref updates and metadata lockfiles fail. The error path recommends a new Sandbox or Host run; it does
not switch placement.

`RuntimeLaunchSpec.gitMetadataMounts` is a closed typed list. Launch validation checks cardinality,
uniqueness, source/target shape, filesystem roots and read-only flags. Docker/Podman effective
inspection must contain exactly the workspace RW bind, all protected RO binds and the private
engine-owned `/mise` volume; a missing, additional or writable host bind rejects attachment.

Production: `packages/kernel/src/git-workspace.ts` (`discoverGitWorkspace`),
`packages/kernel/src/file-kernel.ts` (`createFileKernel` runtime inputs),
`packages/kernel/src/runtime/container-policy.ts` (`assertMaterializedProtectedTargets` and
`validContainerPolicy`), and the Docker/Podman
backends. Test: `packages/kernel/tests/unit/runtime-mounts.test.ts`,
`packages/kernel/tests/unit/runtime-docker-backend.test.ts`,
`packages/kernel/tests/unit/runtime-podman-backend.test.ts`, and
`packages/kernel/tests/integration/local-docker-runtime.e2e.test.ts`.

### 6.3 Preserved engine controls

Both engines retain an immutable image, read-only root filesystem, `cap-drop ALL`,
`no-new-privileges`, no engine socket, bounded CPU/memory/process/output/storage, a `nosuid,nodev,noexec`
`/tmp`, filtered environment and no host credentials. `/mise` is a private engine volume partitioned
by owner, project, workspace and exact image; it is not a host-path bind. Rootful Docker uses the
operator's numeric UID/GID; rootless Docker and Podman use their qualified mappings.

Production: `packages/kernel/src/runtime/docker-backend.ts`,
`packages/kernel/src/runtime/podman-backend.ts`, and
`packages/kernel/src/runtime/container-mise-cache.ts`. Test:
`packages/kernel/tests/unit/runtime-docker-backend.test.ts`,
`packages/kernel/tests/unit/runtime-podman-backend.test.ts`,
`packages/kernel/tests/integration/runtime-docker-identity.e2e.test.ts`, and
`packages/kernel/tests/integration/runtime-podman-isolation.e2e.test.ts`.

## 7. Lifecycle, failure and observability

Container acquisition is lazy and coalesced per effective runtime selection. Plugin revision is not
part of generation identity because Plugin bytes never enter a core generation. A changed runtime
selection retires the old generation; cancellation, steer, tool interruption, model stream, trace,
checkpoint and terminal settlement remain supported.

There is no Docker→Sandbox or Podman→Host/Sandbox fallback, latch, retry status or fallback notice.
An unavailable engine, image/policy mismatch, mount limitation, bridge disconnect or guest failure
returns its original bounded sanitized error. The operator must explicitly change Isolation and
start a new run. A run which started in Container is never replayed natively.

`mcp_degraded` and feature capability events cannot originate from Container because no MCP or
feature bridge is attempted. Runtime logs remain host-owned structured diagnostics; they do not add
prompt policy. Checkpoints exclude host operator-authority and legacy capability state before being
sent to the guest.

Production: `packages/kernel/src/runtime/lazy-runtime.ts` (`createLazyRuntimeCoordinator`),
`packages/kernel/src/runtime/status-schema.ts`, and
`packages/kernel/src/runtime/isolated-run-executor.ts`. Test:
`packages/kernel/tests/unit/lazy-runtime.test.ts`,
`packages/kernel/tests/contract/runtime-status-conformance.test.ts`, and
`packages/kernel/tests/integration/runtime-execution-worker.test.ts`.

## 8. UI contract

Settings > Isolation presents Docker/Podman as **Core tools only** and states:

- Skills, MCPs, Hooks, Plugins and host-backed capabilities are unavailable;
- commands run without Command Review;
- workspace writes and outbound network remain enabled;
- Git metadata is read-only, so commits require Sandbox or Host.

Review renders as `Not applicable in Container`; Memory, Plans and Extensions render inactive. These
views do not overwrite the persisted native values, which become effective again after switching to
Sandbox/Host. Plugin profiles and incompatible custom profiles are disabled or labelled as requiring
Sandbox/Host. Code omits Guard, Memory and Plans fields from Container payloads, but kernel admission
remains authoritative if state changes before submit.

An engine failure tells the operator to fix Docker/Podman or explicitly select Sandbox/Host for a new
run. There is no fallback badge/action and no elicitation which changes placement mid-run.

Production: `packages/code/src/features/run/isolation.ts`,
`packages/code/src/adapters/execution-safety.ts`,
`packages/code/src/views/config/IsolationConfigPanel.tsx`,
`packages/code/src/views/config/RunControlsPanel.tsx`,
`packages/code/src/views/overlays/ReviewPicker.tsx`, and
`packages/code/src/adapters/kernel-run-client.ts`. Test:
`packages/code/tests/unit/isolation.test.ts`,
`packages/code/tests/unit/execution-safety.test.ts`,
`packages/code/tests/integration/isolation-config-render.test.tsx`,
`packages/code/tests/integration/isolation-review-picker-render.test.tsx`, and
`packages/code/tests/integration/run-controls-render.test.tsx`.

## 9. Invariants

1. **Container core-only is host-enforced.** Client filtering is never authority.
2. **No host execution from the guest.** No broker receives arbitrary host command, argv, cwd, env,
   endpoint or path.
3. **No extension contribution.** Plugin Agents/Skills/MCP/Hooks/executables/settings do not enter a
   Container request.
4. **No feature capability crosses the boundary.** Only model, lifecycle, events, trace/checkpoint
   and explicit operator elicitation remain.
5. **No Command Review in Container.** Guard fields, reviewer settings, approval and per-command
   audit do not enter the guest.
6. **No prompt policy substitute.** The implementation does not generate Markdown or system guidance
   to replace Guard.
7. **Explicit incompatibility fails before inference.** Inactive inherited configuration does not.
8. **No placement fallback or replay.** A different placement requires a new operator selection/run.
9. **Only the selected workspace is a writable host bind.** Control roots and Git metadata are
   masked/read-only; `/mise` is engine-private.
10. **Network is independent.** `none`/`outbound` are enforced without Command Review.
11. **`host_vcs` remains absent.** No renamed equivalent exists.
12. **Native composition is unchanged.** Host/Sandbox retain Review, extensions and capabilities.
13. **Registration is not request.** Host-wide inactive capability registration neither enters nor
    blocks Container.
14. **Admission precedes engine acquisition.** An already-incompatible request reserves nothing and
    starts no engine, bridge or model.
