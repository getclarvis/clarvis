# Full audit against current source

Use this mode to recover documentation after accumulated changes, without selecting a commit range.
The deliverable is corrected documentation plus evidence of corpus coverage, not just findings.
For an explicitly review-only request, retain the same coverage discipline and report corrections
without editing. Apply the shared rules in [SKILL.md](../SKILL.md).

## Inventory the current repository

Record the checkout/worktree identity and protect existing edits. Git status is useful for safety;
Git history is optional context, never the boundary of this audit. Include current local changes and
new source files. If Git metadata is unavailable, use filesystem discovery and record that limit.

Build two inventories independently so stale documentation cannot determine what source is read:

- **Source surfaces:** discover workspaces from current manifests, public exports and application
  entrypoints; inspect registrations, schemas, defaults, capabilities, persistence, lifecycle and
  recovery paths, and cross-package consumers. Include repository scripts, installers, build/release
  tooling and workflows. Follow reachable implementations and tests beyond the entrypoint; a type,
  leftover file or test name alone does not establish an active product feature.
- **Documentation:** inventory maintained Markdown/MDX and model-facing guidance embedded in source.
  Include the root and every workspace README, spec index and owning specs, contributor/release and
  security guidance, changelog, known issues, repository skills, shipped clarvis-docs and TUI scenario
  resources. Inspect document contents, not only titles, citations or search hits. The spec index is
  a routing aid that may itself be stale.

Use manifest paths and `rg --files --hidden` with appropriate exclusions when needed; avoid traversing
dependencies, generated build output, caches or live user state. Classify generated documents by
their generator, historical records by their original context, and fixtures/examples by purpose.
Exclude ignored local proposals and unrelated vendored material with an explicit reason. Do not
hand-edit generated facts; use their owning tooling when correction is needed.

The external `getclarvis/docs` site remains a separate corpus. Report its impact and availability;
do not imply it was audited when only this repository was inspected.

## Delegate by topic

Full audit explicitly authorizes and instructs using sub-agents for independent thematic slices
when delegation is available. Do not ask for separate delegation confirmation under this mode.
Before spawning, ask which available model to use unless the user has already selected one for
this audit. Honor any specified reasoning effort as well; never silently substitute another model.
Wait for the model choice before spawning, while continuing independent inventory work when
permitted. A prior choice remains valid across assignments and continuations; do not ask again.
Honor an explicit user restriction on delegation, model or reasoning effort; when agents are
unavailable or prohibited, keep the same coverage requirements and work sequentially. This does
not authorize publication or broaden the selected audit scope.

Derive assignments from both inventories: for example, engine/foundations, capabilities/host
services, TUI, and repository tooling/distribution. Each assignment owns named documents and their
implementation/test evidence, including applicable open questions. Give shared files one writer;
send cross-topic findings to that owner instead of making overlapping edits. Preserve existing
work and communicate ownership transfers before writing.

The coordinator maintains the shared work record, tracks pending coverage and reconciles contracts
across assignments. Each sub-agent returns corrected files, named source/test evidence, per-document
dispositions, unresolved questions and actual check results. Consolidate them into the two coverage
views and impact ledger, then coordinate final validation on the combined changes. Agent completion
alone does not prove corpus coverage or that a check ran. If the user reserves the coordinator for
delegation and monitoring, assign final editing and validation to a sub-agent as well.

## Review in both directions

Work package by package and then across shared contracts. Prioritize risky claims first, but do not
replace full coverage with a sample or a selection of recently touched files.

1. **Source to docs:** derive current reachable behavior from implementation, configuration and
   wiring. Map each surface to its README/spec and applicable user/model guidance. Identify missing
   documentation as well as obsolete text: newly available commands, settings, defaults, permissions,
   formats, lifecycle, failure/recovery behavior and coupling may have no existing search term.
2. **Docs to source:** trace every substantive current claim and example to its implementation and
   applicable tests. Check symbols and semantics, not just file existence. Remove or correct retired
   features, obsolete commands, stale prerequisites and unsupported claims. Specs retain only the
   current contract, without notices describing removed features. Historical release descriptions
   and useful diagnostic evidence belong to the changelog and known-issues record respectively.
3. **Across destinations:** reconcile overlapping root/package README, spec, source guidance,
   repository skill, shipped clarvis-docs and TUI claims. Use [shipped-docs.md](shipped-docs.md) for
   product guidance and [release-records.md](release-records.md) for release/issue classification.
   Inspect every applicable TUI matrix row against current reachable behavior and identify uncovered
   journeys; follow the main skill's scenario/profile maintenance rules. This remains static work,
   not an assertion that E2E scenarios have run.
4. **Open questions:** apply the shared
   [current-contract and open-question rules](../SKILL.md#current-contracts-and-open-questions) to
   every inventoried section. Trace each item to current evidence; remove answered, resolved and
   retired items, retain only genuine uncertainty, and remove empty sections. Track the disposition
   of each item or related group in the work record so an unchanged question is not assumed open.

The implementation establishes what currently happens, not whether that behavior is intended.
When it contradicts an invariant, security guarantee or stated contract, inspect tests, related
contracts and available owner decisions before editing. Do not erase an intended guarantee merely
to make documentation match a likely regression, and do not silently fix product code as part of a
documentation audit. Resolve supported documentation corrections and record genuinely undecidable
conflicts with both evidence sets; ask for the needed decision while continuing independent work.

Do not invent when a behavior was introduced or which release shipped it from current source alone.
Publication claims require release evidence; unavailable remote evidence stays explicitly unverified.

## Correct, track and finish

Maintain one work record with two coverage views and the shared impact ledger:

| Coverage view  | Required record                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source surface | Package/tooling owner, inspected entrypoints and relevant implementations/tests, destination files, disposition or missing-documentation finding |
| Documentation  | File/section, supporting source and test evidence, semantic review result, correction or concrete no-change reason                               |

Track items as pending, reviewed or blocked; every inventoried item must receive a disposition.
Grouping related claims is useful, but reading one section does not mark an entire package or
document reviewed. Exclusions and missing tests are explicit. Keep this record available across
long sessions so interruption does not discard coverage or force repeated discovery. A partial
audit must name the remaining packages, surfaces and documents; never label it complete.

Make supported corrections throughout the authorized corpus during the audit. Add missing owning
documentation and repair indexes/links when required. Do not finish with a recommendation list for
stale guidance that can be corrected under the existing request. Recheck renamed/removed terms in
context and independently verify newly discovered behavior has a destination.
Closure also requires reconciling all open-question dispositions and checking that specs and their
indexes contain neither retired contracts nor prose announcing their removal.

Use the main skill's targeted validation; a full documentation audit does not automatically need
the full product test suite, release gates or live-provider execution. Test existence and source
inspection remain distinct from successful runtime checks. If source inputs change while auditing,
revisit affected evidence and consumers without discarding completed independent reviews.

Finish only after both inventories are reconciled and every applicable destination is updated or
has a supported no-change reason. Report unresolved decisions, external corpus gaps and validation
limits separately; these prevent an unqualified claim that all documentation is current. Link/format
checks alone cannot establish semantic coverage. Review final edits (including new files) with Git
when available, or another before/after comparison when it is not; neither comparison defines scope.
