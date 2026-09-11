# Clarvis TUI product coverage matrix

This is the minimum baseline for [full-audit mode](full-audit.md), not a checklist to load for every
focused regression. Reconcile changed surfaces with current source and tests. Add newly discovered
surfaces and remove obsolete entries. Record one verdict and proof method per scenario ID, even
when several share a fixture. A row with only partial proof remains partial; an inventory count or
passing lower-level suite does not establish execution of its E2E requirements.

## Inventory and provenance

| ID       | Scenario                               | Minimum proof                                                                                                   |
| -------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `INV-01` | Current checkout and artifact identity | Branch, full commit, worktree state, exact source and bundle launch commands                                    |
| `INV-02` | Public slash command inventory         | Live registry, autocomplete and Help agree; dynamic skill and MCP prompt commands included                      |
| `INV-03` | Settings and domain hub inventory      | Every live hub row and deep link has a scenario or explicit unavailable verdict                                 |
| `INV-04` | Interactive CLI entry inventory        | Current flags that boot, resume, continue, select a profile, debug, render ASCII or open a worktree are covered |
| `INV-05` | Keyboard and pointer inventory         | Portable/enhanced/manual bindings, protected actions, terminal environment and mouse routes mapped              |
| `INV-06` | Test environment                       | Bun/OpenTUI, OS/arch, terminal, dimensions, color mode, fixture versions and isolation roots recorded           |

## Boot, first paint, onboarding, and recovery

| ID        | Scenario                                      | Minimum proof                                                                                                                    |
| --------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `BOOT-01` | Clean interactive source boot                 | Startup composer is focused and usable before complete-app paint; no installed release is invoked                                |
| `BOOT-02` | Early submitted task                          | Exact draft survives root replacement and starts once a runnable host exists, without a second Enter                             |
| `BOOT-03` | Early draft without a runnable provider/agent | Accepted or unsent text becomes the complete composer's exact draft rather than disappearing                                     |
| `BOOT-04` | Resume and continue boot                      | Startup input stays locked until the saved session is restored; unknown or absent sessions fail before taking the terminal       |
| `BOOT-05` | Shutdown during foundation load               | No late run admission or complete-app mount; raw mode and alternate screen restore once                                          |
| `BOOT-06` | Fatal boot and retry                          | Visible cause, bounded retry, correct Ctrl+C ownership, no orphan work                                                           |
| `BOOT-07` | First paint across size classes               | Wide, narrow, single-column and below-layout-floor behavior is legible and non-crashing; refresh thresholds from `app/layout.ts` |
| `BOOT-08` | Final bundle boot                             | `bun run build:code` and `bun run smoke` pass; source-critical checkpoints repeat without `CLARVIS_CODE_SOURCE`                  |
| `ONB-01`  | First-run welcome to Ready                    | Provider, model, credential, default seeding, agent selection and final state succeed without rendering the secret               |
| `ONB-02`  | Cancel provider or model selection            | Staged values remain unsaved and navigation returns predictably                                                                  |
| `ONB-03`  | Failed save and retry                         | Failure remains visible and mounted; retry completes once without duplicate writes                                               |
| `ONB-04`  | Compact first-run layout                      | Splash/picker thresholds preserve usable rows, focus and escape routes                                                           |
| `ONB-05`  | Recovery and Doctor fixes                     | Missing, invalid or unusable configuration routes to an actionable repair and then to a runnable app                             |
| `ONB-06`  | Personal subscription setup                   | Device flow cancel, pending, completion, reauthentication and disconnect are verified when authorized; otherwise unverified      |

## Composer, autocomplete, attachments, and local shell

| ID      | Scenario                            | Minimum proof                                                                                                         |
| ------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `IN-01` | Submit and multiline editing        | Enter sends; Shift+Enter and Ctrl+J insert newlines; Unicode, paste, selection and cursor edits are preserved         |
| `IN-02` | Wrapping and composer growth        | Soft wraps, explicit newlines and long unbroken tokens keep the draft prefix visible within bounded height            |
| `IN-03` | Slash completion                    | Bare `/`, fuzzy search, argument completion, subcommands, accept, dismiss and scrolling remain stable                 |
| `IN-04` | Workspace mentions                  | `@path` completion, spaces, missing paths, confined resolution and large workspaces behave predictably                |
| `IN-05` | Image input                         | Clipboard and `@path` images enforce count, per-item and aggregate limits before run or steer starts                  |
| `IN-06` | Local `!` command                   | Success, nonzero exit, spawn failure, cancellation, long output and stale completion after session switch are correct |
| `IN-07` | Steering while a run starts or runs | Input waits for the handle, reaches the intended run once, and leaves steer mode immediately after settlement         |
| `IN-08` | Draft survival                      | Opening/closing overlays, resize, reconnect, model refusal and recoverable errors do not lose or duplicate the draft  |

