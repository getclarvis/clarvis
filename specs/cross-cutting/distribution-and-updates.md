# Portable distribution, installation, release publication, and self-update

> Implemented at `install.sh`, `install.ps1`, `.github/workflows/release.yml`,
> `tooling/checks/release-readiness.ts`, and `packages/code/{src/update-contract.ts,src/update/**,
> tooling/release/**}`. Every behavioral invariant below names its production and test evidence.

## 1. Purpose

Clarvis is distributed as a product, not as eighteen independently versioned workspace packages.
The portable-release path turns the map-free split Code artifact into a target-native archive that
needs no user-installed Bun, Node.js, compiler, or package manager. The same contract owns initial
installation, explicit uninstall and self-update, release assembly, and the point at which a fully
uploaded draft becomes visible. Production: root `package.json` (`version`, private workspaces),
`packages/code/tooling/release/package.ts` (`main`), and `.github/workflows/release.yml`.

This document does not make the package-local `bun run setup` path portable; that remains the
developer-checkout path described by [Code bootstrap](../hosts/code-bootstrap.md). It does not define
user-configuration formats or their own retention policy. Release payloads and Clarvis state occupy
separate roots, and install, update, and uninstall never rewrite `.clarvis` or `.agents`. Production:
`packages/code/src/update/installation.ts` (`ManagedInstallation`) and the root installers.

## 2. Surface

The user-facing surfaces are:

- `install.sh` for GNU/glibc Linux and macOS, selecting `linux-{x64,arm64}` or
  `darwin-{x64,arm64}`, with `--uninstall` and `--help` modes;
- `install.ps1` for `windows-{x64,arm64}`, with `-Uninstall` and `-Help` modes;
- `clarvis --update`, a complete CLI mode answered before the application graph loads;
- six `clarvis-v<version>-<target>.tar.gz` release assets plus `SHA256SUMS`, both installers,
  Clarvis's license, and standalone third-party notices/license texts;
- root scripts `release:package`, `release:smoke`, `release:install-smoke`, and `check:release`;
- a tag-triggered release workflow and a non-publishing `workflow_dispatch` build path.

Production: `packages/code/src/cli-args.ts` (`FLAGS`, `Mode`), root and Code `package.json`
scripts, `packages/code/src/update-contract.ts` (`ReleaseTarget`, `releaseAssetName`), and
`.github/workflows/release.yml`. Test: `packages/code/tests/unit/cli-args.test.ts`,
`packages/code/tests/unit/update-contract.test.ts`, and
`tooling/tests/unit/release-readiness.test.ts`.

Installer overrides are explicit environment inputs: `CLARVIS_VERSION`,
`CLARVIS_RELEASE_REPOSITORY`, `CLARVIS_RELEASE_BASE_URL`, `CLARVIS_RELEASE_DIRECTORY`,
`CLARVIS_INSTALL_ROOT`, and the POSIX `CLARVIS_BIN_DIR`; Windows also accepts
`CLARVIS_SKIP_PATH=1`. `CLARVIS_RELEASE_DIRECTORY` is an operator-selected local mirror, not a
network fallback. Production: `install.sh` and `install.ps1`. Test:
`packages/code/tooling/release/installer-smoke.ts`.

## 3. Data and formats

Every archive has exactly one top-level `clarvis/` directory. Its payload contains the root product
manifest and MIT license, static `THIRD_PARTY_NOTICES.md`, Bun, models.dev, and Vercel AI SDK license
texts beneath `third-party/`, generated `THIRD_PARTY_NOTICES.txt`, `runtime/bun` or
`runtime/bun.exe`, Code's small TypeScript launcher/update graph, the map-free split
`packages/code/dist`, and the target-native runtime dependency closure beneath `node_modules`. The
generated notice routes to the static inventory and lists the exact target closure; license files
supplied by those packages remain in their copied package directories. Production:
`packages/code/tooling/release/package.ts` (`copySource`, `copyRuntime`, `runtimeClosure`,
`copyDependencies`).

