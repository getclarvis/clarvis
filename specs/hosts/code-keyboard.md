# Keybindings, interaction projection and generated navigation hints

> Implemented at `packages/code/src/keys/**`, `packages/code/src/ui/patterns/**`,
> `packages/code/src/ui/presentation.ts`, `packages/code/src/views/Footer.tsx`,
> `packages/code/src/views/hint.ts`, `packages/code/src/views/config/KeyboardView.tsx`, and
> `packages/code/src/adapters/provider-secrets.ts`. Every claim below is anchored to a file and
> line. Open questions are collected in the final section.

## 1. Purpose

This subsystem is `@clarvis/code`'s keybinding layer built on top of `@opentui/keymap`:
it declares what a key does, decides which of several possible key spellings a given
terminal actually gets, and — the property the four owned invariants are about —
generates every on-screen navigation hint (footer segments and the full Help key table)
from that one live declaration rather than from hand-written
strings scattered through each screen.

Three problems are solved together. First, terminals disagree wildly about which key
combinations they can deliver (`packages/code/src/keys/keyboard-profile.ts`
`defaultKeyboardProfile` — enhanced accelerators are automatic only for local Kitty-protocol
input), so a command's binding is described as a list of *candidates* gated by capability,
not a single hard-coded chord. Second, a screen author must not be able to advertise a key
that then does nothing — every list activation, footer segment and settings action row in this
subsystem is generated from what the keymap says is *currently enabled*, never printed as
static text (`packages/code/src/ui/patterns/list-navigation.ts`,
`packages/code/src/keys/commands.ts`). Third, Escape is never a close/cancel gesture: every Escape press immediately clears input
or moves back one semantic screen, while Ctrl+C exclusively owns run cancellation and app
quit. Terminals can deliver repeated packets while the cancel binding is held, so
`createInteraction` retains a 1-second repeat-metadata window for the current `run.cancel` binding;
Escape never enters that timing path (`packages/code/src/keys/interaction.ts`).

`ui/patterns/**` is the reusable, content-agnostic half: list navigation, a level's key
layer (nav + verbs + escape), the footer's action projection and width budget, and a
generic map editor. `keys/**` is the vocabulary half: what a command *is* (`actions.ts`),
what a `when` clause means (`when-dsl.ts`), how a key label is formatted
(`keyspec.ts`), how one physical terminal is classified into a Keyboard Profile
(`keyboard-profile.ts`), the command registry (`commands.ts`) and the one
`createInteraction` call that wires the whole keymap (`interaction.ts`).

## 2. Surface

The background-run view uses the shared level/list key registration: arrows select runs or a new
conversation, Enter opens the selection, `t` explicitly confirms takeover of another controller,
`c` requests cancellation when control permits it, and `ctrl+r` refreshes discovery. Escape follows
the standard view-host dismissal boundary. Disabled verbs do not acquire authority.

Production: `BackgroundView` in [view.tsx](../../packages/code/src/features/background/view.tsx).
Test: [background-commands.test.tsx](../../packages/code/tests/integration/background-commands.test.tsx)
drives the shared keymap and checks attach/new-conversation rendering and actions.

### 2.1 `keys/keyspec.ts` — key-label formatting and layer priorities

| Export | Signature | Cite |
| --- | --- | --- |
| `LAYER` | `{ INPUT = 500, LIST = 810, VITAL = 900, OVERLAY = 950, TRANSIENT = 955, MODAL = 960, CONFIRM = 970 }` | `packages/code/src/keys/keyspec.ts` |
| `compactKey(token, opts?)` | `(string, {clientPlatform?}) => string` | `packages/code/src/keys/keyspec.ts` (`compactKey`) |
| `compactSequence(parts)` | `(readonly {display}[]) => string` | `packages/code/src/keys/keyspec.ts` |
| `commandKeyLabel(keymap, command, opts?)` | `=> string \| undefined` | `packages/code/src/keys/keyspec.ts` |
| `PROMPT_EDITING_KEYS` | `PromptKeyRow[]` (prompt editor's chords, dock-registered and OpenTUI built-in) | `packages/code/src/keys/keyspec.ts` (`PROMPT_EDITING_KEYS`) |
| `promptKeyLabel(command)` | `(string) => string` | `packages/code/src/keys/keyspec.ts` (`promptKeyLabel`) |

`compactKey` is, by its own doc comment, "THE key-label formatter" — every surface that
prints a key routes through it, so one binding can never read `meta+r` in one place and
`alt+r` in another (`packages/code/src/keys/keyspec.ts`, `compactKey`). It is idempotent (feeding an
already-compact label back in returns it unchanged — pinned at
`packages/code/tests/unit/keyspec.test.ts` (`compactKey: already-compact labels pass through unchanged`)).
For the composer, unmodified Return/numpad Enter owns `prompt.send`, while Ctrl+J owns the portable
`prompt.newline` chord. Enhanced keyboard profiles additionally register Shift+Return. Portable
profiles do not register or advertise Shift+Return because a legacy terminal, SSH path or
multiplexer may collapse it to ordinary Return before Clarvis can distinguish it. `compactKey`
preserves the `shift+` prefix for a rendered
non-character key such as Return, including when Help formats the already-compact `shift+↵` label a
second time, so newline cannot look identical to send. Test:
`packages/code/tests/integration/help-render.test.tsx` (newline label in Help).

### 2.2 `keys/when-dsl.ts` — the `when` DSL

| Export | Signature | Cite |
| --- | --- | --- |
| `ContextKey` | `"overlay" \| "autocomplete"` | `packages/code/src/keys/when-dsl.ts` |
| `Clause` | `{kind:"truthy",key} \| {kind:"eq",key,value} \| {kind:"oneOf",key,values}` | `packages/code/src/keys/when-dsl.ts` (`Clause`) |
| `parseWhen(input)` | `(string) => Clause`, throws on empty/malformed/unknown key | `packages/code/src/keys/when-dsl.ts` (`parseWhen`) |
| `isTruthy(v)` | `(unknown) => boolean` | `packages/code/src/keys/when-dsl.ts` |
| `evalClause(c, get)` | `(Clause, (k)=>unknown) => boolean` | `packages/code/src/keys/when-dsl.ts` |
| `compileWhen(value, ctx, get)` | compiles into `ctx.require` (eq) or `ctx.activeWhen` (truthy/value-set) | `packages/code/src/keys/when-dsl.ts` (`compileWhen`) |
| `registerWhenField(keymap)` | registers `when` as a binding + layer field; returns disposer | `packages/code/src/keys/when-dsl.ts` |

Grammar is deliberately narrow: `key`, `key==value`, or a literal bounded set
`key in (value, value)`, nothing else — no `!`, `!=`, `&&`, nesting, or empty set.
Pinned by `packages/code/tests/unit/when-dsl.test.ts`.

`isTruthy` treats `"none"` and `""` as falsy alongside `null`/`undefined`/`false`, because
context values default to sentinels like `overlay: "none"` rather than being absent
(`packages/code/src/keys/when-dsl.ts`; pinned `packages/code/tests/unit/when-dsl.test.ts`).

### 2.3 `keys/actions.ts` — the action/UI-projection vocabulary

| Export | Signature | Cite |
| --- | --- | --- |
| `ActionSurface` | `"footer" \| "full-help" \| "internal"` | `packages/code/src/keys/actions.ts` (`ActionSurface`) |
| `ActionHintGroup` | `"primary" \| "navigation" \| "mutation" \| "escape"` | `packages/code/src/keys/actions.ts` (`ActionHintGroup`) |
| `UiActionSpec` | product-facing action declaration (id, title, description, category, `run`, `surfaces`, `footerLabel?`, `hintPriority?`, `hintGroup?`, `essential?`, `enabled?`) | `packages/code/src/keys/actions.ts` |
| `registerUiActionFields(keymap)` | registers `uiTitle`/`uiDescription`/`uiCategory`/`uiSurfaces`/`footerLabel`/`hintPriority`/`hintGroup`/`essential` as command fields; each setter throws on the wrong shape | `packages/code/src/keys/actions.ts` |
| `uiCommand(spec)` | `UiActionSpec => OpenTuiCommand` | `packages/code/src/keys/actions.ts` |

### 2.4 `keys/command-groups.ts` — slash/Help grouping

| Export | Signature | Cite |
| --- | --- | --- |
| `GROUP_ORDER` | `["actions","navigate","skills","mcp"]` | `packages/code/src/keys/command-groups.ts` |
| `GROUP_LABEL` | `{actions:"Actions", navigate:"Go to", skills:"Skills", mcp:"MCP prompts"}` | `packages/code/src/keys/command-groups.ts` |
| `isTopLevelCommand(e)` | excludes `surface==="internal"` and any command whose `parent` is a hub parent (`settings`, `extensions`) | `packages/code/src/keys/command-groups.ts` (`HUB_PARENTS`, `isTopLevelCommand`) |

Consumed only outside this document's scope (`views/App.tsx`, delegated to
[hosts/code-input-and-overlays.md](code-input-and-overlays.md)); **no dedicated unit test exists for
this file** (see §8).

### 2.5 `keys/commands.ts` — the command registry

| Export | Signature | Cite |
| --- | --- | --- |
| `Scope` | `"global" \| "workspace"` | `packages/code/src/keys/commands.ts` |
| `ViewFactory` | `(host: ViewHost) => JSX.Element` | `packages/code/src/keys/commands.ts` |
| `ConfirmRequest` | `{message, danger?, detail?, confirmLabel?, cancelLabel?}` — parameters for `ViewHost.confirm` | `packages/code/src/keys/commands.ts` |
| `ViewHost` | interaction/level/breadcrumb/scope/dirty/confirm services a view command's body receives | `packages/code/src/keys/commands.ts` |
| `Surface` | `"slash" \| "internal"` | `packages/code/src/keys/commands.ts` |
| `Group` | `"actions" \| "navigate" \| "skills" \| "mcp"` | `packages/code/src/keys/commands.ts` |
| `Parent` | `"settings" \| "sessions" \| "extensions" \| "inspect"` | `packages/code/src/keys/commands.ts` |
| `SubcommandSpec` | `{name, desc?}` — one inline choice hint shown under `/token ` | `packages/code/src/keys/commands.ts` |
| `PromptArgSpec` | `{name, description?, required?}` — one positional argument of an MCP/skill prompt command | `packages/code/src/keys/commands.ts` |
| `CommandMatch` | `{field:"title"\|"name"\|"slash", text, positions}` — a fuzzy-match hit location for slash autocomplete | `packages/code/src/keys/commands.ts` |
| `CommandEntryView` | read-only projection for slash/Help rendering, incl. `keyHint` and `canAct?` | `packages/code/src/keys/commands.ts` |
| `KeyCommandGroup` | `{category, rows: KeyCommandRow[]}` | `packages/code/src/keys/commands.ts` |
| `CommandEffects` | `{clearSession(), status(), exportSession()}` — callbacks the 3 built-in commands invoke | `packages/code/src/keys/commands.ts` |
| `ViewRoute` | `{name, factory, scope?}` — a view route mounted under a deep-linked child so Escape has a page to return to | `packages/code/src/keys/commands.ts` |
| `CommandUi` | `{openView(name, view, opts?), dismiss(), commandFailed(name, error)}` | `packages/code/src/keys/commands.ts` |
| `CommandScope` | `{registerAction, registerView, promptCommand, skillCommand, dispose}` | `packages/code/src/keys/commands.ts` |
| `CommandRouteResult` | `boolean \| "block"`; handled, fall through, or preserve invalid composer input | [commands.ts](../../packages/code/src/keys/commands.ts) |
| `Commands` | the registry API: `registerAction`, `registerView`, `promptCommand`, `skillCommand`, `dispose`, `scope()`, `runCommand`, `route`, `entries`, `revision`, `keyCommandGroups`, `viewFactory` | `packages/code/src/keys/commands.ts` |
| `createCommands(interaction, effects, ui)` | builds the registry, wires the shared keymap, registers 3 built-in session commands | `packages/code/src/keys/commands.ts` |