## Navigation, keyboard, pointer, and responsive layout

| ID       | Scenario                        | Minimum proof                                                                                                                      |
| -------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `NAV-01` | Escape hierarchy                | Autocomplete, modal, picker, detail, hub and page dismiss/back immediately in the correct order                                    |
| `NAV-02` | Escape during async replacement | Escape stays live while preview/install/apply/reconnect/refresh settles; stale completions cannot reopen or mutate newer state     |
| `NAV-03` | Ctrl+C hierarchy                | Active work cancellation, repeated quit guard, fatal boot and idle behavior are distinct from Escape                               |
| `NAV-04` | Focus and retained surfaces     | Opening, closing and returning preserves intended focus and reader position; inactive surfaces consume no input                    |
| `NAV-05` | Pointer routes                  | Click, wheel, retained rows and full-screen pointer guards match keyboard outcomes without accidental confirmation                 |
| `NAV-06` | Keyboard Profiles               | Portable, enhanced and manual profiles, diagnostic capture, reset and protected bindings behave in the active terminal environment |
| `NAV-07` | Resize transitions              | Repeated 200x50, 120x32, 80x24, 60x16 and sub-floor changes do not clip, loop, duplicate owners or lose state                      |
| `NAV-08` | Theme and glyph modes           | Dark/light/auto, themed/terminal background, color-depth fallback, contrast warnings, Unicode and `--ascii` are coherent           |

## Public commands and settings

Exercise each command from typed input and through completion. Verify unknown arguments, disabled
states, Escape/back, persistence, status feedback, and scope where applicable.

| ID       | Surface                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| `CMD-01` | `/help`                                                                                                            |
| `CMD-02` | `/tasks`                                                                                                           |
| `CMD-03` | `/agent`                                                                                                           |
| `CMD-04` | `/compact [request]` while active and settled                                                                      |
| `CMD-05` | `/debug`, `/debug off`, and valid/invalid levels                                                                   |
| `CMD-06` | `/workspace-trust` approve, revoke and inert workspace                                                             |
| `CMD-07` | `/storage` inspect, bounded preview, cancel and cleanup                                                            |
| `CMD-08` | `/sessions` browse, resume, new, export and delete                                                                 |
| `CMD-09` | `/workflow`                                                                                                        |
| `CMD-10` | `/diff` with and without available content                                                                         |
| `CMD-11` | `/plan` normal/review toggle and active-run next-run semantics                                                     |
| `CMD-12` | `/quit` and confirmation ownership                                                                                 |
| `CMD-13` | `/refresh` success and failure                                                                                     |
| `CMD-14` | `/model` selection, active-run refusal and context-fit confirmation                                                |
| `CMD-15` | `/effort`                                                                                                          |
| `CMD-16` | `/settings` and every current subcommand                                                                           |
| `CMD-17` | `/reconnect` recovery; `/reconnect reload` success, busy refusal and failure                                       |
| `CMD-18` | `/doctor` recheck, diagnostics and guided fixes                                                                    |
| `CMD-19` | `/extensions`                                                                                                      |
| `CMD-20` | `/activity`, `/activity plan`, `/activity workflow`, `/activity agents`                                            |
| `CMD-21` | `/clear` with active and settled state                                                                             |
| `CMD-22` | `/status`                                                                                                          |
| `CMD-23` | `/export` success, failure, path confinement and memory-fuse refusal                                               |
| `CMD-24` | Dynamic skill slash commands, including optional task and agent routing                                            |
| `CMD-25` | Dynamic MCP prompt slash commands, duplicate-name handling and refresh                                             |
| `CMD-26` | `/loop` duration/cron, list, pause/resume/cancel and live-session lifetime                                         |
| `CMD-27` | `/background`, list and targeted cancellation; exit only after receipt                                             |
| `CMD-28` | `/attach <execution-id>` and explicit control takeover in discovery                                                |
| `CMD-29` | `/goal` inspection, literal creation, reviewed edit/replacement, pause/resume/cancel/clear and host-started stages |

### Current Settings panels

| ID       | Panel            |
| -------- | ---------------- |
| `SET-01` | Providers        |
| `SET-02` | Feature backends |
| `SET-03` | Agents           |
| `SET-04` | Defaults         |
| `SET-05` | Memory           |
| `SET-06` | Sandbox          |
| `SET-07` | Theme            |
| `SET-08` | Keyboard         |
| `SET-09` | Updates          |
| `SET-10` | Run controls     |

