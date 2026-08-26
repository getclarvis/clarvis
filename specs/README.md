# The Clarvis spec corpus

Sixty-five documents specifying what the Clarvis monorepo does, plus a register of what has been
measured, ruled out, or tried and reverted.

The findings register that used to sit beside them — `gaps.md`, the cross-cutting list of what the
corpus had left open — is **gone as of 2026-08-22, because every item in it was closed.** Nothing
was dropped in the closing. What was a code defect was fixed with a test; what was an unpinned
rule got the test; what genuinely depends on something outside this repository moved into
[`known-issues.md`](known-issues.md), which is where evidence the source cannot supply belongs;
and what a document had simply never described is now described in the document that owns it. Each
resolution is recorded beside the original claim in the owning spec's section 8, struck through
rather than deleted, so the reasoning outlives the finding.

## What this is

These sixty-five documents are the specification of the Clarvis monorepo: what each subsystem is for, what
it publishes, how it behaves, and the rules that must hold. They are the contract; the code under
`packages/` is what realizes it. One document covers one subsystem, and each opens with a blockquote
naming the files that implement it, so the boundary travels with the document rather than in a
separate plan.

The corpus's one hard rule is that **every non-trivial statement carries a
`packages/x/src/y.ts:LINE` citation to the line that implements it.** That is what makes a
specification checkable rather than aspirational: a statement without a citation is one you should
not trust, and a citation is an invitation — open the line and see whether the implementation still
honours it.

[`known-issues.md`](known-issues.md) sits beside the corpus rather than inside it, because what it
records — CI history, memory soaks, upstream bug numbers, and designs that were tried and reverted —
cannot be written as a requirement or checked against a line of source. That is exactly why it is a
separate document.

**The corpus carries no date of its own, so the table below is its timestamp.** These are the
numbers the tree held when it was last refreshed (2026-08-26). If they no longer match, the tree has
moved since the corpus was last checked against it, and the further it has drifted the more of the
corpus's untested statements are worth re-checking. Regenerate them rather than trusting them:

```sh
find packages/<pkg>/src -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | xargs -0 wc -l | tail -n 1
find packages/<pkg>/src -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l
find packages/<pkg>/tests -type f -name '*.test.ts*' | wc -l
```

| Package | `src` lines | `src` files | test files |
|---|---|---|---|
| `code` | 51,378 | 237 | 232 |
| `kernel` | 26,707 | 110 | 83 |
| `loop` | 20,614 | 137 | 233 |
| `memory` | 13,612 | 65 | 59 |
| `tools` | 12,398 | 65 | 71 |
| `capability` | 7,869 | 51 | 34 |
| `plan` | 7,013 | 26 | 24 |
| `server` | 6,450 | 37 | 38 |
| `workflows` | 6,463 | 27 | 23 |
| `trace` | 4,186 | 15 | 16 |
| `llm` | 4,020 | 18 | 19 |
| `tasks` | 3,797 | 13 | 6 |
| `skills` | 3,560 | 20 | 25 |
| `mcp-client` | 3,554 | 13 | 24 |
| `paths` | 3,239 | 14 | 14 |
| `protocol` | 2,933 | 18 | 0 |
| `hooks` | 2,390 | 9 | 11 |
| `supervision` | 1,537 | 10 | 9 |

## How to read a spec

Every document opens with an H1 naming its subject and a blockquote naming the files that implement
it. Then eight numbered sections, in the same order in all sixty-five:

| § | Section | What it holds |
|---|---|---|
| 1 | **Purpose** | What the subsystem is for, what problem it solves, and what is deliberately delegated to a sibling document |
| 2 | **Surface** | The exports, ports, tools, settings blocks and wire names it publishes |
| 3 | **Data and formats** | The shapes it persists or exchanges — on-disk documents, schemas, envelopes |
| 4 | **Behavior** | What actually happens at runtime, step by step, with citations |
| 5 | **Invariants** | The rules that must hold, each with a *Production:* citation and a *Test:* citation |
| 6 | **Failure modes and degradation** | What breaks, and what it degrades to rather than failing |
| 7 | **Coupling** | Who it depends on, who depends on it, and where the seams are |
| 8 | **Open questions** | What this document deliberately leaves open, and what the implementation does not settle |

