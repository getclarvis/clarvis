# Changelog, known issues and publication state

These documents serve different readers. First read [RELEASING.md](../../../../RELEASING.md),
[the changelog](../../../../CHANGELOG.md), and the scope statement of
[known issues](../../../../specs/known-issues.md). Inspect release preparation code before changing
heading conventions: `promoteChangelog` in
[release-prepare.ts](../../../../tooling/lib/release-prepare.ts) consumes `## [Unreleased]` and
creates a versioned entry before publication. A versioned heading or date is therefore not proof
of a completed release.

## Establish which product was observed

Record separately the current commit/worktree, root manifest version, prepared release/candidate,
and latest actually published release. Inspect exact remote release metadata when making a current
publication claim: stable distribution is published in `getclarvis/clarvis-releases`, while source
candidates are prereleases in `getclarvis/clarvis`. A draft, local tag, RC, green CI run or version on
`develop` does not prove stable publication. Use attributable release/source identities; do not
assume the highest local tag is the current public release.

If remote evidence is unavailable, state publication as unverified and continue local analysis.
Never infer affected released versions from the version of the checkout where a bug was found.
Likewise, a fix merged into `develop` is fixed in source, not necessarily available to installed
users. An RC can have affected users of that candidate without affecting a stable release.

## Choose the destination

| Information                                                                          | Destination and treatment                                                                                  |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Current supported behavior, configuration or invariant                               | Owning README/spec and relevant shipped clarvis-docs pages                                                 |
| Meaningful user-facing difference from a published baseline                          | Curated pending changelog entry, or the explicitly prepared release section                                |
| Confirmed unresolved defect in development, a candidate or a release                 | Known issue with observed source/artifact and verification scope                                           |
| Confirmed environment limitation or costly diagnostic finding needed for future work | Known-issues evidence, clearly separated from product defects                                              |
| Intermediate bug introduced and fixed before release                                 | Regression test and current contract; normally fold its final outcome into the pending feature note        |
| Unexecuted test, speculative risk or a checklist item                                | Validation gap in the work report; not automatically a known product defect                                |
| Investigation chronology, discarded attempts and routine fixes                       | Work record or Git history; retain in known issues only when concrete evidence prevents repeated diagnosis |

Do not remove an unresolved development defect solely because it has not shipped. Record its
development/candidate scope instead. Conversely, do not keep resolved implementation details
looking like active user-facing limitations.

## Curate the changelog

- Establish the comparison baseline from the intended release lineage. Describe the final observable
  difference, not every internal iteration. Coalesce duplicate Added/Changed/Fixed categories and
  overlapping bullets within the same pending section while preserving distinct user impacts.
- Keep one clearly identified destination for each pending change. If both `Unreleased` and a
  versioned unreleased block exist, determine whether an explicitly prepared release branch owns
  the latter and whether the former is genuinely later work. If no such separation exists, propose
  or perform a scoped consolidation under `Unreleased` when editorial cleanup is authorized.
  Never move later development work into an active release merely to simplify the file.
- A feature introduced and refined entirely before release normally needs one final feature note.
  A separate fix is useful when it corrects behavior users received in a published release or
  candidate, or has distinct user impact; name that scope when relevant.
- Verify pending statements against current source: reverted changes and features removed before
  release must not remain promises for that release. Preserve published historical entries, except
  for attributable factual corrections; do not rewrite history to match today's implementation.
- Do not invent release dates, choose/bump versions, run `release:prepare`, relabel tags or publish
  as part of documentation synchronization. Release preparation requires its existing explicit
  authorization. Respect the current release tooling rather than changing its grammar incidentally.

## Keep known issues operational

For new or materially revised entries, include the observed source/artifact and environment,
symptom/user impact, reproduction or retained evidence, status, workaround if established, and
what verification would close it. Distinguish `open`, `mitigated`, `fixed in source; validation
pending`, and `resolved`. Record released-version impact separately as verified or unknown.
For historical entries, distinguish missing original evidence from a newly reproduced result.
Do not invent version attribution or rerun measurements merely by reading source.

Keep active defects, environmental constraints, pending qualification and retained historical
diagnoses visibly distinct. A resolved diagnosis can remain useful, but should not read like an
open defect. For a broad cleanup, consider a short active index and clearly marked history sections;
follow existing inbound links and preserve unique measurements/reverted approaches before moving
anything. A documentation edit alone cannot resolve a PTY, provider, native-platform or performance
gap; retain its actual evidence requirement.

The existing known-issues file intentionally retains diagnostic history. Do not delete all resolved
entries or migrate them wholesale into the changelog. Not every experiment is release history.
Keep source citations stable and follow the repository's timeless-spec rules: use commit, artifact,
release and run identities in issue evidence; do not add calendar dates to tracked specs.

## Close with bounded claims

Report the baseline/publication evidence, pending sections consolidated or kept separate and why,
issues reclassified, and unresolved attribution/verification gaps. Check links after moving entries
and run `bun run check:specs` plus scoped formatting. No wording check proves publication or that
an issue is fixed. If the task is only analysis or workflow improvement, present findings and the
proposed editorial policy without silently reorganizing the entire historical corpus.
