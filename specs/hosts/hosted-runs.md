# Hosted run observation and ownership

> Production: [hosting.ts](../../packages/protocol/src/hosting.ts) defines the transport-independent
> hosted-run boundary. [projection.ts](../../packages/kernel/src/hosting/projection.ts) owns bounded
> observation storage. [local-host.ts](../../packages/paths/src/local-host.ts) owns the private path
> vocabulary. Test: [hosted-projection.test.ts](../../packages/kernel/tests/unit/hosted-projection.test.ts),
> [hosted-projection-file.test.ts](../../packages/kernel/tests/component/hosted-projection-file.test.ts)
> and [local-host.test.ts](../../packages/paths/tests/unit/local-host.test.ts).

## Scope

The hosted-run boundary distinguishes execution identity, conversation identity, host generation
and interactive control epoch. `HostingService` describes admission, observation, explicit handoff,
receipt lookup and local-activity leases. Its DTOs contain no provider credentials or configuration
consent nonces. A hosted attachment contains a snapshot plus a `HostedRunObservation`. Its sequenced
frames reuse the run event vocabulary, while its controls follow the ordinary handle methods.
Promises and iterators are local interfaces, not serialized DTO members. Releasing an observation
does not release physical work; `closeSession` separately retires a live conversation's consent.

This implementation currently provides the types, private path builders, admission authority,
observation storage, a host-owned execution pump, a shared registry over persistence/turn ports,
and a reconnectable RPC adapter with hosted service/observation dispatch. `createFileRunHost` composes
these with canonical FileKernel services and immutable run preparation behind required authentication.
`serveLocalFileKernel` holds that composition in a separately launched process, with private discovery,
lease fencing and bounded idle shutdown. Code's workspace manager connects to this composition;
its background feature exposes explicit handoff, discovery and attachment through the kernel RPC.

## Code integration

Host-started goal stages use `RunHost.synchronizeGoal` in the already selected conversation.
Ordinary synchronization preserves the selected conversation and controller authority. Its cursor
stores ordered canonical turn identities. `adoptCanonicalTurn` accepts only executions confirmed by
the store; a refused submission cannot advance it. A divergent resident suffix is truncated and
reconstructed while the shared prefix keeps its node identities. Divergence before the folded
window reloads that canonical window. Closed stages replay persisted history; live stages attach
through normal hosted observation. Delayed reads revalidate the conversation generation.

A rejected submission is resolved against canonical turns and durable operator receipts. An accepted
pending message remains retained by the host; an absent submission returns its text to the composer
without overwriting newer typing. Provisional input never becomes a canonical turn or continuation
base. No branch parses an error string to decide whether the host admitted the input.
Production: `goalBinding`, `prepareGoalConversation` and `synchronizeGoal` in
[run-host.ts](../../packages/code/src/run-host.ts), connected by
[runtime.tsx](../../packages/code/src/runtime.tsx).
Test: automatic-stage, delayed-goal-read, diverging-canonical-history and refused-submission cases in
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts).

The host seeds Goal authority separately from the synthetic Goal work prompt. Guided
stages preserve the exact seed after exact user messages reconstructed from host-recorded source
executions; auto stages use only those source messages; literal stages serialize the complete
user-declared definition. The host also retains the complete persisted Goal definition as a
separate host-attested `review_context`, without converting inferred assumptions or human criteria into permission.
Automatic continuations inherit both fields and never capture their synthetic reminder as fresh
evidence. Production: `goalAuthorityMessages`, `goalReviewContext` and
`GoalExecutionPolicy` in
[hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts), consumed by `createRunService` in
[run-service.ts](../../packages/kernel/src/runs/run-service.ts). Test: Goal authority coverage in
[goal-hosted-continuation.test.ts](../../packages/kernel/tests/integration/goal-hosted-continuation.test.ts)
and [run-service-lifecycle.test.ts](../../packages/kernel/tests/unit/run-service-lifecycle.test.ts).

Goal Steward belongs to the physically admitted Goal entry run. Its finite auxiliary executions use
the owner-scoped run store without creating conversation turns or independent hosted controllers.
The retained coordinator closes before work settlement; auxiliary usage and domain state commit
atomically in the Session transaction. Settlement reuses the current achieved review and rechecks
the proposed result and fences without another model call. Production: `prepareHostedGoalTurn` and
`createFileRunHost`. Test:
[goal-steward-runtime.test.ts](../../packages/kernel/tests/integration/goal-steward-runtime.test.ts).

Legacy Goal formulation uses the same authenticated controller but is not a hosted conversation turn. The
host rejects it before inference when a Goal or physical run already owns the conversation. Its
separate semantic execution is persisted in the owner-scoped run/trace store, while the session lock
is released. After a ready result passes the full-session revision CAS, the host publishes Goal and
receipt before calling the same `startControlled` path used by literal creation. Insufficient, stale
and failed outcomes publish only a receipt and therefore create no hosted observation. Code recovers
that receipt without resubmitting analysis.

Production: `createGoalService` in [service.ts](../../packages/kernel/src/goals/service.ts),
`startControlled` in [registry.ts](../../packages/kernel/src/hosting/registry.ts), and
`createGoalController` in [controller.ts](../../packages/code/src/features/goal/controller.ts).
Test: [goal-formulate-service.test.ts](../../packages/kernel/tests/integration/goal-formulate-service.test.ts)
and formulation recovery in
[goal-controller.test.ts](../../packages/code/tests/unit/goal-controller.test.ts).

`WorkspaceClientManager` discovers or launches Code's companion `local-host` entry, selected by
`resolveLocalKernelArtifact`. The application entry composes the local subscription manager,
memory and lazy runtime factory without importing the renderer. Closing the manager closes its
connection; it does not call the independently owned kernel's shutdown.

Production: `WorkspaceClientManager` in
[workspace-client-manager.ts](../../packages/code/src/adapters/workspace-client-manager.ts),
[local-host.ts](../../packages/code/src/local-host.ts) and
[local-kernel-artifact.ts](../../packages/code/src/adapters/local-kernel-artifact.ts).
Test: [workspace-client-manager.test.ts](../../packages/code/tests/component/workspace-client-manager.test.ts)
exercises the real process connection and pinned workspace. Artifact installation and native platform
qualification require their own process and PTY evidence; a source fixture does not supply it.

`/reconnect` requests `WorkspaceClientManager.recover`, which authenticates another connection to
the discovered host without requesting restart or replaying execution. `/reconnect reload` and the
internal `backend.reload` configuration action request `invalidate`, which must obtain an idle
restart acknowledgement before releasing the previous connection. A rejected restart preserves a
usable client. Failed transport recovery closes an unaccepted candidate and preserves the previous
client until a replacement has passed inspection. Concurrent requests for the same transition share
one operation; conflicting modes are refused.

The application refuses either transition while its conversation has active preparation, a run,
shell work or compaction. It pauses TUI loop scheduling while connecting. Host probe failures publish
connection failure separately from runtime placement. A failed transition probes the retained client
before declaring the connection unavailable; saved settings remain pending when reload was refused.

Production: `WorkspaceClientManager.recover`, `invalidate`, `subscribeConnectionFailure` and
`createKernelRunClient.reconnect` in the adapters, `reconnectBackend` in
[runtime.tsx](../../packages/code/src/runtime.tsx), and the backend actions in
[commands.tsx](../../packages/code/src/app/commands.tsx).
Test: [workspace-client-manager.test.ts](../../packages/code/tests/component/workspace-client-manager.test.ts)
verifies a real closed socket recovers the same host generation without restart, and a physical
activity prevents reload while preserving the original client;
[workspace-operator-notices.test.ts](../../packages/code/tests/component/workspace-operator-notices.test.ts)
verifies sequenced notices, failed-poll recovery and browser callbacks fenced to their connection;
[kernel-run-client.test.ts](../../packages/code/tests/component/kernel-run-client.test.ts) verifies
transition ordering and intent; [app-commands.test.tsx](../../packages/code/tests/integration/app-commands.test.tsx)
verifies the connection and reload routes.

`/background` requests a durable handoff for the selected run and exits only after its receipt on a
local Host/Sandbox connection whose independently owned host survives client disconnect.
Agent command sessions started in that hosted run remain owned by the run through client disconnect. The
tools capability closes command admission, drains tracked process trees, and releases run scratch
only when the hosted execution itself ends. Closing a TUI window is not a run-end signal. An abrupt
host crash outside a sandbox may leave an orphan; a stale session ID cannot authorize signalling in a later run. Production: `createAgentToolsCapability` in
`packages/loop/src/runtime/capabilities/tools.ts`, `ExecutionSessionManager` in
`packages/tools/src/lib/execution-session.ts`, and `createHostedExecution` in
`packages/kernel/src/hosting/sessions.ts`. Test:
`packages/kernel/tests/integration/local-host-process.test.ts` (hosted session through disconnect
and cancellation)
and `packages/loop/tests/integration/tools.test.ts` (drain at run end).
Uncertain handoff remains visible and consults the same operation receipt instead of replaying start.
A draft received during handoff keeps the TUI open even after the run has entered background.
The exit path restores the terminal and prints the execution identity; it bypasses checkout removal.

SSH processes are owned by the current client channel and refuse that handoff before
any hosting mutation. Their list, attach and cancel controls remain useful only while the same
connection is alive. The workspace manager exposes this lifecycle fact explicitly; Code does not
infer it from the Kernel's native runtime label.

| Connection destination | `/background` survives TUI exit | List, attach and cancel |
| --- | --- | --- |
| local Host or Sandbox | yes, after a confirmed host receipt | current or reopened TUI while the local host exists |
| SSH remote | no | current SSH stdio connection only; saved history persists after closure |

Opening a local workspace offers runs with `continue` policy after first paint, unless a draft,
active run or blocking interaction already owns the TUI. `/background list` makes discovery
available later.
The bounded host list shows identity, state, configuration and attention. Enter attaches, observes
another TUI's controlled run, or opens a closed result. Taking another controller requires explicit
confirmation. Starting another conversation does not attach to the listed run.

`createBackgroundListController` owns bounded polling, coalesced refresh, loading/error state and
serialized attach/cancel operations, including the interval spent awaiting takeover confirmation.
Disposal removes the wakeup and suppresses late list results and operation events. `BackgroundView`
keeps keyed rows, selection by execution identity, keyboard navigation and visual confirmation.
Production: [controller.ts](../../packages/code/src/features/background/controller.ts) and
[view.tsx](../../packages/code/src/features/background/view.tsx). Test:
[background-list-controller.test.ts](../../packages/code/tests/unit/background-list-controller.test.ts).

