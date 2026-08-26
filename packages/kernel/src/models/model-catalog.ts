import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NOOP_LOGGER, parseModelRef, type Logger } from "@clarvis/capability";
import type { providerConfigSchema } from "@clarvis/loop/host";
import type {
  CatalogModel as ProtoCatalogModel,
  CatalogProvider as ProtoCatalogProvider,
  ModelCatalog as ProtoModelCatalog,
  ModelCatalogService,
} from "@clarvis/protocol";
import { globalPaths, writeFileAtomicSync } from "@clarvis/paths";

/**
 * Engine provider config shape used when seeding settings from the catalog.
 *
 * @remarks Re-derived from the loop's `providerConfigSchema` so the kernel and
 *   engine agree on the settings shape without the kernel owning the schema.
 */
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/**
 * Supported LLM provider adapter kinds - the `kind` discriminant of a
 * {@link ProviderConfig}; see {@link PROVIDER_KINDS} for the concrete values.
 */
export type ProviderKind = ProviderConfig["kind"];

/** Canonical list of {@link ProviderKind} values accepted by settings. */
export const PROVIDER_KINDS: ProviderKind[] = [
  "openai-compatible",
  "openai",
  "anthropic",
  "google",
  "openai-codex",
  "xai-grok",
];

const catalogCostSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cache_read: z.number().nonnegative().optional(),
    cache_write: z.number().nonnegative().optional(),
  })
  .passthrough();

const catalogModelSchema = z
  .object({
    name: z.string().optional(),
    context: z.number().int().positive().optional(),
    output: z.number().int().positive().optional(),
    capabilities: z.array(z.string()).optional(),
    reasoning_efforts: z.array(z.string()).optional(),
    release_date: z.string().optional(),
    cost: catalogCostSchema.optional(),
  })
  .passthrough();

const catalogProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum([
      "openai-compatible",
      "openai",
      "anthropic",
      "google",
      "openai-codex",
      "xai-grok",
    ]),
    base_url: z.string().optional(),
    env: z.array(z.string()).optional(),
    models: z.record(z.string(), catalogModelSchema),
  })
  .passthrough();

const catalogDataSchema = z
  .object({
    source: z.string().optional(),
    providers: z.record(z.string(), catalogProviderSchema),
  })
  .passthrough();

/**
 * Validated on-disk catalog payload (the bundled snapshot or the refresh cache).
 *
 * @remarks The schemas are `passthrough`, so unknown fields from models.dev
 *   round-trip intact rather than being stripped on parse.
 */
export type CatalogData = z.infer<typeof catalogDataSchema>;

/** One provider record in a {@link CatalogData} payload, with its raw `models` map. */
export type CatalogProviderData = z.infer<typeof catalogProviderSchema>;

/** One model record in a {@link CatalogProviderData} `models` map. */
export type CatalogModelData = z.infer<typeof catalogModelSchema>;

/** Token pricing for a catalog model (currency units as provided by models.dev). */
export type CatalogCost = z.infer<typeof catalogCostSchema>;

/** Normalized model entry exposed by {@link ModelsCatalog}. */
export interface CatalogModel {
  /** Provider-scoped model id (the key under the provider's `models` map). */
  modelId: string;
  /** Human-readable display name, when the catalog supplies one. */
  name?: string;
  /** Maximum context window, in tokens. */
  context_window_tokens?: number;
  /** Maximum output length, in tokens. */
  max_output_tokens?: number;
  /** Normalized capability tags (e.g. `tool_calling`, `reasoning`, `vision`). */
  capabilities?: string[];
  /** Provider-native reasoning-effort values accepted by this model. */
  reasoning_efforts?: string[];
  /** Token pricing, when the catalog knows it. */
  cost?: CatalogCost;
}

