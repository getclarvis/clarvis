# Package architecture and dependency policy

> The physical workspace is declared in the root `package.json`; semantic roles and allowed edges
> are owned by `tooling/lib/package-architecture.ts`; package and module edges are derived by
> `tooling/lib/package-graph.ts`; application boundaries are enforced by
> `packages/code/tests/architecture/dependency-boundary.test.ts` and
> `packages/server/tests/architecture/dependency-boundary.test.ts`. This document owns the semantic
> package roles, the allowed dependency directions, the client/kernel boundary, and the review
> rules. [`package-coupling-analysis.md`](../package-coupling-analysis.md) remains the
> generated record of the graph that exists now.

## 1. Purpose

Clarvis uses one flat Bun workspace because package location is an address, not an architecture
diagram. The entries under `packages/*` are independently named units in one `@clarvis/*` namespace;
their architectural height comes from dependency direction and ownership. The root manifest lists
all 18 workspaces explicitly (root `package.json`, `workspaces`), while the graph analyzer derives declared,
compilation, eager-runtime, dynamic-runtime and type-only edges from manifests and source
(`tooling/lib/package-graph.ts`, `analyzePackageGraph`).

Throughout this document, `A -> B` means **A depends on B**. Applications point downward towards
contracts and implementations; foundations never point upward towards their consumers. A direct
edge is not made more acceptable by being type-only, optional, dynamic or test-only: each form still
creates either a compilation, installation, runtime or test ownership relationship. The analyzer
includes `src`, `tests` and package `tooling` when it collects imports and treats declared and
compilation cycles separately (`tooling/lib/package-graph.ts`, `SOURCE_TREES` and
`analyzePackageGraph`).

The intended product flow is:

```text
applications                   host implementation              composed graph

@clarvis/code ────┐
                  ├──> @clarvis/kernel ──┬──> product capabilities
@clarvis/server ──┘                      ├──> @clarvis/loop ──> execution services
                                         └──> foundations + @clarvis/protocol

additional direct application-owned edges

@clarvis/code ─────> @clarvis/protocol, @clarvis/paths
@clarvis/server ───> @clarvis/protocol, @clarvis/paths, @clarvis/capability
```

This is deliberately not `code/server -> kernel -> every symbol`. The kernel is the local host
implementation and composition root, not a generic barrel. Clients and the implementation both
depend on the transport-neutral protocol; applications may also depend directly on a foundation
when they own the corresponding concern. The kernel publishes five owned entrypoints today
(`packages/kernel/package.json`, `exports`), and its architecture test prevents the root from
becoming a barrel for lower packages
(`packages/kernel/tests/architecture/public-surface.test.ts`, `kernel public surface`).

Physical nesting such as `packages/apps/code` or `packages/hosts/kernel` is not part of the target.
It would duplicate semantic information without enforcing an edge. Roles are specified here and
checked from the same graph that validates manifests and source.
The `specs/foundations`, `specs/execution`, `specs/engine`, `specs/capabilities` and `specs/hosts`
directories route behavioral documents; their folder names do not override the package roles below.

## 2. Surface

### 2.1 Package roles

Every workspace has one primary architectural role:

| Role | Packages | Responsibility | Permitted downward dependencies |
|---|---|---|---|
| foundation | `capability`, `paths` | Stable vocabulary, ports and filesystem ownership used by higher layers | No internal package dependency |
| host contract | `protocol` | Transport-neutral DTOs and the `KernelClient` service contract | No internal package dependency |
| execution service | `llm`, `mcp-client`, `supervision`, `trace`, `tools`, `hooks`, `skills` | Provider, transport, observation and machine-action implementations used by the engine or host | Foundations; a same-role edge only when one service genuinely builds on another, currently `hooks -> tools` |
| engine | `loop` | Embeddable execution and orchestration policy | Foundations and execution services; `hooks`, `skills` and `tools` remain optional |
| product capability | `memory`, `plan`, `tasks`, `workflows` | Independently owned features composed by a host | Foundations; `memory` and `workflows` may execute the loop, and `workflows` may use supervision |
| host implementation | `kernel` | Implements `protocol`, composes the engine and product capabilities, and owns local host policy | Host contract and any lower package it actually composes |
| application | `code`, `server` | User-facing terminal application and MCP-over-HTTP facade | `kernel`, `protocol`, and only those foundations whose concerns the application itself owns |