`/attach <execution-id>` resolves an exact workspace execution. `/background cancel <execution-id>`
requests cancellation only when another TUI does not own control. Temporary cancel observations are
released after delivery or failure; cancellation acknowledgement never releases host physical work.
`RunHost.resumeSessionById` also consults the live host before loading historical traces. Attach
preserves execution identity and does not resubmit the prompt. Closed results load canonical history
and are acknowledged only if that resume still owns the selected conversation. A live controlled
observation is acknowledged by `createKernelRunClient` only after its prefix, tail, result and host
settlement have all been consumed successfully, before observation release and readiness. An explicit
release, observer-only attachment, transport failure or failed settlement does not dismiss that
result. Acknowledgement failure rejects readiness and still attempts observation release.
Production: `driveHandle` and `hostedHandle` in
[kernel-run-client.ts](../../packages/code/src/adapters/kernel-run-client.ts), using
`createHostedObservationLease` in
[hosted-observation.ts](../../packages/code/src/adapters/hosted-observation.ts). Test:
[kernel-run-client.test.ts](../../packages/code/tests/component/kernel-run-client.test.ts) covers
physical/ack ordering, abandoned observations, observer attachments and acknowledgement failure;
[hosted-registry.test.ts](../../packages/kernel/tests/component/hosted-registry.test.ts) covers forty
foreground turns while retaining an unseen background result.

The observed run's confirmed `continue` policy is projected through `RunHost.continuesOnExit` only
when `WorkspaceClientManager.backgroundHandoffSurvivesExit` confirms the connection lifecycle.
The activity line shows `continues after exit`; `/quit` does not arm the run-loss confirmation for
that run. Dirty views retain their confirmation and explicit cancellation remains available.
This projection grants no tool consent and does not transfer `continue` to a later turn: ordinary
admission resets it, and it is inactive after settlement or observation teardown. The host still
owns the disconnect decision.

Production: `runManaged` and `continuesOnExit` in [run-host.ts](../../packages/code/src/run-host.ts),
`leadActivityDetail` and the quit gate in [App.tsx](../../packages/code/src/views/App.tsx).
Test: [run-host.test.ts](../../packages/code/tests/component/run-host.test.ts) checks the observed
policy, teardown and ordinary admission; [app-shell-render.test.tsx](../../packages/code/tests/integration/app-shell-render.test.tsx)
exercises `/quit` through the composer with both disconnect policies and checks the visible notice.

Production: `registerBackgroundCommands`, `createBackgroundController` and `BackgroundView` in
[commands.ts](../../packages/code/src/features/background/commands.ts),
[controller.ts](../../packages/code/src/features/background/controller.ts) and
[view.tsx](../../packages/code/src/features/background/view.tsx); `backgroundCurrentRun`,
`attachHostedRun` and `resumeSessionById` in [run-host.ts](../../packages/code/src/run-host.ts).
Test: [background-controller.test.ts](../../packages/code/tests/unit/background-controller.test.ts),
[background-commands.test.tsx](../../packages/code/tests/integration/background-commands.test.tsx)
and the hosted teardown/identity cases in [run-host.test.ts](../../packages/code/tests/component/run-host.test.ts).

The Sessions chooser closes when the user selects a conversation, before waiting on its potentially
long-lived observation. A reference with an unknown outcome cannot fall through to ordinary trace
resume or automatic continuation. The UI reports that state and leaves inspection or a new
conversation to the user.

Production: `resumeSessionById` and the `sessions.open` registration in Code.
Test: `resume refuses an unknown hosted outcome without treating its trace as an ordinary continuation`
in [run-host.test.ts](../../packages/code/tests/component/run-host.test.ts), and `Sessions closes its
chooser before waiting for a live hosted observation` in
[app-commands.test.tsx](../../packages/code/tests/integration/app-commands.test.tsx).

`!` shell commands reserve their conversation through `HostingService.reserveActivity` before
spawning in the TUI. A refusal settles the visible command without spawning. The owner persists and
reads back its pending observation before releasing the lease; unrelated clients cannot save into
that reserved conversation. `stopLocalWork` cancels and waits for the shell and release before normal
TUI disconnect. Clear/switch invalidates pending admission and cannot append output to a new session.
An abrupt connection loss without release preserves conservative host occupancy, since it does not
prove that a local process ended. These commands cannot be detached. Offline compaction already
reserves host-wide maintenance, so it does not acquire a conflicting client activity lease.

Production: `runBangCommand`, `stopLocalWork` and `closeWorkspace` in Code; `saveDuringActivity` in
the session coordinator and `HostedRegistry.ownsActivity`. Test: the hosted shell admission,
persistence/shutdown and refused-spawn cases in
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts), plus the competing-client
case in [file-run-host.test.ts](../../packages/kernel/tests/integration/file-run-host.test.ts).

Removing an application-selected worktree first stops local shell work and obtains the host's
`requestRestart` retirement acknowledgement. Physical work or an unknown outcome refuses removal
before filesystem deletion or client disposal. An accepted retirement closes new host admission;
the existing clean-check and non-force Git removal then apply. Production: `removeSelectedWorktree`
in [runtime.tsx](../../packages/code/src/runtime.tsx). Test: the occupied-host restart refusal in
[file-run-host.test.ts](../../packages/kernel/tests/integration/file-run-host.test.ts) and the
cleanliness/ownership cases in
[worktree-bootstrap.test.ts](../../packages/code/tests/integration/worktree-bootstrap.test.ts).

`startHeadlessRun` materializes and reads back an empty canonical conversation before hosted
admission. Its observation delivers the immutable prefix before the live tail. Print waits for
event drainage, physical closure and acknowledgement through the same observation lease as the TUI
before releasing its observation and closing its connection. An abandoned event iterator retains the
unconsumed result for later inspection. A refused hosted start cannot fall back to `runs.start`.

Production: [headless-run.ts](../../packages/code/src/adapters/headless-run.ts) and `runPrintMode` in
[runtime.tsx](../../packages/code/src/runtime.tsx). Test:
[headless-run.test.ts](../../packages/code/tests/component/headless-run.test.ts).

## Observation storage

`createHostedProjection` has one append authority. It coalesces adjacent deltas through the existing
`coalesceRunEvents` and `RUN_EVENT_POLICY` vocabulary, preserving attribution, resets and structural
event order. Each encoded NDJSON item records its first and last source sequence. A sequence interval
with several deltas means lossless coalescing, not missing events. The default flush threshold is
64 KiB; structural events flush immediately. A snapshot flushes and syncs the remaining prefix.

The append-only prefix is immutable. `HostedRunSnapshot` fixes its byte length and execution cursor;
later appends cannot change any of its pages. Pages contain at most 256 KiB of raw bytes by default,
encoded as base64 for the wire. Readers concatenate decoded bytes before parsing UTF-8 NDJSON, since
a page boundary can split a multibyte codepoint or a JSON record. Configured page size cannot exceed
1 MiB. A snapshot denotes a projection cut; the registry consuming this primitive must pair that cut
with its event subscription atomically.

Production: `createHostedProjection`, `HostedProjection.append`, `snapshot` and `readPage` in
[projection.ts](../../packages/kernel/src/hosting/projection.ts). Test: `coalesces provider tokens and
pages UTF-8 without altering a frozen prefix`, `keeps attribution, reset, plans and workflow state in
their original order` and `flushes a long token stream in bounded chunks instead of retaining all
deltas` in [hosted-projection.test.ts](../../packages/kernel/tests/unit/hosted-projection.test.ts).

File storage splits the logical byte stream into private 64 MiB segments. Only the current writer
remains open; a page read opens at most one historical segment at a time. Rotation synchronizes the
previous segment and directory before continuing. Snapshot offsets and sequence numbers do not reset
at segment boundaries, including boundaries inside UTF-8 or JSON records. The default no longer
imposes a lifetime history quota. Acknowledgement removes the exact segment namespace; unrelated
siblings remain. Segmentation bounds files and read buffers, not total disk retention.

Production: `openProjectionStorage` and `removeProjectionStorage` in
[projection-storage.ts](../../packages/kernel/src/hosting/projection-storage.ts), used by
`openHostedProjection`, local host storage. Test: `streams beyond the former lifetime
quota with bounded segments and immutable cuts` in
[hosted-projection-file.test.ts](../../packages/kernel/tests/component/hosted-projection-file.test.ts)
streams more than 64 MiB through the real snapshot decoder and preserves an earlier cut.

The positional file writer owns transient syscall recovery. `EINTR`, `EAGAIN`, `EBUSY`, `ETIMEDOUT`
and `EIO` receive at most three attempts with bounded exponential backoff and jitter. A write retries
identical bytes at the same offset, including when the prior syscall wrote them but its acknowledgement
was lost. Only successful acknowledged byte counts advance the local write cursor; the projection
advances an event sequence once. Synchronization retries are idempotent. Neither creation nor close
is retried, and capacity, permissions, identity conflicts and unclassified failures remain failures.
There is no second event pump or replay of model/tool effects. Exhaustion still poisons the projection;
this local syscall recovery does not establish crash resumption or projection reconstruction.

Production: `recoverProjectionIO` in
[projection-io.ts](../../packages/kernel/src/hosting/projection-io.ts), called by `openProjectionStorage`;
local hosts supply their Logger. Test: `recovers positional writes and rotation sync
without duplicating frames or changing a snapshot` in
[hosted-projection-file.test.ts](../../packages/kernel/tests/component/hosted-projection-file.test.ts)
uses real segmented files with faults before/after individual IO operations. `positional IO recovery
has a finite allowance and never retries capacity or identity errors` in
[projection-io.test.ts](../../packages/kernel/tests/unit/projection-io.test.ts) covers refusal and exhaustion.

## Limits and failures

Preparation failures are projected to plain `{code, message}` DTOs before entering the index;
messages use the shared error sanitizer. Exception prototypes, stacks and diagnostic details do not
become persisted run results or invalidate the index used by subsequent admissions.

Production: `createHostedRegistry` in [registry.ts](../../packages/kernel/src/hosting/registry.ts).
Test: `persists a plain sanitized preparation error without poisoning later admissions` in
[hosted-registry.test.ts](../../packages/kernel/tests/component/hosted-registry.test.ts).

Clients use `readHostedSnapshot` to consume the immutable prefix without retaining another complete
history. The decoder uses the live RPC event codec, handles split UTF-8/records, bounds each page to
1 MiB and each decoded record to 64 MiB, and checks offsets, canonical base64, contiguous sequence intervals
and the final cursor. Corruption is explicit and never echoes the invalid payload. Completion or
early iterator return releases the snapshot; a failed release is observed separately.

