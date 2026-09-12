# Tool wire names, dispatch, MCP integration and the result contract

> Implemented at `packages/loop/src/runtime/tools/**`,
> `packages/loop/src/runtime/open-tool-pool.ts`, `packages/loop/src/runtime/loop/mcp-handler.ts`,
> and their tests. Every claim below is anchored to a file and a named symbol or test. Open questions are collected in
> the final section.

## 1. Purpose

This subsystem is the engine's tool-call boundary: the vocabulary of wire names a run's tools may
take (`packages/loop/src/runtime/tools/wire-names.ts`), the machinery that turns a pool of MCP
connections into one namespaced, collision-free registry
(`packages/loop/src/runtime/tools/mcp-registry.ts`), the two dispatchers that actually execute a
claimed call — one for MCP tools (`mcp-dispatch.ts` + `loop/mcp-handler.ts`), one for the built-in
coding toolset (`tools/builtin/execute-agent-tool-call.ts`) — and the `submit_result` finalize
contract that lets a caller demand a structured, schema-validated result
(`result-contract.ts`, `submit-result-tool.ts`).

The problem it solves is keeping three things that must never drift apart in sync while staying
open to extension: (1) an MCP server must never be able to *shadow* an engine or coding tool's wire
name (`RESERVED_WIRE_NAMES`), (2) an arbitrary, caller-authored `output_schema` must be safe to hand
to a JSON Schema compiler without becoming a resource-exhaustion vector
(`OUTPUT_SCHEMA_LIMITS`/`outputSchemaBudgetIssue`), and (3) a tool call's arguments must be checked
against its declared schema without ever making a broken schema fatal to the call
(`createToolArgValidator`'s fail-open design). All three properties are enforced by code the model
cannot influence, not by convention.

`runtime/tools/builtin/**` additionally packages `@clarvis/tools` (the optional coding-tool package)
behind a policy layer — grant ceilings, exec-tool filtering, abort racing — so the rest of the engine
never touches the feature package directly.

## 2. Surface

Model guidance follows [`model-instructions.md`](../cross-cutting/model-instructions.md).
`buildSubmitResultTool` explains that an accepted submission ends the run; a rejected submission
requires the returned validation/gate recovery before retrying. Connected MCP guidance retains
server attribution and appends an explicit truncation marker within its 32,768-code-point cap.
Production: `packages/loop/src/runtime/tools/submit-result-tool.ts` and
`renderMcpInstructions` in `packages/loop/src/runtime/mcp-instructions.ts`. Test:
`packages/loop/tests/unit/submit-result-tool.test.ts`, `result-contract.test.ts` and
`mcp-instructions.test.ts` in the same test directory.

### 2.1 Wire-name constants (`wire-names.ts`)

| Symbol | File | Value / shape |
| --- | --- | --- |
| `DELEGATE_TASK_TOOL_NAME` | `packages/loop/src/runtime/tools/wire-names.ts` | `"delegate_task"` |
| `SUBMIT_RESULT_TOOL_NAME` | `packages/loop/src/runtime/tools/wire-names.ts` | `"submit_result"` |
| `ASK_USER_TOOL_NAME` | `packages/loop/src/runtime/tools/wire-names.ts` | `"ask_user"` |
| `AGENT_LIST_TOOL` / `AGENT_POLL_TOOL` / `AGENT_STOP_TOOL` / `AGENT_STEER_TOOL` / `AWAIT_AGENTS_TOOL` | `packages/loop/src/runtime/tools/wire-names.ts` | `"agent_list"`, `"agent_poll"`, `"agent_stop"`, `"agent_steer"`, `"await_agents"` |
| `AGENT_SUPERVISION_WIRE_NAMES` | `packages/loop/src/runtime/tools/wire-names.ts` | the five names above, in that order |
| `BUILTIN_WIRE_NAMES` | `packages/loop/src/runtime/tools/wire-names.ts` | `[delegate_task, submit_result, ask_user]` |
| `AGENT_TOOL_WIRE_NAMES` | `packages/loop/src/runtime/tools/wire-names.ts` | 23 coding-tool wire names (`read_file` … `tree`) |
| `VISION_AGENT_TOOL_WIRE_NAMES` | `packages/loop/src/runtime/tools/wire-names.ts` | `["read_image"]` |
| `READ_ONLY_AGENT_TOOL_WIRE_NAMES` | `packages/loop/src/runtime/tools/wire-names.ts` | 9 read-only coding tool names |
| `RESERVED_WIRE_NAMES` | `packages/loop/src/runtime/tools/wire-names.ts` | `[...BUILTIN_WIRE_NAMES, ...AGENT_TOOL_WIRE_NAMES]` |
| `CONTROL_PLANE_TOOL_NAMES` | `packages/loop/src/runtime/tools/wire-names.ts` | `run`, `steer`, `get_run`, `list_runs`, `delete_run`, `list_profiles` — a separate, control-plane surface, not run-time tool names |

### 2.2 Registry construction (`mcp-registry.ts`)

| Symbol | Signature | File |
| --- | --- | --- |
| `buildRegistry` | `(entries: RegistryEntry[], capabilityReserved: readonly string[]) => NamespacedRegistry` | `packages/loop/src/runtime/tools/mcp-registry.ts` |
| `poolToolNames`, `selectTools`, `type RegistryEntry` | re-exported from `@clarvis/mcp-client` | `packages/loop/src/runtime/tools/mcp-registry.ts` |

`capabilityReserved` has **no default** — every call site must supply it explicitly, even `[]`
(`packages/loop/src/runtime/tools/mcp-registry.ts`).

### 2.3 Dispatch (`mcp-dispatch.ts`, `loop/mcp-handler.ts`, `builtin/execute-agent-tool-call.ts`)

| Symbol | Signature | File |
| --- | --- | --- |
| `executeMcpToolCall` | `(args: McpDispatchArgs) => Promise<McpCallResult>` | `packages/loop/src/runtime/tools/mcp-dispatch.ts` |
| `McpDispatchArgs` | `{ call, registry, availableWireNames, argValidator, guards, trace, agent, subagentInstanceId?, iteration, signal? }` | `packages/loop/src/runtime/tools/mcp-dispatch.ts` |
| `McpCallResult` | `{ resultText: string; errText: string \| null; productive: boolean; images?: ToolResultImage[] }` | `packages/loop/src/runtime/tools/mcp-dispatch.ts` |
| `buildMcpHandler` | `(deps: { base, registry, argValidator, guards, progress, availableWireNames? }) => ToolHandler` | `packages/loop/src/runtime/loop/mcp-handler.ts` |
| `executeAgentToolCall` | `(args: AgentToolDispatchArgs) => Promise<AgentToolCallResult>` | `packages/loop/src/runtime/tools/builtin/execute-agent-tool-call.ts` |
| `AgentToolDispatchArgs` | `{ call, toolset, guards, trace, agent, subagentInstanceId?, iteration, signal? }` | `packages/loop/src/runtime/tools/builtin/execute-agent-tool-call.ts` |

`ToolHandler` may additionally expose `canonicalName(call)`. The model-facing wire name remains the
call's `name`; the optional canonical identity exists only for lifecycle consumers that must retain a
dotted MCP namespace after wire-name projection (`packages/capability/src/loop-contract.ts`).

### 2.4 Argument validation (`tool-arg-validator.ts`)

| Symbol | Signature | File |
| --- | --- | --- |
| `ToolArgValidator` | `{ validate(this: void, schema, args, tool?): string \| null }` | `packages/loop/src/runtime/tools/tool-arg-validator.ts` |
| `createToolArgValidator` | `(logger?: Logger) => ToolArgValidator` | `packages/loop/src/runtime/tools/tool-arg-validator.ts` |

### 2.5 Tool-effect classification (`tool-effect.ts`)

| Symbol | Signature | File |
| --- | --- | --- |
| `createToolEffectPort` | `(declared?: Readonly<Record<string, ToolEffect>>) => ToolEffectPort` | `packages/loop/src/runtime/tools/tool-effect.ts` |

`ToolEffect` itself (`"read" \| "mutate" \| "control" \| "spawn_run" \| "unknown"`) is owned by
`@clarvis/capability` (`packages/capability/src/tool-effect.ts`) — see
[loop-capability-composition](capability-composition.md) and [capability-contract-and-vocabulary](../foundations/capability.md).

### 2.6 The result contract (`result-contract.ts`, `submit-result-tool.ts`)

| Symbol | Signature | File |
| --- | --- | --- |
| `compileResultContract` | `(outputSchema: unknown) => ResultContract` | `packages/loop/src/runtime/tools/result-contract.ts` |
| `ResultContract` | `{ tool: NamespacedTool; validate(args): ResultValidation }` | `packages/loop/src/runtime/tools/result-contract.ts` |
| `ResultValidation` | `{ ok: boolean; value?: unknown; error?: string }` | `packages/loop/src/runtime/tools/result-contract.ts` |
| `OUTPUT_SCHEMA_LIMITS` | frozen `{ nodes: 20_000; depth: 64; containerEntries: 4_096; keyChars: 1_024; stringChars: 1_048_576; singleStringChars: 262_144 }` | `packages/loop/src/runtime/tools/result-contract.ts` |
| `buildSubmitResultTool` | `(outputSchema: Record<string, unknown>) => NamespacedTool` | `packages/loop/src/runtime/tools/submit-result-tool.ts` |

The `submit_result` tool descriptor (`packages/loop/src/runtime/tools/submit-result-tool.ts`): `wireName`/`toolName`/`fullName`
= `"submit_result"`, `mcpName: ""`, `inputSchema` = the caller's `output_schema` **by reference**, and
a fixed description that names only "finalize" — never the caller's field names.

### 2.7 `runtime/tools/builtin/**`

`names.ts` and `grants.ts` — `AGENT_TOOL_NAMES`, `READ_ONLY_TOOL_NAMES`, `EDIT_TOOL_NAMES`,
`EXEC_TOOL_NAMES`, `FILE_MUTATING_TOOL_NAMES`, `GrantCeiling`, `agentToolCaps`, `agentToolsActive` —
are catalogued to [grants-and-tool-exposure](../cross-cutting/grants.md), not this document (see §8); `specs/cross-cutting/grants.md`
§2.4 is their full treatment. The table below covers only the toolset-construction symbols this document
owns.

| Symbol | Signature | File |
| --- | --- | --- |
| `createAgentToolset` | `(opts: AgentToolsetOptions) => AgentToolset` | `packages/loop/src/runtime/tools/builtin/toolset.ts` |
| `createAgentToolsetWithAdapter` | `(opts, adapter: AgentToolsAdapter) => AgentToolset` | `packages/loop/src/runtime/tools/builtin/toolset.ts` |
| `AgentToolset` | `{ defs: NamespacedTool[]; names: Set<string>; dispatch(name, args, signal?, onOutput?) => Promise<AgentToolResult> }` | `packages/loop/src/runtime/tools/builtin/toolset.ts` |
| `AgentToolResult` | `{ isError; text; images?; diff?; guard? }`; `guard` is the final review metadata returned by a guarded shell-family call | `packages/loop/src/runtime/tools/builtin/toolset.ts` |
| `AgentToolsetOptions` | `{ workspaceRoot; canMutate; canExec; confineToWorkspace?; temporaryRoots?; skillExecutionRoots?; onTemporaryRootRegistered?; guard?; elicit?; sandbox?; secretEnvNames?; logger? }` — the entire configuration surface connecting the coding toolset to ordered temporary access/approved skill roots, command review, elicitation and sandboxing | `packages/loop/src/runtime/tools/builtin/toolset.ts` (`AgentToolsetOptions`) |
| `AgentToolsAdapter` | `{ resolve(opts: AgentToolsetOptions): { defs: NamespacedTool[]; dispatch: AgentToolset["dispatch"] } }` — the injectable test seam `createAgentToolsetWithAdapter` takes in place of the real `@clarvis/tools` calls; its own doc comment calls it a "package-private seam" | `packages/loop/src/runtime/tools/builtin/toolset.ts` |

`builtin/index.ts` is the barrel: it re-exports `FILE_MUTATING_TOOL_NAMES`, `agentToolCaps`,
`agentToolsActive`, `createAgentToolset`, `systemTemporaryRoots`, the
`AgentToolset`/`AgentToolsetOptions` types, and the whole
`@clarvis/tools/guard` analyzer surface (`Guard`, `Elicit`, `analyzeShell`, dialects, etc. —
`packages/loop/src/runtime/tools/builtin/index.ts`); the guard/analyzer surface itself belongs to [command-guard-and-approval](../execution/command-guard.md).
`AgentToolsAdapter` is **not** re-exported through the barrel — `packages/loop/tests/unit/toolset.test.ts` imports it
directly from `../../src/runtime/tools/builtin/toolset.ts`, consistent with the doc comment above
calling it package-private.

### 2.8 `open-tool-pool.ts`

| Symbol | Signature | File |
| --- | --- | --- |
| `openToolPool` | `(input: { request, connections, owner, signal?, relay, emptyUsage, logger? }) => Promise<OpenToolPoolResult>` | `packages/loop/src/runtime/open-tool-pool.ts` |
| `OpenToolPoolResult` | `{ ok: true; opened: Lease[]; degraded: DegradedServer[] } \| { ok: false; response: RunResponse }` | `packages/loop/src/runtime/open-tool-pool.ts` |
| `DegradedServer` | `{ name: string; transport: ToolTransport; reason: string }` | `packages/loop/src/runtime/open-tool-pool.ts` |

### 2.9 The barrel (`runtime/tools/index.ts`)

`runtime/tools/index.ts` re-exports `ask-user-call.js`, `ask-user-tool.js`, `mcp-dispatch.js`,
`result-contract.js`, `submit-result-tool.js`, `tool-arg-validator.js`, `wire-names.js` and
`builtin/names.js`. It is the actual import path several unit tests use rather than
importing each module directly — `packages/loop/tests/unit/result-contract.test.ts` and `packages/loop/tests/unit/mcp-dispatch.test.ts` both
import from `"../../src/runtime/tools/index.ts"`. Its own doc comment describes the
directory as also serving a built-in `load_skill` tool alongside `ask_user`/`submit_result`, but no
`load_skill` module exists anywhere under `runtime/tools/` — that tool belongs to `@clarvis/skills`,
so the comment is stale for this directory.

## 3. Data and formats

### 3.1 `NamespacedTool` / `Resolved` (produced by `@clarvis/mcp-client`, consumed here)

A registry entry carries `fullName` (`"<mcpName>.<toolName>"`), `wireName` (the model-facing name),
`mcpName`, `toolName`, `description`, `inputSchema`, optional `kind` (`resource_list`/
`resource_read`). Built-in tools reuse the same shape with `mcpName: ""` and
`wireName === fullName === toolName` (`packages/loop/src/runtime/tools/submit-result-tool.ts`, `packages/loop/src/runtime/tools/builtin/toolset.ts`).

### 3.2 Wire-name sanitization (delegated mechanism, `@clarvis/mcp-client`)

`makeRegistry` in `packages/mcp-client/src/registry.ts` first counts provider-local names
case-insensitively and reserves every spelling that matches `[A-Za-z0-9_-]+`, occurs exactly once,
and is absent case-insensitively from `[...RESERVED_WIRE_NAMES, ...capabilityReserved]` supplied by
`buildRegistry` in `packages/loop/src/runtime/tools/mcp-registry.ts`. Those tools keep their exact
provider-local name. Reserving the entire eligible set before allocating fallbacks makes ownership
independent of entry order: a namespaced fallback cannot take a unique local spelling that appears
later in the pool.

Duplicate or case-colliding, invalid, and host-reserved local names use
`toWireToolName(fullName, used, onRename?)` in `packages/mcp-client/src/registry.ts`. It sanitizes the
dotted `mcpName.toolName` to `[A-Za-z0-9_-]` and appends `_1`, `_2`, … until the fallback is unused
case-insensitively. `mcp.registry.renamed` reports each fallback with
`reason: "invalid" | "reserved" | "collision"`. The model-facing `wireName` may therefore be a
preserved local name or a namespaced fallback, while dotted `fullName` remains the canonical and
resolvable identity.

### 3.3 `output_schema` size ceilings

```js
OUTPUT_SCHEMA_LIMITS = {
  nodes: 20_000,
  depth: 64,
  containerEntries: 4_096,
  keyChars: 1_024,
  stringChars: 1_048_576,
  singleStringChars: 262_144,
}
```
(`packages/loop/src/runtime/tools/result-contract.ts`). These are walked **before** Ajv ever sees the schema
(`outputSchemaBudgetIssue`, `packages/loop/src/runtime/tools/result-contract.ts`) via an explicit worklist stack (not
recursion), a `WeakSet` cycle guard, and `Object.getOwnPropertyDescriptors` (never a plain property
read, so a getter that throws is caught as "must not contain accessors" rather than invoked —
`packages/loop/src/runtime/tools/result-contract.ts`).

### 3.4 Argument-schema fail-open surface (`tool-arg-validator.ts`)

`isEmptySchema(schema)` treats a schema as unconstrained — and skips compiling or running
Ajv on it entirely — only when it has no `properties`/`required`/`items` **and** none of the
`CONSTRAINING_KEYWORDS`: `oneOf`, `anyOf`, `allOf`, `not`, `if`/`then`/`else`, `enum`,
`const`, `$ref`, `patternProperties`, `propertyNames`, `additionalProperties`,
`unevaluatedProperties`, `dependentRequired`, `dependentSchemas`, `dependencies`, `minProperties`,
`maxProperties`, `contains`, `prefixItems`, `minItems`, `maxItems`, `uniqueItems`, `minimum`,
`maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`,
`format`). A schema whose only content is `additionalProperties: false` therefore still counts as
constraining — `additionalProperties` is on the keyword list — and is validated rather than skipped
(pinned by `packages/loop/tests/unit/tool-arg-validator.test.ts`, `"enforces additionalProperties:false even with empty
properties"`). This is a **fifth** fail-open path, distinct from the four in §3.5: an empty schema is
accepted with **no** `tool.args_validation_failed_open` log line at all, unlike every other fail-open
branch, which always emits one.

