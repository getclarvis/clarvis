# Test layers, isolation, the pre-commit gate and coverage policy

> Implemented at `packages/...`, `tooling/...`, `bunfig.toml`, `.githooks/` and the root
> `package.json`. Every claim below is anchored to current source or test evidence, using a stable
> symbol or configuration key where available. Open questions are collected in the final section.

## 1. Purpose

This subsystem is the repository's *self-enforcement layer*: the rules about how tests are
organised, how a test process is isolated from the developer's machine, and what a commit must
survive before it is allowed to land. It is implemented as nine executable TypeScript checks under
`tooling/checks/`, five shared libraries under `tooling/lib/`, twelve classified test files under
`tooling/tests/` (ten unit and two architecture), and a Bun preload
(`tooling/test-runtime/clarvis-home-preload.ts`), the root and
per-package `bunfig.toml` files, the npm-script chain in the root `package.json`, and a one-line
git hook at `.githooks/pre-commit` that does nothing but `exec bun run check:pre-commit`
(`.githooks/pre-commit:7`).

Three concerns are handled here that no individual package can see. **Test placement**: every
`*.test.*` file in every workspace must sit under one of six named directories, which is what makes
each package's hand-written `bun test <path> <path> …` argument list complete
(`tooling/lib/source-policy.ts:3-10`, `tooling/checks/source-policy.ts:60-64`). **Process-global
mutation**: `mock.module()` is banned outright — zero allowlist entries across package source,
tests and tooling plus repository tooling (`tooling/checks/source-policy.ts:52-59`) — and empty promise catches are budgeted
against a one-entry baseline (`tooling/checks/source-policy.ts:7`). **Coverage honesty**:
`tooling/checks/coverage.ts` sums each package's LCOV counters against a per-package floor *and*
separately requires that every `src` module produced an `SF:` record at all, so a floor cannot be
held over a denominator that is missing files nothing imports
(`tooling/checks/coverage.ts:57-71`, `:316-341`).

The whole thing runs sequentially, fail-fast, from one npm script: `check:pre-commit` is a seven-link
`&&` chain (`package.json`, `scripts.check:pre-commit`).

## 2. Surface

### 2.1 Root npm scripts (the gate and its phases)

| Script | Definition | Source |
|---|---|---|
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

Note that `check:pre-commit` spells out `lint:eslint && lint:intent && knip` rather than calling
`lint`; the effect is identical (`package.json`, `scripts.lint` and `scripts.check:pre-commit`).

`check:specs` scans tracked and unignored Markdown and source files for dangerous characters and
documentation-link failures. It also extracts explicit repository-path citations such as
`packages/x/src/y.ts:12-18,24`; when the target exists, every cited line must be at least one and
within the target's current line count, and each range's start must not exceed its end. URLs,
absolute or parent-traversing
paths, and illustrative citations whose repository target does not exist are not treated as source
citations. Production: `tooling/checks/spec-hygiene.ts` (`invalidCitations`, `failedCitations`) and
`tooling/lib/spec-hygiene.ts` (`extractLineCitations`, `resolveLineCitation`). Test:
`tooling/tests/unit/spec-hygiene.test.ts` (`source line citations`).

### 2.2 The six test levels

`TEST_LEVELS` is a `Set` of exactly six names (`tooling/lib/source-policy.ts:3-10`):

```
architecture · component · contract · e2e · integration · unit
```

### 2.3 Exported checker API

| Symbol | Signature | Source |
|---|---|---|
| `findModuleMockCalls(file, source)` | `→ {file, line, column}[]` | `tooling/lib/source-policy.ts:22` |
| `findUnclassifiedTestFiles(files)` | `string[] → string[]` | `tooling/lib/source-policy.ts:64` |
| `readOwnSourceCoverage(packageName, root?)` | `→ {functions, lines, measured:Set<string>}` | `tooling/checks/coverage.ts:234` |
| `findUnmeasuredSources(packageName, measured, root?)` | `→ {unmeasured, runtimeExports, stale}` | `tooling/checks/coverage.ts:317` |
| `checkCoverage(root?)` | `→ Promise<void>`, throws `AggregateError` | `tooling/checks/coverage.ts:401` |
| `pythonSourcePaths(paths)` | `string[] → string[]`, sorted `.py` / `.pyi` / `.pyw` matches | `tooling/checks/bun-sources.ts:8` |
| `repositoryPaths(root)` | `→ string[]`, tracked plus unignored existing paths | `tooling/checks/bun-sources.ts:13` |
| `countLines(text)` | `string → number`, without inventing a line after a final newline | `tooling/lib/spec-hygiene.ts`, `countLines` |
| `extractLineCitations(text)` | `string → citation[]` for explicit repository-path line/range references | `tooling/lib/spec-hygiene.ts`, `extractLineCitations` |
| `resolveLineCitation(citation, file, tree)` | `→ string[]` for inverted or out-of-bounds ranges on existing targets | `tooling/lib/spec-hygiene.ts`, `resolveLineCitation` |
| `parseModuleEdges(source, fileName?)` | `→ {specifier, kind, typeOnly, line}[]` | `tooling/lib/package-graph.ts:78` |
| `analyzePackageGraph(root)` | `→ report` | `tooling/lib/package-graph.ts`, `analyzePackageGraph` |
| `renderMarkdown(report)` | `→ string` (English role/dependency table and Mermaid graph) | `tooling/lib/package-graph.ts`, `renderMarkdown` |
| `checkDocument(report, document)` | `→ string[]` | `tooling/lib/package-graph.ts`, `checkDocument` |

The checker logic is safely importable from a test in both cases, but the two scripts get there by
different mechanisms. `coverage.ts` self-invokes only when it *is* `process.argv[1]`
(`tooling/checks/coverage.ts:377-380`), a single-file guard, so importing that same file from a test
does not run the check. `package-graph.ts` has no such guard at all — its 28 lines call
`analyzePackageGraph`/`checkDocument`/`renderMarkdown` unconditionally the moment the file is loaded
(`tooling/checks/package-graph.ts:1-28`) — so it must never be imported from a test. Its "dual
purpose" is achieved instead by splitting the logic into two files: the importable library,
`tooling/lib/package-graph.ts` (no guard needed — it only exports functions, nothing runs on load),
and the CLI-only `tooling/checks/package-graph.ts`, which a test reaches only through its exported
functions, never through the script itself.

### 2.4 CLI flags

| Script | Flag | Effect | Source |
|---|---|---|---|
| `package-graph.ts` | `--check-doc` | also validates `specs/package-coupling-analysis.md`'s table | `tooling/checks/package-graph.ts:11-18` |
| `package-graph.ts` | `--json` | prints the full report as JSON instead of the Markdown table | `tooling/checks/package-graph.ts:20-21` |

### 2.5 `./testing` subpaths packages publish

Five packages export a `./testing` entry (from each `package.json` `exports` map):

| Package | Target | Shape | Cross-package consumers |
|---|---|---|---|
| `@clarvis/loop` | `src/testing/index.ts` | `MockLLM`, `mockMCPFactory`, fresh real-loop MCP/trace infrastructure, and `validateBody` (`packages/loop/src/testing/index.ts`, exports) | `kernel`, `memory` |
| `@clarvis/memory` | `src/testing.ts` | in-memory adapter + `memoryStoreConformance()` case table (`packages/memory/src/testing.ts:70`, `:639`) | `kernel` |
| `@clarvis/plan` | `src/testing.ts` | in-memory repository + `planRepositoryConformance()` / `planStoreConformance()` (`packages/plan/src/testing.ts:39`, `:202`, `:455`) | `kernel` |
| `@clarvis/trace` | `src/testing.ts` | `createMemoryTraceStore()` only (`packages/trace/src/testing.ts:21`) | `kernel`, `loop` |
| `@clarvis/tasks` | `src/testing/provider-conformance.ts` | `assertTaskProviderConformance(fixture)` (`packages/tasks/src/testing/provider-conformance.ts:97`) | none |

The consumer column is the set of packages that import the specifier `@clarvis/<pkg>/testing`
anywhere under `packages/*/{src,tests}`; `tasks` is consumed only through a relative
`../../src/testing.ts` import inside its own suite
(`packages/tasks/tests/component/conformance.test.ts:2`).

`@clarvis/loop`'s is the most used entry of the five, and the doubles behind it are the substrate
almost every engine test stands on, so what they can be *made to do* is worth stating rather than
leaving to be read off a fixture. `packages/loop/src/testing/index.ts` publishes them, the exports
map points `./testing` at that barrel (`packages/loop/package.json:49-53`), and inside the package they
are re-exported once more through `packages/loop/tests/helpers/fixtures.ts:1-9`, which is how 117 of
`loop`'s own test files reach `MockLLM` and 112 reach `mockMCPFactory`. Across packages `MockLLM`
travels to Kernel and Memory, while Memory also consumes `createTestRunInfrastructure` and
`createTestTraceStore` so its real-loop suites do not import MCP Client or Trace directly
(`packages/memory/tests/helpers/indexer-runtime.ts`, `fakeIndexerRuntime`). `mockMCPFactory` has no
consumer outside Loop.

