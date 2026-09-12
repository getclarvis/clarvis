# The Clarvis spec corpus

This corpus specifies what the Clarvis monorepo does and records what has been measured, ruled out,
or tried and reverted.

The findings register that used to sit beside them — `gaps.md`, the cross-cutting list of what the
corpus had left open — is **gone because every item in it was closed.** Nothing
was dropped in the closing. What was a code defect was fixed with a test; what was an unpinned
rule got the test; what genuinely depends on something outside this repository moved into
[`known-issues.md`](known-issues.md), which is where evidence the source cannot supply belongs;
and what a document had simply never described is now described in the document that owns it. Each
resolution is recorded beside the original claim in the owning spec's section 8, struck through
rather than deleted, so the reasoning outlives the finding.

## What this is

These documents specify what each Clarvis subsystem is for, what it publishes, how it behaves, and
the rules that must hold. They are the contract; the code under
`packages/` is what realizes it. One document covers one subsystem, and each names production and
test evidence either in an opening ownership block or beside the claims it supports, so the boundary
travels with the document rather than in a separate plan.

Proposals under `specs/proposals/` are ignored local working documents, not part of the versioned
corpus. Do not commit them or link to them from tracked documentation. Promote durable contracts
into the owning spec without making the local proposal a repository dependency.

The [prompt-cache contract](cross-cutting/prompt-cache.md) owns the kernel's real-SDK composition
tests and their development-only LLM dependency; the generated coupling graph describes runtime
dependencies.

The corpus's one hard rule is that **every non-trivial statement carries checkable source or test
evidence.** Cite a stable repository file and name the relevant symbol, test, or section in prose.
Never encode a source line number or range: unrelated edits make that locator stale without changing
the contract. Evidence is what makes a specification checkable rather than aspirational; a citation
is an invitation to open the current source and verify that the implementation still honours it.

[`known-issues.md`](known-issues.md) sits beside the corpus rather than inside it, because what it
records — CI history, memory soaks, upstream bug numbers, and designs that were tried and reverted —
cannot be written as a requirement or checked against current source alone. That is exactly why it is a
separate document.

## How to read a spec

Every document opens with an H1 naming its subject and carries implementation evidence near the
claim it supports. Most use an opening ownership blockquote; the shorter domain contracts instead
put `Production:` / `Test:` evidence directly in their sections. The recurring section roles are:

| § | Section | What it holds |
| --- | --- | --- |
| 1 | **Purpose** | What the subsystem is for, what problem it solves, and what is deliberately delegated to a sibling document |
| 2 | **Surface** | The exports, ports, tools, settings blocks and wire names it publishes |
| 3 | **Data and formats** | The shapes it persists or exchanges — on-disk documents, schemas, envelopes |
| 4 | **Behavior** | What actually happens at runtime, step by step, with citations |
| 5 | **Invariants** | The rules that must hold, each with a *Production:* citation and a *Test:* citation |
| 6 | **Failure modes and degradation** | What breaks, and what it degrades to rather than failing |
| 7 | **Coupling** | Who it depends on, who depends on it, and where the seams are |
| 8 | **Open questions** | What this document deliberately leaves open, and what the implementation does not settle |

The layouts are not mechanically identical. [`capabilities/tasks-domain.md`](capabilities/tasks-domain.md)
inserts *State model* and shifts its remaining sections to 6–9;
[`hosts/kernel-composition.md`](hosts/kernel-composition.md) and
[`hosts/subscription-providers.md`](hosts/subscription-providers.md) use nine domain-sequenced
sections; [`hosts/storage.md`](hosts/storage.md) keeps its compact six-section contract unnumbered.
Other documents may rename a recurring role, but still keep production and test evidence beside the
contract rather than relying on this index as proof.

**"Open questions"** is a first-class section, not an apology. It records what a document does not
decide, and what the implementation leaves unsettled: a trace kind nothing in the
package emits, so its producer lives in some consumer outside scope; a resolved settings field with
no reader in the package that resolves it; two constants that agree today with no test pinning them
to agree tomorrow; a naming or ordering choice whose reason is stated nowhere. These are
recorded as explicit open questions **instead of** being guessed, which is what keeps the rest of the
document trustworthy. If you know the answer, the entry is where it belongs.

---

## The map

### `foundations/` — the leaves everything else is written against