### 3.5 Argument-validation fail-open reasons (`FailOpenReason`, `packages/loop/src/runtime/tools/tool-arg-validator.ts`)

| Reason | Trigger | Log shape | Test |
| --- | --- | --- | --- |
| `"compile_error"` | `ajv.compile(schema)` throws | `{event:"tool.args_validation_failed_open", tool?, reason:"compile_error", cause}` | `packages/loop/tests/unit/tool-arg-validator.test.ts` |
| `"async"` | the compiled function is `$async` | same shape, `reason:"async"` | `packages/loop/tests/unit/tool-arg-validator.test.ts` |
| `"non_boolean"` | the compiled validator's return is neither `true` nor `false` | same shape, `reason:"non_boolean"` | not asserted by a named-reason test in this document's scope — mechanism only, at `packages/loop/src/runtime/tools/tool-arg-validator.ts` |
| `"validator_threw"` | `validate()` itself throws | same shape, `reason:"validator_threw"`, `cause` | `packages/loop/tests/unit/tool-arg-validator.test.ts` (`"returns null when reading the schema throws"`) |

Every reason is reported at most once per schema object: `reported` is a `WeakSet` keyed by the same
schema reference as the compiled-function `WeakMap` cache; `cause` is
rendered through `errorText` (§7), not `JSON.stringify`, so a circular or `BigInt`-bearing cause never
throws inside the reporter itself.

