---
name: clarvis-release-health
description: "Run an evidence-based Clarvis release preflight when assessing launch readiness, validating a beta tag, checking distributable artifacts, or separating proven gates from owner actions and unverified platform canaries. Do not use for publishing, tagging, or changing the product version."
---

# Clarvis release health

Produce a release-readiness verdict without publishing anything.

## Establish scope and identity

1. Read `AGENTS.md`, `README.md`, `RELEASING.md`, `docs/oss-launch-checklist.md`, `specs/known-issues.md`, `specs/cross-cutting/build-and-ci.md`, `specs/cross-cutting/distribution-and-updates.md`, and `specs/cross-cutting/test-architecture.md`.
2. Inspect `git status --short`, the root manifest version, installers, release workflows, and current diff.
3. Verify `git config --local --get core.hooksPath` is `.githooks`; use `bun run hooks:install` only if it is not.
4. Treat the requested release tag and product version as owner decisions. Never choose or change them implicitly.

Honor deliberate publication sequencing. Do not classify intentionally deferred public-repository or live-site population as a release defect, and do not add that temporal state to documentation. Validate the checked-in site source and build unless live deployment is explicitly in scope.

## Build an evidence ledger

Track each item as `pass`, `fail`, `unverified`, or `owner decision`, with its exact command or source. Keep these evidence classes separate:

- repository contract and static checks;
- unit, component, contract, integration, architecture, and end-to-end tests;
- local distributable construction and first-paint/install smokes;
- native operating-system CI or canaries;
- live provider/account canaries;
- external launch operations controlled by the owner.

A workflow label is not a completed native canary. A synthetic provider test is not a real entitled-account canary. A successful archive build is not an install smoke. Do not call a beta production-ready from partial evidence.

## Run the repository gates

Use Bun from the repository root. Do not run `bun run check:pre-commit` as a handoff ritual.

For a comprehensive preflight, run:

```bash
bun run check:bun-version
bun run build
bun run docs:build
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run test:coverage
bun run check:specs
bun run check:graph
bun run check:harness
bun run check:release
```

When the owner has supplied the exact tag, also run:

```bash
RELEASE_TAG=vX.Y.Z-prerelease bun run check:release
```

Do not substitute an assumed tag. Classify known Bun process crashes separately from assertion failures using `specs/known-issues.md`; retry only where that document supports it, and report both attempts.

## Prove the distributable

After the build and static gates pass, replace the diagnostic Code bundle with the no-source-map install artifact, then package and smoke it in order:

```bash
bun --filter @clarvis/code build:install
bun run release:package
bun run release:smoke
bun run release:install-smoke
```

Inspect the produced manifest, checksums, notices, licenses, and target name rather than inferring them from command success alone. Confirm release-workflow permissions, immutable action revisions, credentialless checkout, tag-only publication guards, and artifact naming through the checked-in gate and source review.

Do not claim support for an OS/architecture unless the corresponding native job or explicit evidence completed for this release. Record unavailable environments as unverified, never passing.

## Close launch risks honestly

Review public wording with `$clarvis-doc-health` when docs changed or release evidence changes a claim. Keep these boundaries explicit:

- provider availability, entitlement, billing, and endorsement remain provider-controlled;
- credential hygiene, workspace trust, command review, and process sandboxing are distinct safeguards;
- remaining known TOCTOU, accessibility, signing, and platform gaps stay visible at beta severity;
- private security intake, contacts, announcements, deployments, and rollback decisions are owner actions, not repository test results.

Never run `git add`, `git commit`, `git push`, `git merge`, `git rebase`, create a tag, open a pull request, publish a release, or deploy without immediate authorization for that exact action and destination.

## Report the verdict

Lead with one of:

- **ready on verified scope** — every required local gate and artifact smoke passed, with external items classified separately;
- **conditionally ready** — repository gates pass but named evidence or owner decisions remain;
- **not ready** — a required gate or truthful launch claim fails.

Then list exact checks, artifact evidence, documentation disposition, known or unverified platforms, owner actions, and the absence of publication actions.
