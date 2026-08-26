import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect, spyOn } from "bun:test";
import { createConfigService, createFileConfigStore } from "../../src/config.ts";
import {
  MAX_AGENT_DOCUMENT_BYTES,
  MAX_AGENT_DOCUMENTS_PER_SCOPE,
  MAX_CONTEXT_DOCUMENT_BYTES,
  MAX_SETTINGS_DOCUMENT_BYTES,
} from "../../src/config/file-config-store.ts";
import {
  settingsDocumentRevision,
  type AgentRecord,
  type ConfigStore,
} from "../../src/config/config-store.ts";
import { acquireLocalLeaseSync, globalPaths, type LocalLeaseSync } from "@clarvis/paths";
import { recordingLogger, type RecordingLogger } from "../helpers/logger.ts";

/** Seed a global-scope fixture, creating the config group it now lives in. */
function seedGlobal(file: string, content: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/**
 * The agents this store found on disk, i.e. `listAgents` minus the fleet Clarvis
 * ships. Every host has the shipped five; these tests are about the files.
 */
function fileAgents(store: ConfigStore): AgentRecord[] {
  return store.listAgents().filter((agent) => agent.scope !== "builtin");
}

function freshConfig() {
  const root = mkdtempSync(join(tmpdir(), "clarvis-cfg-"));
  const store = createFileConfigStore({
    workspaceRoot: root,
    globalDir: join(root, "global"),
  });
  return { root, config: createConfigService(store) };
}

describe("ConfigService over the file-backed ConfigStore", () => {
  it("round-trips settings to .clarvis/settings.json", async () => {
    const { root, config } = freshConfig();

    await config.updateSettings("workspace", { default_model: "anthropic/sonnet" }, null);

    const onDisk = JSON.parse(readFileSync(join(root, ".clarvis", "settings.json"), "utf8"));
    expect(onDisk.default_model).toBe("anthropic/sonnet");

    const view = await config.getSettings();
    expect(view.scopes.workspace?.default_model).toBe("anthropic/sonnet");
    expect(view.sources.find((s) => s.scope === "workspace")?.exists).toBe(true);
  });

  it("reports absent settings and context documents without manufacturing repair work", async () => {
    const { config } = freshConfig();

    expect(await config.previewSettingsRepair("workspace")).toBeNull();
    expect(await config.getContext("global")).toBeNull();
    expect(await config.getContext("workspace")).toBeNull();
  });

  it("previews a SHA-256-bound repair and strips only invalid settings", async () => {
    const { root, config } = freshConfig();
    const path = join(root, ".clarvis", "settings.json");
    seedGlobal(path, JSON.stringify({ default_model: "anthropic/sonnet", stale_key: true }));

    const plan = await config.previewSettingsRepair("workspace");
    expect(plan).toMatchObject({ action: "strip", dropped: ["stale_key"] });
    expect(plan?.revision).toMatch(/^[a-f0-9]{64}$/);

    const view = await config.repairSettings("workspace", plan!.revision);
    expect(view.scopes.workspace).toEqual({ default_model: "anthropic/sonnet" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      default_model: "anthropic/sonnet",
    });
  });

  it("resets unparsable JSON only after an explicit revision-bound apply", async () => {
    const { root, config } = freshConfig();
    const path = join(root, ".clarvis", "settings.json");
    seedGlobal(path, '{ "providers": [ BROKEN');

    const plan = await config.previewSettingsRepair("workspace");
    expect(plan).toMatchObject({ action: "reset" });
    expect(plan?.action === "reset" ? plan.reason.length : 0).toBeGreaterThan(0);

    await config.repairSettings("workspace", plan!.revision);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  it("rejects a stale repair revision without overwriting the newer bytes", async () => {
    const { root, config } = freshConfig();
    const path = join(root, ".clarvis", "settings.json");
    seedGlobal(path, JSON.stringify({ stale_key: 1 }));
    const plan = await config.previewSettingsRepair("workspace");
    const newer = JSON.stringify({ another_stale_key: 2 });
    writeFileSync(path, newer);

    await expect(config.repairSettings("workspace", plan!.revision)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(readFileSync(path, "utf8")).toBe(newer);
  });

  it("compares malformed settings by original bytes rather than replacement characters", async () => {
    const { root, config } = freshConfig();
    const path = join(root, ".clarvis", "settings.json");
    seedGlobal(path, Uint8Array.of(0x80));
    const plan = await config.previewSettingsRepair("workspace");

    writeFileSync(path, Uint8Array.of(0x81));

    await expect(config.repairSettings("workspace", plan!.revision)).rejects.toMatchObject({
      code: "conflict",
    });
    expect([...readFileSync(path)]).toEqual([0x81]);
  });

  it("rejects a repair when the previewed source disappeared", async () => {
    const { root, config } = freshConfig();
    const path = join(root, ".clarvis", "settings.json");
    seedGlobal(path, JSON.stringify({ stale_key: 1 }));
    const plan = await config.previewSettingsRepair("workspace");
    rmSync(path);

    await expect(config.repairSettings("workspace", plan!.revision)).rejects.toMatchObject({
      code: "conflict",
      details: { actualRevision: null },
    });
    expect(existsSync(path)).toBe(false);
  });

  it("round-trips an agent to .clarvis/agents/<name>.md with YAML frontmatter", async () => {
    const { root, config } = freshConfig();

    await config.writeAgent("workspace", "coder", {
      frontmatter: { model: "anthropic/sonnet", description: "writes code" },
      body: "You are a coder.",
    });

    const raw = readFileSync(join(root, ".clarvis", "agents", "coder.md"), "utf8");
    expect(raw).toContain("model: anthropic/sonnet");
    expect(raw.trimEnd().endsWith("You are a coder.")).toBe(true);

    const doc = await config.getAgent("workspace", "coder");
    expect(doc.frontmatter.model).toBe("anthropic/sonnet");
    expect(doc.body.trim()).toBe("You are a coder.");
    expect((await config.listAgents()).some((a) => a.name === "coder")).toBe(true);

    await config.deleteAgent("workspace", "coder");
    await expect(config.getAgent("workspace", "coder")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("FileConfigStore — parse errors and dir conventions", () => {
  it("returns null for workspace context when no workspace scope is configured", async () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-cfg-global-only-"));
    const config = createConfigService(createFileConfigStore({ globalDir }));

    expect(await config.previewSettingsRepair("workspace")).toBeNull();
    expect(await config.getContext("workspace")).toBeNull();
  });

  it("falls back to an enabled plugin contribution for a namespaced agent missing on disk", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-cfg-plugin-agent-"));
    seedGlobal(globalPaths(globalDir).settingsFile, JSON.stringify({ enabledPlugins: ["demo"] }));
    const pluginAgent = {
      name: "demo:worker",
      scope: "plugin" as const,
      plugin: "demo",
      frontmatter: { description: "worker" },
      body: "Plugin worker.",
      description: "worker",
    };
    const requests: Array<{ enabled: readonly string[]; name: string }> = [];
    const store = createFileConfigStore({
      globalDir,
      plugins: {
        readAgent: (enabled: readonly string[], name: string) => {
          requests.push({ enabled, name });
          return pluginAgent;
        },
      } as never,
    });

    expect(store.readAgent("global", "demo:worker")).toBe(pluginAgent);
    expect(requests).toEqual([{ enabled: ["demo"], name: "demo:worker" }]);
  });

  it("surfaces a parse error on the scope's source instead of dropping it silently", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-cfg-err-"));
    const globalDir = join(root, "global");
    mkdirSync(globalDir, { recursive: true });
    seedGlobal(globalPaths(globalDir).settingsFile, '{"providers":{}}');
    const store = createFileConfigStore({ workspaceRoot: root, globalDir });
    const snap = store.readSettings();
    const global = snap.sources.find((s) => s.scope === "global")!;
    expect(global.exists).toBe(true);
    expect(global.error).toContain("providers");
    expect(snap.scopes.global).toBeUndefined();
  });

  it("accepts a workspaceConfigDir directly (the config dir, not a parent root)", () => {
    const wsConfig = mkdtempSync(join(tmpdir(), "clarvis-cfg-ws-"));
    writeFileSync(join(wsConfig, "settings.json"), '{"default_model":"x/y"}');
    const store = createFileConfigStore({
      globalDir: mkdtempSync(join(tmpdir(), "clarvis-cfg-g-")),
      workspaceConfigDir: wsConfig,
    });
    expect(store.readSettings().scopes.workspace?.default_model).toBe("x/y");
  });

  it("works as a global-only store (no workspace configured)", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-cfg-go-"));
    seedGlobal(globalPaths(globalDir).settingsFile, '{"default_model":"g/m"}');
    const store = createFileConfigStore({ globalDir });
    const snap = store.readSettings();
    expect(snap.scopes.global?.default_model).toBe("g/m");
    expect(snap.scopes.workspace).toBeUndefined();
    expect(snap.sources.find((s) => s.scope === "workspace")?.exists).toBe(false);
    expect(store.readAgent("workspace", "x")).toBeNull();
    expect(store.readEffectiveAgent("missing:agent")).toBeNull();
    expect(fileAgents(store)).toEqual([]);
  });
});

describe("FileConfigStore — resource bounds", () => {
  it("reports an oversized sparse settings file without reading its body", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-cfg-large-settings-"));
    const globalDir = join(root, "global");
    const path = globalPaths(globalDir).settingsFile;
    seedGlobal(path, "{}");
    truncateSync(path, MAX_SETTINGS_DOCUMENT_BYTES + 1);
    const store = createFileConfigStore({ workspaceRoot: root, globalDir });
    const read = spyOn(fs, "readSync");
    try {
      const source = store.readSettings().sources.find((item) => item.scope === "global")!;
      expect(source.exists).toBe(true);
      expect(source.error).toContain("resource limit");
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it("reports malformed agent frontmatter instead of silently loading an empty profile", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-cfg-malformed-agent-"));
    const globalDir = join(root, "global");
    const dir = globalPaths(globalDir).agentsDir;
    mkdirSync(dir, { recursive: true });
    // A fence that never closes: the lenient parse yields {}, which satisfies
    // every optional field of the agent schema, so without the diagnostic this
    // file reads as a healthy agent that merely declares nothing.
    writeFileSync(
      join(dir, "broken.md"),
      "---\ndescription: ok\ngrants:\n  - read_workspace\nYou are an agent.\n",
    );
    writeFileSync(join(dir, "fine.md"), "---\ndescription: ok\n---\nYou are an agent.\n");

    const agents = createFileConfigStore({ globalDir }).listAgents();
    const broken = agents.find((a) => a.name === "broken");
    const fine = agents.find((a) => a.name === "fine");
    expect(broken?.malformed).toContain("malformed YAML frontmatter");
    expect(broken?.frontmatter).toEqual({});
    expect(fine?.malformed).toBeUndefined();
  });

  it("never admits more than the bounded agent catalog", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-cfg-many-agents-"));
    const globalDir = join(root, "global");
    const dir = globalPaths(globalDir).agentsDir;
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < MAX_AGENT_DOCUMENTS_PER_SCOPE + 10; index += 1)
      writeFileSync(join(dir, `agent-${String(index).padStart(3, "0")}.md`), "agent");

    expect(fileAgents(createFileConfigStore({ globalDir }))).toHaveLength(
      MAX_AGENT_DOCUMENTS_PER_SCOPE,
    );
  });

  it("bounds a directory before non-agent entries can force an unbounded scan", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-cfg-many-entries-"));
    const globalDir = join(root, "global");
    const dir = globalPaths(globalDir).agentsDir;
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 257; index += 1) {
      mkdirSync(join(dir, `directory-${String(index).padStart(3, "0")}`));
    }

    expect(fileAgents(createFileConfigStore({ globalDir }))).toEqual([]);
  });

  it("bounds aggregate workspace-agent bytes in the trust fingerprint", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-cfg-agent-aggregate-"));
    const dir = join(root, ".clarvis", "agents");
    mkdirSync(dir, { recursive: true });
    const body = "x".repeat(MAX_AGENT_DOCUMENT_BYTES - 1);
    for (let index = 0; index < 34; index += 1) {
      writeFileSync(join(dir, `agent-${String(index).padStart(2, "0")}.md`), body);
    }
    const store = createFileConfigStore({ workspaceRoot: root, globalDir: join(root, "global") });

    expect(store.readSettings().workspace_trust?.state).toBe("unapproved");
  });

  it("skips oversized agent bodies in catalogs and rejects a direct read", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-cfg-large-agent-"));
    const globalDir = join(root, "global");
    const path = globalPaths(globalDir).agentFile("huge");
    seedGlobal(path, "x");
    truncateSync(path, MAX_AGENT_DOCUMENT_BYTES + 1);
    const store = createFileConfigStore({ globalDir });

    expect(fileAgents(store)).toEqual([]);
    expect(() => store.readAgent("global", "huge")).toThrow("resource limit");
  });

  it("rejects an oversized context document before reading it", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-cfg-large-context-"));
    const path = join(root, "AGENTS.md");
    writeFileSync(path, "x");
    truncateSync(path, MAX_CONTEXT_DOCUMENT_BYTES + 1);
    const store = createFileConfigStore({ workspaceRoot: root, globalDir: join(root, "global") });

    expect(() => store.readContext("workspace")).toThrow("resource limit");
  });

  it("rejects an oversized agent write before touching disk", () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-cfg-large-write-"));
    const store = createFileConfigStore({ workspaceRoot: root, globalDir: join(root, "global") });

    expect(() =>
      store.writeAgent("workspace", "huge", {
        frontmatter: {},
        body: "x".repeat(MAX_AGENT_DOCUMENT_BYTES + 1),
      }),
    ).toThrow("resource limit");
    expect(existsSync(join(root, ".clarvis", "agents", "huge.md"))).toBe(false);
  });
});

