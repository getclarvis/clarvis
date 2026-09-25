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

it("exposes only the built-in Extension Profile in an in-process kernel", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-builtin-profile-"));
  try {
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    const kernel = createInProcessKernel({
      workspaceRoot: root,
      globalConfigDir: join(root, "global"),
      home: root,
      ...kernelIdentity(root),
      configStore: createMemoryConfigStore(),
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
      const builtin = { scope: "builtin" as const, name: "default" };
      expect(await kernel.extensionProfiles.list()).toEqual([{ ref: builtin, immutable: true }]);
      expect(await kernel.extensionProfiles.current()).toMatchObject({
        ref: builtin,
        status: "ready",
      });
      expect(await kernel.extensionProfiles.get(builtin)).toMatchObject({ ref: builtin });
      expect(await kernel.extensionProfiles.inventory()).toEqual({
        plugins: [],
        standalone_skills: [],
      });
      expect(
        await kernel.extensionProfiles.preview(builtin, { selection_scope: "global" }),
      ).toMatchObject({
        target: { ref: builtin },
        delta: { plugins_entering: [], mcp_servers_entering: [] },
        requires_workspace_trust: false,
      });
      await expect(
        kernel.extensionProfiles.get({ scope: "global", name: "custom" }),
      ).rejects.toMatchObject({ code: "unavailable" });
      await expect(
        kernel.extensionProfiles.preview(
          { scope: "global", name: "custom" },
          { selection_scope: "global" },
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      await expect(kernel.extensionProfiles.previewClear("global")).rejects.toMatchObject({
        code: "unavailable",
      });
      const custom = { scope: "global" as const, name: "custom" };
      const definition = { schema_version: 1 as const, plugins: [], skills: [] };
      for (const attempt of [
        () =>
          kernel.extensionProfiles.select(builtin, {
            selection_scope: "global",
            preview_token: "builtin",
          }),
        () => kernel.extensionProfiles.clearSelection("global", { preview_token: "builtin" }),
        () => kernel.extensionProfiles.create({ ref: custom, definition }),
        () =>
          kernel.extensionProfiles.update({ ref: custom, definition, expected_revision: "old" }),
        () => kernel.extensionProfiles.delete(custom, { expected_revision: "old" }),
        () => kernel.extensionProfiles.clone(builtin, custom),
      ]) {
        await expect(attempt()).rejects.toMatchObject({ code: "unavailable" });
      }
    } finally {
      await kernel.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