/** Normalized provider entry with its nested models, newest release first. */
export interface CatalogProvider {
  /** Stable provider id (the key under the catalog's `providers` map). */
  id: string;
  /** Human-readable provider name. */
  name: string;
  /** Adapter kind that drives this provider. */
  kind: ProviderKind;
  /** Default API base URL, when the catalog pins one. */
  base_url?: string;
  /** Name of the environment variable that holds this provider's API key, when known. */
  api_key_env?: string;
  /**
   * True when the provider is `openai-compatible` with no known `base_url`, so a
   * user must supply one before it can be used.
   */
  needsBaseUrl: boolean;
  models: CatalogModel[];
}

/**
 * In-memory view of the models catalog loaded from cache or the bundled snapshot.
 *
 * @remarks {@link source} records which of the two the view was built from, so a
 *   caller can tell a fresh refresh cache from the shipped fallback.
 */
export interface ModelsCatalog {
  /** Whether this view came from the refresh `cache` or the shipped `bundle`. */
  source: "cache" | "bundle";
  /** All providers, sorted by {@link CatalogProvider.id | id}. */
  providers(): CatalogProvider[];
  /** The provider with this id, or `undefined` when absent. */
  provider(id: string): CatalogProvider | undefined;
  /** The provider's models (empty when the provider is unknown). */
  models(providerId: string): CatalogModel[];
  /** Builds a starter {@link ProviderConfig} with a unique `name` not in `taken`. */
  seed(providerId: string, taken: ReadonlySet<string>): ProviderConfig | undefined;
  /** Looks up model metadata by kind preference, then any provider. */
  fill(kind: ProviderKind, modelId: string): CatalogModel | undefined;
}

/** The shipped models.dev snapshot as it sits in the source tree. */
const SOURCE_TREE_SNAPSHOT = fileURLToPath(new URL("../data/models-dev.json", import.meta.url));

/**
 * The same snapshot as it sits beside a bundled artifact.
 *
 * @remarks A bundler flattens this module into a single file, so
 *   {@link SOURCE_TREE_SNAPSHOT} no longer names anything. Builds that emit an
 *   artifact copy the snapshot next to it - see `packages/code/tooling/artifact/build.ts`,
 *   whose `ASSETS` list must stay in step with this path.
 */
const ARTIFACT_SNAPSHOT = fileURLToPath(new URL("./models-dev.json", import.meta.url));

/** A catalog is metadata, and neither a poisoned cache nor a response may exceed this budget. */
const MAX_MODEL_CATALOG_BYTES = 8 * 1024 * 1024;
const MODEL_CATALOG_FETCH_TIMEOUT_MS = 30_000;

