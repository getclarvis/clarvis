import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRoot, createSignal } from "solid-js";
import { openTempDir } from "../helpers/tracked-temp.ts";
import {
  createCodeConfigStore,
  mergeEffectiveTheme,
  mergeThemeBlock,
  type CodeConfig,
} from "../../src/adapters/code-config.ts";
import { createThemePreview } from "../../src/theme/theme.ts";
import { readStartupKeySources } from "../../src/adapters/startup-key-sources.ts";
import type { ThemeConfig } from "../../src/theme/model.ts";
import type { ClarvisDirs } from "../../src/adapters/agents.ts";
import {
  globalPaths,
  workspacePaths,
  workspaceStatePaths,
  type WorkspaceStatePaths,
} from "@clarvis/paths";

function tmpDirs(): ClarvisDirs & { state: WorkspaceStatePaths } {
  const root = openTempDir("clarvis-cfg-");
  const ws = join(root, "workspace");
  const env = { CLARVIS_HOME: join(root, "global") };
  return {
    global: globalPaths(join(root, "global")),
    workspace: workspacePaths(ws),
    state: workspaceStatePaths(ws, { env }),
  };
}
function seed(file: string, cfg: CodeConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2));
}
function readCfg(file: string): CodeConfig {
  return JSON.parse(readFileSync(file, "utf8")) as CodeConfig;
}

test("effectiveTheme: workspace overrides shadow global per token; mode/preset workspace-wins", () => {
  createRoot((dispose) => {
    const dirs = tmpDirs();
    seed(dirs.global.codeConfigFile, {
      theme: {
        mode: "dark",
        preset: "family",
        overrides: { dark: { accent: "#111111", bg: "#000000" } },
      },
    });
    seed(dirs.state.codeConfigFile, {
      theme: { preset: "high-contrast", overrides: { dark: { accent: "#222222" } } },
    });
    const code = createCodeConfigStore(dirs);
    const eff = code.effectiveTheme();
    expect(eff.mode).toBe("dark");
    expect(eff.preset).toBe("high-contrast");
    expect(eff.overrides?.dark?.accent).toBe("#222222");
    expect(eff.overrides?.dark?.bg).toBe("#000000");
    dispose();
  });
});

test("mergeThemeBlock: an undefined patch value deletes the override key (token reset)", () => {
  const base: ThemeConfig = { overrides: { dark: { accent: "#111111", bg: "#000000" } } };
  const next = mergeThemeBlock(base, { overrides: { dark: { accent: undefined } } });
  expect(Object.keys(next.overrides?.dark ?? {})).toEqual(["bg"]);
  expect("accent" in (next.overrides?.dark ?? {})).toBe(false);
});

test("mergeEffectiveTheme: an undefined workspace entry never shadows the global value", () => {
  const g: ThemeConfig = { overrides: { dark: { accent: "#111111" } } };
  const w: ThemeConfig = { overrides: { dark: { accent: undefined } } };
  expect(mergeEffectiveTheme(g, w).overrides?.dark?.accent).toBe("#111111");
});

test("theme preview reset walks the chain: workspace → global → preset", () => {
  createRoot((dispose) => {
    const dirs = tmpDirs();
    seed(dirs.global.codeConfigFile, { theme: { overrides: { dark: { accent: "#111111" } } } });
    seed(dirs.state.codeConfigFile, { theme: { overrides: { dark: { accent: "#222222" } } } });
    const code = createCodeConfigStore(dirs);
    const [g, setG] = createSignal<ThemeConfig | null>(null);
    const [w, setW] = createSignal<ThemeConfig | null>(null);
    const preview = createThemePreview(code, {
      global: g,
      setGlobal: setG,
      workspace: w,
      setWorkspace: setW,
    });
    expect(preview.resolveToken("accent", "dark", "family").source).toBe("override-workspace");
    preview.set("workspace", { overrides: { dark: { accent: undefined } } });
    expect(preview.resolveToken("accent", "dark", "family")).toMatchObject({
      value: "#111111",
      source: "override-global",
    });
    preview.set("global", { overrides: { dark: { accent: undefined } } });
    expect(preview.resolveToken("accent", "dark", "family").source).toBe("family");
    dispose();
  });
});

