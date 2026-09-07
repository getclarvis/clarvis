# Test layers, isolation, the pre-commit gate and coverage policy

> Implemented at `packages/...`, `tooling/...`, `bunfig.toml`, `.githooks/` and the root
> `package.json`. Every claim below is anchored to current source or test evidence, using a stable
> symbol or configuration key where available. Open questions are collected in the final section.

## 1. Purpose

This subsystem is the repository's *self-enforcement layer*: the rules about how tests are
organised, how a test process is isolated from the developer's machine, and what a commit must
survive before it is allowed to land. It is implemented by the checks and shared libraries under
`tooling/`, the Bun preload at `tooling/test-runtime/clarvis-home-preload.ts`, the root and
per-package `bunfig.toml` files, the npm-script chain in the root `package.json`, and the
`.githooks/pre-commit` hook that delegates to `bun run check:pre-commit`.

Three concerns are handled here that no individual package can see. **Test placement**: every
`*.test.*` file in every workspace must sit under one of six named directories, which is what makes
each package's hand-written `bun test <path> <path> …` argument list complete
(`tooling/lib/source-policy.ts`, `tooling/checks/source-policy.ts`). **Process-global
mutation**: `mock.module()` is banned outright — zero allowlist entries across package source,
tests and tooling plus repository tooling (`tooling/checks/source-policy.ts`) — and empty promise catches are budgeted
against a one-entry baseline (`tooling/checks/source-policy.ts`). **Coverage honesty**:
`tooling/checks/coverage.ts` sums each package's LCOV counters against a per-package floor *and*
separately requires that every `src` module produced an `SF:` record at all, so a floor cannot be
held over a denominator that is missing files nothing imports
(`tooling/checks/coverage.ts`).

The whole thing runs sequentially, fail-fast, from one npm script: `check:pre-commit` is a seven-link
`&&` chain (`package.json`, `scripts.check:pre-commit`).

## 2. Surface

### 2.1 Root npm scripts (the gate and its phases)

| Script | Definition | Source |
| --- | --- | --- |
| `check:pre-commit` | `format:check && build && typecheck && lint:eslint && lint:intent && knip && test:coverage` | `package.json` (`scripts.check:pre-commit`) |
| `format:check` | workspace format checks plus root tooling, authored public docs and the docs workflow | `package.json` (`scripts.format:check`) |
| `build` | `build:packages` followed by the `@clarvis/code` bundle | `package.json` (`scripts.build`) |
| `typecheck` | workspace typechecks plus `typecheck:tooling` | `package.json` (`scripts.typecheck`) |
| `lint` | `lint:eslint && lint:intent && knip` | `package.json` (`scripts.lint`) |
| `lint:eslint` | workspace lint plus the root tooling ESLint project | `package.json` (`scripts.lint:eslint`) |
| `lint:intent` | `test:tooling`, then source policy, graph, spec, harness, Bun-version, Bun-source, import-extension and release-readiness checks | `package.json` (`scripts.lint:intent`) |
| `check:graph` | `bun run tooling/checks/package-graph.ts --check-doc` | `package.json` (`scripts.check:graph`) |
| `check:specs` | `bun run tooling/checks/spec-hygiene.ts` | `package.json` (`scripts.check:specs`) |
| `check:bun-version` | `bun run tooling/checks/bun-version.ts` | `package.json` (`scripts.check:bun-version`) |
| `check:bun-sources` | `bun run tooling/checks/bun-sources.ts` | `package.json` (`scripts.check:bun-sources`) |
| `knip` | `knip` | `package.json` (`scripts.knip`) |
| `test:coverage` | `bun --workspaces --sequential --if-present test:coverage && bun run coverage:check` | `package.json` (`scripts.test:coverage`) |
| `coverage:check` | `bun run tooling/checks/coverage.ts` | `package.json` (`scripts.coverage:check`) |
| `test` | `test:tooling` followed by 18 package tests chained with `&&`, in dependency order | `package.json` (`scripts.test`) |
| `hooks:install` | `git config core.hooksPath .githooks` | `package.json` (`scripts.hooks:install`) |
| `smoke` | `bun --filter @clarvis/code smoke` | `package.json` (`scripts.smoke`) |
| `release:prepare` | `bun run tooling/release/prepare.ts <version>` | `package.json` (`scripts.release:prepare`) |

Note that `check:pre-commit` spells out `lint:eslint && lint:intent && knip` rather than calling
`lint`; the effect is identical (`package.json`, `scripts.lint` and `scripts.check:pre-commit`).

`check:specs` scans tracked and unignored Markdown and source files for dangerous characters and
documentation-link failures. It also rejects line-qualified repository references, resolves
explicit repository paths to tracked files, and rejects calendar dates and source-code line-count
inventories in tracked specs so release chronology stays in `CHANGELOG.md` and implementation size
does not masquerade as a contract. URLs, absolute paths, parent traversal, and visibly illustrative
placeholders are excluded. Production: `tooling/checks/spec-hygiene.ts` and
`tooling/lib/spec-hygiene.ts`
(`extractLineQualifiedReferences`, `extractRepositoryFileReferences`,
`resolveRepositoryFileReference`, `extractCalendarDates`, `extractSourceSizeReferences`). Test:
`tooling/tests/unit/spec-hygiene.test.ts` (`stable source references`, `timeless specifications`).

