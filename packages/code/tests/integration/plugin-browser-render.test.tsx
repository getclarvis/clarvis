import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { PluginView } from "../../src/adapters/plugins.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { PluginBrowser } from "../../src/views/config/PluginBrowser.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const fakeKeymap = createFakeKeymap;

function plugin(over: Partial<PluginView> = {}): PluginView {
  return {
    name: "speckit-clarvis",
    scope: "global",
    source: "clarvis",
    dir: "/plugins/speckit-clarvis",
    enabled: true,
    version: "1.0.0",
    description: "Spec Kit integration",
    installSource: "https://example.invalid/spec-kit.git",
    revision: "abc123",
    contributions: {
      agents: ["builder"],
      brokenAgents: [],
      skills: ["speckit"],
      servers: [],
      hooks: 1,
      capabilityExecutables: [
        {
          capability: "plans",
          command: "python3",
          args: ["-B", "./providers/server.py", "plans"],
          platformOverride: false,
        },
      ],
      skillPlanPolicies: [
        { skill: "speckit-plan", mode: "off" },
        { skill: "speckit-implement", mode: "review" },
      ],
      executables: [],
    },
    ...over,
  };
}

function mount(plugins: PluginView[] = [plugin()]) {
  const { keymap, press } = fakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const toggled: string[] = [];
  const installed: string[] = [];
  const updated: string[] = [];
  const uninstalled: string[] = [];
  const notes: string[] = [];
  return {
    host,
    press,
    toggled,
    installed,
    updated,
    uninstalled,
    notes,
    deps: {
      plugins: () => plugins,
      toggleEnabled: (value: PluginView) => toggled.push(value.name),
      install: (url: string, source: "agents" | "clarvis") => installed.push(`${source}:${url}`),
      update: (value: PluginView) => updated.push(value.name),
      uninstall: (value: PluginView) => uninstalled.push(value.name),
      notify: (message: string) => notes.push(message),
    },
  };
}

test("plugin detail shows origin, revision and effective capability argv", async () => {
  const mounted = mount();
  const rendered = await openRender((() => PluginBrowser(mounted.host, mounted.deps)) as never, {
    width: 140,
    height: 30,
  });
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("https://example.invalid/spec-kit.git");
  expect(frame).toContain("abc123");
  expect(frame).toContain("service  plans");
  expect(frame).toContain("python3 -B ./providers/server.py plans");
  expect(frame).toContain("/speckit-plan");
  expect(frame).toContain("plans:review");
  rendered.renderer.destroy();
});

test("plugin detail shows the display metadata a manifest offers", async () => {
  const mounted = mount([
    plugin({ displayName: "Atlas Tools", shortDescription: "Charts and maps for a workspace." }),
  ]);
  const rendered = await openRender((() => PluginBrowser(mounted.host, mounted.deps)) as never, {
    width: 140,
    height: 30,
  });
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("display  Atlas Tools");
  expect(frame).toContain("summary  Charts and maps for a workspace.");
  rendered.renderer.destroy();
});

test("plugin detail does not repeat a summary that is already the description", async () => {
  const mounted = mount([
    plugin({ description: "Charts and maps.", shortDescription: "Charts and maps." }),
  ]);
  const rendered = await openRender((() => PluginBrowser(mounted.host, mounted.deps)) as never, {
    width: 140,
    height: 30,
  });
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).not.toContain("summary");
  rendered.renderer.destroy();
});

test("enable and workspace-managed lifecycle policy remain independent of hook review", async () => {
  const mounted = mount([plugin({ scope: "workspace" })]);
  const rendered = await openRender((() => PluginBrowser(mounted.host, mounted.deps)) as never, {
    width: 130,
    height: 24,
  });
  await rendered.renderOnce();
  mounted.press("e");
  mounted.press("u");
  mounted.press("d");
  expect(mounted.toggled).toEqual(["speckit-clarvis"]);
  expect(mounted.updated).toEqual([]);
  expect(mounted.uninstalled).toEqual([]);
  expect(mounted.notes.some((note) => note.includes("update it in the repo instead"))).toBe(true);
  expect(mounted.notes.some((note) => note.includes("remove it from the repo instead"))).toBe(true);
  rendered.renderer.destroy();
});

test("install defaults to .agents and can explicitly target .clarvis", async () => {
  const mounted = mount();
  const rendered = await openRender((() => PluginBrowser(mounted.host, mounted.deps)) as never, {
    width: 130,
    height: 24,
  });
  await rendered.renderOnce();
  mounted.press("a");
  await rendered.renderOnce();
  mounted.press("return");
  await rendered.renderOnce();
  await rendered.mockInput.typeText("https://example.invalid/plugin.git");
  mounted.press("return");
  await rendered.renderOnce();
  expect(mounted.installed).toEqual(["agents:https://example.invalid/plugin.git"]);

  mounted.press("a");
  await rendered.renderOnce();
  mounted.press("down");
  mounted.press("return");
  await rendered.renderOnce();
  await rendered.mockInput.typeText("https://example.invalid/native.git");
  mounted.press("return");
  await rendered.renderOnce();
  expect(mounted.installed).toEqual([
    "agents:https://example.invalid/plugin.git",
    "clarvis:https://example.invalid/native.git",
  ]);
  rendered.renderer.destroy();
});

test("empty and broken states remain explicit", async () => {
  const empty = mount([]);
  let rendered = await openRender((() => PluginBrowser(empty.host, empty.deps)) as never, {
    width: 110,
    height: 20,
  });
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("no plugins installed");
  rendered.renderer.destroy();

  const broken = mount([plugin({ error: "manifest is invalid" })]);
  rendered = await openRender((() => PluginBrowser(broken.host, broken.deps)) as never, {
    width: 110,
    height: 20,
  });
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("manifest is invalid");
  rendered.renderer.destroy();
});
