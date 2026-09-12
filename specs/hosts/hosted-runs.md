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

Production: `HostedRunRef`, `HostedRunAttachment`, `HostedRunReceipt` and `HostingService` in
[hosting.ts](../../packages/protocol/src/hosting.ts). The concrete kernel RPC and its IPC adapters
remain owned by [kernel transport](kernel-transport.md); the guest's private execution RPC remains
owned by [isolated agent runtime](isolated-agent-runtime.md).

## Code integration

Host-started goal stages use `RunHost.synchronizeGoal` in the already selected conversation.
This path must not call session-switch teardown or retire controller authority. Its painted-turn
cursor is independent of canonical metadata, which may already contain a following stage. Closed
stages are reconstructed from persisted history; live stages attach through normal hosted
observation. Delayed reads revalidate the conversation generation before painting or attaching.
Production: `goalBinding`, `prepareGoalConversation` and `synchronizeGoal` in
[run-host.ts](../../packages/code/src/run-host.ts), connected by
[runtime.tsx](../../packages/code/src/runtime.tsx).
Test: automatic-stage and delayed-goal-read cases in
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts).

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

`/background` requests a durable handoff for the selected run and exits only after its receipt.
Uncertain handoff remains visible and consults the same operation receipt instead of replaying start.
A draft received during handoff keeps the TUI open even after the run has entered background.
The exit path restores the terminal and prints the execution identity; it bypasses checkout removal.

Opening a workspace offers runs with `continue` policy after first paint, unless a draft, active run
or blocking interaction already owns the TUI. `/background list` makes discovery available later.
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

The observed run's confirmed `continue` policy is projected through `RunHost.continuesOnExit`.
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

## Limits and failures

Preparation failures are projected to plain `{code, message}` DTOs before entering the index;
messages use the shared error sanitizer. Exception prototypes, stacks and diagnostic details do not
become persisted run results or invalidate the index used by subsequent admissions.

Production: `createHostedRegistry` in [registry.ts](../../packages/kernel/src/hosting/registry.ts).
Test: `persists a plain sanitized preparation error without poisoning later admissions` in
[hosted-registry.test.ts](../../packages/kernel/tests/component/hosted-registry.test.ts).

Clients use `readHostedSnapshot` to consume the immutable prefix without retaining another complete
history. The decoder uses the live RPC event codec, handles split UTF-8/records, bounds each page to
1 MiB and total bytes to 64 MiB, and checks offsets, canonical base64, contiguous sequence intervals
and the final cursor. Corruption is explicit and never echoes the invalid payload. Completion or
early iterator return releases the snapshot; a failed release is observed separately.

Production: `readHostedSnapshot` in
[hosted-snapshot.ts](../../packages/kernel/src/transport/hosted-snapshot.ts), exported by
[index.ts](../../packages/kernel/src/index.ts). Test:
[hosted-snapshot.test.ts](../../packages/kernel/tests/unit/hosted-snapshot.test.ts) covers split
Unicode, coalesced intervals, abandoned readers, malformed records/pages, limits and empty cuts.

| Resource | Default | Failure |
| --- | --- | --- |
| Encoded observation history | 64 MiB per projection | Recovery becomes unavailable; further appends and snapshots fail |
| Outstanding snapshots | 4 per projection | A new snapshot is refused without evicting an existing reader |
| Snapshot lifetime | 120 seconds | Expired ids return `not_found`; a caller must obtain another snapshot |
| Queued storage operations | 32 | Refused before another queued operation is allocated |
| Queued input/read bytes | 16 MiB | Refused before another payload is retained by the queue |

All configurable bounds are positive safe integers. A storage or quota failure is sticky: it cannot
become a successful handoff by trying another append. Existing complete prefixes remain readable
after an append failure. A short read is corruption and also prevents new snapshots. Structural
history is never silently dropped to satisfy a quota. Closing drains accepted work and closes the
file without deleting historical bytes; new operations after close fail with `unavailable`.

Production: `createHostedProjection` and its `enqueue`, `flush` and `assertHealthy` boundaries in
[projection.ts](../../packages/kernel/src/hosting/projection.ts). Test: the snapshot expiry, storage
failure, quota, queue saturation and truncated-read cases in
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
the epoch and revokes the previous conversation's consent without revoking unrelated conversations.
Controls carrying an earlier epoch are refused.

A consent scope survives consecutive turns in the same live conversation instance. `closeSession`
retires it on switch/resume, and `disconnect` retires every scope of that connection. A later instance
receives a fresh scope. At most 64 conversation scopes are retained per connection. Even when the
revocation callback fails, a disconnected peer and its controls become unusable before that error is
reported; all scopes are attempted. The concrete guard/configuration policy supplies this callback.