Production: `readHostedSnapshot` in
[hosted-snapshot.ts](../../packages/kernel/src/transport/hosted-snapshot.ts), exported by
[index.ts](../../packages/kernel/src/index.ts). Test:
[hosted-snapshot.test.ts](../../packages/kernel/tests/unit/hosted-snapshot.test.ts) covers split
Unicode, coalesced intervals, abandoned readers, malformed records/pages, limits and empty cuts.

| Resource | Default | Failure |
| --- | --- | --- |
| Physical observation segment | 64 MiB | Rotate to another private segment; logical offsets remain continuous |
| Explicit encoded history quota | Disabled by default | If configured, exhaustion refuses further appends and snapshots |
| Outstanding snapshots | 4 per projection | A new snapshot is refused without evicting an existing reader |
| Snapshot lifetime | 120 seconds | Expired ids return `not_found`; a caller must obtain another snapshot |
| Queued storage operations | 32 per source/observation class | Refused before another queued operation is allocated |
| Queued input/read bytes | 16 MiB per source/observation class | Refused before another payload is retained by the queue |

Source append/sync and observation snapshot/read requests have independent queue allowances.
A saturated reader cannot refuse admission of the next source event. Both classes share the same
ordered storage chain, preserving snapshot cuts and bounded retention; slow storage may still delay
that chain. Closing drains both classes.

All configurable bounds are positive safe integers. After the file writer exhausts its classified transient
IO recovery, an append/sync or explicit quota failure is sticky: it cannot
become a successful handoff by trying another append. Existing complete prefixes remain readable
after an append failure. A failed or short snapshot read rejects that reader without poisoning
append authority or future snapshots; the consumer can reconnect and retry. Structural
history is never silently dropped to satisfy a quota. Closing drains accepted work and closes the
file without deleting historical bytes; new operations after close fail with `unavailable`.

Production: `createHostedProjection` and its `enqueue`, `flush` and `assertHealthy` boundaries in
[projection.ts](../../packages/kernel/src/hosting/projection.ts). Test: the snapshot expiry, storage
failure, quota, queue saturation, `observation saturation by %s preserves source admission and immutable cuts`, and truncated-read cases in
[hosted-projection.test.ts](../../packages/kernel/tests/unit/hosted-projection.test.ts).

`openHostedProjection` creates a new file exclusively, with the shared private file/directory modes.
It retries partial writes until the complete encoded item lands, detects premature EOF and closes
the descriptor when setup fails. It does not reopen or overwrite an existing execution's projection.
File and directory syncing follows [paths](../foundations/paths.md), including that contract's
platform limitations; observation storage is not an executable crash checkpoint.

Production: `openHostedProjection` in [projection.ts](../../packages/kernel/src/hosting/projection.ts).
Test: `file-backed hosted projection` in
[hosted-projection-file.test.ts](../../packages/kernel/tests/component/hosted-projection-file.test.ts).

## Admission and interactive control

`createHostedAdmission` reserves one conversation synchronously before any caller can begin
asynchronous run preparation. Main runs and local shell/compaction activities share that conversation
occupancy. The default workspace limits are two main runs, four local activities and four connected
clients. Disconnecting a client retires its control but retains physical occupancy; only the host's
`release` call after actual teardown frees that slot. A cancel acknowledgement is not that release.

Peers are host-created identities, not caller-supplied RPC records. Observers cannot reserve work or
acquire control. An occupied controller requires explicit takeover; successful transfer increments
the epoch and retires the previous conversation controller without affecting unrelated conversations.
Controls carrying an earlier epoch are refused.

Production: `createHostedAdmission`, `HostedAdmission` and `HostedControl` in
[admission.ts](../../packages/kernel/src/hosting/admission.ts). Test: the reservation/disconnect,
forged-peer, takeover, conversation-resume and independent-limit cases in
[hosted-admission.test.ts](../../packages/kernel/tests/unit/hosted-admission.test.ts).

## Execution pump and subscribers

### Internal continuation authority

A prepared host turn may provide `HostedTurnContinuation`. The registry captures an opaque
`HostedContinuationAuthority` from that execution's actual controller. Its session and predecessor
are fixed, it cannot be reconstructed from a DTO, and reservation consumes it once after physical
occupancy has been released. New stages reuse `startEntry`, including ordinary preparation, intent
commit, host index persistence and supervision. They create neither a public peer nor an observation.
The internal preparation context records the predecessor; public start arguments cannot assert that
an admission is automatic.

Only after physical closure, event drainage, canonical reconciliation, terminal index commit and
admission release does the registry ask that policy whether this execution has a successor. A pending
or failed barrier prevents the question entirely. The policy rules from durable state — its own
revisions, the Goal's admission and the decision its settlement recorded — so the registry no longer
tests the predecessor's physical shape and a stage that ended with a recoverable failure continues
exactly as one that handed off a checkpoint. A run whose preparation provided no policy is inert.
Read-only continuation preparation and its stop notification each have a five-second default deadline.
Late results cannot start work after timeout or revocation. The host policy must still revalidate its
durable revisions during ordinary intent commit and start.

A proposal may carry `not_before`: the earliest instant a successor may start, which is how a
provider-requested backoff is honored. The wait happens outside the short preparation deadline, with
one abortable timer bounded by the platform's timer ceiling, and the policy is asked again afterwards
so only a fresh proposal starts. Losing the authority during the wait abandons the instant and starts
nothing; the instant is durable on the closed stage, so a host restart cannot extend it.

Disconnect, conversation close, takeover and background handoff revoke future control without
granting physical release. Revocation notifies the host policy immediately, even while the current
stage is running. After `commitIntent` succeeds, the presence of that internal policy durably selects
`disconnect_policy: "continue"` for the current run: controller loss pauses the policy's future Goal
stages while the admitted physical stage continues through settlement. A turn with no continuation
policy retains the ordinary cancel-on-disconnect default, and explicit cancellation remains physical.
A new human reservation supersedes pending automatic work; it is distinguished
from controller retirement so the old policy does not pause the newly admitted human stage.
Stop notifications are delivered once and bounded failures are logged without payloads. Cleanup
of an old authority cannot revoke a successor. Retention keeps pending continuation ownership until
its callback settles, and host shutdown awaits its notification before disposing the entry.

Production: `captureContinuation`, `reserveContinuation` and `retireContinuation` in
[admission.ts](../../packages/kernel/src/hosting/admission.ts); `startEntry`, `continueEntry` and
`stopContinuation` in [registry.ts](../../packages/kernel/src/hosting/registry.ts).
Test: [hosted-admission.test.ts](../../packages/kernel/tests/unit/hosted-admission.test.ts) checks
identity forgery, single-use reservation, controller retirement and independent conversations;
[hosted-continuation.test.ts](../../packages/kernel/tests/component/hosted-continuation.test.ts)
holds physical closure, the terminal index commit and durable barriers separately and covers two
automatic successors, human/disconnect/takeover races, foreign proposals, the typed minimum instant
with its re-ask, the abandonment of a pending instant and bounded policy calls;
[hosted-registry.test.ts](../../packages/kernel/tests/component/hosted-registry.test.ts)
checks that a durably admitted Goal stage survives controller disconnect while its future authority
retires.

### Physical execution and observation

Goal user controls also hold a `HostedConversationAuthority` between stages. It belongs to one
registered operator peer and cannot be forged from its visible fields. Physical release retains
this proof; disconnect, close and takeover revoke it. A different peer must explicitly take over,
including while the goal is physically idle. Old proof cleanup cannot retire a newer controller.
`startControlled` and `cancelControlled` are host-only registry methods using this proof and the
existing start/cancel machinery. They cannot target another session or bypass physical exclusion.
`hosting.interrupt_tool` uses the same interactive-control admission as steer, compact, cancel and
respond: an `observe` attachment cannot interrupt a blocking shell or a yielded session; acquire/takeover can. A stale
controller epoch is refused before delivery. Subscription identities belong to one connection;
knowing another connection's identity cannot control its run. A token is delivered only to the
observation's bound run, never looked up across runs.
Production: `createHostingDispatcher` in
[hosting-server.ts](../../packages/kernel/src/transport/hosting-server.ts) and `assertControl` in
[registry.ts](../../packages/kernel/src/hosting/registry.ts).
Test: `fences tool interrupts by observation, connection, run and control epoch` in
[hosted-transport.test.ts](../../packages/kernel/tests/integration/hosted-transport.test.ts), over
loopback and local IPC.
The proof crosses preparation only through the private host context. Process-owned start admission
also applies to automatic starts, and pending continuations/goal controls prevent maintenance.
A guided Goal creation turn claims the conversation control for the operator connection that starts
it, because every Goal stage requires a live conversation controller and the first stage must be able
to start its own successor; a peer that already holds the conversation is still refused by the
ordinary claim, so a takeover stays explicit.
Production: `claimConversation`, `assertConversation` and `releaseConversation` in
[admission.ts](../../packages/kernel/src/hosting/admission.ts), and the controlled start methods and
the guided Goal claim in `startEntry` in [registry.ts](../../packages/kernel/src/hosting/registry.ts).
Test: `keeps conversation control between stages and requires explicit takeover` and
`physical takeover retires old goal control without releasing occupancy` in
[hosted-admission.test.ts](../../packages/kernel/tests/unit/hosted-admission.test.ts),
[file-run-host.test.ts](../../packages/kernel/tests/integration/file-run-host.test.ts), and
`starts a successor when the guided creation stage itself checkpointed` in
[goal-file-host.test.ts](../../packages/kernel/tests/integration/goal-file-host.test.ts).

`createHostedExecution` immediately consumes one managed `RunHandle`. That source consumer survives
zero subscribers, an abandoned iterator and a saturated observer. Each observer defaults to 1,024
buffered items and 16 MiB, with at most four observers per execution. Events coalesce without loss;
structural saturation retires only that observer. The execution continues draining into its projection.

Observation registers its subscriber before requesting a snapshot cut. It excludes events through
that cursor, and coalescing cannot join items across the cut. Source sequences therefore cover an
immutable prefix followed by a contiguous tail, including when new events arrive during snapshot
sync. Completed runs can still issue snapshots until the registry disposes their retained projection.

The pump registers one question observer and one settlement observer. Expired/answered questions
leave its pending map, and responding to such an id fails with `not_found`. A pending question keeps
its published `window_ms` intact, so a reattachment replays the request with the deadline that is
already running instead of arming a new one. Repeated attaches do not register another callback on
the source handle. Subscriber callbacks are removable and bounded.

