# Build graph, package surfaces, CI, the bundle artifact and platform support

> Implemented at `packages/...` and `tooling/...`. Every claim below is anchored to current source or
> test evidence, using a stable symbol or configuration key where available. Open questions are
> collected in the final section.

## 1. Purpose

This subsystem is everything that turns 17 workspace source directories into something runnable and keeps them
consistent while they change: one Bun workspace (`package.json`, `workspaces`) with a single root
lockfile (`bun.lock` is the only lockfile in the tree), a two-layer TypeScript configuration (a `tsc -b`
solution over per-package `composite` emit projects, `tsconfig.json`), one shared ESLint/Prettier
configuration applied through each package's shim (`eslint.config.base.js`), a Knip pass run
once from the root (`package.json`, `scripts.knip`), a locally-enforced pre-commit gate
(`.githooks/pre-commit`),
independent Linux CI gates plus the retained Windows/macOS jobs (`.github/workflows/ci.yml`), a six-target portable
release matrix delegated to [distribution and updates](distribution-and-updates.md), and a separate
bundling path for the one package that is never emitted by `tsc` — the terminal UI
(`packages/code/tooling/artifact/build.ts`). The root `build` command composes those two paths sequentially,
so its completion means every distributable exists rather than only the TypeScript libraries.

Two problems dominate the design as it stands in the code. The first is **cross-package resolution
with no build step in development**: every library package's `exports` map declares a `bun` condition
pointing at `src/*.ts` and `types`/`import` conditions pointing at `dist/*` (e.g.
`packages/capability/package.json`), so Bun runs from source while `tsc` resolves the emitted
declarations. The `tsconfig.build.json` files therefore carry `paths` mappings to `dist/*.d.ts`
(`packages/kernel/tsconfig.build.json`) while the sibling `tsconfig.json` files carry the same
names mapped to `src/*.ts` (`packages/kernel/tsconfig.json`). A machine-checked graph analyzer
(`tooling/checks/package-graph.ts`) exists to keep manifest dependencies, `exports` maps, project
references and the root solution file from drifting apart.

The executable Bun contract has the same single-owner shape. `mise.toml` carries the exact runtime,
and `tooling/checks/bun-version.ts` projects it across CI, release packaging, the crash canary, both
all manifests, `@types/bun`, the resolved lockfile entry and an attributable
version/revision line in every remote job. The checker is part of `lint:intent`, so a partial runtime
upgrade cannot reach the pre-commit test phase.

The second is that the distributable TUI is a **bundle with runtime-shaped invariants that no unit
test can observe**, because the unit suite imports `src/` by path
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
| `build:packages` | `tsc -b` | `package.json` (`scripts.build:packages`) |
| `build:watch` | `tsc -b --watch` | `package.json` (`scripts.build:watch`) |
| `clean` | `tsc -b --clean && bun --workspaces clean` | `package.json` (`scripts.clean`) |
| `test` | `test:tooling`, followed by 17 sequential `bun --filter @clarvis/<pkg> test` invocations, all `&&`-chained | `package.json` (`scripts.test`) |
| `test:coverage` | `bun --workspaces --sequential --if-present test:coverage && bun run coverage:check` | `package.json` (`scripts.test:coverage`) |
| `coverage:check` | `bun run tooling/checks/coverage.ts` | `package.json` (`scripts.coverage:check`) |
| `typecheck` | workspace typechecks followed by `typecheck:tooling` | `package.json` (`scripts.typecheck`) |
| `lint` | `lint:eslint && lint:intent && knip` | `package.json` (`scripts.lint`) |
| `lint:eslint` | workspace lint followed by `lint:tooling` | `package.json` (`scripts.lint:eslint`) |
| `lint:intent` | `test:tooling`, then source-policy, test determinism, graph, spec, harness, Bun-version, Bun-source, import-extension and release-readiness checks | `package.json` (`scripts.lint:intent`) |
| `check:test-determinism` | AST census in check mode; accepts `--report` and `--json` for migration and inspection | `package.json` (`scripts.check:test-determinism`) |
| `check:graph` | `bun run tooling/checks/package-graph.ts --check-doc` | `package.json` (`scripts.check:graph`) |
| `check:specs` | `bun run tooling/checks/spec-hygiene.ts` | `package.json` (`scripts.check:specs`) |
| `knip` | `knip` (root only; no package declares a `knip` script) | `package.json` (`scripts.knip`) |
| `format` / `format:check` | workspace formatting plus root tooling and repository workflows | `package.json` (`scripts.format*`) |
| `check:pre-commit` | `format:check && build && typecheck && lint:eslint && lint:intent && knip && test:coverage` | `package.json` (`scripts.check:pre-commit`) |
| `hooks:install` | `git config core.hooksPath .githooks` | `package.json` (`scripts.hooks:install`) |
| `build:<pkg>` × 16 | `bun --filter @clarvis/<pkg> build` | `package.json` (`scripts.build:<pkg>`) |
| `link` | `bun --filter @clarvis/code link` | `package.json` (`scripts.link`) |
| `smoke` | `bun --filter @clarvis/code smoke` | `package.json` (`scripts.smoke`) |
| `release:package` / `release:smoke` / `release:install-smoke` | native portable archive, artifact smoke, and installer smoke | `package.json` (`scripts.release:*`) |
| `check:release` | root/installers/repository identity; tag identity when `RELEASE_TAG` is supplied | `package.json` (`scripts.check:release`) |
| `bench:code` | `bun --filter @clarvis/code bench` | `package.json` (`scripts.bench:code`) |
| `check:harness` | `bun run tooling/checks/test-harness.ts` | `package.json` (`scripts.check:harness`) |
| `check:bun-version` | `bun run tooling/checks/bun-version.ts` | `package.json` (`scripts.check:bun-version`) |
| `check:bun-sources` | `bun run tooling/checks/bun-sources.ts` | `package.json` (`scripts.check:bun-sources`) |