`createCommands` registers exactly three built-ins: `app.clear` (`/clear`), `status.show`
(`/status`), `session.export` (`/export`) — `packages/code/src/keys/commands.ts`.

`CommandEntryView.canAct` is a *function* rather than a boolean so slash autocomplete evaluates a
command's current availability only while it is the active consumer; registration itself does not
subscribe to those predicates (`packages/code/src/keys/commands.ts`, `CommandEntryView.canAct`).

The application composition adds one contextual navigation action after registry construction:
`activity.open` exposes `/activity` plus `plan`, `workflow` and `agents` subcommands whenever any
run-activity section exists. Bare `/activity` chooses the first available section; the explicit
subcommands reveal their named section. This is the keyboard-accessible reopen route after Escape
closes the responsive Sidebar (`packages/code/src/views/App.tsx`, `openActivitySidebar` and the
`activity.open` registration). The production-shaped command paths are pinned by
`packages/code/tests/integration/app-shell-render.test.tsx` ("Plan, Parallel work, and Agents own
independent once-per-run sidebar reveals").

The interactive composition registers `loop.open` as the native `/loop` action. Its parser and
controls do not consume a model turn. A validation error returns `"block"` through the registry and
App so InputDock preserves the draft. The list/detail use standard level navigation and `p`, `r`,
`c`, `x` for pause, explicit resume, cancel registration and cancel registration plus its own run.
Production: `registerLoopCommands` in
[commands.ts](../../packages/code/src/features/loop/commands.ts), `LoopView` in
[view.tsx](../../packages/code/src/features/loop/view.tsx), and `onSlashCommand` in
[App.tsx](../../packages/code/src/views/App.tsx).
Test: loop validation and interactive controls in
[app-shell-render.test.tsx](../../packages/code/tests/integration/app-shell-render.test.tsx).
Ownership and timing are specified in [loop-scheduling.md](loop-scheduling.md).

### 2.6 `keys/keyboard-profile.ts` — compatibility environment and manual overrides

| Export | Signature | Cite |
| --- | --- | --- |
| `CapabilityState` | `"supported" \| "unsupported" \| "unknown"` | `packages/code/src/keys/keyboard-profile.ts` |
| `KeyboardProfile` | `"portable" \| "enhanced" \| "manual"` | `packages/code/src/keys/keyboard-profile.ts` |
| `ClientPlatform` | `"macos" \| "windows" \| "linux"` | `packages/code/src/keys/keyboard-profile.ts` |
| `KeyboardEnvironment` | the effective, non-sensitive facts (`transport`, `runtimePlatform`, `terminal`, `protocol`, `multiplexer`, `modifiers`, `baseLayout`, `profile`, `clientPlatform?`) | `packages/code/src/keys/keyboard-profile.ts` |
| `KeyboardEnvironmentConfig` | persisted per-environment record (`profile`, `clientPlatform?`, `verdicts?`, `bindings?`) | `packages/code/src/keys/keyboard-profile.ts` |
| `KeyboardEnvironmentInput` | `{remote, runtimePlatform, terminal?, kittyKeyboard, multiplexer?, host}` — inputs collected from OpenTUI without retaining raw input or host identity; the shape `defaultKeyboardProfile`, `buildKeyboardEnvironment` and `keyboardEnvironmentId` all take | `packages/code/src/keys/keyboard-profile.ts` |
| `KeyboardConfig` | `{ version = 1, environments: Record<string, KeyboardEnvironmentConfig> }` | `packages/code/src/keys/keyboard-profile.ts` |
| `BindingCandidate` | `{key, minimumProfile?, requires?}` | `packages/code/src/keys/keyboard-profile.ts` |
| `KeyboardBindingIssue` | `{command, key?, message, shadows?}` | `packages/code/src/keys/keyboard-profile.ts` |
| `normalizeKeyboardConfig(value)` | tolerant reader of the versioned block | `packages/code/src/keys/keyboard-profile.ts` |
| `defaultKeyboardProfile(input)` | `enhanced` iff `!remote && kittyKeyboard` | `packages/code/src/keys/keyboard-profile.ts` |
| `buildKeyboardEnvironment(input, saved?)` | derives the effective environment | `packages/code/src/keys/keyboard-profile.ts` |
| `keyboardEnvironmentId(input)` | 24-hex-char stable id from 5 dimensions | `packages/code/src/keys/keyboard-profile.ts` |
| `resolveCommandBindings(command, candidates, environment, overrides?)` | overrides → supported enhanced → portable | `packages/code/src/keys/keyboard-profile.ts` |
| `validateManualBindings(bindings, commands, normalizeKey?, defaultBindings?)` | shadow/unknown/empty/syntax checks against manual overrides and effective defaults | `packages/code/src/keys/keyboard-profile.ts` (`validateManualBindings`) |
| `applyManualBindingEdit(opts)` | folds one edit into a stored record | `packages/code/src/keys/keyboard-profile.ts` |
| `effectiveClientPlatform(environment)` | human-readable client convention, never guessed for `ssh` | `packages/code/src/keys/keyboard-profile.ts`, `effectiveClientPlatform` |

### 2.7 `keys/interaction.ts` — the wired keymap

| Export | Signature | Cite |
| --- | --- | --- |
| `OverlayKind` | `"none" \| "agentPicker" \| "diff" \| "plan" \| (string & {})` | `packages/code/src/keys/interaction.ts` |
| `InteractionEffects` | callbacks (`cancelRun`, `dismissTopOverlay`, `scrollTranscript`, …) the built-in commands dispatch into | `packages/code/src/keys/interaction.ts` |
| `Interaction` | the handle: `keymap`, `renderer`, `pushOverlayContext`/`popOverlayContext`, `setModalContext`, `keyboardEnvironment`, `keyboardEnvironmentId`, `configureKeyboard`, `dispose` | `packages/code/src/keys/interaction.ts` |
| `DEFAULT_BINDING_CANDIDATES` | 16 commands → candidate lists | `packages/code/src/keys/interaction.ts` (`DEFAULT_BINDING_CANDIDATES`) |
| `DEFAULT_WHEN` | 11 commands → `"overlay==none"`; `plan.open` → `"overlay in (none, plan)"` | `packages/code/src/keys/interaction.ts` (`DEFAULT_WHEN`) |
| `buildVitalBindings(defaults, defaultWhen)` | expands a command→key(s) table into bindings, stamping `modal:"none"` unless in `MODAL_LIVE_COMMANDS` | `packages/code/src/keys/interaction.ts` |
| `resolvedVitalBindings(platformName, environment, overrides?)` | resolves every vital command's key(s) for one environment; drops `app.suspend` on `win32` | `packages/code/src/keys/interaction.ts` |
| `createInteraction(renderer, platform, effects, initialKeyboardConfig?)` | builds and wires the whole keymap, returns `Interaction` | `packages/code/src/keys/interaction.ts`, `createInteraction` |

### 2.8 `ui/patterns/**`

| File | Exports | Cite |
| --- | --- | --- |
| `index.ts` | re-exports `bindLevelKeys`, all of `level-keys.ts`, all of `list-navigation.ts`, `SelectableList`, all of `map-editor.tsx`, `ViewFrame`, `LevelView` (type) | `packages/code/src/ui/patterns/index.ts` |
| `bind-level-keys.ts` | `bindLevelKeys(opts)` — reactively registers/unregisters a level's key layer | `packages/code/src/ui/patterns/bind-level-keys.ts` |
| `level-keys.ts` | `VerbSpec`, `PanelVerbName`, `PANEL_VERBS`, `verb(name, run, when?)`, `LevelSpec`, `registerLevel(keymap, spec, priority?)`; re-exports `LAYER`/`compactKey`/`compactSequence`/`commandKeyLabel`/`PROMPT_EDITING_KEYS`/`promptKeyLabel` from `keyspec.ts` | `packages/code/src/ui/patterns/level-keys.ts` |
| `list-navigation.ts` | `clampListIndex`, `ListNavOptions`, `registerListNav(keymap, opts)`, `followSelection(scroll, idPrefix, index)`, `registerScrollKeys(keymap, scroll, priority?, reservedKeys?)` | `packages/code/src/ui/patterns/list-navigation.ts` |
| `level-host.tsx` | `LevelView` (title, body, when?, readOnly?), `LevelHost<PickerSpec>(props)` | `packages/code/src/ui/patterns/level-host.tsx` |
| `view-frame.tsx` | `ViewFrame(props)` | `packages/code/src/ui/patterns/view-frame.tsx` |
| `navigation-bar.tsx` | `NavigationBar(props)`, `InteractionNavigationBar(props)` | `packages/code/src/ui/patterns/navigation-bar.tsx` |
| `active-actions.ts` | `ActiveAction`, `projectActiveActions(keys, client?)`, `actionSegment(action)`, `budgetFooterActions(actions, width, measure?)` | `packages/code/src/ui/patterns/active-actions.ts` |
| `selectable-list.tsx` | `SelectableList<T>(props)` | `packages/code/src/ui/patterns/selectable-list.tsx` |
| `map-editor.tsx` | `MapValueKind`, `MapFieldEditor`, `MapLevelStack`, `MapSuggestion`, `MapEditorSpec`, `MapRow`, `isMapNode`, `readAt`, `pruneEmpty`, `updateAt`, `formatMapValue`, `mapRows`, `parseMapValue`, `MapEditor`, `createMapEditor(deps)` | see `map-editor.tsx` throughout |

### 2.9 `ui/presentation.ts`

Product vocabulary (`UiLifecycle`, `uiLifecycle`, `lifecycleLabel`, `MarkerMeaning`,
`markerText`, `SettingPresentation`, `settingSummary`, `EntitySummary`, `ScopedUsage`,
`scopedUsageText`) — `packages/code/src/ui/presentation.ts`. This module has **no coupling to keys/**
at all; it is content-agnostic formatting shared by settings screens (delegated to
[hosts/code-settings-panels.md](code-settings-panels.md) / [hosts/code-domain-hubs.md](code-domain-hubs.md)).

### 2.10 `views/Footer.tsx`, `views/hint.ts`

| Export | Signature | Cite |
| --- | --- | --- |
| `FooterStatusTone` | `HintTone \| "running"` | `packages/code/src/views/Footer.tsx` |
| `LeadActivityPhase`, `LeadActivityLine(props)` | one-row `ready`/`thinking`/`working` owner with optional run detail, replaced while composer autocomplete owns the band | `packages/code/src/views/Footer.tsx` |
| `HintToast(props)` | overlay-safe notify surface | `packages/code/src/views/Footer.tsx` |
| `Footer(props)` | `{hint, status?, runStrip?, navigation?: JSX.Element, compact?}` | `packages/code/src/views/Footer.tsx` |
| `HintTone` | = `NoticeTone` | `packages/code/src/views/hint.ts` |
| `HintState` | `{hint: Accessor<{text,tone}>, notify}` | `packages/code/src/views/hint.ts` |
| `createHintState(clock?)` | self-clearing (4s) hint signal | `packages/code/src/views/hint.ts` |

### 2.11 `views/config/KeyboardView.tsx`

`KeyboardView(host, deps)` — the settings screen for the Keyboard Profile, manual
bindings and the capability diagnostic. `deps: {code: CodeConfigStore, notify, startDiagnostic?}`
(`packages/code/src/views/config/KeyboardView.tsx`).

### 2.12 `adapters/provider-secrets.ts` — scope note

This file is **not** about keyboard keys. It is the provider-secret ("API key") cache
adapter: `KeySource` (`"auto"|"env"|"keyfile"`), `keyOrigin(source, envPresent, filePresent)`,
`KeysAdapter`, `createKeysAdapter(secrets)` (`packages/code/src/adapters/provider-secrets.ts`). Its only consumers
are the Providers feature and panels (`grep` confirms: `app/command-composition.ts`,
`app/commands.tsx`, `features/providers/*.ts`, `views/App.tsx`,
`views/config/{DoctorView,ProvidersPanel,providers/detail-level}.tsx` — none of them
keyboard-related). It shares nothing with `keys/**`. See §8.

## 3. Data and formats

### 3.1 The persisted `KeyboardConfig` block

Stored at `code.json`'s `ui.keyboard`, **global scope only** — `writeKeyboardEnvironment`
always calls `persist("global", ...)` (`packages/code/src/adapters/code-config.ts`) and
`keyboardConfig()` always reads `global().ui?.keyboard`
(`packages/code/src/adapters/code-config.ts`), never the workspace-merged view.

```json
{
  "version": 1,
  "environments": {
    "<24-hex-char id>": {
      "profile": "portable" | "enhanced" | "manual",
      "clientPlatform": "macos" | "windows" | "linux",
      "verdicts": { "ctrl": "supported", "meta": "unsupported", "baseLayout": "supported" },
      "bindings": { "isolation.picker": ["ctrl+b"] }
    }
  }
}
```

`writeKeyboardEnvironment` validates the id shape before writing
(`/^[a-f0-9]{24}$/`, `packages/code/src/adapters/code-config.ts`) — the same shape
`keyboardEnvironmentId` produces.

### 3.2 The environment id — what it hashes and what it deliberately excludes

`keyboardEnvironmentId` hashes exactly 5 dimensions with SHA-256, truncated to 24 hex
chars (`packages/code/src/keys/keyboard-profile.ts`):

| Dimension | Source |
| --- | --- |
| `transport` | `"ssh"` if remote else `"local"` |
| `runtimePlatform` | `HostPlatform` |
| `terminal` | terminal **name** only, lower-cased/trimmed — **not** version |
| `protocol` | `"kitty"` or `"legacy"` |
| `multiplexer` | `"none"\|"tmux"\|"zellij"\|"screen"\|"unknown"` |

Deliberately excluded: hostname, IP, username, raw key data, typed text, and the
terminal's **version** (`packages/code/src/keys/keyboard-profile.ts`) — a version bump would otherwise
mint a fresh id and silently orphan a path's saved profile, manual bindings and capability
verdicts. Pinned: `packages/code/tests/unit/keyboard-profile.test.ts` (a patch-version bump on
`ghostty` produces the same id; a different terminal name does not).

### 3.3 `DEFAULT_BINDING_CANDIDATES` — the full vital-command table

16 commands, each with 1-2 candidates (`packages/code/src/keys/interaction.ts`,
`DEFAULT_BINDING_CANDIDATES`):

| Command | Candidates | `when` |
| --- | --- | --- |
| `run.cancel` | `ctrl+c` | (none) |
| `app.escape` | `escape` | (none) |
| `app.suspend` | `ctrl+z` | (none) |
| `focus.next` | `tab` | `overlay==none` |
| `agent.picker` | `shift+tab` | `overlay==none` |
| `isolation.picker` | `alt+s` (enhanced, requires `meta`), `ctrl+s` | `overlay==none` |
| `review.picker` | `alt+g` (enhanced, requires `meta`), `ctrl+g` | `overlay==none` |
| `controls.open` | `alt+r` (enhanced, requires `meta`) | `overlay==none` |
| `plan.open` | `ctrl+p`, `alt+p` (enhanced, requires `meta`) | `overlay in (none, plan)` |
| `transcript.toggleCollapse` | `ctrl+o` | `overlay==none` |
| `transcript.focusPrev` | `ctrl+up` | `overlay==none` |
| `transcript.focusNext` | `ctrl+down` | `overlay==none` |
| `transcript.scrollPageUp` | `pageup` | `overlay==none` |
| `transcript.scrollPageDown` | `pagedown` | `overlay==none` |
| `transcript.scrollLineUp` | `alt+up` (enhanced, requires `meta`) | `overlay==none` |
| `transcript.scrollLineDown` | `alt+down` (enhanced, requires `meta`) | `overlay==none` |

Modified arrows (`ctrl+up`/`ctrl+down`) are portable — "plain xterm", not gated — while
`alt+…` candidates carry `minimumProfile:"enhanced"` because Alt is the modifier terminals
actually intercept (`packages/code/src/keys/interaction.ts`; pinned `packages/code/tests/integration/interaction.test.ts`).

`focus.next` is navigation only. A focused screen may reserve Tab for its own ordered controls; at
shell level `App.focusNext` clears the transcript's logical block cursor and focuses the composer,
regardless of whether the activity Sidebar is closed, split or in a drawer. It never activates a
control and never changes Lead/child transcript selection. Return remains the activation/submission
key for the component that owns focus, and Shift+Tab remains the explicit agent-picker route.
Production: `packages/code/src/keys/interaction.ts` (`focus.next`) and
`packages/code/src/views/App.tsx` (`focusNext`). Test:
`packages/code/tests/integration/app-shell-render.test.tsx` ("Tab returns block focus to the
composer with a sidebar open and never selects an agent" and "the split sidebar owns one compact
textual agent roster, including after expand all").

The transcript scroll commands dispatch row intent through `App.scrollTranscript`, which delegates
to `CommittedHistory.scrollBy` whenever committed history is mounted. That handle scrolls the native
ScrollBox and reveals older or newer index slices at the edges. Vertical wheel and trackpad packets
remain on OpenTUI's native ScrollBox path; leaving the bottom pauses follow-the-tail.
Production: `packages/code/src/views/App.tsx` and
`packages/code/src/views/history/CommittedHistory.tsx` (`scrollBy`). Test:
`packages/code/tests/integration/transcript-window-render.test.tsx` ("wheel-up over a long stream
does not clamp back to the tail").

### 3.4 Vital-command bindings example — `resolvedVitalBindings` output

For an `enhanced` environment with all modifiers `"supported"` (no manual overrides):

```json
{
  "run.cancel": "ctrl+c",
  "app.escape": "escape",
  "isolation.picker": ["alt+s", "ctrl+s"],
  "review.picker": ["alt+g", "ctrl+g"],
  "controls.open": "alt+r",
  "plan.open": ["alt+p", "ctrl+p"]
}
```

`resolveCommandBindings` builds `[...enhanced, ...portable]`
(`packages/code/src/keys/keyboard-profile.ts`), so a resolved enhanced candidate is always listed before
a portable one — `plan.open`'s enhanced `alt+p` precedes its portable `ctrl+p`. A single
resolved key collapses to a bare string; two or more become an array
(`packages/code/src/keys/interaction.ts`). A command whose every candidate resolves away (e.g. all
`enhanced`-only candidates on a `portable` profile) is **absent from the map entirely**
— `resolveCommandBindings` returns `[]` and the command gets no key at all
(`packages/code/src/keys/interaction.ts`).

### 3.5 `KeyboardBindingIssue` and `applyManualBindingEdit`'s output shapes

```ts
// success
{ config: KeyboardEnvironmentConfig }
// failure
{ issues: KeyboardBindingIssue[] }
```

Never both. Example refusal: editing `isolation.picker` to bind `escape` while `app.escape`
owns that protected default — `{command:"isolation.picker", key:"escape", message:"binding shadows app.escape", shadows:"app.escape"}`
(pinned by `packages/code/tests/unit/keyboard-profile.test.ts`, "the edited command's own issues still block the write"). The same shadow rule holds for an
alias spelling of a protected action's key (`escape`/`esc`/`Esc`/`ESC` all refused against
`app.escape`), though that test only asserts the message contains `"shadows app.escape"`,
not the full issue object (`packages/code/tests/unit/keyboard-profile.test.ts`).
A strict-prefix collision is refused too: `escape x` and `esc x` report
`"binding has an ambiguous prefix with app.escape"`. Without that rule, a timeout-based resolver
could make the protected exact action feel frozen; with Clarvis's exact-first resolver, the longer
route would instead be unreachable. The comparison includes every effective default for the active
profile, not only protected defaults and persisted overrides: rebinding `app.escape` to `tab x` is
therefore refused while unchanged `focus.next:tab` is active. Production: `validateManualBindings`
and `applyManualBindingEdit` in `packages/code/src/keys/keyboard-profile.ts`, wired with
`resolvedVitalBindings` by `KeyboardView`. Test:
`packages/code/tests/unit/keyboard-profile.test.ts` (`"a protected action cannot be the delayed
prefix of a manual sequence"`, `"a protected override cannot extend an unchanged effective
default"`).

### 3.6 The reserved `[key(s)] label` footer segment format

`actionSegment(action)` produces exactly `` `[${action.keys.join("/")}] ${action.footerLabel}` ``
(`packages/code/src/ui/patterns/active-actions.ts`, `actionSegment`) — e.g. `"[↵/super+o] list.open"`
(`packages/code/tests/unit/active-actions.test.ts`, "active action projection deduplicates alternatives by command identity"). This is the *only* place a segment is assembled;
key and label are never truncated independently, by the function's own doc comment
(`packages/code/src/ui/patterns/active-actions.ts`).

### 3.7 `PANEL_VERBS` — the panel-wide verb key/label table

`verb(name, run, when?)` (`packages/code/src/ui/patterns/level-keys.ts`) builds a `VerbSpec` from a fixed
`PanelVerbName` → key/label pair in `PANEL_VERBS` (`packages/code/src/ui/patterns/level-keys.ts`):

| `PanelVerbName` | Key | Label |
| --- | --- | --- |
| `add` | `a` | add |
| `delete` | `d` | delete |
| `rename` | `r` | rename |
| `clear` | `x` | clear |
| `refresh` | `ctrl+r` | refresh |

Pinned: `packages/code/tests/unit/keyspec.test.ts` (`verb("delete", ...)` yields key `d`; a gated
`verb("refresh", ..., () => false)` yields key `ctrl+r` and a `when` that reads `false`).

## 4. Behavior

### 4.1 `createInteraction` boot sequence

1. `createDefaultOpenTuiKeymap(renderer)` builds the base OpenTUI keymap (`packages/code/src/keys/interaction.ts`).
2. Window-close-gesture tracking is installed as two `intercept("key", …)` hooks at
   `priority: Number.MAX_SAFE_INTEGER - 1` — one on press, one on release
   (`packages/code/src/keys/interaction.ts`). See §4.3.
3. An unnamed-key guard is installed at `priority: Number.MAX_SAFE_INTEGER` (press and
   release) that recovers a bare Escape from its raw wire bytes (`U+001B` /
   `U+001B U+001B`) and consumes every other unnamed event before OpenTUI's strict
   resolver can throw on it (`packages/code/src/keys/interaction.ts`).
4. A `dispatch` diagnostic counter fires on every `binding-execute`/`binding-reject`,
   reading `event.command` as the string name or literally `"inline-handler"` when the
   fired binding's `cmd` was a bare function rather than a registered command name
   (`packages/code/src/keys/interaction.ts`).
5. Clarvis registers an exact-first disambiguation resolver plus four OpenTUI addons:
   Escape-clears-pending-sequence (`preventDefault:false` — a half-typed chord must still fall
   through to Back/Close), Backspace-pops-pending-sequence, base-layout fallback, and dead-binding
   warnings. If an active exact binding is also the prefix of a longer sequence, the exact command
   runs synchronously; there is no 300 ms Neovim-style timeout. Production:
   `registerImmediateExactDisambiguation` and `createInteraction` in
   `packages/code/src/keys/interaction.ts`.
6. An `interactionBlocked` intercept at max priority consumes every key except **unmodified** Escape
   while `effects.interactionBlocked?.()` is true (workspace replacement). The active view remains
   mounted and owns its local Escape route; modified Escape cannot dispatch a manually rebound
   modal-live command. A full-bleed portal surface simultaneously consumes pointer events before a
   retained picker or page row sees them. Production: the `offInteractionBlocker` intercept in
   `packages/code/src/keys/interaction.ts`, plus `consumePointerEvent` and the switching
   `SurfacePortal` in `packages/code/src/views/App.tsx`.
7. `registerWhenField`, `registerUiActionFields`, and a `modal` binding field (only the
   literal string `"none"` is a legal value) are registered (`packages/code/src/keys/interaction.ts`).
8. The keyboard environment is computed once from the platform/keymap host metadata
   (`keyboardInput`) and stamped into two signals (`packages/code/src/keys/interaction.ts`).
9. `overlay`/`autocomplete` context defaults are seeded (`"none"`, `false`) and `modal`
   is seeded `"none"` (`packages/code/src/keys/interaction.ts`).
10. A separate, larger command list — 16 entries on any platform but `win32` (15 there,
    since `app.suspend` is conditionally omitted, `packages/code/src/keys/interaction.ts`) — is constructed via
    `command(name, run, meta)`, which merges `ACTION_PROJECTION[name]` under any explicit
    `meta` and is registered, with **no bindings at all**, as one layer:
    `keymap.registerLayer({ commands })` (`packages/code/src/keys/interaction.ts`). This is not the same
    set as `DEFAULT_BINDING_CANDIDATES`: it omits `agent.picker`, `controls.open` and
    `plan.open` (which have no `command()` registration in this file — only key
    candidates) and adds `transcript.loadEarlier`, which has no entry in
    `DEFAULT_BINDING_CANDIDATES`/`DEFAULT_WHEN` at all. Because this layer carries no
    `bindings`, a command in it exists and is dispatchable by name through registered UI surfaces,
    yet has literally no key bound to it until `configureKeyboard` (step 11) installs the
    separate `LAYER.VITAL` layer that actually attaches keys — so declaration and binding
    are two independent `registerLayer` calls, and a command can be rebound or dropped by
    environment/profile change without ever re-registering its metadata.
11. `configureKeyboard(initialKeyboardConfig)` computes the effective environment, validates
    any stored manual overrides (silently discarding one that fails
    `keymap.parseKeySequence`), builds the vital-binding layer via `buildVitalBindings` +
    `resolvedVitalBindings`, and registers it at `LAYER.VITAL` (`packages/code/src/keys/interaction.ts`).
12. A `SIGCONT` listener resumes the platform; `registerUnresolvedCommandWarnings` is
    deferred one microtask so cross-feature bindings are assessed against the *complete*
    command registry once the app finishes composing feature commands
    (`packages/code/src/keys/interaction.ts`).
13. `renderer.once("destroy", dispose)` ties the whole wiring's teardown to renderer
    destruction (`packages/code/src/keys/interaction.ts`, `createInteraction.dispose`).

### 4.2 `configureKeyboard` re-resolution (called again whenever the environment or config changes)

1. Recompute `KeyboardEnvironmentInput` from the live platform/keymap and its id
   (`packages/code/src/keys/interaction.ts`).
2. Look up the saved `KeyboardEnvironmentConfig` for that id; `buildKeyboardEnvironment`
   folds it over the host-derived guesses (`packages/code/src/keys/interaction.ts`).
3. **Only** while `environment.profile === "manual"` are stored `bindings` even considered
   (`packages/code/src/keys/interaction.ts`) — a manual map stored under a different profile is presented in
   the UI as *stored but inactive* rather than applied (`packages/code/src/views/config/KeyboardView.tsx`,
   the `overridesActive` memo at `packages/code/src/views/config/KeyboardView.tsx`).
4. Each candidate override is filtered to commands that are either in
   `DEFAULT_BINDING_CANDIDATES` or currently registered, and re-parsed through
   `keymap.parseKeySequence`; a parse failure is silently dropped from *activation* (it
   stays visible in the Keyboard settings screen) (`packages/code/src/keys/interaction.ts`).
5. `buildVitalBindings(resolvedVitalBindings(...), DEFAULT_WHEN)` produces the vital
   layer; the previous vital layer is torn down first (`offVital?.()`), then the new one
   registered at `LAYER.VITAL` (`packages/code/src/keys/interaction.ts`).
6. Both keyboard signals are updated, and `keyboard.profile`/`keyboard.environment` are
   written into the keymap's own data store (readable by any binding's `when`)
   (`packages/code/src/keys/interaction.ts`).

### 4.3 The run-cancel repeat gesture

`trackWindowPress` runs on every key press at near-max priority
(`packages/code/src/keys/interaction.ts`). `windowOwnsKey` means
`overlayStack.length > 0 || modal !== "none"`.

| Condition | Effect |
| --- | --- |
| A cancel gesture is already open, the effective `run.cancel` binding matches, and OpenTUI marks the event `repeated === true` | `consume({preventDefault, stopPropagation})` and refresh the 1-second deadline |
| The same binding arrives within the deadline without repeat metadata | Treat it as a deliberate second press and dispatch it normally |
| The effective cancel binding arrives while a window or modal is open | Open a new `closingGesture` with `until = now + 1000ms`, then dispatch the global `run.cancel` command |
| Escape or any other key arrives | Never open or refresh a close gesture; dispatch immediately |

The guard prevents a held Ctrl+C from cancelling a run and then flowing into quit after the
run settles. Escape is deliberately outside the guard: every event is immediately available
to clear input or navigate one level, including rapid consecutive presses.
`releaseWindowGesture` clears a matching cancel gesture on key release. The comparison resolves the
current registered single-stroke `run.cancel` binding, so rebinding transfers repeat protection and
physical Ctrl+C no longer receives special treatment. Repeat ownership is pinned at
`packages/code/tests/integration/interaction.test.ts`; rapid Escape navigation is
pinned at `packages/code/tests/integration/app-shell-render.test.tsx`.

### 4.4 `registerLevel` — a level's key layer (nav/scroll, verbs, guards, escape)

| Step | What happens | Cite |
| --- | --- | --- |
| 1 | Build one binding + one `uiCommand` per `spec.verbs[]` entry; the command carries `enabled: v.when` when present. A verb with no explicit `id` gets a derived command id, `` `ui.level.${label.toLowerCase().replace(/[^a-z0-9]+/g,"-")}` ``, which keeps an ad hoc verb (not built via `verb()`) collision-free and addressable by `commandKeyLabel` | `packages/code/src/ui/patterns/level-keys.ts` |
| 2 | For every gated verb (`v.when` present), push a **second, no-op binding on the same key** (`{key, cmd: noop}`) | `packages/code/src/ui/patterns/level-keys.ts` |
| 3 | For every name in `spec.guards`, push a no-op binding | `packages/code/src/ui/patterns/level-keys.ts` |
| 4a | If `spec.nav`: delegate to `registerListNav`, passing the verb bindings/commands as `extra`/`extraCommands` | `packages/code/src/ui/patterns/level-keys.ts` |
| 4b | Else if `spec.scroll`: delegate to `registerScrollKeys`, reserving whichever of the verb keys are strings | `packages/code/src/ui/patterns/level-keys.ts` |
| 4c | Else if there are any bindings at all: register them directly as one layer | `packages/code/src/ui/patterns/level-keys.ts` |
| 5 | If `spec.scroll` **and** there are bindings, register the verb layer *again* (so verbs still bind alongside scroll keys) | `packages/code/src/ui/patterns/level-keys.ts` |
| 6 | If `spec.escape.run`: register only `{key:"escape", cmd:"ui.level.escape"}` at `max(priority, LAYER.OVERLAY+1)`; Ctrl+C stays with the global `run.cancel` command | `packages/code/src/ui/patterns/level-keys.ts` |

Step 2's no-op binding is load-bearing, not decorative: a *disabled* command binding lets
its key fall through to a lower layer or the focused input; the no-op absorbs it instead
— e.g. Doctor's `q` on a hard-required gate must do nothing, not reach the prompt
underneath (`packages/code/src/ui/patterns/level-keys.ts`).

### 4.5 `registerListNav` activation gating

The `ui.list.activate` command's `enabled` predicate reads `opts.count()` **under
`untrack`** (`packages/code/src/ui/patterns/list-navigation.ts`) — a deliberate, load-bearing choice: the keymap
evaluates `enabled` while resolving its own state, so a reactive read there would
subscribe the projection to whatever the predicate touches, and a filtered list's count
changing on every keystroke could recursively queue the state change that caused the next evaluation
(`packages/code/src/ui/patterns/list-navigation.ts`, `ListNavOptions.activate`). Pinned: `packages/code/tests/unit/list-navigation-gate.test.ts`.

### 4.6 `budgetFooterActions` — the footer's width budget

1. Filter to actions carrying `"footer"` in `surfaces`
   (`packages/code/src/ui/patterns/active-actions.ts`, `budgetFooterActions`).
2. `limit = tierLimit(width)` — a count cap only: `≥100→10`, `≥72→4`, `≥48→3`, otherwise `2`
   (`packages/code/src/ui/patterns/active-actions.ts`, `tierLimit`). There is no special Help seat or
   reservation.
3. Sort remaining candidates by **importance** (`byImportance`): essential-vs-not first;
   among essentials, by declared `hintPriority`; among non-essentials, by the reading-order
   comparator (group → priority → title) (`packages/code/src/ui/patterns/active-actions.ts`,
   `byImportance`, `byReadingOrder`).
4. Greedily admit candidates in that order while `selected.length < candidateLimit` **and**
   the whole candidate set, resorted to **reading order**, fits within `width - 2` cells
   (`packages/code/src/ui/patterns/active-actions.ts`, `budgetFooterActions`).
5. Re-sort the final selected set to reading order and return it
   (`packages/code/src/ui/patterns/active-actions.ts`, `budgetFooterActions`).

Both orderings are load-bearing per the file's own remarks: importance-order admission is
what keeps a confirmation's `confirm.accept`/`confirm.cancel` pair seated together even
though `confirm.cancel` sits in the low-reading-order `escape` group
(`packages/code/src/ui/patterns/active-actions.ts`, `budgetFooterActions`; pinned by
`packages/code/tests/unit/active-actions.test.ts`, "a confirmation keeps both of its verbs at every
width the footer paints"); every seat — essentials included — is width-checked, which is what stops
a wide essential set from painting past the container's edge (pinned by the same test file,
"footer budgeting never overflows its width, even when every action is essential").

### 4.7 `createMapEditor` level lifecycle

`open(spec)` records `baseDepth = level.depth()+1` and, in one Solid `batch`, sets the
spec/path/index signals and pushes the level (`packages/code/src/ui/patterns/map-editor.tsx`) — batching is
required because outside a batch the reconciling effect runs while `path` is updated but
depth is still stale, truncating the very path being extended
(`packages/code/src/ui/patterns/map-editor.tsx`). The editor has **no explicit `close`**: Escape belongs to the
host shell and only decrements level depth, so a reactive effect derives editor state from
that depth — falling below the depth it opened at clears the whole spec (persisting a
pruned write first); falling back by exactly one level pops one path segment
(`packages/code/src/ui/patterns/map-editor.tsx`). `persist` is a no-op when the serialized next value equals the
serialized current one, so merely visiting and leaving an unchanged map writes nothing
(`packages/code/src/ui/patterns/map-editor.tsx`; pinned `packages/code/tests/unit/map-editor.test.ts`). `pruneEmpty`
removes an emptied object only at the two edges where "empty" can only mean "leftover" —
removing an entry, and closing the editor — never inside `persist` itself, because a
suggestion whose template is `{}` must be stageable and drillable
(`packages/code/src/ui/patterns/map-editor.tsx`).

#### 4.7b The rest of `map-editor.tsx`'s exported helpers

- `isMapNode(value)` returns `true` only for a non-null, non-array object — an array is
  deliberately not drillable, because a drill level is keyed by name and an array's
  members are keyed by position, so treating `["a","b"]` as a two-row map would silently
  make the index part of the data (`packages/code/src/ui/patterns/map-editor.tsx`; pinned
  `packages/code/tests/unit/map-editor.test.ts`).
- `updateAt(root, path, mutate)` copies the object at every ancestor on the way down to
  `path`, never the input, so a staged map handed to a Solid signal is a genuinely new
  object at every level the edit touches — a mutation in place would leave the signal's
  identity unchanged and the rows stale (`packages/code/src/ui/patterns/map-editor.tsx`).
- `formatMapValue(value, kind)` summarizes an object value by its key count (`"{ 2 keys }"`)
  rather than serializing it, because the row is one line and drilling in is the way to
  see it (`packages/code/src/ui/patterns/map-editor.tsx`; pinned `packages/code/tests/unit/map-editor.test.ts`).
- `parseMapValue(text)` tries `JSON.parse` first and falls back to the raw text only when
  it carries no character in `JSON_PUNCTUATION` (`["'{}[\]:,\\]`) at all — most scalar
  body fields are enumerated strings (`sort: throughput`), and demanding a quoted
  `"throughput"` for each one turns the commonest edit into a JSON quiz. A half-written
  `["a` or `{x: 1` still fails loudly rather than being silently reinterpreted as text
  (`packages/code/src/ui/patterns/map-editor.tsx`; pinned `packages/code/tests/unit/map-editor.test.ts`).
- A duplicate key is refused with a notice and writes nothing (pinned
  `packages/code/tests/unit/map-editor.test.ts`); a rename onto an existing key is refused the same
  way; a rename otherwise keeps the entry **in place** rather than moving it to
  the end; removing the last entry of an object writes `undefined` for it (or, if
  it is the root, the whole map), dropping the enclosing key rather than leaving `{}`
  behind.

### 4.8 `KeyboardView` states

`KeyboardView` composes three modes over one `ViewHost` level, chosen by two local
signals (`diagnostic`, `bindingMode`):

| State | `nav` count/index | Verbs (key→label) | `escape` |
| --- | --- | --- | --- |
| Keyboard Profile list (default) | `PROFILES.length` / `selected` | `b`→manual bindings, `d`→diagnostic, `c`→client convention, `x`→reset automatic | `run: host.close()` |
| manual bindings (`bindingMode()`) | `stableCommands().length` / `bindingIndex` | (none) | `run: closeBindings` (pops one level, clears `bindingMode`) |
| diagnostic (`diagnostic()`) | its own `registerLayer` at `LAYER.CONFIRM+10`, not a `LevelSpec` | `u`→mark unavailable, `s`→save (enabled only once `done()`) | `escape`/`ctrl+c` → `onClose` |

`bindLevelKeys({register, editor, suspend})` suspends the level-list registration
whenever `bindingMode()` **or** `diagnostic()` is true, so the diagnostic's own layer
(registered separately at `LAYER.CONFIRM+10`, above `LAYER.MODAL`) never competes with it
(`packages/code/src/views/config/KeyboardView.tsx`).

The profile-list row's own state is more than nav/verbs/escape: `profileState(profile)`
labels each row `"Active"` (matches the live environment), `"Recommended"` (matches
`recommendedProfile()` — `kitty` protocol and local transport), else for a
non-`"enhanced"` profile `"Available"`, else (for `"enhanced"`) `"Unavailable: modified
keys are intercepted"` if any modifier verdict is `"unsupported"`, `"Run diagnostic to
verify modified keys"` if the protocol is `"legacy"`, else `"Available"`
(`packages/code/src/views/config/KeyboardView.tsx`). The manual-bindings sublevel's `stableCommands()` filters
`keymap.getCommands({visibility:"registered"})` to entries whose `uiSurfaces` include
`"full-help"` and whose name does **not** match
`/^(ui\.|confirm\.|editor\.|autocomplete\.|elicit\.)/` — internal/editor-only commands
never appear as editable bindings (`packages/code/src/views/config/KeyboardView.tsx`). `cycleClient()` rotates
the stored `clientPlatform` through `undefined → "macos" → "windows" → "linux" →
undefined` (`packages/code/src/views/config/KeyboardView.tsx`). `editBinding()` splits the entered text on `,`,
trims and drops empty entries, validates each against `keymap.parseKeySequence`
(collecting failures as `invalidKeys`), normalizes each parsed key's display form for
shadow and protected-prefix comparison, then folds the whole edit through `applyManualBindingEdit` before
writing or deleting the `bindings` map entry (`packages/code/src/views/config/KeyboardView.tsx`). Pinned:
`packages/code/tests/integration/keyboard-view-render.test.tsx` ("selects profiles, cycles the
client convention, and resets") ("manual bindings shows stable commands...").

`KeyboardDiagnostic` runs 4 probes in sequence (`ctrl+k`, `alt/option+k`, `super/cmd+k`,
"layout-stable K") (`packages/code/src/views/config/KeyboardView.tsx`); each keypress is intercepted at
`LAYER.CONFIRM+20`, `ctx.consume()`d unconditionally so no destination opens underneath,
and recorded as `"supported"` only if it matches the probe (`packages/code/src/views/config/KeyboardView.tsx`).
`save()` recommends `enhanced` only if the protocol is `kitty` **and** no verdict is
`"unsupported"`; if the environment's stored profile is already `manual`, the
recommendation is computed but **not applied** — only the verdicts are merged in, so a
user's authored overrides are never silently switched off by running the diagnostic
(`packages/code/src/views/config/KeyboardView.tsx`).

### 4.9 `registerListNav` and `registerScrollKeys` — the full key schemes

`registerListNav(keymap, opts)` (`packages/code/src/ui/patterns/list-navigation.ts`) binds: `up`/`down`
to previous/next; `k`/`j` to the same, unless `opts.letters === false`; `pageup`/`pagedown`
to page-previous/page-next; `home`/`end` to first/last; `return` to `ui.list.activate`
when `opts.activate` is given; `tab` to `ui.list.next` **unless** `"tab"` already appears
(case-insensitively) among `opts.extra`'s keys, in which case Tab is left to whatever
`extra` binds it to; and finally any `opts.extra` bindings themselves, appended last.

`registerScrollKeys(keymap, scroll, priority?, reservedKeys?)`
(`packages/code/src/ui/patterns/list-navigation.ts`) binds the parallel but distinct scheme: `up`/`k`
to scroll up, `down`/`j` to scroll down, `pageup`/`pagedown` to page up/down, and `tab` to
`ui.scroll.pageDown` **unless** `"tab"` appears in `reservedKeys`. The two functions
diverge on what Tab does when not reserved — next-item in nav mode, page-down in scroll
mode — and both make that divergence suppressible through their own reserved-keys
mechanism (`opts.extra`'s keys for nav, `reservedKeys` for scroll).

Both helpers also accept an OpenTUI `ReactiveMatcher` lifecycle gate and pass it to the registered
layer without evaluating it during construction. `registerLevel` adapts its `LevelSpec.enabled`
accessor through `reactiveMatcherFromSignal` and shares the matcher across its navigation, verb and
Escape sublayers. A retained surface can therefore keep one structural registration while becoming
unreachable immediately when its active signal turns false
(`packages/code/src/ui/patterns/{level-keys,list-navigation}.ts`; pinned by
`packages/code/tests/integration/list-picker-render.test.tsx` and
`packages/code/tests/unit/keyspec.test.ts`).

### 4.10 `projectActiveActions` — deduplication and client-gated glyphs

`projectActiveActions(keys, client?)` (`packages/code/src/ui/patterns/active-actions.ts`) walks the
keymap's active keys and keeps only those whose `key.command` is a **string** — an
inline-function binding (such as a level's own Ctrl+C, §4.4 step 6) has no string command
and is invisible to this projection by construction — and whose `commandAttrs.uiSurfaces`
is non-empty. Entries sharing a command name are merged into one `ActiveAction`, folding
every alternate key spelling into its `keys` array rather than producing a duplicate row
(pinned: `packages/code/tests/unit/active-actions.test.ts`, "deduplicates alternatives by command
identity"). Each key's label passes through `compactKey(key.display, {clientPlatform:
client})`, which renders `super`/`meta`/`option` differently only when `client` is the
explicit literal `"macos"` — the default (`client` undefined) renders the portable
spelling instead (pinned: `packages/code/tests/unit/active-actions.test.ts`, "presents Option and
Cmd only for an explicit Mac client").

### 4.11 From the live keymap to the rendered footer text

`NavigationBar` (`packages/code/src/ui/patterns/navigation-bar.tsx`) is the live wiring the rest of
this document's mechanisms feed: `useActiveActions` (`packages/code/src/ui/patterns/navigation-bar.tsx`) reads
`keymap.getActiveKeys({ includeBindings: true, includeMetadata: true })` through
`useKeymapSelector` (a reactive subscription), pipes the result through
`projectActiveActions`, then through
`budgetFooterActions` for the current width, and joins the surviving actions with
`actionSegment` into one text node. `InteractionNavigationBar`
(`packages/code/src/ui/patterns/navigation-bar.tsx`) is the self-contained wrapper `ViewFrame` and others mount:
it renders **nothing** (`null as never`) when the supplied `interaction.keymap` lacks a
`getActiveKeys` function — the guard that keeps a test double without a real keymap from
throwing here.

### 4.12 `ViewFrame`'s own action filter and badge states

`ViewFrame` (`packages/code/src/ui/patterns/view-frame.tsx`) always mounts
`InteractionNavigationBar` with an `actionFilter` that unconditionally excludes
`run.cancel` (`action.id !== "run.cancel"`) ahead of any filter the caller supplies — a
level's own footer never re-advertises the global cancel action. Its title row shows one
of four mutually exclusive states, in order: the scope badge (default), `"Read-only" +
readOnlyReason` when `props.readOnly` or `props.mode === "read-only"`, `"Monitor"` when
`props.mode === "monitor"`, or no badge at all when `props.unscoped` is true
(`packages/code/src/ui/patterns/view-frame.tsx`).

### 4.13 `bindLevelKeys` — stable lifecycle suppression

Beyond the one call-site example in §4.8, `bindLevelKeys` combines four conditions into one reactive
gate — `opts.editor.editing() === null`, `opts.host.pendingConfirm() === null`,
`opts.host.active()`, and `!opts.suspend?.()` — then supplies that accessor to the caller's
`register` function. Every configuration/onboarding caller installs it as `LevelSpec.enabled`, so
activation, editing, confirmation and picker suspension disable the existing OpenTUI layer instead
of allocating a replacement. Signals read while constructing a structurally different level spec
still rerun the owning effect, unregister the previous structure first and register the new one;
owner cleanup unregisters the final layer (`packages/code/src/ui/patterns/bind-level-keys.ts`,
`bindLevelKeys`; pinned by `packages/code/tests/unit/level-keys.test.ts`).

### 4.14 `LevelHost`'s active-level selection

`LevelHost` (`packages/code/src/ui/patterns/level-host.tsx`) selects the active `LevelView` as the
first one in `props.levels` whose own `when()` returns true; failing that, the one whose
index equals the host's current depth. A `when`-matched level can therefore win out of
depth order — used to show a different body at the same depth once some local screen
state changes — while every level without a `when` falls back to being addressed purely
by position. Pinned: `packages/code/tests/integration/level-host-render.test.tsx` ("a when-matched
level ... wins over the depth default"), which also exercises the one-`ViewFrame`-per-depth
render and the single `CatalogPicker` mount driven by the host's own picker signal
(`packages/code/tests/integration/level-host-render.test.tsx`).

### 4.15 `Footer`'s navigation-suppression precedence, and `HintToast`

`Footer` shows its `navigation` prop only when **both** the current hint text is empty
**and** `props.compact?.()` is false (`packages/code/src/views/Footer.tsx`) — a live hint or compact
mode silently hides every action the keymap projection generated, so a screen that hints
frequently or renders compact never shows its footer's action segments at that moment.
`HintToast` (`packages/code/src/views/Footer.tsx`) is a second, independent copy of the hint line,
absolutely positioned above the float layer (`zIndex: FLOAT_Z + 1`): it exists because a
floating overlay's full-bleed scrim otherwise paints over the in-flow footer, so a
`notify()` raised while a picker or other overlay is open would land on a buried row.

The composer owns one additional exclusivity rule for the row above it. `InputDock` reports
`onPopupOpenChange`; while slash autocomplete is open, `App.inputPopupOpen` removes
`LeadActivityLine` so the menu replaces that band instead of stacking with `ready`, `thinking` or
`working`. When visible during a run, the activity line owns phase, elapsed time, iteration and
the active `run.cancel` binding (`Ctrl+C` by default) to interrupt. A hosted run with confirmed
continuation also displays `continues after exit` before the elapsed detail; this is presentation
of host policy, not a grant or another key binding. The canonical footer is deliberately stable across that lifecycle: it keeps
Context plus cumulative Session token totals/cost before and after settlement and never repeats
`Running`, elapsed time or iteration. Production: `packages/code/src/views/InputDock.tsx`
(`onPopupOpenChange`), `packages/code/src/views/App.tsx` (`inputPopupOpen`, `leadActivityDetail`,
`footerRunStrip`) and `packages/code/src/features/run/status-presenter.ts` (`runStripText`). Tests:
`packages/code/tests/integration/app-shell-render.test.tsx` ("autocomplete replaces the Lead activity
row instead of stacking ready or working above it" and "an active run seats its live metadata beside
working and keeps the session footer stable") and `packages/code/tests/unit/run-status.test.ts` ("the
run strip keeps cumulative session tokens before and after a run settles").

### 4.16 `SelectableList`'s error/loading/empty precedence

`SelectableList` (`packages/code/src/ui/patterns/selectable-list.tsx`) renders its three status rows
independently rather than as a single switch, but their conditions compose into a fixed
precedence: the error banner shows whenever `props.error?.()` is truthy, regardless of
list contents; the loading hint shows only when the list is empty, there is no error, and
`props.loading?.()` is true; the empty hint shows only when the list is empty, there is
no error, loading is **not** true, and an `empty` projection was supplied. A non-empty
list always renders its scrollbox, independent of an error or loading state coexisting
above it.

## 5. Invariants

**INV-254.** No source file anywhere under `packages/code/src/` contains the obsolete
navigation-label identifiers `defaultKeyHint`, `PANEL_KEY_LEGEND`, `hintLine(`, or
`scrollHint(` — navigation labels have no legacy static source of truth left.
Production: n/a (a negative/absence invariant — the whole `src/` tree is the subject).
Test: `packages/code/tests/architecture/tui-navigation-boundary.test.ts`.

**INV-255.** Every ordinary screen — every source file **except**
`views/FatalBoot.tsx`, `views/config/KeyboardView.tsx`, and `keys/keyspec.ts` — is free
of a hand-embedded bracketed shortcut instruction (a `[esc]`/`[enter]`/`[ctrl+x]`-shaped
hint followed by an action verb, or a literal `glyph("return")` reference). Navigation
hints are generated from the live keymap (§4.6, `active-actions.ts`), never hand-written
per screen. The three exemptions are principled: `FatalBoot` runs before the shared
keymap exists; `KeyboardView`'s diagnostic probe labels (`"Press Ctrl+K"`, etc.,
`packages/code/src/views/config/KeyboardView.tsx`) are *inputs under test*, not navigation instructions; `keyspec.ts`
is the one file that legitimately declares the prompt-editing chord table
(`PROMPT_EDITING_KEYS`, `packages/code/src/keys/keyspec.ts`), consumed by `InputDock`.
Test: `packages/code/tests/architecture/tui-navigation-boundary.test.ts`.

**INV-256.** `views/Footer.tsx`, `views/PageFrame.tsx` and `ui/patterns/view-frame.tsx`
declare the action-projection props (`navigation?: JSX.Element` on `Footer`
— `packages/code/src/views/Footer.tsx`; `interaction: Interaction` on `PageFrame` — confirmed at
`packages/code/src/views/PageFrame.tsx`; `InteractionNavigationBar` used inside `ViewFrame` —
`packages/code/src/ui/patterns/view-frame.tsx`) and none of the old static key-hint props (`keyHint?:`,
`hint?: string`, `footer: string`). Test:
`packages/code/tests/architecture/tui-navigation-boundary.test.ts`.

**INV-257.** A window-local `{ key: "escape", cmd: ... }` binding must not be paired
with a local `{ key: "ctrl+c", cmd: ... }`: Escape belongs to the current screen's clear/back
action, while Ctrl+C remains exclusively bound to global `run.cancel`. Directly witnessed
inside this document's scope at `packages/code/src/ui/patterns/level-keys.ts` and
`packages/code/src/views/config/KeyboardView.tsx`. The repository-wide architecture
test scans every source file so overlays, editors, confirmations and mounted views cannot
reintroduce a local Ctrl+C owner.
Test: `packages/code/tests/architecture/tui-navigation-boundary.test.ts`.

### Further invariants derived directly from the code in this document's scope

**INV-D1.** A command whose every `BindingCandidate` requires `minimumProfile:"enhanced"`
and the active Keyboard Profile is `"portable"` has **no key binding at all** —
`resolveCommandBindings` returns `[]` for it and `resolvedVitalBindings` omits it from the
output map. Such actions retain an equivalent mouse, slash, hub, or other portable route.
Production: `packages/code/src/keys/interaction.ts` (`DEFAULT_BINDING_CANDIDATES`),
`packages/code/src/keys/keyboard-profile.ts` (`resolveCommandBindings`).

**INV-D2.** A protected action (`app.escape`, `run.cancel`) can be **rebound** but
never explicitly **unbound**: an empty `keys` array for either action in `validateManualBindings` always reports `"protected action
cannot be unbound"`. Production: `packages/code/src/keys/keyboard-profile.ts`. Test:
`packages/code/tests/unit/keyboard-profile.test.ts`.

**INV-D3.** A manual-binding shadow or protected-prefix check is refused independently of persisted
map order. `applyManualBindingEdit` examines both `KeyboardBindingIssue.command` and `shadows`, so a
conflict remains actionable whether the protected or ordinary command was visited second. Exact
protected defaults are the fallback validation baseline; the Keyboard screen supplies every
effective profile default, including unchanged ordinary commands. Production:
`packages/code/src/keys/keyboard-profile.ts` (`validateManualBindings`, `applyManualBindingEdit`) and
`packages/code/src/views/config/KeyboardView.tsx` (`editBinding`). Test:
`packages/code/tests/unit/keyboard-profile.test.ts` (`"protected prefix conflicts are refused in
either persisted binding order"`, `"a protected override cannot extend an unchanged effective
default"`).

A protected action also cannot be one exact side of a strict-prefix ambiguity. This applies in both
directions, after alias normalization, and across manual/effective-default ownership: neither
`escape x` beside `app.escape:escape` nor a protected multi-stroke override beside an unchanged or
manual exact prefix can be saved. Production:
`validateManualBindings` (`strictPrefix`, `ownedSequences`) in
`packages/code/src/keys/keyboard-profile.ts`. Test:
`packages/code/tests/unit/keyboard-profile.test.ts` ("a protected action cannot be the delayed
prefix of a manual sequence").

**INV-D4.** The shadowing comparison is over a **canonical** key spelling, not a raw
lower-cased string: `esc` and `escape` (and every pair in `KEY_ALIASES`) must compare
equal, or an ordinary command can take a protected action's key by spelling it the other
way. Production: `packages/code/src/keys/keyboard-profile.ts`. Test:
`packages/code/tests/unit/keyboard-profile.test.ts`.

**INV-D5.** Stored manual `bindings` apply **only** while the environment's stored
`profile` is exactly `"manual"`; under any other profile they are inert, and the UI must
present them as *stored but inactive* rather than *active*. Production:
`packages/code/src/keys/interaction.ts` (`configureKeyboard`'s override loop reads
`saved?.bindings` only inside the ternary's `"manual"` branch);
`packages/code/src/views/config/KeyboardView.tsx` (`overridesActive` memo). Test:
`packages/code/tests/integration/keyboard-view-render.test.tsx` (both the
"presented as active only under manual" and "marked off under another profile" cases).

**INV-D6.** `keyboardEnvironmentId` never hashes the terminal's version, only its name —
a version bump must produce the same id. Production: `packages/code/src/keys/keyboard-profile.ts`. Test:
`packages/code/tests/unit/keyboard-profile.test.ts`.

**INV-D7.** A gated verb's key is never left dangling: whenever `spec.verbs[]` contains an
entry with `when`, `registerLevel` binds the same key twice — once to the (conditionally
enabled) command, once to a no-op — so a disabled verb's key is absorbed rather than
falling through to whatever is layered beneath. Production: `packages/code/src/ui/patterns/level-keys.ts`.
Test: unpinned directly (no test asserts the no-op fallback binding exists); the general
`registerLevel` behavior is exercised at `packages/code/tests/unit/keyspec.test.ts` but does not
cover a gated verb specifically.

**INV-D8.** `registerListNav`'s `ui.list.activate` command is enabled only when the list
is non-empty (and, if given, its own `when` also holds) — an empty list never advertises
an activation route that would do nothing on Enter. Production:
`packages/code/src/ui/patterns/list-navigation.ts`. Test:
`packages/code/tests/unit/list-navigation-gate.test.ts`.

**INV-D9.** Help has no keyboard action or reserved footer segment. F1 is unassigned by
the built-in keymap and remains available for a manual binding; `/help` is the sole Help entry route.
Production: `packages/code/src/keys/interaction.ts` (`DEFAULT_BINDING_CANDIDATES`,
`createInteraction`), `packages/code/src/app/commands.tsx` (`help.open`). Tests:
`packages/code/tests/integration/interaction.test.ts` ("F1 has no built-in action"),
`packages/code/tests/unit/keyboard-profile.test.ts` ("protected keys are refused by every spelling,
and F1 remains available"), and `packages/code/tests/integration/app-shell-render.test.tsx`
("/help opens the full Help screen and returns to the same shell").

**INV-D10.** `LAYER.TRANSIENT` must exceed `LAYER.OVERLAY + 1` (the priority
`registerLevel` lifts a level's escape sublayer to) and must stay below `LAYER.MODAL`.
Production: `packages/code/src/keys/keyspec.ts`. Test: `packages/code/tests/unit/keyspec.test.ts`.

**INV-D11.** Every Escape event dispatches immediately and never enters the 1-second
Ctrl+C repeat guard. Exact-versus-prefix ambiguity resolves to the exact action synchronously, so
even an active `escape x` sequence cannot add a timer to Back/Close. `Providers -> Settings ->
Transcript` therefore completes with two immediate presses, and Escape can never fall through into
run cancellation or quit because those effects are absent from `app.escape` and all local Escape
handlers. Popping a configuration child back to its parent also must not start a sandbox host probe
or subscription entitlement check: those remain Doctor's explicit recheck and the Sandbox settings
surface. Production: `registerImmediateExactDisambiguation`, `trackWindowPress`, and the
`offInteractionBlocker` intercept plus `app.escape` command in
`packages/code/src/keys/interaction.ts`; `popView` in
`packages/code/src/views/overlay-host.ts`. Tests:
`packages/code/tests/integration/interaction.test.ts` ("an exact action beats a longer prefix
synchronously" and "a workspace replacement blocks commands but keeps window Escape live") and
rapid semantic navigation plus the active-view switching case in
`packages/code/tests/integration/app-shell-render.test.tsx`.

**INV-D12.** The root `app.escape` command resolves in strict order: dismiss the top overlay,
clear transcript-block focus, then clear any composer text (including whitespace) or staged
attachments and emit `"Draft cleared"`. If nothing needs clearing, Escape is a
no-op; it never calls run cancellation or quit. Conversely, global `run.cancel` on Ctrl+C first
cancels an active run and otherwise enters the quit gate without clearing the draft, and remains
active while overlays and elicitation modals are open.
Production: `packages/code/src/keys/interaction.ts`; the complete draft predicate and
clear effect are wired at `packages/code/src/views/App.tsx`.
Tests: `packages/code/tests/integration/interaction.test.ts`; full-shell paths are
pinned at `packages/code/tests/integration/app-shell-render.test.tsx`.

**INV-D13.** `Ctrl+S` and `Ctrl+G` are the portable bindings for the internal `isolation.picker` and
`review.picker` actions; `Alt+S` and `Alt+G` are their enhanced-path accelerators. All four are
inactive while another overlay is open. On a macOS client the enhanced bindings are presented as
Option and require the terminal to deliver Option as Meta/Esc+; the Ctrl routes require no terminal
configuration. `Ctrl+E` belongs only to expanding or collapsing the Task editor, so `Ctrl+G` never
changes editor state. The renderer keeps Kitty keyboard reporting in its conservative mode and
never requests all-key escape reports, so terminal-native dead-key and IME text composition remains
intact. A literal `ß` remains composer text.
No global physical sidebar binding exists; `/activity`
and `/activity [plan|workflow|agents]` are contextual slash actions. The first live Plan, first
workflow leader and first visible sub-agent each own an independent automatic
reveal once per execution for Plan, Parallel work and Agents. Closing the surface is sticky for
later updates of the intent that opened it, while the first event for another section may still
reveal it. Escape only suppresses that repeated automatic reveal: `/activity` can reopen any
available section explicitly. The bounded agent/workflow footer strip remains a pointer reopen route,
whose split or drawer presentation is determined by the viewport; Plan never contributes footer
text.

Production: `packages/code/src/keys/interaction.ts` (`DEFAULT_BINDING_CANDIDATES`, `DEFAULT_WHEN`),
`packages/code/src/adapters/renderer-bootstrap.ts` (`buildRendererConfig`),
`packages/code/src/views/config/KeyboardView.tsx` (`PROBES`, `KeyboardDiagnostic`),
`packages/code/src/app/commands.tsx` (`isolation.picker`, `review.picker`),
`packages/code/src/views/InputDock.tsx` (`prompt.editor.open`, `prompt.editor.close`),
`packages/code/src/app/layout.ts` (`createLayoutController`), and
`packages/code/src/views/App.tsx` (`requestAutomaticSidebar`, `visiblePlanContext`,
`visibleSubagentContext`, `closeActivitySidebar`, `openActivitySidebar`, the `activity.open` command
and `compactActivityStrip`). Tests:
`packages/code/tests/integration/interaction.test.ts`,
`packages/code/tests/integration/app-shell-render.test.tsx`,
`packages/code/tests/integration/platform-lifecycle.test.ts`,
`packages/code/tests/integration/input-dock-submit.test.tsx` (typed Portuguese accents),
`packages/code/tests/integration/keyboard-view-render.test.tsx`, and
`packages/code/tests/unit/layout.test.ts`.

**INV-D14.** Input callbacks already queued while OpenTUI destroys the renderer are inert. The
Clarvis-owned keymap host checks the renderer lifecycle immediately before forwarding press,
release, or raw input, so a listener snapshot cannot dispatch into a destroyed keymap host.
Production: `packages/code/src/keys/interaction.ts` (`createLifecycleSafeKeymap`). Test:
`packages/code/tests/integration/interaction.test.ts` ("queued input is inert after the renderer
destroys its keymap host").

**INV-D15.** Unmodified Return and numpad Enter submit the composer; Ctrl+J inserts a newline on
every keyboard profile, while Shift+Return does so only on the Enhanced profile. Portable does not
register the shifted chord when its transport may erase the modifier. The displayed Shift+Return
label retains its modifier even after
an already-compact `shift+↵` label is formatted again. Every accepted explicit model submission —
ordinary submit, steer, MCP prompt or skill — made while reading older history or a selected child
first returns selection and scroll ownership to the current Lead tail. Background transcript,
delegation, Plan and Workflow events never perform that navigation.
Production: `packages/code/src/keys/keyspec.ts` (`PROMPT_EDITING_KEYS`, `compactKey`) and
`packages/code/src/views/InputDock.tsx` (`promptHandlers`) and
`packages/code/src/views/App.tsx` (`submitFromLeadTail`). Tests:
`packages/code/tests/unit/keyspec.test.ts` (`PROMPT_EDITING_KEYS`, compact-label idempotence),
`packages/code/tests/integration/help-render.test.tsx` (newline label), and
`packages/code/tests/integration/input-dock-submit.test.tsx` (Enhanced Shift+Enter and Ctrl+J,
plus portable Ctrl+J-only registration) and
`packages/code/tests/integration/app-shell-render.test.tsx` ("normal submit and steer return an old
reader to the Lead tail while background events do not", "model-backed prompt and skill submit also
return an old reader to the Lead tail", and "returning from a child sidebar transcript restores the
live Lead frontier").

## 6. Failure modes and degradation

| Situation | Handling | Cite |
| --- | --- | --- |
| Terminal, SSH path or multiplexer erases Shift from Return | Portable profile does not register or advertise Shift+Return because the resulting packet is indistinguishable from submit; Ctrl+J remains the newline chord. Enhanced can register Shift+Return only after its capability probe succeeds | `packages/code/src/keys/keyspec.ts` (`PromptKeyRow.enhancedKeys`), `packages/code/src/views/InputDock.tsx` (profile-gated textarea bindings), and `packages/code/tests/integration/input-dock-submit.test.tsx` |
| A manual override's key fails `keymap.parseKeySequence` | Silently excluded from the *active* vital-binding layer; remains visible (as a stored, inactive entry) in Keyboard settings | `packages/code/src/keys/interaction.ts` |
| A hand-edited manual sequence extends an active exact binding | The exact command runs synchronously and the longer sequence is unreachable in that context; the Keyboard editor refuses protected-prefix conflicts before persistence | `registerImmediateExactDisambiguation` in `packages/code/src/keys/interaction.ts`; `validateManualBindings` in `packages/code/src/keys/keyboard-profile.ts`; tests `packages/code/tests/integration/interaction.test.ts` and `packages/code/tests/unit/keyboard-profile.test.ts` |
| A stale manual-binding entry names a command no longer registered (e.g. an MCP prompt whose server left `settings.json`) | Reported as `"unknown command"` **only if the edited command itself**; does not block clearing or editing any other entry | `packages/code/src/keys/keyboard-profile.ts`; test `packages/code/tests/unit/keyboard-profile.test.ts` |
| A `when` clause names an unrecognized `ContextKey`, is empty, or uses unsupported grammar | `parseWhen`/`compileWhen` throw synchronously — a fail-closed error, not a silently-ignored clause | `packages/code/src/keys/when-dsl.ts` |
| A command-field or binding-field value has the wrong shape (`uiSurfaces` not an array of strings, `hintPriority` not a finite number, `essential` not boolean, `modal` not the literal `"none"`) | Throws synchronously at registration time | `packages/code/src/keys/actions.ts`, `packages/code/src/keys/interaction.ts` |
| A command's `enabled` predicate throws while `entries()` computes `canAct` | Caught; a diagnostic counter fires (`command.enabled.threw`); `canAct()` **fails open** (`true`) — a broken predicate leaves the command reachable rather than hiding its slash route | `packages/code/src/keys/commands.ts`; test `packages/code/tests/unit/commands.test.ts` |
| An action/view `run()` throws synchronously, or its returned promise rejects | Funnelled into `ui.commandFailed(name, error)` either way — never an unhandled rejection | `packages/code/src/keys/commands.ts`; test `packages/code/tests/unit/commands.test.ts` |
| A duplicate command name, or a slash token another command already owns, is registered | Throws immediately (`register`/`registerAction` roll back the partially-inserted registry entry before rethrowing) | `packages/code/src/keys/commands.ts`; test `packages/code/tests/unit/commands.test.ts` |
| A key event arrives with an empty `name` (observed as parser residue after Escape closes a view) | Recovered as `escape` if the raw wire bytes are exactly `U+001B`/`U+001B U+001B`; every other unnamed event is consumed before OpenTUI's strict resolver can throw on it | `packages/code/src/keys/interaction.ts`; test `packages/code/tests/integration/interaction.test.ts` |
| A press, release, or raw-input callback was queued before renderer teardown and runs after the host is destroyed | The lifecycle-safe OpenTUI host drops it before keymap dispatch; teardown emits no `Cannot use a keymap after its host was destroyed` error | `packages/code/src/keys/interaction.ts` (`createLifecycleSafeKeymap`); test `packages/code/tests/integration/interaction.test.ts` ("queued input is inert after the renderer destroys its keymap host") |
| The workspace runtime is being replaced (`effects.interactionBlocked?.()===true`) | Every key except unmodified Escape is consumed at max intercept priority, including a modified Escape rebound to a modal-live command; a nearly transparent full-bleed portal consumes mouse and scroll input while the mounted page or picker stays visible, and plain Escape can still navigate the active view immediately | `offInteractionBlocker` in `packages/code/src/keys/interaction.ts`; `consumePointerEvent` and the switching `SurfacePortal` in `packages/code/src/views/App.tsx`; tests in `packages/code/tests/integration/interaction.test.ts` and `packages/code/tests/integration/app-shell-render.test.tsx` |
| A pending elicitation modal (`setModalContext("elicitation")`) | Every vital binding **except** `MODAL_LIVE_COMMANDS` (`run.cancel`, `app.suspend`, the four `transcript.scroll*`) is inert; those six stay live (read-only navigation and escape hatches only) | `packages/code/src/keys/interaction.ts` (`MODAL_LIVE_COMMANDS`, `buildVitalBindings`); test `packages/code/tests/integration/interaction.test.ts` ("a pending modal keeps scrolling, suspend and cancel, and withholds the rest") |
| An overlay is on the stack | The 11 `overlay==none` commands in `DEFAULT_WHEN` go dark. On the `plan` overlay only, `plan.open` remains active: the same shortcut closes current-plan detail and returns to the transcript. There is no history-origin route. `app.escape`, `run.cancel` and `app.suspend` have no overlay gate, so the cancel binding still cancels the run or enters quit. | `packages/code/src/keys/interaction.ts` (`DEFAULT_WHEN`), `packages/code/src/views/overlays/PlanOverlay.tsx` (`plan.escape`); tests `packages/code/tests/integration/interaction.test.ts` and `packages/code/tests/integration/app-shell-render.test.tsx` |
| `normalizeKeyboardConfig` is handed malformed/future JSON (wrong version, non-object environments, junk verdicts) | Tolerantly degrades: unrecognized top-level shape → empty config; a malformed per-environment entry is skipped entirely; unrecognized verdict/binding entries inside an otherwise-valid entry are dropped individually | `packages/code/src/keys/keyboard-profile.ts`; test `packages/code/tests/unit/keyboard-profile.test.ts` (`normalizeKeyboardConfig tolerates future and malformed UI data`) |
| `app.suspend` on `win32` | The command is not registered at all (no `SIGTSTP`/job control to return from), and its binding candidate is skipped by `resolvedVitalBindings` so the keymap's own dead-binding warning never fires on an orphaned key | `packages/code/src/keys/interaction.ts`; test `packages/code/tests/integration/interaction.test.ts` |

## 7. Coupling

### 7.1 What this subsystem depends on

| Dependency | Why | Direction |
| --- | --- | --- |
| `@opentui/keymap` (+ `/opentui`, `/addons`, `/addons/opentui`, `/solid`) | The entire binding/layer/command/context machinery this document wires — `Keymap`, `Command`, `Binding`, `ActiveKey`, `BindingFieldContext`, addons | static value import, external package (`packages/code/src/keys/interaction.ts`, `packages/code/src/ui/patterns/navigation-bar.tsx`) |
| `@opentui/core` | `KeyEvent`, `Renderable`, `ScrollBoxRenderable`, `CliRenderer` types throughout | static, mostly type-only |
| `solid-js` | `createSignal`/`createEffect`/`createMemo`/`batch`/reactivity primitives | static value import |
| `../adapters/platform.ts` (`Platform`) | suspend/resume/capabilities probing feeding `keyboardInput` | static, type + value (`packages/code/src/keys/interaction.ts`) — **out of this document's scope** |
| `../theme/{tokens,glyphs,tone}.ts` | `ViewFrame`'s rendering | static value import — **out of scope**, delegated to [hosts/code-theme.md](code-theme.md) |
| `../core/fuzzy.ts`, `../core/diagnostic-events.ts` | `commands.ts` entry filtering and failure/diagnostic counters | static value import — **out of scope** |
| `../ui/primitives/index.ts` (`ScopeBadge`, `SelectableRow`, `EmptyHint`, `ErrorBanner`, `LoadingHint`) | rendering rows/badges in `view-frame.tsx`, `selectable-list.tsx`, `map-editor.tsx` | static value import — **out of scope**, delegated to [hosts/code-theme.md](code-theme.md) |
| `../views/hint.ts`'s `NoticeTone` (by shape only) | `map-editor.tsx`'s `NoticeTone` type is declared **structurally identical** to `HintTone`, not imported — `packages/code/src/ui/patterns/map-editor.tsx` says "matches `views/hint.ts`'s `HintTone`" in a comment only | **no runtime or type edge** — deliberate, see §8 |

### 7.2 What forces `ui/patterns/**` to stay decoupled from `views/`

`ui/patterns/map-editor.tsx`'s own doc comment states the constraint explicitly: "written
against the *structure* of a field editor and a level stack rather than against
`views/config`, both because `src/ui/**` may not import `views/`" (`packages/code/src/ui/patterns/map-editor.tsx`).
`packages/code/tests/architecture/architecture-boundary.test.ts` enforces that `edgesUnder("ui")`
never imports `@clarvis/kernel`, `adapters/`, or `features/` — but **does not itself list
`views` as forbidden for the `ui` layer** (only for `adapters`, at
`packages/code/tests/architecture/architecture-boundary.test.ts`). In the actual tree no `ui/**` file imports
`views/**` (`grep` over `src/ui/` for `from "../views` / `from "../../views` returns
nothing), so the comment's stronger claim currently holds in practice, but it is **not
directly test-enforced for the `ui` layer** — see §8. `MapFieldEditor`, `NoticeTone`, and
`MapLevelStack` in `map-editor.tsx` are exactly the structural interfaces that let
`views/config/field-editor.tsx`'s `FieldEditor` and `ViewHost`'s level stack satisfy the
contract **by shape** without either module importing the other.

### 7.3 What imports this subsystem

| Consumer (outside this document's scope) | What it takes | Owning sibling document |
| --- | --- | --- |
| `views/App.tsx` | `createInteraction`, `GROUP_LABEL`/`GROUP_ORDER`/`isTopLevelCommand` from `command-groups.ts` | [hosts/code-bootstrap.md](code-bootstrap.md) |
| `views/PageFrame.tsx` | `interaction: Interaction` prop (confirmed at `packages/code/src/views/PageFrame.tsx`) | [hosts/code-bootstrap.md](code-bootstrap.md) |
| `views/InputDock.tsx`, `ElicitBlock.tsx`, `confirm.ts`, `field-editor.tsx`, `overlay-host.ts`, `overlays/PlanOverlay.tsx` | their own local `{key:"escape",cmd}` clear/back bindings; none claims Ctrl+C, following `packages/code/src/ui/patterns/level-keys.ts` | [hosts/code-input-and-overlays.md](code-input-and-overlays.md), [hosts/code-bootstrap.md](code-bootstrap.md), [hosts/code-settings-panels.md](code-settings-panels.md), [capabilities/plan-capability.md](../capabilities/plan-capability.md), [cross-cutting/elicitation.md](../cross-cutting/elicitation.md) (per file) |
| Every settings/hub screen (`views/config/**`) | `ViewHost`, `bindLevelKeys`, `registerLevel`, `LevelSpec`, `verb`, `SelectableList`, `ViewFrame` | [hosts/code-settings-panels.md](code-settings-panels.md), [hosts/code-domain-hubs.md](code-domain-hubs.md) |

### 7.4 What forces the direction, not just convention

- `ui/patterns/level-host.tsx` and `ui/patterns/view-frame.tsx` import `type { ViewHost }`
  from `../../keys/commands.ts` (`packages/code/src/ui/patterns/level-host.tsx`, `packages/code/src/ui/patterns/view-frame.tsx`) — a
  **type-only** edge from `ui/patterns` to `keys/`, so `ui/patterns` cannot be built or
  typechecked without `keys/commands.ts` existing, but no value crosses at runtime beyond
  what the caller supplies.
- `ui/patterns/level-keys.ts` and `ui/patterns/list-navigation.ts` both import `LAYER` and
  `uiCommand` as **values** from `../../keys/keyspec.ts` and `../../keys/actions.ts`
  respectively — a genuine runtime dependency of `ui/patterns` on `keys/`.
- `keys/interaction.ts` imports `type { Platform }` from `../adapters/platform.ts` — the
  reverse direction would be a cycle (`adapters/` sits below `keys/` in the layer test);
  `packages/code/tests/architecture/architecture-boundary.test.ts` enforces `adapters` never importing `ui`/`views`,
  which combined with `keys` importing only `type Platform` keeps the graph acyclic.
- `tui-navigation-boundary.test.ts` is what forces INV-254 through INV-257 to hold across
  the **whole** `src/` tree, not just this document's files — a violation anywhere (including
  in a sibling document's screen) fails this test, so the boundary is repo-wide even though the
  mechanism (`registerLevel`, `active-actions.ts`) lives entirely in this document's scope.

## 8. Open questions

- ~~**`adapters/keys.ts` is a scope/naming mismatch.**~~ **Resolved by renaming the file.** Its
  content (`KeySource`, `keyOrigin`, `KeysAdapter`, `createKeysAdapter`) is the provider-secret cache
  used by the Providers panel and touches nothing in `@opentui/keymap`, `keys/**` or `ui/patterns/**`
  — it was listed under keyboard-and-navigation only because it shared a word. It is now
  `packages/code/src/adapters/provider-secrets.ts`, with a module comment recording that a "key" there
  is a credential and never a keystroke, and its unit test moved with it
  (`packages/code/tests/unit/provider-secrets.test.ts`). It remains out of scope for this document.

- **`keys/command-groups.ts` has no dedicated unit test.** `GROUP_ORDER`, `GROUP_LABEL`,
  and `isTopLevelCommand` are exercised only transitively through `views/App.tsx` integration tests,
  outside this document's file set
  — no `tests/unit/command-groups.test.ts` (or similarly named file) exists anywhere in the
  package.

- **The "`ui/` may not import `views/`" rule is a comment, not a test assertion for the
  `ui` layer.** `packages/code/src/ui/patterns/map-editor.tsx` states it in prose; `architecture-boundary.test.ts`'s
  `ui`-layer check (`packages/code/tests/architecture/architecture-boundary.test.ts`) only forbids
  `@clarvis/kernel`, `adapters`, and `features` — `views` is checked as a forbidden target
  only for the **`adapters`** layer (`packages/code/tests/architecture/architecture-boundary.test.ts`), not for `ui`.
  In the current tree no `ui/**` file actually imports `views/**`, so the stronger claim
  holds in practice, but nothing would fail the build if it stopped holding. This is an
  unpinned invariant, distinct from — and narrower coverage than — the four INV-254–257
  rules this document does own.

- **INV-D7 (gated verb's key absorbed by a same-key no-op binding) has no direct test.**
  `tests/unit/keyspec.test.ts` exercises `registerLevel` for escape-priority, scroll-vs-nav
  precedence, and the `verb()` helper itself, but no test constructs a `LevelSpec` with a
  gated verb and asserts the second no-op binding is present or that pressing the key while
  disabled does nothing observable.

- **Whether `ui/patterns/index.ts`'s `export *` surface is deliberately narrower than
  `keys/**`'s is not stated anywhere.** `index.ts` re-exports everything from
  `level-keys.ts` and `list-navigation.ts` (which themselves re-export several `keyspec.ts`
  symbols) but does not re-export `active-actions.ts`, `navigation-bar.tsx`, or
  `bind-level-keys.ts`'s `EditingState` type — each of those is imported directly by its
  consumers rather than through the barrel (e.g. `view-frame.tsx` imports
  `active-actions.ts`'s `ActiveAction` type directly rather than via `index.ts`). The code
  does not say whether this asymmetry is intentional API surface curation or incidental.

- **The exact terminal/SSH compatibility measurements** (which real terminal emulators
  report Kitty-protocol support, which multiplexers pass modifiers through, etc.) that
  presumably informed `defaultKeyboardProfile`'s "local Kitty only" default are not present
  in this subsystem's code or tests — delegated, per the document's own instruction, to
  [cross-cutting/build-and-ci.md](../cross-cutting/build-and-ci.md).

- **What `views/config/field-editor.tsx`'s `FieldEditor` and `create-view-host.ts`'s
  `ViewHost` construction actually do** (beyond satisfying `MapFieldEditor` and
  `ViewHost`'s structural shapes) is out of this document's scope; only the shapes those
  modules must satisfy to compose with `ui/patterns/**` are covered here.
