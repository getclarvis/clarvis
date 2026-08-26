import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "bun:test";
import { globalPaths } from "@clarvis/paths";
import { recordingLogger } from "../helpers/logger.ts";
import {
  createModelCatalogService,
  createModelsCatalog,
  loadCatalogData,
  writeCatalogCache,
  resolveModelPrice,
  projectModelsDevApi,
  fetchModelsDevApi,
  refreshModelsCatalog,
  type ProviderConfig,
  type CatalogData,
} from "../../src/config.ts";

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "clarvis-model-catalog-"));
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ModelCatalogService (bundle-backed)", () => {
  it("get() serves the bundled catalog mapped to protocol DTOs", async () => {
    const catalog = await createModelCatalogService("/nonexistent-config-dir").get();
    expect(catalog.source).toBe("bundle");
    expect(catalog.providers.length).toBeGreaterThan(0);
    const anthropic = catalog.providers.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.kind).toBe("anthropic");
    expect(anthropic!.models.length).toBeGreaterThan(0);
    const model = anthropic!.models[0]!;
    expect(typeof model.id).toBe("string");
    expect(model).not.toHaveProperty("modelId");
  });

  it("the kernel catalog helper builds seed/fill lookups from the same data", () => {
    const cat = createModelsCatalog("/nonexistent-config-dir");
    expect(cat.source).toBe("bundle");
    const seeded = cat.seed("anthropic", new Set());
    expect(seeded?.kind).toBe("anthropic");
  });

  it("seed() returns undefined for an unknown provider id", () => {
    const cat = createModelsCatalog("/nonexistent-config-dir");
    expect(cat.seed("not-a-real-provider", new Set())).toBeUndefined();
  });

  it("seed() disambiguates a colliding name by walking safeName's suffix loop", () => {
    const cat = createModelsCatalog("/nonexistent-config-dir");
    const taken = new Set(["anthropic", "anthropic-2"]);
    const seeded = cat.seed("anthropic", taken);
    expect(seeded?.name).toBe("anthropic-3");
  });

  it("fill() falls back to any provider when no same-kind provider has the model", () => {
    const cat = createModelsCatalog("/nonexistent-config-dir");
    const hit = cat.fill("google", "claude-opus-4-5");
    expect(hit?.modelId).toBe("claude-opus-4-5");
  });

  it("fill() returns undefined when no provider at all has the model", () => {
    const cat = createModelsCatalog("/nonexistent-config-dir");
    expect(cat.fill("anthropic", "totally-fake-model-id-xyz")).toBeUndefined();
  });

  it("provider()/models() return undefined/empty for an unknown provider id", () => {
    const cat = createModelsCatalog("/nonexistent-config-dir");
    expect(cat.provider("not-a-real-provider")).toBeUndefined();
    expect(cat.models("not-a-real-provider")).toEqual([]);
  });
});

describe("resolveModelPrice", () => {
  const cat = createModelsCatalog("/nonexistent-config-dir");

  it("returns undefined when no configured provider matches the ref's provider segment", () => {
    const providers: ProviderConfig[] = [];
    expect(resolveModelPrice(cat, providers, "anthropic/claude-opus-4-5")).toBeUndefined();
  });

  it("returns undefined when the configured provider's model has no catalog price anywhere", () => {
    const providers: ProviderConfig[] = [{ name: "anthropic", kind: "anthropic" }];
    expect(
      resolveModelPrice(cat, providers, "anthropic/totally-fake-model-id-xyz"),
    ).toBeUndefined();
  });

  it("prefers an exact hit under the configured provider's own name", () => {
    const providers: ProviderConfig[] = [{ name: "anthropic", kind: "anthropic" }];
    const cost = resolveModelPrice(cat, providers, "anthropic/claude-opus-4-5");
    expect(cost?.input).toBe(5);
    expect(cost?.output).toBe(25);
  });

  it("falls back to a same-kind catalog.fill() hit when the config name isn't a catalog id", () => {
    const providers: ProviderConfig[] = [{ name: "my-anthropic", kind: "anthropic" }];
    const cost = resolveModelPrice(cat, providers, "my-anthropic/claude-opus-4-5");
    expect(cost?.input).toBe(5);
    expect(cost?.output).toBe(25);
  });
});