The one variance is [`capabilities/tasks-domain.md`](capabilities/tasks-domain.md), which inserts a
fifth section, *State model*, and so numbers its remaining sections 6–9.

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
|---|---|---|
| [`capability.md`](foundations/capability.md) | The four-level capability contract (`Capability` → `RunCapability` → `AgentCapability` → `AgentLoopContribution`), the settings/services/port registries, and the shared run vocabulary of open unions every layer names | `capability` |
| [`paths.md`](foundations/paths.md) | The single owner of `.clarvis`/`.agents` and every path built from them, plus atomic write-then-rename, directory `fsync` and the crash-recoverable local lease | `paths` (+ one `kernel` architecture test) |
| [`supervision.md`](foundations/supervision.md) | The run-scoped child registry two independent spawners share: agent ids, activity buffers, the trace→activity projection, the steer queue and the effective limits | `supervision`, `capability` |
| [`trace.md`](foundations/trace.md) | The split between trace *vocabulary* (which events exist) and trace *implementation* (recording handle, JSON store, crash journal, recovery, retention sweeper) | `trace`, `capability` |
| [`llm.md`](foundations/llm.md) | The provider layer: the AI-SDK adapter behind the `LLMProvider` port, the decorator stack (cache/logging/retry/admission), the error classifier, bounded transport and the two-entry lazy split | `llm`, `capability` |
| [`mcp-client.md`](foundations/mcp-client.md) | How Clarvis *speaks* MCP: three transports, the self-healing session with reconnect and circuit breaker, the refcounted pool, and the namespaced tool registry | `mcp-client`, `capability` |

### `execution/` — what an agent can actually do to a machine

| Document | Covers | Implemented in |
|---|---|---|
| [`tools-contract.md`](execution/tools-contract.md) | The one dispatcher every tool sits behind: argument validation, the approval gate, output bounding, the immutable `RuntimeConfig`, and the single registry both surfaces derive from | `tools` |
| [`tools-read-and-search.md`](execution/tools-read-and-search.md) | The nine observing tools (`read_file`, `read_image`, `read_files`, `list_dir`, `glob`, `grep`, `diff`, `file_stat`, `tree`) and the ripgrep-parity contract between grep's two engines | `tools` |
| [`tools-mutation.md`](execution/tools-mutation.md) | The nine mutating tools and the shared staging/locking/rollback machinery that makes a write all-or-nothing | `tools` |
| [`tools-shell-and-monitor.md`](execution/tools-shell-and-monitor.md) | Running host commands: `shell` to completion and the `monitor_*` family in the background, shell resolution, process trees, killing, and bounded spill-backed output | `tools` |
| [`command-guard.md`](execution/command-guard.md) | Per-call approval, split three ways: the shell analyzer that produces facts, the kernel's fixed-precedence policy cascade, and the engine wiring that consults them once per run | `tools`, `kernel`, `loop`, `code` |
| [`hooks.md`](execution/hooks.md) | Operator-declared shell commands bound to lifecycle events: matching, the subprocess contract, the three spellings of a block, the flat foreign-dialect payload, and argument rewriting | `hooks`, `capability`, `loop` |
| [`sandbox.md`](execution/sandbox.md) | Bubblewrap probing and argv construction, toolchain discovery on `PATH`, the host path policy layered above it, and what the operator's Sandbox panel truthfully reports | `tools`, `loop`, `kernel`, `code` |
| [`skills.md`](execution/skills.md) | Discovering, parsing and merging `SKILL.md` trees across roots with last-wins precedence, and serving them in three tiers through `load_skill` | `skills`, `kernel`, `loop` |

