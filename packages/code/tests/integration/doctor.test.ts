import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRoot } from "solid-js";
import { openTempDir } from "../helpers/tracked-temp.ts";
import {
  bootGate,
  GATES,
  runGates,
  startupRoute,
  type BackendProbe,
  type DoctorCtx,
} from "../../src/onboarding/doctor.ts";
import {
  compareAgentDisplayOrder,
  createConfigService,
  createFileConfigStore,
  resolveAgentsByName,
} from "@clarvis/kernel/config";
import type { Scope, SecretService } from "@clarvis/protocol";
import { findAgentConflicts } from "../../src/adapters/agents-store.ts";
import {
  createSettingsAdapter,
  type SettingsAdapter,
  type SettingsFile,
} from "../../src/adapters/settings.ts";
import { createKeysAdapter } from "../../src/adapters/provider-secrets.ts";
import { createDiagnosticSession } from "../../src/adapters/diagnostic-session.ts";
import { installDiagnosticSession } from "../../src/core/diagnostic-events.ts";

function configFrom(dirs: ScopeDirs) {
  return createConfigService(storeFrom(dirs));
}
function storeFrom(dirs: ScopeDirs) {
  return createFileConfigStore({
    globalDir: dirs.global,
    ...(dirs.workspace !== undefined ? { workspaceConfigDir: dirs.workspace } : {}),
  });
}
/**
 * Approve the workspace so its agents participate.
 *
 * @remarks Workspace agents are withheld until approved, so a cross-scope name
 * conflict only exists in an approved workspace — which is the state these
 * cases describe.
 */
function approveWorkspace(dirs: ScopeDirs): void {
  storeFrom(dirs).setWorkspaceTrust?.(true);
}
function settingsFrom(
  dirs: ScopeDirs,
  opts?: Parameters<typeof createSettingsAdapter>[1],
): Promise<SettingsAdapter> {
  return createSettingsAdapter(configFrom(dirs), opts);
}
import { createCodeConfigStore, type CodeConfig } from "../../src/adapters/code-config.ts";
import { docToAgentFile, readEnvView, type AgentFile } from "../../src/adapters/agent-files.ts";
import type { ClarvisDirs } from "../../src/adapters/agents.ts";
import { globalPaths, workspacePaths } from "@clarvis/paths";

interface ScopeDirs {
  global: string;
  workspace?: string;
}

function tmpDirs(): ScopeDirs {
  const root = openTempDir("clarvis-doctor-");
  return { global: join(root, "global"), workspace: join(root, "workspace") };
}