describe("loadCatalogData", () => {
  it("returns the bundle when configDir is omitted", () => {
    const { data, source } = loadCatalogData();
    expect(source).toBe("bundle");
    expect(Object.keys(data.providers).length).toBeGreaterThan(0);
  });

  it("returns the bundle when the cache file does not exist", () => {
    const { source } = loadCatalogData(tmpConfigDir());
    expect(source).toBe("bundle");
  });

  it("returns the bundle when the cache file is present but not valid JSON", () => {
    const dir = tmpConfigDir();
    const cacheDir = join(dir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "models-dev.json"), "{not valid json");
    const { source } = loadCatalogData(dir);
    expect(source).toBe("bundle");
  });

  it("returns the bundle when the cache file fails schema validation", () => {
    const dir = tmpConfigDir();
    const cacheDir = join(dir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "models-dev.json"), JSON.stringify({ providers: "not-a-map" }));
    const { source } = loadCatalogData(dir);
    expect(source).toBe("bundle");
  });

  it("falls back before reading an oversized sparse cache", () => {
    const dir = tmpConfigDir();
    const cacheDir = join(dir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    const path = join(cacheDir, "models-dev.json");
    const fd = openSync(path, "w");
    try {
      truncateSync(path, 64 * 1024 * 1024);
    } finally {
      closeSync(fd);
    }
    expect(loadCatalogData(dir).source).toBe("bundle");
  });

  it("returns cached data when the cache file is valid", () => {
    const dir = tmpConfigDir();
    const data: CatalogData = {
      providers: {
        acme: {
          id: "acme",
          name: "Acme",
          kind: "openai-compatible",
          models: { "acme-1": { name: "Acme One" } },
        },
      },
    };
    writeCatalogCache(dir, data);
    const loaded = loadCatalogData(dir);
    expect(loaded.source).toBe("cache");
    expect(loaded.data.providers.acme?.name).toBe("Acme");
  });
});