`release.json` is schema 1:

```json
{
  "schema": 1,
  "repository": "getclarvis/clarvis",
  "version": "0.0.1-beta",
  "target": "linux-x64",
  "files": [{ "path": "runtime/bun", "size": 80761952, "sha256": "..." }]
}
```

`files` describes every regular payload file except `release.json` itself, with a portable relative
path, exact byte length, and lowercase SHA-256. Directories, symlinks, traversal segments, absolute
paths, backslashes, duplicates, extra files, and more than 4,096 entries are refused. Production:
`packages/code/src/update/release-manifest.ts` (`parseReleaseManifest`, `manifestFiles`,
`verifyReleaseTree`). Test: `packages/code/tests/unit/release-manifest.test.ts`.

A managed installation is:

```text
<install-root>/
├── .clarvis-managed-install
├── current
├── update.lock
└── versions/
    ├── v0.0.1-beta/clarvis-payload...
    └── v<newer>/clarvis-payload...
```

`.clarvis-managed-install` is the installer's exact bounded ownership marker. `current` is one
`v<version>` line. `update.lock` normally exists only while one installer, updater, or uninstaller
owns the mutation lease; a file left by a crashed owner requires the reported manual recovery. The
stable launcher reads `current` on every invocation, exports `CLARVIS_INSTALL_ROOT`, and executes
that version's included runtime and `cli.ts`. Production:
`install.sh`, `install.ps1`, and `packages/code/src/update/installation.ts`.

## 4. Behavior

Packaging runs only for the host's native supported target. It copies the exact running Bun binary,
discovers bare runtime package references retained by the split artifact, closes their production
dependency graph, adds the one OpenTUI native package for the target, copies the static Bun,
models.dev, and Vercel AI SDK license and notice set, removes every `.map`, writes the internal
manifest, creates a gzip tar archive, and emits a sidecar SHA-256. Production:
`packages/code/tooling/release/package.ts` and
`packages/code/tooling/release/runtime-package-discovery.ts`. Generated call specifiers contribute
to that closure only when they name an installed bare package root; relative, absolute, built-in,
and module-internal `#` references are ignored, package subpaths resolve to their owning root, and an
invalid name reaching manifest resolution is rejected before any path is read. Test:
`packages/code/tests/unit/runtime-package-discovery.test.ts`. The release smoke re-extracts the
archive, verifies the manifest, required notices/licenses, and zero-map rule, runs `--version` and
`--help`, and on POSIX boots first paint under a real PTY using the packaged runtime. Test:
`packages/code/tooling/release/smoke.ts` and
`packages/code/tooling/artifact/pty.ts`.

Initial installation prints its selected version, target, install root, launcher, and one numbered
status line before each potentially slow or mutating phase. It downloads the target archive and
`SHA256SUMS` from the same versioned release directory, requires one exact checksum entry, verifies
the bytes, extracts into a private temporary directory, and proves the staged CLI reports the
requested version. An existing same-version payload must carry the same manifest. Before changing
`current`, the installer acquires `update.lock` and refuses an unrelated command at the launcher
path. Only then does it store the ownership marker, activate the version, and atomically replace its
own marked launcher. The stable launcher validates the `current` identifier before using it in a
path. The POSIX installer accepts the script either as a file or on `/bin/sh`'s standard input, asks
no interactive question, and invokes the staged Clarvis payload only through the application-free
`--version` fast path before activation. Production: `install.sh`, `install.ps1`, and
`packages/code/src/cli.ts`. Test: `packages/code/tooling/release/installer-smoke.ts` covers visible
progress, the POSIX standard-input entry, unmanaged-launcher refusal, a same-version reinstall, the
ownership marker, and the stable launcher.