Native Host/Sandbox command approval consults the live scope on every check. Answers received after
that scope retires deny even when the old dialog selected one-time approval. Human fallback answers
are not cached by effect review. Container guests receive no guard or approval bridge. Production:
`createGuardHumanApproval` in [human-approval.ts](../../packages/kernel/src/guard/human-approval.ts)
and `createLocalContainerRuntime` in
[local-container-runtime.ts](../../packages/kernel/src/runtime/local-container-runtime.ts). Test:
[guard.test.ts](../../packages/kernel/tests/unit/guard.test.ts) and
[runtime-guest-loop.test.ts](../../packages/kernel/tests/integration/runtime-guest-loop.test.ts).

Production: `createHostedAdmission`, `HostedAdmission` and `HostedControl` in
[admission.ts](../../packages/kernel/src/hosting/admission.ts). Test: the reservation/disconnect,
forged-peer, takeover, conversation-resume, independent-limit and revocation-failure cases in
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

Only a successful checkpoint with physical closure, event drainage, canonical reconciliation,
terminal index commit and admission release reaches continuation preparation. A pending or failed
barrier prevents it. Read-only continuation preparation and its stop notification each have a
five-second default deadline. Late results cannot start work after timeout or revocation. The
host policy must still revalidate its durable revisions during ordinary intent commit and start.

Disconnect, conversation close, takeover and background handoff revoke future control without
granting physical release. Revocation notifies the host policy immediately, even while the current
stage is running. A new human reservation supersedes pending automatic work; it is distinguished
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
holds physical closure and durable barriers separately and covers two automatic successors,
human/disconnect/takeover races, foreign proposals and bounded late preparation.

### Physical execution and observation

Goal user controls also hold a `HostedConversationAuthority` between stages. It belongs to one
registered operator peer and cannot be forged from its visible fields. Physical release retains
this proof; disconnect, close and takeover revoke it. A different peer must explicitly take over,
including while the goal is physically idle. Old proof cleanup cannot retire a newer controller.
`startControlled` and `cancelControlled` are host-only registry methods using this proof and the
existing start/cancel machinery. They cannot target another session or bypass physical exclusion.
The proof crosses preparation only through the private host context. Process-owned start admission
also applies to automatic starts, and pending continuations/goal controls prevent maintenance.
Production: `claimConversation`, `assertConversation` and `releaseConversation` in
[admission.ts](../../packages/kernel/src/hosting/admission.ts), and the controlled start methods in
[registry.ts](../../packages/kernel/src/hosting/registry.ts).
Test: `keeps conversation control between stages and requires explicit takeover` and
`physical takeover retires old goal control without releasing occupancy` in
[hosted-admission.test.ts](../../packages/kernel/tests/unit/hosted-admission.test.ts), and
[file-run-host.test.ts](../../packages/kernel/tests/integration/file-run-host.test.ts).

`createHostedExecution` immediately consumes one managed `RunHandle`. That source consumer survives
zero subscribers, an abandoned iterator and a saturated observer. Each observer defaults to 1,024
buffered items and 16 MiB, with at most four observers per execution. Events coalesce without loss;
structural saturation retires only that observer. The execution continues draining into its projection.

Observation registers its subscriber before requesting a snapshot cut. It excludes events through
that cursor, and coalescing cannot join items across the cut. Source sequences therefore cover an
immutable prefix followed by a contiguous tail, including when new events arrive during snapshot
sync. Completed runs can still issue snapshots until the registry disposes their retained projection.

The pump registers one question observer and one settlement observer. Expired/answered questions
leave its pending map, and responding to such an id fails with `not_found`. Repeated attaches do not
register another callback on the source handle. Subscriber callbacks are removable and bounded.

Semantic `done`, source event end, physical `closed` and host reconciliation are independent. The
execution's `settled` promise also awaits its owner's `commitTerminal` transaction. Successful
subscriber `closed` and `terminalCommitted` mean reconciliation, durable terminal discovery and
admission release have finished. Until then the reference remains `finishing`; neither semantic
`done` nor physical exit alone permits reuse. A reconciliation or terminal commit failure rejects
subscriber closure and reports unknown/recovery state while keeping the conversation occupied. Closing an observation is not physical completion. A storage failure retires observers,
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
prompts or live consent scopes enter that index. Acknowledged terminal entries are reclaimed only
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
become `unknown` with `recovery_error`. The affected conversation remains occupied for mutation and
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

### Explicit operator recovery

`HostingService.resolveRecovery` accepts only an authenticated operator, an old execution's exact
generation and revision, and `physical_work_stopped: true`. The operator must first verify that all
processes and containers belonging to the old work have stopped. A missing host record or dead host
PID alone does not establish this. The host records an operator attestation; it does not independently
prove process closure or remote side effects. Current-generation executions, live occupancy, missing
confirmation and stale revisions are refused. Guest capabilities do not expose this operation.

`archiveRecovery` first commits a `HostedRecoveryResolution` on the canonical session turn. The
receipt names the old and resolving generations, the authenticated connection and the verification
time. An unfinished turn becomes `interrupted`; known terminal status and usage remain intact, and
no execution end time or run result is invented. If intent never reached the session, a transcript
audit turn records its identity. That conversation is archived: later model admission requires a
new conversation, preserving history without replaying uncertain actions. Metadata reads, export
and explicit deletion retain their ordinary contracts.

