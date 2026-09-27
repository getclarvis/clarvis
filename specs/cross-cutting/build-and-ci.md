# Build graph, package surfaces, CI, the bundle artifact and platform support

> Implemented at `packages/...` and `tooling/...`. Every claim below is anchored to current source or
> test evidence, using a stable symbol or configuration key where available. Open questions are
> collected in the final section.

## 1. Purpose

This subsystem is everything that turns workspace source directories into something runnable and keeps them
consistent while they change: one Bun workspace (`package.json`, `workspaces`) with a single root
lockfile (`bun.lock` is the only lockfile in the tree), a two-layer TypeScript configuration (a `tsc -b`
solution over per-package `composite` emit projects, `tsconfig.json`), one shared ESLint/Prettier
configuration applied through each package's shim (`eslint.config.base.js`), a Knip pass run
once from the root (`package.json`, `scripts.knip`), a locally-enforced pre-commit gate
(`.githooks/pre-commit`),
independent Linux CI gates plus macOS ARM64 and Intel jobs (`.github/workflows/ci.yml`), a four-target portable
release matrix delegated to [distribution and updates](distribution-and-updates.md), and a separate
bundling path for the one package that is never emitted by `tsc` — the terminal UI
(`packages/code/tooling/artifact/build.ts`). The root `build` command composes those two paths sequentially,
so its completion means every distributable exists rather than only the TypeScript libraries.

Workspace resolution follows package `exports`: the `bun` condition points at source, `types` at
declarations, and `import` at emitted JavaScript (`packages/capability/package.json`, `exports`).
Development profiles enable `bun` and do not emit; build profiles disable it and emit declarations
through project references (`tsconfig.base.json`, `packages/kernel/tsconfig.build.json`). No
workspace `paths` aliases mediate those imports. `check:graph` validates effective profiles,
exports and source resolution (`tooling/lib/module-resolution-policy.ts`,
`moduleResolutionPolicyErrors`; `tooling/lib/package-graph.ts`, `analyzePackageGraph`).

The executable Bun contract has the same single-owner shape. `mise.toml` carries the exact runtime,
and `tooling/checks/bun-version.ts` projects it across CI, release packaging, the crash canary, both
all manifests, `@types/bun`, the resolved lockfile entry and an attributable
version/revision line in every remote job. The checker is part of `lint:intent`, so a partial runtime
upgrade cannot reach the pre-commit test phase.

The second is that the development TUI bundle has runtime-shaped invariants that no unit
test can observe, because the unit suite imports `src/` by path
(`packages/code/tooling/artifact/smoke.ts`). Bundling is therefore guarded by three separate
mechanisms: pure assertion functions run inside the build itself
(`packages/code/tooling/artifact/contract.ts`), a unit test over those same functions
(`packages/code/tests/architecture/artifact-contract.test.ts`), and a PTY boot of the finished
artifact through an exclusive `SmokeContext` (`packages/code/tooling/artifact/isolation.ts`), used
by `packages/code/tooling/artifact/smoke.ts`. The context fixes HOME, `CLARVIS_HOME`, workspace,
temporary, cache, logs, sockets and installation roots and passes an allowlisted environment to
children; its socket directory may be a sibling short root when the endpoint budget requires one, and
an inherited operator root is never treated as a fixture.

The bundle itself exists for a measured cost, stated in `packages/code/tooling/artifact/build.ts`: running
the TUI from source pipes every `.tsx` file through Babel via the OpenTUI Solid plugin on every launch
(measured: 466ms to load Babel plus 2700ms to transform 44 files, ~3.2s total), and Bun's transpiler
cache does not cover plugin output, so the cost repeats on every start — the artifact applies that
transform once, at build time. The same file frames its lazy-chunk requirement (§4.6, BUILD-3) the same
way : "`@clarvis/llm` deliberately imports its AI SDK adapter only when a provider is first
used. A monolithic Bun bundle flattened that boundary and made the idle TUI retain provider SDKs it had
never called. Code splitting is therefore a memory invariant, not a deployment preference."

## 2. Surface

### 2.1 Root scripts (`package.json`)

| Script | Command | Source |
| --- | --- | --- |
| `build` | `build:packages && build:code` | `package.json` (`scripts.build`) |
| `build:packages` | `tsc -b`, then sandbox native assets and the tools worker bundle | `package.json` (`scripts.build:packages`) |
| `build:watch` | `tsc -b --watch` | `package.json` (`scripts.build:watch`) |
| `clean` | `tsc -b --clean && bun --workspaces clean` | `package.json` (`scripts.clean`) |
| `test` | `test:tooling`, followed by every sequential package suite, all `&&`-chained | `package.json` (`scripts.test`) |
| `test:cleanup` | run one supplied argv under an exclusive temporary area and fail on residue | `package.json` (`scripts.test:cleanup`) |
| `test:fast` | tooling unit tests and in-memory package suites, isolated by workspace | `package.json` (`scripts.test:fast`) |
| `test:integration` | tooling and package physical suites, isolated by workspace | `package.json` (`scripts.test:integration`) |
| `test:tooling` | unit and architecture tests, then all tooling integration canaries once | `package.json` (`scripts.test:tooling`) |
| `test:tooling:fast` | in-memory tooling unit cases | `package.json` (`scripts.test:tooling:fast`) |
| `test:module-resolution` | compiler and Bun runtime canary in a disposable workspace | `package.json` (`scripts.test:module-resolution`) |
| `test:coverage` | `bun --workspaces --sequential --if-present test:coverage && bun run coverage:check` | `package.json` (`scripts.test:coverage`) |
| `coverage:check` | `bun run tooling/checks/coverage.ts` | `package.json` (`scripts.coverage:check`) |
| `typecheck` | workspace typechecks followed by `typecheck:tooling` | `package.json` (`scripts.typecheck`) |
| `lint` | `lint:eslint && lint:intent && knip` | `package.json` (`scripts.lint`) |
| `lint:eslint` | workspace lint followed by `lint:tooling` | `package.json` (`scripts.lint:eslint`) |
| `lint:intent` | `test:tooling`, then source-policy, graph, spec, harness, Bun-version, Bun-source, import-extension and release-readiness checks | `package.json` (`scripts.lint:intent`) |
| `check:graph` | `bun run tooling/checks/package-graph.ts --check-doc` | `package.json` (`scripts.check:graph`) |
| `check:specs` | `bun run tooling/checks/spec-hygiene.ts` | `package.json` (`scripts.check:specs`) |
| `knip` | `knip --tsConfig tsconfig.build.json` (root only) | `package.json` (`scripts.knip`) |
| `format` / `format:check` | workspace formatting plus root tooling and repository workflows | `package.json` (`scripts.format*`) |
| `check:pre-commit` | `format:check && build && typecheck && lint:eslint && lint:intent && knip && test:coverage` | `package.json` (`scripts.check:pre-commit`) |
| `hooks:install` | `git config core.hooksPath .githooks` | `package.json` (`scripts.hooks:install`) |
| `build:<pkg>` | `bun --filter @clarvis/<pkg> build` | `package.json` (`scripts.build:<pkg>`) |
| `link` | `bun --filter @clarvis/code link` | `package.json` (`scripts.link`) |
| `smoke` | `bun --filter @clarvis/code smoke` | `package.json` (`scripts.smoke`) |
| `release:package` / `release:smoke` / `release:install-smoke` | native portable archive, artifact smoke, and installer smoke | `package.json` (`scripts.release:*`) |
| `check:release` | root/installers/repository identity; tag identity when `RELEASE_TAG` is supplied | `package.json` (`scripts.check:release`) |
| `bench:code` | `bun --filter @clarvis/code bench` | `package.json` (`scripts.bench:code`) |
| `check:harness` | `bun run tooling/checks/test-harness.ts` | `package.json` (`scripts.check:harness`) |
| `check:bun-version` | `bun run tooling/checks/bun-version.ts` | `package.json` (`scripts.check:bun-version`) |
| `check:bun-sources` | `bun run tooling/checks/bun-sources.ts` | `package.json` (`scripts.check:bun-sources`) |

The Linux `checks` job runs the structural gates and complete tooling suite through
`lint:intent` under `test:cleanup`; the `coverage` supervisor audits each existing workspace
attempt in its single LCOV pass, then runs source-presence and floor checks. The separate
`sandbox-macos-intel` and `keyboard-macos` jobs audit their existing native qualifications.
`test:fast` and `test:integration` are focused
development entries, and CI does not repeat the fast suite after coverage. Production:
`.github/workflows/ci.yml` (`checks`, `coverage`, `sandbox-macos-intel`, `keyboard-macos`) and
`tooling/lib/ci-coverage.ts` (`runCiCoverage`),
`tooling/lib/test-temporary-audit.ts` (`runTestTemporaryAudit`). Test:
`tooling/tests/architecture/ci-workflow.test.ts` and
`tooling/tests/integration/ci-coverage.test.ts`.

Root tooling keeps executable checks under `tooling/checks/`, shared libraries under `tooling/lib/`,
release orchestration under `tooling/release/`, and classified tests under
`tooling/tests/`.

`check:specs` scans tracked and unignored Markdown and source files for dangerous characters,
documentation links, unstable source line locators, and explicit repository file references that no
longer exist. It additionally rejects calendar dates and source-code line-count inventories in
tracked specs so chronology remains in `CHANGELOG.md` and implementation size does not masquerade as
a contract. URLs are excluded, and illustrative paths use visible placeholders. Production:
`tooling/checks/spec-hygiene.ts`; `extractLineQualifiedReferences`,
`extractRepositoryFileReferences`, `resolveRepositoryFileReference`, `extractCalendarDates`, and
`extractSourceSizeReferences` in `tooling/lib/spec-hygiene.ts`. Test: the `stable repository references`
and `timeless specifications` cases in
`tooling/tests/unit/spec-hygiene.test.ts`.

`engines.bun` is `>=1.4.0` at the root (`package.json`, `engines.bun`) and repeated in every package manifest
(e.g. `packages/capability/package.json`, `packages/code/package.json`).
`mise.toml` pins the toolchain to `bun = "1.4.0"` exactly.

Root `devDependencies` hold the entire toolchain — `@eslint/js`, `@types/bun` (pinned `1.4.0`),
`@types/node`, `@types/picomatch`, `eslint`, `globals`, `knip`, `prettier`, `typescript ^6.0.3`, and `typescript-eslint`
(`package.json`, `devDependencies`). No package re-declares them. `allowScripts` permits post-install
scripts for `esbuild@0.28.1` only (`package.json`, `allowScripts`).

