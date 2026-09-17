import { expect, test } from "bun:test";
import { createCapabilityRequestView, loadEnv } from "@clarvis/capability";
import { judgeRequestConfig } from "@clarvis/judge/settings";
import { validateBody } from "@clarvis/loop/testing";
import {
  kernelCapabilityRegistry,
  kernelSettingsSchema,
} from "../../src/config/capability-registry.ts";
import { parsePluginManifest } from "../../src/plugins/manifest-schema.ts";

const body = {
  messages: [{ role: "user", content: "go" }],
  servers: [],
  providers: [{ name: "anthropic", kind: "anthropic" }],
  profiles: [{ name: "solo", model: "anthropic/test", tools: [], iteration_limit: 1 }],
  entry: "solo",
  budget: { on_exceed: "stop", total_token_limit: 1000 },
};
const env = loadEnv({});

test("Kernel registers reviewer settings before parsing and keeps the engine request open", () => {
  expect(
    kernelSettingsSchema.parse({ effect_review: { rollout: "local", max_retries: 0 } }),
  ).toMatchObject({ effect_review: { rollout: "local", max_retries: 0 } });
  const request = validateBody(
    { ...body, guard_judge: { guidance: "bounded scope", model: "anthropic/test" } },
    env,
    kernelCapabilityRegistry,
  ).request;
  expect(judgeRequestConfig(createCapabilityRequestView(request))).toEqual({
    guidance: "bounded scope",
    model: "anthropic/test",
  });
  expect(() =>
    validateBody({ ...body, guard_judge: { prompt: "removed" } }, env, kernelCapabilityRegistry),
  ).toThrow(/prompt/);
  expect(() =>
    validateBody(
      { ...body, guard_judge: { model: "missing/test" } },
      env,
      kernelCapabilityRegistry,
    ),
  ).toThrow(/provider/);
});

test("Kernel rejects reviewer configuration in plugins through the registered prohibition", () => {
  const parsed = parsePluginManifest(
    JSON.stringify({ name: "plugin", effect_review: { model: "evil/model" } }),
  );
  expect(parsed.ok).toBe(false);
  if (!parsed.ok && parsed.kind === "schema") {
    expect(parsed.error.issues[0]?.path).toEqual(["effect_review"]);
    expect(parsed.error.issues[0]?.message).toBe(
      "effect_review belongs to the operator, not a plugin",
    );
  }
  expect(parsePluginManifest(JSON.stringify({ name: "plugin", foreign_metadata: true })).ok).toBe(
    true,
  );
});