Uninstall is an explicit mode of the same versioned scripts. It prints the resolved install root and
launcher before mutation, authenticates the exact ownership marker, and supports installations made
before that marker existed only when the marked launcher, valid `current` tag, and active
`release.json` are all present. It refuses symlink/reparse-point roots, invalid markers, unrelated
launchers/roots, and an existing `update.lock`; after acquiring that shared lock it removes the
installer-owned versions, activation file, marker, and marked launcher. Windows also removes only
the exact managed `bin` entry from the user `PATH` unless `CLARVIS_SKIP_PATH=1`. Unknown root files
and unrelated launchers remain in place and are reported. A missing installation is a successful
no-op. User configuration, credentials, sessions, `.clarvis`, and `.agents` are outside this
operation. Production: `install.sh` and `install.ps1`. Test:
`packages/code/tooling/release/installer-smoke.ts` covers unauthenticated-root and active-lock
refusal, legacy pre-marker authentication, removal, preserved user state, POSIX standard-input
uninstall, and repeated uninstall.

Self-update performs no network request until it has authenticated a managed current installation
and acquired the exclusive `update.lock`. Because GitHub's `releases/latest` excludes prereleases,
it reads a bounded list of releases instead. It validates the response shape, tag/version agreement,
draft and prerelease flags, exact asset identity, `uploaded` state, size, GitHub URL, and GitHub's
`sha256:` digest. A stable current version rejects prereleases; a prerelease current version may
advance to a higher prerelease or stable version and never downgrades. Production:
`packages/code/src/update/github-releases.ts` and `packages/code/src/update-contract.ts`
(`selectUpdateRelease`). Test: `packages/code/tests/unit/github-releases.test.ts` and
`packages/code/tests/unit/update-contract.test.ts`.

The updater downloads into a unique same-filesystem staging directory, streams the asset through
the declared size and SHA-256 bounds, extracts through `Bun.Archive`, verifies every manifest file,
and executes the candidate's included Bun with `--version`. It renames a new version beside the old
one and durably replaces `current` last. Failure before that write leaves the active version and all
user state unchanged. Production: `packages/code/src/update/index.ts` and
`packages/code/src/update/installation.ts`. Test:
`packages/code/tests/unit/update-command.test.ts` (verified activation and preserved predecessor).

The release workflow builds and smokes all six target archives independently. A tag build downloads
the complete set, verifies every sidecar, assembles `SHA256SUMS`, attests the archives, creates a
GitHub release as a draft, uploads every asset, and removes the draft flag only in the final step.
Manual dispatch builds downloadable workflow artifacts but cannot publish because the publish job
requires both a tag ref and the `push` event. Production: `.github/workflows/release.yml`. Release
publication still requires a separately authorized tag and push; nothing in the local build or
installer creates one.

## 5. Invariants

**DIST-1.** Root `package.json` is the sole product-version authority. Both installer defaults must
match it; when a release tag is supplied, it must be `v<root version>`. Production:
`tooling/checks/release-readiness.ts` (`releaseReadinessFailures`). Test:
`tooling/tests/unit/release-readiness.test.ts`.

**DIST-2.** A portable archive contains no source map anywhere, including copied third-party
packages. Production: `packages/code/tooling/release/package.ts` (`removeSourceMaps`, final manifest
assertion). Test: `packages/code/tooling/release/smoke.ts` (manifest zero-map assertion).

**DIST-3.** Release identity is exact across repository, SemVer tag, target, asset name, asset URL,
size, state, and SHA-256; an ambiguous or partial match is ineligible. Production:
`packages/code/src/update-contract.ts` (`eligibleAsset`, `selectUpdateRelease`). Test:
`packages/code/tests/unit/update-contract.test.ts`.

**DIST-4.** Ordinary startup performs no release request. Only the explicit `update` mode imports the
updater, and source or unmanaged invocations fail before fetching. Production:
`packages/code/src/cli.ts`, `packages/code/src/index.tsx`, and
`packages/code/src/update/index.ts`. Test: `packages/code/tests/architecture/cli-fast-path.test.ts`
and `packages/code/tests/unit/update-command.test.ts`.

**DIST-5.** Activation is last and retains the previous version. Production:
`packages/code/src/update/installation.ts` (`activateStagedRelease`, `durableCurrent`). Test:
`packages/code/tests/unit/update-command.test.ts` (eligible archive case).

