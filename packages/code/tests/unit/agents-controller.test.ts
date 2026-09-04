import { expect, test } from "bun:test";
import { createRoot, createSignal, type Accessor } from "solid-js";
import type { SettingsAdapter } from "../../src/adapters/settings.ts";
import type { CodeConfigStore } from "../../src/adapters/code-config.ts";
import type { AgentsStore } from "../../src/adapters/agents-store.ts";
import type { AgentFile, EnvView } from "../../src/adapters/agent-files.ts";
import type { Scope } from "../../src/adapters/settings.ts";
import {
  createAgentsController,
  grantTier,
  sanitizeAgentName,
  type AgentsControllerDeps,
} from "../../src/features/agents/controller.ts";
import { presentAgentsEvent } from "../../src/features/agents/events.ts";

const ENV: EnvView = {
  budgetOnExceed: "escalate",
  iterationDefault: 50,
  iterationCeiling: 100,
  tokenDefault: 4_000_000,
  tokenCeiling: 5_000_000,
  maxGrant: "exec",
  contextWindowDefault: 128000,
};

function agent(name: string, fm: AgentFile["frontmatter"] = {}, body = ""): AgentFile {
  return { name, scope: "global", frontmatter: fm, body };
}

function fakeAgentsStore(initial: AgentFile[]): AgentsStore & { written: AgentFile[] } {
  const [list, setList] = createSignal<AgentFile[]>(initial);
  const written: AgentFile[] = [];
  return {
    list,
    conflicts: () => [],
    read: async (name, scope) => list().find((a) => a.name === name && a.scope === scope) ?? null,
    write: async (file) => {
      written.push(file);
      setList((l) => [...l.filter((a) => !(a.name === file.name && a.scope === file.scope)), file]);
    },
    remove: async (name, scope) => {
      setList((l) => l.filter((a) => !(a.name === name && a.scope === scope)));
    },
    rename: async (oldName, newName, scope) => {
      setList((l) =>
        l.map((a) => (a.name === oldName && a.scope === scope ? { ...a, name: newName } : a)),
      );
    },
    reload: async () => {},
    written,
  };
}

function fakeSettings(providerNames: string[]): SettingsAdapter {
  const providers = providerNames.map((name) => ({ name, kind: "openai-compatible" as const }));
  return {
    version: () => 0,
    read: () => ({ providers }),
    origin: () => "global",
    planRepair: () => null,
    applyRepair: async () => {},
    effective: () => ({ providers }),
    effectiveProviders: () => [],
    knownGrants: () => undefined,
    withheldWorkspaceFields: () => [],
    workspaceTrust: () => "inert",
    setWorkspaceTrust: async () => {},
    validateProviders: () => ({ ok: true }),
    refs: () => ({ agents: [], defaultModel: false }),
    modelRefs: () => ({ agents: [], defaultModel: false }),
    envStatus: () => "unset",
    corrupt: () => null,
    sources: () => ({ global: "/tmp/settings.json" }),
    write: async () => {},
    declaredMcpServers: () => [],
    reload: async () => {},
    inspectSandbox: async () => {
      throw new Error("sandbox inspection is outside the agents controller contract");
    },
  };
}

interface FakeCodeStore extends CodeConfigStore {
  defaultWrites: { scope: Scope; name: string }[];
}

function fakeCode(agentDefault?: string): FakeCodeStore {
  const defaultWrites: FakeCodeStore["defaultWrites"] = [];
  return {
    read: () => ({}),
    themeAt: () => ({}),
    effectiveTheme: () => ({}),
    agentDefault: () => agentDefault,
    guardModeDefault: () => undefined,
    updateCheckEnabled: () => true,
    asciiEnabled: () => false,
    keyboardConfig: () => ({ version: 1, environments: {} }),
    keySources: () => ({}),
    keySource: () => "auto",
    overrideSource: () => null,
    write: () => {},
    writeAscii: () => {},
    writeKeyboardEnvironment: () => {},
    writeUpdateCheckEnabled: () => {},
    writeTheme: () => {},
    writeAgentDefault: (scope, name) => defaultWrites.push({ scope, name }),
    clearAgentDefault: () => {},
    writeKeySource: () => {},
    hasWorkspace: () => false,
    defaultWrites,
  };
}

