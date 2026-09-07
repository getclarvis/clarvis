# Run-request validation, profile readiness and the engine settings schema

> Implemented at `packages/loop/src/validation/**` and `packages/loop/src/settings/**`. Every claim
> below is anchored to a file and a named symbol or test. Open questions are collected in the final section.

## 1. Purpose

This subsystem is the loop's input boundary on both of its two untrusted documents: a single run
request (the body an `executeRun` call receives) and `settings.json` (the file an operator or a
plugin author writes on disk). Both are Zod schemas layered with hand-written semantic rules that Zod
cannot express as a single schema — cross-field constraints, registry lookups, and environment
ceilings that depend on values the schema itself does not see.

The two documents share one problem: an engine that ships optional and host-registered capabilities
must let a capability contribute its own field to *both* documents (a `settings.json` block, a
per-run request param) without the engine ever naming that capability. `validateBody`
(`packages/loop/src/validation/request-schema.ts`) and `settingsSchemaFor`
(`packages/loop/src/settings/capability-settings.ts`) are the two answers to that problem, built on
the same idea: a bare, statically-typed schema for the engine's own fields, extended at the point of
use with whatever a `CapabilityRegistry` declares.

A third, smaller responsibility rides beside these two: turning a caller-authored agent markdown file
(frontmatter + body) into the same `AgentProfile` shape a run request carries
(`packages/loop/src/settings/agent-frontmatter.ts`), and a matching "would this profile actually run"
advisory check a UI can run without executing anything
(`packages/loop/src/validation/profile-readiness.ts`).

## 2. Surface

### 2.1 Request validation (`src/validation/**`)

| Symbol | Signature | File |
| --- | --- | --- |
| `validateBody` | `(raw: unknown, env: EnvConfig, registry?: CapabilityRegistry) => ValidatedRunRequest` | `packages/loop/src/validation/request-schema.ts` |
| `ValidatedRunRequest` | `{ request: RunRequest; shape: RunShape }` | `packages/loop/src/validation/request-schema.ts` |
| `runRequestSchema` | Zod object, `.strict()` | `packages/loop/src/validation/request/request-schema.ts` |
| `ParsedRunRequest` | `z.infer<typeof runRequestSchema>` | `packages/loop/src/validation/request/request-schema.ts` |
| `budgetSchema` | Zod object, `.strict()` | `packages/loop/src/validation/request/request-schema.ts` |
| `agentProfileSchema` | Zod object, `.strict()` | `packages/loop/src/validation/request/profile-schemas.ts` |
| `modelField` | `z.string()` regex `^[a-z0-9_-]+/[a-zA-Z0-9_./:-]+$` | `packages/loop/src/validation/request/profile-schemas.ts` |
| `grantSchema` | `z.string()` + `.options = BUILTIN_GRANT_NAMES` | `packages/loop/src/validation/request/profile-schemas.ts` |
| `providerConfigSchema` | Zod object, `.strict()` | `packages/loop/src/validation/request/provider-schemas.ts` |
| `serverSchema` | `serverBase.superRefine(refineServerTransport)` | `packages/loop/src/validation/request/server-schemas.ts` |
| `messagesField` / `messageSchema` | Zod array / object | `packages/loop/src/validation/request/message-schemas.ts` |
| `deriveRunShape` | `(request: RunRequest, capabilityNeedsHuman?: boolean) => RunShape \| undefined` | `packages/loop/src/validation/request/run-shape.ts` |
| `parseRunRequest` | `(raw: unknown, registry?) => ParsedRunRequest` | `packages/loop/src/validation/request/parsing.ts` |
| `BUILTIN_GRANT_NAMES` | `readonly ["ask_user","read_workspace","edit_workspace","run_commands"]` | `packages/loop/src/validation/request/grant-registry.ts` |
| `requireKnownGrants` | `(data, registry?) => void`, throws `invalid_profile` | `packages/loop/src/validation/request/grant-registry.ts` |
| `profileReadinessIssues` | `(ctx: ReadinessContext) => ReadinessIssue[]` | `packages/loop/src/validation/profile-readiness.ts` |
| `PROFILE_READINESS_RULES` | `readonly ReadinessRule[]`, 8 rules | `packages/loop/src/validation/profile-readiness.ts` |
| `createAjv` / `createStrictAjv` | `() => AjvInstance` | `packages/loop/src/validation/ajv.ts` |
| `INPUT_LIMITS` | `Record<string, number>` ceiling table | `packages/loop/src/validation/input-limits.ts` |
| `boundedRecord` | `<K,V>(value: Record<K,V>, maxEntries: number) => boolean` | `packages/loop/src/validation/input-limits.ts` |
| `positiveIntField` / `nonnegativeIntField` | `(label: string) => ZodNumber` — the shared "must be a positive/non-negative integer" field, used by `budgetSchema`, `agentProfileSchema` (`retry`, `compaction`, `stagnation_threshold`, `call_timeout_ms`) and `providerConfigSchema`'s `models[].context_window_tokens`/`max_output_tokens` | `packages/loop/src/validation/request/numeric-schemas.ts` |

Barrel: `packages/loop/src/validation/index.ts` re-exports `ajv`, `profile-readiness` and
`request-schema`. The barrel itself has no package-root export path, and
`@clarvis/loop`'s bare export (`.` → `src/lib.ts`) re-exports none of these symbols either, so the
outside world reaches them only through the narrower `@clarvis/loop/host` subpath
(`packages/loop/src/host.ts`), which is what `@clarvis/kernel` actually imports (see §7).

### 2.2 Settings (`src/settings/**`, engine half)

| Symbol | Signature | File |
| --- | --- | --- |
| `settingsSchema` | Zod object, `.strict()` | `packages/loop/src/settings/settings-schema.ts` |
| `SettingsFile` | `z.infer<typeof settingsSchema>` | `packages/loop/src/settings/settings-schema.ts` |
| `mcpServerSettingsSchema` | `mcpServerBase.strict().superRefine(refineMcpServer)` | `packages/loop/src/settings/settings-schema.ts` |
| `mcpServerPluginSchema` | `z.preprocess(inferMcpTransport, mcpServerBase).superRefine(refineMcpServer)` (no `.strict()`) | `packages/loop/src/settings/settings-schema.ts` |
| `pluginNameField` | lowercase filesystem-safe token with `.`, `_`, `-`; rejects `--`, `..`, edge separators and 3 reserved names | `packages/loop/src/settings/settings-schema.ts` |
| `settingsSchemaFor` | `(registry?: CapabilityRegistry) => z.ZodType<SettingsFile>` | `packages/loop/src/settings/capability-settings.ts` |
| `readCapabilitySettings` | `<T>(settings, spec: CapabilitySettingsSpec) => T \| undefined` | `packages/loop/src/settings/capability-settings.ts` |
| `mergeSettings` | `(scopes: SettingsScope[], registry?) => SettingsFile` | `packages/loop/src/settings/settings-merge.ts` |
| `mergeProviders` | `(...lists: (ProviderConfig[] \| undefined)[]) => ProviderConfig[] \| undefined` | `packages/loop/src/settings/settings-merge.ts` |
| `SETTINGS_MERGE_STRATEGY_KEYS` | `(keyof SettingsFile)[]` | `packages/loop/src/settings/settings-merge.ts` |
| `settingsServerToEngine` | `(name: string, entry: McpServerSettings) => McpServerConfig` | `packages/loop/src/settings/engine-server.ts` |
| `agentFrontmatterSchema` | `agentProfileSchema.omit(...).extend(...).loose()` | `packages/loop/src/settings/agent-frontmatter.ts` |
| `splitAgentFrontmatter` | `(raw: string, mode?: "strict" \| "lenient") => RawAgentFrontmatter` | `packages/loop/src/settings/agent-frontmatter.ts` |
| `normalizeTools` | `(tools: string[] \| string \| undefined) => string[]` | `packages/loop/src/settings/agent-frontmatter.ts` |
| `agentPromptOf` | `(basePrompt?: string, body: string) => string \| undefined` | `packages/loop/src/settings/agent-frontmatter.ts` |
| `editDistance` | `(a: string, b: string, limit: number) => number` | `packages/loop/src/settings/typo-suggestion.ts` |
| `typoBudget` | `(candidate: string) => number` | `packages/loop/src/settings/typo-suggestion.ts` |

