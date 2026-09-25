# `@clarvis/code`

The flagship Clarvis terminal UI. It connects to an independently owned workspace host through
`@clarvis/kernel` and renders runs with SolidJS and OpenTUI.

The UI programs against the `@clarvis/protocol` service contract, so the same
shell uses the same typed kernel RPC over a private local socket or Windows named pipe.
`/diff` and `Ctrl+X D` open the current workspace changes from `KernelClient.changes`, not
transcript tool history.

The run adapter accepts a backend advertising `hosting`: starts carry a persisted conversation
revision, while `attachRun` consumes an existing run's snapshot and live tail without starting it
again. Hosted completion waits for observation delivery, host reconciliation, terminal index commit and
released admission. After consuming a controlled result, the adapter acknowledges it and releases
its observation before reporting readiness, allowing long conversations to reclaim retained entries.
Observers and abandoned or failed observations do not acknowledge an unseen result. Print and TUI
consumers share that retention lifecycle through `createHostedObservationLease`. A lost connection
rejects observation without inventing an execution result. The session cache supports explicit
canonical refresh and confirmed revision sequencing. Its usage adapter converts presentation fields
and delegates token/cache/pricing accumulation to Kernel’s `addRunUsage` through `./policy`. The workspace manager launches or discovers
the companion `local-host` entry and owns its connection, while the host owns execution and history.

On a local Host or Sandbox connection, `/background` confirms that the current hosted run may
continue, then closes the TUI. SSH Kernels are owned by the current client channel, so
they refuse an exit-surviving handoff; list, attach and cancel remain available while that
connection is alive. A failed or uncertain handoff leaves the interface open.
An explicitly classified pre-admission refusal clears that attempt and permits a fresh handoff
after its cause is resolved. Uncertain or unclassified failures retain their operation identity
and use receipt lookup without repeating the mutation. Reopening the same workspace offers the
previous work or a new conversation; `/background list` opens that choice later. `/attach <execution-id>` observes
the same execution, and `/background cancel <execution-id>` requests cancellation without treating
its acknowledgement as physical completion. Another TUI's controller is observed by default;
taking control requires an explicit action in the list. Saved results remain in Sessions. The
background list controller owns polling, loading/errors and serialized attach/cancel operations;
the view owns selection, keyboard navigation, confirmation and painting.
Taking control while already observing preserves the existing session, transcript and event stream.
After confirmation, that observation gains interactive questions and normal foreground result
acknowledgement; it does not replay the snapshot or retire the conversation.

For an old run whose physical state is unknown, `/background list` offers `archive recovery`.
First verify that every process from that host has stopped, then explicitly confirm
the displayed host/run identity. The host records this operator verification in the saved session
before releasing its physical-work block. The conversation is archived and new work requires a new
conversation; existing history and any known result remain. Failed confirmation or persistence keeps
the recovery pending. The application does not infer physical closure from a missing host process.
After attachment through a local Host/Sandbox connection, the activity line says `continues after
exit` for a promoted run. `/quit` closes that TUI without asking about losing the run or cancelling
it; a new turn defaults to ordinary exit policy. SSH attachments never show that
promise. Unsaved settings still require confirmation, and Ctrl+C still requests run cancellation.
A Goal turn whose intent has committed also carries the host's continuation policy immediately.
Connection loss pauses its future automatic stages but preserves the current physical work and its
eventual settlement; it does not depend on the TUI completing a separate `/background` handoff.

For local connections, `/reconnect` restores the connection to the existing host without restarting
it or replaying work. `/reconnect reload` applies saved configuration through an explicit host
restart, which is refused while physical work is active. Hosted runs in `starting`, `running`, or
`finishing` state block that restart. A persisted `unknown` outcome records uncertainty but does not
claim that the current generation still owns physical work. Memory shutdown releases an in-flight
claim back to its shared
durable queue, and the replacement Kernel recovers it without spending an attempt. A refused reload
leaves a healthy connection available. Provider
credential saves and extension activation request that same reload path; connection recovery alone
does not activate a saved Extension Profile.
For an idle Host/Sandbox selection change, reload resolves the saved placement again,
retires the previous connection, and publishes the replacement Kernel's effective runtime to the
header before another run can start. If the replacement cannot be admitted, the picker restores the
previous isolation through the host administrative config service before the manager recovers that
connection. Expected EOF while retiring Host/Sandbox is not presented as a connection failure.
For SSH connections, reconnect first closes and drains the old SSH-owned host so its exclusive
workspace lease is retired before the replacement starts. That expected closure is not presented as
a connection failure. Closing the TUI or SSH stream also closes that remote host, cancels its
physical runs under the hosted disconnect policy and pauses future Goal continuations. Saved history
remains available, but `/background` cannot make work survive the channel.
User-typed `!` commands remain owned by the TUI and cannot be put in background. They reserve the
conversation in the host before spawning, persist their observation under that reservation, and
release it after physical completion. Normal exit cancels and drains local shell work before
closing the host connection. Offline compaction uses the host's separate maintenance admission.

`--resume` and `--continue` check for hosted work before reconstructing historical traces. Print mode
also uses hosted turn admission and waits for physical closure. The host must remain alive for
execution to continue; restarting an interrupted host does not replay tools or restore a live run.
See [hosted runs](../../specs/hosts/hosted-runs.md) for authority and recovery boundaries.

`/goal` shows the conversation's objective, semantic definition, origin, compact budget and Goal
Steward status. The sidebar adds one short Steward line; the complete view shows bounded review and
completion-review count plus the latest summary, Steward question or actionable next step.
`needs_evidence` is presented as a Steward clarification that the main agent is answering, not as an
operator action. Technical execution IDs remain
hidden. `goal_steward_failed` and `goal_steward_inconclusive` appear as Goal-domain attention.
Only post-closure Kernel settlement may show the Goal as complete.
Goal command suggestions follow the current Goal and physical execution state. Without a current
Goal, only `/goal` appears. `/goal <seed>` submits an ordinary turn of the selected main agent; the
host persists a formulating intent, appends a host instruction after the operator's literal request,
and the agent must call `create_goal` before implementation. The automatic
formulation mode remains available to the host service but is not exposed as a slash
command. `/goal -- <objective>` bypasses inference and creates that exact literal text, including
`/goal -- auto`; an empty literal is refused.

Any current Goal blocks a new guided creation until the user reviews, cancels or clears it. The
ordinary main-agent creation turn is visible immediately in the Lead activity line and
automatically reveal a compact Goal section in
the same activity sidebar used by Plans, parallel work and agents. The section remains after
creation with objective, status and stage count, using the same title/status/key anatomy and lifecycle
tones as Plan, with the `full goal` navigation label; `Ctrl+X O` toggles the complete Goal view while
that section is revealed. While the ordinary creation turn runs, both surfaces show its normal
bounded activity and current iteration when known.
The sidebar retains the latest completed workspace activity above the current thinking line so a
short read or search remains observable after the next model iteration begins.
Creation never switches screens automatically. Insufficient, stale or
failed outcomes show their one question or actionable message and never retry analysis
automatically. From the complete Goal view, `Ctrl+X O` returns to the transcript without requiring
`Escape`. The full view uses a bounded reading column with spaced status, review and usage blocks;
completed goals omit the internal completion reason. Transcript-wide expansion is a separate `Ctrl+X K` action. `/goal edit` opens a
deterministic form for objective, criteria, constraints, exclusions, assumptions and limits. A
semantic edit warns that saving converts the complete definition to literal and clears normative
source bindings; a limit-only edit preserves them. Editing a terminal goal requires confirmed
replacement. Pause, resume, cancel and clear use explicit host controls. Pause alone stops future
stages; `pause --running` also requests cancellation of the bound run. Editing waits for physical
closure, including unknown work that requires recovery.
An edit submits only fields changed from the reviewed snapshot; a no-op closes locally, and a
limit-only edit does not revise the objective or clear its candidate and human approvals. Once a
mutation receipt is confirmed, a failed follow-up read leaves the view stale with an error but does
not report the committed mutation as failed.
Human criteria show pending or accepted status for the current objective revision. The acceptance
picker offers only pending criteria; an approval from an earlier revision does not satisfy a new review.
Completed and cancelled goals retain their approval display without offering new acceptance.

The presentation controller subscribes before reading canonical state, pins each review to its
conversation and revision, and recovers uncertain mutations by receipt without resubmission.
The runtime observes host-started stages in the same conversation, retains the painted prefix and
hydrates stages that finished before observation. It never schedules goal continuation in the TUI.
The transcript renders accepted stage endings as `Checkpoint saved`, retaining that label during
reconciliation and session restoration. Ordinary successful runs remain `Completed`; the goal view
is the authority projection for whether the full objective has completed. An intentional
`goal_blocked` outcome is rendered as Goal-domain attention, not as the generic
`goal_blocked: guard_trip` run-error row; the durable Goal reason remains visible in the sidebar and
complete view.
When stages settle behind a full-region view, returning to the transcript transfers older sealed
blocks to history navigation even if they are not yet resident. They cannot remain in the live tail
after a newer completion; scrolling or revealing an earlier checkpoint loads its retained history.
Hosts without goal authority report explicit unavailability. The
[goal contract](../../specs/capabilities/goals.md) owns these boundaries; complete local/remote,
real-provider and installed-artifact qualification requires separate journey evidence.

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
keyboard policy, theme, and onboarding. The performance contract and measurement review live
in [`code-performance.md`](../../specs/hosts/code-performance.md). Image entry and the vision pre-pass are specified in
[`engine/vision-routing.md`](../../specs/engine/vision-routing.md).
Thinking text shows at most three wrapped lines, with `...` when additional content is hidden.
Resizing updates the preview; the persisted reasoning is unchanged.
Transcript snapshot rendering remains in
[`code-transcript.md`](../../specs/hosts/code-transcript.md); publication, visual stability and the
committed-history/live-frontier contract are separated into
[`code-transcript-stability.md`](../../specs/hosts/code-transcript-stability.md).

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