Root tooling keeps executable checks under `tooling/checks/`, shared libraries under `tooling/lib/`,
isolated-runtime build/manifest support under `tooling/runtime/`, and classified tests under
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
| `@clarvis/workflows` | every test script carries `--isolate` | `packages/workflows/package.json` |
| `@clarvis/llm`, `@clarvis/loop`, `@clarvis/workflows` | declare `prebuild: bun run clean` | `packages/llm/package.json`, `packages/loop/package.json`, `packages/workflows/package.json` |
| `@clarvis/kernel`, `@clarvis/protocol` | `typecheck` is `tsc -p tsconfig.json` with no `--noEmit` flag (their `tsconfig.json` sets `noEmit: true` itself) | `packages/kernel/package.json`, `packages/kernel/tsconfig.json` |
| `@clarvis/code` | `typecheck` is bare `tsc --noEmit` (no `-p`) | `packages/code/package.json` |

Every `bun test` invocation reachable from a package's `test` script carries `--timeout 60000` on the
command line (the type-only `@clarvis/protocol` runs `tsc` instead). `bunfig.toml` records the
historical 1.3.14 probe and the migration rule: Bun 1.4 retains the proven CLI contract unless a
separate measured change moves it.

### 2.3 Package surfaces — `exports` subpaths and bins

| Package | Export subpaths (besides `./package.json`) | `bin` |
| --- | --- | --- |
| `@clarvis/capability` | `.`, `./ports`, `./trace` | — |
| `@clarvis/supervision` | `.` | — |
| `@clarvis/llm` | `.`, `./adapter` | — |
| `@clarvis/paths` | `.` | — |
| `@clarvis/trace` | `.`, `./testing` | — |
| `@clarvis/mcp-client` | `.` | — |
| `@clarvis/tools` | `.`, `./shell` | — |
| `@clarvis/hooks` | `.`, `./capability` | — |
| `@clarvis/skills` | `.`, `./catalog`, `./capability` | — |
| `@clarvis/memory` | `.`, `./schemas`, `./capability`, `./settings`, `./testing` | — |
| `@clarvis/plan` | `.`, `./schemas`, `./testing`, `./capability`, `./settings` | — |
| `@clarvis/protocol` | `.` | — |
| `@clarvis/loop` | `.`, `./capabilities/tools`, `./host`, `./workflows`, `./testing` | — |
| `@clarvis/workflows` | `.`, `./schemas`, `./artifact` | — |
| `@clarvis/kernel` | `.`, `./bootstrap`, `./config`, `./policy`, `./local` | `clarvis-kernel` → `dist/bin.js` |
| `@clarvis/code` | **none** | `clarvis` → `src/cli.ts` |

Every export entry has the same three-condition shape, `bun` first:

```json
".": { "bun": "./src/index.ts", "types": "./dist/index.d.ts", "import": "./dist/index.js" }
```

(`packages/capability/package.json`; the same shape recurs in every library manifest). The application package publishes no `exports` and is reached through its `bin`
(`packages/code/package.json`). Kernel points at built `dist/bin.js`; Code points at TypeScript source
(`src/cli.ts`), which then dispatches to the bundle at runtime (§4.6).

`@clarvis/skills` is the only manifest carrying `"overrides": { "esbuild": "^0.25.0" }` plus
`repository`/`homepage`/`bugs` metadata (`packages/skills/package.json`).

### 2.4 tsconfig profiles

| Profile | Packages | Evidence |
| --- | --- | --- |
| Extends `tsconfig.base.json` | 13: capability, hooks, llm, loop, mcp-client, memory, paths, plan, skills, supervision, tools, trace, workflows | `rg -l tsconfig.base.json packages/*/tsconfig.json` → 13 |
| Standalone | 3: `protocol`, `kernel`, `code` | none of those three contains `extends` |

`tsconfig.base.json` fixes `module`/`moduleResolution` = `NodeNext`,
`rewriteRelativeImportExtensions: true`, `types: ["bun","node"]`, `strict`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `esModuleInterop`,
`forceConsistentCasingInFileNames`, `resolveJsonModule`, `declaration: false`, `sourceMap: true` and
`skipLibCheck: true`. Extending packages keep only `target`/`lib` and path-relative options
(`packages/capability/tsconfig.json`).

The three standalone profiles differ concretely:

| Package | `module` | `moduleResolution` | Extras |
| --- | --- | --- | --- |
| `protocol` | `NodeNext` | `NodeNext` | `rewriteRelativeImportExtensions`, `declaration: true`, `isolatedModules: true`, `verbatimModuleSyntax`, `noEmit: true`, no `types` array (`packages/protocol/tsconfig.json`) |
| `kernel` | `NodeNext` | `NodeNext` | `rewriteRelativeImportExtensions`, `verbatimModuleSyntax`, 18 `paths` entries onto sibling **sources** (`packages/kernel/tsconfig.json`) |
| `code` | `ESNext` | `bundler` | `jsx: "preserve"`, `jsxImportSource: "@opentui/solid"`, `types: ["bun"]` only, `allowImportingTsExtensions`, 16 `paths` entries (`packages/code/tsconfig.json`) |


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

Fourteen packages' `eslint.config.js` is exactly one call to that factory (e.g.
`packages/paths/eslint.config.js`). Four append:

| Package | Appended | Citation |
| --- | --- | --- |
| `capability` | `no-floating-promises: ignoreVoid` for `src/tasks.ts` | `packages/capability/eslint.config.js` |
| `kernel` | `require-await: off` in `src/**`; `no-restricted-imports` banning `@clarvis/loop/internal` | `packages/kernel/eslint.config.js` |
| `workflows` | `no-restricted-imports` banning `@clarvis/loop/internal` | `packages/workflows/eslint.config.js` |
| `code` | `eslint-plugin-unicorn` + `unicorn/filename-case` (PascalCase or kebab-case); `no-unsafe-*` and `no-base-to-string` and `require-await` off; a `tests/**/*.{ts,tsx}` block turning off `no-non-null-assertion` and `no-require-imports`; a `src/core/tasks.ts` block re-enabling `no-floating-promises` with `ignoreVoid: true` (the same pattern `@clarvis/capability` uses for its own `src/tasks.ts`); six `no-restricted-imports` layer rules (adapters/core/keys/ui/infrastructure/features) | `packages/code/eslint.config.js`, tests block tasks block |

`eslint-plugin-unicorn` is the only package-level lint devDependency (`packages/code/package.json`).

Prettier is one root `.prettierrc.json` — `semi: true`, `singleQuote: false`, `trailingComma: "all"`,
`printWidth: 100`, `tabWidth: 2`, `arrowParens: "always"` (`.prettierrc.json`) — and one root
`.prettierignore` that excludes `node_modules/`, `dist/`, `coverage/`, `package-lock.json`, and
`**/specs/` (`.prettierignore`).

Knip runs once from the root (`package.json`, `scripts.knip`). `knip.json` sets
`ignoreExportsUsedInFile` for `interface` and `type` and adds five workspace overrides. The
root workspace's entries cover executable TypeScript checks and the Bun preload; its project globs
cover root tooling.
`packages/code` explicitly includes
its `src`, tests, artifact builders and benchmarks,
`packages/kernel` adds `src/bin.ts` and its Bun-native executable test fixture as entries,
`packages/protocol` adds
`tests/contract/public-contract.fixture.ts` as an entry; that fixture type-imports 24 protocol names
(`packages/protocol/tests/contract/public-contract.fixture.ts`), and
`packages/tools` ignores the `rg` binary.

### 2.6 Bun test configuration

Root `bunfig.toml` sets `[install] linker = "hoisted"` and a `[test]` block with
`preload = ["./tooling/test-runtime/clarvis-home-preload.ts"]`, `coverageReporter = ["text","lcov"]`,
`coverageDir = "coverage"`, `coverageSkipTestFiles = true`. Every one of the 17 workspace packages
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
Test: `tooling/tests/unit/gitflow-workflow.test.ts` (PR triggers and credential ordering).
`.github/workflows/release.yml` excludes RC pushes and admits stable version tags for
publication. `.github/workflows/candidate.yml` publishes source prereleases for signed RC tags.
Both workflows request Publisher installation tokens scoped to their target repository.
Production: `tooling/release/gitflow.ts` (`main`) and `tooling/lib/gitflow-release.ts`
(`planGitflowRelease`, `candidateTag`). Test: `tooling/tests/unit/gitflow-release.test.ts` and
`tooling/tests/unit/gitflow-release-git.test.ts`. External App installation, signing secrets, and tag
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
| `CLARVIS_CODE_SOURCE=1` | `packages/code/src/cli.ts` | launcher runs `src/index.tsx` instead of `dist/index.js` |
| `SMOKE_TIMEOUT_MS` | `packages/code/tooling/artifact/smoke.ts` | smoke timeout, default `90_000` |
| `BENCH_N`, `BENCH_POLL_MS`, `BENCH_TIMEOUT_MS`, `BENCH_MAX_LOAD` | `packages/code/tooling/benchmarks/first-paint.ts` | benchmark sample size, poll, timeout, per-core load refusal (default `0.35`) |
| `CI` | `packages/tools/tests/contract/grep-parity.test.ts` | when set, `rg` must be installed (TEST-01) |
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
`external: ["@opentui/core", "@opentui/core-*", "pino"]`, `splitting: true` and `minify: true`.
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
  models-dev.json              copied asset (1.7 MB)
