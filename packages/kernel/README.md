# `@clarvis/kernel`

The in-process implementation of `@clarvis/protocol` over `@clarvis/loop`.
It is the Clarvis server core: applications can use it directly or consume the same typed services
through its RPC transports, including the independently owned local workspace host.
`KernelClient.changes` is a VCS-agnostic read-only inventory of the bound workspace; the first
adapter is Git and never writes to the repository.

`@clarvis/code` uses this package as its backend, and it is the only backend.

Workspace dependencies: `@clarvis/protocol` (the contract it implements), `@clarvis/loop` (the engine),
`@clarvis/capability`, `@clarvis/goal`, `@clarvis/mcp-client`, `@clarvis/memory`, `@clarvis/paths`, `@clarvis/plan`, `@clarvis/skills`,
`@clarvis/tools`, `@clarvis/trace` and `@clarvis/workflows`. It injects
host-owned capabilities into runs, so the engine never imports those product layers.
Clients remain independent of the engine through seven deliberately bounded public entrypoints. Each
public symbol has one thematic owner; the root is not a compatibility barrel for lower packages.

| Entry                         | Responsibility                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@clarvis/kernel`             | in-process kernel, kernel services/errors, client/server/transports and wire metadata                                         |
| `@clarvis/kernel/bootstrap`   | file-backed construction, authenticated local host/launcher, owner-scoped stores, stdio hosting, bootstrap logger/environment |
| `@clarvis/kernel/config`      | config stores/schemas, agents, models, plugins, workflows and settings composition                                            |
| `@clarvis/kernel/policy`      | sanitization, tool identity, event mapping/policy/spans and ingest state                                                      |
| `@clarvis/kernel/local`       | shell/process/executable helpers and local filesystem/git adapters                                                            |
| `@clarvis/kernel/logger`      | logger constructor and types without loading file-kernel bootstrap                                                            |
| `@clarvis/kernel/system-docs` | verified publication of the product-owned Markdown skill for installers and source launchers                                  |

> Private, unversioned workspace. The root manifest owns the Clarvis product version; this package
> may change during the beta period.

## Contract

`createFileKernel` reconciles the product-owned `clarvis-docs` Markdown tree in the resolved global
Clarvis skills directory before capturing the skill catalog. `reconcileSystemDocs` verifies a
portable release's listed Markdown hashes or reads the current source checkout, then publishes a
complete revision only into the owned `.system/clarvis-docs` subtree. An unsafe or unowned target
leaves user content untouched and makes this optional guide unavailable. The host supplies its
active product root explicitly to bundled kernels; a package-local Kernel module derives its
checkout from the package identity without naming an output directory.
`createSystemDocsProvider` keeps body and resource bytes stable for an
active host generation. See [self-configuration](../../specs/hosts/self-configuration.md) and
[skills](../../specs/execution/skills.md).

Steering acceptance persists the host-selected destination in its receipt before source delivery.
After restart, consumption reconciliation reads that destination instead of depending on unrelated
historical traces. Missing destination evidence remains uncertain; mismatched acknowledgements or
attempts to rebind the identity are refused. Startup discovers proven consumption even when the
previous pump lost its delivery checkpoint, then uses the existing persisted receipt recovery.
Discovery failure stays local and never replays steering or releases uncertain physical work.

Accepted operator submissions continue waiting in the existing per-session admission operation after
the response deadline. Once the predecessor physically settles, the same live controller can admit
the pending turn automatically; duplicate requests share that operation. Disconnect or takeover
revokes its authority while preserving the durable input for reconciliation. This does not restore
interactive grants or dispatch pending inputs across host generations.

After restart, a persisted physical-closure checkpoint and terminal outcome can repair a missing
ordinary conversation settlement. The session transaction records status and usage once, then the
registry commits terminal discovery before releasing occupancy. It never starts inference or restores
a previous controller. Non-final Goal stages additionally require the domain's persisted
`settlement_preparation`, written after physical closure with the host's usage and activity
measurement. Recovery uses the Goal reducer and charges its usage once, preserving gaps. Final Goal
completion, unfinished guided creation, transcript digests and custom settlement callbacks retain
their validation owner; restart alone cannot approve those outcomes.
Persisted future recovery instants do not hold startup synchronization open. The registry keeps one
cancellable wakeup into the same coalesced sync operation; eligible records resume without another
operator message. Independent records recover immediately, and closing the host cancels future work.
External waits are not polled automatically or given a fresh attempt allowance.

The projection file writer retries classified transient positional writes and file/directory syncs
at most three times. Repeating identical bytes at the same offset preserves event sequences and
immutable snapshots. Creation, closure, capacity failures and unclassified errors are not retried;
exhaustion remains an explicit projection failure. Recovery-index checkpoint retries likewise repeat
only persistence, including steering receipt registration/removal, never the operation being recorded.

Synced steering consumption has a private recovery receipt in the existing host index before the
canonical session acknowledgement is attempted. Classified transient acknowledgement failures retry
up to three times without re-steering or cancelling the live source. Restart retains the attempt
count and only reconciles that receipt; it does not restore execution authority. Exhaustion retains
an explicit wait and prevents terminal settlement and retention cleanup until reconciliation.
A matching canonical receipt can resolve a lost acknowledgement even after retry exhaustion.
An unavailable recovery checkpoint remains an authoritative persistence failure.
A permanent steering-proof lookup failure also persists a local wait without attempting a receipt
write or interrupting other sessions. Matching canonical proof can later resolve that wait.
Canonical settlement-proof reads share the persisted repair attempt allowance. A failing session
cannot stop recovery of unrelated sessions. Once exhausted, each synchronization may inspect fresh
proof once without rearming writes; a recovered terminal receipt can finish reconciliation.

Pending steering reconciliation inspects every recorded conversation execution, one trace at a
time. A matching host receipt confirms consumption even when another trace is missing. Missing,
live or salvaged history cannot establish non-consumption: the affected intent stays pending with
`submission: recovering`, while independent operator input remains available. A later lookup can
recover without replaying the steering message or starting another execution.

A persistent completion snapshot race is classified as `finalization_conflict`, separately from
unreadable or revoked Goal control. Physical settlement can admit one bounded successor under current
authority and remaining limits, preserving semantic progress tolerance. The successor retains prior
context and must verify current proof with a new candidate; no completion or tool retry is inferred.

Goal catalog reads isolate classified evidence capacity/conflict failures from authority reads.
The host revalidates the binding after the catalog attempt and reports `evidence_unavailable`;
the next read retries the catalog. Completion and evidence-dependent writes remain fail-closed.
Conflicting Goal evidence identities invalidate only the ambiguous proof and fence every affected
subject against older successes. Independent receipts remain queryable. Activity affected by an
identity conflict is unknown, with a typed conflict cause; identical replay remains idempotent.
The bounded window retains conflicting variants until journal replay takes over.

Evidence uses a 512-entry live window backed by the existing trace journal. Before replay can
replace the window, it must attest the observed prefix. Candidate references remain pinned through
rotation; later failures invalidate earlier successes. There is no separate evidence database.
Oversized tool arguments, results, diffs and delegated output become unavailable individual receipts;
independent evidence remains usable and truncated payloads never become complete proof.
Unreadable activity is persisted as unknown instead of consuming the semantic no-progress allowance.
This does not replace hosted recovery or relax completion and consumption gates.
See the [Goal contract](../../specs/capabilities/goals.md).

Construction, configuration, runs, and transport are specified in the four kernel specs under the
[`hosts` map](../../specs/README.md#hosts--the-kernel-the-terminal-ui-and-the-http-facade). The
run event mapper forwards live-only `tool_control_released` with no coalescing or dropping so a
connected TUI can remove a settled shell's stop control. The kernel also owns host-side composition described by
[`plugins.md`](../../specs/hosts/plugins.md),
[`extension-profiles.md`](../../specs/hosts/extension-profiles.md),
[`model-catalog.md`](../../specs/hosts/model-catalog.md), and
[`sessions.md`](../../specs/hosts/sessions.md), plus the kernel halves of capability specs named in
their package READMEs. Shared-prompt resolution, workspace trust for `shared-agent.md`, and
independence from agent overlays are specified in
[`agent-system-prompt.md`](../../specs/engine/agent-system-prompt.md).

Operator administration offers synchronous, host-only credential fences: `onSecretChanged`
receives a name after a successful secret-store mutation; subscription `onAuthorityRevoked`
receives a scheme and reason before authority replacement/removal or remote revocation. Disconnect
commits local removal before contacting the provider and preserves a concurrently connected account.
The caller binds these ports to leases; construction alone neither creates a lease nor runs a domain.
See [subscription providers](../../specs/hosts/subscription-providers.md).

## Hosted observation infrastructure

The settings assembler captures effective global and workspace context for the work agent:
`CLARVIS.md`, falling back to `AGENTS.md` independently per scope. Host-only request identity
preserves this snapshot through preparation and workflow admission. Persistent instructions inform
the run but arbitrary request fields cannot replace them. See
[model instructions](../../specs/cross-cutting/model-instructions.md).
Hosted Goal preparation gives the tool-free Steward only the bounded Goal definition and execution
receipts. It has no repository instructions or file-reading context and does not reread context
files during evaluation.

`src/hosting/admission.ts` separates physical conversation occupancy from interactive control and
retires conversation control on disconnect, takeover or conversation close.
`src/hosting/projection.ts` provides bounded append-only observation storage with immutable,
byte-paginated snapshots over private 64 MiB segments, without a default lifetime history quota.
It uses the existing run event coalescer and keeps structural events; append/sync failures prevent
new snapshots, while a snapshot read failure affects only that reader. Logical offsets survive
segment rotation and acknowledgement reclaims the exact segment namespace. `src/hosting/execution.ts` keeps the sole managed-run
consumer alive without subscribers, cuts snapshot/tail observations and waits for physical closure
plus host reconciliation, terminal index commit and admission release before successful observer
closure. Failure of this terminal transaction rejects closure and retains conservative occupancy.
A slow observer loses only its own bounded stream. Projection source writes and observation requests
have independent finite queue allowances, so saturated snapshot readers cannot reject source events;
the shared storage chain retains event and snapshot ordering.
The registry checkpoints settlement phases in its existing private index. Classified transient
storage failures retry at most three times with backoff and jitter; a terminal commit retry does
not rerun reconciliation or cancel an already closed source. Startup can settle terminal discovery
from persisted physical-closure and reconciliation proof, without restoring old control authority.
A pending reconciliation still retains uncertainty. See the
[hosted recovery contract](../../specs/hosts/hosted-runs.md#durable-settlement-recovery).
The root entry's `readHostedSnapshot` incrementally decodes those pages with the live event codec,
checks byte/sequence continuity through the immutable cut and releases the snapshot on abandonment.
`src/hosting/registry.ts` provides shared admission, controller epochs and connection-independent
handoff receipts over injected turn/persistence ports.
An internal continuation policy can admit another stage after the complete terminal barrier, using
authority captured from the actual controller. The policy rules from durable state — a Goal stage's
own closed decision and admission — so the registry no longer requires the predecessor to have been a
successful checkpoint, and a run with no policy stays inert. A proposal may carry the earliest
instant a successor may start; the wait happens abortably outside the short preparation deadline and
the policy is asked again, so only a fresh proposal starts and a retired authority abandons the wait.
That instant is pending only until it elapses: an elapsed one — including the instant a zero backoff
lands on — starts its successor, and admission never refuses a proposal merely for carrying it.
Once the turn's intent is durable, providing this policy also promotes the current physical run to
`disconnect_policy: "continue"`. Losing the interactive controller pauses future Goal admission but
does not cancel useful work already executing; its ordinary settlement remains responsible for the
result and usage.
Its reservation is single-use, preserves the session,
and loses to admitted human work. A run that declares `intent: "operator"` _is_ that human work: the
host admits it as the person's own turn even while a Goal is pending, stopping that Goal's automatic
continuation in the same transaction rather than asking the Goal for permission, and leaves the
Goal's identity, definition, spend and audit intact for an explicit resume. An automatic run, or one
that declared nothing, keeps the Goal's admission rules. Disconnect, conversation close, takeover and background handoff
revoke future authority. Preparation and failure notification are bounded, and a failed continuation
logs the sanitized reason beside the execution identity so the refusal is diagnosable without
payloads; old-stage cleanup cannot
revoke its successor. No public peer or extra observation is synthesized for the automatic stage.
Handoff failures classify their operation identity as refused before admission or uncertain after
admission; receipt absence alone never permits replay. A definite refusal does not consume the
operation identity, allowing clients to retry after resolving its cause.
The existing RPC catalog exposes that registry through an explicitly hosted connection.
Attachment transfers snapshot metadata and subscribes to
sequenced tail, result, elicitation (question and settlement) and physical-closure notifications.
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
Goal start and resume previews include the complete current objective after
`Work toward the persistent goal:`; this display text does not change the model input.
Evidence validation releases the session lock so user controls remain available; the terminal write
rechecks those controls and charges usage once. The host also checks the persisted absolute deadline
before every physical model call. An already-started call may finish and remains chargeable, while
settlement refuses a late completion and records the still-current goal as usage limited. Its
composition test executes an initial stage and
two automatic continuations through the real loop and SDK, retaining the serialized prefix and
agent affinity. A stage that ended with a recoverable failure is continued the same way, from the
durable decision its settlement recorded rather than from the run's physical shape; the guided
creation turn shares that settlement and policy, so a checkpoint or a recoverable ending in the first
stage starts exactly one bounded successor. `createFileRunHost` registers that policy through ordinary immutable run preparation
and exposes connection-scoped `goals` controls over the existing RPC catalog. Creation and resume
persist an operation receipt with the reserved execution ID before the internal hosted start; replay
returns that receipt without another run. Native hosts expose this surface;
headless hosts return explicit unavailability. The IPC integration test
performs creation, checkpoint continuation and completion through the real FileKernel. Code's
`/goal` commands observe these host-owned stages through the same service. Complete local/remote,
real-provider and installed-artifact qualification require separate evidence.
Production: `prepareHostedGoalTurn` and `goalAuthorityMessages` in
[hosted-turn.ts](src/goals/hosted-turn.ts), consumed by `createRunService` in
[run-service.ts](src/runs/run-service.ts). Test: Goal authority cases in
[goal-hosted-continuation.test.ts](tests/integration/goal-hosted-continuation.test.ts) and
[run-service-lifecycle.test.ts](tests/unit/run-service-lifecycle.test.ts).
Guided `/goal <seed>` is admitted as the ordinary conversation turn of the selected main agent.
`prepareHostedGoalCreationTurn` commits a formulating `creation_intent` on the session document and
adds the required `createGoalCreationCapability` only for the host-authenticated typed intent; it
does not start an isolated formulation run, create a hidden conversation, or invoke the Steward
before a Goal is saved. Isolated backends receive the same `goal_intent`. Until durable creation,
dispatch admits proven reads and clarification and refuses writes, shell, unknown tools and
work-executing delegation. The model retains its advertised catalog, and `create_goal` atomically
persists the semantic definition and admits the same execution as its first Goal stage. The
capability then exposes the normal Goal controls and completion gate in that same run. Host identity,
limits, evidence references and operation idempotency remain outside model arguments.

The compatibility `GoalService.formulate` endpoint remains available to older clients, but Code no
longer routes the guided slash command through it. `createGoalCreationPort` owns the session
transaction and `prepareSettlement` closes the bound stage with the ordinary usage ledger.
Production: `prepareHostedGoalCreationTurn` and `createGoalCreationPort` in
[hosted-turn.ts](src/goals/hosted-turn.ts) and [creation-port.ts](src/goals/creation-port.ts),
with capability composition in [run-service.ts](src/runs/run-service.ts). Test: the new hosted
port unit coverage in [goal-creation-port.test.ts](tests/unit/goal-creation-port.test.ts), plus
existing [goal-hosted-continuation.test.ts](tests/integration/goal-hosted-continuation.test.ts).
`createGoalRuntimePort` implements the bound model operations over that private repository. It
revalidates execution/revision after asynchronous evidence reads and again in the short transaction.
Notifications follow successful durable publication; a notification failure does not roll back state.
`createGoalEvidenceSource` derives bounded references from existing tool traces and current artifact
bytes. Tool identity follows the actual trace mapper's flat-name versus qualified-MCP convention;
goal controls and polling never enter the evidence catalog. Shell checks require exit zero even when
transport succeeded, newer contradictory results invalidate older successes, and confined artifact
reads recheck their digest. Qualitative relevance remains model judgment.
Before completion, the host revalidates normative source digests and the current candidate plus
host/human evidence. `createGoalStewardCoordinator` owns one finite read-only evaluation at a time
through `createStewardExecutionRuntime`. It binds the late Plan review port, fences semantic output
and returns internal corrections or a final verdict to the Goal capability. A private result gate
validates the Steward's cited reads and semantic targets before accepting its output, allowing one
corrective nudge within the same evaluation budget; a second invalid result fails closed. Batched
reads remain verifiable from the full-result digest when trace display text is abbreviated.
Observations reserve evaluation slots for completion, and prior observation failures do not
reclassify later inconclusive verdicts. Its private frame is the conversational projection in
`buildStewardConversationFrame`: Goal contract, original operator request, later corrections, the
work agent's explanatory report and any pending question/answer. It does not include raw tool
results, files, evidence catalogs, plan dumps or repository instructions. The Steward assesses
declared evidence; it is not an independent artifact audit. `needs_evidence` returns a specific
question to the same work run through the existing gate. Technical interruption is persisted with a
typed cause rather than left pending, and unknown consumption is its own cause (`usage_unknown`)
rather than a transport fault.
Session accounting and
Goal Steward state settle atomically, separately from the unchanged pursuit allowance. Compatible
evaluations continue their private persisted prefix; observation failure degrades monitoring while
final failure prevents completion.
Production: [runtime-port.ts](src/goals/runtime-port.ts) and
[hosted-turn.ts](src/goals/hosted-turn.ts). Test:
[goal-runtime-port.test.ts](tests/integration/goal-runtime-port.test.ts) and
[goal-hosted-continuation.test.ts](tests/integration/goal-hosted-continuation.test.ts).
The goal capability composition test exercises `get_goal`/`update_goal` with the actual loop, plan,
SDK transport and durable host port under controlled responses. A manually admitted continuation retains its
plan, catalog, cache identity and complete serialized prefix; blocking or refused plan review keeps
pending tasks. This is separate from qualification of the hosting controller and real providers.
The hosted continuation test also pauses while a provider response is pending, settles its checkpoint,
and resumes through the real SDK. A changed goal reminder follows the complete tool exchange, preserving
call/result correlation in the persisted context and subsequent request.
`settleGoalSession` uses the coordinator's host-only settlement callback to persist goal status,
turn closure and confirmed usage together. It also translates the run's own safe terminal code into
the goal domain's closed failure vocabulary, so a stalled stage and an unreadable bound control are
named as themselves in a blocked goal's reason while every other failure keeps the domain's generic
wording; the run's message is never forwarded. Stagnation covers the whole family the engine reports
for repetition without advancement — the loop's unproductive-attempt streak, the doom-loop guard and
the convergence guard on identical results — because naming only one of them would leave the others
reporting a generic failure. An unresolved measurement remains explicit in the goal audit as
`partial` with its gap causes or as `unknown` when no subtotal was observed at all, and the host
charges the confirmed subtotal either way; late measurements update the original binding by
delta — once per revision, including after archival, and never lowering a charged dimension.
`measureGoalRunUsage`
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
of its processes stopped. The host first archives the canonical conversation with
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
catalog version fields their services gate; those values are not the Clarvis product version.
Responses-backed Grok entitled-catalog rows tag `tool_calling` and keep `vision` unless the payload
explicitly omits image input, so persisted model capabilities cannot strip composer images. The
ordinary remote composition uses the unavailable implementation. The authenticated local
`createFileRunHost` composition exposes subscription control only to its operator role.

`createFileKernel` is the single-workspace entrypoint. It derives stable project and workspace
identities directly from Git and owns that canonical workspace until close. There is no project-level
kernel cache, worktree registry, switching transaction, or occupancy lease.

Completed hosted projections unlink their files/segments and prune only an empty generation directory; sibling
projections keep that directory alive and cleanup never treats a directory as a regular file.

As part of that bootstrap, the kernel constructs one planning runtime. The plans capability and
owner-scoped `PlansService` resolve through the exact same `PlanFactory`. It uses the built-in
Markdown store from `planStoreFor`.
The service projects controlled plan fields and preserved extra sections into `PlanDocumentDto`,
alongside canonical Markdown, so clients do not reparse provider storage.

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
`builtin:default` activates the exact plugin references in `enabledPlugins` and applies two-root
standalone-skill discovery; a custom definition is a complete qualified allow-list and never
inherits that builtin activation list. Plugin identity is always `{ scope, source, name }`, where
`source` is `agents` for installed plugins; no same-name install across scopes shadows or
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
construction or delaying a run. The extension-profile manager's `observeSkillCatalog` then polls those paths
asynchronously. Standalone authorship queues a coalesced refresh when the authoring run's model and
tools settle; the later memory-ingest stream grace does not delay the new slash catalog. Other
physical runs still hold their own catalog leases. The host stream lease remains held through
`closed`. Invalid replacements retain the last catalog and its monitors. Root watchers also detect
new skills.
Plugin drift retains its explicit trust boundary. Builtin and custom standalone roots carry exact
`include` lists for the captured generation. New skills authored through file tools are discovered
at the next safe refresh. The builtin default discovers standalone skills without a
separate workspace-trust approval for the skill file alone. If any
packaged skill in a plugin cannot be captured within its bounds, that plugin's entire skill-root
surface is withheld while its independently valid non-skill contributions remain.
`PluginContributions.observeRuntimeFiles` applies the same asynchronous latch to captured
package-local MCP and hook executable files. An explicitly local executable declaration
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
configuration stores, secret storage, model catalogs and engine-to-protocol mapping.

The operator-scoped `StorageService` walks Clarvis-owned roots with entry/depth bounds, reports
logical category totals without exposing persisted content, paths or credential sizes, and applies
only explicitly requested cleanup of stale temporary artifacts and rebuildable cache. A truncated
inventory remains previewable but cannot authorize an apply. Cache cleanup also removes the
intentionally immutable runtime-artifact tree: `removeOwnedTree` restores removal rights only on
real directories owned by the current POSIX user, never traverses links, and refuses unsafe
ownership without elevation or disclosing the local path. Published artifacts keep their read-only
modes outside that bounded cleanup. Production: `createStorageService` in
[`src/storage/storage-service.ts`](src/storage/storage-service.ts), `removeOwnedTree` in
[`src/storage/owned-tree.ts`](src/storage/owned-tree.ts), and `cacheRuntimeArtifact` in
[`src/runtime/runtime-artifact.ts`](src/runtime/runtime-artifact.ts). Test:
[`tests/integration/storage-service.test.ts`](tests/integration/storage-service.test.ts) and
[`tests/unit/runtime-artifact.test.ts`](tests/unit/runtime-artifact.test.ts). Workspace
bootstrap also sweeps inactive workspace spill/run scratch state and repairs recognized spill modes
to `0600` on POSIX.

Installing from Code's focused
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

A symbolic link may contribute an external checkout to a global or workspace `.agents/plugins`
inventory, but Clarvis treats that entry as discovery-only. It does not advertise
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

## Remote-ready transport

The goal facade validates availability, receipts and bounded conversation state on the wire,
including the physical run's session/workspace binding. `goals.subscribe` installs a live
subscription before its acknowledgement; its `goals.change` notification carries the affected
session ID and may include bounded, non-authoritative formulation activity. Consumers reread
canonical state for notifications without that transient activity. Goal writes and physical lifecycle transitions emit
these invalidations without transferring execution authority. Registrations are bounded to eight
per connection and 128 per host, and pending installations are released on disconnect.
See [kernel transport](../../specs/hosts/kernel-transport.md) for response validation and disposal.

Public stdio transport uses a 64 MiB logical JSON limit. Larger-than-frame
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
quiescent restart. These operations belong to the authenticated application channel. Code supplies the companion application's composition.
Preparation failures enter the durable run index as sanitized plain error DTOs, so an invalid
request does not poison later admissions with an unserializable exception object.

Run elicitation is buffered until a client registers `RunHandle.onElicit`.
Questions raised during startup therefore survive the asynchronous
`runs.start` boundary. The same connection pushes `run.elicitation_settled`
(`{ execution_id, elicitation_id }`) when the run retires a question, and the
client then drops a request still sitting in that buffer and reports the
settlement to every `onElicitSettled` observer, so a frontend showing the prompt
removes it without answering an id the kernel already settled.

An interactive frontend declares its question window on the run-creation request
(`elicit_policy.ask_user_window_ms`, carried into the bridge by
`elicitWindowFor`), confirms the question is on screen with `runs.present` and
the hosted `hosting.present`, and keeps the operational `elicit_wait_ms` ceiling
for a question nobody ever presented. Only a request the engine marked
`origin: "model"` with `kind: "ask_user"` receives a window, and only for a
duration a host timer can hold (`MAX_ELICIT_WINDOW_MS`); a relayed MCP
question, a plan or workflow review and the soft-budget ask
keep their existing policies. See
[elicitation](../../specs/cross-cutting/elicitation.md).

`RunHandle.steer` acknowledges a message only after the loop drains it from the run-scoped steering
source. If the run closes first, the pending call rejects with `not_found`; a host can therefore
distinguish applied steering from an accepted-but-undelivered queue entry and restore the user's
input.

`RunHandle.interruptTool` coalesces pending requests into at most 16 token entries, each with one
first-call promise and one shared repeat promise. On acceptance, the first receives `accepted` and
pending repeats receive `already_requested`. A 30-second absolute deadline settles requests still
awaiting a subscriber as `not_running`, but rejects stalled delivered requests as `unavailable`;
repeats do not renew it. Closing the run settles pending requests as `not_running`.
Delivery failures and malformed receipts reject with bounded, sanitized errors, without asserting
that a shell stopped. Timers and queued deliveries
are released on settlement; late responses cannot settle a newer request for the same token.

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

## Control plane and isolation

The kernel provides services for configuration, plugins, secrets, models, provider
authentication, files, memory, plans, workflows, skills, sessions, tasks, storage,
Extension Profiles and runs. These are control-plane APIs rather than model-callable
MCP tools. The tools capability executes shell and file calls under the configured
native sandbox; it offers no per-call escape. Production:
`packages/kernel/src/file-kernel.ts` (`createFileKernel`) and
`packages/tools/src/sandbox.ts` (`sandboxCommand`). Test:
`packages/kernel/tests/integration/file-kernel.test.ts` and
`packages/tools/tests/integration/sandbox.test.ts`. See the
[sandbox contract](../../specs/execution/sandbox.md).

The hosted generation identity includes the effective Sandbox settings and resolved roots, not only
environment flags. Runs use the startup Sandbox snapshot; a settings change that would alter it
requires an idle host restart before another run can use it. Inspection reports host-visible reads,
the selected workspace/write posture and effective network without exposing credential values.
An untrusted workspace cannot weaken an enabled global Sandbox: the host retains its read-only,
network, environment, toolchain and protected-path floor when resolving runs and inspection.
## The settings schema

The kernel publishes exactly one, `kernelSettingsSchema`: the engine's blocks
plus the ones its capability registry contributes: memory, plans, goals, workflows, tasks and
runtime placement.
Registration happens at module load in `config/capability-registry.ts`, **before**
any `settings.json` is read — a block registered afterwards reads as an
unrecognized key.

The strict `goals` block configures creation defaults: `max_net_tokens` optionally overrides the
finite entry budget for the whole objective; `max_auto_continuations` defaults to 8 and
`max_no_progress_stages` to 3, counting closed stages that advanced nothing — including the
recoverable endings a successor may re-evaluate — against the goal's whole recorded activity history.
The field was renamed from `max_no_progress_checkpoints`, and `resolveGoalsSettings` admits and
normalizes the old spelling in memory so a scope that still carries it is not discarded whole.
`deadline_at` is an optional absolute Unix timestamp in
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

`createSettingsRunAssembler` optionally accepts a `modelExecutionResolver`: it checks exact entry,
delegated, vision and explicit reviewer targets against that closed catalog and emits empty
`providers`, keeping transport declarations outside the request. Without this option, native provider declarations
and resolution are preserved.

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

## File-tool configuration

Entry agents use ordinary file tools to edit workspace and global configuration when
allowed by the selected execution environment and OS permissions. The host configuration
service validates known document semantics when it subsequently loads those files. Tool
calls do not use a separate configuration review port. Production:
`packages/tools/src/lib/paths.ts` (`resolveFileToolPath`) and
`packages/kernel/src/config/file-config-store.ts` (`createFileConfigStore`).
See [self-configuration](../../specs/hosts/self-configuration.md).

## The agent fleet ships as data

Clarvis ships five agents — `marshall`, `admiral`, `coder`, `explorer`, `planner` — as TypeScript in
`src/config/builtin-agents/`. They are not templates copied into a user's configuration on first
run: there is no scaffolding step, and a host whose configuration directory is empty already has all
five. That is what lets `@clarvis/code` reach its first prompt, and `@clarvis/server` serve a
request, against a directory nothing has ever written to. `DEFAULT_ENTRY_AGENT` (`marshall`) is what
`createFileKernel` hands the run assembler, so a request naming no agent still resolves.

The two shipped leaders, `marshall` and `admiral`, each declare a 256-iteration soft session limit;
the `coder`, `explorer`, and `planner` children each declare 64 iterations. These power-of-two
limits distinguish lead and child capacity without relying on the former 50-iteration profile cap.

The builtin bodies define roles and the minimum harness handoff contract, not a generic engineering
handbook. Leads act directly unless delegation is explicitly requested under the shared policy:
by the user, an applicable loaded skill, or an agent-instruction file such as `AGENTS.md` or
`CLARVIS.md`. Harness availability alone is not authorization; profile and grant limits still apply.
All five condition instructions on the tools actually exposed, distinguish a delegated
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
[`wire.ts`](src/transport/wire.ts). Hello is
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
`config`, `plugins`, `plan`, `memory`, `tasks`, `trace`, `kernel`.
`CLARVIS_LOG=config=debug` therefore turns one subsystem on without
raising the global level. `createInProcessKernel` takes a `logger` of its own and passes it to the
plugin service, the model catalog and each owner's runs/sessions with `{ owner }` bound.

| Level | `event`                                                        | Fields                                                                                          |
| ----- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
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

The diagnostic properties below are load-bearing:

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
  a TUI owns, and interleaved as non-JSON lines with pino JSON in a host process. Every
  `detachObserved`/`bestEffort` observer now goes through `observationSink(logger, event)`.

**There is no `logging:` settings block, and there will not be one.** Every boot event above happens
before or during the settings read, so a block could not configure the logging of its own rejection.

## Test ownership

The suite is classified by its primary boundary while the architecture migration proceeds:

- `tests/unit/` owns pure mapping, event policy and state-machine decisions,
  prompt-cache configuration, workflow routing policy and other deterministic request projections.
- `tests/component/` owns kernel services and assembly over typed fakes or in-memory collaborators:
  memory, skills, planning and settings-to-run assembly
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

Qualification harnesses are not production kernel roots. The cache and goal live runners construct
their File Kernel with explicit trial globals, workspaces and lock directories; the auth-view
qualification stages disposable configuration and state and admits only the explicitly selected
subscription document. Deterministic kernel tests never establish that live OAuth or an installed
artifact is safe to use.

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

Hosted session preparation persists the leader instance before the first call. The same session and instance fields cross local and SSH connections. `@clarvis/kernel/bootstrap` exposes host subscription manager/adapter construction for bounded transport observation; credentials remain under host authority. Kernel integration tests compose the real plan, loop and SDK through persisted continuation.
For a goal stage, the host observes its provider port directly, including child, compaction and
retry consumption. A pending call, a cancelled call without usage, or an unreported attempt leaves
accounting unknown and prevents continuation. A failed stage with confirmed exhausted goal spend
settles as `budget_limited`, preserving its physical outcome and any measured overrun; newer user
pause/cancel controls still prevail. Missing cache detail alone counts the full input
conservatively. Zero-initialized loop totals cannot override that observation.
The [goal-file-host.test.ts](tests/integration/goal-file-host.test.ts) integration suite exercises IPC, the actual file host, SDK and HTTP
with controlled responses: two automatic continuations with a delegated plan, prefix/identity
preservation, pause/resume, cancellation and absent usage. It is separate from live-provider and installed-artifact qualification.
The companion [plan review test](tests/integration/goal-file-host-plan.test.ts) answers actual IPC
elicitations: approval permits delegated work and two checkpoints; cancellation or requested changes
prevents workspace writes and preserves the unapproved plan even with discard retention.
The [compaction test](tests/integration/goal-file-host-compaction.test.ts) queues compaction through
the active hosted handle. The real SDK summary call is included in goal/session consumption; one
rolling anchor, current goal and plan survive into automatic continuation. SDK requests preserve the
historical prefix before and after the deliberate compaction boundary.
Workflow leaders retain the manager's session identity and use their reserved child execution ID
as their own persisted agent instance. Two leaders of the same profile therefore have distinct
cache keys, separate from the manager, in both direct and prepared host assembly.
The captured SDK requests also cover transport retry, two same-profile children, physical-call
cancellation and the actual indexing pass. Restricting indexing dispatch
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

Goal formulation and Steward executions capture provider usage, including retries, through the
same usage tracker. Once-only auxiliary settlement applies model prices to session cost totals
when usage and cache measurements are known. Partial observation reads do not attest complete
artifacts; completion still requires complete current reads for every cited artifact.
Goal stage settlement prices the host-observed calls. It persists that priced subtotal with the stage measurement and credits
the Session cost total once, beside ordinary run and auxiliary costs. A later measurement revision
credits only the difference.
The file
host loads model prices before recovery and refreshes them before new runs.

The Kernel composes a public trace view for ordinary execution and run services. Internal records
are absent from run lookup, listing, context, compaction, continuation and deletion by ID. Their IDs
remain reserved across the physical store. Native recovery and retention cover both classes.

Operator submissions persist their identity, input and sequence in the existing session before
waiting for physical closure. Repeating an accepted identity reattaches to its execution; it cannot
start a second attempt. Steering consumption is recorded after its observation event is durable;
undelivered steering can become a successor after closure. Ordinary turns expose the previous Goal
as subordinate context and can bind through `attach_goal` without starting another execution.
Manual resume reattaches to a healthy Goal attempt and retains a receipt when old physical work
requires recovery. Explicit recovery retries the same receipt; later controls supersede it.

Compatible queued operator messages share one successor with per-message durable receipts. Physical waits are bounded, and recovered context flags uncertain effects before retrying work.

Accepted pending input can be resumed through `HostingService.resumePending(sessionId)` using the
current authenticated operator connection. The Kernel reads canonical receipts and uses its existing
idempotent admission queue; it restores no old consent or physical-closure claim. Code requests this
when reopening an idle conversation and attaches to the admitted run. Recovery failure leaves the
saved history readable. A restart without a new controller still waits for authority.
