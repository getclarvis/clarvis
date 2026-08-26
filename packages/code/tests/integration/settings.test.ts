import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openTempDir } from "../helpers/tracked-temp.ts";
import { createConfigService, createFileConfigStore } from "@clarvis/kernel/config";
import type { SecretService } from "@clarvis/protocol";
import {
  createSettingsAdapter,
  mergeProviders,
  mergeSettings,
  resolveContextWindow,
  type ProviderConfig,
  type SettingsFile,
} from "../../src/adapters/settings.ts";
import { createKeysAdapter } from "../../src/adapters/provider-secrets.ts";
import { recordDiagnostics } from "../helpers/recording-diagnostics.ts";
import { globalPaths } from "@clarvis/paths";
import { parseModelRef } from "@clarvis/kernel/config";

/** Raw config-scope directories: what {@link createFileConfigStore} takes. */
interface ScopeDirs {
  global: string;
  workspace?: string;
}

function settingsFrom(
  dirs: ScopeDirs,
  opts?: Parameters<typeof createSettingsAdapter>[1],
): Promise<Awaited<ReturnType<typeof createSettingsAdapter>>> {
  const config = createConfigService(
    createFileConfigStore({
      globalDir: dirs.global,
      ...(dirs.workspace !== undefined ? { workspaceConfigDir: dirs.workspace } : {}),
    }),
  );
  return createSettingsAdapter(config, opts);
}

function tmp(): string {
  return openTempDir("clarvis-settings-");
}

