# `@clarvis/code`

The flagship Clarvis terminal UI. It runs the agent stack in process through
`@clarvis/kernel` and renders runs with SolidJS and OpenTUI.

The UI programs against the `@clarvis/protocol` service contract, so the same
shell can run against a remote kernel later without a client change.

Its three workspace dependencies are `@clarvis/kernel`, `@clarvis/protocol` and
`@clarvis/paths` — the last only to locate the workspace and global roots before a
kernel exists to ask. It never reaches the engine directly.

The kernel API is intentionally segmented: the root is reserved for central services/errors, and
`bootstrap`, `config`, `policy`, and `local` enter only through the application root, bootstrap, or
Code-owned adapters. Core, generic UI, Views, feature controllers, onboarding, commands, and the run
host do not import Kernel directly. Architecture tests scan source and tests, enforce those internal
boundaries, and derive Code's exact workspace-package allowlist from the central role policy.

> Private, unversioned workspace. The root manifest owns the Clarvis product version; this
> application is not published independently.

## Contract

The TUI contract is divided across the focused `code-*` specs in the
[`hosts` map](../../specs/README.md#hosts--the-kernel-the-terminal-ui-and-the-http-facade): bootstrap,
performance, run hosting, transcript projection, input/overlays, domain hubs, settings panels,
keyboard policy, theme, and onboarding. The performance contract and dated measurement review live
in [`code-performance.md`](../../specs/hosts/code-performance.md). Image entry and the vision pre-pass are specified in
[`engine/vision-routing.md`](../../specs/engine/vision-routing.md).

## Requirements

- Bun 1.4.0 or newer.
- A real terminal.
- A configured Clarvis workspace or global configuration.

Install workspace dependencies from the monorepo root:

```bash
bun install
```

Then launch the UI:

```bash
bun --filter @clarvis/code start
```

To install the optimized command globally from this checkout:

```bash
bun --filter @clarvis/code setup
clarvis
```

For end users, the public installers in the repository root download portable artifacts from the
binary-only [`getclarvis/clarvis-releases`](https://github.com/getclarvis/clarvis-releases)
repository. A portable archive includes the exact Bun runtime, the map-free split artifact, its
package-owned assets, and the native OpenTUI closure for one of six targets: GNU/glibc Linux, macOS,
or Windows on x64 or arm64. Alpine and other musl-only Linux distributions are not portable-release
targets for this beta. Runtime dependency discovery accepts only installed bare package specifiers;
relative, absolute, built-in, and module-internal `#` references retained by the generated artifact
are not interpreted as package roots, while package subpaths resolve to their owning root.
`release.json` declares the exact regular-file set checked by release smoke and self-update.
Each archive also carries Clarvis's license; the Bun, models.dev, and Vercel AI SDK notices/license
texts; Bun's source and relinking route; a generated runtime-package inventory; and the
package-owned license files.
The installer also verifies the release-level `SHA256SUMS`, confirms that the staged CLI reports the
requested version, stores it under `versions/v<version>`, and writes `current` only after every
earlier step succeeds. Both root installers print the target, resolved destination, and numbered
download, verification, staging, and activation phases. `install.sh --uninstall` and
`install.ps1 -Uninstall` authenticate the installer-owned marker (or the complete legacy managed
layout), share the updater's mutation lock through launcher and Windows `PATH` cleanup, and remove
only managed application files. POSIX launcher ownership is bound to the selected install root;
linked managed directories and non-file activation/marker destinations are refused. Cancellation
stops the operation, repeated removal is a successful no-op, and Clarvis configuration,
credentials, sessions, and workspace data remain untouched.

`clarvis --update` is an explicit managed-install operation. It reads the bounded public GitHub
release index from `getclarvis/clarvis-releases`, selects only a newer version allowed by the current
channel, requires GitHub's `sha256:` asset digest and exact target-specific URL, verifies the
internal manifest, smokes the staged runtime, preserves the previous version, and activates the
candidate last. It performs no automatic update check at ordinary startup and refuses source or
`bun link` installations.

The current directory is the workspace Clarvis operates on. To run against
another project, start the binary from that directory or use the installed
`clarvis` command there.

## Configuration

The app uses a file-backed kernel. Workspace configuration lives under
`.clarvis`, typically:

```text
.clarvis/
├── settings.json
├── guard-judge.md       # optional: the prompt that answers command prompts for you
├── memory-policy.md     # optional: what this project wants recorded
├── agents/              # optional: one file per agent you add or customize
│   └── ...
└── workflows/           # optional: one directory per workflow you add or replace
    └── <name>/WORKFLOW.md
```

`agents/` and `workflows/` start empty and stay empty unless you put something there. The five agents
Clarvis ships — `marshall`, `admiral`, `coder`, `explorer`, `planner`, in that order — are data inside
`@clarvis/kernel`, not files copied onto your machine. The `audit`, `implement` and `research`
workflows are TypeScript definitions inside `@clarvis/workflows`. A valid workspace workflow document
replaces a same-named global or built-in definition; a valid global document replaces a same-named
built-in. See [`@clarvis/workflows`](../workflows/README.md#built-ins-and-workflow-documents) for the
complete document contract.

The onboarding and configuration views can configure providers and secrets, select models, manage
memory, inspect MCP tool servers, and manage extensions. `/extensions` is the only public extension
route. It uses the same guided decision pattern as first boot: choose workspace/global selection
scope, choose or stage an Environment, search exact plugin and standalone-skill inventory, review
every resulting agent/skill/MCP/hook/executable contribution, then apply one preview-bound delta and
reconnect. Each decision exposes one key per outcome: Enter advances or applies and Escape finishes
the multi-select or walks back, asking before an edited draft is discarded. Install, exact
resolution and Apply use the shared footer-right spinner, show elapsed time, advance through their
real host phases and suspend local actions until the operation settles. Large catalogs use bounded
retained rows, review bodies scroll independently from their decisions, and the optional splash
disappears on compact terminals. Internal Environments, Plugins and MCP children remain available
from that home and return to it with Escape; they are not nested slash commands. `/tasks` remains a
standalone workspace surface.
Capability services display their effective argv and packaged per-skill Plans policy in the
plugin/provider panels, and start only when selected.

The Plugins child includes `https://github.com/getclarvis/marketplace.git` as a built-in source
before any configured or discovered catalog. Its retained collection bar moves with left/right
through All, Installed, each exact marketplace URL, Workspace, and Add Marketplace; up/down moves
through plugins and `/` searches only the current collection. Enter opens a dedicated detail with
source, lifecycle, capabilities, executables and active Environment state. The built-in URL is not
written to settings, and loading its listings does not install or activate a plugin. A second Enter
on an available detail is one composed consent: install the complete plugin, select its exact ref in
the current Environment, reconnect, and verify it remains active after reload. Hooks are part of
that atomic plugin unit and have no independent approval screen. Update and uninstall are guarded at
the idle boundary. Workspace-owned checkouts are edited in their repository, and linked external
checkouts remain visible and activatable but never offer the managed update action. Environment selects
only already-installed extensions. The guided flow obtains the complete exact
inventory from `EnvironmentService.inventory()` and commits a definition plus local selection only
through `previewComposition`/`applyComposition`; a changed definition, selection document, or
resolved contribution invalidates the review before either write. Its immutable `builtin:default` uses exact
`enabledPlugins` refs and four-root skill behavior; custom Environments are complete allow-lists of
exact `{ scope, source, name }` plugins and standalone skills. `.agents/plugins` and
`.clarvis/plugins` participate equally; the install picker defaults to the shared `.agents` global
inventory. Definitions may be shared from `.clarvis/environments`, but the active workspace
selection is always local machine state. The Environment browser shows resolution status, routes
creation/customization into the guided composer, retains direct selection/clear diagnostics, and
can revision-safely delete an inactive custom definition. A process-local `--env`
keeps persisted selection controls read-only. A failed Environment catalog reload remains visible
inside the browser, with `r` retry, instead of surviving only as a transient footer notification. See
[`hosts/environments.md`](../../specs/hosts/environments.md) for activation semantics and
[`hosts/code-extensions.md`](../../specs/hosts/code-extensions.md) for the interactive catalog and
lifecycle experience.
Interactive Code and local `--print` kernels also provide the operating-system browser opener used
by remote MCP OAuth. The authorization coordinator still validates the destination and loopback
callback; this adapter grants only the host action of opening the already validated URL. Remote
kernel clients and server hosts do not inherit that local authority.
After onboarding, `/model` is the only surface that changes `default_model`, and `/effort` is the
only surface that changes its `default_reasoning_effort`. They write only their own setting in the
selected global/workspace scope. Providers owns credentials and the available-model set, while
Settings > Defaults owns vision and budget defaults; none can overwrite the model/effort choice.
Those user defaults are authoritative for the run's Lead even when its selected agent profile
declares another model or effort. A spawned Sub-agent keeps the model and effort explicitly
declared by its own profile, falling back to the user defaults only when it declares none.
Settings > Defaults shows the effective host token default when no settings layer declares one; it
does not label the run unlimited while the kernel still applies its environment fallback.
Editing a shipped agent in `/settings` → agents writes a **customization**, not a copy: only the
fields you changed reach `agents/<name>.md`, and everything else keeps following the shipped
default. Deleting that file is offered as a reset — the shipped agent comes back. A shipped agent
cannot be renamed or deleted; fork it under a new name instead. If a customization's frontmatter
does not parse or does not validate, Clarvis runs the shipped agent unchanged and Doctor reports
which file was refused and why.

Every interactive cold boot first paints a parser-free Clarvis shell in the same Solid root the
application will use. Its boot-only slash header and composer placeholder, slash wordmark and moving
shared spinner preserve the final screen's visual structure while the workspace foundation loads;
the usable `App` replaces it in place without waiting for the models catalogue or Markdown parsers.
The boot copy intentionally excludes the complete app's `◆ Clarvis` paint marker and `New task…`
readiness marker, so release smoke and first-paint measurements cannot accept the placeholder shell.

On the first interactive launch, startup opens a branded Clarvis setup rather than Doctor or an
empty conversation. Enter begins the focused provider/model picker; the flow makes the selected
model the default and asks for its credential without ever rendering the secret. After saving,
Clarvis seeds its ordinary planning, memory and command-review defaults, reloads the live profile
catalogue, selects `marshall`, and shows one Ready screen. No agent or workflow file is written at
any point; the default fleet and workflow catalogue are built into the kernel. Canceling either picker returns to setup with the
staged choice unsaved. Opening `/settings/providers` later keeps the ordinary multi-provider and
multi-model editor.
The complete eight-row Clarvis splash stays visible from Welcome through both the provider and model
pickers when the terminal is at least 76 columns by 24 rows. That shared threshold accounts for the
narrower floating card and preserves at least three useful catalog rows. Below it, first-run setup
omits the splash entirely and gives the space back to the picker.
Manual model entry preserves provider-native ids, including tagged local-server ids such as
`qwen2.5-coder:7b`; the resulting default reference keeps the provider name before the first `/`.
The Providers module and the single-flight models catalogue are loaded concurrently only after a
provider surface is requested, and that surface waits for both before mounting. This preserves the
deferred first paint while ensuring an auto-opened first-run picker cannot freeze in the reduced
subscription/manual branch. A failed bootstrap save stays mounted; **Ctrl+S** retries the same
selected model and staged credential through the completion path.

The same guided picker presents ChatGPT and Grok subscription rows. Their public-client registrations
are enabled by an explicit project-owner product decision; this records Clarvis's choice to use the
public protocol references, not provider endorsement. Each starts a cancellable device flow, keeps
the public URL/code only in the mounted view, then loads that account's entitled catalog and writes
the ordinary global provider/model shape. Both subscriptions may remain connected at once, and
different agent profiles may select either provider. Subscription detail omits API-key, base-URL,
header and body fields and instead offers connect, reauthenticate, or confirmed disconnect.
Its `add models` action reloads the authenticated entitled catalog instead of falling back to the
public models.dev provider-name picker.
Personal subscriptions can be configured only in global scope. Workspace provider screens keep the
rows visible for discovery but refuse activation and direct the operator to switch scope.
Entitled model setup retains the provider-published reasoning levels in the ordinary model entry, so
`/effort` can configure a supported subscription effort after the picker closes or Clarvis restarts.
For an older configured subscription model without that metadata, `/effort` loads the authenticated
entitled catalog on demand instead of borrowing a same-named model from the public catalog. While
that request is pending the panel says it is loading; it reports unpublished effort levels only
after the request settles without metadata.
Browser opening remains an explicit user action; copy/manual opening always remains available. Copy
and browser actions animate in place while their platform adapters are pending, then leave visible
`✓ Copied to clipboard` or `✓ Browser opened` confirmations in the device-login picker before
restoring the ordinary row. See
[`subscription-providers.md`](../../specs/hosts/subscription-providers.md).

A previously configured but damaged installation opens the branded Repair Clarvis screen instead.
It presents the first run-blocking condition and one primary repair route; Doctor remains the manual
full diagnostic available at `/doctor`, where optional recommendations are distinct from blockers.
Cold boot does not probe host sandbox toolchains: that inspection may run several bounded
`--version` subprocesses and is not needed to route setup or repair. An explicit Doctor recheck
performs it for the header and readiness gates; opening Settings > Sandbox performs its own
panel-local inspection. Durable memory-queue recovery is likewise released only after
`app.boot.painted`, so stale indexing work cannot delay the first usable application frame.

`/agent` separates the current session agent from persistent defaults. `Enter` changes only the
current session. `S` first asks whether the selected agent should be the global default or a
workspace override, and `X` in that scope chooser removes only the selected layer. Workspace wins
over global when both are set. Its list follows the same presentation order as Settings > Agents:
the shipped fleet order above, then custom agents by name. On startup, an explicit valid default is respected; otherwise `code`
chooses a runnable `marshall`, then the first runnable Lead in presentation order. A headless/sub-agent
persona is never selected merely because its file was listed first. If neither safe fallback exists,
the TUI opens the agent picker and headless mode requires `--agent` or a configured default.

The settings adapter is backed exclusively by `KernelClient.config`. It keeps a
cached `SettingsView`, but does not open or parse the source paths the kernel
returns for display. When Doctor finds corrupt settings, it asynchronously asks
the kernel for a revision-bound strip/reset preview, confirms that exact plan
with the user, then applies it through `repairSettings`. A concurrent edit is a
`conflict`, is shown as a repair failure, and is never overwritten.

### Interactive memory fuse

`clarvis code` samples its own RSS every 500 ms. The interactive TUI warns at 80% of a 2 GiB
default limit and, at the limit, cancels active work and blocks new model/tool submissions while
leaving the process, transcript navigation, explicit transcript clearing and quit controls alive. Export is blocked
after the fuse trips because constructing a large document is itself memory-intensive. The
controller stops waiting after a 10-second abort grace even when a non-cooperative run still reports
itself active; `/recover-memory` can then rebuild the backend instead of leaving the TUI permanently
stuck in `aborting`. The sampler covers the TUI process RSS, not arbitrary external MCP/shell process
trees, so host-level monitoring remains appropriate for untrusted external services. The banner and
`/recover-memory` rebuild the backend through the normal reconnect path. A non-cooperative rebuild
returns control to the TUI after 10 seconds and remains one physical attempt; a late success enters
the ordinary cooling gate instead of starting a second backend beside it. The fuse rearms only after
three samples below 70%. Recovery never clears the transcript automatically, so `/clear` remains an
explicit user choice. Every model-start path, including `Work on task`, rechecks the fuse immediately
before dispatch. Positive custom limits have a 512 MiB floor, preventing a recovery threshold below
the measured healthy baseline. A separate efficiency advisory observes a 20-sample slope and requires
both 512 MiB absolute RSS and 256 MiB growth from the process baseline; it records evidence but never
cancels work or runs GC.

Recovery uses synchronous `Bun.gc(true)` only after the backend reconnects and every physical run
handle and local process has settled. Forced visual detachment does not release that physical lease.
If work is still settling, recovery skips collection and records `memory.gc.skipped`; it never queues
an asynchronous collection that could overlap the next run. Every ten seconds and at memory state
changes, debug mode records one aggregate `memory.ledger` containing transcript/session bytes,
renderable ownership, physical handles, and protocol event-queue counters.

Set `CLARVIS_TUI_RSS_LIMIT_MB` to another MiB value, or `0` to disable this interactive-only guard.
It is not installed in the server, print mode or embeddable kernel.

The OpenTUI console overlay is disabled in ordinary runs, so hidden diagnostic
logs do not accumulate behind the interface. `CLARVIS_CODE_DEV=1` enables the
overlay and its cache together with the existing developer error surface.

Prompt history is likewise a bounded convenience cache: at most 1,000 entries, 1 million
characters per entry and 8 million resident characters. Startup reads only the newest 8 MiB of its
JSONL file and compacts an older oversized file in the background. A custom guard-judge prompt is
limited to 1 MiB and an oversized override safely falls through to the next scope.

### Navigation and keyboard environments

Every interactive behavior is a named OpenTUI command. Its binding, enabled state, label and
description are projected from that one registration into the current footer and full Help screen;
screens must not maintain a second shortcut legend. `/help` is the sole Help entry route. It opens a
lazy full-page reference containing actions available here and elsewhere, destinations, input
syntax, editing commands and the effective terminal path. F1 has no built-in action or reserved
footer segment. Slash commands and configuration hubs remain the searchable routes to destinations
and actions.

`Ctrl+S` opens the canonical safety-preset picker on every keyboard profile; `Alt+S` remains an
enhanced-path accelerator. In a direct iTerm session on macOS, Clarvis requests Kitty's all-key and
associated-text reports so Option+S remains identifiable even when the profile leaves Option in its
normal text-producing mode. iTerm's standalone modifier-state packets are consumed before OpenTUI
can misread their numeric payload as control text. Other terminal paths still need to deliver Option
as Meta/Esc+ for the enhanced accelerator; a literal `ß` from a legacy path remains ordinary text,
while `Ctrl+S` keeps the picker reachable. The picker is loaded on first use, retained after that
first mount, and reuses the same preset application policy as Run controls. There is no
sidebar-toggle command: activity appears automatically as a wide split when it has content, while
compact layouts open the activity drawer from the visible activity strip and close it with Escape.

Scrollable collections use shared ownership patterns rather than page-local windowing code.
`ListPicker` owns filterable modal lists, `SelectableList` owns scroll-following page lists, and
`StableWindowedList` owns bounded windows with a fixed retained row pool for high-churn surfaces.
Autocomplete uses that stable-window primitive as one continuously scrolling viewport: selection
moves the visible rows without changing the popup frame or inserting `N more` rows. The slash-command provider
also reuses its command catalog and bare-slash row projection until registration, keyboard
environment or dynamic eligibility actually changes; typing and deleting `/` does not rebuild the
complete command graph each time.

Configuration destinations form a mounted page stack. Opening a child keeps its parent selection,
scroll position, open editor and staged draft intact but inactive. Escape has one immediate job:
clear the active composer input, close an editor/local detail, or return to the exact parent screen;
at the root with nothing to clear it does nothing. Escape never enters a repeat timeout, cancels a
run or quits. Ctrl+C is the exclusive keyboard route for cancellation and shutdown: it cancels an
active run from any screen, otherwise enters the existing double-Ctrl+C quit gate without clearing
the draft. Window-local layers never claim Ctrl+C. Input callbacks already queued during renderer
teardown are discarded at the keymap host boundary, so a final macOS terminal packet cannot dispatch
through an OpenTUI host after it has been destroyed.

The Workflows tree follows the same contextual-action contract. Rows show the persisted short task
title rather than the first line of the full prompt. `Enter` opens the selected node's result; `T`
appears only for a leader whose complete task is available and opens that task on a separate detail
page. The manager and legacy records without a persisted task do not advertise or bind `T`.

When a current plan is available, `Ctrl+P` is the portable route to its full detail and `Alt+P`
remains an enhanced alternative. Retained completed, failed and canceled plans stay reachable as
the latest plan; a removed plan advertises neither shortcut. A directly opened detail returns to
the run when the same plan shortcut is pressed again or on Escape; a detail entered from `/plans`
returns to history first. Ctrl+C leaves the plan screen open and cancels the active run (or enters
quit when no run is active). The sidebar separates the plan title, lifecycle, task states, active
task and last result with explicit labels and an active-row surface, so progress is not encoded by
colour alone. Planning policy uses a separate,
hierarchical command: `/planning/review` requires approval and `/planning/normal` restores normal
execution for the next run. Execution memory has no global quick toggle:
the next-run/session choice belongs to Run controls, while persistent configuration belongs to
Settings > Memory.

Keyboard policy is scoped to an opaque terminal-path identifier in the global `code.json`. Local
Kitty sessions default to the enhanced profile; SSH, multiplexed legacy and unknown paths default to
portable behavior. A remote server's operating system is never presented as the user's client OS.
Settings > Keyboard can select portable/enhanced/manual behavior, set the client-side modifier
convention and override any stable named action. Protected Help, back and cancel
actions may be rebound but not left empty. Keyless actions are labelled `no shortcut`; the removed
command palette is not presented as a fallback route. The same normalized-event diagnostic is reachable from
Doctor; it stores only capability verdicts and never raw escape sequences, hostnames, addresses or
typed text.

### The command guard, and answering it automatically

Before a shell command runs, the guard rules on it. Its mode lives in
`settings.json` and defaults to `on`:

```json
{
  "guard": {
    "mode": "on",
    "denied_commands": ["rm -rf /*", "git push --force*"],
    "allowed_commands": ["bun test", "git status"]
  }
}
```

- **`off`** — no ruling at all.
- **`on`** (default) — an `ask` verdict becomes a confirmation prompt for you.
- **`auto`** — an LLM answers each `ask` instead of interrupting you.

After a guarded shell call settles, its transcript header states the durable
verdict and answerer, for example `auto-guard approved · judge` or
`auto-guard denied · judge`. The same annotation is included in Markdown export
and survives reopening the run. When consecutive shell calls collapse into a
`shell ×N` group, every visible member signature retains its own verdict and
answerer; a denied member is not hidden by the group's collapsed error body.
Denied signatures are prioritized ahead of ordinary signatures when the six-row group cap applies.

Changing the guard mode or choosing a named safety preset preserves the effective
`allowed_commands` and `denied_commands`, including when a workspace preset inherits the global
policy. A preset changes execution posture; it does not erase the command policy.

The six selectable presets are `free`, `judged`, `approval`, `isolated`, `reviewed`, and
`protected`. `judged` runs directly on the host without a native sandbox boundary while the LLM judge
reviews risky commands; if no judge can resolve a decision, execution falls back to asking the user.
Because `free` and `judged` remove the sandbox boundary, the quick picker requires an explicit danger
confirmation before applying either posture.

A **deny** is enforced before any of this, in every mode; `denied_commands` wins
over `allowed_commands`. An entry without `*` is a space-boundary prefix over the
normalized command; an entry with `*` is an anchored glob. Turning the guard off
is a persisted choice — write `"mode": "off"` rather than deleting the block, or
it comes back on the next boot.

**`auto` needs a prompt, and that prompt is `guard-judge.md`.** Without one, a
run in `auto` behaves exactly like `on`, which is why setting the mode alone can
look like nothing happened. `code` resolves it from two places:

| file                           | scope                |
| ------------------------------ | -------------------- |
| `<ws>/.clarvis/guard-judge.md` | this project         |
| `~/.clarvis/guard-judge.md`    | you, every workspace |

Unlike `memory-policy.md`, these **do not concatenate**: the workspace file wins
whole, then the global one, then a built-in default. A judging prompt is one
complete instruction, so two of them would be two rulings for one verdict. A file
that exists but is blank counts as absent and falls through to the next scope.

It is plain prose — no frontmatter, no schema. Write the standing rules you would
apply yourself:

```markdown
Approve read-only inspection freely: status, log, diff, ls, cat, test runs.

Ask me about anything that pushes, publishes, deletes outside the working tree,
or edits files under `infra/`.

Never approve a command that pipes a network fetch into a shell.
```

The built-in policy does not receive the surrounding conversation. When a command's safety depends
on whether you authorized a destructive workspace operation — for example `git restore`, `git reset`,
`git clean`, checkout-over-files or broad deletion — it answers `unsure`, which opens the command
approval prompt for you. It does not guess at missing authorization. An explicit deny-list match or
ordinary sandboxed workspace escape is still rejected before the model reviewer and cannot be
appealed through it. The argv-only `host_vcs` fallback is deliberately different: it exists for an
operation the sandbox cannot perform and may name any host executable. The built-in judge therefore
treats it as privileged host execution and evaluates its exact executable, arguments, paths,
credentials, and host-side effects instead of assuming sandbox containment.

`~/.clarvis` is `$CLARVIS_HOME` when that is set.

## CLI modes

The flags below mirror the declarative table in `src/cli-args.ts` (the same
table drives parsing and `--help`; a test keeps this section in sync). An
unknown flag prints a usage error to stderr and exits 1 — it never boots the
TUI.

`--help` and `--version` are answered by the launcher before the application is
loaded at all, so they cost milliseconds rather than seconds. `src/cli-args.ts`
exists to make that possible and its runtime graph is itself plus the root
`package.json`, which owns the product version; `tests/architecture/cli-fast-path.test.ts` fails if
an import creeps in and puts the whole module graph back on that path.

```text
usage: clarvis [-h] [--version] [-p <prompt>] [--agent <name>] [--env <environment>]
                    [--format <text|md>]
                    [--resume <session-id>] [--continue] [--list] [--delete <session-id>]
                    [--refresh-models] [--update] [--ascii] [--worktree [name]]
                    [--debug[=<error|warn|info|debug>]]

  -h, --help                  print this help and exit
  --version                   print the version and exit
  -p, --print <prompt>        run the prompt headless: stream the reply to stdout, exit 0/1
  --agent <name>              agent to run --print as (default: entry agent)
  --env <environment>         select an Environment for this process (scope:name or name)
  --format <text|md>          --print output: text (default) or md transcript
  --resume <session-id>       resume a saved session
  --continue                  resume this workspace's most recent session
  --list                      list saved sessions and exit
  --delete <session-id>       delete a session and its runs
  --refresh-models            refresh the models.dev catalog and exit
  --update                    install the newest eligible Clarvis release and exit
  --ascii                     render glyphs as plain ascii
  --worktree [name]           open a dedicated Git worktree; omit name to generate one
  --debug[=<error|warn|info|debug>]  write bounded application diagnostics; --debug=<level>
```

`--worktree [name]` resolves the Git project and creates or reopens
`<primary-worktree>/.clarvis/worktrees/<name>` before any kernel, session, or TUI service starts.
The process then stays pinned to that canonical checkout. Git's registered worktree list is the
source of truth; Clarvis keeps no parallel registry. Before creation, Code ensures the primary
worktree's `.clarvis/.gitignore` excludes `worktrees/` so the nested checkout cannot be staged by
accident.

Normal interactive launches use the full Unicode glyph theme. Plain ASCII is
an explicit compatibility choice through `--ascii` or the saved Theme setting.

`--debug` is available on normal application modes, headless ones included: interactive run,
`--resume`, `--continue`, `-p/--print`, `--list`, `--delete` and `--refresh-models` can all leave
diagnostics for a failing automated or interactive run. `--help` and `--version` remain
application-free fast paths, usage errors do not open a session, and `--update` refuses `--debug`.
`--debug=<level>` narrows the floor to `error`, `warn`, `info` or `debug` (the
default), and `CLARVIS_CODE_DEBUG` / `CLARVIS_CODE_DEBUG_LEVEL` are the
environment equivalents, so a wrapper script or the tmux harness can turn
diagnostics on without editing argv. `/debug`, `/debug off` and `/debug <level>`
do the same from inside a running session, and Doctor's `diagnostics` row names
the open file so the path does not have to be caught as it scrolls past.
It writes
owner-only JSONL under the workspace's machine-local Clarvis state
(`state/workspaces/<workspace>/local/diagnostics` beneath `CLARVIS_HOME`), keeps
the newest five files and caps each file at 16 MiB. Repeated counter events are
sampled at the first eight occurrences and powers of two, so a runaway loop is
visible without letting diagnostics become a second resource leak. Prompt/tool
payloads and credential-shaped fields are redacted.

Every line uses the same versioned envelope: `v`, `at`, `seq`, `level`, `source`,
`event`, `pid`, any bound correlation fields (`workspace`, `execution_id`) and
bounded `details`. `memory` is sampled rather than written on every line: it is
always present at `warn` and `error`, where the RSS fuse reports, and every 32nd
record otherwise. Physical async operations share
`async.started`, `async.pending`, `async.settled` and `async.failed`; a pending
warning observes a stuck operation but does not start another request beside it.
The file reserves room for `diagnostics.saturated` and `diagnostics.stop`, so a
full log still records its final counters.

### Events this host records

Beyond the `async.*`, `diagnostics.*` and `task.*` vocabulary above:

| Level | Event                                                                                  | Fields                                                         |
| ----- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| info  | `app.boot.begin`, `app.boot.shell-painted`, `app.render.mounted`, `app.shutdown`       | `elapsed_ms`, `mode`, `workspace`, `reason`                    |
| info  | `app.boot.painted`                                                                     | `elapsed_ms`, `mode`, `deferred_catalog`                       |
| debug | `markdown.preload.completed`                                                           | `markdown`, `markdownInline`, `duration_ms`                    |
| warn  | `markdown.preload.failed`                                                              | `error`, `duration_ms`                                         |
| error | `boot.failed`                                                                          | `phase`, `error`, `attempt`                                    |
| warn  | `catalog.unavailable`                                                                  | `reason`, `source` (`kernel` \| `snapshot`)                    |
| info  | `catalog.load.started`                                                                 | `trigger`                                                      |
| debug | `memory.ledger`                                                                        | bounded ownership, payload and event-queue counters            |
| info  | `memory.gc.completed`, `memory.gc.skipped`                                             | `mode`, `reason`                                               |
| warn  | `memory.gc.failed`, `memory.efficiency`                                                | collection error or RSS baseline/slope evidence                |
| info  | `worktree.remove.completed`                                                            | `name`, `branch`                                               |
| error | `worktree.remove.failed`                                                               | `name`, `branch`, `error`                                      |
| info  | `settings.save.applied`                                                                | `scope`, `keys`                                                |
| error | `settings.save.rejected`                                                               | `scope`, `issue_count`, `fields`, `reason`                     |
| debug | `settings.model_ref.unparsed`                                                          | `site`, `error` (sampled)                                      |
| error | `plugin.install.failed`                                                                | `phase`, `argv0`, `subcommand`, `exit_code`, `stderr_tail`     |
| warn  | `marketplace.containment.unknown`                                                      | `reason`                                                       |
| error | `doctor.check.failed`                                                                  | `check_id`, `error`, `duration_ms`                             |
| debug | `shell.local.exit`                                                                     | `exit_code`, `duration_ms`, `killed`, `signal`, `spawn_failed` |
| warn  | `run.stream.interrupted`                                                               | `execution_id`, `error`                                        |
| debug | `run.close.failed`                                                                     | `execution_id`, `error`                                        |
| warn  | `elicit.handler.failed`                                                                | `error`                                                        |
| warn  | `transcript.rehydrate.failed`                                                          | `error`                                                        |
| warn  | `mcp.list.failed`                                                                      | `surface` (`tools` \| `prompts`), `error`                      |
| debug | `memory.sample`, `keyboard.event.unnamed`, `command.dispatch`, `mcp.refresh.requested` | sampled counters                                               |

`shell.local.exit` deliberately carries no command text: a `!` command is
whatever the user typed, credentials included.

The distributable build keeps `@opentui/core` external. OpenTUI therefore resolves its parser
worker and grammar assets relative to its own package entry point instead of a rewritten bundled
`import.meta.url`. Startup warms the Markdown and Markdown-inline parsers through OpenTUI's public
client API without holding the application shell behind that work. Session rehydration waits for
the warm-up before publishing restored Markdown, and the artifact smoke still requires both parser
assets to load successfully.

`-p/--print` runs without a terminal: it starts the kernel silently, streams
the lead agent's reply to stdout and exits 0 on success or 1 on failure —
suitable for scripts and CI. Interactive approvals (guard/ask_user) are
auto-denied with a note on stderr, so a headless run can never hang. Without
`--agent`, it uses the same configured-default, runnable-`marshall`, runnable-Lead
resolution as the TUI and fails clearly when no interactive entry agent exists.

`--resume` with an unknown id and `--continue` in a workspace with no sessions
fail fast with exit 1 before the terminal is taken; `--continue` only ever
resumes a session of the current workspace.

Sessions and runs are persisted through kernel services. The UI can resume a
specific session or continue the most recently used one.
Each turn stores the process-pinned Environment id and fingerprint. Resuming under a different
snapshot remains allowed, but the transcript and status line warn about the mismatch before the next
run starts.

`/storage` opens a metadata-only inventory of Clarvis-owned local state, grouped by logical data
category without changing the physical `~/.clarvis` layout. It shows only present/owner-only posture
for `keys.json` and `subscriptions.json`; their paths, sizes and contents never enter the view. The
`c` action previews stale temporary files and rebuildable cache, asks for confirmation, then reports
the actual bytes removed. If the bounded preview is truncated, cleanup stops before confirmation and
the kernel independently refuses an apply against an incomplete inventory.

### Worktrees

Normal boot remains in the checkout where `clarvis` started. `--worktree [name]` creates or
reopens a checkout before the kernel and TUI boot, then the process stays pinned to it. There is no
in-TUI selector or runtime switching. When an interactive launch selected a managed worktree and
that checkout is clean, exit asks whether to remove the checkout or keep it. Removal is explicit,
closes the workspace and completes outside the platform's bounded shutdown path, rechecks
cleanliness, uses `git worktree remove` without force, and preserves `clarvis/<name>` so a clean tree
with unmerged commits cannot lose its branch. Clarvis removes an empty parent only for its canonical
`.clarvis/worktrees/` location; an externally registered checkout's parent remains untouched. A
dirty checkout exits without offering removal.

Settings saves are serialized by the adapter and carry the exact source revision returned by the
kernel. Another process editing the same scope produces an explicit conflict; Code never retries by
blindly overwriting the newer source. Reloads, workspace-trust changes and repairs share that same
state-publication queue, so an older slow response cannot replace a newer cached view or agent list.
After an idle workspace-trust approval or revocation recomposes the kernel Environment, the run
client refreshes its cached `{id, fingerprint}` immediately; the next turn and resume comparison
therefore use the post-transition snapshot without requiring a reconnect.

The header carries the selected branch. `--continue`, `--resume`, `--list` and `--delete` operate
only on this process's selected workspace.

Session persistence is optimistic in the UI and serialized per session in the
background. Shutdown waits for pending writes, and persistence failures are
shown in the status line. Session switches invalidate older asynchronous resume
operations, so a slow resume cannot replace a newer session.

Transcript exports pass the raw owner id to `@clarvis/paths`; the export
directory builder encodes it at the path boundary, so an owner id cannot select
a directory outside the global `exports/` tree.

### Tasks

`/tasks` opens the provider-backed Tasks hub. It offers a normalized-stage board and list, current
provider health, container/search filters, task detail, explicit supported mutations and a manual
refresh. Native state, assignee and an active Clarvis claim remain separate; `concurrency: none` is
shown as `claim not enforced`. A provider failure, conflict or unknown mutation outcome is never
rendered as an empty board.

`Work on task` opens the ordinary agent/profile picker and starts a run in the current workspace with
only the external task ID and provider key. It never follows a task URL, changes worktree, or accepts
a repository/path from provider data. Returning from a run refreshes from the external source of
truth. Opening a task in work mode does not itself mutate the backend: the agent must call
`start_task` explicitly when that tool is available.

The provider setup remains separate from plugin installation and enablement. Settings select one
effective namespaced MCP server, fixed protocol `clarvis.tasks.v2`, optional default container and
writes policy; the test action probes capabilities only. `@clarvis/code` uses `KernelClient.tasks`
and never imports `@clarvis/tasks` or a Jira/Trello SDK.

## Main features

- Streaming lead-agent and sub-agent transcripts.
- Provider-declared commentary assistant turns retain their full Markdown body without a synthetic
  `update` marker; final answers keep the ordinary assistant presentation, and absent phase metadata
  never causes the client to synthesize text.
- Delegation briefs and terminal task/sub-agent results stay as bounded one-line previews in the
  transcript/sidebar; clicking them opens the original content in a scrollable Markdown detail modal.
  A completed roster state also settles a stale or cardless transcript section header through any
  resident node carrying that sub-agent identity, so one agent cannot read `Completed` in the
  sidebar and `Running` in the transcript at the same time. Parallel sub-agent bodies start folded
  behind their delegation cards even when the Lead produced no visible transcript.
- The agent roster has one responsive owner: the split sidebar or drawer when either is open. With
  both closed, the aggregate transcript stays unobstructed and the footer composes lifecycle counts
  with canonical run/context status. The compact footer strip is a portable mouse route into the
  drawer. Tab cycles agent selection in both the drawer and wide split; clicking a settled agent
  selects its transcript before opening result detail.
- Bounded transcript pages with incremental Markdown; live tails use OpenTUI's streaming mode and
  preserve sealed-prefix identity when a reply settles. A final Markdown candidate is prepared
  transparently and revealed only after its syntax descendants have painted; finalized diffs use
  the same readiness boundary and remain mounted through unrelated transcript activity. Oversized
  tails fall back to plain text with an explicit formatting-simplified notice instead of starting
  unbounded highlighting.
- The semantic transcript itself retains only the latest 20 complete turns, both while a session is
  live and after resume. One prefix notice represents every older turn; `/export` reloads those turns
  one trace at a time, so complete persisted history remains available without a second resident copy.
- Hidden/later turn labels use an append-aware boundary index, so a streamed structural append does
  work proportional to the mounted page and new suffix instead of rescanning the whole conversation.
- One mounted transcript page carries at most 512 Ki semantic text characters. Every textual node
  pays proportional render cost, and one individually pathological node is visibly shortened at the
  same boundary so it cannot bypass the page ceiling.
- Individual user/assistant/reasoning prose nodes retain at most 2 million characters and append an explicit
  truncation notice. This cap is applied before the value enters Solid/OpenTUI state, including the
  authoritative iteration-complete replacement, so one extreme provider response cannot dominate
  the interactive process.
- Resident user/assistant/reasoning prose also shares a 64 MiB UTF-16 budget. Old settled prose is
  replaced by an explicit `/export` recovery notice while semantic nodes, status, attribution and
  persisted run traces remain intact; streamed/running prose and the newest update are never evicted
  mid-write.
- Tool bodies are retained under a 200-call window, a 64 MiB estimated aggregate heap budget and a
  32 MiB single-body ceiling. Older arguments, results, diffs and errors are reloaded from the
  persisted run on demand through two concurrent reads and an eight-item queue; a body beyond the
  ceiling stays persisted and gives an explicit `/export` route instead of defeating the bound.
  Expanded live rendering separately caps each arguments/result/diff/error field at 64 KiB before
  any parser or native renderable sees it, and transcript paging charges that bounded projection plus
  its header signature. Markdown export includes the bounded, renderer-safe argument projection even
  though the live transcript intentionally mounts no raw argument panel.
- File and memory mutations from the run lead open by default and show their bounded mutation body
  even beyond the ordinary 40-line inline gate. Delegated mutations keep the compact default, and
  an explicit user fold still wins.
- Failed tool calls are folded by default: their red failure mark and call identity remain visible,
  while validation payloads and error text appear only after the user expands the call. A collapsed
  failed group likewise renders one aggregate failure row rather than repeating each member's error.
  Nonzero local-shell results remain expanded warnings because their partial stdout/stderr is the
  result the user asked to inspect, not a rejected tool call.
- Session persistence keeps one physical write and only the newest queued snapshot per session, so
  a slow filesystem cannot retain the quadratic sequence of every growing turn list. At most eight
  idle complete session documents stay cached; older entries demote to catalog summaries and reload
  only when selected.
- Session token totals are maintained incrementally per mounted run; reconciliation subtracts and
  rebuilds only that run, so a new streamed iteration never rescans the complete session history.
- The live footer shows token input/output once, scoped to `Run`; cumulative session information on
  that row is cost-only (`Session $...`). `/status` and Sessions retain the session-level token total
  for explicit inspection instead of duplicating it beside the run counters.
- **Every token count on screen reports input the provider had to read** — the gross prompt less
  what its prefix cache served (`uncachedInput`, and the run strip's own subtraction from
  `UsageActivity.cached`). Pricing keeps the gross figure, because a cache hit still costs a
  reduced rate; the count beside it answers a different question, and on a long session the two
  differ by an order of magnitude. `Context` is the one figure that stays gross: a cached prefix
  still occupies the window. The per-iteration split reaches the client on
  `iteration_completed.cached_tokens`, which is optional — absent, the strip states the gross
  number rather than guessing.
- The activity sidebar does not retain a second copy of each full delegated brief. It keeps at most
  64 terminal summaries of 512 characters; complete task and result detail remains in the transcript
  and persisted run.
- Tool-call, diff, reasoning, plan and budget views.
- Transcript blocks use the full available content width when the inline sidebar is closed, while
  the split layout retains the 110-column reading measure.
- Session browsing and continuation.
- Command guards and approval flows.
- User elicitation during a run.
- `/compact [request]` to compact the context used by the next model call, whether a run is active
  or the latest session turn is already settled.
- Skill slash commands and prompt injection.
- Execution-memory review and curation.
- Provider-backed task board, detail and current-workspace **Work on task** flow.
- Provider, model, plugin and MCP-server configuration.
- Contextual action Help, slash-command discovery and per-terminal keyboard profiles.
- Local `!bash` commands and workspace attachments. The composer admits at most four images,
  5 MiB each and 10 MiB aggregate. Binary clipboard input is rejected before base64 expansion;
  workspace images resolved from `@path` are checked against the same per-item and aggregate limits
  before a run or steer request starts.
- The composer sends with unmodified Enter, inserts a newline with either Shift+Enter or Ctrl+J,
  and grows from visual soft wraps as well as explicit newlines up to its bounded inline height.
  Unbroken long tokens wrap by character, so continuing to type never hides the draft prefix.

Steering submitted while a run is still starting waits for the kernel handle
instead of being dropped. Likewise, completion of a cancelled `!bash` job from
an outgoing session cannot overwrite the current session's status.

`/compact` performs a forced pass while retaining the configured recent tail. During a run it queues
the pass before the next model call. After a run it rewrites that run's persisted `final_context`
immediately, so the next continuation starts smaller. `/compact <request>` adds the text to the
agent's own compaction prompt; it does not steer the agent or add a conversation message.
The existing footer spinner reads the live compaction lifecycle: it shows `Compacting context…`
only after a queued pass actually starts, or while a settled-context request is awaiting its direct
result. Terminal events clear the state, and replayed start signals cannot reactivate it.

Changing `/model` while a run is active is refused until that run settles. If the selected model's
safe context limit is smaller than the latest persisted continuation, the picker shows the estimated
current size and new limit and requires explicit confirmation. Acceptance mechanically evicts older
context first and saves the model only after the replacement fits; cancellation or fitting failure
leaves both model and context unchanged.

Most features go through `KernelClient`. Local shell commands, marketplace
catalog cloning and platform diagnostics remain client-side seams because the
protocol does not yet provide corresponding services. Marketplace clones remove Git's repository-local
environment before spawning: a Clarvis process launched from a Git hook cannot redirect the catalog
clone with the parent repository's `GIT_DIR`, work tree, index, object store, common directory or local
config. Git transport and credential variables are preserved.

## Test ownership

The suite is classified by the primary effect boundary of each file:

- `tests/unit/` owns pure adapters, controllers, state machines, parsers, projections and theme or
  layout policy. Narrow fakes are local to the behavior under test;
- `tests/component/` composes code-owned stores, hosts, command registration and view models over
  fake or in-memory protocol/kernel ports;
- `tests/integration/` owns OpenTUI's real test renderer, file-backed settings and prompt history,
  clipboard/process/platform behavior, local shell and Git, plugin/template installation and the
  shipped `admiral` contract;
- `tests/architecture/` owns static dependency, public-surface and ASCII-source guards. It reads
  source and manifests but does not stand in for runtime coverage;
- `tests/helpers/` contains preloads, typed fixtures and renderer-lifecycle harnesses; helpers own no
  behavior matrix.

`bun run test` discovers all four test tiers in one Bun invocation. Each tier also has a targeted
`test:<level>` script. `test:coverage` runs the three source-behavior tiers with coverage, then runs
architecture once without charging repository scans as behavioral coverage. The distributable
bundle and its real PTY remain a separate e2e phase through `bun run build` (or the targeted
`bun run build:code`) and `bun run smoke`.

Unit and component suites do not wait on wall-clock time: asynchronous ownership is observed through
deferred barriers or bounded microtask drains, and timer behavior uses injected clocks. Integration
renderers open through the tracked helpers in `tests/helpers/`, which register teardown before the
first assertion; file-backed suites use the same pattern for temporary directories. Eager cleanup in
the test remains useful, while the registered fallback owns assertion failures and early returns.

Consumer fixtures author `RunEvent` directly from `@clarvis/protocol`; the kernel's engine-event
projection is covered by one integration smoke, while the exhaustive mapping matrix belongs to
`@clarvis/kernel`. Likewise, the ASCII matrix belongs to the glyph unit suite plus one static source
guard and one renderer smoke. Markdown cut-point permutations belong to the pure segmenter suite;
the renderer tier keeps only a small contract against the real `BlockView`, never a copied component.

Providers and Agents controller suites own state transitions, validation, persistence, reconnect,
catalog mutation and reference handling over typed in-memory ports. Their renderer suites use fake
stores and retain only rows, navigation/focus, visible error states and representative submits. View
command registration is one data-driven router/factory contract; only one command factory is booted
through the real renderer, while each concrete view's behavior stays with its own renderer suite.

## Development

Run commands from the monorepo root:

```bash
bun --filter @clarvis/code typecheck
bun --filter @clarvis/code test
bun --filter @clarvis/code lint
bun --filter @clarvis/code format:check
```

Relative imports name the actual TypeScript source extension: `.ts` for TypeScript and `.tsx` for
Solid components. A `.js` specifier is reserved for a real JavaScript artifact such as
`dist/index.js` or a generated lazy chunk; it must not alias a neighboring `.ts`/`.tsx` source. The
repository-wide `bun run check:imports` pass keeps this convention uniform across `src`, `tooling`
and tests in every package.

For live development:

```bash
bun --filter @clarvis/code dev
```

This package is outside the monorepo's `tsc -b` reference graph — Bun executes the TypeScript and
TSX source directly and nothing is emitted for consumers — but it **does** have a package build:
`bun --filter @clarvis/code build` (`tooling/artifact/build.ts`) produces the distributable bundle. From the
repository root, `bun run build` runs the TypeScript library graph and then this bundle; use
`bun run build:code` when only the TUI changed.

**That bundle is what `clarvis` runs.** `bin` points at `src/cli.ts`, which
is a launcher: it answers `--help`/`--version` itself and otherwise loads
`dist/index.js`. Running the sources costs ~2.5 s per launch — Bun transpiles the
847-file graph and applies the Solid JSX transform through Babel every time — and
the build pays that once. Consequences worth knowing:

- **A missing `dist/` is an error, not a silent fallback.** `dist/` is gitignored,
  so a fresh clone has none until `bun run setup` (which now builds), `bun run build`, or the
  targeted `bun run build:code`. The launcher names the fix rather than failing as an
  opaque module-resolution error.
- **After editing `src/`, the global command keeps running the old bundle.** Use
  `bun run start` / `bun run dev` for the inner loop, rebuild with `bun run build` or
  `bun run build:code`, or set `CLARVIS_CODE_SOURCE=1` to force the sources.
- **The bundle is package-local, not standalone by itself.** `tooling/artifact/build.ts` keeps
  `@opentui/core`, its platform-native packages, and `pino` external, so renderer and logging workers
  remain relative to their owning package instead of embedding the build host's `node_modules` path.
  The build rejects generated JavaScript containing the checkout root. Checkout setup provides the
  ordinary package dependency graph. Public release packaging assembles that same bundle with a
  pruned target-native dependency closure and an included Bun runtime; application source does not
  address the resulting `node_modules` layout directly.
- **The artifact is intentionally split.** Bun's `splitting: true` preserves the source graph's
  dynamic imports as sibling `chunk-*.js` files. The AI SDK adapter, provider implementations, Diff,
  Plan, settings panels and domain hubs stay out of the startup entrypoint until their capability or
  route is first mounted. `lazyView` gives command views one Solid-owned loading boundary and cached
  module without duplicating lifecycle code. The build and artifact smoke reject an entrypoint that
  absorbs representative lazy boundaries, and derive generated chunk basenames from either POSIX or
  Windows path separators so every native release job enforces the same graph contract.
- **Local maps are detached; installed and portable maps are omitted.** Bun eagerly loads an external `.map`
  found beside its runtime `.js`; with this artifact that erased most of the splitting gain. The
  ordinary package/root build moves maps to `dist/maps/` for offline diagnostics and the smoke
  rejects adjacent maps. `bun run setup` uses `build:install`, which emits no maps before linking the
  package, so the installed command carries only runtime JavaScript and assets. Portable packaging
  also removes source maps shipped inside runtime dependencies and rejects any remaining `.map`
  before archive creation. The checkout installer
  removes the former `clarvis-code` bin only when it is the symlink owned by this package, then
  unregisters and relinks the package. This avoids both a stale global alias and deleting an
  unrelated command. Setup requires the exact Bun version pinned in `mise.toml`, installs from the
  frozen root lockfile, and never downloads a runtime or edits shell profiles. Together with code
  splitting, detaching maps moved the 2026-08 idle 120x32
  Linux baseline from roughly 237 MB to 171 MB RSS.

The unit suite imports source and tooling modules by path, so it can never load a bundle and every
bundling-only defect is invisible to it: 1017 tests passed green while a bundled
`code` died on startup for want of the models.dev snapshot. `bun run smoke` is the
step that covers it. The smoke fixture fabricates a clean `HOME`, asserts the shipped snapshot
exists for a later Providers open, and proves first paint emits no `catalog.load.started` while
`deferred_catalog` remains true.

`bun run bench:code` measures the launch: the module graph (`--version`), exclusive
parser-free shell, complete header and input-ready frame, n≥7 with min/median/max.
It refuses to report on a busy machine and stamps the power state, because CPU
frequency scaling moved one unchanged measurement from 2.05 s to 0.60 s and three
conclusions had to be withdrawn over it.

`bun run bench:code-overlays` runs the renderer lifecycle soak. Every named case and default
120x32/80x24 size gets a fresh process, warm-up, forced-GC batch samples and RSS/PSS/private-dirty plus live renderable, renderer
lifecycle-pass, key-layer and cumulative layer-registration counters. Set
`OTUI_NO_NATIVE_RENDER=true` to label and run OpenTUI's official no-native-frame control.
Pass case names after `--` to run a subset; `OVERLAY_SOAK_{CYCLES,BATCH,WARMUP,SIZES}` controls
the measurement. A parent watchdog kills a child after 120 seconds or 1 GiB RSS. Production cases
fail above 5 MiB PSS per 100 cycles on Linux (RSS elsewhere) or when live renderable, lifecycle-pass
or key-layer counts do not balance; the corresponding limits are configurable through
`OVERLAY_SOAK_{MAX_MIB_PER_100,WATCHDOG_MS,WATCHDOG_RSS_MB}`. The case set includes the production floating modals, pickers, activity drawer,
elicitation, Splash, HintToast and an empty configuration page, not only primitive frames. The current
lifecycle keeps the transcript shell mounted behind retained Plan/Diff pages and lazily retains
Profile Picker, Safety Preset Picker, Catalog Picker, the narrow drawer and a bounded ten-slot
autocomplete projection.
The autocomplete cases cover both visibility churn and a retained ten-row scrolling mutation; both
must keep renderable, lifecycle-pass and key-layer ownership constant. Immediate RSS/PSS may rise
while Bun and OpenTUI retain collectable arenas, so the pass/fail leak rate is the post-GC
fresh-process slope rather than a close-time snapshot.
`SurfaceBoundary` owns each surface's explicit disposal policy and stable portal placement; the
portal remains outside remounted content and is always `retain-one`. This is load-bearing: changing
the Portal host while OpenTUI recursively removes a conditional subtree leaves orphaned
lifecycle-pass nodes. The inactive retained host is invisible, and component key layers are gated,
including configuration levels across page activation; workflow/provider timers pause and focus is
released. Activity Detail clears its last Markdown payload on close. A retained `FloatFrame`
animates only its first activation; reopening it
reveals the settled retained tree instead of restarting the timeline. Non-portal regions may still
use `dispose-on-close`. Configuration pages
keep their stricter stack semantics: inactive parents remain mounted, but popped frames are disposed
rather than cached.

Because OpenTUI requires a PTY, use `bun run smoke` for the repeatable bundle boot assertion and the
`tui-driver` skill for interactive reproduction. Do not launch the app through plain redirected
stdin and treat that as a renderer test.
