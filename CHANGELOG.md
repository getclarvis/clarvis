# Changelog

All notable user-facing changes to Clarvis are recorded here. The project follows
[Semantic Versioning](https://semver.org/) for release identifiers while it is in prerelease.

## [Unreleased]

### Added

- Portable installers now show numbered download, verification, staging, and activation progress and
  provide lock-serialized guarded uninstall modes that bind launcher ownership to the selected root,
  reject linked managed paths, stop on cancellation, clean managed Windows `PATH` entries, and
  preserve Clarvis user and workspace state.

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