### `engine/` — the loop itself

| Document | Covers | Implemented in |
|---|---|---|
| [`loop-run-lifecycle.md`](engine/loop-run-lifecycle.md) | One validated request to one persisted record: the run / orchestration / agent layers, the unbounded iteration loop and every stop condition delegated to an injected probe | `loop` |
| [`request-and-settings-schema.md`](engine/request-and-settings-schema.md) | The engine's input boundary on both untrusted documents — a run request and `settings.json` — plus agent frontmatter and the profile-readiness advisory | `loop`, `kernel` |
| [`capability-composition.md`](engine/capability-composition.md) | How a host extends the engine without editing it: registration, folding, the five public entrypoints, and the eager-path rule that keeps optional packages genuinely optional | `loop`, `capability` |
| [`tool-dispatch.md`](engine/tool-dispatch.md) | Wire names and reservations, the MCP registry and its two dispatchers, the fail-open argument validator, and the `submit_result` finalize contract with its schema budget | `loop`, `mcp-client` |
| [`context-compaction.md`](engine/context-compaction.md) | The mutable message window an iteration appends to, volatile entries, and the selection/rewrite policy that sheds tokens without breaking call/result pairing or the cached prefix | `loop`, `kernel` |
| [`budgets-and-guards.md`](engine/budgets-and-guards.md) | Five self-defence mechanisms: the shared token ledger and iteration counter, the pausable compute clock, the concurrency-safe output-token reservation, admission control and convergence guards | `loop`, `capability` |
| [`delegation-and-subagents.md`](engine/delegation-and-subagents.md) | How one run produces children: independent `spawn_subagent`, tracked `delegate_task`, inline/background execution, and the five `agent_*` supervision tools | `loop`, `supervision`, `capability` |
| [`vision-routing.md`](engine/vision-routing.md) | The two ways an image enters a run, and the tool-less vision pre-pass spliced in when the entry agent's own model cannot see it | `loop`, `code`, `tools` |

### `capabilities/` — features that compose onto the engine

| Document | Covers | Implemented in |
|---|---|---|
| [`plan-store.md`](capabilities/plan-store.md) | The plan as one Markdown file whose bytes *are* the plan: the parse/render inverse pair, the `(revision, digest, spec_digest)` compare-and-swap triple, and the file-backed repository | `plan` |
| [`plan-capability.md`](capabilities/plan-capability.md) | Planning packaged as a registrable capability: sessions, the five plan tools, the review blocker, two finalize gates, retention policy and the kernel's plans service | `plan`, `kernel`, `capability` |
| [`memory-store.md`](capabilities/memory-store.md) | The Markdown wiki (`PROFILE.md` → `TOPIC.md` → `MEMORY.md`): the store port and its adapters, the atomic batch engine and journal, revisions, deterministic reindex, and BM25F search | `memory`, `paths` |
| [`memory-capability.md`](capabilities/memory-capability.md) | The seam from wiki to run: the `<memory>` seed block, the seven tools, the entry-agent-only write policy, the settings block and the kernel control plane | `memory`, `kernel` |
| [`memory-indexer.md`](capabilities/memory-indexer.md) | Turning a finished run into something the wiki knows: the durable enqueue, the background drain with leases and retry budgets, and the isolated versus continuation index passes | `memory`, `kernel` |
| [`workflows-scheduling.md`](capabilities/workflows-scheduling.md) | Manager-to-leader fan-out: the four spawn tools, wave scheduling and write-conflict separation, round barriers, the FIFO concurrency semaphore and the tree-wide token ledger | `workflows` |
| [`workflows-service.md`](capabilities/workflows-service.md) | The non-live half: code-backed built-ins, optional `WORKFLOW.md` overrides, the three reusable result schemas, and the kernel's persisted workflow tree and routing | `workflows`, `kernel`, `code` |
| [`worktrees.md`](capabilities/worktrees.md) | Launch-time Git worktrees: Git-owned identity and lifecycle, immutable process scope, linked-checkout sandbox mounts and approved host VCS access | `code`, `kernel`, `paths`, `tools` |
| [`tasks-domain.md`](capabilities/tasks-domain.md) | The vendor-neutral task model: stages, actors, claims, strict schemas, the stable error taxonomy, provider identity, the `clarvis.tasks.v2` MCP adapter and its conformance harness | `tasks` |
| [`tasks-capability.md`](capabilities/tasks-capability.md) | Binding one run to one remote task: the ten tools, the four-way gate on what is offered, `task_outcome_unknown` handling, and the kernel's single provider factory | `tasks`, `kernel` |
| [`provider-executables.md`](capabilities/provider-executables.md) | Replacing a capability's *content* without changing its vocabulary: memory/plan provider registries and the language-neutral JSON-RPC executable protocol | `capability`, `memory`, `plan`, `kernel`, `code` |