The current manifests instantiate the two application rows exactly: Code declares only Kernel,
Paths and Protocol (`packages/code/package.json`, `dependencies`); Server declares Capability,
Kernel, Paths and Protocol (`packages/server/package.json`, `dependencies`). Kernel declares its
composition dependencies directly rather than hiding them behind a lower barrel
(`packages/kernel/package.json`, `dependencies`). Loop declares its execution services and keeps
Hooks, Skills and Tools optional (`packages/loop/package.json`, `optionalDependencies`). Protocol
has no internal dependency field (`packages/protocol/package.json`).

### 2.2 Ownership terms

- A **foundation** owns vocabulary or a port, not a concrete product workflow. Adding a convenient
  helper is insufficient reason to put it in a foundation.
- A **contract** is safe for both sides of a boundary. Protocol DTOs describe values that may cross
  a transport; they do not expose stores, filesystem handles, process objects or implementation
  classes.
- A **composition root** chooses implementations and lifecycles. It may have high fan-in without
  becoming the owner of every type it wires.
- An **application adapter** translates application concerns to a contract. Presentation and domain
  code consume that adapter instead of importing implementation defaults or schemas directly.
- A **public entrypoint** is an owned thematic surface in a package export map. It is not permission
  to re-export another package merely to shorten an import.

### 2.3 Package versus subpath

Use a subpath when the surface has the same owner, lifecycle, release unit and dependency direction
as its package. Create a package only when at least one of these boundaries is real:

1. a stable contract must be consumable without its implementation;
2. optional or lazy installation/loading must be preserved;
3. a reverse dependency would otherwise appear;
4. the unit has independent lifecycle, security or platform ownership;
5. multiple consumers need one cohesive implementation that belongs below all of them.

Line count, directory size, a desire for a shorter import, or a single shared helper do not justify
a package. A proposed package must name its owner, consumers, allowed dependencies, public entries,
README, owning spec and architecture test before it is added.

## 3. Data and formats

### 3.1 Workspace declaration

Each package remains at `packages/<name>` and uses the `@clarvis/<name>` package name. The root
workspace list is explicit (root `package.json`, `workspaces`), internal runtime edges use
`workspace:*`, and a
buildable package mirrors those runtime edges with TypeScript project references. The analyzer
rejects an internal dependency absent from the source, a runtime import declared only for
development, and a mismatch between runtime dependencies and project references
(`tooling/lib/package-graph.ts`, `analyzePackageGraph`).

The filesystem layout is therefore:

```text
packages/<name>/
  package.json
  README.md
  src/
  tests/
  tooling/            # only when automation is owned by this package
  tsconfig.json
  tsconfig.build.json # buildable library packages
```

Semantic role folders are not inserted between `packages/` and `<name>`. The `PACKAGE_ROLES`
registry in `tooling/lib/package-architecture.ts` is the source of architectural grouping.

The root manifest is also the sole Clarvis product-version authority. Every workspace manifest is
private and omits `version`, and the workspace entries in `bun.lock` omit synthetic versions;
internal edges continue to use `workspace:*`. Only the terminal CLI,
Server CLI, Loop `VERSION` export, and MCP initialization identity read the root version at runtime.
`PRODUCT_VERSION_IMPORTERS` names those four source modules and `analyzePackageGraph` rejects any
additional root-manifest import.

### 3.2 Public surfaces

Cross-package imports use an exported package entrypoint. Relative imports may not cross package
roots, and a package's source may not import its own public root as a shortcut around its internal
module graph. The analyzer resolves export conditions, validates requested subpaths and reports
both forms (`tooling/lib/package-graph.ts`, `analyzePackageGraph`).

