---
name: clarvis-doc-health
description: "Update Clarvis documentation from recent changes or run a full audit against current source without a Git diff. Covers root/package READMEs, specs, shipped clarvis-docs, TUI scenarios and other repository guidance."
---

# Clarvis documentation health

Trace material claims to evidence and make coherent corrections when edits are requested. Follow
[AGENTS.md](../../../AGENTS.md), including its scope, authorization, documentation, and evidence-reuse
rules. A documentation audit does not by itself require release qualification or live product E2E.
An update/synchronization request requires actual edits to stale guidance, not just a list of
recommendations. An explicitly review-only request produces findings without edits. Changing this
maintenance skill alone does not authorize an unrelated repository-wide documentation rewrite.

## Select the mode

- **Change sync:** synchronize documentation for recent changes, a PR or a supplied range. Use
  the change-set procedure below and trace each affected behavior to its documentation.
- **Full audit:** reconcile the complete current source and documentation corpus, including drift
  accumulated across unrelated changes. Read [full-audit.md](references/full-audit.md), then apply
  the shared claim, correction and validation rules below. No Git baseline, diff or usable history
  is required; unchanged files are in scope. Without a narrower requested boundary, cover this
  repository's current workspaces, tooling and maintained guidance. This mode explicitly instructs
  topic-based sub-agent delegation when available; follow the ownership and consolidation rules in
  the full-audit reference. Ask which model to use before spawning unless the user already selected
  one for this audit, and respect the user's delegation and reasoning-effort preferences.

An explicit named-document review remains bounded to that corpus. Honor a selected mode without
asking again; requests to recover documentation after many undocumented changes select full audit.
Both modes update stale documentation unless the user explicitly requests review only. Editing
this skill adds the mode; it does not execute the audit.

## Establish the change set (change sync only)

For “recent changes”, a PR, or post-implementation synchronization, start from Git evidence rather
than only searching documentation. Record the requested base/head or commit range and the current
worktree state. Inspect `git status --short --branch`, staged and unstaged diffs, and untracked files;
preserve existing work. Read commit bodies and actual patches, including renamed/deleted files.

- Use the user's range or PR base/head when supplied. For a task branch, resolve its merge base with
  the intended integration branch, then inspect that base-to-head diff plus current local changes.
- On the integration branch, comparing it to itself misses already merged changes. Inspect recent
  history to identify the relevant bounded change set; state the exact chosen range and rationale.
  “Recent” has no universal commit count or date cutoff. Ask when different plausible ranges would
  materially change the work; continue reviewing clearly relevant local changes meanwhile.
- Use `git diff --name-status <base> <head>` to route discovery, then read the relevant patches.
  `git diff`, `git diff --cached`, and `git ls-files --others --exclude-standard` cover work not in
  that committed range. Inspect new files explicitly; do not assume a plain diff contains them.
  If Git history/base is unavailable, report that limit and audit the supplied/current surfaces
  without claiming all recent changes were covered.

For a named-document audit, start with that corpus instead; history can explain a discrepancy but
must not silently broaden the assignment. Treat commit messages and existing docs as leads, not
proof of current behavior. Refactors can leave source citations stale even when behavior is unchanged.

## Bound the reading

Identify the affected claims and document families first. Use
[the spec index](../../../specs/README.md) to select owning specs, inspect their cited symbols/tests,
and read the [root README](../../../README.md) and relevant package READMEs. Search matching entries in
[known issues](../../../specs/known-issues.md) before repeating historical investigations. Read each
needed contract once and reuse its evidence while the inputs remain unchanged.

For broad or change-driven synchronization, the root README is a required destination even when
the Git diff changes no Markdown. For a narrowly named-document task, assess root/package README
impact without expanding beyond the authorized corpus; report any outside-scope stale claims.
Inventory package READMEs from current workspace membership, including affected consumers and
renamed or removed packages, rather than trusting only the root's existing package table.

For a repository-wide audit, start with tracked and unignored Markdown from the repository root:

```bash
git ls-files --cached --others --exclude-standard -- '*.md' '*.mdx'
```