function readCatalogFile(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_MODEL_CATALOG_BYTES) throw new Error("model catalog exceeds byte limit");
    const buffer = Buffer.allocUnsafe(Math.min(size + 1, MAX_MODEL_CATALOG_BYTES + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_MODEL_CATALOG_BYTES) throw new Error("model catalog exceeds byte limit");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve the shipped snapshot's path.
 *
 * @returns the first of {@link SOURCE_TREE_SNAPSHOT} and {@link ARTIFACT_SNAPSHOT}
 *   that exists, or the former when neither does, so the ensuing read reports the
 *   location a developer expects.
 * @remarks Both are resolved against `import.meta.url`, never `process.cwd()` -
 *   the agent runs in the user's workspace, so a cwd-relative read finds nothing.
 */
function bundlePath(): string {
  return (
    [SOURCE_TREE_SNAPSHOT, ARTIFACT_SNAPSHOT].find((p) => existsSync(p)) ?? SOURCE_TREE_SNAPSHOT
  );
}

let bundleCache: CatalogData | undefined;

function loadBundle(): CatalogData {
  if (!bundleCache) {
    bundleCache = catalogDataSchema.parse(JSON.parse(readCatalogFile(bundlePath())));
  }
  return bundleCache;
}

function cachePath(configDir: string): string {
  return globalPaths(configDir).modelsCacheFile;
}

/**
 * Loads catalog JSON from `configDir/cache/models-dev.json` when valid, otherwise
 * the bundled snapshot.
 *
 * @param configDir - config dir holding the refresh cache; when omitted, the
 *   bundle is used directly.
 * @returns the parsed catalog and which source it came from.
 * @remarks A missing, unreadable, or schema-invalid cache is silently ignored and
 *   the bundle is returned instead, so a corrupt cache never breaks loading.
 */
export function loadCatalogData(
  configDir?: string,
  logger: Logger = NOOP_LOGGER,
): {
  data: CatalogData;
  source: "cache" | "bundle";
} {
  if (configDir !== undefined) {
    const path = cachePath(configDir);
    try {
      const parsed = catalogDataSchema.safeParse(JSON.parse(readCatalogFile(path)));
      if (parsed.success) return { data: parsed.data, source: "cache" };
      reportCacheInvalid(logger, path, "the cached catalog does not match the catalog schema");
    } catch (error) {
      reportCacheRead(logger, path, error);
    }
  }
  return { data: loadBundle(), source: "bundle" };
}

/**
 * Report a cache file that exists but cannot be used.
 *
 * @param logger - the catalog's logger.
 * @param path - the cache file.
 * @param cause - why it was rejected.
 * @remarks The fallback to the bundle is correct; doing it in silence is not.
 *   Without this line a successful `models.refresh()` and a corrupt cache are
 *   the same observable state — a catalog that never changes.
 */
function reportCacheInvalid(logger: Logger, path: string, cause: string): void {
  logger.warn(
    { event: "kernel.models.cache_invalid", path, cause },
    "the refreshed model catalog cache is unusable and the bundled snapshot is served instead; a refresh result is being ignored",
  );
}

/**
 * Report a cache file that could not be read at all.
 *
 * @param logger - the catalog's logger.
 * @param path - the cache file.
 * @param error - the raw failure; an absent cache is the normal first-run state
 *   and is not reported.
 */
function reportCacheRead(logger: Logger, path: string, error: unknown): void {
  if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
  reportCacheInvalid(logger, path, error instanceof Error ? error.message : String(error));
}

/**
 * Atomically writes catalog data to the cache path and invalidates the in-memory
 * bundle cache.
 *
 * @param configDir - config dir under which the cache file is written.
 * @param data - the catalog payload to persist.
 * @returns the provider and model counts written, plus the cache file path.
 * @remarks Clears the memoized {@link loadBundle} result so the next in-process
 *   read reflects the new data rather than a stale bundle snapshot.
 */
export function writeCatalogCache(
  configDir: string,
  data: CatalogData,
): { providers: number; models: number; path: string } {
  const target = cachePath(configDir);
  const serialized = JSON.stringify(data) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > MAX_MODEL_CATALOG_BYTES) {
    throw new Error(`model catalog exceeds ${String(MAX_MODEL_CATALOG_BYTES)} bytes`);
  }
  writeFileAtomicSync(target, serialized);
  bundleCache = undefined;
  const models = Object.values(data.providers).reduce(
    (n, p) => n + Object.keys(p.models).length,
    0,
  );
  return { providers: Object.keys(data.providers).length, models, path: target };
}

const CAPABILITY_ALIASES: Record<string, string> = { tool_call: "tool_calling" };

function normalizeCapabilities(caps: string[]): string[] {
  return [...new Set(caps.map((c) => CAPABILITY_ALIASES[c] ?? c))];
}

function toModels(data: CatalogProviderData): CatalogModel[] {
  return Object.entries(data.models)
    .map(([modelId, m]) => {
      const model: CatalogModel = { modelId };
      if (m.name) model.name = m.name;
      if (m.context) model.context_window_tokens = m.context;
      if (m.output) model.max_output_tokens = m.output;
      if (m.capabilities?.length) model.capabilities = normalizeCapabilities(m.capabilities);
      if (m.reasoning_efforts) model.reasoning_efforts = [...m.reasoning_efforts];
      if (m.cost) model.cost = m.cost;
      return { model, releaseDate: m.release_date ?? "" };
    })
    .sort((a, b) => {
      if (a.releaseDate !== b.releaseDate) return b.releaseDate.localeCompare(a.releaseDate);
      return a.model.modelId.localeCompare(b.model.modelId);
    })
    .map((entry) => entry.model);
}