Semantic `done`, source event end, physical `closed` and host reconciliation are independent. The
execution's `settled` promise also awaits its owner's `commitTerminal` transaction. Successful
subscriber `closed` and `terminalCommitted` mean reconciliation, durable terminal discovery and
admission release have finished. Until then the reference remains `finishing`; neither semantic
`done` nor physical exit alone permits reuse. A reconciliation or terminal commit failure enters the registry-owned settlement recovery chain.
Known transient storage failures receive at most three attempts with bounded exponential backoff
and jitter; semantic conflicts and unclassified failures do not retry. Each phase is checkpointed
in the existing private index before execution. A terminal commit retry never reruns reconciliation.
Exhaustion rejects subscriber closure and retains explicit pending-phase state and occupancy.
No failure of this physically closed settlement sends cancellation to the source. Closing an observation is not physical completion. A storage failure retires observers,
requests run cancellation and keeps draining until the real source closes. It prevents further
recoverable attaches; existing run/session stores remain the authority for any reconciled outcome.

Production: `createHostedExecution` and `HostedExecution` in
[execution.ts](../../packages/kernel/src/hosting/execution.ts), with the sticky `HostedProjection.failure`
boundary in [projection.ts](../../packages/kernel/src/hosting/projection.ts). Test: the zero-subscriber,
snapshot-sync race, saturated-client, expired-elicitation, cancellation/reconciliation and disk-full
cases in [hosted-execution.test.ts](../../packages/kernel/tests/component/hosted-execution.test.ts).
Those tests use the real managed-run lifecycle and in-memory storage, not a detached OS process or
a real model provider.

## Registry and handoff transactions

`createHostedRegistry` binds all its connections to one owner, workspace and host generation.
`HostingService.start` reserves the conversation synchronously, obtains a projection and a prepared
turn, invokes `commitIntent`, commits the starting reference, then invokes that turn's `start` once.
The prepared transaction is retained before the intent write, so even a write that fails after
canonical publication can be reconciled before physical admission is released.
`createHostedSessionCoordinator` supplies file-session revision checking, turn intent and usage
reconciliation as specified in [sessions](sessions.md#host-owned-conversation-transactions).
Effective execution binding is supplied by `InProcessKernel.prepareRun` and `createFileRunHost`, as
specified below. `serveLocalFileKernel` supplies the process lease and private connection authority
described under independent process composition.

Run controls capture the current controller epoch. Observers cannot mutate; taking an occupied
controller requires explicit takeover. Authority is checked again after asynchronous observation
preparation. A connection can hold four observations, counting preparations already in flight.
Closing control cancels unpromoted work and revokes its interactive consent. Promoted work continues.
An authenticated operator may call `controlObservation(observationId, "acquire" | "takeover")`
on its existing observation. It creates no snapshot/subscription and updates only that observation's
captured controller epoch. A foreign/released observation, observer role, committing handoff or
ended occupancy is refused. Acquiring occupied control still requires explicit takeover; older
observation handles retain their previous epoch and fail control checks.
Code routes takeover of an already observed execution through this method, retaining the session,
transcript, pump and observation ID. Confirmed acquisition wires interactive questions once and
permits normal result acknowledgement after complete consumption and host closure.
Production: `createHostedRegistry` in [registry.ts](../../packages/kernel/src/hosting/registry.ts),
`hostedHandle`/`driveHandle` in [kernel-run-client.ts](../../packages/code/src/adapters/kernel-run-client.ts),
and `attachHostedRun` in [run-host.ts](../../packages/code/src/run-host.ts).
Test: existing-observation takeover and old-controller fencing in
[hosted-registry.test.ts](../../packages/kernel/tests/component/hosted-registry.test.ts) and
[hosted-transport.test.ts](../../packages/kernel/tests/integration/hosted-transport.test.ts);
preserved TUI session/stream and controlled result consumption in
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts) and
[kernel-run-client.test.ts](../../packages/code/tests/component/kernel-run-client.test.ts).
Local activity leases share conversation admission and remain occupied if their connection dies
without proving physical completion; releasing an unknown or foreign lease is refused.

Detach validates generation, revision and controller before admitting the operation. Native
configuration and incomplete preparation cannot detach. It syncs the projection without consuming a
reader snapshot slot, then waits for the host index's durable commit before changing disconnect
policy. It then retires the conversation's interactive control and consent before returning the
receipt, including when the original connection remains open. Concurrent loss of that connection
waits on the admitted handoff's outcome before
applying cancel/continue. Receipt lookup on a new authenticated connection preserves its operation id;
current run state accompanies the receipt, including completion during commit.

Handoff failures carry `HostedHandoffFailureDetails` in `KernelError.details`:
`{handoff: {operation_id, admission: "refused" | "uncertain"}}`. Before its identity is admitted,
a definitive refusal leaves that identity unused. Previously admitted, failed or expired identities
remain uncertain and cannot be replayed. The Code run host clears its pending handoff only for a
matching explicit refusal, allowing a fresh operation after the refusal cause is resolved.
An unclassified failure, mismatched operation identity or missing receipt retains uncertainty and
continues receipt lookup without repeating detach.
Production: `HostingService` and `HostedHandoffFailureDetails` in
[hosting.ts](../../packages/protocol/src/hosting.ts), `createHostedRegistry` in
[registry.ts](../../packages/kernel/src/hosting/registry.ts), and `backgroundCurrentRun` in
[run-host.ts](../../packages/code/src/run-host.ts).
Test: pre-admission refusal and failed durable handoff in
[hosted-registry.test.ts](../../packages/kernel/tests/component/hosted-registry.test.ts),
and definite refusal, uncertain conflict and lost receipt recovery in
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts).

The registry retains at most 32 runs and 128 handoff operation identities per generation. Receipt
lookup expires after 24 hours by default; an expired/failed operation id is never replayed. The commit
queue holds at most 16 operations and an encoded index cannot exceed 2 MiB. No provider credentials,
prompts enter that index. Acknowledged terminal entries are reclaimed only
after observations close, using the dedicated `removeProjection` port; session and trace deletion
are outside that port. Reclamation failures cannot silently free retention capacity.

Physical run closure, conversation reconciliation and terminal index commit must all succeed before
the registry releases occupancy. Failure leaves explicit unknown/recovery state and blocks unsafe
reuse. `commitTerminal` is the single settlement barrier shared with the execution pump; handoff
index writes preserve the current lifecycle rather than restoring an older captured state.
Test: the blocked/failed terminal commit and completion-during-handoff cases in
[hosted-registry.test.ts](../../packages/kernel/tests/component/hosted-registry.test.ts) verify that
awaiting successful `closed` permits the next turn immediately.
Host shutdown separately cancels all remaining roots and waits for preparation and physical
teardown; a single client's `close` never invokes that shutdown.

Production: `createHostedRegistry`, `PreparedHostedTurn` and `HostedRegistryState` in
[registry.ts](../../packages/kernel/src/hosting/registry.ts), with `HostedProjection.sync` in
[projection.ts](../../packages/kernel/src/hosting/projection.ts). Test: reservation, response-loss,
failed-commit, completion-race, takeover, consent, reader-limit and acknowledged-reclamation cases in
[hosted-registry.test.ts](../../packages/kernel/tests/component/hosted-registry.test.ts). These tests
use the real managed-run lifecycle and controlled persistence ports; OS process survival and durable
file index writes are exercised separately by the process integration tests below.

## Discovery after a host generation ends

`decodeHostedRegistryState` validates a strict, byte-bounded index before the registry receives it.
Duplicate execution/operation ids, unsupported schemas, foreign workspaces and an index identifying
the new generation are rejected. No prompt, execution handle, executable checkpoint or consent is
restored. Terminal references retain their original generation and canonical result; other references
become `unknown` with `recovery_error`, except a durable physically closed and reconciled settlement
checkpoint permits terminal discovery recovery as described below. An unresolved conversation remains occupied for mutation and
cannot start another run or local activity. An independent conversation may still admit work.

Old-generation references cannot acquire control or attach through the new host. Receipt lookup
can report the recorded handoff without replaying it. A closed reference may be acknowledged and its
old projection reclaimed; an unknown execution cannot be acknowledged as physically closed. `sync`
durably publishes the recovered discovery state before a new endpoint becomes discoverable.

Production: `decodeHostedRegistryState` in [state.ts](../../packages/kernel/src/hosting/state.ts),
the `initialState`, `sync` and `acknowledge` boundaries in
[registry.ts](../../packages/kernel/src/hosting/registry.ts). Test:
[hosted-recovery.test.ts](../../packages/kernel/tests/component/hosted-recovery.test.ts) covers
old-generation controls, unknown occupancy, terminal acknowledgement, corrupt/oversized indexes and
expired receipts. This is recovery of discovery metadata, not resumption after a process crash.

### Durable steering receipt recovery

A synced `steering_applied` record with a host submission identity proves consumption independently
of the canonical session acknowledgement. The registry checkpoints a private delivery record before
calling `deliverOperator`. The record carries the intent identity, controller epoch, attempt count,
state, classified cause and next eligible time. Its enclosing run supplies execution and generation.
It contains neither message content nor credentials. At most 16 unconfirmed receipts are retained
per execution, matching the session's pending submission bound.

Known transient canonical receipt failures receive at most three attempts with exponential backoff
and jitter. A lost acknowledgement repeats only the idempotent receipt transaction, never steering,
model inference or tools. Callback exhaustion or a permanent callback failure retains
`waiting_external` without cancelling the live source. Recovery checkpoints independently receive at most three attempts for classified transient storage
failures, including registration and durable removal. Repeating a checkpoint never repeats consumption.
Exhausted checkpoint failures still propagate as authoritative persistence failures; they are not
converted into successful delivery.

Registry synchronization resumes persisted ready/recovering receipts across generations without
restoring controller authority. It preserves the attempt allowance, including an uncertain last
attempt, which becomes `receipt_unconfirmed` rather than silently repeating. An exhausted or
permanent wait is not rearmed by polling. A matching canonical `admitted`/`delivered_to` receipt
can settle even an exhausted acknowledgement without another write. Typed transient lookup failure
is unknown, not absence proof; the bounded idempotent receipt path remains available. Terminal reconciliation and retention cleanup cannot discard
pending receipts. Removing a receipt is itself persisted before resolving the caller's consumption
acknowledgement. Physical uncertainty about the old process remains separate from receipt recovery.

Production: `recoverHostedDelivery` in
[delivery-recovery.ts](../../packages/kernel/src/hosting/delivery-recovery.ts), `reconcileDeliveries`
in [registry.ts](../../packages/kernel/src/hosting/registry.ts), and the closed index decoder in
[state.ts](../../packages/kernel/src/hosting/state.ts). Test: lost acknowledgement, persisted attempt
allowance and checkpoint failure in
[hosted-delivery-recovery.test.ts](../../packages/kernel/tests/unit/hosted-delivery-recovery.test.ts);
`a failed canonical steering receipt preserves the live source and reconciles without re-steering`
and `recovers each receipt checkpoint acknowledgement without repeating consumption`
in [hosted-registry.test.ts](../../packages/kernel/tests/component/hosted-registry.test.ts); `restart
reconciles durable consumption receipts without starting or restoring authority` in
[hosted-recovery.test.ts](../../packages/kernel/tests/component/hosted-recovery.test.ts), including
`canonical consumption proof repairs an exhausted receipt without another write` and the duplicate
identity and capacity checks.