### 2.2 Per-package script contract

Every workspace declares the same script names, so the root `--workspaces` fan-outs work uniformly:
`build`, `clean`, `typecheck`, `test`, `test:coverage`, `lint`, `format`, `format:check`. Deviations
that matter:

| Package | Deviation | Citation |
| --- | --- | --- |
| `@clarvis/code` | `build` invokes the package-local artifact builder rather than `tsc`; `build:install` selects the map-free install artifact; also adds artifact/release/installer smokes, native release packaging, two benchmarks, deterministic `setup`, `start`, `dev`, and `link` | `packages/code/package.json` (`scripts`), `packages/code/tooling/artifact/build.ts` |
| `@clarvis/protocol` | `test` is `bun run test:contract`, which is `tsc -p tsconfig.json` — it runs no `bun test` at all | `packages/protocol/package.json` |
| `@clarvis/llm`, `@clarvis/loop`, `@clarvis/workflows` | declare `prebuild: bun run clean` | `packages/llm/package.json`, `packages/loop/package.json`, `packages/workflows/package.json` |
| `@clarvis/kernel`, `@clarvis/protocol` | `typecheck` is `tsc -p tsconfig.json` with no `--noEmit` flag (their `tsconfig.json` sets `noEmit: true` itself) | `packages/kernel/package.json`, `packages/kernel/tsconfig.json` |
| `@clarvis/code` | `typecheck` is bare `tsc --noEmit` (no `-p`) | `packages/code/package.json` |

Every `bun test` invocation reachable from a package's `test` script carries `--timeout 60000` on the
command line (the type-only `@clarvis/protocol` runs `tsc` instead).

### 2.3 Package surfaces — `exports` subpaths and bins

| Package | Export subpaths (besides `./package.json`) | `bin` |
| --- | --- | --- |
| `@clarvis/capability` | `.`, `./ports`, `./trace` | — |
| `@clarvis/supervision` | `.` | — |
| `@clarvis/llm` | `.`, `./adapter`, `./metrics` | — |
| `@clarvis/paths` | `.` | — |
| `@clarvis/execpolicy` | `.` | — |
| `@clarvis/judge` | `.` | — |
| `@clarvis/sandbox` | `.` | — |
| `@clarvis/trace` | `.`, `./testing` | — |
| `@clarvis/mcp-client` | `.` | — |
| `@clarvis/tools` | `.`, `./shell` | — |
| `@clarvis/hooks` | `.`, `./capability` | — |
| `@clarvis/skills` | `.`, `./catalog`, `./capability` | — |
| `@clarvis/memory` | `.`, `./schemas`, `./capability`, `./settings`, `./testing` | — |
| `@clarvis/plan` | `.`, `./schemas`, `./testing`, `./capability`, `./settings` | — |
| `@clarvis/goal` | `.`, `./settings` | — |
| `@clarvis/protocol` | `.` | — |
| `@clarvis/loop` | `.`, `./capabilities/tools`, `./host`, `./workflows`, `./testing` | — |
| `@clarvis/workflows` | `.`, `./schemas`, `./artifact` | — |
| `@clarvis/kernel` | `.`, `./bootstrap`, `./config`, `./policy`, `./paths`, `./local`, `./logger`, `./system-docs` | `clarvis-kernel` → `dist/bin.js` |
| `@clarvis/code` | **none** | `clarvis` → `src/cli.ts` |

Every export entry has the same three-condition shape, `bun` first:

```json
".": { "bun": "./src/index.ts", "types": "./dist/index.d.ts", "import": "./dist/index.js" }
```

(`packages/capability/package.json`; the same shape recurs in every library manifest). The application package publishes no `exports` and is reached through its `bin`
(`packages/code/package.json`). Kernel points at built `dist/bin.js`; Code points at TypeScript source
(`src/cli.ts`), which dynamically loads TypeScript source at runtime (§4.6).

`@clarvis/skills` is the only manifest carrying `"overrides": { "esbuild": "^0.25.0" }` plus
`repository`/`homepage`/`bugs` metadata (`packages/skills/package.json`).

### 2.4 tsconfig profiles

| Profile | Packages | Evidence |
| --- | --- | --- |
| Extends `tsconfig.base.json` | All libraries except protocol and kernel | `packages/<name>/tsconfig.json`, `extends` |
| Standalone | 3: `protocol`, `kernel`, `code` | none of those three contains `extends` |

`tsconfig.base.json` fixes `module`/`moduleResolution` = `NodeNext`, `noEmit: true`,
`customConditions: ["bun"]`,
`rewriteRelativeImportExtensions: true`, `types: ["bun","node"]`, `strict`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `esModuleInterop`,
`forceConsistentCasingInFileNames`, `resolveJsonModule`, `declaration: false`, `sourceMap: true` and
`skipLibCheck: true`. Extending packages keep only `target`/`lib` and other local options
(`packages/capability/tsconfig.json`).

The three standalone profiles differ concretely:

| Package | `module` | `moduleResolution` | Extras |
| --- | --- | --- | --- |
| `protocol` | `NodeNext` | `NodeNext` | `rewriteRelativeImportExtensions`, `declaration: true`, `isolatedModules: true`, `verbatimModuleSyntax`, `noEmit: true`, no `types` array (`packages/protocol/tsconfig.json`) |
| `kernel` | `NodeNext` | `NodeNext` | `rewriteRelativeImportExtensions`, `verbatimModuleSyntax`, `noEmit: true`, `customConditions: ["bun"]` (`packages/kernel/tsconfig.json`) |
| `code` | `ESNext` | `bundler` | `jsx: "preserve"`, `jsxImportSource: "@opentui/solid"`, `types: ["bun"]` only, `allowImportingTsExtensions`, `noEmit: true`, `customConditions: ["bun"]` (`packages/code/tsconfig.json`) |


### 2.5 ESLint / Prettier / Knip

`clarvisEslintConfig({ tsconfigRootDir, project = ["./tsconfig.json"] })` is the single exported
factory (`eslint.config.base.js`). It composes `globalIgnores(["dist/","coverage/","node_modules/"])`, `js.configs.recommended`, `tseslint.configs.recommended` and
`tseslint.configs.recommendedTypeChecked`, sets `ecmaVersion: 2026`, and adds four
rules: `no-unused-vars` with `^_` ignore patterns, `consistent-type-imports`,
`no-floating-promises` with `ignoreVoid: false`, and `no-empty` with `allowEmptyCatch: true`. A second config object turns off eleven rules under `tests/**` — `only-throw-error`,
`require-await`, `no-unsafe-assignment`, `no-unsafe-call`, `no-unsafe-member-access`,
`no-unsafe-return`, `no-unsafe-argument`, `no-unnecessary-type-assertion`,
`no-redundant-type-constituents`, `no-explicit-any` and `await-thenable` — and flips
`no-floating-promises` back to `ignoreVoid: true` there (`eslint.config.base.js`).

Most packages' `eslint.config.js` is exactly one call to that factory (e.g.
`packages/paths/eslint.config.js`). The following append rules:

| Package | Appended | Citation |
| --- | --- | --- |
| `capability` | `no-floating-promises: ignoreVoid` for `src/tasks.ts` | `packages/capability/eslint.config.js` |
| `kernel` | `require-await: off` in `src/**`; restricted private Loop imports | `packages/kernel/eslint.config.js` |
| `workflows` | restricted private Loop imports | `packages/workflows/eslint.config.js` |
| `code` | `eslint-plugin-unicorn` + `unicorn/filename-case` (PascalCase or kebab-case); `no-unsafe-*` and `no-base-to-string` and `require-await` off; a `tests/**/*.{ts,tsx}` block turning off `no-non-null-assertion` and `no-require-imports`; a `src/core/tasks.ts` block re-enabling `no-floating-promises` with `ignoreVoid: true` (the same pattern `@clarvis/capability` uses for its own `src/tasks.ts`); six `no-restricted-imports` layer rules (adapters/core/keys/ui/infrastructure/features) | `packages/code/eslint.config.js`, tests block tasks block |

`eslint-plugin-unicorn` is the only package-level lint devDependency (`packages/code/package.json`).

Prettier is one root `.prettierrc.json` — `semi: true`, `singleQuote: false`, `trailingComma: "all"`,
`printWidth: 100`, `tabWidth: 2`, `arrowParens: "always"` (`.prettierrc.json`) — and one root
`.prettierignore` that excludes `node_modules/`, `dist/`, `coverage/`, `package-lock.json`, and
`**/specs/` (`.prettierignore`).

Knip runs once from the root with each workspace's build tsconfig (`package.json`, `scripts.knip`).
The build profile supplies the `src`/`dist` relationship so Knip attributes conditional private
imports selected through `dist` back to their source files; this check runs after build in the
pre-commit gate. `knip.json` sets
`ignoreExportsUsedInFile` for `interface` and `type` and adds five workspace overrides. The
root workspace's entries cover executable TypeScript checks and the Bun preload; its project globs
cover root tooling.
`packages/code` explicitly includes
its `src`, tests, artifact builders and benchmarks,
`packages/kernel` adds its Bun-native executable test fixtures as entries,
`packages/protocol` adds
`tests/contract/public-contract.fixture.ts` as an entry; that fixture type-imports 24 protocol names
(`packages/protocol/tests/contract/public-contract.fixture.ts`), and
`packages/tools` ignores the `rg` binary.

### 2.6 Bun test configuration

Root `bunfig.toml` sets `[install] linker = "hoisted"` and a `[test]` block with
`preload = ["./tooling/test-runtime/clarvis-home-preload.ts"]`, `coverageReporter = ["text","lcov"]`,
`coverageDir = "coverage"`, `coverageSkipTestFiles = true`. Every workspace package
has its own `bunfig.toml` repeating those three coverage keys plus
`coveragePathIgnorePatterns = ["../**"]` (e.g. `packages/capability/bunfig.toml`). Every package
that runs `bun test` also preloads the shared home redirector; only the type-only `protocol` package
does not. `packages/code/bunfig.toml` preloads four modules in
a pinned order, `@opentui/solid/preload` first "because it registers the Solid JSX transform plugin
every `.tsx` test is compiled with," with the tree-sitter preload placed "ahead of anything that loads
`src/`, so its no-worker stub is installed on `TreeSitterClient.prototype` before any code can construct
a client", explains that no `[install]`-level global preload is declared there
because it cost every Bun process started from that directory ~250 ms.

### 2.7 CI workflow inputs