For every panel, verify global and workspace scopes, effective-value labeling, scope switching,
revision conflicts, failed saves, stale responses, reset/inheritance behavior, and deep-link return
routes.

## Providers, models, agents, and runs

| ID       | Scenario                          | Minimum proof                                                                                                             |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `RUN-01` | Provider create/edit/remove       | Secret redaction, validation, catalog loading, scope, reconnect and failure recovery are correct                          |
| `RUN-02` | Model and effort changes          | Provider-native IDs, default authority, limits, cost/cache metadata and active-run restrictions persist correctly         |
| `RUN-03` | Agent selection and customization | Built-ins, partial customization, reset, invalid files, fork/rename rules and delegated defaults are represented honestly |
| `RUN-04` | Basic streamed run                | Unique submission, text/reasoning stream, usage, settlement and a subsequent turn occur exactly once                      |
| `RUN-05` | Tool-rich run                     | Tool call/result, shell group, file write/diff, plan and budget blocks remain legible live and settled                    |
| `RUN-06` | Elicitation                       | Prompt, focus, answer, cancel, handler failure and transcript outcome are correct                                         |
| `RUN-07` | Interrupted stream                | Visible recoverable error, preserved transcript/session, no false success and usable next turn                            |
| `RUN-08` | Cancellation race                 | Cancellation before handle, during stream, during tool work and at settlement has one terminal outcome                    |
| `RUN-09` | Transcript continuity             | Painted history keeps row/style while live content grows; Markdown settlement does not flicker or downgrade               |
| `RUN-10` | Scroll and tail ownership         | History admission, wheel/keyboard scroll, return to tail and new-submit tail selection preserve reader state              |
| `RUN-11` | Responsive transcript             | Full width without inspector, split width with activity, folded groups and narrow drawers avoid clipping or overlap       |

## Sessions, context, telemetry, and persistence

| ID         | Scenario                          | Minimum proof                                                                                                  |
| ---------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `STATE-01` | New, resume and continue          | Session identity, selected Extension Profile warning, transcript and next turn persist across process restarts |
| `STATE-02` | Rapid session switching           | Slow old resume/shell/export callbacks cannot overwrite the newer active session                               |
| `STATE-03` | Persistence failure               | Optimistic UI reports failure, shutdown waits boundedly, and stored state is not silently corrupted            |
| `STATE-04` | Export                            | Markdown/text content, tool verdicts, ownership, encoding and confined output path are correct                 |
| `STATE-05` | Active and settled compaction     | Queued/direct lifecycle, optional request, context replacement, spinner and next-call use are correct          |
| `STATE-06` | Model context fitting             | Cancel/failure leaves model and context unchanged; acceptance evicts only as needed before saving              |
| `STATE-07` | Token and cost totals             | Live baseline plus current usage settles once; resident transcript never substitutes for full-session totals   |
| `STATE-08` | Cache telemetry                   | Measured zero remains zero; missing cache detail remains unknown and omits a false percentage                  |
| `STATE-09` | Memory pressure and recovery      | Fuse blocks risky work, exposes actionable recovery, and returns to a usable bounded state without losing data |
| `STATE-10` | Corrupt/truncated/oversized state | Error is bounded, actionable and isolated; no crash, secret leak or blind overwrite                            |
| `STATE-11` | Concurrent settings edits         | Exact revision conflicts are visible; older responses and blind retries cannot replace newer state             |

## Product capabilities and integrations

| ID       | Scenario                  | Minimum proof                                                                                                                  |
| -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `CAP-01` | Plans                     | Create/update/review/retain/delete paths, full-screen detail, conflicts and active-run projection are coherent                 |
| `CAP-02` | Execution memory          | Enable/disable, policy, review/curation, indexing after run, failure, recovery and persistence are coherent                    |
| `CAP-03` | Subagents                 | Parallel children, isolated transcript, activity detail, cancellation, failure and bounded summaries settle correctly          |
| `CAP-04` | Workflows                 | Built-in/custom precedence, manager tree, concurrency, cancellation, budget exhaustion, deletion and resume are correct        |
| `CAP-05` | Tasks board               | Availability, health, filters, detail, refresh, normalized/native state and claim semantics are honest                         |
| `CAP-06` | Task mutations            | Supported write, conflict, provider failure and unknown outcome never render as a successful empty board                       |
| `CAP-07` | Work on task              | Current workspace and selected agent are used; opening does not mutate; return refreshes source of truth                       |
| `CAP-08` | Feature backend selection | Namespaced server, protocol/capability probe, writes policy, default container and unavailable state are correct               |
| `CAP-09` | MCP tools and prompts     | Inventory, refresh, duplicate names, invocation, errors, degraded pools and prompt injection are visible and bounded           |
| `CAP-10` | OAuth-pending MCP         | Browser flow remains background, other work runs, bounds are retained, no duplicate browser, later reuse works when authorized |