| Document | Covers | Implemented in |
| --- | --- | --- |
| [`capability.md`](foundations/capability.md) | The four-level capability contract (`Capability` → `RunCapability` → `AgentCapability` → `AgentLoopContribution`), the settings/services/port registries, and the shared run vocabulary of open unions every layer names | `capability` |
| [`paths.md`](foundations/paths.md) | The single owner of `.clarvis`/`.agents` and every path built from them, plus atomic write-then-rename, directory `fsync` and the crash-recoverable local lease | `paths` (+ one `kernel` architecture test) |
| [`supervision.md`](foundations/supervision.md) | The run-scoped child registry two independent spawners share: agent ids, activity buffers, the trace→activity projection, the steer queue and the effective limits | `supervision`, `capability` |
| [`trace.md`](foundations/trace.md) | The split between trace *vocabulary* (which events exist) and trace *implementation* (recording handle, JSON store, crash journal, recovery, retention sweeper) | `trace`, `capability` |
| [`llm.md`](foundations/llm.md) | The provider layer: the AI-SDK adapter behind the `LLMProvider` port, the decorator stack (cache/logging/retry/admission), the error classifier, bounded transport and the two-entry lazy split | `llm`, `capability` |
| [`mcp-client.md`](foundations/mcp-client.md) | How Clarvis *speaks* MCP: three transports, the self-healing session with reconnect and circuit breaker, the refcounted pool, and the namespaced tool registry | `mcp-client`, `capability`, `kernel` |

### `execution/` — what an agent can actually do to a machine

| Document | Covers | Implemented in |
| --- | --- | --- |
| [`tools-contract.md`](execution/tools-contract.md) | The one dispatcher every tool sits behind: argument validation, the approval gate, output bounding, the immutable `RuntimeConfig`, and the single registry both surfaces derive from | `tools` |
| [`tools-read-and-search.md`](execution/tools-read-and-search.md) | The nine observing tools (`read_file`, `read_image`, `read_files`, `list_dir`, `glob`, `grep`, `diff`, `file_stat`, `tree`) and the ripgrep-parity contract between grep's two engines | `tools` |
| [`tools-mutation.md`](execution/tools-mutation.md) | The nine mutating tools and the shared staging/locking/rollback machinery that makes a write all-or-nothing | `tools` |
| [`tools-shell-and-monitor.md`](execution/tools-shell-and-monitor.md) | Running host commands: `shell` to completion and the `monitor_*` family in the background, shell resolution, process trees, killing, and bounded spill-backed output | `tools` |
| [`command-guard.md`](execution/command-guard.md) | Per-call approval, split three ways: the shell analyzer that produces facts, the kernel's fixed-precedence policy cascade, and the engine wiring that consults them once per run | `tools`, `kernel`, `loop`, `code` |
| [`hooks.md`](execution/hooks.md) | Operator- and plugin-declared command or MCP-tool invocations bound to lifecycle events: matching, blocking and observer semantics, subprocess and MCP execution, foreign payloads, and argument rewriting | `hooks`, `capability`, `loop`, `mcp-client` |
| [`sandbox.md`](execution/sandbox.md) | Native Bubblewrap/Seatbelt probing and policy construction, toolchain discovery on `PATH`, host path policy, real-platform canaries, and operator inspection | `tools`, `loop`, `kernel`, `protocol`, `code` |
| [`skills.md`](execution/skills.md) | Discovering, parsing and merging `SKILL.md` trees with last-wins precedence; serving catalog, body and confined resource pages through `load_skill` and `read_skill_resource`; and routing named or description-matching skills into the run | `skills`, `kernel`, `loop` |

### `engine/` — the loop itself