A permanent canonical consumption-proof lookup failure persists `waiting_external` with
`operation_failed` on that delivery, without attempting the receipt write or stopping another
session's recovery. A later matching canonical proof can remove the wait without rearming writes.
Failure to persist this classification remains an authoritative index failure.
Production: `reconcileDeliveries` in [registry.ts](../../packages/kernel/src/hosting/registry.ts).
Test: `a permanent delivery proof failure waits locally without rewriting consumption` in
[hosted-recovery.test.ts](../../packages/kernel/tests/component/hosted-recovery.test.ts).

### Durable settlement recovery

The private index can retain a `settlement` checkpoint alongside a run: operation (`reconcile` or
`commit_terminal`), readiness/recovery/external-wait state, attempt, controller epoch, typed cause,
next eligible instant and physical-closure proof. The existing execution settlement chain owns these
operations; no additional scheduler, tool retry or provider retry is introduced. Checkpoint writes
also retry classified transient storage failures, without rerunning a completed earlier phase.
A record requires a terminal outcome and a non-running discovery state.

After a host generation ends, `commit_terminal` proves that the source physically closed and the
canonical session reconciled. Startup can finish the discovery transition to `closed` without
operator physical attestation or re-executing effects. The normal startup index sync must succeed
before publication. A new durably accepted operator turn may reattempt an exhausted transient settlement in the same
host before physical admission. Concurrent attempts coalesce; completed reconciliation is skipped,
and source/physical failures are not retried. The submission retains its identity and supersedes
automatic continuation before waiting. Test: `a new accepted operator turn repairs exhausted
terminal storage before physical admission` in
[hosted-registry.test.ts](../../packages/kernel/tests/component/hosted-registry.test.ts).

A pending `reconcile` after host restart first queries the canonical session's terminal turn receipt.
With persisted physical closure and a matching ended turn, startup publishes terminal discovery
before releasing uncertainty; a lost session-write acknowledgement does not repeat effects. A
missing receipt can be repaired by the owning session coordinator for an ordinary conversation turn,
using the persisted terminal outcome and physical-closure checkpoint. That repair commits status and
usage atomically under the session lock; an already-ended turn makes a lost acknowledgement idempotent.
Non-final Goal runs can instead replay their durable domain-owned `settlement_preparation` through
`recoverGoalSettlementSession`; it must match the physical result's outcome and disposition. The
Goal reducer consumes that preparation and accounts for its measured usage atomically with the turn,
including partial gaps. Final completion, guided creation without a bound Goal, transcript digests,
operator recovery resolutions and custom settlement callbacks are not replayed through this path. Without the required domain
settlement proof, they remain pending. Failure to publish the index retains occupancy. Test:
`reconciles a lost session acknowledgement before releasing old-generation occupancy` in
[hosted-recovery.test.ts](../../packages/kernel/tests/component/hosted-recovery.test.ts).
A pending reconciliation without a matching receipt or successful canonical repair does not prove
settlement; it cannot be promoted using a cancellation acknowledgement or an outcome alone.
Concurrent index synchronization coalesces into one recovery pass, and host close awaits that pass.
A persisted future `next_attempt_at` leaves its operation pending instead of sleeping inside startup
synchronization. The registry schedules one cancellable wakeup for the earliest pending instant and
calls the same coalesced sync operation. A manual sync replaces that wakeup; host close cancels it,
and an already-delivered callback cannot revive a closed host. The comparison retains the beginning
of the sync pass so an instant that becomes due while another session is processed still gets a
wakeup. Waiting-external records are excluded, and failure to persist a scheduled pass is logged
without creating an unbounded retry loop. No controller authority or successor is reconstructed.
Production: `schedulePendingRecovery` and `sync` in
[registry.ts](../../packages/kernel/src/hosting/registry.ts), and `recoverHostedDelivery` in
[delivery-recovery.ts](../../packages/kernel/src/hosting/delivery-recovery.ts).
Test: `future backoff releases sync and wakes its owner, crossing eligibility during sync: %s` and
`closing cancels a future delivery wake and prevents late recovery` in
[hosted-recovery.test.ts](../../packages/kernel/tests/component/hosted-recovery.test.ts), plus
`a future delivery retry neither sleeps nor consumes an attempt before eligibility` in
[hosted-delivery-recovery.test.ts](../../packages/kernel/tests/unit/hosted-delivery-recovery.test.ts).

Canonical proof-lookup and repair failures stay scoped to their session: classified transient failures consume the
persisted three-attempt allowance with backoff; permanent failures wait immediately. Exhaustion
persists `waiting_external` and does not become terminal success or fail the whole synchronization.
Later synchronization can still recognize a canonical receipt, but does not rearm an exhausted repair
merely because it was polled. A failed proof lookup in `waiting_external` is logged and contained;
it does not reset the persisted allowance or prevent another session from reconciling. Each later
synchronization may check once for fresh canonical proof, without retrying the exhausted write.
Failure to persist the recovery index itself remains authoritative.
Test: `contains %s proof lookup failure without preventing another session from recovering` in
[hosted-recovery.test.ts](../../packages/kernel/tests/component/hosted-recovery.test.ts) covers both
transient and permanent lookup failures, independent recovery, unchanged exhausted checkpoints and
later proof-only completion.
Test: `restart repair failures remain scoped and exhaust their persisted allowance` in
[hosted-recovery.test.ts](../../packages/kernel/tests/component/hosted-recovery.test.ts). Neither recovery
restores controller authority nor automatically creates a successor under obsolete authority.

Production: `recoverHostedSettlement` in
[settlement-recovery.ts](../../packages/kernel/src/hosting/settlement-recovery.ts), composed by
`createHostedRegistry` in [registry.ts](../../packages/kernel/src/hosting/registry.ts), with index
validation in [state.ts](../../packages/kernel/src/hosting/state.ts).
Test: [hosted-settlement-recovery.test.ts](../../packages/kernel/tests/unit/hosted-settlement-recovery.test.ts),
`recovers terminal storage without repeating reconciliation or cancelling the closed source` in
[hosted-registry.test.ts](../../packages/kernel/tests/component/hosted-registry.test.ts), and
`recovers only a durable physically closed and reconciled settlement without operator attestation`
in [hosted-recovery.test.ts](../../packages/kernel/tests/component/hosted-recovery.test.ts).
The component tests recreate a registry from persisted state. The separate physical-process canary
`hosted-settlement-crash.test.ts` kills an isolated Bun host after the reconciliation checkpoint,
after canonical session publication, and after terminal index publication. Two restarts preserve one
turn and one charge, release proven occupancy and perform no additional execution. This qualifies
those three settlement milestones on the platform actually running the test, not every write/rename boundary.
The `steering_evidence` case kills the process after persisting target-bound acceptance and a
canonical consumption fixture, before a delivery checkpoint exists. Two restarts recover the
consumed receipt without another execution, charge, terminal outcome or physical-closure claim.
Its canonical trace port is synthetic; process death and private file persistence are real.

Production: `recoverSettlement` in [sessions.ts](../../packages/kernel/src/hosting/sessions.ts) and
`sync` in [registry.ts](../../packages/kernel/src/hosting/registry.ts), wired by `createFileRunHost`.
Test: `repairs a physically closed ordinary turn after restart without another execution or charge`
in [hosted-sessions.test.ts](../../packages/kernel/tests/integration/hosted-sessions.test.ts),
`repairs missing canonical settlement before releasing occupancy and coalesces restart synchronization`
in [hosted-recovery.test.ts](../../packages/kernel/tests/component/hosted-recovery.test.ts), and
[hosted-settlement-crash.test.ts](../../packages/kernel/tests/integration/hosted-settlement-crash.test.ts)
with [its process fixture](../../packages/kernel/tests/fixtures/hosted-settlement-crash.ts).

### Explicit operator recovery

`HostingService.resolveRecovery` accepts only an authenticated operator, an old execution's exact
generation and revision, and `physical_work_stopped: true`. The operator must first verify that all
processes and containers belonging to the old work have stopped. A missing host record or dead host
PID alone does not establish this. The host records an operator attestation; it does not independently
prove process closure or remote side effects. Current-generation executions, live occupancy, missing
confirmation and stale revisions are refused. Guest capabilities do not expose this operation.

`archiveRecovery` first commits a `HostedRecoveryResolution` on the canonical session turn. The
receipt names the old and resolving generations, the authenticated connection, the verification
time and its **disposition**: `archive`, the default, parks the interrupted work, while `continue`
lets the same conversation host a successor. An unfinished turn becomes `interrupted` in both
cases; known terminal status and usage remain intact, and no execution end time or run result is
invented. If intent never reached the session, a transcript audit turn records its identity. Only
an `archive` resolution closes the conversation to later model admission — a resolved conversation
is reopened when every recorded resolution asked to continue, with the interrupted turn kept as the
base its successor continues from. Neither disposition replays uncertain actions. Metadata reads,
export and explicit deletion retain their ordinary contracts.

Only after the session audit is durable does the registry commit the discovery row as physically
`closed`, retaining any already known outcome and recovery error. It then releases unresolved
physical occupancy and, for `continue` only, hands the resolved run to the conversation's own owner
so the record that was waiting on that execution — a Goal stage that never reported an ending —
stops treating it as occupied. Doing that after the commit, and only for `continue`, is what keeps
a crash from releasing occupancy without its evidence and keeps `archive` from resuming a line of
work the operator asked to park. If either write fails, the row remains unresolved; a retry reuses a
previously committed session audit. Concurrent confirmations share one operation. Host shutdown
awaits that operation. Ordinary acknowledgement may now remove the discovery row and private
observation projection while the session audit remains. These archived records therefore do not
exhaust the retained-run index. Maintenance still requires every live run/activity and remaining
unknown physical execution to be absent.

Production: `resolveRecovery` in [registry.ts](../../packages/kernel/src/hosting/registry.ts),
`archiveRecovery`, `continueRecovery` and archived/resolved-conversation admission in
[sessions.ts](../../packages/kernel/src/hosting/sessions.ts), and the coordinator composition in
[file-host.ts](../../packages/kernel/src/hosting/file-host.ts). Test:
[hosted-recovery.test.ts](../../packages/kernel/tests/component/hosted-recovery.test.ts),
`durably archives unknown turns with %s intent without inventing outcomes or replay` in
[hosted-sessions.test.ts](../../packages/kernel/tests/integration/hosted-sessions.test.ts), and
`operator recovery preserves the session audit and unlocks maintenance over local IPC` in
[file-run-host.test.ts](../../packages/kernel/tests/integration/file-run-host.test.ts).