### 3.6 Rejection message shapes

| Situation | Message shape | Cite |
| --- | --- | --- |
| Unknown MCP wire name | `` Unknown tool '<name>'. Available tools: <comma list> `` | `packages/loop/src/runtime/tools/mcp-dispatch.ts` |
| Malformed (truncated) arguments | `malformedArgumentsMessage(name, {ok:false, preview, reason:"unparsable"})` — "arrived truncated or malformed…", includes the raw `preview` | `packages/loop/src/runtime/tools/mcp-dispatch.ts`, `packages/capability/src/tool-arguments.ts` |
| Argument-schema violation | `` InputValidationError: <ajv.errorsText(...)> `` | `packages/loop/src/runtime/tools/tool-arg-validator.ts` |
| `submit_result` schema violation | `` submit_result rejected: <ajv.errorsText(...)> `` | `packages/loop/src/runtime/tools/result-contract.ts` |
| Bad `output_schema` at compile time | `ValidationError("invalid_output_schema", "…")`, four distinct message templates (non-object, malformed, `$async`, non-object top-level `type`) | `packages/loop/src/runtime/tools/result-contract.ts` |
| Non-`Error` thrown during compile | coalesced via `String(err)` into the same `ValidationError` | `packages/loop/src/runtime/tools/result-contract.ts` |
| Final MCP-handler wrapping (outermost text delivered to the model) | success: `` Tool '<name>' result: <resultText> ``; failure: `` Tool '<name>' result (error): <errText> `` — wraps every `errText`/`resultText` shape above one layer out | `packages/loop/src/runtime/loop/mcp-handler.ts` |

## 4. Behavior

### 4.1 Building the registry a run's tools resolve through

1. `openToolPool` (§4.2) acquires MCP `Lease`s in parallel.
2. `selectTools(opened, wireNamesForThisAgent)` (`@clarvis/mcp-client`, re-exported
   `packages/loop/src/runtime/tools/mcp-registry.ts`) narrows the pool to the tool full-names one profile actually lists, dropping
   any connection left with zero tools.
3. `buildRegistry(entries, capabilityReserved)` (`packages/loop/src/runtime/tools/mcp-registry.ts`) calls
   `@clarvis/mcp-client`'s `buildRegistry` with reserved names =
   `[...RESERVED_WIRE_NAMES, ...capabilityReserved]`. There are (at least) three call sites in
   `@clarvis/loop`'s source: the entry agent's own registry
   (`packages/loop/src/runtime/orchestrator.ts`), a lead's lazily-built subagent registry
   (`packages/loop/src/runtime/entry-inputs.ts`, closed over inside
   `buildSubagentRegistry`), and delegation's per-call registry
   (`packages/loop/src/runtime/subagents/delegate-task.ts`). `capabilityReserved` in the last
   two comes from `deps.capabilityReserved ?? []` (`packages/loop/src/runtime/entry-inputs.ts`, inside the closure's own
   `deps`, not the outer `p`) and `ctx.capabilityReserved ?? []` (`packages/loop/src/runtime/subagents/delegate-task.ts`)
   respectively, i.e. it is threaded from the same
   `CapabilityToolMetadata` the entry agent used — collection of that metadata
   (`collectCapabilityToolMetadata`, `packages/loop/src/runtime/capability-tool-metadata.ts`) is
   owned by [loop-capability-composition](capability-composition.md).
4. Inside `@clarvis/mcp-client`'s `makeRegistry` (`packages/mcp-client/src/registry.ts`), the first
   pass reserves every safe, case-insensitively unique, non-host-reserved provider-local name. The
   allocation pass preserves those exact names and sends every duplicate/case-colliding, invalid,
   or reserved local name through `toWireToolName`'s sanitized namespaced fallback. Every tool is
   indexed by exact wire name, exact dotted full name, and the first lowercased form of either;
   dotted `fullName` remains canonical.

### 4.2 `openToolPool` — acquiring the pool and validating it against profiles

1. `Promise.allSettled` acquires a `Lease` per declared server with
   `authorizationWait: "background"`, so an opened browser flow can never hold run admission
   (`openToolPool` in `packages/loop/src/runtime/open-tool-pool.ts`).
2. Successes/failures are partitioned.
3. **If the caller's signal is already aborted**, every acquired lease is released
   (`Promise.allSettled(successes.map(o => o.release()))`) and the function returns
   `{ ok:false, response:{status:"cancelled", result:"", usage: emptyUsage()} }` — *before* any
   further validation. This is unconditional: it runs even when every server actually
   connected.
4. **If every server failed for a terminal reason** and at least one was declared, the run fails with either
   `mcp_connection_failed` (carrying `mcp_name`/`transport` from the thrown
   `MCPConnectionFailedError`) or a generic `provider_error`. An
   `MCPAuthorizationPendingError` and `MCPBackgroundConnectDeferredError` are deliberately excluded
   from this terminal-failure predicate. A mixed pending/deferred plus terminal failure set therefore
   continues with an empty MCP pool; one terminal error cannot mask an inactive background server.