Also inventory shipped agent guidance in TypeScript when present; a Markdown-only search can miss
product instructions embedded in source. Reviewed file-tool configuration is owned by the
[Kernel README](../../../packages/kernel/README.md#file-tool-configuration) and
[self-configuration contract](../../../specs/hosts/self-configuration.md).

When the scope includes release notes, unresolved defects, development fixes or publication claims,
read [release-records.md](references/release-records.md). Distinguish the checkout's product version
from a published release, and give `CHANGELOG.md` and `specs/known-issues.md` explicit dispositions
in the impact ledger. Do not append each development iteration to both documents automatically.

Distinguish product documentation, repository skill instructions, proposals, and intentionally
invalid test fixtures. The public site and its English/Portuguese pages belong to the separate
`getclarvis/docs` repository. Inspect or edit that corpus only when it is in scope and available;
otherwise record the external documentation disposition. Do not search for or add a local `docs/`
site tree in this monorepo.

## Establish each claim

Keep one compact impact ledger, grouped by behavioral change in change sync or current behavioral
surface in full audit, rather than one row per source file:

| Change / evidence | Before → current behavior | README / owning specs | Shipped clarvis-docs pages | TUI scenarios / profiles | Other affected guidance | Disposition / validation |
| ----------------- | ------------------------- | --------------------- | -------------------------- | ------------------------ | ----------------------- | ------------------------ |

Every behavior-bearing change or audited current surface needs a disposition for each applicable destination:
`updated`, `reviewed; no change needed` with a concrete reason, or `blocked` with the missing
decision/resource. Name actual files and sections; “docs checked” is not a disposition. Include
new behavior with no existing documentation, removed options/examples and cross-package consumers.
Check user-visible setup, API/schema, defaults, paths, permissions, activation timing, failure and
recovery changes even when the changed file is internal. Pure formatting can be grouped and excluded
with that reason.

Trace applicable links through public guide, package README, owning spec, production symbol, and
test or explicit gap. Record whether the evidence is a durable contract, current implementation,
an actually completed check, or temporal external state. A test's existence proves a declared
assertion, not a successful run, live entitlement, or native support.

Inspect install/update commands, defaults, retention, failure behavior, configuration scope,
ownership, security/trust/subscription wording, platform and performance claims, and translated
counterparts. Use risky absolutes as search leads, not automatic defects. Do not turn intentionally
deferred publication or a temporary deployment/account state into a durable product claim.

When code and spec disagree, use the owner's decision, current tests, adjacent contracts, and
history where needed to determine the correction. Report a genuinely unresolved product decision
with both sides of the evidence; do not invent one.

Keep source references stable: link the file and name its symbol or test, without source line
numbers. Remove unnecessary counts rather than continually recounting them. Specs contain no LOC
inventories or change dates; chronology belongs in `CHANGELOG.md`, and date-shaped examples use
semantic placeholders. Preserve contractual limits and coverage ratios.

## Correct and synchronize

Update all affected documents within the authorized corpus in the same iteration, including
translations, package READMEs, specs, and source comments that assert the same incorrect contract.
For review-only requests, return the findings and proposed dispositions without edits. Add a narrow
regression check only when an executable rule caused the drift; wording changes need no invented
behavioral tests.

### Current contracts and open questions

Specs describe the current product. When a feature is removed, delete its contract, examples,
invariants, open questions and index entries, and repair inbound links. Do not retain a paragraph
announcing the removal, a retired API inventory, or a comparison with the former implementation.
Describe surviving behavior directly. Release chronology belongs in `CHANGELOG.md`; retain an old
diagnosis in `specs/known-issues.md` only when its evidence remains useful. Do not create historical
entries merely to preserve deleted spec prose.

Reassess every open question in the reviewed scope against current implementation and tests:

- **Answered or resolved:** put any necessary answer in the owning contract with source/test
  evidence, then remove the question. Do not leave a resolved-status entry in an open list.
- **Retired or misplaced:** delete questions about removed behavior; move a still-live question to
  its actual owner rather than duplicating it across specs.
- **Still open:** state the precise unresolved decision or missing evidence and why current source
  and tests cannot settle it. An unexecuted native, PTY or provider check is not closed by reading
  its test; a test gap is not proof of a product defect.

Remove an empty Open questions section instead of filling it with “none” or inventing questions.
Record dispositions and supporting evidence in the work ledger, not as cleanup history in the spec.
Apply this review to affected questions in change sync and to every such section in full audit.

### Root and package READMEs

Synchronize the root README explicitly, not only the README of the package whose code changed:

- Check the product overview and feature claims against implemented, reachable behavior. Remove
  retired features and describe significant additions missing from the overview.
- Review installation/update instructions, supported platforms, prerequisites, first-run setup,
  configuration examples, commands/shortcuts, security/permission claims and documentation links.
  Distinguish what the published installer provides from what the development checkout supports;
  use [release-records.md](references/release-records.md) for publication evidence.
- Check development commands and the package table against current manifests and architecture.
  For each affected package README, check purpose, public exports, usage examples, dependencies,
  operational/failure behavior and local validation commands against current source and scripts.
- Reconcile overlapping claims across the root README, package READMEs, owning specs and shipped
  clarvis-docs. Keep the root concise and link to details; do not turn it into a copy of the specs.

Give `README.md` and each affected package README separate, named dispositions in the impact ledger.
An update request requires correcting stale text in the files, not merely recommending updates.
Do not mark the root README reviewed because the package table or links passed a checker; semantic
claims and missing guidance require inspection. A supported no-change reason is valid when the
change does not affect its contents.

### Model-facing guidance and TUI scenarios

For every product behavior change, evaluate the shipped `clarvis-docs` destination explicitly.
Use [shipped-docs.md](references/shipped-docs.md) to map relevant changes to its entrypoint and
reference pages, inspect their owning implementation/tests, and select validation. This is required
for configuration, commands, activation, grants, lifecycle and recovery; a documentation-only
refactor may instead record why the installed guide is unaffected. Do not stop after editing a
README/spec when the model-facing guide still teaches the previous behavior.

Search the scoped corpus for the previous field/command/path, its user-facing name, aliases and
equivalent prose after editing. Inspect matches in context: retain historical changelog entries
and intentionally invalid test examples. Check both removed claims and missing new instructions;
an obsolete-token search alone cannot establish completeness.

Treat `clarvis-tui-validation` scenarios as a required documentation destination for changes that
add, change or remove interactive behavior, capabilities, integrations or their proof requirements.
This applies even when the patch only changes backend code. Follow
[the TUI inventory maintenance section](../clarvis-tui-validation/references/full-audit.md#maintain-the-inventory).

- Compare affected [matrix rows](../clarvis-tui-validation/references/coverage-matrix.md) with current
  production entrypoints, reachable UI routes, owning specs and tests. An old scenario, legacy DTO
  or historical test name does not establish an active feature.
- Add scenarios for new behavior; update actions, expectations, prerequisites and required proof
  for changed behavior; remove retired scenarios. A removed feature is not an unavailable
  integration. Preserve surviving IDs and do not reuse retired IDs for unrelated scenarios.
- Synchronize [journey profiles](../clarvis-tui-validation/references/journey-profiles.md), including
  happy and secondary subcases, setup needs and scenario references. Search all TUI skill resources
  for removed IDs and feature names so no profile continues instructing a nonexistent journey.
- Record affected scenario IDs and profile changes in the impact ledger, or a supported no-change
  reason. Change setup/workflow instructions and report fields only when their semantics changed.
- Run the static inventory checker after these edits, then review capability journeys manually:
  its command/panel/ID checks cannot prove a backend integration still exists or that the scenarios
  cover all changed behavior. A green inventory is not sufficient evidence of synchronization.

This is static maintenance. A task that also requests E2E uses the TUI skill's
execution mode under the existing authorization; documentation synchronization alone does not
launch Clarvis, build artifacts, open a PTY, or make provider calls.

## Validate the changed surface

Run `bun run check:specs` for Markdown changes. Run the TUI static inventory checker only when its
matrix, checker, or registered surface changed. Check formatting for edited files with the existing
formatter. Run `bun run check:graph` only for dependency/package changes; source or checker changes
receive their targeted tests and checks. Reuse enclosing checks already completed on the same
inputs instead of starting full suites for documentation-only work.

When `clarvis-docs` changes, use the targeted content/publication checks and distribution escalation
criteria in [shipped-docs.md](references/shipped-docs.md). These establish packaging and loading
properties, not factual completeness or proof that a model followed the prose. Do not add tests
that merely mirror new wording.

## Close the synchronization

Reconcile the edits against the impact ledger after the last edit; for full audit, also close the
source/document inventories in its reference. The final diff reviews edits, not audit coverage.
Any new code changes during the work need an impact disposition before completion. Re-read the updated guidance as a consumer:
can the operator or model perform the changed task using the documented scope, values, sequence,
activation and recovery rules? For the shipped skill, follow its entrypoint to the resource without
assuming the installed user can inspect the repository.

Finish only when every in-scope destination is updated or has a supported no-change reason and
required checks have passed. An unavailable external docs repo or unresolved contract keeps that
destination explicitly incomplete; distinguish completed local synchronization from overall gaps.
Never claim global freshness from link/format checks, test totals, or a ledger with unresolved rows.
Do not claim that editing this skill installs automatic CI enforcement or guarantees future agents
will comply: its completion criteria require evidence on each invocation.

Review `git diff --check` and the final diff, including newly added files. Report the contradictions
resolved, remaining decisions, reviewed README/spec files, exact validation and limits, external
documentation and `clarvis-docs` dispositions, and publication status under the repository
handoff contract.