function toProvider(data: CatalogProviderData): CatalogProvider {
  const apiKeyEnv = data.env?.[0];
  return {
    id: data.id,
    name: data.name,
    kind: data.kind,
    base_url: data.base_url,
    api_key_env: apiKeyEnv,
    needsBaseUrl: data.kind === "openai-compatible" && !data.base_url,
    models: toModels(data),
  };
}

function safeName(id: string, taken: ReadonlySet<string>): string {
  const base =
    id
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "provider";
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Builds a {@link ModelsCatalog} from cache (when present) or the bundled
 * models.dev snapshot.
 *
 * @param configDir - config dir whose cache is preferred; omitted uses the bundle.
 * @returns a read-only catalog view; its providers are sorted by id and its
 *   {@link ModelsCatalog.fill} prefers a same-kind provider before falling back
 *   to any provider.
 */
export function createModelsCatalog(
  configDir?: string,
  logger: Logger = NOOP_LOGGER,
): ModelsCatalog {
  const { data, source } = loadCatalogData(configDir, logger);
  const byId = new Map(Object.entries(data.providers));
  const list = [...byId.values()].map(toProvider).sort((a, b) => a.id.localeCompare(b.id));
  const listById = new Map(list.map((p) => [p.id, p]));

  function provider(id: string): CatalogProvider | undefined {
    return listById.get(id);
  }

  function seed(providerId: string, taken: ReadonlySet<string>): ProviderConfig | undefined {
    const p = provider(providerId);
    if (!p) return undefined;
    const config: ProviderConfig = { name: safeName(p.id, taken), kind: p.kind };
    if (p.base_url) config.base_url = p.base_url;
    if (p.api_key_env) config.api_key_env = p.api_key_env;
    return config;
  }

  function fill(kind: ProviderKind, modelId: string): CatalogModel | undefined {
    const sameKind = list.filter((p) => p.kind === kind);
    for (const p of [...sameKind, ...list]) {
      const hit = p.models.find((m) => m.modelId === modelId);
      if (hit) return hit;
    }
    return undefined;
  }

  return {
    source,
    providers: () => list,
    provider,
    models: (providerId) => provider(providerId)?.models ?? [],
    seed,
    fill,
  };
}

/**
 * Resolves token cost for a `provider/model` ref against configured providers and
 * the catalog.
 *
 * @param catalog - the catalog to price against.
 * @param providers - the user's configured providers; the ref's provider segment
 *   is matched against their `name`.
 * @param modelRef - a `provider/model` reference (parsed by `parseModelRef`).
 * @returns the model's {@link CatalogCost}, or `undefined` when the provider is
 *   not configured or no matching model price is found.
 * @remarks Prefers an exact catalog hit under the configured provider's own name,
 *   then falls back to a same-kind match via {@link ModelsCatalog.fill}.
 */
export function resolveModelPrice(
  catalog: ModelsCatalog,
  providers: ProviderConfig[],
  modelRef: string,
): CatalogCost | undefined {
  const { provider: providerName, modelId } = parseModelRef(modelRef);
  const providerConfig = providers.find((p) => p.name === providerName);
  if (!providerConfig) return undefined;
  const exact = catalog.provider(providerConfig.name)?.models.find((m) => m.modelId === modelId);
  if (exact?.cost) return exact.cost;
  return catalog.fill(providerConfig.kind, modelId)?.cost;
}

/**
 * What a published price shape says about how a model's prompt cache is asked
 * for.
 *
 * @param cost - the catalog's price entry, or `undefined`.
 * @returns `"explicit"` when the provider charges to create a cache entry,
 *   `"implicit"` when reads are priced but creation is free, `"unknown"` when
 *   the catalog says nothing.
 * @remarks models.dev publishes no `supports_caching` flag. What it publishes is
 *   the *shape of the price*, and that shape is the signal: a provider that
 *   charges to **create** an entry is one where creation is an act the caller
 *   performs, so the request must carry a marker.
 *
 *   Two comparisons carry the whole function and neither may be simplified:
 *
 *   - `> 0`, never a presence check. **179 models publish `cache_write: 0`**,
 *     meaning creation is free — which is implicit caching. Treating presence as
 *     explicit would bill every one of them the 1.25x creation multiplier for a
 *     marker they never wanted.
 *   - `!== undefined`, never truthiness. **131 models publish `cache_read: 0`**,
 *     where reads are free rather than absent, and `0` is falsy in JavaScript —
 *     so `cost.cache_read && ...` silently excludes all of them.
 *
 *   `"unknown"` means *the catalog does not know*, and must never be rendered as
 *   "this model has no cache" or used to disable anything. Two models are known
 *   to be mis-described today: `alibaba/qwen3.6-flash` publishes no `cache_read`
 *   while the vendor bills hits at 10%, and `alibaba/qwen-flash` publishes
 *   neither field while the vendor documents an implicit cache for it.
 *
 *   Takes a structural parameter rather than {@link CatalogCost} so the one
 *   implementation also serves a UI holding the protocol's `ModelCost`; the two
 *   are identical on exactly these fields, and a second copy is a second chance
 *   to get the two comparisons above wrong.
 */
export function cacheModeOf(
  cost: { cache_read?: number; cache_write?: number } | undefined,
): "explicit" | "implicit" | "unknown" {
  if ((cost?.cache_write ?? 0) > 0) return "explicit";
  if (cost?.cache_read !== undefined) return "implicit";
  return "unknown";
}

/**
 * What a configured model's `prompt_cache` should be, given what the catalog
 * prices and what kind of endpoint will serve it.
 *
 * @param cost - the catalog's pricing for this model, or `undefined` on a miss.
 * @param kind - the configured provider's kind.
 * @returns the mode to store, or `undefined` to leave the field absent.
 * @remarks Called where a model is **configured** — the TUI writing it into
 *   `settings.json` — and deliberately not where a run is assembled. Deriving
 *   per request made the bundled catalog a hard dependency of every run for a
 *   value that, after the kind cap below, cannot change a single byte on the
 *   wire: the adapter marks Anthropic whenever the mode is not `"off"`, so
 *   `"explicit"`, `"implicit"` and absent are one case there, and on
 *   `openai-compatible` it marks only on `"explicit"`, which this never returns.
 *   Stored in settings the value is visible, editable, and stable across a
 *   catalog refresh — and a memory continuation pass reads the same one its
 *   subject run did, which is what keeps their two prefixes byte-identical.
 *
 *   A `"unknown"` catalog answer yields `undefined` rather than `"off"`: absence
 *   of information is not evidence of absence, and the adapter already treats an
 *   absent mode conservatively.
 *
 *   **It never returns `"explicit"` for kind `openai-compatible`; it settles for
 *   `"implicit"`.** The catalog describes a *model*, while honouring
 *   `cache_control` is a property of the *endpoint*, and those two coincide only
 *   where the SDK talks to the vendor's own API. `openai-compatible` means an
 *   arbitrary `base_url`, and the ones people configure are overwhelmingly
 *   routers: 642 of the 680 catalog models whose pricing reads `"explicit"` sit
 *   behind one, led by pioneer, amazon-bedrock, openrouter, crossmodel, zenmux,
 *   vercel and kilo — against 30 on `anthropic` and 8 on `openai`, which does
 *   not emit markers at all. A router picks a different upstream per request,
 *   and the upstreams disagree about what `cache_control` means.
 *
 *   Measured on OpenRouter serving `deepseek/deepseek-v4-flash`, same transcript,
 *   upstream pinned so routing could not confound it. On DeepInfra the marker is
 *   a perfect no-op: six iterations with and six without produced identical
 *   `input` and `cached` counts, 90.9% either way. On Novita the same marker
 *   turns a **deterministic** 92.5% hit rate — four independent runs, 2,838
 *   uncached tokens each, iteration for iteration identical — into a lottery
 *   that returned 54.6%, 73.0%, 92.5% and 51.9%. Never better than no marker,
 *   sometimes six times worse, and which upstream serves a given call is not
 *   something the caller chooses: `provider.order` is a preference list, not
 *   affinity, and a genuine single-upstream pin turns that upstream's 429 into a
 *   failed run.
 *
 *   Kept separate from {@link cacheModeOf} because the two answer different
 *   questions: that one reads pricing and is about the model, this one is about
 *   whether the endpoint can be trusted with what the pricing implies. Folding
 *   them would make the pricing helper — which the TUI also calls, to *describe*
 *   the catalog rather than to decide anything — start lying about what the
 *   catalog says.
 *
 *   This removes the silent default, not the escape hatch: an author who writes
 *   `"explicit"` on an openai-compatible provider still gets markers, because
 *   nothing here ever overwrites a value that is already set.
 */
export function derivePromptCacheMode(
  cost: { cache_read?: number; cache_write?: number } | undefined,
  kind: ProviderConfig["kind"],
): "explicit" | "implicit" | undefined {
  const mode = cacheModeOf(cost);
  if (mode === "unknown") return undefined;
  return mode === "explicit" && kind === "openai-compatible" ? "implicit" : mode;
}

const MODELS_DEV_URL = "https://models.dev/api.json";

const KIND_BY_NPM: Record<string, ProviderKind> = {
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/openai": "openai",
  "@ai-sdk/google": "google",
};

/**
 * Endpoints for providers models.dev describes but does not give a base URL for.
 *
 * @remarks A gap-filler, not a registry. Every entry here is an
 * OpenAI-compatible provider — {@link KIND_BY_NPM} already routes the three with
 * first-party SDKs — and the value is the one thing a user cannot reasonably be
 * asked to supply, since it is fixed per provider and getting it wrong produces
 * an authentication failure rather than a legible error.
 *
 * Membership is therefore not an endorsement and not exhaustive: a provider
 * absent from this table works exactly as before, with the operator setting
 * `base_url` themselves. That is what keeps the list from needing to be
 * complete, and what makes adding one a convenience rather than a contract.
 */
const KNOWN_BASE_URL: Record<string, string> = {
  togetherai: "https://api.together.xyz/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
  perplexity: "https://api.perplexity.ai",
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asPosInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}
function asNonNegNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}
function asCost(v: unknown): CatalogCost | undefined {
  const c = asRecord(v);
  const input = asNonNegNumber(c.input);
  const output = asNonNegNumber(c.output);
  if (input === undefined || output === undefined) return undefined;
  const cost: CatalogCost = { input, output };
  const cacheRead = asNonNegNumber(c.cache_read);
  if (cacheRead !== undefined) cost.cache_read = cacheRead;
  const cacheWrite = asNonNegNumber(c.cache_write);
  if (cacheWrite !== undefined) cost.cache_write = cacheWrite;
  return cost;
}
function kindOfNpm(npm: unknown): ProviderKind {
  const key = asString(npm);
  return (key && KIND_BY_NPM[key]) || "openai-compatible";
}

