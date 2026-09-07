# Working in Clarvis

This file is the repository-wide operating guide for coding agents and their reviewers. It tells you
how to find the authoritative contract, make a bounded change, validate it, and hand it back safely.
It intentionally does not repeat package internals: those belong in the package README and the specs.

## Start here

1. Read this file.
2. Read the README of every package you may change.
3. Use [`specs/README.md`](specs/README.md) to find every spec that owns the behavior, surface, format,
   invariant, or cross-package seam involved.
4. Check [`specs/known-issues.md`](specs/known-issues.md) before diagnosing a failure or changing a
   workaround.
5. Inspect the implementation and tests cited by the relevant specs. Do not treat prose as a
   substitute for current source evidence.
6. Check the worktree before editing. Existing changes belong to the user unless proven otherwise.

The documentation has three distinct jobs:

| Document                    | Job                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`                 | Repository workflow, safety rules, validation, and pointers                                                         |
| `packages/<name>/README.md` | A package's purpose, public entries, usage, operational behavior, and local development commands                    |
| `specs/**/*.md`             | The authoritative behavioral contract, formats, invariants, failure modes, and coupling, with source/test citations |

The public product site, translated user guides, and GitHub Pages deployment are owned by the
separate [`getclarvis/docs`](https://github.com/getclarvis/docs) repository. Do not add a `docs/`
site tree, VitePress dependency, or Pages workflow to this monorepo. When a product change affects
the public guides, record the external documentation disposition in the handoff.

Proposals are local working documents, not versioned specifications. Keep them under
`specs/proposals/`, which Git ignores; do not stage, force-add, or publish them in commits or pull
requests. Preserve local proposal files when removing them from version control. Durable contracts
belong in the owning tracked spec, and tracked documentation must not link to local proposal files.

If these disagree, stop and resolve the disagreement in the same iteration. The specs are the stated
contract; the code is the current implementation. Neither silently overrides the other.

## The iteration contract

Documentation is part of the change, not follow-up work. A coding iteration is not complete until its
documentation disposition is complete.

- Before coding, name the owning package README and specs.
- During the same iteration, update every affected spec and package README when code changes behavior,
  public API, configuration, wire or persisted data, failure handling, ownership, dependencies, or an
  invariant. Cite the stable repository file and name the owning symbol or test in prose; never encode
  source line numbers or ranges in documentation references.
- If the implementation changes without changing a documented contract, re-read the owning README and
  specs anyway. In the handoff, explicitly report `Docs reviewed; no change needed` and why.
- Never leave a knowingly stale spec or README for a later iteration, TODO, follow-up, or reviewer.
- New behavior needs an owning spec. New or changed invariants need both `Production:` and `Test:`
  citations in that spec. If the behavior crosses package boundaries, update every affected package
  README and the coupling section of the owning specs.
- Keep specs timeless: change dates and chronology belong in `CHANGELOG.md`, not under `specs/`.
  Date-shaped data examples use semantic placeholders such as `YYYY-MM-DD`.
- Do not record source line counts or LOC inventories in specs. Behavioral line limits and coverage
  ratios remain valid when they are part of the contract.
- If a package is added, removed, renamed, or changes dependency edges, update the root package table,
  the package README set, `specs/README.md`, and the generated coupling report. Run
  `bun run check:graph` rather than editing generated graph facts by hand.
- Before handoff, run `bun run check:specs` for any Markdown change and list the README/spec files you
  reviewed, including those that required no edit.

Pure typo or formatting edits do not require inventing a contract change, but they still must not make
the README, spec, implementation, and tests disagree.

## Branch workflow

`develop` is the default integration branch; `main` holds approved release source. Start ordinary
work in a short-lived `feat/`, `fix/`, `refactor/`, `docs/`, or `chore/` branch from current
`develop`, and target its pull request at `develop`. Keep both permanent branches green; neither
accepts direct pushes, force pushes, or deletion. Both require the Linux, Windows, and macOS CI
contexts, an up-to-date base, and resolved review conversations, with no ruleset bypass actors.

Use a merge commit when promoting a release into `main` or synchronizing permanent branches.
Squash is available for bounded task PRs into `develop`; never squash a promotion or back-merge.
Rebase merging and required linear history are disabled so these synchronization merges retain
their ancestry. External approving reviews are not required for the single-maintainer workflow;
this does not replace the owner's review of the change.

Create `release/<version>` from `develop` when stabilization must run alongside further development.
Otherwise promote the qualified `develop` through a PR to `main`. Hotfixes start from the affected
published tag; integrate them into `main` and propagate the fix to `develop` and any active release
branch. If `main` already contains unreleased work, do not publish that work accidentally as a
hotfix: resolve the intended release lineage explicitly.

Version preparation, tagging, and publication follow [RELEASING.md](RELEASING.md). A merge does not
publish a release; an authorized signed `v<version>` tag identifies the exact approved source.
See [CONTRIBUTING.md](CONTRIBUTING.md#branch-workflow) for the contributor sequence. Branch and PR
operations remain subject to the publication authorization below.

## Publication authorization

Do not publish without the project owner's explicit authorization. A request for a publication
outcome authorizes the normal, non-destructive prerequisite steps needed to reach that outcome for
the current bounded change; do not ask for another confirmation between those steps.

- `Commit this` authorizes staging the scoped files and creating the commit.
- `Push this` authorizes creating a branch and commit when needed, safely synchronizing with the
  target branch, and pushing the scoped branch.
- `Open a pull request` authorizes creating or switching to a branch, staging, committing, safely
  synchronizing, pushing, opening or updating the pull request, and monitoring its checks.
- `Merge the pull request` authorizes the normal non-destructive work needed to make that pull
  request mergeable and then merging it when its required checks and reviews allow.
- Fixes and retries that remain within the authorized change, including hook fixes, push retries,
  pull-request metadata corrections, and CI reruns, do not require renewed authorization.

Before opening or updating any pull request, including a draft, always read the target repository's
current PR template. In this repository it is
[`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). Use its required sections
and checklists, fill them with evidence from the actual change, and follow its instructions for
optional sections. If multiple templates exist, select the applicable one. Do not substitute a
remembered template or a generic PR body.

