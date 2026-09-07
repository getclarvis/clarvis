# Releasing Clarvis

This is the maintainer runbook for a portable Clarvis release. Reading or running local validation
does not authorize a tag, push, GitHub Release, or any other publication action.

## Release contract

- Root `package.json` is the only product-version authority.
- A final release tag is exactly `v<version>`, annotated, and signed by the authorized releaser.
- The release workflow builds glibc-based Linux, macOS, and Windows archives for x64 and arm64 on
  native runners.
- A pushed final tag also builds `linux/amd64` and `linux/arm64` isolated-runtime carrier/final images,
  publishes their multi-platform indexes in the source repository's GHCR, attests both subjects,
  and emits `runtime-release.json` with the exact digests and private protocol revision.
- A tag-triggered workflow in `getclarvis/clarvis` uploads a complete draft to public
  `getclarvis/clarvis-releases` and activates it in its final step. There is no human pause after the
  tagged workflow starts.
- The source repository's `GITHUB_TOKEN` is read-only by default and receives `Packages: write` only
  inside the two GHCR jobs. Cross-repository publication uses the `Clarvis Release Publisher` GitHub
  App, installed on `clarvis` and `clarvis-releases` with `Contents: write`. Its Client ID is repository
  variable `CLARVIS_RELEASE_APP_CLIENT_ID`; its private key is repository secret
  `CLARVIS_RELEASE_APP_PRIVATE_KEY`.
- The final publish job independently extracts all six archives, rejects any case-insensitive
  `.map` suffix, inline `sourceMappingURL=data:` payload, malformed/runtime-version-mismatched
  `runtime-release.json`, and non-allowlisted asset, rechecks every sidecar and `SHA256SUMS`, and only
  then mints the short-lived GitHub App token.
- A manual workflow dispatch builds downloadable portable artifacts but cannot publish a runtime
  image or release.
- Active source-repository rulesets protect `main`, `develop`, and release tags. Published releases in the
  distribution repository are immutable: fixes use a new version; never move or reuse a release tag.

## Automation setup

Before activating [the Gitflow workflow](.github/workflows/gitflow-release.yml), reuse `Clarvis Release Publisher`, installed on `getclarvis/clarvis` and
`getclarvis/clarvis-releases` with `Contents: write`. Both workflows use repository variable
`CLARVIS_RELEASE_APP_CLIENT_ID` and secret `CLARVIS_RELEASE_APP_PRIVATE_KEY`. Permit that App to create tags
in the tag-creation ruleset; keep tag updates/deletions blocked and permanent branch protections
intact. Each installation token is scoped to one repository: tag creation uses `clarvis`;
distribution publication uses `clarvis-releases`.

Store a dedicated, unencrypted SSH automation signing key in secret `CLARVIS_TAG_SIGNING_KEY`;
keep its public counterpart in [tooling/release/tag-signing-key.pub](tooling/release/tag-signing-key.pub).
Never reuse a maintainer's personal key. The workflow writes the secret only to a temporary directory,
checks it matches the tracked public key, verifies tags against that pinned identity, and removes
the temporary directory on exit. This establishes cryptographic verification in the workflow;
it does not claim a GitHub account-level Verified badge for the App's SSH signatures. The source App token is required because a tag pushed with
`GITHUB_TOKEN` does not trigger the downstream release workflow.

These credentials and external ruleset permissions must be checked live before calling the
integration operational. Local tests use temporary repositories and throwaway signing keys; they
do not establish GitHub App permissions or successful public publication.

## Image channels and first publication

Candidate images live in `ghcr.io/getclarvis/clarvis-runtime-candidate-artifact` and
`ghcr.io/getclarvis/clarvis-runtime-candidate`, linked to the source repository. The signed RC tag
starts native amd64 and arm64 builds on Ubuntu 26.04 runners with Podman 5.7. The image itself
still uses the pinned Debian base. Ubuntu 24.04's Podman 4.9 cannot implement the required volume
subpath contract; engine tests must not weaken that contract to accommodate an older runner. Each runnable image must pass the existing real-engine Docker
and rootless Podman canaries before its digest is included in a candidate index. These canaries use
a deterministic model provider; they do not establish a live subscription result. The source
prerelease attaches `runtime-candidate.json`, which is deliberately separate from the stable manifest.
New installable candidates declare `installation: "source-v1"`. Use `./dev-install.sh --candidate`
for the newest published RC among the latest 100 source releases, or supply an exact RC tag. This
installs an isolated source checkout using the candidate's pinned Bun and pulls its Docker image
before replacing `clarvis-develop`; Git and Docker must already be available. The existing image-only
RCs cannot be installed this way. The stable portable installer and updater remain separate.
Candidate source/image matching is enforced again on Docker runtime initialization. Previous
candidate checkouts and images are retained; reinstall selects a newer candidate explicitly.
The root version remains the prepared final version; the RC tag and candidate channel identify
these non-stable images. No stable installer is published from an RC.