test("theme preview carries `background` through set, the effective merge and commit", async () => {
  const dirs = tmpDirs();
  seed(dirs.global.codeConfigFile, { theme: { background: "terminal" } });
  seed(dirs.state.codeConfigFile, {});
  let commitDone!: Promise<void>;
  createRoot((dispose) => {
    const code = createCodeConfigStore(dirs);
    const [g, setG] = createSignal<ThemeConfig | null>(null);
    const [w, setW] = createSignal<ThemeConfig | null>(null);
    const preview = createThemePreview(code, {
      global: g,
      setGlobal: setG,
      workspace: w,
      setWorkspace: setW,
    });
    expect(preview.source().background).toBe("terminal");
    preview.set("workspace", { background: "themed" });
    preview.set("workspace", { mode: "light" });
    expect(preview.source().background).toBe("themed");
    commitDone = preview.commit();
    dispose();
  });
  await commitDone;
  expect(readCfg(dirs.state.codeConfigFile).theme?.background).toBe("themed");
  expect(readCfg(dirs.state.codeConfigFile).theme?.mode).toBe("light");
});

test("writeTheme/writeAscii: atomic writes preserve other blocks and update signals", () => {
  createRoot((dispose) => {
    const dirs = tmpDirs();
    seed(dirs.global.codeConfigFile, {
      agent: { default: "answerer" },
    });
    const code = createCodeConfigStore(dirs);
    code.writeTheme("global", { preset: "mono", overrides: { dark: { fg: "#eeeeee" } } });
    let disk = readCfg(dirs.global.codeConfigFile);
    expect(disk.theme?.preset).toBe("mono");
    expect(disk.agent?.default).toBe("answerer");
    expect(code.effectiveTheme().preset).toBe("mono");

    code.writeAscii("global", false);
    disk = readCfg(dirs.global.codeConfigFile);
    expect(disk.ui?.ascii).toBe(false);
    expect(disk.theme?.preset).toBe("mono");
    expect(code.asciiEnabled()).toBe(false);
    dispose();
  });
});

test("ascii glyphs are opt-in, while explicit global and workspace choices still layer", () => {
  createRoot((dispose) => {
    const dirs = tmpDirs();
    seed(dirs.global.codeConfigFile, {});
    seed(dirs.state.codeConfigFile, {});
    const code = createCodeConfigStore(dirs);

    expect(code.asciiEnabled()).toBe(false);
    code.writeAscii("global", true);
    expect(code.asciiEnabled()).toBe(true);
    code.writeAscii("workspace", false);
    expect(code.asciiEnabled()).toBe(false);
    dispose();
  });
});

test("keyboard profiles persist globally by opaque environment id and preserve UI fields", () => {
  createRoot((dispose) => {
    const dirs = tmpDirs();
    seed(dirs.global.codeConfigFile, { ui: { ascii: false } });
    seed(dirs.state.codeConfigFile, {
      ui: {
        keyboard: {
          version: 1,
          environments: { workspaceOnly: { profile: "manual" } },
        },
      },
    });
    const code = createCodeConfigStore(dirs);
    const environmentId = "0123456789abcdef01234567";
    code.writeKeyboardEnvironment(environmentId, {
      profile: "manual",
      clientPlatform: "macos",
      verdicts: { super: "supported" },
      bindings: { "safety.picker": ["f8"] },
    });

    expect(code.keyboardConfig().environments[environmentId]).toEqual({
      profile: "manual",
      clientPlatform: "macos",
      verdicts: { super: "supported" },
      bindings: { "safety.picker": ["f8"] },
    });
    expect(readCfg(dirs.global.codeConfigFile).ui?.ascii).toBe(false);
    expect(readCfg(dirs.state.codeConfigFile).ui?.keyboard).toBeDefined();

    code.writeKeyboardEnvironment(environmentId, undefined);
    expect(code.keyboardConfig().environments[environmentId]).toBeUndefined();
    expect(() => code.writeKeyboardEnvironment("hostname", { profile: "portable" })).toThrow(
      "invalid keyboard environment id",
    );
    dispose();
  });
});