A package root exports only symbols it owns. Re-exporting lower packages to make all consumers
depend on one facade is prohibited. Kernel's current five-entry surface and no-generic-barrel rule
are pinned by `packages/kernel/tests/architecture/public-surface.test.ts` (`kernel public surface`).

### 3.3 Graph report

[`package-coupling-analysis.md`](../package-coupling-analysis.md) is generated evidence, not the
policy source. Its checked fragment presents:

- the role of every package;
- every direct internal edge, including whether it is optional;
- a role-grouped diagram generated from the same graph;
- package, internal-edge and optional-edge totals.

`renderMarkdown` produces the complete fragment and `checkDocument` compares it with the committed
document (`tooling/lib/package-graph.ts`, `renderMarkdown` and `checkDocument`). Violations are
reported by `check:graph` rather than serialized into a report that must remain valid.

## 4. Behavior

### 4.1 Adding or changing a dependency

Before adding an internal edge, the author performs this decision in order:

1. **Name the owner.** Identify which package owns the behavior, state, lifecycle or vocabulary.
2. **Classify both roles.** Confirm that the consumer is allowed to point to the provider under
   section 2.1. An application reaching an engine or capability directly is rejected even if the
   import is convenient.
3. **Choose contract before implementation.** A client that needs a service shape depends on
   `protocol`; it depends on `kernel` only where it constructs or hosts the local implementation or
   deliberately consumes an owned kernel runtime surface.
4. **Avoid a facade edge.** Do not re-export a lower symbol through Kernel, Loop or Capability to
   conceal its owner.
5. **Classify loading.** If the provider is optional or expensive, prove the eager runtime closure
   remains free of it. A dynamic import changes loading time, not ownership.
6. **Declare every representation.** Update the consumer manifest and build reference, use a public
   export, and update the owning README/specs and generated graph.
7. **Pin the direction.** Add or update an architecture test for a new seam; do not rely only on a
   successful build.

The graph analyzer reads source edges through the TypeScript AST, including static imports,
exports, dynamic imports, `require` and import types (`tooling/lib/package-graph.ts`,
`parseModuleEdges`). It then compares those edges with declarations, exports and project references
(`tooling/lib/package-graph.ts`, `analyzePackageGraph`).

### 4.2 Application boundaries

`code` and `server` may both construct a local kernel, while their service-facing logic programs
against `KernelClient`. Neither application imports Loop or a product capability directly. Their
package boundary tests derive exact manifest allowlists from `allowedInternalDependenciesFor`,
validate every imported workspace package with `packageDependencyViolation`, and separately pin the
owned Kernel entrypoints (`packages/code/tests/architecture/dependency-boundary.test.ts`,
`code dependency boundary`; `packages/server/tests/architecture/dependency-boundary.test.ts`,
`server dependency boundary`).

An application may depend directly on a foundation only for an application-owned concern. Examples
today are Code resolving its launch and state paths and Server using the shared Logger port and
authentication roots. Routing those types through Kernel would make the composition root a facade,
not reduce coupling.

### 4.3 Engine and capability direction

Loop imports execution services and the generic capability contract. Packages the engine depends on
must not import the engine back, including through tests or public subpaths. The inverse scan derives
the engine dependencies from its own manifest and scans both `src` and `tests`
(`packages/loop/tests/architecture/optional-package-boundary.test.ts`,
`optional package boundaries`). Memory
and Workflows may depend on Loop because they execute runs; Plan and Tasks remain host-registered
capabilities that do not need the engine. Kernel is where these branches are composed.

### 4.4 New package review

A new package proposal answers all of the following before files move:

- What single responsibility and lifecycle does it own?
- Which current and expected consumers justify a public contract?
- Which role does it occupy, and which roles may depend on it?
- Why is a subpath or application-local adapter insufficient?
- Does it preserve optional loading, protocol isolation and Windows support?
- Which README, spec, production entrypoint and architecture test make it complete?

If the only answer is reuse, size or tidiness, keep the code with its current owner.

## 5. Invariants

**INV-PA1. The declared workspace graph and the full compilation graph are acyclic.** Optional,
type-only and test edges do not create an exception to direction.