For a reusable source command from this checkout, run the root development installer once:

```bash
./dev-install.sh
clarvis-develop
```

`clarvis-develop` loads the selected TypeScript sources, preserves the caller's current
directory as the Clarvis workspace, and remains separate from an installed release's `clarvis`
command. `--empty-workspace` starts it in a newly allocated directory under
`/tmp/clarvis-development-temp/`; `--clear` removes global state and those managed workspaces, and
the two flags can be combined to clear before opening a fresh workspace.

To install the optimized command globally from this checkout:

```bash
bun --filter @clarvis/code setup
clarvis
```

To test a published source candidate, use:

```bash
./dev-install.sh --candidate                 # newest published RC among the latest 100 releases
./dev-install.sh --candidate v0.2.0-rc.4      # exact RC, once published with source-v1 support
clarvis-develop
```

This requires Git and the candidate's pinned Bun version. The installer verifies the source
prerelease and its `source-candidate.json`, checks out the exact tag commit under
`${XDG_DATA_HOME:-$HOME/.local/share}/clarvis-candidates/`, installs frozen dependencies and
checks the CLI version before replacing the managed launcher. The launcher pins the RC and source
revision. The ordinary `./dev-install.sh` selects the working checkout. Candidate installation
does not alter that checkout or replace the stable `clarvis` command. Update a candidate by
rerunning `--candidate`; `clarvis --update` remains a portable-release command. Previous candidate
checkouts are retained; `--uninstall` removes only the launcher. Older RCs without the `source-v1`
installation marker are refused.

