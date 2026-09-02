# Agents, tasks, workflows, sessions, memory and run-control screens

> Implemented at `packages/code/src/**` and `packages/code/tests/**`. Every claim below is anchored
> to a file and line. Open questions are collected in the final section.

## 1. Purpose

`@clarvis/code` renders six full-screen "domain hub" views on top of the kernel's protocol
services. Each one owns one domain the terminal user manipulates directly: authoring agent profiles
(`AgentsPanel`), browsing and acting on external tasks (`TasksHub`), inspecting a workflow's manager→leader tree and each node's result
(`WorkflowsHub`), resuming or deleting saved sessions (`SessionsHub`), configuring the workspace
memory block (`MemoryConfigPanel`), and setting the safety/guard/memory/plan-retention posture for
the next run (`RunControlsPanel`). Planning review itself is toggled by `/plan`, outside this hub.

The views are thin. Everything that is not painting is pushed either into a **feature controller**
(`src/features/{agents,tasks}/controller.ts`) — pure orchestration with no presentation
imports (`packages/code/tests/architecture/architecture-boundary.test.ts:167`) — or into an
**adapter** (`src/adapters/{agent-files,agents-store,agents,memory-mode,effort-levels}.ts`) which may
not import `ui/` or `views/` at all
(`packages/code/tests/architecture/architecture-boundary.test.ts:149`). Three shared feature helpers
sit beside them: `features/issues.ts` (validation issue projection), `features/dispose-guard.ts`
(event emission gated on controller teardown, `packages/code/src/features/dispose-guard.ts:17`), and
`features/run/status-presenter.ts`, which turns the framework-free status structures in
`core/run-status.ts` into glyph-rendered strings. The deleted compatibility re-export
`features/notice.ts` is recorded in §8 item 8.

All six views reach their data through `@clarvis/protocol` service interfaces or through
`@clarvis/kernel`'s six sanctioned entrypoints; none of them touches the filesystem or the engine.
`WorkflowsHub`'s own doc comment states the rule: "It reads everything through the kernel's
workflows/runs services, never the local filesystem, so a remote kernel needs no change"
(`packages/code/src/views/config/WorkflowsHub.tsx:106`). `TasksHub` states the same: "All reads and
writes cross `KernelClient.tasks`" (`packages/code/src/views/config/TasksHub.tsx:123`).

## 2. Surface

### 2.1 Registered commands

Every hub is registered as a *view* command. The name/title/surface/parent tuple is a pinned contract
(`packages/code/tests/component/command-composition.test.ts:235-255`, asserted at `:257-264`).

| Command | Title | Slash | Surface | Parent | Registered at |
|---|---|---|---|---|---|
| `agents.open` | Agents | — | `internal` | `settings` | `packages/code/src/features/agents/commands.ts:22` |
| `tasks.open` | Tasks | `/tasks` | `slash` | — | `packages/code/src/app/commands.tsx:258` |
| `sessions.open` | Sessions | `/sessions` | `slash` | `sessions` | `packages/code/src/app/commands.tsx:502` |
| `workflows.open` | Workflows | `/workflow` | `slash` | — | `packages/code/src/app/commands.tsx:534` |
| `controls.open` | Run controls | — | `internal` | `settings` | `packages/code/src/app/commands.tsx` (`controls.open`) |
| `memory.config` | Memory settings | — | `internal` | `settings` | `packages/code/src/app/commands.tsx` (`memory.config`) |

`tasks.open` alone carries `enabled: deps.tasks.available` (`packages/code/src/app/commands.tsx:264`);
the other five are unconditionally registered.

### 2.2 View entry points

All six follow the same signature shape `(host: ViewHost, deps) => JSX.Element`. `ViewHost` is
declared at `packages/code/src/keys/commands.ts:31` and supplies `scope()`/`toggleScope()`/
`bindScope()`, `dirty()`/`markDirty()`/`onSave()`, `level.push/pop/depth`, `confirm()`, `close()` and
`dispatch()`.

| Export | Deps interface | Source |
|---|---|---|
| `AgentsPanel` | `AgentsDeps` = `{ agents: AgentsStore; settings: SettingsAdapter; catalog: ModelsCatalog\|null; code: CodeConfigStore; env: EnvView; notify; controller? }` | `packages/code/src/views/config/AgentsPanel.tsx:58`, `:92` |
| `TasksHub` | `TasksHubDeps` = `{ controller: TasksController; profiles; defaultContainer; workBlockedReason?; onError }` | `packages/code/src/views/config/TasksHub.tsx:59`, `:124` |
| `WorkflowsHub` | `WorkflowsHubDeps` = `{ list; get; getRun; delete?; now; live?; openAgentPicker?; pollMs?; refreshSlowMs? }` | `packages/code/src/views/config/WorkflowsHub.tsx:34`, `:109` |
| `SessionsHub` | `SessionsHubDeps` = `{ sessions; catalog?; now; statusLine; resume; resumeCatalog?; delete? }` plus `SessionCatalogItem` | `packages/code/src/views/config/SessionsHub.tsx:24`, `:34`, `:47` |
| `MemoryConfigPanel` | `MemoryConfigDeps` = `{ settings: SettingsAdapter; memoryMode: MemoryModeStore; notify }` | `packages/code/src/views/config/MemoryConfigPanel.tsx:23`, `:41` |
| `RunControlsPanel` | inline deps `{ settings; guard: GuardModeStore; memory: MemoryModeStore; notify; runActive; openSandbox }` | `packages/code/src/views/config/RunControlsPanel.tsx` (`RunControlsPanel`) |

`refreshSlowMs` on `WorkflowsHubDeps` is explicitly documented as an internal test seam for the
pending-operation warning (`packages/code/src/views/config/WorkflowsHub.tsx:44`).

### 2.3 Feature controllers

| Export | Signature / shape | Source |
|---|---|---|
| `createAgentsController(deps: AgentsControllerDeps): AgentsController` | 20-member reactive controller (`agents`, `conflicts`, `reload`, `draft`, `setDraft`, `openDraft`, `clearDraft`, `patchFm`, `setBody`, `readiness`, `draftIssues`, `toggleGrant`, `toggleSpawn`, `save`, `forkWithNewName`, `createFromTemplate`, `rename`, `remove`, `repointRefs`, `dispose`) | `packages/code/src/features/agents/controller.ts:76`, `:106` |
| `grantTier(grants): GrantTier` | `run_commands`→`exec`, `edit_workspace`→`edit`, `read_workspace`→`read`, else `none` | `packages/code/src/features/agents/controller.ts:59` |
| `sanitizeAgentName(raw): string \| null` | trim, replace `[^a-zA-Z0-9_-]` with `-`, `null` when empty | `packages/code/src/features/agents/controller.ts:67` |
| `CODING_GRANTS`, `TIER_GRANTS`, `ALL_GRANTS`, `RANK` | grant-tier vocabulary re-exported for the panel | `packages/code/src/features/agents/controller.ts:37`, `:40`, `:48`, `:51` |
| `SaveOutcome` | `"saved" \| "blocked" \| "fork-needed" \| "no-draft" \| "error"` | `packages/code/src/features/agents/controller.ts:73` |
| `presentAgentsEvent(event: AgentsEvent): Notice` | total switch over 13 event variants | `packages/code/src/features/agents/events.ts:28` |
| `registerAgentsCommands(commands, deps)` | registers `agents.open` | `packages/code/src/features/agents/commands.ts:21` |
| `createTasksController(deps): TasksController` | read passthroughs + four idempotency-guarded mutations + `workBlocked`/`workOnTask` | `packages/code/src/features/tasks/controller.ts:172` |
| `presentStatusLine`, `memoryNoticeText`, `progressStatusText`, `liveRunStatusLine`, `RunStripInput`, `runOutcomeLabel`, `runStripText` | run-status glyph projections | `packages/code/src/features/run/status-presenter.ts:13`, `:18`, `:23`, `:28`, `:32`, `:58`, `:87` |

### 2.4 Adapters owned by this document

| Export | Signature | Source |
|---|---|---|
| `docToAgentFile(doc: AgentDoc, overlay?: AgentOverlay): AgentFile` | kernel doc → editor file | `packages/code/src/adapters/agent-files.ts:25` |
| `normalizeAgentWrite(file: AgentFile): AgentWrite` | editor file → kernel write; throws on schema failure | `packages/code/src/adapters/agent-files.ts:65` |
| `overlayAgentWrite(draft, base): AgentWrite` | minimal diff overlay against a shipped agent | `packages/code/src/adapters/agent-files.ts:119` |
| `overlayIsEmpty(write): boolean` | no frontmatter keys and empty body | `packages/code/src/adapters/agent-files.ts:135` |
| `readEnvView(env = process.env): EnvView` | `CLARVIS_*` defaults/ceilings, degrading to `loadEnv({})` | `packages/code/src/adapters/agent-files.ts:159` |
| `agentReadiness(agent, registry, settings, env, knownGrants?): ReadinessSeal` | runnability verdict | `packages/code/src/adapters/agent-files.ts:206` |
| `NEW_AGENT_TEMPLATE: AgentTemplate` | the one starting point a scaffolded agent gets | `packages/code/src/adapters/agent-files.ts:250` |
| `AgentFile`, `StoredAgentFile`, `GrantTier`, `EnvView`, `ReadinessSeal`, `AgentTemplate` | editor-side types | `packages/code/src/adapters/agent-files.ts:78`, `:94`, `:140`, `:143`, `:191`, `:233` |
| `findAgentConflicts(summaries): string[]` | names present in >1 config scope | `packages/code/src/adapters/agents-store.ts:40` |
| `loadAgentFiles(config)` / `loadAgentFilesSnapshot(config, prefetched?)` | merged list, and list+conflicts off one round trip | `packages/code/src/adapters/agents-store.ts:71`, `:88` |
| `createAgentsStore(config, initial, initialConflicts = [])` | reactive store with epoch-guarded reload | `packages/code/src/adapters/agents-store.ts:109` |
| `AgentsStore`, `AgentFilesSnapshot` | store contract | `packages/code/src/adapters/agents-store.ts:12`, `:76` |
| `GRANT_CATALOG: readonly GrantSpec[]`, `GrantId`, `GrantSpec` | 6-grant UI catalog | `packages/code/src/adapters/agents.ts:26`, `:5`, `:10` |
| `profileView(profile: ProfileInfo): AgentProfileView` | kernel profile → view | `packages/code/src/adapters/agents.ts:72` |
| `deriveAgentShape(v): AgentShape` | `isLead`/`askUserGranted`/`softMode` | `packages/code/src/adapters/agents.ts:90` |
| `grantBadges(grants, max?): string` | whole-label badge string with `+N` remainder | `packages/code/src/adapters/agents.ts:121` |
| `ClarvisDirs` | `{ global; workspace?; state? }` | `packages/code/src/adapters/agents.ts:69` |
| `createMemoryModeStore(deps): MemoryModeStore` | `configured`/`mode`/`setMode`/`cycle`/`refresh` | `packages/code/src/adapters/memory-mode.ts:32`, contract at `:7` |
| `EFFORT_LEVELS`, `EffortLevel` | `["off","minimal","low","medium","high","xhigh","max"]` | `packages/code/src/adapters/effort-levels.ts:6` |
| `normalizeReasoningEfforts(values)` | provider `none`→`off`, drop unknowns, order-normalize | `packages/code/src/adapters/effort-levels.ts:11` |
| `supportedReasoningEfforts(catalog, providers, modelRef)` | `EffortLevel[] \| undefined` | `packages/code/src/adapters/effort-levels.ts:17` |
| `recommendedReasoningEffort(levels)` | closest-to-`medium`, quality-biased tie-break | `packages/code/src/adapters/effort-levels.ts:33` |
| `issueSet(issues)`, `mapProviderIssues(check, providerName?)`, `mapAgentIssues(seal)`, `saveWarningsNote(warnings)`, `PanelIssue`, `IssueLevel`, `IssueSet` | issue projection | `packages/code/src/features/issues.ts:29`, `:45`, `:87`, `:101`, `:9`, `:6`, `:16` |
| `createDisposeGuard<Event>(emit)` | `isDisposed`/`emit`/`dispose` | `packages/code/src/features/dispose-guard.ts:17` |
| `formatStructuredWorkflowResult(value: object): string`, `parseStructuredWorkflowResult(value: string): object \| undefined` | JSON → Markdown workflow result projection | `packages/code/src/views/config/workflow-result.ts:114`, `:124` |

