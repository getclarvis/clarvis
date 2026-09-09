# Builtin guidance and native self configuration

## 1. Ownership and entry

Clarvis ships `clarvis-configure` as TypeScript data embedded in the kernel and application bundle.
It needs no generated `SKILL.md`, source checkout or separately installed extension. Its guide covers
settings precedence, providers, Agent Profiles, subagents, grants, optional capabilities, Extension
Profiles, plugins, skills, MCP, hooks, memory, plans, tasks, workflows, trust, runtime settings,
TUI loop scheduling, background runs and configuration reload.
The ordinary `load_skill` tool discloses these instructions under `use_skills`; it grants no access.
Container disclosure retains builtin provenance and priority, and uses the same canonical embedded
instruction text without inventing a `SKILL.md` path or execution directory. The background guidance
states that detach, takeover, connection loss and leaving the live conversation revoke command
`allow_session` approvals in native and container execution.
Production: [skills-bridge.ts](../../packages/kernel/src/runtime/skills-bridge.ts),
[disclosure.ts](../../packages/skills/src/disclosure.ts) and
[clarvis-configure.ts](../../packages/kernel/src/skills/clarvis-configure.ts).
Test: native/guest builtin conformance in
[runtime-skills-bridge.test.ts](../../packages/kernel/tests/unit/runtime-skills-bridge.test.ts) and
controller revocation in
[runtime-guard-approval.test.ts](../../packages/kernel/tests/component/runtime-guard-approval.test.ts).

The file kernel reserves this skill's name and composes it after extension discovery. Disabling
skills at the host or environment level removes it too. A custom empty Extension Profile excludes
scanned extensions but retains this product-owned guide. Production: `CLARVIS_CONFIGURE_SKILL` and
`withBuiltinSkills` in [kernel skills](../../packages/kernel/src/skills/builtin-skills.ts);
the content is [clarvis-configure.ts](../../packages/kernel/src/skills/clarvis-configure.ts).
Test: `builtin skill distribution and run composition` in
[builtin-skills.test.ts](../../packages/kernel/tests/integration/builtin-skills.test.ts), and
`shipped configuration skill` in
[builtin-skills.test.ts](../../packages/kernel/tests/component/builtin-skills.test.ts).

Invoking `/clarvis-configure <task>` uses the skill's builtin `agent` metadata to start a standalone
transcript turn. The file kernel recognizes the reserved name and builtin provenance before ordinary
Agent Profile assembly or workflow routing. It supplies a dedicated profile for that run; this
profile is not a sixth editable member of the shipped agent fleet. Loading the guide inside an
ordinary turn does not switch placement; the guide directs the operator to the slash command.

Production: `withBuiltinSkills`, `createRunService` in
[run-service.ts](../../packages/kernel/src/runs/run-service.ts), and `createNativeConfigurationRuns`
in [native-configuration.ts](../../packages/kernel/src/configuration/native-configuration.ts).
Test: `elicits before native configuration, edits through the real loop, and preserves ordinary
Docker placement` in
[native-configuration.test.ts](../../packages/kernel/tests/integration/native-configuration.test.ts).

## 2. Consent and live session lifetime

Before native model execution or configuration tool access, the host emits `configuration_access`
through the run's elicitation bridge. The prompt names all four resolved roots, native execution
without sandbox or container, permitted mutations, credential exclusions and consent lifetime. Only
`action: accept` with `content.answer: allow_session` grants access. Denial, cancellation, timeout,
missing elicitation, malformed answers and late approval after abort or closure fail closed. Guard
auto mode and a model's `ask_user` answer cannot authorize this route.

`StartRunParams.configuration_session_id` is a volatile nonce scoped to the authenticated owner and
the current file kernel/workspace. Code creates it in a `WeakMap` keyed by the live `Session` object.
Repeated configuration turns in that object reuse consent. Closing/clearing/switching the session
discards its identity; resume constructs another `Session` and receives another nonce, even for the
same saved session id. Kernel reconnect and owner retirement discard host approvals. Neither the
nonce nor consent enters engine requests, saved session metadata, continuation state or trace records.
Other clients must generate a new nonce on every open/resume and never persist it. Omitting it
limits approval to one run. Provider cache hints and `continue_from` never supply authorization.

Concurrent requests sharing a live nonce share one pending prompt. The host retains at most 128
consent entries per resident owner. `retireSession(owner, nonce)` revokes one live instance without
retiring other conversations or owners. Retirement, eviction and host closure abort the consent's
signal, including pending elicitation and active native execution; a late approval cannot revive it.
Every tool operation rechecks consent and cancellation. Native placement stays active until the last
overlapping native run settles. Production: `createNativeConfigurationRuns`;
`configurationSessions` in [run-host.ts](../../packages/code/src/run-host.ts); `toStartParams` in
[kernel-run-client.ts](../../packages/code/src/adapters/kernel-run-client.ts); `StartRunParams` in
[runs.ts](../../packages/protocol/src/runs.ts). Test: `native configuration consent` in
[native-configuration.test.ts](../../packages/kernel/tests/unit/native-configuration.test.ts);
`configuration consent identity lives only in the open TUI session, never in resume` in
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts).
Test: the single-conversation retirement, pending-approval and overlapping-native-work cases in
[native-configuration.test.ts](../../packages/kernel/tests/unit/native-configuration.test.ts).

