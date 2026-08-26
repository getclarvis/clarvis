import { expect, test } from "bun:test";
import { projectModelsDevApi } from "@clarvis/kernel/config";

const FIXTURE = {
  anthropic: {
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    api: "https://api.anthropic.com/v1",
    env: ["ANTHROPIC_API_KEY", 42],
    models: {
      "claude-x": {
        name: "Claude X",
        tool_call: true,
        reasoning: true,
        release_date: "2026-01-01",
        limit: { context: 200_000, output: 64_000 },
        modalities: { input: ["text", "image"] },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
      "claude-old": { status: "deprecated", limit: { context: 100_000 } },
      "~experimental": { limit: { context: 1 } },
    },
  },
  groq: {
    name: "Groq",
    models: {
      "llama-fast": {
        tool_call: false,
        modalities: { input: ["text"] },
        limit: { context: 0, output: -5 },
        cost: { input: 0.1 },
      },
    },
  },
  weird: "not an object",
};

test("projectModelsDevApi: providers, kind by npm, base url, env filtering", () => {
  const data = projectModelsDevApi(FIXTURE);
  expect(data.source).toBe("https://models.dev/api.json");
  const anthropic = data.providers.anthropic!;
  expect(anthropic.kind).toBe("anthropic");
  expect(anthropic.name).toBe("Anthropic");
  expect(anthropic.base_url).toBe("https://api.anthropic.com/v1");
  expect(anthropic.env).toEqual(["ANTHROPIC_API_KEY"]);
  const groq = data.providers.groq!;
  expect(groq.kind).toBe("openai-compatible");
  expect(groq.base_url).toBe("https://api.groq.com/openai/v1");
  expect(data.providers.weird).toMatchObject({ kind: "openai-compatible", models: {} });
});

test("projectModelsDevApi: model fields, capability mapping, cost incl. cache rates", () => {
  const models = projectModelsDevApi(FIXTURE).providers.anthropic!.models;
  const m = models["claude-x"]!;
  expect(m.name).toBe("Claude X");
  expect(m.context).toBe(200_000);
  expect(m.output).toBe(64_000);
  expect(m.release_date).toBe("2026-01-01");
  expect(m.capabilities).toEqual(["tool_calling", "reasoning", "vision"]);
  expect(m.cost).toEqual({ input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 });
});

test("projectModelsDevApi: deprecated (status) and ~-prefixed models are skipped", () => {
  const models = projectModelsDevApi(FIXTURE).providers.anthropic!.models;
  expect(Object.keys(models)).toEqual(["claude-x"]);
});

test("projectModelsDevApi: invalid limits and partial cost degrade to absent fields", () => {
  const m = projectModelsDevApi(FIXTURE).providers.groq!.models["llama-fast"]!;
  expect(m.context).toBeUndefined();
  expect(m.output).toBeUndefined();
  expect(m.cost).toBeUndefined();
  expect(m.capabilities).toBeUndefined();
});

test("projectModelsDevApi: non-object roots project to an empty catalog", () => {
  expect(projectModelsDevApi(null).providers).toEqual({});
  expect(projectModelsDevApi("junk").providers).toEqual({});
});