For end users, the public installers in the repository root download portable artifacts from the
binary-only [`getclarvis/clarvis-releases`](https://github.com/getclarvis/clarvis-releases)
repository. A portable archive includes the exact Bun runtime, the map-free split artifact, its
package-owned assets, and the native OpenTUI closure for one of six targets: GNU/glibc Linux, macOS,
or Windows on x64 or arm64. Alpine and other musl-only Linux distributions are not portable-release
targets for this beta. The installed application uses native Host or Sandbox isolation. The bundled Bun executable is installed as `runtime/clarvis` on
POSIX and `runtime/clarvis.exe` on Windows, so operating-system process viewers attribute the
foreground process and its CPU and memory use to Clarvis rather than Bun. Developer source commands
still run under their explicitly invoked Bun executable. Archives retain `runtime/bun` or `runtime/bun.exe`
only as a compatibility entry for an older launcher; current installers and updates do not select it.
Runtime dependency discovery accepts only installed bare package specifiers from generated imports
and calls, including minified `createRequire` bindings; relative, absolute,
built-in, and module-internal `#` references retained by the generated artifact are not interpreted
as package roots, while package subpaths resolve to their owning root.
`release.json` declares the exact regular-file set checked by release smoke and self-update.
Starting with the first documentation-skill release, the payload also includes the raw
`clarvis-docs` Markdown tree and a bundled `runtime/system-docs.js` publisher. The source launcher
passes its active product root to the host; the kernel never derives Markdown assets from `dist`.
Managed installation and update verify the release tree, then publish the product-owned skill
before activating the version. A checkout `dev-install.sh` or candidate install publishes from
its selected source checkout. An owned older revision is retired when a pre-skill release becomes
active; an unowned destination is never overwritten. See
[self-configuration](../../specs/hosts/self-configuration.md).
Each archive also carries Clarvis's license; the Bun, models.dev, and Vercel AI SDK notices/license
texts; Bun's source and relinking route; a generated runtime-package inventory; and the
package-owned license files.
The installer also verifies the release-level `SHA256SUMS`, confirms that the staged CLI reports the
requested version, stores it under `versions/v<version>`, and writes `current` only after every
earlier step succeeds. On POSIX, checksum parsing, checksum calculation, and archive extraction all
use the portable `C` locale, so a synthetic host locale cannot add warnings to an otherwise healthy
install. Both root installers print the target, resolved destination, and numbered download,
verification, staging, and activation phases. `install.sh --uninstall` and
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
candidate last. The interactive TUI of a managed portable installation also performs a read-only
release check after `app.boot.painted`, at most once per process and once per 24-hour global cache.
It uses GitHub `ETag` revalidation, times out after five seconds, and only reports a release that the
same channel/target/asset policy accepts. The check never acquires `update.lock`, downloads an asset,
or changes `current`; failures are silent in the UI, while an available release produces one hint and
a persistent arrow beside the installed version. **Settings > Updates** writes the global-only,
default-on preference in Code's generated `state/code.json`; workspace `code.json` cannot override
it. Source, `bun link`, unmanaged, unsupported, fast-path, and headless invocations make no automatic
release request. The public request sends GitHub the caller's network metadata and
`User-Agent: clarvis/<installed-version>`; it sends no Clarvis credentials. `clarvis --update`
ignores the passive-check preference/cache and always repeats the authenticated release query and
artifact verification.

The current directory is the workspace Clarvis operates on. To run against
another project, start the binary from that directory or use the installed
`clarvis` command there.

## Configuration

Configuration requests use the normal conversation and file tools.
An eligible entry agent can load the product-owned `clarvis-docs` skill and its focused references
through the ordinary skill tools; this guide supplies information, not a file-edit grant.
Skill catalog notifications refresh command listings without reconnecting;
active resource users retain their captured revision until safe application.
See [self-configuration.md](../../specs/hosts/self-configuration.md).

The app uses a file-backed kernel. Workspace configuration lives under
`.clarvis`, typically:

```text
.clarvis/
├── settings.json
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
scope, choose or stage an Extension Profile, search exact plugin and standalone-skill inventory, review
every resulting agent/skill/MCP/hook contribution, then apply one preview-bound delta and
reconnect. Each decision exposes one key per outcome: Enter advances or applies and Escape finishes
the multi-select or walks back, asking before an edited draft is discarded. Install, exact
resolution and Apply use the shared footer-right spinner, show elapsed time, advance through their
real host phases and suspend mutation keys until the operation settles, while Escape remains live.
Leaving an install or preview returns immediately without cancelling its background work; once Apply
has started, Escape closes Extensions while apply, reconnect, refresh and the final notification
continue. Large catalogs use bounded retained rows, review bodies scroll independently from their
decisions, and the optional splash disappears on compact terminals. Internal Extension Profiles, Plugins
and MCP children remain available through that home's footer and return to it with Escape. The home
body omits the step preview and duplicate child-shortcut legend; they are not nested
slash commands.

The Plugins browser uses the shared bounded detail layout and section styles. Its root shows
compact counts and collections; the footer owns search/open hints, and detail pages retain
installation consent and source/security information. Catalog rows contain only installable entries,
omit repeated availability labels, and name their marketplace only when All mixes sources.
Installed inventory remains manageable independently of catalog availability.

The Plugins child includes `https://github.com/getclarvis/marketplace.git` as a built-in source
before any configured or discovered catalog. Its retained collection bar moves with left/right
through All, Installed, each exact marketplace URL, Workspace, and Add Marketplace; up/down moves
through plugins and `/` searches only the current collection. Enter opens a dedicated detail with
source, lifecycle, capabilities, executables and active Extension Profile state. The built-in URL is not
written to settings, and loading its listings does not install or activate a plugin. A second Enter
on an available detail is one composed consent: install the complete plugin, select its exact ref in
the current Extension Profile, reconnect, and verify it remains active after reload. Hooks are part of
that atomic plugin unit and have no independent approval screen or additional workspace approval;
repository-owned `scope: "workspace"` checkouts are covered together by one proactive workspace
approval. The lightweight startup composer paints without waiting for inventory hashing or trust;
repository plugins stay inactive until the complete app receives the resolved verdict and opens the
approval modal automatically, without a slash command. Update and uninstall are guarded at
the idle boundary. Workspace-owned checkouts are edited in their repository, and linked external
checkouts remain visible and activatable but never offer the managed update action. The kernel's
explicit `updateable` projection also suppresses Update for local and npm installs rather than
offering an operation that will be refused. Extension Profile selects only already-installed extensions.
Marketplace entries may install from Git
repositories/subdirectories (optionally pinned by ref or SHA), confined local directories, or npm
packages fetched without lifecycle scripts. Each install carries the listing name and refuses an
explicitly different manifest identity; an unnamed foreign manifest uses that listing name as its
stable install identity. The browser shows `AVAILABLE`, `INSTALLED_BY_DEFAULT`,
`NOT_AVAILABLE`, `ON_INSTALL`, and `ON_FIRST_USE` policy metadata without treating catalog load as
installation. Plugin detail preserves the original publisher, license, repository/legal links,
category, capabilities, prompts, brand and asset paths; Clarvis never replaces the declared author
with its own contributors. The guided flow obtains the complete exact
inventory from `ExtensionProfileService.inventory()` and commits a definition plus local selection only
through `previewComposition`/`applyComposition`; a changed definition, selection document, or
resolved contribution invalidates the review before either write. Its immutable `builtin:default` uses exact
`enabledPlugins` refs and two-root skill behavior; custom Extension Profiles are complete allow-lists of
exact `{ scope, source, name }` plugins and standalone skills. Plugins install into the shared global
`.agents/plugins` inventory. Definitions may be shared from `.clarvis/extension-profiles`, but the active workspace
selection is always local machine state. The Extension Profile browser shows resolution status, routes
creation/customization into the guided composer, retains direct selection/clear diagnostics, and
can revision-safely delete an inactive custom definition. A process-local `--extension-profile`
keeps persisted selection controls read-only. A failed Extension Profile catalog reload remains visible
inside the browser, with `r` retry, instead of surviving only as a transient footer notification. When a
retained child returns after changing the active snapshot, the Extensions hub immediately starts a full
reload of its summary and counts; no manual close and reopen is required. See
[`hosts/extension-profiles.md`](../../specs/hosts/extension-profiles.md) for activation semantics and
[`hosts/code-extensions.md`](../../specs/hosts/code-extensions.md) for the interactive catalog and
lifecycle experience.
Interactive Code and local `--print` kernels also provide the operating-system browser opener used
by remote MCP OAuth. The authorization coordinator still validates the destination and loopback
callback; this adapter grants only the host action of opening the already validated URL. Remote
kernel clients and server hosts do not inherit that local authority. Opening the browser never holds
an interactive run: the challenged MCP stays inactive for that run while authorization continues in
the background, and its sanitized reason appears once in a transient TUI warning rather than the
conversation transcript. Ignoring the page leaves the composer and model run usable; completing it
stores the token for a later run.
After onboarding, `/model` is the only surface that changes `default_model`, and `/effort` is the
only surface that changes its `default_reasoning_effort`. They write only their own setting in the
selected global/workspace scope. Providers owns credentials and the available-model set, while
Settings > Defaults owns vision and budget defaults; none can overwrite the model/effort choice.
Those user defaults are authoritative for the run's Lead even when its selected Agent Profile
declares another model or effort. A spawned Sub-agent keeps the model and effort explicitly
declared by its own Agent Profile, falling back to the user defaults only when it declares none.
Settings > Defaults shows the effective host token default when no settings layer declares one; it
does not label the run unlimited while the kernel still applies its environment fallback.
Defaults, Memory, Sandbox and Run controls use the same stable overview/detail interaction as
Agents: the overview keeps one compact row per setting, Enter edits, and `i` opens configured,
effective, source and application details without expanding the list in place. Sandbox host and
toolchain diagnostics live with the Sandbox detail, where errors remain visible and refreshable.
Settings > Memory presents its effective summary and rows as one list — the effective state, then
`Memory`, `Extraction model` when a block exists, and `Session memory` — with no intermediate scope
headings: each row names its own origin (`from <scope>`, `this client`) and its own timing
(`next run`, `now`), and the session control stays client-local and immediate whatever scope page it
is shown from.
Editing a shipped agent in `/settings` → agents writes a **customization**, not a copy: only the
fields you changed reach `agents/<name>.md`, and everything else keeps following the shipped
default. Deleting that file is offered as a reset — the shipped agent comes back. A shipped agent
cannot be renamed or deleted; fork it under a new name instead. If a customization's frontmatter
does not parse or does not validate, Clarvis runs the shipped agent unchanged and Doctor reports
which file was refused and why.

Every interactive cold boot first paints a parser-free, focused `StartupComposer` in one lightweight
Solid root. Its header keeps the root-owned `v<version>` visible at the right edge, and its shared
`BrandBanner` preserves the final screen's visual structure while the
application chunk and workspace foundation load concurrently. At 60 columns by 17 rows or larger,
the first paint shows the same complete eight-row Clarvis banner as an empty, untouched run; a
narrower or shorter frame uses the shared one-line wordmark, and an extremely short frame retains
only the branded header. The banner reserves all eight physical rows, followed by a blank separator
and a non-shrinking status row, so reactive progress cannot paint over the final banner line. During startup that status reports the local or SSH Kernel connection. It remains startup-specific
instead of claiming an agent, model or complete-app shortcut before those values exist. In `run` mode the user can type
immediately; Enter stores the exact submission outside renderer ownership. As soon as the run host
exists with a runnable active Agent Profile, that queued task starts before complete-app hydration, and the
resulting store/events survive the root handoff. The state continuously captures the draft and does
not read renderer-owned input after the startup view is destroyed. If provider/agent setup is not runnable yet, the
accepted text is restored as the full composer's exact draft instead of disappearing. An unsent draft
uses the same handoff. Resume/continue keep startup input locked until their saved session is restored.
If terminal shutdown wins while the foundation or profiles are still loading, a boot latch prevents
both startup-task admission and complete-app mount after teardown has begun.

The complete `App` replaces the startup root without waiting for the models catalogue or Markdown
parsers. The startup copy has its own `Queue a task…` readiness marker and intentionally excludes the
complete app's `◆ Clarvis` paint marker and `New task…` marker. The first-paint benchmark therefore
reports functional startup input separately from full hydration, and release smoke still requires
the complete application plus its `app.boot.painted` diagnostic. The smoke's outer elapsed time also
includes its 100 ms polling cadence and required Markdown-diagnostic settlement, so it is an artifact
health duration rather than a startup-performance sample; compare startup only through the repeated
benchmark's individual markers.

On the first interactive launch, startup opens a branded Clarvis setup rather than Doctor or an
empty conversation. Enter begins the focused provider/model picker; the flow makes the selected
model the default and asks for its credential without ever rendering the secret. After saving,
Clarvis seeds its ordinary planning and memory defaults, reloads the live Agent Profile
catalogue, selects `marshall`, and shows one Ready screen. No agent or workflow file is written at
any point; the default fleet and workflow catalogue are built into the kernel. One **Escape** from
either picker closes the bootstrap picker and returns to setup with the staged choice unsaved.
Opening `/settings/providers` later keeps the ordinary multi-provider and
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
different Agent Profiles may select either provider. Subscription detail omits API-key, base-URL,
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
When an entitled subscription model is added, its authenticated catalog supplies entitlement and
model shape while the local models.dev snapshot supplies cache pricing for the exact same model
under the owning public provider: native OpenAI for ChatGPT and `xai` for Grok. That price shape
derives the persisted `prompt_cache` mode without naming a model in code. Cache-write pricing does
not prove that an endpoint accepts inline markers: only Anthropic is catalog-derived as explicit;
ChatGPT, native OpenAI, Grok, Google and compatible endpoints default to provider-managed implicit
caching. No equivalent
cross-provider lookup runs for an arbitrary OpenAI-compatible endpoint.
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
the TUI opens the agent picker and headless mode requires `--agent` or a configured default. If an
Extension Profile recompose removes the current session agent, the same safe fallback is selected and
persisted as that session's Agent Profile before its next run.

The settings adapter is backed exclusively by `KernelClient.config`. It keeps a
cached `SettingsView`, but does not open or parse the source paths the kernel
returns for display. When Doctor finds corrupt settings, it asynchronously asks
the kernel for a revision-bound strip/reset preview, confirms that exact plan
with the user, then applies it through `repairSettings`. A concurrent edit is a
`conflict`, is shown as a repair failure, and is never overwritten.

### Interactive memory fuse

`clarvis code` samples its own RSS every 500 ms. The interactive TUI treats three consecutive samples
at 80% of a 2 GiB default as sustained pressure and then silently drops reconstructible completed
tool bodies that persistence can refill. At the 2 GiB limit it blocks new model/tool submissions,
export, and other expensive admissions while leaving the process, live observation, transcript
navigation, explicit `/clear`, and quit controls alive. It does not cancel independent hosted work,
restart the workspace host, or ask the user to recover memory. A 10-second bound covers one local
maintenance callback; a 30-second bound covers a blocking critical episode. The sampler covers the
TUI process RSS, not arbitrary external MCP/shell process trees, so host-level monitoring remains
appropriate for untrusted external services. The fuse rearms after three samples below 70% with no
pending local maintenance. A later natural drop can also rearm a measured failure that did not lose
integrity. `/clear` remains an explicit session action, not part of recovery. Every model-start path,
including `Work on task` and scheduled `/loop` turns, rechecks the fuse immediately before dispatch.
Positive custom limits have a 512 MiB floor, preventing a rearm threshold below the measured healthy
baseline. A separate efficiency advisory observes a 20-sample slope and requires both 512 MiB
absolute RSS and 256 MiB growth from the process baseline; it records diagnostics but never blocks
work, maintains, or runs GC.

Successful maintenance is silent. While admission is blocked the footer shows `Restoring the
interface…`. A definitive failure notifies once that new work is paused because the interface is out
of memory. Diagnostics never claim a ledger capture unless a diagnostic logger is active.

Maintenance uses synchronous `Bun.gc(true)` at most once per episode, and only after reconstructible
local caches were released and TUI-owned work (local shell, tool rehydration, and physical run
handles) is idle. If that work is still settling, collection records `memory.gc.skipped` and is not
queued for later. Every ten seconds and at memory state changes, debug mode records one aggregate
`memory.ledger` containing transcript/session bytes, renderer renderable, lifecycle-pass and
frame-listener counts, renderable ownership, physical handles, and protocol event-queue counters.

Set `CLARVIS_TUI_RSS_LIMIT_MB` to another MiB value, or `0` to disable this interactive-only guard.
It is not installed in the server, print mode or embeddable kernel.

The OpenTUI console overlay is disabled in ordinary runs, so hidden diagnostic
logs do not accumulate behind the interface. `CLARVIS_CODE_DEV=1` enables the
overlay and its cache together with the existing developer error surface.

Prompt history is likewise a bounded convenience cache: at most 1,000 entries, 1 million
characters per entry and 8 million resident characters. Startup reads only the newest 8 MiB of its
JSONL file and compacts an older oversized file in the background.

### Navigation and keyboard environments

Every interactive behavior is a named OpenTUI command. Its binding, enabled state, label and
description are projected from that one registration into the current footer and full Help screen;
screens must not maintain a second shortcut legend. Footer action labels are rendered in lowercase,
independently of Help and screen titles. `/help` is the sole Help entry route. It opens a
lazy full-page reference containing actions available here and elsewhere, destinations, input
syntax, editing commands and the effective terminal path. F1 has no built-in action or reserved
footer segment. Slash commands and configuration hubs remain the searchable routes to destinations
and actions.
`/diff` opens every file mutation recorded in the active Lead or selected sub-agent transcript. A
folder tree lists all changed files and can collapse or expand directories; selecting a file shows
all of its recorded diffs in chronological order. Narrow terminals show the tree and file detail as
separate steps. Retained bodies are rehydrated before display instead of silently falling back to
only the newest edit. Moving through the tree does not replace the open file until Enter confirms
the selected row. Each tree row names its file in full: the status letter, the whole basename and
the entry's added and removed counts, which move to the row's own trailing line when a long name
needs the width. A file is therefore recognisable before it is opened, and a row's height depends on
the entry alone, so moving the cursor never reflows the rows around it. The file reader's header
keeps the whole path too and names the open file's operation. Escape returns from file detail to the
tree, then closes `/diff`; its footer omits
the global Ctrl+C cancel/quit action like the Plan and Goal detail screens.

Memory's quick control is session-only.
Application actions use Ctrl+X: I for Isolation, M for Memory, R for Run controls,
P for Plan, O for Goal, W for Workflow, D for Diff, S for the activity Sidebar, K for block expansion, and E
for the expanded editor. Ctrl+X Up/Down enter transcript-block focus; while a block is focused,
plain Up/Down move between blocks and Tab returns to the composer. While a Ctrl+X prefix is pending,
the navigation band names the sequence the user actually holds and lists the continuations the
keymap would dispatch next (`Ctrl+X active ▸ [K] expand · [I] isolation …`), so the options appear
next to the prefix they belong to and the activity line keeps reporting the run instead. A pending
prefix is announced once, on the surface that owns the band, and each continuation reflects the
binding that would really fire there. These defaults are identical
on macOS, Windows and Linux: press Ctrl+X, release it, then press the second key.
The prefix expires after two seconds; Escape clears it and retains normal back behavior. Manual overrides remain
available in Keyboard settings. All shortcut labels spell out Ctrl and Shift instead of a caret.
Isolation, Memory and Agent pickers are disabled while a run is active.
Clarvis keeps the terminal's native text path
instead of requesting all-key escape reports, preserving dead-key and IME composition; a literal
`ß` remains ordinary text. The three run-control pickers are loaded on first use and retained after their first
mount. `Ctrl+X S` is the sole keyboard route for toggling the responsive activity Sidebar; it opens
the first available Agents, Parallel work or Plan section when closed and closes the surface when open.
In every width below the split it opens that surface across the whole content region instead of a narrow
drawer, and the
summary strip names the same effective binding so the route stays discoverable while no panel is
mounted. The first live Plan, first workflow state/leader and first typed delegation each own an independent,
once-per-execution automatic reveal intent for the responsive Plan, Parallel work and Agents
sections. Those reveals keep the Lead transcript selected and never open result detail. Closing the
split or whole-region panel dismisses the intent that opened it, so later updates of that kind do not reopen it
automatically; the first event for another section may still reveal and orient the Sidebar. Escape
does not close any presentation. Agent, workflow and Plan rosters remain in the Sidebar; the
canonical footer contains only run context/session usage and does not repeat their counts.

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
the draft. From the instant the bootstrap renderer enters raw/alternate-screen mode, a lightweight
lifecycle owner restores it on exit and every platform-supported catchable OpenTUI signal, then
the platform retains the same ownership; `SIGKILL` is inherently outside this contract. Raw Ctrl+C
stays owned through complete-keymap mount. The fatal-boot screen takes priority during that interval,
so idle Ctrl+C exits 1 and Ctrl+C during retry remains inert. Window-local layers never claim Ctrl+C. A live builtin `shell` block shows a compact `[X]` immediately after its elapsed time. Clicking it, or focusing that block and pressing `Ctrl+X T`, interrupts only that invocation; the run continues. `Ctrl+X` alone only starts a sequence. `Ctrl+X D` opens the same multi-file viewer as `/diff`; protected manual cancellation overrides retain precedence. While a workspace runtime is being replaced, the
mounted screen stays visible and only unmodified Escape remains interactive; modified Escape,
every other key and all pointer actions are consumed until replacement settles. Input callbacks already queued during renderer
teardown are discarded at the keymap host boundary, so a final macOS terminal packet cannot dispatch
through an OpenTUI host after it has been destroyed.

The Workflows tree follows the same contextual-action contract. Rows show the persisted short task
title rather than the first line of the full prompt. `Enter` opens the selected node's result; `T`
appears only for a leader whose complete task is available and opens that task on a separate detail
page. The manager and legacy records without a persisted task do not advertise or bind `T`. Above
the tree, an `awaiting_manager` checkpoint appears as waiting for the next stage. The live Parallel work section shows the same checkpoint even when no
leader remains live, so an Admiral decision cannot disappear with the last child. Its header and
leader roster mirror the compact Plan/Agents grammar: settled/total plus active running count, then
one plan-tone status glyph, handle and title per leader in an isolated bounded scroll. Lifecycle
words, elapsed time, iteration counts and failure totals stay out of this summary surface.

A `workflow_review` prompt retains the `cancel`, `run` wire enum and displays `[1] run workflow`
then `[2] do not run`, with no preselected UI answer.
Numbered elicitation choices submit immediately with `1–9`, and `0` selects the tenth option. Arrow
keys only move the highlighted choice and still require Enter. Number shortcuts deactivate while a
text or numeric field owns input. Enter on an untouched workflow prompt cannot launch a workflow by
enum order.

Goal, Plan and Workflow detail screens share a 100-cell reading column, title/section styling,
spacing and lifecycle colors. Their footers use the same lowercase action labels and group Escape
with the screen toggle as `close`; nested Workflow pages distinguish `back` from `close`. The
global cancel/quit hint is omitted consistently, while Ctrl+C retains its behavior. Workflow detail omits technical identities, refresh timestamps and
internal execution counters while retaining tasks, progress, actionable failures and results.
Merging live activity preserves cancellation separately from failure.
`Ctrl+X W` opens the current workflow directly and closes the entire workflow view from its tree,
task or result page. Ctrl+W remains the composer's previous-word deletion.

When a current plan is available, `Ctrl+X P` opens its full detail. Retained completed, failed and canceled plans stay reachable as
the latest plan; a removed plan advertises neither shortcut. A directly opened detail returns to
the run when the same plan shortcut is pressed again or on Escape. Ctrl+C leaves the plan screen
open and cancels the active run (or enters quit when no run is active). The sidebar separates the
plan title, lifecycle, task states, active task and last result with explicit labels and an
active-row surface, so progress is not encoded by colour alone. The TUI has no retained-plan
catalogue, filters, per-plan retention mutation or deletion; its backend seam reads only the live
plan's document. The detail uses the same bounded reading column as Goal, with spaced objective,
context, tasks, validation, notes and preserved extra sections. It renders structured fields instead of the stored
Markdown, omits empty fields, paths, IDs, revision counters and retention metadata, and shows
approval guidance only when a decision is pending.

`/plan` toggles this workspace's next-run policy between normal planning and required human review:
`review` becomes `on`, while `on` or `off` becomes `review`. Repeated invocations serialize, so a
second `/plan` restores normal planning even when entered while the first write is settling. Run
controls has no planning-mode selector; its only plan row chooses whether completed plans are kept
or deleted after a successful result. Registered Clarvis commands own their slash tokens, so an
agent-backed skill named `plan` cannot shadow this built-in action.
`/plans` and `/planning` are not commands. Execution memory has no global quick toggle:
the next-run/session choice belongs to Run controls, while persistent configuration belongs to
Settings > Memory.

Keyboard policy is scoped to an opaque terminal-path identifier in the global `code.json`. Local
Kitty sessions default to the enhanced profile; SSH, multiplexed legacy and unknown paths default to
portable behavior. A remote server's operating system is never presented as the user's client OS.
Settings > Keyboard can select portable/enhanced/manual behavior, set the client-side modifier
convention and override any stable named action. Protected Help, back and cancel
actions may be rebound but not left empty or placed on either side of a strict-prefix conflict with
the active Keyboard Profile's effective defaults or another manual override. Validation uses both commands in
the conflict, so persisted binding order cannot make an unreachable protected route acceptable.
Whenever an exact action and a longer sequence are both active, the exact action dispatches
synchronously; Clarvis never waits on a key-sequence timeout. Keyless actions are labelled `no
shortcut`; the removed command palette is not presented as a fallback route. The same
normalized-event diagnostic is reachable from Doctor; it stores only capability verdicts and never
raw escape sequences, hostnames, addresses or typed text.

### Repeat prompts in the current conversation

`/loop` schedules an explicit prompt while this TUI stays open:

```text
/loop 5m check the PR comments
/loop 90m --max-runs 8 -- review the test results
/loop cron "0 9 * * 1-5" --tz America/Recife -- prepare the summary
```

Intervals use positive integer minutes, hours or days (`m`, `h`, `d`), with a one-minute minimum.
The first run waits a full interval; later runs wait that interval after the preceding execution
finishes. Cron uses five numeric calendar fields, with lists, ranges, steps and Sunday 0/7. A
restricted day of month and weekday use OR. The timezone is captured at creation; DST gaps are
skipped and repeated local times use their first occurrence. Missed cron times become one pending
run. Options go before `--`; everything after it is literal prompt text, even `/quit`, `/loop` or
`!command`.

Creation opens details with the prompt, id, conversation, agent/model, schedule, next eligibility
and attempt limit. `/loop` or `/loop list` opens help and the list; `/loop show <id>` opens details.
Use `/loop pause <id>`, `/loop resume <id>` or `/loop cancel <id>`. Pause and cancel leave the current
run to finish; `/loop cancel <id> --running` also requests cancellation of that job's own run.
The detail/list controls expose the same actions. Invalid commands preserve your draft for correction.

Runs use the current conversation context and ordinary tools, permissions, approvals and budgets.
They wait while you have a draft, attachments, an open dialog or another execution still settling.
There are at most ten live jobs per conversation and twenty admitted attempts per job by default;
`--max-runs` changes the latter. A prompt is limited to 64 KiB, with at most one hundred retained
registrations across the TUI. Errors, cancellation, unavailable results, connection loss or changed
execution configuration pause the job. Changing conversations also pauses it; returning requires
explicit resume, which shows the revalidated configuration and schedules a future occurrence.
Clearing/deleting a conversation cancels its registrations. Closing the TUI forgets all jobs;
normal run history remains, and restarting or resuming a conversation never restarts a loop.

The host owns this feature, with no model call needed to create or control a registration. It uses
the pinned Croner dependency solely for calendar calculations; its bundled MIT license is preserved
in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). The behavioral contract and test ownership
are in [loop-scheduling.md](../../specs/hosts/loop-scheduling.md).