| Document | Covers | Implemented in |
| --- | --- | --- |
| [`loop-run-lifecycle.md`](engine/loop-run-lifecycle.md) | One validated request to one persisted record: the run / orchestration / agent layers, the unbounded iteration loop and every stop condition delegated to an injected probe | `loop` |
| [`request-and-settings-schema.md`](engine/request-and-settings-schema.md) | The engine's input boundary on both untrusted documents — a run request and `settings.json` — plus agent frontmatter and the profile-readiness advisory | `loop`, `kernel` |
| [`capability-composition.md`](engine/capability-composition.md) | How a host extends the engine without editing it: registration, folding, the five public entrypoints, and the eager-path rule that keeps optional packages genuinely optional | `loop`, `capability` |
| [`tool-dispatch.md`](engine/tool-dispatch.md) | Wire names and reservations, the MCP registry and its two dispatchers, the fail-open argument validator, and the `submit_result` finalize contract with its schema budget | `loop`, `mcp-client` |
| [`context-compaction.md`](engine/context-compaction.md) | The message window an iteration appends to, preserved historical entries, and the selection/rewrite policy that sheds tokens without breaking call/result pairing or the cached prefix | `loop`, `kernel` |
| [`budgets-and-guards.md`](engine/budgets-and-guards.md) | Five self-defence mechanisms: the shared token ledger and iteration counter, the pausable compute clock, the concurrency-safe output-token reservation, admission control and convergence guards | `loop`, `capability` |
| [`delegation-and-subagents.md`](engine/delegation-and-subagents.md) | How one run produces children: independent `spawn_subagent`, tracked `delegate_task`, inline/background execution, and the five `agent_*` supervision tools | `loop`, `supervision`, `capability` |
| [`vision-routing.md`](engine/vision-routing.md) | The two ways an image enters a run, and the tool-less vision pre-pass spliced in when the entry agent's own model cannot see it | `loop`, `code`, `tools` |
| [`agent-system-prompt.md`](engine/agent-system-prompt.md) | The four-layer system head, the fleet-wide shared prompt, last-wins global/workspace overrides, workspace trust, and run-start snapshotting | `loop`, `kernel`, `paths`, `code`, `skills` |

### `capabilities/` — features that compose onto the engine

| Document | Covers | Implemented in |
| --- | --- | --- |
| [`plan-store.md`](capabilities/plan-store.md) | The plan as one Markdown file whose bytes *are* the plan: the parse/render inverse pair, the `(revision, digest, spec_digest)` compare-and-swap triple, and the file-backed repository | `plan` |
| [`plan-capability.md`](capabilities/plan-capability.md) | Planning packaged as a registrable capability: sessions, the five plan tools, the review blocker, two finalize gates, retention policy and the kernel's plans service | `plan`, `kernel`, `capability` |
| [`goals.md`](capabilities/goals.md) | Persistent objectives, host-owned session transactions, user control, checkpoint policy, scoped completion evidence and per-goal reconciliation | `goal`, `kernel`, `protocol` |
| [`memory-store.md`](capabilities/memory-store.md) | The Markdown wiki (`PROFILE.md` → `TOPIC.md` → `MEMORY.md`): the store port and its adapters, the atomic batch engine and journal, revisions, deterministic reindex, and BM25F search | `memory`, `paths` |
| [`memory-capability.md`](capabilities/memory-capability.md) | The seam from wiki to run: the `<memory>` seed block, the seven tools, the entry-agent-only write policy, the settings block and the kernel control plane | `memory`, `kernel` |
| [`memory-indexer.md`](capabilities/memory-indexer.md) | Turning a finished run into something the wiki knows: the durable enqueue, the background drain with leases and retry budgets, and the isolated versus continuation index passes | `memory`, `kernel` |
| [`workflows-scheduling.md`](capabilities/workflows-scheduling.md) | Manager-to-leader fan-out: the four spawn tools, wave scheduling and write-conflict separation, round barriers, the FIFO concurrency semaphore and the tree-wide token ledger | `workflows` |
| [`workflows-service.md`](capabilities/workflows-service.md) | The non-live half: code-backed built-ins, optional `WORKFLOW.md` overrides, the three reusable result schemas, and the kernel's persisted workflow tree and routing | `workflows`, `kernel`, `code` |
| [`worktrees.md`](capabilities/worktrees.md) | Launch-time Git worktrees: Git-owned identity and lifecycle, immutable process scope, linked-checkout sandbox mounts, and Isolation Sandbox `require_escalated` host-command fallback | `code`, `kernel`, `paths`, `tools` |
| [`tasks-domain.md`](capabilities/tasks-domain.md) | The vendor-neutral task model: stages, actors, claims, strict schemas, the stable error taxonomy, provider identity, the `clarvis.tasks.v2` MCP adapter and its conformance harness | `tasks` |
| [`tasks-capability.md`](capabilities/tasks-capability.md) | Binding one run to one remote task: the ten tools, the four-way gate on what is offered, `task_outcome_unknown` handling, and the kernel's single provider factory | `tasks`, `kernel` |
| [`provider-executables.md`](capabilities/provider-executables.md) | Replacing a capability's *content* without changing its vocabulary: memory/plan provider registries and the language-neutral JSON-RPC executable protocol | `capability`, `memory`, `plan`, `kernel`, `code` |

### `hosts/` — the kernel, the terminal UI and the HTTP facade