Production: `tooling/lib/package-graph.ts` (`analyzePackageGraph`, declared and compilation SCCs).

Test: `tooling/tests/unit/package-graph.test.ts` (`detects declared and compilation cycles`);
`packages/loop/tests/architecture/optional-package-boundary.test.ts`
(`optional package boundaries`).

**INV-PA2. Every workspace has exactly one semantic role, and every declared or imported internal
edge is permitted by the central role policy.** This includes dependencies declared for runtime,
development, peer or optional use and imports from source, tests and package tooling.

Production: `tooling/lib/package-architecture.ts` (`PACKAGE_ROLES`,
`packageDependencyViolation`, `packageRoleRegistryErrors`); `tooling/lib/package-graph.ts`
(`analyzePackageGraph`).

Test: `tooling/tests/unit/package-architecture.test.ts` (`package architecture policy`).

**INV-PA3. Every cross-package import names a declared workspace dependency, every buildable
runtime dependency agrees with TypeScript project references, and source reaches only exported
entrypoints.** Relative imports never cross package roots, and package source never imports its own
public root.

Production: `tooling/lib/package-graph.ts` (`analyzePackageGraph`).

Test: `tooling/tests/unit/package-graph.test.ts` (`analyzePackageGraph`).

**INV-PA4. Code depends on no Clarvis implementation package below Kernel; its only Clarvis package
dependencies are Kernel, Paths and Protocol.**

Production: `tooling/lib/package-architecture.ts` (`APPLICATION_FOUNDATIONS` and role matrix);
`packages/code/package.json` (`dependencies`).

Test: `packages/code/tests/architecture/dependency-boundary.test.ts` (`code dependency boundary`).

**INV-PA5. Concrete Kernel imports in Code are confined to `src/index.tsx`, `src/bootstrap/**`, and
`src/adapters/**`.** Core, generic UI, Views, feature controllers, onboarding, commands and the run
host consume Code-owned adapters or Protocol contracts.

Production: `packages/code/src/index.tsx`; `packages/code/src/bootstrap/**`;
`packages/code/src/adapters/**`.

Test: `packages/code/tests/architecture/architecture-boundary.test.ts`
(`confines concrete kernel imports to composition and adapter boundaries`).

**INV-PA6. Server's only Clarvis dependencies are Capability, Kernel, Paths and Protocol, and its
build references mirror those dependencies.**

Production: `tooling/lib/package-architecture.ts` (`APPLICATION_FOUNDATIONS` and role matrix);
`packages/server/package.json` (`dependencies`); `packages/server/tsconfig.build.json`
(`references`).

Test: `packages/server/tests/architecture/dependency-boundary.test.ts`
(`server dependency boundary`).

**INV-PA7. Kernel exposes only its five owned entrypoints and its root is not a generic re-export
barrel for lower packages. Protocol remains dependency-free.**

Production: `packages/kernel/package.json` (`exports`); `packages/kernel/src/index.ts`;
`packages/protocol/package.json`.

Test: `packages/kernel/tests/architecture/public-surface.test.ts` (`kernel public surface`);
`tooling/tests/unit/package-architecture.test.ts` (`package architecture policy`).

**INV-PA8. Code's framework-free core and generic UI do not depend on Kernel; Core also remains
independent from Paths, filesystem effects, adapters and presentation.**

Production: `packages/code/src/core/**`; `packages/code/src/ui/**`.

Test: `packages/code/tests/architecture/architecture-boundary.test.ts`
(`code's internal architecture`).

**INV-PA9. Clarvis has one product version, owned by the root manifest. Every workspace package is
private and omits `version`, `bun.lock` carries no workspace versions, and only the four approved
product-version modules may import the root manifest at runtime.**

Production: root `package.json` (`version`); `tooling/lib/package-architecture.ts`
(`PRODUCT_VERSION_IMPORTERS`, `productVersionPolicyErrors`, `productLockfileVersionErrors`,
`productManifestImportViolation`); `tooling/lib/package-graph.ts` (`analyzePackageGraph`).