Official images use `ghcr.io/getclarvis/clarvis-runtime-artifact` and
`ghcr.io/getclarvis/clarvis-runtime`, linked to `clarvis-releases`. Both official packages must be
public and grant Actions write access to `clarvis`; registry writes use its job-scoped
`GITHUB_TOKEN`, not the Publisher App token. Source/revision OCI labels and attestations continue
to identify the source build even when the official package is connected to the distribution repo.

Multi-platform index assembly uses the runner-provided Docker Buildx plugin and verifies its
availability before use; it requires no third-party action allowlist expansion.

GHCR package controls exist only after the first image push. At first publication, verify the
package's connected repository, visibility, and Actions access in GitHub; creating a public Git
repository does not prove that a newly pushed package is public. The stable publish job attempts
anonymous pulls of both exact manifest digests and refuses to activate the release if either fails.
Keep official digests and their attestations for every published release. Do not apply candidate
cleanup rules to official packages. No automatic deletion is configured.

Build staging tags include the workflow run and attempt. Candidate version indexes are never
silently overwritten: an existing index stops publication and requires inspection. A partially
published candidate is not qualified merely because some registry blobs exist. Retry failed jobs
before index publication; after an index has been written, investigate and use a new candidate
when rebuilding would change its digest. Stable releases accept only exact `v<major.minor.patch>`
tags; prereleases remain in `clarvis`. Historical distribution prereleases are preserved.

## Branch lifecycle

`develop` carries the next version. Between releases, `main` must equal the source commit of the
latest published release tag. Release preparation stays on `release/<major.minor.patch>` until
the owner authorizes the release promotion. Ordinary task PRs never target `main`.

The protected merge into `main`, final checks, signed tag push, and asynchronous publication form
one release in progress. During this window, `main` temporarily leads the last published tag.
Serialize promotions: do not merge another release or unrelated work into `main` before publication
finishes. If a check or publication fails, report the release as incomplete and investigate; do not
reset `main`, move a tag, or disable protections without separate explicit authorization.

## Prepare

1. Confirm the release version, intended audience, known limitations, and rollback owner.
2. Create `release/<major.minor.patch>` from qualified `develop`. From a branch without unrelated changes, record user-facing changes under `Unreleased` in
   [CHANGELOG.md](CHANGELOG.md), then run
   `bun run release:prepare <version>`. This promotes that entry and updates the root product version
   and both installer defaults as one validated operation. It does not commit, tag, or publish.
   Commit this preparation before the first branch push. The root version is the final version
   (for example `0.2.0`); RC tags label source snapshots and do not change the product version.
   Push the branch, then open its PR into `main` to create `v0.2.0-rc.1`.
   Branch pushes alone create no candidate. Each different head commit while the PR is open
   receives the next RC number. Reopening or retargeting a PR into `main` also evaluates its head;
   closing without merge stops new candidate tagging. Existing tags remain intact.
   Repeating a run for the same commit reuses its tag. `release.yml` excludes `v*-rc.*` pushes, so
   candidates cannot publish stable installers or official runtime images. The separate
   `candidate.yml` workflow publishes only candidate packages and a prerelease in `clarvis`. Wait for each candidate run before
   pushing another revision: GitHub concurrency serializes tag writes but can replace pending runs
   during rapid pushes. A replaced run creates no candidate; its newer revision is the candidate.
   Candidate tagging after its final tag exists fails and requires a new release version.
   Wait for a candidate tag on the final
   branch head before merging; existing tags are never overwritten.
3. Review [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md), and the open questions in
   [`specs/cross-cutting/distribution-and-updates.md`](specs/cross-cutting/distribution-and-updates.md).
4. Verify the root version, installer defaults, source identity, and public distribution identity
   agree. Supply the intended `RELEASE_TAG` to `check:release` when validating tag identity before
   publication.
5. Review [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), the exact Bun license/relink notice, the
   models.dev and Vercel AI SDK licenses, the portable dependency closure, and the licenses copied
   into the isolated-runtime carrier. Treat third-party-license review as a release gate, not a
   post-release task.
