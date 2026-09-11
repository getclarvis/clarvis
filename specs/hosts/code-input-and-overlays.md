# The input dock, autocomplete and overlays

> Implemented at
> `packages/code/src/{views/InputDock.tsx, views/input/**, views/overlays/**, app/commands.tsx, features/run/{isolation,review}.ts, core/{prompt-history,fuzzy,attachments}.ts, adapters/local-shell.ts}`.
> Every claim below is anchored to a file and a named symbol or test. Open questions are collected in the final
> section.

## 1. Purpose

This subsystem is everything the user types into and everything that floats over the transcript:
the composer textarea (`InputDock.tsx`), the trigger-based completion popup it drives
(`views/input/*`), the pure text-parsing helpers behind both (`core/{prompt-history,fuzzy,
attachments}.ts`), the generic floating-card chrome and the concrete cards built from it
(`views/overlays/*`), the app-level command registrations that give the `/slash` surface and
configuration hubs their contents (`app/commands.tsx`), and the one deliberate escape hatch that runs a shell
command outside the agent loop entirely (`adapters/local-shell.ts`).

The unifying problem is turning one line of typed text into one of four dispatches — an ordinary
chat message, a `/slash` command, a `!shell` command, or a `@mention`/attachment — while a single
popup (`AutocompletePopup`) and a family of generic list/card primitives (`FloatFrame`,
`ListPicker`, `PickerRow`, `ChoiceRows`, `FilterField`) serve every place in the app that needs a
searchable, keyboard-navigable, windowed list: the Agent Profile picker and the slash-command popup
share the same windowing math
(`windowRows`/`windowGroupedRows` in `ui/patterns/windowed-list.tsx`) rather than each re-deriving it.

## 2. Surface