/** Project raw scope dirs onto the path sets the code-config store expects. */
function pathsOf(dirs: ScopeDirs): ClarvisDirs {
  return {
    global: globalPaths(dirs.global),
    ...(dirs.workspace !== undefined ? { workspace: workspacePaths(dirs.workspace) } : {}),
  };
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

/** Only the global scope nests its config under a lifetime group. */
function settingsFileOf(base: string, scope: "global" | "workspace"): string {
  return scope === "global" ? globalPaths(base).settingsFile : join(base, "settings.json");
}
function agentsDirOf(base: string, scope: "global" | "workspace"): string {
  return scope === "global" ? globalPaths(base).agentsDir : join(base, "agents");
}
function seedSettings(
  base: string,
  s: SettingsFile,
  scope: "global" | "workspace" = "global",
): void {
  const file = settingsFileOf(base, scope);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2));
}
function seedAgent(
  base: string,
  name: string,
  fmYaml: string,
  body = "prompt",
  scope: "global" | "workspace" = "global",
): void {
  const dir = agentsDirOf(base, scope);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${fmYaml}\n---\n${body}\n`);
}
function seedCode(base: string, cfg: CodeConfig): void {
  const file = globalPaths(base).codeConfigFile;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2));
}

const KEYLESS_PROVIDER = {
  name: "local",
  kind: "openai-compatible",
  base_url: "http://localhost:8080",
  models: { m: { context_window_tokens: 128000 } },
};

/**
 * The agent list and the conflict list as the doctor really receives them.
 *
 * @remarks Both delegate to the production projections rather than restating
 *   them. The restatements they replace had already drifted: one dropped
 *   `malformed`, and both were blind to a conflict reported on an overlay,
 *   so the gate under test saw a fleet the app never shows.
 */
function snapshotFrom(dirs: ScopeDirs): { agents: AgentFile[]; conflicts: string[] } {
  const store = createFileConfigStore({
    globalDir: dirs.global,
    ...(dirs.workspace !== undefined ? { workspaceConfigDir: dirs.workspace } : {}),
  });
  const records = store.listAgents();
  const summaries = records.map((rec) => ({
    name: rec.name,
    scope: rec.scope,
    ...(rec.overlay === undefined ? {} : { overlay: rec.overlay }),
  }));
  const agents = resolveAgentsByName(records.filter((rec) => rec.scope !== "plugin")).map((rec) =>
    docToAgentFile(
      {
        name: rec.name,
        scope: rec.scope as Scope | "builtin",
        frontmatter: rec.frontmatter,
        body: rec.body,
        ...(rec.malformed === undefined ? {} : { malformed: rec.malformed }),
      },
      rec.overlay,
    ),
  );
  return {
    agents: agents.sort(compareAgentDisplayOrder),
    conflicts: findAgentConflicts(summaries as never),
  };
}

function agentsFrom(dirs: ScopeDirs): AgentFile[] {
  return snapshotFrom(dirs).agents;
}

function conflictsFrom(dirs: ScopeDirs): string[] {
  return snapshotFrom(dirs).conflicts;
}

function buildCtx(
  dirs: ScopeDirs,
  settings: SettingsAdapter,
  backend: BackendProbe = { status: "reachable", profileCount: 1 },
  subscriptionReadiness?: DoctorCtx["subscriptionReadiness"],
): DoctorCtx {
  return {
    settings,
    agents: {
      list: () => agentsFrom(dirs),
      conflicts: () => conflictsFrom(dirs),
    },
    code: createCodeConfigStore(pathsOf(dirs)),
    env: readEnvView({}),
    backend: () => backend,
    ...(subscriptionReadiness !== undefined ? { subscriptionReadiness } : {}),
    sandboxInspection: () => ({
      backend: {
        type: "bubblewrap",
        available: true,
        mode: "fresh-proc",
        degraded: false,
      },
      toolchains: [],
      extra_paths: [],
      effective_path: ["/usr/bin"],
    }),
  };
}

test("ladder: a fully green fleet passes every gate → shell", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, {
    providers: [KEYLESS_PROVIDER as never],
    default_model: "local/m",
    budget: { on_exceed: "stop", total_token_limit: 200000 },
  });
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  seedCode(dirs.global, { agent: { default: "coder" }, theme: { mode: "dark" } });
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const report = runGates(buildCtx(dirs, settings));
    expect(report.results.config.status).toBe("pass");
    expect(report.results.providers.status).toBe("pass");
    expect(report.results.credentials.status).toBe("pass");
    expect(report.results.agents.status).toBe("pass");
    expect(report.results.default_model.status).toBe("pass");
    expect(report.results.default_agent.status).toBe("pass");
    expect(report.results.theme.status).toBe("pass");
    expect(report.results.backend.status).toBe("pass");
    expect(report.blocked).toBe(false);
    expect(bootGate(report)).toBe("shell");
    expect(startupRoute(buildCtx(dirs, settings), report)).toBe("shell");
    dispose();
  });
});

test("ladder: a fresh machine blocks on config alone — the agent fleet is always there", async () => {
  const dirs = tmpDirs();
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const report = runGates(buildCtx(dirs, settings, { status: "unreachable" }));
    expect(report.results.config.status).toBe("fail");
    /* Nothing has ever been written to this machine and it still has five
       agents: they ship as data, so there is no "install the templates" step
       left for a gate to block on. */
    expect(report.results.agents.status).toBe("pass");
    expect(report.results.agents.detail).toBe("5 agent(s)");
    expect(report.results.backend.status).toBe("warn");
    expect(report.blocked).toBe(true);
    expect(bootGate(report)).toBe("doctor");
    expect(startupRoute(buildCtx(dirs, settings, { status: "unreachable" }), report)).toBe("setup");
    dispose();
  });
});

test("ladder: config present and no agent file at all reaches the shell", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, {
    providers: [KEYLESS_PROVIDER as never],
    default_model: "local/m",
  });
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const report = runGates(buildCtx(dirs, settings));
    expect(report.results.config.status).toBe("pass");
    expect(report.results.agents.status).toBe("pass");
    expect(report.blocked).toBe(false);
    expect(startupRoute(buildCtx(dirs, settings), report)).toBe("shell");
    dispose();
  });
});

test("agents gate warns (not fails) on a cross-scope name conflict, and never blocks boot", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, {
    providers: [KEYLESS_PROVIDER as never],
    default_model: "local/m",
  });
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  seedAgent(dirs.workspace!, "coder", "grants: [edit_workspace]", "prompt", "workspace");
  approveWorkspace(dirs);
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const report = runGates(buildCtx(dirs, settings));
    expect(report.results.agents.status).toBe("warn");
    expect(report.results.agents.detail).toContain("duplicate name");
    expect(report.results.agents.fix).toEqual({ kind: "view", view: "agents" });
    expect(report.blocked).toBe(false);
    expect(bootGate(report)).toBe("shell");
    dispose();
  });
});

test("agents gate counts both a cross-scope conflict and invalid frontmatter without hiding either", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, {
    providers: [KEYLESS_PROVIDER as never],
    default_model: "local/m",
  });
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  seedAgent(dirs.workspace!, "coder", "grants: [edit_workspace]", "prompt", "workspace");
  seedAgent(dirs.global, "broken", 'grants: "edit_workspace"');
  approveWorkspace(dirs);
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const report = runGates(buildCtx(dirs, settings));
    expect(report.results.agents.status).toBe("warn");
    expect(report.results.agents.detail).toContain("duplicate name");
    expect(report.results.agents.detail).toContain("invalid");
    expect(report.blocked).toBe(false);
    dispose();
  });
});

test("agents gate does not call an agent invalid over a frontmatter key it does not know", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, {
    providers: [KEYLESS_PROVIDER as never],
    default_model: "local/m",
  });
  seedAgent(dirs.global, "coder", 'grants: [edit_workspace]\nx-house-style: "terse"');
  approveWorkspace(dirs);
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const report = runGates(buildCtx(dirs, settings));
    expect(report.results.agents.detail).not.toContain("invalid");
    expect(report.blocked).toBe(false);
    dispose();
  });
});

test("ladder: an empty settings.json is 'present' but a missing provider warns (soft blocks)", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, {});
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const report = runGates(buildCtx(dirs, settings));
    expect(report.results.config.status).toBe("pass");
    expect(report.results.providers.status).toBe("warn");
    expect(report.results.agents.status).toBe("pass");
    expect(report.blocked).toBe(true);
    dispose();
  });
});

test("credentials: a native provider with an unset api_key_env warns; keyless stays pass", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, {
    providers: [
      {
        name: "anthropic",
        kind: "anthropic",
        api_key_env: "DOCTOR_TEST_UNSET_KEY_XZ",
        models: { s: { context_window_tokens: 200000 } },
      } as never,
    ],
    default_model: "anthropic/s",
  });
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const report = runGates(buildCtx(dirs, settings));
    expect(report.results.credentials.status).toBe("warn");
    expect(report.results.credentials.detail).toContain("DOCTOR_TEST_UNSET_KEY_XZ");
    expect(report.results.providers.status).toBe("pass");
    expect(report.blocked).toBe(true);
    expect(startupRoute(buildCtx(dirs, settings), report)).toBe("repair");
    dispose();
  });
});

test("credentials: a key present only in keys.json passes via the keyfile source", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, {
    providers: [
      {
        name: "anthropic",
        kind: "anthropic",
        api_key_env: "DOCTOR_KEYFILE_ONLY_XZ",
        models: { s: { context_window_tokens: 200000 } },
      } as never,
    ],
    default_model: "anthropic/s",
  });
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  const keys = await createKeysAdapter(fakeSecrets());
  await keys.set("DOCTOR_KEYFILE_ONLY_XZ", "v");
  const settings = await settingsFrom(dirs, { keys });
  createRoot((dispose) => {
    const report = runGates(buildCtx(dirs, settings));
    expect(report.results.credentials.status).toBe("pass");
    expect(report.results.credentials.detail).toContain("keys.json");
    dispose();
  });
});

test("credentials: ChatGPT and Grok must both be connected and entitled", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, {
    providers: [
      {
        name: "chatgpt",
        kind: "openai-codex",
        models: { codex: { context_window_tokens: 200000 } },
      },
      {
        name: "grok",
        kind: "xai-grok",
        models: { code: { context_window_tokens: 256000 } },
      },
    ] as never,
    default_model: "chatgpt/codex",
  });
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const ready = () => ({
      "openai-codex": { state: "connected" as const, entitled: true },
      "xai-grok": { state: "connected" as const, entitled: true },
    });
    expect(runGates(buildCtx(dirs, settings, undefined, ready)).results.credentials.status).toBe(
      "pass",
    );

    const grokDenied = () => ({
      "openai-codex": { state: "connected" as const, entitled: true },
      "xai-grok": { state: "connected" as const, entitled: false },
    });
    const result = runGates(buildCtx(dirs, settings, undefined, grokDenied)).results.credentials;
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("grok: entitlement denied");

    const checking = runGates(buildCtx(dirs, settings)).results.credentials;
    expect(checking).toMatchObject({
      status: "pass",
      detail: "chatgpt: subscription check deferred",
    });

    const expired = () => ({
      "openai-codex": { state: "expired" as const },
      "xai-grok": { state: "connected" as const, entitled: true },
    });
    expect(
      runGates(buildCtx(dirs, settings, undefined, expired)).results.credentials,
    ).toMatchObject({
      status: "warn",
      detail: "chatgpt: expired",
    });

    const checkingEntitlement = () => ({
      "openai-codex": { state: "connected" as const },
      "xai-grok": { state: "connected" as const, entitled: true },
    });
    expect(
      runGates(buildCtx(dirs, settings, undefined, checkingEntitlement)).results.credentials,
    ).toMatchObject({ status: "warn", detail: "chatgpt: checking entitlement" });
    dispose();
  });
});

test("default_model: a model the provider does not declare does not resolve either", async () => {
  const dirs = tmpDirs();
  seedAgent(dirs.global, "coder", "model: local/m\ngrants: [edit_workspace]");
  seedCode(dirs.global, { agent: { default: "coder" } });
  // The provider `local` exists and declares exactly one model, `m`. Checking
  // the provider name alone reported `local/ghost` as resolving, so nothing
  // discovered the broken default until the first run failed.
  seedSettings(dirs.global, {
    providers: [KEYLESS_PROVIDER as never],
    default_model: "local/ghost",
  });
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const result = runGates(buildCtx(dirs, settings));
    expect(result.results.default_model.status).toBe("warn");
    expect(result.results.default_model.detail).toContain("does not resolve");
    dispose();
  });
});

test("credentials fixes interactively; backend fixes by reconnecting", () => {
  expect(GATES.find((g) => g.id === "credentials")!.fix).toEqual({ kind: "set-key" });
  expect(GATES.find((g) => g.id === "backend")!.fix).toEqual({ kind: "reconnect" });
});

test("default_model: unresolved model warns; entry-agent model resolves without a default_model", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, { providers: [KEYLESS_PROVIDER as never] });
  seedAgent(dirs.global, "coder", "model: local/m\ngrants: [edit_workspace]");
  seedCode(dirs.global, { agent: { default: "coder" } });
  const okSettings = await settingsFrom(dirs);
  seedSettings(dirs.global, { providers: [KEYLESS_PROVIDER as never], default_model: "ghost/x" });
  const badSettings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const ok = runGates(buildCtx(dirs, okSettings));
    expect(ok.results.default_model.status).toBe("pass");

    const bad = runGates(buildCtx(dirs, badSettings));
    expect(bad.results.default_model.status).toBe("warn");
    expect(bad.results.default_model.detail).toContain("does not resolve");
    dispose();
  });
});

test("default_agent: unset falls back to the shipped entry agent; a broken fallback still warns", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, { providers: [KEYLESS_PROVIDER as never], default_model: "local/m" });
  const okSettings = await settingsFrom(dirs);
  seedSettings(dirs.global, {});
  const brokenSettings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const ok = runGates(buildCtx(dirs, okSettings));
    expect(ok.results.default_agent.status).toBe("pass");
    /* The fleet's own order is what makes this deterministic: `marshall` is
       first because the product says so, not because it sorts first. */
    expect(ok.results.default_agent.detail).toBe("using marshall");

    const broken = runGates(buildCtx(dirs, brokenSettings));
    expect(broken.results.default_agent.status).toBe("warn");
    expect(broken.results.default_agent.detail).toContain("using marshall:");
    dispose();
  });
});

test("run_safety: a not-yet-inspected sandbox passes with detail; a genuinely broken one still warns", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, {
    providers: [KEYLESS_PROVIDER as never],
    default_model: "local/m",
    sandbox: {
      type: "native",
      enabled: true,
      availability: "required",
      filesystem: "workspace-write",
      network: "host",
    } as never,
  });
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const pending = runGates({ ...buildCtx(dirs, settings), sandboxInspection: () => null });
    expect(pending.results.run_safety.status).toBe("pass");
    expect(pending.results.run_safety.detail).toContain("checking sandbox host");

    const broken = runGates({
      ...buildCtx(dirs, settings),
      sandboxInspection: () => ({
        backend: {
          type: "bubblewrap",
          available: false,
          mode: "unavailable",
          degraded: true,
          reason: "not found",
        },
        toolchains: [],
        extra_paths: [],
        effective_path: [],
      }),
    });
    expect(broken.results.run_safety.status).toBe("warn");
    expect(broken.results.run_safety.detail).toContain("sandbox unavailable");
    dispose();
  });
});

test("default_agent: a set-but-nonexistent default warns (ui gate, never blocks)", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, { providers: [KEYLESS_PROVIDER as never], default_model: "local/m" });
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  seedCode(dirs.global, { agent: { default: "ghost" } });
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const report = runGates(buildCtx(dirs, settings));
    expect(report.results.default_agent.status).toBe("warn");
    expect(report.results.default_agent.detail).toContain("no longer exists");
    expect(report.blocked).toBe(false);
    dispose();
  });
});

test("ladder: a corrupt settings.json fails the config gate naming the file, not as missing", async () => {
  const dirs = tmpDirs();
  mkdirSync(dirs.global, { recursive: true });
  mkdirSync(dirname(globalPaths(dirs.global).settingsFile), { recursive: true });
  writeFileSync(globalPaths(dirs.global).settingsFile, '{ "providers": [ BROKEN');
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const report = runGates(buildCtx(dirs, settings));
    expect(report.results.config.status).toBe("fail");
    expect(report.results.config.detail).toContain(globalPaths(dirs.global).settingsFile);
    expect(report.results.config.detail).toContain("invalid JSON");
    expect(report.results.config.fix).toEqual({ kind: "repair-settings", scope: "global" });
    expect(report.blocked).toBe(true);
    expect(startupRoute(buildCtx(dirs, settings), report)).toBe("repair");
    dispose();
  });
});

test("a gate that throws is recorded and degraded, never taken out on the whole report", async () => {
  const dirs = tmpDirs();
  const settings = await settingsFrom(dirs);
  const boom = new Error("probe exploded");
  const directory = openTempDir("clarvis-doctor-diagnostics-");
  const session = createDiagnosticSession({ directory });
  const uninstall = installDiagnosticSession(session);
  const original = GATES.find((g) => g.id === "theme")!;
  const restore = original.check.bind(original);
  original.check = () => {
    throw boom;
  };
  try {
    createRoot((dispose) => {
      const report = runGates(buildCtx(dirs, settings));
      expect(report.results.theme.status).toBe("fail");
      expect(report.results.theme.detail).toContain("probe exploded");
      expect(report.results.config.status).toBeDefined();
      dispose();
    });
  } finally {
    original.check = restore;
    uninstall();
    session.close();
  }

  const failure = readFileSync(session.path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string; details?: Record<string, unknown> })
    .find((record) => record.event === "doctor.check.failed");
  expect(failure?.details?.check_id).toBe("theme");
  expect(typeof failure?.details?.duration_ms).toBe("number");
});

test("the diagnostics gate names the open log, and reads 'off' when nothing is recording", async () => {
  const dirs = tmpDirs();
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    expect(runGates(buildCtx(dirs, settings)).results.diagnostics).toMatchObject({
      status: "pass",
      detail: "off",
    });
    dispose();
  });

  const session = createDiagnosticSession({
    directory: openTempDir("clarvis-doctor-diagnostics-row-"),
    level: "info",
  });
  const uninstall = installDiagnosticSession(session);
  try {
    createRoot((dispose) => {
      expect(runGates(buildCtx(dirs, settings)).results.diagnostics).toMatchObject({
        status: "warn",
        detail: "recording at info",
        hint: session.path,
      });
      dispose();
    });
  } finally {
    uninstall();
    session.close();
  }
});

test("the ladder orders required before recommended before informational; the dead tty gate is gone", () => {
  const rank = (g: (typeof GATES)[number]): number =>
    g.severity === "hard" ? 0 : g.severity === "soft" ? 1 : 2;
  const ranks = GATES.map(rank);
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  expect(GATES.map((g) => g.id as string)).not.toContain("tty");
});

test("corrupt by one stale key: the gate shows path + issue, and the repair plan strips exactly that key", async () => {
  const dirs = tmpDirs();
  const path = globalPaths(dirs.global).settingsFile;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ providers: [KEYLESS_PROVIDER], default_model: "local/m", stale_key: true }),
  );
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const report = runGates(buildCtx(dirs, settings));
    expect(report.results.config.status).toBe("fail");
    expect(report.results.config.detail).toContain(path);
    expect(report.results.config.detail).toContain("stale_key");
    expect(report.results.config.fix).toEqual({ kind: "repair-settings", scope: "global" });
    dispose();
  });

  const plan = await settings.planRepair("global");
  expect(plan).toMatchObject({ action: "strip", path, dropped: ["stale_key"] });
  await settings.applyRepair(plan!);
  expect(settings.corrupt("global")).toBeNull();
  expect(settings.read("global")?.default_model).toBe("local/m");

  await settings.write("global", { default_model: "local/m" });
  createRoot((dispose) => {
    const report = runGates(buildCtx(dirs, settings));
    expect(report.results.config.status).toBe("pass");
    expect(report.blocked).toBe(false);
    dispose();
  });
});

test("corrupt beyond parsing: the repair plan is a reset, and applying it leaves a valid empty scope", async () => {
  const dirs = tmpDirs();
  mkdirSync(dirs.global, { recursive: true });
  const path = globalPaths(dirs.global).settingsFile;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{ "providers": [ BROKEN');
  const settings = await settingsFrom(dirs);
  const plan = await settings.planRepair("global");
  expect(plan).toMatchObject({ action: "reset", path });
  await settings.applyRepair(plan!);
  expect(settings.corrupt("global")).toBeNull();
  expect(settings.read("global")).toEqual({});
});

test("planRepair on a healthy scope is null — the fix action never invents work", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, { providers: [KEYLESS_PROVIDER as never], default_model: "local/m" });
  const settings = await settingsFrom(dirs);
  expect(await settings.planRepair("global")).toBeNull();
});

test("memory: unconfigured warns; configured resolves through default_model", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, { providers: [KEYLESS_PROVIDER as never], default_model: "local/m" });
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  const withoutSettings = await settingsFrom(dirs);
  seedSettings(dirs.global, {
    providers: [KEYLESS_PROVIDER as never],
    default_model: "local/m",
    memory: {} as never,
  });
  const withSettings = await settingsFrom(dirs);
  createRoot((dispose) => {
    // The block is seeded on first use, so an absent one means the seed was
    // refused — worth saying out loud, but never blocking.
    const without = runGates(buildCtx(dirs, withoutSettings));
    expect(without.results.memory.status).toBe("warn");
    expect(without.results.memory.detail).toBe("not configured");
    expect(without.blocked).toBe(false);

    const withBlock = runGates(buildCtx(dirs, withSettings));
    expect(withBlock.results.memory.status).toBe("pass");
    expect(withBlock.results.memory.detail).toBe("local/m");
    dispose();
  });
});

test("plans: unconfigured reports the defaults; an explicit block reports its policy", async () => {
  const dirs = tmpDirs();
  const base = { providers: [KEYLESS_PROVIDER as never], default_model: "local/m" };
  seedSettings(dirs.global, base);
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  const unconfigured = await settingsFrom(dirs);
  seedSettings(dirs.global, {
    ...base,
    plans: { mode: "review", retention: "discard" } as never,
  });
  const review = await settingsFrom(dirs);
  seedSettings(dirs.global, { ...base, plans: { mode: "off" } as never });
  const off = await settingsFrom(dirs);
  createRoot((dispose) => {
    const none = runGates(buildCtx(dirs, unconfigured));
    expect(none.results.plans.status).toBe("pass");
    expect(none.results.plans.detail).toContain("(defaults)");
    expect(none.results.plans.detail).toContain("keep");
    expect(none.blocked).toBe(false);

    const gated = runGates(buildCtx(dirs, review));
    expect(gated.results.plans.detail).toContain("approval required");
    expect(gated.results.plans.detail).toContain("delete after success");

    expect(runGates(buildCtx(dirs, off)).results.plans.detail).toBe("off");
    dispose();
  });
});

test("run_safety: a sandboxed, LLM-reviewed guard resolves to the 'reviewed' preset", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, {
    providers: [KEYLESS_PROVIDER as never],
    default_model: "local/m",
    guard: { type: "shell", mode: "auto" } as never,
    sandbox: {
      type: "native",
      enabled: true,
      availability: "required",
      filesystem: "workspace-write",
      network: "host",
    } as never,
  });
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const report = runGates(buildCtx(dirs, settings));
    expect(report.results.run_safety.detail).toContain("reviewed");
    dispose();
  });
});

test("memory: enabled but without a resolvable extraction model warns; disabled passes", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, { providers: [KEYLESS_PROVIDER as never], memory: {} as never });
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  const noModelSettings = await settingsFrom(dirs);
  seedSettings(dirs.global, {
    providers: [KEYLESS_PROVIDER as never],
    memory: { enabled: false },
  });
  const disabledSettings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const noModel = runGates(buildCtx(dirs, noModelSettings));
    expect(noModel.results.memory.status).toBe("warn");
    expect(noModel.results.memory.detail).toContain("model");

    const disabled = runGates(buildCtx(dirs, disabledSettings));
    expect(disabled.results.memory.status).toBe("pass");
    expect(disabled.results.memory.detail).toContain("disabled");
    dispose();
  });
});

test("workspace_trust: a repository that asks to run code is refused and the human is told", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, { providers: [KEYLESS_PROVIDER as never], default_model: "local/m" });
  seedAgent(dirs.global, "coder", "grants: [edit_workspace]");
  const clean = await settingsFrom(dirs);

  seedSettings(
    dirs.workspace!,
    {
      hooks: [{ event: "session_start", command: "touch /tmp/pwned" }],
    } as never,
    "workspace",
  );
  const hostile = await settingsFrom(dirs);

  createRoot((dispose) => {
    const quiet = runGates(buildCtx(dirs, clean));
    expect(quiet.results.workspace_trust.status).toBe("pass");
    expect(quiet.results.workspace_trust.detail).toBe("nothing to approve");

    const warned = runGates(buildCtx(dirs, hostile));
    expect(warned.results.workspace_trust.status).toBe("warn");
    expect(warned.results.workspace_trust.detail).toContain("hooks");
    expect(hostile.effective().hooks).toBeUndefined();
    dispose();
  });
});

test("agents gate hard-fails when the effective fleet is actually empty", async () => {
  const dirs = tmpDirs();
  seedSettings(dirs.global, {
    providers: [KEYLESS_PROVIDER as never],
    default_model: "local/m",
  });
  const settings = await settingsFrom(dirs);
  createRoot((dispose) => {
    const ctx: DoctorCtx = {
      ...buildCtx(dirs, settings),
      agents: { list: () => [], conflicts: () => [] },
    };
    const report = runGates(ctx);
    expect(report.results.agents).toMatchObject({ status: "fail", detail: "no agents" });
    expect(report.blocked).toBe(true);
    expect(bootGate(report)).toBe("doctor");
    dispose();
  });
});
