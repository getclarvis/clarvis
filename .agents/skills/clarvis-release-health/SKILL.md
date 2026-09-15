---
name: clarvis-release-health
description: "Assess Clarvis release readiness or qualify distributable archives and installers with attributable gate and platform evidence. Use for release preflight; ordinary TUI regressions and documentation audits have their own skills."
---

# Clarvis release health

Produce a readiness verdict for the requested release scope. Follow
[AGENTS.md](../../../AGENTS.md) for publication authority and evidence reuse. A preflight alone
authorizes no publication; when the task also authorizes publication, honor that existing scope
without requiring approval again for its normal prerequisites.

## Establish the requested evidence

Read [RELEASING.md](../../../RELEASING.md) and the relevant parts of
[build and CI](../../../specs/cross-cutting/build-and-ci.md),
[distribution and updates](../../../specs/cross-cutting/distribution-and-updates.md), and
[test architecture](../../../specs/cross-cutting/test-architecture.md). Check matching
[known issues](../../../specs/known-issues.md). Inspect the current root version, worktree, requested
tag, relevant manifests, installers, and workflows. Version changes remain owner decisions.

For a complete release review, include the root README, security policy, notices, and owning package
READMEs. For one archive, installer, or failed gate, limit the review to its contract and dependencies.
Record source identity, artifact flavor/target, configuration, exact commands, exit outcomes, and
evidence paths in one ledger shared with any TUI or documentation work.

Keep repository checks, archive construction, install/boot smokes, real-account canaries, native
platform evidence, and external owner actions distinct. Synthetic tests cannot qualify an account;
workflow configuration cannot qualify an unrun platform job. Deliberately deferred site or public
repository publication is not a repository defect.

## Select gates without duplicate work

Expand the current manifest scripts and reuse valid completed checks before executing. For a
comprehensive local preflight, the current nonduplicating sequence is:

```bash
bun run format:check
bun run build
bun run typecheck
bun run lint
bun run test:coverage
```

`lint` already includes tooling tests, spec/graph/harness/Bun/release checks, and Knip.
`test:coverage` already executes each package's tests and architecture checks plus coverage
verification. Do not also run the root `test` or repeat those children on unchanged inputs. Recheck
the manifest composition when it changes; omitted requirements must still be executed. The
publication hook retains its own full gate.

If the owner supplied an exact tag, pass it as `RELEASE_TAG` to the gate process that includes
`check:release`. For tag-only verification, run `check:release` directly with that value. Without a
supplied tag, check local version consistency and record publication-tag validation as unverified;
do not choose a release version. Install dependencies with the frozen lockfile only when needed.

On failure, retain completed independent gates. Classify known crash/socket signatures using the
known-issues evidence, rerun the affected command in the suitable environment, and record both
attempts. A code fix invalidates checks that depend on its inputs, not every unrelated result.

## Qualify the requested artifact

For portable distribution, build the map-free flavor and package it in order:

```bash
bun --filter @clarvis/code build:install
bun run release:package
bun run release:smoke
bun run release:install-smoke
```

This build differs from the diagnostic TUI artifact. Reuse an already-qualified identical flavor;
do not overwrite it with another build between packaging and inspection. Inspect target, manifest,
checksums, notices, licenses, and native dependency closure. Confirm the checked-in workflow's
permissions, immutable action pins, publication guards, and artifact names.

Use [TUI validation](../clarvis-tui-validation/SKILL.md) for interactive release canaries, selecting
focused mode unless a full product audit is requested. Share its artifact and evidence ledger.
When Docker runtime distribution is in scope, follow the runtime procedure in `RELEASING.md` and
the [runtime contract](../../../specs/hosts/isolated-agent-runtime.md), qualifying the image
independently from the TUI archive. Native builds, local canaries, and registry attestations are
different evidence; do not fabricate a release sidecar to pass a gate.

Record unsupported or unrun targets separately. Review CI evidence only when it belongs to the
requested source/artifact; a previous release's green job cannot qualify this one.

## Report readiness

Use [documentation health](../clarvis-doc-health/SKILL.md) only when claims need auditing or
correction, scoped to those claims. Public site work belongs to `getclarvis/docs`; record its
disposition instead of inventing a monorepo docs build.

Report **ready on verified scope**, **conditionally ready**, or **not ready**, with the precise
scope. List required gates and artifacts, reused evidence and why it applies, failures, native and
account gaps, owner decisions, cleanup, documentation disposition, and publication actions actually
taken. No partially executed gate or unavailable platform counts as a pass.