Only after the session audit is durable does the registry commit the discovery row as physically
`closed`, retaining any already known outcome and recovery error. It then releases unresolved
physical occupancy. If either write fails, the row remains unresolved; a retry reuses a previously
committed session audit. Concurrent confirmations share one operation. Host shutdown awaits that
operation. Ordinary acknowledgement may now remove the discovery row and private observation
projection while the session audit remains. These archived records therefore do not exhaust the
retained-run index. Maintenance still requires every live run/activity and remaining unknown
physical execution to be absent.

Production: `resolveRecovery` in [registry.ts](../../packages/kernel/src/hosting/registry.ts),
`archiveRecovery` and archived-conversation admission in
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

## File kernel composition

`createFileRunHost` owns one FileKernel and one registry across connections. Its bootstrap caller
must supply the host generation, durable index/projection operations and a token verifier; RPC
parameters cannot select them. A successful hello binds the configured workspace and an operator or
observer role; a supplied workspace selector must match that workspace's id or canonical path.
Operator authority and machine-local application controls are separate. The bootstrap may set
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
authentication, observer restrictions and native configuration revocation. This is not evidence of
a surviving child process, a subscription provider, or a TUI journey.

`serveRemoteFileKernelOverStdio` composes that same file host for one process-owned authenticated
channel. The launcher that owns the channel must establish machine and user authority before the
process starts, for example through SSH. The stdio process therefore binds its sole peer as the
operator, fixes owner and canonical workspace from server-side inputs, sets
`exposeLocalControls: false`, and publishes neither a listener nor a Clarvis connection credential.
Its hosted capability may expose the server-owned `default_owner` needed by an application client;
the client must not derive that namespace with path rules from another operating system.
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
resurrected by its prepared start. Native configuration skips ordinary profile assembly, identifies
the shipped configuration skill, requires fresh interactive consent and remains non-detachable.

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
to the selected canonical roots. Child stdio is independent of the TUI. Linux/macOS and Windows have
explicit detachment policies; `unref` releases the parent wait. Launch waits at most 30 seconds by
default, configurable up to 120 seconds. It retries discovery/connection without replaying ordinary
mutations. A live host with the same wire and effective operator policy accepts an artifact transition only
through its authenticated local control and only while idle. The new launcher requests restart,
waits for the prior generation to retire, and then starts its selected artifact. Active physical work
refuses the transition and remains owned by the prior process. A wire mismatch still requires the
original compatible installation because the new client cannot assume control-protocol compatibility.
A timeout reports unconfirmed startup. `bin.ts` accepts the strict private `--local-host` bootstrap
mode while preserving ordinary stdio serving. Selecting and retaining the installed artifact is the
application composition's responsibility, not authority supplied over RPC.

Reuse also requires the same resolved operator execution policy. The identity covers the explicit
non-secret loop projection and the enabled/confine/grant tool policy; raw environment values,
credentials, owner and diagnostics are excluded. Equivalent environment spellings compare equally.
Both narrower and wider policy refuse reuse, preserving admitted work and the original generation.
The operator reconnects with the original policy, requests an idle host restart, then launches with
the desired policy. The launcher never silently mutates policy or restarts an active host.
Production: `localKernelPolicyIdentity` in
[policy-identity.ts](../../packages/kernel/src/hosting/policy-identity.ts),
`connectOrLaunchLocalKernel` in [launcher.ts](../../packages/kernel/src/hosting/launcher.ts), and
`serveLocalFileKernel` in [serve-local.ts](../../packages/kernel/src/hosting/serve-local.ts).
Test: [host-policy-identity.test.ts](../../packages/kernel/tests/unit/host-policy-identity.test.ts)
and the independent process test that preserves its background execution after incompatible
tool/default/ceiling reconnect attempts in
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
expiry, old controls, and completion with zero clients. It uses controlled run work and persistence
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

Inspection returns copied process state. Application-owned Docker recipe preparation publishes
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

Unix socket names use a short operator-scoped temporary directory, independently of HOME length, and
reject endpoint paths exceeding 100 UTF-8 bytes. Windows uses its named-pipe namespace. These builders
do not authenticate peers, create listeners or establish filesystem permissions: callers must enforce
those boundaries before publishing a usable endpoint.

Production: `localHostPaths` in [local-host.ts](../../packages/paths/src/local-host.ts). Test:
[local-host.test.ts](../../packages/paths/tests/unit/local-host.test.ts) covers identity separation,
hostile ids, long global paths, named-pipe spelling and excessive temporary path lengths. These are
deterministic builder tests, not native Windows/macOS listener qualification.

`protocol` owns the DTOs and has no runtime dependency. `kernel` implements storage using `paths`
and the ordinary run event policy; it does not import Code or the TUI. The canonical terminal run
and conversation histories remain governed by [kernel runs](kernel-runs.md) and
[sessions](sessions.md). Adding a service implementation must preserve those ownership contracts.