5. Otherwise, every failed/pending server is logged once as `mcp.connect.failed` and folded into
   `DegradedServer[]` — the run is **not** failed merely because *some* servers failed.
   The caller (`packages/loop/src/runtime/orchestrator.ts`, out of this document's scope) turns a non-empty `degraded`
   into a persisted trace record of kind `"mcp_degraded"` carrying `{ servers: poolResult.degraded }`,
   so a degraded startup is not only an in-memory return value but a wire-visible event a client or a
   rehydrated session actually sees; asserted end-to-end by
   `packages/loop/tests/integration/open-tool-pool.test.ts`, which checks the event's shape via
   `onEvent` and its persistence via `harness.getRun(...).trace.events`.
6. `poolToolNames(successes)` lists every surviving tool's dotted full name; `belongsToFailed(tool)`
   excludes from validation any profile tool reference whose namespace prefix matches a failed
   server, so a profile naming a tool on a server that degraded is not itself an error.
7. `findInvalidToolRef` (`packages/loop/src/runtime/subagents/subagent-profiles.ts`) checks
   every remaining profile tool reference against the surviving pool names; a miss releases every
   lease and returns `invalid_profile` naming the offending profile and tool.
8. On success, `{ ok:true, opened: successes, degraded }` is returned.

### 4.3 Dispatching one MCP tool call (`executeMcpToolCall`, `packages/loop/src/runtime/tools/mcp-dispatch.ts`)

1. `registry.resolve(call.name)` looks the wire name up.
2. **Unknown name** → `errText`/`resultText` = `` Unknown tool '<name>'. Available tools: … ``;
   `productive` stays `false` (never set `true`).
3. **Malformed arguments** (`call.malformedArguments !== undefined`) → rejected with
   `malformedArgumentsMessage`, again non-productive.
4. Otherwise, `argValidator.validate(resolved.inputSchema, call.arguments, call.name)` runs; a
   non-null result is the error text, `productive: false`. **No `tool_call_started`
   record fires for this branch** — the record is nested inside the `else` of the
   `validationError !== null` check, so a validation failure gets no start event, exactly
   like the unknown-name and malformed-arguments branches above it; only a call that clears
   validation and actually dispatches gets one.
5. On a clean call, a `tool_call_started` trace record fires, then:
   - `kind === "resource_list"` and the connection has `listResources` → `conn.listResources(signal)`.
   - `kind === "resource_read"` and the connection has `readResource` → `conn.readResource(String(uri), signal)`, `uri` read off `call.arguments.uri`.
   - otherwise → `conn.callTool(resolved.toolName, call.arguments, signal)`.

6. On `result.ok`, `extractMcpResult` splits any `content` array's image blocks out of the
   serialized text, replacing each with a `"[image delivered as an image block]"` placeholder so the
   base64 is not duplicated; `productive: true`.
7. On failure, `errText = result.error?.message ?? "tool execution failed"`; `productive =
   result.error?.code !== "mcp_unavailable"` — an `mcp_unavailable` failure sets
   `productive: false`, the opposite of every other error code (which leaves `productive: true`),
   and that `false` is what excuses a repeatedly-unreachable server from the convergence guard's
   unproductive-looping penalty (doc comment).
8. A terminal `tool_call` trace record always fires, carrying both `arguments` (what ran) and, if the
   call was hook-rewritten, `arguments_original` (what the model asked for) via
   `originalArgumentsPatch`.
9. Unless the signal is aborted, `guards.record(sig, resultText, errText !== null)` feeds the
   convergence guard, where `sig` is built from the **malformed preview** (`` `${call.name}:malformed:${call.malformedArguments}` ``) when arguments were
   malformed, or from `` `${call.name}:${safeStringify(call.arguments)}` `` otherwise.
   Using the raw preview rather than the arguments normalized to `{}` is deliberate: two calls to the
   same tool truncated differently by the provider must produce two different signatures, or the
   convergence guard would read every malformed call to that tool as the same repeated call and end
   the run for looping faster than the bug it is reporting. Pinned for both dispatchers by
   `packages/loop/tests/unit/malformed-tool-arguments.test.ts` — `"keeps two differently-truncated
   payloads distinct to the convergence guard"` ( for `executeAgentToolCall` for
   `executeMcpToolCall`).

### 4.4 Dispatching one built-in coding-tool call (`executeAgentToolCall`, `packages/loop/src/runtime/tools/builtin/execute-agent-tool-call.ts`)

Mirrors §4.3's shape without a registry resolve step (the toolset's `dispatch` already gates on
`names.has(name)` — see §4.6): malformed arguments short-circuit to a traced, non-productive error; otherwise a `tool_call_started` record fires, `toolset.dispatch` runs with an `onOutput`
callback relayed as `tool_output_delta` trace **signals**, and the terminal `tool_call`
record carries any returned `diff` and final command-review `guard` metadata. The convergence-guard signature always uses
`safeStringify(call.arguments)` here — there is no malformed-preview branch for the signal, because
malformed arguments already returned above. `packages/loop/tests/unit/malformed-tool-arguments.test.ts`
is the primary test for both dispatchers' malformed-argument path: refusal instead of dispatching on
fabricated-empty arguments, the model being told what actually arrived, the trace persisting the
arrived preview, and the distinct-signature rule above across `executeAgentToolCall` and
`executeMcpToolCall`.

For a schema-valid built-in call, convergence classification uses the structured review rather than
the serialized error text alone: `guard.outcome === "denied"` records the `"denied"` disposition;
otherwise `errText !== null` records a genuine execution failure and `null` records success. A denial
therefore remains visible as an error result/trace event but breaks, rather than increments, the
execution-failure streak. The doom guard does not make a threshold irrevocable until `runAgentLoop`
observes it after the whole dispatch, so a later success in the model-declared call order can reset a
crossing reached earlier in the same batch. Production: `executeAgentToolCall`,
`createConvergenceGuards`, and `createDoomLoopGuard`. Tests:
`packages/loop/tests/integration/command-guard-wiring.test.ts`,
`packages/loop/tests/integration/doom-loop-lead.test.ts`, and
`packages/loop/tests/unit/doom-loop-guard.test.ts`.

### 4.5 Building the two dispatch handlers and their ordering (context in `runtime/loop/run-agent.ts`)

`buildMcpHandler` (`packages/loop/src/runtime/loop/mcp-handler.ts`) wraps `executeMcpToolCall` as a `ToolHandler` whose
`matches` is unconditionally `true` — it is the catch-all. Two of its behaviors are named in
§2.3's signature table but only spelled out here: it wraps `executeMcpToolCall`'s
`resultText`/`errText` into the model-facing text shown in §3.6's final row — `` Tool '<name>' result:
<resultText> `` on success, `` Tool '<name>' result (error): <errText> `` on failure — and
`deps.progress` is the persona's own policy function mapping `{errText, productive}` to the
`HandlerVerdict.progress` boolean; `deps.availableWireNames` defaults to
`deps.registry.tools.map(t => t.wireName)` when the caller omits it. Its `canonicalName`
resolves the call through the same registry and returns `fullName`. The loop keeps the wire
name as `tool`, adds a distinct `toolFullName` only when resolution succeeds and differs, and treats a
throwing optional resolver as absent (`packages/loop/src/runtime/loop/loop.ts`). Both the
before- and after-tool hook payloads use that same identity. The coding-tool equivalent,
`buildAgentToolsHandler` (`packages/loop/src/runtime/capabilities/tools.ts`, owned by
[loop-capability-composition](capability-composition.md)), instead matches only `toolset.names.has(call.name)`. The run's
handler list is assembled as:

```
handlers = [...folded.handlers, ...(contract ? [submitHandler] : []), mcpHandler]
```
(`packages/loop/src/runtime/loop/run-agent.ts`), and `selectHandler` picks the **first**
handler whose `matches` returns true (`packages/loop/src/runtime/loop/loop-contract.ts`,
"earlier handlers win"). Consequences of that order:
- `folded.handlers` (capability-contributed, includes the coding-tools handler) always gets first
  refusal, so a capability can shadow a wire name the run also has an MCP tool for.
- `submitHandler` (built directly in `run-agent.ts`, matching only `SUBMIT_RESULT_TOOL_NAME`) comes
  next, guarded by whether an `output_schema`/`contract` exists for the run at all.
- `mcpHandler`, matching everything, is last — it is what actually resolves and dispatches any call
  nothing earlier claimed, including a genuinely unknown name (§4.3 step 2).

