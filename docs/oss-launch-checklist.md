# OSS launch checklist

This checklist separates repository content from external GitHub settings. A checked-in file cannot
enable private reporting, protect a branch, configure organization contact details, or prove a native
release. Record an owner and evidence for every external item before announcing the OSS beta.

## Repository content

- [ ] README install commands point to a tag that actually exists.
- [ ] User guide, terminal matrix, troubleshooting, support, security policy, code of conduct,
      contribution guide, changelog, release runbook, architecture, and third-party notices match the
      release commit.
- [ ] The release commit contains a dated `0.0.1-beta` changelog entry and leaves `[Unreleased]`
      ready for later work.
- [ ] Every archive contains Clarvis's license, the Bun license/relink information, the models.dev
      and Vercel AI SDK licenses, generated dependency notices, and retained package license files.
- [ ] The repository history and release payloads have been scanned for credentials, tokens, private
      fixtures, generated state, source maps, and developer-local paths.
- [ ] Issue forms and the pull-request template render correctly in GitHub's preview.

## GitHub organization and repository settings

- [ ] Set the public description, website, and topics for `getclarvis/clarvis`.
- [ ] Publish a monitored confidential conduct contact and replace the prelaunch wording in
      [`CODE_OF_CONDUCT.md`](https://github.com/getclarvis/clarvis/blob/main/CODE_OF_CONDUCT.md).
- [ ] Enable private vulnerability reporting and confirm the link in
      [`SECURITY.md`](https://github.com/getclarvis/clarvis/blob/main/SECURITY.md).
- [ ] Configure secret scanning, push protection, and Dependabot security updates where available.
- [ ] Protect the default branch with required current CI checks and reviewed pull requests.
- [ ] Protect release tags from deletion or movement; decide and document commit/tag signing policy.
- [ ] Review GitHub Actions permissions, third-party action pinning, trusted publishers, environments,
      and every release secret.
- [ ] Decide whether GitHub immutable releases will be enabled and align the release runbook.
- [ ] Verify the Community Profile recognizes the README, license, contribution guide, code of
      conduct, issue templates, and security policy.

Do not add funding, governance, CODEOWNERS, a CLA/DCO, or citation metadata until the responsible
owners and policy have actually been chosen.

## Release evidence

- [ ] Run `RELEASE_TAG=v0.0.1-beta bun run check:release` and the repository's complete quality gate
      on the release commit.
- [ ] Run the non-publishing manual workflow successfully on all six native target jobs.
- [ ] Download and inspect the six manual-run archives and SHA-256 sidecars; inspect their embedded
      notices and license files. The combined `SHA256SUMS`, installers, standalone notices, and
      attestations exist only after the authorized tag workflow assembles the publication set.
- [ ] Install and launch on clean glibc-based Linux x64/arm64, macOS Intel/Apple silicon, and Windows
      x64/arm64 environments, recording terminal and hardware/virtualization evidence.
- [ ] Verify first-run setup, one real provider request under an owner-controlled test account,
      session continuation, headless output, managed update, rollback retention, and removal.
- [ ] Confirm macOS Gatekeeper and Windows SmartScreen documentation against observed unsigned-beta
      behavior, or complete signing/notarization before changing those claims.
- [ ] Freeze the changelog and review commit/pull-request metadata before the authorized tag push;
      the workflow generates GitHub release notes and publishes after successful upload without a
      human approval pause.

## Launch and follow-through

- [ ] Obtain immediate authorization for the exact release commit/tag and, separately, its push.
- [ ] Watch every release job through the final draft-to-public transition.
- [ ] Verify public assets and installers from the tagged URLs, not local fixtures.
- [ ] Deploy the release-matched site to `clarvis.dev`, verify DNS and TLS, then crawl the English and
      Brazilian Portuguese HTML and Markdown routes, canonical/hreflang links, sitemap, robots file,
      and `llms*.txt` discovery files from the public origin.
- [ ] Publish the announcement with beta limitations, supported evidence, checksum guidance, security
      route, and support expectations.
- [ ] Monitor installation, security, and accessibility reports and define the decision point for the
      next beta or rollback release.