/**
 * Projects a raw models.dev API payload into validated {@link CatalogData}.
 *
 * @param raw - the untyped models.dev JSON (defensively read field by field).
 * @returns the normalized catalog, its `source` set to the models.dev API URL.
 * @remarks Skips any model carrying a `status` (preview/deprecated) or a `~`-prefixed
 *   alias id; derives `tool_calling`/`reasoning`/`vision` capabilities from the raw
 *   flags; and fills a provider `base_url` from the payload's `api` field or the
 *   {@link KNOWN_BASE_URL} table for known OpenAI-compatible hosts.
 */
export function projectModelsDevApi(raw: unknown): CatalogData {
  const providers: Record<string, CatalogProviderData> = {};
  for (const [pid, value] of Object.entries(asRecord(raw))) {
    const p = asRecord(value);
    const kind = kindOfNpm(p.npm);
    const models: Record<string, CatalogModelData> = {};
    for (const [mid, mvalue] of Object.entries(asRecord(p.models))) {
      const m = asRecord(mvalue);
      if (asString(m.status)) continue;
      if (mid.startsWith("~")) continue;
      const limit = asRecord(m.limit);
      const modalities = asRecord(m.modalities);
      const input = modalities.input;
      const caps: string[] = [];
      if (m.tool_call) caps.push("tool_calling");
      if (m.reasoning) caps.push("reasoning");
      if (Array.isArray(input) && input.includes("image")) caps.push("vision");
      const entry: CatalogModelData = {};
      const name = asString(m.name);
      if (name) entry.name = name;
      const ctx = asPosInt(limit.context);
      if (ctx) entry.context = ctx;
      const out = asPosInt(limit.output);
      if (out) entry.output = out;
      if (caps.length) entry.capabilities = caps;
      const reasoningOptions = Array.isArray(m.reasoning_options) ? m.reasoning_options : [];
      const effortOption = reasoningOptions
        .map(asRecord)
        .find((option) => asString(option.type) === "effort");
      if (Array.isArray(effortOption?.values)) {
        entry.reasoning_efforts = effortOption.values.filter(
          (value): value is string => typeof value === "string",
        );
      }
      const releaseDate = asString(m.release_date);
      if (releaseDate) entry.release_date = releaseDate;
      const cost = asCost(m.cost);
      if (cost) entry.cost = cost;
      models[mid] = entry;
    }
    const base = asString(p.api) ?? KNOWN_BASE_URL[pid];
    const env = Array.isArray(p.env) ? p.env.filter((e): e is string => typeof e === "string") : [];
    const entry: CatalogProviderData = { id: pid, name: asString(p.name) ?? pid, kind, models };
    if (base) entry.base_url = base;
    if (env.length) entry.env = env;
    providers[pid] = entry;
  }
  return { source: MODELS_DEV_URL, providers };
}