Before starting an authorized publication workflow, state once what will be published, the target
repository and branch, and the intended outcome. The authorization ends when that outcome is reached
or when the scope or destination changes materially.

Separate explicit authorization is still required to force-push or otherwise rewrite remote
history, delete branches, tags, releases, or data, publish a tag or release, bypass a required check,
or perform another destructive or materially broader action. Run authorized Git/GitHub publication
commands outside the sandbox; a sandbox may not see the host keyring and can falsely report broken
authentication. Never bypass the hook with `--no-verify`.

Editing files and running builds, tests, typechecks, lint, and read-only Git commands are allowed.

## Repository map

Clarvis is a pre-release Bun/TypeScript monorepo of 18 packages. The current package list and concise
descriptions live in [`README.md`](README.md); the authoritative dependency graph is generated in
[`specs/package-coupling-analysis.md`](specs/package-coupling-analysis.md).

The architecture has seven semantic roles:

```text
foundation             capability · paths
host contract          protocol
execution service      llm · mcp-client · supervision · trace · tools · hooks · skills
engine                 loop
product capability     memory · plan · tasks · workflows
host implementation    kernel
application            code (terminal UI) · server (MCP over HTTP)
```

Roles are architectural ownership, not a literal dependency chain or physical directory nesting.
Use the generated coupling report for exact edges. Three relationships are especially easy to
reverse:

- `memory` and `workflows` sit above `loop` and may execute runs; the loop does not name them.
- `plan` and `tasks` are host-registered capabilities beside the loop.
- `protocol` is transport-agnostic. `code` and `server` consume the `KernelClient` contract, while
  `kernel` implements it over the loop.