`ci.yml` triggers on pushes to `main` and `develop`, pull requests, and manual dispatch, with read-only contents
permission and `concurrency: ci-${{ github.ref }}, cancel-in-progress: true`
(`.github/workflows/ci.yml`). `develop` is the default integration branch; `main` is the approved
release-source branch. Outside an explicitly authorized release in progress, its tip must equal
the source commit of the latest published release tag. Promotion, final checks, tagging, and
asynchronous publication form a serialized transition; a failed publication leaves that transition
incomplete, not permission to rewrite history. This is an operator workflow requirement, not an
automated equality check in CI. Their GitHub rulesets target each branch by name, require pull requests,
up-to-date branches, resolved conversations, and the three existing CI contexts, and block deletion
and force pushes without bypass actors. Neither requires linear history. `main` accepts merge
commits only; `develop` also accepts squash for task PRs. Promotions and back-merges preserve
ancestry with merge commits. Ruleset settings are external GitHub configuration and require live
inspection; passing local checks alone does not prove enforcement. The operating sequence lives in
[CONTRIBUTING.md](../../CONTRIBUTING.md#branch-workflow), [AGENTS.md](../../AGENTS.md#branch-workflow),
and [RELEASING.md](../../RELEASING.md). Ordinary branch pushes do not publish. `.github/workflows/gitflow-release.yml` creates signed RC
source tags only for open same-repository `release/*` PRs targeting `main`, then creates a final tag after a merged release PR has green
CI on its exact merge SHA. Candidate events are `opened`, `reopened`, `synchronize`, and `edited`;
plain pushes and closed unmerged PRs cannot create tags. Checkout uses the PR head SHA, not the
synthetic merge SHA. Before acquiring Publisher credentials, the workflow verifies that the live PR
is still open at that head and still targets `main`. Retries reuse the same candidate tag.
Production: `.github/workflows/gitflow-release.yml` (candidate PR guard).
Test: `tooling/tests/architecture/gitflow-workflow.test.ts` (PR triggers and credential ordering).
`.github/workflows/release.yml` excludes RC pushes and admits stable version tags for
publication. `.github/workflows/candidate.yml` publishes source prereleases for signed RC tags.
Both workflows request Publisher installation tokens scoped to their target repository.
Production: `tooling/release/gitflow.ts` (`main`) and `tooling/lib/gitflow-release.ts`
(`planGitflowRelease`, `candidateTag`). Test: `tooling/tests/unit/gitflow-release.test.ts` and
`tooling/tests/integration/gitflow-release-git.test.ts`. External App installation, signing secrets, and tag
creation permissions require live validation; local Git tests do not prove GitHub enforcement.

Every checkout and setup action is pinned to a commit SHA and checkout
does not retain credentials. The on-demand canary has the same least-privilege posture: explicit
`contents: read`, SHA-pinned checkout and setup-bun actions, and
`persist-credentials: false` (`.github/workflows/segfault-canary.yml`, `permissions.contents` and
`jobs.canary.steps`). `segfault-canary.yml`
declares four dispatch inputs (`on.workflow_dispatch.inputs`): `bun-version` (default `"1.4.0"`), `coverage` (boolean,
default true), `iterations` (default `"30"`, described as ">= 30; smaller batches cannot tell 20%
from 50%"), and `jsc` (choice: `none`, `no-concurrent-gc`, `single-marker`, `no-concurrent-jit`). Its
job carries `timeout-minutes: 300` (`jobs.canary.timeout-minutes`), and the file's header comment gives the cost that
justifies it and forbids automating it: "~30 iterations at a couple of minutes each, so a batch costs
one to two hours of billed runner time. Dispatching is therefore an explicit decision every time — do
NOT add a `schedule:` or `push:` trigger".

### 2.8 Build/tooling environment variables

| Variable | Read at | Effect |
| --- | --- | --- |
| `CLARVIS_CODE_SOURCE=1` | `packages/code/src/update/check.ts`, `packages/code/src/update/installation.ts` | identifies a source checkout so managed-release update checks are skipped and self-update is refused |
| `SMOKE_TIMEOUT_MS` | `packages/code/tooling/artifact/smoke.ts` | smoke timeout, default `90_000` |
| `BENCH_N`, `BENCH_POLL_MS`, `BENCH_TIMEOUT_MS`, `BENCH_MAX_LOAD` | `packages/code/tooling/benchmarks/first-paint.ts` | benchmark sample size, poll, timeout, per-core load refusal (default `0.35`) |
| `GITHUB_STEP_SUMMARY` | `tooling/checks/ci-coverage.ts`, `tooling/checks/ci-artifacts.ts` | package outcomes, retry notes and build-transfer measurements |
| `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `CI_BUILD_PRODUCER_ATTEMPT` | `tooling/checks/ci-artifacts.ts`, and `requireBuildProducer` in `tooling/lib/ci-artifacts.ts` for `CI_BUILD_PRODUCER_ATTEMPT` | same-run artifact identity with distinct producer and consumer attempts |
| `CI_BUILD_ARTIFACT_ID`, `CI_BUILD_ARTIFACT_DIGEST`, `CI_BUILD_TAR_DIGEST` | `tooling/lib/ci-artifacts.ts`, `requireBuildProducer` | complete immutable producer receipt required before download |
| `CI_UPLOAD_STARTED_MS`, `CI_DOWNLOAD_STARTED_MS` | `tooling/checks/ci-artifacts.ts` | transfer durations including step-transition overhead |
| `BUN_JSC_useConcurrentGC` / `BUN_JSC_numberOfGCMarkers` / `BUN_JSC_useConcurrentJIT` | `.github/workflows/segfault-canary.yml` (`jobs.canary.steps[name=measure].run`) | canary JSC arms |

## 3. Data and formats

### 3.1 Library package emit layout

Every `tsconfig.build.json` is `composite`, emits to `dist/`, roots at `src`, and keeps its
incremental state **inside** the output directory as `dist/.tsbuildinfo`
(`packages/capability/tsconfig.build.json`; identical in all emitting packages). All set
`declaration: true` and `declarationMap: true`. All exclude `tests`
(`packages/capability/tsconfig.build.json`).

So a library's shipped shape is:

```
packages/<pkg>/dist/
  .tsbuildinfo
  index.js  index.d.ts  index.d.ts.map  index.js.map
  <subpath>.js  <subpath>.d.ts  ...
```

`files` in the manifests is `["dist", "README.md"]` for library packages
(`packages/capability/package.json`, `files`), `["dist"]` for `protocol`
(`packages/protocol/package.json`, `files`); `kernel` and `code` declare no `files` field.
Every workspace package is `"private": true` and omits `version`; workspace entries in `bun.lock`
also omit versions. The root `package.json` owns the single Clarvis product version, and
`check:graph` enforces the complete manifest/lock policy.

### 3.2 The `code` artifact layout

`packages/code/tooling/artifact/build.ts` (`main`) calls `Bun.build` with
`entrypoints: [src/index.tsx]`, `target: "bun"`, `outdir: dist`, the Solid transform plugin,
`external: ["@opentui/core", "@opentui/core-*", "@clarvis/tools", "@clarvis/sandbox", "pino"]`, `splitting: true` and `minify: true`.
The entry contains the renderer/startup composer and dynamically imports the complete runtime.
The ordinary developer/root
build uses `sourcemap: "external"`; `build:install` passes `--install` and uses `sourcemap: "none"`.
The developer artifact is:

```
packages/code/dist/
  index.js                     entry point
  chunk-<hash>.js              lazy chunks (matched by /^chunk-[a-z0-9]+\.js$/)
  maps/index.js.map            detached source maps
  maps/chunk-<hash>.js.map
  models-dev.json              copied asset
```

The installed layout is identical except that it has no `maps/` directory or `.map` file. The
one-shot TypeScript setup verifies the exact Bun version in `mise.toml`, installs from the frozen root
lockfile, builds that layout, unlinks only a bin registration it can prove this package owns, then registers the `clarvis` bin
with `bun link`. It neither downloads a runtime, edits a shell profile, publishes development maps,
nor deletes an unrelated command (`packages/code/tooling/setup.ts`).

The generated chunk-name shape is pinned by the smoke's listing filter
`/^chunk-[a-z0-9]+\.js$/`. The provider contract is deliberately graph-shaped rather than tied to
one Bun rewrite: it finds the chunk containing the adapter-owned `llm.provider.resolved` marker,
requires a generated dynamic
import of that basename somewhere in the artifact, rejects any static import of it, and rejects the
adapter marker in the entry. Bun reports output paths with host-native separators, so basename
extraction accepts both `/` and `\` before matching the generated import specifier
(`packages/code/tooling/artifact/contract.ts`, `assertLazyProviderArtifact`).

The one copied asset is declared in `ASSETS` alongside the module that reads it back
(`packages/code/tooling/artifact/build.ts`):

| `from` | `to` | `reader` |
| --- | --- | --- |
| `packages/kernel/src/data/models-dev.json` | `dist/models-dev.json` | `packages/kernel/src/models/model-catalog.ts` |

The model catalog tries `../data/models-dev.json` then `./models-dev.json`
(`packages/kernel/src/models/model-catalog.ts`, `bundlePath()`). The smoke checks the concrete
bundled path before booting (`packages/code/tooling/artifact/smoke.ts`, `REQUIRED_ASSETS`). Workflow
built-ins are TypeScript values bundled with `@clarvis/workflows`, not path-read assets.

Copying `models-dev.json` is an offline availability contract, not an eager startup read. Interactive
boot leaves the catalog untouched until Model, Effort or Providers mounts and calls Code's
single-flight loader. The artifact smoke requires the asset to exist while also rejecting
`catalog.load.started` before complete usable paint (`packages/code/src/runtime.tsx`,
`ensureModelsCatalog`; `packages/code/tooling/artifact/smoke.ts`).

### 3.4 Git attributes

`.gitattributes` normalizes every file to `text=auto eol=lf` and marks `*.png`, `*.wasm`,
`*.ico`, `*.woff`, and `*.woff2` as binary, and keeps `bun.lock -text`. This preserves
exact-byte fixtures such as the CRLF/BOM tally in `packages/tools/src/lib/text.ts` and the `apply_patch` tests.

### 3.5 Report formats produced by the tooling

`tooling/checks/package-graph.ts` emits either JSON (`--json`) or a Markdown table rendered by
`renderMarkdown` (`tooling/lib/package-graph.ts`, `renderMarkdown`) whose header is
`| Package | Role | Direct internal dependencies | Internal consumers |`. The `checkDocument`
validator compares that complete generated block with `specs/package-coupling-analysis.md`; optional
dependencies carry the suffix `(optional)` in the dependency column.

`tooling/checks/ci-coverage.ts` emits structured package/attempt/start/end/duration/result records,
a GitHub `::warning::` annotation for each classified retry, and package outcomes in
`GITHUB_STEP_SUMMARY`. `tooling/checks/ci-artifacts.ts` records archive bytes, packaging, upload,
download and restoration durations, plus both run attempts and the immutable artifact ID.

`.github/workflows/segfault-canary.yml` (`jobs.canary.steps[name=measure].run`) appends a
`## segfault-canary result` block with the arm, the
`crashes / iterations` ratio, an exit-code histogram, and de-duplicated `https://bun.report/...`
URLs scraped from the crash logs.

## 4. Behavior

### 4.1 Install and resolution

At runtime under Bun, an internal `@clarvis/x` specifier resolves through that package's `exports`
`bun` condition and loads source. Development typechecks select the same source using
`customConditions: ["bun"]`; builds clear that condition and select `types` declarations through
workspace links (`tsconfig.base.json`, `packages/kernel/tsconfig.build.json`,
`tooling/tests/architecture/module-resolution-contract.test.ts`).

### 4.2 Root build composition and `tsc -b`

`bun run build` runs `build:packages` and then `build:code` sequentially (`package.json`,
`scripts.build`). The first phase runs `tsc -b` against the root solution file,
then builds the native sandbox assets and the source tools worker manifest
(`scripts.build:packages`). The second invokes `@clarvis/code`'s Bun bundle. The solution declares
`"files": []` and references every package that has a `tsconfig.build.json`
(`tsconfig.json`). `@clarvis/code` is absent; `tsconfig.json` states it "is Bun-only (runs from
source, never emits) and is intentionally excluded", and indeed `packages/code` has no
`tsconfig.build.json`.

Each `tsconfig.build.json` extends its development config and explicitly sets `noEmit: false` and
`customConditions: []` for a composite declaration project with package-local `rootDir` and
`outDir` (`packages/capability/tsconfig.build.json`,
`tooling/lib/module-resolution-policy.ts`, `moduleResolutionPolicyErrors`).

Repository source names the actual relative TypeScript extension. Shared library profiles and the
standalone emitting profiles enable `rewriteRelativeImportExtensions`, so JavaScript output
still imports sibling `.js`/`.mjs`/`.cjs` files. `code` already permits TypeScript extensions under
its non-emitting bundler profile. The `check:imports` pass scans tracked and unignored TypeScript ASTs
and rejects literal relative specifiers without an extension, as well as runtime-style extensions
that mask a neighboring TypeScript source (`tooling/checks/import-extensions.ts`,
`invalidRelativeImportExtensions`). It suggests a source path only when that target is
unambiguous. Real generated artifacts such as `dist/index.js` and lazy chunks remain JavaScript;
calculated runtime imports are outside this literal-specifier check.

The same AST pass requires an alias when a source import climbs at least two directories within
its own `src`, or a package test/tooling module imports its own `src`. Short relatives, public
package imports, fixtures and resource paths stay as written. The check reports the target and
required mapping even for a new package without `#src/`; every current workspace with eligible
imports has adopted it (`packages/code/package.json`, `imports`;
`packages/kernel/package.json`, `imports`;
`tooling/checks/import-extensions.ts`, `moduleSpecifiers`,
`invalidPrivateImportConvention`; `tooling/tests/unit/import-extensions.test.ts`).

Declaration emit deliberately retains the source-oriented `.ts`/`.tsx` specifier. Under NodeNext,
TypeScript resolves that declaration edge to the sibling `.d.ts`; package build audits and the root
project-reference build verify those consumers. The runtime rewrite claim therefore applies to
emitted JavaScript, not to declaration text.

No effective `@clarvis/...` `paths` mapping is permitted in development, build or tooling. The
checker resolves configuration inheritance with TypeScript and rejects aliases, `bun` leaking into
build, missing source targets and export condition drift. A source-resolution architecture test
hides `dist` through its resolver host; an isolated two-package canary compiles and runs emitted
JavaScript (`tooling/lib/module-resolution-policy.ts`, `moduleResolutionPolicyErrors`;
`tooling/tests/architecture/module-resolution-contract.test.ts`;
`tooling/tests/integration/module-resolution.test.ts`).

Private source imports have separate package-owned `imports` mappings: Code declares direct
`#src/*` to `./src/*`, while emitting libraries use `#src/*.ts` with ordered `bun` source,
`types` declaration and `default` JavaScript targets. Development selects source without a
prior build. Library build profiles clear `bun`, and TypeScript remaps their local output
targets through `rootDir`/`outDir`; emitted aliases remain spelled with `.ts`. The integration
fixture checks emitted declarations without provider sources and exercises the JavaScript branch
with `bun` removed from the fixture's mapping (`tooling/lib/module-resolution-policy.ts`,
`privateImportTarget`; `tooling/tests/integration/module-resolution.test.ts`).

