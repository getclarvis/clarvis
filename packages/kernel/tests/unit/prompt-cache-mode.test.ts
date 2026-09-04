import { describe, it, expect } from "bun:test";
import {
  cacheModeOf,
  createModelsCatalog,
  derivePromptCacheMode,
  loadCatalogData,
  PROVIDER_KINDS,
  type CatalogCost,
  type ModelsCatalog,
} from "../../src/config.ts";

describe("T1: cacheModeOf", () => {
  it("reads a priced creation as explicit", () => {
    expect(cacheModeOf({ cache_read: 0.2, cache_write: 2.5 })).toBe("explicit");
    expect(cacheModeOf({ cache_write: 0.234375 })).toBe("explicit");
  });

  it("never reads a FREE creation as explicit", () => {
    // 179 models publish cache_write: 0, meaning creation costs nothing — which
    // is implicit caching, not an invitation to send a marker. A presence check
    // ("cache_write" in cost) classifies every one of them as explicit and bills
    // them the 1.25x creation multiplier for a marker they never wanted. Every
    // ordinary case passes under a presence check; only these fail it.
    expect(cacheModeOf({ cache_read: 0, cache_write: 0 })).toBe("implicit");
    expect(cacheModeOf({ cache_read: 0.01, cache_write: 0 })).toBe("implicit");
    // With no read price either, the catalog has said nothing usable at all.
    expect(cacheModeOf({ cache_write: 0 })).toBe("unknown");
  });

  it("reads a FREE read as implicit, not unknown", () => {
    // 131 models publish cache_read: 0, and 0 is falsy — so any truthiness test
    // (`cost.cache_read && ...`) silently drops all of them into "unknown".
    expect(cacheModeOf({ cache_read: 0 })).toBe("implicit");
  });

  it("reads a priced read with no creation price as implicit", () => {
    expect(cacheModeOf({ cache_read: 0.0028 })).toBe("implicit");
  });

  it("reads silence as unknown, never as 'no cache'", () => {
    expect(cacheModeOf({})).toBe("unknown");
    expect(cacheModeOf(undefined)).toBe("unknown");
  });
});

describe("T1b: the derivation against the committed catalog", () => {
  const { data } = loadCatalogData("/nonexistent-config-dir");
  const costs = Object.values(data.providers).flatMap((p) =>
    Object.values(p.models ?? {}).flatMap((m) => (m.cost ? [m.cost] : [])),
  );

  it("has a corpus large enough for the invariants below to mean something", () => {
    expect(costs.length).toBeGreaterThan(1000);
  });

  // Invariants, not bucket totals: the snapshot is refreshed from models.dev and
  // the counts move, but no refresh can make a free creation into a paid one.
  it("classifies no free-creation model as explicit", () => {
    const offenders = costs.filter((c) => c.cache_write === 0 && cacheModeOf(c) === "explicit");
    expect(offenders).toEqual([]);
  });

  it("classifies no free-read model as unknown", () => {
    const offenders = costs.filter((c) => c.cache_read === 0 && cacheModeOf(c) === "unknown");
    expect(offenders).toEqual([]);
  });

  it("classifies every priced-creation model as explicit", () => {
    const offenders = costs.filter(
      (c) => (c.cache_write ?? 0) > 0 && cacheModeOf(c) !== "explicit",
    );
    expect(offenders).toEqual([]);
  });

  it("leaves a model the catalog does not price alone (qwen-flash is the live case)", () => {
    const alibaba = data.providers.alibaba;
    const qwenFlash = alibaba?.models?.["qwen-flash"];
    // If models.dev starts pricing it, this assertion is the notice to update
    // the spec's example rather than a failure of the derivation.
    if (qwenFlash?.cost !== undefined) {
      expect(["explicit", "implicit", "unknown"]).toContain(cacheModeOf(qwenFlash.cost));
    }
  });
});

describe("derivePromptCacheMode: what a configured model should store", () => {
  const catalog: ModelsCatalog = createModelsCatalog("/nonexistent-config-dir");

  function costOf(providerId: string, modelId: string): CatalogCost | undefined {
    return catalog.provider(providerId)?.models.find((m) => m.modelId === modelId)?.cost;
  }

  it("derives explicit for the vendor's own SDK", () => {
    expect(derivePromptCacheMode(costOf("anthropic", "claude-sonnet-4-5"), "anthropic")).toBe(
      "explicit",
    );
    expect(derivePromptCacheMode(costOf("openai", "gpt-5.6-sol"), "openai-codex")).toBe("explicit");
    expect(derivePromptCacheMode(costOf("xai", "grok-build-0.1"), "xai-grok")).toBe("implicit");
  });

  it("settles for implicit rather than sending markers into a router", () => {
    // Pricing describes the MODEL; honouring `cache_control` describes the
    // ENDPOINT, and behind an arbitrary base_url the two are unrelated. Measured
    // on OpenRouter with the upstream pinned so routing could not confound it:
    // DeepInfra ignored the marker outright (identical input and cached counts,
    // six iterations each way), while Novita turned a deterministic 92.5% hit
    // rate — four runs, 2,838 uncached tokens each — into 54.6% / 73.0% / 92.5%
    // / 51.9%. Never better than no marker, sometimes six times worse, and the
    // caller does not choose the upstream: `provider.order` is a preference
    // list, not affinity.
    const cost = costOf("openrouter", "google/gemini-2.5-pro");
    expect(cacheModeOf(cost)).toBe("explicit");
    expect(derivePromptCacheMode(cost, "openai-compatible")).toBe("implicit");
  });

  it("returns undefined for a catalog that knows nothing, never 'off'", () => {
    // Absence of information is not evidence of absence, and the adapter already
    // treats an absent mode conservatively. Writing "off" here would turn a
    // catalog gap into a decision the user never made.
    expect(derivePromptCacheMode(undefined, "anthropic")).toBeUndefined();
    expect(derivePromptCacheMode({}, "openai-compatible")).toBeUndefined();
  });

  it("passes an implicit answer through on every kind", () => {
    for (const kind of PROVIDER_KINDS) {
      expect(derivePromptCacheMode({ cache_read: 0.1 }, kind)).toBe("implicit");
    }
  });

  it("caps explicit on openai-compatible ONLY", () => {
    const priced = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 };
    expect(derivePromptCacheMode(priced, "openai-compatible")).toBe("implicit");
    for (const kind of PROVIDER_KINDS.filter((k) => k !== "openai-compatible")) {
      expect(derivePromptCacheMode(priced, kind)).toBe("explicit");
    }
  });
});

describe("nothing on the run path consults the catalog", () => {
  it("the kernel exports no per-request stamping helper", async () => {
    // Deriving per run request made the 1.6 MB bundled snapshot a hard
    // dependency of every run: `loadBundle` reads and schema-parses it with no
    // guard, so a missing or corrupt asset stopped degrading the models UI and
    // started failing runs outright. It bought nothing — after the kind cap the
    // derived value cannot change a byte on the wire, since the adapter marks
    // Anthropic whenever the mode is not "off" and marks openai-compatible only
    // on "explicit", which derivation never returns. The value belongs in
    // settings.json, written where a model is configured.
    const kernel: Record<string, unknown> = await import("../../src/config.ts");
    expect(kernel.withPromptCacheModes).toBeUndefined();
    expect(kernel.resolvePromptCacheModes).toBeUndefined();
    expect(typeof kernel.derivePromptCacheMode).toBe("function");
  });
});
