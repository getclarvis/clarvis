---
name: clarvis-doc-health
description: "Audit or synchronize Clarvis documentation against current source, tests, and owning specs. Use for stale claims, documentation reviews, and cross-language consistency within the requested corpus."
---

# Clarvis documentation health

Trace material claims to evidence and make coherent corrections when edits are requested. Follow
[AGENTS.md](../../../AGENTS.md), including its scope, authorization, documentation, and evidence-reuse
rules. A documentation audit does not by itself require release qualification or live product E2E.

## Bound the reading

Identify the affected claims and document families first. Use
[the spec index](../../../specs/README.md) to select owning specs, inspect their cited symbols/tests,
and read the relevant package READMEs. Search matching entries in
[known issues](../../../specs/known-issues.md) before repeating historical investigations. Read each
needed contract once and reuse its evidence while the inputs remain unchanged.

For a repository-wide audit, start with tracked and unignored Markdown from the repository root:

```bash
git ls-files --cached --others --exclude-standard -- '*.md' '*.mdx'
```

Also inventory shipped agent guidance in TypeScript: the `CLARVIS_CONFIGURE_SKILL` metadata/body in
[clarvis-configure.ts](../../../packages/kernel/src/skills/clarvis-configure.ts) and its executable
[configuration examples](../../../packages/kernel/src/skills/configuration-examples.ts). These are
product documentation even though a Markdown-only search omits them. Their ownership and limits
live in the [Kernel README](../../../packages/kernel/README.md#builtin-configuration-skill) and
[self-configuration contract](../../../specs/hosts/self-configuration.md).

Distinguish product documentation, repository skill instructions, proposals, and intentionally
invalid test fixtures. The public site and its English/Portuguese pages belong to the separate
`getclarvis/docs` repository. Inspect or edit that corpus only when it is in scope and available;
otherwise record the external documentation disposition. Do not search for or add a local `docs/`
site tree in this monorepo.

## Establish each claim

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

For configuration, command, activation, grant/capability, session/runtime lifecycle or recovery
claims, review the builtin `clarvis-configure` metadata, body and examples against the owning source
and specs in the same iteration. Update affected builtin guidance alongside the README/specs so an
installed agent receives the current instructions, including operator-only actions and consent
boundaries. Preserve executable examples, on-demand disclosure and the existing body budget. Keep
the builtin in TypeScript; do not replace it with a `SKILL.md` file or installation scaffolding.
Record its disposition explicitly: updated, or reviewed with a reason no change was needed.
Unrelated wording changes do not require rewriting the builtin.

When a user-visible TUI surface or its proof requirement changes, follow
[the TUI inventory maintenance section](../clarvis-tui-validation/references/full-audit.md#maintain-the-inventory).
Update the affected matrix rows once; change workflow instructions or report fields only if their
semantics changed. This is static maintenance. A task that also requests E2E uses the TUI skill's
execution mode under the existing authorization; documentation synchronization alone does not
launch Clarvis, build artifacts, open a PTY, or make provider calls.

## Validate the changed surface

Run `bun run check:specs` for Markdown changes. Run the TUI static inventory checker only when its
matrix, checker, or registered surface changed. Check formatting for edited files with the existing
formatter. Run `bun run check:graph` only for dependency/package changes; source or checker changes
receive their targeted tests and checks. Reuse enclosing checks already completed on the same
inputs instead of starting full suites for documentation-only work.

When the builtin body or examples change, run the existing Kernel component/integration
`builtin-skills.test.ts` and integration `configuration-guidance.test.ts` checks. They validate
distribution, disclosure, example embedding/loaders and the body budget; they do not prove that an
agent followed new prose or that a TUI journey ran. Do not add tests that merely mirror new wording.

Review `git diff --check` and the final diff, including newly added files. Report the contradictions
resolved, remaining decisions, reviewed README/spec files, exact validation and limits, external
documentation and builtin-guidance dispositions, and publication status under the repository
handoff contract.