The root manifest owns the sole Clarvis product version. The owner started the first public beta at
`0.0.1-beta`; later version changes still require an explicit release decision. Workspace packages
are private and omit `version`; internal
dependencies use `workspace:*`, and there is one root `bun.lock`. Do not initialize nested
repositories under `packages/`.

## Find the owning spec

The complete, maintained routing table is [`specs/README.md`](specs/README.md). Common starting points:

| Change                                                | Read first                                                                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability contract or composition                    | [`specs/foundations/capability.md`](specs/foundations/capability.md), [`specs/engine/capability-composition.md`](specs/engine/capability-composition.md)                      |
| Paths or filesystem ownership                         | [`specs/foundations/paths.md`](specs/foundations/paths.md)                                                                                                                    |
| Tools, shell, guards, sandbox                         | [`specs/execution/tools-contract.md`](specs/execution/tools-contract.md), then the focused execution spec                                                                     |
| Loop lifecycle, budgets, context, delegation          | the focused file under [`specs/engine/`](specs/README.md#engine--the-loop-itself)                                                                                             |
| Memory, plans, tasks, workflows                       | the focused file under [`specs/capabilities/`](specs/README.md#capabilities--features-that-compose-onto-the-engine)                                                           |
| Kernel, protocol, server, or TUI                      | the focused file under [`specs/hosts/`](specs/README.md#hosts--the-kernel-the-terminal-ui-and-the-http-facade)                                                                |
| Package roles, dependency direction, or a new package | [`specs/cross-cutting/package-architecture.md`](specs/cross-cutting/package-architecture.md), then [`specs/package-coupling-analysis.md`](specs/package-coupling-analysis.md) |
| Security, observability, prompt cache, tests, build   | the focused file under [`specs/cross-cutting/`](specs/README.md#cross-cutting--properties-no-single-package-owns)                                                             |

Read all applicable rows, not only the first plausible document. Cross-cutting contracts often own
the constraint that a package-local change could otherwise miss.

## High-risk invariants

These are routing warnings, not replacements for the linked specs.

- **Optional package boundary:** `hooks`, `skills`, and `tools` are optional dependencies of `loop`.
  Nothing on the eager settings/import path may load their runtime values. See
  [`specs/engine/capability-composition.md`](specs/engine/capability-composition.md).
- **Directory ownership:** only `@clarvis/paths` spells or builds `.clarvis` and `.agents` paths.
  Human-authored/readable workspace content and machine state live in different trees. See
  [`specs/foundations/paths.md`](specs/foundations/paths.md).
- **Prompt-prefix stability:** do not rewrite or reposition a non-volatile message. Append instead.
  See [`specs/cross-cutting/prompt-cache.md`](specs/cross-cutting/prompt-cache.md).
- **Diagnostics:** packages use the `Logger` port, never `console.*`, raw stdout/stderr, or
  `process.emitWarning`. Logs are not trace events. See
  [`specs/cross-cutting/observability.md`](specs/cross-cutting/observability.md).
- **Secrets and trust:** use the shared sanitization, environment filtering, confinement, and trust
  boundaries. See [`specs/cross-cutting/security.md`](specs/cross-cutting/security.md).
- **Protocol isolation:** UI code does not import the loop. Transport and host boundaries stay behind
  `@clarvis/protocol` and `@clarvis/kernel`.
- **Pre-release persistence:** old pre-release state may be discarded when a format changes. Do not
  add migrations or compatibility readers unless the owner changes this policy.
- **Plan retention:** plans are kept by default and deleted only through the explicit documented
  retention path.
- **No parser in tools:** `@clarvis/tools` does not parse source code or depend on tree-sitter.
- **Windows is a hard constraint:** use `node:path`, argv-based process APIs, the shared shell/process
  helpers, and named platform predicates. Never pass `detached: true` unconditionally.

## Change workflow

1. Inspect `git status --short` and the relevant source, tests, README, and specs.
2. Make the smallest coherent change. Preserve unrelated user edits.
3. Add or update tests at the correct level: `unit`, `component`, `contract`, `integration`,
   `architecture`, or `e2e`.
4. Complete the documentation part of the iteration as defined above.
5. Rebuild a changed package before downstream typechecking when its type surface changed; TypeScript
   resolves cross-package declarations through built `dist/*.d.ts`.
6. Run the targeted package checks implicated by the change.
7. For Markdown changes, run `bun run check:specs`. For dependency/package changes, also run
   `bun run check:graph`.
8. Review the final diff and report exact validation, documentation disposition, and any platform or
   environment limitation.

Do not run `bun run check:pre-commit` as a handoff ritual. The hook owns the full gate and runs it on
an authorized commit. Running it early pays for the same work twice. Never claim the gate passes
unless it genuinely ran to completion.

## Repository skills and evidence reuse

Choose the skill that owns the requested outcome. Additional modes share the same work record;
they do not restart discovery, builds, or verification.

| Outcome                                                                 | Skill                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Documentation audit or synchronization                                  | [clarvis-doc-health](.agents/skills/clarvis-doc-health/SKILL.md)         |
| Focused TUI journey, complete product E2E, or performance investigation | [clarvis-tui-validation](.agents/skills/clarvis-tui-validation/SKILL.md) |
| Release readiness and distributable qualification                       | [clarvis-release-health](.agents/skills/clarvis-release-health/SKILL.md) |

- Keep one record of scope, authorization, source and artifact identities, fixtures, commands,
  outcomes, and evidence paths. Reuse already-read contracts while their contents remain current.
- Reuse a completed check only when its relevant source/dependency inputs, artifact, configuration,
  fixture, and environment still match. A commit alone does not identify a dirty build. Record the
  earlier evidence and why it still applies; missing output or an interrupted check is not a pass.
- Expand root and package scripts before planning gates. Run each required check once; a parent
  script may already include it. The publication hook still runs its own complete gate.
- Build once after the last relevant change and share that artifact across applicable checks.
  Rebuild when its inputs or requested artifact flavor change. Resume from a failed stage and rerun
  invalidated dependents; retain successful independent evidence and both attempts of any retry.
- Read only the selected skill mode's references. A documentation edit or focused regression does
  not automatically require a full product audit, release preflight, or performance soak.
- Keep proof method separate from verdict: source review, static inventory, deterministic tests,
  PTY interaction, real provider, and native hardware establish different claims. Listed scenarios
  and passing lower-level tests do not establish that an E2E journey was executed.

## Tests and checks

Use Bun only, from the repository root unless a package command explicitly changes scope.

```bash
bun install
bun run build
bun run test
bun run typecheck
bun run lint
bun run format:check
bun run test:coverage
bun run check:specs
bun run check:graph
bun run check:harness
bun run check:bun-version

# targeted examples
bun --filter @clarvis/loop build
bun --filter @clarvis/kernel typecheck
bun --filter @clarvis/plan test
bun --filter @clarvis/code start
```

- Verify `git config --local --get core.hooksPath` returns `.githooks`. If not, run
  `bun run hooks:install`.
- Use `bun run test`, not raw root `bun test`, for the supported full suite; the root script isolates
  workspaces.
- Do not use `mock.module()`. Process-global module mutation invalidates suite isolation.
- Every workspace `tsconfig.json` includes its tests.
- Every package test command keeps `--timeout 60000`. Package `bunfig.toml` files keep the shared
  preload and `coveragePathIgnorePatterns = ["../**"]`. `bun run check:harness` enforces this.
- Bun is pinned exactly by `mise.toml`; `bun run check:bun-version` enforces the same runtime across
  CI, the crash canary, Docker, all manifests, `@types/bun`, and the lockfile.
- Coverage authority is `tooling/checks/coverage.ts` over LCOV counters, including source-file
  presence. Do not infer package coverage from Bun's averaged `All files` row or lower a floor to pass.
- Keep the pre-commit phases sequential and in their current order. Each phase already fans out.
- A targeted failure must be fixed or accurately reported; never defer a known failure to the hook.

The full architecture, gate order, coverage policy, and CI/platform scope are in
[`specs/cross-cutting/test-architecture.md`](specs/cross-cutting/test-architecture.md) and
[`specs/cross-cutting/build-and-ci.md`](specs/cross-cutting/build-and-ci.md).

## TUI validation

Interactive `@clarvis/code` defects must be reproduced and verified in a real PTY. Use the
[`clarvis-tui-validation`](.agents/skills/clarvis-tui-validation/SKILL.md) skill for the
end-to-end evidence contract, the `tui-driver` skill for its PTY interaction mechanics, and
`bun run smoke` for the automated artifact boot contract.

- Build the bundle with `bun run build` (all distributables) or `bun run build:code` (TUI only), or
  set `CLARVIS_CODE_SOURCE=1`; otherwise the CLI may run a stale `dist/index.js`.
- Poll for a stable rendered token instead of sleeping for a fixed duration.
- Run `bun run smoke` after bundling when the change affects boot or first paint.

Read [`packages/code/README.md`](packages/code/README.md) and the applicable `specs/hosts/code-*.md`
documents before changing the TUI.

## Source and documentation style

- Public APIs and non-obvious internal contracts use TSDoc. Describe behavior, invariants, failure
  modes, and ownership rather than restating types.
- Relative module specifiers name the actual TypeScript source extension (`.ts`, `.tsx`, `.mts` or
  `.cts`). Keep `.js`, `.jsx`, `.mjs` and `.cjs` only for real JavaScript files or generated
  artifacts; `bun run check:imports` enforces this and the compiler rewrites emitted JavaScript.
- Do not add ad-hoc `//` or plain block comments in `src/`. Keep tooling directives and the minimal
  comment required by an otherwise empty block.
- Never insert literal NUL, zero-width, BOM, non-breaking, or irregular-whitespace characters. Use an
  escape such as `\0` when the codepoint is required.
- Keep diagnostics structured: dotted lowercase event names, snake_case scalar fields, and no secret
  material.
- Keep commits focused; do not reformat unrelated files.
- Use Markdown links for repository documentation and run `bun run check:specs` after editing them.

## Known environmental failures

Do not compress the evidence in [`specs/known-issues.md`](specs/known-issues.md) into a guess. In
particular:

- `@clarvis/code` can crash under Bun with a signal after a passing test; retry and classify the
  process crash separately from an assertion failure.
- `@clarvis/loop` has a distinct rare Bun `epoll_ctl EEXIST` CI failure.
- The Codex workspace sandbox can prohibit local socket listeners. Tests that bind an ephemeral
  loopback port may then fail together with `Failed to start server. Is port 0 in use?` even though
  no port is occupied. On that signature, rerun the affected test or package outside the sandbox
  before diagnosing a product regression or changing code.
- On macOS, invoking the host `/usr/bin/git` from the Codex workspace sandbox can falsely trigger
  the Command Line Developer Tools installer even when Git works on the host. Use injected fake
  executables for sandbox contract tests and rerun real host-Git probes outside the Codex sandbox;
  do not diagnose a missing Git installation from that popup.
- Windows and macOS CI availability and known Windows gaps are recorded there and in the build spec.
- Workspace-confined writes still have a documented parent-directory TOCTOU; do not claim a partial
  path re-check closes it.

When the environment prevents a required check, report the exact command, failure, and unverified
surface. Do not report an unavailable platform or interrupted suite as passing.

## Handoff checklist

Every final handoff states:

- what changed and why;
- the package README(s) and spec(s) reviewed;
- which documentation files changed, or `Docs reviewed; no change needed` with the reason;
- the exact checks run and their result;
- any remaining risk, known issue, or unverified platform;
- that no commit or publication action was performed, unless covered by a scoped publication
  authorization.