/**
 * Fetches the live models.dev JSON API.
 *
 * @returns the raw decoded JSON payload, to be passed to {@link projectModelsDevApi}.
 * @throws Error when the HTTP response is not `ok` (message carries the status).
 */
export async function fetchModelsDevApi(): Promise<unknown> {
  const res = await fetch(MODELS_DEV_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(MODEL_CATALOG_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`models.dev returned ${res.status} ${res.statusText}`);
  if (res.body === null) throw new Error("models.dev returned an empty body");
  const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MODEL_CATALOG_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`models.dev response exceeds ${String(MAX_MODEL_CATALOG_BYTES)} bytes`);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(parts.join("")) as unknown;
}

/**
 * Whether a projection is worth writing over the catalog the host already has.
 *
 * @param data - the freshly projected catalog.
 * @returns `true` when at least one provider carries at least one model.
 * @remarks
 * Structural, not a count floor. {@link projectModelsDevApi} reads every provider's models through
 * `asRecord(p.models)`, so a change to the payload's root shape does not fail — it collapses at that
 * one nesting key and projects providers with no models at all. Measured on the committed snapshot:
 * wrapping it one level deep, the shape an added envelope would produce, projects to 1 provider and
 * 0 models; an array root projects to 3 and 0. Since a written cache is preferred over the vendored
 * bundle, such a projection would shadow a good catalog permanently, and `--refresh` could not
 * repair it because the same fetch produces the same cache.
 *
 * A count floor was rejected as the test: it needs re-tuning as the market moves, and any figure
 * large enough to be meaningful also rejects the single-provider, single-model payloads the refresh
 * tests legitimately mock. "Some provider has a model" catches every root-shape change a floor
 * catches and admits those.
 */