function setup(
  initial: AgentFile[],
  opts?: { scope?: Scope; providers?: string[]; confirm?: () => Promise<boolean> },
) {
  const notes: string[] = [];
  let dirty = false;
  const [scope] = createSignal<Scope>(opts?.scope ?? "global");
  const agents = fakeAgentsStore(initial);
  const code = fakeCode();
  let controller!: ReturnType<typeof createAgentsController>;
  let disposeRoot!: () => void;
  createRoot((dispose) => {
    disposeRoot = dispose;
    const deps: AgentsControllerDeps = {
      agents,
      settings: fakeSettings(opts?.providers ?? ["ghost"]),
      code,
      env: ENV,
      scope: scope as Accessor<Scope>,
      markDirty: (v) => {
        dirty = v ?? true;
      },
      emit: (event) => notes.push(presentAgentsEvent(event).message),
      confirm: opts?.confirm ?? (async () => false),
    };
    controller = createAgentsController(deps);
  });
  return {
    ctrl: controller,
    agents,
    code,
    notes,
    isDirty: () => dirty,
    dispose: () => {
      controller.dispose();
      disposeRoot();
    },
  };
}

test("patchFm merges frontmatter and marks dirty", () => {
  const { ctrl, isDirty, dispose } = setup([]);
  ctrl.setDraft(agent("a"));
  ctrl.patchFm({ description: "hello" });
  ctrl.patchFm({ iteration_limit: 3 });
  const d = ctrl.draft()!;
  expect(d.frontmatter.description).toBe("hello");
  expect(d.frontmatter.iteration_limit).toBe(3);
  expect(isDirty()).toBe(true);
  dispose();
});

test("toggleGrant adds and removes a grant, unsets when empty", () => {
  const { ctrl, dispose } = setup([]);
  ctrl.setDraft(agent("a"));
  ctrl.toggleGrant("read_workspace");
  expect(ctrl.draft()!.frontmatter.grants).toEqual(["read_workspace"]);
  ctrl.toggleGrant("read_workspace");
  expect(ctrl.draft()!.frontmatter.grants).toBeUndefined();
  dispose();
});

test("toggleSpawn clearing the list also clears default_spawn", () => {
  const { ctrl, dispose } = setup([]);
  ctrl.setDraft(agent("a", { can_spawn: ["b"], default_spawn: "b" }));
  ctrl.toggleSpawn("b");
  expect(ctrl.draft()!.frontmatter.can_spawn).toBeUndefined();
  expect(ctrl.draft()!.frontmatter.default_spawn).toBeUndefined();
  dispose();
});

test("toggleSpawn keeps default_spawn when it stays in the list", () => {
  const { ctrl, dispose } = setup([]);
  ctrl.setDraft(agent("a", { can_spawn: ["b", "c"], default_spawn: "b" }));
  ctrl.toggleSpawn("c");
  expect(ctrl.draft()!.frontmatter.can_spawn).toEqual(["b"]);
  expect(ctrl.draft()!.frontmatter.default_spawn).toBe("b");
  dispose();
});

test("toggleSpawn ignores the draft's own name", () => {
  const { ctrl, dispose } = setup([]);
  ctrl.setDraft(agent("a"));
  ctrl.toggleSpawn("a");
  expect(ctrl.draft()!.frontmatter.can_spawn).toBeUndefined();
  dispose();
});

test("save is blocked on error-level draft issues", async () => {
  // default_spawn not in can_spawn → file-local error → blocked
  const { ctrl, notes, dispose } = setup([], { providers: ["ghost"] });
  ctrl.setDraft(agent("a", { model: "ghost/gpt-x", can_spawn: ["b"], default_spawn: "c" }));
  const outcome = await ctrl.save();
  expect(outcome).toBe("blocked");
  expect(notes.some((n) => n.startsWith("cannot save"))).toBe(true);
  dispose();
});

test("save writes when the draft is runnable and reports warnings", async () => {
  const { ctrl, notes, dispose } = setup([]);
  ctrl.setDraft(agent("a", { model: "ghost/gpt-x" }));
  const outcome = await ctrl.save();
  expect(outcome).toBe("saved");
  expect(notes.some((n) => n.includes("saved agent 'a'"))).toBe(true);
  dispose();
});

test("save returns fork-needed when the scope moved away from the draft scope", async () => {
  const { ctrl, dispose } = setup([], { scope: "workspace" });
  ctrl.setDraft(agent("a", { model: "ghost/gpt-x" }));
  const outcome = await ctrl.save();
  expect(outcome).toBe("fork-needed");
  dispose();
});