describe("FileConfigStore.mutateSettings", () => {
  it("derives each snapshot scope and revision from one exact-byte read", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-cfg-snapshot-single-read-"));
    const store = createFileConfigStore({ globalDir });
    const settingsPath = globalPaths(globalDir).settingsFile;
    const bytes = Buffer.from('{"default_model":"a/one"}\n');
    seedGlobal(settingsPath, bytes);
    const open = spyOn(fs, "openSync");

    try {
      const snapshot = store.readSettings();
      expect(snapshot.scopes.global).toEqual({ default_model: "a/one" });
      expect(snapshot.sources.find((source) => source.scope === "global")?.revision).toBe(
        settingsDocumentRevision(bytes),
      );
      const settingsReads = open.mock.calls.filter(([path]) => String(path) === settingsPath);
      expect(settingsReads).toHaveLength(1);
    } finally {
      open.mockRestore();
    }
  });

  it("derives the mutation input from the exact bytes whose revision it checked", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-cfg-mutate-single-read-"));
    const store = createFileConfigStore({ globalDir });
    store.writeSettings("global", { default_model: "a/one" });
    const settingsPath = globalPaths(globalDir).settingsFile;
    const expectedRevision = store.readSettingsDocument("global")!.revision;
    const open = spyOn(fs, "openSync");

    try {
      expect(() =>
        store.mutateSettings!("global", expectedRevision, (current) => {
          expect(current).toEqual({ default_model: "a/one" });
          throw new Error("stop before write");
        }),
      ).toThrow("stop before write");

      const settingsReads = open.mock.calls.filter(([path]) => String(path) === settingsPath);
      expect(settingsReads).toHaveLength(1);
    } finally {
      open.mockRestore();
    }
  });

  it("preserves an empty mutation input for an absent settings document", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-cfg-mutate-absent-"));
    const store = createFileConfigStore({ globalDir });

    const result = store.mutateSettings!("global", null, (current) => {
      expect(current).toEqual({});
      return { default_model: "a/one" };
    });

    expect(result.scopes.global).toEqual({ default_model: "a/one" });
  });

  it.each(['{ "providers": [ BROKEN', JSON.stringify({ providers: {} })])(
    "preserves an empty mutation input for invalid settings bytes: %p",
    (raw) => {
      const globalDir = mkdtempSync(join(tmpdir(), "clarvis-cfg-mutate-invalid-"));
      const store = createFileConfigStore({ globalDir });
      const settingsPath = globalPaths(globalDir).settingsFile;
      seedGlobal(settingsPath, raw);

      expect(() =>
        store.mutateSettings!(
          "global",
          store.readSettingsDocument("global")!.revision,
          (current) => {
            expect(current).toEqual({});
            throw new Error("leave invalid source untouched");
          },
        ),
      ).toThrow("leave invalid source untouched");
      expect(readFileSync(settingsPath, "utf8")).toBe(raw);
    },
  );

  it("hands mutate the settings as they sit on disk right now, not an earlier cached view", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-cfg-mutate-"));
    const store = createFileConfigStore({ globalDir });
    store.writeSettings("global", { default_model: "a/one" });

    const settingsPath = globalPaths(globalDir).settingsFile;
    const writtenByAnotherProcess = {
      default_model: "a/one",
      marketplaces: ["https://example.com/other-writer.git"],
    };
    writeFileSync(settingsPath, `${JSON.stringify(writtenByAnotherProcess, null, 2)}\n`);

    let seen: unknown;
    store.mutateSettings!("global", store.readSettingsDocument("global")!.revision, (current) => {
      seen = current;
      return { ...current, enabledPlugins: ["p"] };
    });

    expect(seen).toEqual(writtenByAnotherProcess);
    expect(store.readSettings().scopes.global?.marketplaces).toEqual(
      writtenByAnotherProcess.marketplaces,
    );
  });

  it("writes nothing and leaves no lockfile when mutate throws", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-cfg-mutate-throw-"));
    const store = createFileConfigStore({ globalDir });
    store.writeSettings("global", { default_model: "a/one" });
    const settingsPath = globalPaths(globalDir).settingsFile;

    expect(() =>
      store.mutateSettings!("global", store.readSettingsDocument("global")!.revision, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(JSON.parse(readFileSync(settingsPath, "utf8")).default_model).toBe("a/one");
    expect(existsSync(`${settingsPath}.lock`)).toBe(false);
  });

  it("rejects an unconfigured scope before ever calling mutate, leaving no lockfile", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-cfg-mutate-unconf-"));
    const store = createFileConfigStore({ globalDir });
    let called = false;

    expect(() =>
      store.mutateSettings!("workspace", null, (current) => {
        called = true;
        return current;
      }),
    ).toThrow(/workspace' scope configured/);

    expect(called).toBe(false);
  });

  it("reclaims a stale lease only after its same-host holder is known dead", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-cfg-mutate-stale-"));
    const store = createFileConfigStore({ globalDir });
    store.writeSettings("global", { default_model: "a/one" });

    const lockPath = `${globalPaths(globalDir).settingsFile}.lock`;
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: "dead-writer",
        acquiredAt: 1,
        host: hostname(),
      }),
    );
    const longAgo = new Date(Date.now() - 20_000);
    utimesSync(lockPath, longAgo, longAgo);

    const result = store.mutateSettings!(
      "global",
      store.readSettingsDocument("global")!.revision,
      (current) => ({
        ...current,
        default_model: "reclaimed/one",
      }),
    );

    expect(result.scopes.global?.default_model).toBe("reclaimed/one");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not reclaim a stale lease while its same-host holder is still alive", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-cfg-mutate-timeout-"));
    const store = createFileConfigStore({ globalDir });
    store.writeSettings("global", { default_model: "a/one" });

    const lockPath = `${globalPaths(globalDir).settingsFile}.lock`;
    const live = acquireLocalLeaseSync(lockPath, {
      staleMs: 10_000,
      token: () => "live-writer",
    });
    expect(live).not.toBeNull();
    const longAgo = new Date(Date.now() - 20_000);
    utimesSync(lockPath, longAgo, longAgo);

    try {
      expect(() =>
        store.mutateSettings!(
          "global",
          store.readSettingsDocument("global")!.revision,
          (current) => current,
        ),
      ).toThrow(/locked by another process/);

      expect(
        JSON.parse(readFileSync(globalPaths(globalDir).settingsFile, "utf8")).default_model,
      ).toBe("a/one");
      expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ token: "live-writer" });
    } finally {
      live?.release();
    }
  });

  it("a late release cannot unlink an ABA successor at the settings lease path", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "clarvis-cfg-release-foreign-"));
    const store = createFileConfigStore({ globalDir });
    store.writeSettings("global", { default_model: "a/one" });
    const lockPath = `${globalPaths(globalDir).settingsFile}.lock`;
    const leases: { successor?: LocalLeaseSync } = {};

    store.mutateSettings!("global", store.readSettingsDocument("global")!.revision, (current) => {
      // Simulate an uncooperative actor replacing the directory entry after
      // this transaction acquired it. Release must compare the held inode and
      // token, not read-then-unlink whatever now occupies the same path.
      unlinkSync(lockPath);
      const successor = acquireLocalLeaseSync(lockPath, {
        staleMs: 10_000,
        token: () => "successor",
      });
      expect(successor).not.toBeNull();
      if (successor !== null) leases.successor = successor;
      return { ...current, default_model: "b/two" };
    });

    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ token: "successor" });
    expect(leases.successor?.release()).toBe(true);
  });
});