### Shell and file tools

Shell commands and file operations execute with the selected Isolation policy. When native
Sandbox isolation is configured, its filesystem and network restrictions apply to both.
Production: `packages/code/src/features/run/` (run configuration) and
`packages/tools/src/sandbox.ts` (`sandboxCommand`). The behavior is specified in
[sandbox.md](../../specs/execution/sandbox.md).

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
usage: clarvis [-h] [--version] [-p <prompt>] [--agent <name>] [--extension-profile <selector>]
                    [--format <text|md>]
                    [--resume <session-id>] [--continue] [--list] [--delete <session-id>]
                    [--refresh-models] [--update] [--ascii] [--worktree [name]]
                    [--remote <user@host>] [--remote-workspace <path>]
                    [--debug[=<error|warn|info|debug>]]

  -h, --help                  print this help and exit
  --version                   print the version and exit
  -p, --print <prompt>        run the prompt headless: stream the reply to stdout, exit 0/1
  --agent <name>              agent to run --print as (default: entry agent)
  --extension-profile <selector> select an Extension Profile for this process (scope:name or name)
  --format <text|md>          --print output: text (default) or md transcript
  --resume <session-id>       resume a saved session
  --continue                  resume this workspace's most recent session
  --list                      list saved sessions and exit
  --delete <session-id>       delete a session and its runs
  --refresh-models            refresh the models.dev catalog and exit
  --update                    install the newest eligible Clarvis release and exit
  --ascii                     render glyphs as plain ascii
  --worktree [name]           open a dedicated Git worktree; omit name to generate one
  --remote <user@host>         connect to a Clarvis installation over SSH
  --remote-workspace <path>   absolute workspace path on the remote host
  --debug[=<error|warn|info|debug>]  write bounded application diagnostics; --debug=<level>
