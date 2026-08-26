# OSS launch checklist

This checklist separates repository content from external GitHub settings. A checked-in file cannot
enable private reporting, protect a branch, configure organization contact details, or prove a native
release. Record an owner and evidence for every external item before announcing the OSS beta.

Checked external items below record evidence observed for `v0.0.1-beta` on 2026-08-26. They are a
launch record, not a substitute for rechecking mutable GitHub settings before a later release.

## Repository content

- [x] README install commands point to a tag that actually exists.
- [ ] User guide, terminal matrix, troubleshooting, support, security policy, code of conduct,
      contribution guide, changelog, release runbook, architecture, and third-party notices match the
      release commit.
- [x] The release commit contains a dated `0.0.1-beta` changelog entry and leaves `[Unreleased]`
      ready for later work.
- [x] Every archive contains Clarvis's license, the Bun license/relink information, the models.dev
      and Vercel AI SDK licenses, generated dependency notices, and retained package license files.
- [ ] The repository history and release payloads have been scanned for credentials, tokens, private
      fixtures, generated state, source maps, and developer-local paths.
- [ ] Issue forms and the pull-request template render correctly in GitHub's preview.

## GitHub organization and repository settings

- [x] Set the public description, website, and topics for `getclarvis/clarvis`.
- [x] Publish `hello@clarvis.dev` as the monitored confidential conduct contact in the organization
      profile and replace the prelaunch wording in
      [`CODE_OF_CONDUCT.md`](https://github.com/getclarvis/clarvis/blob/main/CODE_OF_CONDUCT.md).
- [x] Enable private vulnerability reporting and confirm the link in
      [`SECURITY.md`](https://github.com/getclarvis/clarvis/blob/main/SECURITY.md).
- [x] Configure secret scanning, push protection, and Dependabot security updates where available.
- [x] Protect the default branch with signed commits, reviewed pull requests, resolved conversations,
      and the current Linux, Windows, and macOS CI checks. Organization administrators may bypass
      only through a pull request.
- [x] Protect `v*` release tags from deletion or movement and require signed releases.
- [x] Review GitHub Actions permissions, third-party action pinning, trusted publishers, environments,
      and every release secret.
- [x] Enable GitHub immutable releases for future publications. The setting was enabled after
      `v0.0.1-beta`, so that historical release still reports `immutable: false`; do not treat it as
      evidence that the repository setting is disabled.
- [x] Verify that the Community Profile reports 100% health and that the README, license,
      contribution guide, code of conduct, pull-request template, issue forms, and security policy are
      present. GitHub's API does not populate its legacy `issue_template` field for these YAML forms.
- [x] Choose `evandrocabf` as the temporary account that receives Clarvis sponsorships and configure
      [`.github/FUNDING.yml`](https://github.com/getclarvis/clarvis/blob/main/.github/FUNDING.yml).
- [x] Activate the public [GitHub Sponsors profile for
      `evandrocabf`](https://github.com/sponsors/evandrocabf). For the initial launch, the owner kept
      custom sponsorship amounts only and published no tier.

Do not add governance, CODEOWNERS, a CLA/DCO, or citation metadata until the responsible owners and
policy have actually been chosen.

## Release evidence

- [x] Run `RELEASE_TAG=v0.0.1-beta bun run check:release` and the repository's complete quality gate
      on the release commit. The
      [release workflow](https://github.com/getclarvis/clarvis/actions/runs/32998576908) and
      [same-commit CI](https://github.com/getclarvis/clarvis/actions/runs/32997847446) passed.
- [x] Run the
      [non-publishing manual workflow](https://github.com/getclarvis/clarvis/actions/runs/32998292867)
      successfully on all six native target jobs.
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

- [ ] Record explicit authorization for the exact release commit, tag, repository, and publication;
      generic commit, push, or pull-request authorization does not cover a release.
- [x] Watch every release job through the final draft-to-public transition.
- [x] Verify public assets, checksums, provenance, and the Linux x64 installer from the tagged URLs,
      not local fixtures.
- [ ] Deploy the release-matched site to `clarvis.dev`, verify DNS and TLS, then crawl the English and
      Brazilian Portuguese HTML and Markdown routes, canonical/hreflang links, sitemap, robots file,
      and `llms*.txt` discovery files from the public origin.
- [ ] Publish the announcement with beta limitations, supported evidence, checksum guidance, security
      route, and support expectations.
- [ ] Monitor installation, security, and accessibility reports and define the decision point for the
      next beta or rollback release.