describe("the settings rejection diagnostic now has a channel", () => {
  function loggedStore(logger: RecordingLogger) {
    const root = mkdtempSync(join(tmpdir(), "clarvis-cfg-log-"));
    const store = createFileConfigStore({
      workspaceRoot: root,
      globalDir: join(root, "global"),
      logger,
    });
    return { root, store };
  }

  it("names the failing key and file when a scope does not validate", () => {
    const logger = recordingLogger();
    const { root, store } = loggedStore(logger);
    mkdirSync(join(root, ".clarvis"), { recursive: true });
    writeFileSync(join(root, ".clarvis", "settings.json"), JSON.stringify({ default_model: 7 }));
    store.readSettings();
    const rejected = logger.events("kernel.config.rejected")[0];
    expect(rejected).toMatchObject({ scope: "workspace", at: "default_model" });
    expect(rejected?.schema).toBe("kernelSettingsSchema");
    expect(String(rejected?.path)).toContain("settings.json");
    expect(logger.records.find((r) => r.fields.event === "kernel.config.rejected")?.level).toBe(
      "error",
    );
  });

  it("reports unparsable JSON separately from a schema failure", () => {
    const logger = recordingLogger();
    const { root, store } = loggedStore(logger);
    mkdirSync(join(root, ".clarvis"), { recursive: true });
    writeFileSync(join(root, ".clarvis", "settings.json"), "{ not json");
    store.readSettings();
    expect(logger.events("kernel.config.rejected")[0]).toMatchObject({ at: "(json)" });
  });

  it("reports a settings file that cannot be read at all", () => {
    const logger = recordingLogger();
    const { root, store } = loggedStore(logger);
    mkdirSync(join(root, ".clarvis"), { recursive: true });
    writeFileSync(
      join(root, ".clarvis", "settings.json"),
      `{"x":"${"y".repeat(MAX_SETTINGS_DOCUMENT_BYTES)}"}`,
    );
    store.readSettings();
    expect(logger.events("kernel.config.rejected")[0]).toMatchObject({ at: "(read)" });
  });

  it("says the same thing once a minute, not once a read", () => {
    const logger = recordingLogger();
    const { root, store } = loggedStore(logger);
    mkdirSync(join(root, ".clarvis"), { recursive: true });
    writeFileSync(join(root, ".clarvis", "settings.json"), JSON.stringify({ default_model: 7 }));
    for (let i = 0; i < 5; i++) store.readSettings();
    expect(logger.events("kernel.config.rejected")).toHaveLength(1);
  });

  it("warns when a mutation folds an unreadable document onto an empty object", () => {
    const logger = recordingLogger();
    const { root, store } = loggedStore(logger);
    mkdirSync(join(root, ".clarvis"), { recursive: true });
    const path = join(root, ".clarvis", "settings.json");
    writeFileSync(path, "{ not json");
    const revision = settingsDocumentRevision(readFileSync(path));
    store.mutateSettings?.("workspace", revision, (current) => ({
      ...current,
      default_model: "anthropic/x",
    }));
    expect(logger.events("kernel.config.document_discarded")[0]).toMatchObject({
      scope: "workspace",
      reason: "json",
    });
  });

  it("warns when a mutation folds a schema-invalid document onto an empty object", () => {
    const logger = recordingLogger();
    const { root, store } = loggedStore(logger);
    mkdirSync(join(root, ".clarvis"), { recursive: true });
    const path = join(root, ".clarvis", "settings.json");
    writeFileSync(path, JSON.stringify({ default_model: 7 }));
    const revision = settingsDocumentRevision(readFileSync(path));
    store.mutateSettings?.("workspace", revision, (current) => ({
      ...current,
      default_model: "anthropic/x",
    }));
    expect(logger.events("kernel.config.document_discarded")[0]).toMatchObject({
      reason: "schema",
    });
  });

  it("distinguishes an unreadable agents directory from a workspace with no agents", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const logger = recordingLogger();
    const { root, store } = loggedStore(logger);
    const agents = join(root, ".clarvis", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "a.md"), "---\n---\nbody\n");
    fs.chmodSync(agents, 0o000);
    try {
      expect(fileAgents(store)).toEqual([]);
      expect(logger.events("kernel.config.agents_unreadable")[0]).toMatchObject({
        scope: "workspace",
      });
    } finally {
      fs.chmodSync(agents, 0o700);
    }
  });
});