`views/config/validation.ts` is a thin re-export of `issueSet`/`mapProviderIssues` and their types,
existing "so feature controllers can use them without pulling in theme/UI modules"
(`packages/code/src/views/config/validation.ts:5`).

## 3. Data and formats

### 3.1 `AgentFile` — the editor's agent shape

```
interface AgentFile {
  name: string;
  scope: Scope | "builtin";   // "builtin" = shipped with no config file overlaying it
  frontmatter: AgentFrontmatter;
  body: string;
  invalid?: string;           // zod summary or kernel `malformed` reason
  overlay?: AgentOverlay;     // what a config file did to a shipped agent
}
```
(`packages/code/src/adapters/agent-files.ts:78`.) `StoredAgentFile` narrows `scope` to a writable
`Scope` (`:95`).

`docToAgentFile` has three branches: a kernel-reported `malformed` doc yields empty frontmatter plus
`invalid` (`:29`); a doc whose frontmatter fails `agentFrontmatterSchema` yields empty frontmatter
plus a `zodIssueSummary` (`:39`); otherwise the parsed frontmatter is kept, and an *empty* body with
a `base_prompt` promotes that field into `body` and removes it from frontmatter (`:49`). A frontmatter
key the schema does not name survives into `frontmatter` and back out through `normalizeAgentWrite`
(`packages/code/tests/unit/agent-files.test.ts:77`).

### 3.2 `AgentWrite` overlays

`overlayAgentWrite(draft, base)` returns only the frontmatter keys whose JSON-stringified value
differs from the shipped agent's, and a body only when the trimmed prompt differs
(`packages/code/src/adapters/agent-files.ts:119`). Concretely, from the test corpus: nudging
`iteration_limit` on the shipped `marshall` writes `{ iteration_limit: 80 }` with `body: ""`
(`packages/code/tests/unit/agents-controller.test.ts:360`); changing only the prompt writes
`frontmatter: {}` and the new body (`:378`); re-pointing a shipped agent's spawn list writes
`{ can_spawn: ["assistant"], default_spawn: "assistant" }` and `body: ""` (`:422`). The union of key
sets is walked, so *dropping* a shipped field is recorded explicitly rather than lost
(`packages/code/src/adapters/agent-files.ts:128`; test at
`packages/code/tests/unit/agent-files.test.ts:280`).

### 3.3 `EnvView`

```
{ defaultModel?, budgetOnExceed: "stop"|"escalate", iterationDefault, iterationCeiling,
  tokenCeiling, maxGrant: GrantTier, contextWindowDefault }
```
(`packages/code/src/adapters/agent-files.ts:143`.) Sourced from `loadEnv(env)`
(`@clarvis/kernel/bootstrap`) plus a raw read of `CLARVIS_DEFAULT_MODEL`
(`packages/code/src/adapters/agent-files.ts:167`).

### 3.4 `GRANT_CATALOG`

Six entries, in this order: `read_workspace`/`read`, `edit_workspace`/`edit`,
`run_commands`/`exec`, `ask_user`/`ask`, `use_skills`/`skills`,
`workflow`/`workflow` (`packages/code/src/adapters/agents.ts:26-33`). `TIER_GRANTS` maps the simplified
tier onto grants: `none: []`, `read: ["read_workspace"]`, `edit: ["edit_workspace"]`,
`exec: ["edit_workspace","run_commands"]` (`packages/code/src/features/agents/controller.ts:40`).