Test: `tooling/tests/unit/package-architecture.test.ts`
(`keeps the root manifest as the sole product-version authority`,
`limits runtime reads of the root product manifest`); package-local version tests in Code, Loop,
MCP Client, and Server.

## 6. Failure modes and degradation

| Change | Current result | Required response |
|---|---|---|
| Declared or compilation cycle | `check:graph` fails with the strongly connected component | Remove or invert the edge; dynamic or optional loading is not a waiver |
| Undeclared internal import or unused internal dependency | `check:graph` fails with package and source location | Align ownership, source and manifest rather than suppressing the finding |
| Runtime import declared only in `devDependencies` | `check:graph` fails | Move it to a runtime field or remove the runtime edge |
| Missing project reference | `check:graph` fails | Add the reference only when the runtime dependency is valid |
| Private subpath or relative cross-package import | `check:graph` fails | Publish an owned entrypoint or keep the code internal |
| Role-invalid edge that is otherwise declared and acyclic | `check:graph` fails with the consumer/provider roles | Change ownership or invert/remove the edge; declaration kind is not a waiver |
| New Kernel import outside Code's composition, bootstrap or adapter boundaries | Code's architecture suite fails with the importing file and specifier | Move the translation into an owned adapter or use Protocol |
| Workspace or its lock entry declares a version, workspace becomes public, or root version is not exact SemVer | `check:graph` fails with the offending manifest or lock path | Keep the version only in the root manifest and every workspace private |
| Unapproved source imports the root manifest | `check:graph` fails with the importing file | Add a narrow product-version module only when a real external identity surface requires it |
| Proposed package with no distinct owner or lifecycle | Build may pass | Keep it as a subpath or local module; package count is not a decomposition goal |

Architecture failure is a build-time design failure, not a runtime degradation mode. The repository
does not ship a fallback that discovers a cycle or substitutes a private import at runtime.

## 7. Coupling and enforced state

### 7.1 Enforced dependency policy

The package-level policy is:

```text
applications
  code, server
      |-- protocol                     contract used by clients and implementation
      |-- kernel                       local implementation and composition
      `-- owned foundation concerns    paths; capability ports where justified

host implementation
  kernel
      |-- product capabilities         memory, plan, tasks, workflows
      |-- engine                       loop
      |-- execution services           only those it composes directly
      `-- foundations + protocol

engine and capabilities
  memory, workflows --> loop
  plan, tasks --------> capability/paths only
  loop ---------------> execution services + foundations

leaves
  capability, paths, protocol
```

This permits multiple downward branches; it does not force every package into one numerical height.
Topological depth and semantic role are different: Plan and Tasks sit low in the graph because their
contracts are small, yet Kernel composes them as product capabilities beside Memory and Workflows.

### 7.2 Enforced Code boundary

The terminal application contains both a local composition root and a transport-neutral client. The
package separates them inside the package:

- `src/index.tsx`, `src/bootstrap/**` and explicitly local process/filesystem adapters may construct
  or host `@clarvis/kernel`;
- service-facing adapters depend on `@clarvis/protocol` and receive a `KernelClient` or a narrower
  service port;
- `src/core/**`, `src/ui/**`, `src/views/**` and feature controllers do not import any
  `@clarvis/kernel` entrypoint;
- presentation receives normalized view models, effective defaults and derived policy through
  Code-owned adapters instead of parsing Kernel configuration itself;
- Paths access remains at bootstrap, onboarding or persistence adapters, not in framework-free core
  or generic presentation;
- a future remote client factory can replace local bootstrap without changing the run host, feature
  controllers or views.

The architecture suite scans every Code source file and rejects a concrete Kernel import outside
`index.tsx`, `bootstrap/**`, or `adapters/**`
(`packages/code/tests/architecture/architecture-boundary.test.ts`,
`confines concrete kernel imports to composition and adapter boundaries`). Model parsing and cache
policy enter presentation through `adapters/model-policy.ts`; plan and guard defaults through
`adapters/settings.ts` and `adapters/guard-mode.ts`; provider request constraints through
`adapters/provider-request-policy.ts`; and shipped-agent identity through `adapters/agent-files.ts`.
Local construction remains explicit in `packages/code/src/index.tsx` (`createFileKernel`).