/** Let queued adapter work reach a deterministic barrier without wall-clock sleeps. */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function fakeSecrets(): SecretService {
  const values = new Map<string, string>();
  return {
    listNames: async () => [...values.keys()],
    set: async (n, v) => {
      values.set(n, v);
    },
    delete: async (n) => {
      values.delete(n);
    },
  };
}
/** Only the global scope nests its settings under a lifetime group. */
function seed(base: string, s: SettingsFile, scope: "global" | "workspace" = "global"): void {
  const file = scope === "global" ? globalPaths(base).settingsFile : join(base, "settings.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2));
}

const compat: ProviderConfig = {
  name: "compat",
  kind: "openai-compatible",
  base_url: "https://api.example.com/v1",
  api_key_env: "COMPAT_KEY",
};

test("mergeProviders: workspace replaces the whole entry by name", async () => {
  const g: ProviderConfig[] = [
    { name: "a", kind: "openai" },
    { name: "b", kind: "anthropic" },
  ];
  const w: ProviderConfig[] = [{ name: "b", kind: "google" }];
  const out = mergeProviders(g, w)!;
  expect(out.find((p) => p.name === "b")!.kind).toBe("google");
  expect(out.length).toBe(2);
});

test("mergeSettings: workspace-wins scalars, per-name providers, merged mcpServers", async () => {
  const g: SettingsFile = {
    providers: [{ name: "a", kind: "openai" }],
    default_model: "a/x",
    default_reasoning_effort: "low",
    budget: { on_exceed: "stop" },
  };
  const w: SettingsFile = {
    providers: [{ name: "b", kind: "google" }],
    default_model: "b/y",
    default_reasoning_effort: "high",
  };
  const m = mergeSettings([
    { origin: "operator", settings: g },
    { origin: "operator", settings: w },
  ]);
  expect(m.default_model).toBe("b/y");
  expect(m.default_reasoning_effort).toBe("high");
  expect(m.budget).toEqual({ on_exceed: "stop" });
  expect(m.providers!.map((p) => p.name).sort()).toEqual(["a", "b"]);
});

test("mergeSettings: global default_reasoning_effort survives when workspace omits it", async () => {
  const g: SettingsFile = { default_reasoning_effort: "medium" };
  const w: SettingsFile = { default_model: "b/y" };
  expect(
    mergeSettings([
      { origin: "operator", settings: g },
      { origin: "operator", settings: w },
    ]).default_reasoning_effort,
  ).toBe("medium");
});

test("write persists default_reasoning_effort round-trip", async () => {
  const dir = openTempDir("clarvis-effort-");
  const dirs: ScopeDirs = { global: join(dir, "g"), workspace: join(dir, "w") };
  const a = await settingsFrom(dirs, { keys: await createKeysAdapter(fakeSecrets()) });
  await a.write("global", { default_model: "compat/m", default_reasoning_effort: "high" });
  expect(a.read("global")?.default_reasoning_effort).toBe("high");
});

test("effectiveProviders: origin badges (global / workspace / shadow)", async () => {
  const g = tmp();
  const w = tmp();
  seed(g, {
    providers: [
      { name: "compat", kind: "openai-compatible", base_url: "https://x/v1" },
      { name: "onlyg", kind: "openai" },
    ],
  });
  seed(
    w,
    {
      providers: [
        { name: "compat", kind: "openai-compatible", base_url: "https://y/v1" },
        { name: "onlyw", kind: "anthropic" },
      ],
    },
    "workspace",
  );
  const a = await settingsFrom({ global: g, workspace: w });
  const byName = new Map(a.effectiveProviders().map((e) => [e.provider.name, e.origin]));
  expect(byName.get("onlyg")).toBe("global");
  expect(byName.get("onlyw")).toBe("workspace");
  expect(byName.get("compat")).toBe("shadow");
});

test("validateProviders: ≥1, compatible needs http base_url, default_model resolves", async () => {
  const dirs: ScopeDirs = { global: tmp() };
  const a = await settingsFrom(dirs);
  expect(a.validateProviders({ providers: [] }).ok).toBe(false);

  const bad = a.validateProviders({ providers: [{ name: "compat", kind: "openai-compatible" }] });
  expect(bad.ok).toBe(false);
  expect(bad.ok === false && bad.issues.some((i) => i.field === "base_url")).toBe(true);

  const good = a.validateProviders({ providers: [compat], default_model: "compat/gpt" });
  expect(good.ok).toBe(true);

  const unresolved = a.validateProviders({ providers: [compat], default_model: "ghost/gpt" });
  expect(
    unresolved.ok === false && unresolved.issues.some((i) => i.field === "default_model"),
  ).toBe(true);
});

test("a refused write whose re-read also fails still reports the original refusal", async () => {
  // Failing to re-sync must not mask the refusal the caller is waiting on.
  const g = tmp();
  seed(g, { default_model: "compat/original" });
  const base = createConfigService(createFileConfigStore({ globalDir: g }));
  let reads = 0;
  const config = {
    ...base,
    getSettings: async () => {
      reads += 1;
      if (reads > 1) throw new Error("kernel went away");
      return base.getSettings();
    },
    updateSettings: async () => {
      throw new Error("changed before save");
    },
  } as unknown as typeof base;
  const settings = await createSettingsAdapter(config);
  let thrown = "";
  await settings
    .write("global", { default_reasoning_effort: "high" })
    .catch((error: Error) => (thrown = error.message));
  expect(thrown).toBe("changed before save");
  expect(settings.read("global")?.default_model).toBe("compat/original");
});

test("validateProviders rejects a duplicate name and an empty one", async () => {
  // Duplicate names were accepted on save, and deletion was by name — so adding
  // a provider under an existing name and deleting either destroyed the
  // original credentialed one.
  const a = await settingsFrom({ global: tmp() });
  const dupes = a.validateProviders({ providers: [compat, { ...compat }] });
  expect(dupes.ok).toBe(false);
  expect(dupes.ok === false && dupes.issues.map((issue) => issue.message)).toContain(
    "duplicate provider name 'compat': names must be unique",
  );

  const nameless = a.validateProviders({
    providers: [{ ...compat, name: "" } as unknown as ProviderConfig],
  });
  expect(nameless.ok).toBe(false);
  expect(nameless.ok === false && nameless.issues[0]!.message).toBe("provider name is required");
});

test("write: atomic, preserves mcpServers, only patches given keys", async () => {
  const g = tmp();
  seed(g, {
    providers: [{ name: "old", kind: "openai" }],
    mcpServers: { fs: { type: "stdio", command: "x" } },
  });
  const a = await settingsFrom({ global: g });
  await a.write("global", { providers: [compat] });
  const onDisk = JSON.parse(readFileSync(globalPaths(g).settingsFile, "utf8"));
  expect(onDisk.providers).toEqual([compat]);
  expect(onDisk.mcpServers).toEqual({ fs: { type: "stdio", command: "x" } });
});

test("write serializes saves and snapshots the revision after the previous save", async () => {
  const g = tmp();
  const base = createConfigService(createFileConfigStore({ globalDir: g }));
  const expected: Array<string | null> = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const config: typeof base = {
    ...base,
    updateSettings: async (scope, patch, expectedRevision) => {
      expected.push(expectedRevision);
      if (expected.length === 1) await firstGate;
      return base.updateSettings(scope, patch, expectedRevision);
    },
  };
  const settings = await createSettingsAdapter(config);

  const first = settings.write("global", { default_model: "compat/one" });
  const second = settings.write("global", { default_reasoning_effort: "high" });
  await waitFor(() => expected.length > 0, "the first settings write");
  expect(expected).toEqual([null]);
  releaseFirst();
  await Promise.all([first, second]);

  expect(expected).toHaveLength(2);
  expect(expected[1]).toMatch(/^[a-f0-9]{64}$/);
  expect(settings.read("global")).toMatchObject({
    default_model: "compat/one",
    default_reasoning_effort: "high",
  });
});

test("state-publishing settings operations share one invocation-ordered queue", async () => {
  const g = tmp();
  const base = createConfigService(createFileConfigStore({ globalDir: g }));
  const calls: string[] = [];
  let getCount = 0;
  let releaseReload!: () => void;
  const reloadGate = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  const config: typeof base = {
    ...base,
    getSettings: async () => {
      getCount += 1;
      const snapshot = await base.getSettings();
      if (getCount > 1) {
        calls.push("reload");
        await reloadGate;
      }
      return snapshot;
    },
    listAgents: async () => {
      calls.push("agents");
      return base.listAgents();
    },
    updateSettings: async (scope, patch, expectedRevision) => {
      calls.push("write");
      return base.updateSettings(scope, patch, expectedRevision);
    },
    approveWorkspace: async () => {
      calls.push("trust");
      return base.approveWorkspace();
    },
    repairSettings: async () => {
      calls.push("repair");
      return base.getSettings();
    },
  };
  const settings = await createSettingsAdapter(config);
  calls.length = 0;

  const reload = settings.reload();
  await waitFor(() => calls.includes("reload"), "the queued settings reload");
  const write = settings.write("global", { default_model: "compat/new" });
  const trust = settings.setWorkspaceTrust(true);
  const repair = settings.applyRepair({
    scope: "global",
    revision: "0".repeat(64),
    action: "reset",
    reason: "test fixture",
    path: "",
  });

  await Promise.resolve();
  expect(calls).toEqual(["reload"]);
  expect(settings.version()).toBe(0);

  releaseReload();
  await Promise.all([reload, write, trust, repair]);

  expect(calls).toEqual(["reload", "agents", "write", "trust", "agents", "repair"]);
  expect(settings.read("global")?.default_model).toBe("compat/new");
  expect(settings.version()).toBe(4);
});

test("a slow agent reload cannot overwrite a later trust refresh", async () => {
  const g = tmp();
  const base = createConfigService(createFileConfigStore({ globalDir: g }));
  let listCount = 0;
  let releaseStaleAgents!: () => void;
  const staleAgentsGate = new Promise<void>((resolve) => {
    releaseStaleAgents = resolve;
  });
  const config: typeof base = {
    ...base,
    listAgents: async () => {
      listCount += 1;
      if (listCount === 1) return [];
      if (listCount === 2) {
        await staleAgentsGate;
        return [{ name: "stale", scope: "global", model: "old/model" }];
      }
      return [{ name: "fresh", scope: "global", model: "new/model" }];
    },
    approveWorkspace: () => base.getSettings(),
  };
  const settings = await createSettingsAdapter(config);

  const reload = settings.reload();
  await waitFor(() => listCount >= 2, "the stale agent-list read");
  const trust = settings.setWorkspaceTrust(true);
  releaseStaleAgents();
  await Promise.all([reload, trust]);

  expect(settings.refs("old").agents).toEqual([]);
  expect(settings.refs("new").agents).toEqual(["fresh"]);
});

test("write conflict never clobbers the external edit, and re-syncs the snapshot", async () => {
  const g = tmp();
  seed(g, { default_model: "compat/original" });
  const settings = await settingsFrom({ global: g });
  const path = globalPaths(g).settingsFile;
  const external = JSON.stringify({ default_model: "compat/external" });
  writeFileSync(path, external);

  let thrown = "";
  await settings
    .write("global", { default_reasoning_effort: "high" })
    .catch((error: Error) => (thrown = error.message));

  expect(thrown).toContain("changed before save");
  expect(readFileSync(path, "utf8")).toBe(external);
  // The refused write's own field is never adopted, and the snapshot moves to
  // what is actually on disk. Keeping the stale snapshot is what left Run
  // controls and Memory settings reporting a refused value as `Effective` /
  // `Source: workspace` indefinitely, with no route to refresh.
  expect(settings.read("global")?.default_reasoning_effort).toBeUndefined();
  expect(settings.read("global")?.default_model).toBe("compat/external");
});

test("envStatus: reads process.env at the current moment", async () => {
  const a = await settingsFrom({ global: tmp() });
  process.env.CLARVIS_TEST_KEY_XYZ = "secret";
  expect(a.envStatus("CLARVIS_TEST_KEY_XYZ")).toBe("set");
  expect(a.envStatus("CLARVIS_DEFINITELY_UNSET_XYZ")).toBe("unset");
  delete process.env.CLARVIS_TEST_KEY_XYZ;
});

test("envStatus: tri-state — real env wins over the keys file", async () => {
  const g = tmp();
  const keys = await createKeysAdapter(fakeSecrets());
  await keys.set("CLARVIS_TEST_TRI_XYZ", "file-value");
  const a = await settingsFrom({ global: g }, { keys });
  expect(a.envStatus("CLARVIS_TEST_TRI_XYZ")).toBe("keyfile");
  process.env.CLARVIS_TEST_TRI_XYZ = "env-value";
  expect(a.envStatus("CLARVIS_TEST_TRI_XYZ")).toBe("set");
  delete process.env.CLARVIS_TEST_TRI_XYZ;
  expect(a.envStatus("CLARVIS_NOT_ANYWHERE_XYZ")).toBe("unset");
});

test("envStatus: source=keyfile makes keys.json win over a shell env var", async () => {
  const g = tmp();
  const keys = await createKeysAdapter(fakeSecrets());
  await keys.set("CLARVIS_TEST_SRC_XYZ", "file-value");
  const sources: Record<string, "auto" | "env" | "keyfile"> = {};
  const a = await settingsFrom({ global: g }, { keys, keySource: (v) => sources[v] ?? "auto" });
  process.env.CLARVIS_TEST_SRC_XYZ = "env-value";
  expect(a.envStatus("CLARVIS_TEST_SRC_XYZ")).toBe("set");
  sources.CLARVIS_TEST_SRC_XYZ = "keyfile";
  expect(a.envStatus("CLARVIS_TEST_SRC_XYZ")).toBe("keyfile");
  sources.CLARVIS_TEST_SRC_XYZ = "env";
  await keys.set("CLARVIS_TEST_SRC2_XYZ", "only-file");
  sources.CLARVIS_TEST_SRC2_XYZ = "env";
  expect(a.envStatus("CLARVIS_TEST_SRC2_XYZ")).toBe("unset");
  delete process.env.CLARVIS_TEST_SRC_XYZ;
});

test("corrupt settings.json: read undefined, corrupt() reports, write refuses and preserves the file", async () => {
  const g = tmp();
  mkdirSync(dirname(globalPaths(g).settingsFile), { recursive: true });
  const raw = '{ "providers": [ BROKEN';
  writeFileSync(globalPaths(g).settingsFile, raw);
  const a = await settingsFrom({ global: g });
  expect(a.read("global")).toBeUndefined();
  expect(a.corrupt("global")).not.toBeNull();
  expect(a.corrupt("workspace")).toBeNull();
  let thrown = "";
  await a.write("global", { default_model: "compat/m1" }).catch((e: Error) => (thrown = e.message));
  expect(thrown).toContain("invalid JSON");
  expect(readFileSync(globalPaths(g).settingsFile, "utf8")).toBe(raw);
});

test("repair: a hand-fix on disk between plan and apply is detected and never clobbered", async () => {
  const g = tmp();
  mkdirSync(dirname(globalPaths(g).settingsFile), { recursive: true });
  const path = globalPaths(g).settingsFile;
  writeFileSync(path, JSON.stringify({ default_model: "compat/m1", stale_key: 1 }));
  const a = await settingsFrom({ global: g });
  const plan = await a.planRepair("global");
  expect(plan).toMatchObject({ action: "strip", dropped: ["stale_key"] });
  expect(plan?.revision).toMatch(/^[a-f0-9]{64}$/);
  const handFixed = JSON.stringify({ default_model: "compat/m2" });
  writeFileSync(path, handFixed);
  let thrown = "";
  await a.applyRepair(plan!).catch((e: Error) => (thrown = e.message));
  expect(thrown).toContain("changed since repair preview");
  expect(readFileSync(path, "utf8")).toBe(handFixed);
});

test("missing settings.json is NOT corrupt: read undefined, corrupt null, write creates fresh", async () => {
  const g = tmp();
  const a = await settingsFrom({ global: g });
  expect(a.read("global")).toBeUndefined();
  expect(a.corrupt("global")).toBeNull();
  await a.write("global", { default_model: "compat/m1" });
  expect(a.read("global")?.default_model).toBe("compat/m1");
});

test("schema-invalid settings.json (valid JSON, wrong shape): read undefined, write blocked", async () => {
  const g = tmp();
  mkdirSync(dirname(globalPaths(g).settingsFile), { recursive: true });
  const raw = JSON.stringify({ providers: {} });
  writeFileSync(globalPaths(g).settingsFile, raw);
  const a = await settingsFrom({ global: g });
  expect(a.read("global")).toBeUndefined();
  expect(a.corrupt("global")).toContain("providers");
  expect(a.effective()).toEqual({});
  let thrown = "";
  await a.write("global", { default_model: "compat/m1" }).catch((e: Error) => (thrown = e.message));
  expect(thrown).toContain("is invalid");
  expect(readFileSync(globalPaths(g).settingsFile, "utf8")).toBe(raw);
});

test("write refuses a patch that would land schema-invalid settings on disk", async () => {
  const g = tmp();
  seed(g, { providers: [compat] });
  const a = await settingsFrom({ global: g });
  let thrown = "";
  await a
    .write("global", { budget: { total_token_limit: 0 } as never })
    .catch((e: Error) => (thrown = e.message));
  expect(thrown).toContain("refusing to save invalid settings");
  expect(a.read("global")?.budget).toBeUndefined();
});

test("modelRefs: matches the exact provider/model ref across agents and default_model", async () => {
  const g = tmp();
  mkdirSync(globalPaths(g).agentsDir, { recursive: true });
  writeFileSync(
    globalPaths(g).agentFile("coder"),
    "---\nmodel: openrouter/glm-5.2\n---\nbe helpful\n",
  );
  seed(g, { default_model: "openrouter/other" });
  const a = await settingsFrom({ global: g });
  expect(a.modelRefs("openrouter/glm-5.2")).toEqual({ agents: ["coder"], defaultModel: false });
  expect(a.modelRefs("openrouter/other")).toEqual({ agents: [], defaultModel: true });
  expect(a.modelRefs("openrouter").agents).toEqual([]);
});

test("write: the plans block round-trips, including an explicit mode 'off'", async () => {
  const dir = openTempDir("clarvis-plancfg-");
  const dirs: ScopeDirs = { global: join(dir, "g"), workspace: join(dir, "w") };
  const a = await settingsFrom(dirs, { keys: await createKeysAdapter(fakeSecrets()) });
  await a.write("global", {
    default_model: "compat/m",
    plans: { mode: "review", retention: "keep", pending_task_nudges: 5 },
  });
  expect(a.read("global")?.plans).toEqual({
    mode: "review",
    retention: "keep",
    pending_task_nudges: 5,
  });
  const onDisk = JSON.parse(readFileSync(globalPaths(dirs.global).settingsFile, "utf8"));
  expect(onDisk.plans).toEqual({ mode: "review", retention: "keep", pending_task_nudges: 5 });

  await a.write("global", {
    plans: { mode: "off", retention: "discard", pending_task_nudges: 5 },
  });
  const b = await settingsFrom(dirs, { keys: await createKeysAdapter(fakeSecrets()) });
  expect(b.read("global")?.plans?.mode).toBe("off");
  expect(b.read("global")?.plans?.retention).toBe("discard");
  expect(b.read("global")?.default_model).toBe("compat/m");
});

// A `workflows` block is contributed at runtime by @clarvis/workflows through the
// kernel's capability registry, so it is absent from the engine's bare
// `settingsSchema`. The adapter must validate against the kernel's registry-extended
// schema, or a workspace that configures workflows can never save anything again.
const withWorkflows = { default_model: "compat/m", workflows: { max_concurrency: 8 } };

test("write: an unrelated patch succeeds and leaves a workflows block on disk", async () => {
  const g = tmp();
  seed(g, withWorkflows);
  const a = await settingsFrom({ global: g });
  await a.write("global", { plans: { mode: "on", retention: "keep", pending_task_nudges: 3 } });
  const onDisk = JSON.parse(readFileSync(globalPaths(g).settingsFile, "utf8"));
  expect(onDisk.workflows).toMatchObject({ max_concurrency: 8 });
  expect(onDisk.plans.mode).toBe("on");
  expect(onDisk.default_model).toBe("compat/m");
});

test("planRepair: a valid workflows block is kept, not counted among the dropped keys", async () => {
  const g = tmp();
  mkdirSync(dirname(globalPaths(g).settingsFile), { recursive: true });
  writeFileSync(
    globalPaths(g).settingsFile,
    JSON.stringify({ ...withWorkflows, stale_key: 1 }, null, 2),
  );
  const a = await settingsFrom({ global: g });
  expect(a.corrupt("global")).not.toBeNull();
  const plan = await a.planRepair("global");
  expect(plan!.action).toBe("strip");
  const strip = plan as Extract<NonNullable<typeof plan>, { action: "strip" }>;
  expect(strip.dropped).toEqual(["stale_key"]);
  await a.applyRepair(strip);
  expect(a.read("global")?.workflows).toMatchObject({ max_concurrency: 8 });
});

test("write: memory block round-trips and memory: undefined deletes the key", async () => {
  const dir = openTempDir("clarvis-memcfg-");
  const dirs: ScopeDirs = { global: join(dir, "g"), workspace: join(dir, "w") };
  const a = await settingsFrom(dirs, { keys: await createKeysAdapter(fakeSecrets()) });
  await a.write("global", {
    default_model: "compat/m",
    memory: { enabled: true, model: "compat/m" },
  });
  expect(a.read("global")?.memory?.enabled).toBe(true);
  const onDisk = JSON.parse(readFileSync(globalPaths(dirs.global).settingsFile, "utf8"));
  expect(onDisk.memory).toEqual({ enabled: true, model: "compat/m" });

  await a.write("global", { memory: undefined });
  const b = await settingsFrom(dirs, { keys: await createKeysAdapter(fakeSecrets()) });
  expect(b.read("global")?.memory).toBeUndefined();
  const after = JSON.parse(readFileSync(globalPaths(dirs.global).settingsFile, "utf8"));
  expect("memory" in after).toBe(false);
  expect(after.default_model).toBe("compat/m");
});

test("resolveContextWindow: resolves the model's configured window", () => {
  const providers: ProviderConfig[] = [
    { name: "compat", kind: "openai", models: { "gpt-4": { context_window_tokens: 128000 } } },
  ];
  expect(resolveContextWindow(providers, "compat/gpt-4", 8000)).toBe(128000);
});

test("resolveContextWindow: falls back when fullModelId is undefined", () => {
  expect(resolveContextWindow([], undefined, 8000)).toBe(8000);
});

test("resolveContextWindow: falls back when providers is undefined", () => {
  expect(resolveContextWindow(undefined, "compat/gpt-4", 8000)).toBe(8000);
});

test("resolveContextWindow: falls back when the provider is not found", () => {
  const providers: ProviderConfig[] = [{ name: "other", kind: "openai" }];
  expect(resolveContextWindow(providers, "compat/gpt-4", 8000)).toBe(8000);
});

test("resolveContextWindow: falls back when the model is not listed on the provider", () => {
  const providers: ProviderConfig[] = [
    { name: "compat", kind: "openai", models: { "gpt-3": { context_window_tokens: 4000 } } },
  ];
  expect(resolveContextWindow(providers, "compat/gpt-4", 8000)).toBe(8000);
});

test("resolveContextWindow: a non-positive configured window is treated as absent", () => {
  const providers: ProviderConfig[] = [
    { name: "compat", kind: "openai", models: { "gpt-4": { context_window_tokens: 0 } } },
  ];
  expect(resolveContextWindow(providers, "compat/gpt-4", 8000)).toBe(8000);
});

test("resolveContextWindow: a model id that cannot be parsed at runtime falls back rather than throwing", () => {
  expect(resolveContextWindow([], 42 as unknown as string, 8000)).toBe(8000);
});

test("origin: workspace wins when both scopes set the same key", async () => {
  const g = tmp();
  const w = tmp();
  seed(g, { default_model: "compat/g" });
  seed(w, { default_model: "compat/w" }, "workspace");
  const a = await settingsFrom({ global: g, workspace: w });
  expect(a.origin("default_model")).toBe("workspace");
});

test("origin: reports global when only the global scope sets the key", async () => {
  const g = tmp();
  seed(g, { default_model: "compat/g" });
  const a = await settingsFrom({ global: g });
  expect(a.origin("default_model")).toBe("global");
});

test("origin: is undefined when neither scope sets the key", async () => {
  const a = await settingsFrom({ global: tmp() });
  expect(a.origin("providers")).toBeUndefined();
});

test("reload: re-reads external changes to settings.json and bumps version", async () => {
  const g = tmp();
  const a = await settingsFrom({ global: g });
  const v0 = a.version();
  expect(a.read("global")).toBeUndefined();
  seed(g, { default_model: "compat/x" });
  expect(a.read("global")).toBeUndefined();
  await a.reload();
  expect(a.read("global")?.default_model).toBe("compat/x");
  expect(a.version()).toBeGreaterThan(v0);
});

test("refs: lists agents citing a provider and flags a matching default_model", async () => {
  const g = tmp();
  mkdirSync(globalPaths(g).agentsDir, { recursive: true });
  writeFileSync(globalPaths(g).agentFile("coder"), "---\nmodel: compat/gpt\n---\nbe helpful\n");
  writeFileSync(globalPaths(g).agentFile("other"), "---\nmodel: other/gpt\n---\nbe helpful\n");
  seed(g, { default_model: "compat/gpt" });
  const a = await settingsFrom({ global: g });
  const r = a.refs("compat");
  expect(r.agents).toEqual(["coder"]);
  expect(r.defaultModel).toBe(true);
});

test("refs: a provider cited by nothing reports empty agents and defaultModel false", async () => {
  const g = tmp();
  seed(g, { default_model: "compat/gpt" });
  const a = await settingsFrom({ global: g });
  const r = a.refs("unused");
  expect(r.agents).toEqual([]);
  expect(r.defaultModel).toBe(false);
});

test("validateProviders: provider name must match ^[a-z0-9_-]+$", async () => {
  const a = await settingsFrom({ global: tmp() });
  const r = a.validateProviders({ providers: [{ name: "Bad Name!", kind: "openai" }] });
  expect(r.ok).toBe(false);
  expect(r.ok === false && r.issues.some((i) => i.field === "name")).toBe(true);
});

test("validateProviders: api_key_env must be a valid environment-variable name", async () => {
  const a = await settingsFrom({ global: tmp() });
  const r = a.validateProviders({
    providers: [{ name: "p", kind: "openai", api_key_env: "1BAD" }],
  });
  expect(r.ok).toBe(false);
  expect(r.ok === false && r.issues.some((i) => i.field === "api_key_env")).toBe(true);
});

test("validateProviders: a model's context_window_tokens must be a positive integer", async () => {
  const a = await settingsFrom({ global: tmp() });
  const r = a.validateProviders({
    providers: [
      { name: "p", kind: "openai", models: { m: { context_window_tokens: 0 } } },
    ] as ProviderConfig[],
  });
  expect(r.ok).toBe(false);
  expect(r.ok === false && r.issues.some((i) => i.field === "context_window_tokens")).toBe(true);
});

test("validateProviders: resolveAgainst overrides which provider list default_model must resolve against", async () => {
  const a = await settingsFrom({ global: tmp() });
  const withoutResolve = a.validateProviders({ providers: [compat], default_model: "ext/x" });
  expect(withoutResolve.ok).toBe(false);
  const withResolve = a.validateProviders({ providers: [compat], default_model: "ext/x" }, [
    { name: "ext", kind: "openai" },
  ]);
  expect(withResolve.ok).toBe(true);
});

test("planRepair/applyRepair: an invalid-JSON file plans a 'reset' with the parse error as reason", async () => {
  const g = tmp();
  mkdirSync(dirname(globalPaths(g).settingsFile), { recursive: true });
  const raw = '{ "providers": [ BROKEN';
  writeFileSync(globalPaths(g).settingsFile, raw);
  const a = await settingsFrom({ global: g });
  const plan = await a.planRepair("global");
  expect(plan).not.toBeNull();
  expect(plan!.action).toBe("reset");
  expect(plan!.action === "reset" ? plan!.reason.length : 0).toBeGreaterThan(0);
});

test("planRepair: valid JSON that is not an object (e.g. an array) also plans a 'reset'", async () => {
  const g = tmp();
  mkdirSync(dirname(globalPaths(g).settingsFile), { recursive: true });
  writeFileSync(globalPaths(g).settingsFile, JSON.stringify([1, 2, 3]));
  const a = await settingsFrom({ global: g });
  expect(a.corrupt("global")).not.toBeNull();
  const plan = await a.planRepair("global");
  expect(plan!.action).toBe("reset");
});

test("planRepair: a nested wrong-typed leaf climbs to the nearest removable ancestor", async () => {
  const g = tmp();
  mkdirSync(dirname(globalPaths(g).settingsFile), { recursive: true });
  writeFileSync(
    globalPaths(g).settingsFile,
    JSON.stringify({
      providers: [
        { name: "compat", kind: "openai", models: { gpt: { context_window_tokens: "big" } } },
      ],
    }),
  );
  const a = await settingsFrom({ global: g });
  const plan = await a.planRepair("global");
  expect(plan!.action).toBe("strip");
  const strip = plan as Extract<NonNullable<typeof plan>, { action: "strip" }>;
  expect(strip.dropped).toContain("providers.0.models.gpt");
  await a.applyRepair(strip);
  expect(a.read("global")?.providers?.[0]?.models).toEqual({});
});

test("planRepair: a file with more distinct errors than the repair budget allows falls back to reset", async () => {
  const g = tmp();
  mkdirSync(dirname(globalPaths(g).settingsFile), { recursive: true });
  const providers = Array.from({ length: 70 }, () => "not-an-object");
  writeFileSync(globalPaths(g).settingsFile, JSON.stringify({ providers }));
  const a = await settingsFrom({ global: g });
  const plan = await a.planRepair("global");
  expect(plan!.action).toBe("reset");
});

test("planRepair: an array element of the wrong type is spliced out, then a sibling's stray key is stripped", async () => {
  const g = tmp();
  mkdirSync(dirname(globalPaths(g).settingsFile), { recursive: true });
  writeFileSync(
    globalPaths(g).settingsFile,
    JSON.stringify({
      providers: [
        { name: "a", kind: "openai" },
        "oops",
        { name: "b", kind: "openai", bogus_field: true },
      ],
    }),
  );
  const a = await settingsFrom({ global: g });
  const plan = await a.planRepair("global");
  expect(plan!.action).toBe("strip");
  const strip = plan as Extract<NonNullable<typeof plan>, { action: "strip" }>;
  expect(strip.dropped).toContain("providers.1");
  await a.applyRepair(strip);
  expect(a.read("global")?.providers?.map((p) => p.name)).toEqual(["a", "b"]);
  expect(a.read("global")?.providers?.every((p) => !("bogus_field" in p))).toBe(true);
});

test("parseModelRef is total, so the three model-ref fallbacks are guards and not live paths", async () => {
  // Every one of the three `catch` blocks around `parseModelRef` is currently
  // unreachable: the parser has no throwing branch at all, and a reference with
  // no slash resolves to a provider of that whole name. The instrumentation
  // stays as a guard, and this is what notices if the parser ever grows one.
  const g = tmp();
  mkdirSync(globalPaths(g).agentsDir, { recursive: true });
  writeFileSync(globalPaths(g).agentFile("coder"), "---\nmodel: no-slash-here\n---\nbe helpful\n");
  seed(g, { providers: [compat], default_model: "also-no-slash" });
  const a = await settingsFrom({ global: g });
  const recording = recordDiagnostics();
  try {
    expect(resolveContextWindow([], "not-a-ref", 8000)).toBe(8000);
    expect(a.validateProviders({ providers: [compat], default_model: "also-no-slash" }).ok).toBe(
      false,
    );
    expect(a.refs("compat").agents).toEqual([]);
  } finally {
    recording.uninstall();
  }

  expect(recording.of("settings.model_ref.unparsed")).toEqual([]);
  expect(parseModelRef("no-slash-here")).toEqual({ provider: "no-slash-here", modelId: "" });
});

test("a refused settings write records the scope and the fields that failed", async () => {
  const g = tmp();
  seed(g, { providers: [compat] });
  const a = await settingsFrom({ global: g });
  const recording = recordDiagnostics();
  try {
    await a.write("global", { default_reasoning_effort: "high" });
    await a.write("global", { budget: { total_token_limit: 0 } as never }).catch(() => undefined);
  } finally {
    recording.uninstall();
  }

  expect(recording.first("settings.save.applied")).toMatchObject({
    level: "info",
    details: { scope: "global", keys: "default_reasoning_effort" },
  });
  const rejected = recording.first("settings.save.rejected");
  expect(rejected?.level).toBe("error");
  expect(rejected?.details.scope).toBe("global");
  expect(rejected?.details.reason).toBe("invalid");
  expect(Number(rejected?.details.issue_count)).toBeGreaterThan(0);
  expect(String(rejected?.details.fields)).toContain("budget");
});

test("a settings file that cannot be parsed at all is a rejection of its own kind", async () => {
  const g = tmp();
  mkdirSync(dirname(globalPaths(g).settingsFile), { recursive: true });
  writeFileSync(globalPaths(g).settingsFile, "{ not json");
  const a = await settingsFrom({ global: g });
  const recording = recordDiagnostics();
  try {
    await a.write("global", { default_model: "compat/m" }).catch(() => undefined);
  } finally {
    recording.uninstall();
  }

  expect(recording.first("settings.save.rejected")).toMatchObject({
    level: "error",
    details: { scope: "global", reason: "unparsable", issue_count: 1, fields: "" },
  });
});