function isPlausibleCatalog(data: CatalogData): boolean {
  return Object.values(data.providers).some(
    (provider) => Object.keys(provider.models ?? {}).length > 0,
  );
}

/**
 * Downloads models.dev, projects it into catalog form, and writes the local cache
 * under `configDir`.
 *
 * @param configDir - config dir under which the refreshed cache is written.
 * @returns the provider and model counts written, plus the cache file path.
 * @throws Error when the models.dev fetch fails (see {@link fetchModelsDevApi}), or when the
 *   projection carries no models at all — see {@link isPlausibleCatalog} for why that is refused
 *   rather than written.
 */
export async function refreshModelsCatalog(
  configDir: string,
): Promise<{ providers: number; models: number; path: string }> {
  const data = projectModelsDevApi(await fetchModelsDevApi());
  if (!isPlausibleCatalog(data)) {
    throw new Error(
      "models.dev returned a payload this build cannot read: it projected to no models at all. " +
        "The existing catalog is kept rather than replaced.",
    );
  }
  return writeCatalogCache(configDir, data);
}

function toProtoModel(m: CatalogModel): ProtoCatalogModel {
  return {
    id: m.modelId,
    ...(m.name !== undefined ? { name: m.name } : {}),
    ...(m.context_window_tokens !== undefined ? { context_window: m.context_window_tokens } : {}),
    ...(m.max_output_tokens !== undefined ? { max_output: m.max_output_tokens } : {}),
    ...(m.capabilities !== undefined ? { capabilities: m.capabilities } : {}),
    ...(m.reasoning_efforts !== undefined ? { reasoning_efforts: m.reasoning_efforts } : {}),
    ...(m.cost !== undefined ? { cost: m.cost } : {}),
  };
}