Portable source packaging copies each Clarvis package's complete `package.json` and `src` tree
into the source checkout and copies the external runtime packages into `node_modules`. Their
private mappings therefore travel with the source that Bun selects. The distributed bundle keeps
Tools and Sandbox external; it does not promise a standalone output-only package tree.
Production: `packages/code/tooling/release/package.ts` (`copySource`) and
`packages/code/tooling/artifact/build.ts` (`main`, external package list).
Test: `tooling/tests/architecture/module-resolution-contract.test.ts` (all package aliases
with output hidden), `packages/code/tests/architecture/artifact-contract.test.ts` (external
runtime package boundary), and the `release:smoke` command in `packages/code/package.json`
(portable source and artifact boot).

Project references mirror the runtime dependency edges. `packages/kernel/tsconfig.build.json`
lists its referenced packages; `packages/loop/tsconfig.build.json` lists nine (including the three optional
packages `tools`, `hooks`, `skills`); leaves list one or two.

`@clarvis/code` retains its separate `ESNext`/bundler typecheck and resolves Kernel and Protocol
through public exports (`packages/code/tsconfig.json`,
`packages/code/tests/architecture/dependency-boundary.test.ts`). Root tooling's editor config
inherits source resolution; its CLI typecheck selects declarations through
`tooling/tsconfig.check.json` so its existing less strict options do not recheck package
implementations under a different strictness profile (`package.json`, `scripts.typecheck:tooling`).

### 4.3 The pre-commit gate

`.githooks/pre-commit` resolves the repository root with `git rev-parse --show-toplevel`, `cd`s
there, and `exec bun run check:pre-commit`. That script is a strictly sequential `&&` chain
(`package.json`, `scripts.check:pre-commit`):

```
format:check → build → typecheck → lint:eslint → lint:intent → knip → test:coverage
```

`build` sits immediately before `typecheck`: package source typechecks can resolve without `dist`,
while the tooling CLI profile and build qualification consume declarations (§4.2). The hook is installed by
`bun run hooks:install`, which is just `git config core.hooksPath .githooks`
(`package.json`, `scripts.hooks:install`) — a clone that has never run it has no gate at all.

### 4.4 CI jobs

Linux gates use separate runners and depend only on a completed shared build:

| Job ID | Dependencies | Gate |
| --- | --- | --- |
| `build` | none | frozen install, full build, artifact smoke, tar packaging and upload |
| `typecheck` | build | restore, full workspace and tooling typecheck, including tests |
| `lint` | build | restore, `lint:eslint` |
| `knip` | build | restore, `knip` |
| `checks` | build | restore, separate `format:check`, `lint:intent`, `test:cache` steps |
| `coverage` | build | restore, install Bubblewrap for native sandbox canaries, sequential coverage supervisor |
| `linux` | all six gates above | fail-closed required-result aggregation |

Every host Bun job installs the exact mise version, records `bun --version && bun --revision`,
and installs its own dependencies with `bun install --frozen-lockfile`. Installation is not a build.
Only `build` emits the shared Linux build, including the Code bundle; upload follows both build and
smoke success. Its consumers restore that build before checking it and never silently rebuild.
Finite timeouts remain conservative: 15 minutes
for build and ordinary Linux gates, 30 for coverage, 5 for aggregation, and 10 for each macOS job. No required job or step uses `continue-on-error`.


The public required contexts remain exactly `linux` and `keyboard policy (macos)`.
The release workflow consumes these literal names. `linux` has `always()` and all six Linux
needs; it installs nothing and downloads nothing. Its Bash step receives `toJSON(needs)` through
an environment variable, then jq requires exactly one JSON object, the exact dependency key set,
and `result == "success"` for every entry. Failure, cancellation, skip, missing/unknown results,
malformed input, and an empty object cannot approve the required status. The job condition only
admits the aggregator; the explicit result check decides success.

Production: [CI workflow](../../.github/workflows/ci.yml), `jobs`;
[workflow validator](../../tooling/lib/ci-workflow.ts), `ciWorkflowFailures`;
[Bun version checker](../../tooling/checks/bun-version.ts), `bunVersionFailures`.
Test: [CI workflow tests](../../tooling/tests/architecture/ci-workflow.test.ts), including mutations that
remove each gate/dependency and fixtures executing the actual YAML Bash body;
[Bun version tests](../../tooling/tests/unit/bun-version.test.ts), per-job setup/evidence validation.
The validator reuses `workflowSecurityFailures`; other workflows retain their existing policies.

**`sandbox-macos-intel`** uses `macos-15-intel` to build the library packages
and run both native sandbox suites on x64. **`keyboard-macos`** uses ARM64
`macos-15`, repeats the native suites, runs the complete `@clarvis/tools` suite
and keyboard policy tests. Its stable `keyboard policy (macos)` status runs
with `always()` and explicitly requires the Intel job's success before it can
pass, so both architectures gate the existing permanent-branch context.
Production: `.github/workflows/ci.yml` (`jobs.sandbox-macos-intel` and
`jobs.keyboard-macos`). Test: `ciWorkflowFailures` in
`tooling/lib/ci-workflow.ts` and `tooling/tests/architecture/ci-workflow.test.ts`.

All host Bun jobs record `bun --version` and `bun --revision` immediately after setup, so a run
remains attributable to the executable it actually used. CI runs on pushes to `main` and `develop`
and on pull requests.

### 4.5 Shared build identity and coverage supervision

