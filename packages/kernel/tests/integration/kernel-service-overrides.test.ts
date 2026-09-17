import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "@clarvis/capability";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { MockLLM } from "@clarvis/loop/testing";
import { createInProcessKernel } from "../../src/kernel.ts";
import * as configServices from "../../src/config/config-service.ts";
import * as secrets from "../../src/secrets/secret-store.ts";
import * as plugins from "../../src/plugins/plugin-service.ts";
import * as models from "../../src/models/model-catalog.ts";
import * as auth from "../../src/subscriptions/unavailable.ts";
import { createMemoryConfigStore } from "../../src/config/memory-config-store.ts";
import { kernelIdentity } from "../helpers/kernel-identity.ts";
import { createRecordingKernelServices } from "../helpers/recording-kernel-services.ts";

it("preserves override identity with ZERO default config, secret, plugin, model or auth factory calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-overrides-"));
  const provided = createRecordingKernelServices([]);
  const spies = [
    spyOn(configServices, "createConfigService"),
    spyOn(secrets, "createSecretService"),
    spyOn(secrets, "createFileSecretStore"),
    spyOn(plugins, "createPluginService"),
    spyOn(models, "createModelCatalogService"),
    spyOn(auth, "createUnavailableProviderAuthService"),
  ];
  try {
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    const kernel = createInProcessKernel({
      workspaceRoot: root,
      globalConfigDir: join(root, "global"),
      home: root,
      ...kernelIdentity(root),
      configStore: createMemoryConfigStore(),
      configService: provided.config,
      secretService: provided.secrets,
      pluginService: provided.plugins,
      modelCatalogService: provided.models,
      providerAuthService: provided.providerAuth,
      extensionProfileService: provided.extensionProfiles,
      deps: {
        executionVisibility: "public",
        env,
        workspaceRoot: root,
        llm: new MockLLM({ script: [] }),
        traceStore: createMemoryTraceStore(),
        connections: createConnectionManager({
          workspace: root,
          factory: defaultMCPClientFactory,
          connectTimeoutMs: env.CLARVIS_MCP_CONNECT_TIMEOUT_MS,
          callTimeoutMs: env.CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS,
        }),
      },
    });
    try {
      for (const name of [
        "config",
        "secrets",
        "plugins",
        "models",
        "providerAuth",
        "extensionProfiles",
      ] as const) {
        expect(kernel[name]).toBe(provided[name]);
        expect(kernel.operatorServices[name]).toBe(provided[name]);
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      await kernel.close();
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