## Extensions, trust, sandbox, and executable behavior

| ID        | Scenario                            | Minimum proof                                                                                                                                                                                                                                                                             |
| --------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXT-01`  | Extensions guided flow              | Scope, profile, inventory search, multi-select, contribution review, preview, apply, reconnect and final state                                                                                                                                                                            |
| `EXT-02`  | Cancel/discard/leave during work    | Draft discard confirmation and background completion ownership are predictable; Escape stays responsive                                                                                                                                                                                   |
| `EXT-03`  | Marketplace collections             | Built-in/configured sources, search, large list windowing, add source, load failure and retry are correct                                                                                                                                                                                 |
| `EXT-04`  | Plugin lifecycle                    | Install, identity validation, activate, update eligibility, uninstall and exact-ref selection are atomic and honest                                                                                                                                                                       |
| `EXT-05`  | Extension Profiles                  | Create/customize/select/clear/delete, process-pinned read-only mode, conflicts and resolution errors are correct                                                                                                                                                                          |
| `EXT-06`  | Skills and resources                | Four-root inventory, qualified identity, task/agent routing, invalid or inactive roots and bounded reads are correct                                                                                                                                                                      |
| `EXT-07`  | Hooks and executables               | Contribution review, workspace approval, command execution, failure and diagnostic redaction preserve trust boundaries                                                                                                                                                                    |
| `EXT-08`  | Workspace trust                     | Executable configuration is withheld until approval, recomposes after change, and revocation takes effect safely                                                                                                                                                                          |
| `EXT-09`  | Drift after admission               | After the documented asynchronous drift notice, affected skills or executable contributions are withdrawn, unaffected work remains usable, and reconnect captures changed bytes                                                                                                           |
| `SAFE-01` | Safety presets                      | All current presets, danger confirmation, next-run semantics and effective policy preservation are correct                                                                                                                                                                                |
| `SAFE-02` | Guard modes and policy              | Off/on/auto, allow/deny precedence, ask, judge result, fallback and durable transcript annotation are correct                                                                                                                                                                             |
| `SAFE-03` | Native sandbox                      | Available/unavailable/degraded backends, containment refusal, diagnostics and host fallback match the active OS                                                                                                                                                                           |
| `SAFE-04` | Secret and path boundaries          | Keys, subscriptions, logs, storage, export, attachments, marketplace and tool output reveal no protected material or escape path                                                                                                                                                          |
| `SAFE-05` | Host temporary interoperability     | Cross-tool host-temp access, read-only overlap and non-owning cleanup are proved on the active OS                                                                                                                                                                                         |
| `SAFE-06` | Absolute executable classification  | A platform/runtime absolute head is occurrence-local, keeps cross-platform policy identity, and never admits identical outside operands                                                                                                                                                   |
| `SAFE-07` | Sandboxed DNS and package bootstrap | macOS DNS, real package execution, Apple Silicon Homebrew shims and denied-network behavior are proved                                                                                                                                                                                    |
| `SAFE-08` | Isolation and review selectors      | Header chips, Run Controls, Ctrl+S/Ctrl+G, Alt/Option accelerators and Ctrl+E keep placement, command review and editor expansion independent                                                                                                                                             |
| `SAFE-09` | Docker lazy execution               | Native boot performs no engine work; the first Docker run launches once, mounts the selected Git/non-Git workspace directly, supports outbound package bootstrap and exposes a guest service only through loopback preview                                                                |
| `SAFE-10` | Container host bridges              | Admitted Skills/resources and Plan operations work through the host; Memory is read-only to the guest and post-run indexing stays host-side; credentials, host paths, engine socket and workspace control writes remain unavailable                                                       |
| `SAFE-11` | Container recovery and lifecycle    | Active steer and cancel work, a follow-up reuses the healthy channel, operational startup failure reports required-Sandbox fallback, integrity/policy/recipe/handshake failures stay closed, and orderly close removes only the disposable container while the Docker mise cache persists |
| `SAFE-12` | Operator runtime recipe             | A global advanced recipe builds only on first cold use, concurrent callers share its inspected image, later sessions reuse the cache identity, edits take effect at the next cold generation, and the guest cannot invoke or mutate the recipe                                            |

For `SAFE-05`, create a path through a host-native temporary API in `shell`, then reuse its absolute
path through a later native coding tool without a guard denial. Repeat with a read-only workspace
below the system temp root: the workspace must remain closed while exact run scratch remains
writable. Teardown and fixture cleanup must stay distinct; Clarvis must never own or remove the
system parent or unrelated children.

For `SAFE-06`, compare the PATH and absolute spellings of the same system command. The absolute form
must not receive an `outside_workspace` policy denial, and a denied command must remain denied under
the absolute spelling. Add an absolute data operand outside the workspace in the same command and
prove that operand is still refused. An executable outside the platform/runtime roots must also stay
refused. Repeat the exact executable path later as a redirection or ordinary operand and require the
operand occurrence to remain outside. On Windows, prove `.exe`, `.com`, `.bat`, and `.cmd` command
heads match extensionless policy entries.

For `SAFE-07`, do not use a raw IP or only a loopback socket: those miss the macOS resolver path.
Resolve a registry hostname from the current built artifact and perform a bounded package bootstrap
that both downloads and executes its fetched entrypoint; a metadata-only request is insufficient.
When `/opt/homebrew/bin/npm` exists, require that logical shim rather than bypassing it with its
resolved Cellar target. Repeat under `network: none` and require a network failure. Record external
registry availability separately from the sandbox verdict.

## Operations, resilience, performance, and native canaries

| ID          | Scenario                         | Minimum proof                                                                                                                                                                                                                                      |
| ----------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPS-01`    | Diagnostics                      | CLI/env and `/debug` lifecycle, levels, rotation, saturation, sampling, redaction and Doctor path are correct                                                                                                                                      |
| `OPS-02`    | Storage                          | Metadata posture, bounded/truncated inventory, preview/apply race and actual byte report are correct                                                                                                                                               |
| `OPS-03`    | Managed worktree                 | Create/reopen, canonical pinning, branch display, clean-exit remove/keep and dirty preservation are correct                                                                                                                                        |
| `OPS-04`    | Reconnect                        | Draft/session survive; fresh environment, providers, profiles, skills, tools and trust state publish once                                                                                                                                          |
| `OPS-05`    | Remote Clarvis over SSH          | Paired flags select the remote workspace; verified key/agent/certificate login carries the full wire with port/agent/X11 forwarding disabled; remote settings/OAuth/state stay remote; reconnect owns one fresh SSH process and no mutation replay |
| `RES-01`    | Slow and out-of-order work       | Later state wins; pending feedback is visible; no stale mutation, focus theft or duplicate completion                                                                                                                                              |
| `RES-02`    | Never-settling work              | External watchdog fires, cancellation/shutdown remains bounded, diagnostics identify the owner                                                                                                                                                     |
| `RES-03`    | Input during teardown            | Queued press/release/raw input after renderer destruction is inert and terminal restoration occurs once                                                                                                                                            |
| `RES-04`    | Resize/scroll feedback           | Rapid resize plus scroll/live stream does not create redraw loops, jumps, owner growth or input starvation                                                                                                                                         |
| `RES-05`    | Repeated full journeys           | Multiple runs, session switches, overlays, settings and reconnect cycles leave bounded owners, handles, queues and process tree                                                                                                                    |
| `PERF-01`   | Staged startup benchmark         | `BENCH_N=7 bun run bench:code --arm=bundle`; min/median/max for launcher, shell, startup composer and complete app reported separately                                                                                                             |
| `PERF-02`   | Overlay lifecycle soak           | `bun run bench:code-overlays`; ownership deltas are zero and environment-specific leak slope stays within current tooling limits                                                                                                                   |
| `PERF-03`   | Clean versus extension-heavy run | Same artifact, controlled profiles, plugin/skill/MCP inventory, admission, first activity and completion timings compared                                                                                                                          |
| `PERF-04`   | Idle and active resource soak    | Diagnostics plus external process-tree RSS/PSS, CPU/redraw, listeners, owners, queues and child processes remain bounded                                                                                                                           |
| `NATIVE-01` | Physical terminal                | Exact launcher and profile keyboard packets, rendering, Escape latency, paste, mouse and shutdown are exercised on target terminal hardware                                                                                                        |
| `NATIVE-02` | Real provider/account            | Authorized provider stream, usage, tools, errors and continuation match deterministic behavior without exposing credentials                                                                                                                        |
| `NATIVE-03` | Target platforms                 | Required macOS, Linux and Windows PTY/native canaries are reported independently; unavailable platforms remain unverified                                                                                                                          |
