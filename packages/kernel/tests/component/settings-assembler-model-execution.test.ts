import { kernelCapabilityRegistry } from "../../src/config/capability-registry.ts";
import { expect, test } from "bun:test";
import { loadEnv, type ModelExecutionInfo, type ModelExecutionResolver } from "@clarvis/capability";
import { validateBody } from "@clarvis/loop/testing";
import { createMemoryConfigStore } from "../../src/config/memory-config-store.ts";
import { createSettingsRunAssembler } from "../../src/runs/settings-assembler.ts";

const info: ModelExecutionInfo = {
  provider: "alias",
  model: "org/model:tag",
  kind: "openai",
  contextWindowTokens: 32000,
  capabilities: ["vision", "tool_calling"],
  reasoningEfforts: ["low"],
  promptCache: "implicit",
};
const resolver: ModelExecutionResolver = {
  resolve: (provider, model) =>
    provider === info.provider && model === info.model ? info : undefined,
};
const start = {
  agent: "lead",
  messages: [{ role: "user" as const, content: "Test catalog." }],
  execution_id: "catalog",
};
function assembler(
  childModel = "alias/org/model:tag",
  catalog: ModelExecutionResolver | undefined = resolver,
) {
  const store = createMemoryConfigStore({
    settings: {
      global: {
        default_model: "alias/org/model:tag",
        providers: [{ name: "alias", kind: "openai", base_url: "https://example.test/v1" }],
      },
    },
  });
  store.writeAgent("global", "lead", { frontmatter: { can_spawn: ["child"] }, body: "Lead." });
  store.writeAgent("global", "child", { frontmatter: { model: childModel }, body: "Child." });
  return createSettingsRunAssembler(
    store,
    catalog === undefined ? {} : { modelExecutionResolver: catalog },
  );
}

test("catalog assembler validates the delegated closure without native transports", () => {
  const body = assembler()(start);
  const { request } = validateBody(body, loadEnv({}), kernelCapabilityRegistry, {
    modelExecutionResolver: resolver,
  });
  expect(request.providers).toEqual([]);
  expect(request.profiles.map((profile) => profile.model)).toEqual([
    "alias/org/model:tag",
    "alias/org/model:tag",
  ]);
  expect(request.prompt_cache_ttl).toBeUndefined();
  expect(() => assembler("alias/missing")(start)).toThrow(/execution catalog/);
});

test("catalog assembler rejects a resolver returning a different provider or model", () => {
  for (const mismatch of [{ provider: "other" }, { model: "other" }]) {
    expect(() =>
      assembler(undefined, { resolve: () => ({ ...info, ...mismatch }) })(start),
    ).toThrow(/execution catalog/);
  }
});

test("native assembler preserves transport declarations and open model resolution", () => {
  const store = createMemoryConfigStore({
    settings: {
      global: {
        default_model: "alias/uncatalogued",
        providers: [{ name: "alias", kind: "openai", base_url: "https://example.test/v1" }],
      },
    },
  });
  store.writeAgent("global", "lead", { frontmatter: {}, body: "Lead." });
  const { request } = validateBody(createSettingsRunAssembler(store)(start), loadEnv({}));
  expect(request.providers[0]?.base_url).toBe("https://example.test/v1");
  expect(request.profiles[0]?.model).toBe("alias/uncatalogued");
});