### 4.6 `AgentToolset` construction and gating (`builtin/toolset.ts`)

`createAgentToolsetWithAdapter(opts, adapter)` calls `adapter.resolve(opts)` to get the
raw tool defs + dispatch, then:
- drops every `EXEC_TOOL_NAMES` def when `opts.canExec` is false;
- builds `names` as the `Set` of the (possibly filtered) defs' wire names;
- wraps `dispatch` so a call whose name is not in `names` never reaches the adapter at all — it
  resolves immediately to `{ isError: true, text: "Tool '<name>' is not available to this agent." }`;
- otherwise races the adapter's own dispatch promise against the abort `signal` via `raceAbort`, resolving to `abortedResult()` (`"Tool call aborted (run cancelled)."`) the instant the
  signal fires, always removing its own abort listener afterward.

`createAgentToolset` is the only barrel-exported factory and always binds
`REAL_AGENT_TOOLS_ADAPTER`, which calls `@clarvis/tools`' `resolveConfig`/`listTools`/
`dispatch`/`contentText`, translating a coding-tool result's image content parts into
`ToolResultImage[]`, its `meta.diff` into the flat `diff` field, and its final `GuardReview` into the
flat `guard` field. `temporaryRoots` and `onTemporaryRootRegistered` are forwarded into
`resolveConfig`, so roots admitted during a run become available to the already-resolved toolset and
are reported back to its owner (`packages/loop/src/runtime/tools/builtin/toolset.ts`).

This whole policy layer (gate, exec filtering, abort race, listener cleanup) is directly pinned by
`packages/loop/tests/unit/toolset.test.ts` against a fake `AgentToolsAdapter`, independent of the real
`@clarvis/tools` adapter: the complete options object reaches the adapter unchanged
(`packages/loop/tests/unit/toolset.test.ts`); `canExec:false` removes every exec-tool def and name; a name outside `names` (`"shell"` filtered out, or `"unknown"`) is refused
*without the adapter's dispatch ever being called* (`adapter.calls` stays empty); call
inputs/output-chunks/the adapter's result all pass through unchanged; an already-aborted
signal short-circuits to the cancelled result without invoking the adapter at all; an
abort firing mid-flight wins the race and removes its `abort` listener (checked via
`node:events`' `getEventListeners`); and a normal (non-aborted) dispatch also leaves no
listener behind.

This section's `EXEC_TOOL_NAMES`/`canExec` filtering consumes `agentToolCaps`/`GrantCeiling`'s output
without re-deriving it: that function, `agentToolsActive`, and the rest of the `grants.ts`/`names.ts`
vocabulary are [grants-and-tool-exposure](../cross-cutting/grants.md)'s scope — see `specs/cross-cutting/grants.md` §2.4/§4.2 for
their full treatment.

### 4.7 Compiling and validating the `submit_result` contract (`result-contract.ts`)

1. `compileResultContract(outputSchema)` first rejects non-object/array/null schemas outright.
2. `outputSchemaBudgetIssue` walks the schema iteratively (an explicit stack, not recursion) counting
   nodes, string characters, container sizes and depth, and bails the first ceiling crossed, a cycle,
   or a non-enumerable/accessor-backed property; any budget violation is thrown as a plain
   `Error` and immediately re-wrapped as `ValidationError("invalid_output_schema", …)`.
3. `createStrictAjv().compile(outputSchema)` (strict-schema Ajv) actually compiles it; any thrown
   error (including a non-`Error` value, coalesced via `String(err)`) becomes the same
   `ValidationError` code.
4. `$async` on the compiled function is rejected the same way.
5. The schema's top-level `type` must be absent, `"object"`, or an array containing `"object"`
   (`describesObject`) — otherwise rejected, because `submit_result`'s arguments are
   always a JSON object regardless of what the caller's schema claims to describe.
6. `buildSubmitResultTool(outputSchema)` builds the `NamespacedTool`, exposing the caller's schema
   **by reference** (`tool.inputSchema === outputSchema`, no copy — pinned by
   `packages/loop/tests/unit/result-contract.test.ts`).
7. The returned `validate(args)` runs the compiled function; on success it returns
   `{ok:true, value: args}` **verbatim** (no coercion —); on failure,
   `{ok:false, error: "submit_result rejected: " + ajv.errorsText(...)}`.

`compileResultContract` is invoked exactly once per run, in `packages/loop/src/runtime/execute-run.ts`, only when
`parsed.output_schema !== undefined` — a throw here propagates as a pre-execution `ValidationError`
(the surrounding function's own doc says "@throws ValidationError if the body is invalid",
`packages/loop/src/runtime/execute-run.ts`), never as a run response. The compiled `contract`
then feeds `runtime/loop/run-agent.ts`'s `submitHandler` and its `fastAcceptSubmit`
finalize-gate fast path — both outside this document's scope (owned by the loop's finalize/
gate machinery) but both call `contract.validate` exactly as described above.

### 4.8 Tool-effect classification (`createToolEffectPort`, `packages/loop/src/runtime/tools/tool-effect.ts`)