**`MockLLM` is a script, a cursor and a recorder** (`packages/loop/src/testing/mock-llm.ts:69`). It is
constructed with `{ script, routes? }` (`packages/loop/src/testing/mock-llm.ts:39-54`) and consumes one
step per `call`, in order (`packages/loop/src/testing/mock-llm.ts:95-99`). A step is a partial provider
response (`packages/loop/src/testing/mock-llm.ts:16-31`):

| Field | Effect | Default when omitted |
|---|---|---|
| `text`, `reasoning`, `reasoningParts` | the assistant turn's content | `text` is set to `undefined` (`:134`); the two reasoning fields are omitted from the result object entirely (`:135-136`) |
| `toolCalls: {id?, name, arguments?}[]` | the calls the turn requests | `id` becomes `call_<index>`, `arguments` becomes `{}` (`:138-142`) |
| `usage` | a `Partial` of the four counters | `10` input, `5` output, `0` cached, `0` cache-write (`:143-148`) |
| `finishReason` | the provider's stop reason; `"length"` is how a truncated answer is reported (`:29`) | omitted from the result (`:137`) |
| `throw` | fails the call instead of answering it (`:132`) | – |
| `delayMs` | holds the call open before it answers or throws (`:115-131`) | returns immediately |

Two behaviours are load-bearing and easy to lose. **Every call's params are recorded with a
`structuredClone` of `messages`** (`packages/loop/src/testing/mock-llm.ts:71`, `:91`), so an assertion
about request *n* sees the window as it stood at call *n* rather than as later iterations mutated it —
which is what makes the prefix-stability checks possible at all. And **the abort signal is honoured both
before and during a delay**: an already-aborted signal throws the signal's own reason, or a
`DOMException("Mock model call aborted.", "AbortError")` when the reason is not an `Error`
(`packages/loop/src/testing/mock-llm.ts:110-114`), and a `delayMs` wait rejects the same way on abort
rather than running to completion (`packages/loop/src/testing/mock-llm.ts:115-131`) — deliberately, "so
timeout tests cannot accidentally prove that detached model work is acceptable"
(`packages/loop/src/testing/mock-llm.ts:86-88`). The step is consumed *before* the abort check, so an
aborted call still spends its script entry.

**`routes` exist because one cursor cannot describe a concurrent tree.** A route is
`{name, when(params), script}` with a cursor of its own; routes are tried in order, the first whose
`when` matches claims the call, and a call matching none falls back to the bare `script`
(`packages/loop/src/testing/mock-llm.ts:57-62`, `:92`, `:100-108`). The source states the failure this
avoids: a single cursor "can only express a tree whose agents take strict turns — fine while a spawn
blocks its parent, and wrong the moment one does not: a parent and a background child are genuinely
concurrent, and a single cursor hands whichever gets there first the other's lines"
(`packages/loop/src/testing/mock-llm.ts:43-47`). Running out is always an error, never a silent stall,
and a drained route names itself: `MockLLM exhausted (call #N); add more script steps.`
(`packages/loop/src/testing/mock-llm.ts:97`) or `MockLLM route '<name>' exhausted (call #N); add more
steps.` (`packages/loop/src/testing/mock-llm.ts:104-106`).

**`mockMCPFactory(byName)` returns an `MCPClientFactory` over a map of server name to scripted server**
(`packages/loop/src/testing/mock-mcp.ts:60-61`). A tool is `{name, description?, inputSchema?, call}`
(`packages/loop/src/testing/mock-mcp.ts:11-16`) and a resource is
`{uri, name, mimeType?, description?, text?, blob?}` (`packages/loop/src/testing/mock-mcp.ts:25-32`).
What can be injected, and where each fault lands:

| Knob | Behaviour | Source |
|---|---|---|
| server name absent from `byName` | connection throws `No mock MCP configured for tool '<name>'` | `packages/loop/src/testing/mock-mcp.ts:62-65` |
| `connectDelayMs` | delays the connection; applied *before* `connectError` | `packages/loop/src/testing/mock-mcp.ts:66` |
| `connectError` | fails the connection | `packages/loop/src/testing/mock-mcp.ts:67` |
| `listToolsError` | fails only `listTools`; the connection still succeeds | `packages/loop/src/testing/mock-mcp.ts:73` |
| a tool's `call` returning a value | wrapped as one `text` content part, `JSON.stringify`d unless already a string | `packages/loop/src/testing/mock-mcp.ts:94-98` |
| a tool's `call` throwing | surfaced as an `isError: true` tool result, **not** a rejected promise | `packages/loop/src/testing/mock-mcp.ts:99-104` |
| an unknown tool name | `callTool` throws `Tool '<name>' not found` | `packages/loop/src/testing/mock-mcp.ts:91` |
| `resources` present or absent | gates the advertised capability: `{resources:{}}` versus `undefined` | `packages/loop/src/testing/mock-mcp.ts:106-108` |
| a resource's `blob` | returned as binary content; otherwise `text`, defaulting to `""` | `packages/loop/src/testing/mock-mcp.ts:130-131` |
| an unknown resource uri | `readResource` rejects `Resource '<uri>' not found` | `packages/loop/src/testing/mock-mcp.ts:127` |

An omitted `inputSchema` defaults to `{type:"object", properties:{}}`
(`packages/loop/src/testing/mock-mcp.ts:78`), `listResourceTemplates` always answers with an empty array
(`packages/loop/src/testing/mock-mcp.ts:121-123`), and `listResources` **omits** an absent `mimeType` or
`description` rather than setting it to `undefined` (`packages/loop/src/testing/mock-mcp.ts:113-118`) —
the same absent-not-`undefined` discipline the wire types elsewhere require. Closing is one flag shared
by the handle and the client (`packages/loop/src/testing/mock-mcp.ts:134-137`, `:141-144`), and it is
**partial on purpose**: after close, `callTool` throws and `readResource` rejects with
`MCP '<name>' is closed` (`packages/loop/src/testing/mock-mcp.ts:89`, `:125`), while `listTools`,
`listResources` and `getServerCapabilities` keep answering — so a test can assert that dispatch is dead
without the registry it was built from disappearing underneath it.

### 2.6 `bunfig.toml` keys

| Key | Root value | Per-package value | Source |
|---|---|---|---|
| `[install] linker` | `"hoisted"` | absent | `bunfig.toml:1-2` |
| `[test] preload` | `["./tooling/test-runtime/clarvis-home-preload.ts"]` | present in 17 of 18 packages; absent only from type-only `protocol` | `bunfig.toml:13` |
| `[test] coverageReporter` | `["text","lcov"]` | same in all 18 | `bunfig.toml:14` |
| `[test] coverageDir` | `"coverage"` | same in all 18 | `bunfig.toml:15` |
| `[test] coverageSkipTestFiles` | `true` | same in all 18 | `bunfig.toml:16` |
| `[test] coveragePathIgnorePatterns` | **absent** | `["../**"]` in all 18 | e.g. `packages/loop/bunfig.toml:6` |
| `[test] timeout` | **deliberately absent** | absent everywhere | `bunfig.toml:17-21` |
| `[test] coverageThreshold` | absent | absent | (grep of all 19 bunfigs returns nothing) |

The timeout omission remains measured rather than inherited folklore. On 2026-08-22, Bun 1.4.0
ignored `timeout = 60000` in both root-like and package-local scratch `bunfig.toml` files: a
5.25-second test failed at the default 5 seconds in both locations. Every package therefore keeps
`--timeout 60000` on the actual `bun test` command line.

## 3. Data and formats

### 3.1 Test-path grammar

