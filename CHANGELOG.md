# Changelog

All notable user-facing changes to Clarvis are recorded here. The project follows
[Semantic Versioning](https://semver.org/); releases before 1.0 may make breaking changes.

## [Unreleased]

### Added

- Composer `$name` inserts a skill mention. The kernel expands unique user-invocable skills that do
  not name an `agent`; `$clarvis-configure` stays literal and does not start native configuration.
- Settings > Isolation is the dedicated global placement screen for Host, native Sandbox, Docker, or
  Podman. Native Sandbox details stay in Settings > Sandbox. Run Controls and `Ctrl+S` share the
  same writer; a workspace cannot choose a runtime.
- Simple Podman isolation now accepts `{ "backend": "podman" }` with the same product-owned limits
  and outbound default as Docker. Podman has no recipe and no Sandbox fallback: an operational
  startup failure fails closed.
- `./dev-install.sh` now builds the local `clarvis-runtime:development` image for each of Docker and
  Podman that is installed. A missing engine is skipped, so a Docker-only or Podman-only host still
  completes; native mode remains available when neither engine is present.

### Changed

- The interactive TUI now recovers from high process RSS locally and silently. Sustained pressure
  drops reconstructible completed tool bodies; the 2 GiB limit only blocks expensive new admissions.
  `/recover-memory`, the memory banner, and host rebuilds are gone. The footer may show
  `Restoring the interface…`; a definitive failure notifies once. Independent hosted work is not
  cancelled. `/clear`, `/quit`, and `/exit` remain available.
- `host_vcs` is gone. Host Git or credential needs that the sandbox cannot satisfy retry the same
  `shell` or `monitor_start` command with `sandbox_permissions: "require_escalated"` and a
  justification. Isolation Sandbox reviews that one host effect; Isolation Host is already
  unsandboxed; Docker/Podman guests reject the field.
- Review Auto may judge Isolation Sandbox `require_escalated` host execution from attested facts.
  Approval stays human-only. Host-command asks never use session coverage or `allow_session`.

### Fixed

- Simple Podman isolation accepts Podman's unprefixed 64-character local image IDs when resolving
  the development runtime image, instead of reporting an invalid image id after a successful build.
- Settled Markdown no longer keeps a tall streaming height as blank rows above the run outcome.

## [0.2.0] - 2026-09-07

### Added

- Isolation is now independent from command review in the TUI: Host, native Sandbox, and lazy Docker
  placement can be combined with Off, Approval, or automatic LLM review.
- Docker isolation uses an immutable minimal runtime image, host-owned model/skill/Plan/Memory
  bridges, persistent workspace-scoped `mise` tool caches, and bounded loopback service exposure.
- Advanced global runtime recipes can build a reusable operator-customized Docker image on first use
  without exposing the recipe as a guest tool or modifying the canonical release image.

### Changed

- Container runs mount the selected workspace directly; linked Git worktrees remain ordinary
  operator-managed checkouts, while non-Git directories can use the same isolation mode.
- Runtime startup is demand-driven. An operational Docker startup failure falls back to required
  native sandboxing by default and reports the effective placement; integrity and policy failures
  still fail closed.

### Security

- Container guests do not receive Memory mutation tools or host credential/skill paths. Existing
  Clarvis workspace control paths are mounted read-only, while the selected project remains
  intentionally writable and default outbound networking can reach host/LAN peers and transmit
  readable workspace data.

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