test("automatic version checks default on, ignore workspace config and write only globally", () => {
  createRoot((dispose) => {
    const dirs = tmpDirs();
    seed(dirs.global.codeConfigFile, { theme: { preset: "mono" } });
    seed(dirs.state.codeConfigFile, { updateCheck: { enabled: false } });
    const code = createCodeConfigStore(dirs);

    expect(code.updateCheckEnabled()).toBe(true);
    code.writeUpdateCheckEnabled(false);
    expect(code.updateCheckEnabled()).toBe(false);
    expect(readCfg(dirs.global.codeConfigFile)).toEqual({
      theme: { preset: "mono" },
      updateCheck: { enabled: false },
    });
    expect(readCfg(dirs.state.codeConfigFile)).toEqual({ updateCheck: { enabled: false } });

    seed(dirs.state.codeConfigFile, { updateCheck: { enabled: true } });
    expect(createCodeConfigStore(dirs).updateCheckEnabled()).toBe(false);
    dispose();
  });
});

test("writeAgentDefault is clobber-safe against an independent on-disk edit", () => {
  createRoot((dispose) => {
    const dirs = tmpDirs();
    seed(dirs.global.codeConfigFile, { agent: { default: "answerer" } });
    const code = createCodeConfigStore(dirs);
    const onDisk = readCfg(dirs.global.codeConfigFile);
    onDisk.theme = { preset: "mono" };
    writeFileSync(dirs.global.codeConfigFile, JSON.stringify(onDisk, null, 2));
    code.writeAgentDefault("global", "coder");
    const after = readCfg(dirs.global.codeConfigFile);
    expect(after.agent?.default).toBe("coder");
    expect(after.theme?.preset).toBe("mono");
    dispose();
  });
});

test("overrideSource reports the winning scope for a token", () => {
  createRoot((dispose) => {
    const dirs = tmpDirs();
    seed(dirs.global.codeConfigFile, {
      theme: { overrides: { dark: { accent: "#111111", bg: "#000000" } } },
    });
    seed(dirs.state.codeConfigFile, { theme: { overrides: { dark: { accent: "#222222" } } } });
    const code = createCodeConfigStore(dirs);
    expect(code.overrideSource("dark", "accent")).toBe("workspace");
    expect(code.overrideSource("dark", "bg")).toBe("global");
    expect(code.overrideSource("dark", "fg")).toBeNull();
    dispose();
  });
});

test("agentDefault: workspace wins, undefined when empty", () => {
  createRoot((dispose) => {
    const dirs = tmpDirs();
    seed(dirs.global.codeConfigFile, { agent: { default: "answerer" } });
    seed(dirs.state.codeConfigFile, { agent: { default: "coder" } });
    const code = createCodeConfigStore(dirs);
    expect(code.agentDefault()).toBe("coder");
    dispose();
  });
});

test("clearAgentDefault removes only the selected scope and restores inheritance", () => {
  createRoot((dispose) => {
    const dirs = tmpDirs();
    seed(dirs.global.codeConfigFile, {
      agent: { default: "answerer" },
      theme: { preset: "mono" },
    });
    seed(dirs.state.codeConfigFile, { agent: { default: "coder" } });
    const code = createCodeConfigStore(dirs);

    code.clearAgentDefault("workspace");
    expect(code.agentDefault()).toBe("answerer");
    expect(readCfg(dirs.state.codeConfigFile).agent).toBeUndefined();

    code.clearAgentDefault("global");
    const global = readCfg(dirs.global.codeConfigFile);
    expect(code.agentDefault()).toBeUndefined();
    expect(global.agent).toBeUndefined();
    expect(global.theme?.preset).toBe("mono");
    dispose();
  });
});