**DIST-6.** An update archive is trusted only after both release-metadata SHA-256 and internal
regular-file manifest verification. Production: `downloadReleaseAsset` in
`packages/code/src/update/github-releases.ts` and `verifyStagedRelease` in
`packages/code/src/update/installation.ts`. Test: `packages/code/tests/unit/github-releases.test.ts`,
`packages/code/tests/unit/release-manifest.test.ts`, and
`packages/code/tests/unit/update-command.test.ts`.

**DIST-7.** Exactly one installer, updater, or uninstaller may mutate managed release state in an
install root at a time; all three surfaces use the same exclusive `update.lock`. Production:
`install.sh`, `install.ps1`, and `packages/code/src/update/installation.ts` (`withUpdateLock`). Test:
`packages/code/tests/unit/update-command.test.ts` asserts normal update completion removes the lock
and an existing owner is neither replaced nor removed;
`packages/code/tooling/release/installer-smoke.ts` asserts install and uninstall both refuse an
existing owner.

**DIST-8.** The release workflow cannot expose a partially uploaded release: publication starts as a
draft and clearing `draft` is the final step after checks and attestation. Production:
`.github/workflows/release.yml` (`publish` job). Test: `check:release` pins local identity; the remote
draft transition is verifiable only in an authorized release run.

**DIST-9.** Every portable archive carries the static Bun runtime, models.dev snapshot, and Vercel AI
SDK notices; their license files; Bun source/relinking information; the generated target dependency
inventory; and the license files retained inside copied packages. The assembled release also exposes
the Vercel AI SDK license as a standalone asset. Production:
`packages/code/tooling/release/package.ts` (`copySource`, `copyDependencies`),
`.github/workflows/release.yml` (`publish` assembly), `tooling/checks/release-readiness.ts`
(`releaseReadinessFailures`), and the root `THIRD_PARTY_NOTICES.md` / `third-party/**` files. Test:
`packages/code/tooling/release/smoke.ts` refuses an archive missing the required static files or
identity markers; `tooling/tests/unit/release-readiness.test.ts` rejects an incomplete standalone
release set; and manifest verification refuses a declared file that was not packaged.

**DIST-10.** A manual workflow dispatch cannot reach the publish job, even when it is launched from
a tag ref. Production: `.github/workflows/release.yml` (`publish.if`) and
`tooling/checks/release-readiness.ts` (`releaseReadinessFailures`). Test:
`tooling/tests/unit/release-readiness.test.ts` (manual-dispatch guard case).

**DIST-11.** Every repository workflow declares a read-only default for repository contents, pins
external actions to complete commit SHAs, and disables checkout credential retention. Production:
`.github/workflows/*.yml` and `tooling/checks/release-readiness.ts` (`workflowSecurityFailures`).
Test: `tooling/tests/unit/release-readiness.test.ts` (workflow-security cases).

**DIST-12.** Portable runtime discovery accepts only installed bare package roots from generated
call specifiers. Path-like, built-in, and module-internal specifiers cannot become filesystem paths
beneath `node_modules`; package subpaths resolve to their owning root, and manifest resolution
rejects any invalid package name that reaches the closure.
Production: `packages/code/tooling/release/runtime-package-discovery.ts`
(`runtimePackageName`, `runtimePackageCandidates`, `assertRuntimePackageRoot`) and
`packages/code/tooling/release/package.ts` (`packageManifest`, `discoveredRuntimePackages`). Test:
`packages/code/tests/unit/runtime-package-discovery.test.ts` (package roots, rejected specifiers,
and invalid closure entries).

**DIST-13.** Installer output identifies the selected target and resolved destination and announces
every download, verification, staging, and activation phase. Uninstall removes only an authenticated
managed installation and preserves Clarvis user/workspace state, unrelated launchers, and unknown
root files. Production: `install.sh` and `install.ps1`. Test:
`packages/code/tooling/release/installer-smoke.ts` (visible progress, ownership marker,
legacy authentication, unauthenticated refusal, managed-file removal, preserved user/unknown-root
state, and idempotence).