```

`--worktree [name]` resolves the Git project and creates or reopens
`<primary-worktree>/.clarvis/worktrees/<name>` before any kernel, session, or TUI service starts.
The process then stays pinned to that canonical checkout. Git's registered worktree list is the
source of truth; Clarvis keeps no parallel registry. Before creation, Code ensures the primary
worktree's `.clarvis/.gitignore` excludes `worktrees/` so the nested checkout cannot be staged by
accident.

A new `clarvis/<name>` branch starts from the commit at `HEAD` of the checkout where `clarvis` was
started — that checkout also when it is a linked worktree. Bootstrap never fetches and never consults
a remote default branch, so commits that exist only locally are included and creation does not depend
on connectivity. An existing `clarvis/<name>` branch or a registered checkout is reused exactly as it
stands and without reading `HEAD`, so reuse still works when the launching checkout's `HEAD` is
unborn; uncommitted changes remain in the source checkout and are not copied, and a repository without
a commit fails with a clear error before any branch or checkout is created once a new branch is
required.

`--remote <user@host> --remote-workspace <path>` starts the installed `clarvis` command through
OpenSSH and carries the ordinary kernel protocol over that process's stdio. Both flags are required
and cannot be combined with `--worktree`. SSH owns host/user authentication and encryption; Clarvis
does not copy the client's provider credentials, global configuration or local-host discovery token
to the remote process. The remote installation resolves its own global state and OAuth session. The
workspace and optional Extension Profile selector are encoded into one bounded base64url argument;
the remote host canonicalizes them and returns its server-owned session namespace. It supports
hosted runs and goals but exposes no browser, inspection, restart or runtime-retry controls belonging
to the remote machine. `/reconnect` starts a fresh SSH process; configuration reload is unavailable
for that connection. Client-only diagnostics and prompt history remain under the local invocation's
state, while workspace files and durable sessions remain remote.

The destination may be a normal `user@host` or an alias from the operator's OpenSSH configuration.
OpenSSH chooses default identity files, `IdentityFile` entries, certificates and identities already
loaded in `ssh-agent`; Clarvis has no separate identity-file or password store. A local agent may
authenticate the connection, but `-a`, `-x` and `ClearAllForwardings=yes` prevent agent, X11 and port
forwarding to the VPS. Host-key verification, jump hosts and authentication order retain the user's
SSH configuration. Clarvis leaves `StrictHostKeyChecking` to that configuration and forces
`BatchMode=yes`: an unknown host key, unavailable identity or locked key fails startup instead of
asking for input after OpenTUI owns the terminal.
The SSH child receives only home/path, platform process-discovery, local agent and askpass/display
variables from the client environment. Provider keys, Clarvis OAuth values and unrelated variables
are absent, so OpenSSH `SendEnv` cannot forward them. The already-pinned remote process supplies the
canonical workspace identity during hello; the client does not resend the operator's raw path.

Before opening the TUI, establish the host key and verify noninteractive login with the same alias,
for example `ssh -o BatchMode=yes user@host true`. Use a key, certificate or hardware-backed identity
that OpenSSH can use without prompting; unlock protected keys in `ssh-agent` first. The wire receives
no second Clarvis encryption layer; prompts, events and results are confidential and
integrity-protected in transit by SSH, while the authenticated remote account can read them after
decryption. Both local and remote Code hosts apply the product's `exec` tool-grant ceiling by default;
an explicit `CLARVIS_AGENT_TOOLS_MAX_GRANT` on the machine hosting the kernel still narrows it.

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
suitable for scripts and CI. Interactive `ask_user` prompts are
auto-denied with a note on stderr, so a headless run can never hang. Without
`--agent`, it uses the same configured-default, runnable-`marshall`, runnable-Lead
resolution as the TUI and fails clearly when no interactive entry agent exists. Its kernel, like
the interactive path, is opened through `WorkspaceClientManager` for the selected local or SSH
destination.

`--resume` with an unknown id and `--continue` in a workspace with no sessions
fail fast with exit 1 before the terminal is taken; `--continue` only ever
resumes a session of the current workspace.

Sessions and runs are persisted through kernel services. The UI can resume a
specific session or continue the most recently used one.
Each turn stores the process-pinned Extension Profile id and fingerprint. Resuming under a different
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
in-TUI selector or runtime switching. A newly created checkout branches from the commit at `HEAD` of
the checkout that launched Clarvis, even when that is a linked worktree or a detached `HEAD`; the
primary checkout only anchors the destination. A new branch also records no upstream, so `git push`
inside the checkout never inherits the remote default branch. Reopening and branch reuse preserve the
existing history, no fetch runs, and uncommitted source changes are never copied. When an interactive
launch selected a managed worktree and that checkout is clean, exit asks whether to remove the
checkout or keep it. Removal is explicit, first asks the host to retire admission, which is refused
while hosted work remains occupied. It then closes the workspace and completes outside the platform's
bounded shutdown path, rechecks cleanliness, uses `git worktree remove` without force, and preserves
`clarvis/<name>` so a clean tree with unmerged commits cannot lose its branch. Clarvis removes an
empty parent only for its canonical `.clarvis/worktrees/` location; an externally registered
checkout's parent remains untouched. A dirty checkout exits without offering removal.

Settings saves are serialized by the adapter and carry the exact source revision returned by the
kernel. Another process editing the same scope produces an explicit conflict; Code never retries by
blindly overwriting the newer source. Reloads, workspace-trust changes and repairs share that same
state-publication queue, so an older slow response cannot replace a newer cached view or agent list.
After an idle workspace-trust approval or revocation recomposes the kernel Extension Profile, the run
client refreshes its cached `{id, fingerprint}` immediately; the next turn and resume comparison
therefore use the post-transition snapshot without requiring a reconnect.

The header carries the selected branch and keeps the root-manifest product version in a fixed
right-aligned zone. `--continue`, `--resume`, `--list` and `--delete` operate only on this process's
selected workspace.

Session persistence is optimistic in the UI and serialized per session in the
background. Shutdown waits for pending writes, and persistence failures are
shown in the status line. Session switches invalidate older asynchronous resume
operations, so a slow resume cannot replace a newer session.

Transcript exports pass the raw owner id to `@clarvis/paths`; the export
directory builder encodes it at the path boundary, so an owner id cannot select
a directory outside the global `exports/` tree.

## Main features

- One Lead-only main transcript plus one explicitly selected, isolated sub-agent transcript. Each
  delegation contributes exactly two friendly Lead-owned lifecycle markers to the main flow: one
  immutable `spawned` marker from `delegation_created`, then one separately appended immutable
  `completed` or `failed` marker when it settles. `delegation_started` adds no row. Child-owned
  cards, tools, reasoning and answers remain outside the Lead projection; selecting a worker from the
  Sidebar swaps the projection to that worker alone.
- Provider-declared commentary assistant turns retain their full Markdown body without a synthetic
  `update` marker; final answers keep the ordinary assistant presentation, and absent phase metadata
  never causes the client to synthesize text. Running and settled assistant prose use the same
  static bullet; progress animation belongs to the composer-adjacent activity line and running tool
  rows, not to already-painted Markdown history.
- Delegation briefs and terminal sub-agent results are absent from the Lead transcript. Its two
  lifecycle markers contain only bounded, friendly identity/status copy; the settled marker never
  rewrites the spawned marker. The Sidebar keeps each agent to one glyph-and-title row inside its
  own bounded scroll; clicking an agent selects its isolated transcript and does not open result
  detail automatically. Inside that
  isolated transcript, the first explicit selection expands that child's section so its delegation
  card and worker tools/answers are immediately readable. A manual collapse remains sticky across a
  return to Lead and reselection, while a sibling still receives its own one-time expansion; neither
  path changes Lead/global fold preference. An explicit detail affordance may open the original
  content in the scrollable Markdown modal.
- The delegation capability's generic `capability_event` wire mirror is suppressed rather than
  producing a duplicate third row. Only typed delegation lifecycle events own the two Lead markers,
  Sidebar/footer state and the selected child's isolated transcript.
- Provider tool plumbing for Lead-owned supervision, spawning/delegation and workflow orchestration
  is also transcript-silent in every phase. Composing, started, streaming-output and terminal rows for
  `spawn_subagent`, `delegate_task`, `agent_list`, `agent_poll`, `agent_stop`, `agent_steer`,
  `await_agents`, `run_leader`, `run_workflow`, `run_round`, `run_work_items`, `workflow_status` and
  `workflow_decide` never mount in the
  Lead transcript; this includes transient copy such as `Wait for agents starting…`. Typed delegation
  events remain the sole owner of the two lifecycle markers, while workflow state remains
  Sidebar-only. Ordinary Lead `thinking`/`working` state occupies one fixed activity line
  immediately above the composer, outside the transcript ScrollBox; child-owned tools/content remain
  available only in that child's selected transcript.
- The combined activity Sidebar has one responsive owner: a wide split from 100 columns, or — below
  that threshold (24 to 99 columns) — a whole-region panel opened on request. It has
  three independent, once-per-execution automatic reveal intents: the first live Plan reveals
  **Plan**, the first workflow state or leader reveals **Parallel work**, and the first delegation reveals
  **Agents** while Lead remains selected. Repeated updates of the same kind do not flap the layout;
  closing an automatically revealed section is sticky for that intent, while the first event for a
  different section may still reopen and reorient the Sidebar. Each section is one native ScrollBox
  child, so a later section is scrolled fully into view even when a long Plan precedes it. **Below the
  split no automatic reveal opens anything**: activity is stated as one summary line below the
  transcript (`Goal Completed · Plan 1/2 · Agents 0/1`), the intent is spent once so widening cannot
  replay it, and its section is preferred by the next explicit open. A width that stops supporting the
  split collapses a surface only an automatic intent had opened; a surface the reader opened survives
  at full width. The summary states canonical group facts only — never titles, paths, task lists or
  token metrics — wraps whole facts into at most two rows (one on short terminals) and sheds settled
  work before in-flight or attention facts. With the
  Sidebar closed, the aggregate transcript stays unobstructed. `Ctrl+X S` reopens the first available
  Agents, Parallel work or Plan section and closes the surface when it is open, naming the same
  effective binding the summary strip shows. The footer never
  duplicates agent, workflow or Plan status; `Ctrl+X S` and automatic reveal own access to the
  responsive surface. Plain Tab follows the active
  screen's focus order and, at shell level, returns transcript block focus to the composer without
  changing Lead/child selection; Return activates or submits the currently focused component.
  Shift+Tab opens the agent picker, and clicking an agent selects only that agent's transcript.
  Agent progress reports only settled/total and the running count while work is active; failures
  stay encoded in each row's status glyph instead of adding header or result copy. Workflow progress
  never contributes a row to the Lead transcript. Agent and workflow rosters use the Plan's status
  priority—running, pending, done, then failed—without changing their stable handles. A sub-agent
  row keeps the cause the delegation wire carried: `done`, `limited` (a budget cap ended it with a
  partial), `cancelled` (the run took it down) and `error` (a technical failure), with `limited`
  sorted as unfinished work and `cancelled` sharing the settled bucket. A child stopped at its own
  iteration limit is therefore a different row from a child that broke, and neither the roster nor
  the settled marker calls the first one a failure. Workflow leaders use run-local `L<n>` handles and sub-agents use the
  separate `A<spawn order + 1>` namespace; both derive from the current projection and retain no
  native-id allocation ledger across runs.
  Opening the Sidebar never replaces the shortcuts or run strip below the composer. A fixed
  line inside the Sidebar names `Ctrl+X S` for opening and closing it.
- Plan activity has no lower pane between history and the composer and contributes no footer text.
  Its complete operational view remains in the Sidebar or the `Ctrl+X P` plan surface; its first live
  projection may reveal the Sidebar once for that execution. The Sidebar's compact task list shows
  only each status glyph and title, prioritizes running and next work above completed and failed work,
  omits the result-preview panel, and appends `[Ctrl+X P] full plan` to the progress line; assignee,
  exit-condition and result detail remain in the full plan surface. The fixed Lead activity line reuses the
  same physical row for `thinking` and `working`, leaving it blank when idle without meaningful detail; during a run that row also owns
  elapsed time, iteration and the active `run.cancel` binding (`Ctrl+C` by default) to interrupt. Slash autocomplete replaces the whole activity
  band while it is open. Transient activity therefore never enters history or changes transcript
  height, and run-local timing never competes with Context or cumulative Session usage in the
  footer.
- End returns to the latest bounded transcript window and resumes follow; the off-tail reading
  indicator provides the same pointer action.
- One transcript projection renders stable row IDs for composing, pending, running and terminal
  records. Results are sealed into bounded immutable copies without freezing live reactive nodes,
  then remain in the same row owner across later iterations and restored turns.
  Explicit exploration groups exist from their first read/search call; shell, mutations
  and unknown MCP tools stay individual. Each open group mounts one page of 20 members.
- One native ScrollBox owns sticky follow, culling and semantic row anchors. Short projections mount
  at most 80 rows; long projections normally mount 40 with 20-row paging and an 80-row transition
  ceiling. Resident-list changes are coalesced to native frames. The reader can leave the tail while
  data continues; prepend, folds and width changes preserve the row reference after native layout.
  End explicitly restores tail follow. Lead and children share this viewport, never hidden trees.
  Each projection retains independent reading and expansion state. The contract is in
  [code-transcript-stability.md](../../specs/hosts/code-transcript-stability.md).
- The transcript retains the latest 20 complete turns, live and after resume. Retention replaces
  discarded records with one frozen folded-prefix notice and releases associated identity/UI state.
  `/export` reloads folded turns one trace at a time; the viewport does not invent infinite backfill.
- Markdown keeps incremental segmentation and bounded native syntax settlement. Oversized bodies
  use the existing plain-text recovery notice. Terminal controls and ANSI are stripped before native
  rendering. Per-field tool caps and the 512 Ki-character aggregate mounted-text cap remain in force.
  The three-row reading runway (one row at compact height) remains inside the ScrollBox; Lead
  activity, composer and footer remain outside it.
- Individual user/assistant/reasoning prose nodes retain at most 2 million characters and append an explicit
  truncation notice. This cap is applied before the value enters Solid/OpenTUI state, including the
  authoritative iteration-complete replacement, so one extreme provider response cannot dominate
  the interactive process. Reasoning shown beneath the `thinking` label removes Markdown presentation
  delimiters from its plain-text projection; user and assistant presentation paths are unchanged.
- Mutable user/assistant/reasoning prose also shares a 64 MiB UTF-16 budget. Old settled mutable
  prose is replaced by an explicit `/export` recovery notice; each immutable published copy already
  contains only the at-most-512-Ki-character inline projection and leaves residency only with its
  complete retained turn batch. Streamed/running prose and the newest update are never evicted
  mid-write.
- Mutable tool bodies are retained under a 200-call window, a 64 MiB estimated aggregate heap budget
  and a 32 MiB single-body ceiling. Published history freezes only the bounded inline projection;
  older raw arguments, results, diffs and errors are reloaded from the
  persisted run on demand through two concurrent reads and an eight-item queue; a body beyond the
  ceiling stays persisted and gives an explicit `/export` route instead of defeating the bound.
  Expanded live rendering separately caps each arguments/result/diff/error field at 64 KiB before
  any parser or native renderable sees it; immutable publication freezes that bounded projection plus
  its header signature. Collapsed live headers and grouped member lists keep that resident signature
  after the body is dropped, so a still-running sub-agent's finished tools still name their paths.
  Shell signatures show the command but omit the execution `cwd` from transcript chrome.
  Markdown export includes the bounded, renderer-safe argument projection even
  though the live transcript intentionally mounts no raw argument panel.
- Successful mutations start folded. Explicit expansion wins over defaults across settlement,
  window disposal and child navigation. Their bounded native diff remains available on demand.
- Failed tool calls are folded by default: their red failure mark and call identity remain visible,
  with a short sanitized diagnosis on the next row; expansion reveals the bounded full body. A
  collapsed failed group likewise renders one aggregate failure row rather than repeating each
  member's error. Nonzero shell results follow the same folded presentation and keep their parsed
  `exit N` diagnosis visible.
- A live controllable builtin shell, including one that yielded a session ID, exposes `[X]` immediately after its elapsed time without folding its row or cancelling
  the run. The focused eligible shell also accepts Ctrl+X then T; elicitation and a rebound
  protected cancellation shortcut take precedence. After a click, the muted `[X]` remains stable and
  ignores repeated clicks while waiting for the authoritative tool terminal, not merely an accepted receipt. Only an explicit operator interruption in that terminal
  renders `Interrupted by operator`; scope closure or abandoned argument composition retains its
  actual diagnostic instead. See [transcript interruption](../../specs/hosts/code-transcript.md#47-provenance-and-interruption)
  and [run hosting](../../specs/hosts/code-run-host.md#selective-shell-interruption).
  A yielded shell removes `[X]` when its physical session settles, even if the run continues.
- Session persistence keeps one physical write and only the newest queued snapshot per session, so
  a slow filesystem cannot retain the quadratic sequence of every growing turn list. At most eight
  idle complete session documents stay cached; older entries demote to catalog summaries and reload
  only when selected.
- Persisted Session token totals are maintained incrementally once per settled run. During a run,
  the footer combines a frozen full-session baseline with only `ActivityStore.currentUsage`; the
  separate resident-window aggregate never substitutes for the complete session or double-counts
  settled history after more than 20 turns. The new live sink claims a zero delta before first paint,
  so the previous run cannot briefly appear twice while `run_started` is still in flight.
- The canonical footer keeps gross Context plus cumulative `Session` input/output, prompt-cache hit
  percentage and cost available before and after a run settles (token totals and cache percentage
  appear in the wide band). Goal stages, ordinary runs and Goal auxiliary work accumulate in the same
  Session cost field. It does not repeat
  `Running`, elapsed time or iteration there; those live-run facts sit beside `thinking`/`working`
  immediately above the composer, where the current phase leads and the details after it stay muted.
  When a full-region page (Plan, Diff, a view) owns the reading area, that activity line prefixes
  `Run` so its facts are not read as the page's. `/status` and Sessions expose the same session-level totals for
  explicit inspection.
- **Every `In` token count on screen reports input the provider had to read** — the gross prompt less
  what its prefix cache served (`uncachedInput`, and the run strip's own subtraction from
  `UsageActivity.cached`). The adjacent `Cache hit` percentage uses `cached / gross input`, scoped
  independently to the projected Run or cumulative Session; it never divides by the already-net
  `In` value. Pricing keeps the gross figure, because a cache hit still costs a reduced rate; the
  count beside it answers a different question, and on a long session the two differ by an order of
  magnitude. `Context` is the one figure that stays gross: a cached prefix still occupies the
  window. The per-iteration split reaches the client on
  `iteration_completed.cached_tokens`, which is optional. A numeric zero is a measured zero; if any
  positive-input contribution omits the split, `cached` remains absent through live aggregation,
  session persistence and resume. The strip then states gross `In` and omits `Cache hit` rather than
  subtracting a known subset or guessing `0%`.
- The activity sidebar does not retain a second copy of each full delegated brief. It keeps at most
  64 terminal summaries of 512 characters; complete child task and result detail remains in that
  child's explicitly selected isolated transcript and in the persisted run.
- Hidden sub-agent event detail bypasses the Lead transcript store. The TUI keeps a bounded live
  event tail and only one selected child transcript; switching away releases that projection.
  Selecting the child reloads its full persisted history, while a failed reload stays local and can
  be retried by reselecting. Session export reloads hidden child detail from the persisted run and
  marks an unavailable record as incomplete. See
  [transcript stability](../../specs/hosts/code-transcript-stability.md) and
  [run host](../../specs/hosts/code-run-host.md).
- Tool-call, diff, reasoning, plan and budget views.
- A tool appears as soon as its name is known. While the provider composes a large argument payload,
  its one mutable row says `waiting for arguments` until the first argument byte arrives, then shows
  a throttled cumulative character count. A separate `stream N chars` total shows text, reasoning,
  and tool-input progress for the physical provider attempt, so continuing SDK activity remains
  visible even when argument bytes are unavailable; neither counter retains a history.
  `tool_input_end` changes that row to `arguments ready` without claiming the filesystem or command
  action ran. A distinct
  `tool_call_started` begins execution, and only terminal `tool_call` marks its outcome. Starting a
  second tool does not close the first because parallel composition is valid. Retry removes the
  abandoned attempt's composing row before showing the retry state.
- Transcript blocks use the full available content width while the inspector is closed and the full
  remaining pane width beside an explicitly opened split; the old 110-column reading cap no longer
  applies.
- Session browsing and continuation.
- User elicitation during a run.
  A model-originated `ask_user` question arrives with a 30-second decision window (`window_ms`,
  declared by this frontend as `elicit_policy.ask_user_window_ms`): the block confirms its own
  presentation once it is really laid out in the viewport, and shows one discreet line counting the
  kernel's projection down — `The model decides in N s.` — only once that confirmation has been
  answered, so a question the kernel did not project carries no countdown instead of a declared one.
  At zero the line becomes `No response in