Generated sandbox assets and the source-worker manifest are ignored by Git. The Linux coverage job
generates these platform-local assets after restoring the shared TypeScript build; it installs
Bubblewrap and a C compiler first. Ubuntu's AppArmor restriction on unprivileged user namespaces
must be disabled on the disposable CI runner before executing the native canaries; Bubblewrap still
creates the sandbox namespaces and applies Clarvis's seccomp filter. This does not rebuild the shared
declarations or Code bundle.
Production: `.github/workflows/ci.yml` (`jobs.coverage`), `.gitignore`, and each owning package's
`build:assets` script. Test: `ciWorkflowFailures` in `tooling/lib/ci-workflow.ts` and the missing
coverage-prerequisite regression in `tooling/tests/architecture/ci-workflow.test.ts`.

The build tar contains exclusively workspace `dist` directories, their internal incremental files,
and `ci-build-manifest.json`. The manifest records schema, actual `git rev-parse HEAD`, run ID,
producer attempt, Bun version/revision, OS/architecture, lockfile SHA-256, exact build directories,
and every member's path, kind, permissions, size and checksum. Node modules, configuration,
credentials and user state are not transported. Regular files and directories are the supported
build format; links and special members are rejected even when apparently internal.

The producer exports the immutable Actions artifact ID/digest, tar digest and producer attempt.
Consumers download only that ID within the current run, with digest mismatches configured as errors.
The Actions digest verifies the transported artifact; the separately bound tar digest and member
checksums verify the bytes restored. Missing producer outputs fail before download and explicitly
require a full workflow rerun, without cache or artifact-name fallback.

A failed-job rerun may reuse a successful producer from an earlier attempt of the same run. The
manifest is compared with the producer's output attempt, not the current consumer attempt; both are
logged. Commit, run, Bun, lockfile and platform identity must still match. The CLI reads the actual
checkout identity in each consumer rather than trusting an event SHA.

Before any destination mutation, restoration verifies the tar digest, strict USTAR headers, exact
inventory and every checksum. It rejects absolute/traversing/out-of-scope paths, duplicate members,
missing members, links, devices and unsupported tar extensions. Files are written into fresh staging
and then replace only verified workspace build directories. Existing symlinked parents or build
destinations are refused. This assumes a CI-owned checkout without a concurrent hostile writer;
it does not claim to close the repository's documented filesystem TOCTOU boundary.

Production: [artifact library](../../tooling/lib/ci-artifacts.ts), `packCiBuild`,
`validateCiBuild`, `restoreCiBuild`, `readBuildIdentity`, and `requireBuildProducer`;
[workspace inventory](../../tooling/lib/ci-workspaces.ts), `readCiWorkspaces`;
[artifact CLI](../../tooling/checks/ci-artifacts.ts).
Test: [artifact tests](../../tooling/tests/integration/ci-artifacts.test.ts), round trip, modes/dotfiles,
identity/integrity failures, invalid members/destinations and earlier-producer reruns.

Artifact logs and step summaries record size, packaging, upload, download and restoration time.
Transfer timers include inter-step overhead; Actions step durations identify checkout, Bun setup,
and installation costs, with frozen installs additionally timed. The proposed Linux median of
4–5 minutes is a measurement hypothesis, not a guaranteed budget or a local-test result. Evaluate
complete remote runs, including preparation/transfer and runner scheduling, and retain their run
identities and attempt-specific results when comparing the critical path. Coverage remains
sequential across packages; no coverage sharding is required by this topology.

