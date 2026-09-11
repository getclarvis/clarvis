# Package coupling analysis

Generated companion to `tooling/checks/package-graph.ts`. The marked block below is the verbatim
output of that script's `renderMarkdown`, and `checkDocument` compares the complete fragment against
the graph derived from manifests and source. It includes each package's semantic role, direct
internal dependencies, optional edges, internal consumers, and a role-grouped diagram.

That makes this document a **build input, not prose**. `bun run check:graph` — the tail of
`lint:intent`, which is a phase of `check:pre-commit` — reads it with a bare `readFileSync`, so a
missing or stale file fails the gate deterministically, regardless of the change being committed.

## Regenerating

```bash
bun run tooling/checks/package-graph.ts > /tmp/graph.md   # prints exactly the generated block
bun run check:graph                                       # re-validates this file against the graph
```

Update the marked block whenever a package gains or loses an internal dependency or changes role.
The table and Mermaid source belong to the generator and must stay exactly as emitted.

## The graph

<!-- prettier-ignore-start -->
<!-- package-graph:start -->

Packages: 19; internal edges: 50; optional edges: 3.

| Package | Role | Direct internal dependencies | Internal consumers |
| --- | --- | --- | ---: |
| `capability` | foundation | — | 14 |
| `code` | application | `kernel`, `paths`, `protocol` | 0 |
| `goal` | product-capability | `capability` | 1 |
| `hooks` | execution-service | `capability`, `tools` | 1 |
| `kernel` | host-implementation | `capability`, `goal`, `loop`, `mcp-client`, `memory`, `paths`, `plan`, `protocol`, `skills`, `tasks`, `tools`, `trace`, `workflows` | 2 |
| `llm` | execution-service | `capability` | 1 |
| `loop` | engine | `capability`, `hooks` (optional), `llm`, `mcp-client`, `paths`, `skills` (optional), `supervision`, `tools` (optional), `trace` | 3 |
| `mcp-client` | execution-service | `capability`, `paths` | 2 |
| `memory` | product-capability | `capability`, `loop`, `paths` | 1 |
| `paths` | foundation | — | 10 |
| `plan` | product-capability | `capability`, `paths` | 1 |
| `protocol` | host-contract | — | 3 |
| `server` | application | `capability`, `kernel`, `paths`, `protocol` | 0 |
| `skills` | execution-service | `capability`, `paths` | 2 |
| `supervision` | execution-service | `capability` | 2 |
| `tasks` | product-capability | `capability` | 1 |
| `tools` | execution-service | `paths` | 3 |
| `trace` | execution-service | `capability`, `paths` | 2 |
| `workflows` | product-capability | `capability`, `loop`, `supervision` | 1 |

### Direct graph grouped by role

Arrows point from consumer to dependency; a dotted arrow is optional.

```mermaid
flowchart LR
  subgraph role_foundation["foundations"]
    capability["@clarvis/capability"]
    paths["@clarvis/paths"]
  end
  subgraph role_host_contract["host contracts"]
    protocol["@clarvis/protocol"]
  end
  subgraph role_execution_service["execution services"]
    hooks["@clarvis/hooks"]
    llm["@clarvis/llm"]
    mcp_client["@clarvis/mcp-client"]
    skills["@clarvis/skills"]
    supervision["@clarvis/supervision"]
    tools["@clarvis/tools"]
    trace["@clarvis/trace"]
  end
  subgraph role_engine["engine"]
    loop["@clarvis/loop"]
  end
  subgraph role_product_capability["product capabilities"]
    goal["@clarvis/goal"]
    memory["@clarvis/memory"]
    plan["@clarvis/plan"]
    tasks["@clarvis/tasks"]
    workflows["@clarvis/workflows"]
  end
  subgraph role_host_implementation["host implementations"]
    kernel["@clarvis/kernel"]
  end
  subgraph role_application["applications"]
    code["@clarvis/code"]
    server["@clarvis/server"]
  end
  code --> kernel
  code --> paths
  code --> protocol
  goal --> capability
  hooks --> capability
  hooks --> tools
  kernel --> capability
  kernel --> goal
  kernel --> loop
  kernel --> mcp_client
  kernel --> memory
  kernel --> paths
  kernel --> plan
  kernel --> protocol
  kernel --> skills
  kernel --> tasks
  kernel --> tools
  kernel --> trace
  kernel --> workflows
  llm --> capability
  loop --> capability
  loop -. optional .-> hooks
  loop --> llm
  loop --> mcp_client
  loop --> paths
  loop -. optional .-> skills
  loop --> supervision
  loop -. optional .-> tools
  loop --> trace
  mcp_client --> capability
  mcp_client --> paths
  memory --> capability
  memory --> loop
  memory --> paths
  plan --> capability
  plan --> paths
  server --> capability
  server --> kernel
  server --> paths
  server --> protocol
  skills --> capability
  skills --> paths
  supervision --> capability
  tasks --> capability
  tools --> paths
  trace --> capability
  trace --> paths
  workflows --> capability
  workflows --> loop
  workflows --> supervision
```

<!-- package-graph:end -->
<!-- prettier-ignore-end -->

## Reading the graph

- **Direct internal dependencies** lists `@clarvis/*` entries in the package's `dependencies` plus
  `optionalDependencies`; optional entries are labeled explicitly. `loop` is the only package that
  declares optional internal dependencies.
- **Internal consumers** counts the workspace packages that depend on the row's package.
- **Role** comes from the central registry in `tooling/lib/package-architecture.ts`; `check:graph`
  rejects packages without one and dependencies that violate the role policy.
- A leaf with zero dependencies and many consumers (`capability` at 13, `paths` at 10) is a
  vocabulary package: everything above it is allowed to name it, and it may name nothing.
- A package with zero consumers (`code`, `server`) is an application: it is the top of the graph and
  nothing in the workspace may depend on it.