Moving every shared runtime value into Protocol is not the target: Protocol is currently a
dependency-free type contract (`packages/protocol/package.json`). Prefer returning an effective
value through `KernelClient`, deriving a presentation value in Code, or injecting a narrow function.
Extract a client-runtime package only if the remaining implementation is cohesive, has multiple
consumers and belongs below all of them under the criteria in section 2.3.

### 7.3 Enforced Server boundary

Server remains a thin host adapter. Bootstrap may construct Kernel; request handling uses Protocol
services; Capability supplies host ports such as Logger; Paths supplies authentication and state
roots. Server never imports engine or product-capability implementations. Its boundary test derives
the exact application allowlist from the central policy and checks matching project references
(`packages/server/tests/architecture/dependency-boundary.test.ts`, `server dependency boundary`).

### 7.4 Kernel boundary

Kernel may depend on many packages because it is the composition root, but it does not become their
facade. Its root and subpaths expose only host-owned construction, configuration, policy, transport
and local-host behavior. A lower package is imported directly by its real consumer, subject to the
role table, instead of re-exported through Kernel. If a Kernel subpath becomes a cohesive runtime
dependency of multiple peers that should not depend on Kernel, that is evidence for extraction;
Kernel size alone is not.

### 7.5 Implementation status

The architecture migration is complete because all of the following gates are implemented:

1. One machine-readable role registry assigns every workspace exactly one role.
2. `check:graph` rejects role-invalid edges in manifests and all source trees, including type-only,
   optional, dynamic and test-only edges.
3. The generated coupling report shows roles and direct edges, not only counts.
4. Code's architecture test rejects every Kernel import from Core, generic UI, Views and feature
   controllers; its remaining Kernel imports are confined to named composition and local-adapter
   boundaries.
5. Server's package allowlist is derived from the central role policy rather than a partial local
   forbidden list.
6. The protocol remains independent from Kernel and Loop, and Kernel remains a bounded owned surface
   rather than a lower-package barrel.
7. Root README, affected package READMEs, this spec and the generated graph agree on every package
   role and edge.
8. The root manifest is the sole product-version authority; workspaces and their lock entries are
   unversioned, workspaces are private, and the four runtime version consumers are centrally
   allowlisted.

## 8. Open questions

### ~~The role matrix is not yet centralized in tooling~~ — resolved

Resolved by `tooling/lib/package-architecture.ts` (`PACKAGE_ROLES` and
`packageDependencyViolation`). `analyzePackageGraph` applies that policy to workspace registration,
declared dependencies and imported edges, while the Code and Server boundary tests import the same
helpers rather than restating package lists.

### ~~Code still consumes Kernel runtime values outside local composition~~ — resolved

Resolved by the Code-owned policy/configuration adapters named in section 7.2 and the source-wide
Kernel-import ratchet in `packages/code/tests/architecture/architecture-boundary.test.ts`. Commands,
onboarding, the run host, Views and feature controllers now consume those adapters rather than
Kernel entrypoints.

### Extraction of a client-runtime package remains evidence-dependent

The target does not pre-authorize `@clarvis/client-runtime`, `@clarvis/platform` or a split of
Kernel's `config`, `policy` and `local` subpaths. First remove presentation leakage and inject narrow
ports. If a cohesive multi-consumer implementation remains below both Code and Server, propose it
under section 2.3 with its dependency direction and lifecycle; otherwise keep it with its owner.

### ~~The generated report communicates counts, not architecture~~ — resolved

`renderMarkdown` now emits roles, named direct dependencies, optional-edge labels, consumer counts
and a role-grouped Mermaid graph. `checkDocument` compares the entire marked block in
[`package-coupling-analysis.md`](../package-coupling-analysis.md), so prose cannot preserve a stale
diagram while the numeric totals pass.