test("guardModeDefault: workspace wins, invalid strings coerce to undefined", () => {
  createRoot((dispose) => {
    const dirs = tmpDirs();
    seed(dirs.global.codeConfigFile, { guard: { mode: "on" } });
    seed(dirs.state.codeConfigFile, { guard: { mode: "auto" } });
    expect(createCodeConfigStore(dirs).guardModeDefault()).toBe("auto");

    const dirs2 = tmpDirs();
    seed(dirs2.global.codeConfigFile, { guard: { mode: "yes" } });
    expect(createCodeConfigStore(dirs2).guardModeDefault()).toBeUndefined();

    const dirs3 = tmpDirs();
    expect(createCodeConfigStore(dirs3).guardModeDefault()).toBeUndefined();
    dispose();
  });
});

test("keySources: workspace wins per var; writeKeySource round-trips and 'auto' prunes", () => {
  createRoot((dispose) => {
    const dirs = tmpDirs();
    seed(dirs.global.codeConfigFile, { keySources: { A_KEY: "env", B_KEY: "keyfile" } });
    seed(dirs.state.codeConfigFile, { keySources: { A_KEY: "keyfile" } });
    const code = createCodeConfigStore(dirs);
    expect(code.keySource("A_KEY")).toBe("keyfile");
    expect(code.keySource("B_KEY")).toBe("keyfile");
    expect(code.keySource("UNSET_KEY")).toBe("auto");

    code.writeKeySource("global", "C_KEY", "env");
    expect(readCfg(dirs.global.codeConfigFile).keySources?.C_KEY).toBe("env");
    expect(code.keySource("C_KEY")).toBe("env");

    code.writeKeySource("global", "A_KEY", "auto");
    expect(readCfg(dirs.global.codeConfigFile).keySources?.A_KEY).toBeUndefined();
    dispose();
  });
});

test("startup key-source projection preserves precedence and fails invalid values to auto", () => {
  const dirs = tmpDirs();
  seed(dirs.global.codeConfigFile, {
    keySources: { SHARED_KEY: "env", GLOBAL_KEY: "keyfile" },
    theme: { mode: "dark" },
  });
  mkdirSync(dirname(dirs.state.codeConfigFile), { recursive: true });
  writeFileSync(
    dirs.state.codeConfigFile,
    JSON.stringify({ keySources: { SHARED_KEY: "keyfile", INVALID_KEY: "prompt" } }),
  );

  expect(readStartupKeySources(dirs)).toEqual({
    SHARED_KEY: "keyfile",
    GLOBAL_KEY: "keyfile",
    INVALID_KEY: "auto",
  });
});

test("writeKeySource: setting every var back to auto drops the keySources block entirely", () => {
  createRoot((dispose) => {
    const dirs = tmpDirs();
    seed(dirs.global.codeConfigFile, { agent: { default: "coder" }, keySources: { A_KEY: "env" } });
    const code = createCodeConfigStore(dirs);
    code.writeKeySource("global", "A_KEY", "auto");
    const disk = readCfg(dirs.global.codeConfigFile);
    expect("keySources" in disk).toBe(false);
    expect(disk.agent?.default).toBe("coder");
    dispose();
  });
});

test("corrupt code.json: reads stay tolerant, but persist refuses instead of clobbering", () => {
  createRoot((dispose) => {
    const dirs = tmpDirs();
    mkdirSync(dirname(dirs.global.codeConfigFile), { recursive: true });
    const raw = '{ "theme": BROKEN';
    writeFileSync(dirs.global.codeConfigFile, raw);
    const code = createCodeConfigStore(dirs);
    expect(code.read("global")).toEqual({});
    expect(() => code.writeAgentDefault("global", "coder")).toThrow(/invalid JSON/);
    expect(() => code.writeTheme("global", { mode: "dark" })).toThrow(/invalid JSON/);
    expect(readFileSync(dirs.global.codeConfigFile, "utf8")).toBe(raw);
    dispose();
  });
});
