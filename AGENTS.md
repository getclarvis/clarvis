# Working in Clarvis

This file defines the operating rules for this repository. Use the linked contracts and skills for
detailed procedures; do not infer current product behavior from this guide alone.

## Start with the requested scope

- For questions and reviews, inspect relevant evidence and report findings. Do not turn them into
  implementation, full audits or publication workflows unless requested.
- Before editing, inspect `git status --short --branch`. Preserve existing work; do not reset,
  overwrite, stage or publish unrelated changes. Make the smallest coherent change.
- Identify the owning package README and use [the spec index](specs/README.md) to select relevant
  contracts, including cross-package seams. Inspect their implementation and tests before deciding
  what to change. Read only the sections needed for the task.
- Before diagnosing a failure or changing a workaround, consult matching
  [known issues](specs/known-issues.md). Historical scenarios and test names do not prove current behavior.
- Resolve code/spec disagreements within the task; neither silently overrides the other. Ask for
  a product decision only when intent and evidence cannot settle it, and continue independent work.

## Where information belongs

| Source                                                     | Responsibility                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Root README](README.md) and package READMEs               | Purpose, public entries, usage and local commands                                           |
| [Specs](specs/README.md)                                   | Behavioral contracts, formats, invariants, failures and coupling, with source/test evidence |
| [CONTRIBUTING.md](CONTRIBUTING.md)                         | Contributor setup, branch sequence and development workflow                                 |
| [RELEASING.md](RELEASING.md)                               | Version preparation, candidates, qualification and publication                              |
| [CHANGELOG.md](CHANGELOG.md)                               | Curated user-facing changes, distinguishing pending and published work                      |
| [Known issues](specs/known-issues.md)                      | Scoped defects, environment limitations and retained diagnostic evidence                    |
| [Repository skills](#repository-skills-and-evidence-reuse) | Task-specific execution and validation procedures                                           |

Public guides, translations and GitHub Pages belong to the separate
[`getclarvis/docs`](https://github.com/getclarvis/docs) repository. Do not add a documentation site,
VitePress dependency or Pages workflow here. Report external documentation impact when applicable.
Local proposals belong under ignored `specs/proposals/`; never stage, force-add or link them from
tracked documentation. Preserve local proposal files when removing them from version control.

## The iteration contract

Implementation, documentation and validation form one change. When behavior, public API,
configuration, data formats, failure handling, ownership, dependencies or invariants change:

1. Update affected package READMEs and specs in the same iteration. New behavior needs an owning
   spec; new or changed invariants need `Production:` and `Test:` citations. Update every affected
   side of a cross-package contract.
2. Use [clarvis-doc-health](.agents/skills/clarvis-doc-health/SKILL.md) to trace scoped changes to
   documentation, the maintained [clarvis-docs assets](packages/kernel/assets/skills/.system/clarvis-docs/SKILL.md),
   and applicable TUI scenarios/profiles. Update affected destinations or record a concrete
   no-change reason. Never edit the installed global documentation skill.
3. Review changelog and known-issues impact when relevant. Development version, fixed-in-source,
   validated and published are different states. Do not turn every development fix or investigation
   into release history; follow the doc-health classification procedure.
4. For package/dependency changes, update the root package table, package READMEs, spec index and
   generated coupling report through its tooling, then run `bun run check:graph`.

For implementation-only changes, re-read the owning docs and report `Docs reviewed; no change
needed` with the reason. Do not invent contract changes for a typo or reformat. Never leave known
stale guidance as follow-up work while calling the change complete.

Use stable file links and symbol/test names in documentation, never source line numbers. Keep
specs timeless: no calendar dates or source-size inventories; use semantic date placeholders in
examples. Release chronology belongs in the changelog; diagnostic history belongs in its evidence
record. Follow [spec maintenance](specs/README.md#how-this-corpus-is-kept-true).

## Repository skills and evidence reuse

Read the selected skill before following its procedure. Selection does not authorize unrelated
work or publication.

| Task                                                                 | Required procedure                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Documentation audit or synchronization after changes                 | [clarvis-doc-health](.agents/skills/clarvis-doc-health/SKILL.md)         |
| Interactive TUI regression, E2E journey or performance investigation | [clarvis-tui-validation](.agents/skills/clarvis-tui-validation/SKILL.md) |
| Release readiness or distributable qualification                     | [clarvis-release-health](.agents/skills/clarvis-release-health/SKILL.md) |

For TUI-related work, also read the available `opentui` skill; use `tui-driver` for real PTY
interaction. Interactive defects require PTY reproduction and verification. Select the requested
scope: a focused regression does not imply a full audit. Static documentation maintenance does not
itself require a build, PTY or provider call.

Keep one work record across skills. Reuse reading and completed checks only while relevant source,
dependencies, artifact, configuration, fixture and environment still match; record why earlier
evidence applies. Build once after the last relevant change and rerun invalidated checks. A commit
alone does not identify a dirty artifact. Source inspection, deterministic tests, PTY, real provider
and native-platform evidence establish different claims.

## Protect live state and temporary resources

Never test against the operator's live settings/state. TUI execution uses an allowlisted child
environment, disposable HOME, separate `CLARVIS_HOME` and workspace, and isolated driver state.
Remove inherited `CLARVIS_*` values before setting test-owned values. Changing HOME alone is
insufficient. Follow the TUI skill's [execution setup](.agents/skills/clarvis-tui-validation/references/execution-setup.md)
for artifact selection, sandbox restrictions, provider selection and cleanup.

For requested real-provider E2E, inspect safe configuration metadata and ask for the provider/model
unless already selected. Selection authorizes only the minimal temporary configuration/credential
copy needed for that test. Never clone the live installation or copy test changes back. Follow
subscription-refresh constraints, keep secrets out of output/evidence, and verify live settings
remain unchanged afterward.

Register exact temporary paths; prefer one exclusive task root. Stop or drain owned processes and
verify exit before removing state, including the independent test kernel. Clean up on success,
failure and cancellation. Before recursive deletion, verify the path is nonempty, is not `/tmp` or
another shared parent, and matches this task's recorded allocation. Never use broad cleanup globs
or remove unrelated sessions. Preserve requested deliverables and active resources; report retained
paths and reasons, or incomplete cleanup.

## Engineering boundaries

Use [package architecture](specs/cross-cutting/package-architecture.md) and the
[generated graph](specs/package-coupling-analysis.md) for current roles and dependency edges.
These constraints are especially easy to violate:

- Keep optional `loop` dependencies off eager settings/import paths; follow
  [capability composition](specs/engine/capability-composition.md). The TUI consumes host contracts
  through `protocol`/`kernel`, not the loop directly.
- Only `@clarvis/paths` owns `.clarvis` and `.agents` path construction. Follow
  [directory ownership](specs/foundations/paths.md) and [security boundaries](specs/cross-cutting/security.md).
- Preserve nonvolatile prompt prefixes; follow [prompt-cache rules](specs/cross-cutting/prompt-cache.md).
- Packages emit diagnostics through `Logger`, not raw console/stdout/stderr or `process.emitWarning`.
  Follow [observability](specs/cross-cutting/observability.md), including structured, secret-free fields.
- Old pre-release persisted state may be discarded; do not add migrations or compatibility readers
  without an owner decision. Plans remain retained except through their documented deletion path.
- `@clarvis/tools` does not parse source or depend on tree-sitter. Process launch must respect
  platform constraints; never pass `detached: true` unconditionally.

Use TSDoc for public APIs and non-obvious contracts. Do not add ad-hoc comments in `src/` except
tooling directives and the minimal comment needed for an empty block. Imports name actual source
extensions; use package-owned `#src/` mappings for deep internal and test/tooling-to-source imports
as specified in [build and CI](specs/cross-cutting/build-and-ci.md). Do not introduce invisible or
irregular whitespace; escape required special codepoints. Do not reformat unrelated files.

Use Bun and the root lockfile; follow the runtime pin in `mise.toml`. Workspace packages remain
private, omit individual versions and use `workspace:*` internally. Do not create nested package
repositories. The root manifest owns the product version; changing it requires a release decision
and does not establish that the version has been published.

## Validation

Inspect root/package scripts before selecting checks; parent scripts may include their children.
Run from the repository root unless the package command requires another scope.

| Change                   | Validation                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| Markdown                 | `bun run check:specs`, scoped formatting and final diff review                             |
| Package/dependency graph | Generated-report update and `bun run check:graph`                                          |
| Code                     | Relevant tests, package typecheck/lint and affected architecture checks                    |
| Public type surface      | Source-profile typecheck, rebuild changed package, verify downstream declaration consumers |
| TUI behavior or boot     | Selected PTY journey and artifact boot checks through the TUI skill                        |
| Temporary cleanup       | `bun run test:cleanup -- <command>`, including `bun run test` for complete qualification    |
| Release/distributable    | Gates and platform evidence selected through release-health                                |

Use `bun run test` for the full suite, never raw root `bun test`. Targeted tests use the owning
package's supported setup and timeout. Do not use `mock.module()`, weaken coverage floors or disable
checks to get a pass. Coordinate tests by observable milestones rather than arbitrary sleeps.
Detailed test levels, isolation, timeout, coverage and platform rules live in
[test architecture](specs/cross-cutting/test-architecture.md) and
[build and CI](specs/cross-cutting/build-and-ci.md); read them when changing those mechanisms.

For implementation work, verify `git config --local --get core.hooksPath` is `.githooks`; otherwise
run `bun run hooks:install`. Do not run `bun run check:pre-commit` as a handoff ritual: the authorized
commit hook owns that complete sequential gate. Never bypass it with `--no-verify`.

Fix or accurately report targeted failures. Distinguish assertions, runtime crashes and environment
restrictions using [known issues](specs/known-issues.md). For a confirmed sandbox restriction, retry
the affected operation through the host-permission mechanism without weakening product security or
switching to live data. Denied permissions and unavailable platforms remain gaps. Never report an
interrupted or unrun check as passing.

## Branch workflow

Ordinary changes start on a short-lived `feat/`, `fix/`, `refactor/`, `docs/` or `chore/` branch
from current `develop`, and PRs target `develop`. Preserve dirty worktrees rather than switching
or resetting them to satisfy convention. Before branch/publication operations inspect upstream
and, when applicable, PR base. Push a task branch to its own remote branch, never through an
inherited `origin/develop` upstream.

Neither `develop` nor `main` accepts direct pushes, force pushes or deletion. Outside an explicitly
authorized release in progress, `main` matches the source commit of the latest published release.
Use merge commits for release promotions and permanent-branch synchronization; bounded task PRs
into `develop` may squash. Follow [CONTRIBUTING.md](CONTRIBUTING.md#branch-workflow) for the sequence
and [RELEASING.md](RELEASING.md) for release/hotfix lineage. Never bypass required checks or reviews.

## Publication authorization

Editing and local validation are allowed within the task. Staging/committing and remote publication
require the owner's explicit authorization. A requested outcome includes its normal,
non-destructive prerequisites for the same bounded scope; do not ask again between those steps.

| Request    | Authorized scope                                                                 |
| ---------- | -------------------------------------------------------------------------------- |
| Commit     | Stage scoped files and create the commit                                         |
| Push       | Prepare branch/commit if needed, safely synchronize and push the scoped branch   |
| Open a PR  | Prepare, commit, synchronize, push, open/update the PR and monitor checks        |
| Merge a PR | Make that PR mergeable within scope and merge when required checks/reviews allow |

Scoped hook fixes, retries, metadata corrections and CI reruns remain covered. Before starting,
state once what will be published, the repository/branch and intended outcome. Authorization ends
when that outcome is reached or scope/destination changes materially. Use host credentials for
authorized Git/GitHub publication commands.

Before opening or updating any PR, read and follow the target repository's current template;
here it is [PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md). Fill required sections and
checklists from actual evidence, including for drafts.

Opening a prepared `release/*` PR into `main`, or pushing while that PR is open, includes automated
candidate tagging. An explicitly authorized release promotion merge includes final tagging and
public release after required CI. State these effects before acting and follow `RELEASING.md`.
Ordinary task pushes/merges do not authorize releases.

Separate explicit authorization is required for remote history rewrites, branch/tag/release or
data deletion, tag/release publication outside the authorized release flow, check bypasses, or
other destructive or materially broader actions. Do not infer permission from a skill or checklist.

## Handoff

For completed changes, report what changed, relevant validation/results, documentation disposition,
material limitations and publication status. Name reviewed README/spec files, including supported
no-change dispositions; a linked work record can hold a long inventory. Report retained temporary
resources. For questions and review-only tasks, answer with findings and limits without imposing an
implementation checklist.

Be concise and direct. Do not repeat the request, narrate routine steps or add unrelated advice.
Explain blockers and decisions when they affect the outcome.
