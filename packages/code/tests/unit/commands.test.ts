import { expect, test } from "bun:test";
import { createTestKeymap } from "@opentui/keymap/testing";
import {
  createCommands,
  type CommandEffects,
  type CommandUi,
  type Commands,
} from "../../src/keys/commands.ts";
import { createRoot, createSignal } from "solid-js";
import { createMcpCapabilities } from "../../src/adapters/mcp-capabilities-bridge.ts";
import { classifySlashSubmit, parseSlashCommand } from "../../src/views/input/autocomplete.ts";
import { commandKeyLabel } from "../../src/ui/patterns/level-keys.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createCommandCompletionProvider } from "../../src/views/input/command-completion.ts";

interface FakeCmd {
  name: string;
  run: (ctx: unknown) => unknown;
  [k: string]: unknown;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeFakeKeymap(): { keymap: Interaction["keymap"] } {
  const cmds = new Map<string, FakeCmd>();
  const data = new Map<string, unknown>();
  const keymap = {
    registerLayer(layer: { commands?: FakeCmd[] }) {
      for (const c of layer.commands ?? []) cmds.set(c.name, c);
      return () => {
        for (const c of layer.commands ?? []) cmds.delete(c.name);
      };
    },
    runCommand(name: string) {
      const c = cmds.get(name);
      if (c) c.run({});
      return { ok: !!c };
    },
    getCommandBindings() {
      return new Map();
    },
    setData(k: string, v: unknown) {
      data.set(k, v);
    },
    getData(k: string) {
      return data.get(k);
    },
  };
  return { keymap: keymap as unknown as Interaction["keymap"] };
}

function harness(interaction?: Interaction): { commands: Commands; calls: string[] } {
  const calls: string[] = [];
  const effects: CommandEffects = {
    clearSession: () => calls.push("clear"),
    status: () => calls.push("status"),
    exportSession: () => calls.push("export"),
  };
  const ui: CommandUi = {
    openView: (name) => calls.push("view:" + name),
    dismiss: () => calls.push("dismiss"),
    commandFailed: (name, e) =>
      calls.push(`failed:${name}:${e instanceof Error ? e.message : String(e)}`),
  };
  const commands = createCommands(
    interaction ?? (makeFakeKeymap() as unknown as Interaction),
    effects,
    ui,
  );
  return { commands, calls };
}

test("built-ins register with the right names and categories", () => {
  const { commands } = harness();
  const byName = new Map(commands.entries().map((e) => [e.name, e]));
  // help.open is registered by app-commands (presentation), not keys createCommands.
  expect([...byName.keys()].sort()).toEqual(["app.clear", "session.export", "status.show"].sort());
  expect(byName.get("app.clear")!.category).toBe("action");
});

test("entries reuses its catalog until registration or keyboard configuration changes", () => {
  const [environment, setEnvironment] = createSignal({ profile: "portable" });
  const interaction = {
    ...makeFakeKeymap(),
    keyboardEnvironment: environment,
  } as unknown as Interaction;
  const { commands } = harness(interaction);
  const first = commands.entries();
  expect(commands.entries()).toBe(first);

  const off = commands.registerAction({
    name: "catalog.new",
    title: "New catalog row",
    slash: "/catalog-new",
    surface: "slash",
    group: "actions",
    run: () => {},
  });
  const registered = commands.entries();
  expect(registered).not.toBe(first);
  expect(commands.entries()).toBe(registered);

  setEnvironment({ profile: "manual" });
  expect(commands.entries()).not.toBe(registered);
  off();
  commands.dispose();
});

test("bare slash completion reuses rows while still rechecking dynamic eligibility", () => {
  const { commands, calls } = harness();
  let enabled = true;
  commands.registerAction({
    name: "probe.dynamic",
    title: "Dynamic",
    slash: "/dynamic",
    surface: "slash",
    group: "actions",
    enabled: () => enabled,
    run: () => {
      calls.push("dynamic");
    },
  });
  const provider = createCommandCompletionProvider({ commands, recoverMemory: () => {} });
  const first = provider.query("");
  expect(provider.query("")).toBe(first);
  expect(first.some((item) => item.label === "/dynamic")).toBe(true);

  enabled = false;
  const hidden = provider.query("");
  expect(hidden).not.toBe(first);
  expect(hidden.some((item) => item.label === "/dynamic")).toBe(false);
  expect(provider.query("")).toBe(hidden);

  enabled = true;
  const restored = provider.query("");
  expect(restored.some((item) => item.label === "/dynamic")).toBe(true);
  provider.onAccept?.(restored.find((item) => item.label === "/dynamic")!);
  expect(calls).toContain("dynamic");
  commands.dispose();
});

test("a command scope owns all of its registrations and disposes idempotently", () => {
  const { commands } = harness();
  const scope = commands.scope();
  scope.registerAction({
    name: "scoped.action",
    title: "Scoped action",
    surface: "internal",
    group: "actions",
    run: () => {},
  });
  scope.registerView({
    name: "scoped.view",
    title: "Scoped view",
    surface: "internal",
    group: "navigate",
    view: () => null as never,
  });
  expect(commands.entries().some((entry) => entry.name === "scoped.action")).toBe(true);
  expect(commands.viewFactory("scoped.view")).toBeDefined();

  scope.dispose();
  scope.dispose();

  expect(commands.entries().some((entry) => entry.name === "scoped.action")).toBe(false);
  expect(commands.viewFactory("scoped.view")).toBeUndefined();
});

test("disposing the registry releases built-ins and refuses new registrations", () => {
  const { commands } = harness();
  commands.dispose();
  commands.dispose();
  expect(commands.entries()).toEqual([]);
  expect(() =>
    commands.registerAction({
      name: "late",
      title: "Late",
      surface: "internal",
      group: "actions",
      run: () => {},
    }),
  ).toThrow("command registry is disposed");
});

test("slash tokens resolve from the def (explicit) and are normalized", () => {
  const { commands } = harness();
  const byName = new Map(commands.entries().map((e) => [e.name, e]));
  expect(byName.get("app.clear")!.slashes).toEqual(["/clear"]);
  expect(byName.get("status.show")!.slashes).toEqual(["/status"]);
});

test("omitted slash means no slash — auto-derivation from the internal name no longer happens", () => {
  const { commands } = harness();
  const offA = commands.registerAction({
    name: "foo.bar",
    title: "Foo",
    surface: "internal",
    group: "actions",
    run: () => {},
  });
  const offView = commands.registerView({
    name: "providers.open",
    title: "Providers",
    surface: "internal",
    group: "navigate",
    view: () => null as never,
  });
  const offB = commands.registerAction({
    name: "x.y",
    title: "XY",
    slash: false,
    surface: "internal",
    group: "actions",
    run: () => {},
  });
  const byName = new Map(commands.entries().map((e) => [e.name, e]));
  expect(byName.get("foo.bar")!.slashes).toEqual([]);
  expect(byName.get("providers.open")!.slashes).toEqual([]);
  expect(byName.get("x.y")!.slashes).toEqual([]);
  offA();
  offView();
  offB();
  expect(commands.entries().some((e) => e.name === "foo.bar")).toBe(false);
});

test("runCommand dispatches an action's run through the injected effects", () => {
  const { commands, calls } = harness();
  commands.runCommand("app.clear");
  commands.runCommand("status.show");
  commands.runCommand("session.export");
  expect(calls).toEqual(["clear", "status", "export"]);
});

test("view commands dispatch to ui.openView; viewFactory exposes the factory", () => {
  const { commands, calls } = harness();
  // help.open is registered by app-commands; keys only provides the registry.
  commands.registerView({
    name: "help.open",
    title: "Help",
    surface: "slash",
    group: "actions",
    view: () => null as never,
  });
  commands.runCommand("help.open");
  expect(calls).toEqual(["view:help.open"]);
  expect(typeof commands.viewFactory("help.open")).toBe("function");
  expect(commands.viewFactory("app.clear")).toBeUndefined();
});

test("entries(term) fuzzy-filters over title/name/slash", () => {
  const { commands } = harness();
  const names = commands.entries("clear").map((e) => e.name);
  expect(names).toContain("app.clear");
  expect(names[0]).toBe("app.clear");
  expect(commands.entries("zzznope")).toHaveLength(0);
});

test("entries(term) reports which field matched: slash-first, title when only it hits", () => {
  const { commands } = harness();
  const off = commands.registerAction({
    name: "agent.picker",
    title: "Switch agent",
    slash: "/agent",
    surface: "slash",
    group: "navigate",
    run: () => {},
  });
  const byTitle = commands.entries("switch").find((e) => e.name === "agent.picker")!;
  expect(byTitle.match).toEqual({
    field: "title",
    text: "Switch agent",
    positions: [0, 1, 2, 3, 4, 5],
  });
  const bySlash = commands.entries("agent").find((e) => e.name === "agent.picker")!;
  expect(bySlash.match).toEqual({
    field: "slash",
    text: "/agent",
    positions: [1, 2, 3, 4, 5],
  });
  expect(commands.entries().find((e) => e.name === "agent.picker")!.match).toBeUndefined();
  off();
});

test("registering a duplicate command name throws", () => {
  const { commands } = harness();
  expect(() =>
    commands.registerAction({
      name: "app.clear",
      title: "dup",
      surface: "internal",
      group: "actions",
      run: () => {},
    }),
  ).toThrow();
});

test("registering a duplicate slash throws instead of silently hiding a command", () => {
  const { commands } = harness();
  expect(() =>
    commands.registerAction({
      name: "other.clear",
      title: "Other clear",
      slash: "/clear",
      surface: "slash",
      group: "actions",
      run: () => {},
    }),
  ).toThrow("slash command already registered: /clear");
});

test("skillCommand registers a bare /<name> slash command and dispatches its run", () => {
  const { commands } = harness();
  let ran = false;
  const off = commands.skillCommand(
    "review-diff",
    { name: "review-diff", description: "Review a diff." },
    () => {
      ran = true;
    },
  );
  const entry = commands.entries().find((e) => e.name === "skill.review-diff")!;
  expect(entry.slashes).toEqual(["/review-diff"]);
  expect(entry.namespace).toBe("skills");
  expect(entry.surface).toBe("slash");
  expect(entry.group).toBe("skills");
  commands.runCommand("skill.review-diff");
  expect(ran).toBe(true);
  off();
  expect(commands.entries().some((e) => e.name === "skill.review-diff")).toBe(false);
});

test("skillCommand titles a skill by its declared display name, keeping the slash key", () => {
  const { commands } = harness();
  const off = commands.skillCommand(
    "review-diff",
    { name: "review-diff", description: "Review a diff.", displayName: "Diff Review" },
    () => {},
  );
  const entry = commands.entries().find((e) => e.name === "skill.review-diff")!;
  expect(entry.title).toBe("Diff Review");
  expect(entry.slashes).toEqual(["/review-diff"]);
  off();
});

test("skillCommand skips when its bare slash collides with an existing command", () => {
  const { commands } = harness();
  const off = commands.skillCommand("clear", { name: "clear" }, () => {});
  expect(commands.entries().some((e) => e.name === "skill.clear")).toBe(false);
  const clears = commands.entries().filter((e) => e.slashes.includes("/clear"));
  expect(clears.map((e) => e.name)).toEqual(["app.clear"]);
  off();
});

test("a rejecting async action funnels into commandFailed (never an unhandled rejection)", async () => {
  const { commands, calls } = harness();
  const off = commands.registerAction({
    name: "boom.async",
    title: "Boom",
    surface: "internal",
    group: "actions",
    run: async () => {
      throw new Error("backend gone");
    },
  });
  commands.runCommand("boom.async");
  await flushMicrotasks();
  expect(calls).toContain("failed:boom.async:backend gone");
  off();
});

test("a synchronously throwing action funnels into commandFailed", () => {
  const { commands, calls } = harness();
  const off = commands.registerAction({
    name: "boom.sync",
    title: "Boom",
    surface: "internal",
    group: "actions",
    run: () => {
      throw new Error("sync boom");
    },
  });
  commands.runCommand("boom.sync");
  expect(calls).toContain("failed:boom.sync:sync boom");
  off();
});

test("route() invokes the def's router and returns whether it handled the line", () => {
  const { commands } = harness();
  const seen: string[] = [];
  const off = commands.registerView({
    name: "settings.open",
    title: "Settings",
    slash: "/settings",
    surface: "slash",
    group: "navigate",
    subcommands: [
      { name: "providers", desc: "Providers" },
      { name: "sandbox", desc: "Sandbox" },
    ],
    route: (args) => {
      if (args.trim() === "sandbox") {
        seen.push("sandbox");
        return true;
      }
      return false;
    },
    view: () => null as never,
  });
  expect(commands.route("settings.open", "sandbox")).toBe(true);
  expect(commands.route("settings.open", "bogus")).toBe(false);
  expect(seen).toEqual(["sandbox"]);
  expect(commands.entries().find((e) => e.name === "settings.open")!.subcommands).toEqual([
    { name: "providers", desc: "Providers" },
    { name: "sandbox", desc: "Sandbox" },
  ]);
  off();
});

test("route() on a command without a router returns false (no throw)", () => {
  const { commands } = harness();
  expect(commands.route("app.clear", "anything")).toBe(false);
  expect(commands.route("does.not.exist", "x")).toBe(false);
});

test("prompt/skill commands surface their declared arguments on the entry", () => {
  const { commands } = harness();
  const off = commands.skillCommand(
    "deploy",
    {
      name: "deploy",
      arguments: [
        { name: "env", required: true },
        { name: "notes", description: "free text" },
      ],
    },
    () => {},
  );
  const entry = commands.entries().find((e) => e.name === "skill.deploy")!;
  expect(entry.args.map((a) => a.name)).toEqual(["env", "notes"]);
  expect(entry.args[0]!.required).toBe(true);
  expect(commands.entries().find((e) => e.name === "app.clear")!.args).toEqual([]);
  off();
});

test("one binding renders identically in the popup hint, Help groups and the footer resolver", () => {
  const t = createTestKeymap({ defaultKeys: true });
  const keymap = t.keymap as unknown as Interaction["keymap"];
  const { commands } = harness({ keymap } as unknown as Interaction);
  const off = commands.registerAction({
    name: "controls.open",
    title: "Run controls",
    desc: "Safety presets",
    surface: "internal",
    group: "navigate",
    run: () => {},
  });
  const offKeys = keymap.registerLayer({
    priority: 900,
    bindings: [{ key: "alt+r", cmd: "controls.open" }],
  });

  const popup = commands.entries().find((e) => e.name === "controls.open")!.keyHint;
  const helpRow = commands
    .keyCommandGroups()
    .flatMap((g) => g.rows)
    .find((r) => r.desc === "Safety presets");
  const footer = commandKeyLabel(keymap, "controls.open");

  expect(popup).toBe("alt+r");
  expect(helpRow?.key).toBe("alt+r");
  expect(footer).toBe("alt+r");

  offKeys();
  off();
  t.cleanup();
});

test("key-command help falls back to a raw command title when no description is present", () => {
  const t = createTestKeymap({ defaultKeys: true });
  const keymap = t.keymap as unknown as Interaction["keymap"];
  const { commands } = harness({ keymap } as unknown as Interaction);
  const off = keymap.registerLayer({
    priority: 900,
    commands: [{ name: "raw.title", title: "Raw title", run: () => {} }] as never,
    bindings: [{ key: "f8", cmd: "raw.title" }],
  });

  expect(commands.keyCommandGroups().flatMap((group) => group.rows)).toContainEqual({
    key: "f8",
    desc: "Raw title",
  });

  off();
  t.cleanup();
});

test("promptCommand registers a /<server>:<name> slash command with group mcp", () => {
  const { commands } = harness();
  let ran = false;
  const off = commands.promptCommand(
    "figma",
    { name: "inspect", description: "Inspect a node." },
    () => {
      ran = true;
    },
  );
  const entry = commands.entries().find((e) => e.name === "figma:inspect")!;
  expect(entry.slashes).toEqual(["/figma:inspect"]);
  expect(entry.namespace).toBe("figma");
  expect(entry.surface).toBe("slash");
  expect(entry.group).toBe("mcp");
  commands.runCommand("figma:inspect");
  expect(ran).toBe(true);
  off();
});

test("entries() echoes surface/group/parent verbatim from the def", () => {
  const { commands } = harness();
  const off = commands.registerView({
    name: "settings.open",
    title: "Settings",
    surface: "internal",
    group: "navigate",
    parent: "settings",
    view: () => null as never,
  });
  const entry = commands.entries().find((e) => e.name === "settings.open")!;
  expect(entry.surface).toBe("internal");
  expect(entry.group).toBe("navigate");
  expect(entry.parent).toBe("settings");
  off();
});

test("skillCommand's rejecting invoke funnels into commandFailed", async () => {
  const { commands, calls } = harness();
  const off = commands.skillCommand("opentui", { name: "opentui" }, async () => {
    throw new Error("mcp not connected");
  });
  commands.runCommand("skill.opentui");
  await flushMicrotasks();
  expect(calls).toContain("failed:skill.opentui:mcp not connected");
  off();
});

test("a skill routes its typed argument tail to its handler and reports the line as handled", () => {
  const { commands } = harness();
  const seen: string[] = [];
  const off = commands.skillCommand("spec", { name: "spec" }, (args) => {
    seen.push(args);
  });

  expect(commands.route("skill.spec", "add SSO to the admin app")).toBe(true);
  expect(seen).toEqual(["add SSO to the admin app"]);

  commands.runCommand("skill.spec");
  expect(seen).toEqual(["add SSO to the admin app", ""]);

  off();
});

test("a skill rejecting on the routed path still funnels into commandFailed", async () => {
  const { commands, calls } = harness();
  const off = commands.skillCommand("spec", { name: "spec" }, () =>
    Promise.reject(new Error("boom")),
  );

  expect(commands.route("skill.spec", "anything")).toBe(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toContain("failed:skill.spec:boom");

  off();
});

test("a skill registered by the bridge carries a typed tail all the way to getPrompt", async () => {
  await createRoot(async (dispose) => {
    const { commands } = harness();
    const promptCalls: Array<{ name: string; args: unknown }> = [];
    const caps = createMcpCapabilities({
      client: {
        listTools: async () => [],
        listPrompts: async () => [{ name: "spec", description: "Write a spec." }],
        getPrompt: async (name: string, args: Record<string, string>) => {
          promptCalls.push({ name, args });
          return [{ role: "user" as const, content: "rendered" }];
        },
        connectionStatus: () => "connected" as const,
      },
      commands,
      effects: {
        submitPromptTurn: () => {},
        submitSkillRun: () => {},
        activeProfile: () => "coder",
        openMcpServers: () => {},
        collectArgs: async () => null,
      },
      declared: () => [],
      profiles: () => [],
    });
    await caps.refresh();

    // Exactly what App.tsx does with a submitted `/spec add SSO` line.
    const parsed = parseSlashCommand("/spec add SSO")!;
    const hit = classifySlashSubmit(parsed.name, {
      skillAgent: (n) => caps.skillAgent(n),
      findCommand: (slash) => commands.entries().find((e) => e.slashes.includes(slash))?.name,
    });
    expect(hit).toEqual({ kind: "command", command: "skill.spec" });
    expect(commands.route(hit.kind === "command" ? hit.command : "", parsed.args)).toBe(true);

    await Promise.resolve();
    await Promise.resolve();
    expect(promptCalls).toEqual([{ name: "spec", args: { task: "add SSO" } }]);

    caps.dispose();
    commands.dispose();
    dispose();
  });
});

test("canAct is carried as a predicate and fails open when it throws", () => {
  // `entries()` runs inside a Solid computation on every palette keystroke.
  // Evaluating every predicate there subscribed the projection to whatever they
  // read, and one that touches a signal it also writes wedged the palette.
  const { commands } = harness();
  let reads = 0;
  commands.registerAction({
    name: "probe.gated",
    title: "Gated",
    surface: "internal",
    group: "actions",
    enabled: () => {
      reads++;
      return false;
    },
    run: () => {},
  });
  commands.registerAction({
    name: "probe.throws",
    title: "Throws",
    surface: "internal",
    group: "actions",
    enabled: () => {
      throw new Error("collaborator not ready");
    },
    run: () => {},
  });
  const byName = new Map(commands.entries().map((entry) => [entry.name, entry]));
  const before = reads;
  // The projection carries the predicate, not its answer, so the consumer that
  // wants it pays for it — once, where the answer is actually used.
  expect(byName.get("probe.gated")!.canAct!()).toBe(false);
  expect(reads).toBe(before + 1);
  expect(byName.get("probe.throws")!.canAct!()).toBe(true);
  expect(byName.get("app.clear")!.canAct).toBeUndefined();
});

test("a hub child opened by any route seeds its hub beneath it", () => {
  // Reached through the hub it got a parent frame; reached from the palette or a
  // /token it did not, so one Escape jumped two semantic levels.
  const { commands, calls } = harness();
  commands.registerView({
    name: "settings.open",
    title: "Settings",
    surface: "slash",
    group: "navigate",
    view: () => null as never,
  });
  commands.registerView({
    name: "providers.open",
    title: "Providers",
    surface: "internal",
    group: "navigate",
    parent: "settings",
    view: () => null as never,
  });
  commands.registerView({
    name: "status.detail",
    title: "Status detail",
    surface: "internal",
    group: "navigate",
    parent: "sessions",
    view: () => null as never,
  });
  commands.runCommand("providers.open");
  commands.runCommand("status.detail");
  expect(calls).toEqual(["view:providers.open", "view:status.detail"]);
});
