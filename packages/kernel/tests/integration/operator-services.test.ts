import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalPaths, workspacePaths } from "@clarvis/paths";
import * as mcp from "@clarvis/mcp-client";
import * as memory from "@clarvis/memory";
import * as plans from "@clarvis/plan";
import * as plugins from "../../src/plugins/plugin-contributions.ts";
import * as pluginService from "../../src/plugins/plugin-service.ts";
import * as tasks from "../../src/tasks/task-provider-factory.ts";
import { SubscriptionManager } from "../../src/subscriptions/manager.ts";
import { createFileSubscriptionStore } from "../../src/subscriptions/store.ts";
import { createOperatorServices } from "../../src/config/operator-services.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clarvis-operator-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "global");
  mkdirSync(workspaceRoot);
  mkdirSync(globalDir);
  return { workspaceRoot, globalDir };
}

it("fences secret authority synchronously after validated writes and never passes secret values", async () => {
  const changes: string[] = [];
  const authority: string[] = [];
  const services = createOperatorServices({
    ...fixture(),
    subscriptions: false,
    onSecretChanged: (name) => {
      changes.push(name);
    },
  });
  const stop = services.onAuthorityChanged((change) => {
    authority.push(
      change.kind === "secret" ? `secret:${change.name}` : `subscription:${change.scheme}`,
    );
  });
  try {
    const setting = services.secrets.set("FIXTURE_KEY", "fixture-only-value");
    expect(changes).toEqual(["FIXTURE_KEY"]);
    await setting;
    await expect(services.secrets.set("invalid name", "fixture-only-value")).rejects.toThrow();
    expect(changes).toEqual(["FIXTURE_KEY"]);
    const deleting = services.secrets.delete("FIXTURE_KEY");
    expect(changes).toEqual(["FIXTURE_KEY", "FIXTURE_KEY"]);
    await deleting;
    expect(authority).toEqual(["secret:FIXTURE_KEY", "secret:FIXTURE_KEY"]);
    stop();
    await services.secrets.set("IGNORED_KEY", "fixture-only-value");
    expect(authority).toHaveLength(2);
    await services.secrets.delete("IGNORED_KEY");
    expect(await services.secrets.listNames()).toEqual([]);
  } finally {
    await services.close();
  }
});

it("chains subscription revocation into the Container broker authority fence", async () => {
  const events: string[] = [];
  const services = createOperatorServices({
    ...fixture(),
    subscriptions: {
      onAuthorityRevoked: (scheme, reason) => {
        events.push(`caller:${scheme}:${reason}`);
      },
    },
  });
  const stop = services.onAuthorityChanged((change) => {
    if (change.kind === "subscription") events.push(`broker:${change.scheme}`);
  });
  try {
    const disconnecting = services.providerAuth.disconnect("openai-codex");
    expect(events).toEqual(["caller:openai-codex:disconnected", "broker:openai-codex"]);
    await disconnecting;

    events.length = 0;
    await expect(services.resolveSubscription!("xai-grok")).rejects.toThrow();
    expect(events).toEqual(["caller:xai-grok:invalidated", "broker:xai-grok"]);
    stop();
  } finally {
    await services.close();
  }
});