| Document | Covers | Implemented in |
| --- | --- | --- |
| [`protocol.md`](hosts/protocol.md) | The transport-agnostic contract: wire DTOs plus the `KernelClient` service interfaces, a pure leaf with no dependency of any kind | `protocol` |
| [`kernel-composition.md`](hosts/kernel-composition.md) | The three stacked construction entry points — in-process composition, `createFileKernel` as the sole local one-workspace bootstrap, and `createFileRunHost` process hosting — plus owner scoping | `kernel` |
| [`isolated-agent-runtime.md`](hosts/isolated-agent-runtime.md) | Host-owned admission and model/remote-MCP brokers, direct selected-workspace mounts, private execution, immutable OCI distribution, and Docker/Podman adapters for disposable agent workers | `kernel`, `protocol`, `code`, `paths`, `loop`, `mcp-client`, `tools`, `tooling/` |
| [`kernel-config.md`](hosts/kernel-config.md) | The synchronous config store under the async config service, `kernelSettingsSchema` validation, the shipped agent fleet as TypeScript data, and field-by-field overlays | `kernel`, `protocol` |
| [`self-configuration.md`](hosts/self-configuration.md) | Shipped TypeScript configuration skill, explicit native execution, live-session consent and credential-excluding file operations | `kernel`, `paths`, `protocol`, `code`, `skills` |
| [`kernel-runs.md`](hosts/kernel-runs.md) | Admission and execution identity, request assembly from settings plus agent records, the run-scoped handle with its queues, and the two mappers that project events into the protocol union | `kernel`, `protocol` |
| [`hosted-runs.md`](hosts/hosted-runs.md) | Independent workspace host, bounded observation and recovery, conversation authority, and TUI background/attach commands | `kernel`, `protocol`, `paths`, `code` |
| [`kernel-transport.md`](hosts/kernel-transport.md) | The JSON-RPC-shaped wire with Clarvis's own vocabulary: one operations table both halves are built from, stdio framing, the loopback seam and inbound run-event re-validation | `kernel`, `protocol` |
| [`extension-profiles.md`](hosts/extension-profiles.md) | Deterministic activation snapshots over already-installed plugins and standalone skills: exact scopes, selection precedence, trust, deltas, fingerprints, and session/trace identity | `kernel`, `protocol`, `paths`, `skills`, `loop`, `trace`, `code` |
| [`storage.md`](hosts/storage.md) | Metadata-only inventory of Clarvis-owned local state, confirmed cleanup of disposable artifacts, spill/run-scratch housekeeping and session-safe trace retention | `kernel`, `protocol`, `paths`, `trace`, `loop`, `code` |
| [`plugins.md`](hosts/plugins.md) | Reading a `plugin.json`, translating foreign dialects, degrading one artifact at a time, and normalized Git/local/npm marketplace installation | `kernel`, `loop`, `code` |
| [`model-catalog.md`](hosts/model-catalog.md) | The shipped models.dev snapshot, `provider/model` ref parsing and provider resolution, pricing, reasoning-effort floors and where a model's cache mode is derived | `kernel`, `capability`, `code` |
| [`subscription-providers.md`](hosts/subscription-providers.md) | Local ChatGPT and Grok subscription login, credentials, entitled catalogs, pinned Responses transports, billing separation, coexistence, and remote unavailability | `paths`, `protocol`, `capability`, `loop`, `llm`, `kernel`, `code`, `server` |
| [`sessions.md`](hosts/sessions.md) | A session as a conversation index of turns pointing at runs: the file-backed service with its bounded summary sidecar, and how a client rebuilds a transcript from persisted traces | `kernel`, `code`, `protocol` |
| [`server-auth.md`](hosts/server-auth.md) | Everything in front of the MCP surface: bind-time refusals, the environment posture schema, the four owner modes, OAuth `client_credentials`, and the per-request principal pipeline | `server` |
| [`server-mcp.md`](hosts/server-mcp.md) | The four-tool facade: `clarvis_run` as a blocking call that *is* the run, the steer/cancel/respond triad, session-scoped run bookkeeping and the bounded notification sink | `server` |
| [`code-bootstrap.md`](hosts/code-bootstrap.md) | From the `clarvis` bin to a painted frame: the flag table, the two flags answered before the graph loads, bundle-versus-source entry, headless modes and the Solid/OpenTUI shell | `code` |
| [`code-performance.md`](hosts/code-performance.md) | Startup latency, resident-memory budgets, measurement discipline, measured evidence, and the prioritized reduction plan | `code`, `kernel` |
| [`code-run-host.md`](hosts/code-run-host.md) | The stateful bridge to the kernel run stream: the in-flight handle, the session, the kernel run client and workspace client manager, and the transcript/activity/session projection stores | `code` |
| [`loop-scheduling.md`](hosts/loop-scheduling.md) | Memory-only conversation prompt recurrence: interval/cron parsing, bounded fair admission, live-session configuration bindings and TUI controls | `code` |
| [`code-transcript.md`](hosts/code-transcript.md) | How the Lead-only main transcript or one selected child transcript is filtered, grouped, folded and rendered, including tool-call identity and hard display ceilings | `code` |
| [`code-transcript-stability.md`](hosts/code-transcript-stability.md) | Immutable publication batches, exhaustive event disposition, syntax-ready physical row markers, native-scroll lazy residency, the continuous mutable tail and replay equivalence | `code` |
| [`code-input-and-overlays.md`](hosts/code-input-and-overlays.md) | The composer and its completion popup, the shared floating-card and windowed-list primitives, plan/history overlays, and the `!bash` escape hatch | `code` |
| [`code-domain-hubs.md`](hosts/code-domain-hubs.md) | The six full-screen domain views (agents, tasks, workflows, sessions, memory, run controls) and the controller/adapter layering that keeps them thin | `code` |
| [`code-extensions.md`](hosts/code-extensions.md) | The five-step Extensions setup, unified exact catalog, capability review, preview-bound Extension Profile composition and retained-list performance contract | `code`, `kernel`, `protocol`, `skills` |
| [`code-settings-panels.md`](hosts/code-settings-panels.md) | The configuration surface: the view host with its scope toggle and dirty latch, the single-slot field editor, and the provider/model and extension-browser screens | `code` |
| [`code-keyboard.md`](hosts/code-keyboard.md) | Capability-gated key candidates over `@opentui/keymap`, and generating every footer segment, help row and hint from that one live declaration | `code` |
| [`code-theme.md`](hosts/code-theme.md) | The design-token layer: token resolution to hex, derived surface washes, syntax colors, and the paired ASCII rendering of every non-ASCII glyph | `code` |
| [`code-onboarding.md`](hosts/code-onboarding.md) | The readiness ladder that routes a first run to the shell, a wizard or a repair screen; the idempotent settings seeders; and the platform doctor and diagnostics | `code` |