6. Review the exact source commit that the distribution release notes will disclose.
7. Confirm the source `main`, `develop`, and `v*` rulesets are active, GitHub Actions requires full-SHA action
   pins, the scoped App variable/secret are present, and `clarvis-releases` reports immutable releases
   as enabled. Treat a missing policy as a release blocker.
8. With explicit authorization for the release promotion, commit and merge the reviewed release
   preparation into `main` through the normal protected-branch
   workflow, using a merge commit rather than squash or rebase. Then use a clean checkout of that
   exact `main` source commit for verification. The automation waits for all three required CI
   contexts on that commit before creating the final signed tag; complete manual preflight before
   merging because there is no subsequent approval pause. Synchronize release changes back into
   `develop` with a merge PR so version metadata and fixes remain shared. Never promote unrelated
   next-version work merely to synchronize a release.

Hotfix preparation uses `hotfix/<version>` from the latest published tag and propagates the fix
into `develop` and any active release branch. If `main` already includes unreleased changes, settle the
intended patch-release lineage before merging or tagging; do not accidentally include those changes
in the patch. Stage the hotfix on `release/<patch-version>` for candidate tagging and final
promotion; a direct `hotfix/*` PR does not trigger the automation. Only merged, same-repository
`release/*` PRs targeting `main` qualify. The merge must preserve both parents, `main` must still
equal that merge SHA, and the release head must have a candidate. Failures stop tag creation.

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

On a qualified Docker/Colima host, also run
`bun run runtime:build:dev -- clarvis-runtime:release-canary`, resolve the printed local image ID,
and execute the gated Docker runtime canary against it. This is current-source evidence only; it does
not publish or emulate a registry attestation.

Run the manual `workflow_dispatch` path to exercise every native runner without publishing. Download
the six workflow artifacts and confirm:

- every target job passed its manifest, fast-path, and applicable PTY smoke;
- archive names, sizes, and SHA-256 sidecars are complete, and every archive contains its required
  notices and license files;
- a clean machine can install, run `clarvis --version`, launch first paint, and update through a
  controlled release fixture;
- unsigned macOS and Windows behavior is accurately described in the docs;
- no source map, secret, private fixture, or developer path is present in any archive.

The complete `release-assets` allowlist also requires the real `runtime-release.json`, which exists
only after the tag-only GHCR jobs resolve their registry digests. Do not fabricate it to make a
manual dispatch look like a publication rehearsal. The tag workflow runs that complete gate before
it obtains the cross-repository publication credential.

The public documentation repository resolves the newest complete published release during its
build and rebuilds on a schedule. A patch release therefore requires no documentation version bump;
after publication, verify that its next successful deployment materialized the new version and
immutable installer URLs.

## Publish

With this automation configured, the owner's explicit request to push a prepared release branch
includes candidate tagging; the explicit request to merge its release promotion includes the final
signed tag and public release. State the version, source branch, repository, and automatic publication
effect before merging. A generic task commit, push, or PR request does not authorize that promotion.
Do not bypass hooks or force a tag. Do not push a second manual final tag after automation starts. If the final tag exists but
publication failed, inspect and rerun the failed downstream release run; rerunning tag creation
verifies the existing tag and does not emit a second push event.

After the authorized source tag push, watch every native build, both runtime architecture jobs, the
multi-platform manifest/attestation job, and the final cross-repository publish job. Because that job
clears the public draft flag automatically after checks, stop and investigate any failed or
surprising job; do not assemble a partial release manually under the same tag.

## Verify and announce

Once GitHub reports the release as public, compare the remote `main` SHA, the source tag peeled to
its commit, and the source commit disclosed by the distribution release. All three must match before
calling the release complete. Synchronize `main` back into `develop` through a merge PR and carry
fixes into any active release branch; keep any subsequent development on `develop`.

Then:

1. Confirm all archives, `SHA256SUMS`, `runtime-release.json`, installer scripts, and
   license/notices are visible under the correct `getclarvis/clarvis-releases` tag and that no
   uploaded filename or archive member ends in `.map`, case-insensitively, or embeds an inline source
   map.
2. Run each published installer from the tag URL on a clean supported platform.
3. Verify `clarvis --version`, first-run setup, `clarvis --update`, and the documented removal path.
4. Check README badges and links, the public changelog entry, private vulnerability reporting, issue
   forms, branch/tag rulesets, and the GitHub Community Profile.
5. Resolve both GHCR references from `runtime-release.json`, verify their platform set and GitHub
   attestations, pull the final image by digest, and run the gated Docker runtime canary against its
   local immutable image ID.
6. Record platform evidence and any launch incident. If a release must be superseded, publish a new
   version and explain the affected one; do not mutate its binaries.
