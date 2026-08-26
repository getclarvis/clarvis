# `@clarvis/kernel`

The in-process implementation of `@clarvis/protocol` over `@clarvis/loop`.
It is the Clarvis server core: applications can use it directly today and place
the same services behind a remote transport later.

`@clarvis/code` uses this package as its backend, and it is the only backend.

Workspace dependencies: `@clarvis/protocol` (the contract it implements), `@clarvis/loop` (the engine),
`@clarvis/capability`, `@clarvis/memory`, `@clarvis/paths`, `@clarvis/plan`, `@clarvis/skills`,
`@clarvis/tools`, `@clarvis/trace`, `@clarvis/tasks` and `@clarvis/workflows`. It injects
host-owned capabilities into runs, so the engine never imports those product layers.
Clients remain independent of the engine through five deliberately bounded public entrypoints. Each
public symbol has one thematic owner; the root is not a compatibility barrel for lower packages.

| Entry                       | Responsibility                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `@clarvis/kernel`           | in-process kernel, kernel services/errors, client/server/transports and wire metadata      |
| `@clarvis/kernel/bootstrap` | file-backed construction, owner-scoped stores, stdio hosting, bootstrap logger/environment |
| `@clarvis/kernel/config`    | config stores/schemas, agents, models, plugins, workflows and settings composition         |
| `@clarvis/kernel/policy`    | guard, sanitization, tool identity, event mapping/policy/spans and ingest state            |
| `@clarvis/kernel/local`     | shell/process/executable helpers and local filesystem/git adapters                         |

> Private, unversioned workspace. The root manifest owns the Clarvis product version; this package
> may change during the beta period.

## Contract