time; decision returned to the model.` and that question's form, choices and decision commands are
  retired, because the kernel owns the outcome: it settles the question and reports the closure by
  id, which removes the block without this frontend answering an already-settled id. Its settled
  transcript annotation reads `no answer: …`, never `answered:`. Typing, focus,
  remounting or reconnecting never extend the window, and no partial draft, default option or
  synthetic answer is ever submitted. Plan and workflow reviews and relayed MCP
  questions declare no window and render no countdown. See
  [elicitation](../../specs/cross-cutting/elicitation.md) and
  [input and overlays](../../specs/hosts/code-input-and-overlays.md).
  An iteration-budget question is presented as `iteration limit` in the modal and its settled
  transcript notice; the engine's soft-budget vocabulary and non-iteration dimensions remain unchanged.
  If a confirmation arrives while the reader is browsing older history, Clarvis explicitly returns
  that physical reader to the live tail before replacing the composer with the question. The
  composer remains painted but keyboard-inert until the question owns a visible transcript row, so
  there is no intermediate frame containing neither interaction surface. A dirty configuration
  page pauses that transition without polling renderer frames; closing the page restarts it from the
  retained request. Each `returnToTail` mounts the newest slice and scrolls to the native bottom;
  `App` repeats that after the elicitation layout frame. Native sticky-bottom remains the follow
  authority. Resolving or cancelling the question requests the changed tail geometry again before the
  composer returns.
- `/compact [request]` to compact the context used by the next model call, whether a run is active
  or the latest session turn is already settled.
- Skill slash commands and prompt injection.
- Execution-memory review and curation.
- Provider-backed task board, detail and current-workspace **Work on task** flow.
- Provider, model, plugin and MCP-server configuration.
- Contextual action Help, slash-command discovery and per-terminal Keyboard Profiles.
- Local `!bash` commands and workspace attachments. The composer admits at most four images,
  5 MiB each and 10 MiB aggregate. Binary clipboard input is rejected before base64 expansion;
  workspace images resolved from `@path` are checked against the same per-item and aggregate limits
  before a run or steer request starts.
- The composer sends with unmodified Enter and inserts a newline with Ctrl+J on every keyboard
  profile. Enhanced profiles also accept Shift+Enter; portable profiles do not advertise that chord
  because legacy terminals and multiplexers can erase its modifier before Clarvis receives it. The
  composer grows from visual soft wraps as well as explicit newlines up to its bounded inline height.
  Unbroken long tokens wrap by character, so continuing to type never hides the draft prefix.

Steering submitted while a run is still starting waits for the kernel handle
instead of being dropped. A successful steering response now means the loop drained the message,
not merely that an in-memory queue accepted it. If the run settles before that drain, the draft is
restored and the transcript keeps one visible `Steer not delivered` receipt through stored-trace
reconciliation. Once the run result settles, the composer immediately
leaves steer mode and a subsequent message starts a new turn. Post-run memory
indexing may keep the event stream physically open and continue updating the
status line, but it never keeps the footer `Running` or routes user input to the
settled run. Likewise, completion of a cancelled `!bash` job from an outgoing
session cannot overwrite the current session's status.

The retained Catalog Picker and elicitation soak cases discard 220 and 400 finite warm-up cycles,
respectively, before the measured 100-cycle window. Their 5 MiB/100 production ceiling and
deterministic owner-balance gates are unchanged; the larger per-case warm-up isolates steady-state
retention from OpenTUI/native allocator arena growth during initial traversal.

`/compact` performs a forced pass while retaining the configured recent tail. During a run it queues
the pass before the next model call. After a run it rewrites that run's persisted `final_context`
immediately, so the next continuation starts smaller. `/compact <request>` adds the text to the
agent's own compaction prompt; it does not steer the agent or add a conversation message.
The Lead activity line reads the live compaction lifecycle: it shows `compacting context` in place
of `working` or `thinking` only after a queued pass actually starts, or while a settled-context
request is awaiting its direct result. Terminal events clear the state, and replayed start signals
cannot reactivate it.

Changing `/model` while a run is active is refused until that run settles. If the selected model's
safe context limit is smaller than the latest persisted continuation, the picker shows the estimated
current size and new limit and requires explicit confirmation. Acceptance mechanically evicts older
context first and saves the model only after the replacement fits; cancellation or fitting failure
leaves both model and context unchanged. A successful save requests an idle generation reload so the next run uses the selected model.
A refused reload keeps the committed save visible as pending reconnect instead of claiming that it is active.

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

Settings > Agents uses the same compact detail styling as Plan, Goal and Workflow. Profile rows
show name, role and source scope; the editor keeps stable one-line fields while moving selection.
Description and Instructions show `view / edit` and open a scrollable reader, where `e` edits;
empty fields open editing directly. `i` opens field provenance. Shared prompt follows the same
reader flow, with its save path shown once in details and disable/restore actions on its overview.
Errors and conflicts remain visible; routine runnable messages and repeated per-field origins are
omitted. Draft saving, scope retargeting and inherited configuration retain their existing rules.

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

For testing this checkout from arbitrary project directories without rebuilding after source
edits, use `./dev-install.sh`. It requires the exact Bun version from `mise.toml`, performs
`bun install --frozen-lockfile`, installs the repository hook, and atomically writes a managed
`clarvis-develop` launcher to
`${CLARVIS_DEV_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}`. Re-running it updates that owned launcher;
an unrelated file, directory, or symlink at the destination is refused. `./dev-install.sh
--uninstall` removes only the launcher.

When the selected workspace still has a same-wire host from another installation, startup requests
an authenticated idle restart and continues with the new artifact. Physical work keeps the prior
host alive and the error directs the operator back to that installation until the work finishes.

`clarvis-develop --empty-workspace` allocates a different empty
`/tmp/clarvis-development-temp/workspace-*` directory on every invocation and starts Clarvis with
that directory as its workspace. `clarvis-develop --clear` and `./dev-install.sh --clear`
permanently remove the effective global Clarvis root (`$CLARVIS_HOME`, otherwise `~/.clarvis`) and
the authenticated `/tmp/clarvis-development-temp` tree before the next source run. Global-state
cleaning refuses the user home itself, any target outside it, a symlink, or a non-directory. The
temporary root must be owned by the current user and carry its exact management marker. Other
workspace `.clarvis` content remains out of scope. This destructive option is development-only; the
release installer continues to preserve global state on uninstall. Bare `--clear` exits after
cleanup; combine `--clear --empty-workspace` to clean and immediately start a fresh test workspace.

This package is outside the monorepo's `tsc -b` reference graph — Bun executes the TypeScript and
TSX source directly and nothing is emitted for consumers — but it **does** have a package build:
`bun --filter @clarvis/code build` (`packages/code/tooling/artifact/build.ts`) produces the distributable bundle. From the
repository root, `bun run build` runs the TypeScript library graph and then this bundle; use
`bun run build:code` when only the TUI changed.
`bun run clean` removes package build outputs, including the Code bundle, before a fresh build.

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
- **The bundle is package-local, not standalone by itself.** `packages/code/tooling/artifact/build.ts` keeps
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
step that covers it. Artifact, release and first-paint smoke use `createSmokeFixture` and its
`SmokeContext` (`packages/code/tooling/artifact/isolation.ts`), not an ambient or merely renamed
HOME. The context owns a short, exclusive, account-owned temporary root containing HOME, `CLARVIS_HOME`,
workspace, cache, logs and managed-install paths; `environmentFor` passes an allowlisted environment
to every child and rejects root-sensitive overrides outside the fixture. That root is never the inherited
`TMPDIR`: its candidates are the host's short temporary roots filtered by the account-owned ancestor chain
the kernel re-checks for its own private state, and a host offering none fails with
`smoke_fixture_no_usable_parent` rather than landing somewhere unpredictable. Sockets are a reserved
resource: `socketPath(label)` builds an exclusive address inside the root whenever the endpoint budget
allows it and otherwise from a short root of its own, taken from the same validated parents followed by
the host's short temporary roots, and a host where none of them can hold an address fails
`smoke_socket_root_unavailable` instead of starting a backend that cannot bind. `writableRoots` declares
the socket root as an extra mount for confinement, and cleanup removes it after the children settle. The
fixture lifecycle terminates registered children before removing its roots. It asserts the shipped snapshot
exists for a later Providers open, and proves first paint emits no `catalog.load.started` while
`deferred_catalog` remains true.

The normal smoke mode isolates environment and filesystem state. The opt-in native mode requires a
working Bubblewrap probe, mounts only selected runtime/checkout roots read-only, masks `.clarvis`,
`.agents` and `.git`, disables network, and fails as unavailable instead of falling back to an
unconfined PTY. `script(1)` and tmux both use the fixture environment; tmux receives the fixture's
reserved socket through `-S` and every capture and `kill-server` command names that same endpoint.
Installer smoke copies release inputs into the fixture and refuses Windows User `Path`
coverage unless a disposable account is explicitly proven. The regression coverage is
`packages/code/tests/unit/artifact-isolation.test.ts` plus
`packages/code/tests/unit/benchmark-isolation.test.ts`, which executes the benchmark's version arm
against a real Bun child and checks the observed fixture roots. The release/installer/PTY contract
canary is `tooling/tests/unit/harness-isolation-contract.test.ts`; installer smoke has also passed
the current Linux archive journey, while the artifact and release PTY journeys remain subject to
the host private-state ownership check described in `specs/known-issues.md`.

`bun run bench:code` measures the launch: the module graph (`--version`), minimal shell, focused
startup composer, complete header and complete input-ready frame, n≥7 with min/median/max.
It refuses to report on a busy machine and stamps the power state, because CPU
frequency scaling moved one unchanged measurement from 2.05 s to 0.60 s and three
conclusions had to be withdrawn over it.
The repository's [Clarvis TUI validation
skill](../../.agents/skills/clarvis-tui-validation/SKILL.md) selects focused, full-audit, or performance
work. Its performance mode scopes startup, extension comparisons, real-run latency, OAuth, drift,
and retention checks to the investigation and reuses valid artifact evidence across modes.

An MCP that cannot connect while a run opens its tool pool remains represented by the persisted
`mcp_degraded` diagnostic event, but Code does not publish that event into conversation history. The
live shell shows each newly observed `{ server, reason }` failure once as a transient warning; replay
and resume do not repeat it.

The file kernel handles skill drift on the same non-conversational surface. It monitors the
process-pinned skill manifests/resources outside run admission; when one changes, that skill is
withheld until reconnect and Code shows `Skill '<name>' changed on disk and was withheld from runs
until reconnect` as a transient warning. The user message and the next run continue normally, and
the notice is never written into transcript history. A selected plugin whose captured executable
files drift receives the parallel `Plugin '<name>' changed executable files` warning while its
runtime MCP/hook projections are withheld.

The workspace header reports effective Isolation. Settings >
Run controls owns the persisted global Host or Sandbox choice alongside the `Ctrl+X I` quick picker.
Host follows OS permissions; Sandbox reads host-visible files but limits writes to
its declared roots. `workspace-read-only` keeps the workspace read-only even below a writable
temporary root. A Sandbox command may use an accessible directory outside the workspace as `cwd`.
The panel's effective access line follows host inspection when an untrusted workspace requests a
weaker Sandbox than the global policy; Run controls, Doctor and the quick picker use the same
observation for effective placement, while editable rows still show the requested settings. When
idle, selecting a placement reloads the workspace connection. The picker shows its save/reconnect
phase until admission completes. Host selection requires the explicit danger confirmation.

Local and SSH destinations remain available through `WorkspaceClientManager`. Their settings,
Agent, prompt and model-catalog writes stay with the selected host; `/model` attempts an idle reload
so the next run uses the saved configuration. No elicitation changes placement.

`bun run bench:code-overlays` runs the renderer lifecycle soak. Every named case and default
120x32/80x24 size gets a fresh process, warm-up, forced-GC batch samples and RSS/PSS/private-dirty plus live renderable, renderer
lifecycle-pass, key-layer and cumulative layer-registration counters. Set
`OTUI_NO_NATIVE_RENDER=true` to label and run OpenTUI's official no-native-frame control.
Pass case names after `--` to run a subset; `OVERLAY_SOAK_{CYCLES,BATCH,WARMUP,SIZES}` controls
the measurement. A parent watchdog kills a child after 120 seconds or 1 GiB RSS. Production cases
fail above 5 MiB PSS per 100 cycles on Linux (RSS elsewhere) or when live renderable, lifecycle-pass
or key-layer counts do not balance; the corresponding limits are configurable through
`OVERLAY_SOAK_{MAX_MIB_PER_100,WATCHDOG_MS,WATCHDOG_RSS_MB}`. The case set includes the production floating modals, pickers, activity sidebar,
elicitation, Splash, HintToast and an empty configuration page, not only primitive frames. The current
lifecycle keeps the transcript shell mounted, paused and input-inert behind every full-region
configuration, Workflow, Plan and Diff page. Diff and Plan are lazily retained after first use;
configuration frames remain bounded by their stack and dispose when popped. Agent Profile Picker,
Isolation Picker, Review Picker, Catalog Picker and a bounded ten-slot
autocomplete projection are also retained lazily.
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
animates only its first activation; reopening it reveals the settled retained tree instead of
restarting the timeline. Its optional JSX navigation is resolved once, so one card owns one
responsive navigation subtree and one corresponding renderer resize subscription. Non-portal
regions may still use `dispose-on-close`. Configuration pages
keep their stricter stack semantics: inactive parents remain mounted, but popped frames are disposed
rather than cached.

Because OpenTUI requires a PTY, use `bun run smoke` for the repeatable bundle boot assertion and the
`tui-driver` skill for interactive reproduction. Do not launch the app through plain redirected
stdin and treat that as a renderer test.

## Prompt-cache continuity

Session metadata round-trips the persisted leader instance through the kernel. Starting another turn sends the session identity and lets hosted preparation retain its agent identity, keeping provider affinity stable after restart.

Hosted admission bounds and redacts its display preview independently of the full prompt. Long
messages remain intact in the model request and do not exceed the host's 4096-character preview
limit.

See the [prompt-cache contract](../../specs/cross-cutting/prompt-cache.md) for replay, identity
validation and separate deterministic, live-provider and installed-artifact qualification.

Agent Profile frontmatter uses the closed kernel schema. Unknown keys mark a document invalid in the editor and are rejected on write and execution admission; they cannot become executor overrides.

The application header and action footer wrap with terminal width. Narrow layouts retain
configuration fields and available footer actions on additional rows; shared Ctrl+X
hints repeat their modifier prefix on each continuation row, and an action with an authored shorter
wording uses it before its segment is dropped. Every band is admitted by the cells its own container
really offers — a detail frame subtracts its padding and pinned status, a picker card its border,
padding and footer text — while the seat cap stays keyed to the terminal, and a card never paints
wider than the screen. A tool call's identity, a changed file's name and an error's diagnostic
break onto another row instead of being abbreviated away; the argument _preview_ in a tool header
keeps its own explicit character bound. Help shows full key combinations.

Hosted submissions remain local until admission is confirmed. `beginTurn` does not advance hosted
semantic history or its continuation base; canonical adoption does. Pending host recovery retains
the message, and an admission failure is not presented as settlement of an executed turn.
Resume remains available for terminal Goals and healthy running attempts. A pending resume retains
its operation identity; the explicit recovery action retries that operation after recovery.

The Goal panel offers physical recovery for a pending resume and links a required limit edit to that same request. Transcript synchronization compares ordered turn identities and preserves the matching resident prefix.

Accepted pending input can be resumed through `HostingService.resumePending(sessionId)` using the
current authenticated operator connection. The Kernel reads canonical receipts and uses its existing
idempotent admission queue; it restores no old consent or physical-closure claim. Code requests this
when reopening an idle conversation and attaches to the admitted run. Recovery failure leaves the
saved history readable. A restart without a new controller still waits for authority.