`findUnclassifiedTestFiles` normalises `\` to `/`, then applies two filters
(`tooling/lib/source-policy.ts:65-72`):

```
file matches  /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/   → candidate, else ignored entirely
segment after the LAST "/tests/" in the path        → must be one of TEST_LEVELS
```

So the accepted shape is `…/tests/<level>/**/*.test.{ts,tsx,js,jsx,mts,cts,mjs,cjs}`. Two forms are
explicitly pinned as *rejected* by the unit test: a flat `packages/a/tests/flat.test.ts` and a
hidden `packages/a/tests/helpers/hidden.test.ts`
(`tooling/tests/unit/source-policy.test.ts:38-41`). Windows-shaped paths are normalised
(`tooling/tests/unit/source-policy.test.ts:79-86`).

Actual population across the 18 workspaces (920 `*.test.*` files, counted by the first segment
under `tests/`):

| Level | Files |
|---|---:|
| `unit` | 407 |
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
`field()` (`tooling/checks/coverage.ts:228-231`, `:250-264`):

| Field | Meaning in the aggregate |
|---|---|
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
`{functions: 1, lines: 1}` (`tooling/checks/coverage.ts:260-264`) — protocol's reported 100 % is by
declaration, not by measurement.

Bun 1.4 assigns a distinct LCOV line to a multiline `catch` token even when the handler body runs.
Where a defensive filesystem fault cannot be induced deterministically after a directory handle is
opened, `packages/workflows/src/artifact.ts` keeps the `try` and handler on the guarded source line;
the production fault path remains present and the workflows package retains its 100% source-line
floor without lowering a threshold.

### 3.3 Per-package floors

`PACKAGE_THRESHOLDS` (`tooling/checks/coverage.ts:27-47`) has one entry per workspace:

| Package | min functions | min lines |
|---|---:|---:|
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

Output line format is fixed (`tooling/checks/coverage.ts:409-413`):

```
loop       functions 99.07% (min 96.00%) pass; lines 98.98% (min 98.00%) pass
```

### 3.4 `NO_COUNTER_ALLOWLIST`

A map from short package name to package-relative `src/` paths that are permitted to produce no
LCOV record (`tooling/checks/coverage.ts:75-196`). Its own comment names three legitimate,
permanent reasons — a type-only module, a pure re-export barrel, and an executable entry point a
test cannot import without starting the process it boots (`tooling/checks/coverage.ts:63-66`) — and
records that a fourth, `GRANDFATHERED`, was never legitimate and no longer has any entry
(`tooling/checks/coverage.ts:68-74`).

| Package | Type-only | Barrel | Entry point | GRANDFATHERED |
|---|---:|---:|---:|---|
| capability | 8 | – | – | – |
| code | 4 | – | 2 (`src/cli.ts`, `src/index.tsx`) | – (was `src/adapters/kernel-capabilities-client.ts`; closed 2026-08-22) |
| hooks | – | – | – | – (empty array) |
| kernel | 5 | – | 1 (`src/bin.ts`) | – |
| loop | – | 4 (`host`, `lib`, `workflows`, `workspace`) | – | – (was `src/version.ts` and `src/settings/marketplace-schema.ts`; both closed 2026-08-22) |
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
`export { VERSION } from "./version.ts"` (`packages/loop/src/lib.ts:200`),
`export { ownerFromWorkspace } from "./workspace.ts"` (`packages/loop/src/host.ts:73`) — which is the
shape the allowlist's own comment says "emits no counters of its own"
(`tooling/checks/coverage.ts:121-122`). The package's three *internal* barrels are absent from the list
and pass anyway: `packages/loop/src/runtime/budget/index.ts:7-9`,
`packages/loop/src/runtime/guards/index.ts:9-12` and `packages/loop/src/runtime/support/index.ts:9-14`
spell theirs `export *`, and every one of them is imported by tests
(`packages/loop/tests/unit/budget.test.ts:6`, `packages/loop/tests/unit/doom-loop-guard.test.ts:2`,
`packages/loop/tests/unit/stringify.test.ts:2`). Since `findUnmeasuredSources` fails any `src` module
that neither produced an `SF:` record nor is named on the list (`tooling/checks/coverage.ts:326-327`),
their staying off it is the gate's own evidence that an `export *` line does carry a counter where a
named re-export does not.

Five packages have **no** key at all and fall through `?? []` (`tooling/checks/coverage.ts:314`):
`llm`, `mcp-client`, `paths`, `plan`, `protocol`. ~~Three GRANDFATHERED entries remain.~~ ~~**One
remains** as of 2026-08-22~~ — **none remain**, as of 2026-08-22; see §8 item 10.

The `server/src/bin.ts` entry carries the longest justification in the file
(`tooling/checks/coverage.ts:143-161`): its behaviour *is* tested, by real subprocess tests, but
"Bun's coverage instrumentation only sees code running inside the `bun test` process itself, so a
subprocess contributes no counters here no matter how thoroughly it is tested". The same
cross-reference is written from the other side, in the test:
`packages/server/tests/architecture/bin-bind-gate.test.ts:9-20`.

`TYPE_ONLY_PACKAGES` is a separate one-member set, `{"protocol"}`
(`tooling/checks/coverage.ts:55`).

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
|---|---|---|---:|
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
public DTOs (`packages/protocol/tests/contract/public-contract.fixture.ts:1-37`).

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

Production modules that carry this shape say so at the line, including
`packages/plan/src/store.ts:293` and the corresponding Code boot failure path.

## 4. Behavior

### 4.1 The gate, in the order it runs

`git commit` → `.githooks/pre-commit` resolves the repo root, `cd`s to it and `exec`s
`bun run check:pre-commit` (`.githooks/pre-commit:4-7`). The hook is only wired up if
`core.hooksPath` points at `.githooks`, which is what `bun run hooks:install` sets
(`package.json`, `scripts.hooks:install`). Then, sequentially
(`package.json`, `scripts.check:pre-commit`):

| # | Phase | Internal fan-out | What it can catch |
|---|---|---|---|
| 1 | `format:check` | `--parallel` across workspaces, then root Prettier | package formatting plus root tooling, authored public docs and `.github/workflows/docs.yml` |
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
   (`tooling/checks/source-policy.ts:19-40`).
2. Append every file under the repository's own `tooling/` to `moduleMockFiles`
   (`tooling/checks/source-policy.ts:41`).
3. **Empty-promise-catch budget** — for each `src` file, count matches of
   `/\.catch\(\(\)\s*=>\s*\{\s*\}\)/g` and compare against `baseline.get(file) ?? 0`
   (`:45-51`). The map has exactly one entry: `packages/capability/src/tasks.ts → 1`
   (`:7`). That one occurrence is `suppressSecondaryRejection`'s
   `void Promise.resolve(promise).catch(() => {})`
   (`packages/capability/src/tasks.ts:70`). The two empty `catch {}` *blocks* in the same file
   (`:42`, `:45`) are not matched by the regex; they are governed instead by ESLint's
   `no-empty: ["error", {allowEmptyCatch: true}]` (`eslint.config.base.js:42`).
4. **`mock.module()` ban** — for each file in `moduleMockFiles`, parse it with the TypeScript AST
   and report every `CallExpression` whose callee is a `PropertyAccessExpression` of the identifier
   `mock` with property name `module` (`tooling/lib/source-policy.ts:33-42`). There is no allowlist
   and no baseline. The script never writes the literal string, assembling the label as
   `["mock", ".module()"].join("")` so that the checker does not trip itself
   (`tooling/checks/source-policy.ts:44`).
5. **Level classification** — run `findUnclassifiedTestFiles(packageTestFiles)`; each hit becomes
   `"<file>: test file must live under tests/{unit,component,contract,integration,architecture,e2e}"`
   (`:60-64`). Repository checker tests live under the same named levels at
   `tooling/tests/{unit,architecture}` and are invoked by `test:tooling`.
6. If anything failed, print `Task-intent violations:` followed by every failure and the remedy
   sentence — "Use dependency injection instead of `mock.module()`; use bestEffort, detachObserved,
   or suppressSecondaryRejection instead of empty catches" — and set `process.exitCode = 1`
   (`:65-72`). It reports **all** violations, never the first.

Current state: the script exits 0, and a repo-wide search for `mock.module`, `vi.mock` and
`jest.mock` returns zero hits.

### 4.3 `coverage.ts`

For each of the 18 entries in `PACKAGE_THRESHOLDS`, in object order
(`tooling/checks/coverage.ts:404`):

1. `readOwnSourceCoverage` reads `packages/<pkg>/coverage/lcov.info` with a bare `readFile`. On
   `ENOENT` it rethrows *unless* the package is in `TYPE_ONLY_PACKAGES`, in which case it first
   `readdir`s the package's `src/` — so a missing report is excused but a missing package is not —
   and returns `{functions: 1, lines: 1, measured: new Set()}` (`:204-212`).
2. Records are split on `end_of_record`; a record with no `SF:` line is skipped. The `SF:` path is
   resolved against the package directory and kept only if the package-relative result is `src` or
   starts with `src/` — this is the "own source" filter, and it is what makes the per-package
   `coveragePathIgnorePatterns = ["../**"]` a belt-and-braces measure rather than the only one
   (`:217-231`).
3. If `linesFound` is still 0: a type-only package returns the synthetic `{1, 1}`, anything else
   throws `` `${packageName}: LCOV report contains no own-source line data` `` (`:233-238`).
4. Ratios: `functionsFound === 0 ? 1 : hit/found` for functions, `linesHit/linesFound` for lines
   (`:240-244`). Note the asymmetry — a package with zero functions scores 1, a package with zero
   lines has already thrown.
5. The two ratios are compared with `>=` against the floor and one line per package is printed
   (`:321-339`).
6. `findUnmeasuredSources` walks the package's `src/` for `.ts`/`.tsx` excluding `.d.ts`
   (`:172-191`) and then branches (`:293-301`):
   - **type-only package**: every module is read and run through `looksExecutionFree`; anything with
     a runtime export lands in `runtimeExports`. `measured` is ignored entirely, so a stale LCOV
     record cannot excuse a runtime export.
   - **ordinary package**: a module that is neither in `measured` nor in the allowlist lands in
     `unmeasured`.
   - `stale` is computed either way: allowlist entries that were in fact measured, or that name a
     file that no longer exists (`:305`).
7. `unmeasured` and `runtimeExports` become failures with a remedial sentence naming
   `NO_COUNTER_ALLOWLIST in tooling/checks/coverage.ts` (`:346-360`). `stale` is deliberately
   **not** a failure — it is logged, under the comment "a stale entry is someone having closed a gap
   or deleted a file, and breaking their build for it would be a poor thank-you"
   (`:361-367`).
8. All failures across all packages are collected and thrown as one
   `AggregateError(failures, "Own-source coverage checks did not pass")` (`:370-372`); success
   prints `All own-source coverage thresholds passed, over every src module.` (`:373`).

`looksExecutionFree` (`:263-271`) strips block and line comments, deletes `export type …` lines, and
then tests for any of: `export default`, `export [async|abstract]* const|let|var|function|class|enum`
(with `const enum` excluded via a negative lookahead), `export * [as X] from`, or
`export { … } from|;`. Its own docblock calls it "a heuristic over syntax, not a type checker"
(`:257-261`). It is reachable only through the `TYPE_ONLY_PACKAGES` branch, i.e. today only for
`@clarvis/protocol`'s 18 modules (2,933 lines).

### 4.4 `stream-metrics-drift.test.ts`

Two files are declared duplicates by construction:
`packages/llm/src/stream-metrics.ts` and `packages/code/src/adapters/stream-metrics.ts`
(`tooling/tests/architecture/stream-metrics-drift.test.ts:4-7`).

`normalize()` (`:9-22`) does two things: it rewrites the **first** match of
`/source\s*=\s*["'](?:loop|code)["']/` to `source = "owner"` — the one authorised difference, which
is each copy's default `source` tag (`packages/llm/src/stream-metrics.ts:100` vs
`packages/code/src/adapters/stream-metrics.ts:102`) — and then runs a TypeScript `Scanner` with
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
(`packages/llm/src/stream-metrics.ts:21-22`).