```

The installed layout is identical except that it has no `maps/` directory or `.map` file. The
one-shot TypeScript setup verifies the exact Bun version in `mise.toml`, installs from the frozen root
lockfile, builds that layout, removes the former bin only when it is a symlink targeting this
package's Bun global registration, runs `bun unlink`, then registers only the current `clarvis` bin
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
`*.ico`, `*.woff`, `*.woff2` binary marks `bun.lock -text`. The stated reason is that
Git-for-Windows' `core.autocrlf=true` "corrupts the fixtures that assert on exact bytes: the CRLF/BOM
tally in `packages/tools/src/lib/text.ts`, and every `apply_patch`, `diff` and `replace` test".

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
`bun` condition, which points at `src/*.ts` — so editing a package's source is immediately visible to
its consumers with no build. Under `tsc`, the same specifier resolves through `types`/`import` to
`dist/*.d.ts`, except where a `paths` mapping redirects it (§4.2).

### 4.2 Root build composition and `tsc -b`

`bun run build` runs `build:packages` and then `build:code` sequentially (`package.json`,
`scripts.build`). The first phase is `tsc -b` against the root solution file (`scripts.build:packages`),
and the second invokes `@clarvis/code`'s Bun bundle. The solution declares
`"files": []` and 17 `references` — every package that has a `tsconfig.build.json`
(`tsconfig.json`). `@clarvis/code` is absent; `tsconfig.json` states it "is Bun-only (runs from
source, never emits) and is intentionally excluded", and indeed `packages/code` has no
`tsconfig.build.json`.

Each `tsconfig.build.json` `extends` its own package's `tsconfig.json`, then overrides it into an
emitting composite project (`packages/capability/tsconfig.build.json`). Because the dev config
sets `noEmit: true` for most packages, the build config must turn it back off — twelve of them carry
an explicit `"noEmit": false` (e.g. `packages/loop/tsconfig.build.json`).

Repository source names the actual relative TypeScript extension. The 14 shared profiles and the
three standalone emitting profiles enable `rewriteRelativeImportExtensions`, so JavaScript output
still imports sibling `.js`/`.mjs`/`.cjs` files. `code` already permits TypeScript extensions under
its non-emitting bundler profile. The `check:imports` pass scans tracked and unignored TypeScript ASTs
and rejects only runtime-style relative specifiers that do not name a real JavaScript file but do
alias a neighboring TypeScript source (`tooling/checks/import-extensions.ts`,
`aliasedTypeScriptImports`). Real generated artifacts such as `dist/index.js` and lazy chunks remain
JavaScript.

Declaration emit deliberately retains the source-oriented `.ts`/`.tsx` specifier. Under NodeNext,
TypeScript resolves that declaration edge to the sibling `.d.ts`; package build audits and the root
project-reference build verify those consumers. The runtime rewrite claim therefore applies to
emitted JavaScript, not to declaration text.

Two different `paths` regimes exist and the direction matters. A package's dev `tsconfig.json`
`paths` map is a **hand-maintained subset** of its dependencies, not a complete mirror of them, and the
gaps resolve silently through the ordinary `types` condition onto `dist/*.d.ts` — the built output —
even during an otherwise source-mapped, non-build `tsc -p tsconfig.json` typecheck:

- The **dev** `tsconfig.json` of `loop`, `kernel`, `code`, `memory`, `workflows`, `trace`,
  `hooks`, `llm`, `mcp-client`, `skills`, `supervision` maps most `@clarvis/*` specifiers it imports
  onto sibling **sources** (e.g. `packages/loop/tsconfig.json`, `packages/kernel/tsconfig.json`),
  but each package's map omits some of its own declared dependencies: `kernel`'s 18-entry map
  (`packages/kernel/tsconfig.json`) excludes `@clarvis/capability`, `@clarvis/paths` and
  even though `kernel` depends on both (`packages/kernel/package.json`);
  `loop`'s 11-entry map (`packages/loop/tsconfig.json`) excludes `@clarvis/paths`,
  `@clarvis/supervision`, `@clarvis/trace` and `@clarvis/mcp-client` despite depending on all four
  (`packages/loop/package.json`); `skills`'s single-entry map
  (`packages/skills/tsconfig.json`) excludes `@clarvis/paths` despite depending on it
  (`packages/skills/package.json`); and `hooks`'s two-entry map
  (`packages/hooks/tsconfig.json`) maps only the `@clarvis/tools/shell` subpath, never the
  package's own `.` entrypoint, even though `hooks` declares `@clarvis/tools` as a whole
  (`packages/hooks/package.json`) — in `hooks`'s case its `src`/`tests` never actually import the
  bare `@clarvis/tools` specifier, so the gap is unexercised rather than latent. Each of these edges
  therefore typechecks against the named package's built `dist`, not its live source, which is exactly
  the asymmetry §4.3's "build precedes typecheck" rule exists to paper over.
- The **build** `tsconfig.build.json` either clears the mapping (`"paths": {}`, e.g.
  `packages/loop/tsconfig.build.json`) so resolution goes through the emitted `dist/*.d.ts`, or
  remaps explicitly onto `dist/*.d.ts` — `kernel` does this for `protocol` and `plan`
  (`packages/kernel/tsconfig.build.json`).

Project references mirror the runtime dependency edges. `packages/kernel/tsconfig.build.json`
lists its referenced packages; `packages/loop/tsconfig.build.json` lists nine (including the three optional
packages `tools`, `hooks`, `skills`); leaves list one or two.

`@clarvis/code` is typechecked separately by `tsc --noEmit` (`packages/code/package.json`) using
`moduleResolution: "bundler"` and 16 source `paths` entries
(`packages/code/tsconfig.json`). Those entries include `@clarvis/loop`, `@clarvis/memory`,
`@clarvis/plan`, `@clarvis/skills`, `@clarvis/tools` — packages the architecture test forbids `code`
from importing directly (`packages/code/tests/architecture/dependency-boundary.test.ts`); they
are needed because `code`'s `@clarvis/kernel` mapping points at kernel **source**
(`packages/code/tsconfig.json`), whose own imports must then resolve.

### 4.3 The pre-commit gate

`.githooks/pre-commit` resolves the repository root with `git rev-parse --show-toplevel`, `cd`s
there, and `exec bun run check:pre-commit`. That script is a strictly sequential `&&` chain
(`package.json`, `scripts.check:pre-commit`):

```
format:check → build → typecheck → lint:eslint → lint:intent → knip → test:coverage
```

`build` sits immediately before `typecheck`, which is load-bearing because `typecheck` resolves
cross-package types through the built `dist/*.d.ts` (§4.2). The hook is installed by
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
| `coverage` | build | restore, native Linux preparation, sequential coverage supervisor |
| `linux` | all six gates above | fail-closed required-result aggregation |

Every host Bun job installs the exact mise version, records `bun --version && bun --revision`,
and installs its own dependencies with `bun install --frozen-lockfile`. Installation is not a build.
Only `build` emits the shared Linux build, including the Code bundle; upload follows both build and
smoke success. Its consumers restore that build before checking it and never silently rebuild.
Finite timeouts remain conservative: 15 minutes
for build and ordinary Linux gates, 30 for coverage, and 5 for aggregation. Windows/macOS retain
their existing bounds. No required job or step uses `continue-on-error` or an optional gate condition.


The public required contexts remain exactly `linux`,
`tools, paths, plan, memory, keyboard policy (windows)`, and `keyboard policy (macos)`.
The release workflow consumes these literal names. `linux` has `always()` and all seven Linux
needs; it installs nothing and downloads nothing. Its Bash step receives `toJSON(needs)` through
an environment variable, then jq requires exactly one JSON object, the exact dependency key set,
and `result == "success"` for every entry. Failure, cancellation, skip, missing/unknown results,
malformed input, and an empty object cannot approve the required status. The job condition only
admits the aggregator; the explicit result check decides success.

Production: [CI workflow](../../.github/workflows/ci.yml), `jobs`;
[workflow validator](../../tooling/lib/ci-workflow.ts), `ciWorkflowFailures`;
[Bun version checker](../../tooling/checks/bun-version.ts), `bunVersionFailures`.
Test: [CI workflow tests](../../tooling/tests/unit/ci-workflow.test.ts), including mutations that
remove each gate/dependency and fixtures executing the actual YAML Bash body;
[Bun version tests](../../tooling/tests/unit/bun-version.test.ts), per-job setup/evidence validation.
The validator reuses `workflowSecurityFailures`; other workflows retain their existing policies.

**`windows`**, `windows-latest`, records the exact Bun runtime and installs ripgrep from a pinned
release asset after checking its SHA-256 and executing it in the same step. Then it runs four
package suites and one explicit test-file list:

- `bun --filter @clarvis/paths test`
- `bun --filter @clarvis/tools test`
- `bun --filter @clarvis/plan test`
- `bun --filter @clarvis/memory test`
- `bun test packages/code/tests/unit/{keyboard-profile,keyspec,active-actions}.test.ts`

The retained scope is deliberate: `paths` owns the Windows `PATH`/`PATHEXT` resolver; `tools` owns
PowerShell dispatch and Windows process behavior; `plan` has a real win32 directory-sync branch;
`memory` exercises platform filesystem, symlink and child-process lifetime behavior; and `code`
contributes only its platform-independent keyboard-policy tests. `kernel`, `loop`, `trace`,
`mcp-client` and `supervision` remain deliberately absent. Production: `.github/workflows/ci.yml`
(`jobs.windows.steps`).

**`keyboard-macos`**, `macos-14`, records the Bun version/revision, installs/verifies
ripgrep, runs the complete `@clarvis/tools` suite and keyboard policy tests. It publishes
the stable `keyboard policy (macos)` status context required by both permanent-branch rulesets.
Production: `.github/workflows/ci.yml` (`jobs.keyboard-macos`).

All host Bun jobs record `bun --version` and `bun --revision` immediately after setup, so a future run
remains attributable to the executable it actually used. CI was restored for the new public
repository on push to `main` and `develop` and pull request; the earlier account-specific billing incident remains
historical evidence in [Known issues](../known-issues.md), not current workflow behavior.

### 4.5 Shared build identity and coverage supervision

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
Test: [artifact tests](../../tooling/tests/unit/ci-artifacts.test.ts), round trip, modes/dotfiles,
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

Bun 1.4's upstream Worker fix does not retire this mitigation. The independent GitHub-runner canary
still requires at least 30 Code coverage iterations without 132/134/139; its historical rates,
diagnosis and retirement criterion remain in [Known issues](../known-issues.md).
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
`packages/code/tooling/artifact/isolation.ts`. Tests: `packages/code/tests/unit/artifact-isolation.test.ts`.

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

The cross-runner contract canary is `tooling/tests/unit/harness-isolation-contract.test.ts`; it
keeps artifact, release and installer runners on fixture-owned roots and explicit child
environments. `packages/code/tests/architecture/artifact-contract.test.ts` covers the release
packager's allowlisted locale environment, while the direct Linux installer journey is exercised
by `bun run release:install-smoke`. The PTY and archive journeys remain separate evidence layers:
an archive/installer pass does not claim a complete-app PTY pass when the host rejects the fixture's
private-state parent.

The launcher's decision is a pure function (`packages/code/src/cli-entry.ts`):

| `forceSource` | `distExists` | Result |
| --- | --- | --- |
| `true` | any | `{ kind: "source" }` |
| `false` | `true` | `{ kind: "dist" }` |
| `false` | `false` | `{ kind: "error" }` with the three fixes spelled out |

`packages/code/src/cli.ts` performs it: `--help`/`--version` are answered before any of that, then `dist` is loaded with `await import(pathToFileURL(distPath).href)` or the
source path with `await import("@opentui/solid/preload")` followed by `await import("./index.tsx")`.

### 4.7 The package-graph analyzer

`analyzePackageGraph(root)` (`tooling/lib/package-graph.ts`) reads the root manifest's
`workspaces`, then for each package walks `src`, `tests` and `scripts`
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

`--check-doc` additionally validates the three numeric columns of the Markdown table in
`specs/package-coupling-analysis.md` against the computed report
(`tooling/checks/package-graph.ts`, `tooling/lib/package-graph.ts`); any mismatch is an
error and `process.exitCode = 1` (`tooling/checks/package-graph.ts`).

`tooling/tests/architecture/stream-metrics-drift.test.ts` is one of the twelve test files executed by
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
chunk instead of spelling it directly in `index.js`, and when Bun reports the chunk path with POSIX
or Windows separators.
Production: `packages/code/tooling/artifact/contract.ts` (`assertLazyProviderArtifact`). Enforced in
the build by `packages/code/tooling/artifact/build.ts` (`assertLazyProviderChunk`) and again on disk
by `packages/code/tooling/artifact/smoke.ts`.
Test: `packages/code/tests/architecture/artifact-contract.test.ts` (lazy provider artifact and
Windows-shaped chunk-path cases).

**BUILD-4 (INV-259).** The ordinary developer/root artifact keeps its source maps **detached** under
`dist/maps/`, and must still contain `index.js.map` there; a `.map` beside runtime JS, or a missing
entrypoint map, is rejected.
Production: `packages/code/tooling/artifact/contract.ts` (messages: "source maps must not
sit beside runtime JavaScript; Bun loads them eagerly" "artifact must retain its entrypoint
source map under dist/maps"); implemented by `detachSourceMaps`
(`packages/code/tooling/artifact/build.ts`).
Test: `packages/code/tests/architecture/artifact-contract.test.ts`.

**BUILD-5.** `Bun.build` for `code` keeps `@opentui/core` and `@opentui/core-*` external.
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
Production: `tsconfig.json` lists 17 references, none of them `packages/code`; `packages/code`
has no `tsconfig.build.json`.
Pinned indirectly: `tooling/lib/package-graph.ts` requires the root solution's references to
be exactly the set of packages that have a `tsconfig.build.json`, so adding one for `code` without a
root reference (or vice versa) is an error. That rule is unit-tested at
`tooling/tests/unit/package-graph.test.ts`.

**BUILD-8 (INV-309 d).** A package's `dependencies` + `optionalDependencies` on other workspaces must equal its
`tsconfig.build.json` `references` set, in both directions.
Production: `tooling/lib/package-graph.ts` (errors `"dependency without project reference X"`
and `"project reference without runtime dependency X"`).
Test: `tooling/tests/unit/package-graph.test.ts`.

**BUILD-9 (INV-309 f).** A `src` file may not import a subpath the target package's `exports` map does not
publish, and a type-only import may additionally use a `types`-only condition where a value import may
not.
Production: `tooling/lib/package-graph.ts`.
Test: `tooling/tests/unit/package-graph.test.ts` (unexported and accepted deep subpaths) (wildcards and type-only conditions).

**BUILD-10 (INV-309 a).** A `src` file may not import its own package's public entrypoint — by package name or by
a relative path that resolves to it.
Production: `tooling/lib/package-graph.ts`.
Test: `tooling/tests/unit/package-graph.test.ts`.

**BUILD-11 (INV-309 b).** A `src` **value** import of an internal package declared only under `devDependencies` is
an error; the same import from `tests/` or package `tooling/` is allowed.
Production: `tooling/lib/package-graph.ts` (`sourceTree === "src" && !edge.typeOnly`).
Test: `tooling/tests/unit/package-graph.test.ts`.
A real instance of exactly this pattern: `@clarvis/kernel` declares `@clarvis/mcp-client` under
`devDependencies` (`packages/kernel/package.json`) and no file in `packages/kernel/src` imports it.

**BUILD-12 (INV-309 g).** No relative import may cross a package root.
Production: `tooling/lib/package-graph.ts`.
Test: `tooling/tests/unit/package-graph.test.ts`.

**BUILD-13 (INV-309 e).** The declared workspace graph and the compilation graph are both acyclic, and no
package's `src` contains a value-import module cycle.
Production: `tooling/lib/package-graph.ts`.
Test: `tooling/tests/unit/package-graph.test.ts` (package cycles) (module cycles, with
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

**BUILD-16.** `code` reaches `@clarvis/kernel` only through its six published entrypoints and imports
no lower implementation package, in `src/` **and** `tests/`.
Production: `packages/code/package.json` declares exactly `@clarvis/kernel`, `@clarvis/paths`,
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

**BUILD-18 (INV-312).** The launcher prefers the bundle, `CLARVIS_CODE_SOURCE=1` overrides it in both
directions, and a missing bundle produces an explanatory error naming the build command, `bun run
setup`, and the source-mode escape.
Production: `packages/code/src/cli-entry.ts`.
Test: `packages/code/tests/unit/cli-entry.test.ts`.

**BUILD-21.** The CI retry accepts only Code exits 132/134/139, with three additional attempts, and
never retries 130/143 or another package. Production: `tooling/lib/ci-coverage.ts`, `runCiCoverage`
and `normalizeCoverageExit`; `tooling/ci/retry-code-coverage.sh` is only the CLI entry.
Test: `tooling/tests/unit/ci-coverage.test.ts`, classified retry, continuation, cancellation and the
pinned Bun subprocess signal boundary.

**BUILD-21.** Line endings are normalized to LF for every text file at checkout, and `bun.lock` is
kept verbatim.
Production: `.gitattributes`. Unpinned by a test; the byte-exact fixtures it protects are
named in the file's own comment.

**BUILD-22.** Windows commands run through PowerShell, never `cmd.exe`, with the payload carried as a
base64 UTF-16LE `-EncodedCommand`.
Production: `packages/tools/src/shell.ts` (`computeShell`: `pwsh` from `PATH` restricted to
`.EXE`, else `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, tail), reached
through `resolveShell` (`encodePowerShellCommand`) (`shellArgs` →
`-NoProfile -NonInteractive -EncodedCommand`). Detailed behaviour is delegated to **tools-shell-and-sessions**.

**BUILD-23.** `spawn`'s `detached` option is derived from the platform, never passed
unconditionally: `true` on POSIX, `false` on Windows.
Production: `packages/tools/src/lib/process.ts`, with the Windows consequence documented ("a console-subsystem shell spawned that way produces nothing at all: empty stdout and
stderr, a `null` exit code … while the spawn itself still reports success"). Call sites:
`packages/tools/src/lib/execution-session.ts`.

**BUILD-24.** A test that exercises a platform-conditional branch pins `process.platform` rather than
relying on the ambient host.
Production: `packages/plan/src/file-repository.ts` (`fsyncDir` reads `process.platform` per
call and swallows the failure only on win32).
Test: `packages/plan/tests/integration/file-repository.test.ts` (pins `"win32"`) (pins `"linux"`). states the reason: "`fsyncDir` reads `process.platform` per
call, so a test that only *assumes* it is off win32 is really asserting whatever host it runs on. That
held until `@clarvis/plan` joined the Windows CI job … Skipping it there would have been the wrong
repair: the branch under test is platform-independent code, so the test should be too."

**BUILD-25.** Platform conditional tests name the property they cannot exercise: POSIX shell syntax (`posixShell`), mode-bit enforcement (`modeBitsEnforced`), or a process-settlement measurement (`backgroundSettleIsMeasurable`). Session capture is exercised through the new `shell` and `shell_session` tests on every supported platform; native Windows and macOS CI evidence remains necessary. Production: `packages/tools/tests/helpers/fixtures.ts` and `packages/tools/src/lib/execution-session.ts`. Test: `packages/tools/tests/integration/shell-session.test.ts` and `packages/tools/tests/integration/execution-session.test.ts`.

**BUILD-26 (INV-313).** Every executable and declaration surface derives from the one exact Bun
version in `mise.toml`: every host Bun CI job, the release package matrix, the release publication gate,
the crash-canary default and its evidence, all 20
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

**BUILD-28.** Every tracked relative module specifier that targets a TypeScript source names the
source's actual `.ts`, `.tsx`, `.mts` or `.cts` extension. Runtime extensions remain valid only for
real JavaScript files; emitting packages rewrite source extensions back to their JavaScript
equivalents in emitted JavaScript, while declaration specifiers remain source-oriented and resolve
to sibling `.d.ts` files.
Production: `tsconfig.base.json` and the standalone emitting profiles in
`packages/{kernel,protocol}/tsconfig.json` enable `rewriteRelativeImportExtensions`;
`packages/code/tsconfig.json` enables `allowImportingTsExtensions`; `check:imports` is part of
`lint:intent` in `package.json`.
Test: `tooling/checks/import-extensions.ts` (`moduleSpecifiers`, `aliasedTypeScriptImports`) scans the
repository, while `tooling/tests/unit/import-extensions.test.ts` pins every supported syntax,
positive aliases, real-JavaScript exceptions and source-file selection.

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
frozen-lockfile, safe legacy-link and no-host-mutation cases).

**BUILD-31.** The terminal application publishes exactly one executable name, `clarvis`, targeting
`src/cli.ts`; there is no `clarvis-code` compatibility alias.
Production: `packages/code/package.json` (`bin`), `packages/code/tooling/setup.ts` (legacy-bin
ownership check and unlink/link phase), `packages/code/src/cli-args.ts` (`usageText`, `helpText`, `versionText`) and
`packages/code/src/cli-entry.ts` (`resolveEntry`).
Test: `packages/code/tests/architecture/cli-fast-path.test.ts` (manifest bin case) and
`packages/code/tests/unit/cli-args.test.ts` (`versionText`).

**BUILD-32.** Clarvis uses a single product version: root `package.json` owns one exact SemVer;
every workspace manifest is private and omits `version`, as does every workspace entry in
`bun.lock`. The only runtime imports of the root
manifest are Code's CLI presentation, Loop's public `VERSION`, and MCP Client's initialization identity.

Production: root `package.json` (`version`); `tooling/lib/package-architecture.ts`
(`PRODUCT_VERSION_IMPORTERS`, `productVersionPolicyErrors`, `productLockfileVersionErrors`,
`productManifestImportViolation`); `tooling/lib/package-graph.ts` (`analyzePackageGraph`);
`packages/{code,loop,mcp-client}/src` version consumers.
Test: `tooling/tests/unit/package-architecture.test.ts` (product-version policy and importer cases),
`packages/code/tests/unit/cli-args.test.ts`, `packages/loop/tests/unit/version.test.ts`,
and `packages/mcp-client/tests/unit/version.test.ts`.

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
Test: `packages/code/tests/unit/development-install.test.ts` (argument, launcher, ownership,
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
| A missing entry in `specs/package-coupling-analysis.md` | `checkDocument` reports `"document is missing package row X"`; `process.exitCode = 1` | `tooling/lib/package-graph.ts`, `tooling/checks/package-graph.ts` |
| Root version is invalid, a workspace or lock entry declares `version`, a workspace is not private, or an unapproved module imports the root manifest | `check:graph` reports the exact manifest, lock path, or source-policy violation | `tooling/lib/package-architecture.ts` (product-version policy helpers) |
| A Bun version surface drifts | `check:bun-version` reports every offending file and observed value, then sets exit 1 | `tooling/checks/bun-version.ts` |
| Model catalog file exceeds 8 MiB, or the user cache is corrupt | `readCatalogFile` throws `"model catalog exceeds byte limit"`; a bad cache is silently ignored and the bundled snapshot returned | `packages/kernel/src/models/model-catalog.ts` |
| Neither models-dev.json candidate exists | `bundlePath()` returns the source-tree path anyway "so the ensuing read reports the location a developer expects" | `packages/kernel/src/models/model-catalog.ts` |
| `code`'s temp-home cleanup races a live child | `rmSync` failure swallowed; comment: "a live child may still hold a handle; the OS reaps the temp dir" | `tooling/test-runtime/clarvis-home-preload.ts` |
| `chocolatey`-style install reporting success over a no-op | avoided by construction: the Windows ripgrep step verifies the SHA256 and runs the binary in the same step | `.github/workflows/ci.yml` |
| Documentation embeds a source line locator, names an explicit repository file that does not exist, or a tracked spec embeds a calendar date or source-size inventory | `check:specs` reports every unstable, missing, dated, or source-size reference and exits nonzero; illustrative paths use visible placeholders, chronology stays in `CHANGELOG.md`, and behavioral line limits remain legal | `tooling/checks/spec-hygiene.ts`; `extractLineQualifiedReferences`, `resolveRepositoryFileReference`, `extractCalendarDates`, and `extractSourceSizeReferences` in `tooling/lib/spec-hygiene.ts` |
| A Pages workflow, local `docs/` site, or VitePress dependency is reintroduced | the repository-metadata architecture test reports the duplicated ownership surface | `tooling/tests/architecture/repository-metadata.test.ts` (`keeps public-site ownership outside this monorepo`) |

Degradation that is **silent by design**: a clone that has never run `bun run hooks:install` has no
pre-commit gate at all, because `core.hooksPath` is a local git config value and nothing in the tree
sets it (`package.json`, `scripts.hooks:install`, is the only writer).

## 7. Coupling

**What this subsystem depends on.**

| Dependency | Direction forced by | Kind |
| --- | --- | --- |
| Bun ≥ 1.4.0 | `engines` in all 20 manifests; exact `mise.toml`; `check:bun-version` in `lint:intent` | runtime |
| `typescript` ^6 | root devDependency; imported as a **library** by four repository-tooling modules (`tooling/lib/source-policy.ts`, `tooling/lib/package-graph.ts`, `tooling/checks/import-extensions.ts`, `tooling/tests/architecture/stream-metrics-drift.test.ts`) and five package architecture tests (three under `packages/code/tests/architecture/`, two under `packages/loop/tests/architecture/`) | static value import |
| `@opentui/solid/bun-plugin` | `packages/code/tooling/artifact/build.ts` — the build cannot produce the artifact without it | static value import |
| `@clarvis/paths` | `packages/code/tooling/artifact/pty.ts` and `packages/code/tooling/artifact/smoke.ts` use `globalPaths` so the fixture layout cannot drift from the vocabulary; `tooling/test-runtime/clarvis-home-preload.ts` uses `HOME_ENV` | static value import |
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
`dist/*.d.ts` exists for `tsc` — its own package `test` script is a typecheck, not a test run
(`packages/protocol/package.json`). The inverse instance — a package declared only under
`devDependencies` and absent from `src/` — is `@clarvis/kernel`'s `@clarvis/mcp-client`
(`packages/kernel/package.json`, BUILD-11).

**Static vs dynamic.** `packages/code/src/cli.ts` reaches the application only dynamically, which is what BUILD-17 pins; `packages/code/tooling/artifact/build.ts` relies on `Bun.build`'s
`splitting: true` turning `@clarvis/llm`'s own dynamic adapter import into a `chunk-*.js`,
which is what BUILD-3 pins.

**Delegated.** Coverage thresholds, the LCOV counter allowlist and the test taxonomy belong to
**test-architecture-and-gate** (`tooling/checks/coverage.ts` holds `NO_COUNTER_ALLOWLIST`, whose
`code` entry lists `src/cli.ts` among "executable entry points"). Shell resolution, process
groups, `killTree` and session capture belong to **tools-shell-and-sessions**.

## 8. Open questions

1. **Several build-time rules are unpinned.** No test asserts the `external` list
   (`packages/code/tooling/artifact/build.ts`) or the `splitting` option, the
   `.gitattributes` normalization, or the canary's least-privilege workflow fields. Each is enforced only by the build or CI failing at the moment it
   is broken. Interactive PTY reproduction belongs to `tui-driver`; the repository owns only the
   automated artifact boot contract through `bun run smoke`.

2. **`packages/skills/package.json` alone carries `overrides` (`esbuild ^0.25.0`) and
   `repository`/`homepage`/`bugs` metadata**, and the root `allowScripts` permits `esbuild@0.28.1`
   (`package.json`, `allowScripts`). Neither the reason for the skills-only override nor which
   dependency pulls esbuild in is derivable from the files in this document's scope.

3. ~~**CI is disabled and the Windows/macOS legs are therefore unexercised.**~~ **Resolved in the
   first public-beta preparation:** `.github/workflows/ci.yml` triggers on push to `main` and `develop`, pull
   request, and manual dispatch with read-only permissions and SHA-pinned actions. This configuration
   does not itself claim a green platform run; observed release-platform evidence belongs to
   [distribution and updates](distribution-and-updates.md#8-open-questions).

4. **The Bun 1.4 retirement canary has not run.** `tooling/ci/retry-code-coverage.sh`
   and the header comment in `.github/workflows/segfault-canary.yml` both point at
   `specs/known-issues.md` for the
   historical rate, upstream repair, ruled-out theories and removal condition. The canary still has
   not supplied the retirement evidence, so restored CI does not make the wrapper unnecessary.

5. **Rationale for the ordering inside `check:pre-commit` is only partly derivable.** The chain is
   sequential (`package.json`, `scripts.check:pre-commit`) and `build` precedes `typecheck`, which the `paths`-to-`dist`
   arrangement (§4.2) makes necessary. Whether the rest of the order (format before build, knip before
   coverage) is load-bearing is not stated in any file in scope.

## Prompt-cache gates

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
[loaded artifact observation](../../tooling/tests/unit/prompt-cache-artifact.test.ts).