### `cross-cutting/` — properties no single package owns

| Document | Covers | Implemented in |
| --- | --- | --- |
| [`package-architecture.md`](cross-cutting/package-architecture.md) | Package roles, dependency directions, the single product-version model, package-versus-subpath criteria, and the application/Protocol/Kernel boundary | root manifest, workspace manifests, graph tooling, all workspaces |
| [`grants.md`](cross-cutting/grants.md) | The one string vocabulary a profile asks with, how capabilities contribute grants at boot, and how a profile's model/tools/grants resolve into the tools an agent actually sees | `loop`, `capability`, `kernel`, and the grant-contributing capability packages |
| [`prompt-cache.md`](cross-cutting/prompt-cache.md) | What a provider's prefix cache charges for, the append-only rule that keeps it, the measured cost of breaking it, and the session-affinity and breakpoint mechanics | `loop`, `llm` |
| [`model-instructions.md`](cross-cutting/model-instructions.md) | Owned prompt/tool inventory, compact role and harness handoffs, local schema guidance, recovery semantics and structural payload budgets | `kernel`, `loop`, `tools`, `plan`, `workflows`, `tasks`, `server`, instruction-contributing packages |
| [`elicitation.md`](cross-cutting/elicitation.md) | Every way a run asks a human — `ask_user`, guard prompts, budget escalation, MCP elicitation — through one port, one per-run FIFO, one tree-wide mux and each host's own surface | `loop`, `kernel`, `server`, `code`, `workflows` |
| [`security.md`](cross-cutting/security.md) | Path confinement, the single redaction module and its two rule sets, environment filtering for subprocesses, workspace trust, and what is explicitly *not* a sandbox | `tools`, `kernel`, `capability`, `hooks` |
| [`observability.md`](cross-cutting/observability.md) | The one `Logger` port and its single backend, the event-name vocabulary, environment-only verbosity, the cost model at hot call sites, and the audit channel | `capability`, `kernel` (repo-wide) |
| [`agent-interop.md`](cross-cutting/agent-interop.md) | Component-scoped ownership of the shared `.agents` seam, plus the single-owner correspondence tables that make a foreign-dialect hook document degrade instead of silently failing open | `kernel`, `skills`, `capability`, `paths` |
| [`test-architecture.md`](cross-cutting/test-architecture.md) | Test placement, runner isolation, the pre-commit gate, LCOV-summed coverage floors, and the static TUI scenario inventory | `tooling/`, root config, all workspaces |
| [`build-and-ci.md`](cross-cutting/build-and-ci.md) | One Bun workspace and lockfile, the two-layer TypeScript configuration, shared lint/format, the `tsc -b` graph, the three CI jobs, the TUI bundle and platform support | root config, `code`, all workspaces |
| [`distribution-and-updates.md`](cross-cutting/distribution-and-updates.md) | Portable native archives, installers, release trust and publication, explicit self-update, staging and atomic activation | root release config, `code` |