### `hosts/` — the kernel, the terminal UI and the HTTP facade

| Document | Covers | Implemented in |
|---|---|---|
| [`protocol.md`](hosts/protocol.md) | The transport-agnostic contract: wire DTOs plus the `KernelClient` service interfaces, a pure leaf with no dependency of any kind | `protocol` |
| [`kernel-composition.md`](hosts/kernel-composition.md) | The three stacked construction entry points — in-process composition, file backing, and the project host fanning one Git project out into ref-counted workspace kernels — plus owner scoping | `kernel` |
| [`kernel-config.md`](hosts/kernel-config.md) | The synchronous config store under the async config service, `kernelSettingsSchema` validation, the shipped agent fleet as TypeScript data, and field-by-field overlays | `kernel`, `protocol` |
| [`kernel-runs.md`](hosts/kernel-runs.md) | Admission and execution identity, request assembly from settings plus agent records, the run-scoped handle with its queues, and the two mappers that project events into the protocol union | `kernel`, `protocol` |
| [`kernel-transport.md`](hosts/kernel-transport.md) | The JSON-RPC-shaped wire with Clarvis's own vocabulary: one operations table both halves are built from, stdio framing, the loopback seam and inbound run-event re-validation | `kernel`, `protocol` |
| [`storage.md`](hosts/storage.md) | Metadata-only inventory of Clarvis-owned local state, confirmed cleanup of disposable artifacts, spill/run-scratch housekeeping and session-safe trace retention | `kernel`, `protocol`, `paths`, `trace`, `loop`, `code` |
| [`plugins.md`](hosts/plugins.md) | Reading a `plugin.json`, translating foreign dialects, degrading one artifact at a time, and the marketplace clone-and-install path | `kernel`, `loop`, `code` |
| [`model-catalog.md`](hosts/model-catalog.md) | The shipped models.dev snapshot, `provider/model` ref parsing and provider resolution, pricing, reasoning-effort floors and where a model's cache mode is derived | `kernel`, `capability`, `code` |
| [`subscription-providers.md`](hosts/subscription-providers.md) | Local ChatGPT and Grok subscription login, credentials, entitled catalogs, pinned Responses transports, billing separation, coexistence, and remote unavailability | `paths`, `protocol`, `capability`, `loop`, `llm`, `kernel`, `code`, `server` |
| [`sessions.md`](hosts/sessions.md) | A session as a conversation index of turns pointing at runs: the file-backed service with its bounded summary sidecar, and how a client rebuilds a transcript from persisted traces | `kernel`, `code`, `protocol` |
| [`server-auth.md`](hosts/server-auth.md) | Everything in front of the MCP surface: bind-time refusals, the environment posture schema, the four owner modes, OAuth `client_credentials`, and the per-request principal pipeline | `server` |
| [`server-mcp.md`](hosts/server-mcp.md) | The four-tool facade: `clarvis_run` as a blocking call that *is* the run, the steer/cancel/respond triad, session-scoped run bookkeeping and the bounded notification sink | `server` |
| [`code-bootstrap.md`](hosts/code-bootstrap.md) | From the `clarvis` bin to a painted frame: the flag table, the two flags answered before the graph loads, bundle-versus-source entry, headless modes and the Solid/OpenTUI shell | `code` |
| [`code-performance.md`](hosts/code-performance.md) | Startup latency, resident-memory budgets, measurement discipline, the dated 2026-08-24 audit and the prioritized reduction plan | `code`, `kernel` |
| [`code-run-host.md`](hosts/code-run-host.md) | The stateful bridge to the kernel run stream: the in-flight handle, the session, the kernel run client and workspace client manager, and the transcript/activity/session projection stores | `code` |
| [`code-transcript.md`](hosts/code-transcript.md) | Framework-free node projection, prefix-stable Markdown segmentation, windowing and grouping, tool-call rendering and identity — all under hard display ceilings | `code` |
| [`code-input-and-overlays.md`](hosts/code-input-and-overlays.md) | The composer and its completion popup, the shared floating-card and windowed-list primitives, plan/history overlays, and the `!bash` escape hatch | `code` |
| [`code-domain-hubs.md`](hosts/code-domain-hubs.md) | The six full-screen domain views (agents, tasks, workflows, sessions, memory, run controls) and the controller/adapter layering that keeps them thin | `code` |
| [`code-settings-panels.md`](hosts/code-settings-panels.md) | The configuration surface: the view host with its scope toggle and dirty latch, the single-slot field editor, and the provider/model and extension-browser screens | `code` |
| [`code-keyboard.md`](hosts/code-keyboard.md) | Capability-gated key candidates over `@opentui/keymap`, and generating every footer segment, help row and hint from that one live declaration | `code` |
| [`code-theme.md`](hosts/code-theme.md) | The design-token layer: token resolution to hex, derived surface washes, syntax colors, and the paired ASCII rendering of every non-ASCII glyph | `code` |
| [`code-onboarding.md`](hosts/code-onboarding.md) | The readiness ladder that routes a first run to the shell, a wizard or a repair screen; the idempotent settings seeders; and the platform doctor and diagnostics | `code` |