`tooling/ci/retry-code-coverage.sh` is a thin exec entry for the importable CI coverage supervisor.
It runs each package's complete script once in manifest order, with at most three additional
attempts only for Code exits 132/134/139. A recovered Code attempt continues the remaining packages;
the global checker runs only after all finish. Assertions, other-package crashes and 130/143 are
never retried. Nullable Bun signal exits are normalized explicitly. Cancellation settles the active
child and prevents further packages/retries. The detailed process and LCOV contract belongs to
[test architecture](test-architecture.md#48-the-ci-coverage-supervisor).
The local root coverage script and pre-commit phase order remain unchanged and have no CI retry.

The independent GitHub-runner canary requires at least 30 Code coverage iterations without
132/134/139; its diagnostic evidence and criterion remain in [Known issues](../known-issues.md).
The canary's wider signal accounting and real-test-failure abort remain unchanged.

### 4.6 `code` build → smoke → launch

`packages/code/tooling/artifact/build.ts` (`main`) runs, in order:

1. `rm -rf dist`, `mkdir dist`.
2. `Bun.build(...)`; on `!result.success`, print every log to stderr and throw
   `"bun build failed"`.
3. `assertLazyProviderChunk(result.outputs)` — finds the entry point, throws
   `"build emitted no entry point"` if absent, collects `kind === "chunk"` `.js` outputs, and
   delegates to `assertLazyProviderArtifact`.
4. For the ordinary build, `detachSourceMaps(result.outputs)` renames every `.map` output into
   `dist/maps/`, then `assertDetachedSourceMaps` requires no adjacent map and an entrypoint map. For
   `--install`, Bun emits no maps and `assertInstallArtifact` rejects any `.map` output.
5. `copyAssets()` — `stat`s each `from`; a missing one throws a message naming the asset, its
   reader, and the instruction "if it moved, update both that reader's candidate list and ASSETS here".
6. Prints one summary line: entry size in MB, lazy chunk count, either detached-map count or
   `no source maps`, total outputs and elapsed ms.

Step 4 must follow step 3: `assertLazyProviderChunk` reads the entry from `entry.path`, and
`detachSourceMaps` renames files out from under `outdir`. Step 5 must follow step 1, which deletes
`dist`.

`packages/code/tooling/artifact/smoke.ts` then:

1. Refuses with a build instruction if `dist/index.js` is absent.
2. Re-runs **both** artifact assertions against the on-disk directory rather than the build's
   in-memory output.
3. Checks each `REQUIRED_ASSETS` path exists, "so a missing one is reported as itself rather than as
   an opaque startup failure".
4. Creates an exclusive `SmokeContext` via `createSmokeFixture()`. Its root is a short, account-owned
   allocation under one of the host's short temporary roots — never the inherited `TMPDIR` — holding
   HOME, `CLARVIS_HOME`, workspace, cache, logs and managed-install paths, while the socket directory
   is reserved separately by the same allocator. It then refuses with
   `"fixture is not a fresh install: it has a models cache"` if the fixture's explicit cache path
   exists.
5. Boots the artifact under a PTY with `--debug`, waiting for the marker `"New task…"` up to
   `SMOKE_TIMEOUT_MS`. `READY_MARKER`'s own doc comment states why that specific
   string: it is "Substring proving the normal Unicode input is mounted...rather than the `--ascii`
   fallback".
6. On a non-`ready` outcome, dumps the last 4000 chars of the stripped screen and 2000 of stderr,
   cleans up, and `exit 1`.
7. Reads `app.boot.shell-painted`, `app.boot.painted`, `markdown.preload.completed` and
   `catalog.load.started` out of the run's `code-debug-*.jsonl`
   files under the throwaway home, and fails if the first is absent
   (`"--debug is the only diagnostic channel a bundled clarvis has"`) or if
   `markdown`/`markdownInline` are not both `true`, if the minimal-shell record is absent, or if the
   catalog started before the usable frame. The file's own TSDoc gives the reason
   for checking both the screen marker and this JSONL record rather than either alone: "The screen
   marker alone proves a frame was drawn; the record proves the diagnostic channel...survived bundling
   too, and it carries the boot's elapsed time, which the screen does not".
8. Reports the outer PTY/polling/diagnostic duration as artifact settlement, not as first paint, and
   labels the two process-relative diagnostic timings as startup-shell paint and complete-app paint.
   The outer duration includes the 100 ms poll cadence plus Markdown diagnostic settlement and is not
   a performance benchmark (`packages/code/tooling/artifact/smoke.ts`, `main`).

`createSmokeFixture` (`packages/code/tooling/artifact/isolation.ts`) writes only a `settings.json`
with one `openai-compatible` provider pointing at `https://example.invalid/v1` and an api-key env of
`SMOKE_API_KEY`, mode `0o600`, and **no agent files** — states that this is deliberate: "the fleet
ships as data inside the bundle, so a home with an empty `agents/` directory is what a first run
really looks like." The retained `makeCleanHome` name is a private compatibility alias, not the
fixture contract.

The fixture's parent is chosen, not inherited: `shortTemporaryRootCandidates` proposes the host's
short temporary roots, each is validated exactly as before (a real directory that does not overlap
operator state), and `ancestorTrust` additionally requires the account-owned chain the kernel will
re-check for the private state published under `CLARVIS_HOME`. A host offering no acceptable candidate
fails `smoke_fixture_no_usable_parent` naming every refusal, instead of landing somewhere the boot then
rejects or reporting it as a timeout. One validated list serves both roots: the fixture's own parent is
chosen from it, and the socket root falls back to it followed by the host's short temporary roots, so a
pinned deep parent cannot make the fixture's address unreservable. `SmokeContextOptions.parentRoot`,
`parentCandidates` and `socketParentCandidates` pin or replace those lists for a nested harness or a
test; a host where no socket parent can hold an address short enough for a socket name fails
`smoke_socket_root_unavailable` naming every refusal. Production:
`createSmokeContext`, `validateParents`, `allocateFixtureRoot` and `allocateSocketRoot` in
`packages/code/tooling/artifact/isolation.ts`. Tests: `packages/code/tests/integration/artifact-isolation.test.ts`.

The PTY is obtained by `script(1)` where available, with a platform-split argv — `script -q /dev/null …`
on darwin, `script -qec '<quoted argv>' /dev/null` elsewhere
(`packages/code/tooling/artifact/pty.ts`) — and falls back to a tmux server only in ordinary
environment-isolated mode. `SmokeContext.socketPath(label)` reserves an exclusive address and
validates its UTF-8 length against `UNIX_SOCKET_PATH_BUDGET_BYTES` before any process is started, so
a too-deep root is reported as itself rather than as a failing backend; tmux receives that address
through `-S` and every capture and `kill-server` command names the same endpoint. The socket directory
stays inside the fixture root while the endpoint budget allows it and otherwise becomes a short
root of its own. Cleanup removes it after the children settle. Every PTY child receives
`environmentFor(...)`. When neither `script(1)` nor tmux is available, the harness reports
`"observing a boot requires either script(1) or tmux to provide a PTY"`.

The cross-runner contract canary is `tooling/tests/integration/harness-isolation-contract.test.ts`; it
keeps artifact, release and installer runners on fixture-owned roots and explicit child
environments. `packages/code/tests/architecture/artifact-contract.test.ts` covers the release
packager's allowlisted locale environment, while the direct Linux installer journey is exercised
by `bun run release:install-smoke`. The PTY and archive journeys remain separate evidence layers:
an archive/installer pass does not claim a complete-app PTY pass when the host rejects the fixture's
private-state parent.

The production launcher is the source entry `packages/code/src/cli.ts`. It handles
`--remote-kernel` through a private dynamic import, and answers `--help`, `--version` and update
before loading the interactive application. The ordinary path resolves its product root through
`productRootForEntry` in `packages/code/src/cli-entry.ts`, then dynamically imports
`@opentui/solid/preload` followed by `./index.tsx`. The built Code bundle is qualified separately
by artifact smoke.

### 4.7 The package-graph analyzer

`analyzePackageGraph(root)` (`tooling/lib/package-graph.ts`) reads the root manifest's
`workspaces`, then for each package walks `src`, `tests` and `tooling`
(`SOURCE_TREES`) over six source extensions and parses every module edge through the
TypeScript AST (`parseModuleEdges`), classifying static/dynamic and type-only/value
(import declarations, export-from, `import =`, dynamic `import()`, `require()`, and `import type`
nodes).

It then raises errors for: an unknown `@clarvis/*` package, `src` importing its own public
entrypoint by name or by relative path resolving to the root entry, an
undeclared internal dependency, a `src` **value** import of a package declared only under
`devDependencies`, a subpath the target's `exports` does not publish, a relative import that crosses into another package's directory, a declared
dependency naming an unknown workspace package, a declared internal dependency nothing
imports, a runtime dependency with no matching
`tsconfig.build.json` project reference and vice versa, a root-solution reference that
does not correspond to a `tsconfig.build.json` and vice versa, a declared-graph cycle, a compilation cycle that is not already a declared cycle, and a runtime
module cycle **inside** one package's `src`.

Its export-condition handling distinguishes runtime from type resolution:
`RUNTIME_EXPORT_CONDITIONS = {bun, import, require, default}` and `TYPE_EXPORT_CONDITIONS` adds
`types`, so a subpath exposing only `types` satisfies a type-only import and fails a
value import. Wildcard subpaths are matched by prefix/suffix.

`--check-doc` additionally validates the complete generated Markdown block in
`specs/package-coupling-analysis.md` against the computed report
(`tooling/checks/package-graph.ts`, `tooling/lib/package-graph.ts`); any mismatch is an
error and `process.exitCode = 1` (`tooling/checks/package-graph.ts`).

`tooling/tests/architecture/stream-metrics-drift.test.ts` is executed by
`test:tooling` and contains two Bun tests. It token-scans `packages/llm/src/stream-metrics.ts` and
`packages/code/src/adapters/stream-metrics.ts` through the TypeScript scanner, normalizing only the
one authorized difference — the `source = "loop" | "code"` default. One ordinary Bun test uses
`expect` to pin both the allowed default difference and rejection of an unrelated token difference;
the other reads the production files and expects the normalized streams to match. Drift is therefore
reported through Bun's normal assertion failure, with no custom stderr or `process.exitCode` path
(`tooling/tests/architecture/stream-metrics-drift.test.ts`, tests "the normalizer permits only the
owner-specific default" and "the two production stream metrics implementations stay
token-identical").

### 4.8 Public documentation ownership boundary

The public product site is owned by the separate `getclarvis/docs` repository. This monorepo has no
`docs/` site tree, VitePress dependency, `docs:*` scripts, Pages permission, or Pages deployment
workflow. Root contributor documentation points public-site changes to that repository, while
package READMEs and `specs/` remain local because they are part of the implementation contract.

Production: root `README.md` and `AGENTS.md` (external site ownership); root `package.json`
(`scripts`, `devDependencies`); `.github/workflows/` (workflow set).
Test: `tooling/tests/architecture/repository-metadata.test.ts` (`keeps public-site ownership outside
this monorepo`).

## 5. Invariants

Numbered `BUILD-n`. Each carries the rule, the production site, and the test that pins it.

**BUILD-3 (INV-258).** The `code` artifact loads the chunk containing `AiSdkAdapter` only through a
generated dynamic import; an artifact with zero JS chunks, the adapter class in the entry, no
dynamic edge, or any static edge to the provider chunk is rejected with a message naming the
condition. This remains valid when Bun moves the source dynamic import into an eagerly shared kernel
chunk instead of spelling it directly in `index.js`, and when Bun reports the chunk path with POSIX separators.
Production: `packages/code/tooling/artifact/contract.ts` (`assertLazyProviderArtifact`). Enforced in
the build by `packages/code/tooling/artifact/build.ts` (`assertLazyProviderChunk`) and again on disk
by `packages/code/tooling/artifact/smoke.ts`.
Test: `packages/code/tests/architecture/artifact-contract.test.ts` (lazy provider artifact).

**BUILD-4 (INV-259).** The ordinary developer/root artifact keeps its source maps **detached** under
`dist/maps/`, and must still contain `index.js.map` there; a `.map` beside runtime JS, or a missing
entrypoint map, is rejected.
Production: `packages/code/tooling/artifact/contract.ts` (messages: "source maps must not
sit beside runtime JavaScript; Bun loads them eagerly" "artifact must retain its entrypoint
source map under dist/maps"); implemented by `detachSourceMaps`
(`packages/code/tooling/artifact/build.ts`).
Test: `packages/code/tests/architecture/artifact-contract.test.ts`.

**BUILD-5.** `Bun.build` for `code` keeps `@opentui/core`, `@opentui/core-*`,
`@clarvis/tools`, `@clarvis/sandbox` and `pino` external.
Production: `packages/code/tooling/artifact/build.ts`. Stated reason : "Its parser worker and
grammars are resolved relative to its own entry point; bundling core rewrites that import.meta.url
and disconnects those assets from their owner." Unpinned — no test asserts the `external` list.

**BUILD-6.** Every asset the artifact reads by path is declared once in `ASSETS` alongside the module
that reads it, and a missing one aborts the build naming both.
Production: `packages/code/tooling/artifact/build.ts` (`ASSETS`, `copyAssets`). Mirrored by
`REQUIRED_ASSETS` in the smoke (`packages/code/tooling/artifact/smoke.ts`) and by the model catalog's
reader-side candidate list (`packages/kernel/src/models/model-catalog.ts`, `bundlePath`). Workflow
built-ins do not participate because they are ordinary TypeScript values in the bundle.
Unpinned by a unit test; the enforcement is the build failing and the smoke failing.

**BUILD-7.** `@clarvis/code` is outside the `tsc -b` reference graph, while remaining part of the
composed root build through its separate bundle phase.
Production: `tsconfig.json` references the emitting packages, but not `packages/code`; `packages/code`
has no `tsconfig.build.json`.
Pinned indirectly: `tooling/lib/package-graph.ts` requires the root solution's references to
be exactly the set of packages that have a `tsconfig.build.json`, so adding one for `code` without a
root reference (or vice versa) is an error. That rule is unit-tested at
`tooling/tests/architecture/package-graph.test.ts`.

**BUILD-8 (INV-309 d).** A package's `dependencies` + `optionalDependencies` on other workspaces must equal its
`tsconfig.build.json` `references` set, in both directions.
Production: `tooling/lib/package-graph.ts` (errors `"dependency without project reference X"`
and `"project reference without runtime dependency X"`).
Test: `tooling/tests/architecture/package-graph.test.ts`.

**BUILD-9 (INV-309 f).** A `src` file may not import a subpath the target package's `exports` map does not
publish, and a type-only import may additionally use a `types`-only condition where a value import may
not.
Production: `tooling/lib/package-graph.ts`.
Test: `tooling/tests/architecture/package-graph.test.ts` (unexported and accepted deep subpaths) (wildcards and type-only conditions).

**BUILD-10 (INV-309 a).** A `src` file may not import its own package's public entrypoint — by package name or by
a relative path that resolves to it.
Production: `tooling/lib/package-graph.ts`.
Test: `tooling/tests/architecture/package-graph.test.ts`.

**BUILD-11 (INV-309 b).** A `src` **value** import of an internal package declared only under `devDependencies` is
an error; the same import from `tests/` or package `tooling/` is allowed.
Production: `tooling/lib/package-graph.ts` (`sourceTree === "src" && !edge.typeOnly`).
Test: `tooling/tests/architecture/package-graph.test.ts`.

**BUILD-12 (INV-309 g).** No relative import may cross a package root.
Production: `tooling/lib/package-graph.ts`.
Test: `tooling/tests/architecture/package-graph.test.ts`.

**BUILD-13 (INV-309 e).** The declared workspace graph and the compilation graph are both acyclic, and no
package's `src` contains a value-import module cycle.
Production: `tooling/lib/package-graph.ts`.
Test: `tooling/tests/architecture/package-graph.test.ts` (package cycles) (module cycles, with
the type-only back edge shown not to count).

**BUILD-14 (INV-310, timeout half).** Every `bun test` invocation reachable from a workspace's
`test` script carries `--timeout 60000` on the command line rather than in a `bunfig.toml`;
`@clarvis/protocol` is explicitly type-only and reaches no `bun test` invocation.
Production: every package manifest, e.g. `packages/capability/package.json`,
`packages/code/package.json`.
Rationale recorded at `bunfig.toml`.
Test: `tooling/checks/test-harness.ts` applies `checkPackageHarness` to every workspace manifest, and
`tooling/tests/unit/test-harness.test.ts` pins delegated-script discovery and the missing-timeout
failure.

**BUILD-15 (INV-310, preload half).** Every `bunfig.toml` that can be the nearest one to a test run declares
`preload = [".../clarvis-home-preload.ts"]`, which redirects the Clarvis global root to a throwaway
directory for the process. The rule exists because "Bun resolves `bunfig.toml` from the *cwd*, and
does not merge a package's with this one" (`bunfig.toml`) — a `bun test packages/<name>/tests/<case>.test.ts`
run from the repository root reads only the root file and never sees the per-package `preload`. The
measured failure this caused: "102 stray `~/.clarvis/state/workspaces/_tmp_clarvis-plan-*` directories
got written into a real `$HOME` during one afternoon of stress-running a suite by path. Measured: a
root-cwd run of one plan test file leaked 17 directories, the same file via
`bun --filter @clarvis/plan test` leaked none" (`bunfig.toml`).
Production: `bunfig.toml`; every non-type-only package bunfig, with
`packages/code/bunfig.toml` carrying it among the TUI-specific preloads. The preload itself is
`tooling/test-runtime/clarvis-home-preload.ts`, which leaves an already-set value alone and registers an
`exit` handler to remove the temp root.
Test: `tooling/checks/test-harness.ts` checks the root bunfig and every package bunfig;
`tooling/tests/unit/test-harness.test.ts` pins parsing, missing-preload failure, and the
type-only exception.

**BUILD-16.** `code` reaches `@clarvis/kernel` only through its eight published entrypoints and imports
no lower implementation package, in `src/` **and** `tests/`.
Production: `packages/code/package.json` declares exactly `@clarvis/kernel` and
`@clarvis/protocol`.
Test: `packages/code/tests/architecture/dependency-boundary.test.ts` (entrypoints and role-valid
packages) (manifest dependency set).

**BUILD-17.** `src/cli.ts`'s static import closure is exactly
`{src/cli.ts, src/cli-args.ts, src/cli-entry.ts, ../../package.json}`, and both
`@opentui/solid/preload` and `./index.tsx` are reached only through a dynamic `import()`.
Production: `packages/code/src/cli.ts` (fast-path imports and dynamic application imports);
`packages/code/src/cli-args.ts` (root product-manifest import).
Test: `packages/code/tests/architecture/cli-fast-path.test.ts` (`cli fast path`, static closure,
dynamic application loading, and root-manifest-only cases).

**BUILD-18 (INV-312).** The production launcher loads the TypeScript application and remote-host
entries directly. A missing development bundle cannot change its selected runtime.
Production: `packages/code/src/cli.ts`.
Test: `packages/code/tests/architecture/cli-fast-path.test.ts`.

**BUILD-20.** The CI retry accepts only Code exits 132/134/139, with three additional attempts, and
never retries 130/143 or another package. Production: `tooling/lib/ci-coverage.ts`, `runCiCoverage`
and `normalizeCoverageExit`; `tooling/ci/retry-code-coverage.sh` is only the CLI entry.
Test: `tooling/tests/integration/ci-coverage.test.ts`, classified retry, continuation, cancellation and the
pinned Bun subprocess signal boundary.

**BUILD-21.** Line endings are normalized to LF for every text file at checkout, and `bun.lock` is
kept verbatim.
Production: `.gitattributes`. Unpinned by a test; the byte-exact fixtures it protects are
named in the file's own comment.

**BUILD-22.** Shell commands run under `sh`, with the approved command passed unchanged.
Production: `resolveShell` and `shellArgs` in `packages/tools/src/shell.ts`.
Test: `packages/tools/tests/unit/shell.test.ts`.

**BUILD-23.** Owned processes use a POSIX process group so termination reaches descendants.
Production: `packages/tools/src/lib/process.ts` and `packages/tools/src/lib/process-owner.ts`.
Test: `packages/tools/tests/integration/common/execution-session.test.ts`.

**BUILD-25.** Session capture is exercised through the `shell` and `shell_session` tests.
Production: `packages/tools/src/lib/execution-session.ts`.
Test: `packages/tools/tests/integration/common/shell-session.test.ts` and
`packages/tools/tests/integration/common/execution-session.test.ts`.

**BUILD-26 (INV-313).** Every executable and declaration surface derives from the one exact Bun
version in `mise.toml`: every host Bun CI job, the release package matrix, the release publication gate,
the crash-canary default and its evidence, workspace
`engines.bun` fields, root `@types/bun`, and the declared plus resolved lockfile entry.
Production: `bunVersionFailures` in `tooling/checks/bun-version.ts` validates the snapshot, and `package.json`
(`scripts.lint:intent`) runs `check:bun-version` inside `lint:intent`.
Test: the cases in `tooling/tests/unit/bun-version.test.ts` cover a valid snapshot and
independent drift in the canonical pin, CI, canary, engines, types, and
lockfile.

**BUILD-27.** The tracked Clarvis repository contains no Python source (`.py`, `.pyi`, or `.pyw`);
test executables and maintenance automation use the pinned Bun runtime.
Production: `tooling/checks/bun-sources.ts`, invoked by `check:bun-sources` inside `lint:intent`.
Test: `tooling/tests/unit/bun-sources.test.ts` pins the accepted and rejected extensions.

**BUILD-28.** Every tracked literal relative module specifier has an extension. A specifier that
targets a TypeScript source names its actual `.ts`, `.tsx`, `.mts` or `.cts` extension. Runtime
extensions remain valid for real JavaScript files; emitting packages rewrite source extensions back
to their JavaScript equivalents in emitted JavaScript, while declaration specifiers remain
source-oriented and resolve
to sibling `.d.ts` files.
Production: `tsconfig.base.json` and the standalone emitting profiles in
`packages/{kernel,protocol}/tsconfig.json` enable `rewriteRelativeImportExtensions`;
`packages/code/tsconfig.json` enables `allowImportingTsExtensions`;
`tooling/checks/import-extensions.ts` (`invalidRelativeImportExtensions`) implements the check;
`check:imports` is part of `lint:intent` in `package.json`.
Test: `tooling/tests/unit/import-extensions.test.ts` (`moduleSpecifiers`,
`invalidRelativeImportExtensions`) pins supported literal syntax, extensionless imports,
ambiguous suggestions, real-JavaScript exceptions and source-file selection.

**BUILD-29.** Literal imports of a package's own source use a private
specifier when a source module climbs two or more parent directories, or a package test/tooling
module imports that source. The resolved source target determines eligibility even if the package
has not declared a mapping yet.
Production: `tooling/checks/import-extensions.ts` (`invalidPrivateImportConvention`).
Test: `tooling/tests/unit/import-extensions.test.ts` (`invalidPrivateImportConvention`).

**BUILD-30.** `bun run setup` requires the exact Bun version pinned in `mise.toml`, performs a frozen
root install, and builds the linked installation with `sourcemap: "none"`; no `.map` may exist in
that artifact and no generated JavaScript may embed a `sourceMappingURL=data:` payload. The ordinary
`build` remains diagnostic and retains detached maps. Setup does not
download Bun or modify shell profiles.
Production: `packages/code/package.json` (`scripts.build`, `scripts.build:install`, `scripts.setup`),
`packages/code/tooling/setup.ts` (build phase), and `packages/code/tooling/artifact/build.ts`
(`installBuild`, `main`).
Test: `packages/code/tests/architecture/artifact-contract.test.ts` (external and inline installed
artifact cases) and
`packages/code/tests/architecture/cli-fast-path.test.ts` (manifest install-build, pinned-version,
frozen-lockfile, owned-link and no-host-mutation cases).

**BUILD-31.** The terminal application publishes one executable name, `clarvis`, targeting
`src/cli.ts`.
Production: `packages/code/package.json` (`bin`), `packages/code/tooling/setup.ts` (owned-link
check and unlink/link phase), `packages/code/src/cli-args.ts` (`usageText`, `helpText`, `versionText`) and
`packages/code/src/cli-entry.ts` (`productRootForEntry`).
Test: `packages/code/tests/architecture/cli-fast-path.test.ts` (manifest bin case) and
`packages/code/tests/integration/cli-args.test.ts` (`versionText`).

**BUILD-32.** Clarvis uses a single product version: root `package.json` owns one exact SemVer;
every workspace manifest is private and omits `version`, as does every workspace entry in
`bun.lock`. The only runtime imports of the root
manifest are Code's CLI presentation, Loop's public `VERSION`, and MCP Client's initialization identity.

Production: root `package.json` (`version`); `tooling/lib/package-architecture.ts`
(`PRODUCT_VERSION_IMPORTERS`, `productVersionPolicyErrors`, `productLockfileVersionErrors`,
`productManifestImportViolation`); `tooling/lib/package-graph.ts` (`analyzePackageGraph`);
`packages/{code,loop,mcp-client}/src` version consumers.
Test: `tooling/tests/architecture/package-architecture.test.ts` (product-version policy and importer cases),
`packages/code/tests/integration/cli-args.test.ts`, `packages/loop/tests/integration/version.test.ts`,
and `packages/mcp-client/tests/integration/version.test.ts`.

**BUILD-33.** The POSIX checkout bootstrap `dev-install.sh` delegates to typed Code tooling and
installs `clarvis-develop`, never a second product `bin`. It requires the exact pinned Bun, performs
the frozen root install, configures `.githooks`, writes only a marked regular launcher, and verifies
its application-free version path. The launcher preserves the caller's working directory and forces
the current TypeScript sources, so source edits need neither a Code build nor a release. Its
development-only cleanup is explicit, resolves the app's effective global root, and refuses the
user home, external roots, symlinks, and non-directories before recursive removal. Its empty-workspace
mode creates a unique directory below `/tmp/clarvis-development-temp`; cleanup authenticates that
complete root by type, current-user ownership, and exact marker before removal. Production: root
`package.json` (`scripts.dev:install`), `dev-install.sh`, and
`packages/code/tooling/development-install.ts` (`main`, `developmentLauncherSource`,
`cleanDevelopmentState`, `createEmptyDevelopmentWorkspace`, `clearDevelopmentTempWorkspaces`).
Test: `packages/code/tests/integration/development-install.test.ts` (argument, launcher, ownership,
cleanup, empty-workspace, and shell-delegation cases).

**BUILD-36.** The crash-retirement canary remains an explicitly dispatched, read-only workflow. It
grants only `contents: read`, pins checkout and setup-bun to complete commit SHAs, disables checkout
credential persistence, and has no scheduled or push trigger.
Production: `.github/workflows/segfault-canary.yml` (`on.workflow_dispatch`,
`permissions.contents`, and `jobs.canary.steps`).
Test: `tooling/tests/unit/bun-version.test.ts` pins the canary's Bun-version default and runtime
evidence. `workflowSecurityFailures` in `tooling/checks/release-readiness.ts`, exercised by
`tooling/tests/unit/release-readiness.test.ts`, scans every workflow and pins `contents: read`, full
action SHAs, and disabled checkout credential persistence. The `workflow_dispatch`-only trigger with
no schedule or push remains unpinned.

**BUILD-37.** Public-site source and GitHub Pages deployment stay outside this monorepo. The root
manifest carries no VitePress dependency or `docs:*` script, the workflow set carries no Pages
permission or action, and contributor-facing repository documentation names `getclarvis/docs` as
the owner. Production: root `package.json` (`scripts`, `devDependencies`), `.github/workflows/`,
`README.md`, and `AGENTS.md`. Test:
`tooling/tests/architecture/repository-metadata.test.ts` (`keeps public-site ownership outside this
monorepo`).

## 6. Failure modes and degradation

| Situation | Handling | Citation |
| --- | --- | --- |
| `Bun.build` reports `success: false` | every log written to stderr, then `throw new Error("bun build failed")` — no artifact is left half-written because `dist` was already removed | `packages/code/tooling/artifact/build.ts` |
| Build emits no entry point | `throw new Error("build emitted no entry point")` | `packages/code/tooling/artifact/build.ts` |
| Build flattened the lazy chunk | throws, naming which of the two conditions failed | `packages/code/tooling/artifact/contract.ts` |
| A source map sits beside runtime JS, or `index.js.map` is missing | throws with the specific message | `packages/code/tooling/artifact/contract.ts` |
| An install build emits a source map | throws `installed artifact must not contain source maps: <path>` | `packages/code/tooling/artifact/contract.ts` (`assertInstallArtifact`) |
| A build asset moved | throws naming the asset, its reader, and the two files to update | `packages/code/tooling/artifact/build.ts` |
| Smoke run with no artifact | `throw` with `"run: bun --filter @clarvis/code build"` | `packages/code/tooling/artifact/smoke.ts` |
| Smoke fixture already has a models cache | `throw new Error("fixture is not a fresh install: it has a models cache")` — refuses to run rather than measure the wrong branch | `packages/code/tooling/artifact/smoke.ts`; `createSmokeFixture` |
| Smoke fixture has no usable or short-enough parent | `throw new Error("smoke_fixture_no_usable_parent:<candidate>: <refusal>;…")`, or `smoke_socket_root_unavailable:…` when only the socket root cannot be reserved, naming every refusal | `packages/code/tooling/artifact/isolation.ts` (`validateParents`, `allocateFixtureRoot`, `allocateSocketRoot`) |
| Smoke boot times out or hits `"failed to start"` | prints stripped screen tail + stderr tail, terminates owned children, removes only its own fixture and socket roots, and exits 1 | `packages/code/tooling/artifact/smoke.ts`; `SmokeContext.cleanup` and `packages/code/tooling/artifact/pty.ts` |
| Smoke painted but wrote no `app.boot.painted` | `exit 1` with "`--debug` is the only diagnostic channel a bundled clarvis has" | `packages/code/tooling/artifact/smoke.ts` |
| Ordinary smoke has no `script(1)` and no `tmux` | `throw new Error("observing a boot requires either script(1) or tmux to provide a PTY")` | `packages/code/tooling/artifact/pty.ts` |
| Code dies by signal 132/134/139 during CI tests | up to 3 additional Code attempts, then remaining packages and the global checker | `tooling/lib/ci-coverage.ts`, `runCiCoverage` |
| Bun dies by 130 or 143 | passed straight through, never retried | `tooling/ci/retry-code-coverage.sh` |
| A package other than `code` dies by signal | return that failure immediately, without retry or global checking | `tooling/lib/ci-coverage.ts`, `runCiCoverage` |
| Shared build is absent, corrupt or has mismatched identity/inventory | fail before restoration; no fallback build or cache | `tooling/lib/ci-artifacts.ts` |
| Any Linux dependency fails, cancels, skips or is missing | required `linux` fails through explicit aggregation | `.github/workflows/ci.yml`, `jobs.linux` |
| Canary batch hits a real test failure | prints `"real test failure (exit N) -- batch invalid"`, tails 60 log lines, exits with that status | `.github/workflows/segfault-canary.yml` (`jobs.canary.steps[name=measure].run`) |
| A stale generated block in `specs/package-coupling-analysis.md` | `checkDocument` reports that the block is stale; `process.exitCode = 1` | `tooling/lib/package-graph.ts`, `tooling/checks/package-graph.ts` |
| Root version is invalid, a workspace or lock entry declares `version`, a workspace is not private, or an unapproved module imports the root manifest | `check:graph` reports the exact manifest, lock path, or source-policy violation | `tooling/lib/package-architecture.ts` (product-version policy helpers) |
| A Bun version surface drifts | `check:bun-version` reports every offending file and observed value, then sets exit 1 | `tooling/checks/bun-version.ts` |
| Model catalog file exceeds 8 MiB, or the user cache is corrupt | `readCatalogFile` throws `"model catalog exceeds byte limit"`; a bad cache is silently ignored and the bundled snapshot returned | `packages/kernel/src/models/model-catalog.ts` |
| Neither models-dev.json candidate exists | `bundlePath()` returns the source-tree path anyway "so the ensuing read reports the location a developer expects" | `packages/kernel/src/models/model-catalog.ts` |
| `code`'s temp-home cleanup races a live child | `rmSync` failure swallowed; comment: "a live child may still hold a handle; the OS reaps the temp dir" | `tooling/test-runtime/clarvis-home-preload.ts` |
| Documentation embeds a source line locator, names an explicit repository file that does not exist, or a tracked spec embeds a calendar date or source-size inventory | `check:specs` reports every unstable, missing, dated, or source-size reference and exits nonzero; illustrative paths use visible placeholders, chronology stays in `CHANGELOG.md`, and behavioral line limits remain legal | `tooling/checks/spec-hygiene.ts`; `extractLineQualifiedReferences`, `resolveRepositoryFileReference`, `extractCalendarDates`, and `extractSourceSizeReferences` in `tooling/lib/spec-hygiene.ts` |
| A Pages workflow, local `docs/` site, or VitePress dependency is reintroduced | the repository-metadata architecture test reports the duplicated ownership surface | `tooling/tests/architecture/repository-metadata.test.ts` (`keeps public-site ownership outside this monorepo`) |

Degradation that is **silent by design**: a clone that has never run `bun run hooks:install` has no
pre-commit gate at all, because `core.hooksPath` is a local git config value and nothing in the tree
sets it (`package.json`, `scripts.hooks:install`, is the only writer).

## 7. Coupling

**What this subsystem depends on.**

| Dependency | Direction forced by | Kind |
| --- | --- | --- |
| Bun ≥ 1.4.0 | `engines` in root/workspace manifests; exact `mise.toml`; `check:bun-version` in `lint:intent` | runtime |
| `typescript` ^6 | root devDependency; imported as a **library** by repository-tooling modules (`tooling/lib/source-policy.ts`, `tooling/lib/package-graph.ts`, `tooling/lib/module-resolution-policy.ts`, `tooling/checks/import-extensions.ts`, `tooling/tests/architecture/stream-metrics-drift.test.ts`) and package architecture tests (three under `packages/code/tests/architecture/`, two under `packages/loop/tests/architecture/`) | static value import |
| `@opentui/solid/bun-plugin` | `packages/code/tooling/artifact/build.ts` — the build cannot produce the artifact without it | static value import |
| `@clarvis/kernel/paths` | `packages/code/tooling/artifact/isolation.ts` uses shared path vocabulary through the host facade; `tooling/test-runtime/clarvis-home-preload.ts` reaches `@clarvis/paths` independently for its fixture | static value import |
| GNU tar | `tooling/lib/ci-artifacts.ts` creates strict USTAR; restoration uses validated bytes and filesystem APIs | external process |
| Bash and jq | `.github/workflows/ci.yml`, required Linux aggregation and its executable fixtures | external process |
| `script(1)` or `tmux` | `packages/code/tooling/artifact/pty.ts` | external process |

**What depends on this subsystem.**

- Every package's resolvability depends on its own `exports` map and on the root workspaces array;
  `tooling/lib/package-graph.ts` reads `rootManifest.workspaces` reads
  `pkg.manifest.exports`, so both are load-bearing configuration and not documentation.
- `packages/code/tooling/artifact/smoke.ts` depends on `@clarvis/kernel`'s model-catalog data file
  existing at its fixed bundled path; moving it breaks the smoke rather than a unit test.
- `packages/kernel/src/models/model-catalog.ts` names
  `packages/code/tooling/artifact/build.ts` in its own TSDoc as the module whose `ASSETS` list must stay in
  step — a documentation-level coupling with no mechanical check.

**Type-only vs runtime.** `@clarvis/protocol` is a `dependencies` entry of `kernel` and
`code` but has an emitting `tsconfig.build.json` (`packages/protocol/tsconfig.build.json`) purely so
`dist/*.d.ts` exists for declaration consumers and builds — its own package `test` script is a typecheck, not a test run
(`packages/protocol/package.json`).

**Static vs dynamic.** `packages/code/src/cli.ts` reaches the application only dynamically, which is what BUILD-17 pins; `packages/code/tooling/artifact/build.ts` relies on `Bun.build`'s
`splitting: true` turning `@clarvis/llm`'s own dynamic adapter import into a `chunk-*.js`,
which is what BUILD-3 pins.

**Delegated.** Coverage thresholds, the LCOV counter allowlist and the test taxonomy belong to
**test-architecture-and-gate** (`tooling/checks/coverage.ts` holds `NO_COUNTER_ALLOWLIST`, whose
`code` entry lists `src/cli.ts` among "executable entry points"). Shell resolution, process
groups, `killTree` and session capture belong to **tools-shell-and-sessions**.

### 7.1 Prompt-cache gates

Every pull request runs the credential-free `test:cache` SDK serialization and independent metric
evaluation gate, without credentials or provider calls. Live cache qualification is an
operator-run local command using the existing Clarvis subscription OAuth; no API key or GitHub
secret is required.
A reduced local C01/C02/C06 series retains bounded JSON evidence and does not establish full
artifact qualification. Full cache qualification and the installed PTY evidence follow
[prompt-cache](prompt-cache.md).

Production: [CI](../../.github/workflows/ci.yml),
[local live runner](../../tooling/cache/live.ts), and
[deterministic runner](../../tooling/cache/deterministic.ts).
Test: [metric evaluation](../../tooling/tests/unit/prompt-cache-evaluation.test.ts),
[HTTP capture](../../tooling/tests/unit/prompt-cache-recorder.test.ts), and
[loaded artifact observation](../../tooling/tests/integration/prompt-cache-artifact.test.ts).

## 8. Open questions

- The exact `external` and `splitting` choices in
  `packages/code/tooling/artifact/build.ts`, `.gitattributes` normalization, and the
  crash-canary workflow's least-privilege fields do not have individual contract tests.
  Build and CI execution exercise them, but source inspection alone does not establish a
  successful platform run.
- `packages/skills/package.json` alone declares the esbuild override and package metadata,
  while root `package.json` permits the esbuild install script. The reason for that
  package-specific override is not stated in the current manifests.
- The Bun retirement canary has no recorded run evidence. `tooling/ci/retry-code-coverage.sh`
  and `.github/workflows/segfault-canary.yml` point to `specs/known-issues.md` for the
  historical rate, repair and removal condition. Source configuration cannot satisfy the
  retirement gate.
