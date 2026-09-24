# Changelog

All notable user-facing changes to Clarvis are recorded here. The project follows
[Semantic Versioning](https://semver.org/); releases before 1.0 may make breaking changes.

## [Unreleased]

### Changed

- Removed Docker and Podman execution, container images and runtime installers. Isolation now offers
  Host and Sandbox; remote SSH connections remain available. Release candidates use source identity
  and stable releases continue to publish portable binaries.

## [0.2.0] - Unreleased

### Changed

- Live context compaction replaces `working` on the Lead activity line above the composer instead of
  repeating `Compacting context…` in the footer.

### Fixed

- `/diff` no longer blinks the open file patch on an unchanged poll. `StableDiff` stays mounted
  until the selected unified diff actually changes.
- `clarvis --worktree` bases a new `clarvis/<name>` branch on the commit at `HEAD` of the checkout it
  was started in, not on the remote default branch. Creation no longer fetches `origin`, so an
  unreachable remote, a differently configured `origin/HEAD`, or a commit that exists only locally
  cannot change the base. A source checkout without a commit fails, once a new branch is required,
  before creating a branch or checkout, while an existing `clarvis/<name>` branch is still reused;
  uncommitted changes stay where they were, and the new branch records no upstream, so `git push`
  inside the checkout cannot inherit the remote default branch.

### Added

- `/diff` and `Ctrl+X D` show the current Git working tree, including staged, unstaged and untracked
  files, instead of grouping transcript tool calls. The overlay opens on an empty conversation.
- Isolation and command review are independent controls. `Ctrl+X I` selects Host or native Sandbox,
  while `Ctrl+X G` selects Off, Approval or Auto review. Settings > Run controls and `Ctrl+X I`
  expose the same choices.
- `/background`, `/background list`, `/attach` and scoped cancellation let a local Host/Sandbox run
  continue after its TUI closes and return to the same execution later. SSH retains list, attach
  and cancel only while its current client connection is alive.
- `/goal` creates and controls a persistent objective with bounded automatic continuation,
  checkpoints, token limits, deadlines and human or command-based completion criteria.
- `/loop` schedules interval or cron prompts for the current conversation while the TUI remains
  open, with pause, resume, cancellation and bounded run counts.
- `--remote` with `--remote-workspace` keeps the TUI local while an authenticated OpenSSH channel
  runs a process-owned Clarvis host on another machine.
- Clarvis can author its own bounded configuration through the reviewed `configure_clarvis` writer.
  `/clarvis-configure` loads the embedded guide in the current conversation without changing agent
  or placement.
- Composer `$name` mentions expand a unique user-invocable skill into the current turn without
  starting another run. Agent-backed skills, environment-shaped tokens and the reserved
  `$clarvis-configure` name stay literal.
- A global or workspace `shared-agent.md` can replace or disable the common fleet prompt without
  copying every Agent Profile.
- A focused shell invocation can be interrupted without cancelling the complete agent run.
- Plan reminders name the plan and group compact task ids/statuses into attention, pending and
  closed work so returned or failed work is actionable without repeating task titles.
- Source release candidates carry an exact source identity separately from stable installers.
  `./dev-install.sh --candidate` installs a candidate in an isolated checkout; ordinary
  `./dev-install.sh` prepares the local source launcher.

### Changed

- The transcript now uses native OpenTUI scrolling and one semantic row model for streaming and
  settled content, preserving the reader's position while new work arrives and returning explicit
  submissions to the live tail.
- The interactive TUI now recovers from high process RSS locally and silently. Sustained pressure
  drops reconstructible completed tool bodies; the 2 GiB limit only blocks expensive new admissions.
  `/recover-memory`, the memory banner, and host rebuilds are gone. The footer may show
  `Restoring the interface…`; a definitive failure notifies once. Independent hosted work is not
  cancelled. `/clear`, `/quit`, and `/exit` remain available.
- Builtin leads and sub-agents use stronger shared communication and evidence handoff instructions;
  the compact sidebar owns agent/workflow counts instead of repeating them in the footer.

### Fixed

- Auto command review never elicits a person. Dangerous matches, Judge denials and Judge
  uncertainty are refused to the principal with the exact policy match; unsandbox is a Judge
  decision. Approval (`on`) asks a human only for the grey zone that is neither allow-listed nor
  dangerous, and denies forced removal of a credential file instead of prompting. Judge policy
  now states that deny and unsure are closed refusals to the calling agent, not a handoff to a
  person or TUI prompt.
- Grok subscription catalogs keep `vision` unless the entitled payload omits image input, so persisted
  `tool_calling`-only rows can no longer strip composer images as if the model were blind.
- Auto review denies uncertainty, model failures and malformed answers to the calling agent and
  never selects human fallback.
- `$clarvis-configure` remains literal despite the embedded guide intentionally having no agent
  override, preserving explicit configuration disclosure.
- SSH sessions no longer claim that a promoted run can survive TUI exit: the SSH stdio channel owns
  its remote Kernel and closes it when the connection ends.
- `/model` can request an explicit context target through `runs.context` again; the optional field is
  admitted by the closed transport envelope.
- A Lead now defers plan mutations issued in the same model iteration after tracked delegation until
  the returned task state and fresh CAS identity are published. Sub-agents continue to receive no
  plan mutation tools, and strict digest checks remain intact.
- Agent and workflow counts appear only in the sidebar; the footer no longer repeats the roster.
- Corrupt PNG tool results are refused before they can enter a later provider request.
- Long accepted user prompts and slim follow-up turns now retain their authenticated conversation
  scope for automatic command review instead of forcing manual approval through missing evidence.
- Explicit non-forced current-branch pushes and bounded pull-request metadata/check observations now
  reach automatic effect review with repository, branch and HEAD attestation instead of stopping as
  partial evidence before a reviewer attempt.
- POSIX local hosts now fall back to the private account-scoped namespace under `/tmp` when the
  operator environment's temporary root would make the Unix socket exceed its byte limit, preserving
  independent startup, discovery and reconnection without changing run scratch paths.
- Settled Markdown no longer keeps a tall streaming height as blank rows above the run outcome.

### Security

- Review Auto evaluates attested effects and authenticated operator scope. Dangerous operations,
  credentials and Approval-mode decisions remain human-only; review events persist no prompt,
  response, command arguments or operator evidence payloads.

## [0.1.1] - 2026-09-04

### Added

- Managed interactive installations now check for a newer complete public release after first paint,
  cache that result for 24 hours, and surface an available update without delaying or disrupting
  offline startup.

### Fixed

- Prompt caching now preserves a stable provider-specific prefix across turns, keeps OpenAI and
  ChatGPT subscription caching provider-managed, applies explicit breakpoints only to providers that
  declare them, and reports breakpoint drift without exposing prompt content.

## [0.1.0] - 2026-09-03

### Changed

- Portable archives now run a product-named `clarvis` executable, so process viewers attribute CPU
  and memory use to Clarvis; the former `bun` runtime path remains only as a launcher compatibility
  entry.
- Streaming model-call timeouts now measure inactivity across text, reasoning, and tool-input
  progress instead of treating an actively growing tool argument as a stalled call.
- The workflow token ceiling now covers every auxiliary workflow agent, including manager children
  and leader sub-agents, through per-call fair-share reservations that return unused headroom.
- ChatGPT subscription catalog discovery now sends Codex compatibility revision `0.153.2`, matching
  the reviewed latest stable `@openai/codex` release while keeping Clarvis's own version separate.
- First-run POSIX and PowerShell command policies now allow conventional inspection, build, test,
  lint, and type-check commands across common language ecosystems. Existing allowlists remain
  unchanged, while generic runners, installs, publishing, deployments, and migrations still require
  review.

### Fixed

- Live tool input shows bounded cumulative progress, and a retry keeps the classified failure that
  scheduled it without retaining prompt or argument contents.
- Command-review denials no longer accumulate as failed executions, while genuine tool failures do;
  a later success in the same model-declared batch clears a provisional convergence crossing.
- Native sandboxes admit the host's compatible temporary roots and recognized system executables;
  Apple-silicon Homebrew tools work inside Seatbelt without granting write access to Homebrew.
- Transcript streaming remains in one chronological scroll flow, keeps an older reader's exact
  anchor, returns explicit new submissions to the Lead tail, and avoids stale overscroll while an
  elicitation replaces the composer.
- Workflow review results distinguish a decline, dismissal, invalid answer, and timeout, and one
  capless model call can no longer reserve the complete auxiliary workflow budget.
- Direct iTerm sessions preserve Portuguese accents, dead keys, and ordinary Option text input;
  `Ctrl+S` remains the portable safety shortcut and `Option+S` requires Meta/Esc+ delivery.

### Security

- Absolute system-executable allowances are occurrence-local, so the same path used later as a data
  operand cannot inherit the command-head exemption or bypass command policy.

## [0.0.4-beta] - 2026-09-02

### Changed

- Workflow sequences now pause at every authored or repeated round boundary so Admiral can inspect
  the persisted checkpoint and explicitly continue or stop; cumulative leader limits keep the
  complete sequence bounded.
- Extension activation is now named Extension Profile across the CLI, protocol, persisted state,
  paths, diagnostics, and terminal UI; the existing execution identity is named Agent Profile on
  ambiguous session and picker surfaces.
- This prerelease rename is a clean break: Clarvis reads `extension-profiles/`,
  `extension-profile.json`, and the `--extension-profile` flag, without compatibility aliases or
  readers for the former Environment names; the internal wire contract is now version 3.
- Run admission reuses one immutable Extension Profile snapshot instead of rescanning every skill
  root synchronously, while exact selected content is still revalidated before execution.

### Fixed

- Steering is acknowledged only after the loop drains the message; if a run settles first, Clarvis
  restores the draft and keeps a visible `Steer not delivered` receipt.
- First-run provider and model pickers return to setup with one Escape, and portable terminals use
  Ctrl+J as the reliable multiline chord without advertising an indistinguishable Shift+Enter.
- Missing `--resume` and `--continue` sessions now fail before OpenTUI enters raw or alternate-screen
  mode, leaving the calling terminal intact.

## [0.0.3-beta] - 2026-09-01

### Added

- Environment profiles now pin qualified plugin and skill selections into immutable run snapshots,
  with guided creation and editing through the Extensions workflow.
- macOS can enforce native Seatbelt sandbox profiles for shell execution, with matching inspection
  and CI coverage alongside the Linux Bubblewrap backend.
- A source-development installer provides the `clarvis-develop` launcher for running the current
  checkout without replacing a managed release installation.
- Extension compatibility now accepts portable MCP declarations, pre-registered OAuth client
  discovery, MCP-backed hooks and skill resources, plus confined local, Git subdirectory, and npm
  marketplace sources.

### Changed

- The terminal UI now opens with a usable startup composer and responsive Clarvis splash on its first
  paint, while deferred hydration continues in the background.
- Plugin-heavy startup reuses validated extension state and keeps MCP OAuth discovery in the
  background so an unanswered authorization flow does not block run admission.
- Plan controls use a simpler command workflow, and Escape navigation dismisses replaceable overlays
  immediately.
- Run and session usage footers now show the prompt-cache hit percentage beside input and output
  totals while preserving settled values across later activity.

### Fixed

- Settled runs now release the composer from steer mode so the next prompt starts a new run instead
  of targeting an inactive one.
- Environment resolution preserves qualified plugin identities and rejects missing, changed, or
  ambiguous snapshot entries instead of silently substituting another contribution.
- Portable release packaging now includes runtime packages loaded through Bun-minified
  `createRequire` bindings.

### Security

- macOS shell execution can require a native sandbox instead of falling back to an unconstrained
  host shell, while Linux sandbox enforcement remains fail-closed.
- Environment snapshots are revalidated at run admission and recorded with their exact identities so
  workspace or marketplace drift cannot silently change an approved run.
- Marketplace npm installs disable lifecycle scripts, while refs, registries, subdirectories, paths,
  and bounded extension payloads are validated before admission.

## [0.0.2-beta] - 2026-08-27

### Added

- The official Clarvis marketplace is now the first built-in source, with explicit install and trust
  boundaries plus compatibility for complete plugin, skill, hook, and MCP layouts from supported
  host dialects.
- Remote MCP servers can complete OAuth authorization, refresh, and late challenge flows while
  keeping service credentials isolated from authorization requests and local callback state.
- Portable installers now show numbered download, verification, staging, and activation progress and
  provide lock-serialized guarded uninstall modes that bind launcher ownership to the selected root,
  reject linked managed paths, stop on cancellation, clean managed Windows `PATH` entries, and
  preserve Clarvis user and workspace state.

### Changed

- First-run setup keeps the responsive Clarvis splash visible when the terminal has room and reports
  pending and successful subscription clipboard and browser actions in place.
- Built-in Lead profiles now allow 200 iterations, and workflow leaders use a separate bounded token
  ledger so queued work can consume capacity released by earlier leaders.

### Fixed

- macOS startup now paints before deferred parser and recovery work, and queued keyboard events no
  longer reach a renderer after teardown.
- Subscription model catalogs use provider-specific compatibility revisions, expose published
  reasoning efforts, and remain visibly loading until entitlement discovery settles.
- Workflow leaders no longer inherit primary-run plans or memory, aggregate failure is preserved,
  and dynamic workflow grants use an isolated memory-indexing pass instead of an invalid
  continuation.
- Portable JavaScript keeps package-relative logging workers external and rejects generated chunks
  that embed the build host's absolute checkout path.

### Security

- Installer removal authenticates exact managed ownership, serializes against installs and updates,
  rejects linked or ambiguous managed paths, and leaves credentials, sessions, workspace state,
  unrelated launchers, and unknown files untouched.
- MCP OAuth requires secure authorization endpoints and redirects, binds loopback callbacks to
  PKCE/state, and keeps tokens out of settings, prompts, logs, plugin hooks, and resource headers.

## [0.0.1-beta] - 2026-08-26

### Added

- Portable glibc-based Linux, macOS, and Windows release targets for x64 and arm64, including the Bun
  runtime and target-native TUI dependencies.
- Checksum-verifying installers and explicit `clarvis --update` support for managed installations.
- First-run provider and model setup in the terminal UI.
- Public user, contributor, security, support, architecture, terminal, and release documentation.

### Security

- Release manifests, SHA-256 verification, staged activation, exclusive update locking, and retained
  previous versions for managed updates.