### `cross-cutting/` — properties no single package owns

| Document | Covers | Implemented in |
|---|---|---|
| [`package-architecture.md`](cross-cutting/package-architecture.md) | Package roles, dependency directions, the single product-version model, package-versus-subpath criteria, and the application/Protocol/Kernel boundary | root manifest, workspace manifests, graph tooling, all workspaces |
| [`grants.md`](cross-cutting/grants.md) | The one string vocabulary a profile asks with, how capabilities contribute grants at boot, and how a profile's model/tools/grants resolve into the tools an agent actually sees | `loop`, `capability`, `kernel`, and the grant-contributing capability packages |
| [`prompt-cache.md`](cross-cutting/prompt-cache.md) | What a provider's prefix cache charges for, the append-only rule that keeps it, the measured cost of breaking it, and the session-affinity and breakpoint mechanics | `loop`, `llm` |
| [`elicitation.md`](cross-cutting/elicitation.md) | Every way a run asks a human — `ask_user`, guard prompts, budget escalation, MCP elicitation — through one port, one per-run FIFO, one tree-wide mux and each host's own surface | `loop`, `kernel`, `server`, `code`, `workflows` |
| [`security.md`](cross-cutting/security.md) | Path confinement, the single redaction module and its two rule sets, environment filtering for subprocesses, workspace trust, and what is explicitly *not* a sandbox | `tools`, `kernel`, `capability`, `hooks` |
| [`observability.md`](cross-cutting/observability.md) | The one `Logger` port and its single backend, the event-name vocabulary, environment-only verbosity, the cost model at hot call sites, and the audit channel | `capability`, `kernel` (repo-wide) |
| [`agent-interop.md`](cross-cutting/agent-interop.md) | The `.agents` seam Clarvis reads but never writes, and the single-owner correspondence tables that make a foreign-dialect hook document degrade instead of silently failing open | `kernel`, `skills`, `capability`, `paths` |
| [`test-architecture.md`](cross-cutting/test-architecture.md) | Test placement in six named directories, runner isolation and the banned `mock.module()`, the pre-commit gate's ordered phases, and LCOV-summed coverage floors | `tooling/`, root config, all workspaces |
| [`build-and-ci.md`](cross-cutting/build-and-ci.md) | One Bun workspace and lockfile, the two-layer TypeScript configuration, shared lint/format, the `tsc -b` graph, the three CI jobs, the TUI bundle and platform support | root config, `code`, all workspaces |
| [`distribution-and-updates.md`](cross-cutting/distribution-and-updates.md) | Portable native archives, installers, release trust and publication, explicit self-update, staging and atomic activation | root release config, `code` |

