# Changelog

All notable user-facing changes to Clarvis are recorded here. The project follows
[Semantic Versioning](https://semver.org/) for release identifiers while it is in prerelease.

## [Unreleased]

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
