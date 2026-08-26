# Releasing Clarvis

This is the maintainer runbook for a portable Clarvis release. Reading or running local validation
does not authorize a tag, push, GitHub Release, or any other publication action.

## Release contract

- Root `package.json` is the only product-version authority.
- A release tag is exactly `v<version>`, annotated, and signed by the authorized releaser.
- The release workflow builds glibc-based Linux, macOS, and Windows archives for x64 and arm64 on
  native runners.
- A tag-triggered workflow uploads a complete draft release and makes it public in its final step.
  There is no human pause after the tagged workflow starts.
- A manual workflow dispatch builds downloadable artifacts but cannot publish a release.
- Active GitHub rulesets protect `main` and release tags. Published tag names are immutable by
  project policy: fixes use a new version; never move or reuse a release tag.
- GitHub immutable releases are enabled for future publications. The setting was enabled after
  `v0.0.1-beta`, so that historical beta remains mutable in GitHub's API. Once GitHub marks a release
  immutable, its tag, assets, and release notes cannot be changed.

## Prepare

1. Confirm the release version, intended audience, known limitations, and rollback owner.
2. Ensure the working tree is clean and the release commit is already present on the intended
   `getclarvis/clarvis` branch.
3. Review [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md), the
   [OSS launch checklist](docs/oss-launch-checklist.md), and the open questions in
   [`specs/cross-cutting/distribution-and-updates.md`](specs/cross-cutting/distribution-and-updates.md).
4. Verify the root version, installer defaults, and repository identity agree. Supply the intended
   `RELEASE_TAG` to `check:release` when validating tag identity before publication.
5. Review [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), the exact Bun license/relink notice, the
   models.dev and Vercel AI SDK licenses, and the generated dependency closure. Treat
   third-party-license review as a release gate, not a post-release task.
6. Replace the changelog's unpublished entry with the final version/date. The workflow asks GitHub to
   generate release notes from the tagged history, so review the included commits and pull-request
   metadata before creating the tag.
7. Confirm the `main` and `v*` rulesets are active, GitHub Actions requires full-SHA action pins, and
   the repository reports immutable releases as enabled. Treat a missing policy as a release blocker.

## Validate without publishing

Use an up-to-date checkout and the exact Bun version pinned by `mise.toml`:

```bash
bun install --frozen-lockfile
RELEASE_TAG=v0.0.1-beta bun run check:release
bun run build
bun run typecheck
bun run lint
bun run test:coverage
bun --filter @clarvis/code build:install
bun run release:package
bun run release:smoke
bun run release:install-smoke
```

Run the manual `workflow_dispatch` path to exercise every native runner without publishing. Download
the six workflow artifacts and confirm:

- every target job passed its manifest, fast-path, and applicable PTY smoke;
- archive names, sizes, and SHA-256 sidecars are complete, and every archive contains its required
  notices and license files;
- a clean machine can install, run `clarvis --version`, launch first paint, and update through a
  controlled release fixture;
- unsigned macOS and Windows behavior is accurately described in the docs;
- no source map, secret, private fixture, or developer path is present in any archive.

## Publish

Publication requires the owner's explicit authorization for the exact release outcome before
creating and pushing the signed, annotated version tag. State the exact tag, commit, repository, and
branch before acting. A generic commit, push, or pull-request request does not authorize a tag or
release. Do not bypass hooks or force a tag.

After the authorized tag push, watch every native build and the final publish job. Because that job
clears the draft flag automatically after checks, stop and investigate any failed or surprising job;
do not assemble a partial release manually under the same tag.

## Verify and announce

Once GitHub reports the release as public:

1. Confirm all archives, `SHA256SUMS`, installer scripts, license/notices, and attestations are
   visible under the correct tag.
2. Run each published installer from the tag URL on a clean supported platform.
3. Verify `clarvis --version`, first-run setup, `clarvis --update`, and the documented removal path.
4. Check README badges and links, the public changelog entry, private vulnerability reporting, issue
   forms, branch/tag rulesets, and the GitHub Community Profile.
5. Record platform evidence and any launch incident. If a release must be superseded, publish a new
   version and explain the affected one; do not mutate its binaries.