describe("writeCatalogCache", () => {
  it("writes the cache file atomically and reports provider/model counts", () => {
    const dir = tmpConfigDir();
    const data: CatalogData = {
      providers: {
        acme: {
          id: "acme",
          name: "Acme",
          kind: "openai-compatible",
          models: { "acme-1": {}, "acme-2": {} },
        },
        other: {
          id: "other",
          name: "Other",
          kind: "openai",
          models: { "other-1": {} },
        },
      },
    };
    const result = writeCatalogCache(dir, data);
    expect(result.providers).toBe(2);
    expect(result.models).toBe(3);
    expect(result.path).toBe(join(dir, "cache", "models-dev.json"));
    expect(existsSync(result.path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(result.path, "utf8")) as CatalogData;
    expect(Object.keys(onDisk.providers)).toEqual(["acme", "other"]);
  });

  it("invalidates the in-memory bundle cache so a later bundle-only read is unaffected", () => {
    const dir = tmpConfigDir();
    const before = loadCatalogData();
    writeCatalogCache(dir, {
      providers: {
        acme: { id: "acme", name: "Acme", kind: "openai-compatible", models: {} },
      },
    });
    const after = loadCatalogData();
    expect(after.source).toBe("bundle");
    expect(Object.keys(after.data.providers)).toEqual(Object.keys(before.data.providers));
  });
});

describe("projectModelsDevApi", () => {
  it("returns an empty catalog for a non-object payload", () => {
    const projected = projectModelsDevApi(null);
    expect(projected.providers).toEqual({});
    expect(projected.source).toBe("https://models.dev/api.json");
  });

  it("normalizes providers and models, skipping deprecated and alias entries", () => {
    const raw = {
      anthropic: {
        npm: "@ai-sdk/anthropic",
        name: "Anthropic",
        api: "https://api.anthropic.com/v1",
        env: ["ANTHROPIC_API_KEY", 42, null],
        models: {
          "claude-old": { name: "Claude Old", status: "deprecated" },
          "~claude-alias": { name: "Claude Alias" },
          "claude-good": {
            name: "Claude Good",
            limit: { context: 200000, output: 8192 },
            modalities: { input: ["text", "image"] },
            tool_call: true,
            reasoning: true,
            reasoning_options: [
              { type: "effort", values: ["low", "medium", "high", "max"] },
              { type: "budget_tokens", min: 1024 },
            ],
            release_date: "2026-01-01",
            cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
          },
          "claude-bare": {},
        },
      },
      togetherai: {
        models: {
          "some-model": { cost: { input: 1 } },
        },
      },
      unknownkind: {
        npm: "not-a-known-npm",
        models: {},
      },
      badprovider: "not-an-object",
    };

    const projected = projectModelsDevApi(raw);

    const anthropic = projected.providers.anthropic!;
    expect(anthropic.kind).toBe("anthropic");
    expect(anthropic.base_url).toBe("https://api.anthropic.com/v1");
    expect(anthropic.env).toEqual(["ANTHROPIC_API_KEY"]);
    expect(Object.keys(anthropic.models)).toEqual(["claude-good", "claude-bare"]);
    const good = anthropic.models["claude-good"]!;
    expect(good.name).toBe("Claude Good");
    expect(good.context).toBe(200000);
    expect(good.output).toBe(8192);
    expect(good.capabilities).toEqual(["tool_calling", "reasoning", "vision"]);
    expect(good.reasoning_efforts).toEqual(["low", "medium", "high", "max"]);
    expect(good.release_date).toBe("2026-01-01");
    expect(good.cost).toEqual({ input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 });
    expect(anthropic.models["claude-bare"]).toEqual({});

    const together = projected.providers.togetherai!;
    expect(together.kind).toBe("openai-compatible");
    expect(together.base_url).toBe("https://api.together.xyz/v1");
    expect(together.name).toBe("togetherai");
    expect(together.env).toBeUndefined();
    expect(together.models["some-model"]).toEqual({});

    const unknown = projected.providers.unknownkind!;
    expect(unknown.kind).toBe("openai-compatible");
    expect(unknown.base_url).toBeUndefined();

    const bad = projected.providers.badprovider!;
    expect(bad.kind).toBe("openai-compatible");
    expect(bad.models).toEqual({});
    expect(bad.base_url).toBeUndefined();
    expect(bad.name).toBe("badprovider");
  });
});

describe("fetchModelsDevApi", () => {
  it("returns the decoded JSON on a successful response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const payload = await fetchModelsDevApi();
    expect(payload).toEqual({ ok: true });
  });

  it("throws with the status when the response is not ok", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", {
        status: 503,
        statusText: "Service Unavailable",
      })) as unknown as typeof fetch;
    await expect(fetchModelsDevApi()).rejects.toThrow(/503/);
  });

  it("cancels a streamed response at the catalog byte bound", async () => {
    let pulls = 0;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(1024 * 1024));
            if (pulls === 20) controller.close();
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await expect(fetchModelsDevApi()).rejects.toThrow(/exceeds/);
    expect(pulls).toBeLessThan(20);
  });
});