Hosted backends add `/background`, `/background list`, `/background cancel <execution-id>` and
`/attach <execution-id>` through the same deterministic command registry. Invalid arguments return
`block` so the composer retains them. No command is forwarded to the model. The startup discovery
view rechecks interaction ownership after its list request and cannot replace a newly typed draft.
The complete lifecycle is owned by [hosted runs](hosted-runs.md#code-integration).

Production: `registerBackgroundCommands` in
[commands.ts](../../packages/code/src/features/background/commands.ts), registered by
[command-composition.ts](../../packages/code/src/app/command-composition.ts) and wired in
[App.tsx](../../packages/code/src/views/App.tsx).
Test: [background-commands.test.tsx](../../packages/code/tests/integration/background-commands.test.tsx).

`/goal` uses the same registry for deterministic inspection and controls, including literal
`/goal -- <objective>`, reviewed replacement, a criteria/limits form, pause, resume, cancel and
archive. Invalid control syntax returns `block` and remains in the composer. A form pins both the
conversation generation and the reviewed revision, so navigation cannot retarget an old draft.
Physical execution gates editing independently from goal status; pause alone does not imply a stopped
run. Replacement, including editing a terminal goal, requires explicit confirmation.
Human criteria show whether the host accepted them for the current objective revision. The
acceptance picker offers only pending criteria; historical approvals cannot satisfy a revised goal.
Production: `registerGoalCommands` in
[commands.ts](../../packages/code/src/features/goal/commands.ts), `GoalForm` and `GoalView` in
[form.tsx](../../packages/code/src/features/goal/form.tsx) and
[view.tsx](../../packages/code/src/features/goal/view.tsx).
Test: [goal-commands.test.tsx](../../packages/code/tests/integration/goal-commands.test.tsx).
The owning authority and completion contract is [goals](../capabilities/goals.md).

### `InputDock.tsx` — the composer

| Symbol | Signature | File |
| ------------------ | -------------------------------- | --------------------------------------------- |
| `SlashOutcome` | `"handled" \| "block" \| "pass"` | `packages/code/src/views/InputDock.tsx` |
| `InputDock(props)` | see prop table below | `packages/code/src/views/InputDock.tsx` |

`InputDock` props:

| Prop | Type | Meaning |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `interaction` | `Interaction` | keymap/renderer/overlay-context handle (owned by [hosts/code-keyboard.md](code-keyboard.md)) |
| `renderer` | `CliRenderer` | OpenTUI renderer, used to listen for `paste` events |
| `platform` | `Platform` | supplies `readClipboardImage()` |
| `history` | `PromptHistory` | Up/Down recall, see §2 below |
| `providers?` | `CompleteProvider[]` | autocomplete providers; read once per refresh (Invariant 6) |
| `visible?`, `runActive?` | `() => boolean` | gate key-layer registration / border color / placeholder |
| `onSubmit` | `(content: MessageContent) => void` | fires on an ordinary (non-slash, non-bang) submit |
| `onSlashCommand?` | `(name, args) => SlashOutcome` | classifies/dispatches a `/name args` line |
| `onBashCommand?` | `(cmd: string) => boolean` | dispatches a `!cmd` line; return `true` clears the draft |
| `submissionBlocked?` | `Accessor<string \| null>` | non-null refuses ordinary/bang submission, keeps the draft |
| `onReady?` | `(el: TextareaRenderable) => void` | exposes the underlying textarea |
| `onDock?` | callback receiving `{clearAttachments, restoreAttachments, popupOpen, expanded, closeEditor}` | the dock's imperative handle |
| `onNotify?`, `onDraftChange?`, `onExpandedChange?`, `targetLabel?` | — | UI callbacks |

(`packages/code/src/views/InputDock.tsx`)

### `views/input/autocomplete.ts` — pure completion/parsing helpers

| Export | Signature | File |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `CompleteItem` | `{label, detail?, value, insert?, group?}` | `views/input/autocomplete.ts` |
| `CompleteProvider` | `{id, trigger, label, kind?: "completion"\|"hint", query, onAccept?}` | `views/input/autocomplete.ts` |
| `TriggerHit` | `{trigger, term}` | `views/input/autocomplete.ts` |
| `detectTrigger(text, triggers)` | `TriggerHit \| null` | `views/input/autocomplete.ts` |
| `splitSlashArgs(raw, count)` | `string[]` | `views/input/autocomplete.ts` |
| `parseSlashCommand(text)` | `{name, args} \| null` | `views/input/autocomplete.ts` |
| `slashCompletion(label)` | `string` | `views/input/autocomplete.ts` |
| `SlashSubmit` | `{kind:"skill",agent}\|{kind:"command",command}\|{kind:"unknown"}\|{kind:"chat"}` | `views/input/autocomplete.ts` |
| `classifySlashSubmit(name, {skillAgent, findCommand})` | `SlashSubmit` | `views/input/autocomplete.ts` |
| `parseBangCommand(text)` | `string \| null` | `views/input/autocomplete.ts` |
| `acceptMention(text, trigger, insert)` | `string` | `views/input/autocomplete.ts` |
| `clampIndex(index, length)` | `number` | `views/input/autocomplete.ts` |
| `slashTokenMatches(slashes, term)` | `boolean` | `packages/code/src/views/input/autocomplete.ts` (`slashTokenMatches`) |

### `ui/patterns/windowed-list.tsx` — shared retained-window projection

| Export | Signature | File:symbol |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `WindowOverflowMode` | `"indicators" \| "scroll"` | `packages/code/src/ui/patterns/windowed-list.tsx` (`WindowOverflowMode`) |
| `RowWindow<T>` / `windowRows(items, index, max, overflowMode?)` | `{rows, offset, above, below}` | `packages/code/src/ui/patterns/windowed-list.tsx` (`RowWindow`, `windowRows`) |
| `GroupedRowWindow<T>` / `windowGroupedRows(items, index, max, overflowMode?)` | adds `headers` | `packages/code/src/ui/patterns/windowed-list.tsx` (`GroupedRowWindow`, `windowGroupedRows`) |
| `StableWindowedList<T>(props)` | fixed retained slots over a grouped or ungrouped window, with optional overflow mode | `packages/code/src/ui/patterns/windowed-list.tsx` (`StableWindowedList`) |

The file-local `headersFor` helper derives one optional group heading per visible row for
`windowGroupedRows`; autocomplete consumes the resulting projection rather than owning that policy.

### `views/input/attachments.ts` — Solid-backed attachment store

| Export | Signature |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createAttachmentStore()` | `AttachmentStore` (Solid signal over `core/attachments.ts` logic) |
| re-exports | `attachmentAdmissionMessage`, `base64DecodedBytes`, `composeWithAttachments`, `formatAttachmentBytes`, `nextAttachmentId`, `Attachment`, `AttachmentAdmission`, `AttachmentAdmissionFailure`, `AttachmentStore`, `ImageLoader` |

### `core/attachments.ts` — pure attachment/mention logic

| Export | Signature |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `isImageRef(path)` | `boolean` |
| `parseMentions(text)` | `string[]` |
| `ImageLoader` | `(path) => Promise<ImagePart \| null>` |
| `buildContent(text, loadImage)` | `Promise<MessageContent>` |
| `appendMentionImages(parts, loadImage)` | `Promise<ContentPart[]>` |
| `MAX_COMPOSER_IMAGES` | `4` |
| `MAX_COMPOSER_IMAGE_BYTES` | `5 * 1024 * 1024` |
| `MAX_COMPOSER_IMAGE_TOTAL_BYTES` | `10 * 1024 * 1024` |
| `AttachmentAdmissionFailure` | `"empty" \| "count" \| "item_bytes" \| "total_bytes"` |
| `MentionImageError` (abstract) / `MentionImageLoadError` / `MentionImageAdmissionError` | — |
| `formatAttachmentBytes(bytes)` | `string` (`"123B"`/`"1.2k"`/`"3.4M"`) |
| `attachmentAdmissionMessage(admission, prefix?)` | `string` |
| `Attachment` / `AttachmentStore` | interfaces |
| `base64DecodedBytes(data)` | `number` |
| `attachmentBytes(attachment)` | `number` (max of declared vs decoded) |
| `checkAttachmentAdmission(existing, bytes)` | `AttachmentAdmission` |
| `nextAttachmentId()` | `` `att_${Date.now()}_${seq}` `` |
| `composeWithAttachments(text, attachments)` | `MessageContent` |

### `core/prompt-history.ts`

| Export | Signature |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `PromptHistory` | `{push, seed, prev, next, resetCursor, size, flush, persistenceDegraded}` |
| `PromptHistoryPersistence` | `{path, load(limit), append(text), compact(entries)}` |
| `PromptHistoryOptions` | `{onPersistenceError?}` |
| `MAX_PROMPT_HISTORY_ENTRY_CHARS` | `1_000_000` |
| `createPromptHistory(limit=200, persistence=null, options={})` | `PromptHistory` |

Backing hard bounds (not exported): `MAX_PROMPT_HISTORY_ENTRIES = 1_000`,
`MAX_PROMPT_HISTORY_CHARS = 8_000_000`.

### `core/fuzzy.ts`

| Export | Signature |
| ---------------------------------------------- | ----------------------------------------------------- |
| `fuzzyScore(text, term)` | `number \| null` |
| `fuzzyFilter(items, term, key)` | `T[]`, sorted desc by score, ties by original order |
| `fuzzyPositions(text, term)` | `number[] \| null` |
| `HighlightRun` / `matchRuns(text, positions)` | `{text,hit}[]` |
| `labelRuns(label, term)` | `HighlightRun[]` |
| `FieldMatch` / `fuzzyFieldMatch(fields, term)` | best-scoring field + positions, ties to earlier field |
| `ItemMatch` | `{field:"label"\|"detail", positions}` |

### `adapters/local-shell.ts` — the `!` seam

| Export | Signature | Source |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `LocalBashResult` | `{exitCode, stdout, stderr, signal, timedOut, cancelled, stdoutTruncated, stderrTruncated, durationMs}` | `packages/code/src/adapters/local-shell.ts` (`LocalBashResult`) |
| `LocalBashOptions` | `{cwd, timeoutMs?, maxBytes?, signal?, env?}` | `packages/code/src/adapters/local-shell.ts` (`LocalBashOptions`) |
| `stripAnsi(s)` | `string` | `packages/code/src/core/terminal-text.ts` (`stripAnsi`), re-exported by `local-shell.ts` |
| `runLocalBash(command, opts)` | `Promise<LocalBashResult>` | `packages/code/src/adapters/local-shell.ts` (`runLocalBash`) |
| `formatBashObservation(command, r)` | `string` (tagged text block) | `packages/code/src/adapters/local-shell.ts` (`formatBashObservation`) |

Defaults: `DEFAULT_TIMEOUT_MS = 120_000`, `MAX_CAPTURE_BYTES = 64 * 1024`, `KILL_GRACE_MS = 1_500`,
`EXIT_DRAIN_MS = 1_000` (`packages/code/src/adapters/local-shell.ts`).

### Overlay components (`views/overlays/*`, `views/input/{AutocompletePopup,CommandGroupHeader}.tsx`)

| Component | Purpose | File |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SurfaceBoundary(props)` | Lazy surface owner with explicit `dispose-on-close`/`retain-one`, activation identity and optional stable root-portal placement; portal placement requires `retain-one` | `packages/code/src/ui/patterns/surface-lifecycle.tsx` (`SurfaceBoundary`) |
| `SurfaceRegion` / `SurfaceOverlay` / `SurfacePortal` | Hidden retained region, full-bleed in-region surface and stable root portal primitives | `packages/code/src/ui/patterns/surface-lifecycle.tsx` |
| `FloatFrame(props)` | Generic centered animated card (title/footer/nav), scrim behind it, `sm`/`lg` sizing; its floating host belongs to the surrounding `SurfaceBoundary` | `packages/code/src/views/overlays/FloatFrame.tsx` (`FloatFrame`) |
| `floatMaxRows(terminalRows)` | `Math.floor(terminalRows * 0.8)` | `packages/code/src/views/overlays/FloatFrame.tsx` |
| `FLOAT_CHROME_ROWS` | `5` | `packages/code/src/views/overlays/FloatFrame.tsx` |
| `FLOAT_Z` | `100` — z-index every `FloatFrame`/scrim paints at | `packages/code/src/views/overlays/FloatFrame.tsx` |
| `PickerRow(props)` | One selectable row: chevron + cells, optional retained visibility, mouse-down selects+confirms | `packages/code/src/views/overlays/PickerRow.tsx` (`PickerRow`) |
| `PickerCell` | `{text?, render?, fg?, width?, grow?, marginLeft?, shrink?}` | `packages/code/src/views/overlays/PickerRow.tsx` |
| `ChoiceRow<T>` | `{value, label, description, tone?: "normal"\|"warn"}` | `packages/code/src/views/overlays/ChoiceRows.tsx` |
| `ChoiceRows(props)` | Renders `ChoiceRow<T>[]` as `PickerRow`s with a radio marker | `packages/code/src/views/overlays/ChoiceRows.tsx` |
| `FilterField(props)` | Auto-focused single-line filter input, reports term via `onTerm` | `packages/code/src/views/overlays/FilterField.tsx` |
| `ListPicker<T>(props)` | Generic filterable/scrollable/windowed picker inside a `FloatFrame`; an optional fixed `intro` declares its responsive `introRows` cost | `packages/code/src/views/overlays/ListPicker.tsx` (`ListPicker`) |
| `ListPickerVerb<T>` | shared `PanelVerbName` or one-off `{key,label,run,when?}` | `packages/code/src/views/overlays/ListPicker.tsx` |
| `AgentProfilePicker(props)` | `ListPicker` of Agent Profiles + a nested default-scope `ListPicker` | `packages/code/src/views/overlays/AgentProfilePicker.tsx` |
| `IsolationPicker(props)` | Lazy retained `ListPicker` over Host, native Sandbox and lazy Docker, with armed confirmation before direct-host execution | `packages/code/src/views/overlays/IsolationPicker.tsx` (`IsolationPicker`) |
| `ReviewPicker(props)` | Lazy retained `ListPicker` over Off, Approval and Auto command review without changing isolation | `packages/code/src/views/overlays/ReviewPicker.tsx` (`ReviewPicker`) |
| `Help(props)` | Full-page live-projected key/action/destination reference with stable indexed rows | `packages/code/src/views/overlays/Help.tsx` (`Help`) |
| `DiffViewer(props)` | Full-screen page rendering one transcript tool node's diff via the tool registry; an optional active accessor gates retained key layers | `packages/code/src/views/overlays/DiffViewer.tsx` (`DiffViewer`) |
| `PlanOverlay(props)` | Full-screen current/latest-plan task/document viewer; an optional active accessor gates retained key layers and refreshes on reopen | `packages/code/src/views/overlays/PlanOverlay.tsx` (`PlanOverlay`) |
| `ActivityDetail(props)` | Floating scrollable Markdown reader for a full delegation brief or terminal task/sub-agent result | `packages/code/src/views/overlays/ActivityDetail.tsx` |
| `AutocompletePopup(props)` | Floating windowed/grouped suggestion list above the input, backed by ten stable row/header slots | `packages/code/src/views/input/AutocompletePopup.tsx` (`AutocompletePopup`, `MAX_ROWS_CAP`); `packages/code/src/ui/patterns/windowed-list.tsx` (`StableWindowedList`) |
| `CommandGroupHeader(props)` | Non-interactive section divider above a command group's first row | `packages/code/src/views/input/CommandGroupHeader.tsx` |

### `app/commands.tsx` — command and view wiring

| Export | Signature | File |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `AppCommandDeps` | large dependency-injection interface (settings, agents, plugins, plans, workflows, tasks, session, backend probe, debug session, …) | `packages/code/src/app/commands.tsx` |
| `AppCommandWiring` | `{doctorDirty, recheck, sandboxInspection, skillAgent, dispose}` | `packages/code/src/app/commands.tsx` |
| `registerAppCommands(deps)` | `AppCommandWiring` — registers every app-level (non-feature) command/view/action | `:165-…` |

Each registration carries a `slash?` token, a `surface` (`"slash" \| "internal"`), a `group` and an
optional `parent`; the `/name` autocomplete provider (in `views/App.tsx`, outside this document)
reads these fields back. Example
dispositions actually registered by this file (name → slash/surface/group/parent), pinned by
`packages/code/tests/integration/app-commands.test.tsx` (canonical token and disposition tests):

| name | slash | surface | group | parent |
| ------------------- | ----------- | -------- | -------- | ---------- |
| `agent.picker` | `/agent` | slash | navigate | — |
| `transcript.diff` | `/diff` | slash | navigate | `inspect` |
| `plan.toggleReview` | `/plan` | slash | actions | — |
| `plan.open` | — | internal | navigate | — |
| `app.quit` | `/quit` | slash | actions | — |
| `sessions.open` | `/sessions` | slash | navigate | `sessions` |
| `storage.open` | `/storage` | slash | navigate | — |

`plan.toggleReview` reads the effective workspace policy at dispatch time, maps `review` to `on`
and either `on` or `off` to `review`, then writes the workspace scope through
`patchPlansSettings`, preserving retention, provider and pending-task nudges. Repeated invocations
serialize their writes and re-read effective state after the preceding write, so two quick `/plan`
commands still perform both halves of the toggle. An active run keeps its submitted mode and the
notification says the change applies to the next run. The command registry has no `/plans` history
route and no `/planning` hierarchy. Production:
`packages/code/src/app/commands.tsx` (`plan.toggleReview` registration). Test:
`packages/code/tests/integration/app-commands.test.tsx` (`/plan` toggle/serialization and removed
registrations) and `packages/code/tests/integration/app-shell-render.test.tsx` (`/plan`, `/plans`,
`/planning`).

`StorageView` is an unscoped operator view. On mount and Ctrl+R it calls `storage.inspect`; category
rows show logical bytes/file/directory counts and highlight reclaimable bytes. Credential rows show
only absent/present and owner-only posture. Pressing `c` calls `storage.cleanup` with `dry_run: true`,
opens the standard confirmation prompt only when bytes are reclaimable, and applies the same closed
`temporary`/`cache` category set only after confirmation. A truncated dry-run inventory warns and
stops before confirmation. Production:
`packages/code/src/views/config/StorageView.tsx` and the `storage.open` registration in
`packages/code/src/app/commands.tsx`. Test: canonical registration in
`packages/code/tests/component/command-composition.test.ts`; view behavior in
`packages/code/tests/integration/storage-view-render.test.tsx`; kernel cleanup semantics in
`packages/kernel/tests/integration/storage-service.test.ts`.

`registerAppCommands` also builds `openWithReturn(childCmd, returnCmd, scope?)`
(`packages/code/src/app/commands.tsx`) — the mechanism behind every `/hub <child>` deep link
(`hubRoute`): it opens `childCmd`'s view with a synthetic `parent: {name: returnCmd,
factory, scope}` route, so one Escape returns to the hub rather than to the root screen.

## 3. Data and formats

### Message content the dock hands to `onSubmit`

`composeWithAttachments(text, attachments)` (`packages/code/src/core/attachments.ts`) returns:

- the plain `text` string when there are no image attachments;
- otherwise a `ContentPart[]`: an optional `{type:"text", text}` (only when `text.trim()` is
  non-empty) followed by one `{type:"image", mime, data}` per staged image, in staging order.

This is exactly the shape `InputDock.composeMessage()` returns (`packages/code/src/views/InputDock.tsx`) and
what `onSubmit`/`restoreAttachments` exchange. Downstream, `run-host.ts` ([hosts/code-run-host.md](code-run-host.md)
item) runs this content through `buildContent`/`appendMentionImages`
(`packages/code/src/core/attachments.ts`, called at `packages/code/src/run-host.ts`) to additionally resolve `@path`
image mentions before the turn reaches the model — a separate pass the dock itself never invokes
(no `buildContent`/`appendMentionImages` import in `InputDock.tsx`).

Both entry points share one engine, `loadMentionImages(text, loadImage, existing)`
(`packages/code/src/core/attachments.ts`, not exported): it walks `parseMentions(text)` in order, skipping a
path that is not `isImageRef` and any path already seen earlier in the same text (a `seen` set), so
a repeated `@shot.png and again @shot.png` resolves and counts the image once
(`packages/code/tests/unit/attachments.test.ts`). Its running `imageCount`/`totalBytes` are seeded from
the `existing` images already in the content — so, for `appendMentionImages`, images already staged
in the composer count toward the same `MAX_COMPOSER_IMAGES`/`MAX_COMPOSER_IMAGE_TOTAL_BYTES` budget
a newly-resolved mention is admitted against (`packages/code/tests/unit/attachments.test.ts`) — before
throwing a typed `MentionImageLoadError` (the loader itself threw) or
`MentionImageAdmissionError` (the resolved image failed `checkImageAdmission`)
(`packages/code/tests/unit/attachments.test.ts`).

### Attachment admission budgets

| Limit | Value | Constant | File |
| ------------------------------------------------ | ------ | -------------------------------- | ------------------------------------------- |
| Images per composer submission | 4 | `MAX_COMPOSER_IMAGES` | `packages/code/src/core/attachments.ts` |
| Bytes per staged image (decoded) | 5 MiB | `MAX_COMPOSER_IMAGE_BYTES` | `packages/code/src/core/attachments.ts` |
| Aggregate decoded bytes across all staged images | 10 MiB | `MAX_COMPOSER_IMAGE_TOTAL_BYTES` | `packages/code/src/core/attachments.ts` |

`checkImageAdmission` evaluates, in order: count ≥ max → `"count"`; normalized bytes
`=== 0` → `"empty"`; bytes `>` per-item cap → `"item_bytes"`; existing+new `>` aggregate cap →
`"total_bytes"`. `AttachmentAdmission` is `{ok:true}` or `{ok:false, reason, actual, limit}`.

`base64DecodedBytes(data)` computes decoded length from the base64 string's own length
and trailing `=` padding, without allocating a decoded buffer. `attachmentBytes(attachment)`
 takes `Math.max(declaredSize, base64DecodedBytes(data))`, so an attachment cannot
understate its own size to slip past the budget.

### Autocomplete item/provider shape

`CompleteItem` (`packages/code/src/views/input/autocomplete.ts`): `{label, detail?, value, insert?, group?}`.
`group` is the section-header label rendered once per boundary by `CommandGroupHeader`
(`packages/code/src/views/input/AutocompletePopup.tsx`, `headersFor` in
`packages/code/src/ui/patterns/windowed-list.tsx`).

`CompleteProvider` : `{id, trigger, label, kind?, query, onAccept?}`. `kind:"hint"`
providers are display-only — the popup shows their items but the popup claims no keys, so Enter
still submits the line (used for argument-hint providers built in `packages/code/src/views/App.tsx` from
each command's declared `args`).

`InputDock` lazily mounts autocomplete on its first open and then changes the container's `visible`
state instead of destroying the OpenTUI subtree. Closing clears provider/query/selection state but
keeps the last bounded projection so the same ten retained slots and their header wrappers can be
rewritten on the next open. The keymap's `autocomplete` context value is updated only when it
actually changes. Production: `packages/code/src/views/InputDock.tsx` (`SurfaceBoundary`, `closeAc`,
`refreshAc`), `packages/code/src/ui/patterns/windowed-list.tsx` (`StableWindowedList`), and
`packages/code/src/views/input/AutocompletePopup.tsx` (`MAX_ROWS_CAP`, `visible`).
Test: `packages/code/tests/integration/input-dock-submit.test.tsx` and
`packages/code/tests/integration/autocomplete-popup-render.test.tsx`.

Windowing is a shared UI pattern, not an autocomplete-owned algorithm. `windowRows` and
`windowGroupedRows` compute bounded projections; `StableWindowedList` projects those windows into a
fixed row/header/overflow slot pool whose OpenTUI ownership does not change as the selection moves.
The default `"indicators"` mode preserves explicit overflow-count rows for generic pickers.
Autocomplete selects `"scroll"`: all available lines belong to item/header slots, no overflow
labels mount, and its explicit popup height stays fixed while the selected window moves.
Modal collections compose through `ListPicker`, and
scroll-following page collections compose through `SelectableList`. Production:
`packages/code/src/ui/patterns/windowed-list.tsx`,
`packages/code/src/views/overlays/ListPicker.tsx`, and
`packages/code/src/ui/patterns/selectable-list.tsx`. Test:
`packages/code/tests/unit/autocomplete.test.ts`,
`packages/code/tests/integration/autocomplete-popup-render.test.tsx`, and
`packages/code/tests/integration/list-picker-render.test.tsx`.

At the application region, the transcript shell and its Yoga geometry remain mounted behind Diff,
Plan and every full-region configuration view, including Workflows. The shell is transparent and
cannot receive pointer input there; `overlayFallbackActive` also pauses its physical-history
observation and removes any elicitation from the hidden interactive projection. Returning therefore
reveals the same transcript owners and scroll state instead of reconstructing them. Diff and Plan
are dynamically imported and mount lazily on first use, remain hidden afterward and gate their key
layers with stable reactive matchers; Plan reloads the current live document on each
inactive-to-active transition and invalidates in-flight reads on deactivation. The configuration
stack still preserves only its own inactive parents and disposes a popped frame once; retaining the
shell does not cache closed configuration frames. `popView` reactivates the parent and does not
run Doctor/sandbox/subscription probes. Production:
`packages/code/src/views/app/OverlayRegion.tsx` (`OverlayRegion`, `overlayFallbackActive`),
`packages/code/src/views/app/TranscriptRegion.tsx` (`active`, `TranscriptProjection`),
`packages/code/src/views/overlays/{DiffViewer,PlanOverlay}.tsx`, and
`packages/code/src/views/overlay-host.ts` (`mountView`, `popView`). Test:
`packages/code/tests/integration/overlay-region-render.test.tsx` and
`packages/code/tests/unit/overlay-host.test.ts`.

### Fuzzy-match scoring (`core/fuzzy.ts`)

Every completion/picker row is ranked by `scoreMatch(text, term)` (not exported;
reached through `fuzzyScore`/`fuzzyFilter`/`fuzzyFieldMatch`), a subsequence match that returns
`null` when `term` is not a subsequence of `text` and otherwise a score built per matched character:
`+1` base, `+3` more when the character is consecutive with the previous match, and `+2` more when
it starts a word — the character at index `0`, or one preceded by `/`, `-`, `_`, `.` or a space.
Pinned: `packages/code/tests/integration/input-editor.test.ts` ("ranks contiguous / boundary matches
higher").

### Bash observation block

`formatBashObservation(command, result)` (`packages/code/src/adapters/local-shell.ts`) renders (example from
`packages/code/tests/integration/local-shell.test.ts`):

```
<bash-input>git status</bash-input>
<bash-output exit-code="0">
clean
</bash-output>
```

- the attribute is `exit-code="N"` when the process exited, or `signal="SIGNAME"` when it did not;
- `<bash-stderr>…</bash-stderr>` appears only when stderr is non-empty;
- a truncated stream gets a trailing `\n[output truncated]` line inside its own tag (`tagBody`,
  in `local-shell.ts`);
- `<bash-timed-out />` / `<bash-cancelled />` self-closing markers are appended when applicable
  (`formatBashObservation`).

### `shell.local.exit` diagnostic

Every `runLocalBash` call emits exactly one `diagnosticEvent("shell.local.exit", {...})`
(`packages/code/src/adapters/local-shell.ts`, `runLocalBash`) with **exactly** the fields `exit_code`, `duration_ms`,
`killed`, `signal`, `spawn_failed` — pinned by `packages/code/tests/integration/local-shell.test.ts`
(`Object.keys(record.details).sort()` equals that list). The command text is never a field.

### Prompt history on-disk format

`createFilePromptHistory` (`packages/code/src/adapters/file-prompt-history.ts`) backs `core/prompt-history.ts`'s
`PromptHistoryPersistence` port with one JSON-string-per-line file at
`workspaceStatePaths().promptHistoryFile` (default), one `JSON.stringify(text) + "\n"` per entry
(`encode`). `loadEntries` reads only the **tail** of the file, bounded to
`MAX_PROMPT_HISTORY_FILE_BYTES = 8 MiB`, and walks backward line-by-line so a truncated
partial line at the read boundary is discarded rather than mis-parsed; a JSON-parse
failure on one line is skipped without losing the rest. Example round-trip
(`packages/code/tests/integration/input-editor.test.ts`): three pushed entries reload in the same order
after a fresh `createFilePromptHistory` against the same file.

### Plan overlay's document vs. live-activity duality

`PlanOverlay` reads two independent sources for the same current/latest plan: the live `PlanActivity` projection
(`props.plan`, from `adapters/activity-store.ts` — owned by [hosts/code-run-host.md](code-run-host.md)) for the
in-run task list, and, when a `Pick<PlansService, "read">` is supplied (`@clarvis/protocol`, owned by
[capabilities/plan-capability.md](../capabilities/plan-capability.md)), the persisted `PlanDocumentDto` fetched via
`plans.read(plan.id)` (`PlanOverlay.loadActivePlan`). `approvalLine(doc)` renders the
distinct "human approval" vs. "specification revision" counters from `doc.approved_spec_revision`
vs. `doc.spec_revision`, deliberately never sharing the label "revision" between them.

## 4. Behavior

### Submit dispatch order (`InputDock.submit()`, `packages/code/src/views/InputDock.tsx`)

1. If `text` is blank and there are no attachments, do nothing.
2. If `onSlashCommand` is supplied, `parseSlashCommand(text)` is tried **first, unconditionally**. If it parses:
   - `outcome === "handled"`: push to history, clear the draft, return.
   - `outcome === "block"`: return, draft untouched (an error was already surfaced by the caller).
   - `outcome === "pass"`: fall through to the remaining steps below.
3. `submissionBlocked?.()` is checked next : if non-null, `onNotify` fires with the
   reason and the function returns — the draft is never touched. This governs ordinary text and `!`
   commands, not a slash line that has already been `"handled"`/`"block"`ed above.
4. If `onBashCommand` is supplied, `parseBangCommand(text)` is tried : an empty command
   after `!` notifies `"type a command after !"`and returns; otherwise `onBashCommand(bang)` runs,
   and only a truthy return clears the draft and pushes history.
5. Otherwise: push non-blank text to history, `composeMessage()` (text + staged image attachments),
   clear the textarea and attachments, call `onSubmit(content)`.

`classifySlashSubmit` (called by the host that implements `onSlashCommand` in
`packages/code/src/views/App.tsx` — outside this document, in
[hosts/code-bootstrap.md](code-bootstrap.md)) gives a registered `command` its slash token before
consulting the agent-backed `skill` fallback; this prevents a same-named skill from shadowing a
built-in such as `/plan`. It otherwise returns `unknown` (notify + block) or `chat` (fall through as
`pass`). Production: `classifySlashSubmit` in
`packages/code/src/views/input/autocomplete.ts`. Test:
`packages/code/tests/unit/autocomplete.test.ts` and
`packages/code/tests/integration/app-shell-render.test.tsx`. `collectArgs`, the one place a slash line's argument
tail actually feeds a schema (an MCP prompt's declared `arguments`, `packages/code/src/app/commands.tsx`, `mcpEffects.collectArgs`),
maps it positionally with `splitSlashArgs(raw, count)` (`packages/code/src/views/input/autocomplete.ts`): one
whitespace-separated token per declared argument, and the last argument takes the entire remainder
(so a trailing free-text argument keeps its spaces). A required argument left unfilled is reported
with a warn notification naming it (`mcpEffects.collectArgs`) rather than submitted with a gap.
Pinned: `packages/code/tests/unit/autocomplete.test.ts`.

Slash parsing preserves trailing argument whitespace. Native routers may return `"block"` to keep
invalid input editable, including a `/loop` creation missing its mandatory prompt. The live loop
controller defers automatic admission for nonempty drafts, attachments, autocomplete and blocking
dialogs; it never dispatches the scheduled prompt through this input parser. Production:
`parseSlashCommand` in [autocomplete.ts](../../packages/code/src/views/input/autocomplete.ts),
`onSlashCommand` and loop interaction gates in [App.tsx](../../packages/code/src/views/App.tsx).
Test: literal argument tails in [autocomplete.test.ts](../../packages/code/tests/unit/autocomplete.test.ts)
and the two loop command/control cases in
[app-shell-render.test.tsx](../../packages/code/tests/integration/app-shell-render.test.tsx).
The schedule grammar belongs to [loop-scheduling.md](loop-scheduling.md).

### Composer sizing and history-recall gating (`views/InputDock.tsx`)

The textarea auto-grows with the draft up to `maxInlineRows()` — `Math.min(12...)`, itself
capped at 30% of `dims().height - 5` — so a long paste never claims the whole screen. Its inline
height follows the textarea's visual-line projection (`lineInfo.lineStartCols`, with
`virtualLineCount` as a second renderer signal), while the expanded editor's status keeps the
logical newline count. `wrapMode="char"` gives even an uninterrupted token a soft wrap instead of
turning the one-row viewport into a horizontally moving suffix.
Up/Down only recall prompt history when the cursor is already on the buffer's first/last line
(`atTop()`/`atBottom()`); otherwise they move the cursor within a multi-line draft, so
history recall and in-draft navigation share the same two keys without either shadowing the other.

Ctrl+E toggles a separate **expanded Task editor** state (`registerEditorToggle`): the collapsed
binding sits one priority above the managed textarea's Emacs-style Ctrl+E mapping, then swaps to
`LAYER.OVERLAY` for the duration so the editor's own Escape binding takes priority while it is open.
The draft text is untouched by the toggle — `onDock` exposes `expanded`/`closeEditor` explicitly so
a caller can query or close it. Ctrl+G is not an editor command; the shell reserves it for Review.
While expanded, Escape closes an open autocomplete popup first; only a second Escape (with no popup
open) collapses the editor (`dismissAutocomplete`/the `escape` binding). Pinned:
`packages/code/tests/integration/input-dock-submit.test.tsx` ("inline composition is height-bounded and
the expanded Task editor preserves the draft"; "Escape closes autocomplete before collapsing the
expanded Task editor").

At the root composer, after any top overlay and focused transcript block have had their chance to
consume Escape, `app.escape` checks the complete composer draft. Any text (including whitespace) or
staged attachment clears through `clearInputDraft` and reports `"Draft cleared"`; with nothing to clear,
Escape is a no-op. It never cancels a run or enters quit (`packages/code/src/keys/interaction.ts`;
`packages/code/src/views/App.tsx`). Window-local Escape layers still take priority: an open
autocomplete closes first, and the expanded Task editor collapses before the root command is
reachable. All of these handlers dispatch without an Escape timer or grace interval. Pinned at the
command boundary by `packages/code/tests/integration/interaction.test.ts` and end to
end by `packages/code/tests/integration/app-shell-render.test.tsx`.

### Autocomplete refresh (`refreshAc()`, `packages/code/src/views/InputDock.tsx`)

Runs on every `onContentChange`. Reads `providers()` **once** into a local `list`, calls `detectTrigger(text, list.map(p => p.trigger))`, finds the matching
provider, and — unless `acSuppressed` (set by an explicit dismiss) — calls
`provider.query(term)`, resets the selection index only when the term actually changed
(`clampIndex` else `0`), and opens the popup. A `"hint"` provider opens the popup but never
claims the autocomplete key layer (`props.interaction.keymap.setData("autocomplete", !hint)`), so Enter still submits and Up/Down still walk history while an argument hint is showing.
A dismiss latches `acSuppressed = true` for as long as the same trigger keeps scanning — `refreshAc`
only clears it once `detectTrigger` finds no hit or no matching provider at all, i.e.
once the trigger token itself is gone (the word is finished, or the trigger character is deleted),
not on the next keystroke inside the same token.

The `/` provider also projects every hub child as its canonical hierarchical route and matches a
non-empty term anywhere after the route's leading slash. A child therefore remains a subcommand —
`Providers` has no standalone `/providers` alias — while `/provider` can still offer
`/settings/providers` for the user to select (`packages/code/src/views/input/command-completion.ts`). Pinned by
`packages/code/tests/integration/app-shell-render.test.tsx`.

### Accept vs. complete (`acceptAc()`/`completeAc()`)

- `acceptAc()` (Enter, or the popup's own confirm): closes the popup first, then, for a `/`-trigger
  item, replaces the whole buffer with `item.insert ?? ""` and calls `provider.onAccept?.(item)`;
  for a mention-style trigger, splices `trigger+insert` in at the current token via `acceptMention`
  and calls `onAccept`. A plain, argument-less, subcommand-less slash command has `insert === ""`
  (built that way in `packages/code/src/views/input/command-completion.ts`, outside this document), so pressing Enter on one **clears
  the textarea** via `ref.setText("")` and then reaches `commands.runCommand` only through
  `provider.onAccept` dispatching only when `!item.insert` (`packages/code/src/views/input/command-completion.ts`) — a route that
  never touches `InputDock.submit()`, `parseSlashCommand`, or `classifySlashSubmit`. Typing the same
  command's full text and pressing Enter with the popup already closed instead goes through
  `submit()` → `parseSlashCommand` → `onSlashCommand`; both end at `commands.runCommand`, by two
  genuinely different call paths.
- `completeAc()` (Tab): for a `/`-triggered item, sets the text to `item.insert ||
slashCompletion(item.label)`, **does not** call `onAccept`, and re-runs `refreshAc()` — so the
  popup stays open and the model is still just a completed token, not a run command. Any other
  trigger falls back to `acceptAc()`.

### PromptHistory recall mechanics (`packages/code/src/core/prompt-history.ts`)

`prev(liveDraft)` only stashes the caller's live draft the first time the cursor steps off the end
of the ring (`cursor === entries.length`); repeated `prev()` calls thereafter walk
backward without re-stashing. `next()` returns that stash once the cursor returns to the end. `push` no-ops on an immediate repeat of the last entry — `entries[length-1] !== t` is
checked before pushing — so consecutive duplicate submissions collapse into one ring
entry. `seed` (session resume) deduplicates against entries already known via a `Set` built from the
current ring, so re-seeding the same resumed prompts never grows the ring, while a
prompt the file no longer has (but the session remembers) is still recovered. Pinned:
`packages/code/tests/integration/input-editor.test.ts` (push/prev/next walk and dupe collapse) (seed dedup and recovery of file-evicted entries).

### Attachment/paste flow

- `onPasteImage()` (clipboard): re-entrancy-guarded (`readingClipboardImage`), checks
  `attachments.canAddImage(1)` **before** invoking `props.platform.readClipboardImage()` — a full
  composer never even asks the platform for a clipboard image. The `1` is a placeholder byte count:
  `checkAttachmentAdmission`'s `"item_bytes"`/`"total_bytes"` reasons need the image's real decoded
  size to trigger, so this precheck reliably enforces only the `"count"` cap (and, incidentally,
  `"total_bytes"` if existing attachments already sit at the aggregate cap) before spawning the
  clipboard read; the real byte-budget check happens again, with the actual payload, inside
  `addImageAttachment`'s own `attachments.add(...)` call once the image is read.
- Binary paste (`onPaste`, wired to `renderer.keyInput.on("paste", …)`): admission is
  checked against the raw byte length **before** the bytes are base64-encoded into a `Buffer`, so an oversized paste never pays the encoding cost.
- `restoreAttachments(content)` : clears the current attachment list, then re-adds only
  the `image` parts of `content` that carry `data`, ignoring anything else — the mechanism a caller
  (`run-host.ts`, via the `onDock` handle) uses to put staged images back after a failed
  steer/mention-resolution (`packages/code/src/run-host.ts`).

### Windowing math (`windowRows`/`windowGroupedRows`, `packages/code/src/ui/patterns/windowed-list.tsx`)

`windowRows(items, index, max, "indicators")` keeps the selected index inside a `max`-row slice:
below `max===3` it collapses to a single selected row (reporting the rest as overflow on whichever
side); above that it reserves one row for the empty "N more" indicator on whichever end has
overflow. In `"scroll"` mode it instead spends the entire budget on a contiguous item window and
slides that window just enough to keep the selected index visible; `above`/`below` remain available
as data but consume no lines.
`windowGroupedRows` re-derives the window with a shrinking budget (up to 4 attempts) until
`rows.length + headerCount + indicatorLines <= max`, so a header line never pushes the rendered
popup past its row budget (proven for the full cross-product of terminal heights and scroll
positions by `packages/code/tests/unit/autocomplete.test.ts`). `windowRows` guarantees `rows + indicators
<= max` only from `max >= 3`; below that, `ListPicker`'s `showOverflow()`
(`packages/code/src/views/overlays/ListPicker.tsx`, `showOverflow`) suppresses the "N more" indicators entirely rather than mounting them
alongside a `windowRows` result with no room left for them — the selected row is what a reader needs
at that height, and the counts are what goes.

`AutocompletePopup` uses the scroll mode and an explicit bounded content height. Therefore moving
through slash commands rewrites the ten retained row/header slots inside one stable frame; it does
not add or remove top/bottom count rows as the selection crosses a window boundary.

### `AutocompletePopup` rendering (`views/input/AutocompletePopup.tsx`)

`runsFor(item, term)` turns an item's recorded `ItemMatch` (from `core/fuzzy.ts`) into
highlight runs: when `match.field` names `"label"` or `"detail"`, only that field is diffed against
the recorded positions and the other field renders unhighlighted; with no recorded field, both
label and detail are re-derived from `term` directly via `labelRuns`. The popup's own width
(`popupWidth`) is clamped between 24 and 112 columns, sized from the longest
`label.length + (detail?.length ?? 0)` across the current items plus a fixed chrome allowance.

### `ListPicker<T>` (`views/overlays/ListPicker.tsx`)

Filtering: `fuzzyFilter(props.items(), term, haystack)` when a `filter` prop and non-empty term are
present; the selection resets to `0` on every term change. Row budget:
`rowBudget(reservePreview)` subtracts the frame chrome, an optional responsive `introRows` cost, an
optional filter row, and (when it still fits) a fixed 3-row preview pane from
`floatMaxRows(terminalHeight)`. The visible slice is `windowRows(rows(), selection,
maxVisibleRows())` — only the windowed rows are ever mounted, which is the same "does not leak native
memory per unrendered row" property documented beside the `win` memo. The mouse wheel moves the
_selection_ rather than scrolling a box, because a windowed list has nothing to scroll (`onWheel`).
A caller's `verbs` bound to a key that a generic
row-traversal command would otherwise claim (e.g. `tab`) take precedence, because `registerLevel`
folds `verbs` after `nav` in the same `LevelSpec` (`spec`, keybinding resolution order is owned
by [hosts/code-keyboard.md](code-keyboard.md)).

An optional `active` accessor gates both the picker's own key layer and its
`FilterField`'s focus: while `active` reads `false`, the registration effect tears down the
layer (`off?.()`, no `registerLevel` call) instead of registering it, and `FilterField` blurs its
input rather than stealing focus (`packages/code/src/views/overlays/FilterField.tsx`) — so a picker stacked
_underneath_ another one (e.g. `AgentProfilePicker`'s scope chooser over its agent list) claims no keys
and no focus while it is hidden, without being unmounted.

### `AgentProfilePicker` (`views/overlays/AgentProfilePicker.tsx`)

A `ListPicker` of Agent Profiles behind a `Show/keyed` toggle over a second, nested `ListPicker`:
pressing `s` on a selected row (a `verbs` entry) opens a scope chooser over
`DEFAULT_SCOPE_CHOICES` (`{global, workspace}`); confirming a scope calls
`onSetDefault(name, scope)` and, on success, returns to the agent list; pressing `x` inside the
scope chooser calls `onClearDefault(scope)`; `escLabel="back"` and `onClose` return to
the agent list without effect. A workspace default wins over a global one
(`effectiveDefault`/`defaultSource`). The model column collapses to `0` width
(`MODEL_COL_COLLAPSED`) when no listed profile declares its own model, redistributing its width to
the grants column (`modelWidth`/`grantsWidth`); a profile `isRunnable?.() === false` still
renders as a selectable row, styled `tokens.warn` and suffixed `" · not runnable"` rather than
hidden or disabled. Pinned: `packages/code/tests/integration/agent-profile-picker-render.test.tsx`
(opening with the active agent selected, the scope chooser opening/setting/clearing a default, and
mouse-press select+confirm).

The supplied Agent Profile list comes from `ActiveAgentStore.list`, which applies the kernel-owned
`compareAgentDisplayOrder`: shipped agents stay in their product order and custom agents follow by
name, matching Settings > Agents (`packages/code/src/adapters/active-agent.ts`). Pinned by
`packages/code/tests/unit/active-agent.test.ts` (`"agent list uses the same canonical presentation
order as the Agents window"`).

### `IsolationPicker` and `ReviewPicker`

The two quick pickers reuse `ListPicker` but never combine their state. `IsolationPicker` marks the
effective Host/Sandbox/Docker boundary, persists the global choice through `applyIsolation`, and
arms `useArmedConfirm` before Host removes containment. Its Docker choice writes only
`runtime.backend`, strengthens the native Sandbox fallback and asks the existing coordinator to
retry on the next run; it does not start Docker from the picker. `ReviewPicker` marks
Off/Approval/Auto, writes through `applyReviewMode` at the current scope, preserves command policy
and leaves Isolation untouched. Both are lazy `retain-one` portal boundaries, so neither module
enters first boot and each native tree is reused after first open. Production:
`packages/code/src/features/run/isolation.ts`, `packages/code/src/features/run/review.ts`,
`packages/code/src/views/overlays/IsolationPicker.tsx`,
`packages/code/src/views/overlays/ReviewPicker.tsx`, and `packages/code/src/views/App.tsx`.

### `Help` (`views/overlays/Help.tsx`)

Composes up to seven sections (`sections`), each dropped when empty: **Available here**
(`available()`, the live-projected active-action list), **Available elsewhere** (`elsewhere`, a _registered_-visibility scan that excludes anything already in "Available here", any
`EDITING_CATEGORIES` command, and any name matching the `CHROME_COMMAND` prefix regex
`/^(ui\.|view\.|confirm\.|autocomplete\.|elicit\.|editor\.)/`, so a screen's own transient chrome
commands never clutter the reference), **Editing** (`editing()`, the same
`EDITING_CATEGORIES` filtered the other direction), **Go to** (destinations from `props.entries()`),
**Input syntax**, **Mouse**, and **Keyboard environment**. Pinned:
`packages/code/tests/integration/help-render.test.tsx` ("help documents the global keys its own overlay
deactivates").

### `DiffViewer` (`views/overlays/DiffViewer.tsx`)

With no node loaded, the page shows an empty-state hint ("no diff in the transcript yet") rather
than a blank pane. The subtitle names the file, not only the tool: when the node's
`args.path` is a string it is appended after the tool's label (`toolLabel(n.mcpName, n.toolName)`),
because the full-screen view otherwise said only e.g. `edit_file` while the inline block a reader
opens it _from_ already shows the path (`subtitle()`). The diff itself always goes
through the shared tool-result renderer (`resolveToolRenderer`) in `full`/`wrap` mode, passing the
node's own `diff` through unchanged — a node without one falls back to the renderer's own
args-reconstructed diff. Pinned: `packages/code/tests/integration/diff-viewer-render.test.tsx`
(empty state, real-diff render, args-reconstructed fallback, subtitle-from-tool) (subtitle names the file).

### `PlanOverlay` (`views/overlays/PlanOverlay.tsx`)

The overlay has no history state. A visible, non-removed `PlanActivity` is the only key that can
start I/O. When its id or revision tuple changes while the retained surface is active,
`loadActivePlan` calls only `plans.read(plan.id)`; without a live plan it renders `no plan yet` and
never calls the reader. The returned id must equal the requested live id or the document is rejected
and the live task projection remains visible.

When `document() !== null`, `spec()` supplies `scroll: () => scrollEl`, so arrows and page keys
scroll readable Markdown. Without a document, the same spec supplies task-row navigation and
auto-selects `in_progress`, then `returned`, then `pending`. Escape and `Ctrl+P` both call
`onClose`; `Ctrl+C` is not claimed locally, so the global cancel/quit behavior remains live. There
are no list/filter/page verbs and no per-plan retention/delete mutations. Production:
`packages/code/src/views/overlays/PlanOverlay.tsx` (`PlanOverlay`, `loadActivePlan`, `spec`). Test:
`packages/code/tests/integration/plan-overlay-render.test.tsx`.

The readable document (`Prose` over `stripDocChrome(doc.markdown)`) renders whenever a document has
been loaded for the _live_ plan; the interactive task-row list (`taskRow`) is only the fallback when
`!document()` — so the two views never double-render the same tasks (`tasks` and the final `Show`
gates in `PlanOverlay`).

### The local `!` shell path (`adapters/local-shell.ts:runLocalBash`)

1. Resolve the host shell via `resolveShell()` (from `@clarvis/kernel/local`), but force the POSIX
   executable to `bash` specifically rather than the kernel-tool default `sh` (`runLocalBash`).
2. Spawn with `stdio: ["ignore", "pipe", "pipe"]` (stdin closed, so an interactive command like `cat`
   exits immediately) and `detached: ownProcessGroup()` so the whole process tree can be
   killed as a group.
3. Accumulate stdout/stderr through a `collector(maxBytes)` that truncates once and then no-ops for
   the rest of the stream, so `truncated()` stays true for the remainder (`collector`).
4. A `timeoutMs` timer or an aborted `signal` both call `startKill()`: SIGTERM immediately, SIGKILL
   after `KILL_GRACE_MS` if the process group hasn't exited (`runLocalBash`).
5. On `exit`, wait `EXIT_DRAIN_MS` before destroying the streams and settling — so a grandchild that
   inherited the pipes and outlives the direct child (e.g. `sleep 5 &`) does not wedge the call
   waiting on a pipe that never closes (`runLocalBash`, pinned by `packages/code/tests/integration/local-shell.test.ts`).
6. `settle()` projects both streams through `terminalPlainText`; OSC/DCS-family strings terminate on
   BEL, `ESC \\` or C1 `ST`, so printable output following any standard terminator is retained. It
   emits exactly one `shell.local.exit` diagnostic and resolves the `LocalBashResult`.

This function is called from `run-host.ts`'s `runBangCommand` ([hosts/code-run-host.md](code-run-host.md) document,
`packages/code/src/run-host.ts`), which is itself the implementation behind `InputDock`'s `onBashCommand` prop
(wired at `packages/code/src/runtime.tsx` (`runControls.bang`) and
`packages/code/src/views/App.tsx` as `props.run.bang`). **No `KernelClient`
call, no `GuardContext`, and no shell-command analysis happen anywhere on this path** — the command
guard that gates an agent's own `shell` tool calls is entirely bypassed, by design (`runLocalBash` in
`packages/code/src/adapters/local-shell.ts`), because the command is one the user typed and submitted
themselves.

## 5. Invariants

`/compact` remains on the slash surface when no run is active. Dispatch then targets the latest
settled turn's persisted continuation; an empty session reports that there is no context. Production:
`registerAppCommands` in `packages/code/src/app/commands.tsx` and `compactCurrentRun` in
`packages/code/src/run-host.ts`. Test: `packages/code/tests/integration/app-shell-render.test.tsx`
(`"/compact remains discoverable while no run is active"`).

1. **Slash-command dispatch is checked before `submissionBlocked`, which is checked before the bang
   path, which is checked before an ordinary submit.** `packages/code/src/views/InputDock.tsx`. Pinned:
   `packages/code/tests/integration/input-dock-submit.test.tsx` (slash and bang each reach their handler
   with an image still pending) (a `submissionBlocked` reason blocks ordinary and bang
   submission, leaving the draft intact).
2. **The autocomplete provider list is read at most once per refresh.** `packages/code/src/views/InputDock.tsx`
   (`providers()` read into a local before use). Pinned:
   `packages/code/tests/integration/autocomplete-provider-reads.test.tsx` (reads ≤ keystrokes, never 2× per
   refresh).
3. **`detectTrigger`'s `/` handling is anchored and compound-aware**: a bare leading `/` with no
   following whitespace is a trigger; `/name arg…` first tries a non-slash trigger inside the
   argument tail (so `/skill @src/x` completes `@`), then falls back to treating a _registered_
   `/name` prefix as its own trigger, and an unregistered compound head closes the popup rather than
   matching the bare `/`. `packages/code/src/views/input/autocomplete.ts`. Pinned:
   `packages/code/tests/unit/autocomplete.test.ts`.
4. **`windowGroupedRows` never renders more than `max` total lines** (rows + group headers + over/
   under indicators), across every item count, group layout, scroll position and budget tested.
   Production: `packages/code/src/ui/patterns/windowed-list.tsx` (`windowGroupedRows`). Test:
   `packages/code/tests/unit/autocomplete.test.ts` (grouped-window cases).
5. **The autocomplete popup caps at 10 rows regardless of terminal height.**
   `packages/code/src/views/input/AutocompletePopup.tsx` (`MAX_ROWS_CAP`). Pinned:
   `packages/code/tests/integration/autocomplete-popup-render.test.tsx`.
6. **`slashTokenMatches` scopes the composer's popup ranking to a command's own slash tokens**, never
   to its title, so a typo of one command's slash cannot fuzzy-match a different command's title.
   `packages/code/src/views/input/autocomplete.ts` (`slashTokenMatches`). Pinned (the exact regression the docstring names):
   `packages/code/tests/unit/autocomplete.test.ts` (`/hlep` never reaches `/plan-review`).
7. **`classifySlashSubmit` gives a registered command precedence over an agent-backed skill with
   the same slash token, then uses the skill as a fallback, and refuses a path-like name
   (`etc/hosts`) as chat rather than "unknown".** Production: `classifySlashSubmit` in
   `packages/code/src/views/input/autocomplete.ts`. Test:
   `packages/code/tests/unit/autocomplete.test.ts` and
   `packages/code/tests/integration/app-shell-render.test.tsx` (`/plan` with an agent-backed
   same-named skill).
8. **An attachment's declared size can never understate its actual encoded payload** —
   `attachmentBytes` takes `Math.max(declared, base64DecodedBytes(data))`.
   `packages/code/src/core/attachments.ts`. Pinned: `packages/code/tests/unit/attachments.test.ts`.
9. **Composer image admission is checked before the byte payload is encoded/decoded**, for both
   clipboard reads and raw pastes. `packages/code/src/views/InputDock.tsx`. Pinned:
   `packages/code/tests/integration/input-dock-submit.test.tsx` ("before base64 composition",
   "clipboard image reading is skipped when the composer count is already full").
10. **Only one clipboard-image read may be in flight; a repeated request while pending is a no-op**,
    not a second call to the platform. `packages/code/src/views/InputDock.tsx` (`readingClipboardImage` guard).
    Pinned: `packages/code/tests/integration/input-dock-submit.test.tsx`.
11. **`restoreAttachments` re-admits only `image` content parts**, clearing the prior list first.
    `packages/code/src/views/InputDock.tsx`. Pinned: `packages/code/tests/integration/input-dock-submit.test.tsx`.
12. **Prompt history bounds every entry to `MAX_PROMPT_HISTORY_ENTRY_CHARS` (1,000,000 chars) and the
    ring to 1,000 entries**, dropping an oversized entry rather than truncating it into a different
    string. `packages/code/src/core/prompt-history.ts`. Pinned:
    `packages/code/tests/integration/input-editor.test.ts`.
13. **Seeding prompt history (session resume) never writes to the persistence port** — only `push`
    does. `packages/code/src/core/prompt-history.ts` (`seed` never calls `persist`). Pinned:
    `packages/code/tests/integration/input-editor.test.ts`.
14. **A `push` is synchronous in memory; disk persistence is queued and drained asynchronously.**
    `packages/code/src/core/prompt-history.ts` (`kickPersistence`, `persist`). Pinned:
    `packages/code/tests/integration/input-editor.test.ts`.
15. **A prompt-history persistence failure is reported at most once per instance and does not stop
    the ring from working.** `packages/code/src/core/prompt-history.ts` (`report`, `reported` latch). Pinned:
    `packages/code/tests/integration/input-editor.test.ts`.
16. **`!` always runs through `bash` specifically on POSIX**, even though the kernel's own tools
    resolve to bare `sh`. `packages/code/src/adapters/local-shell.ts` (`runLocalBash`). Pinned (skipped on win32):
    `packages/code/tests/integration/local-shell.test.ts`.
17. **A `shell.local.exit` diagnostic never carries the command text**, only
    `{exit_code, duration_ms, killed, signal, spawn_failed}`. `packages/code/src/adapters/local-shell.ts` (`runLocalBash`).
    Pinned: `packages/code/tests/integration/local-shell.test.ts` (exact key set, and the secret token in the
    command argv is absent from the serialized record).
18. **Output truncation is exact at the byte cap**, not off-by-one in either direction: exactly
    `maxBytes` is untruncated, `maxBytes+1` is. `packages/code/src/adapters/local-shell.ts` (`collector`). Pinned:
    `packages/code/tests/integration/local-shell.test.ts` (explicitly a regression comment: "C8 regression:
    output of exactly maxBytes was flagged truncated by the >= cap check").
19. **A timeout or abort kills the whole process group**, not only the direct child, and a
    grandchild that outlives the child does not wedge the call. `packages/code/src/adapters/local-shell.ts`
    (`runLocalBash`). Pinned: `packages/code/tests/integration/local-shell.test.ts`.
20. **`ListPicker` mounts only the windowed slice of items, never the whole list.**
    `packages/code/src/views/overlays/ListPicker.tsx` (`win`, via `windowRows`). Pinned:
    `packages/code/tests/integration/list-picker-render.test.tsx` (120 items, far fewer than 30 rendered).
21. **A windowed `ListPicker`'s mouse wheel moves the selection rather than scrolling a box.**
    `packages/code/src/views/overlays/ListPicker.tsx` (`onWheel`). Pinned:
    `packages/code/tests/integration/list-picker-render.test.tsx`.
22. **A caller-supplied `verbs` binding on a key takes precedence over generic row-traversal on that
    same key** (e.g. a picker-local `tab`). `packages/code/src/views/overlays/ListPicker.tsx` (`spec`; verbs folded
    after `nav` in the same `LevelSpec`; ordering enforced by `registerLevel`, owned by
    [hosts/code-keyboard.md](code-keyboard.md)). Pinned:
    `packages/code/tests/integration/list-picker-render.test.tsx`.
23. **`PlanOverlay`'s readable markdown document supersedes the fallback task-row projection whenever
    a document has been loaded for the live plan; they never both render.**
    `packages/code/src/views/overlays/PlanOverlay.tsx` (`document`, final `Show` gates). Pinned:
    `packages/code/tests/integration/plan-overlay-render.test.tsx` (readable sections shown once, "Wire the
    projection reducer" appears exactly once even though it exists in both the live tasks and the
    markdown body).
24. **No live plan means no backend read. A returned document whose id differs from the live id is
    rejected rather than substituted as the current plan.** Production:
    `packages/code/src/views/overlays/PlanOverlay.tsx` (`activePlan`, `loadActivePlan`). Test:
    `packages/code/tests/integration/plan-overlay-render.test.tsx` (current-only empty state and
    mismatched-id cases).
25. **The TUI's plan backend boundary exposes only `PlansService.read`; it cannot list retained
    plans, mutate one plan's retention or delete one.** Production: `KernelRunClient.plans` in
    `packages/code/src/adapters/kernel-run-client.ts`, `AppBackend.plans` in
    `packages/code/src/views/App.tsx`, `OverlayRegionProps.plans`, and `PlanOverlay.props.plans`.
    Test: `packages/code/tests/component/kernel-run-client.test.ts` (read-only plan surface), the
    read-only fakes in `packages/code/tests/integration/app-shell-render.test.tsx` and
    `packages/code/tests/integration/overlay-region-render.test.tsx`.
26. **A stale plan-document response cannot overwrite a newer live revision.** `loadActivePlan`
    captures a monotonic `documentRequestSeq`; deactivation, plan disappearance or a new live
    revision advances it.
    Production: `packages/code/src/views/overlays/PlanOverlay.tsx` (`documentRequestSeq`,
    `loadedPlanKey`, `loadActivePlan`). Test:
    `packages/code/tests/integration/plan-overlay-render.test.tsx` (stale document response case).
27. **Escape or Ctrl+P closes the current-plan overlay and returns to the transcript.
    Ctrl+C is not claimed by the plan: the global command cancels the active run or enters quit while
    the plan stays open.** Production: `packages/code/src/views/overlays/PlanOverlay.tsx`
    (`plan.escape`), `packages/code/src/views/App.tsx` (`openPlan`), and
    `packages/code/src/keys/interaction.ts` (`DEFAULT_WHEN`). Pinned by
    `packages/code/tests/integration/plan-overlay-render.test.tsx` and
    `packages/code/tests/integration/app-shell-render.test.tsx`.
28. **`fuzzyFieldMatch` ties go to the earlier-indexed field**, and a match spanning only the
    concatenation of two fields (neither field alone) is `null`. `packages/code/src/core/fuzzy.ts`. Pinned:
    `packages/code/tests/unit/fuzzy-positions.test.ts`.
29. **A local `!` command never reaches the command guard or a `KernelClient` call.**
    `packages/code/src/adapters/local-shell.ts` (`runLocalBash`; the function's own body
    contains no such call). **Unpinned by an automated test** — this is an absence-of-a-call
    property, not directly assertable from the outside; verified here only from the function
    and its call sites.
30. **`AgentProfilePicker`'s scope chooser is a fully reversible round trip**: opening it (`s`) never
    mutates a default by itself, `escLabel="back"`/`onClose` return to the agent list with no
    default changed, and a successful `onSetDefault`/`onClearDefault` is what closes it back to the
    agent list — never the reverse. `packages/code/src/views/overlays/AgentProfilePicker.tsx`. Pinned:
    `packages/code/tests/integration/agent-profile-picker-render.test.tsx`.
31. **While the Task editor is expanded, a first Escape closes an open autocomplete popup; only a
    second Escape (with no popup open) collapses the editor back to the inline composer.**
    `packages/code/src/views/InputDock.tsx` (the `escape` binding registered only while `expanded()`, sharing
    the layer with `dismissAutocomplete`). Pinned:
    `packages/code/tests/integration/input-dock-submit.test.tsx`.
32. **`PromptHistory.prev` stashes the live draft only the first time the cursor steps off the end of
    the ring; `push` no-ops on an immediate repeat of the previous entry; `seed` never re-adds an
    entry already known to the ring, while still recovering one the backing file no longer has.**
    `packages/code/src/core/prompt-history.ts` (`prev`, `push`, `seed`). Pinned:
    `packages/code/tests/integration/input-editor.test.ts`.
33. **`Help`'s "Available elsewhere" section is a live, deduplicated projection, not a static table**:
    it excludes anything already shown in "Available here", any `EDITING_CATEGORIES` command, and
    any `CHROME_COMMAND`-matching name, so the one screen whose purpose is documenting keys still
    lists a global key the `/help` overlay itself deactivates while open.
    `packages/code/src/views/overlays/Help.tsx`. Pinned: `packages/code/tests/integration/help-render.test.tsx`.
34. **`ActivityDetail` renders the original content as scrollable Markdown and owns Escape while
    open; Ctrl+C remains global.** The sidebar/transcript preview is deliberately not the detail source. Production:
    `packages/code/src/views/overlays/ActivityDetail.tsx`; pinned by
    `packages/code/tests/integration/activity-detail-render.test.tsx`.
35. **Escape only clears the active input or returns one screen, and every Escape dispatch is
    immediate.** At the root composer it clears text plus staged attachments and emits
    `"Draft cleared"`; with no draft/focus/overlay it does nothing. It never cancels a run or quits.
    Top overlays, focused transcript blocks, autocomplete and the expanded editor keep their
    higher-priority clear/back behavior, while Ctrl+C remains the sole cancel-or-quit key.
    Production: `packages/code/src/keys/interaction.ts`,
    `packages/code/src/views/App.tsx`. Pinned synchronously at
    `packages/code/tests/integration/interaction.test.ts`, and end to end at
    `packages/code/tests/integration/app-shell-render.test.tsx`.
36. **Opening and closing autocomplete reuses one bounded native projection after first use.** It
    keeps exactly ten row/header slots, hides unused slots, continuously scrolls them inside a fixed
    popup frame without `N more` labels and changes the `autocomplete` keymap datum only when its
    boolean value changes. Production: `packages/code/src/views/InputDock.tsx`
    (`SurfaceBoundary`, `closeAc`, `refreshAc`) and
    `packages/code/src/ui/patterns/windowed-list.tsx` (`StableWindowedList`) and
    `packages/code/src/views/input/AutocompletePopup.tsx` (`MAX_ROWS_CAP`, `visible`). Test:
    `packages/code/tests/integration/autocomplete-popup-render.test.tsx` and
    `packages/code/tests/integration/input-dock-submit.test.tsx`.
37. **No full-region page reconstructs or interacts through the transcript shell.** Diff, Plan and
    configuration pages, including Workflows, cover one still-mounted fallback whose Yoga geometry,
    owners and scroll state remain intact. While covered, the fallback is transparent, rejects mouse
    input, pauses physical transcript observation and exposes no elicitation; returning reveals the
    same shell instance. Diff and Plan mount lazily, remain hidden after first use and cannot dispatch
    their retained key layers while inactive. Production:
    `packages/code/src/views/app/OverlayRegion.tsx` (`OverlayRegion`, `overlayFallbackActive`),
    `packages/code/src/views/app/TranscriptRegion.tsx` (`active`, `TranscriptProjection`),
    `packages/code/src/views/overlays/PlanOverlay.tsx` (`active`, `when`), and
    `packages/code/src/views/overlays/DiffViewer.tsx` (`active`, `registerScrollKeys`). Test:
    `packages/code/tests/integration/overlay-region-render.test.tsx` ("full-page overlays hide the
    shell without unmounting and rebuilding it" and full-region repeated-visit geometry) and
    `packages/code/tests/unit/when-dsl.test.ts`.
38. **Configuration-page retention stops at the stack boundary.** Opening the stack removes the
    transcript shell from paint and interaction but not from ownership or layout. An inactive
    configuration parent remains mounted, but popping a child disposes that frame once and closing
    the root disposes the remaining configuration stack. Shell retention and Plan/Diff retention
    must not turn popped configuration frames into an application-lifetime cache. Production:
    `packages/code/src/views/app/OverlayRegion.tsx` (`OverlayRegion`) and
    `packages/code/src/views/overlay-host.ts` (`mountView`, `popView`, `closeView`).
    Test: `packages/code/tests/unit/overlay-host.test.ts` and
    `packages/code/tests/integration/overlay-region-render.test.tsx`.
39. **High-churn picker and drawer trees mount lazily once, then hide without owning inactive
    keys.** Agent Profile Picker, Catalog Picker and the narrow activity drawer retain their renderer trees
    only after first use. A retained catalog resets its filter and cursor whenever the active picker
    spec changes. Production: `packages/code/src/ui/patterns/surface-lifecycle.tsx`
    (`SurfaceBoundary`), `packages/code/src/views/App.tsx` (agent-picker boundary),
    `packages/code/src/views/app/TranscriptRegion.tsx` (drawer boundary),
    `packages/code/src/views/config/CatalogPicker.tsx` (`CatalogPicker`),
    `packages/code/src/ui/patterns/level-host.tsx` (`LevelHost`), and
    `packages/code/src/views/config/field-editor.tsx` (`PickerInput`). Test:
    `packages/code/tests/integration/app-shell-render.test.tsx` and
    `packages/code/tests/integration/field-editor-pick-render.test.tsx`.
40. **Help is a full-page, slash-only destination.** `/help` lazily mounts the `Help` view, projects
    active and elsewhere-registered actions from the live keymap, and adds destinations, input
    syntax, editing commands and keyboard-environment diagnostics. No floating Help overlay or F1
    action exists. Production: `packages/code/src/app/commands.tsx` (`help.open`),
    `packages/code/src/views/overlays/Help.tsx` (`Help`), and
    `packages/code/src/keys/interaction.ts` (`DEFAULT_BINDING_CANDIDATES`). Tests:
    `packages/code/tests/integration/help-render.test.tsx`,
    `packages/code/tests/integration/app-shell-render.test.tsx` ("/help opens the full Help screen and
    returns to the same shell"), and `packages/code/tests/integration/interaction.test.ts`
    ("F1 has no built-in action").
41. **Floating content escapes clipped pages without remounting its portal host.** A floating
    `SurfaceBoundary` creates one root portal outside its content and requires `retain-one`. The host
    becomes invisible while inactive so it cannot intercept mouse input, while the bounded subtree
    and its lifecycle-pass set remain constant after first use. `dispose-on-close` is restricted to
    non-portal regions because mutating a Portal host during conditional recursive removal leaves
    orphaned descendant lifecycle-pass nodes. Production:
    `packages/code/src/ui/patterns/surface-lifecycle.tsx` (`SurfaceBoundary`, `SurfacePortal`) and
    `packages/code/src/views/overlays/FloatFrame.tsx` (`FloatFrame`). Test:
    `packages/code/tests/integration/surface-lifecycle-render.test.tsx` (portal clipping, focus/guard
    lifecycle and retained-frame lifecycle-set cases) and
    `packages/code/tests/integration/app-shell-render.test.tsx` (drawer/modal mouse routes).
42. **A bare slash reuses both the command catalog and its completion rows.** The catalog is
    invalidated only by command registration/disposal or a new keyboard-environment object; the
    browse projection is invalidated only when that catalog or dynamic eligibility changes.
    Production: `packages/code/src/keys/commands.ts` (`commandCatalog`, `entries`) and
    `packages/code/src/views/input/command-completion.ts` (`createCommandCompletionProvider`). Test:
    `packages/code/tests/unit/commands.test.ts` (catalog identity and bare-slash eligibility cases).
43. **A retained `FloatFrame` owns one animation and one resolved navigation subtree.** The first
    activation preserves the entrance treatment; later activations reveal the settled retained tree
    and keep the single timeline owner paused while inactive. Its JSX-valued navigation prop is
    resolved once, so footer visibility checks cannot mount duplicate responsive navigation trees or
    duplicate their renderer resize listeners. Production:
    `packages/code/src/views/overlays/FloatFrame.tsx` (`FloatFrame`, `onSurfaceActivate`). Test:
    `packages/code/tests/integration/float-frame-render.test.tsx` (single navigation subtree and
    listener cleanup) and `packages/code/tooling/benchmarks/overlays.tsx` (retained Profile,
    Isolation, Review and Catalog picker cases).
44. **Isolation and Review are independent lazy retained overlays over the same write contracts as
    Run Controls.** They mount only after `isolation.picker` or `review.picker` opens them, reuse
    `ListPicker`, cannot own keys while inactive, and cannot implement settings merges that differ
    from Run Controls. Production: `packages/code/src/views/App.tsx`,
    `packages/code/src/views/overlays/IsolationPicker.tsx`,
    `packages/code/src/views/overlays/ReviewPicker.tsx`,
    `packages/code/src/features/run/isolation.ts` (`applyIsolation`), and
    `packages/code/src/features/run/review.ts` (`applyReviewMode`). Tests:
    `packages/code/tests/integration/app-shell-render.test.tsx`,
    `packages/code/tests/integration/isolation-review-picker-render.test.tsx`,
    `packages/code/tests/integration/run-controls-render.test.tsx`, and
    `packages/code/tests/integration/interaction.test.ts`.
45. **A fixed picker intro pays for its rows before list windowing.** A responsive intro reports zero
    rows while hidden; when visible, its full row count is subtracted before filter, preview and list
    space are allocated, so fixed branding cannot paint over the catalog or footer. Production:
    `packages/code/src/views/overlays/ListPicker.tsx` (`intro`, `introRows`, `rowBudget`) and
    `packages/code/src/views/config/CatalogPicker.tsx` (`firstRunIntroRows`). Test:
    `packages/code/tests/integration/catalog-picker-render.test.tsx` (`first-run branding stays with
the picker only while the complete splash fits`).
46. **The composer separates send from newline across the chords its keyboard profile can prove.**
    Unmodified Return and numpad Enter submit; Ctrl+J inserts a newline on every profile, and an
    Enhanced profile additionally registers Shift+Return. Portable never advertises a shifted chord
    after a legacy transport may have collapsed it to ordinary Return.
    Production: `packages/code/src/keys/keyspec.ts` (`PROMPT_EDITING_KEYS`) and
    `packages/code/src/views/InputDock.tsx` (`promptHandlers`). Test:
    `packages/code/tests/integration/input-dock-submit.test.tsx` (Enhanced Shift+Enter and Ctrl+J,
    plus portable Ctrl+J-only registration).
47. **Inline composer height follows visual soft wraps, not only explicit newline characters.** It
    uses the renderer's visual-line projection, caps at `maxInlineRows()` and wraps unbroken tokens
    by character, while the expanded status continues to report logical lines. Production:
    `packages/code/src/views/InputDock.tsx` (`visualRows`, `inlineRows`, `syncDraftState`, textarea
    `wrapMode`). Test: `packages/code/tests/integration/input-dock-submit.test.tsx` ("a soft-wrapped
    logical line grows the inline composer and keeps its prefix visible").
48. **Autocomplete scroll mode changes only the retained row/header projection.** It uses every
    available content line without overflow-count labels and keeps the popup's top and bottom frame
    rows fixed as selection moves. Production:
    `packages/code/src/ui/patterns/windowed-list.tsx` (`WindowOverflowMode`, `windowRows`,
    `windowGroupedRows`) and `packages/code/src/views/input/AutocompletePopup.tsx`
    (`contentLines`, `overflowMode`). Tests: `packages/code/tests/unit/autocomplete.test.ts`
    (scroll-mode cases) and `packages/code/tests/integration/autocomplete-popup-render.test.tsx`
    (fixed-frame scrolling case).

## 6. Failure modes and degradation

- **Attachment rejection is always surfaced, never silent.** Every `attachments.add(...)`/
  `canAddImage(...)` call whose `AttachmentAdmission.ok` is `false` is routed through
  `notifyAttachmentRejection` → `props.onNotify?.(attachmentAdmissionMessage(admission))`
  (`packages/code/src/views/InputDock.tsx`); the rejected image never enters `AttachmentStore`
  (`packages/code/tests/unit/attachments.test.ts`).
- **A clipboard read that throws is caught and reported as a plain notification**
  (`"clipboard image read failed"`), guarded by a `disposed` flag so a resolution after the component
  unmounted is silently dropped rather than calling a stale `onNotify` (`packages/code/src/views/InputDock.tsx`).
- **An unknown `/name` submitted through the host's `onSlashCommand` implementation reports
  `unknown command: /name` and blocks** (this decision lives in the host — e.g. `packages/code/src/views/App.tsx`
  — not in `InputDock` itself, which only relays the `SlashOutcome`).
- **A mentioned-image load failure (`MentionImageError`) restores the exact draft text and staged
  attachments** rather than silently dropping the message — this recovery is `run-host.ts`'s
  ([hosts/code-run-host.md](code-run-host.md)), reached through the `onDock.restoreAttachments` handle
  (`packages/code/src/run-host.ts`).
- **`runLocalBash`'s own spawn failure (`proc.on("error", ...)`) still resolves, never rejects**: it
  records `spawnError`, settles with `exitCode: null` and `stderr` falling back to the spawn error's
  message (`packages/code/src/adapters/local-shell.ts`, `runLocalBash`). Pinned:
  `packages/code/tests/integration/local-shell.test.ts` (a nonexistent `cwd` "settles as a failure and
  records why", with `spawn_failed: true` in the diagnostic).
- **Prompt history persistence degradation never blocks the ring.** A failed `append`/`compact`
  sets `degraded=true` and reports once via `onPersistenceError`, but `entries`/`cursor` continue to
  work purely in memory (`packages/code/src/core/prompt-history.ts`). Pinned:
  `packages/code/tests/integration/input-editor.test.ts`.
- **A corrupt line in the prompt-history file is skipped, not fatal** — `loadEntries`'s `JSON.parse`
  is wrapped per-line (`packages/code/src/adapters/file-prompt-history.ts`). Pinned:
  `packages/code/tests/integration/input-editor.test.ts`.
- **`PlanOverlay.loadActivePlan` guards against a stale response** via `documentRequestSeq`; an
  out-of-order resolve is discarded rather than overwriting a newer live revision. A read failure
  sets `loadingError()` and renders `"plan document invalid: <message>"` while preserving live tasks.
- **The fire-and-forget active-plan read** is wrapped in `detachObserved`
  (`packages/code/src/core/tasks.ts`, owned elsewhere), which records a
  `task.failed` diagnostic before any local observer runs and — by design — never falls back to
  `process.emitWarning`, so a background failure cannot paint over the terminal.
- **A hooks/agent-loop capability importing this subsystem is out of scope** — nothing here degrades
  when the model/agent side fails; that boundary belongs to [hosts/code-run-host.md](code-run-host.md).

## 7. Coupling

**Depends on** (runtime, static imports):

- `@opentui/{core,solid,keymap}` — textarea/renderer/keymap primitives, throughout `InputDock.tsx`
  and every overlay.
- `views/theme/*` ([hosts/code-theme.md](code-theme.md) document) — `tokens`, `glyph`/`borderChars`, `overlayBg`/
  `selectionBg`/`scrimColor`/`ruleColor` — every overlay component reads these for color/border.
- `keys/*`, `ui/patterns/*` ([hosts/code-keyboard.md](code-keyboard.md) document) — `Interaction`, `uiCommand`,
  `LAYER`/`registerLevel`, `clampListIndex`, `registerScrollKeys`, `followSelection`,
  `InteractionNavigationBar`, `GROUP_ORDER`/`GROUP_LABEL`/`PARENT_LABEL`. `InputDock`,
  `ListPicker`, `Help`, `PlanOverlay` all register key layers through
  this vocabulary; this document does not re-derive keybinding semantics.
- `@clarvis/kernel/local` (`resolveShell`, `shellArgs`, `killTree`, `ownProcessGroup`) —
  `packages/code/src/adapters/local-shell.ts` reuses the exact shell-dialect resolver the kernel's own tools use, so
  `!` never diverges in _which_ shell binary/flavor runs, only in forcing `bash` over bare `sh`.
- `@clarvis/protocol` — `MessageContent`, `PlanDocumentDto`/`PlansService`, `Scope` — the wire types
  `InputDock` composes and `PlanOverlay`/`AgentProfilePicker`
  render against.
- `adapters/activity-store.ts`, `adapters/execution-safety.ts`, `views/blocks.tsx`,
  `ui/presentation.ts`, `views/Prose.tsx`, `views/config/view-host.tsx` — all owned by sibling documents
  ([hosts/code-run-host.md](code-run-host.md), [hosts/code-transcript.md](code-transcript.md)); `PlanOverlay`/`DiffViewer` read
  from them but do not own their contracts.
- `core/tasks.ts` (`detachObserved`) — the shared observed-task helper this document consumes but
  does not own.

**Depended on by**:

- `views/App.tsx` ([hosts/code-bootstrap.md](code-bootstrap.md) document) mounts `InputDock` and,
  via `views/app/OverlayRegion.tsx`, `DiffViewer`/`PlanOverlay`; it also _is_ the
  concrete `onSlashCommand`/`onBashCommand` implementation (`classifySlashSubmit`, the `commandProvider`
  and `mentionProvider` autocomplete providers) that `InputDock`'s props describe abstractly. This
  item does not describe `App.tsx`'s own internals beyond the seam.
- `run-host.ts` ([hosts/code-run-host.md](code-run-host.md) document) is the concrete `runBash`/`bang` implementation
  behind `onBashCommand`, and the mention-image resolution step (`buildContent`/
  `appendMentionImages`) that runs on `InputDock`'s composed content before it reaches a run.
- `runtime.tsx` wires `runHost.runBangCommand` to `props.run.bang`
  (`packages/code/src/runtime.tsx`, `runControls.bang`).
- `views/ElicitBlock.tsx` ([cross-cutting/elicitation.md](../cross-cutting/elicitation.md) document) reuses `ChoiceRows` for rendering
  elicitation option lists — a one-way dependency out of this document's `views/overlays/*`.
- `views/config/CatalogPicker.tsx` reuses `ListPicker<T>`.

**What forces the direction**: `packages/code/src/adapters/local-shell.ts` and
`packages/code/src/views/input/*`/`views/overlays/*` import nothing from `run-host.ts` or `App.tsx`
(verified by grep — no reverse import found), so the dependency is one-way: this document's components
are generic/leaf, and the app shell composes them. `core/{prompt-history,fuzzy,attachments}.ts` import
nothing beyond `@clarvis/protocol` types and are themselves leaves within `packages/code/src`.

## 8. Open questions

- **The exact combination of a slash line submitted while `submissionBlocked` is simultaneously
  set** is not exercised by a test in this document's scope. The source shows `onSlashCommand` is invoked
   unconditionally before the `submissionBlocked` check (`packages/code/src/views/InputDock.tsx`), and — one
  layer up, in `packages/code/src/views/App.tsx` (outside this document) — the concrete `onSlashCommand`
  implementation applies its own memory-pressure gate per slash name. Whether every other host of
  `InputDock` (there appears to be exactly one, `App.tsx`) relies on this same double-gating, or
  whether a slash command could bypass a blocked-submission reason the plain-text/bang paths would
  have honored, is a design property stated by reading the code, not proven by a test that submits
  both simultaneously.
- **The absence of a `KernelClient`/guard call on the `!` path (Invariant 30)** is documented in a
  source comment on `runLocalBash` in `packages/code/src/adapters/local-shell.ts`. ~~No test can assert "no call was
  made" as directly as it can assert a positive behavior; this is inherently an
  absence-property.~~ **Pinned** by
  `packages/code/tests/architecture/local-bash-bypasses-the-kernel.test.ts`, which asserts the absence
  structurally — the module names no kernel client, no `GuardContext`, and no shell analysis. Writing
  it corrected the claim in one respect: the module _does_ import `@clarvis/kernel`, but from
  `./local`, the host process/shell adapter surface, which is precisely what keeps `!` from diverging
  from the shell the agent's own commands run through. The test asserts that distinction — exactly one
  kernel import, and it is `/local` — rather than a blanket absence that would have been false.
- **`AgentProfilePicker`'s comment** ("Offering a profile that cannot run, with nothing said, is invariant
  2 read backwards" — `packages/code/src/views/overlays/AgentProfilePicker.tsx`) references a numbered invariant list
  the source itself never names. The claim is recorded verbatim as evidence of intent, but which list
  its "invariant 2" belongs to is not resolved here.
- **Whether `keys/commands.ts`'s registry (`createCommands`, tested in
  `tests/unit/commands.test.ts`/`commands-revision.test.ts`) belongs partially to this document** is
  ambiguous from the file list alone: `app/commands.tsx` (`registerAppCommands`, in this document's scope)
  is a thin _consumer_ of that registry, which is specified in
  [hosts/code-keyboard.md](code-keyboard.md) §2.5. This spec treats the registry itself, and the deep-linking/
  hub-child mechanics tested at length in `tests/integration/app-commands.test.tsx` (planning-mode
  settings writes, doctor gates, debug session, first-run/recovery routing), as belonging to sibling
  items ([hosts/code-keyboard.md](code-keyboard.md), [hosts/code-bootstrap.md](code-bootstrap.md), [capabilities/plan-capability.md](../capabilities/plan-capability.md))
  and describes only the surface `app/commands.tsx` exposes for internal/slash wiring.
- **`tests/integration/secret-input-render.test.tsx`** exercises `views/config/view-host.tsx`'s
  `createFieldEditor` secret-entry mode, not anything under `views/overlays/*` or `views/input/*`; it
  is out of this document's scope (it belongs with the config-view host, not among the files this
  document specifies) and is not cited further above.
