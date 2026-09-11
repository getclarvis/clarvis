# Changelog

All notable user-facing changes to Clarvis are recorded here. The project follows
[Semantic Versioning](https://semver.org/); releases before 1.0 may make breaking changes.

## [Unreleased]

## [0.2.0] - 2026-09-07

### Added

- Isolation is now independent from command review in the TUI: Host, native Sandbox, and lazy Docker
  placement can be combined with Off, Approval, or automatic LLM review.
- Docker isolation uses an immutable minimal runtime image, host-owned model/skill/Plan/Memory
  bridges, persistent workspace-scoped `mise` tool caches, and bounded loopback service exposure.
- Advanced global runtime recipes can build a reusable operator-customized Docker image on first use
  without exposing the recipe as a guest tool or modifying the canonical release image.
- Persistent per-conversation goals provide CAS-controlled edits, bounded automatic continuation,
  checkpoints, human and host evidence criteria, and durable settlement across restart and compaction.
- Remote TUI hosting can run Clarvis on an operator-selected machine over OpenSSH stdio while the
  remote installation retains workspace, state, provider credentials and runtime ownership.
- Prompt-cache qualification tooling captures serialized SDK requests and physical usage per agent,
  including deterministic checks and bounded local real-provider and installed-artifact journeys.
- `/clarvis-configure` ships configuration guidance as TypeScript and starts an explicitly approved
  native run for editing authored global/workspace configuration, agents, skills, workflows and
  Extension Profiles. Credential stores and private state remain excluded from its file tools.
- `/loop` schedules user-authored prompts by interval or five-field cron in the current conversation,
  with bounded attempts, human interaction priority, pause/resume and scoped cancellation. Schedules
  live only while the TUI is open; interval jobs wait after each completed run.
- `/background` hands an active run to the workspace host so it can continue after the TUI exits.
  Reopening that workspace offers the existing run or a new conversation; `/background list` and
  `/attach` recover the same execution without resubmitting its prompt.

### Changed

- Container runs mount the selected workspace directly; linked Git worktrees remain ordinary
  operator-managed checkouts, while non-Git directories can use the same isolation mode.
- Runtime startup is demand-driven. An operational Docker startup failure falls back to required
  native sandboxing by default and reports the effective placement; integrity and policy failures
  still fail closed.
- Prompt history is append-only across plan changes, retries, resumes and restarts, while persisted
  session and agent-instance identities keep leaders, children and memory indexing on separate cache
  affinities.
- Remote reconnect retires the previous SSH host and workspace lease before starting its replacement;
  goal edits preserve unchanged objective state and confirmed receipts survive a failed view refresh.
- `/reconnect` restores the connection to the existing workspace host. `/reconnect reload` explicitly
  restarts an idle host to activate pinned configuration and refuses while physical work is active.
- Builtin configuration guidance covers scheduling, background runs and reload. Documentation
  maintenance now includes synchronizing that shipped guide with the owning contracts.

### Security

- Container guests do not receive Memory mutation tools or host credential/skill paths. Existing
  Clarvis workspace control paths are mounted read-only, while the selected project remains
  intentionally writable and default outbound networking can reach host/LAN peers and transmit
  readable workspace data.
- Host model execution rejects guest-controlled URL media, and independently assembled workflow
  leaders receive distinct persistent identities instead of sharing the manager's cache affinity.
- Remote OpenSSH processes receive an allowlisted client environment that excludes local Clarvis and
  provider credentials; OpenSSH continues to own host verification, authentication and encryption.
- Stdio MCP connections and MCP hooks execute inside Docker/Podman guests. Authenticated HTTP/SSE
  connections stay host-owned behind scoped operations, retaining host tool policy, bounded RPC
  handling and human elicitation without exposing credentials to the guest.
- Native configuration consent lasts only in the currently live TUI session; resume and reconnection
  require fresh approval. Configuration runs cannot be detached into background execution.

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
