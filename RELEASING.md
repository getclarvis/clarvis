# Releasing Clarvis

This is the maintainer runbook for a portable Clarvis release. Reading or running local validation
does not authorize a tag, push, GitHub Release, or any other publication action.

## Release contract

- Root `package.json` is the only product-version authority.
- A release tag is exactly `v<version>`, annotated, and signed by the authorized releaser.
- The release workflow builds glibc-based Linux, macOS, and Windows archives for x64 and arm64 on
  native runners.
- A tag-triggered workflow in `getclarvis/clarvis` uploads a complete draft to public
  `getclarvis/clarvis-releases` and activates it in its final step. There is no human pause after the
  tagged workflow starts.
- The source repository's `GITHUB_TOKEN` remains read-only. Cross-repository publication uses the
  `Clarvis Release Publisher` GitHub App, installed only on `clarvis-releases` with `Contents: write`.
  Its Client ID is repository variable `CLARVIS_RELEASE_APP_CLIENT_ID`; its private key is repository
  secret `CLARVIS_RELEASE_APP_PRIVATE_KEY`.
- The final publish job independently extracts all six archives, rejects any case-insensitive
  `.map` suffix, inline `sourceMappingURL=data:` payload, and non-allowlisted asset, rechecks every
  sidecar and `SHA256SUMS`, and only then mints the short-lived GitHub App token.
- A manual workflow dispatch builds downloadable artifacts but cannot publish a release.
- Active source-repository rulesets protect `main` and release tags. Published releases in the
  distribution repository are immutable: fixes use a new version; never move or reuse a release tag.

## Prepare

1. Confirm the release version, intended audience, known limitations, and rollback owner.
2. From a branch without unrelated changes, record user-facing changes under `Unreleased` in
   [CHANGELOG.md](CHANGELOG.md), then run
   `bun run release:prepare <version>`. This promotes that entry and updates the root product version
   and both installer defaults as one validated operation. It does not commit, tag, or publish.
3. Review [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md), and the open questions in
   [`specs/cross-cutting/distribution-and-updates.md`](specs/cross-cutting/distribution-and-updates.md).
4. Verify the root version, installer defaults, source identity, and public distribution identity
   agree. Supply the intended `RELEASE_TAG` to `check:release` when validating tag identity before
   publication.
5. Review [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), the exact Bun license/relink notice, the
   models.dev and Vercel AI SDK licenses, and the generated dependency closure. Treat
   third-party-license review as a release gate, not a post-release task.
6. Commit and merge the reviewed release preparation through the normal protected-branch workflow,
   then use a clean checkout of that exact source commit for the final preflight.
7. Review the exact source commit that the distribution release notes will disclose.
8. Confirm the source `main` and `v*` rulesets are active, GitHub Actions requires full-SHA action
   pins, the scoped App variable/secret are present, and `clarvis-releases` reports immutable releases
   as enabled. Treat a missing policy as a release blocker.

## Validate without publishing

Use an up-to-date checkout and the exact Bun version pinned by `mise.toml`:

```bash
bun install --frozen-lockfile
RELEASE_TAG="v$(bun -e 'process.stdout.write(require("./package.json").version)')" bun run check:release
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

After assembling those six archives, their sidecars, and the standalone release files in one
directory, derive the tag from the root product version and run
`bun run tooling/checks/release-assets.ts <directory> "$RELEASE_TAG"`. This is the same
map-free allowlist gate that the tag workflow runs before it obtains a publication credential.

The public documentation repository resolves the newest complete published release during its
build and rebuilds on a schedule. A patch release therefore requires no documentation version bump;
after publication, verify that its next successful deployment materialized the new version and
immutable installer URLs.

## Publish

Publication requires the owner's explicit authorization for the exact release outcome before
creating and pushing the signed, annotated version tag. State the exact tag, commit, repository, and
branch before acting. A generic commit, push, or pull-request request does not authorize a tag or
release. Do not bypass hooks or force a tag.

After the authorized source tag push, watch every native build and the final cross-repository publish
job. Because that job clears the public draft flag automatically after checks, stop and investigate
any failed or surprising job; do not assemble a partial release manually under the same tag.

## Verify and announce

Once GitHub reports the release as public:

1. Confirm all archives, `SHA256SUMS`, installer scripts, and license/notices are visible under the
   correct `getclarvis/clarvis-releases` tag and that no uploaded filename or archive member ends in
   `.map`, case-insensitively, or embeds an inline source map.
2. Run each published installer from the tag URL on a clean supported platform.
3. Verify `clarvis --version`, first-run setup, `clarvis --update`, and the documented removal path.
4. Check README badges and links, the public changelog entry, private vulnerability reporting, issue
   forms, branch/tag rulesets, and the GitHub Community Profile.
5. Record platform evidence and any launch incident. If a release must be superseded, publish a new
   version and explain the affected one; do not mutate its binaries.