The background list's `archive recovery` action presents the generation/run identity and physical
verification statement before confirmation. Declining or leaving the view does not publish recovery.
After confirmation, it acknowledges only a matching durable recovery response; a lost response
requires refreshing discovery before another action. Production: `BackgroundView` and
`createBackgroundListController` in
[view.tsx](../../packages/code/src/features/background/view.tsx) and
[controller.ts](../../packages/code/src/features/background/controller.ts). Test:
[background-controller.test.ts](../../packages/code/tests/unit/background-controller.test.ts) and
[background-list-controller.test.ts](../../packages/code/tests/unit/background-list-controller.test.ts).

`continue recovery` is the second action on the same selected unknown run, and the operator's
verification statement is the same one: what differs is that the copy names the consequence — this
conversation stays open and can start a successor, with the interrupted turn kept as its base — and
the confirmed disposition reaches the wire (`background-controller.test.ts`, "sends the continue
disposition only when the operator asked to resume"). The action layer carries the disposition; the
list layer is what asks the operator first, so a declined confirmation publishes nothing for either
action.

## File kernel composition

`createFileRunHost` owns one FileKernel and one registry across connections. Its bootstrap caller
must supply the host generation, durable index/projection operations and a token verifier; RPC
parameters cannot select them. A successful hello binds the configured workspace and an operator or
observer role; a supplied workspace selector must match that workspace's id or canonical path.
Machine-local application controls are separately exposed. The bootstrap may set
`exposeLocalControls: false`; the connection then retains hosting and goal services but advertises no
`local_host` capability and receives no local inspection, browser handoff, runtime retry or restart
service. This is the required composition boundary for a later remote transport.
Every operation checks the current connection role against the existing catalog:
operators retain local kernel services, including subscription control; observers can issue only
reads without a sensitive service category. Disconnect removes the role before asynchronous cleanup.
Four pending disconnect cleanups prevent further handshakes until cleanup progresses.

Connections receive the coordinated session service. Ordinary `runs.start` is unavailable on this
host, preserving the remote run client's existing failed-handle contract. Hosted controls carry the
registry epoch. Offline compaction, trace/workflow deletion and disposable storage cleanup acquire a
single host-wide maintenance reservation before their first await, require no physical run/activity
occupancy and block new hosted starts and local activities until they settle. Session deletion also
uses its conversation reservation. Kernel shutdown remains a process operation.

Production: `createFileRunHost` in [file-host.ts](../../packages/kernel/src/hosting/file-host.ts),
exported through [bootstrap.ts](../../packages/kernel/src/bootstrap.ts). Test:
[file-run-host.test.ts](../../packages/kernel/tests/integration/file-run-host.test.ts) exercises a
FileKernel, real loop with MockLLM, file-backed projection/index and Unix socket. It verifies
withholding local controls without removing hosted goal authority,
completion with no connected client, the same execution id after attach, canonical turn settlement,
authentication, observer restrictions and conversation control retirement. This is not evidence of
a surviving child process, a subscription provider, or a TUI journey.

`serveRemoteFileKernelOverStdio` composes that same file host for one process-owned authenticated
channel. The launcher that owns the channel must establish machine and user authority before the
process starts, for example through SSH. The stdio process therefore binds its sole peer as the
operator, fixes owner and canonical workspace from server-side inputs, sets
`exposeLocalControls: false`, and publishes neither a listener nor a Clarvis connection credential.
Its hosted capability may expose the server-owned `default_owner` needed by an application client;
the client must not derive that namespace with path rules from another operating system. Hosted
list, attach and cancel remain available during the channel, but this process ownership means a
background handoff cannot survive TUI or SSH exit.
It acquires the ordinary durable workspace lease, so another local or remote host cannot serve the
same workspace generation concurrently. EOF, pipe failure or explicit close shuts down the host,
persists the existing durable state and releases the lease. This bootstrap does not make generic
stdio safe to expose directly on a network.

Production: `serveRemoteFileKernelOverStdio` in
[serve-remote-stdio.ts](../../packages/kernel/src/hosting/serve-remote-stdio.ts), exported through
[bootstrap.ts](../../packages/kernel/src/bootstrap.ts). Test:
[remote-stdio-host.test.ts](../../packages/kernel/tests/integration/remote-stdio-host.test.ts) uses
the real NDJSON transport, FileKernel and durable lease to verify hosted goal authority, withheld
local controls, contender refusal and shutdown on EOF.

`connectRemoteKernelOverSsh` starts OpenSSH with argv and no local shell, requests no TTY, disables
port, agent and X11 forwarding and negotiates the existing stdio wire. It validates the destination
and every fixed remote command token because OpenSSH joins those tokens for the remote shell. The application places
workspace and Extension Profile selection in one closed, bounded base64url payload; neither local
provider credentials nor a local discovery token enters argv. Closing or losing the channel closes
the process-owned remote host, which retires conversation authority and applies the ordinary goal
pause-on-disconnect policy. Reconnect creates a new SSH process and never replays a mutation.
OpenSSH owns encryption, integrity, host-key verification and user authentication. It uses the
operator's default identities, configuration and local agent, while the explicit no-forwarding flags
keep agent/socket, X11 and port authority off the remote account. Clarvis provides no password or
identity-file UI, leaves `StrictHostKeyChecking` to OpenSSH configuration and forces
`BatchMode=yes`. The operator must establish the host key and a usable noninteractive identity before
launch; otherwise startup fails through captured stderr instead of letting OpenSSH prompt on the
TUI's controlling terminal. SSH is the only transport encryption layer, and the authenticated
endpoints see the decrypted protocol. Code composes the same default `exec` tool ceiling into local
and remote hosts; an explicit remote environment setting can narrow that ceiling.

Production: `connectRemoteKernelOverSsh` in
[connect-remote-ssh.ts](../../packages/kernel/src/hosting/connect-remote-ssh.ts), Code's
`remote-host.ts`, `remote-kernel-arguments.ts` and `WorkspaceClientManager` in
[packages/code/src](../../packages/code/src). Test:
[remote-ssh.test.ts](../../packages/kernel/tests/integration/remote-ssh.test.ts) uses a process fake
for SSH around a real remote stdio worker; Code's argument, manager and CLI architecture suites pin
the closed payload, remote namespace, reconnection and private entry selection. This deterministic
coverage does not establish interoperability with an SSH server on another machine.

`prepareKernelRun` resolves the actual entry and model through the settings assembler, including a
user-invoked skill's entry override and rendered seed. `snapshotRunConfiguration` captures the
effective settings, MCP provenance, contexts and profiles: at most 1,024 profile names and 16 MiB of
encoded inputs. Reads return independent copies. Later workflow leaders share that assembler,
default-spawn policy and fan-out settings; editing configuration for another turn cannot change
their admitted tree. The snapshot is process memory, never discovery metadata or a reusable consent.
Live guard and extension revocation still resolve through the host's current authority.

Preparation does not launch or reserve an execution id. Its single-use start passes through the
ordinary execution-id, owner-generation and Extension Profile run leases. A retired owner cannot be
resurrected by its prepared start. Configuration guidance uses the same ordinary profile assembly,
leases and hosted control lifecycle. Concrete file effects are reviewed by the restricted writer.

Production: `prepareKernelRun` in [prepare-run.ts](../../packages/kernel/src/runs/prepare-run.ts),
`snapshotRunConfiguration` in
[configuration-snapshot.ts](../../packages/kernel/src/runs/configuration-snapshot.ts),
`PreparedWorkflowExecution` in
[workflows-service.ts](../../packages/kernel/src/workflows/workflows-service.ts) and
`InProcessKernel.prepareRun` in [kernel.ts](../../packages/kernel/src/kernel.ts). Test:
[prepared-kernel-run.test.ts](../../packages/kernel/tests/integration/prepared-kernel-run.test.ts)
executes an actual manager/leader tree with MockLLM after changing the skill, profiles and default
model, and verifies the original inputs, duplicate-id refusal, lease release and snapshot quotas.

## Independent process composition

`serveLocalFileKernel` resolves the canonical workspace/global roots and acquires the local host
lease before constructing a FileKernel. A contender returns without constructing a second kernel.
Private state must be outside the writable workspace. The host generates an independent random
connection credential; it is not a provider credential and never enters the run index or guest.
The schema-2 credential record includes wire, artifact, effective operator-policy identity,
account/workspace namespace, host generation,
machine, endpoint and diagnostic PID. Discovery is a hint: an authenticated hello must confirm the
expected workspace and generation before a client can use the connection.

POSIX directories/files require account ownership and shared private modes, canonical paths and
safe parent directories. Windows creates a protected account-only ACL for new state directories and
verifies existing ACLs; it does not infer privacy from POSIX mode bits. Bounded descriptor reads
reject links, special files, changing files and permissive credentials. A connection record is
limited to 16 KiB and the run index to 2 MiB. These checks do not remove the parent-directory TOCTOU
limitation documented in [known issues](../known-issues.md).

The shared lease uses a 30-second stale threshold and five-second heartbeat. Only an `ESRCH` process
probe establishes death; a foreign-machine record or possibly live previous PID prevents replacement,
even if its lease file disappeared. A stale Unix socket is removed only under the acquired lease,
after verifying its private directory and its previous owner's death. No launcher sends a signal to
a PID from discovery. Requests recheck the lease before acquiring operation authority; the process
also polls ownership and shuts down physical work on loss. Discovery is published after index sync
and listener creation, and removed only by its owning generation after physical shutdown.
A discovery record that disappears during its bounded descriptor read is treated as absent:
normal retirement can race a launcher or status probe. Other I/O, privacy and schema failures still
reject; an absent record does not authorize replacing a live lease or replaying an execution.

`connectOrLaunchLocalKernel` takes an absolute installation-selected executable/argv and an operator
environment snapshot. It preserves policy while binding `CLARVIS_HOME` and `CLARVIS_WORKSPACE_ROOT`
to the selected canonical roots. On POSIX, both launcher and child derive endpoint candidates from
that same snapshot: the first non-empty absolute value in `TMPDIR`, `TMP`, `TEMP` order, then `/tmp`.
Relative values are ignored because launcher and child have different working directories. A short
effective temp therefore preserves the existing endpoint, while a temp that would exceed the socket
budget falls back deterministically without changing the environment delivered to runs. Child stdio
is independent of the TUI. Linux/macOS and Windows have explicit detachment policies; `unref`
releases the parent wait. Launch waits at most 30 seconds by default, configurable up to 120 seconds.
It retries discovery/connection without replaying ordinary mutations. A live host with the same wire
and effective operator policy accepts an artifact transition only
through its authenticated local control and only while idle. The new launcher requests restart,
waits for the prior generation to retire, and then starts its selected artifact. Active physical work
refuses the transition and remains owned by the prior process. A wire mismatch still requires the
original compatible installation because the new client cannot assume control-protocol compatibility.
For a same-wire incompatible artifact with active work, the launcher returns the exact prior host
generation as a replacement offer. Only an operator choosing the boot-screen termination action
may authenticate to that generation and call `requestShutdown`. The host closes new admission,
cancels and drains its hosted runs, retires its lease, and preserves their durable history before
the new generation starts. A changed generation or matching artifact refuses that action.
A timeout reports unconfirmed startup. `bin.ts` accepts the strict private `--local-host` bootstrap
mode while preserving ordinary stdio serving. Selecting and retaining the installed artifact is the
application composition's responsibility, not authority supplied over RPC.

Reuse also requires the same resolved operator execution policy. The identity covers the explicit
non-secret loop projection and the enabled/confine/grant tool policy; raw environment values,
credentials, owner and diagnostics are excluded. Equivalent environment spellings compare equally.
Both narrower and wider policy refuse reuse, preserving admitted work and the original generation.
The operator reconnects with the original policy, requests an idle host restart, then launches with
the desired policy. When an idle restart was already requested, the launcher checks that retiring
host through authenticated read-only control and waits for its exit before starting the desired
policy; a live host without that request still refuses the mismatch. The launcher never silently
mutates policy or restarts an active host.
Production: `localKernelPolicyIdentity` in
[policy-identity.ts](../../packages/kernel/src/hosting/policy-identity.ts),
`localHostEndpointRootCandidates` and `resolveLocalHostIdentity` in
[local-state.ts](../../packages/kernel/src/hosting/local-state.ts),
`connectOrLaunchLocalKernel` and `requestLocalHostReplacement` in
[launcher.ts](../../packages/kernel/src/hosting/launcher.ts), and
`serveLocalFileKernel` in [serve-local.ts](../../packages/kernel/src/hosting/serve-local.ts).
Test: [host-policy-identity.test.ts](../../packages/kernel/tests/unit/host-policy-identity.test.ts),
[local-host-state.test.ts](../../packages/kernel/tests/integration/local-host-state.test.ts) for
snapshot precedence and identity stability, and the independent process tests for long-temp fallback,
same-generation reconnection, explicit old-run cancellation before a new generation, changed Sandbox
policy after a requested idle restart, and
preservation of background execution after incompatible tool/default/ceiling reconnect attempts in
[local-host-process.test.ts](../../packages/kernel/tests/integration/local-host-process.test.ts).

The host normally exits after 60 seconds with no clients or physical work. The idle boundary includes
preparation/runs, local activities, maintenance, disconnect cleanup, index commits, and the FileKernel's
execution leases. Pending/running/retry memory jobs also keep it alive. A supported but disabled
workspace memory capability does not keep an idle host alive: only `capability_disabled` with
`MEMORY_NOT_CONFIGURED` means no active memory instance. Other queue inspection failures prevent
automatic retirement; they are not treated as an empty queue.
Production: `memoryKeepsHostAlive` in
[memory-activity.ts](../../packages/kernel/src/hosting/memory-activity.ts). Test:
[host-memory-activity.test.ts](../../packages/kernel/tests/unit/host-memory-activity.test.ts)
covers absent/disabled memory, job states and inspection errors; `retires an idle memory-capable
process with workspace memory disabled` in
[local-host-process.test.ts](../../packages/kernel/tests/integration/local-host-process.test.ts)
verifies process discovery retirement with the real file host.
Closing a client never invokes
the physical host's close. Host shutdown closes the listener, drains/cancels the kernel, then removes
discovery and releases its lease. Durable terminal references and canonical traces/sessions remain.

Production: `resolveLocalHostIdentity`, `acquireLocalHostState` and `readLocalHostConnection` in
[local-state.ts](../../packages/kernel/src/hosting/local-state.ts), private reads/ACL checks in
[private-files.ts](../../packages/kernel/src/hosting/private-files.ts), `serveLocalFileKernel` in
[serve-local.ts](../../packages/kernel/src/hosting/serve-local.ts), and `connectOrLaunchLocalKernel`
in [launcher.ts](../../packages/kernel/src/hosting/launcher.ts), exported by
[bootstrap.ts](../../packages/kernel/src/bootstrap.ts) and used by
[bin.ts](../../packages/kernel/src/bin.ts). Test:
[local-host-state.test.ts](../../packages/kernel/tests/integration/local-host-state.test.ts) verifies
credential privacy, bounded reads, live-owner refusal, concurrent discovery retirement and
lease-fenced writes;
[local-host-lifecycle.test.ts](../../packages/kernel/tests/integration/local-host-lifecycle.test.ts)
exercises authenticated connections, lease loss, idle restart/retirement and failed construction
through the actual process composition in the test process;
[local-host-launcher.test.ts](../../packages/kernel/tests/unit/local-host-launcher.test.ts) verifies
strict argv and explicit platform options;
[local-host-process.test.ts](../../packages/kernel/tests/integration/local-host-process.test.ts)
starts actual separate processes, proves work after the launching peer exits, reconnects to the same
execution/generation, reloads old terminal metadata, and exercises concurrent launch and idle exit.
That process fixture executes the real kernel/loop with MockLLM. It is not a subscription or TUI E2E,
nor evidence of native Windows/macOS qualification or installed-artifact retention.

## Hosted kernel RPC

`KernelClient.hosting` is available only after a handshake advertising the current host generation.
`OPERATIONS.hosting` owns ordinary request encoders, access metadata and dispatch. Admission,
attach and observation controls are special operations in that same catalog. A connection without
an injected hosting service receives `unsupported`; neither a method name nor transport selection
creates execution authority. The host resolver still owns authentication, role and workspace binding.

An attachment request carries a fresh client subscription id. The response contains serializable
metadata and the registry observation id; its handle stays on the host. The connection dispatcher
pumps only that observation, while the registry's sole source pump survives disconnects. The
`hosting.observation` discriminated notification carries frames, pending questions, question
settlement, result, event end and physical/reconciliation closure. Stream end and semantic result
cannot imply physical closure. Control calls target the connection's observation and its captured
controller epoch, so takeover invalidates old controls without transferring a credential.

A pending question is replayed to an attaching observation, so its client can present it again:
`hosting.present` carries the `{ id, presenter }` presentation of one pending elicitation to the
observed handle and answers with that handle's `ElicitationPresentationAck`, whose `remaining_ms` is
the original deadline's remainder — a reattachment never restarts a question's window. A
presentation for an unknown or already-settled id answers `accepted: false`, and a source handle
without `present` answers the same instead of failing. Presenting is an observation control: it never
answers the question and never grants execution authority.

The remote client registers before admission, buffering at most 1,024 notifications/16 MiB until
the reply binds the snapshot cut. It validates execution, workspace and generation and then requires
contiguous sequence intervals after that cut. Tail buffers are also bounded at 1,024 items/16 MiB;
they coalesce through the ordinary event policy and never drop structural events. Malformed wire
data closes the observing connection. Saturation/abandonment retires the observer, not the root.
Client disconnect rejects unfinished observation promises with `unavailable`; it does not synthesize
a failed `RunResult` or automatically retry a start, control mutation or handoff. The registry's
persisted detach receipt remains the recovery path after response loss.

Connections admit at most four observations, including asynchronous preparation, and retain at most
256 subscription identities to reject reuse. Question maps hold at most 64 questions/8 MiB and each
observer channel permits 16 removable callbacks. These bounds complement the shared inbound
framing and outbound notification budgets. Snapshot pages remain independently byte-bounded and
owned by the requesting connection.

Production: `createHostingDispatcher`, `createHostingClient`, `decodeHostedNote` and
`validHostedAttachment` in [hosting-server.ts](../../packages/kernel/src/transport/hosting-server.ts),
[hosting-client.ts](../../packages/kernel/src/transport/hosting-client.ts) and
[hosting-codec.ts](../../packages/kernel/src/transport/hosting-codec.ts), composed by
[server.ts](../../packages/kernel/src/transport/server.ts) and
[client.ts](../../packages/kernel/src/transport/client.ts).
Test: [hosted-transport.test.ts](../../packages/kernel/tests/integration/hosted-transport.test.ts)
exercises the same managed execution over loopback and a real local socket, file-backed snapshots,
notifications before the attach response, sequence corruption, response loss, pending-question
expiry, an on-screen presentation that starts the question's window, a replayed presentation that
reports the remaining time without restarting it, old controls, and completion with zero clients. It uses controlled run work and persistence
ports; it does not establish independent process survival or subscription-provider execution.
[hosting-client.test.ts](../../packages/kernel/tests/component/hosting-client.test.ts) exercises
early/tail saturation, bounded question maps and listeners, late admission replies, and closure
without a reconciled outcome. These failures release observations without cancelling the source or
answering its questions.

## Local operator callbacks

`createLocalHostOperator` scopes browser handoffs to the conversation that initiated them. At most
eight bounded HTTPS requests remain pending, with a fixed deadline of at most five minutes. A
current controller claims a request; another observer or an earlier controller cannot settle it.
Disconnect relinquishes the claim without approving the request. Expiry or host close resolves an
unanswered request as not opened. Opening a browser is separate from provider authorization.

Inspection returns copied process state. The application may publish
bounded, sequenced `runtime_notice` data through `FileRunHost.runtimeNotice`, which is not a guest
RPC operation. The workspace adapter reports that notice to the TUI. Runtime retry and configuration
restart are explicit operator operations; neither inspection nor reconnect triggers them.
After asynchronous authentication, the host rechecks closing/restart state before accepting a peer.

Production: [operator.ts](../../packages/kernel/src/hosting/operator.ts), `resolveConnection` and
`runtimeNotice` in [file-host.ts](../../packages/kernel/src/hosting/file-host.ts), and the application
runtime factory in [local-host.ts](../../packages/code/src/local-host.ts).
Test: [local-host-operator.test.ts](../../packages/kernel/tests/unit/local-host-operator.test.ts)
checks control transfer, disconnect, expiry, bounds and explicit operations;
[file-run-host.test.ts](../../packages/kernel/tests/integration/file-run-host.test.ts) checks
authentication racing restart and bounded operator notices over the local RPC.

## Paths and coupling

`localHostPaths` separates the operator account, data owner, canonical workspace and effective global
root with a fixed-width hash. Discovery credentials, lease and bounded run index belong to private
global state, outside the workspace scratch tree. Projection filenames hash generation and execution
identity; neither id is interpreted as a path component.

Unix socket names use a short account-scoped temporary directory independently of HOME length. The
host supplies an ordered list derived from its launch snapshot, and `localHostPaths` chooses the first
candidate whose complete endpoint fits `UNIX_SOCKET_PATH_BUDGET_BYTES` — 100 UTF-8 bytes, the budget
`unixSocketPathFits` in `packages/paths/src/short-temporaries.ts` also applies to a fixture's reserved
socket; normal composition includes `/tmp` after the
preferred temp. Candidate selection is based only on length. A short but missing, inaccessible,
symlinked, foreign-owned or permissive root still fails closed in the existing transport preparation;
there is no post-bind security fallback. Windows uses its unchanged named-pipe namespace. These
builders do not authenticate peers, create listeners or establish filesystem permissions: callers
must enforce those boundaries before publishing a usable endpoint.

Production: `localHostPaths` in [local-host.ts](../../packages/paths/src/local-host.ts), the snapshot
derivation in [local-state.ts](../../packages/kernel/src/hosting/local-state.ts), and the launcher/host
composition in [launcher.ts](../../packages/kernel/src/hosting/launcher.ts) and
[serve-local.ts](../../packages/kernel/src/hosting/serve-local.ts). Test:
[local-host.test.ts](../../packages/paths/tests/unit/local-host.test.ts) covers deterministic builder
selection and named-pipe spelling;
[local-host-state.test.ts](../../packages/kernel/tests/integration/local-host-state.test.ts) covers
snapshot derivation and discovery validation; and
[local-host-process.test.ts](../../packages/kernel/tests/integration/local-host-process.test.ts)
launches a separate POSIX host with long temp values, completes authenticated hello and reconnects to
the same generation. CI on Windows retains named-pipe coverage; the process fallback is POSIX-only.

`protocol` owns the DTOs and has no runtime dependency. `kernel` implements storage using `paths`
and the ordinary run event policy; it does not import Code or the TUI. The canonical terminal run
and conversation histories remain governed by [kernel runs](kernel-runs.md) and
[sessions](sessions.md). Adding a service implementation must preserve those ownership contracts.

A Goal stage with a persistent completion snapshot race closes with `goal_finalization_conflict`.
The host persists `finalization_conflict` and uses its existing successor admission after physical
settlement. Current authority and limits remain mandatory; no old completion verdict is reused.
Production: `goalStageOutcome` in [settlement.ts](../../packages/kernel/src/goals/settlement.ts) and
`prepareHostedGoalTurn` in [hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts).
Test: `settles a concurrent completion conflict and verifies a fresh candidate in one successor`
in [goal-hosted-continuation.test.ts](../../packages/kernel/tests/integration/goal-hosted-continuation.test.ts).

## Durable operator submissions

A response deadline does not retire a pending admission. While its original authenticated controller
remains valid, the registry retains the same per-session operation after returning
`submission: recovering`; physical settlement of the predecessor wakes that operation automatically.
Repeated submissions of the same identity share it and cannot admit another successor. Authority is
rechecked before preparation and admission; disconnect or takeover abandons that in-memory operation
without removing its durable receipt. This wakeup does not restore permissions or dispatch accepted
inputs after a host restart.

Production: `startOperator` and its `awaitSubmission` boundary in
[registry.ts](../../packages/kernel/src/hosting/registry.ts).
Test: `retains an operator submission while a previous execution settles, bounded by its wait` and
`retiring the controller fences a submission retained beyond its response deadline` in
[hosted-registry.test.ts](../../packages/kernel/tests/component/hosted-registry.test.ts).

Public hosted submission defaults to operator intent after authentication; host-created successors
explicitly carry automatic intent and their continuation authority. `startOperator` persists authenticated input using `acceptOperator` before awaiting prior physical
closure. The private session owns at most sixteen pending submissions and a bounded admitted audit,
with a monotonic `operator_sequence`; accepted messages are not executed turns. Same-identity
replays validate the fingerprint and reattach. Preparation reads the current conversation revision
and predecessor, while automatic requests retain their revision checks. New operator input retires
pending continuation authority and suspends active Goal automation. A foreign controller still
requires explicit takeover. Session mutations use one bounded serialized lane per conversation.

Steering carries a correlation identity independent of its text. `createHostedExecution` records
`steering_applied` before `deliverOperator` durably acknowledges consumption. Concurrent delivery of
one identity shares its operation. A refusal before the source consumes steering retains the input
and starts a successor only after the predecessor's physical and publication barriers. Unknown old
physical work retains pending input and requires the existing generation-fenced recovery operation.
During startup synchronization, the host also discovers target-bound accepted receipts with a
matching canonical `steering_applied` event, including when the prior pump never published its
delivery checkpoint. Discovery persists a ready record before invoking the existing bounded
receipt recovery. A lookup failure stays scoped to that execution; no trace, absent event or missing
reader proves consumption. Canonical input remains retained. No steering/model/tool call is replayed,
and discovery does not release physical uncertainty. This is receipt recovery, not admission of
unconsumed input under a recreated controller.

Production: `discoverDeliveries` in [sessions.ts](../../packages/kernel/src/hosting/sessions.ts)
and `createHostedRegistry` in [registry.ts](../../packages/kernel/src/hosting/registry.ts), wired by
`createFileRunHost` in [file-host.ts](../../packages/kernel/src/hosting/file-host.ts).
Test: `discovers a lost steering checkpoint after restart and reconciles without replay` in
[hosted-recovery.test.ts](../../packages/kernel/tests/component/hosted-recovery.test.ts).

New steering receipts persist the host-selected `steering_target` before sending to the source.
Reconciliation reads only that destination; unavailable unrelated history cannot block it. An
acknowledgement naming another execution is refused, and reusing the submission identity cannot
change its target. No client argument selects this field. Receipts without a bound destination use
the conservative unbound search: `prepareOperator` searches every recorded execution, newest first,
retaining only one trace at a time. A matching `steering_applied` proves consumption even if another
trace is unavailable. Absence proves non-consumption only after every inspected trace is intact and
terminal. Missing readers/records, live executions and salvaged records keep the steering pending
with `submission: recovering`; independent ordinary input is not included in that wait. Another
lookup may recover when the dependency becomes available, without repeating the original effect.
Production: `prepareOperator` in [sessions.ts](../../packages/kernel/src/hosting/sessions.ts).
Test: `restart scopes steering reconciliation to its persisted destination, consumed: %s`,
`retains steering when canonical history is %s and retries only the lookup` and
`finds steering consumption older than sixteen turns despite a missing newer trace` in
[hosted-sessions.test.ts](../../packages/kernel/tests/integration/hosted-sessions.test.ts).

Production: `startOperator` and the observation controls in
[registry.ts](../../packages/kernel/src/hosting/registry.ts), `acceptOperator`, `prepareOperator` and
`deliverOperator` in [sessions.ts](../../packages/kernel/src/hosting/sessions.ts), and the source
pump in [execution.ts](../../packages/kernel/src/hosting/execution.ts).
Test: priority, stale revision, duplicate replay and steering cases in
[goal-operator-recovery.test.ts](../../packages/kernel/tests/integration/goal-operator-recovery.test.ts).

Compatible pending ordinary messages are combined in acceptance order during preparation. Each
retains its own receipt with `delivered_to` naming the single admitted execution. A replay of a grouped
member identifies that execution in its admitted-submission receipt. The physical/publication wait is bounded; timeout retains input and
returns actionable recovery rather than silently dropping it. Steering completion waits for its
durable consumption acknowledgement, not merely the source queue acknowledgement.
Production: `createHostedSessionCoordinator` and `startOperator` in the sources above.
Test: the queued-input integration case in
[goal-operator-recovery.test.ts](../../packages/kernel/tests/integration/goal-operator-recovery.test.ts).

`HostingService.resumePending(sessionId)` asks the host to read its canonical unconsumed operator
receipts and requeue them under the current authenticated operator connection. It accepts no message
body or receipt list from the client. Repeated calls use the existing idempotent per-session admission
queue; consumption, physical closure, current policy and controller ownership are revalidated.
Observers cannot invoke it, and it neither takes over another controller nor restores old consent.
It returns an admitted run or null when no input is pending; unavailable dependencies leave receipts
retained. Headless restart without a new authenticated controller still waits for that authority.

Production: `pendingOperators` in [sessions.ts](../../packages/kernel/src/hosting/sessions.ts),
`resumePending` in [registry.ts](../../packages/kernel/src/hosting/registry.ts),
`OPERATIONS.hosting.resumePending` in [operations.ts](../../packages/kernel/src/transport/operations.ts).
Test: `requeues canonical pending input on a fresh operator connection without duplicate admission`
in [hosted-registry.test.ts](../../packages/kernel/tests/component/hosted-registry.test.ts), and
`restart scopes steering reconciliation to its persisted destination, consumed: %s` in
[hosted-sessions.test.ts](../../packages/kernel/tests/integration/hosted-sessions.test.ts).

Non-final Goal preparation is recorded after physical closure and before turn publication. Missing
preparation leaves recovery pending rather than inferring complete usage from the loop's aggregate.
A lost session-write acknowledgement is resolved by the committed turn, without charging again.
Production: `prepareGoalSettlement` in [execution.ts](../../packages/goal/src/execution.ts),
`createGoalStageSettlement` in [hosted-turn.ts](../../packages/kernel/src/goals/hosted-turn.ts), and
`recoverSettlement` in [sessions.ts](../../packages/kernel/src/hosting/sessions.ts).
Test: `recovers prepared Goal settlement after a lost write acknowledgement without losing usage gaps`
in [hosted-sessions.test.ts](../../packages/kernel/tests/integration/hosted-sessions.test.ts).

Process-loss qualification includes the boundary after non-final Goal settlement preparation is
persisted. Two fresh host generations consume that preparation without another execution, retain
partial-usage gaps and unknown activity, and publish one closed turn without a completion verdict.
Production: `recoverSettlement` in [sessions.ts](../../packages/kernel/src/hosting/sessions.ts)
and `recoverGoalSettlementSession` in [settlement.ts](../../packages/kernel/src/goals/settlement.ts).
Test: `physical process loss after goal_prepared recovers canonical bookkeeping` in
[hosted-settlement-crash.test.ts](../../packages/kernel/tests/integration/hosted-settlement-crash.test.ts),
using the subprocess fixture in
[hosted-settlement-crash.ts](../../packages/kernel/tests/fixtures/hosted-settlement-crash.ts).
