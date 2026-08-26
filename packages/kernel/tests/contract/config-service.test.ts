import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConfigService,
  createMemoryConfigStore,
  createFileConfigStore,
  type ConfigStore,
} from "../../src/config.ts";

describe("ConfigService over a storage-agnostic ConfigStore (memory)", () => {
  it("exposes builtin misses and a disposable low-level watcher", () => {
    const store = createMemoryConfigStore();
    expect(store.readAgent("builtin", "not-shipped")).toBeNull();
    const stop = store.watch!(() => {});
    stop();
  });

  it("reads/writes settings per scope and merges workspace over global", async () => {
    const config = createConfigService(
      createMemoryConfigStore({ settings: { global: { default_model: "anthropic/opus" } } }),
    );

    const before = await config.getSettings();
    expect(before.merged.default_model).toBe("anthropic/opus");
    expect(before.scopes.workspace).toBeUndefined();

    const after = await config.updateSettings(
      "workspace",
      { default_model: "anthropic/haiku" },
      null,
    );
    expect(after.scopes.workspace?.default_model).toBe("anthropic/haiku");
    expect(after.merged.default_model).toBe("anthropic/haiku");
    expect(after.scopes.global?.default_model).toBe("anthropic/opus");
  });

  it("rejects an invalid settings patch with invalid_request", async () => {
    const config = createConfigService(createMemoryConfigStore());
    await expect(
      config.updateSettings("workspace", { default_model: 123 as unknown as string }, null),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects a stale settings revision without overwriting the concurrent writer", async () => {
    const store = createMemoryConfigStore({
      settings: { workspace: { default_model: "anthropic/old" } },
    });
    const config = createConfigService(store);
    const before = await config.getSettings();
    const revision = before.sources.find((source) => source.scope === "workspace")!.revision;
    store.writeSettings("workspace", {
      default_model: "anthropic/concurrent",
      memory: { enabled: false },
    });

    await expect(
      config.updateSettings("workspace", { default_model: "anthropic/stale" }, revision),
    ).rejects.toMatchObject({
      code: "conflict",
      details: {
        scope: "workspace",
        expectedRevision: revision,
        actualRevision: expect.any(String),
      },
    });
    expect((await config.getSettings()).scopes.workspace).toEqual({
      default_model: "anthropic/concurrent",
      memory: { enabled: false },
    });
  });

  it("exposes host sandbox inspection through the config service", async () => {
    const inspection = {
      bubblewrap: { available: true, mode: "fresh-proc" as const, degraded: false },
      toolchains: [],
      extra_paths: [],
      effective_path: ["/usr/bin"],
    };
    const config = createConfigService(createMemoryConfigStore(), {
      inspectSandbox: async () => inspection,
    });
    expect(await config.inspectSandbox({ refresh: true })).toEqual(inspection);
  });

  it("does agent CRUD and 404s a missing agent", async () => {
    const config = createConfigService(createMemoryConfigStore());

    const summary = await config.writeAgent("workspace", "coder", {
      frontmatter: { model: "anthropic/sonnet", description: "writes code" },
      body: "You are a coder.",
    });
    expect(summary).toMatchObject({ name: "coder", scope: "workspace", model: "anthropic/sonnet" });

    const doc = await config.getAgent("workspace", "coder");
    expect(doc.body).toBe("You are a coder.");
    expect(doc.frontmatter.description).toBe("writes code");

    expect((await config.listAgents()).map((a) => a.name)).toContain("coder");

    await config.deleteAgent("workspace", "coder");
    await expect(config.getAgent("workspace", "coder")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects agent names that could escape the agents directory", async () => {
    const config = createConfigService(createMemoryConfigStore());
    const doc = { frontmatter: {}, body: "x" };

    await expect(config.writeAgent("workspace", "../../AGENTS", doc)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(config.getAgent("workspace", "../coder")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(config.deleteAgent("workspace", "coder/name")).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("accepts a dotted agent name on every name-guarded path", async () => {
    const config = createConfigService(createMemoryConfigStore());
    const doc = { frontmatter: { model: "anthropic/sonnet" }, body: "x" };

    const written = await config.writeAgent("workspace", "review.strict", doc);
    expect(written.name).toBe("review.strict");
    expect((await config.getAgent("workspace", "review.strict")).body.trim()).toBe("x");

    const renamed = await config.renameAgent("workspace", "review.strict", "review.v2.strict");
    expect(renamed.name).toBe("review.v2.strict");

    await config.deleteAgent("workspace", "review.v2.strict");
    await expect(config.getAgent("workspace", "review.v2.strict")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects every traversal, separator and plugin-qualified agent name", async () => {
    const config = createConfigService(createMemoryConfigStore());
    const doc = { frontmatter: {}, body: "x" };
    const rejected = [
      "",
      ".",
      "..",
      "...",
      ".hidden",
      "a..b",
      "../coder",
      "..\\coder",
      "a/../b",
      "a\\..\\b",
      "coder/name",
      "coder\\name",
      "/etc/passwd",
      "C:coder",
      "plugin:coder",
      "coder:",
      "coder name",
      "coder\nname",
      "coder\0name",
      "coder%2Fname",
      "coder@2",
      "café",
    ];

    for (const name of rejected) {
      await expect(config.writeAgent("workspace", name, doc)).rejects.toMatchObject({
        code: "invalid_request",
      });
      await expect(config.getAgent("workspace", name)).rejects.toMatchObject({
        code: "invalid_request",
      });
      await expect(config.deleteAgent("workspace", name)).rejects.toMatchObject({
        code: "invalid_request",
      });
      await expect(config.renameAgent("workspace", "coder", name)).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
  });

  it("keeps a rejected traversal name off disk on the file store", async () => {
    const config = createConfigService(createFileConfigStore(tmpConfigDirs()));

    await expect(
      config.writeAgent("workspace", "../escape", { frontmatter: {}, body: "x" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect((await config.listAgents()).filter((a) => a.scope !== "builtin")).toEqual([]);
  });

  it("carries unknown frontmatter keys through a write instead of rejecting them", async () => {
    const config = createConfigService(createMemoryConfigStore());
    const frontmatter = {
      model: "anthropic/sonnet",
      description: "writes code",
      "x-house-style": "terse",
      presentation: { colour: "amber" },
    };

    await config.writeAgent("workspace", "coder", { frontmatter, body: "You are a coder." });

    const doc = await config.getAgent("workspace", "coder");
    expect(doc.frontmatter).toEqual(frontmatter);
  });

  it("projects grants/can_spawn/budget from frontmatter onto the summary", async () => {
    const config = createConfigService(createMemoryConfigStore());
    const summary = await config.writeAgent("workspace", "lead", {
      frontmatter: {
        model: "anthropic/sonnet",
        grants: ["read_workspace", "run_commands"],
        can_spawn: ["explorer"],
        budget: { on_exceed: "escalate", total_token_limit: 200000 },
      },
      body: "You lead.",
    });
    expect(summary.grants).toEqual(["read_workspace", "run_commands"]);
    expect(summary.can_spawn).toEqual(["explorer"]);
    expect(summary.budget).toEqual({ on_exceed: "escalate", total_token_limit: 200000 });

    const listed = (await config.listAgents()).find((a) => a.name === "lead");
    expect(listed?.grants).toEqual(["read_workspace", "run_commands"]);
    expect(listed?.can_spawn).toEqual(["explorer"]);
  });

  it("omits grants/can_spawn/budget when the frontmatter declares none", async () => {
    const config = createConfigService(createMemoryConfigStore());
    const summary = await config.writeAgent("workspace", "bare", {
      frontmatter: { model: "anthropic/sonnet" },
      body: "x",
    });
    expect(summary.grants).toBeUndefined();
    expect(summary.can_spawn).toBeUndefined();
    expect(summary.budget).toBeUndefined();
  });

  it("notifies subscribers on a write and stops after unsubscribe", async () => {
    const config = createConfigService(createMemoryConfigStore());
    const seen: string[] = [];
    const off = config.subscribe(["agents"], (c) => seen.push(c.kind));

    await config.writeAgent("workspace", "a", { frontmatter: {}, body: "x" });
    await config.updateSettings("workspace", { default_model: "anthropic/x" }, null);
    off();
    await config.writeAgent("workspace", "b", { frontmatter: {}, body: "y" });

    expect(seen).toEqual(["agents"]);
  });

  it("reports an absent repair source as null and rejects an apply with its null CAS revision", async () => {
    const config = createConfigService(createMemoryConfigStore());

    expect(await config.previewSettingsRepair("workspace")).toBeNull();
    await expect(config.repairSettings("workspace", "missing-revision")).rejects.toMatchObject({
      code: "conflict",
      details: {
        scope: "workspace",
        expectedRevision: "missing-revision",
        actualRevision: null,
      },
    });
  });

  it("previews and applies a reset when settings JSON is not an object", async () => {
    const store = createMemoryConfigStore({ settings: { workspace: [] as never } });
    const config = createConfigService(store);

    const plan = await config.previewSettingsRepair("workspace");
    expect(plan).toMatchObject({
      scope: "workspace",
      action: "reset",
      reason: "settings JSON must be an object",
    });

    const repaired = await config.repairSettings("workspace", plan!.revision);
    expect(repaired.scopes.workspace).toEqual({});
    expect(await config.previewSettingsRepair("workspace")).toBeNull();
  });

  it("strips an invalid array member by its nearest existing ancestor", async () => {
    const store = createMemoryConfigStore({
      settings: { workspace: { providers: [{}] } as never },
    });
    const config = createConfigService(store);

    const plan = await config.previewSettingsRepair("workspace");
    expect(plan).toMatchObject({ action: "strip", dropped: ["providers.0"] });

    const repaired = await config.repairSettings("workspace", plan!.revision);
    expect(repaired.scopes.workspace).toEqual({ providers: [] });
  });

  it("strips an invalid object field without disturbing valid siblings", async () => {
    const store = createMemoryConfigStore({
      settings: {
        workspace: {
          default_model: 123,
          default_reasoning_effort: "high",
        } as never,
      },
    });
    const config = createConfigService(store);

    const plan = await config.previewSettingsRepair("workspace");
    expect(plan).toMatchObject({ action: "strip", dropped: ["default_model"] });

    const repaired = await config.repairSettings("workspace", plan!.revision);
    expect(repaired.scopes.workspace).toEqual({ default_reasoning_effort: "high" });
  });

  it("falls back to a bounded reset when more than 64 invalid leaves need repair", async () => {
    const store = createMemoryConfigStore({
      settings: {
        workspace: { providers: Array.from({ length: 65 }, () => ({})) } as never,
      },
    });
    const config = createConfigService(store);

    const plan = await config.previewSettingsRepair("workspace");
    expect(plan).toMatchObject({ action: "reset" });
    expect(plan?.action === "reset" ? plan.reason.length : 0).toBeGreaterThan(0);

    const repaired = await config.repairSettings("workspace", plan!.revision);
    expect(repaired.scopes.workspace).toEqual({});
  });

  it("refuses to apply a stale repair when the source has become valid", async () => {
    const store = createMemoryConfigStore({
      settings: { workspace: { default_model: "anthropic/sonnet" } },
    });
    const config = createConfigService(store);
    const document = store.readSettingsDocument("workspace")!;

    expect(await config.previewSettingsRepair("workspace")).toBeNull();
    await expect(config.repairSettings("workspace", document.revision)).rejects.toMatchObject({
      code: "conflict",
      details: { scope: "workspace", expectedRevision: document.revision },
    });
    expect((await config.getSettings()).scopes.workspace).toEqual({
      default_model: "anthropic/sonnet",
    });
  });

  it("uses safe fallbacks when workspace trust and sandbox collaborators are absent", async () => {
    const config = createConfigService(createMemoryConfigStore());

    expect(await config.approveWorkspace()).toMatchObject({ merged: {}, scopes: {} });
    expect(await config.revokeWorkspace()).toMatchObject({ merged: {}, scopes: {} });
    expect(await config.workspaceTrustError()).toBeNull();
    await expect(config.inspectSandbox()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("rejects invalid agent frontmatter before asking the store to write", async () => {
    const config = createConfigService(createMemoryConfigStore());

    await expect(
      config.writeAgent("workspace", "coder", {
        frontmatter: { model: 123 as never },
        body: "x",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(config.getAgent("workspace", "coder")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

function tmpConfigDirs(): { globalDir: string; workspaceConfigDir: string } {
  const root = mkdtempSync(join(tmpdir(), "clarvis-config-service-"));
  return { globalDir: join(root, "global"), workspaceConfigDir: join(root, "workspace") };
}

const STORE_FACTORIES: Array<[string, () => ConfigStore]> = [
  ["memory", () => createMemoryConfigStore()],
  ["file", () => createFileConfigStore(tmpConfigDirs())],
];

describe.each(STORE_FACTORIES)(
  "ConfigService cross-scope agent-name uniqueness (%s store)",
  (_label, makeStore) => {
    it("rejects writeAgent when the name already exists in the other scope", async () => {
      const config = createConfigService(makeStore());
      await config.writeAgent("global", "coder", { frontmatter: {}, body: "global coder" });

      await expect(
        config.writeAgent("workspace", "coder", { frontmatter: {}, body: "workspace coder" }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(config.getAgent("workspace", "coder")).rejects.toMatchObject({
        code: "not_found",
      });
    });

    it("allows overwriting an agent in its own scope without a cross-scope conflict", async () => {
      const config = createConfigService(makeStore());
      await config.writeAgent("workspace", "coder", { frontmatter: {}, body: "v1" });
      await config.writeAgent("workspace", "coder", { frontmatter: {}, body: "v2" });

      expect((await config.getAgent("workspace", "coder")).body.trim()).toBe("v2");
    });

    it("rejects overwriting either copy of a pre-existing legacy conflict", async () => {
      const store = makeStore();
      store.writeAgent("global", "coder", { frontmatter: {}, body: "global" });
      store.writeAgent("workspace", "coder", { frontmatter: {}, body: "workspace" });
      const config = createConfigService(store);

      await expect(
        config.writeAgent("global", "coder", { frontmatter: {}, body: "edited" }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        config.writeAgent("workspace", "coder", { frontmatter: {}, body: "edited" }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect((await config.getAgent("global", "coder")).body.trim()).toBe("global");
      expect((await config.getAgent("workspace", "coder")).body.trim()).toBe("workspace");
    });

    it("renameAgent moves a name within its scope", async () => {
      const config = createConfigService(makeStore());
      await config.writeAgent("workspace", "coder", {
        frontmatter: { model: "anthropic/sonnet" },
        body: "b",
      });

      const summary = await config.renameAgent("workspace", "coder", "coder2");
      expect(summary).toMatchObject({ name: "coder2", scope: "workspace" });
      await expect(config.getAgent("workspace", "coder")).rejects.toMatchObject({
        code: "not_found",
      });
      expect((await config.getAgent("workspace", "coder2")).body.trim()).toBe("b");
    });

    it("renameAgent rejects a same-scope name collision, leaving the old name intact", async () => {
      const config = createConfigService(makeStore());
      await config.writeAgent("workspace", "coder", { frontmatter: {}, body: "coder body" });
      await config.writeAgent("workspace", "explorer", { frontmatter: {}, body: "explorer body" });

      await expect(config.renameAgent("workspace", "coder", "explorer")).rejects.toMatchObject({
        code: "conflict",
      });
      expect((await config.getAgent("workspace", "coder")).body.trim()).toBe("coder body");
    });

    it("renameAgent rejects a cross-scope name collision, leaving the old name intact", async () => {
      const config = createConfigService(makeStore());
      await config.writeAgent("global", "explorer", { frontmatter: {}, body: "global explorer" });
      await config.writeAgent("workspace", "coder", { frontmatter: {}, body: "coder body" });

      await expect(config.renameAgent("workspace", "coder", "explorer")).rejects.toMatchObject({
        code: "conflict",
      });
      expect((await config.getAgent("workspace", "coder")).body.trim()).toBe("coder body");
    });

    it("renameAgent 404s a missing source agent", async () => {
      const config = createConfigService(makeStore());
      await expect(config.renameAgent("workspace", "ghost", "coder")).rejects.toMatchObject({
        code: "not_found",
      });
    });

    it("renameAgent rejects renaming to the same name", async () => {
      const config = createConfigService(makeStore());
      await config.writeAgent("workspace", "coder", { frontmatter: {}, body: "b" });
      await expect(config.renameAgent("workspace", "coder", "coder")).rejects.toMatchObject({
        code: "invalid_request",
      });
    });
  },
);