## 3. Native execution boundary

Approved configuration runs call the host's native loop executor directly. They never initialize a
container, invoke the sandbox launcher, or change the configured placement for subsequent ordinary
runs. They carry a fresh request with one dedicated profile, no MCP servers, no continuation,
no spawn graph, and only the `ask-user` and `native-configuration` capabilities. Hooks, plugins,
shell, normal filesystem tools, memory, plans, tasks and workflows cannot execute in this run.
The configured provider still serves the model using the host's normal authentication; credentials
are not exposed to the model as configuration documents.

Because this route executes no extensions, it does not acquire an Extension Profile run lease or
run its assembly hooks. This permits changes to authored configuration without pinning the very
snapshot being edited. Workspace trust and extension activation remain independent operator
decisions; file edits do not approve them. Ordinary and workflow runs retain their normal admission
and placement. Production: `createNativeConfigurationRuns`, `createConfigurationCapability` in
[capability.ts](../../packages/kernel/src/configuration/capability.ts), and the `runs.start` wrapper
in [kernel.ts](../../packages/kernel/src/kernel.ts). Test: native-configuration integration and
unit tests cited above assert native routing, capability narrowing, no continuation and ordinary
Docker admission after configuration.

The file kernel publishes `RuntimeStatus` as native/host while approved configuration executes and
restores the coordinator's status on settlement. Code's header therefore displays actual host
execution during that turn. Its elicitation has a warning title, a readable live-session label and
denial selected initially. Production: `currentRuntime` in
[file-kernel.ts](../../packages/kernel/src/file-kernel.ts), `ElicitBlock` in
[ElicitBlock.tsx](../../packages/code/src/views/ElicitBlock.tsx), and `DECISION_LABELS` in
[elicitation.ts](../../packages/code/src/adapters/elicitation.ts). Test: the native integration test
asserts host placement and restoration; `native configuration consent has a live-session label and
defaults to denial` in [elicitation.test.ts](../../packages/code/tests/unit/elicitation.test.ts).

## 4. File operations

`configurationRoots` in [configuration.ts](../../packages/paths/src/configuration.ts) owns the four
root names: `global_clarvis`, `workspace_clarvis`, `global_agents`, `workspace_agents`. It honors the
file kernel's global directory, including `CLARVIS_HOME`, and resolves the shared roots under the
user home and workspace. It creates no directories and grants no access by itself.

`configure_clarvis` accepts these operations:

| Operation | Inputs beyond `root` and relative `path` | Result |
| --- | --- | --- |
| `list` | empty path lists a root | at most 200 allowed names and kinds, with truncation/missing indicators |
| `read` | none | UTF-8 content and SHA-256 revision, or null content/revision for an absent file |
| `write` | complete `content`, `expected_revision` | atomic replacement; null revision creates an absent file |
| `edit` | `old_text`, `new_text`, `expected_revision` | replace exactly one occurrence, preserving the remaining bytes, including a UTF-8 BOM and line endings |
| `delete` | `expected_revision` | remove one existing regular file |

Stale or omitted revisions, empty/ambiguous/missing edit matches, malformed settings JSON and settings
schema violations reject without writing. Settings validation uses the owning kernel schema. Other
authored formats retain their normal loader validation and trust checks. File reads and writes are
bounded to 256 KiB; new parents and files use the shared private modes.

Clarvis roots permit `settings.json`, context/policy prompts, and authored `agents`, `skills`,
`plugins`, `workflows`, `extension-profiles` and `runtime-recipes` trees. Shared roots permit `skills`,
`plugins` and `marketplace.json`. Private state, cache, exports, worktrees, keys, subscriptions, auth,
trust records, credential-like filenames, `.env` files and private key files are excluded. Paths
reject traversal, absolute/alternate separators, control characters, Windows devices and alternate
streams. Stable symlink paths, hardlinked leaves and special files are refused. Read descriptors
are checked against the inspected inode and decoded as strict UTF-8. Writes use the shared atomic
replacement helper. Tool envelopes persist operation metadata instead of raw file content.

This is mediated native file access, not an OS isolation boundary. Another process replacing a
parent between validation and mutation remains the documented portable filesystem TOCTOU limit.
Revision checking detects an already changed source; it does not lock out an unrelated external
editor between comparison and replacement. Filename exclusions do not detect every secret an
operator embeds inside an allowed authored document. Changing executable declarations can affect
future authorized runs; this mode never executes them to validate a change.

Production: `configurationFileOperation` in [files.ts](../../packages/kernel/src/configuration/files.ts)
and `createConfigurationCapability`. Test: `native configuration files` in
[configuration-files.test.ts](../../packages/kernel/tests/unit/configuration-files.test.ts) covers
all four roots, edits, stale revisions, settings validation, private paths, traversal, links and
bounded reads; the native integration test exercises the tool through the real loop.

## 5. Configuration coverage and activation