`packages/loop/src/settings/plugin-schema.ts`, `plugin-agents.ts`, `plugin-resources.ts` and
`marketplace-schema.ts` live in the same directory and are re-exported from the same `host.ts`
subpath, but their content is owned by the [plugins-and-marketplace](../hosts/plugins.md) document, not this one, and is
only referenced here as a coupling (§7).

### 2.3 The `@clarvis/loop/host` subpath — the actual consumer-facing surface

`packages/kernel/src` never imports from `packages/loop/src/validation/*` or
`packages/loop/src/settings/*` directly (verified: `grep` for those paths anywhere under
`packages/kernel/src` returns nothing). Every one of `mergeSettings`, `settingsSchemaFor`,
`agentFrontmatterSchema`, `profileReadinessIssues`, `readCapabilitySettings`, `BUILTIN_GRANT_NAMES`,
`splitAgentFrontmatter`, `settingsSchema`, `providerConfigSchema` and `grantSchema` reaches
`@clarvis/kernel` through the single `@clarvis/loop/host` export (`packages/loop/src/host.ts`),
which is the sanctioned "host composition surface for config, provider, plugin, and sandbox policy"
(`packages/loop/src/host.ts`). `validateBody` itself is **not** re-exported from `host.ts`; it is
called only from inside the engine (`packages/loop/src/runtime/execute-run.ts`) and separately
exposed for tests via `packages/loop/src/testing/index.ts` (`validateBody`).

## 3. Data and formats

### 3.1 Run request shape (wire)

`runRequestSchema` (`packages/loop/src/validation/request/request-schema.ts`) is a strict object
with these top-level fields: `execution_id?`, `continue_from?`, `prompt_cache_key?`,
`prompt_cache_ttl?`, `messages`, `servers`, `profiles`, `entry`, `providers`, `vision_model?`,
`budget`, `elicit_wait_ms?`, `guard_escalation?`, `output_schema?`, plus
`...capabilityRequestParamFields` (`packages/loop/src/validation/request/request-schema.ts`) — a
static spread of every **built-in** capability's own request params (e.g. `guard_judge`, from the
agent-tools capability's settings spec, `packages/loop/src/runtime/capabilities/tools-settings.ts`,
confirmed reached at `packages/loop/src/validation/request/provider-rules.ts`).

The hooks capability contributes `hook_user_prompt_expansion?: { command_name: string }`. It is a
reserved host context field used by the kernel when a user explicitly invokes a skill command;
ordinary prompts and model-initiated `load_skill` calls omit it. The object is strict, its name is
1–256 characters, and the field is part of the request schema only because the loop/hook capability
boundary is a run request (`packages/loop/src/runtime/capabilities/hooks.ts`, registration). It is structurally accepted at the wire boundary like every capability request param, so
it is context, not an unforgeable security claim.

`execution_id` and `continue_from` are both optional strings sharing one wire constraint, defined
once in `packages/loop/src/types/execution-id.ts` and imported into `request-schema.ts` rather than
duplicated: `EXECUTION_ID_PATTERN` (`packages/loop/src/types/execution-id.ts`) is
`/^[A-Za-z0-9._:-]+$/` — ASCII letters, digits, and `.`/`_`/`:`/`-`, one or more characters, no
whitespace — and `EXECUTION_ID_MIN`/`EXECUTION_ID_MAX` are `1`/`128`. `request-schema.ts`
applies the same three checks to both fields: `.min(EXECUTION_ID_MIN, …)`, `.max(EXECUTION_ID_MAX,
…)`, `.regex(EXECUTION_ID_PATTERN, …)` for `execution_id`
(`packages/loop/src/validation/request/request-schema.ts`) and again for `continue_from`, each with its own field-named error message. A caller that supplies neither field gets a
minted id instead ([loop-run-lifecycle](loop-run-lifecycle.md) §4.1 step 13's `generateExecutionId()`
path); the pattern only constrains a **caller-supplied** value. `packages/loop/tests/unit/execution-id.test.ts`
pins the charset against these same three constants (accepting `my-app.task_001:v2`, rejecting a
space/slash/emoji/comma) and the 128-character boundary (exactly 128 accepted, 129 rejected), and
separately asserts that `@clarvis/trace`'s `generateExecutionId()` — the id minted when a caller
supplies neither field — always satisfies `EXECUTION_ID_PATTERN` itself. `generateExecutionId`'s own
test, `packages/trace/tests/unit/execution-id.test.ts`, pins its `exec_`-prefixed v4-UUID shape
against a separate, hardcoded regex rather than against `EXECUTION_ID_PATTERN`.

Example minimal valid body (from the test fixture, `packages/loop/tests/helpers/request.ts`):

```json
{
  "messages": [{ "role": "user", "content": "hi" }],
  "servers": [],
  "profiles": [
    { "name": "solo", "model": "anthropic/model", "tools": [], "iteration_limit": 5 }
  ],
  "entry": "solo",
  "providers": [{ "name": "anthropic", "kind": "anthropic" }],
  "budget": { "on_exceed": "stop", "total_token_limit": 1000 }
}
```

`messagesField`/`messageSchema` (`packages/loop/src/validation/request/message-schemas.ts`)
enforce a whole taxonomy of character/count ceilings:
`CONTENT_MAX_CHARS = 1,000,000` (one text part), `IMAGE_MAX_CHARS = 10,000,000` (one image part),
`CONTENT_PARTS_MAX = 100` (parts per message), `MESSAGE_CONTENT_MAX_CHARS = 16,000,000` (aggregate
per single message, across every part) and `MESSAGES_TOTAL_MAX_CHARS = 16,000,000` (aggregate across
the whole `messages` array) — all defined at `packages/loop/src/validation/request/message-schemas.ts`. `contentPartSchema` is a
`discriminatedUnion("type", [textPartSchema, imagePartSchema])`; array (multimodal)
content is legal only on a `user` message, enforced by `messageSchema`'s own `superRefine`, which also enforces the per-message aggregate cap; `messagesField`'s own
`superRefine` walks the array and enforces the whole-history aggregate cap. The doc
comment on `messagesField` states why a per-part cap alone does not bound the sum: "100 legal 10 MB
images in one message (and 10,000 such messages) passed validation" before this refinement existed. Tests: `packages/loop/tests/unit/request-message-schemas.test.ts` (multimodal
rejected on a `system` message) (per-message aggregate cap defeats individually-legal
parts) (whole-history aggregate cap defeats individually-legal messages).