Repository validation skills share scope and evidence reuse through
[`AGENTS.md`](../../AGENTS.md#repository-skills-and-evidence-reuse). The TUI skill selects focused,
performance, or full-audit work from one entrypoint; documentation synchronization maintains its
inventory without executing E2E. The standalone static inventory check compares registered slash
commands and Settings panel labels with matrix rows, requires dynamic-command scenarios, and
rejects duplicate IDs regardless of Markdown cell padding. Prose mentions do not count as rows.
Its result proves inventory consistency only, never execution of a product scenario.
Production: [the checker](../../.agents/skills/clarvis-tui-validation/scripts/check-live-inventory.ts)
and `tooling/lib/tui-inventory.ts` (`inspectTuiInventory`). Test:
`tooling/tests/unit/tui-inventory.test.ts` (`static TUI inventory`) covers padding-independent counts,
duplicate rejection, missing/stale registrations, dynamic rows, and command argument normalization.

### 2.2 The six test levels

`TEST_LEVELS` is a `Set` of exactly six names (`tooling/lib/source-policy.ts`):

```
architecture · component · contract · e2e · integration · unit
```

### 2.3 Exported checker API

| Symbol | Signature | Source |
| --- | --- | --- |
| `findModuleMockCalls(file, source)` | `→ {file, line, column}[]` | `tooling/lib/source-policy.ts` |
| `findUnclassifiedTestFiles(files)` | `string[] → string[]` | `tooling/lib/source-policy.ts` |
| `readOwnSourceCoverage(packageName, root?)` | `→ {functions, lines, measured:Set<string>}` | `tooling/checks/coverage.ts` |
| `findUnmeasuredSources(packageName, measured, root?)` | `→ {unmeasured, runtimeExports, stale}` | `tooling/checks/coverage.ts` |
| `checkCoverage(root?)` | `→ Promise<void>`, throws `AggregateError` | `tooling/checks/coverage.ts` |
| `pythonSourcePaths(paths)` | `string[] → string[]`, sorted `.py` / `.pyi` / `.pyw` matches | `tooling/checks/bun-sources.ts` |
| `repositoryPaths(root)` | `→ string[]`, tracked plus unignored existing paths | `tooling/checks/bun-sources.ts` |
| `extractLineQualifiedReferences(text)` | finds repository paths and prose that encode unstable source line locators | `tooling/lib/spec-hygiene.ts`, `extractLineQualifiedReferences` |
| `extractRepositoryFileReferences(text)` | extracts explicit paths rooted in repository-owned trees | `tooling/lib/spec-hygiene.ts`, `extractRepositoryFileReferences` |
| `resolveRepositoryFileReference(reference, file, tree)` | reports explicit repository files that do not exist | `tooling/lib/spec-hygiene.ts`, `resolveRepositoryFileReference` |
| `extractCalendarDates(text)` | finds literal calendar dates in common numeric and English month-name forms so tracked specs remain timeless | `tooling/lib/spec-hygiene.ts`, `extractCalendarDates` |
| `extractSourceSizeReferences(text)` | finds inventory-style source-code line counts while preserving behavioral limits and coverage ratios | `tooling/lib/spec-hygiene.ts`, `extractSourceSizeReferences` |
| `parseModuleEdges(source, fileName?)` | `→ {specifier, kind, typeOnly, line}[]` | `tooling/lib/package-graph.ts` |
| `analyzePackageGraph(root)` | `→ report` | `tooling/lib/package-graph.ts`, `analyzePackageGraph` |
| `renderMarkdown(report)` | `→ string` (English role/dependency table and Mermaid graph) | `tooling/lib/package-graph.ts`, `renderMarkdown` |
| `checkDocument(report, document)` | `→ string[]` | `tooling/lib/package-graph.ts`, `checkDocument` |
| `compareReleaseVersions(left, right)` | exact SemVer ordering | `tooling/lib/release-prepare.ts` |
| `prepareReleaseSources(sources, version, date)` | validated in-memory release mutation | `tooling/lib/release-prepare.ts` |

The checker logic is safely importable from a test in both cases, but the two scripts get there by
different mechanisms. `coverage.ts` self-invokes only when it *is* `process.argv[1]`
(`tooling/checks/coverage.ts`), a single-file guard, so importing that same file from a test
does not run the check. `package-graph.ts` has no such guard at all: it calls
`analyzePackageGraph`/`checkDocument`/`renderMarkdown` unconditionally the moment the file is loaded
(`tooling/checks/package-graph.ts`) — so it must never be imported from a test. Its "dual
purpose" is achieved instead by splitting the logic into two files: the importable library,
`tooling/lib/package-graph.ts` (no guard needed — it only exports functions, nothing runs on load),
and the CLI-only `tooling/checks/package-graph.ts`, which a test reaches only through its exported
functions, never through the script itself.

### 2.4 CLI flags

| Script | Flag | Effect | Source |
| --- | --- | --- | --- |
| `package-graph.ts` | `--check-doc` | also validates `specs/package-coupling-analysis.md`'s table | `tooling/checks/package-graph.ts` |
| `package-graph.ts` | `--json` | prints the full report as JSON instead of the Markdown table | `tooling/checks/package-graph.ts` |

### 2.5 `./testing` subpaths packages publish

Five packages export a `./testing` entry (from each `package.json` `exports` map):

| Package | Target | Shape | Cross-package consumers |
| --- | --- | --- | --- |
| `@clarvis/loop` | `src/testing/index.ts` | `MockLLM`, `mockMCPFactory`, fresh real-loop MCP/trace infrastructure, and `validateBody` (`packages/loop/src/testing/index.ts`, exports) | `kernel`, `memory` |
| `@clarvis/memory` | `src/testing.ts` | in-memory adapter + `memoryStoreConformance()` case table (`packages/memory/src/testing.ts`) | `kernel` |
| `@clarvis/plan` | `src/testing.ts` | in-memory repository + `planRepositoryConformance()` / `planStoreConformance()` (`packages/plan/src/testing.ts`) | `kernel` |
| `@clarvis/trace` | `src/testing.ts` | `createMemoryTraceStore()` only (`packages/trace/src/testing.ts`) | `kernel`, `loop` |
| `@clarvis/tasks` | `src/testing/provider-conformance.ts` | `assertTaskProviderConformance(fixture)` (`packages/tasks/src/testing/provider-conformance.ts`) | none |

The consumer column is the set of packages that import the specifier `@clarvis/<pkg>/testing`
anywhere under `packages/*/{src,tests}`; `tasks` is consumed only through a relative
`../../src/testing.ts` import inside its own suite
(`packages/tasks/tests/component/conformance.test.ts`).

`@clarvis/loop`'s is the most used entry of the five, and the doubles behind it are the substrate
almost every engine test stands on, so what they can be *made to do* is worth stating rather than
leaving to be read off a fixture. `packages/loop/src/testing/index.ts` publishes them, the exports
map points `./testing` at that barrel (`packages/loop/package.json`), and inside the package they
are re-exported once more through `packages/loop/tests/helpers/fixtures.ts`, which is how 117 of
`loop`'s own test files reach `MockLLM` and 112 reach `mockMCPFactory`. Across packages `MockLLM`
travels to Kernel and Memory, while Memory also consumes `createTestRunInfrastructure` and
`createTestTraceStore` so its real-loop suites do not import MCP Client or Trace directly
(`packages/memory/tests/helpers/indexer-runtime.ts`, `fakeIndexerRuntime`). `mockMCPFactory` has no
consumer outside Loop.

**`MockLLM` is a script, a cursor and a recorder** (`packages/loop/src/testing/mock-llm.ts`). It is
constructed with `{ script, routes? }` (`packages/loop/src/testing/mock-llm.ts`) and consumes one
step per `call`, in order (`packages/loop/src/testing/mock-llm.ts`). A step is a partial provider
response (`packages/loop/src/testing/mock-llm.ts`):

| Field | Effect | Default when omitted |
| --- | --- | --- |
| `text`, `reasoning`, `reasoningParts` | the assistant turn's content | `text` is set to `undefined`; the two reasoning fields are omitted from the result object entirely |
| `toolCalls: {id?, name, arguments?}[]` | the calls the turn requests | `id` becomes `call_<index>`, `arguments` becomes `{}` |
| `usage` | a `Partial` of the four counters | `10` input, `5` output, `0` cached, `0` cache-write |
| `finishReason` | the provider's stop reason; `"length"` is how a truncated answer is reported | omitted from the result |
| `throw` | fails the call instead of answering it | – |
| `delayMs` | holds the call open before it answers or throws | returns immediately |

Two behaviours are load-bearing and easy to lose. **Every call's params are recorded with a
`structuredClone` of `messages`** (`packages/loop/src/testing/mock-llm.ts`), so an assertion
about request *n* sees the window as it stood at call *n* rather than as later iterations mutated it —
which is what makes the prefix-stability checks possible at all. And **the abort signal is honoured both
before and during a delay**: an already-aborted signal throws the signal's own reason, or a
`DOMException("Mock model call aborted.", "AbortError")` when the reason is not an `Error`
(`packages/loop/src/testing/mock-llm.ts`), and a `delayMs` wait rejects the same way on abort
rather than running to completion (`packages/loop/src/testing/mock-llm.ts`) — deliberately, "so
timeout tests cannot accidentally prove that detached model work is acceptable"
(`packages/loop/src/testing/mock-llm.ts`). The step is consumed *before* the abort check, so an
aborted call still spends its script entry.

**`routes` exist because one cursor cannot describe a concurrent tree.** A route is
`{name, when(params), script}` with a cursor of its own; routes are tried in order, the first whose
`when` matches claims the call, and a call matching none falls back to the bare `script`
(`packages/loop/src/testing/mock-llm.ts`). The source states the failure this
avoids: a single cursor "can only express a tree whose agents take strict turns — fine while a spawn
blocks its parent, and wrong the moment one does not: a parent and a background child are genuinely
concurrent, and a single cursor hands whichever gets there first the other's lines"
(`packages/loop/src/testing/mock-llm.ts`). Running out is always an error, never a silent stall,
and a drained route names itself: `MockLLM exhausted (call #N); add more script steps.`
(`packages/loop/src/testing/mock-llm.ts`) or `MockLLM route '<name>' exhausted (call #N); add more
steps.` (`packages/loop/src/testing/mock-llm.ts`).

**`mockMCPFactory(byName)` returns an `MCPClientFactory` over a map of server name to scripted server**
(`packages/loop/src/testing/mock-mcp.ts`). A tool is `{name, description?, inputSchema?, call}`
(`packages/loop/src/testing/mock-mcp.ts`) and a resource is
`{uri, name, mimeType?, description?, text?, blob?}` (`packages/loop/src/testing/mock-mcp.ts`).
What can be injected, and where each fault lands:

| Knob | Behaviour | Source |
| --- | --- | --- |
| server name absent from `byName` | connection throws `No mock MCP configured for tool '<name>'` | `packages/loop/src/testing/mock-mcp.ts` |
| `connectDelayMs` | delays the connection; applied *before* `connectError` | `packages/loop/src/testing/mock-mcp.ts` |
| `connectError` | fails the connection | `packages/loop/src/testing/mock-mcp.ts` |
| `listToolsError` | fails only `listTools`; the connection still succeeds | `packages/loop/src/testing/mock-mcp.ts` |
| a tool's `call` returning a value | wrapped as one `text` content part, `JSON.stringify`d unless already a string | `packages/loop/src/testing/mock-mcp.ts` |
| a tool's `call` throwing | surfaced as an `isError: true` tool result, **not** a rejected promise | `packages/loop/src/testing/mock-mcp.ts` |
| an unknown tool name | `callTool` throws `Tool '<name>' not found` | `packages/loop/src/testing/mock-mcp.ts` |
| `resources` present or absent | gates the advertised capability: `{resources:{}}` versus `undefined` | `packages/loop/src/testing/mock-mcp.ts` |
| a resource's `blob` | returned as binary content; otherwise `text`, defaulting to `""` | `packages/loop/src/testing/mock-mcp.ts` |
| an unknown resource uri | `readResource` rejects `Resource '<uri>' not found` | `packages/loop/src/testing/mock-mcp.ts` |

An omitted `inputSchema` defaults to `{type:"object", properties:{}}`
(`packages/loop/src/testing/mock-mcp.ts`), `listResourceTemplates` always answers with an empty array
(`packages/loop/src/testing/mock-mcp.ts`), and `listResources` **omits** an absent `mimeType` or
`description` rather than setting it to `undefined` (`packages/loop/src/testing/mock-mcp.ts`) —
the same absent-not-`undefined` discipline the wire types elsewhere require. Closing is one flag shared
by the handle and the client (`packages/loop/src/testing/mock-mcp.ts`), and it is
**partial on purpose**: after close, `callTool` throws and `readResource` rejects with
`MCP '<name>' is closed` (`packages/loop/src/testing/mock-mcp.ts`), while `listTools`,
`listResources` and `getServerCapabilities` keep answering — so a test can assert that dispatch is dead
without the registry it was built from disappearing underneath it.

### 2.6 `bunfig.toml` keys

| Key | Root value | Per-package value | Source |
| --- | --- | --- | --- |
| `[install] linker` | `"hoisted"` | absent | `bunfig.toml` |
| `[test] preload` | `["./tooling/test-runtime/clarvis-home-preload.ts"]` | present in 17 of 18 packages; absent only from type-only `protocol` | `bunfig.toml` |
| `[test] coverageReporter` | `["text","lcov"]` | same in all 18 | `bunfig.toml` |
| `[test] coverageDir` | `"coverage"` | same in all 18 | `bunfig.toml` |
| `[test] coverageSkipTestFiles` | `true` | same in all 18 | `bunfig.toml` |
| `[test] coveragePathIgnorePatterns` | **absent** | `["../**"]` in all 18 | e.g. `packages/loop/bunfig.toml` |
| `[test] timeout` | **deliberately absent** | absent everywhere | `bunfig.toml` |
| `[test] coverageThreshold` | absent | absent | (grep of all 19 bunfigs returns nothing) |

The timeout omission remains measured rather than inherited folklore. A direct Bun 1.4.0 check
confirmed that `timeout = 60000` is ignored in both root-like and package-local scratch
`bunfig.toml` files: a
5.25-second test failed at the default 5 seconds in both locations. Every package therefore keeps
`--timeout 60000` on the actual `bun test` command line.

## 3. Data and formats

### 3.1 Test-path grammar

`findUnclassifiedTestFiles` normalises `\` to `/`, then applies two filters
(`tooling/lib/source-policy.ts`):

```
file matches  /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/   → candidate, else ignored entirely
segment after the LAST "/tests/" in the path        → must be one of TEST_LEVELS
```

So the accepted shape is `…/tests/<level>/**/*.test.{ts,tsx,js,jsx,mts,cts,mjs,cjs}`. Two forms are
explicitly pinned as *rejected* by the unit test: a flat
`packages/<name>/tests/<case>.test.ts` and a hidden
`packages/<name>/tests/helpers/<case>.test.ts`
(`tooling/tests/unit/source-policy.test.ts`). Windows-shaped paths are normalised
(`tooling/tests/unit/source-policy.test.ts`).

Actual population across the 18 workspaces (921 `*.test.*` files, counted by the first segment
under `tests/`):

| Level | Files |
| --- | ---: |
| `unit` | 408 |
| `integration` | 344 |
| `component` | 102 |
| `architecture` | 51 |
| `contract` | 16 |
| `e2e` | **0** |

Non-level directories under `tests/` exist and are legal because they contain no `*.test.*`
file: `helpers` (16 packages) and `fixtures` (5). Three loose non-test modules sit directly under
`packages/loop/tests/` — `bun-test.ts`, `env-section.ts`, `prefix-stability.ts`.

### 3.2 The LCOV subset `coverage.ts` consumes

Records are split on the literal `end_of_record` and only four numeric fields are read, via
`field()` (`tooling/checks/coverage.ts`):

| Field | Meaning in the aggregate |
| --- | --- |
| `SF:` | source path; resolved against the package dir, kept only if it lands under `src/` |
| `FNF` / `FNH` | functions found / hit, summed across records |
| `LF` / `LH` | lines found / hit, summed across records |

A real record, `packages/protocol/coverage/lcov.info` as it stands in the tree:

```
TN:
SF:src/index.ts
FNF:0
FNH:0
LF:0
LH:0
end_of_record
```

That is `linesFound === 0`, which for a `TYPE_ONLY_PACKAGES` member short-circuits to a synthetic
`{functions: 1, lines: 1}` (`tooling/checks/coverage.ts`) — protocol's reported 100 % is by
declaration, not by measurement.

Bun 1.4 assigns a distinct LCOV line to a multiline `catch` token even when the handler body runs.
Where a defensive filesystem fault cannot be induced deterministically after a directory handle is
opened, `packages/workflows/src/artifact.ts` keeps the `try` and handler on the guarded source line;
the production fault path remains present and the workflows package retains its 100% source-line
floor without lowering a threshold.

### 3.3 Per-package floors

`PACKAGE_THRESHOLDS` (`tooling/checks/coverage.ts`) has one entry per workspace:

| Package | min functions | min lines |
| --- | ---: | ---: |
| capability | 1.00 | 1.00 |
| code | 0.93 | 0.96 |
| hooks | 1.00 | 1.00 |
| kernel | 0.94 | 0.97 |
| llm | 1.00 | 1.00 |
| loop | 0.96 | 0.98 |
| mcp-client | 0.90 | 0.98 |
| memory | 0.90 | 0.95 |
| paths | 1.00 | 1.00 |
| plan | 0.95 | 0.97 |
| protocol | 1.00 | 1.00 |
| server | 0.90 | 0.96 |
| skills | 1.00 | 1.00 |
| supervision | 0.98 | 1.00 |
| tasks | 0.95 | 0.98 |
| tools | 0.98 | 0.98 |
| trace | 0.98 | 0.97 |
| workflows | 1.00 | 1.00 |

Three packages share the lowest function floor at 0.90: `mcp-client`, `memory` and `server`.

Output line format is fixed (`tooling/checks/coverage.ts`):

```
loop       functions 99.07% (min 96.00%) pass; lines 98.98% (min 98.00%) pass
```

### 3.4 `NO_COUNTER_ALLOWLIST`

A map from short package name to package-relative `src/` paths that are permitted to produce no
LCOV record (`tooling/checks/coverage.ts`). Its own comment names three legitimate,
permanent reasons — a type-only module, a pure re-export barrel, and an executable entry point a
test cannot import without starting the process it boots (`tooling/checks/coverage.ts`) — and
records that a fourth, `GRANDFATHERED`, was never legitimate and no longer has any entry
(`tooling/checks/coverage.ts`).

| Package | Type-only | Barrel | Entry point | GRANDFATHERED |
| --- | ---: | ---: | ---: | --- |
| capability | 8 | – | – | – |
| code | 4 | – | 3 (`src/cli.ts`, `src/index.tsx`, `src/runtime.tsx`) | – (former `src/adapters/kernel-capabilities-client.ts` entry removed) |
| hooks | – | – | – | – (empty array) |
| kernel | 5 | – | 1 (`src/bin.ts`) | – |
| loop | – | 4 (`host`, `lib`, `workflows`, `workspace`) | – | – (former `src/version.ts` and `src/settings/marketplace-schema.ts` entries removed) |
| memory | 4 | – | – | – |
| server | – | – | 1 (`src/bin.ts`) | – |
| skills | 1 | – | – | – |
| supervision | – | 1 | – | – |
| tasks | 2 | – | – | – |
| tools | 4 | 1 (`src/shell-entry.ts`) | – | – |
| trace | 1 | – | – | – |
| workflows | 1 | 1 | – | – |

The **barrel** reason turns on the *form* of the re-exports rather than on the word. All four `loop`
entries are the package's entry-point barrels, and each spells its statements as a named list —
`export { VERSION } from "./version.ts"` (`packages/loop/src/lib.ts`),
`export { ownerFromWorkspace } from "./workspace.ts"` (`packages/loop/src/host.ts`) — which is the
shape the allowlist's own comment says "emits no counters of its own"
(`tooling/checks/coverage.ts`). The package's three *internal* barrels are absent from the list
and pass anyway: `packages/loop/src/runtime/budget/index.ts`,
`packages/loop/src/runtime/guards/index.ts` and `packages/loop/src/runtime/support/index.ts`
spell theirs `export *`, and every one of them is imported by tests
(`packages/loop/tests/unit/budget.test.ts`, `packages/loop/tests/unit/doom-loop-guard.test.ts`,
`packages/loop/tests/unit/stringify.test.ts`). Since `findUnmeasuredSources` fails any `src` module
that neither produced an `SF:` record nor is named on the list (`tooling/checks/coverage.ts`),
their staying off it is the gate's own evidence that an `export *` line does carry a counter where a
named re-export does not.

Five packages have **no** key at all and fall through `?? []` (`tooling/checks/coverage.ts`):
`llm`, `mcp-client`, `paths`, `plan`, `protocol`. No `GRANDFATHERED` entries remain; see §8 item 10.

The `server/src/bin.ts` entry carries the longest justification in the file
(`tooling/checks/coverage.ts`): its behaviour *is* tested, by real subprocess tests, but
"Bun's coverage instrumentation only sees code running inside the `bun test` process itself, so a
subprocess contributes no counters here no matter how thoroughly it is tested". The same
cross-reference is written from the other side, in the test:
`packages/server/tests/architecture/bin-bind-gate.test.ts`.

`TYPE_ONLY_PACKAGES` is a separate one-member set, `{"protocol"}`
(`tooling/checks/coverage.ts`).

### 3.5 The package-graph report

`analyzePackageGraph` returns `{packageCount, edgeCount, optionalEdgeCount, packages[], cycles,
compilationCycles, moduleCycles, errors[]}` (`tooling/lib/package-graph.ts`,
`analyzePackageGraph`). Each package row carries
`sourceEdges: {compilation, eagerRuntime, dynamicRuntime, typeOnly}` and
`runtimeClosure: {eager, dynamic}`. `renderMarkdown` emits an English table with the
package's semantic role, direct dependencies and consumer count; optional dependencies use
the suffix `(optional)`. `checkDocument` compares the complete generated block against that output
(`tooling/lib/package-graph.ts`, `renderMarkdown` and `checkDocument`).

Running the analyzer against the tree today: 18 packages, 47 internal edges, 3 optional edges, zero
`errors`.

### 3.6 Per-package `test` / `test:coverage` argument lists

Two shapes exist. Seven packages run `bun test` with **no path filter** — `hooks`, `loop`,
`mcp-client`, `memory`, `plan`, `skills`, `tools` — so every level present is collected. The rest
name their levels explicitly. Six packages deliberately run `architecture` *outside* the coverage
pass, as `… --coverage && bun run test:architecture`:

| Package | levels under `--coverage` | architecture run separately | architecture files |
| --- | --- | --- | ---: |
| capability | unit, integration | yes | 1 |
| code | unit, component, integration | yes | 8 |
| kernel | unit, component, contract, integration | yes | 5 |
| paths | unit, component, contract, integration | yes | 3 |
| tasks | unit, component | yes | 1 |
| trace | unit, component, contract, integration | yes | 1 |
| llm / server / workflows | …including architecture | no | 1 / 4 / 1 |

19 of the 50 architecture test files therefore contribute no `SF:` records at all, which means in
those six packages every `src` module must be reached from a *non*-architecture test or be
allowlisted.

`@clarvis/protocol` is the outlier: its `test`, `test:coverage` and `test:contract` are all
`tsc -p tsconfig.json` (`packages/protocol/package.json`), i.e. its contract suite is a type-check
over `tests/contract/public-contract.fixture.ts`, a file of `satisfies` assertions against the
public DTOs (`packages/protocol/tests/contract/public-contract.fixture.ts`).

Every `bun test` script in the repository carries `--timeout 60000`; `workflows` additionally
carries `--isolate` (`packages/workflows/package.json`). `loop` deliberately uses Bun's
shared-global default after the Bun 1.4 qualification measured an 84.9% isolation penalty and five
consecutive complete shared-global runs passed; its package README records the samples and the
state-restoration evidence.

### 3.7 What a line counter cannot see

**Bun attributes a line inside a `catch` body coarsely, to the enclosing `try`.** `@clarvis/paths` once
reported 100% lines against a 1.00 floor while three `lost = true;` catch bodies had never executed
once: the `DA` counter on those lines was satisfied by the `try` around them. The defect surfaced only
when the reporters were extracted into named functions, which forced Bun to count them as their own
units.

Two consequences, and both are repository-wide rather than properties of the package that found it:

- **A line floor is weakest exactly where diagnostics matter most** — the error paths a `catch` exists
  to report. "100% lines" on a module full of `catch` blocks is not evidence its failure paths run.
- **Extracting a `catch` body into a named function is what makes it measurable**, not merely tidier.
  Prefer that shape for any `catch` that emits an event.

Production modules that carry this shape document it locally, including
`packages/plan/src/store.ts` and the corresponding Code boot failure path.

## 4. Behavior

### 4.1 The gate, in the order it runs

`git commit` → `.githooks/pre-commit` resolves the repo root, `cd`s to it and `exec`s
`bun run check:pre-commit`. The hook is only wired up if
`core.hooksPath` points at `.githooks`, which is what `bun run hooks:install` sets
(`package.json`, `scripts.hooks:install`). Then, sequentially
(`package.json`, `scripts.check:pre-commit`):

| # | Phase | Internal fan-out | What it can catch |
| --- | --- | --- | --- |
| 1 | `format:check` | `--parallel` across workspaces, then root Prettier | package formatting plus root tooling and repository workflows |
| 2 | `build` | `build:packages`, then `build:code` | library emit and `.d.ts` for the reference graph, then the TUI bundle |
| 3 | `typecheck` | `--parallel` across workspaces, then `typecheck:tooling` | every package's `tsconfig.json`, all of which `include` `tests`, plus root tooling |
| 4 | `lint:eslint` | `--parallel` across workspaces, then `lint:tooling` | package lint plus the root tooling ESLint project |
| 5 | `lint:intent` | strictly serial, 9 links | `test:tooling`, then source policy, package graph, spec hygiene, test harness, Bun-version consistency, the no-Python-source check, import-extension policy and release readiness |
| 6 | `knip` | one process, whole monorepo | unused files/exports/dependencies |
| 7 | `test:coverage` | `--sequential --if-present`, then `coverage:check` | every suite, then the floors and the module inventory |

Two orderings are load-bearing from the code alone. `build` precedes `typecheck` because every
package's `tsconfig.json` resolves cross-package types either through built `dist/*.d.ts` or through
an explicit `paths` mapping into a sibling's `src` (`packages/kernel/tsconfig.json` maps 22
specifiers, `packages/memory/tsconfig.json` maps 6) — the packages without such a mapping have only
`dist`. And `coverage:check` runs *after* the suites in the same `&&` chain
(`package.json`, `scripts.test:coverage`), because it reads the `coverage/lcov.info` those suites
write.

### 4.2 `source-policy.ts`

1. Walk `packages/`, and for each entry collect `src` recursively into both `sourceFilesToCheck` and
   `moduleMockFiles`, then collect `tests` and `tooling` into `moduleMockFiles` only (`tests` also
   into `packageTestFiles`). `ENOENT` on any of these is swallowed; any other error rethrows
   (`tooling/checks/source-policy.ts`).
2. Append every file under the repository's own `tooling/` to `moduleMockFiles`
   (`tooling/checks/source-policy.ts`).
3. **Empty-promise-catch budget** — for each `src` file, count matches of
   `/\.catch\(\(\)\s*=>\s*\{\s*\}\)/g` and compare against `baseline.get(file) ?? 0`. The map has exactly one entry: `packages/capability/src/tasks.ts → 1`. That one occurrence is `suppressSecondaryRejection`'s
   `void Promise.resolve(promise).catch(() => {})`
   (`packages/capability/src/tasks.ts`). The two empty `catch {}` *blocks* in the same file
    are not matched by the regex; they are governed instead by ESLint's
   `no-empty: ["error", {allowEmptyCatch: true}]` (`eslint.config.base.js`).
4. **`mock.module()` ban** — for each file in `moduleMockFiles`, parse it with the TypeScript AST
   and report every `CallExpression` whose callee is a `PropertyAccessExpression` of the identifier
   `mock` with property name `module` (`tooling/lib/source-policy.ts`). There is no allowlist
   and no baseline. The script never writes the literal string, assembling the label as
   `["mock", ".module()"].join("")` so that the checker does not trip itself
   (`tooling/checks/source-policy.ts`).
5. **Level classification** — run `findUnclassifiedTestFiles(packageTestFiles)`; each hit becomes
   `"<file>: test file must live under tests/{unit,component,contract,integration,architecture,e2e}"`.
   Repository checker tests live under the same named levels in
   `tooling/tests/{unit,architecture}` and are invoked by `test:tooling`.
6. If anything failed, print `Task-intent violations:` followed by every failure and the remedy
   sentence — "Use dependency injection instead of `mock.module()`; use bestEffort, detachObserved,
   or suppressSecondaryRejection instead of empty catches" — and set `process.exitCode = 1`. It reports **all** violations, never the first.

Current state: the script exits 0, and a repo-wide search for `mock.module`, `vi.mock` and
`jest.mock` returns zero hits.

### 4.3 `coverage.ts`

For each of the 18 entries in `PACKAGE_THRESHOLDS`, in object order
(`tooling/checks/coverage.ts`):

1. `readOwnSourceCoverage` reads `packages/<pkg>/coverage/lcov.info` with a bare `readFile`. On
   `ENOENT` it rethrows *unless* the package is in `TYPE_ONLY_PACKAGES`, in which case it first
   `readdir`s the package's `src/` — so a missing report is excused but a missing package is not —
   and returns `{functions: 1, lines: 1, measured: new Set()}`.
2. Records are split on `end_of_record`; a record with no `SF:` line is skipped. The `SF:` path is
   resolved against the package directory and kept only if the package-relative result is `src` or
   starts with `src/` — this is the "own source" filter, and it is what makes the per-package
   `coveragePathIgnorePatterns = ["../**"]` a belt-and-braces measure rather than the only one.
3. If `linesFound` is still 0: a type-only package returns the synthetic `{1, 1}`, anything else
   throws `` `${packageName}: LCOV report contains no own-source line data` ``.
4. Ratios: `functionsFound === 0 ? 1 : hit/found` for functions, `linesHit/linesFound` for lines. Note the asymmetry — a package with zero functions scores 1, a package with zero
   lines has already thrown.
5. The two ratios are compared with `>=` against the floor and one line per package is printed.
6. `findUnmeasuredSources` walks the package's `src/` for `.ts`/`.tsx` excluding `.d.ts`
    and then branches :
   - **type-only package**: every module is read and run through `looksExecutionFree`; anything with
     a runtime export lands in `runtimeExports`. `measured` is ignored entirely, so a stale LCOV
     record cannot excuse a runtime export.
   - **ordinary package**: a module that is neither in `measured` nor in the allowlist lands in
     `unmeasured`.
   - `stale` is computed either way: allowlist entries that were in fact measured, or that name a
     file that no longer exists.
7. `unmeasured` and `runtimeExports` become failures with a remedial sentence naming
   `NO_COUNTER_ALLOWLIST in tooling/checks/coverage.ts`. `stale` is deliberately
   **not** a failure — it is logged, under the comment "a stale entry is someone having closed a gap
   or deleted a file, and breaking their build for it would be a poor thank-you".
8. All failures across all packages are collected and thrown as one
   `AggregateError(failures, "Own-source coverage checks did not pass")`; success
   prints `All own-source coverage thresholds passed, over every src module.`.

`looksExecutionFree` strips block and line comments, deletes `export type …` lines, and
then tests for any of: `export default`, `export [async|abstract]* const|let|var|function|class|enum`
(with `const enum` excluded via a negative lookahead), `export * [as X] from`, or
`export { … } from|;`. Its own docblock calls it "a heuristic over syntax, not a type checker". It is
reachable only through the `TYPE_ONLY_PACKAGES` branch, currently for `@clarvis/protocol`.

### 4.4 `stream-metrics-drift.test.ts`

Two files are declared duplicates by construction:
`packages/llm/src/stream-metrics.ts` and `packages/code/src/adapters/stream-metrics.ts`
(`tooling/tests/architecture/stream-metrics-drift.test.ts`).

`normalize()` does two things: it rewrites the **first** match of
`/source\s*=\s*["'](?:loop|code)["']/` to `source = "owner"` — the one authorised difference, which
is each copy's default `source` tag (`packages/llm/src/stream-metrics.ts` vs
`packages/code/src/adapters/stream-metrics.ts`) — and then runs a TypeScript `Scanner` with
`skipTrivia = true`, joining the token texts with `\0`. Because trivia is skipped, the two files may
carry entirely different TSDoc prose and still compare equal; they do, and the diff between them is
prose plus that one default.

The first Bun test asserts both directions: a comment-bearing `source = "loop"` normalises equal to
`source = "code"`, while `const value = 1` does **not** normalise equal to `const value = 2`. The
second test reads both production files and requires the normalized token streams to match. Both are
ordinary Bun tests using `expect`; a mismatch is reported by the test runner rather than by custom
stderr or `process.exitCode` handling
(`tooling/tests/architecture/stream-metrics-drift.test.ts`, tests "the normalizer permits only the
owner-specific default" and "the two production stream metrics implementations stay
token-identical").

The duplication itself has a reason stated in the source: the copies exist because "the packages do
not share a dependency edge, and a debug counter is not worth minting one"
(`packages/llm/src/stream-metrics.ts`).

### 4.5 `package-graph.ts`

`analyzePackageGraph` walks each workspace's `src`, `tests` and `tooling` trees
(`tooling/lib/package-graph.ts`), parses every module edge through the TypeScript AST, and emits the following errors (all deduplicated and sorted):

| Error | Condition | File |
| --- | --- | --- |
| `unknown workspace package X` | a `@clarvis/*` specifier naming no workspace | `package-graph.ts` |
| `source imports its own public entrypoint X` | a `src` file importing its own package root specifier | and again by resolved target |
| `imports undeclared dependency X` | any tree imports a workspace not in any dep field | `package-graph.ts` |
| `imports runtime dependency X … declared only for development` | a **`src`** value import of a devDependency-only workspace | `package-graph.ts` |
| `X is not exported by Y` | the requested subpath is absent from the target's `exports`, evaluated under runtime vs type-only condition sets | `package-graph.ts` |
| `relative import crosses into X` | a `./…` specifier resolving inside another package's directory | `package-graph.ts` |
| `declares unknown workspace dependency X` / `declares unused internal dependency X` | manifest vs actual usage | `package-graph.ts` |
| `dependency without project reference X` / `project reference without runtime dependency X` | `tsconfig.build.json` references vs runtime deps | `package-graph.ts` |
| `root tsconfig missing/unknown project reference X` | root solution file vs the set of packages with a `tsconfig.build.json` | `package-graph.ts` |
| `dependency cycle: …` | Tarjan SCC over declared runtime deps | `package-graph.ts` |
| `compilation cycle: …` | Tarjan SCC over all source edges, reported only when not already a declared cycle | `package-graph.ts` |
| `X: runtime module cycle: …` | Tarjan SCC over intra-package value edges | `package-graph.ts` |

`DEP_FIELDS` (`tooling/lib/package-graph.ts`) is
`["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]` — a fourth field,
`peerDependencies`, is co-equal with the other three in `pkg.declared` and therefore
participates in the unknown/unused-dependency checks above, but it is absent from `runtimeDeclared`
(built only from `dependencies` and `optionalDependencies`), so a `peerDependencies` entry
is invisible to the devDependency-only-import check and to the project-reference checks. No package
in the tree currently declares one (`rg peerDependencies packages/*/package.json` is empty), so the
gap is latent rather than live.

The edge taxonomy is what makes the last three meaningful, and it is pinned case by case in
`tooling/tests/unit/package-graph.test.ts`: `import type`, `export type`, `export { type Z } from`
and `import { type U } from` are all `typeOnly: true`; `type Q = import("…")` is likewise
`typeOnly: true` (it is a static edge nonetheless: `kind: "static"`). The plain
`import alias = require("…")` form is pinned `typeOnly: false` — the same bucket as a bare
`require("…")` — and only `import("…")` is `dynamic`. (`node.isTypeOnly` on an
`ImportEqualsDeclaration` can be `true` for `import type alias = require(...)`, but that spelling is
not the one the fixture exercises.) A type-only back edge dissolves a module cycle
(`tooling/tests/unit/package-graph.test.ts`).

`--check-doc` additionally reads `specs/package-coupling-analysis.md` and compares the two numeric
columns of each package's row (`tooling/checks/package-graph.ts`,
`tooling/lib/package-graph.ts`).

**`runtimeClosure`'s two fields are two different algorithms, not two filters of the same walk.**
`reachableFrom` (`tooling/lib/package-graph.ts`) is a plain breadth-first search over the
eager-runtime adjacency alone — every package transitively reachable through non-type-only, non-
dynamic edges. `dynamicReachableFrom` walks eager and dynamic edges together but tags
each queued node with whether the path to it has *already crossed* a dynamic edge, and only adds a
node to the result once that flag is set; from there it keeps expanding eagerly. So `dynamic` answers
"what can this package reach only by first going through a lazy `import()`" — exactly the shape
`@clarvis/loop`'s optional-package-boundary tests need (§4.10) to prove an eager entry point never
reaches an optional package while still allowing an explicit dynamic subpath to load it. Pinned by
`tooling/tests/unit/package-graph.test.ts` ("separates type-only, eager, and dynamic edges and
computes dynamic closure").

### 4.5.1 `bun-sources.ts`

`repositoryPaths(root)` asks Git for the NUL-delimited union of tracked and unignored paths with
`git ls-files --cached --others --exclude-standard -z`, fails if Git exits non-zero, and keeps only
paths that still exist (`tooling/checks/bun-sources.ts`). `pythonSourcePaths(paths)` then
matches `.py`, `.pyi` and `.pyw` case-insensitively and sorts the result. The CLI
prints every match under `Python source files are not allowed; use Bun/TypeScript:` and exits 1, or
prints `bun sources: no tracked Python source files`. Dependencies and ignored build
output are outside this inventory by construction. The extension matrix is pinned at
`tooling/tests/unit/bun-sources.test.ts`.

### 4.6 Test-process isolation: `tooling/test-runtime/clarvis-home-preload.ts`

At preload time — before any test module is evaluated — the file checks whether
`process.env[HOME_ENV]` (i.e. `CLARVIS_HOME`, `packages/paths/src/roots.ts`) is unset or blank.
If so it `mkdtempSync`es `clarvis-test-home-` under the OS temp dir, assigns it, and registers a
`process.on("exit")` that `rmSync`es it, swallowing failure with the comment "a live child may still
hold a handle; the OS reaps the temp dir" (`tooling/test-runtime/clarvis-home-preload.ts`). An
already-set value is left alone.

The docblock states the mechanism and why a fixture cannot do it: per-workspace machinery "resolves
under the global root rather than inside the working tree", and "the writers resolve the root from
the ambient environment at call time, so nothing a test passes to a helper can redirect them"
(`tooling/test-runtime/clarvis-home-preload.ts`).

The root `bunfig.toml` carries the same preload with a production incident behind its comment: "102
stray `~/.clarvis/state/workspaces/_tmp_clarvis-plan-*` directories got written into a real `$HOME`
during one afternoon of stress-running a suite by path" (`bunfig.toml`), attributed to Bun
resolving `bunfig.toml` from the *cwd* and not merging a package's with the root's. The comment also
gives a controlled measurement of the same failure: "a root-cwd run of one plan test file leaked 17
directories, the same file via `bun --filter @clarvis/plan test` leaked none" (`bunfig.toml`).
That configuration is not decorative — the repository currently contains
a root-level `coverage/lcov.info` whose 13 `SF:` records span `packages/paths/src/*`,
`packages/protocol/src/index.ts` **and `tooling/test-runtime/clarvis-home-preload.ts`**, which is the fingerprint of
exactly such a root-cwd run (and shows the root bunfig's lack of `coveragePathIgnorePatterns`).
CI itself makes root-cwd runs in the Windows and macOS platform-policy jobs
(`.github/workflows/ci.yml`, jobs `windows` and `sandbox-macos`).

Seventeen of the eighteen packages repeat the preload in their own `bunfig.toml`; only the
type-only `protocol` package omits it.

`@clarvis/code`'s bunfig is the only one with a four-entry preload list and an ordering rule stated
inline: `@opentui/solid/preload` must stay first because it registers the Solid JSX transform, and
the tree-sitter preload must precede anything that loads `src/`
(`packages/code/bunfig.toml`). Its top-of-file comment also records why there is no *global*
`preload` key: it applied to every Bun process started from that directory and cost each ~250 ms
(`packages/code/bunfig.toml`).

Of those preloads, `packages/code/tests/helpers/ascii-preload.ts` registers its fixture in
`beforeEach`, and
`tests/helpers/tree-sitter-preload.ts`
stubs `TreeSitterClient.prototype.startWorker` to a no-op before any client is constructed
(`packages/code/tests/helpers/tree-sitter-preload.ts`), then patches three methods on the
singleton. Its docblock records a measurement: the previous arrangement "spawned and
terminated **82** workers" across the suite, and with the spawn path closed "the count is zero". The stub is pinned by a test that reads the private `worker` field, with a note that
swapping `globalThis.Worker` "counts zero whether or not a worker was created"
(`packages/code/tests/integration/tree-sitter-preload.test.ts`).

### 4.7 The `--timeout` rule

The root `bunfig.toml` documents, in place of the setting, why the setting is absent: the historical
Bun 1.3.14 probe found `[test] timeout` silently ignored, and the Bun 1.4 migration deliberately
retains the proven `--timeout` CLI contract unless a separate measured change moves it
(`bunfig.toml`).

Verified against the then-pinned 1.3.11 toolchain: a scratch project with
`[test] timeout = 60000` in its `bunfig.toml` and a single test that sleeps 8 s fails with
`this test timed out after 5000ms`. The claim holds on 1.3.11 as well as on the 1.3.14 the comment
names.

### 4.8 The CI retry wrapper

`tooling/ci/retry-code-coverage.sh` runs `bun run test:coverage` once; on exit 0 it stops. Otherwise it retries **up to 3 times**, and only while `is_crash_exit` holds. The classifier is a three-value case: 132 (SIGILL, "Bun's @trap"), 134 (SIGABRT),
139 (SIGSEGV).

| Exit | Retried? | Reason given in the file |
| --- | --- | --- |
| 0 | n/a | success |
| 132 / 134 / 139 | yes, ≤3× | Bun crash signals |
| 130 (SIGINT) | **no** | "somebody asked this to stop — a cancelled workflow, or Bun killing sibling scripts after one of them failed" |
| 143 (SIGTERM) | **no** | same |
| anything else | no | a real test failure |

Each retry re-runs `bun --filter @clarvis/code test:coverage` **alone**, then `bun run coverage:check`. The file states the precondition that makes that sound: `code` is last in the sequential
root script, so every other package has already written its lcov; and if any other package died by
signal its report would be missing and `coverage:check` "fails loudly", because check-coverage reads
each report with a bare `readFile`. A retry emits a `::warning::` annotation and appends a
line to `$GITHUB_STEP_SUMMARY`.

### 4.9 Conformance harnesses

Four distinct shapes exist.

| Shape | Example | Assertion vehicle | Driver |
| --- | --- | --- | --- |
| **case table as data** | `memoryStoreConformance(): readonly ConformanceCase[]` (`packages/memory/src/testing.ts`, `memoryStoreConformance`), 31 cases | `node:assert/strict` | a `for … of` that wraps each case in a `test()` (`packages/memory/tests/contract/store.test.ts`) |
| same | `planRepositoryConformance()` (18 cases) + `planStoreConformance()` (10 cases) (`packages/plan/src/testing.ts`, `planRepositoryConformance` and `planStoreConformance`) | `node:assert/strict` | `packages/plan/tests/contract/repository.test.ts`, `plan-store.test.ts` |
| **suite registrar** | `traceStoreConformance(name, createHarness)` (`packages/trace/tests/contract/trace-store-conformance.ts`), 16 `it()` blocks | `bun:test` `expect` | called twice, once per backend (`packages/trace/tests/contract/trace-store.test.ts`) |
| **single async assertion** | `assertTaskProviderConformance(fixture)` (`packages/tasks/src/testing/provider-conformance.ts`) | zod `.parse` + a local `assert` throwing `Task provider conformance: …` | `packages/tasks/tests/component/conformance.test.ts` |

The first two shapes live in `src/` and the third does not, and the source states why: memory's and
plan's tables are "exposed as **data** rather than as `describe`/`test` calls, and assert through
`node:assert/strict`, so this module carries no test-runner dependency and an adapter living in
another package (or another runner) can drive the same cases"
(`packages/memory/src/testing.ts`, `packages/plan/src/testing.ts`). The trace registrar
imports `bun:test` directly (`packages/trace/tests/contract/trace-store-conformance.ts`) and
therefore cannot be published from `src`.

A harness declares optional capabilities and cases that need one they lack "return early rather than
failing": `MemoryStoreHarness` carries optional `poke` and `atomic` flags
(`packages/memory/src/testing.ts`).

Each driver runs the same table against every adapter — memory against `file` and `in-memory`
(`packages/memory/tests/contract/store.test.ts`), trace against `memory` and `JSON`
(`packages/trace/tests/contract/trace-store.test.ts`).

### 4.10 The `architecture` level's idiom

Architecture tests do not import the code they police; they read it as **text** and scan it. The
recurring structure has four parts, all four present in `packages/paths/tests/architecture/invariant.test.ts`:

1. A matcher regex over source lines.
2. A comment filter, because "TSDoc writes `` `.clarvis` `` in backticks, which no regex can tell
   from a template literal … only computation must not".
3. An explicit, currently-empty exception list, kept "so that a deliberate, reviewed exception can be
   recorded rather than the assertion being weakened", plus a second test asserting the
   list names nothing already fixed.
4. **Positive and negative controls on the matcher itself** — fixtures that must match, fixtures
   recognized as comments, and near-misses that must not match.

Two further conventions recur. The scanned tree set is `packages/*/src` *and* `packages/*/tooling`
 — the same two of the three trees `package-graph.ts`'s `SOURCE_TREES` walks
(`tooling/lib/package-graph.ts`, which also includes `tests`), and matching
`source-policy.ts`'s per-package scopes for those two trees. And fixture strings are assembled
at runtime rather than written literally, so the guard does
not fire on its own test — `packages/loop/tests/architecture/optional-package-boundary.test.ts`
does it for import specifiers, exactly as `tooling/checks/source-policy.ts` does for the `mock.module`
label.

The same positive-and-negative control discipline appears in the root architecture suite's
normalizer test (`tooling/tests/architecture/stream-metrics-drift.test.ts`, "the normalizer permits
only the owner-specific default").

## 5. Invariants

1. **INV-303 — every `*.test.*` file under a package's `tests/` tree has one of the six level names
   as its first path segment below `tests/`** (deeper nesting inside a level is unconstrained).
   Rule: `tooling/lib/source-policy.ts` + enforced at
   `tooling/checks/source-policy.ts`. Pinned by `tooling/tests/unit/source-policy.test.ts`
   (accepts `unit`/`integration`/`e2e`, rejects a flat file and one under `helpers/`).
   Currently satisfied: 921 test files, 0 unclassified.

2. **INV-304 — `mock.module()` appears nowhere in `packages/*/{src,tests,tooling}` or root `tooling/`,
   with no allowlist and no baseline.** Rule: `tooling/checks/source-policy.ts`, matcher at
   `tooling/lib/source-policy.ts`. Pinned by `tooling/tests/unit/source-policy.test.ts`, which
   asserts a direct, an `await`-prefixed, and a `void`-prefixed call are all detected with correct
   line/column, and more broadly, which also pins that the matcher ignores comments,
   string literals, `other.module("pkg")`, and a bare property read. Currently satisfied at zero
   occurrences.

3. **INV-305 — `packages/capability/src/tasks.ts` is the only production file permitted an empty
   promise catch, and it is permitted exactly one.** Rule: `tooling/checks/source-policy.ts` (baseline map)
   +. The occurrence is `packages/capability/src/tasks.ts`, inside
   `suppressSecondaryRejection`, which throws if given an empty `observedBy` — so the
   suppression cannot be used anonymously. **Unpinned** by any test; the baseline is a literal in
   the checker.

4. **INV-305 (scope half) — `tests/` and `tooling/` are exempt from the empty-catch budget; only
   `src/` is scanned.** Rule:
   `tooling/checks/source-policy.ts` (only `sources` reaches `sourceFilesToCheck`)
   (tests and tooling reach `moduleMockFiles` only). **Unpinned.**

5. **INV-307 — every `src` module of every non-type-only package produces an `SF:` LCOV record, or
   is named in `NO_COUNTER_ALLOWLIST` with a reason.** Rule: `tooling/checks/coverage.ts`, failure. The stated mechanism it defends against is : "A module that NO test file
   imports is absent from LCOV entirely rather than present at 0% — it contributes to neither
   numerator nor denominator". Partially pinned by
   `tooling/tests/unit/coverage.test.ts`.

6. **INV-307 (tolerance half) — a stale allowlist entry is reported but never fails the check.** Rule:
   `tooling/checks/coverage.ts` (computation) (log, not failure, with the
   in-file reason). **Unpinned.**

7. **INV-307 (type-only half) — a package declared type-only may contain no runtime export, and a
   stale LCOV record does not excuse one.** Rule: `tooling/checks/coverage.ts` (the type-only branch ignores
   `measured` entirely) +. Pinned by `tooling/tests/unit/coverage.test.ts`
   ("still reports runtime exports even when stale LCOV names the module") and
   (interfaces and `export type * from` are accepted).

8. **INV-307 (absent-report half) — an absent `coverage/lcov.info` is tolerated only for a
   `TYPE_ONLY_PACKAGES` member, and only when the package's `src/` really exists.** Rule: `tooling/checks/coverage.ts`. Pinned by
   `tooling/tests/unit/coverage.test.ts` (protocol tolerated, kernel rejects with `ENOENT`) (a missing type-only package still throws `ENOENT`).

9. **INV-306 (hard-error half) — an LCOV report that names own-source files but reports zero lines
   is a hard error for a non-type-only package.** Rule: `tooling/checks/coverage.ts`, message
   `"<pkg>: LCOV report contains no own-source line data"`. **Unpinned** by a test; relied upon in
   prose by `tooling/ci/retry-code-coverage.sh`.

10. **INV-306 (own-source half) — only `src/`-relative `SF:` records enter a package's ratios; a
    workspace dependency's source cannot.** Rule: `tooling/checks/coverage.ts`, reinforced by
    `coveragePathIgnorePatterns = ["../**"]` in all 18 package bunfigs. ~~**Unpinned.**~~
    **Pinned on its reinforcement half:** `checkPackageHarness` fails any package bunfig
    whose `[test] coveragePathIgnorePatterns` omits `"../**"`, naming the consequence — "workspace
    dependencies enter this package's ratios" (`tooling/lib/test-harness.ts`, over
    `REQUIRED_IGNORE_PATTERN`), and `tooling/tests/unit/test-harness.test.ts` holds it. Type-only
    packages are **not** excused this one, which is why `packages/protocol/bunfig.toml` carries it
    too. The `src/`-relative `SF:` filter inside `coverage.ts` still has no direct test.

11. **INV-310 (timeout half) — the per-test timeout lives on the CLI, never in a `bunfig.toml`.** Rule: the absence itself,
    documented at `bunfig.toml`; every `bun test` script carries `--timeout 60000`.
    ~~**Unpinned** — no test asserts that a package's `test` script carries the flag.~~
    **Pinned** by `tooling/checks/test-harness.ts`, in both directions and for every package.
    `bunTestInvocations` expands a package's `test` script through the other scripts it delegates to
    (`tooling/lib/test-harness.ts`), so the flag is required on each `bun test` a package can
    actually reach rather than only the direct script text (through `REQUIRED_TIMEOUT`); and `[test]
    timeout` is a forbidden bunfig key, refused with the reason that Bun parses it
    and ignores it. Unit-pinned at
    `tooling/tests/unit/test-harness.test.ts`, with the expansion itself. The checker reads package bunfigs only, so the *root* bunfig's abstention is still held by
    the comment at `bunfig.toml` alone. Empirically confirmed before migration on Bun 1.3.11 that a
    bunfig `[test] timeout` is ignored and the 5 000 ms default applies.

12. **INV-306 — coverage thresholds live only in `tooling/checks/coverage.ts`, and are computed by
    summing LCOV counters rather than read from Bun's per-file average.** Rule:
    `tooling/checks/coverage.ts`; no `coverageThreshold` key appears in the root or any package
    `bunfig.toml`. ~~**Unpinned.**~~ **Pinned for the package half:** `coverageThreshold`
    is the second forbidden bunfig key, refused with its own reason — floors live only in
    `coverage.ts`, which sums LCOV counters rather than averaging per file
    (implemented in `tooling/lib/test-harness.ts` and pinned by
    `tooling/tests/unit/test-harness.test.ts`). The root bunfig is checked for the preload only
    (`tooling/checks/test-harness.ts`), so its abstention from both forbidden keys remains
    unpinned.

13. **INV-310 (preload half) — a test process never writes into the developer's real
    `CLARVIS_HOME`.** Rule:
    `tooling/test-runtime/clarvis-home-preload.ts`, wired at `bunfig.toml` and in seventeen package bunfigs.
    ~~**Unpinned** — nothing asserts the preload is registered where it is needed, and eleven package
    bunfigs omit it.~~ **Pinned**, and the count was the finding. `checkPackageHarness`
    requires a `preload` entry ending in `clarvis-home-preload.ts` in every non-type-only package bunfig
    (`tooling/lib/test-harness.ts`, over `PRELOAD_BASENAME`), and
    `tooling/checks/test-harness.ts` checks the root bunfig separately, because a run by path
    from the repository root reads that file and no package's. Pinned by
    `tooling/tests/unit/test-harness.test.ts`, which asserts the failure names its consequence.

    Ten of the nineteen packages were missing it, and adding it turned two `@clarvis/skills` tests
    red on the spot: both had been passing only because the ambient environment had no
    `CLARVIS_HOME`, so `clarvisSkillRoots` fell back to the developer's real `~/.clarvis` and matched
    an expectation written for it. That is the failure the preload exists to expose, and the rule the
    two tests should have been pinning is now asserted rather than assumed —
    `packages/skills/tests/unit/preset.test.ts` ("lets CLARVIS_HOME outrank the injected home for
    the clarvis user root only") (it is read from the ambient process env when none is
    injected), with the three older cases passing `env: {}` so they state their environment instead
    of inheriting one.

14. **INV-310 (idempotence half) — a pre-set `CLARVIS_HOME` is never overwritten by the preload.** Rule:
    `tooling/test-runtime/clarvis-home-preload.ts` — the guard is `undefined || trim() === ""`. **Unpinned.**

15. **INV-308 — `packages/llm/src/stream-metrics.ts` and
    `packages/code/src/adapters/stream-metrics.ts` are token-identical except for the `source`
    default.** Rule:
    `tooling/tests/architecture/stream-metrics-drift.test.ts`, "the two production stream metrics
    implementations stay token-identical". The separate test "the normalizer permits only the
    owner-specific default" pins both the authorized owner-default difference and rejection of an
    unrelated token difference.

16. **INV-309 (a) — no `src` file imports its own package's public entrypoint.** Rule:
    `tooling/lib/package-graph.ts` (by specifier) (by resolved target).
    Pinned by `tooling/tests/unit/package-graph.test.ts`.

17. **INV-309 (b) — a `src` value import may only name a workspace declared in `dependencies` or
    `optionalDependencies`; a devDependency-only workspace may be imported from `tests`/`scripts`
    alone.** Rule: `tooling/lib/package-graph.ts` (`runtimeDeclared` is
    `dependencies ∪ optionalDependencies`). Pinned by
    `tooling/tests/unit/package-graph.test.ts`.

18. **INV-309 (c) — every `@clarvis/*` name a package declares (in any of `dependencies`, `devDependencies`,
    `optionalDependencies` or `peerDependencies`) must resolve to a real workspace and be referenced
    by at least one source edge somewhere in that package's `src`/`tests`/`scripts` trees.** Rule:
    `tooling/lib/package-graph.ts` (`declares unknown workspace dependency X` /
    `declares unused internal dependency X`). **Unpinned** — neither message string is asserted
    anywhere in `tooling/tests/unit/package-graph.test.ts`.

19. **INV-309 (d) — every workspace runtime dependency has a matching `tsconfig.build.json` project
    reference and vice versa, and the root solution file references exactly the packages that have one.** Rule:
    `tooling/lib/package-graph.ts`. Pinned by
    `tooling/tests/unit/package-graph.test.ts`, including the JSONC-with-comments case.

20. **INV-309 (e) — no declared cycle, no compilation cycle, and no intra-package runtime module
    cycle.** Rule:
    `tooling/lib/package-graph.ts`. Pinned by `tooling/tests/unit/package-graph.test.ts`
    (module cycles, and the type-only back edge that dissolves one) (declared and
    compilation cycles). Currently satisfied: `errors: []` over the real tree.

21. **INV-309 (f) — a deep import must be a subpath the target's `exports` actually publishes, evaluated under the
    right condition set.** Rule: `tooling/lib/package-graph.ts` —
    `{bun, import, require, default}` for a value import, plus `types` for a type-only one. Pinned by
    `tooling/tests/unit/package-graph.test.ts`, which asserts a `{types: …}`-only subpath is legal
    for `import type` and illegal for a value import.

22. **INV-309 (g) — no relative import crosses a package boundary.** Rule:
    `tooling/lib/package-graph.ts`. Pinned by `tooling/tests/unit/package-graph.test.ts`.

23. **Every package's `tsconfig.json` includes its `tests` tree**, so the gate's `typecheck` phase
    type-checks test sources. Verified by reading all 18: fourteen use
    `["src/**/*.ts","tests/**/*.ts"]`, and `code`, `kernel`, `protocol`, `server` use
    `["src","tests"]` (e.g. `packages/protocol/tsconfig.json`, `packages/kernel/tsconfig.json`).
    **Unpinned.**

24. **Repository checker tests are first-class classified suites.** Ten focused test files live under
    `tooling/tests/unit/`; the repository-metadata and stream-metrics test files live under
    `tooling/tests/architecture/`. `bun run test:tooling` executes both trees and the supported root
    `test` and `lint:intent` commands invoke that script (`package.json`, `scripts.test:tooling`,
    `scripts.test`, `scripts.lint:intent`).

25. **INV-311 (installation half) — a commit only runs the gate if `core.hooksPath` is
    `.githooks`.** Rule: `.githooks/pre-commit`
    is the only file in that directory, and `bun run hooks:install` is the only thing that points a
    clone at it (`package.json`, `scripts.hooks:install`). **Unpinned**, and unverifiable from inside a test — a clone with
    `core.hooksPath` unset commits past every check.

26. **The `text=auto eol=lf` normalisation is committed, not configured per-clone**, because
    byte-exact fixtures depend on it: the `.gitattributes` comment names "the CRLF/BOM tally in
    `packages/tools/src/lib/text.ts`, and every `apply_patch`, `diff` and `replace` test", and states
    that "committing the rule fixes every clone, which a CI-only `git config` would not"
    (`.gitattributes`).

27. **INV-311 (order half) — the gate is one strictly sequential `&&` chain in a fixed order.**
    `format:check → build → typecheck → lint:eslint → lint:intent → knip → test:coverage`
    (`package.json`, `scripts.check:pre-commit`), invoked by a hook that does nothing else
    (`.githooks/pre-commit`). `build` sits immediately before `typecheck` because
    `typecheck` resolves cross-package types through the built `dist/*.d.ts`, so running it against a
    stale `dist` reports errors that do not exist. `lint:intent` has its own inner order —
    `test:tooling`, `check:source-policy`, `check:graph`, `check:specs`, `check:harness`,
    `check:bun-version`, `check:bun-sources`, `check:imports` and `check:release`
    (`package.json`, `scripts.lint:intent`). ~~**Unpinned**: the order is a literal in
    one npm script, and nothing asserts it.~~ **Pinned** for the top-level chain:
    `checkGateChain` splits `check:pre-commit` on `&&`, strips `bun run`, and compares the result to
    `GATE_PHASES` (`tooling/lib/test-harness.ts`), so a dropped phase, a reordered chain and a
    restored top-level `--parallel` are each reported on their own, and an absent script is reported
    rather than passing vacuously (`tooling/tests/unit/test-harness.test.ts`). `lint:intent`'s inner order is **not** covered — it remains a literal in one npm script.
    Combined with item 25, a clone that never ran `bun run hooks:install` runs none of it and gets no
    signal.

28. **INV-309's document half makes a `specs/` file a build input.** `check:graph` passes
    `--check-doc` unconditionally (`package.json`, `scripts.check:graph`) and
    `tooling/checks/package-graph.ts` reads
    `specs/package-coupling-analysis.md` with a bare `readFileSync`, so deleting that document breaks
    every commit rather than only the rule it encodes. It is generated from the analyzer's own
    `renderMarkdown` (`tooling/lib/package-graph.ts`) so the two cannot drift.

29. **The repository carries no tracked or unignored Python source.** `.py`, `.pyi` and `.pyw`
    paths are rejected case-insensitively; Bun/TypeScript remains the repository's implementation
    and maintenance runtime. This does not constrain user-installed toolchains or language-neutral
    capability executables. Production: `tooling/checks/bun-sources.ts`, invoked by
    `check:bun-sources` inside `lint:intent` (`package.json`, `scripts.lint:intent` and
    `scripts.check:bun-sources`). Test:
    `tooling/tests/unit/bun-sources.test.ts` pins accepted Bun/TypeScript paths, all three
    rejected extensions, case insensitivity and deterministic sorting.

## 6. Failure modes and degradation

| Condition | Handler | Outcome |
| --- | --- | --- |
| Any task-intent violation | `tooling/checks/source-policy.ts` | all violations printed under `Task-intent violations:`, `process.exitCode = 1`. Never first-failure-only. |
| A package directory has no `src`/`tests`/`scripts` | `tooling/checks/source-policy.ts` | `ENOENT` swallowed; any other error rethrows |
| Missing `coverage/lcov.info`, non-type-only package | `tooling/checks/coverage.ts` | raw `ENOENT` propagates out of `checkCoverage` — an unhandled rejection, not an `AggregateError` |
| Missing report **and** missing `src/`, type-only package | `tooling/checks/coverage.ts` | `readdir` throws `ENOENT`; pinned by `tooling/tests/unit/coverage.test.ts` |
| Empty own-source report, non-type-only | `tooling/checks/coverage.ts` | `Error: <pkg>: LCOV report contains no own-source line data` |
| Floor breach, unmeasured module, or type-only runtime export | `tooling/checks/coverage.ts` (`checkCoverage`, failure collection and final `AggregateError`) | collected across **all** packages, then one `AggregateError` — the run does not stop at the first bad package |
| Stale allowlist entry | `tooling/checks/coverage.ts` (`staleEntries`) | **tolerated**: printed as an informational line, exit code unaffected |
| Package with zero functions in LCOV | `tooling/checks/coverage.ts` | scored `1` rather than dividing by zero |
| Stream-metrics drift | `tooling/tests/architecture/stream-metrics-drift.test.ts`, "the two production stream metrics implementations stay token-identical" | its `expect(...).toBe(...)` fails through Bun's normal test reporter; the test has no custom stderr or `process.exitCode` path |
| Normalizer admits an unrelated token difference | `tooling/tests/architecture/stream-metrics-drift.test.ts`, "the normalizer permits only the owner-specific default" | its negative-control expectation fails through Bun's normal test reporter |
| Package-graph violations | `tooling/checks/package-graph.ts` | the Markdown table is still printed on stdout, violations on stderr, `exitCode = 1` |
| `--check-doc` with the document absent | `tooling/checks/package-graph.ts` | `readFileSync` throws — an **uncaught** `ENOENT` at module load, not a collected failure. This is the live state of the tree (see §8). |
| Git inventory fails for the Bun-source check | `tooling/checks/bun-sources.ts` | throws `git ls-files failed`, appending trimmed stderr when present |
| Python source path found | `tooling/checks/bun-sources.ts` | every sorted path is printed and `process.exitCode = 1` |
| Documentation embeds a source line locator, names an explicit repository file that does not exist, or a tracked spec embeds a calendar date or source-size inventory | `tooling/checks/spec-hygiene.ts`; `extractLineQualifiedReferences`, `resolveRepositoryFileReference`, `extractCalendarDates`, and `extractSourceSizeReferences` in `tooling/lib/spec-hygiene.ts` | every unstable, missing, dated, or source-size reference is reported and `process.exitCode = 1`; illustrative paths use visible placeholders, chronology stays in `CHANGELOG.md`, and behavioral line limits remain legal |
| Bun dies by SIGILL/SIGABRT/SIGSEGV in CI | `tooling/ci/retry-code-coverage.sh` | up to 3 retries of `@clarvis/code` alone, then `coverage:check` |
| Bun dies by SIGINT/SIGTERM in CI | `tooling/ci/retry-code-coverage.sh` | never retried |
| Preload temp-dir cleanup fails at exit | `tooling/test-runtime/clarvis-home-preload.ts` | swallowed; "the OS reaps the temp dir" |
| A conformance harness lacks an optional capability | `packages/memory/src/testing.ts` | the case returns early rather than failing |
| Tree-sitter highlighting unavailable under the code preload | `packages/code/tests/helpers/tree-sitter-preload.ts` | `highlightOnce` resolves with an `error`; renderables fall back to plain text. The test asserts only `error` is a string, because "asserting the exact string made this pass alone and fail in the full run" (`packages/code/tests/integration/tree-sitter-preload.test.ts`) |

**What degrades vs. what fails hard.** Only three things degrade: a stale allowlist entry, a
conformance case whose harness lacks a capability, and CI's crash retry. Everything else is
fail-hard. Notably, `coverage.ts` has no partial mode — there is no flag to check one package.

## 7. Coupling

### 7.1 What the checkers depend on

| Consumer | Dependency | Kind | What forces it |
| --- | --- | --- | --- |
| `tooling/lib/source-policy.ts` | `typescript` | runtime, static | `import ts from "typescript"`; the `mock.module` matcher is an AST walk, not a regex |
| `tooling/lib/package-graph.ts` | `typescript` | runtime, static | used for both `createSourceFile` and `parseConfigFileTextToJson` (JSONC tsconfigs) |
| `tooling/checks/import-extensions.ts` | `typescript` | runtime, static | the import-extension policy parses module specifiers through the TypeScript AST |
| `tooling/tests/architecture/stream-metrics-drift.test.ts` | `typescript` | runtime, static | `ts.createScanner` with `skipTrivia` is what makes comments non-material |
| `tooling/checks/coverage.ts` | none beyond `node:fs/promises`, `node:path`, `node:url` | — | it parses LCOV with `split`/`startsWith`, no library |
| `tooling/checks/bun-version.ts` | none beyond `node:fs`, `node:path`, `node:url` | — | validates the exact mise pin against every runtime and declaration surface |
| `tooling/checks/bun-sources.ts` | Git executable plus `node:fs`/`node:path`/`node:url` | subprocess | Git supplies the tracked-and-unignored path inventory; the script performs no recursive filesystem scan |
| `tooling/test-runtime/clarvis-home-preload.ts` | `@clarvis/paths` | runtime, static | — it must not spell `CLARVIS_HOME` itself; `HOME_ENV` is owned at `packages/paths/src/roots.ts` |
| `tooling/checks/package-graph.ts` | `specs/package-coupling-analysis.md` | runtime, filesystem | only under `--check-doc` |

`typescript` is a root `devDependency` (`package.json`, `devDependencies.typescript`), which is what
lets these four repository-tooling modules import it from the repository root.

### 7.2 What depends on this subsystem

- **Every commit**, through `.githooks/pre-commit` → `package.json`
  (`scripts.check:pre-commit`).
- **CI's linux job**, which runs `bun run lint` (hence `lint:intent`) and
  `bash tooling/ci/retry-code-coverage.sh` (`.github/workflows/ci.yml`). CI job layout belongs to
  *build-tooling-ci-and-platform*.
- **Every package's `test:coverage` script**, which must write `coverage/lcov.info` where
  `readOwnSourceCoverage` expects it (`tooling/checks/coverage.ts`), i.e. the `coverageDir`
  setting in each package's `bunfig.toml` is part of this contract.
- **Five packages' `./testing` exports**, which are consumed across package boundaries and therefore
  ride the ordinary `exports`/dependency rules `package-graph.ts` enforces: `loop`, `memory`,
  `plan`, `trace` and `tasks` each declare one (§2.5), and `kernel` and `memory` are the
  actual cross-package importers of `@clarvis/loop/testing`. `kernel` and `workflows` declare no
  `./testing` export of their own — neither appears in either package's `exports` map.

### 7.3 Checker reach by tree

A precise boundary, derived from the manifest and config globs, is shown below.
`check-bun-sources` inventories every tracked or unignored path in all of these trees (and elsewhere
in the repository), but rejects only Python source extensions. `check:imports` uses the same
inventory and parses every TypeScript file's module specifiers.

| Tree | `format:check` | `lint:eslint` | `typecheck` | `source-policy` | `package-graph` | `check:imports` | `knip` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `packages/*/src` | yes | yes | yes | yes (both rules) | yes | yes | yes |
| `packages/*/tests` | yes | yes | yes | mock-module + level rule | yes | yes | yes |
| `packages/code/tooling` | yes | yes | yes | mock-module only | yes | yes | yes |
| repo `tooling/checks`, `lib`, `release`, `test-runtime` | yes | yes | yes | mock-module only | no | yes | yes |
| repo `tooling/tests` | yes | yes | yes | mock-module only | no | yes | yes |
| repo `tooling/ci` | no¹ | no¹ | no¹ | no¹ | no | no¹ | no¹ |

¹ `tooling/ci/retry-code-coverage.sh` is the sole exception because its behavior is GitHub Actions
shell orchestration rather than importable repository logic. It remains isolated and temporary
pending the Bun 1.4 canary described in `specs/known-issues.md`.

Root tooling has its own TypeScript and ESLint projects (`tooling/tsconfig.json`,
`tooling/eslint.config.js`); root package scripts also include it in Prettier and Knip. The
`packages/paths` architecture test remains the domain-specific path-ownership check over
`packages/*/tooling`. The
paths test's comment records the incident that put it there — a `packages/code/tooling/artifact/smoke.ts` that
"kept spelling the pre-`@clarvis/paths` layout after it moved, and turned every CI run red at a
90-second timeout that named neither the file nor the cause"
(`packages/paths/tests/architecture/invariant.test.ts`).

### 7.4 ESLint's test-file relaxations

The shared flat config applies a second block scoped to `tests/**/*.{ts,tsx}` that disables eleven
type-safety rules and flips `no-floating-promises` from `{ignoreVoid: false}` to `{ignoreVoid: true}`
(`eslint.config.base.js`). The header comment states the scope: "Test files legitimately
traffic in untyped fixtures/mocks". `@typescript-eslint/await-thenable` is off in tests with a stated
mechanism — "Bun's promise matchers are tracked by the runner but typed as synchronous".
The `ignoreVoid: false` setting in `src` (`eslint.config.base.js`) means a bare `void p` is not,
by itself, an accepted way to mark a rejection as intentionally unhandled there; `suppressSecondaryRejection`
(invariant 3) is the named pattern the codebase uses at call sites instead, over a promise that
already ends its own chain in `.catch(() => {})` (`packages/capability/src/tasks.ts`).

## 8. Open questions

1. **Why `--check-doc` is passed unconditionally is not answerable from source.**
   `tooling/checks/package-graph.ts` reads `specs/package-coupling-analysis.md` with a bare
   `readFileSync`, so the flag makes a documentation file a hard dependency of `lint:intent`
   (`package.json`, `scripts.lint:intent`) and therefore of `check:pre-commit`
   (`scripts.check:pre-commit`) — losing the document stops every
   commit, not just the graph check. Whether that coupling is deliberate, or whether the flag was
   meant to be conditional, the code does not say.

2. **The six level names carry no definition in code.** `TEST_LEVELS`
   (`tooling/lib/source-policy.ts`) is a bare set of strings. Nothing in `packages/*/tests`,
   `tooling/`, `bunfig.toml` or any config states what distinguishes `unit` from `component`, or
   `component` from `integration`. The one observable regularity is the `architecture` idiom
   (§4.10) and the `contract` idiom (§4.9); the other four are conventional only.

3. **`e2e` is a declared level with zero members.** No `tests/e2e` directory exists in any of the 18
   packages. It is pinned as *accepted* by `tooling/tests/unit/source-policy.test.ts`, so it is live
   vocabulary, but nothing uses it.

4. **The level rule had two syntactic gaps.** ~~`findUnclassifiedTestFiles` matches only
   `/\.test\.[cm]?[jt]sx?$/`. Verified on the then-pinned Bun 1.3.11: `tests/helpers/thing.spec.ts` and
   `tests/helpers/thing_test.ts` are both **collected and run** by `bun test`, and both slip past the
   classifier.~~ **Resolved**: the matcher is now `BUN_TEST_FILENAME`
   (`tooling/lib/source-policy.ts`), covering all four shapes Bun collects, pinned by
   `tooling/tests/unit/source-policy.test.ts`. Re-verified on 1.3.11 before the change that both forms really
   do run — the gap was that such a file could sit outside every declared level, execute on every CI
   leg, and be reported by nothing. Still open: `lastIndexOf("/tests/")` would misclassify a nested
   `tests` directory inside a level; none exists.

5. **The `mock.module` matcher is syntactic and can be evaded.** It requires the literal identifier
   `mock` with property `module` (`tooling/lib/source-policy.ts`), and the unit test pins that
   `other.module("pkg")` is ignored (`tooling/tests/unit/source-policy.test.ts`). `vi.mock(...)`, a
   destructured `const { module } = mock`, or an aliased binding would not be found. Zero hits for
   `vi.mock` and `jest.mock` today, so the gap is latent.

6. ~~**No test asserts the per-package test harness configuration.**~~ **Resolved.**
   `tooling/checks/test-harness.ts`, backed by `tooling/lib/test-harness.ts` and
   `tooling/tests/unit/test-harness.test.ts`, discovers all 18 packages and fails when a runtime package's
   `test` script reaches no `bun test`, any reached invocation omits `--timeout 60000`, a package
   bunfig lacks the shared preload or `coveragePathIgnorePatterns = ["../**"]`, a forbidden
   `timeout`/`coverageThreshold` key appears, or the root gate stops being the required sequential
   chain. `--isolate` is not a universal invariant: workflows retains it, while loop removed it
   after the measured Bun 1.4 regression recorded in §3.6 and its README.

7. ~~**The rationale for the gate's phase order is not in the repository.**~~ **Now recorded in
   `.githooks/pre-commit`**, at the one place a reader meets the chain. Beyond the two links data flow
   forces (`build` before `typecheck` via `dist/*.d.ts`; the suites before `coverage:check` via
   `coverage/lcov.info`), the order is cost against probability of failing — cheapest and most likely
   first, so a failure arrives as early as the check that found it allows rather than after minutes of
   tests a formatting slip would have invalidated anyway. `format:check` is seconds and catches the
   most common oversight; `test:coverage` is the whole suite and goes last.

8. ~~**The package-graph serializer used non-English headings.**~~ **Resolved.**
   `renderMarkdown` now emits the repository-standard English role/dependency table and Mermaid
   graph. `specs/package-coupling-analysis.md` holds that output verbatim, and `checkDocument`
   compares the complete generated block with the current serializer. A format change therefore
   requires regenerating the document in the same iteration, or `check:graph` fails
   (`tooling/lib/package-graph.ts`, `renderMarkdown` and `checkDocument`).

9. ~~**`@clarvis/tasks/testing` has no cross-package consumer.**~~
   **Resolved.** `@clarvis/tasks/testing` is a **provider conformance harness**, and its intended
   consumer is outside this repository by design: a provider-neutral task domain means somebody else
   writes the Jira or Trello or in-house provider, and this is how they find out whether it satisfies
   the contract before Clarvis ever loads it. No in-repo importer is the *expected* state there, not
   an unused export.

10. ~~**The three `GRANDFATHERED` allowlist entries are undocumented individually.** The header says
    they are "real, executable, untested modules that predate this check"
    (`tooling/checks/coverage.ts`), but nothing records what would have to be tested to close
    `packages/code/src/adapters/kernel-capabilities-client.ts`,
    `packages/loop/src/settings/marketplace-schema.ts` or `packages/loop/src/version.ts`.~~
    **Resolved.** Two were closed rather than documented, because importing them *is* the
    test: `packages/loop/src/version.ts` (the assertion is that a *static* import inlines this
    package's version, where its
    `createRequire` predecessor silently reported whichever `package.json` sat beside the bundle) and
    `packages/code/src/adapters/kernel-capabilities-client.ts` (carrying three claims about
    the in-process kernel: no tools, because MCP servers are connected only during a run; always
    `"connected"`, because there is no link that could drop; and a prompt mapping whose optional
    fields must stay absent rather than become `undefined`). The third,
    `packages/loop/src/settings/marketplace-schema.ts`, was closed the same day rather than
    documented, and with it the category: `packages/loop/tests/unit/marketplace-schema.test.ts`
    drives the reader through `marketplaceSchema`, its only runtime export, to complete coverage
    of its functions and lines. It exercises what the entry had named — the
    `MAX_LISTINGS`/`MAX_NOTES`/`MAX_LISTED_KEYS` truncations and the notes they emit, both default
    strings, bounded and confined local-source normalization, and the suggestion `typoBudget`
    withholds from a short key at the same edit distance it allows a long one — plus every supported
    source dialect, the drop-one-listing-never-the-collection rule, and the alternate spellings a
    foreign dialect writes a summary and a display name under. The original local-source rejection
    assertion was replaced when local marketplace entries became installable; current
    mutation confidence is owned by that focused suite rather than the historical six-mutation
    count. `NO_COUNTER_ALLOWLIST` now holds nothing but the three permanent reasons.

11. **Coverage figures from an existing LCOV artifact can be stale.** ~~Whether the per-package
    reports are current with `HEAD` is not determinable.~~ **Resolved**: it is
    determinable, and `coverage.ts` now
    determines it — it compares each report's mtime against the package's own sources and names the
    file that outran it, with the command to re-run. A type-only package is exempt, because its
    `test:coverage` writes no LCOV and the warning would be permanent noise. This was hit twice while
    closing §5 of the gap report: once as a phantom "src module produced no coverage record at all"
    for a module that had simply never been measured, and once as figures disagreeing with the last
    gate run. Both read as findings about the code rather than about the report's age. The leftover
    `.lcov.info.*.tmp` beside `packages/protocol/coverage/lcov.info` is untracked and gitignored —
    local hygiene, not a repository defect.

12. **`packages/memory/src/testing.ts` and `packages/plan/src/testing.ts` are counted in their
    packages' coverage denominators** — they are `src` modules and are on no
    allowlist. ~~Whether the floors were chosen with that in mind is not determinable.~~ **Measured,**
    and the numbers now sit beside the floors in `tooling/checks/coverage.ts`: `memory`
    reports 95.55% / 96.28% and would be 94.76% / 95.80% without it; `plan` reports 98.65% / 99.00%
    against 98.55% / 98.85%. Both are unusually well covered, so they do inflate the reported figure —
    and every floor holds on either denominator, which is what makes the question moot rather than
    open. Excluding them was rejected on that evidence: a `testing.ts` a package ships is consumed by
    other packages' suites, so it is production surface for them.

13. **Delegated to sibling documents.** The individual rules the 50 `tests/architecture/` files
    enforce belong to their owning subsystems (the `.clarvis`/`.agents` vocabulary to *paths*, the
    optional-package boundary and the eager-import closure to *loop*, the entrypoint-ownership and
    external-name tables to *kernel*, the bind gate and tool surface to *server*, and so on); this
    document describes only the level's shared idiom. CI job layout, the Bun version pin, the
    `code` bundle/smoke contract and interactive PTY validation belong to
    *build-tooling-ci-and-platform* and to the `code` host document.