### 4.5 `package-graph.ts`

`analyzePackageGraph` walks each workspace's `src`, `tests` and `tooling` trees
(`tooling/lib/package-graph.ts:6`, `:357-359`), parses every module edge through the TypeScript AST
(`:78-136`), and emits the following errors (all deduplicated and sorted, `:574`):

| Error | Condition | Line |
|---|---|---|
| `unknown workspace package X` | a `@clarvis/*` specifier naming no workspace | `:371` |
| `source imports its own public entrypoint X` | a `src` file importing its own package root specifier | `:378-380`, and again by resolved target at `:426-430` |
| `imports undeclared dependency X` | any tree imports a workspace not in any dep field | `:382-385` |
| `imports runtime dependency X … declared only for development` | a **`src`** value import of a devDependency-only workspace | `:386-395` |
| `X is not exported by Y` | the requested subpath is absent from the target's `exports`, evaluated under runtime vs type-only condition sets | `:396-401` |
| `relative import crosses into X` | a `./…` specifier resolving inside another package's directory | `:403-412` |
| `declares unknown workspace dependency X` / `declares unused internal dependency X` | manifest vs actual usage | `:444-451` |
| `dependency without project reference X` / `project reference without runtime dependency X` | `tsconfig.build.json` references vs runtime deps | `:452-460` |
| `root tsconfig missing/unknown project reference X` | root solution file vs the set of packages with a `tsconfig.build.json` | `:463-485` |
| `dependency cycle: …` | Tarjan SCC over declared runtime deps | `:493-497` |
| `compilation cycle: …` | Tarjan SCC over all source edges, reported only when not already a declared cycle | `:499-516` |
| `X: runtime module cycle: …` | Tarjan SCC over intra-package value edges | `:518-528` |

`DEP_FIELDS` (`tooling/lib/package-graph.ts:7`) is
`["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]` — a fourth field,
`peerDependencies`, is co-equal with the other three in `pkg.declared` (`:343`) and therefore
participates in the unknown/unused-dependency checks above, but it is absent from `runtimeDeclared`
(`:344-347`, built only from `dependencies` and `optionalDependencies`), so a `peerDependencies` entry
is invisible to the devDependency-only-import check and to the project-reference checks. No package
in the tree currently declares one (`rg peerDependencies packages/*/package.json` is empty), so the
gap is latent rather than live.

The edge taxonomy is what makes the last three meaningful, and it is pinned case by case in
`tooling/tests/unit/package-graph.test.ts:7-34`: `import type`, `export type`, `export { type Z } from`
and `import { type U } from` are all `typeOnly: true`; `type Q = import("…")` is likewise
`typeOnly: true` (it is a static edge nonetheless: `kind: "static"`). The plain
`import alias = require("…")` form is pinned `typeOnly: false` — the same bucket as a bare
`require("…")` — and only `import("…")` is `dynamic`. (`node.isTypeOnly` on an
`ImportEqualsDeclaration` can be `true` for `import type alias = require(...)`, but that spelling is
not the one the fixture exercises.) A type-only back edge dissolves a module cycle
(`tooling/tests/unit/package-graph.test.ts:112-127`).

`--check-doc` additionally reads `specs/package-coupling-analysis.md` and compares the two numeric
columns of each package's row (`tooling/checks/package-graph.ts:11-18`,
`tooling/lib/package-graph.ts:610-629`).