The guide's examples are TypeScript data in `CONFIGURATION_EXAMPLES`, rendered verbatim by
`configurationExample` in
[configuration-examples.ts](../../packages/kernel/src/skills/configuration-examples.ts). They are
fragments to adapt and merge, never instructions to overwrite unrelated configuration. Its body
remains below the 32,768-character regression ceiling and is disclosed on demand.

| Flow | Authored configuration and validation | Activation or remaining operator action |
| --- | --- | --- |
| Models, budgets, MCP, hooks, capabilities and runtime | Settings fragments pass `kernelSettingsSchema` and the real file store | Existing runs retain their resolved settings; host-pinned configuration requires `/reconnect reload` with an idle host; authentication and dependency installation are separate |
| Agent Profiles and subagents | Reviewer plus Marshall overlay assemble into the reachable profile graph | Next ordinary run, with workspace trust for workspace declarations |
| Workflows | Complete `WORKFLOW.md`, relative brief, args, round type/profile, selectors and synthesis | Reloaded each manager run; Admiral or another `workflow` entry invokes the normal preview/preflight and checkpoints |
| Workflow slash launcher | A separate `SKILL.md` declares `agent: admiral` | Normal skill discovery; custom Extension Profiles must select the standalone launcher |
| Plugins and Extension Profiles | A manifest and a nonempty strict definition use exact plugin `global/workspace` and skill `user/workspace` identities | Operator inventories, previews, selects and uses `/reconnect reload` when idle; native file authoring never writes selection or trust state |
| Loop scheduling and background runs | User-operated TUI commands; no new settings fields, grants or native configuration file operations | `/loop` creates in-memory conversation jobs; `/background` hands off an eligible run, `/attach` reattaches and explicit controls manage cancellation |
| Context and policy prompts | Global context plus supported guard/memory prompts | Workspace `CLARVIS.md`/`AGENTS.md` belong at the workspace root, requiring ordinary authorized workspace editing |
| Credentials, subscriptions, workspace trust and UI preferences | Outside the configuration file tool | Operator controls; a functioning default model/provider is a prerequisite for this agent mode |

Custom Extension Profiles select installed plugins and standalone skills; they do not contain
workflow definitions, models or Agent Profiles. An empty custom profile retains product-owned
guidance and workflow definitions while excluding scanned extensions. Creating, selecting and
making a profile effective are separate outcomes. The guide also distinguishes a launch override
from persisted selection, stale preview recovery, safe rename/deletion sequencing, complete
workflow overrides and the possible reappearance of a lower-precedence definition after removal.
Plugin hooks activate with their plugin; there is no separate per-hook approval record.

The guide follows the [loop scheduling](loop-scheduling.md) and [hosted runs](hosted-runs.md)
contracts for user commands, interval/calendar semantics, limits, pausing, handoff and recovery.
Closing the TUI forgets loop registrations; only an admitted occurrence can continue in background.
Reattachment does not replay a prompt or restore configuration consent. Native configuration runs
cannot detach. Plain `/reconnect` recovers the same host connection; `/reconnect reload` requires an
idle host to apply pinned configuration. These are operator actions after the configuration turn,
not tools exposed by loading this guide. The command behavior and its executable evidence remain
owned by those contracts; the builtin distribution checks do not execute TUI journeys.

Production: `CLARVIS_CONFIGURE_SKILL` in
[clarvis-configure.ts](../../packages/kernel/src/skills/clarvis-configure.ts), `CONFIGURATION_EXAMPLES`,
the profile manager and workflow loader linked in the owning
[Extension Profile](extension-profiles.md) and [workflow](../capabilities/workflows-service.md) contracts.
Test: `configuration guide against product loaders` in
[configuration-guidance.test.ts](../../packages/kernel/tests/integration/configuration-guidance.test.ts)
uses native file operations, actual settings/agent/skill/plugin/workflow loaders and Extension
Profile preview/selection/reconnection. It rejects incorrect skill scopes, forbidden global
references and duplicate names, and diagnoses missing briefs. Its real-loop test authors a workflow
in an approved native run, then executes its explorer leader through Admiral with an independent
workflow preflight. The model is scripted; this proves configuration composition and tool behavior,
not a real provider's ability to follow the guide or execute every documented option.
`shipped configuration skill` in
[builtin-skills.test.ts](../../packages/kernel/tests/component/builtin-skills.test.ts) pins verbatim
example embedding and the body budget. `preserves a UTF-8 BOM and CRLF when editing an authored
workflow brief` in
[configuration-files.test.ts](../../packages/kernel/tests/unit/configuration-files.test.ts) covers
byte preservation outside an edited snippet.

## 6. Coupling

The kernel owns the embedded guide, consent, native routing and file policy. Paths owns root
construction and atomic replacement. Protocol carries only the optional volatile identity; Code
owns its open-session lifetime and uses the existing skill/elicitation UI. The loop stays unaware of
this product mode and composes the host-supplied capabilities normally. Skills owns catalog and
on-demand presentation, including the builtin label instead of a fictitious file path. Runtime
bridges never acquire configuration mutation authority.