Construction, configuration, runs, and transport are specified in the four kernel specs under the
[`hosts` map](../../specs/README.md#hosts--the-kernel-the-terminal-ui-and-the-http-facade). The
kernel also owns host-side composition described by
[`plugins.md`](../../specs/hosts/plugins.md),
[`model-catalog.md`](../../specs/hosts/model-catalog.md), and
[`sessions.md`](../../specs/hosts/sessions.md), plus the kernel halves of capability specs named in
their package READMEs.

## File-backed kernel

`createFileKernel` is the standard local entrypoint. It loads workspace and
global Clarvis configuration, resolves provider secrets, builds loop
dependencies and returns an asynchronous kernel client.

For the local Code host it also owns the complete subscription subsystem described in
[`subscription-providers.md`](../../specs/hosts/subscription-providers.md): reviewed ChatGPT and Grok
registration references, global `subscriptions.json`, bounded device attempts, rotation-safe
refresh, revocation, entitled catalogs, and token-opaque physical request authorities. The project
owner explicitly enables both public-client references for the local product; that is a Clarvis
product decision, not provider endorsement. Synthetic registrations exercise transport behavior in
tests. Provider `user-agent` and ChatGPT `client_version` identity use the same root-owned product
version as the rest of Clarvis. The remote transport always uses the unavailable implementation.

`createFileKernel` is the single-workspace entrypoint. It derives stable project and workspace
identities directly from Git and owns that canonical workspace until close. There is no project-level
kernel cache, worktree registry, switching transaction, or occupancy lease.

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
```

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

Packaged capability services are authorized by installation, enablement and provider selection.
Plugin hooks use a separate exact-definition review store and remain inactive until approved in
`/extensions/hooks`; the kernel does not invent a transitive-code fingerprint for either surface.

Every kernel Git operation that selects a plugin checkout through a clone destination, `cwd`, or `-C`
removes Git's repository-local environment first. A kernel launched by a parent repository's hook
therefore cannot redirect plugin fetch, update, origin, or revision operations through `GIT_DIR`, a
temporary index, work tree, object store, common directory, or local Git config. The generic process
runner does not impose this policy; each Git-owning adapter applies it before invoking the runner.
`GIT_CEILING_DIRECTORIES` is removed as well so a parent cannot stop discovery before the selected
repository root.

Plugin admission is all-or-nothing across every executable contribution. Manifests and declared or
convention hook documents are descriptor-read before JSON parsing with a 2 MiB ceiling; install
records are capped at 64 KiB. The shared plugin-agent limits add bounded depth, directory/entry/file
counts, 256 KiB per file and 8 MiB aggregate source. An excessive manifest, agent tree, hooks
document, install record or skill-directory fanout is surfaced as a plugin error and contributes no
agents, hooks, MCP servers or capability executables. Install-root enumeration is also bounded and
fails explicitly instead of returning a partial catalog.

Plugins may also package a per-skill Plans mode. The kernel applies it only when the skill originates
from the enabled plugin and that plugin is the selected Plans provider; explicit run parameters take
precedence. This lets authoring skills run with Plans off and implementation skills enter review
without a client-side settings workaround.

## Remote-ready transport

The transport layer maps the same kernel services to Clarvis wire methods:

- `createKernelServer` exposes a kernel over a connection.
- `connectKernelClient` builds a remote `KernelClient`.
- `createLoopbackTransport` connects both sides in process.
- `createStdioTransport` and `serveKernelOverStdio` provide stdio framing.
- `serveFileKernelOverStdio` combines a file kernel and stdio server.

The `clarvis-kernel` binary starts the file-backed stdio server. The protocol is
Clarvis's own request/notification contract, not MCP.

Transports may implement `KernelTransport.onClose` to report explicit closure,
EOF or connection errors. Remote clients use this signal to settle active run
streams with `unavailable` instead of leaving `RunHandle.done` pending, and to
settle `RunHandle.closed` so host lifecycle leases cannot remain pinned. The
stdio and loopback transports implement this lifecycle.

Run elicitation is buffered until a client registers `RunHandle.onElicit`.
Questions raised during startup therefore survive the asynchronous
`runs.start` boundary.

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
sessions, tasks, storage and runs — the fourteen `KernelClient` services. These are control-plane APIs rather
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

A resolved judge reports which channel ultimately answered. An `allow` or `deny` is attributed to
the judge; `unsure`, a provider failure, or a malformed response routes to the human channel when
the default `on_unsure: "ask"` policy and an interactive host permit it. Without that channel — or
with `on_unsure: "deny"` — the same inconclusive outcomes still fail closed. Failed and malformed
attempts are not memoized, so fixing a transient provider problem restores automatic review without
restarting the session.

The argv-only `host_vcs` fallback is an ordinary `ask`, not a forced human escalation. Mode `on`
therefore sends it to the human, while a configured mode `auto` judge may allow or deny it under the
same audited answerer rules. The tool remains unavailable when no guard reviewer exists.

The resolver returns the final answer together with its answerer, and the kernel
projects the resulting `tool_call.guard` unchanged to `RunEvent`. This makes the
auto-guard verdict visible after replay rather than leaving it only in audit logs.

## The settings schema

The kernel publishes exactly one, `kernelSettingsSchema`: the engine's blocks
plus the ones its capability registry contributes (today memory, plans, workflows and
tasks).
Registration happens at module load in `config/capability-registry.ts`, **before**
any `settings.json` is read — a block registered afterwards reads as an
unrecognized key.

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

## The agent fleet ships as data

Clarvis ships five agents — `marshall`, `admiral`, `coder`, `explorer`, `planner` — as TypeScript in
`src/config/builtin-agents/`. They are not templates copied into a user's configuration on first
run: there is no scaffolding step, and a host whose configuration directory is empty already has all
five. That is what lets `@clarvis/code` reach its first prompt, and `@clarvis/server` serve a
request, against a directory nothing has ever written to. `DEFAULT_ENTRY_AGENT` (`marshall`) is what
`createFileKernel` hands the run assembler, so a request naming no agent still resolves.

For multi-step or tool-heavy work, the shipped `marshall` prompt requires a short visible update
before the first tool and after meaningful findings or roughly a minute of uninterrupted tool work.
The update and the next tool call stay in the same turn; the rule neither exposes hidden reasoning
nor turns every routine call into narration.

Spawning is independent of planning. Marshall uses `spawn_subagent`, which has no `task_id`, for
bounded independent work including parallel read-only fan-out. It uses `delegate_task` only for an
existing plan task and copies that task's exact required id so the plan can track the return.
Admiral may use the same child-spawn tools for a narrow lookup, while its prompt continues to prefer
workflows and `run_leader` for substantive or reusable orchestration.

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

The internal transport uses clean-break wire contract 2. Hello negotiates the exact version and is
mandatory before every read, control or mutation even for in-process/default-owner connections;
request envelopes reject unknown fields, stdio frames are capped at 8 MiB, and the serialized writer
has bounded count/bytes plus a 30-second stall timeout. `run.result` settles execution independently
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

Executable workflow definitions are resolved separately for every manager run. The kernel starts
with the `audit`, `implement` and `research` definitions exported by `@clarvis/workflows`, then applies
valid global and workspace documents by name. Effective precedence is
`workspace > global > built-in`; a malformed document is logged and leaves the lower-precedence
definition available. The kernel never materializes a built-in as a user-owned file.

A settled run no longer remains leased for the memory indexer's multi-minute retry schedule. Its
event stream waits five idle seconds for the usual immediate terminal notice, renews only within a
15-second absolute window, and hard-caps every override at one minute. The durable memory job keeps
retrying after the stream closes; only the transient client projection is released.

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
- `tests/architecture/` owns static enforcement of the five-entry public surface and the
  cross-package workspace-layout invariant.
- `tests/helpers/` contains executable fixtures only. They run under the repository's pinned Bun
  runtime; the kernel test suite does not require a second language runtime. Helpers are not test
  entrypoints and own no behavior matrix.

`tests/unit/managed-run.test.ts` is the single owner of run-handle buffering, steering, explicit
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