**`runtimeClosure`'s two fields are two different algorithms, not two filters of the same walk.**
`reachableFrom` (`tooling/lib/package-graph.ts:250-260`) is a plain breadth-first search over the
eager-runtime adjacency alone — every package transitively reachable through non-type-only, non-
dynamic edges. `dynamicReachableFrom` (`:262-283`) walks eager and dynamic edges together but tags
each queued node with whether the path to it has *already crossed* a dynamic edge, and only adds a
node to the result once that flag is set; from there it keeps expanding eagerly. So `dynamic` answers
"what can this package reach only by first going through a lazy `import()`" — exactly the shape
`@clarvis/loop`'s optional-package-boundary tests need (§4.10) to prove an eager entry point never
reaches an optional package while still allowing an explicit dynamic subpath to load it. Pinned by
`tooling/tests/unit/package-graph.test.ts:159-174` ("separates type-only, eager, and dynamic edges and
computes dynamic closure") and `:176-209`.

### 4.5.1 `bun-sources.ts`

`repositoryPaths(root)` asks Git for the NUL-delimited union of tracked and unignored paths with
`git ls-files --cached --others --exclude-standard -z`, fails if Git exits non-zero, and keeps only
paths that still exist (`tooling/checks/bun-sources.ts:13-31`). `pythonSourcePaths(paths)` then
matches `.py`, `.pyi` and `.pyw` case-insensitively and sorts the result (`:5`, `:8-10`). The CLI
prints every match under `Python source files are not allowed; use Bun/TypeScript:` and exits 1, or
prints `bun sources: no tracked Python source files` (`:33-44`). Dependencies and ignored build
output are outside this inventory by construction. The extension matrix is pinned at
`tooling/tests/unit/bun-sources.test.ts:4-16`.

### 4.6 Test-process isolation: `tooling/test-runtime/clarvis-home-preload.ts`

At preload time — before any test module is evaluated — the file checks whether
`process.env[HOME_ENV]` (i.e. `CLARVIS_HOME`, `packages/paths/src/roots.ts:11`) is unset or blank.
If so it `mkdtempSync`es `clarvis-test-home-` under the OS temp dir, assigns it, and registers a
`process.on("exit")` that `rmSync`es it, swallowing failure with the comment "a live child may still
hold a handle; the OS reaps the temp dir" (`tooling/test-runtime/clarvis-home-preload.ts:24-33`). An
already-set value is left alone.

The docblock states the mechanism and why a fixture cannot do it: per-workspace machinery "resolves
under the global root rather than inside the working tree", and "the writers resolve the root from
the ambient environment at call time, so nothing a test passes to a helper can redirect them"
(`tooling/test-runtime/clarvis-home-preload.ts:7-23`).

The root `bunfig.toml` carries the same preload with a production incident behind its comment: "102
stray `~/.clarvis/state/workspaces/_tmp_clarvis-plan-*` directories got written into a real `$HOME`
during one afternoon of stress-running a suite by path" (`bunfig.toml:8-9`), attributed to Bun
resolving `bunfig.toml` from the *cwd* and not merging a package's with the root's. The comment also
gives a controlled measurement of the same failure: "a root-cwd run of one plan test file leaked 17
directories, the same file via `bun --filter @clarvis/plan test` leaked none" (`bunfig.toml:5-13`).
That configuration is not decorative — the repository currently contains
a root-level `coverage/lcov.info` whose 13 `SF:` records span `packages/paths/src/*`,
`packages/protocol/src/index.ts` **and `tooling/test-runtime/clarvis-home-preload.ts`**, which is the fingerprint of
exactly such a root-cwd run (and shows the root bunfig's lack of `coveragePathIgnorePatterns`).
CI itself makes two root-cwd runs, in the Windows and macOS keyboard-policy jobs
(`.github/workflows/ci.yml`, jobs `windows` and `keyboard-macos`).

Seventeen of the eighteen packages repeat the preload in their own `bunfig.toml`; only the
type-only `protocol` package omits it.

`@clarvis/code`'s bunfig is the only one with a four-entry preload list and an ordering rule stated
inline: `@opentui/solid/preload` must stay first because it registers the Solid JSX transform, and
the tree-sitter preload must precede anything that loads `src/`
(`packages/code/bunfig.toml:8-17`). Its top-of-file comment also records why there is no *global*
`preload` key: it applied to every Bun process started from that directory and cost each ~250 ms
(`packages/code/bunfig.toml:1-5`).

Of those four, `tests/helpers/ascii-preload.ts` is four lines — two imports, a blank line, then a
`beforeEach` registration (`packages/code/tests/helpers/ascii-preload.ts:1-4`), and
`tests/helpers/tree-sitter-preload.ts`
stubs `TreeSitterClient.prototype.startWorker` to a no-op before any client is constructed
(`packages/code/tests/helpers/tree-sitter-preload.ts:67`), then patches three methods on the
singleton (`:71-75`). Its docblock records a measurement: the previous arrangement "spawned and
terminated **82** workers" across the suite, and with the spawn path closed "the count is zero"
(`:41-45`). The stub is pinned by a test that reads the private `worker` field, with a note that
swapping `globalThis.Worker` "counts zero whether or not a worker was created"
(`packages/code/tests/integration/tree-sitter-preload.test.ts:4-26`).

### 4.7 The `--timeout` rule

The root `bunfig.toml` documents, in place of the setting, why the setting is absent: the historical
Bun 1.3.14 probe found `[test] timeout` silently ignored, and the Bun 1.4 migration deliberately
retains the proven `--timeout` CLI contract unless a separate measured change moves it
(`bunfig.toml:17-20`).

Verified against the then-pinned 1.3.11 toolchain: a scratch project with
`[test] timeout = 60000` in its `bunfig.toml` and a single test that sleeps 8 s fails with
`this test timed out after 5000ms`. The claim holds on 1.3.11 as well as on the 1.3.14 the comment
names.

### 4.8 The CI retry wrapper

`tooling/ci/retry-code-coverage.sh` runs `bun run test:coverage` once; on exit 0 it stops
(`:48-52`). Otherwise it retries **up to 3 times**, and only while `is_crash_exit` holds
(`:31`, `:54-64`). The classifier is a three-value case: 132 (SIGILL, "Bun's @trap"), 134 (SIGABRT),
139 (SIGSEGV) (`:34-39`).

| Exit | Retried? | Reason given in the file |
|---|---|---|
| 0 | n/a | success |
| 132 / 134 / 139 | yes, ≤3× | Bun crash signals |
| 130 (SIGINT) | **no** | "somebody asked this to stop — a cancelled workflow, or Bun killing sibling scripts after one of them failed" (`:13-14`) |
| 143 (SIGTERM) | **no** | same |
| anything else | no | a real test failure |

Each retry re-runs `bun --filter @clarvis/code test:coverage` **alone**, then `bun run coverage:check`
(`:58-62`). The file states the precondition that makes that sound: `code` is last in the sequential
root script, so every other package has already written its lcov; and if any other package died by
signal its report would be missing and `coverage:check` "fails loudly", because check-coverage reads
each report with a bare `readFile` (`:22-28`). A retry emits a `::warning::` annotation and appends a
line to `$GITHUB_STEP_SUMMARY` (`:41-46`).

### 4.9 Conformance harnesses

Four distinct shapes exist.

| Shape | Example | Assertion vehicle | Driver |
|---|---|---|---|
| **case table as data** | `memoryStoreConformance(): readonly ConformanceCase[]` (`packages/memory/src/testing.ts`, `memoryStoreConformance`), 31 cases | `node:assert/strict` | a `for … of` that wraps each case in a `test()` (`packages/memory/tests/contract/store.test.ts:38-50`) |
| same | `planRepositoryConformance()` (18 cases) + `planStoreConformance()` (10 cases) (`packages/plan/src/testing.ts`, `planRepositoryConformance` and `planStoreConformance`) | `node:assert/strict` | `packages/plan/tests/contract/repository.test.ts`, `plan-store.test.ts` |
| **suite registrar** | `traceStoreConformance(name, createHarness)` (`packages/trace/tests/contract/trace-store-conformance.ts:13`), 16 `it()` blocks | `bun:test` `expect` | called twice, once per backend (`packages/trace/tests/contract/trace-store.test.ts:9-17`) |
| **single async assertion** | `assertTaskProviderConformance(fixture)` (`packages/tasks/src/testing/provider-conformance.ts:97`) | zod `.parse` + a local `assert` throwing `Task provider conformance: …` (`:54-56`) | `packages/tasks/tests/component/conformance.test.ts` |

The first two shapes live in `src/` and the third does not, and the source states why: memory's and
plan's tables are "exposed as **data** rather than as `describe`/`test` calls, and assert through
`node:assert/strict`, so this module carries no test-runner dependency and an adapter living in
another package (or another runner) can drive the same cases"
(`packages/memory/src/testing.ts:1-9`, `packages/plan/src/testing.ts:1-9`). The trace registrar
imports `bun:test` directly (`packages/trace/tests/contract/trace-store-conformance.ts:1`) and
therefore cannot be published from `src`.

A harness declares optional capabilities and cases that need one they lack "return early rather than
failing": `MemoryStoreHarness` carries optional `poke` and `atomic` flags
(`packages/memory/src/testing.ts:596-607`, `:635-637`).

Each driver runs the same table against every adapter — memory against `file` and `in-memory`
(`packages/memory/tests/contract/store.test.ts:33-36`), trace against `memory` and `JSON`
(`packages/trace/tests/contract/trace-store.test.ts:9-17`).

### 4.10 The `architecture` level's idiom

Architecture tests do not import the code they police; they read it as **text** and scan it. The
recurring structure has four parts, all four present in `packages/paths/tests/architecture/invariant.test.ts`:

1. A matcher regex over source lines (`:12`).
2. A comment filter, because "TSDoc writes `` `.clarvis` `` in backticks, which no regex can tell
   from a template literal … only computation must not" (`:14-28`).
3. An explicit, currently-empty exception list, kept "so that a deliberate, reviewed exception can be
   recorded rather than the assertion being weakened" (`:30-39`), plus a second test asserting the
   list names nothing already fixed (`:71-74`).
4. **Positive and negative controls on the matcher itself** — six lines that must match (`:76-87`),
   four that must be seen as comments (`:89-98`), three near-misses that must not match (`:100-104`).

Two further conventions recur. The scanned tree set is `packages/*/src` *and* `packages/*/tooling`
(`:41-51`) — the same two of the three trees `package-graph.ts`'s `SOURCE_TREES` walks
(`tooling/lib/package-graph.ts:6`, which also includes `tests`), and matching
`source-policy.ts`'s per-package scopes for those two trees. And fixture strings are assembled
at runtime rather than written literally, so the guard does
not fire on its own test — `packages/loop/tests/architecture/optional-package-boundary.test.ts:53-59`
does it for import specifiers, exactly as `tooling/checks/source-policy.ts:44` does for the `mock.module`
label.

The same positive-and-negative control discipline appears in the root architecture suite's
normalizer test (`tooling/tests/architecture/stream-metrics-drift.test.ts`, "the normalizer permits
only the owner-specific default").

## 5. Invariants

1. **INV-303 — every `*.test.*` file under a package's `tests/` tree has one of the six level names
   as its first path segment below `tests/`** (deeper nesting inside a level is unconstrained).
   Rule: `tooling/lib/source-policy.ts:3-10` + `:64-74`; enforced at
   `tooling/checks/source-policy.ts:60-64`. Pinned by `tooling/tests/unit/source-policy.test.ts:31-51`
   (accepts `unit`/`integration`/`e2e`, rejects a flat file and one under `helpers/`).
   Currently satisfied: 924 test files, 0 unclassified.

2. **INV-304 — `mock.module()` appears nowhere in `packages/*/{src,tests,tooling}` or root `tooling/`,
   with no allowlist and no baseline.** Rule: `tooling/checks/source-policy.ts:52-59`, matcher at
   `tooling/lib/source-policy.ts:33-42`. Pinned by `tooling/tests/unit/source-policy.test.ts:7-15`, which
   asserts a direct, an `await`-prefixed, and a `void`-prefixed call are all detected with correct
   line/column, and by `:6-28` more broadly, which also pins that the matcher ignores comments,
   string literals, `other.module("pkg")`, and a bare property read. Currently satisfied at zero
   occurrences.

3. **INV-305 — `packages/capability/src/tasks.ts` is the only production file permitted an empty
   promise catch, and it is permitted exactly one.** Rule: `tooling/checks/source-policy.ts:7` (baseline map)
   + `:45-51`. The occurrence is `packages/capability/src/tasks.ts:70`, inside
   `suppressSecondaryRejection`, which throws if given an empty `observedBy` (`:67-69`) — so the
   suppression cannot be used anonymously. **Unpinned** by any test; the baseline is a literal in
   the checker.

4. **INV-305 (scope half) — `tests/` and `tooling/` are exempt from the empty-catch budget; only
   `src/` is scanned.** Rule:
   `tooling/checks/source-policy.ts:25` (only `sources` reaches `sourceFilesToCheck`) vs `:31-41`
   (tests and tooling reach `moduleMockFiles` only). **Unpinned.**

5. **INV-307 — every `src` module of every non-type-only package produces an `SF:` LCOV record, or
   is named in `NO_COUNTER_ALLOWLIST` with a reason.** Rule: `tooling/checks/coverage.ts:317-393`, failure at
   `:345-351`. The stated mechanism it defends against is at `:38-42`: "A module that NO test file
   imports is absent from LCOV entirely rather than present at 0% — it contributes to neither
   numerator nor denominator". Partially pinned by
   `tooling/tests/unit/coverage.test.ts:41-48`.

6. **INV-307 (tolerance half) — a stale allowlist entry is reported but never fails the check.** Rule:
   `tooling/checks/coverage.ts:340` (computation) and `:445-462` (log, not failure, with the
   in-file reason). **Unpinned.**

7. **INV-307 (type-only half) — a package declared type-only may contain no runtime export, and a
   stale LCOV record does not excuse one.** Rule: `tooling/checks/coverage.ts:327-331` (the type-only branch ignores
   `measured` entirely) + `:354-359`. Pinned by `tooling/tests/unit/coverage.test.ts:41-48`
   ("still reports runtime exports even when stale LCOV names the module") and by `:50-63`
   (interfaces and `export type * from` are accepted).

8. **INV-307 (absent-report half) — an absent `coverage/lcov.info` is tolerated only for a
   `TYPE_ONLY_PACKAGES` member, and only when the package's `src/` really exists.** Rule: `tooling/checks/coverage.ts:239-247`. Pinned by
   `tooling/tests/unit/coverage.test.ts:25-32` (protocol tolerated, kernel rejects with `ENOENT`)
   and `:34-39` (a missing type-only package still throws `ENOENT`).

9. **INV-306 (hard-error half) — an LCOV report that names own-source files but reports zero lines
   is a hard error for a non-type-only package.** Rule: `tooling/checks/coverage.ts:260-264`, message
   `"<pkg>: LCOV report contains no own-source line data"`. **Unpinned** by a test; relied upon in
   prose by `tooling/ci/retry-code-coverage.sh:25-28`.

10. **INV-306 (own-source half) — only `src/`-relative `SF:` records enter a package's ratios; a
    workspace dependency's source cannot.** Rule: `tooling/checks/coverage.ts:251-256`, reinforced by
    `coveragePathIgnorePatterns = ["../**"]` in all 18 package bunfigs. ~~**Unpinned.**~~
    **Pinned 2026-08-22 on its reinforcement half**: `checkPackageHarness` fails any package bunfig
    whose `[test] coveragePathIgnorePatterns` omits `"../**"`, naming the consequence — "workspace
    dependencies enter this package's ratios" (`tooling/lib/test-harness.ts:190`-`:195`, over
    `REQUIRED_IGNORE_PATTERN` at `:47`), and `tooling/tests/unit/test-harness.test.ts:111` holds it. Type-only
    packages are **not** excused this one, which is why `packages/protocol/bunfig.toml:5` carries it
    too. The `src/`-relative `SF:` filter inside `coverage.ts` still has no direct test.

11. **INV-310 (timeout half) — the per-test timeout lives on the CLI, never in a `bunfig.toml`.** Rule: the absence itself,
    documented at `bunfig.toml:17-21`; every `bun test` script carries `--timeout 60000`.
    ~~**Unpinned** — no test asserts that a package's `test` script carries the flag.~~
    **Pinned 2026-08-22** by `tooling/checks/test-harness.ts`, in both directions and for every package.
    `bunTestInvocations` expands a package's `test` script through the other scripts it delegates to
    (`tooling/lib/test-harness.ts:60`-`:72`), so the flag is required on each `bun test` a package can
    actually reach rather than on the literal one line (`:160`-`:166`, over `REQUIRED_TIMEOUT` at
    `:9`); and `[test] timeout` is a forbidden bunfig key, refused with the reason that Bun parses it
    and ignores it (`:29`-`:38`, applied at `:179`-`:181`). Unit-pinned at
    `tooling/tests/unit/test-harness.test.ts:87` and `:99`, with the expansion itself at `:27`, `:44` and
    `:48`. The checker reads package bunfigs only, so the *root* bunfig's abstention is still held by
    the comment at `bunfig.toml:17-20` alone. Empirically confirmed before migration on Bun 1.3.11 that a
    bunfig `[test] timeout` is ignored and the 5 000 ms default applies.

12. **INV-306 — coverage thresholds live only in `tooling/checks/coverage.ts`, and are computed by
    summing LCOV counters rather than read from Bun's per-file average.** Rule:
    `tooling/checks/coverage.ts:27-47`; no `coverageThreshold` key appears in the root or any package
    `bunfig.toml`. ~~**Unpinned.**~~ **Pinned 2026-08-22 for the package half**: `coverageThreshold`
    is the second forbidden bunfig key, refused with its own reason — floors live only in
    `coverage.ts`, which sums LCOV counters rather than averaging per file
    (`tooling/lib/test-harness.ts:34`-`:37`, applied at `:179`-`:181`; pinned by
    `tooling/tests/unit/test-harness.test.ts:105`). The root bunfig is checked for the preload only
    (`tooling/checks/test-harness.ts:49`-`:54`), so its abstention from both forbidden keys remains
    unpinned.

13. **INV-310 (preload half) — a test process never writes into the developer's real
    `CLARVIS_HOME`.** Rule:
    `tooling/test-runtime/clarvis-home-preload.ts:24-33`, wired at `bunfig.toml:13` and in seventeen package bunfigs.
    ~~**Unpinned** — nothing asserts the preload is registered where it is needed, and eleven package
    bunfigs omit it.~~ **Pinned 2026-08-22**, and the count was the finding. `checkPackageHarness`
    requires a `preload` entry ending in `clarvis-home-preload.ts` in every non-type-only package bunfig
    (`tooling/lib/test-harness.ts:183`-`:188`, over `PRELOAD_BASENAME` at `:18`), and
    `tooling/checks/test-harness.ts:49`-`:54` checks the root bunfig separately, because a run by path
    from the repository root reads that file and no package's. Pinned by
    `tooling/tests/unit/test-harness.test.ts:93`, which asserts the failure names its consequence.

    Ten of the nineteen packages were missing it, and adding it turned two `@clarvis/skills` tests
    red on the spot: both had been passing only because the ambient environment had no
    `CLARVIS_HOME`, so `clarvisSkillRoots` fell back to the developer's real `~/.clarvis` and matched
    an expectation written for it. That is the failure the preload exists to expose, and the rule the
    two tests should have been pinning is now asserted rather than assumed —
    `packages/skills/tests/unit/preset.test.ts:33` ("lets CLARVIS_HOME outrank the injected home for
    the clarvis user root only") and `:51` (it is read from the ambient process env when none is
    injected), with the three older cases passing `env: {}` so they state their environment instead
    of inheriting one.

14. **INV-310 (idempotence half) — a pre-set `CLARVIS_HOME` is never overwritten by the preload.** Rule:
    `tooling/test-runtime/clarvis-home-preload.ts:24` — the guard is `undefined || trim() === ""`. **Unpinned.**

15. **INV-308 — `packages/llm/src/stream-metrics.ts` and
    `packages/code/src/adapters/stream-metrics.ts` are token-identical except for the `source`
    default.** Rule:
    `tooling/tests/architecture/stream-metrics-drift.test.ts`, "the two production stream metrics
    implementations stay token-identical". The separate test "the normalizer permits only the
    owner-specific default" pins both the authorized owner-default difference and rejection of an
    unrelated token difference.

16. **INV-309 (a) — no `src` file imports its own package's public entrypoint.** Rule:
    `tooling/lib/package-graph.ts:373-381` (by specifier) and `:414-431` (by resolved target).
    Pinned by `tooling/tests/unit/package-graph.test.ts:102-110`.

17. **INV-309 (b) — a `src` value import may only name a workspace declared in `dependencies` or
    `optionalDependencies`; a devDependency-only workspace may be imported from `tests`/`scripts`
    alone.** Rule: `tooling/lib/package-graph.ts:386-395` (`runtimeDeclared` is
    `dependencies ∪ optionalDependencies`, `:345-348`). Pinned by
    `tooling/tests/unit/package-graph.test.ts:176-209`.

18. **INV-309 (c) — every `@clarvis/*` name a package declares (in any of `dependencies`, `devDependencies`,
    `optionalDependencies` or `peerDependencies`) must resolve to a real workspace and be referenced
    by at least one source edge somewhere in that package's `src`/`tests`/`scripts` trees.** Rule:
    `tooling/lib/package-graph.ts:436-451` (`declares unknown workspace dependency X` /
    `declares unused internal dependency X`). **Unpinned** — neither message string is asserted
    anywhere in `tooling/tests/unit/package-graph.test.ts`.

19. **INV-309 (d) — every workspace runtime dependency has a matching `tsconfig.build.json` project
    reference and vice versa, and the root solution file references exactly the packages that have one.** Rule:
    `tooling/lib/package-graph.ts:452-460`, `:463-485`. Pinned by
    `tooling/tests/unit/package-graph.test.ts:228-247`, including the JSONC-with-comments case.

20. **INV-309 (e) — no declared cycle, no compilation cycle, and no intra-package runtime module
    cycle.** Rule:
    `tooling/lib/package-graph.ts:493-528`. Pinned by `tooling/tests/unit/package-graph.test.ts:112-127`
    (module cycles, and the type-only back edge that dissolves one) and `:211-226` (declared and
    compilation cycles). Currently satisfied: `errors: []` over the real tree.

21. **INV-309 (f) — a deep import must be a subpath the target's `exports` actually publishes, evaluated under the
    right condition set.** Rule: `tooling/lib/package-graph.ts:147-158`, `:396-401` —
    `{bun, import, require, default}` for a value import, plus `types` for a type-only one. Pinned by
    `tooling/tests/unit/package-graph.test.ts:129-157`, which asserts a `{types: …}`-only subpath is legal
    for `import type` and illegal for a value import.

22. **INV-309 (g) — no relative import crosses a package boundary.** Rule:
    `tooling/lib/package-graph.ts:403-412`. Pinned by `tooling/tests/unit/package-graph.test.ts:249-260`.

23. **Every package's `tsconfig.json` includes its `tests` tree**, so the gate's `typecheck` phase
    type-checks test sources. Verified by reading all 18: fourteen use
    `["src/**/*.ts","tests/**/*.ts"]`, and `code`, `kernel`, `protocol`, `server` use
    `["src","tests"]` (e.g. `packages/protocol/tsconfig.json`, `packages/kernel/tsconfig.json`).
    **Unpinned.**

24. **Repository checker tests are first-class classified suites.** Ten focused test files live under
    `tooling/tests/unit/`; the public-documentation and stream-metrics test files live under
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
    (`.gitattributes:1-8`).

27. **INV-311 (order half) — the gate is one strictly sequential `&&` chain in a fixed order.**
    `format:check → build → typecheck → lint:eslint → lint:intent → knip → test:coverage`
    (`package.json`, `scripts.check:pre-commit`), invoked by a hook that does nothing else
    (`.githooks/pre-commit:4`-`:5`, `:23`). `build` sits immediately before `typecheck` because
    `typecheck` resolves cross-package types through the built `dist/*.d.ts`, so running it against a
    stale `dist` reports errors that do not exist. `lint:intent` has its own inner order —
    `test:tooling`, `check:source-policy`, `check:graph`, `check:specs`, `check:harness`,
    `check:bun-version`, `check:bun-sources`, `check:imports` and `check:release`
    (`package.json`, `scripts.lint:intent`). ~~**Unpinned**: the order is a literal in
    one npm script, and nothing asserts it.~~ **Pinned 2026-08-22** for the top-level chain:
    `checkGateChain` splits `check:pre-commit` on `&&`, strips `bun run`, and compares the result to
    `GATE_PHASES` (`tooling/lib/test-harness.ts:208`-`:241`), so a dropped phase, a reordered chain and a
    restored top-level `--parallel` are each reported on their own, and an absent script is reported
    rather than passing vacuously (`tooling/tests/unit/test-harness.test.ts:146`, `:150`, `:154`, `:162`,
    `:166`). `lint:intent`'s inner order is **not** covered — it remains a literal in one npm script.
    Combined with item 25, a clone that never ran `bun run hooks:install` runs none of it and gets no
    signal.

28. **INV-309's document half makes a `specs/` file a build input.** `check:graph` passes
    `--check-doc` unconditionally (`package.json`, `scripts.check:graph`) and
    `tooling/checks/package-graph.ts:15` reads
    `specs/package-coupling-analysis.md` with a bare `readFileSync`, so deleting that document breaks
    every commit rather than only the rule it encodes. It is generated from the analyzer's own
    `renderMarkdown` (`tooling/lib/package-graph.ts:591`) so the two cannot drift.

29. **The repository carries no tracked or unignored Python source.** `.py`, `.pyi` and `.pyw`
    paths are rejected case-insensitively; Bun/TypeScript remains the repository's implementation
    and maintenance runtime. This does not constrain user-installed toolchains or language-neutral
    capability executables. Production: `tooling/checks/bun-sources.ts:5-10`, invoked by
    `check:bun-sources` inside `lint:intent` (`package.json`, `scripts.lint:intent` and
    `scripts.check:bun-sources`). Test:
    `tooling/tests/unit/bun-sources.test.ts:4-16` pins accepted Bun/TypeScript paths, all three
    rejected extensions, case insensitivity and deterministic sorting.

## 6. Failure modes and degradation

| Condition | Handler | Outcome |
|---|---|---|
| Any task-intent violation | `tooling/checks/source-policy.ts:65-72` | all violations printed under `Task-intent violations:`, `process.exitCode = 1`. Never first-failure-only. |
| A package directory has no `src`/`tests`/`scripts` | `tooling/checks/source-policy.ts:27-29`, `:36-38` | `ENOENT` swallowed; any other error rethrows |
| Missing `coverage/lcov.info`, non-type-only package | `tooling/checks/coverage.ts:239-243` | raw `ENOENT` propagates out of `checkCoverage` — an unhandled rejection, not an `AggregateError` |
| Missing report **and** missing `src/`, type-only package | `tooling/checks/coverage.ts:245` | `readdir` throws `ENOENT`; pinned by `tooling/tests/unit/coverage.test.ts:34-39` |
| Empty own-source report, non-type-only | `tooling/checks/coverage.ts:271` | `Error: <pkg>: LCOV report contains no own-source line data` |
| Floor breach, unmeasured module, or type-only runtime export | `tooling/checks/coverage.ts` (`checkCoverage`, failure collection and final `AggregateError`) | collected across **all** packages, then one `AggregateError` — the run does not stop at the first bad package |
| Stale allowlist entry | `tooling/checks/coverage.ts:446-463` | **tolerated**: printed as an informational line, exit code unaffected |
| Package with zero functions in LCOV | `tooling/checks/coverage.ts:275` | scored `1` rather than dividing by zero |
| Stream-metrics drift | `tooling/tests/architecture/stream-metrics-drift.test.ts`, "the two production stream metrics implementations stay token-identical" | its `expect(...).toBe(...)` fails through Bun's normal test reporter; the test has no custom stderr or `process.exitCode` path |
| Normalizer admits an unrelated token difference | `tooling/tests/architecture/stream-metrics-drift.test.ts`, "the normalizer permits only the owner-specific default" | its negative-control expectation fails through Bun's normal test reporter |
| Package-graph violations | `tooling/checks/package-graph.ts:23-28` | the Markdown table is still printed on stdout, violations on stderr, `exitCode = 1` |
| `--check-doc` with the document absent | `tooling/checks/package-graph.ts:15` | `readFileSync` throws — an **uncaught** `ENOENT` at module load, not a collected failure. This is the live state of the tree (see §8). |
| Git inventory fails for the Bun-source check | `tooling/checks/bun-sources.ts:13-24` | throws `git ls-files failed`, appending trimmed stderr when present |
| Python source path found | `tooling/checks/bun-sources.ts:33-44` | every sorted path is printed and `process.exitCode = 1` |
| Existing source citation uses line zero, exceeds the target, or inverts a range | `tooling/checks/spec-hygiene.ts` (`failedCitations`); `tooling/lib/spec-hygiene.ts` (`resolveLineCitation`) | all invalid citations are reported and `process.exitCode = 1`; nonexistent illustrative targets are ignored |
| Bun dies by SIGILL/SIGABRT/SIGSEGV in CI | `tooling/ci/retry-code-coverage.sh:34-39`, `:54-64` | up to 3 retries of `@clarvis/code` alone, then `coverage:check` |
| Bun dies by SIGINT/SIGTERM in CI | `tooling/ci/retry-code-coverage.sh:12-20` | never retried |
| Preload temp-dir cleanup fails at exit | `tooling/test-runtime/clarvis-home-preload.ts:30-32` | swallowed; "the OS reaps the temp dir" |
| A conformance harness lacks an optional capability | `packages/memory/src/testing.ts:596-609` | the case returns early rather than failing |
| Tree-sitter highlighting unavailable under the code preload | `packages/code/tests/helpers/tree-sitter-preload.ts:71-75` | `highlightOnce` resolves with an `error`; renderables fall back to plain text. The test asserts only `error` is a string, because "asserting the exact string made this pass alone and fail in the full run" (`packages/code/tests/integration/tree-sitter-preload.test.ts:28-36`) |

**What degrades vs. what fails hard.** Only three things degrade: a stale allowlist entry, a
conformance case whose harness lacks a capability, and CI's crash retry. Everything else is
fail-hard. Notably, `coverage.ts` has no partial mode — there is no flag to check one package.

## 7. Coupling

### 7.1 What the checkers depend on

| Consumer | Dependency | Kind | What forces it |
|---|---|---|---|
| `tooling/lib/source-policy.ts` | `typescript` | runtime, static | `import ts from "typescript"` (`:1`); the `mock.module` matcher is an AST walk, not a regex |
| `tooling/lib/package-graph.ts` | `typescript` | runtime, static | `:3`; used for both `createSourceFile` and `parseConfigFileTextToJson` (JSONC tsconfigs) |
| `tooling/checks/import-extensions.ts` | `typescript` | runtime, static | the import-extension policy parses module specifiers through the TypeScript AST |
| `tooling/tests/architecture/stream-metrics-drift.test.ts` | `typescript` | runtime, static | `:2`; `ts.createScanner` with `skipTrivia` is what makes comments non-material |
| `tooling/checks/coverage.ts` | none beyond `node:fs/promises`, `node:path`, `node:url` | — | it parses LCOV with `split`/`startsWith`, no library |
| `tooling/checks/bun-version.ts` | none beyond `node:fs`, `node:path`, `node:url` | — | validates the exact mise pin against every runtime and declaration surface |
| `tooling/checks/bun-sources.ts` | Git executable plus `node:fs`/`node:path`/`node:url` | subprocess | Git supplies the tracked-and-unignored path inventory; the script performs no recursive filesystem scan |
| `tooling/test-runtime/clarvis-home-preload.ts` | `@clarvis/paths` | runtime, static | `:5` — it must not spell `CLARVIS_HOME` itself; `HOME_ENV` is owned at `packages/paths/src/roots.ts:11` |
| `tooling/checks/package-graph.ts` | `specs/package-coupling-analysis.md` | runtime, filesystem | `:15`, only under `--check-doc` |

`typescript` is a root `devDependency` (`package.json`, `devDependencies.typescript`), which is what
lets these four repository-tooling modules import it from the repository root.

### 7.2 What depends on this subsystem

- **Every commit**, through `.githooks/pre-commit:7` → `package.json`
  (`scripts.check:pre-commit`).
- **CI's linux job**, which runs `bun run lint` (hence `lint:intent`) and
  `bash tooling/ci/retry-code-coverage.sh` (`.github/workflows/ci.yml:60`, `:69`). CI job layout belongs to
  *build-tooling-ci-and-platform*.
- **Every package's `test:coverage` script**, which must write `coverage/lcov.info` where
  `readOwnSourceCoverage` expects it (`tooling/checks/coverage.ts:236`), i.e. the `coverageDir`
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
|---|---|---|---|---|---|---|---|
| `packages/*/src` | yes | yes | yes | yes (both rules) | yes | yes | yes |
| `packages/*/tests` | yes | yes | yes | mock-module + level rule | yes | yes | yes |
| `packages/code/tooling` | yes | yes | yes | mock-module only | yes | yes | yes |
| repo `tooling/checks`, `lib`, `test-runtime` | yes | yes | yes | mock-module only | no | yes | yes |
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
(`packages/paths/tests/architecture/invariant.test.ts:41-51`).

### 7.4 ESLint's test-file relaxations

The shared flat config applies a second block scoped to `tests/**/*.{ts,tsx}` that disables eleven
type-safety rules and flips `no-floating-promises` from `{ignoreVoid: false}` to `{ignoreVoid: true}`
(`eslint.config.base.js:45-63`). The header comment states the scope: "Test files legitimately
traffic in untyped fixtures/mocks". `@typescript-eslint/await-thenable` is off in tests with a stated
mechanism — "Bun's promise matchers are tracked by the runner but typed as synchronous" (`:59`).
The `ignoreVoid: false` setting in `src` (`eslint.config.base.js:41`) means a bare `void p` is not,
by itself, an accepted way to mark a rejection as intentionally unhandled there; `suppressSecondaryRejection`
(invariant 3) is the named pattern the codebase uses at call sites instead, over a promise that
already ends its own chain in `.catch(() => {})` (`packages/capability/src/tasks.ts:70`).

## 8. Open questions

1. **Why `--check-doc` is passed unconditionally is not answerable from source.**
   `tooling/checks/package-graph.ts:15` reads `specs/package-coupling-analysis.md` with a bare
   `readFileSync`, so the flag makes a documentation file a hard dependency of `lint:intent`
   (`package.json`, `scripts.lint:intent`) and therefore of `check:pre-commit`
   (`scripts.check:pre-commit`) — losing the document stops every
   commit, not just the graph check. Whether that coupling is deliberate, or whether the flag was
   meant to be conditional, the code does not say.

2. **The six level names carry no definition in code.** `TEST_LEVELS`
   (`tooling/lib/source-policy.ts:3-10`) is a bare set of strings. Nothing in `packages/*/tests`,
   `tooling/`, `bunfig.toml` or any config states what distinguishes `unit` from `component`, or
   `component` from `integration`. The one observable regularity is the `architecture` idiom
   (§4.10) and the `contract` idiom (§4.9); the other four are conventional only.

3. **`e2e` is a declared level with zero members.** No `tests/e2e` directory exists in any of the 18
   packages. It is pinned as *accepted* by `tooling/tests/unit/source-policy.test.ts:36`, so it is live
   vocabulary, but nothing uses it.

4. **The level rule had two syntactic gaps.** ~~`findUnclassifiedTestFiles` matches only
   `/\.test\.[cm]?[jt]sx?$/`. Verified on the then-pinned Bun 1.3.11: `tests/helpers/thing.spec.ts` and
   `tests/helpers/thing_test.ts` are both **collected and run** by `bun test`, and both slip past the
   classifier.~~ **Resolved 2026-08-22**: the matcher is now `BUN_TEST_FILENAME`
   (`tooling/lib/source-policy.ts:61`), covering all four shapes Bun collects, pinned by
   `tooling/tests/unit/source-policy.test.ts`. Re-verified on 1.3.11 before the change that both forms really
   do run — the gap was that such a file could sit outside every declared level, execute on every CI
   leg, and be reported by nothing. Still open: `lastIndexOf("/tests/")` would misclassify a nested
   `tests` directory inside a level; none exists.

5. **The `mock.module` matcher is syntactic and can be evaded.** It requires the literal identifier
   `mock` with property `module` (`tooling/lib/source-policy.ts:34-39`), and the unit test pins that
   `other.module("pkg")` is ignored (`tooling/tests/unit/source-policy.test.ts:22`). `vi.mock(...)`, a
   destructured `const { module } = mock`, or an aliased binding would not be found. Zero hits for
   `vi.mock` and `jest.mock` today, so the gap is latent.

6. ~~**No test asserts the per-package test harness configuration.**~~ **Resolved 2026-08-22.**
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

8. ~~**The package-graph serializer used non-English headings.**~~ **Resolved 2026-08-24.**
   `renderMarkdown` now emits the repository-standard English role/dependency table and Mermaid
   graph. `specs/package-coupling-analysis.md` holds that output verbatim, and `checkDocument`
   compares the complete generated block with the current serializer. A format change therefore
   requires regenerating the document in the same iteration, or `check:graph` fails
   (`tooling/lib/package-graph.ts`, `renderMarkdown` and `checkDocument`).

9. ~~**`@clarvis/tasks/testing` has no cross-package consumer.**~~
   **Resolved 2026-08-22.** `@clarvis/tasks/testing` is a **provider conformance harness**, and its intended
   consumer is outside this repository by design: a provider-neutral task domain means somebody else
   writes the Jira or Trello or in-house provider, and this is how they find out whether it satisfies
   the contract before Clarvis ever loads it. No in-repo importer is the *expected* state there, not
   an unused export.

10. ~~**The three `GRANDFATHERED` allowlist entries are undocumented individually.** The header says
    they are "real, executable, untested modules that predate this check"
    (`tooling/checks/coverage.ts:68-71`), but nothing records what would have to be tested to close
    `packages/code/src/adapters/kernel-capabilities-client.ts`,
    `packages/loop/src/settings/marketplace-schema.ts` or `packages/loop/src/version.ts`.~~
    **Resolved 2026-08-22.** Two were closed rather than documented, because both were small enough
    that importing them *is* the test: `packages/loop/src/version.ts` (12 lines — and the one thing
    worth asserting is that a *static* import inlines this package's version, where its
    `createRequire` predecessor silently reported whichever `package.json` sat beside the bundle) and
    `packages/code/src/adapters/kernel-capabilities-client.ts` (38 lines carrying three claims about
    the in-process kernel: no tools, because MCP servers are connected only during a run; always
    `"connected"`, because there is no link that could drop; and a prompt mapping whose optional
    fields must stay absent rather than become `undefined`). The third,
    `packages/loop/src/settings/marketplace-schema.ts`, was closed the same day rather than
    documented, and with it the category: `packages/loop/tests/unit/marketplace-schema.test.ts`
    drives the whole 530-line reader through `marketplaceSchema`, its only runtime export, to 100%
    of its functions and lines. It exercises what the entry had named — the
    `MAX_LISTINGS`/`MAX_NOTES`/`MAX_LISTED_KEYS` truncations and the notes they emit, both default
    strings, a local source read but never offered for install, and the suggestion `typoBudget`
    withholds from a short key at the same edit distance it allows a long one — plus every source
    dialect, the drop-one-listing-never-the-collection rule, and the alternate spellings a foreign
    dialect writes a summary and a display name under. Six deliberate mutations of the module (each
    of the three bounds, a local source made installable, both defaults, and `typoBudget` replaced
    by a constant) each failed only the tests naming that rule. `NO_COUNTER_ALLOWLIST` now holds
    nothing but the three permanent reasons.

11. **Coverage figures from an existing LCOV artifact can be stale.** ~~Whether the per-package
    reports are current with `HEAD` is not determinable.~~ **Resolved 2026-08-22**: it is
    determinable, and `coverage.ts` now
    determines it — it compares each report's mtime against the package's own sources and names the
    file that outran it, with the command to re-run. A type-only package is exempt, because its
    `test:coverage` writes no LCOV and the warning would be permanent noise. This was hit twice while
    closing §5 of the gap report: once as a phantom "src module produced no coverage record at all"
    for a module that had simply never been measured, and once as figures disagreeing with the last
    gate run. Both read as findings about the code rather than about the report's age. The leftover
    `.lcov.info.*.tmp` beside `packages/protocol/coverage/lcov.info` is untracked and gitignored —
    local hygiene, not a repository defect.

12. **`packages/memory/src/testing.ts` (1 233 lines) and `packages/plan/src/testing.ts` (714 lines)
    are counted in their packages' coverage denominators** — they are `src` modules and are on no
    allowlist. ~~Whether the floors were chosen with that in mind is not determinable.~~ **Measured
    2026-08-22**, and the numbers now sit beside the floors in `tooling/checks/coverage.ts`: `memory`
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