test("grantTier ranks grants by highest capability", () => {
  expect(grantTier([])).toBe("none");
  expect(grantTier(["read_workspace"])).toBe("read");
  expect(grantTier(["read_workspace", "edit_workspace"])).toBe("edit");
  expect(grantTier(["edit_workspace", "run_commands"])).toBe("exec");
});

test("sanitizeAgentName strips unsafe characters and rejects empties", () => {
  expect(sanitizeAgentName("  my agent! ")).toBe("my-agent-");
  expect(sanitizeAgentName("   ")).toBeNull();
});

test("dispose prevents an in-flight save from republishing controller state", async () => {
  const { ctrl, agents, notes, dispose } = setup([]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  agents.write = async (file) => {
    await gate;
    agents.written.push(file);
  };
  ctrl.setDraft(agent("a", { model: "ghost/gpt-x" }));
  const saving = ctrl.save();
  ctrl.dispose();
  release();
  expect(await saving).toBe("saved");
  expect(ctrl.draft()).toBeNull();
  expect(notes.some((note) => note.includes("saved agent"))).toBe(false);
  dispose();
});

test("rename owns draft identity and re-points agent/default references after confirmation", async () => {
  const builder = agent("builder", { can_spawn: ["explorer"], default_spawn: "explorer" });
  const explorer = agent("explorer");
  const { ctrl, agents, code, notes, dispose } = setup([builder, explorer], {
    confirm: async () => true,
  });
  code.agentDefault = () => "explorer";
  ctrl.openDraft(explorer);

  await ctrl.rename("explorer", "explorer2", "global");

  expect(ctrl.draft()?.name).toBe("explorer2");
  expect(agents.list().find((item) => item.name === "builder")?.frontmatter).toMatchObject({
    can_spawn: ["explorer2"],
    default_spawn: "explorer2",
  });
  expect(code.defaultWrites).toEqual([{ scope: "global", name: "explorer2" }]);
  expect(
    notes.some((note) => note.includes("renamed 'explorer'") && note.includes("'explorer2'")),
  ).toBe(true);
  dispose();
});

test("fork and remove own persistence while keeping the active draft coherent", async () => {
  const explorer = agent("explorer");
  const { ctrl, agents, dispose } = setup([explorer]);
  ctrl.openDraft(explorer);

  await ctrl.forkWithNewName(explorer, "workspace", "explorer-copy");
  expect(agents.list()).toContainEqual(expect.objectContaining({ name: "explorer-copy" }));
  expect(ctrl.draft()?.name).toBe("explorer");

  await ctrl.remove("explorer", "global");
  expect(agents.list().some((item) => item.name === "explorer")).toBe(false);
  expect(ctrl.draft()).toBeNull();
  dispose();
});

test("persistence failures stay owned by the controller and preserve recoverable state", async () => {
  const saving = setup([]);
  saving.ctrl.setDraft(agent("save-me", { model: "ghost/gpt-x" }));
  saving.ctrl.setBody("new body");
  saving.agents.write = async () => {
    throw new Error("write denied");
  };
  expect(await saving.ctrl.save()).toBe("error");
  expect(saving.ctrl.draft()?.body).toBe("new body");
  expect(saving.notes.some((note) => note.includes("write denied"))).toBe(true);
  saving.dispose();

  const forking = setup([]);
  forking.agents.write = async () => {
    throw new Error("fork denied");
  };
  await forking.ctrl.forkWithNewName(agent("source"), "workspace", "copy");
  expect(forking.notes.some((note) => note.includes("fork denied"))).toBe(true);
  forking.dispose();

  const creating = setup([agent("taken")]);
  expect(await creating.ctrl.createFromTemplate("taken")).toBeNull();
  expect(creating.notes.some((note) => note.includes("already exists"))).toBe(true);
  creating.agents.write = async () => {
    throw new Error("create denied");
  };
  expect(await creating.ctrl.createFromTemplate("new-agent")).toBeNull();
  expect(creating.notes.some((note) => note.includes("create denied"))).toBe(true);
  creating.dispose();

  const mutating = setup([agent("original")]);
  mutating.ctrl.openDraft(agent("original"));
  mutating.agents.rename = async () => {
    throw new Error("rename denied");
  };
  await mutating.ctrl.rename("original", "renamed", "global");
  expect(mutating.ctrl.draft()?.name).toBe("original");
  expect(mutating.notes.some((note) => note.includes("rename denied"))).toBe(true);
  mutating.agents.remove = async () => {
    throw new Error("delete denied");
  };
  expect(mutating.ctrl.remove("original", "global")).rejects.toThrow("delete denied");
  expect(mutating.ctrl.draft()?.name).toBe("original");
  expect(mutating.notes.some((note) => note.includes("delete denied"))).toBe(true);
  mutating.dispose();
});

/** The shipped `marshall`, as the panel receives it when no file overlays it. */
function shipped(): AgentFile {
  return {
    name: "marshall",
    scope: "builtin",
    frontmatter: {
      description: "Coding Lead",
      model: "ghost/gpt-x",
      grants: ["edit_workspace", "read_workspace"],
      can_spawn: ["helper"],
      default_spawn: "helper",
      iteration_limit: 50,
    },
    body: "You are marshall.",
  };
}

test("saving a shipped agent writes only what changed, into the current scope", async () => {
  const { ctrl, agents, notes, dispose } = setup([shipped()]);
  ctrl.setDraft(shipped());
  ctrl.patchFm({ iteration_limit: 80 });
  expect(await ctrl.save()).toBe("saved");

  expect(agents.written).toHaveLength(1);
  const written = agents.written[0]!;
  expect(written.scope).toBe("global");
  expect(written.name).toBe("marshall");
  /* Not a copy of the shipped profile: one key, and no body at all, so every
     other field keeps tracking the default. */
  expect(written.frontmatter).toEqual({ iteration_limit: 80 });
  expect(written.body).toBe("");
  expect(notes.some((n) => n.includes("saved agent 'marshall'"))).toBe(true);
  dispose();
});

test("saving a shipped agent whose prompt changed carries the prompt and nothing else", async () => {
  const { ctrl, agents, dispose } = setup([shipped()]);
  ctrl.setDraft(shipped());
  ctrl.setBody("Fale sempre em português.");
  expect(await ctrl.save()).toBe("saved");
  expect(agents.written[0]!.frontmatter).toEqual({});
  expect(agents.written[0]!.body).toBe("Fale sempre em português.");
  dispose();
});

test("saving a shipped agent unchanged writes nothing and says so", async () => {
  const { ctrl, agents, notes, dispose } = setup([shipped()]);
  ctrl.setDraft(shipped());
  expect(await ctrl.save()).toBe("saved");
  expect(agents.written).toHaveLength(0);
  expect(notes.some((n) => n.includes("matches the shipped default"))).toBe(true);
  dispose();
});

test("saving a shipped agent Clarvis no longer ships reports the error, not a silent write", async () => {
  const { ctrl, agents, notes, dispose } = setup([]);
  ctrl.setDraft({ ...shipped(), name: "marshall" });
  expect(await ctrl.save()).toBe("error");
  expect(agents.written).toHaveLength(0);
  expect(notes.some((n) => n.includes("no longer shipped"))).toBe(true);
  dispose();
});

test("creating an agent under a shipped name is refused rather than becoming a customization", async () => {
  const { ctrl, agents, notes, dispose } = setup([]);
  expect(await ctrl.createFromTemplate("coder")).toBeNull();
  expect(agents.written).toHaveLength(0);
  expect(notes.some((n) => n.includes("already exists"))).toBe(true);
  dispose();
});

test("deleting a customized shipped agent is reported as a reset, not a deletion", async () => {
  const customized: AgentFile = { ...shipped(), scope: "global" };
  const { ctrl, notes, dispose } = setup([customized]);
  await ctrl.remove("marshall", "global");
  expect(notes.some((n) => n.includes("reset to the shipped default"))).toBe(true);
  dispose();
});

test("re-pointing a shipped agent's spawn list writes a customization, not a copy", async () => {
  const { ctrl, agents, dispose } = setup([shipped(), agent("helper", { model: "ghost/gpt-x" })], {
    confirm: async () => true,
  });
  await ctrl.rename("helper", "assistant", "global");

  const overlay = agents.written.find((f) => f.name === "marshall");
  expect(overlay?.scope).toBe("global");
  expect(overlay?.frontmatter).toEqual({
    can_spawn: ["assistant"],
    default_spawn: "assistant",
  });
  expect(overlay?.body).toBe("");
  dispose();
});