One agent profile (`agentProfileSchema`,
`packages/loop/src/validation/request/profile-schemas.ts`): `name`, `description?`, `model`,
`base_prompt?`, `tools` (required array), `grants?`, `can_spawn?`, `default_spawn?`,
`iteration_limit?`, `stagnation_threshold?`, `call_timeout_ms?`, `reasoning_summary?`,
`reasoning_effort?`, `retry?` (`max_retries`, `max_retry_after_ms`), `compaction?` (`enabled`,
`context_fraction`, `target_fraction`, `max_result_chars`, `preserve_recent_tokens`, `prompt`,
`prompt_mode`), `orchestration?` (an **open** object, only `force_tool_on_nudge` is named —
`packages/loop/src/validation/request/profile-schemas.ts`, proven open by
`packages/loop/tests/unit/request-profile-validation.test.ts` accepting an extra
`capability_owned` key). `compactionSchema` carries a `superRefine`
(`packages/loop/src/validation/request/profile-schemas.ts`) enforcing two cross-field rules
not implied by any single field's own type: (a) `compaction.target_fraction` must be `<=
compaction.context_fraction` (the low-water mark cannot sit above the high-water mark); (b)
`compaction.prompt` cannot be combined with `compaction.prompt_mode: "none"`, because a prompt that
mode never uses "would never be used." Both are pinned at
`packages/loop/tests/unit/request-profile-validation.test.ts` ("compaction watermarks",
"compaction prompt mode").

`call_timeout_ms` is the profile's per-physical-model-call inactivity window when the provider is
streaming: every received provider part resets it, so an actively growing tool argument may outlive
the value in total. Generation has no observable progress and remains absolutely bounded. The
schema owns validation and ceiling enforcement; the runtime timeout and retry contract is owned by
[LLM](../foundations/llm.md). Production: `agentProfileSchema`, `enforcePerProfileRules`, and
`AiSdkAdapter.call`. Test: `packages/loop/tests/unit/request-profile-validation.test.ts` and
`packages/llm/tests/component/ai-sdk-adapter-streaming.test.ts`.

`modelField` keeps the provider token restricted to settings-safe lowercase characters, then allows
provider-native `/`, `.`, and `:` characters in the model-id half. This admits tagged local-server
ids such as `local/qwen2.5-coder:7b` without weakening the provider-name boundary. Tests:
`packages/loop/tests/unit/request-profile-validation.test.ts` (tagged profile model) and
`packages/loop/tests/unit/settings-schema.test.ts` (tagged default model and provider model map).

One provider entry (`providerConfigSchema`,
`packages/loop/src/validation/request/provider-schemas.ts`): `name` (regex `^[a-z0-9_-]+$`),
`kind` (`"openai-compatible" | "openai" | "anthropic" | "google" | "openai-codex" |
"xai-grok"`), `base_url?`, `api_key_env?`
(regex `^[A-Za-z_][A-Za-z0-9_]*$`), `headers?`, `body?`, `models?` (a record keyed by model id, each
entry requiring `context_window_tokens` and optionally `max_output_tokens`, `capabilities`,
provider-published `reasoning_efforts`, `prompt_cache` (`"explicit"|"implicit"|"off"`), `headers`,
`body`). `reasoning_efforts` is retained metadata for model-aware host configuration; the loop
validates non-empty strings but does not interpret their vocabulary
(`packages/loop/src/validation/request/provider-schemas.ts`).

One MCP server (`serverSchema`, `packages/loop/src/validation/request/server-schemas.ts`): `name`,
`transport` (default `"stdio"`), plus a transport-conditional set enforced by
`refineServerTransport`: `stdio` requires `command` and forbids `url`/`headers`/remote credentials;
`http`/`sse` requires a well-formed `url` and forbids
`command`/`args`/`env`/`cwd`/`shared`/`env_vars`. A URL-only entry infers `http`, and
`http_headers` normalizes to `headers`, matching portable `.mcp.json` declarations.

The remaining optional surface is carried into `McpServerConfig`: `expandVariables`,
`shared`, `resources`, `auto_tools`, OAuth (`client_id`, `callback_url`, `callback_port`, and HTTPS
`client_metadata_url`), `bearer_token_env_var`, `env_http_headers`, `env_vars`, per-server startup
and tool timeouts, `enabled`, `required`, `enabled_tools`, `disabled_tools`, and `authentication`.
The allow and deny lists may not overlap. A configured `callback_url` may not carry a query or
fragment, matching the redirect accepted by the OAuth credential store. `expandVariables` lets
portable Agent Plugin adapters disable Clarvis's ordinary `${VAR}` expansion after their
format-owned `PLUGIN_ROOT`/`PLUGIN_DATA`
pass. `shared` opts a `stdio` server into one pooled subprocess reused across runs and therefore
suppresses elicitation. `resources` (default on) controls synthetic resource tools. `auto_tools`
(default false) admits every retained advertised tool to every effective agent in the run without
mutating authored profiles. Direct requests normalize `enabled: false` declarations out before
duplicate-name checks, tool-pool acquisition, and skill dependency evaluation, just as the
settings-derived path does. Production: `serverSchema`, `refineServerTransport`, `parseRunRequest`,
and `addAutomaticMcpTools`. Test: `packages/loop/tests/unit/settings-schema.test.ts`,
`packages/loop/tests/unit/engine-server.test.ts`, `packages/loop/tests/unit/automatic-mcp-tools.test.ts`,
`packages/loop/tests/unit/request-parsing.test.ts`, and
`packages/loop/tests/integration/open-tool-pool.test.ts`.

### 3.2 `settings.json` shape

`settingsSchema` (`packages/loop/src/settings/settings-schema.ts`) is a strict object:
`providers?`, `mcpServers?` (a **record** keyed by server name — the "ecosystem-standard `mcpServers`
shape", `packages/loop/src/settings/settings-schema.ts`, as opposed to the request's flat
`servers[]` array where each entry carries its own `name`), `default_model?`,
`default_vision_model?`, `default_reasoning_effort?`, `budget?` (every field optional, unlike the
request's `budgetSchema` — see §4.4), `...capabilitySettingsFields` (built-in blocks: `hooks`,
`guard`, `sandbox`, `agents` — owned by their respective packages;
`packages/loop/src/runtime/capabilities/settings-specs.ts` spreads
`HOOKS_SETTINGS_FIELDS`/`AGENT_TOOLS_SETTINGS_FIELDS`/`AGENTS_SETTINGS_FIELDS`, and
`AGENT_TOOLS_SETTINGS_FIELDS` at `packages/loop/src/runtime/capabilities/tools-settings.ts`
is what contributes both `guard` and `sandbox`), `marketplaces?`, `enabledPlugins?`.

An Extension Profile is deliberately **not** part of `SettingsFile`: definitions and selections
have their own strict JSON contracts and paths, owned by
[Extension Profiles](../hosts/extension-profiles.md). The loop continues to validate and merge
`enabledPlugins` because `builtin:default` uses it as its exact activation list; a
custom Extension Profile is a complete allow-list resolved by the kernel and never overlays or copies
`settings.json`. Consequently an `extensionProfiles`/`extensionProfile` key in settings remains an unknown
top-level key and is rejected by this strict schema.

`pluginNameField` (`packages/loop/src/settings/settings-schema.ts`) accepts lowercase names bounded
by alphanumeric characters with `.`, `_`, or `-` separators, rejects repeated `--`/`..`, path
separators, edge punctuation, and `RESERVED_PLUGIN_NAMES =
{"__proto__","constructor","prototype"}`. The last three would corrupt the trust map instead of
storing an approval.

`mcpServerBase` (`packages/loop/src/settings/settings-schema.ts`) is itself built with
`.strip()`, not `.strict()`. `mcpServerSettingsSchema` re-adds `.strict()` for `settings.json`
but `mcpServerPluginSchema` inherits the base's `.strip()` — a **third** tolerance
mode for an unrecognized key, distinct from both `agentFrontmatterSchema`'s "carried through" (§3.3)
and `settingsSchema`'s "rejected": a plugin-manifest MCP entry silently **drops** a key this host
gives no meaning to, rather than carrying or rejecting it. The schema's own doc comment
 states the reason: an operator's own `settings.json` typo is best rejected outright, but
a plugin manifest written for another agent host arrives with configuration keys this host does not
have, and failing the whole entry over one of them "did not withhold a server; it failed the
manifest, and with it the plugin's agents, hooks and skills" — measured, per the same comment, at 24
of 196 catalog plugins and 82 skills broken by the stricter rule.

`mcpServerSettingsSchema` spells the transport field `type` (not `transport`), infers `http` when a
URL is present without a type, normalizes `http_headers`, and accepts snake_case or camelCase OAuth
keys. The bridge `settingsServerToEngine` (`packages/loop/src/settings/engine-server.ts`) renames
`type`, converts timeout seconds to engine milliseconds, and carries every remaining declared field
without reinterpretation; its compile-time drift lock fails if a schema key is not mapped. When
`cwd` is absent, the client factory applies its workspace-rooted default.

### 3.3 Agent frontmatter document

`splitAgentFrontmatter` (`packages/loop/src/settings/agent-frontmatter.ts`) splits a markdown file
into `{ data, body }` on the first `---`-fenced block. `"strict"` mode (the default) throws on an
unterminated fence or malformed YAML; `"lenient"` mode falls back to `{ data: {}, body: raw }`
(fence-absent or fence-malformed) or `{ data: {}, body: fence.body }` (bad YAML). A leading BOM is
stripped before fence detection (proven at
`packages/loop/tests/unit/agent-frontmatter.test.ts`).

`agentFrontmatterSchema` (`packages/loop/src/settings/agent-frontmatter.ts`) is
`agentProfileSchema` with `name`/`model`/`tools` re-specified (`model` and `tools` become optional;
`tools` accepts a YAML list *or* a comma-separated string) and `base_prompt`/`budget`/`output_schema`
added, then made `.loose()` — unknown keys are **carried through**, not stripped or rejected
(`packages/loop/src/settings/agent-frontmatter.ts`).

The frontmatter's own `budget` field (`packages/loop/src/settings/agent-frontmatter.ts`)
reuses the strict, request-side `budgetSchema` verbatim — `on_exceed` is still required — rather
than the lenient `settingsBudgetSchema` (`on_exceed` optional,
`packages/loop/src/settings/settings-schema.ts`) that §4.4 documents for the top-level
`settings.budget` default. The same "a default is not a complete instruction" reasoning §4.4 gives
for the top-level field is not extended to this one: an agent file's own `budget:` frontmatter must
be complete wherever it names one at all.

### 3.4 Error codes

`ValidationError` (`packages/capability/src/errors.ts`) carries an `ErrorCode`
(`packages/capability/src/run.ts` — open union, `BuiltinErrorCode | (string & {})`). The 42
built-in codes are enumerated at `packages/capability/src/run.ts`; the ones this subsystem
throws directly: `duplicate_server_name`, `duplicate_profile_name`, `unknown_profile`,
`invalid_token_limit`, `invalid_iteration_limit`, `invalid_budget_mode`, `invalid_server_config`,
`invalid_timeout`, `invalid_max_escalations`, `invalid_provider_config`, `duplicate_provider_name`,
`invalid_profile`, plus whatever `resolveProvider` returns (e.g.
`unknown_provider`) and whatever `classifyIssue` derives from a raw Zod issue (§4.2).

### 3.5 Ceiling table

`INPUT_LIMITS` (`packages/loop/src/validation/input-limits.ts`) is the one table both the
request schema and the settings schema read from, so a structural ceiling cannot drift between the
two documents: `profileNameChars: 128`, `profileDescriptionChars: 4096`, `profileBasePromptChars:
256*1024`, `profileAggregateChars: 8*1024*1024`, `profileTools: 512`, `profileGrants: 64`,
`profileSpawnTargets: 64`, `profileCompactionPromptChars: 64*1024`, `toolNameChars: 256`, `mcpArgs:
256`, `mcpMapEntries: 256`, `mcpNameChars: 128`, `mcpCommandChars: 8192`, `mcpArgChars: 8192`,
`mcpValueChars: 16384`, `pathChars: 4096`, `commandPatterns: 256`, `commandPatternChars: 2048`,
`sandboxListEntries: 256`, `marketplaces: 64`, `enabledPlugins: 256`, `providers: 1000`.

## 4. Behavior

### 4.1 `validateBody`'s fixed pipeline

`validateBody` (`packages/loop/src/validation/request-schema.ts`) runs, in this exact order:

1. `parseRunRequest(raw, registry)` — structural Zod parse against the registry-extended schema.
2. `rejectDuplicateServerNames(data)`
3. `rejectDuplicateProfileNames(data)`
4. `requireKnownGrants(data, registry)`
5. `requireEntryShape(data)` → derives `shape` (topology only, `capabilityNeedsHuman` defaults to
   `false` here — see §4.6 for the second, real derivation)
6. `requireKnownSpawnTargets(data, shape)`
7. `enforceBudgetMode(data, shape)`
8. `enforceEnvCeilings(data, env)`
9. `rejectProviderConfigIssues(data)`
10. `requireResolvableModelProviders(data)`
11. `enforcePerProfileRules(data, env)`

The doc comment on `parseRunRequest` calls this "the stable, observable failure order"
(`packages/loop/src/validation/request-schema.ts`), and
`packages/loop/tests/component/request-schema-facade.test.ts` pins one instance of it
directly: a body with both a duplicate server name *and* a duplicate profile name throws
`duplicate_server_name` (server dedup runs first), never `duplicate_profile_name`.

A minor documentation artifact worth naming so a reader is not misled: `identity-rules.ts` ends with
the doc comment for `budget-rules.ts`'s `enforceBudgetMode`, `budget-rules.ts` ends with the doc
comment for `provider-rules.ts`'s internal `rejectProviderMapIssues`, and `provider-rules.ts` ends
with the doc comment for `profile-rules.ts`'s `enforcePerProfileRules` — each function's own TSDoc
lives at the bottom of the *previous* file in the pipeline rather than above its own declaration.
Purely cosmetic; nothing here changes behavior.

### 4.2 Structural parse → coded error (`parseRunRequest` / `classifyIssue`)

`parseRunRequest` (`packages/loop/src/validation/request/parsing.ts`) calls
`runRequestSchemaFor(registry).safeParse(raw)`; on failure it takes only the **first** issue
(`pickFirstIssue`, `packages/loop/src/validation/request/parsing.ts`) and maps it to an `ErrorCode`
via `classifyIssue` (`packages/loop/src/validation/request/parsing.ts`), which switches on the
issue's top-level path segment (`execution_id`/`continue_from` → `invalid_execution_id`;
`prompt_cache_key` → `invalid_prompt_cache_key`; `prompt_cache_ttl` → `invalid_prompt_cache_ttl`
(`packages/loop/src/validation/request/parsing.ts`); `messages` → `messages_empty` for an
empty/wrong-type array, else `invalid_message_format`; `profiles` → `invalid_model_format` for a
`.model` path, `invalid_iteration_limit` for `.iteration_limit`, else `invalid_profile`; `entry` →
`unknown_profile`; `elicit_wait_ms` → `invalid_elicit_wait`; `budget` → one of
`invalid_on_exceed`/`invalid_token_limit`/`invalid_timeout`/`invalid_max_escalations`/
`invalid_budget_mode` by sub-path; `servers` → `invalid_server_config`; `providers` →
`invalid_provider_config`; anything else → `invalid_message_format`, the catch-all).
`packages/loop/tests/unit/request-parsing.test.ts` pins this table entry-by-entry against 19
distinct malformed inputs.

`runRequestSchemaFor(registry)` (`packages/loop/src/validation/request/parsing.ts`) extends
`runRequestSchema` with every registered spec's `requestParams`, throwing a **plain** `Error`
(deliberately not a `ValidationError` — this is a host-registration bug, not a caller's bad request)
when a spec's param key collides with a field the engine already owns
(`packages/loop/src/validation/request/parsing.ts`, pinned at
`packages/loop/tests/unit/request-parsing.test.ts`).

### 4.3 Identity/topology rules (`identity-rules.ts`)

| Function | Rule | Code |
| --- | --- | --- |
| `rejectDuplicateServerNames` | first repeated `servers[].name` | `duplicate_server_name` |
| `rejectDuplicateProfileNames` | first repeated `profiles[].name` | `duplicate_profile_name` |
| `requireEntryShape` | `entry` must name a real profile | `unknown_profile` |
| `requireKnownSpawnTargets` | every `can_spawn` name must resolve; `default_spawn` must be inside `can_spawn` | `unknown_profile` |

(`packages/loop/src/validation/request/identity-rules.ts`)

`requireKnownSpawnTargets` is purely structural admission — whether the named profiles exist at
all — and is a different mechanism from whether an agent's grants actually unlock spawning at
runtime (`canSpawnChildren`/`shape.isLead`), which is [grants-and-tool-exposure](../cross-cutting/grants.md)'s own scope
(`specs/cross-cutting/grants.md` §4.3); the two must not be conflated.

### 4.4 Budget rules (`budget-rules.ts`)

`enforceBudgetMode` (`packages/loop/src/validation/request/budget-rules.ts`):

| `on_exceed` | Required | Forbidden |
| --- | --- | --- |
| `"stop"` | `budget.total_token_limit`; an `iteration_limit` on **every running agent** (the entry, plus every profile named in the entry's `can_spawn` when `isLead`) | `budget.max_escalations` |
| `"escalate"` | at least one of `budget.total_token_limit` or the entry's own `iteration_limit` | — |

`enforceEnvCeilings` (`packages/loop/src/validation/request/budget-rules.ts`) rejects, against
`EnvConfig`'s `CLARVIS_*_CEILING` values: `servers.length > CLARVIS_MCP_MAX_SERVERS_PER_RUN`
(`invalid_server_config`); `budget.total_token_limit > CLARVIS_TOKEN_CEILING`
(`invalid_token_limit`); any profile's `iteration_limit > CLARVIS_ITERATION_CEILING`
(`invalid_iteration_limit`); `budget.timeout_ms > CLARVIS_TIMEOUT_CEILING_MS` (`invalid_timeout`);
`budget.max_escalations > CLARVIS_ESCALATION_CEILING` (`invalid_max_escalations`).

`settingsBudgetSchema` (`packages/loop/src/settings/settings-schema.ts`) is `budgetSchema` with
`on_exceed` made optional — a settings default is not a complete instruction, so
`{ total_token_limit: 200000 }` alone is legal there (proven at
`packages/loop/tests/unit/settings-schema.test.ts`) while the same body would fail
`budgetSchema` at the request boundary.

### 4.5 Provider rules (`provider-rules.ts`)

`rejectProviderConfigIssues` (`packages/loop/src/validation/request/provider-rules.ts`):
returns immediately when `providers` is empty; else, for each entry: rejects a repeated `name`
(`duplicate_provider_name`); rejects a `base_url` that is not a well-formed `http(s)` URL
(`isWellFormedHttpUrl`, `packages/loop/src/http-url.ts`); requires `base_url` when
`kind === "openai-compatible"`; and calls `rejectProviderMapIssues` on the provider's own
`headers`/`body` and on every `models[modelId]`'s `headers`/`body`.

The subscription kinds, `openai-codex` and `xai-grok`, are deliberately token-free at this request
boundary. Semantic validation rejects `base_url`, `api_key_env`, provider-level `headers`/`body`,
and model-level `headers`/`body` even though the shared structural schema accepts those fields; their
credentials, endpoints and request maps are kernel-owned. The first incompatible field is reported
as `invalid_provider_config` with `reason: "subscription_field_forbidden"`
(`packages/loop/src/validation/request/provider-rules.ts`). Tests first prove structural
acceptance and then semantic rejection for both kinds at
`packages/loop/tests/unit/request-provider-validation.test.ts`.

`rejectProviderMapIssues` (`packages/loop/src/validation/request/provider-rules.ts`) applies
three rules, all coded `invalid_provider_config`: (a) every header value must have every `${...}`
substring match `envRefPattern()` (a malformed `${` anywhere fails); (b) a `body` is rejected outright
on any provider `kind !== "openai-compatible"` **when that provider is `used`**; (c) a `body` may
never set a key in `FORBIDDEN_PROVIDER_BODY_KEYS` (from `@clarvis/capability`) — `messages`/`tools`
are the cached prefix, `model`/`stream`/`tool_choice`/`stream_options` are resolved per call.

`referencedProviders` (`packages/loop/src/validation/request/provider-rules.ts`) — the `used`
set for rule (b) — is every profile's `model` provider token **plus** `data.guard_judge?.model`'s
provider, because the guard judge resolves through the same provider registry without appearing in
`profiles`. Proven at `packages/loop/tests/unit/request-provider-validation.test.ts`: an
unused provider may carry an unsupported `body` freely, but the same provider becomes rejected the
moment a `guard_judge` names it.

`requireResolvableModelProviders` (`packages/loop/src/validation/request/provider-rules.ts`)
resolves every profile's `model` and, when present, `vision_model`, via `resolveProvider`
(`@clarvis/capability`), throwing that resolver's own `code`/`message` (typically
`unknown_provider`) on the first miss.

### 4.6 Per-profile semantic rules (`profile-rules.ts`) and `RunShape`

`enforcePerProfileRules` (`packages/loop/src/validation/request/profile-rules.ts`) first sums a
retained-character total across every profile (`name` + `description` + `base_prompt` +
`compaction.prompt` + every `tools[]`/`grants[]`/`can_spawn[]` entry's length) and rejects the whole
request with `invalid_profile` once it exceeds `INPUT_LIMITS.profileAggregateChars` (8 MiB) — an
aggregate limit distinct from any single field's own cap, pinned at
`packages/loop/tests/unit/request-profile-validation.test.ts` with 33 profiles each carrying
a 256 KiB `base_prompt`. Then, per profile: `orchestration` is rejected unless `can_spawn` is
non-empty ("lead-only"); `reasoning_summary` (when not `"off"`) is rejected unless the model's
provider `kind === "openai"`; `call_timeout_ms`, `retry.max_retries` and
`retry.max_retry_after_ms` are each checked against their own `CLARVIS_*_CEILING`.

`deriveRunShape` (`packages/loop/src/validation/request/run-shape.ts`) computes: `entry` (the
resolved profile), `isLead` (`can_spawn` non-empty), `softMode` (`budget.on_exceed === "escalate"`),
`askUserGranted` (`"ask_user"` in the entry's `grants`), `userInputEnabled` (`askUserGranted ||
capabilityNeedsHuman || softMode`), `humanParkLikely` (`(askUserGranted || capabilityNeedsHuman) &&
elicit_wait_ms !== 0`). It is called **twice** for one run: once inside `validateBody` via
`requireEntryShape` with `capabilityNeedsHuman` defaulted to `false`
(`packages/loop/src/validation/request/identity-rules.ts`) — purely to get a topology-valid
`RunShape` for the remaining structural rules — and again by `executeRun` with the real,
capability-derived `capabilityNeedsHuman` value once every registered capability has been asked
`requiresUserInput?.(requestView)` (`packages/loop/src/runtime/execute-run.ts`). Only the
second `shape` is the one the rest of the run uses.

### 4.7 Grant admission (`grant-registry.ts`)

`requireKnownGrants` (`packages/loop/src/validation/request/grant-registry.ts`) builds the
known set as `BUILTIN_GRANT_NAMES ∪ registry.grants().map(g => g.name)` and rejects any profile grant
outside it with `invalid_profile`. `BUILTIN_GRANT_NAMES` is exactly `["ask_user", "read_workspace",
"edit_workspace", "run_commands"]` (`packages/loop/src/validation/request/grant-registry.ts`).
Grant *semantics* (what each name actually authorizes) belong to [grants-and-tool-exposure](../cross-cutting/grants.md); this
subsystem only decides admission.

### 4.8 Profile readiness (advisory mirror)

`PROFILE_READINESS_RULES` (`packages/loop/src/validation/profile-readiness.ts`) is a data
table of 8 rules, each declaring which `validateBody` rule it `mirrors` and a `check` over a loose
`ReadinessProfile` (all fields optional, so a partial/in-progress config can be inspected without
throwing): `missing_model`, `invalid_model`, `unknown_provider`, `budget_needs_limit`,
`unknown_spawn_target`, `default_spawn_not_in_can_spawn`, `unknown_grant` (skipped entirely when the
caller supplies no `knownGrants`, so a UI blind to the capability registry never falsely flags a
capability-owned grant), `orchestration_needs_can_spawn`. `profileReadinessIssues` flat-maps every
rule's `check` over one `ReadinessContext` — it never throws, only returns issues, and reports **all**
of them, not just the first (unlike `validateBody`; proven for `unknown_spawn_target` at
`packages/loop/tests/unit/profile-readiness.test.ts`, two ghost targets → two issues).

`ReadinessCode` (`packages/loop/src/validation/profile-readiness.ts`) has a **9th** member,
`"malformed_frontmatter"`, that no rule in `PROFILE_READINESS_RULES` ever produces — the 8 rules
above are the type's only producers inside this module. The code exists for a caller outside this
package to synthesize: `@clarvis/code`'s own adapter returns it directly when a file's frontmatter
failed to parse at all, before `profileReadinessIssues` is ever called on it
(`packages/code/src/adapters/agent-files.ts`), reusing this module's `ReadinessCode` type for a
verdict this module itself never reaches.

### 4.9 Settings composition: `settingsSchemaFor`, `mergeSettings`

`settingsSchemaFor(registry)` (`packages/loop/src/settings/capability-settings.ts`): returns
the bare `settingsSchema` when the registry is empty; otherwise, for every registered spec, throws a
plain `Error` if `spec.key` already names a built-in block (`packages/loop/src/settings/capability-settings.ts`)
or if the spec declares any plugin-manifest surface (`pluginContributable`, `pluginDescription`,
`pluginForbiddenReason` — `packages/loop/src/settings/capability-settings.ts`, because the
manifest schema is composed statically from the engine's own built-in specs alone and would silently
ignore a registered spec's claim); else extends `settingsSchema` with `{ [spec.key]:
spec.schema.optional() }` and re-`.strict()`s.

`mergeSettings(scopes, registry?)` (`packages/loop/src/settings/settings-merge.ts`) folds an
ascending-precedence list of `SettingsScope`s (`{ origin, settings }`) key by key through a
`STRATEGIES` table built once at module load: `CORE_STRATEGIES` for `providers` (union by name, later
wins — `mergeProviders`), `mcpServers` (shallow record merge, later wins per key —
`mergeRecord`), `default_model`/`default_vision_model`/`default_reasoning_effort`/`budget`
(last-wins), `enabledPlugins` (exact-reference concatenation with duplicate identities removed) and
`marketplaces` (distinct-string concatenation — first-seen order, later scopes can only add); plus
one `specStrategy` per entry of `BUILTIN_SETTINGS_SPECS`
(`packages/loop/src/settings/settings-merge.ts`); plus, inside `mergeSettings` itself, one
more `specStrategy` per **registry**-supplied spec not already in `STRATEGIES`
(`packages/loop/src/settings/settings-merge.ts`) — so a capability registered only at runtime
(not among the engine's built-ins) still merges correctly. `specStrategy` collects every
scope defining the key as a `SettingsValueScope`, then either takes the last one (`spec.merge ===
"lastWins"`) or calls the spec's own custom fold function.

The concatenated `enabledPlugins` result feeds only `builtin:default`. Each entry is the strict
object `{ scope: "global"|"workspace", source: "agents"|"clarvis", name }`; strings and partially
qualified references are rejected. Extension Profile resolution happens after the operator settings
layers are read and before plugin settings fragments are folded; no Extension Profile data is introduced
into this schema or merge table.

A **module-load guard** (`packages/loop/src/settings/settings-merge.ts`) throws immediately
if any key of `settingsSchema.shape` lacks an entry in `STRATEGIES` — so a new top-level settings key
cannot ship without a merge strategy being written for it in the same change.

### 4.10 Agent frontmatter parsing

`splitAgentFrontmatter(raw, mode)` (`packages/loop/src/settings/agent-frontmatter.ts`): strips
nothing itself (delegates fence-splitting to `@clarvis/capability`'s `splitFrontmatterFence`), then
YAML-parses the frontmatter text. `"strict"` mode is the default; `"lenient"` is what every
production *read/list* path uses so a malformed file still lists (degrading only its frontmatter to
`{}`, never dropping the agent) — `@clarvis/kernel`'s `parseAgentFile`
(`packages/kernel/src/config/file-config-store.ts`) and its plugin-manifest counterpart
(`packages/kernel/src/plugins/plugin-contributions.ts`) both call it with `"lenient"`. The
**only** production call in `"strict"` mode anywhere in the monorepo is the same `parseAgentFile`,
immediately after its lenient parse, wrapped in a `try`/`catch` whose sole purpose is to populate
`AgentRecord.malformed` as a diagnostic string for listing (`packages/kernel/src/config/file-config-store.ts`)
— the throw is caught and never propagated to reject a write, block a save, or reach an author as an
error. `agentPromptOf(basePrompt, body)`
(`packages/loop/src/settings/agent-frontmatter.ts`) prefers a non-blank trimmed `body` and
falls back to `basePrompt` only when the body is empty/whitespace-only.

### 4.11 Ajv construction and its two consumers

`build(opts)` in `packages/loop/src/validation/ajv.ts` is the one place that actually instantiates
an Ajv instance and registers `ajv-formats`; both public factories call it. `load()` normally
resolves those CommonJS modules only on first use. The isolated worker's standalone composition
instead calls `installBundledAjvModules` from `tooling/runtime/guest-entry.ts` before starting the
worker, so Bun can close the modules into one executable without changing the native host's lazy
path. `createAjv()` (`{ strict: false, allErrors: true }`) and `createStrictAjv()` (the same plus
`strictSchema: true`) differ by exactly that one option, but serve two different
purposes at two unrelated call sites: `createAjv` is the **only** call in
`packages/loop/src/runtime/tools/tool-arg-validator.ts`, validating a tool call's arguments against that tool's
own declared schema (fail-open by design, per that module's own doc comment); `createStrictAjv` is
the **only** call in `packages/loop/src/runtime/tools/result-contract.ts`, vetting a caller-supplied
`output_schema`'s own well-formedness before a run starts. Both call sites are outside this document's
`src/validation/**`/`src/settings/**` scope, but are the sole production consumers of the two
factories.

## 5. Invariants

**INV-046.** A text-only wire request carrying a multi-turn `messages` continuity seed (no tool
turns) still validates against `runRequestSchema`, and running it to completion never requires the
caller to have sent a `tool`-role message.
Production: `packages/loop/src/validation/request/message-schemas.ts` (role enum has no
`"tool"` member). Test: `packages/loop/tests/contract/native-tool-wire-stable.contract.test.ts`.

**INV-047.** The wire role enum still excludes `tool` — a caller-sent message with `role: "tool"` is
rejected by `validateBody`.
Production: `packages/loop/src/validation/request/message-schemas.ts`
(`z.enum(["system","user","assistant"])`). Test:
`packages/loop/tests/contract/native-tool-wire-stable.contract.test.ts`.

**INV-048.** `RunRequest` (the hand-authored type from `@clarvis/capability`) and `ParsedRunRequest`
(the zod-inferred type from `runRequestSchema`) stay mutually assignable — a compile-time parity
check.
Production: the `SchemaMatches`/`_runRequestDriftLock` machinery at
`packages/loop/src/validation/request/request-schema.ts`. Test:
`packages/loop/tests/contract/schema-type-parity.contract.test.ts`.

The same file defines **three siblings** of `_runRequestDriftLock`, one per remaining hand-authored
DTO from `@clarvis/capability`, each its own `SchemaMatches<..., ...> = true` constant
(`packages/loop/src/validation/request/request-schema.ts`): `_agentProfileDriftLock`
(`z.infer<typeof agentProfileSchema>` against `AgentProfile`), `_serverConfigDriftLock`
(`z.infer<typeof serverSchema>` against `McpServerConfig`), and `_providerConfigDriftLock`
(`z.infer<typeof providerConfigSchema>` against `ProviderConfig`). Unlike `_runRequestDriftLock`,
none of the three has a dedicated test asserting its value — each is a compile-time-only guard whose
failure mode is the **build itself** refusing to typecheck, not an assertion.

**INV-064.** A request's server names, profile names, and `entry`/`can_spawn`/`default_spawn`
topology must each be unique/resolvable: duplicate server or profile names are rejected with
`duplicate_server_name`/`duplicate_profile_name`; an unresolvable `entry` is rejected with
`unknown_profile`; and so is a profile whose `can_spawn` names an unknown profile, or whose
`default_spawn` falls outside its own `can_spawn`.
Production: `packages/loop/src/validation/request/identity-rules.ts`. Test:
`packages/loop/tests/unit/request-identity-rules.test.ts`.

**INV-073.** `src/validation/ajv.ts` calls `require("ajv")`/`require("ajv-formats")` only from inside
the `load()` function, deferred past module evaluation, never at the top level — so an ordinary host
that merely reaches this module (e.g. the terminal UI, through delegation, on its boot path) does
not pay the cost unless a validator is actually built. The only eager alternative is explicit
composition: the standalone guest entry statically imports both modules, installs them with
`installBundledAjvModules`, and only then calls `startGuestMain`.
Production: `load` and `installBundledAjvModules` in
`packages/loop/src/validation/ajv.ts`; `tooling/runtime/guest-entry.ts`. Test:
`packages/loop/tests/architecture/eager-validator-boundary.test.ts` (walks the TypeScript AST and
asserts every fallback `require(...)` call is nested inside a function) and
`tooling/tests/architecture/runtime-containerfiles.test.ts` (pins the standalone composition).

**INV-RS-01.** The built-in request schema and the hand-authored `RunRequest` type both carry the
same optional prompt-expansion context, while the kernel adds it only for a successfully resolved,
user-invoked skill command.
Production: `packages/loop/src/runtime/capabilities/hooks.ts`,
`packages/capability/src/api.ts`, `packages/kernel/src/runs/settings-assembler.ts`.
Test: `packages/kernel/tests/component/settings-assembler.test.ts`.

### Further invariants derived directly from the code (not in the numbered catalog above)

**A.** `enforceBudgetMode`'s `"stop"` branch requires an `iteration_limit` on **every currently
running agent**, not only the entry: when `isLead`, that set is `[entry, ...spawnable]` where
`spawnable` is every profile named in the entry's own `can_spawn` — a spawnable worker missing
`iteration_limit` fails the *entry's* request even though the worker itself is never named `entry`.
Production: `packages/loop/src/validation/request/budget-rules.ts`. Test:
`packages/loop/tests/unit/request-budget-rules.test.ts`.

**B.** A provider's `body` is rejected as `invalid_provider_config` only when that provider is
**used** by this run (a profile's `model` or `guard_judge.model` resolves to it) — an unused entry in
the whole-workspace `providers[]` registry may carry an unsupported `body` freely.
Production: `packages/loop/src/validation/request/provider-rules.ts`. Test:
`packages/loop/tests/unit/request-provider-validation.test.ts`.

**C.** `agentFrontmatterSchema` is `.loose()`: an unrecognized top-level key is carried through
verbatim, not stripped or rejected, while every key the schema *does* name is still validated exactly
as strictly as `agentProfileSchema` (a nested `retry`/`compaction` block remains `.strict()` — an
unknown key nested *inside* one of those still fails).
Production: `packages/loop/src/settings/agent-frontmatter.ts`. Test:
`packages/loop/tests/unit/agent-frontmatter.test.ts`.

**D.** `settingsSchemaFor` and `readCapabilitySettings` refuse, at registration time, three distinct
misuses that would otherwise fail *silently*: a registered spec's `key` shadowing a built-in block
(would let `.extend()` — last-wins — silently replace the engine's own validation for that block);
and a registered spec declaring any of `pluginContributable`/`pluginDescription`/
`pluginForbiddenReason` (would be accepted and then read by nobody, since the plugin manifest schema
is composed only from the engine's built-in specs).
Production: `packages/loop/src/settings/capability-settings.ts`. Test:
`packages/loop/tests/unit/capability-settings.test.ts` (exhaustively, over every
key of `settingsSchema.shape`).

**E.** A settings-merge module-load guard throws if any key in `settingsSchema.shape` lacks a
`STRATEGIES` entry, so a new top-level settings field cannot ship without an explicit merge
strategy.
Production: `packages/loop/src/settings/settings-merge.ts`. Test:
`packages/loop/tests/unit/settings-merge.test.ts` (asserts
`SETTINGS_MERGE_STRATEGY_KEYS` equals `Object.keys(settingsSchema.shape)`, sorted).

**F.** `enabledPlugins` and `marketplaces` are additive across settings scopes. Marketplaces
de-duplicate by URL; plugin entries de-duplicate by the complete `{ scope, source, name }` identity.
A later scope cannot remove an earlier entry, and first-seen position is preserved.
Production: `concatDistinct` and `concatDistinctPluginRefs` in
`packages/loop/src/settings/settings-merge.ts`. Test:
`packages/loop/tests/unit/settings-merge.test.ts`.

This is the builtin activation behavior, not custom Extension Profile semantics. The kernel resolves every
reference exactly; two selected installations with the same runtime name invalidate the Extension Profile
instead of applying source/scope precedence. Custom Extension Profile allow-lists never use this merge
result. Production:
`packages/kernel/src/extension-profiles/extension-profile-manager.ts` (`resolved`) and
`packages/kernel/src/config/file-config-store.ts` (`snapshot`). Test:
`packages/kernel/tests/integration/extension-profile-manager.test.ts`.

**G.** A plugin-origin `hooks` scope is always merged **after** every operator scope regardless of
its position in the `scopes` argument order — proven at the settings-merge level even though the
concrete fold (concatenation with plugin appended last) is owned by the hooks capability's own
`merge` function, not by this module.
Test: `packages/loop/tests/unit/settings-merge.test.ts`.

**H.** `settingsServerToEngine` carries a fourth, sibling drift lock of the same family as INV-048's:
`_engineServerDriftLock` only type-checks while `MapperCoversSettings` holds — every key of
`McpServerSettings` is one of the mapper's own `MappedSettingsKey` union (transport, process,
credential, OAuth, timeout, enablement, tool-filter, and authentication-policy fields). Its own doc
comment states what it
would silently miss without this: "a key added to the settings schema and forgotten here would
otherwise be dropped in silence on the way to the engine — which is exactly how the
`type`/`transport` mismatch survived from the initial commit."
Production: `packages/loop/src/settings/engine-server.ts`.

**I.** `compactionSchema`'s `superRefine` enforces two cross-field rules no single field's own type
expresses: `compaction.target_fraction` must be `<= compaction.context_fraction`, and
`compaction.prompt` cannot be combined with `compaction.prompt_mode: "none"`.
Production: `packages/loop/src/validation/request/profile-schemas.ts`. Test:
`packages/loop/tests/unit/request-profile-validation.test.ts`.

**J.** A provider model entry accepts `reasoning_efforts` only as an array of non-empty strings and
retains it through both run-request and settings validation, while the hand-authored `ModelConfig`
type carries the same optional field.
Production: `packages/capability/src/api.ts`;
`packages/loop/src/validation/request/provider-schemas.ts`. Test:
`packages/loop/tests/unit/request-provider-validation.test.ts` (complete provider surface);
`packages/loop/tests/unit/settings-schema.test.ts` (provider models map).

**K.** A model reference accepts `:` inside the provider-native model-id half while the provider
token remains restricted to `^[a-z0-9_-]+$`; parsing still splits only at the first `/`.
Production: `modelField` in `packages/loop/src/validation/request/profile-schemas.ts` and
`parseModelRef` in `packages/capability/src/model-ref.ts`. Test:
`packages/loop/tests/unit/request-profile-validation.test.ts` and
`packages/loop/tests/unit/settings-schema.test.ts` (tagged model ids).

## 6. Failure modes and degradation

| Situation | Handling | Cite |
| --- | --- | --- |
| Malformed structural field in a run request | `ValidationError` with a code from `classifyIssue`, carrying the **first** Zod issue's message/path only | `packages/loop/src/validation/request/parsing.ts` |
| A registered capability's request param collides with an engine field | Plain `Error` (not `ValidationError`) at schema-build time — a host bug, refused before any request is even parsed | `packages/loop/src/validation/request/parsing.ts` |
| A registered capability's settings block collides with a built-in block, or claims an unreadable plugin surface | Plain `Error` at `settingsSchemaFor` call time | `packages/loop/src/settings/capability-settings.ts` |
| An agent markdown file's frontmatter fence is malformed / YAML fails to parse, in `"lenient"` mode | Degrades to `{}` frontmatter, keeps the file's body — the agent still lists and runs | `packages/loop/src/settings/agent-frontmatter.ts` |
| Same failure, in `"strict"` mode | Throws — but the only production caller in `"strict"` mode (`@clarvis/kernel`'s `parseAgentFile`) immediately catches it itself and stores the message on `AgentRecord.malformed` for listing; the throw never reaches an author or blocks a save | `packages/loop/src/settings/agent-frontmatter.ts`; caught at `packages/kernel/src/config/file-config-store.ts` |
| Ajv fails to load (`require("ajv")` throws) | Not handled specially — propagates as a raw exception from `load()`; no fallback validator | `packages/loop/src/validation/ajv.ts` |
| Profile readiness check given no `knownGrants` | Silently skips the `unknown_grant` rule entirely (returns no issues for grants) rather than guessing | `packages/loop/src/validation/profile-readiness.ts` |
| A subscription provider carries an operator-owned endpoint, credential, header or body field | `ValidationError("invalid_provider_config")` with `reason: "subscription_field_forbidden"` and the first incompatible field in `details.field` | `packages/loop/src/validation/request/provider-rules.ts` |
| `mergeSettings` producing a record/list past its `INPUT_LIMITS` bound | Plain `Error` thrown mid-merge (`mergeProviders`, `mergeRecord`, `concatDistinct`) | `packages/loop/src/settings/settings-merge.ts` |
| A registered capability's settings block is present in `settings.json` but fails its own `spec.schema` | Raw `z.ZodError` — a third failure shape, neither this subsystem's own `ValidationError` family nor a plain `Error` at schema-composition time, surfaced instead at settings-*read* time | `packages/loop/src/settings/capability-settings.ts` |

Nothing in this subsystem retries or times out — it is pure synchronous validation. Most failures are
either an immediate `ValidationError` (caller-facing, coded) or a plain `Error`
(host-misconfiguration, thrown at schema-composition time rather than per-request) — with one
exception: `readCapabilitySettings` throws a raw `z.ZodError` when a registered block fails its own
schema at settings-read time, a third, uncoded shape the two-way framing above does not cover.

## 7. Coupling

**Depends on** (all runtime, static imports):

- `@clarvis/capability` — `ValidationError`, `ErrorCode`, `RunRequest`/`AgentProfile`/
  `McpServerConfig`/`ProviderConfig` types, `parseModelRef`/`resolveProvider`, `envRefPattern`,
  `FORBIDDEN_PROVIDER_BODY_KEYS`, `EnvConfig`, `CapabilityRegistry`/`CapabilitySettingsSpec`/
  `CapabilityGrantDeclaration`, `splitFrontmatterFence`, `EXECUTION_STATUSES`. This is the vocabulary
  layer every request/settings rule is written against; none of it is optional.
- `packages/loop/src/runtime/capabilities/settings-specs.ts` — `capabilityRequestParamFields` (spread
  into `runRequestSchema`, `packages/loop/src/validation/request/request-schema.ts`) and
  `capabilitySettingsFields`/`BUILTIN_SETTINGS_SPECS` (spread/iterated by `packages/loop/src/settings/settings-schema.ts`
  and `packages/loop/src/settings/settings-merge.ts`). This is a **static, compile-time** coupling: the request and
  settings schemas' own inferred types depend on exactly which built-in capabilities exist, which is
  why the drift-lock types (`_runRequestDriftLock` etc.) are meaningful at all. Per-capability content
  behind these consts is owned by other documents (hooks-execution, grants-and-tool-exposure,
  `@clarvis/supervision`'s `agentsSettingsSpec`).
- `ajv` / `ajv-formats` — lazy fallback resolution for ordinary hosts; statically supplied only by
  the standalone isolated-worker composition root (INV-073).

**Depended on by** (all runtime, via the package's export map — never a raw `src/` path from outside
the package):

- `packages/loop/src/runtime/execute-run.ts` calls `validateBody` directly (same package,
  internal import) — the one place inside the engine this subsystem's whole request pipeline runs.
- `@clarvis/kernel` reaches `mergeSettings`, `settingsSchemaFor`, `agentFrontmatterSchema`,
  `profileReadinessIssues`, `readCapabilitySettings`, `BUILTIN_GRANT_NAMES`, `splitAgentFrontmatter`,
  `settingsSchema`, `providerConfigSchema`/`grantSchema` **exclusively** through
  `@clarvis/loop/host` (`packages/loop/src/host.ts`) — confirmed by grepping every file under
  `packages/kernel/src` for a direct `validation/`- or `settings/`-path import and finding none. This
  is what forces `host.ts` to exist as a distinct, narrow export subpath rather than the package's
  bare root: `packages/kernel/src/config/capability-registry.ts` builds `kernelSettingsSchema =
  settingsSchemaFor(kernelCapabilityRegistry)`, and `packages/kernel/src/config/file-config-store.ts`
  is the only caller of `mergeSettings` across scopes in the whole monorepo outside this package's own
  tests.

**Type-only coupling:** the `SchemaMatches`/drift-lock constants
(`packages/loop/src/validation/request/request-schema.ts`) exist purely so a change to
`@clarvis/capability`'s hand-written `RunRequest`/`AgentProfile`/`McpServerConfig`/`ProviderConfig`
types that is not mirrored in the corresponding Zod schema breaks the **build**, not a test run — this
is a compile-time-only edge with zero runtime cost.

## 8. Open questions

- **Why `capabilityRequestParamFields`/`capabilitySettingsFields` are spread statically from
  `settings-specs.ts` while `settingsSchemaFor`/`runRequestSchemaFor` separately extend from a
  runtime `CapabilityRegistry`** is explained in comments as an inference-precision tradeoff
  (`packages/loop/src/settings/capability-settings.ts`, `packages/loop/src/validation/request/request-schema.ts`),
  and the reason for the split itself is now stated at
  `packages/loop/src/runtime/capabilities/settings-specs.ts`: the static spread *is* the
  reason. A registry is a runtime value, so a schema composed from one is
  `ZodObject<Record<string, unknown>>` — `SettingsFile` and `ParsedRunRequest` stop being precise
  types and every consumer of a settings field falls back to `unknown`, `@clarvis/code` above all.
  The built-ins are exactly the capabilities the engine itself owns and can therefore name at compile
  time; a host-registered capability cannot be named there without the engine depending on it, which
  is the registry's whole purpose. So it is not two mechanisms for one job — it is the type boundary
  between what the engine knows statically and what a host adds.
- **The precise reason `guard_judge`'s provider is folded into `referencedProviders` but not into any
  other per-run accounting** (e.g. it is not a `profiles[]` entry, so it never participates in
  `enforcePerProfileRules`'s aggregate-character sum or in `enforceBudgetMode`'s "running agents" set)
  is stated as intentional in the doc comment (`packages/loop/src/validation/request/provider-rules.ts`)
  but the guard capability's own semantics — what `guard_judge` actually does at runtime — are out of
  this document's scope (owned by the tools/guard capability document) and are unverified beyond the
  one call site this subsystem reads (`profile-rules.ts` is not one of them; only
  `packages/loop/src/validation/request/provider-rules.ts` touches `guard_judge`).
- **`typo-suggestion.ts`'s `editDistance`/`typoBudget` have no call site inside this document's own
  scope** (`settings-schema.ts`, `settings-merge.ts`, `capability-settings.ts`, `engine-server.ts`,
  `agent-frontmatter.ts` — none import from `typo-suggestion.js`). Their two production consumers are
  confirmed by a grep across the whole `packages/loop/src` tree: `plugin-schema.ts`'s
  `suspectedManifestTypos` (which calls `editDistance` against every `unknownManifestKeys` entry, one
  per unrecognized plugin-manifest key) and `marketplace-schema.ts`'s structurally identical
  function. Both are [plugins-and-marketplace](../hosts/plugins.md)'s territory, not this document's, so the
  two functions' own contracts are described (§2.2) without going further into how that package uses them.
- **The exact value and derivation of `envRefPattern()`** (imported from `@clarvis/capability` and
  used at `packages/loop/src/validation/request/provider-rules.ts`) is out of this document's scope
  (owned by `@clarvis/capability`); what is verified is only that `rejectProviderMapIssues` calls it to
  reject any leftover `${` after stripping every well-formed match.