`profileView(profile)` (`packages/code/src/adapters/agents.ts:72-80`) distinguishes an *absent*
`grants` field from an *explicitly empty* one: `profile.grants ? (profile.grants as GrantId[]) :
"unknown"` maps a falsy (`undefined`) `grants` to the sentinel `"unknown"`, but `grants: []` is
itself truthy in JavaScript, so an explicitly empty grant list maps to `[]`, not `"unknown"` — the
same unknown-vs-false distinction invariant 19 states for `askUserGranted`, one layer earlier in the
same conversion. Pinned by `packages/code/tests/unit/agents.test.ts:26` ("profileView: absent grants
→ unknown; empty grants → []").

### 3.5 `PanelIssue` and the agent-issue field map

`PanelIssue = { field: string; level: "error"|"warn"; message: string }`
(`packages/code/src/features/issues.ts:9`). `mapAgentIssues` routes readiness codes onto panel
fields via `AGENT_ISSUE_FIELDS` (`:70`):

| Readiness code | Field | Level |
|---|---|---|
| `missing_model`, `unknown_provider`, `invalid_model` | `model` | warn |
| `budget_needs_limit` | `budget` | **error** |
| `unknown_spawn_target` | `can_spawn` | warn |
| `default_spawn_not_in_can_spawn` | `default_spawn` | **error** |
| `orchestration_needs_can_spawn` | `can_spawn` | **error** |
| `unknown_grant` | `grants` | **error** |
| anything else | the code itself | warn |

The error set is `FILE_LOCAL_AGENT_ISSUES` (`packages/code/src/features/issues.ts:62`), described in
its own doc comment as "issue codes that block saving the current draft file, as opposed to codes
that only matter once other agent files also change".

A synthetic issue is prepended ahead of that map: an `AgentFile` carrying `invalid` short-circuits to
`{ code: "malformed_frontmatter", message: agent.invalid }` and `runnable: false`
(`packages/code/src/adapters/agent-files.ts:213`).

`mapProviderIssues(check, providerName?)` (`packages/code/src/features/issues.ts:45`–`:52`) scopes
by identity, not by truthiness: an omitted (`undefined`) `providerName` keeps every issue regardless
of its own `provider` field, while an explicit `providerName` — including the empty string `""` —
keeps only issues whose `provider` equals that string *or* is itself absent (`i.provider === providerName
|| i.provider == null`). Passing `""` therefore is not "keep only issues with `provider: ""`"; it also
admits issues with no `provider` at all. Pinned by
`packages/code/tests/unit/qa-fixes.test.ts:49` ("provider issues scope to a provider whose name is
empty rather than to none").

### 3.6 `AgentsEvent`

Thirteen variants (`packages/code/src/features/agents/events.ts:7`): `save_blocked`, `save_failed`,
`saved` (with optional `warning`), `forked`, `fork_failed`, `already_exists`, `create_failed`,
`renamed`, `rename_failed`, `delete_failed`, `deleted`, `reset_to_shipped`, `unchanged`. Each maps to
a `Notice { message, tone }` where tone ∈ `info|success|warn|error`
(`packages/code/src/ui/notice.ts:2`).

### 3.7 Tasks replay records

`createMutationExecutor` keys a reserved provider input by
`JSON.stringify([operation, ...fields])` (`packages/code/src/features/tasks/controller.ts:68`). The
field lists are fixed per operation:

| Operation | Key fields | Source |
|---|---|---|
| `create` | `provider_key`, `container_id`, `title`, `description`, `acceptance_criteria`, `priority`, `assignee_id`, `labels` | `:132` |
| `assign` | `ref.provider_key`, `ref.id`, `assignee_id` | `:147` |
| `transition` | `ref.provider_key`, `ref.id`, `intent`, `reason` | `:153` |
| `comment` | `ref.provider_key`, `ref.id`, `body` | `:164` |

Each record is `{ input: TaskMutationDto; uncertain: boolean; pending?: Promise }`
(`:78`). `request_id` is minted once per record with `crypto.randomUUID()` (`:142`) and replayed
verbatim on retry. `MAX_UNCERTAIN_MUTATIONS = 32` (`:31`).

### 3.8 Task board vocabulary

`PRIMARY_STAGES = ["backlog","ready","active","blocked","review","done"]`; `EXTRA_STAGES =
["cancelled","other"]`; `STAGE_LABELS` title-cases each
(`packages/code/src/views/config/TasksHub.tsx:35`, `:43`, `:44`). The internal screen enum is
`"tasks"|"detail"|"profiles"|"containers"|"intents"` and the view mode `"board"|"list"` (`:55`,
`:56`). `FaultKind = "fault"|"conflict"|"outcome_unknown"` (`:57`).

### 3.9 Workflow result Markdown

`formatStructuredWorkflowResult` emits `**Structured result**` followed by a recursive projection
(`packages/code/src/views/config/workflow-result.ts:114`): scalars become
`- **Field Label:** value`, nested objects/arrays become `##`..`######` headings clamped between 2 and
6 (`:26`), an empty object becomes `_(empty)_` (`:48`) and an empty array `_(none)_` (`:69`). Array
elements that are objects take a heading `"<n>. <identity>"` where identity is the first present of
`title`, `name`, `path`, `id` — and that key is then omitted from the body so it is not printed twice
(`:30`, `:84`, `:86`). `fieldLabel` splits camelCase and `_`/`-`, sentence-cases the first word and
upper-cases `id`/`url`/`api` (`:1`). Runs of 3+ newlines collapse to 2 (`:119`).

`parseStructuredWorkflowResult` only attempts `JSON.parse` when the trimmed string starts with `{` or
`[` (`:126`) and only returns non-null objects (`:129`).

### 3.10 Effort levels

`EFFORT_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]`
(`packages/code/src/adapters/effort-levels.ts:6`). `normalizeReasoningEfforts` rewrites the provider
word `none` to `off` and then *filters `EFFORT_LEVELS`*, so unknown future values are dropped and the
output is always in canonical order (`:11`; test at
`packages/code/tests/unit/effort-levels.test.ts:72`).

## 4. Behavior

### 4.1 Agents: list → editor

1. `AgentsPanel` builds an `AgentsController` unless `deps.controller` is supplied, and disposes it
   on cleanup (`packages/code/src/views/config/AgentsPanel.tsx:96`, `:112`).
2. It declares `host.bindScope({ mode: "retarget" })` (`:120`) — the scope toggle changes the write
   target rather than reloading.
3. `detachObserved("agents_reload", …)` kicks a background reload (`:115`).
4. L0 renders a 7-cell header (`role`, `name`, `grants`, `model`, `iters`, `ok`, `scope`) and one
   `PickerRow` per agent (`:567`, `:604`). The `grants` cell appends a warning glyph when
   `RANK[tier] > RANK[env.maxGrant]` (`:598`) — the host ceiling makes the configured tier inert.
   The `scope` cell appends `" shadow"` when the name is in `ctrl.conflicts()` (`:637`).
5. `openSelected` (`:193`) resolves four cases in order: an `invalid` agent is refused with a notice
   telling the user to edit the `.md` directly (`:196`); re-opening the agent whose *own* draft is
   unsaved resumes that draft rather than offering discard (`:206`); a conflicted name opens a scope
   picker (`:211`); otherwise the draft guard runs and the editor opens.
6. `openEditor` toggles `host.scope()` to the agent's own scope if they differ, opens the draft and
   pushes a level (`:149`).
7. L1 navigates the fixed 8-row `EDITOR_FIELDS` list: `description`, `model`, `grants`, `can_spawn`,
   `default_spawn`, `iteration_limit`, `reasoning_effort`, `base_prompt`
   (`packages/code/src/views/config/AgentsPanel.tsx:69`). `editField` routes each to its editor
   (`:446`): grants and `can_spawn` open multi-select pickers, `model` opens `modelPickerSpec`,
   `base_prompt` opens the multiline editor bound to `ctrl.setBody`, `iteration_limit` a number
   editor with `min: 1`, `reasoning_effort` an enum seeded from
   `supportedReasoningEfforts(deps.catalog, providers, fm.model ?? default_model)` with a leading
   "Use /effort default" empty option, `default_spawn` an enum over `can_spawn` plus "Choose when
   delegating". `openSpawnPicker` (`:425`–`:444`) also offers `onManual`: a name typed by hand — not
   present in `ctrl.agents()` — is accepted as a forward reference (prompt copy: "agent name (forward
   refs allowed)"); `spawnRows` (`:391`) synthesizes a row for any `can_spawn` entry that names an
   agent that does not exist yet, labelled `"not a known agent yet"` (`:413`–`:421`), so a spawn
   target may cite an agent not yet created.
8. Verbs: L0 has `add`/`rename`/`delete` (keys `a`/`r`/`d` from `PANEL_VERBS`,
   `packages/code/src/ui/patterns/level-keys.ts:41`); L1 has `rename`/`delete`
   (`packages/code/src/views/config/AgentsPanel.tsx:511`).
9. `toggleSpawn` (`packages/code/src/features/agents/controller.ts:192`–`:201`) has three rules no
   other prose in this document states: it is a no-op on the draft's own name (`name === d.name` guard at
   `:194`, pinned by `packages/code/tests/unit/agents-controller.test.ts:191`, "toggleSpawn ignores
   the draft's own name"); removing the last remaining name from `can_spawn` also clears
   `default_spawn` (`:198`–`:199`, pinned at `:173`); and removing a non-default name from a
   multi-entry list leaves `default_spawn` untouched (same lines, pinned at `:182`).

#### Save state machine (`AgentsController.save`, `packages/code/src/features/agents/controller.ts:203`)

| State | Condition | Next / effect |
|---|---|---|
| no draft | `draft() === null` | → `"no-draft"`, no event |
| blocked | any `draftIssues()` at level `error` | → `"blocked"`, emit `save_blocked` |
| shipped, no longer shipped | `d.scope === "builtin"` and `store.read(name,"builtin")` is null | → `"error"`, emit `save_failed` naming "'x' is no longer shipped" (`:220`) |
| shipped, invalid frontmatter | `overlayAgentWrite` throws | → `"error"`, emit `save_failed` (`:227`) |
| shipped, unchanged | `overlayIsEmpty(write)` | → `"saved"`, `markDirty(false)`, emit `unchanged` — **nothing written** (`:230`) |
| shipped, changed | otherwise | write overlay into `deps.scope()`, emit `saved` (`:236`) |
| stored, scope moved | `targetScope !== d.scope` | → `"fork-needed"` (no write, no event) (`:251`) |
| stored, same scope | otherwise | write, emit `saved` carrying `saveWarningsNote(warnings)` when any warn-level issue remains (`:260`) |

On `"fork-needed"` the panel starts a field editor prompting `fork '<name>' to <scope> as` and calls
`ctrl.forkWithNewName` (`packages/code/src/views/config/AgentsPanel.tsx:133`, `:141`).

Every `"error"` branch above (`:220`, `:227`, the write-throw at `:243` and its stored-scope
equivalent) only emits `save_failed` — it never discards or edits the draft, and never calls
`markDirty(false)`, so the unsaved body/frontmatter changes remain exactly as the user left them and
a retry is a plain re-`save()`. The same holds for `forkWithNewName`, `createFromTemplate` and
`rename` on a write failure (`packages/code/src/features/agents/controller.ts:203`–`:266`, all three
`catch` blocks). Pinned by
`packages/code/tests/unit/agents-controller.test.ts:296` ("persistence failures stay owned by the
controller and preserve recoverable state").

After every write path the controller checks `disposed()` before re-publishing state (`:246`, `:258`,
`:277`, `:296`, `:307`, `:332`, `:362`, `:384`) — the `DisposeGuard` also swallows the event
(`packages/code/src/features/dispose-guard.ts:22`).

#### Destructive verbs

`storedScope(a)` returns `null` for `scope === "builtin"`
(`packages/code/src/views/config/AgentsPanel.tsx:288`), and both rename and delete consult it *before*
prompting: rename calls `refuseRename` (`:257`), delete emits "is shipped with Clarvis and cannot be
deleted" (`:309`, `:337`). For a shipped name that *is* customized, `destructiveMessage` says "reset
… to the shipped default, discarding your <scope> customization?" and the confirm label becomes
`reset` (`:273`, `:317`, `:350`); `AgentsController.remove` then emits `reset_to_shipped` rather than
`deleted` (`packages/code/src/features/agents/controller.ts:334`).

#### Rename and reference re-pointing

`rename` calls `store.rename`, patches the live draft's name if it matches, emits `renamed`, and then
runs `repointRefs` (`packages/code/src/features/agents/controller.ts:304`). `repointRefs` collects
every agent citing the old name in `can_spawn` or `default_spawn`, plus `code.agentDefault()`, and
asks for one confirmation naming the total count (`:341`, `:356`). On confirmation it rewrites each
citing agent — writing a *minimal overlay* into `deps.scope()` when the citing agent is `builtin`
(`:371`) — and finally `code.writeAgentDefault(deps.scope(), newName)` (`:386`).

#### `createFromTemplate`

Refuses when `isBuiltinAgent(name)` or the name already exists in the target scope, emitting
`already_exists` (`packages/code/src/features/agents/controller.ts:289`). Otherwise it writes
`NEW_AGENT_TEMPLATE` and reads the agent back (`:293`).

### 4.2 `AgentsStore` reload

`createAgentsStore.reload` increments an instance-local epoch, awaits `config.listAgents()` plus one
`config.getAgent` per winner, and discards the result if a newer reload started meanwhile
(`packages/code/src/adapters/agents-store.ts:119`, `:122`). `resolveAgentFiles` drops `scope === "plugin"`
summaries, resolves precedence via `resolveAgentsByName` and sorts with `compareAgentDisplayOrder`
(`:55`). `write`/`remove`/`rename` each `await reload()` (`:140`, `:144`, `:148`). `read` maps a
kernel `not_found` to `null` and rethrows everything else (`:134`).

### 4.3 Tasks

**Load (`reload`, `packages/code/src/views/config/TasksHub.tsx:224`).** An `AbortController` is
stored in `refreshAbort`; the previous one is aborted first (`:225`). If
`deps.controller.available()` is false the hub synthesizes
`{ state: "not_configured", writes: "disabled", reason: "Tasks are disabled in this host." }` and
clears everything without touching the service (`:233`). Otherwise it fetches `status()`; a non-`ready`
state clears capabilities/containers/rows and sets a fault unless the state is `not_configured`
(`:247`). On `ready` it fetches `capabilities()` and `listContainers({ limit: 100 })` in parallel (`:258`),
prefers the currently selected container or `deps.defaultContainer()` when the provider still lists it
(`:265`), then `search()`. Every write to state is gated on `isCurrentRefresh(controller)` (`:201`).

**Search (`:204`)** remembers the selected `ref.id`, requests `limit: 100` with optional
`container_id`/`query`, and restores the selection index by id, falling back to `0`.

**Write gating.** Four independent predicates each require `status().writes === "enabled"` *and* the
provider's advertised capability: `canCreate`, `canAssign`, `canComment`, `canTransition` (`:164`–
`:169`). `canTransition` additionally requires at least one advertised intent other than `start`.

**Create / assign / comment.** `createTask` (`:407`) refuses before ever prompting when no
`provider_key` is on the current `status()` ("refresh Tasks before creating against this provider")
or no container is chosen — the picked `containerId()` or `deps.defaultContainer()` ("choose a
container before creating a task") — then prompts a title and discards a blank/whitespace-only one
(`title.trim()`). `assignTask` (`:434`) prompts an assignee id seeded from the task's current
assignee, where a blank value is sent as `assignee_id: null` (unassign), and attaches
`expected_revision` whenever the task carries a `revision`. `commentTask` (`:456`) is the same
revision-attachment shape over a multiline prompt, discarding a blank body. All three are pinned
end-to-end by `packages/code/tests/integration/tasks-hub-render.test.tsx:338` ("root actions create,
assign and comment with revision-bound requests").

**Root verbs (`rootVerbs`, `:575`–`:616`).** `r` refresh, `b` toggle board/list, `/` search
(`editSearch`), `o` switch container (when any container is loaded), `x` show/hide extra stages,
`w` work (when a row is selected), `c` create (when `canCreate`), `a` assign (selected row +
`canAssign`), `t` transition (selected row + `canTransition`, opens `openIntents`), `m` comment
(selected row + `canComment`). The container-switch, extra-stage-toggle and search behaviour are
pinned together at `packages/code/tests/integration/tasks-hub-render.test.tsx:563` ("filters,
containers, extra stages and blocking stay explicit").

**Transition (`:526`)** is the only two-phase write. For `complete` and `reopen` it first calls
`previewTransition`, then `host.confirm` showing the previewed stage and native state, marks `reopen`
as `danger`, and carries the preview's `confirmation_token` into the real call (`:530`–`:546`).
`expected_revision` is attached whenever the document carries a `revision` (`:551`). `block` first
prompts for a reason and refuses an empty one (`:565`). `start` is filtered out of `legalIntents`
entirely (`:159`).

**Work on task (`beginWork`, `:338`).** Checks `deps.workBlockedReason?.()` (`:341`) then
`controller.workBlocked()` (`:346`); pre-selects the first profile holding `tasks.read` or
`tasks.progress` (`:350`); pushes the `profiles` screen. `chooseProfile` (`:366`) **re-checks both
gates** (`:370`, `:375`) before `host.close()` and `controller.workOnTask(task.ref, profile.name)`.

**Failure folding (`fail`, `:193`).** If the error's `details.current_task` looks like a task document
it is written back into the board and detail via `replaceSnapshot` *before* the fault is recorded
(`:194`, `taskFromFailure` at `:84`). `faultOf` (`:97`) classifies `details.outcome_unknown === true`
as `outcome_unknown` with the fixed sentence "outcome unknown — the task was re-read; inspect it
before trying again", `code === "conflict"` as `conflict`, everything else as `fault`.

**Idempotent mutations (`createMutationExecutor`,
`packages/code/src/features/tasks/controller.ts:77`).** The record is inserted *before* dispatch so
concurrent writes cannot overflow the bound (`:99`). A record already carrying `pending` returns that
same promise, so two identical actions share one attempt (`:92`). On success the record is deleted
(`:108`). On failure the record is retained — and marked `uncertain` — when
`outcomeIsUnknown(error)` (`details.outcome_unknown === true` or `code === "task_outcome_unknown"`,
`:33`), when `retryFailureIsTransient(error)` (`task_provider_unavailable`, `task_cancelled`,
`cancelled`, `unavailable`, `:58`), or when the record was *already* uncertain (`:111`); otherwise the
record is released (`:113`).

**Layout.** The board packs stage columns 6/3/1 per row at widths ≥132 / ≥88 / below
(`packages/code/src/views/config/TasksHub.tsx:701`), and `stageRows` chunks the stage list to that
width (`:703`).

### 4.5 Workflows

Three levels, expressed as two nullable signals rather than a stack: `inTree() = detail !== null &&
!inNode()`, `inNode() = node !== null`
(`packages/code/src/views/config/WorkflowsHub.tsx:155`, `:156`).

**Empty-list "choose agent" affordance.** When the list screen has no rows, its verbs collapse to
just `r` refresh plus, only when `deps.openAgentPicker` is supplied, an `a` "choose agent" verb
bound directly to it (`:468`–`:474`). Pinned by
`packages/code/tests/integration/workflows-hub-render.test.tsx:287`–`:292` (captures "choose agent").

**Refresh scheduler (`requestRefresh`, `:307`).** One shared single-flight loop over three targets.
`currentRefreshTarget()` picks `node`/`tree`/`list` from the current level (`:303`), the queued target
is overwritten by the newest request (`:309`), and the loop re-runs while `refreshQueued` (`:337`).
`diagnosticAsync` wraps each pass and its `onSlow` sets the visible message "Refresh is still pending;
the backend may be unavailable" (`:334`). A `createEffect` polls at `deps.pollMs ?? 1000` **only while
something is running** — the open node's status, else the open workflow's status, else any list row
(`:396`–`:406`).

**Live merge (`mergeTreeNodes`, `:158`).** The live projection is applied only when
`live.root === executionId` (`:160`). Live nodes are keyed by `runId` over the persisted map, with
live `status` mapped `running→running`, `ok→completed`, anything else→`failed` (`:174`), and the merged
list is re-sorted by `started_at ?? 0` (`:191`).

**Sequence checkpoint.** When `WorkflowDetail.sequence` exists, the tree level renders one bounded
line above the nodes. `awaiting_manager` is warning-toned and names `Awaiting Admiral`, the CAS
revision and proposed next round; every other status names current round/session and cumulative
`leaders_started/max_total_leaders`. Legacy/ad-hoc-only records omit the line. Production:
`packages/code/src/views/config/WorkflowsHub.tsx` (the `detail()?.sequence` block). Test:
`packages/code/tests/integration/workflows-hub-render.test.tsx` (`the persisted tree names an
awaiting-Admiral checkpoint and proposed round`).

**Node page (`NodePage`, `:48`).** `mode: "result"` carries a `RunDetail | null` fetched by
`deps.getRun`; `mode: "task"` carries only the node meta and renders `meta.task` or the fallback "Task
unavailable for this legacy workflow" (`:203`). `[t]` is bound only when the selected node is a
`leader` with a defined `task` (`:459`) and never fetches the run.

**Result rendering (`resultText`, `:62`).** In order: a null run yields either the "Agent is running"
line (status `running`) or "Run detail is not available yet."; `run.result.error` yields
`"error: <message>"`; a string result is passed through `parseStructuredWorkflowResult` and formatted
if it parses; an object result with a string `text` field is treated the same way; any other object is
formatted directly, falling back to "(unserializable result)" if `formatStructuredWorkflowResult`
throws; `undefined` yields "(no result recorded)".

**Short ids (`shortId`, `:123`).** The manager is always `"Manager"`; every other node gets `A1`,
`A2`, … assigned on first sight and memoized in a per-hub `Map`.

**Delete.** Bound only when `deps.delete` exists *and* a row is selected (`:486`); it confirms naming
the workflow title or execution id, then deletes and reloads (`:411`).

### 4.6 Sessions

`items()` prefers a loaded `catalog()` and otherwise projects `deps.sessions()` into
`SessionCatalogItem`s marked `available: true`
(`packages/code/src/views/config/SessionsHub.tsx:51`). The catalog is loaded once in `onMount` and
sorted by `meta.updatedAt` descending (`:62`). `resumeSelected` refuses an unavailable row and
prefers `deps.resumeCatalog` over `deps.resume` (`:71`). `requestDelete` refuses an unavailable row,
confirms with turn count, deletes, removes the row from the local catalog, and **re-clamps the
selection index** (`:81`–`:104`). Verbs: `n` → `host.dispatch("app.clear")`, `x` →
`host.dispatch("session.export")`, `d` present only when `deps.delete` is supplied (`:118`).

### 4.7 Memory settings

`load()` reads the **per-scope** file (not the merged view) and seeds `saved`/`draft` from its
`memory` block, resetting selection and dirty state
(`packages/code/src/views/config/MemoryConfigPanel.tsx:50`). `host.bindScope({ mode: "reload", load })`
(`:58`) — unlike the other panels, changing scope reloads.

Rows: `Memory` (0), `Extraction model` (1, only when a draft block exists), `Session memory` (last)
— `rowCount()` is 3 with a draft and 2 without (`:160`). `editSelected` (`:163`) maps: with no draft,
row 0 → `createBlock()` and anything else → `toggleSessionMode()`; with a draft, 0 → flip `enabled`,
1 → `editModel()`, else → `toggleSessionMode()`.

`createBlock()` copies the *effective* memory block and forces `enabled: true`, and warns when
`default_model` does not resolve (`:115`). `removeBlock()` (key `x`, `:183`) sets the draft to `null`
and notifies that a save is needed. `toggleSessionMode()` (`:145`–`:149`) itself refuses to cycle
when `!deps.memoryMode.configured()`, instead notifying "memory is not configured in settings —
save a block first"; pinned by
`packages/code/tests/integration/memory-config-render.test.tsx:211` ("activating the session row
while memory is not configured warns instead of cycling"). `save()` (`:94`) writes `{ memory: draft ?? undefined }`,
refreshes `memoryMode`, and — when the saved block is enabled — forces the session toggle **on** and
distinguishes an `inert` outcome ("memory model not resolved; memory will not learn") from a live one
(`:100`–`:108`).

`statusLine()` (`:193`) is a five-way ladder over the *effective* settings: no block → "Off — no
memory configuration is effective"; `enabled === false` → "Off — disabled by settings";
`!effectiveResolves()` → "Unavailable — no extraction model resolves"; session mode `off` → "Off for
this session — configured default remains unchanged"; else "On — runs can read and update workspace
memory".

`MemoryModeStore` (`packages/code/src/adapters/memory-mode.ts:32`) keeps `configured()` derived from
settings (block present and `enabled !== false`) behind a manual `version` signal bumped by
`refresh()`, while `mode` is an independent local signal seeded from `configured()` at construction
(`:34`, `:39`, `:40`).

**`statusLine`'s `const cfg = deps.memoryMode.configured(); void cfg;` (`MemoryConfigPanel.tsx:194-195`)
is a deliberate Solid reactivity idiom, not a leftover.** `settings.effective()` — every branch of
`statusLine` reads it — is a plain closure read with no signal call of its own
(`packages/code/src/adapters/settings.ts:295-296`, `function effective(): SettingsFile { return
view.merged as SettingsFile; }`); `SettingsAdapter` exposes a separate `version: Accessor<number>`
(`:122`, `:259`) that a consumer must read explicitly to subscribe to settings changes, and
`MemoryConfigPanel.tsx` never calls `settings.version()`. So without some other subscription,
`statusLine()` would not re-run when settings change underneath it. `MemoryModeStore.configured()`
does read a signal internally — `version()` at `packages/code/src/adapters/memory-mode.ts:33` — so
calling it establishes exactly that subscription in whatever reactive scope calls `statusLine`; the
returned boolean is irrelevant (the five branches never consult it) and is discarded on purpose.
`save()` closes the loop: after writing settings it calls `deps.memoryMode.refresh()`
(`:99`), which bumps `configured`'s underlying `version` signal and retriggers every computation that
previously called `configured()` — including the `StatusRow` render that calls `statusLine()` — so the
freshly retriggered call to `statusLine()` re-reads `settings.effective()` and picks up the new value.
The same idiom, with the identical shape, recurs verbatim (and equally uncommented) in
`packages/code/src/views/config/SandboxConfigPanel.tsx:314,330` — `void savedVersion();` as the first line of both
`effectiveStatus()` and `hostWarning()`, immediately before each reads `deps.settings.effective().sandbox`
— confirming this is an established pattern in this package for "subscribe via a call whose value is
thrown away, and let a sibling non-reactive read pick up fresh state within the retriggered
computation," not something specific to memory or an accidental one-off.

### 4.8 Run controls

Four rows, fixed order: Safety preset (0), Command review (1), Memory for this session (2),
Completed plans (3). `[b] sandbox details` is offered only on row 0, and the host wires it to
`openWithReturn("sandbox.config", "controls.open", host.scope())`. Production:
`packages/code/src/views/config/RunControlsPanel.tsx` (`spec`, `body`) and
`packages/code/src/app/commands.tsx` (`controls.open`).

`host.bindScope({ mode: "retarget" })` is declared with an in-source note that "Every write here goes
to `host.scope()`, so the toggle retargets rather than reloads"
(`packages/code/src/views/config/RunControlsPanel.tsx`, `host.bindScope`).

| Row | Choices | Write |
|---|---|---|
| Safety preset | `free`, `judged`, `approval`, `isolated`, `reviewed`, `protected`, `custom` | shared `applySafetyPreset` |
| Command review | `off`, `on`, `auto` (`:53`) | `applyGuard` (`:211`) |
| Memory | `on`, `off` (`:63`) | `applyMemory` — **session store only** (`:233`) |
| Completed plans | `keep` / `discard` labelled "Keep plans" / "Delete after success" | `applyPlanRetention` |

Run Controls and the `Alt+S` quick picker consume the same product vocabulary and write path from
`features/run/safety-presets.ts`. `safetyPresetConfirmation` requires a danger confirmation before
`free` or `judged`, because both run directly on the host, and warns when any named preset will reset
custom `pass_env`, availability, filesystem, or network tuning. `applySafetyPreset` carries the
effective `sandbox.toolchains` across the reset, then writes the selected scope and synchronizes the
session guard store. Before writing, its scoped policy merge preserves local allow/deny lists and,
for a workspace without local lists, carries the global policy forward so the last-wins guard block
does not shadow it. The `custom` row is descriptive and cannot be selected.

`applyGuard` (`:211`) degrades `auto` to `on` when `guardAutoResolves(settings)` is false, writes the
degraded value and says why (`:219`). It uses the same `guardPolicyForWrite` preservation path.

The Command-review row's `Source` value comes from `guardSource()` (`:357`–`:358`): it reads as the
scope that actually supplied the persisted value (`settingSource("guard")`, itself
`deps.settings.origin?.(key) ?? "product default"`, `:354`) *unless* the live `deps.guard.mode()`
has since diverged from that persisted value, in which case it reads `"session"` — the same
inherited-scope-vs-session-override distinction the memory panel's `Source` badge makes (invariant
47), applied here to the guard mode instead of the memory block. Pinned by
`packages/code/tests/integration/run-controls-render.test.tsx:262` ("command review separates an
inherited scoped value from a session override").

`applyMemory` (`:233`) never writes settings. It sets the session mode and then reports one of three
outcomes computed from `memoryState(effective, mode)`: `inert` → memory will not learn; still `off` →
"enable it in Settings > Memory before the next run"; otherwise the plain confirmation.

The completed-plan row writes only `retention`, through `patchPlansSettings`. That helper materializes
a valid complete plan block by preserving the scoped value first, then effective mode/provider/nudge
siblings, then `PLANS_DEFAULTS`; selecting workspace scope therefore creates an explicit workspace
block without resetting the policy inherited at the moment of the edit. `discard` is not a
"never save" switch: the plan capability persists the live plan and deletes it only after a
successful result; failures, cancellation and interruption retain it. Production:
`packages/code/src/views/config/RunControlsPanel.tsx` (`scopedPlans`, `applyPlanRetention`) and
`packages/code/src/adapters/settings.ts` (`patchPlansSettings`). Plan lifecycle ownership remains in
[capabilities/plan-capability.md](../capabilities/plan-capability.md).

`sandboxLine()` reports the selected native backend's availability, fetched once in `onMount` via
`settings.inspectSandbox()` and defaulting to `null` on failure (`:117`). Its most severe branch —
unavailable *and* `sandboxRequired` — is rendered in the delete color (`:138`). Sandbox semantics
themselves belong to the [execution/sandbox.md](../execution/sandbox.md) document.

## 5. Invariants

The invariants below are derived directly from this document's own source and tests. The first two are
generic `@clarvis/code` architecture rules that bind this scope and are restated here; the rest are
specific to these files.

1. **No `features/**/controller.ts` in this document imports `theme/`, `ui/`, `views/` or any `.tsx`.**
   Holds for `features/agents/controller.ts` and `features/tasks/controller.ts` — verify by their import blocks
   (`packages/code/src/features/agents/controller.ts:1`,
   `packages/code/src/features/tasks/controller.ts:1`).
   Pinned: `packages/code/tests/architecture/architecture-boundary.test.ts:167`.
   Note the rule is scoped to the filename `controller.ts`: `features/agents/events.ts` does import
   `theme/glyphs.ts` (`packages/code/src/features/agents/events.ts:1`) and `features/agents/commands.ts`
   imports `views/config/AgentsPanel.tsx` (`packages/code/src/features/agents/commands.ts:7`).

2. **`src/adapters/**` never imports `ui/` or `views/`.** `agent-files.ts`, `agents-store.ts`,
   `agents.ts`, `memory-mode.ts`, `effort-levels.ts` all comply (see their import headers).
   Pinned: `packages/code/tests/architecture/architecture-boundary.test.ts:149`.

3. **`AgentsPanel.tsx` and `RunControlsPanel.tsx` contain no non-ASCII character outside comments** —
   every rendered glyph goes through `glyph()`.
   Production: `packages/code/src/views/config/AgentsPanel.tsx:7`,
   `packages/code/src/views/config/RunControlsPanel.tsx:7`.
   Pinned: `packages/code/tests/architecture/ascii-source-boundary.test.ts:9`, `:13`, `:28`.
   `WorkflowsHub.tsx` is also in the swept list (`:17`). `TasksHub`, `SessionsHub`,
   `MemoryConfigPanel` is **not** — see §8.

4. **A frontmatter parse failure never seals an agent runnable.** `agentReadiness` short-circuits on
   `agent.invalid` to `{ runnable: false, issues: [{ code: "malformed_frontmatter" }] }` instead of
   evaluating the rules against an empty fallback.
   Production: `packages/code/src/adapters/agent-files.ts:213`.
   Pinned: `packages/code/tests/unit/agent-files.test.ts:231`.

5. **An unrecognised frontmatter key survives the editor round trip.** `docToAgentFile` keeps it and
   `normalizeAgentWrite` writes it back.
   Production: `packages/code/src/adapters/agent-files.ts:50`, `:69`.
   Pinned: `packages/code/tests/unit/agent-files.test.ts:77`, `:99`, `:111`.

6. **A malformed draft is refused rather than half-written.** Both `normalizeAgentWrite` and
   `overlayAgentWrite` throw on a frontmatter that fails `agentFrontmatterSchema`.
   Production: `packages/code/src/adapters/agent-files.ts:67`, `:121`.
   Pinned: `packages/code/tests/unit/agent-files.test.ts:67`, `:303`.

7. **Saving a shipped agent writes a minimal overlay into the current scope, never a copy.**
   Production: `packages/code/src/features/agents/controller.ts:217`–`:249`, using
   `overlayAgentWrite` at `packages/code/src/adapters/agent-files.ts:119`.
   Pinned: `packages/code/tests/unit/agents-controller.test.ts:360` (one key, empty body), `:378`
   (prompt only), `:422` (re-point path).

8. **Saving a shipped agent that matches the shipped default writes nothing.**
   Production: `packages/code/src/features/agents/controller.ts:230`.
   Pinned: `packages/code/tests/unit/agents-controller.test.ts:388`.

9. **Creating an agent under a name Clarvis ships is refused, not silently converted into a
   customization.** Production: `packages/code/src/features/agents/controller.ts:289`.
   Pinned: `packages/code/tests/unit/agents-controller.test.ts:406`.

10. **Deleting a customized shipped agent is reported as a reset.**
    Production: `packages/code/src/features/agents/controller.ts:334`;
    UI wording at `packages/code/src/views/config/AgentsPanel.tsx:273`.
    Pinned: `packages/code/tests/unit/agents-controller.test.ts:414`,
    `packages/code/tests/integration/agents-panel-render.test.tsx:608`.

11. **A shipped agent with no config file can be neither renamed nor deleted, and the panel says so
    before prompting.** `storedScope` returns `null` and the callers bail.
    Production: `packages/code/src/views/config/AgentsPanel.tsx:288`, `:240`, `:295`, `:307`, `:335`;
    the refusal is documented as happening *before* the prompt at `:254`.
    Pinned: `packages/code/tests/integration/agents-panel-render.test.tsx:596`, `:623`, `:633`.

12. **A save blocked by an error-level issue emits `save_blocked` and writes nothing.**
    Production: `packages/code/src/features/agents/controller.ts:206`.
    Pinned: `packages/code/tests/unit/agents-controller.test.ts:199`.

13. **A controller disposed mid-write never republishes state or emits.**
    Production: `packages/code/src/features/agents/controller.ts:246`, `:258`, and the guard at
    `packages/code/src/features/dispose-guard.ts:22`.
    Pinned: `packages/code/tests/unit/agents-controller.test.ts:238`.

14. **A cross-scope conflict on a shipped name is read from `overlay.shadowed`, not from a second
    row.** Production: `packages/code/src/adapters/agents-store.ts:46`.
    Pinned: `packages/code/tests/component/agents-store.test.ts:123` (reported) and `:141` (a single
    customization is not a conflict).

15. **A store seeded from `loadAgentFilesSnapshot` reports a pre-existing conflict on the first
    render.** Production: `packages/code/src/adapters/agents-store.ts:88`, `:109`.
    Pinned: `packages/code/tests/component/agents-store.test.ts:59`, with the contrast case at `:76`.

16. **An out-of-order `listAgents()` response never clobbers fresher state.** Epoch check.
    Production: `packages/code/src/adapters/agents-store.ts:122`.
    Unpinned — no test in `packages/code/tests` exercises two overlapping reloads.

17. **`GRANT_CATALOG` covers every *engine-owned* grant (the four `BuiltinGrant` names retained on
    `grantSchema.options` as a static discovery aid), plus a curated entry for two
    capability-owned grants (`use_skills`, `workflow`) — six total — with unique
    ids and non-empty label/detail. It does NOT cover every grant the kernel actually accepts on a
    run: the seven `tasks.*` grants `@clarvis/tasks` registers (`packages/tasks/src/toolset.ts:12-18`)
    are real, semantically valid grants once that capability is wired in — accepted by
    `requireKnownGrants` and enumerated by `ConfigService.knownGrants()`
    (`packages/kernel/src/kernel.ts:784-805`) — yet have no `GrantSpec` row here at all, so the
    picker never offers them; a profile carrying one renders only via `grantBadges`' raw-id
    fallback. `grantSchema` itself (the zod schema, not its `.options` aid) syntactically accepts
    any non-empty string, so "covers every grant `grantSchema` accepts" is true of neither the
    schema's syntax nor the run-time known-grant set — only of the four-name discovery list. See
    `specs/cross-cutting/grants.md` §2.3 for the full 14-grant inventory.
    Production: `packages/code/src/adapters/agents.ts:32`.
    Pinned: `packages/code/tests/unit/agents.test.ts:59` (checks only that `GRANT_CATALOG` is a
    superset of `grantSchema.options`, the four built-ins — not of every registrable grant),
    `:64` (unique ids and non-empty label/detail; asserts uniqueness, not completeness).

18. **`grantBadges` drops whole labels and appends `+N`; it never elides inside a label.**
    Production: `packages/code/src/adapters/agents.ts`, `grantBadges`, with the in-source account of the
    misleading render it replaced at `:125`–`:127`.
    Pinned: `packages/code/tests/unit/agents.test.ts:73`, `:97`, `:101`.

19. **`askUserGranted` stays `"unknown"` when grants are unknown rather than defaulting to `false`.**
    Production: `packages/code/src/adapters/agents.ts:106`.
    Pinned: `packages/code/tests/unit/agents.test.ts:48`.

20. **A tasks mutation whose outcome may be unknown keeps its exact request id, revision and
    confirmation token for replay; only success releases it.**
    Production: `packages/code/src/features/tasks/controller.ts:98`, `:108`, `:111`.
    Pinned: `packages/code/tests/unit/tasks-controller.test.ts:188`, `:214`, `:248`, `:280`, `:301`.

21. **An uncertain mutation record is never evicted to admit a new intention; the 33rd distinct
    uncertain action is refused with "Too many unresolved task mutations".**
    Production: `packages/code/src/features/tasks/controller.ts:31`, `:93`.
    Pinned: `packages/code/tests/unit/tasks-controller.test.ts:365`.

22. **A definitive (non-transient, non-unknown) mutation failure releases the key, so the next
    attempt mints a fresh `request_id`.**
    Production: `packages/code/src/features/tasks/controller.ts:113`.
    Pinned: `packages/code/tests/unit/tasks-controller.test.ts:396`.

23. **Two concurrent identical task actions share one physical attempt.**
    Production: `packages/code/src/features/tasks/controller.ts:92`, `:119`.
    Pinned: `packages/code/tests/unit/tasks-controller.test.ts:332`.

24. **Every Tasks write is doubly gated: settings-level `writes === "enabled"` and the provider's
    advertised capability.** Production: `packages/code/src/views/config/TasksHub.tsx:164`–`:169`.
    Pinned: `packages/code/tests/integration/tasks-hub-render.test.tsx:247`.

25. **`complete` and `reopen` require a preview-derived `confirmation_token` and an explicit human
    confirmation.** Production: `packages/code/src/views/config/TasksHub.tsx:530`–`:546`.
    Pinned: `packages/code/tests/integration/tasks-hub-render.test.tsx:274`.

26. **The `start` intent is never offered to the human.**
    Production: `packages/code/src/views/config/TasksHub.tsx:159`.
    Unpinned as an explicit assertion; `packages/code/tests/integration/tasks-hub-render.test.tsx:274`
    exercises the filtered list indirectly.

27. **"Work on task" re-checks both the host block and the run block *after* the agent picker
    opens.** Production: `packages/code/src/views/config/TasksHub.tsx:369`, `:373`.
    Pinned: `packages/code/tests/integration/tasks-hub-render.test.tsx:319` ("rechecks the memory fuse
    after the agent picker opens"), and the first gate at `:306`.

28. **A superseded task read can never replace current state.** Detail, intent-lookup and board
    refresh each compare their `AbortController` identity, the current screen and the current
    selection before committing.
    Production: `packages/code/src/views/config/TasksHub.tsx:201`, `:318`, `:500`, `:512`.
    Pinned: `packages/code/tests/integration/tasks-hub-render.test.tsx:413`, `:453`, `:497`, `:529`.

29. **When the host disables Tasks, the hub synthesizes a `not_configured` status without calling the
    service at all.** Production: `packages/code/src/views/config/TasksHub.tsx:233`.
    Pinned: `packages/code/tests/integration/tasks-hub-render.test.tsx:659`.

30. **Workflow polling is single-flight, coalesces ticks into one trailing refresh, and stops on
    teardown.** Production: `packages/code/src/views/config/WorkflowsHub.tsx:315`, `:337`, `:396`.
    Pinned: `packages/code/tests/integration/workflows-hub-render.test.tsx:206` (asserts `maxActive`
    stays 1 and no further call is made after `renderer.destroy()`).

31. **A refresh that never settles becomes visible rather than silent, and stays one physical
    request.** Production: `packages/code/src/views/config/WorkflowsHub.tsx:332`.
    Pinned: `packages/code/tests/integration/workflows-hub-render.test.tsx:257`.

32. **A failed refresh preserves the last good state at every level.**
    Production: `packages/code/src/views/config/WorkflowsHub.tsx:151`, `:272`, `:294`.
    Pinned: `packages/code/tests/integration/workflows-hub-render.test.tsx:170` (list), `:846`
    (tree), `:870` (node); the initial-load failure case at `:159`.

33. **The live projection is merged only when it belongs to the workflow on screen.**
    Production: `packages/code/src/views/config/WorkflowsHub.tsx:160`.
    Pinned: `packages/code/tests/integration/workflows-hub-render.test.tsx:349`.

33a. **A persisted `awaiting_manager` checkpoint remains visible even when no leader is live.**
    It names the exact revision and proposed round rather than inferring continuation from tree
    shape. Production: `WorkflowsHub` (`detail()?.sequence`). Pinned:
    `packages/code/tests/integration/workflows-hub-render.test.tsx` (`the persisted tree names an
    awaiting-Admiral checkpoint and proposed round`).

34. **`[t]` (open task) is bound only for a `leader` node carrying a `task`, and never fetches the
    run.** Production: `packages/code/src/views/config/WorkflowsHub.tsx:381`, `:459`.
    Pinned: `packages/code/tests/integration/workflows-hub-render.test.tsx:701`, `:733`.

35. **A workflow delete is confirmed by name, and `[d]` is unbound without a `delete` dependency or a
    selected row.** Production: `packages/code/src/views/config/WorkflowsHub.tsx:411`, `:486`.
    Pinned: `packages/code/tests/integration/workflows-hub-render.test.tsx:764`, `:774`, `:788`,
    `:805`.

36. **Ordinary prose is never reinterpreted as a structured workflow result.**
    Production: `packages/code/src/views/config/workflow-result.ts:126`.
    Pinned: `packages/code/tests/unit/workflow-result.test.ts:37`.

37. **A cyclic result object fails explicitly (`TypeError("cyclic workflow result")`) rather than
    recursing forever.** Production: `packages/code/src/views/config/workflow-result.ts:45`, `:67`.
    Pinned: `packages/code/tests/unit/workflow-result.test.ts:43`.

38. **Deleting a session re-clamps the selection so a row stays marked.**
    Production: `packages/code/src/views/config/SessionsHub.tsx:101`, with the in-source account of
    the defect at `:98`.
    Pinned: `packages/code/tests/integration/sessions-hub-render.test.tsx:106`.

39. **A session whose workspace is unavailable can be neither resumed nor deleted.**
    Production: `packages/code/src/views/config/SessionsHub.tsx:73`, `:83`, and the activate guard at
    `:115`. Pinned: `packages/code/tests/integration/sessions-hub-render.test.tsx:136`.

40. **The memory panel's `Source` badge names the scope whose value actually won the merge, not the
    scope on screen.** Production: `packages/code/src/views/config/MemoryConfigPanel.tsx:92`, with the
    Pinned: `packages/code/tests/integration/memory-config-render.test.tsx:376`.

41. **Creating a memory block copies the effective block and forces `enabled: true`.**
    Production: `packages/code/src/views/config/MemoryConfigPanel.tsx:116`.
    Pinned: `packages/code/tests/integration/memory-config-render.test.tsx:150`.

42. **The session toggle is inert while no memory block is configured, and says so.**
    Production: `packages/code/src/views/config/MemoryConfigPanel.tsx:146`.
    Pinned: `packages/code/tests/integration/memory-config-render.test.tsx:211`.

43. **A save whose block is enabled but whose extraction model does not resolve warns that memory will
    not learn.** Production: `packages/code/src/views/config/MemoryConfigPanel.tsx:102`.
    Pinned: `packages/code/tests/integration/memory-config-render.test.tsx:332`, and the equivalent
    warning on the session toggle at `:94`.

44. **`configured()` only becomes true again after an explicit `refresh()` — settings files are not
    reactive.** Production: `packages/code/src/adapters/memory-mode.ts:34`, `:50`.
    Pinned: `packages/code/tests/unit/memory-mode.test.ts:56`.

45. **The Run-controls memory row changes only the session store, never settings.**
    Production: `packages/code/src/views/config/RunControlsPanel.tsx` (`applyMemory`).
    Pinned: `packages/code/tests/integration/run-controls-render.test.tsx:187`.

46. **A direct guard-mode write and a named safety preset both preserve the effective allow/deny
    policy; a workspace with no local lists carries forward the global lists.** Production:
    `packages/code/src/features/run/safety-presets.ts` (`applySafetyPreset`, `scopedGuardPolicy`) for
    presets and `packages/code/src/views/config/RunControlsPanel.tsx` (`guardPolicyForWrite`,
    `applyGuard`) for direct guard writes. Pinned: `packages/code/tests/unit/safety-presets.test.ts`
    and `packages/code/tests/integration/run-controls-render.test.tsx`.

47. **`auto` without a resolvable judge model persists `on`, not a misleading `auto`.**
    Production: `packages/code/src/views/config/RunControlsPanel.tsx` (`applyGuard`).
    Pinned: `packages/code/tests/integration/run-controls-render.test.tsx:234`.

48. **Run Controls contains no planning-mode selector; completed-plan retention is its only editable
    plan row.** Planning review belongs to `/plan`. Production:
    `packages/code/src/views/config/RunControlsPanel.tsx` (`activate`, `body`). Pinned:
    `packages/code/tests/integration/run-controls-render.test.tsx` ("Run controls exposes retention
    without a planning-mode control").

49. **A completed-plan retention write preserves mode, pending-task nudges and provider while
    targeting the selected scope.** Production:
    `packages/code/src/views/config/RunControlsPanel.tsx` (`applyPlanRetention`) and
    `packages/code/src/adapters/settings.ts` (`patchPlansSettings`). Pinned:
    `packages/code/tests/integration/run-controls-render.test.tsx` (global/provider and workspace
    preservation cases).

50. **Every safety-preset selector shares one six-choice vocabulary and one application path; a
    preset that discards custom sandbox tuning asks first and carries `toolchains` across. `judged`
    means sandbox off plus guard auto, with an explicit direct-host confirmation and user fallback
    when the judge cannot resolve.** Production:
    `packages/code/src/features/run/safety-presets.ts` (`SAFETY_PRESET_CHOICES`,
    `safetyPresetConfirmation`, `applySafetyPreset`),
    `packages/code/src/views/config/RunControlsPanel.tsx`, and
    `packages/code/src/views/overlays/SafetyPresetPicker.tsx`. Pinned:
    `packages/code/tests/unit/safety-presets.test.ts`,
    `packages/code/tests/integration/run-controls-render.test.tsx`, and
    `packages/code/tests/integration/safety-preset-picker-render.test.tsx`.

51. **A settled run's outcome label is classified only from the segment before the first separator.**
    Production: `packages/code/src/features/run/status-presenter.ts:59`, with the in-source account of
    the defect at `:51`.
    Pinned: `packages/code/tests/unit/qa-fixes.test.ts:39`.

52. **The run strip reports *uncached* input tokens and *gross* context.**
    Production: `packages/code/src/features/run/status-presenter.ts:87-102`.
    Pinned: `packages/code/tests/unit/run-status.test.ts:79-115`.

53. **`recommendedReasoningEffort` never returns `off` and breaks a distance tie toward the higher
    level.** Production: `packages/code/src/adapters/effort-levels.ts:36`, `:39`.
    Pinned: `packages/code/tests/unit/effort-levels.test.ts:76`.

54. **A model the catalog knows lacks `reasoning` yields an empty effort list, while an unknown model
    yields `undefined`.** Production: `packages/code/src/adapters/effort-levels.ts:24`, `:28`.
    Pinned indirectly: `packages/code/tests/integration/agents-panel-render.test.tsx:414`
    ("reasoning support notes distinguish unsupported and unknown capabilities").

55. **`saveWarningsNote` pluralizes and names the first warning.**
    Production: `packages/code/src/features/issues.ts:101`.
    Pinned: `packages/code/tests/unit/issues.test.ts:4`.

56. **`presentAgentsEvent` handles every `AgentsEvent` variant.**
    Production: `packages/code/src/features/agents/events.ts:28`.
    Pinned: `packages/code/tests/unit/agents-events.test.ts:89` — the file names it an
    "exhaustiveness canary".

57. **The six hubs' command metadata (name, title, surface, parent) is a pinned contract and each
    has exactly one registered factory.**
    Production: the registration sites in §2.1.
    Pinned: `packages/code/tests/component/command-composition.test.ts:235-255`, asserted at `:257-264`.

## 6. Failure modes and degradation

| Condition | Handler | Behavior |
|---|---|---|
| `loadEnv(env)` throws on a malformed environment | `packages/code/src/adapters/agent-files.ts:163` | falls back to `loadEnv({})`; a usable `EnvView` is always produced. Pinned at `packages/code/tests/unit/agent-files.test.ts:141`, `:146` |
| Agent frontmatter fails the schema on *read* | `packages/code/src/adapters/agent-files.ts:38` | file is kept and listed with `invalid` set; the panel refuses to open it and tells the user to edit the `.md` (`packages/code/src/views/config/AgentsPanel.tsx:196`) |
| Agent frontmatter fails the schema on *write* | `packages/code/src/adapters/agent-files.ts:67`, `:121` | throws; the controller catches and emits `save_failed` (`packages/code/src/features/agents/controller.ts:227`, `:243`) |
| `config.getAgent` returns a kernel `not_found` | `packages/code/src/adapters/agents-store.ts:134` | `read()` yields `null`; any other error rethrows |
| Agent delete fails | `packages/code/src/features/agents/controller.ts:328` | emits `delete_failed` **and rethrows**, so the panel's caller does not pop the level (`packages/code/src/views/config/AgentsPanel.tsx:324`, `:354`) |
| Any agent save/fork/create/rename write throws | `packages/code/src/features/agents/controller.ts:203`–`:266` | draft body/frontmatter and controller state are left exactly as before the call — no discard, no `markDirty(false)`; a retry is a plain re-call. Pinned at `packages/code/tests/unit/agents-controller.test.ts:296` |
| Controller torn down mid-operation | `packages/code/src/features/dispose-guard.ts:22` | event is dropped; the operation still completes |
| Tasks host capability off | `packages/code/src/views/config/TasksHub.tsx:233` | synthetic `not_configured` status; no service call |
| Tasks provider not `ready` | `packages/code/src/views/config/TasksHub.tsx:247` | board cleared; `not_configured` shows no fault, any other state shows `status.reason` or `provider <state>` |
| Tasks error carrying `details.current_task` | `packages/code/src/views/config/TasksHub.tsx:194` | the returned document is written into board and detail before the fault is shown |
| `details.outcome_unknown === true` | `packages/code/src/views/config/TasksHub.tsx:102` | fault kind `outcome_unknown` with a fixed instruction to inspect before retrying; the replay record is retained (`packages/code/src/features/tasks/controller.ts:111`) |
| Tasks error `code === "conflict"` | `packages/code/src/views/config/TasksHub.tsx:118` | fault kind `conflict`; the replay record is **released** (not in the transient list at `packages/code/src/features/tasks/controller.ts:58`) |
| >32 unresolved task mutations | `packages/code/src/features/tasks/controller.ts:94` | a *new* intention is refused with an actionable message; retrying an existing one still works |
| Task create with no provider key or container | `packages/code/src/views/config/TasksHub.tsx:409`, `:414` | refused with "refresh Tasks before creating against this provider" / "choose a container before creating a task" |
| Workflow list/tree/node fetch fails | `packages/code/src/views/config/WorkflowsHub.tsx:151`, `:272`, `:294` | `loadError` is set and rendered above the body; the previous data is retained |
| Workflow refresh never settles | `packages/code/src/views/config/WorkflowsHub.tsx:334` | "Refresh is still pending; the backend may be unavailable"; still one in-flight request |
| Workflow result cannot be stringified | `packages/code/src/views/config/WorkflowsHub.tsx:82`, `:89` | "(unserializable result)". Pinned at `packages/code/tests/integration/workflows-hub-render.test.tsx:636` |
| Leader node has no `task` (legacy record) | `packages/code/src/views/config/WorkflowsHub.tsx:203` | "Task unavailable for this legacy workflow"; `[t]` is unbound (`:459`) |
| `settings.inspectSandbox()` rejects | `packages/code/src/views/config/RunControlsPanel.tsx` (`onMount`) | availability stays `null`; the row reads "Checking native sandbox on the kernel host…" indefinitely |
| Any Run-controls settings write throws | `packages/code/src/views/config/RunControlsPanel.tsx` (`applyPreset`, `applyGuard`, `applyPlanRetention`) | `notify(errorText(error))`; the session store is not updated |
| Session-memory toggle activated with no configured memory block | `packages/code/src/views/config/MemoryConfigPanel.tsx:145`–`:149` | refuses to cycle; notifies "memory is not configured in settings — save a block first". Pinned at `packages/code/tests/integration/memory-config-render.test.tsx:211` |
| Any detached async operation rejects unobserved | `packages/code/src/core/tasks.ts:27` | a `task.failed` diagnostic event is emitted with the operation name; nothing is thrown into the render tree |

Degradation that is deliberately silent: `AgentsPanel.openConflictPicker`'s pick discards a `null`
read without notice (`packages/code/src/views/config/AgentsPanel.tsx:186`); `sanitizeAgentName`
returning `null` aborts the create/rename/fork prompt with no message
(`packages/code/src/views/config/AgentsPanel.tsx:135`, `:228`, `:244`); and `WorkflowsHub.openWorkflow` swallows the error of a
request that has been superseded by a queued one (`packages/code/src/views/config/WorkflowsHub.tsx:244`).

## 7. Coupling

### 7.1 Outbound, forced by static value imports

| From | To | Forced by |
|---|---|---|
| `adapters/agent-files.ts` | `@clarvis/kernel/config` (`agentFrontmatterSchema`, `profileReadinessIssues`), `@clarvis/kernel/bootstrap` (`loadEnv`) | `packages/code/src/adapters/agent-files.ts:1`, `:7` |
| `adapters/agents-store.ts` | `@clarvis/kernel/config` (`compareAgentDisplayOrder`, `resolveAgentsByName`), `solid-js` | `packages/code/src/adapters/agents-store.ts:1`, `:3` |
| `features/agents/controller.ts` | `@clarvis/kernel/config` (`isBuiltinAgent`), `solid-js` | `packages/code/src/features/agents/controller.ts:19`, `:1` |
| `views/config/AgentsPanel.tsx` | `@clarvis/kernel/config` (`isBuiltinAgent`) | `packages/code/src/views/config/AgentsPanel.tsx:33` |
| `adapters/guard-mode.ts` | `@clarvis/kernel/policy` (`defaultGuardMode`) | `packages/code/src/adapters/guard-mode.ts` (`defaultGuardMode` import) |
| `adapters/agents.ts` | `@clarvis/paths` (types only) | `packages/code/src/adapters/agents.ts:1` |
| `views/config/{TasksHub,WorkflowsHub}.tsx`, `features/tasks/controller.ts` | `@clarvis/protocol` — **type-only** | `packages/code/src/views/config/TasksHub.tsx:5`, `packages/code/src/views/config/WorkflowsHub.tsx:6`, `packages/code/src/features/tasks/controller.ts:1` |

Only the six kernel entrypoints appear (INV-251) — full statement owned by
[hosts/code-bootstrap.md](code-bootstrap.md) §5.

`features/tasks/controller.ts` imports only types from `@clarvis/protocol`, so it holds no runtime
edge to the kernel. `TasksController` is a structural `ReturnType<>` alias
(`packages/code/src/features/tasks/controller.ts:203`).

### 7.2 Inbound

| Consumer | What it needs | Site |
|---|---|---|
| `src/app/commands.tsx` | five of the six views + their deps | `packages/code/src/app/commands.tsx`; Agents is registered by `src/features/agents/commands.ts` |
| `src/features/agents/commands.ts` | `AgentsPanel` | `packages/code/src/features/agents/commands.ts:7` |
| `src/views/App.tsx` | `SessionCatalogItem` (type) | `packages/code/src/views/App.tsx:66` |
| `src/views/App.tsx` | `runStripText` | `packages/code/src/views/App.tsx:86` |
| `src/runtime.tsx` | `progressStatusText`, `presentStatusLine` | `packages/code/src/runtime.tsx` (`runApp`, `buildRunHost`) |
| `src/views/overlays/AgentProfilePicker.tsx` | `deriveAgentShape`, `grantBadges` | `packages/code/src/views/overlays/AgentProfilePicker.tsx:5` |
| `src/adapters/active-agent.ts` | `profileView`, `deriveAgentShape` | `packages/code/src/adapters/active-agent.ts:4` |
| `src/features/providers/controller.ts` | `createDisposeGuard` | `packages/code/src/features/providers/controller.ts:20` |
| `src/views/config/validation.ts` | `issueSet`, `mapProviderIssues` from `features/issues.ts` | `packages/code/src/views/config/validation.ts:8` |

### 7.3 Shared UI seams (owned elsewhere)

Every hub registers its keys through `registerLevel(host.interaction.keymap, spec)` and
`bindLevelKeys` (`packages/code/src/ui/patterns/level-keys.ts`,
`packages/code/src/views/config/view-host.tsx`); rows come from `SelectableList`/`SelectableRow`/
`PickerRow`/`SettingRow`/`StatusRow`; async work is detached through `detachObserved`
(`packages/code/src/core/tasks.ts:22`) and instrumented with `diagnosticAsync`/`diagnosticCount`
(`packages/code/src/core/diagnostic-events.ts:138`). Those primitives belong to the
[hosts/code-settings-panels.md](code-settings-panels.md) and TUI-navigation documents.

### 7.4 Explicit delegations

- Sandbox semantics, `SandboxConfigPanel`, `probeSandbox` → [execution/sandbox.md](../execution/sandbox.md).
- `CapabilityProvidersPanel` → [capabilities/provider-executables.md](../capabilities/provider-executables.md).
- `DoctorView`, `KeyboardView` → their own documents.
- `execution-safety.ts` (`deriveRunControls`, `memoryState`, `deriveSafetyPreset`,
  `settingsForPreset`, `planRetentionDescription`, `safetyDescription`, `memoryDescription`),
  `guard-mode.ts`, `session-store.ts`, `workflow-projection.ts`, `settings.ts` →
  [hosts/code-run-host.md](code-run-host.md) / [hosts/code-settings-panels.md](code-settings-panels.md).
- The domain semantics behind each hub — the tasks provider contract, workflow
  documents, memory wiki, plan documents, the shipped agent fleet and overlay resolution — belong to
  the capability documents and to [hosts/kernel-config.md](kernel-config.md).

## 8. Open questions

1. **Why `TasksHub.tsx`, `SessionsHub.tsx` and `MemoryConfigPanel.tsx` are
   outside the ASCII sweep.** `packages/code/tests/architecture/ascii-source-boundary.test.ts:4`
   lists fourteen files; these four are not among them, and all four *do* render literal non-ASCII
   characters — `·` throughout `TasksHub.tsx` (e.g. `:723`, `:729`, `:734`, `:880`), a literal
   `${"—"}` in `packages/code/src/views/config/SessionsHub.tsx:88`, em-dashes in eight `MemoryConfigPanel.tsx` status strings
   (`:198`–`:264`). Whether the sweep list is
   an intentional subset or has simply not caught up is not stated anywhere in the code.

3. ~~**`AGENT_TEMPLATES` is a `Record<string, AgentTemplate>` with exactly one key, and
   `createFromTemplate` hard-codes `AGENT_TEMPLATES.explorer!`**~~ **Resolved 2026-08-22 — collapsed
   to `NEW_AGENT_TEMPLATE: AgentTemplate`** (`packages/code/src/adapters/agent-files.ts`), and the
   `!` is gone with it. Whether more templates were once planned is still not stated, but the
   question the map raised is answered by the flow's own shape: `createFromTemplate(name)` takes the
   *agent's* name and never a template's, so there was no argument by which a second entry could have
   been selected. A `Record` read as a picker whose other entries had not been written; a single
   constant reads as what it is. Its docstring now records why one, and why a read-only investigator
   is the right floor: every grant a new agent ends up with is then one the user added on purpose.

4. ~~**`WorkflowsHub`'s `shortId` counter is never reset.**~~ **Resolved:** the reset boundary is the
   view's mount/dispose lifecycle, not "session" in any looser sense. `nextShortId` and `shortIds`
   (`packages/code/src/views/config/WorkflowsHub.tsx:121`–`:122`) are closure state created exactly
   once, when `WorkflowsHub(host, deps)` runs as the `view` factory of the `"workflows.open"`
   registration (`packages/code/src/app/commands.tsx`, `workflows.open`); `backToList()`
   (`:387`–`:390`) only clears the `detail`/`node` **signals**, never touching the counter, because
   navigating from a workflow's tree back to the list is internal `setDetail`/`setNode` state inside
   the same still-mounted instance (`openWorkflow`, `:214`–`:239`, sets `detail` without remounting).
   The counter is discarded only when the view itself is unmounted: `CommandUi.openView`
   (`packages/code/src/views/overlay-host.ts:264`–`:266`) no-ops when the requested view is already
   the top frame (`current?.name === name`), so re-running `/workflow` while already inside it does
   not remount either — the only way to get a fresh `WorkflowsHub` instance (and so a counter reset
   back to `A1`) is to close the Workflows view entirely (pop it off the overlay stack, disposing its
   Solid root) and reopen it. So: opening a second workflow's tree via "back to list" **without**
   leaving the Workflows view continues numbering (`A2`, `A3`, ...); closing the view and reopening it
   resets to `A1`. No test pins either half of this, and no comment states it is deliberate, but the
   mechanism itself is fully determined by `openView`'s same-name no-op plus the view factory's
   one-shot closure — there is no second reading of when the counter clears.

5. **`AgentsController.openDraft` drops `invalid` and `overlay`** when copying the file into the draft
   (`packages/code/src/features/agents/controller.ts:121`). Since `openSelected` refuses `invalid`
   agents this is consistent for `invalid`, but the loss of `overlay` means the editor cannot show
   what a shipped agent's overlay did once the draft is open. Whether that is deliberate is not
   recorded.

6. **`AgentsStore.reload`'s epoch guard (invariant 16) is unpinned.** No test in
   `packages/code/tests` interleaves two reloads. Likewise unpinned: the custom-sandbox confirmation
   branch in `RunControlsPanel.applyPreset` (invariant 50), and the `start`-intent exclusion
   (invariant 26) as a direct assertion.

7. **`GrantId` is a closed union in `packages/code/src/adapters/agents.ts:5`, but the panel writes it through
   `patchFm({ grants })` onto an `AgentFrontmatter`** whose grant vocabulary is the kernel's open
   registry. The doc comment at `packages/code/src/adapters/agents.ts:28` says "Unknown grants already
   stored on a profile are preserved and rendered by their raw id", and `grantBadges` does fall back
   to the raw id (`:134`) — but `toggleGrant` only ever receives a `GrantId`
   (`packages/code/src/features/agents/controller.ts:184`), so how an unknown grant reaches the
   toggle path, if ever, is not determinable from this package. The seven `tasks.*` grants
   (`specs/cross-cutting/grants.md` §2.3) are a concrete, real-world instance of exactly such an
   "unknown grant" from this package's point of view — `GRANT_CATALOG`/`ALL_GRANTS` has no row for
   any of them (invariant 17) — but whether a profile carrying one is reachable through this editor
   at all, short of hand-editing the underlying file outside `code`, is not settled by this
   package's source.

8. ~~**`features/notice.ts` is a two-line type re-export** whose header calls it a "Compatibility
   surface for feature presenters".~~ **Resolved 2026-08-22 — deleted.** What it was compatible
   *with* is not in the code because it was compatible with nothing: it re-exported `Notice` and
   `NoticeTone` from `ui/notice.ts` for two consumers (`features/providers/events.ts`,
   `features/agents/events.ts`), both of which took only `Notice`, while the boundary its header
   implied is contradicted two files over — `features/run/status-presenter.ts` and
   `features/providers/request-params.ts` both import from `ui/` directly, and no architecture test
   forbids it. The two consumers now import from `../../ui/notice.ts` like everything else.

9. **Task provider concurrency wording.** `TasksHub.concurrency()` maps
   `exclusive_claim|revision|none` onto prose and colours `none` as a warning
   (`packages/code/src/views/config/TasksHub.tsx:170`, `:734`). The consequence of `none` for a user
   is not spelled out anywhere in `code`; it belongs to [capabilities/tasks-domain.md](../capabilities/tasks-domain.md).

10. **`WorkflowsHubDeps.refreshSlowMs` is described in-source as an internal test seam** but is also
    the only way to shorten the slow-operation warning. Whether
    production ever sets them — and what the default `slowMs` is when they are omitted — depends on
    `core/diagnostic-events.ts`, which is outside this document's scope; the registration site in
    `packages/code/src/app/commands.tsx` passes none.