Given `declared` (the union of every registered capability's `toolEffects`, keyed by wire name), the
returned port's `effect(wireName)` checks, **in this fixed order**:
1. `CONTROL` set (`submit_result`, `ask_user`, `delegate_task`, the five
   `AGENT_SUPERVISION_WIRE_NAMES`) → `"control"`.
2. `READ` set (`READ_ONLY_AGENT_TOOL_WIRE_NAMES`) → `"read"`.
3. `CODING` set (`AGENT_TOOL_WIRE_NAMES`) → `"mutate"` — this covers `shell` and every monitor tool,
   deliberately, because they "observe and mutate through one entry point".
4. otherwise, `declared[wireName] ?? "unknown"`.

The engine's own three sets are consulted **before** anything a capability declared, so no capability
can reclassify `shell` as `read` (pinned by `packages/loop/tests/unit/tool-effect.test.ts`).

## 5. Invariants

| # | Rule | Production | Test |
| --- | --- | --- | --- |
| INV-050 | A `submit_result` call whose arguments satisfy the caller's `output_schema` produces a completed run whose `result` validates against that schema and whose full response validates against the run envelope schema. | `packages/loop/src/runtime/tools/result-contract.ts`, `packages/loop/src/runtime/loop/run-agent.ts` | `packages/loop/tests/contract/structured-output-envelope.contract.test.ts` |
| INV-051 | `compileResultContract`'s `submit_result` tool exposes the schema *by reference* (`tool.inputSchema === SCHEMA`); its description mentions "finalize" and never the caller's field names. | `packages/loop/src/runtime/tools/result-contract.ts`, `packages/loop/src/runtime/tools/submit-result-tool.ts` | `packages/loop/tests/unit/result-contract.test.ts` |
| INV-052 | `validate()` returns conforming arguments verbatim (no coercion) and accepts an explicit `null` for a nullable field. | `packages/loop/src/runtime/tools/result-contract.ts` | `packages/loop/tests/unit/result-contract.test.ts` |
| INV-053 | A missing required field or wrong-typed field is rejected with a message naming both "submit_result rejected" and the offending field. | `packages/loop/src/runtime/tools/result-contract.ts` | `packages/loop/tests/unit/result-contract.test.ts` |
| INV-054 | `compileResultContract` throws `ValidationError("invalid_output_schema")` for: a well-formed-but-invalid schema; `$async: true`; any non-object schema value; any well-formed schema describing a non-object top-level value. Conversely, `describesObject` (§4.7 step 5) accepts a schema with no top-level `type` at all, a `type: ["object","null"]` union, and a type-less `oneOf` combinator — none of these are rejected. | `packages/loop/src/runtime/tools/result-contract.ts` | `packages/loop/tests/unit/result-contract.test.ts` (rejections) (`"accepts an object schema, a nullable-object union, and a type-less combinator schema"`, the positive counterpart) |
| INV-055 | An `output_schema` exceeding `OUTPUT_SCHEMA_LIMITS` (containers, depth, single-string length) is rejected before Ajv compiles it, as is a cyclic graph or an accessor-backed property. | `packages/loop/src/runtime/tools/result-contract.ts` | `packages/loop/tests/unit/result-contract.test.ts` |
| INV-056 | A non-`Error` thrown during schema compilation is coalesced via `String(err)` into a `ValidationError`, not propagated raw. | `packages/loop/src/runtime/tools/result-contract.ts` | `packages/loop/tests/unit/result-contract.test.ts` |
| INV-057 | `RESERVED_WIRE_NAMES` is *derived from* (not hand-copied alongside) `BUILTIN_WIRE_NAMES` concatenated with `AGENT_TOOL_WIRE_NAMES` — the two lists must literally be the same array. | `packages/loop/src/runtime/tools/wire-names.ts` | `packages/loop/tests/unit/mcp-registry-reservation.test.ts` |
| INV-058 | A wire-safe, case-insensitively unique, non-host-reserved MCP local name is preserved exactly. Eligible locals are reserved before fallbacks, making their ownership independent of entry order. Duplicate/case-colliding, invalid, or reserved locals use a sanitized namespaced fallback; a built-in name such as `submit_result`, `ask_user`, `read_file`, or `delegate_task` is never taken, and dotted `mcp.tool` remains canonical and resolvable. | `buildRegistry` in `packages/loop/src/runtime/tools/mcp-registry.ts`; `makeRegistry` and `toWireToolName` in `packages/mcp-client/src/registry.ts` | `packages/loop/tests/unit/mcp-registry-reservation.test.ts` (`"an MCP extension tool named … never takes the built-in's name"`); `packages/mcp-client/tests/unit/registry.test.ts` (`"preserves a unique provider-safe local name for skill/tool compatibility"`, `"falls back to namespaced names when local names collide across servers"`, and `"reserves a unique local name before allocating colliding namespaced fallbacks"`) |
| INV-059 | A capability's tool metadata (`reservedWireNames`, `toolEffects`) is collected from **every registered capability**, including one whose `forRun()` returns `null` for this run — declaration is independent of activation. | `packages/loop/src/runtime/capability-tool-metadata.ts` (owned by [loop-capability-composition](capability-composition.md)) | `packages/loop/tests/unit/mcp-registry-reservation.test.ts` |
| INV-060 | An MCP tool colliding with a *capability's* reserved name is blocked the same way, once passed through `buildRegistry`; without passing it, the engine alone provides no such protection. | `packages/loop/src/runtime/tools/mcp-registry.ts` | `packages/loop/tests/unit/mcp-registry-reservation.test.ts` |
| INV-061 | A tool-effect classifier built from declared `toolEffects` answers the declared effect for a declared name and `"unknown"` for any undeclared name. | `packages/loop/src/runtime/tools/tool-effect.ts` | `packages/loop/tests/unit/mcp-registry-reservation.test.ts` |
| INV-062 | Every call site of `buildRegistry` in `@clarvis/loop`'s source passes exactly two arguments, never omitting the second (which would silently let an MCP server shadow a reserved name). At least three such call sites exist. | `packages/loop/src/runtime/orchestrator.ts`, `packages/loop/src/runtime/entry-inputs.ts`, `packages/loop/src/runtime/subagents/delegate-task.ts` | `packages/loop/tests/architecture/mcp-registry-call-sites.test.ts` — walks every `.ts` file under `src/`, regex-scans for `buildRegistry(` call sites (excluding the definition itself), asserts there are `>= 3`, and asserts each passes exactly two top-level, balanced-bracket-parsed arguments |
| INV-063 | `openToolPool`, given a signal already aborted before it acquires a lease, still releases the lease it acquired and returns a `cancelled` response rather than leaking it. | `packages/loop/src/runtime/open-tool-pool.ts` | `packages/loop/tests/unit/open-tool-pool-policy.test.ts` |
| INV-064 | Every run requests background MCP authorization/admission. If any failed server is pending browser OAuth or deferred behind a saturated connection/handshake bound, an otherwise empty pool returns success plus `mcp_degraded`; mixed terminal failures cannot mask that nonterminal state. | `openToolPool` in `packages/loop/src/runtime/open-tool-pool.ts` | `packages/loop/tests/integration/open-tool-pool.test.ts` (all-pending, mixed pending/terminal, busy-admission, and consecutive-run cases) |
| INV-065 | `AGENT_TOOL_WIRE_NAMES` stays exactly in sync (as a set) with `AGENT_TOOL_NAMES`, the list `@clarvis/tools` actually registers. | `packages/loop/src/runtime/tools/wire-names.ts`, `packages/loop/src/runtime/tools/builtin/names.ts` | `packages/loop/tests/architecture/agent-tool-wire-names.test.ts` |
| INV-066 | `READ_ONLY_AGENT_TOOL_WIRE_NAMES` matches `READ_ONLY_TOOL_NAMES` exactly, and `READ_ONLY_TOOL_NAMES ∪ EDIT_TOOL_NAMES` equals `AGENT_TOOL_NAMES` with no overlap. | `packages/loop/src/runtime/tools/wire-names.ts`, `packages/loop/src/runtime/tools/builtin/names.ts` | `packages/loop/tests/architecture/agent-tool-wire-names.test.ts` |
| INV-067 | `shell` and `monitor_start` are never classified as read-only. | `packages/loop/src/runtime/tools/builtin/names.ts` (via `readOnlyTools` from `@clarvis/tools`) | `packages/loop/tests/architecture/agent-tool-wire-names.test.ts`, also `packages/loop/tests/unit/tool-effect.test.ts` |
| INV-TD-01 | A handler's canonical identity is additive: lifecycle hooks retain the model-facing wire name as `tool` and receive a different resolved identity only as `toolFullName`, consistently before and after dispatch. | `packages/capability/src/loop-contract.ts`, `packages/loop/src/runtime/loop/loop.ts` | `packages/loop/tests/unit/tool-hooks.test.ts` |

Additional invariants derived directly from the code, carrying no INV number of their own:

- **A malformed-arguments call is never dispatched to the connection/toolset.** Both dispatchers
  short-circuit to a rejection before any `conn.callTool`/`toolset.dispatch` call when
  `call.malformedArguments !== undefined` (`packages/loop/src/runtime/tools/mcp-dispatch.ts`,
  `packages/loop/src/runtime/tools/builtin/execute-agent-tool-call.ts`). Test:
  `packages/loop/tests/unit/malformed-tool-arguments.test.ts` covers both dispatchers —
  refusal instead of fabricated-empty-args dispatch, the model being told what actually arrived, the
  trace persisting the arrived preview, and the guard-signature-distinctness rule in §4.3 step 9.
- **Two malformed calls truncated differently by the provider get two different convergence-guard
  signatures.** The signature is built from the raw `malformedArguments` preview, not from the
  arguments normalized to `{}` (`packages/loop/src/runtime/tools/mcp-dispatch.ts`, `execute-agent-tool-call.ts`'s equivalent
  branch), so a provider that repeatedly truncates the same call's JSON differently each time does
  not collide with a legitimate call to the same tool. Test:
  `packages/loop/tests/unit/malformed-tool-arguments.test.ts` (coding-tool dispatcher) (MCP dispatcher),
  both titled `"keeps two differently-truncated payloads distinct to the convergence guard"`.
- **`mcp_unavailable` is the one MCP error code excluded from `productive`.** `productive =
  result.error?.code !== "mcp_unavailable"` (`packages/loop/src/runtime/tools/mcp-dispatch.ts`). Test:
  `packages/loop/tests/unit/mcp-dispatch.test.ts` (`mcp_unavailable` → non-productive) (any other code →
  productive, with a default message when none is supplied). The rule: `productive` marks a call
  that *did something*, so an unknown tool, a rejected argument schema and a transport-level
  `mcp_unavailable` are alike in that no tool ran; `mcp_unavailable` is the only *code* singled out
  because every other code comes back from a server that did receive the call.

  **But nothing in the engine reads the field.** Both progress predicates the engine builds decide on
  `errText === null` alone (`packages/loop/src/runtime/subagents/build-lead-input.ts`,
  `packages/loop/src/runtime/subagents/build-subagent-input.ts`), and their unit tests pin that
  they ignore it — `packages/loop/tests/unit/build-subagent-input.test.ts` asserts
  `{errText: null, productive: false}` is progress. So the `mcp_unavailable` special case has no
  effect on a shipped run; the field is computed and reported for a host that wants a finer signal
  than success-or-failure. The prior remark at `mcp-dispatch.ts` claimed the opposite behavioural
  consequence and has been corrected.
- **The argument validator never throws.** Every branch of `createToolArgValidator().validate` is
  wrapped so a compile error, a `$async` schema, a non-boolean validator return, or an exception
  during validation all resolve to `null` (accepted) rather than propagating
  (`packages/loop/src/runtime/tools/tool-arg-validator.ts`). Test: `packages/loop/tests/unit/tool-arg-validator.test.ts`.
  This is the mirror of INV-054/055 (which make the **output** schema fail hard); the **input**-side
  validator is fail-open by explicit design (doc comment at `packages/loop/src/runtime/tools/tool-arg-validator.ts`).
- **A fail-open is reported at most once per schema object.** `reported` is a `WeakSet` keyed by the
  same schema reference as the compile cache (`packages/loop/src/runtime/tools/tool-arg-validator.ts`). Test:
  `packages/loop/tests/unit/tool-arg-validator.test.ts` (`warn` called exactly once across two `validate` calls).
- **A coding-tool call outside the agent's ceiling never reaches the adapter.**
  `createAgentToolsetWithAdapter`'s wrapped `dispatch` returns the "not available" error before
  calling the resolved adapter's `dispatch` at all (`packages/loop/src/runtime/tools/builtin/toolset.ts`). Test:
  `packages/loop/tests/unit/toolset.test.ts` (`adapter.calls` stays empty for a filtered-out or unknown name).
- **An abort during a coding-tool dispatch always removes its listener**, whether it fired
  (`raceAbort`'s `.finally`, `packages/loop/src/runtime/tools/builtin/toolset.ts`) or the call finished normally first. Test:
  `packages/loop/tests/unit/toolset.test.ts` (both the abort-wins and the normal-completion case assert
  `getEventListeners(signal, "abort")` is empty afterward).
- **No `tool_call_started` record fires for a call that fails argument validation.** The record sits
  inside the `else` of `argValidator.validate(...) !== null` (`packages/loop/src/runtime/tools/mcp-dispatch.ts`), so a schema
  violation gets no start event, exactly like the unknown-name and malformed-arguments rejections
  ahead of it — only a call that clears validation and actually dispatches gets one. The terminal
  `tool_call` record still always fires (§4.3 step 8).
- **A profile's tool reference to a tool on a server that merely failed to connect is exempt from
  `invalid_profile`, not treated as a bad reference.** `belongsToFailed` filters such references out
  of what `findInvalidToolRef` checks (`packages/loop/src/runtime/open-tool-pool.ts`) before it runs, so the run
  proceeds on the surviving pool rather than failing outright. Test:
  `packages/loop/tests/integration/open-tool-pool.test.ts`.
- **`collectCapabilityToolMetadata`'s `toolEffects` merge is last-registration-wins with no conflict
  error.** It is a plain `Object.assign(toolEffects, capability.toolEffects ?? {})` inside the fold
  loop (`packages/loop/src/runtime/capability-tool-metadata.ts`), so two capabilities both declaring an effect for the same
  wire name silently let the later-registered one win — the doc comment calls this out as intentional
  ("retain registration-order, last-wins behavior to match the former inline composition in the
  orchestrator") but the code enforces no uniqueness check.

## 6. Failure modes and degradation

| Situation | Handler | Outcome |
| --- | --- | --- |
| Unknown MCP wire name | `executeMcpToolCall` (`packages/loop/src/runtime/tools/mcp-dispatch.ts`) | non-productive tool error, model told the available list |
| MCP arguments truncated/unparsable | `executeMcpToolCall` | non-productive, `malformedArgumentsMessage` |
| MCP arguments fail schema | `executeMcpToolCall` via `argValidator` | non-productive, `InputValidationError: …` |
| MCP tool call itself errors, code `mcp_unavailable` | `executeMcpToolCall` | non-productive (excused from convergence-guard penalty) |
| MCP tool call errors, any other code | `executeMcpToolCall` | productive (a real tool failure, still counted) |
| Coding-tool call not in the agent's `names` set | `createAgentToolsetWithAdapter`'s wrapped `dispatch` (`packages/loop/src/runtime/tools/builtin/toolset.ts`) | immediate error result, tool never reached |
| Abort signal fires mid coding-tool call | `raceAbort` (`packages/loop/src/runtime/tools/builtin/toolset.ts`) | `abortedResult()`, adapter promise abandoned (listener always removed) |
| Coding-tool malformed arguments | `executeAgentToolCall` (`packages/loop/src/runtime/tools/builtin/execute-agent-tool-call.ts`) | traced + guarded as non-productive, `malformedArgumentsMessage` |
| Argument schema itself uncompilable/`$async`/throws | `createToolArgValidator` (`packages/loop/src/runtime/tools/tool-arg-validator.ts`) | call accepted unchecked (`null`), one `tool.args_validation_failed_open` log line |
| `output_schema` malformed / oversized / cyclic / non-object | `compileResultContract` (`packages/loop/src/runtime/tools/result-contract.ts`) | `ValidationError("invalid_output_schema")` thrown pre-execution, run never starts |
| `submit_result` arguments fail the (valid) `output_schema` | `ResultContract.validate` (`packages/loop/src/runtime/tools/result-contract.ts`) | `{ok:false, error:"submit_result rejected: …"}`, surfaced to the model as a re-callable rejection (not terminal) |
| MCP server fails to connect at startup | `openToolPool` (`packages/loop/src/runtime/open-tool-pool.ts`) | logged `mcp.connect.failed`, folded into `degraded`, run proceeds without it, and `packages/loop/src/runtime/orchestrator.ts` persists it as an `mcp_degraded` trace record (`packages/loop/tests/integration/open-tool-pool.test.ts`) |
| Every declared MCP server fails for a non-OAuth reason | `openToolPool` | run fails hard: `mcp_connection_failed` (typed) or `provider_error` (generic) |
| Every declared MCP is awaiting browser OAuth | `openToolPool` | all are recorded in `mcp_degraded`; run proceeds with no MCP tools and does not await human input |
| Background MCP connection or handshake admission is saturated | `openToolPool` + connection manager | deferred server is recorded in `mcp_degraded`; run proceeds without waiting for a connect timeout, including while an earlier run's OAuth retains capacity |
| Pending/deferred MCP sits beside a terminal failure | `openToolPool` | all are degraded; the terminal failure does not hard-fail the otherwise runnable empty pool |
| Profile references a tool absent from the surviving pool, not for a failed-server reason | `openToolPool` + `findInvalidToolRef` | every acquired lease released, `invalid_profile` error naming the profile and tool (`packages/loop/tests/integration/open-tool-pool.test.ts`) |
| Profile references a tool belonging to a server that merely failed to connect | `openToolPool`'s `belongsToFailed` filter | the reference is exempt from `invalid_profile`; run proceeds on the surviving pool (`packages/loop/tests/integration/open-tool-pool.test.ts`) |
| Caller's signal already aborted when `openToolPool` runs | `openToolPool` | every acquired lease released, `cancelled` response, no further validation attempted |

## 7. Coupling

- **Depends on `@clarvis/mcp-client`** for `buildRegistry` (the real implementation),
  `poolToolNames`, `selectTools`, `toWireToolName`, `ConnectionManager`, `Lease`,
  `MCPConnectionFailedError`, `ElicitationRelay` (`packages/loop/src/runtime/tools/mcp-registry.ts`, `packages/loop/src/runtime/open-tool-pool.ts`). This
  is a runtime, static-import edge; the mcp-client package itself is documented in the sibling
  [mcp-client](../foundations/mcp-client.md) document, whose delegation note says it hands the "when to call"/"reserved-name seeding"
  half to this document.
- **Depends on `@clarvis/capability`** for `NamespacedRegistry`, `NamespacedTool`, `ToolEffect`,
  `ToolEffectPort`, `LLMToolCall`, `TracePort`, `AgentRole`, `ToolResultImage`,
  `malformedArgumentsMessage`, `ValidationError`, `sanitizeErrorMessage`, `Logger`, `RunRequest`,
  `RunResponse`, `Usage`, `HandlerBase`, `HandlerVerdict`, `ToolHandler` (throughout; e.g.
  `packages/loop/src/runtime/tools/mcp-dispatch.ts`, `packages/loop/src/runtime/tools/result-contract.ts`, `packages/loop/src/runtime/open-tool-pool.ts`,
  `packages/loop/src/runtime/loop/mcp-handler.ts`).
- **Depends on `@clarvis/tools` (optional)** only from `runtime/tools/builtin/{names,toolset}.ts` —
  `tools`, `readOnlyTools`, `dispatch`, `contentText`, `listTools`, `resolveConfig` (`packages/loop/src/runtime/tools/builtin/names.ts`,
  `packages/loop/src/runtime/tools/builtin/toolset.ts`). This is what makes `builtin/**` conditionally loadable: everything else in this
  document's scope (`wire-names.ts`, `mcp-registry.ts`, `mcp-dispatch.ts`, `result-contract.ts`,
  `submit-result-tool.ts`, `tool-arg-validator.ts`, `tool-effect.ts`) imports neither `@clarvis/tools`
  nor `@clarvis/mcp-client`'s heavier surfaces without going through the dep-free wire-name mirror —
  `wire-names.ts`'s own doc comments state this is deliberate (`packages/loop/src/runtime/tools/wire-names.ts`).
- **`ajv`/`ajv-formats` use a lazy fallback**, not module-scope value imports, via `load()` in
  `packages/loop/src/validation/ajv.ts` — both `tool-arg-validator.ts` and `result-contract.ts`
  reach Ajv only through `createAjv()`/`createStrictAjv()`, so nothing in this document's static
  import graph forces Ajv's cost onto an ordinary host that never validates a tool call. The
  isolated worker is the explicit exception: its standalone composition root statically bundles
  and installs those two modules before guest execution.
- **Consumed by `runtime/loop/run-agent.ts`** (loop core, out of this document's scope): builds
  `argValidator` (`createToolArgValidator`, `packages/loop/src/runtime/loop/run-agent.ts`), builds `mcpHandler`
  (`buildMcpHandler`), builds `submitHandler` around `contract.validate`, and assembles the handler chain in the fixed order described in §4.5.
- **Consumed by `runtime/execute-run.ts`** (out of scope): calls `compileResultContract` exactly once
  per run, gated on `parsed.output_schema !== undefined` (`packages/loop/src/runtime/execute-run.ts`).
- **Consumed by `runtime/orchestrator.ts`** (out of scope): registers the tool-effect port
  (`services.provide(TOOL_EFFECT_PORT, createToolEffectPort(...))`, `packages/loop/src/runtime/orchestrator.ts`) and is one
  of the three `buildRegistry` call sites.
- **Consumed by `runtime/capabilities/tools.ts`** (owned by [loop-capability-composition](capability-composition.md)): builds
  `AgentToolset` via `createAgentToolset` and wraps `executeAgentToolCall` as
  `buildAgentToolsHandler`, the coding-toolset's own `ToolHandler` (`packages/loop/src/runtime/capabilities/tools.ts`) — this is a
  runtime edge in the opposite direction from `builtin/**`'s own imports (the capability imports
  `builtin/**`, not the reverse).
- **`error-text.js`'s `errorText`** is imported by `packages/loop/src/runtime/tools/tool-arg-validator.ts` to render a fail-open
  `cause` safely — `String(err)`/`.message` rather than `JSON.stringify`, which throws on a circular
  structure or a `BigInt` and answers `undefined` for a symbol or a function (own doc comment at
  `packages/loop/src/runtime/tools/tool-arg-validator.ts`). The function itself
  (`packages/loop/src/error-text.ts`) is a two-branch coercion — `e instanceof Error ? e.message :
  String(e)` — with no module dependency of its own; it is this package's original, re-exported
  outward as `errorText` from `./host` (`packages/loop/src/host.ts`), which
  `packages/kernel/src/policy.ts` re-exports in turn from `@clarvis/loop/host`. Three modules
  down that chain, `packages/code/src/adapters/errors.ts` keeps a deliberate, independent copy of the
  same implementation rather than importing it — its own doc comment states the copy is "kept
  identical and pinned by `tests/unit/errors.test.ts`" because the re-export path would otherwise
  drag the host graph and its schema construction onto the pre-paint path merely to obtain this
  helper — but that trade-off is `code`'s own concern, not this document's.
- **`../support/stringify.ts`'s `safeStringify`** is imported by both `packages/loop/src/runtime/tools/mcp-dispatch.ts` and
  `packages/loop/src/runtime/tools/builtin/execute-agent-tool-call.ts`, and is what every convergence-guard signature in §4.3/§4.4
  is built from. Its own definition (`packages/loop/src/runtime/support/stringify.ts`) passes a
  string through unchanged and otherwise falls back through two layers: `JSON.stringify(value) ??
  String(value)` (the `??` catches a bare `undefined`, which `JSON.stringify` answers as the
  `undefined` value rather than a string), and a `catch` around the whole `JSON.stringify` call falls
  back to `String(value)` again for a value `JSON.stringify` throws on outright (a circular
  reference or a `BigInt`) — so the function never throws regardless of what a tool call's
  `arguments` or a dispatched result happens to contain. A third call site outside this document's own
  scope, `packages/loop/src/runtime/tools/ask-user-tool.ts` (`extractAnswer`, owned by
  [elicitation-and-user-interaction](../cross-cutting/elicitation.md)), reaches the same function for
  the same reason: serializing an elicitation answer that turned out not to be a plain string.
- **`CONTROL_PLANE_TOOL_NAMES` is re-exported outward** through `packages/loop/src/host.ts` →
  `packages/kernel/src/policy.ts`, consumed by
  `packages/code/src/adapters/mcp-capabilities.ts` — this document only owns the constant's
  declaration, not its downstream consumers.

## 8. Open questions

- **Why `mcp_unavailable` specifically, and no other code, is excluded from `productive`** is stated
  as a design rationale in the doc comment (`packages/loop/src/runtime/tools/mcp-dispatch.ts`: "so retrying an unreachable
  server is not treated as unproductive looping"), but whether any *other* MCP error code might
  deserve the same treatment is not something the code decides one way or the other — only this one
  string is special-cased.

- (Resolved during reconciliation, kept for the record: both the call-site count/arity of INV-062 and
  the "vision-delegate" registry named in `packages/loop/src/runtime/tools/mcp-registry.ts`'s doc comment are settled by
  `packages/loop/tests/architecture/mcp-registry-call-sites.test.ts`, initially missed because it sits
  outside this document's stated scope. Its own doc comment states plainly "there was a fourth: the
  vision delegate's. The vision pre-pass is a single model call with no tools now, so it builds no
  registry at all", which is why only three call sites exist today; and its two `it` blocks
  are exactly the dedicated architecture-walk test the two removed bullets above said was missing —
  see the updated INV-062 citation in §5.)
- **Whether a profile's `tools` field can name a built-in coding-tool wire name (not just an MCP dotted
  name)**, and how that would interact with `findInvalidToolRef`'s pool-name check in `openToolPool`,
  is governed by the request/profile schema — out of this document's scope (see
  [loop-request-and-settings-schema](request-and-settings-schema.md) / [grants-and-tool-exposure](../cross-cutting/grants.md)). This document only describes the
  mechanism `openToolPool` runs, not the full universe of legal `tools` entries.
- (Resolved during reconciliation, kept for the record: `runtime/tools/builtin/grants.ts` and
  `builtin/names.ts` were explicitly in this document's assigned scope text, but the same two files carry
  the broader `BuiltinGrant`/`Grant` vocabulary and profile `can_spawn`/`default_spawn` topology that
  [grants-and-tool-exposure](../cross-cutting/grants.md) treats in full. Nothing in either file's code
  favors one home over the other — the ambiguity is in the boundary between the two documents, not in
  the source — so the split follows that boundary: §2.7 and §4.6 above now cite
  `agentToolCaps`/`GrantCeiling`/`EXEC_TOOL_NAMES`/etc. only where this document's own
  toolset-construction mechanism consumes them, and defer their definitions to
  `specs/cross-cutting/grants.md` §2.4/§4.2.)
- (Resolved during drafting, kept for the record: `packages/loop/tests/unit/toolset.test.ts` does
  directly pin `createAgentToolsetWithAdapter`'s gate, exec-tool filtering and abort-race behavior —
  see the updated citations in §4.6/§5 below. The primary-sources list for this document did not name the
  file explicitly, which is why it was initially missed; it was found by a directory search and is
  cited throughout this document.)