---

## Beside the corpus

| Document | Holds | Reach for it when |
|---|---|---|
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
pre-commit gate) resolves every documentation link and refuses a literal control character. It does
not verify a `packages/x/src/y.ts:LINE` citation, so two further mechanisms do that work, and both are
the reader's to use.

**Statements carry citations, so any statement can be checked in one step.** A sentence anchored to
`packages/x/src/y.ts:123` is falsifiable by opening line 123. A disagreement between a document and
the code is a defect on one side or the other — either the implementation has drifted from what was
specified, or the specification moved and the code has not followed — and it has to be resolved, not
assumed away in either direction. The citation is what makes that check cheap enough to actually
perform, and a statement that lost its citation in an edit has lost its standing along with it.

**Invariants name the test that pins them, so the suite is what keeps them honest.** Section 5 of
every spec lists its rules in the form *Production: `file:line`* / *Test: `file:line`*, each carrying its `INV-nnn` id. That is the load-bearing
distinction in the whole
corpus: a rule with a test behind it stays true because breaking it turns a suite red, while a rule
that nothing pins can stop being honoured without anything turning red. Where a document carries the
second kind, it says so — an unpinned invariant is recorded in section 8 as exactly that, not
promoted into section 5.

### What the corpus was measured to be worth

The corpus was checked against the implementation three ways, and the numbers are kept because "the
specs and the code agree" is itself a claim that should carry evidence.

**A blind stride sample, opened by hand.** 142 citations were drawn by a fixed stride across all six
directories and each was opened at its cited line: **142 confirmed, 0 stale, 0 refuted, 0
unresolvable.**

**Adversarial re-verification.** Every code-side claim in the findings register was handed to a
verifier instructed to refute it against `packages/*/src` and `packages/*/tests`. Each one held.

**A mechanical whole-corpus sweep.** Every path and `path:line` reference resolved against the tree:
**20,743** path references, of which **19,653** are direct `path:LINE` citations and **12,418** are
bare `` `:LINE` `` continuations onto a section's ambient file; **0** line numbers past the end of the
file they name; **0** real references to a path that does not exist; and **366** relative markdown
links, **0** of them dangling. `bun run check:specs` now holds the last of those permanently.

**One method note, because it cost real damage to learn.** When source edits move line numbers, do
not repair `path:LINE` citations with a line delta derived from `git diff`. It is not idempotent —
running it twice shifts twice and cannot tell that it already ran — and it collides with any citation
already re-anchored by hand, moving it a second time. A per-citation content check is *not* a
sufficient guard either: it once reported 429 of 429 "confirmed" while silently breaking the ones that
were already right, because matching text only proves the text moved, not that the citation was
written against the old numbering. Repair by **symbol**: read the prose to learn what the citation
points at, find that symbol in the current file, write that line. A mechanised map is usable only
when it is cross-validated against content first — every unchanged line must land where the map says,
with zero disagreements — and applied exactly once.

So: if you are relying on something here, look at whether it names a test. If it does, that test is what
holds the implementation to this document. If it does not, open the citation.