function toProtoProvider(p: CatalogProvider): ProtoCatalogProvider {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    ...(p.base_url !== undefined ? { base_url: p.base_url } : {}),
    ...(p.api_key_env !== undefined ? { api_key_env: p.api_key_env } : {}),
    needs_base_url: p.needsBaseUrl,
    models: p.models.map(toProtoModel),
  };
}

/**
 * Protocol {@link ModelCatalogService} that serves the local catalog and can
 * refresh from models.dev.
 *
 * @param configDir - config dir whose cache backs the served catalog and receives
 *   refreshes.
 * @returns a service whose `get` projects the current local catalog to the wire
 *   {@link ProtoModelCatalog} and whose `refresh` first downloads and re-caches
 *   from models.dev, then returns the rebuilt catalog.
 * @throws Error from `refresh` when the models.dev fetch fails (see
 *   {@link fetchModelsDevApi}).
 */
export function createModelCatalogService(
  configDir: string,
  logger: Logger = NOOP_LOGGER,
): ModelCatalogService {
  const build = (): ProtoModelCatalog => {
    const cat = createModelsCatalog(configDir, logger);
    const providers = cat.providers().map(toProtoProvider);
    logger.info(
      {
        event: "kernel.models.catalog",
        source: cat.source,
        providers: providers.length,
        models: providers.reduce((n, p) => n + p.models.length, 0),
      },
      "the model catalog was served from this source; a 'bundle' source means no refresh has been cached",
    );
    return { source: cat.source, providers };
  };
  return {
    async get(): Promise<ProtoModelCatalog> {
      return build();
    },
    async refresh(): Promise<ProtoModelCatalog> {
      await refreshModelsCatalog(configDir);
      return build();
    },
    async getEntitled(): Promise<never> {
      throw new Error("subscription catalog unavailable");
    },
    async refreshEntitled(): Promise<never> {
      throw new Error("subscription catalog unavailable");
    },
  };
}