---

## Beside the corpus

| Document | Holds | Reach for it when |
| --- | --- | --- |
| [`known-issues.md`](known-issues.md) | What was measured, ruled out, or tried and reverted: the ten behaviours that turn on something outside this repository, the Bun crash forensics and its retry, the memory leaks and their soaks, the Windows gaps and their suppression predicates, the extractions that were abandoned, and the four confirmed defects and how each was closed | Something is failing and you want to know whether it has already been diagnosed — or you are about to re-run an experiment someone else has run |
| [`package-coupling-analysis.md`](package-coupling-analysis.md) | The generated package-graph report | You want the dependency edges as the checker sees them — this one is generated and gated, so it is the only file here that cannot drift |

---

## How this corpus is kept true

### Documentation changes travel with code

Every coding iteration must identify and re-read its owning package README and specs. A change to
behavior, public API, configuration, wire or persisted data, failure handling, ownership,
dependencies, or an invariant updates those documents in the same iteration; knowingly stale
documentation is never deferred to a follow-up. A new or changed invariant also carries both its
`Production:` and `Test:` citations.

If an implementation-only change leaves the documented contract intact, the handoff says
`Docs reviewed; no change needed` and explains why. This is a required disposition, not an
assumption. [`AGENTS.md`](../AGENTS.md#the-iteration-contract) owns the complete working rule.

One check runs over these files: `bun run check:specs` (inside `lint:intent`, and so inside the
pre-commit gate). It refuses dangerous literal characters, resolves documentation links, rejects
line-qualified repository references, calendar dates, and source-code line-count inventories in
tracked specs, and verifies that every explicit repository file reference resolves. Change
chronology belongs in `CHANGELOG.md`; date-shaped data examples use semantic placeholders such as
`YYYY-MM-DD`. Illustrative paths must use visibly non-literal placeholders such as
`packages/<name>/src/<file>.ts`. Most importantly, an existing file can still be the wrong evidence:
semantic support remains a source-and-test review, not a property this structural check can prove.

**Statements carry citations, so any statement can be checked from one named place.** A sentence
anchored to a source symbol or `packages/<name>/src/<file>.ts` is falsifiable by opening that
place. A disagreement between a document and the code is a defect on one side or the other — either
the implementation has drifted from what was specified, or the specification moved and the code has
not followed — and it has to be resolved, not assumed away in either direction. The citation is
what makes that check cheap enough to actually perform, and a statement that lost its evidence in an
edit has lost its standing along with it.

**Invariants name their production support and test status, so the suite is what keeps the pinned
ones honest.** The exact presentation varies: tables use `Production` plus `Test` or `Pinned by`,
while prose uses `Production:` plus `Test:` or `Pinned:`. A rule with a test behind it stays true
because breaking it turns a suite red; a rule marked `unpinned` can stop being honoured without
anything turning red. The document must state that distinction beside the rule and surface the
remaining gap in its open questions rather than letting prose imply a test exists.

### Verification scope

"The specs and the code agree" is itself a claim that requires current source review. `bun run
check:specs` proves structural properties: links resolve, explicit repository files exist, dangerous
characters are absent, references do not embed source line locators, and specs do not carry calendar
dates or source-size inventories. It does not prove that a file or symbol semantically supports the
surrounding prose.

Review citations by meaning: read the claim, inspect the named symbol and applicable tests, and
update either the implementation or the contract when they disagree. File sizes, corpus counts and
historical sampling totals are deliberately omitted because they drift without adding behavioral
authority.

So: if you are relying on something here, look at whether it names a test. If it does, that test is what
holds the implementation to this document. If it does not, open the citation.