## 6. Failure modes and degradation

| Failure | Result |
|---|---|
| Unsupported OS/architecture | installer or updater exits without changing `current` |
| Missing downloader, tar, or SHA-256 utility | POSIX installer names the missing prerequisite |
| Checksum, size, URL, redirect, manifest, or candidate smoke mismatch | candidate is refused and staging is removed |
| Concurrent install, update, or uninstall | shared exclusive lock fails with a recovery path for an actually crashed owner |
| Unmanaged or ambiguously owned install root | uninstall refuses without removing files |
| Symlinked or reparse-point install root or managed directory | install/uninstall refuses without traversing it |
| Existing destination differs | no overwrite; current version remains active |
| Unknown top-level files under an authenticated install root | managed files are removed; unknown files and the non-empty root remain and are reported |
| Source checkout or `bun link` command | `--update` refuses and directs the operator to Git/setup |
| No eligible newer release | exit 0 and report the current version is up to date |
| Windows release smoke | manifest and fast paths run natively; real-PTY first paint remains covered by POSIX release jobs |
| macOS Gatekeeper or Windows SmartScreen | unsigned beta may require explicit user approval; no bypass is automated |
| Missing third-party notice or license marker | native release smoke fails before publication |
| Workflow dispatch without a tag | packages only; no release creation or remote mutation |

Production: the root installers, `packages/code/src/update/**`, and
`packages/code/tooling/release/{package,smoke,installer-smoke}.ts`. Test: the release tooling smokes
and Code update unit tests named above.

## 7. Coupling

The portable path depends on the root product manifest, Clarvis license and third-party notice set,
the Code launcher and artifact,
the exact Bun runtime running the packaging job, OpenTUI's target-native package names, GitHub
release metadata, and the operating system's archive/launcher conventions. It does not depend on a
Clarvis user configuration, provider credential, package registry at install time, or any remote
kernel. Production: `packages/code/tooling/release/package.ts`, `install.sh`, and `install.ps1`.

Build structure, pinned Bun, CI checks, and the package-local bundle remain owned by
[Build and CI](build-and-ci.md). CLI parsing and fast-path application boot remain owned by
[Code bootstrap](../hosts/code-bootstrap.md). Security's general secret and trust rules remain owned
by [Security](security.md); this document owns only release artifact trust and activation. Product
version ownership remains in [Package architecture](package-architecture.md).

## 8. Open questions

1. The beta artifacts are not yet code-signed or notarized. Signing identities, protected secret
   storage, macOS notarization, Windows signing, and their renewal/revocation procedures need an
   owner decision before the installers can promise warning-free launches.
2. The six-runner workflow is configured from GitHub's current hosted-runner labels. Platform
   support becomes observed rather than configured only after the corresponding native build,
   artifact smoke, and installer smoke complete for the release. Dated run evidence belongs in
   [`specs/known-issues.md`](../known-issues.md) and the launch record, not in this durable contract.
3. The portable Linux assets target GNU/glibc; Alpine and other musl-only distributions are not
   configured targets for this beta. Production: `packages/code/tooling/release/package.ts`
   (`NATIVE_PACKAGES`) and `.github/workflows/release.yml` (Ubuntu Linux runners).
4. The portable Linux x64 beta is roughly 46 MiB compressed after all source maps are removed. Most
   remaining bytes are the included Bun runtime and OpenTUI native library. Further reduction needs
   a measured alternative runtime/link strategy that preserves split loading and package-owned
   native assets; size alone does not authorize weakening either invariant.
5. The repository now preserves Bun's upstream JavaScriptCore/WebKit LGPL notice, source/relinking
   route, linked-library inventory, the models.dev MIT license, and the Vercel AI SDK Apache-2.0
   license in every archive. A release owner still needs to review the exact runtime and dependency
   artifacts and their redistribution obligations before publication; the presence of notices is
   not a substitute for legal review.
