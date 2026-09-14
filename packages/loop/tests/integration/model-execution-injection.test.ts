import { expect, test, spyOn } from "../bun-test.ts";
import * as sdk from "@clarvis/llm";
import * as mcp from "@clarvis/mcp-client";
import { loadEnv, NOOP_LOGGER, type ModelExecutionResolver } from "@clarvis/capability";
import { buildExecuteRunDeps } from "../../src/runtime/build-run-deps.ts";
import { executeRun } from "../../src/runtime/execute-run.ts";
import { MockLLM } from "../../src/testing/mock-llm.ts";
import { VALID_REQUEST } from "../helpers/request.ts";

const resolver: ModelExecutionResolver = {
  resolve(provider, model) {
    if (provider !== "catalog" || !["text", "eyes"].includes(model)) return undefined;
    return {
      provider,
      model,
      kind: "openai",
      contextWindowTokens: 12000,
      maxOutputTokens: 128,
      capabilities: model === "eyes" ? ["vision"] : [],
      reasoningEfforts: [],
      promptCache: "implicit",
    };
  },
};

test("injections keep identity, bypass SDK/MCP/OAuth construction and retry, and retain caller ownership", async () => {
  const connections = mcp.createConnectionManager({
    workspace: process.cwd(),
    factory: async () => {
      throw new Error("unexpected MCP connection");
    },
    connectTimeoutMs: 1000,
    callTimeoutMs: 1000,
  });
  const factories = [
    spyOn(sdk, "createAiSdkProvider"),
    spyOn(sdk, "withTransportRetry"),
    spyOn(mcp, "createConnectionManager"),
    spyOn(mcp, "createMCPClientFactory"),
    spyOn(mcp, "createMCPAuthorizationCoordinator"),
  ];
  const close = spyOn(connections, "closeAll");
  const llm = new MockLLM({ script: [{ text: "a cat" }, { text: "done" }] });
  try {
    const built = await buildExecuteRunDeps({
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      logger: NOOP_LOGGER,
      workspaceRoot: process.cwd(),
      builtins: { tools: false, skills: false, hooks: false },
      llm,
      connections,
      modelExecutionResolver: resolver,
      mcpAuthorization: { storeFile: "unused-catalog-oauth.json" },
    });
    try {
      expect(built.deps.llm).toBe(llm);
      expect(built.deps.connections).toBe(connections);
      expect(built.deps.modelExecutionResolver).toBe(resolver);
      for (const factory of factories) expect(factory).not.toHaveBeenCalled();
      const result = await executeRun({
        owner: "catalog-test",
        rawBody: {
          ...VALID_REQUEST,
          providers: [],
          profiles: [{ ...VALID_REQUEST.profiles[0]!, model: "catalog/text" }],
          vision_model: "catalog/eyes",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "what is this?" },
                { type: "image", image: "data:image/png;base64,CAT", mediaType: "image/png" },
              ],
            },
          ],
        },
        deps: built.deps,
      });
      expect(result).toBeDefined();
      expect(llm.calls).toHaveLength(2);
      expect(llm.calls[0]?.model).toBe("eyes");
      expect(llm.calls[0]?.capabilities).toEqual(new Set(["vision"]));
      expect(llm.calls[0]?.maxOutputTokens).toBe(128);
      for (const call of llm.calls) expect(call.providerConfig).toBeUndefined();
      expect(JSON.stringify(llm.calls[1]?.messages)).toContain("a cat");
    } finally {
      await built.dispose();
    }
    expect(close).not.toHaveBeenCalled();
  } finally {
    close.mockRestore();
    for (const factory of factories) factory.mockRestore();
    await connections.closeAll();
  }
});
