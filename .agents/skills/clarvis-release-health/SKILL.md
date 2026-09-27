---
name: clarvis-release-health
description: "Assess Clarvis release readiness, validate source candidates, qualify archives/installers or verify publication. Select a bounded scope and report attributable source, artifact, platform and documentation evidence."
---

# Clarvis release health

Produce a readiness verdict for the requested release scope. Follow
[AGENTS.md](../../../AGENTS.md) for publication authority and evidence reuse. A preflight alone
authorizes no publication; when the task also authorizes publication, honor that existing scope
without requiring approval again for its normal prerequisites.

## Select the scope

| Request                            | Required outcome                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Readiness analysis or review only  | Inspect existing evidence and identify gaps; do not launch a full build/test campaign or edit files                                       |
| Complete local preflight           | Run the repository gates below and assess documentation; distinguish local results from required remote/platform qualification            |
| Source candidate / RC              | Validate candidate identity and requested source-install evidence using [channels.md](references/channels.md)                             |
| Archive or installer qualification | Test the identified artifact/target and its install/boot path, without rebuilding a supplied artifact into a different one                |
| Verify a publication               | Inspect remote identity, assets and completion using [channels.md](references/channels.md); verification itself authorizes no publication |

Honor an already specified scope. For ambiguous requests, resolve whether the operator wants an
assessment or execution before expensive gates; begin read-only discovery meanwhile. Do not turn
one failed gate into a complete preflight. Revising this skill is static work, not a release run.

## Establish the requested evidence

Read [RELEASING.md](../../../RELEASING.md) and the relevant parts of
[build and CI](../../../specs/cross-cutting/build-and-ci.md),
[distribution and updates](../../../specs/cross-cutting/distribution-and-updates.md), and
[test architecture](../../../specs/cross-cutting/test-architecture.md). Check matching
[known issues](../../../specs/known-issues.md). Inspect the current root version, worktree, requested
tag, relevant manifests, installers, and workflows. Version changes remain owner decisions.
Record separately the development version, selected source commit/worktree, prepared release/RC,
and actually published version. A manifest, local tag or successful gate does not prove publication.
Use remote evidence when making current publication claims; mark it unverified if unavailable.
Do not run `release:prepare` to fix a mismatch without release-preparation authorization, or rerun
it blindly on an already prepared version: it requires a newer version and a new changelog entry.

For a complete release review, include the root README, security policy, notices, and owning package
READMEs. For one archive, installer, or failed gate, limit the review to its contract and dependencies.
Record source identity, artifact flavor/target, configuration, exact commands, exit outcomes, and
evidence paths in one ledger shared with any TUI or documentation work.

For complete readiness/preflight, use [documentation health](../clarvis-doc-health/SKILL.md) to
review the root README, affected package READMEs/specs, changelog, known-issues scope, shipped
clarvis-docs and applicable TUI scenarios. Record updates or supported no-change dispositions.
Review-only scope reports corrections without making them. Distinguish documentation describing
development from the published installer, and fixed-in-source from validated/released fixes.
Public guides belong to `getclarvis/docs`; report required external work without inventing a local
site build. A narrow artifact check assesses only documentation relevant to that artifact.

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

For an exact final tag, pass it as `RELEASE_TAG` to the gate process containing `check:release`.
That checker expects exactly `v<root version>`; do not pass an RC tag to it. For RCs, use the separate
candidate validator and run repository gates with `RELEASE_TAG` unset as described in
[channels.md](references/channels.md). Without a supplied tag, explicitly leave `RELEASE_TAG` unset,
check local consistency and report tag validation unverified; do not inherit an unrelated CI tag or
choose a release version. Install dependencies with the frozen lockfile only when needed.

On failure, retain completed independent gates. Classify known crash/socket signatures using the
known-issues evidence, rerun the affected command in the suitable environment, and record both
attempts. A code fix invalidates checks that depend on its inputs, not every unrelated result.

## Qualify the requested artifact

When building a new portable artifact is in scope, follow the map-free build/package sequence:

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

Record the source SHA and dirty inputs, lockfile/runtime identity, target OS/architecture, build
flavor, archive path and digest, manifest identity and the exact artifact each smoke consumed.
Derive the target matrix from current workflows and release tooling; do not hard-code a remembered
target count. A native host's passing archive cannot qualify other targets. The diagnostic bundle,
source candidate and portable payload have distinct launch/packaging paths; inspect the current
packager rather than assuming portable archives execute `dist/index.js`.

For a supplied archive, preserve its identity and use the harness's supported input/fixture path.
Do not silently replace it with a checkout build. If a harness only accepts artifacts from the local
output directory, isolate and document the staging or report the unsupported input as a gap.

Use [TUI validation](../clarvis-tui-validation/SKILL.md) for interactive release canaries, selecting
focused mode unless a full product audit is requested. Share its artifact and evidence ledger.
Record unsupported or unrun targets separately. Review CI evidence only when it belongs to the
requested source/artifact; a previous release's green job cannot qualify this one.

## Isolate and clean up

Use the repository smoke fixtures for disposable HOME, `CLARVIS_HOME`, workspace, install/launcher
roots and child environment. Never run install/update/uninstall tests against the operator's live
installation or shell profile. For interactive or real-provider canaries, follow the TUI skill's
setup and provider selection; no account traffic is implied by a packaging check.

Register exact temporary roots and owned processes before execution. Retain named artifacts and
sanitized evidence, then stop/drain test kernels and children, verify listener/process exit, remove
only owned temporary credentials/state and verify absence on success, failure and cancellation.
Report retained paths or failed cleanup. Known sandbox restrictions use the host-permission route;
do not repeat equivalent restricted launches or weaken product isolation to pass.

## Report readiness

Use one row per required check/target, with command or CI run URL, source/artifact identity, proof
method, exit/result, evidence and `pass`, `fail`, `blocked`, `not run`, or `not applicable` (reason).
Missing required evidence remains a gap even when all executed checks passed.

- **Ready on verified scope:** every requirement for the named scope passed. Name the scope;
  local readiness is not all-platform readiness or publication.
- **Incomplete:** required checks, platforms, documentation or identity evidence remain unavailable
  or unexecuted. Never hide these behind “conditionally ready”.
- **Not ready:** a required check failed or an established blocking defect remains. Include any
  additional incomplete evidence separately.

Report the selected scope, requirements/results, reused evidence, documentation dispositions,
remaining decisions/risks, cleanup and publication actions actually taken. An owner-accepted
limitation remains visible; do not silently convert it into a passing check. A review-only task can
finish with an incomplete readiness verdict. Do not claim publication complete until the channel's
remote completion checks pass.