it("constructs administrative services without domains, MCP, plugins or network effects", async () => {
  const options = fixture();
  const spies = [
    spyOn(mcp, "createConnectionManager"),
    spyOn(memory, "createFileMemoryStore"),
    spyOn(plans, "createFilePlanRepository"),
    spyOn(plugins, "createPluginContributions"),
    spyOn(pluginService, "createPluginService"),
    spyOn(tasks, "TaskProviderFactory"),
    spyOn(SubscriptionManager.prototype, "resolve"),
    spyOn(SubscriptionManager.prototype, "startDevice"),
    spyOn(SubscriptionManager.prototype, "getEntitled"),
    spyOn(globalThis, "fetch").mockRejectedValue(new Error("forbidden network")),
  ];
  try {
    const services = createOperatorServices(options);
    expect(readdirSync(options.globalDir)).toEqual([]);
    expect(readdirSync(options.workspaceRoot)).toEqual([]);
    expect((await services.config.listAgents()).length).toBeGreaterThan(0);
    expect((await services.models.get()).providers.length).toBeGreaterThan(0);
    expect(
      (await services.providerAuth.list()).every((account) => account.state === "disconnected"),
    ).toBe(true);
    await expect(services.config.inspectSandbox()).rejects.toMatchObject({ code: "unavailable" });
    await services.close();
    await services.close();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(readdirSync(options.globalDir)).toEqual([]);
    expect(readdirSync(options.workspaceRoot)).toEqual([]);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

it("retains settings validation, revisions and trust while withholding plugin contributions and secret values", async () => {
  const options = fixture();
  const workspace = workspacePaths(options.workspaceRoot);
  mkdirSync(workspace.clarvisDir);
  writeFileSync(
    workspace.settingsFile,
    JSON.stringify({ mcpServers: { sentinel: { command: "never-execute-sentinel" } } }),
  );
  writeFileSync(
    globalPaths(options.globalDir).settingsFile,
    JSON.stringify({ enabledPlugins: [{ scope: "global", source: "clarvis", name: "sentinel" }] }),
  );
  const services = createOperatorServices({ ...options, subscriptions: false });
  try {
    const initial = await services.config.getSettings();
    expect(initial.workspace_trust?.state).toBe("unapproved");
    expect(services.configStore.readSettings().active_plugins).toEqual([]);
    expect(services.configStore.readEffectiveAgent("sentinel:agent")).toBeNull();
    await services.config.approveWorkspace();
    expect((await services.config.getSettings()).workspace_trust?.state).toBe("trusted");
    await services.config.revokeWorkspace();
    expect((await services.config.getSettings()).workspace_trust?.state).toBe("unapproved");
    const revision = initial.sources.find((source) => source.scope === "global")!.revision;
    const updated = await services.config.updateSettings(
      "global",
      { default_model: "sentinel/model" },
      revision,
    );
    expect(updated.sources.find((source) => source.scope === "global")!.revision).not.toBe(
      revision,
    );
    await expect(
      services.config.updateSettings("global", { default_model: "other/model" }, revision),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      services.config.updateSettings(
        "global",
        { unknown_sentinel: true },
        updated.sources.find((source) => source.scope === "global")!.revision,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await services.secrets.set("SENTINEL_KEY", "fake-operator-secret-sentinel");
    expect(await services.secrets.listNames()).toEqual(["SENTINEL_KEY"]);
    expect(JSON.stringify(services)).not.toContain("fake-operator-secret-sentinel");
    expect(JSON.stringify(await services.config.getSettings())).not.toContain(
      "fake-operator-secret-sentinel",
    );
    await services.secrets.delete("SENTINEL_KEY");
    expect(await services.secrets.listNames()).toEqual([]);
  } finally {
    await services.close();
  }
});

it("does not refresh an expired sentinel account on construction or status inspection", async () => {
  const options = fixture();
  const store = createFileSubscriptionStore({ dir: options.globalDir });
  await store.mutateAccount("openai-codex", () => ({
    account: {
      access_token: "fake-access-sentinel",
      refresh_token: "fake-refresh-sentinel",
      expires_at: 1,
    },
    result: undefined,
  }));
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("forbidden network"));
  try {
    const services = createOperatorServices(options);
    try {
      expect(await services.providerAuth.list()).toContainEqual({
        scheme: "openai-codex",
        state: "expired",
        authorization_available: true,
      });
      expect(JSON.stringify(services)).not.toContain("fake-access-sentinel");
      expect(JSON.stringify(services)).not.toContain("fake-refresh-sentinel");
      expect(Object.keys(services.providerAuth).sort()).toEqual([
        "cancel",
        "disconnect",
        "list",
        "startDevice",
        "wait",
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await services.close();
    }
  } finally {
    fetchSpy.mockRestore();
  }
});
