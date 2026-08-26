---
name: clarvis-doc-health
description: "Audit Clarvis documentation against current source, tests, and owning specs when reviewing launch readiness, stale claims, cross-language drift, or a behavior change. Use for repository-wide or scoped documentation truth checks; do not use as a release artifact or native-platform smoke test."
---

# Clarvis documentation health

Establish what is true now, then make the smallest coherent correction when the task authorizes edits. Report the audited corpus and remaining uncertainty; do not promise absolute completeness without evidence.

## Start from the contract

1. Read `AGENTS.md` completely.
2. Inspect `git status --short`. Preserve every unrelated user change.
3. Read `specs/README.md`, `specs/known-issues.md`, and the README of every package in scope.
4. Follow the owning specs to their cited production symbols and tests. Prose alone is not evidence.
5. For a repository-wide audit, inventory tracked documentation and site copy with:

   ```bash
   git ls-files --cached --others --exclude-standard -- '*.md' '*.mdx' 'docs/**/*.vue'
   ```

Split a large audit into independent public-doc, package-README, and spec families when parallel review is available. Consolidate findings against the same source before editing.

## Classify every material claim

Use four evidence classes:

- **Durable contract:** the behavior the owning spec promises.
- **Current implementation:** source symbols and actual configuration or workflow files.
- **Pinned verification:** tests, static checks, artifact smokes, or checked-in evidence.
- **Temporal external state:** deployments, provider entitlement, account state, remote repository settings, or platform availability.

Never turn temporal external state into a durable documentation claim. Honor deliberate publication sequencing: do not flag intentionally deferred public-repository or site population as a documentation defect, and do not write that transient state into docs unless the owner explicitly changes scope.

When spec and code disagree, do not silently pick one. Determine whether the contract or implementation is wrong from tests, adjacent specs, history when needed, and the owner's stated decision. Report an unresolved product decision instead of inventing one.

## Audit for drift

For each public claim, trace the chain:

```text
public guide -> package README -> owning spec -> production symbol -> test or explicit gap
```

Pay special attention to:

- install commands, versions, archive targets, update paths, and release dates;
- security, sandbox, trust, credentials, billing, and provider-authorization boundaries;
- beta, support, compatibility, platform, accessibility, and performance wording;
- defaults, retention, failure behavior, command syntax, configuration scope, and cross-package ownership;
- workflow permissions, immutable action pins, publication guards, and what a smoke actually proves;
- numbers such as package, file, event, test, and coverage counts;
- English and Portuguese pages that describe the same behavior.

Search risky absolutes as leads, not automatic defects:

```bash
rg -n -i 'always|never|all platforms|fully supported|production.ready|guarantee|secure|sandbox|subscription|beta' README.md docs packages specs --glob '*.md' --glob '*.vue'
```

Recompute counts from the repository. Do not copy an old count or adjust citations by a blind line-number offset. Prefer production and test symbols in specs; when a range is necessary, verify it against the current file.

## Correct coherently

If edits are authorized:

1. Update every affected public page, translation, package README, and owning spec in the same iteration.
2. Add or update the narrowest test when a previously unpinned claim caused drift.
3. Update source comments when they assert the same false contract.
4. Preserve beta caveats and evidence boundaries; do not market synthetic tests as a real-account or native-platform canary.
5. Do not reformat unrelated files.

If the request is review-only, make no edits. Return findings with file, claim, conflicting evidence, severity, and recommended disposition.

## Validate

Run checks proportional to the affected surface from the repository root:

```bash
bun run check:specs
bun test tooling/tests/architecture/public-docs.test.ts --timeout 60000
bun run docs:build
bun run format:check
```

Also run targeted tests for changed source or contracts. Run `bun run check:graph` for package or dependency facts. For a broad correction, finish with the relevant full typecheck, lint, and test gates from `AGENTS.md`. Do not run `bun run check:pre-commit` as a ritual.

Review `git diff --check`, `git diff --cached --check`, and both staged and unstaged final diffs. Report:

- contradictions fixed and any unresolved decision;
- README/spec files reviewed, including no-change dispositions;
- exact commands and outcomes;
- temporal or platform evidence still unverified;
- that no staging, commit, push, tag, merge, rebase, or release occurred unless separately authorized immediately before it.