describe("refreshModelsCatalog", () => {
  it("downloads, projects, and caches the models.dev payload", async () => {
    const dir = tmpConfigDir();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          acme: {
            npm: "@ai-sdk/openai",
            name: "Acme",
            models: { "acme-1": { name: "Acme One" } },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const result = await refreshModelsCatalog(dir);
    expect(result.providers).toBe(1);
    expect(result.models).toBe(1);
    expect(existsSync(result.path)).toBe(true);

    const reread = loadCatalogData(dir);
    expect(reread.source).toBe("cache");
    expect(reread.data.providers.acme?.kind).toBe("openai");
  });

  it("refuses a payload that projects to no models, keeping the catalog it has", async () => {
    // `projectModelsDevApi` reads a provider's models through `asRecord(p.models)`, so a change to
    // the payload's root shape does not fail - it projects providers with no models. A written cache
    // is preferred over the bundle, so such a projection would shadow a good catalog permanently,
    // and `--refresh` could not repair it: the same fetch produces the same cache.
    const dir = tmpConfigDir();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          providers: {
            acme: {
              npm: "@ai-sdk/openai",
              name: "Acme",
              models: { "acme-1": { name: "Acme One" } },
            },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await expect(refreshModelsCatalog(dir)).rejects.toThrow(/no models at all/);
    expect(loadCatalogData(dir).source).toBe("bundle");
  });

  it("propagates the fetch failure without writing a cache", async () => {
    const dir = tmpConfigDir();
    globalThis.fetch = (async () =>
      new Response("nope", {
        status: 500,
        statusText: "Internal Server Error",
      })) as unknown as typeof fetch;
    await expect(refreshModelsCatalog(dir)).rejects.toThrow(/500/);
    expect(loadCatalogData(dir).source).toBe("bundle");
  });
});

describe("createModelCatalogService.refresh", () => {
  it("refreshes the cache from models.dev then serves the rebuilt catalog", async () => {
    const dir = tmpConfigDir();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          acme: {
            npm: "@ai-sdk/anthropic",
            name: "Acme",
            models: { "acme-1": { name: "Acme One" } },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const service = createModelCatalogService(dir);
    const refreshed = await service.refresh();
    expect(refreshed.source).toBe("cache");
    const acme = refreshed.providers.find((p) => p.id === "acme");
    expect(acme?.kind).toBe("anthropic");
    expect(acme?.models[0]?.id).toBe("acme-1");

    const got = await service.get();
    expect(got.source).toBe("cache");
    await expect(service.getEntitled("openai-codex")).rejects.toThrow(
      "subscription catalog unavailable",
    );
    await expect(service.refreshEntitled("xai-grok")).rejects.toThrow(
      "subscription catalog unavailable",
    );
  });
});

describe("model catalog observability", () => {
  it("reports a corrupt cache instead of silently serving the bundle", () => {
    const dir = tmpConfigDir();
    const logger = recordingLogger();
    mkdirSync(join(dir, "cache"), { recursive: true });
    writeFileSync(globalPaths(dir).modelsCacheFile, "{ not json");
    expect(loadCatalogData(dir, logger).source).toBe("bundle");
    expect(logger.events("kernel.models.cache_invalid")[0]?.path).toBe(
      globalPaths(dir).modelsCacheFile,
    );
  });

  it("reports a cache whose shape the catalog schema refuses", () => {
    const dir = tmpConfigDir();
    const logger = recordingLogger();
    mkdirSync(join(dir, "cache"), { recursive: true });
    writeFileSync(globalPaths(dir).modelsCacheFile, JSON.stringify({ providers: 7 }));
    expect(loadCatalogData(dir, logger).source).toBe("bundle");
    expect(logger.events("kernel.models.cache_invalid")[0]?.cause).toContain("catalog schema");
  });

  it("says nothing about a first run with no cache at all", () => {
    const dir = tmpConfigDir();
    const logger = recordingLogger();
    expect(loadCatalogData(dir, logger).source).toBe("bundle");
    expect(logger.events("kernel.models.cache_invalid")).toEqual([]);
  });

  it("names the source and size every time the catalog is served", async () => {
    const dir = tmpConfigDir();
    const logger = recordingLogger();
    const catalog = await createModelCatalogService(dir, logger).get();
    const served = logger.events("kernel.models.catalog")[0];
    expect(served).toMatchObject({ source: catalog.source });
    expect(served?.providers).toBe(catalog.providers.length);
    expect(typeof served?.models).toBe("number");
  });
});
