# models.dev catalog, model refs, pricing, effort and cache mode

> Implemented at `packages/kernel/src/models/model-catalog.ts`,
> `packages/kernel/src/data/models-dev.json`,
> `packages/capability/src/{model-ref,provider-resolver, reasoning-budget}.ts`,
> `packages/kernel/src/runs/settings-assembler.ts`, and the TUI's
> `packages/code/src/adapters/models-catalog.ts` +
> `packages/code/src/views/config/{ModelView, CatalogPicker,EffortView,catalog-pick,pick-model}.{ts,tsx}`.
> Every claim below is anchored to a file and a named symbol or test. Open questions are collected in the final
> section.

## 1. Purpose

This subsystem answers three questions any run assembly or settings edit needs answered: what
models exist and what do they cost (the **catalog**), which configured provider a `provider/model`
string names (**model refs** and **provider resolution**), and how much output headroom a
reasoning-heavy call needs reserved (the **reasoning budget floor**). It also owns the mechanism by
which a model's prompt-cache behavior is *derived once, at configuration time* rather than
recomputed on every run.

The catalog is a local, versioned snapshot of the [models.dev](https://models.dev) public API,
shipped inside the kernel package (`packages/kernel/src/data/models-dev.json`,
`packages/kernel/src/models/model-catalog.ts`) and optionally refreshed to a per-install cache
file. It exists so the TUI can list, price and validate models without an install-time network
dependency, and so every provider (Anthropic, OpenAI, Google, or any `openai-compatible` endpoint)
is looked at through one normalized shape (`packages/kernel/src/models/model-catalog.ts`).
`parseModelRef`/`resolveProvider` (`packages/capability/src/model-ref.ts`,
`packages/capability/src/provider-resolver.ts`) are the run-time counterpart: given a
`"provider/model"` string and the run's configured `providers[]`, they resolve to the concrete
`ResolvedProviderConfig` the LLM adapter dispatches against — headers, body and prompt-cache mode
merged per model over the provider's own. `reasoning-budget.ts` supplies one number,
`reasoningOutputFloor`, used elsewhere (the adapter and the loop's budget clamp) to keep an
Anthropic call with deep reasoning from being starved of output tokens.

## 2. Surface

### 2.1 Kernel catalog module (`packages/kernel/src/models/model-catalog.ts`)

| Export | Kind | File | Signature / role |
| --- | --- | --- | --- |
| `PROVIDER_KINDS` | value | `packages/kernel/src/models/model-catalog.ts` | `["openai-compatible","openai","anthropic","google","openai-codex","xai-grok"]` |
| `ProviderConfig`, `ProviderKind` | type | `packages/kernel/src/models/model-catalog.ts` | re-derived from the loop's `providerConfigSchema` |
| `CatalogData`, `CatalogProviderData`, `CatalogModelData`, `CatalogCost` | type | `packages/kernel/src/models/model-catalog.ts` | validated on-disk / API shapes |
| `CatalogModel`, `CatalogProvider`, `ModelsCatalog` | type/interface | `packages/kernel/src/models/model-catalog.ts` | normalized in-memory shapes |
| `loadCatalogData(configDir?, logger?)` | function | `packages/kernel/src/models/model-catalog.ts` | `{ data: CatalogData; source: "cache" \| "bundle" }` |
| `writeCatalogCache(configDir, data)` | function | `packages/kernel/src/models/model-catalog.ts` | `{ providers, models, path }` |
| `createModelsCatalog(configDir?, logger?)` | function | `packages/kernel/src/models/model-catalog.ts` | builds a `ModelsCatalog` |
| `resolveModelPrice(catalog, providers, modelRef)` | function | `packages/kernel/src/models/model-catalog.ts` | `CatalogCost \| undefined` |
| `cacheModeOf(cost)` | function | `packages/kernel/src/models/model-catalog.ts` | `"explicit" \| "implicit" \| "unknown"` |
| `derivePromptCacheMode(cost, kind)` | function | `packages/kernel/src/models/model-catalog.ts` | `"explicit" \| "implicit" \| undefined` |
| `projectModelsDevApi(raw)` | function | `packages/kernel/src/models/model-catalog.ts` | raw models.dev JSON → `CatalogData` |
| `fetchModelsDevApi()` | function | `packages/kernel/src/models/model-catalog.ts` | `Promise<unknown>` (raw JSON) |
| `refreshModelsCatalog(configDir)` | function | `packages/kernel/src/models/model-catalog.ts` | fetch + project + write cache |
| `createModelCatalogService(configDir, logger?)` | function | `packages/kernel/src/models/model-catalog.ts` | builds the protocol `ModelCatalogService` |

`ModelsCatalog` is an interface, not a bare export; its methods are `provider(id)`,
`models(id)`, `seed(providerId, taken)` and `fill(kind, modelId)` — `seed`'s and `fill`'s contracts
are documented in §4.2 and §4.13.

Re-exported unchanged from `packages/kernel/src/config.ts` (the package's public
configuration surface), and again as `parseModelRef` from `@clarvis/capability`
(`packages/kernel/src/config.ts`).

### 2.2 Protocol wire contract (`packages/protocol/src/models.ts`)

| Symbol | Shape |
| --- | --- |
| `ModelCost` | `{ input, output, cache_read?, cache_write? }` |
| `CatalogModel` | `{ id, name?, context_window?, max_output?, capabilities?, reasoning_efforts?, cost? }` |
| `CatalogProvider` | `{ id, name, kind, base_url?, api_key_env?, needs_base_url, models[] }` |
| `ModelCatalog` | `{ providers[], source: "cache"\|"bundle" }` |
| `ModelCatalogService` | Public Models.dev `get`/`refresh` plus authenticated `getEntitled`/`refreshEntitled` per subscription scheme |

`ModelCatalogService` is one of the fifteen services a `KernelClient` aggregates
(`packages/protocol/src/client.ts`; `packages/kernel/src/kernel.ts`), constructed at kernel
boot as `createModelCatalogService(globalDir, logger)` (`packages/kernel/src/kernel.ts`) and
exposed over the transport under operation key `models`
(`OPERATIONS.models` in `packages/kernel/src/transport/operations.ts`,
`packages/kernel/src/transport/client.ts`).

### 2.3 `@clarvis/capability` exports

| Export | File | Signature |
| --- | --- | --- |
| `parseModelRef(model)` | `packages/capability/src/model-ref.ts` | `(model: string) => { provider: string; modelId: string }` |
| `ModelRef` | `packages/capability/src/model-ref.ts` | `{ provider: string; modelId: string }` |
| `resolveProvider(token, registry, modelId?)` | `packages/capability/src/provider-resolver.ts` | `ProviderResolution` |
| `ProviderResolution` | `packages/capability/src/provider-resolver.ts` | `{ok:true,config}` \| `{ok:false,code:"unknown_provider",message}` |
| `FORBIDDEN_PROVIDER_BODY_KEYS` | `packages/capability/src/provider-resolver.ts` | `["messages","tools","model","stream","tool_choice"]` |
| `reasoningOutputFloor(kind, effort)` | `packages/capability/src/reasoning-budget.ts` | `number \| undefined` |

### 2.4 Kernel run assembly (`packages/kernel/src/runs/settings-assembler.ts`)

| Settings key | Type | Effect |
| --- | --- | --- |
| `default_model` | `string` | entry agent's model unless frontmatter overrides is the loser; see §4 |
| `default_vision_model` | `string` | copied verbatim into the request's `vision_model` field |
| `default_reasoning_effort` | `string` | entry/child effort resolution, same entry/child priority *shape* as model but only 2-tier (no `options.defaultModel`-equivalent at this layer) |

`SettingsAssemblerOptions.defaultModel` is the last-resort fallback, below both
`default_model` and agent frontmatter.

### 2.5 TUI surface

| Symbol | File | Role |
| --- | --- | --- |
| `createModelsCatalog(catalog: ModelCatalog)` | `packages/code/src/adapters/models-catalog.ts` | Wire DTO → UI `ModelsCatalog` |
| `resolveCatalogModel(catalog, providers, modelRef)` | `packages/code/src/adapters/models-catalog.ts` | model lookup with an extra `base_url`-match tier the kernel's own `resolveModelPrice` lacks |
| `resolveModelPrice(catalog, providers, modelRef)` | `packages/code/src/adapters/models-catalog.ts` | `resolveCatalogModel(...)?.cost` |
| `ModelView(host, deps)` | `packages/code/src/views/config/ModelView.tsx` | the `/model` screen — picks `default_model` |
| `EffortView(host, deps)` | `packages/code/src/views/config/EffortView.tsx` | the `/effort` screen — picks `default_reasoning_effort` |
| `CatalogPicker(props)` | `packages/code/src/views/config/CatalogPicker.tsx` (`CatalogPicker`) | generic filterable list picker over a `CatalogRow[]`, with optional responsive first-run branding |
| `catalog-pick.ts` | — | row builders: `providerRows`, `recommendedProviderRows`, `modelRows`, `configuredModelRows`, `configuredModelCapabilities`, `knownToLackReasoning`, `filterRows`, `catalogReady` |
| `effort-levels.ts` | — | `EFFORT_LEVELS`, `normalizeReasoningEfforts`, `supportedReasoningEfforts`, `recommendedReasoningEffort` |
| `pick-model.ts` | — | `modelPickerSpec(...)` — glue reused by `DefaultsPanel` (vision model), `AgentsPanel` (per-agent model override), `MemoryConfigPanel` (indexer model); full contract in §4.17 |
| CLI `--refresh-models` | `packages/code/src/cli-args.ts`, `packages/code/src/runtime.tsx` (`runRefreshMode`) | headless mode: `kernel.models.refresh()` then exits |

## 3. Data and formats

### 3.1 The bundled snapshot

`packages/kernel/src/data/models-dev.json` is **already** in projected `CatalogData` shape (not raw
models.dev JSON): `{ "source": "https://models.dev/api.json", "providers": { <id>: {...} } }`.
The snapshot itself is authoritative for its changing provider/model inventory; this specification
does not duplicate counts, ordering, model ids, prices, or release dates. Interactive first boot no
longer parses or projects the snapshot; the catalog crosses an explicit on-demand boundary in
`packages/code/src/runtime.tsx` (`ensureModelsCatalog`).

### 3.2 On-disk schema (Zod, `packages/kernel/src/models/model-catalog.ts`)

```
catalogCostSchema:     { input: number>=0, output: number>=0, cache_read?: number>=0, cache_write?: number>=0 }.passthrough()
catalogModelSchema:    { name?, context?: int>0, output?: int>0, capabilities?: string[],
                         reasoning_efforts?: string[], release_date?, cost? }.passthrough()
catalogProviderSchema: { id, name, kind: enum(6 kinds), base_url?, env?: string[],
                         models: record<string, catalogModelSchema> }.passthrough()
catalogDataSchema:     { source?, providers: record<string, catalogProviderSchema> }.passthrough()
```

Every catalog schema in `packages/kernel/src/models/model-catalog.ts` is `.passthrough()`, so
unrecognized models.dev fields survive
a parse/re-serialize round trip rather than being stripped.

### 3.3 Refresh cache file

Path: `globalPaths(configDir).modelsCacheFile` = `<configDir>/cache/models-dev.json`
(`packages/paths/src/global.ts`). Written via `writeFileAtomicSync`
(`packages/kernel/src/models/model-catalog.ts`), same `CatalogData` shape as the bundle. `writeCatalogCache` also clears
the in-process `bundleCache` memo so a later bundle-only read is unaffected by a stale
value, but a cache write is otherwise **independent of the bundle** — reading the bundle again after
a cache write still returns the bundle (pinned by test
`packages/kernel/tests/integration/model-catalog.test.ts`).

### 3.4 Normalized in-memory shape (`CatalogModel`/`CatalogProvider`)

`toModels` (`packages/kernel/src/models/model-catalog.ts`) sorts each provider's models **newest release first**
(`releaseDate.localeCompare` descending), tie-broken by `modelId` ascending — release dates that are
equal or both empty (`""`) fall through to the modelId tiebreak. `toProvider`
(`packages/kernel/src/models/model-catalog.ts`) takes the **first** `env` entry as `api_key_env` and sets
`needsBaseUrl: kind === "openai-compatible" && !base_url`.

`CAPABILITY_ALIASES = { tool_call: "tool_calling" }` — `normalizeCapabilities`
deduplicates via a `Set` after aliasing, so a raw catalog's `tool_call` string normalizes to
`tool_calling` and duplicates collapse.

### 3.5 The wire projection (`toProtoModel`/`toProtoProvider`)

Field renames going out to the protocol DTO: `modelId → id`, `context_window_tokens →
context_window`, `max_output_tokens → max_output`, `needsBaseUrl → needs_base_url`. Every optional
field is included only when defined (spread-guard pattern), never as an explicit `undefined`.
Confirmed by test `packages/kernel/tests/integration/model-catalog.test.ts`: the wire model
"does not have property `modelId`" — only `id`.

### 3.6 models.dev API projection (`projectModelsDevApi`)

Given the **raw** live models.dev payload (a record keyed by provider id, each with `npm`, `name`,
`api`, `env`, `models`), the function:

- Skips any model carrying a `status` field (preview/deprecated) — `packages/kernel/src/models/model-catalog.ts`.
- Skips any model id starting with `~` (an alias) — `packages/kernel/src/models/model-catalog.ts`.
- Derives `kind` from the provider's `npm` field via `KIND_BY_NPM`; anything not in that table
  becomes `"openai-compatible"` through `kindOfNpm`.
- Derives capabilities: `tool_call → "tool_calling"`, `reasoning → "reasoning"`, and
  `modalities.input` containing `"image"` → `"vision"`.
- Reads `reasoning_efforts` only from a `reasoning_options` entry whose `type === "effort"`, taking
  its `values` array filtered to strings — a `budget_tokens`-typed option is ignored.
- Resolves `base_url` from the payload's own `api` field, else from the maintained
  `KNOWN_BASE_URL[providerId]` mapping.
- A non-object provider value (`"badprovider": "not-an-object"`) still produces a provider record
  with `kind: "openai-compatible"`, empty `models: {}`, `name` falling back to the provider's own id
  — pinned by test `packages/kernel/tests/integration/model-catalog.test.ts`.
- The same `asRecord(v)` guard (`packages/kernel/src/models/model-catalog.ts`, returning `{}` for anything not a
  non-null object) is applied to the **entire raw payload** too, not just a nested provider value: a
  `null` (or otherwise non-object) `raw` argument yields `{ source: MODELS_DEV_URL, providers: {} }`
  rather than throwing — pinned by
  `packages/kernel/tests/integration/model-catalog.test.ts` ("returns an empty catalog for a
  non-object payload").

### 3.7 Live fetch bound (`fetchModelsDevApi`)

`MAX_MODEL_CATALOG_BYTES = 8 * 1024 * 1024` bounds both `readCatalogFile` and the streamed response
inside `fetchModelsDevApi` in `packages/kernel/src/models/model-catalog.ts`: the reader is
cancelled and an error thrown the instant accumulated bytes exceed the cap, mid-stream, before the
whole body is buffered. `MODEL_CATALOG_FETCH_TIMEOUT_MS = 30_000` bounds the request via
`AbortSignal.timeout`. Pinned by test
`packages/kernel/tests/integration/model-catalog.test.ts`, which asserts the pull count
never reaches 20 (i.e., the cancel happens before the 20th 1 MiB chunk lands, which would be the
20 MiB point — comfortably past the 8 MiB cap).

## 4. Behavior

### 4.1 Catalog load precedence

`loadCatalogData(configDir?, logger)` (`packages/kernel/src/models/model-catalog.ts`):

| State | Result |
| --- | --- |
| `configDir` omitted | bundle, unconditionally |
| cache file missing (`ENOENT`) | bundle, **silently** — first-run is not reported |
| cache file present but not valid JSON | bundle, logged `kernel.models.cache_invalid` |
| cache file present but fails `catalogDataSchema` | bundle, logged `kernel.models.cache_invalid` |
| cache file present, valid JSON, valid schema | cache |
| cache file exceeds `MAX_MODEL_CATALOG_BYTES` | bundle (rejected before JSON.parse even runs) |

Pinned by `packages/kernel/tests/integration/model-catalog.test.ts` and the observability
block.

### 4.2 `createModelsCatalog` construction (`packages/kernel/src/models/model-catalog.ts`)

1. `loadCatalogData` resolves `{data, source}`.
2. Every provider is mapped through `toProvider` and sorted by `id` with ascending
   `localeCompare`.
3. `provider(id)` is a `Map` lookup; `seed`/`fill` close over the sorted `list`.
4. `fill(kind, modelId)` searches same-`kind` providers **first**, then falls back
   to scanning every provider — `[...sameKind, ...list]` in that order, so a same-kind provider's
   hit always wins over a cross-kind one even if the cross-kind provider sorts earlier by id.

### 4.3 `resolveModelPrice` (kernel, `packages/kernel/src/models/model-catalog.ts`)

1. `parseModelRef(modelRef)` splits the ref.
2. Finds the **configured** provider (`providers: ProviderConfig[]`, i.e. `settings.json`'s
   `providers[]`, not the catalog) whose `.name` matches the ref's provider segment. No match →
   `undefined` immediately (never reaches the catalog).
3. Looks up `catalog.provider(providerConfig.name)` — an **exact catalog-id-equals-configured-name**
   match — for the model. If found and it carries `.cost`, return it.
4. Else falls back to `catalog.fill(providerConfig.kind, modelId)?.cost` — same-kind-then-any
   scan.

This is narrower than the TUI's `resolveCatalogModel` (§4.4) in the `base_url` tier, but not in its
exact-match step: the kernel guards that hit with `if (exact?.cost) return exact.cost;`
(`packages/kernel/src/models/model-catalog.ts`), so an exact catalog hit under the configured provider's own name that
carries **no** `.cost` falls through
to `fill(...)` here — while the TUI's `resolveCatalogModel` returns any exact hit unconditionally
(`if (exact) return exact;`, `packages/code/src/adapters/models-catalog.ts`) and never falls through in that branch.
So for that costless-but-exact case the kernel can still find a price via `fill()` where the TUI
cannot; see §4.4.

### 4.4 `resolveCatalogModel` (TUI, `packages/code/src/adapters/models-catalog.ts`)

1. Parse ref, find configured provider by name — same as kernel. No match → `undefined`.
2. Exact catalog match under the configured provider's own `.name` (same as kernel step 3).
3. **New tier absent from the kernel**: if the configured provider declares a `base_url`, search
   every catalog provider of the **same kind** whose `base_url` (trailing slashes stripped) equals
   the configured provider's `base_url` (also trailing-slash-stripped), and look for the model
   there. This lets a differently-named provider entry (e.g. `router-custom-name` pointing at
   `https://openrouter.ai/api/v1/`) resolve against the catalog's `openrouter` id purely by endpoint
   match. Pinned by `packages/code/tests/unit/effort-levels.test.ts` (the
   `router-custom-name` fixture resolves `openai/gpt-5.6-luna`'s reasoning efforts via this path).
4. Else falls back to `catalog.fill(configured.kind, modelId)` — same-kind-then-any, identical to
   the kernel.

`resolveModelPrice` (TUI) is defined purely as `resolveCatalogModel(...)?.cost`
(`packages/code/src/adapters/models-catalog.ts`), so the TUI's price lookup is wider than the kernel's for any
`openai-compatible` provider the user renamed from its catalog id but kept the `base_url` of — but
narrower than the kernel's for an exact-but-costless catalog entry (§4.3), because its exact-match
step accepts a hit regardless of `.cost` and never falls through to `fill()` in that branch. Neither
direction is "strictly wider"; the two functions diverge in both the `base_url` tier (TUI only) and
the exact-match cost guard (kernel only).

### 4.5 `resolveProvider` (capability, `packages/capability/src/provider-resolver.ts`)

1. Find the registry entry (`ProviderConfig[]`) whose `.name === token`. No match →
   `{ ok:false, code:"unknown_provider", message: "Provider '<token>' is not declared in
   'providers'. Every model's provider token must match a providers[].name entry." }`.
2. On a match, optionally look up `entry.models?.[modelId]` when `modelId` is supplied.
3. `headers` and `body` are **shallow-merged per top-level key** via `mergeShallow`: the model's map
   replaces the provider's at each top-level key, so a nested object
   the model overrides loses every sibling key the provider set at that same top level (pinned by
   `packages/capability/tests/unit/provider-resolver.test.ts`, which explicitly checks that
   `order` does NOT survive under a model override of `provider.allow_fallbacks`).
4. `promptCache` is taken **only** from the model (`model?.prompt_cache`) — there is no
   provider-level `prompt_cache` field to fall back to (confirmed against
   `packages/capability/src/api.ts`: `ProviderConfig` has no `prompt_cache` key at all,
   only `ModelConfig` does).
5. `headers` values are projected **as authored** — `${VAR}` templates, never resolved — per the
   remark at `packages/capability/src/provider-resolver.ts` and the named header projection case in
   `packages/capability/tests/unit/provider-resolver.test.ts`.

### 4.6 Model/effort resolution at run assembly (`buildProfile`)

For the **entry** agent (the run's lead profile), `merged.default_model` wins over agent frontmatter
`model`, which wins over `options.defaultModel`:
```
entry:    merged.default_model ?? agentModel ?? options.defaultModel
non-entry: agentModel ?? merged.default_model ?? options.defaultModel
```
The identical entry/non-entry priority order applies to `reasoning_effort` — **but the tier count is
not identical**: `SettingsAssemblerOptions`
(`packages/kernel/src/runs/settings-assembler.ts`) declares `defaultModel` and `defaultIterationLimit` but no
`defaultReasoningEffort` field at all, so at this layer `reasoning_effort` resolution is only 2-tier
(`merged.default_reasoning_effort` / agent frontmatter) against `model`'s 3-tier
(`merged.default_model` / agentModel / `options.defaultModel`). A further tier exists one layer
down, outside this assembler: the doc-comment at `packages/kernel/src/runs/settings-assembler.ts` states "When no
reasoning effort resolves, the loop's `CLARVIS_DEFAULT_REASONING_EFFORT` fallback remains last" —
that env-backed default (`packages/capability/src/env.ts`) is read by
`packages/loop/src/runtime/subagents/subagent-profiles.ts` as
`p.reasoning_effort ?? env.CLARVIS_DEFAULT_REASONING_EFFORT` when building the profile the assembler
handed off. This means:

- The user's `/model` and `/effort` picks are **authoritative for the entry agent only** — a
  spawned sub-agent's own frontmatter `model`/`reasoning_effort` is never overridden by the user's
  global default; only a sub-agent that declares **neither** falls back to the user's default.
- Pinned by two cases in `packages/kernel/tests/component/settings-assembler.test.ts`: "the user's
  model and effort override the Lead while a spawned Sub-agent keeps its profile" and "a spawned
  Sub-agent with no model or effort falls back to the user's defaults".
- If no model resolves at all (neither settings, frontmatter, nor `options.defaultModel`), a
  `kernel_error("invalid_request"...)` is thrown naming the agent (`packages/kernel/src/runs/settings-assembler.ts`).
- `reasoning_effort` may legitimately end up `undefined` — no fallback throws for it (the assignment
  in `packages/kernel/src/runs/settings-assembler.ts` has no `if (undefined)` guard analogous to
  `model`'s; this is pinned by the corresponding component test).
- `default_vision_model`, unlike `default_model`, has **no** per-agent override path: it is copied
  straight from `merged.default_vision_model` into the request's top-level `vision_model` field
  whenever it is a string — there is no agent-frontmatter equivalent for vision
  model in this assembler.

### 4.7 `cacheModeOf` (`packages/kernel/src/models/model-catalog.ts`)

```
cacheModeOf(cost):
  if (cost?.cache_write ?? 0) > 0        → "explicit"   (creation is charged: must ask)
  else if cost?.cache_read !== undefined → "implicit"   (creation free, reads priced or free)
  else                                    → "unknown"   (catalog says nothing)
```
Two specific comparisons are called out as load-bearing in the source doc-comment
(`packages/kernel/src/models/model-catalog.ts`) and independently pinned by a TUI unit test
(`packages/code/tests/unit/catalog-pick.test.ts`):
- `> 0`, never a bare presence check — because some models publish `cache_write: 0` (free creation
  = implicit, not explicit).
- `!== undefined`, never truthiness — because some models publish `cache_read: 0` (free reads,
  falsy but present), which a `&&`-style check would silently treat as absent.

The current models.dev schema publishes these prices but no field for a provider's cache protocol,
breakpoint shape, marker limit, or TTL. Clarvis therefore does not synthesize an inline marker from
a model id. `cacheModeOf` classifies the price shape, then `derivePromptCacheMode` combines it with
the configured provider `kind`; only an endpoint family whose marker protocol is part of Clarvis's
owned contract may become catalog-derived explicit.

### 4.8 `derivePromptCacheMode` (`packages/kernel/src/models/model-catalog.ts`)

```
derivePromptCacheMode(cost, kind):
  mode = cacheModeOf(cost)
  if mode === "unknown" → undefined
  if mode === "explicit" && kind === "anthropic" → "explicit"
  else → "implicit"
```
The provider-kind gate is deliberately independent of model names: native OpenAI, ChatGPT, Google,
Grok and catalog-derived OpenAI-compatible models stay provider-managed implicit even when
`cache_write > 0`. An explicitly authored OpenAI-compatible provider remains an operator escape
hatch because this derivation is called **once, at model-configuration time** in the TUI's providers controller
(`packages/code/src/features/providers/controller.ts`, inside `addModelFromCatalog`), not per
run — and the kernel deliberately exports no per-request equivalent at all: a dedicated test,
`packages/kernel/tests/unit/prompt-cache-mode.test.ts` (describe `nothing on the run path
consults the catalog`), asserts `kernel.withPromptCacheModes` and `kernel.resolvePromptCacheModes`
are both `undefined` on the module's export surface while `derivePromptCacheMode` itself remains a
function — i.e. the absence of a run-path stamping helper is a pinned architectural choice, not an
unwritten feature. The resulting `prompt_cache` value is written into `settings.json`'s model entry
(`context_window_tokens`, `max_output_tokens`, `capabilities`, `prompt_cache`) by
`packages/code/src/features/providers/controller.ts` and only overwritten if not already set when a
"fill from catalog" action runs
again (`packages/code/src/views/config/providers/model-level.tsx`, guarded by
`ctx.current()?.models?.[ctx.modelId()]?.prompt_cache === undefined`). A user may still cycle it
manually through `undefined → explicit → implicit → off → undefined`
(`PROMPT_CACHE_CYCLE` and `activate()` in
`packages/code/src/views/config/providers/model-level.tsx`) — `derivePromptCacheMode`
never overwrites an already-set value (doc-comment `packages/kernel/src/models/model-catalog.ts`). What the stored
`prompt_cache` mode actually does to a request on the wire is delegated to
[cross-cutting/prompt-cache.md](../cross-cutting/prompt-cache.md).

Authenticated ChatGPT and Grok catalogs deliberately carry entitlement and model-shape metadata
rather than models.dev pricing. `cachePolicyModel` therefore resolves an exact model-id match from
the owning public catalog family when, and only when, the configured endpoint is the matching
subscription kind: native `openai` for `openai-codex`, or the `xai` provider for `xai-grok`.
`addModelFromCatalog` uses that cost only when the entitled hit has none, so future models follow the
catalog without a model-name list. The same fallback is not available to arbitrary
`openai-compatible`, Google, or Anthropic endpoints. Existing persisted `prompt_cache` values still
win.

Production: `packages/code/src/features/providers/controller.ts` (`cachePolicyModel`,
`addModelFromCatalog`, `catalogModelFor`).
Test: `packages/code/tests/unit/providers-controller.test.ts` (tests “derives ChatGPT cache policy
from models.dev without naming models”, “derives Grok cache policy from the xAI catalog without
naming models”, and “never borrows OpenAI cache policy for other provider kinds”).

### 4.9 `reasoningOutputFloor` (`packages/capability/src/reasoning-budget.ts`)

```
reasoningOutputFloor(kind, effort):
  if kind !== "anthropic" or effort undefined or effort === "off" → undefined
  else → ANTHROPIC_OUTPUT_HEADROOM_TOKENS[effort] + 8192
```
`ANTHROPIC_OUTPUT_HEADROOM_TOKENS`: `minimal=1024, low=2048, medium=4096, high=8192,
xhigh=16384, max=32768`. Monotonic in effort — pinned by
`packages/capability/tests/unit/reasoning-budget.test.ts` ("is monotonic in effort, so a
deeper effort never reserves less"). Consumed by `packages/llm/src/ai-sdk/request-options.ts`
(building the actual call) and `packages/loop/src/runtime/loop/loop.ts` (the loop's
window-aware output-budget clamp) — both outside this document's scope (delegated to
[foundations/llm.md](../foundations/llm.md) and the loop's budget/clock machinery respectively); this document owns only the
floor function itself.

### 4.10 TUI catalog boot sequence (`packages/code/src/runtime.tsx`)

1. `loadFoundation` never calls `client.models.get()`. `ensureModelsCatalog` is a single-flight
   loader crossed only by a catalog-dependent command or surface; provider routes await it alongside
   their own dynamic module import before mounting the first-run picker.
2. `liveCatalog` is a `ModelsCatalog` object whose every method reads through the
   `modelsCatalog()` signal and degrades to an empty/`undefined` answer while it is still `null` —
   so every UI surface holding a reference to `liveCatalog` need not know whether the catalog has
   landed yet.
3. An empty-providers catalog or a failed `client.models.get()` call is reported via
   `diagnosticEvent("catalog.unavailable", { reason, source }, "warn")`
   (`reportCatalogUnavailable`), never thrown — the picker simply renders empty.
4. `--refresh-models` (headless CLI mode) constructs a throwaway `FileKernel`, calls
   `kernel.models.refresh()`, prints `"models.dev refreshed — N providers / M models"`, and exits 0
   (or prints `"refresh failed: ..."` and exits 1) — `packages/code/src/runtime.tsx`
   (`runRefreshMode`).

### 4.11 `/model` and `/effort` write coupling

`ModelView.choose()` (`packages/code/src/views/config/ModelView.tsx`) writes **both** `default_model` and
`default_reasoning_effort` in one `settings.write` call whenever a model is picked: the effort is
computed as `recommendedReasoningEffort(supportedReasoningEfforts(catalog, providers, model))` —
i.e. selecting a new default model always resets the default effort to a
model-appropriate recommendation, never leaves a stale effort value from the previous model. Pinned
by `packages/code/tests/integration/model-view-render.test.tsx` (writes
`{ default_model: "openrouter/deepseek-chat", default_reasoning_effort: "medium" }` in one call).

`EffortView.choose()` (`packages/code/src/views/config/EffortView.tsx`) writes **only** `default_reasoning_effort` — it
never touches `default_model`. Pinned by
`packages/code/tests/integration/effort-view-render.test.tsx`.

Before `ModelView.choose()` changes models, it refuses while a run is active. For a settled run it
compares the private persisted-context estimate with the selected model's safe high-water mark. A
smaller window that would overflow opens a destructive confirmation naming both estimates. After
acceptance, the model/effort settings write happens before the irreversible mechanical fit, so a
failed write cannot compact history without switching. If the subsequent fit fails or declines to
compact, the prior scope values are written back and the selection fails; refusal changes neither
history nor setting. Production: `ModelView.choose` in
`packages/code/src/views/config/ModelView.tsx`. Test:
`packages/code/tests/integration/model-view-render.test.tsx` (smaller-model acceptance, refusal,
failed-write preservation, and active-run cases).

### 4.12 `supportedReasoningEfforts` / `recommendedReasoningEffort` (`effort-levels.ts`)

```
supportedReasoningEfforts(catalog, providers, modelRef):
  no modelRef                         → undefined  ("not known")
  configured model has
    reasoning_efforts                 → normalizeReasoningEfforts(that array)
  configured subscription model      → undefined (entitled lookup owns the fallback)
  no catalog                          → undefined  ("not known")
  model not resolved in catalog       → undefined
  model.reasoning_efforts defined     → normalizeReasoningEfforts(that array)
  model.capabilities defined and
    excludes "reasoning"              → []          ("known unsupported")
  otherwise                            → undefined  ("not known")
```
`normalizeReasoningEfforts` maps the provider vocabulary word `"none"` to Clarvis's
`"off"` and silently drops any value not in the fixed `EFFORT_LEVELS` tuple (order preserved:
`off, minimal, low, medium, high, xhigh, max`).

`recommendedReasoningEffort(levels)` filters out `"off"`; among the rest, it picks the
level whose index is closest to `"medium"`'s index; ties are broken toward the **higher** effort
(`bi - ai` tie-break) — pinned by
`packages/code/tests/unit/effort-levels.test.ts` (`["low","high"] → "high"`, both equidistant
from medium).

The configured-model lookup comes first so an entitled ChatGPT or Grok catalog survives the
provider picker boundary: `addModelFromCatalog` persists its published levels, and `/effort` can
resolve them even though the ordinary bundled models.dev catalog does not own subscription
entitlements. A legacy subscription entry without persisted levels returns `undefined` before the
public-catalog fallback; `EffortView` then requests its authenticated entitled catalog and guards
the asynchronous result against a model change (`packages/code/src/adapters/effort-levels.ts`,
`packages/code/src/views/config/EffortView.tsx`). Pinned by
`packages/code/tests/unit/effort-levels.test.ts` and the subscription render case in
`packages/code/tests/integration/effort-view-render.test.tsx`.

### 4.13 `seed`/`safeName` (`packages/kernel/src/models/model-catalog.ts`)

`seed(providerId, taken)` builds a starter `ProviderConfig` for a catalog provider the operator is
about to add to `settings.json`:

```
seed(providerId, taken):
  p = provider(providerId)
  if p is undefined → undefined
  config = { name: safeName(p.id, taken), kind: p.kind }
  if p.base_url      → config.base_url = p.base_url
  if p.api_key_env   → config.api_key_env = p.api_key_env
  return config
```

Only `name`, `kind`, and — when present on the catalog entry — `base_url`/`api_key_env` are copied;
nothing else of `CatalogProvider` carries over. `safeName(id, taken)` lowercases
`id`, collapses every run of characters outside `[a-z0-9_-]` to a single `-`, trims leading/trailing
`-`, and falls back to the literal `"provider"` if that leaves nothing; if the result is already in
`taken` it appends `-2`, then `-3`, ... until an unused name is found.
`packages/code/src/adapters/models-catalog.ts` is a byte-for-byte duplicate of both functions,
operating over the
protocol DTO instead of the kernel's internal `CatalogProvider` (see §7).

Test: `packages/kernel/tests/integration/model-catalog.test.ts` ("seed() returns undefined for an
unknown provider id") ("seed() disambiguates a colliding name by walking safeName's suffix
loop").

### 4.14 `FORBIDDEN_PROVIDER_BODY_KEYS` enforcement

The constant (`packages/capability/src/provider-resolver.ts`) is declared here, but nothing in `resolveProvider` itself
strips or rejects the keys — the doc-comment immediately above it (`packages/capability/src/provider-resolver.ts`)
states the rule is "enforced twice on purpose: a settings schema refuses them so the operator sees a
diagnostic, and the adapter strips them from the merged map so the rule also holds for a host that
constructs a `ResolvedProviderConfig` directly, without any schema having run." Three consumers carry
that out: `packages/loop/src/validation/request/provider-rules.ts` rejects a request whose
provider/model body carries one of the keys (settings-schema-time enforcement);
`packages/llm/src/openai-compatible-request.ts` drops any of the keys from the merged body immediately before the
call is made (adapter-time enforcement, the second half of the doc-comment's "twice"); and
`packages/code/src/features/providers/request-params.ts` surfaces a TUI-side warning when an
operator's own `headers`/`body` entry would set one. The enforcement mechanism itself belongs to
[foundations/llm.md](../foundations/llm.md)/request validation; this document owns only the constant and its consumers.

### 4.15 `EffortView`'s choice list and support state (`EffortView.tsx`)

`effortChoices(levels)` always prepends a synthetic `PROVIDER_CHOICE` row (`{ id: "provider", value:
undefined, label: "Provider default", detail: "Let the provider decide" }`) ahead of the resolved
levels; `EFFORT_COPY` supplies each real level's label and one-line detail text. When the catalog
cannot resolve the levels at all, `UNKNOWN_CHOICES` is just `[PROVIDER_CHOICE]`.

The "support" status row is a 5-way branch over the entitled-catalog request and the same
`supportedReasoningEfforts`/`capabilities` signals as §4.12: while a legacy subscription model's
authenticated entitlement request is pending → "Loading subscription effort levels…"; after that,
no published levels plus `lacksReasoning()` → "Default model does not declare reasoning support";
`available() === undefined` → "Effort levels are not published for this model";
`available()!.length === 0` → "This model offers no configurable effort levels"; otherwise → "`N`
model-supported levels". Separately, the "current"
status row reads `${current()} (not available for this model)` when the
already-stored `default_reasoning_effort` is not among the resolved `choices()` — i.e. an effort a
previous model supported but the current default model does not.

### 4.16 `CatalogPicker`'s behavioral props (`CatalogPicker.tsx`)

Beyond the row list and the compact-threshold invariant (INV-MC-12), `CatalogPickerProps` carries
several independent behaviors: `stayOpen` keeps the picker open after a pick and clears the filter
input (`if (props.stayOpen && inputEl) inputEl.value = "";`) for multi-select flows; the per-row
leading indicator is one of two mutually exclusive modes — a `currentId`
prop drives a radio glyph (`radioOn`/`radioOff`) comparing each row's id to it, while its absence
falls back to an `added`-driven checkmark (`glyph("success")` or a blank); `counter`/`counterLabel`
render a footer suffix like "· `N` added" when the counter is positive; `onManual` adds a
manual-entry row the picker routes to instead of `onPick`; and the picker reserves
`ctrl+s`/`ctrl+t` as guard keys regardless of caller configuration.

### 4.17 `modelPickerSpec` (`packages/code/src/views/config/pick-model.ts`)

`modelPickerSpec` is the one function behind the `pick-model.ts` row in §2.5's TUI-surface table: it
turns a caller's wiring (`opts`) into either a `CatalogPickerSpec` or `null`, and every one of its
three callers — `DefaultsPanel` (vision model), `AgentsPanel` (per-agent model override) and
`MemoryConfigPanel` (indexer model) — hands it a `settings: SettingsAdapter`, the field's `current`
value, and `commit`/`close` callbacks, and reads back either a spec to mount a `CatalogPicker` from
or `null` to do nothing further.

**No-providers path**. `providers = opts.settings.effective().providers ?? []`; when it
is empty, `modelPickerSpec` never returns a picker spec — there is nothing to pick from. If `opts.fe`
(a manual-entry editor, typed `Pick<FieldEditor, "start">`) was supplied, it calls `manual()`
immediately, which is `fe.start("model (provider/modelId)", opts.current, (v) =>
opts.commit(v.trim()))` — i.e. it opens the raw-text field editor pre-filled with the
current value and commits the *trimmed* typed string on submit. Otherwise it calls
`opts.onNoProviders?.()`. Either branch returns `null`. The function's own TSDoc states the
rule directly: "When no provider is configured, falls back to manual entry via `opts.fe.start` if a
manual editor was supplied, otherwise calls `opts.onNoProviders`; either way there is nothing to pick
from, so `null` is returned.". `opts.fe` is deliberately optional — its own inline comment
names "the `/model` picker" as an example of a host that omits it — and all three actual
callers (`DefaultsPanel`, `AgentsPanel`, `MemoryConfigPanel`) do pass `fe`, so the no-`fe` branch is
untaken in the shipped call sites but is exercised directly by
`packages/code/tests/unit/pick-model.test.ts`.

**Providers-present path**. The returned `CatalogPickerSpec` carries: `title`, defaulting
to `"Pick a model " + glyph("emDash") + " configured providers"` unless `opts.title` overrides it
(for callers where "the field is not \"the model\""); `rows`, a thunk re-reading
`opts.settings.effective().providers` on every call and delegating to `configuredModelRows(providers,
opts.current, opts.requireCapability)` — `requireCapability` is what lets
`DefaultsPanel`'s vision-model picker restrict its rows to models declaring that capability
(`packages/code/src/views/config/DefaultsPanel.tsx` passes `requireCapability: "vision"`; see
[code-settings-panels](code-settings-panels.md)'s own `default_vision_model` row); `onManual`, present **only** when `manual` was built
(i.e. only when `opts.fe` was supplied), which first calls `opts.close()` then invokes `manual()`
 — so opening the manual editor from an already-open picker always closes the picker first;
`onClose: opts.close` verbatim; and `onPick`, which calls `opts.close()` then
`opts.commit(id)` in that order.

`packages/code/tests/unit/pick-model.test.ts` pins every branch: the manual-fallback and
`onNoProviders`-fallback no-provider cases (including a caller supplying neither), that the returned
`rows()` mirrors `configuredModelRows` directly, that `onManual` is entirely absent from the spec
when no `fe` was given (asserted both as `undefined` and via `"onManual" in spec`), the
close-then-open-manual-editor ordering, and that `onPick`/`onClose` each close before committing.

## 5. Invariants

**INV-MC-1.** `cacheModeOf` treats `cache_write > 0` (not mere presence) as `"explicit"` and
`cache_read !== undefined` (not truthiness) as `"implicit"` when `cache_write` is absent/zero;
absent-both is `"unknown"`.
Production: `packages/kernel/src/models/model-catalog.ts`.
Test: `packages/kernel/tests/unit/prompt-cache-mode.test.ts` (describe block `T1: cacheModeOf`,
calling `cacheModeOf` directly for every branch) (`T1b`, a corpus-wide invariant sweep
against the real bundled catalog); also independently exercised by
`packages/code/tests/unit/catalog-pick.test.ts` via `modelRows`'s glyph derivation.

**INV-MC-2.** `derivePromptCacheMode` never returns `"explicit"` for `kind === "openai-compatible"`
— it downgrades to `"implicit"` — and returns `undefined` (not `"off"`) when `cacheModeOf` is
`"unknown"`.
Production: `packages/kernel/src/models/model-catalog.ts`.
Test: `packages/kernel/tests/unit/prompt-cache-mode.test.ts` (describe block
`derivePromptCacheMode: what a configured model should store`), including ("caps explicit
on openai-compatible ONLY", asserting `implicit` for openai-compatible and `explicit` for every other
kind on the same priced cost), the bundled `openai/gpt-5.6-sol` price deriving `"explicit"` for
`openai-codex`, the bundled `xai/grok-build-0.1` read price deriving `"implicit"` for `xai-grok`, (`derivePromptCacheMode(undefined, "anthropic")` and
`derivePromptCacheMode({}, "openai-compatible")` both `toBeUndefined()`).

**INV-MC-3.** For the run's entry agent, `merged.default_model` (and `default_reasoning_effort`)
wins over the agent's own frontmatter; for every other (spawned) agent, the agent's own frontmatter
wins and the settings default is only the last resort.
Production: `packages/kernel/src/runs/settings-assembler.ts`.
Test: `packages/kernel/tests/component/settings-assembler.test.ts`.

**INV-MC-4.** An agent that resolves no model at all (no frontmatter, no `default_model`, no
`options.defaultModel`) fails run assembly with `invalid_request`, naming the agent; failing to
resolve a `reasoning_effort` is not an error and yields `undefined`.
Production: `packages/kernel/src/runs/settings-assembler.ts`.
Test: `packages/kernel/tests/component/settings-assembler.test.ts` (the effort-unset half);
no assertion for the model-missing throw path has been identified in that file — see §8.

**INV-MC-5.** `resolveProvider`'s `headers`/`body` merge is shallow per top-level key: a model's
own top-level object entirely replaces the provider's at that key, never deep-merges into it.
Production: `packages/capability/src/provider-resolver.ts`.
Test: `packages/capability/tests/unit/provider-resolver.test.ts` (explicitly asserts a
sibling key, `order`, does NOT survive under a model-level override).

**INV-MC-6.** `resolveProvider` projects a model's `prompt_cache` only from that model's own entry
— there is no provider-level fallback for it (the `ProviderConfig` type carries no `prompt_cache`
field at all).
Production: `packages/capability/src/provider-resolver.ts`; `ProviderConfig` and `ModelConfig` in
`packages/capability/src/api.ts`.
Test: `packages/capability/tests/unit/provider-resolver.test.ts`.

**INV-MC-7.** `reasoningOutputFloor` is non-`undefined` only for `kind === "anthropic"` with a
defined, non-`"off"` effort, and is monotonically non-decreasing in effort level.
Production: `packages/capability/src/reasoning-budget.ts`.
Test: `packages/capability/tests/unit/reasoning-budget.test.ts`.

**INV-MC-8.** `parseModelRef` splits only on the **first** `/`; a ref with no `/` yields
`modelId: ""`, and a ref with multiple slashes keeps every slash after the first inside `modelId`.
Production: `packages/capability/src/model-ref.ts`.
Test: `packages/capability/tests/unit/model-ref.test.ts`.

**INV-MC-9.** `ModelView`'s model selection writes `default_model` and a freshly-recomputed
`default_reasoning_effort` together, in one settings write; `EffortView`'s selection writes only
`default_reasoning_effort`.
Production: `packages/code/src/views/config/ModelView.tsx`;
`packages/code/src/views/config/EffortView.tsx`.
Test: `packages/code/tests/integration/model-view-render.test.tsx`;
`packages/code/tests/integration/effort-view-render.test.tsx`.

**INV-MC-10.** `supportedReasoningEfforts` returns `undefined` ("not known") whenever the catalog
has no capability data at all, and returns `[]` ("known unsupported") only when the model's
`capabilities` are known and explicitly omit `"reasoning"` — the two must never be conflated because
a hint keyed on "known unsupported" must never fire for an uncatalogued model.
When published effort levels are available, `EffortView` treats those as stronger evidence and does
not show the contradictory lacks-reasoning warning even if a generic capability list omits the tag.
Production: `packages/code/src/adapters/effort-levels.ts`,
`packages/code/src/views/config/EffortView.tsx` (`lacksReasoning`),
`packages/code/src/views/config/catalog-pick.ts` (`knownToLackReasoning`, same rule
restated for capability filtering elsewhere).
Test: `packages/code/tests/unit/effort-levels.test.ts` (undefined/empty-array cases across the
three provider fixtures); `packages/code/tests/unit/catalog-pick.test.ts`.

**INV-MC-11.** `recommendedReasoningEffort` excludes `"off"` from consideration and, on a tie in
distance from `"medium"`, prefers the **higher** effort level.
Production: `packages/code/src/adapters/effort-levels.ts`.
Test: `packages/code/tests/unit/effort-levels.test.ts`.

**INV-MC-12.** `CatalogPicker` auto-compacts (hides the filter input) exactly when its row count is
`<= 8` (`COMPACT_FILTER_MAX`), unless the caller forces `compact` explicitly.
Production: `packages/code/src/views/config/CatalogPicker.tsx` (`CatalogPickerSpec`, `CatalogPicker`).
Test: `packages/code/tests/integration/catalog-picker-render.test.tsx` (12-row list shows the
filter; 2-row list does not).

**INV-MC-13.** A catalog file (bundle or cache) larger than 8 MiB, or a live models.dev fetch whose
streamed body exceeds 8 MiB, is rejected before being fully parsed/buffered — a poisoned or runaway
catalog cannot be loaded into memory past that bound.
Production: `packages/kernel/src/models/model-catalog.ts` (file read) (streamed fetch).
Test: `packages/kernel/tests/integration/model-catalog.test.ts` (oversized cache file) (streamed fetch cancellation).

**INV-MC-14.** `fill(kind, modelId)` (both the kernel's and the TUI's catalog) builds its scan order
as `[...sameKind, ...list]`, so a same-`kind` provider is always checked before any cross-kind
provider — by construction this cannot be defeated by id sort order, since the same-kind slice is
concatenated first regardless of where its members fall in `list`.
Production: `packages/kernel/src/models/model-catalog.ts`;
`packages/code/src/adapters/models-catalog.ts`.
Test: `packages/kernel/tests/integration/model-catalog.test.ts` only exercises the pure-fallback
case (no same-kind provider has the model at all);
`packages/code/tests/unit/models-catalog.test.ts` tests `resolveModelPrice`'s exact-then-fill
behavior, not `fill()` directly. **Neither test
constructs a same-kind-provider-sorts-after-cross-kind-provider counter-example**, so the
sort-order-independence half of this invariant is verified from the concatenation order in the
source, not by a dedicated test — flagged in §8.

**INV-MC-15.** `seed(providerId, taken)` returns `undefined` for an unknown provider id, and never
returns a name already in `taken` — `safeName` walks a `-2`, `-3`, ... suffix loop until it finds one
that is not.
Production: `packages/kernel/src/models/model-catalog.ts`.
Test: `packages/kernel/tests/integration/model-catalog.test.ts`.

**INV-MC-16.** Adding a catalog model persists its published `reasoning_efforts`, and effort
resolution prefers that configured metadata before consulting the ordinary catalog. Therefore an
entitled subscription model keeps its selectable effort levels after the picker closes and when no
public catalog is loaded. A legacy subscription entry without persisted levels is resolved only
through the authenticated entitled service, never by a same-id public-catalog fallback.
Production: `packages/code/src/features/providers/controller.ts`;
`packages/code/src/adapters/effort-levels.ts`;
`packages/code/src/views/config/EffortView.tsx` (`subscriptionTarget` and
`subscription_effort_catalog`).
Test: `packages/code/tests/unit/providers-controller.test.ts`;
`packages/code/tests/unit/effort-levels.test.ts` (persisted and legacy subscription cases);
`packages/code/tests/integration/effort-view-render.test.tsx` (subscription model case).

**INV-MC-17.** A legacy subscription model whose authenticated effort catalog is still loading is
never presented as having unpublished effort levels. The loading state remains visible until that
request settles; only a settled result may publish choices or the unavailable state.
Production: `packages/code/src/views/config/EffortView.tsx` (`entitledLoading`,
`subscription_effort_catalog`).
Test: `packages/code/tests/integration/effort-view-render.test.tsx` (pending subscription effort
catalog case).

## 6. Failure modes and degradation

| Failure | Handling | Cite |
| --- | --- | --- |
| Cache file missing (first run) | Silently falls back to bundle; **no** log line | `packages/kernel/src/models/model-catalog.ts` |
| Every `get()`/`refresh()` call, success or not | Unconditional info log `kernel.models.catalog` naming `source`/`providers`/`models` counts — not a failure mode, but the only observability on this hot path | `packages/kernel/src/models/model-catalog.ts`; pinned `packages/kernel/tests/integration/model-catalog.test.ts` |
| Cache file unreadable / invalid JSON / fails schema | Falls back to bundle, logs `kernel.models.cache_invalid` with a `cause` | `packages/kernel/src/models/model-catalog.ts` |
| Cache or bundle file exceeds byte cap | Rejected before parse (`throw`), which `loadCatalogData`'s `try/catch` turns into the same "invalid, fall back to bundle" path | `packages/kernel/src/models/model-catalog.ts` |
| `refreshModelsCatalog` fetch fails (non-2xx, empty body, oversized stream, network error) | The `Error` propagates out of `refreshModelsCatalog`/`createModelCatalogService.refresh()` uncaught — **no** cache write happens, existing cache/bundle is untouched | `packages/kernel/src/models/model-catalog.ts`; pinned `packages/kernel/tests/integration/model-catalog.test.ts` |
| `resolveProvider` given an unknown token | Returns a typed `{ok:false, code:"unknown_provider", message}` rather than throwing; callers (e.g. `packages/loop/src/validation/request/provider-rules.ts`) turn it into a `ValidationError` | `packages/capability/src/provider-resolver.ts` |
| No model resolves for an agent at run assembly | Kernel error `invalid_request`, naming the agent | `packages/kernel/src/runs/settings-assembler.ts` |
| No reasoning effort resolves for an agent | Silently `undefined` — not an error | `packages/kernel/src/runs/settings-assembler.ts` |
| TUI: authenticated subscription effort lookup is pending | Render a loading status and withhold the unpublished-level claim until the request settles | `packages/code/src/views/config/EffortView.tsx` (`entitledLoading`); pinned by `packages/code/tests/integration/effort-view-render.test.tsx` |
| TUI: catalog fetch (`client.models.get()`) fails, or answers with zero providers | `diagnosticEvent("catalog.unavailable", ..., "warn")`; the picker just renders empty (`catalogReady` is `false`) | `packages/code/src/runtime.tsx` (`ensureModelsCatalog`); `catalog-pick.ts:catalogReady` |
| `configuredModelRows`/`configuredModelCapabilities` given a capability filter or a model the catalog never saw | Treated as "not known", never as "unsupported" — the model is still offered/its capabilities read as `undefined` | `packages/code/src/views/config/catalog-pick.ts` (doc-comment) |
| `guard_judge` has no model (neither `cfg.model` nor `deps.defaultModel`) | Warns and degrades the judge to mode `"on"` (asks a human) rather than failing the run | `packages/kernel/src/guard/judge.ts` (outside this document's scope; cited only as a `parseModelRef`/`resolveProvider` consumer) |

## 7. Coupling

**Depends on:**
- `@clarvis/capability` — `parseModelRef` is re-exported unchanged by the kernel
  (`packages/kernel/src/config.ts`); `packages/kernel/src/models/model-catalog.ts` imports it
  directly for `resolveModelPrice`. `NOOP_LOGGER` and `Logger` support logging and the default
  parameter.
- `@clarvis/loop/host`'s `providerConfigSchema` — **type-only** import
  (`import type { providerConfigSchema } from "@clarvis/loop/host"`), used solely to derive
  `ProviderConfig`/`ProviderKind` via `z.infer` so the kernel's catalog and the engine's settings
  schema cannot silently diverge in shape.
- `@clarvis/protocol` — the DTO types `CatalogModel`/`CatalogProvider`/`ModelCatalog`/
  `ModelCatalogService` the kernel's service builds toward through type-only imports.
- `@clarvis/paths` — runtime imports of `globalPaths` (cache path) and `writeFileAtomicSync` (atomic
  cache write).
- Node `node:fs`/`node:url` — direct, bounded file I/O (no streaming JSON library).

**Depended on by (forcing edges):**
- `packages/kernel/src/config.ts` re-exports the whole module's public surface — a required
  registration point; anything added there without updating `config.ts` is invisible to every kernel
  consumer.
- `packages/kernel/src/kernel.ts` constructs the one `ModelCatalogService` instance per kernel —
  a **runtime, static** call, not conditional; every kernel always carries a catalog service.
- `packages/kernel/src/runs/settings-assembler.ts` — imports only `EngineSettings`'s loosely-typed
  `default_model`/`default_vision_model`/`default_reasoning_effort` fields (no import of
  `model-catalog.ts` itself); the coupling to pricing/cache-mode is at **configuration time** in the
  TUI, not at run-assembly time (per the doc-comment at `packages/kernel/src/models/model-catalog.ts`, deliberately —
  the whole point of moving `derivePromptCacheMode` out of the assembler was to stop making the
  bundled catalog a hard dependency of every run).
- `packages/code/src/adapters/models-catalog.ts` — re-implements (does not import) the kernel's
  `ModelsCatalog` **build/lookup algorithms** (`createModelsCatalog`, `resolveModelPrice`, `fill`,
  `seed`/`safeName`) against the **protocol DTO** rather than reusing the kernel's internal shape.
  This is not because the TUI never imports the kernel package at runtime — it does:
  `packages/code/src/adapters/models-catalog.ts` imports `parseModelRef` from `@clarvis/kernel/config`, and
  `packages/code/src/views/config/providers/model-level.tsx` imports `cacheModeOf`/`derivePromptCacheMode` the same
  way. What the TUI does not import is the kernel's **catalog construction logic** itself, which is a
  **structural duplication forced by the package boundary** (per the repository's own rule that
  `code` reaches the engine only through `@clarvis/kernel`'s six entrypoints + `@clarvis/protocol`
  for anything beyond scalar helpers), not an oversight — but it means `resolveModelPrice`'s
  exact/fill algorithm, and `seed`/`safeName` (§4.13), exist in two source files that must be kept in
  step by hand (the TUI's version diverges from the kernel's in both directions — §4.4).
- `packages/code/src/views/config/{ModelView,EffortView,CatalogPicker,DefaultsPanel,AgentsPanel,
  MemoryConfigPanel,ProvidersPanel}.tsx` and `packages/code/src/adapters/effort-levels.ts` all import
  `adapters/models-catalog.ts` and/or `views/config/catalog-pick.ts` — a static, compile-time
  dependency; there is no dynamic/lazy loading of the catalog adapter.
- `packages/llm/src/ai-sdk/request-options.ts` and `packages/loop/src/runtime/loop/loop.ts`
  both call `reasoningOutputFloor` — outside this document's scope (owned by [foundations/llm.md](../foundations/llm.md) and
  the loop's budget machinery), cited here only to show the floor function's actual callers.
- `packages/loop/src/validation/request/provider-rules.ts`,
  `packages/loop/src/runtime/vision-prepass.ts`,
  `packages/loop/src/runtime/subagents/subagent-profiles.ts` all call `resolveProvider` — request
  validation and per-agent provider resolution inside the loop, outside this document's scope.
- `packages/kernel/src/guard/judge.ts` calls both `parseModelRef` and `resolveProvider` to
  resolve the guard-judge's own model — outside this document's scope (guard/judge subsystem), cited
  only as a coupling point.
- Container model calls also use the same resolver on the host's captured provider registry, after
  exact provider/model admission, so raw snake-case settings never masquerade as the adapter's
  resolved configuration. Production: `hostModelBroker` in
  [`local-container-runtime.ts`](../../packages/kernel/src/runtime/local-container-runtime.ts).
  Test: model override and real OpenAI-compatible SDK endpoint/authentication cases in
  [`runtime-capability-composition.test.ts`](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts).
  The wire boundary is owned by [isolated-agent-runtime](isolated-agent-runtime.md).

## 8. Open questions

- **Where `settings-assembler.ts`'s "no model resolves → invalid_request" throw is pinned by test**
  has no identified assertion in `packages/kernel/tests/component/settings-assembler.test.ts`
  (the file is long; the effort-unset sibling case is present, but the model-missing
  throw itself is not confirmed against a specific assertion in scope). INV-MC-4's second half is
  therefore recorded as **plausible but not directly re-verified against an explicit
  `expect(...).toThrow`**.
- ~~**The rationale for the `KNOWN_BASE_URL` table's specific 7 entries**~~ **Resolved: the question
  was the wrong one.** The table is a gap-filler, not a registry, and membership is not an
  endorsement — every entry is an OpenAI-compatible provider whose base URL models.dev does not carry,
  supplying the one value a user cannot reasonably be asked for, since it is fixed per provider and
  getting it wrong produces an authentication failure rather than a legible error. A provider absent
  from the table works exactly as before, with the operator setting `base_url` themselves, which is
  what keeps the list from needing to be complete
  (`packages/kernel/src/models/model-catalog.ts`).
- **Whether `ProvidersPanel.tsx`, `AgentsPanel.tsx`, `MemoryConfigPanel.tsx` and `DefaultsPanel.tsx`
  themselves (as opposed to their use of `CatalogPicker`/`pick-model.ts`) belong to this document**
  is ambiguous from the document boundary text; this spec describes their catalog-picker usage as a
  coupling point only and defers their own behavior (headers/body editing, key sources, agent
  overlay editing, memory model selection) to whichever document owns those panels.
- **The precise reasoning behind moving `prompt_cache` derivation from per-run to
  per-configuration** (the "used to be stamped per run request inside the kernel" remark at
  `packages/kernel/src/models/model-catalog.ts`) is stated in the source doc-comment itself, not
  inferred, so it is included in §4.8 as a direct citation rather than as speculation.
  `packages/kernel/tests/unit/prompt-cache-mode.test.ts` (§4.8) does mechanically pin the *absence* of the two named
  helpers the old architecture used (`withPromptCacheModes`, `resolvePromptCacheModes`), but it would
  not catch a differently-named per-request stamping helper reintroduced under a new name — so the
  design decision is documented and narrowly enforced by name, not structurally prevented.
- **INV-MC-14's sort-order-independence half** (a same-`kind` provider's `fill()` hit wins over a
  cross-kind provider's even when the cross-kind provider sorts earlier by id) is true by
  construction of `[...sameKind...list]` (`packages/kernel/src/models/model-catalog.ts`), but no located test constructs
  the actual counter-example — two providers carrying the same model id, with the same-kind one
  sorting after the cross-kind one — so this is verified from the source, not by test evidence.
