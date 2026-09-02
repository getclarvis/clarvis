import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import type { MarketplaceListing, MarketplaceSource } from "../../src/adapters/marketplace.ts";
import type { PluginView } from "../../src/adapters/plugins.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { MarketplaceBrowser } from "../../src/views/config/MarketplaceBrowser.tsx";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";
import { openRender } from "../helpers/tracked-render.ts";

function listing(over: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    name: "demo-plugin",
    displayName: "Demo Plugin",
    source: "https://example.invalid/demo.git",
    sourceType: "git",
    installation: "AVAILABLE",
    authentication: "ON_FIRST_USE",
    description: "demo listing",
    installable: true,
    notes: [],
    marketplaceUrl: "https://example.invalid/marketplace.git",
    marketplace: "demo-market",
    installed: false,
    ...over,
  };
}

function plugin(over: Partial<PluginView> = {}): PluginView {
  return {
    name: "demo-plugin",
    displayName: "Demo Plugin",
    description: "Installed demo plugin",
    scope: "global",
    source: "agents",
    dir: "/plugins/demo-plugin",
    enabled: true,
    installSource: "https://example.invalid/demo.git",
    updateable: true,
    revision: "abc123",
    contributions: {
      agents: ["researcher"],
      brokenAgents: [],
      skills: ["deep-research"],
      servers: ["context7"],
      hooks: 1,
      capabilityExecutables: [
        {
          capability: "plans",
          command: "python3",
          args: ["-B", "./providers/server.py", "plans"],
          platformOverride: false,
        },
      ],
      skillPlanPolicies: [{ skill: "deep-research", mode: "review" }],
      executables: ["python3"],
    },
    ...over,
  };
}

function mount(opts: {
  listings?: MarketplaceListing[] | (() => MarketplaceListing[]);
  plugins?: PluginView[] | (() => PluginView[]);
  sources?: MarketplaceSource[];
  loading?: boolean;
  install?: (value: MarketplaceListing) => Promise<string>;
  uninstall?: (value: PluginView) => Promise<string>;
}) {
  const harness = createFakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap: harness.keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const installed: string[] = [];
  const installedUrls: string[] = [];
  const configured: string[] = [];
  const updated: string[] = [];
  const uninstalled: string[] = [];
  const added: string[] = [];
  const notifications: string[] = [];
  const listings = (): MarketplaceListing[] =>
    typeof opts.listings === "function" ? opts.listings() : (opts.listings ?? []);
  const plugins = (): PluginView[] =>
    typeof opts.plugins === "function" ? opts.plugins() : (opts.plugins ?? []);
  const deps = {
    listings,
    sources: () => opts.sources ?? [],
    plugins,
    extensionProfile: () => "global:research",
    loading: () => opts.loading ?? false,
    install:
      opts.install ??
      (async (value: MarketplaceListing) => {
        installed.push(value.name);
        return `installed ${value.name}`;
      }),
    installUrl: async (url: string, source: "agents" | "clarvis") => {
      installedUrls.push(`${source}:${url}`);
      return `installed ${url}`;
    },
    configure: (value: PluginView) => configured.push(value.name),
    update: async (value: PluginView) => {
      updated.push(value.name);
      return `updated ${value.name}`;
    },
    uninstall:
      opts.uninstall ??
      (async (value: PluginView) => {
        uninstalled.push(value.name);
        return `uninstalled ${value.name}`;
      }),
    refresh: () => {},
    addSource: (url: string) => added.push(url),
    notify: (message: string) => notifications.push(message),
  };
  return {
    host,
    deps,
    press: harness.press,
    installed,
    installedUrls,
    configured,
    updated,
    uninstalled,
    added,
    notifications,
  };
}

async function settle(
  rendered: Awaited<ReturnType<typeof openRender>>,
  predicate: () => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await Promise.resolve();
    await rendered.renderOnce();
    if (predicate()) return;
  }
  throw new Error(`view did not settle\n${rendered.captureCharFrame()}`);
}

test("shows available marketplace plugins and installs from the primary action", async () => {
  const mounted = mount({ listings: [listing()] });
  const rendered = await openRender(
    (() => MarketplaceBrowser(mounted.host, mounted.deps)) as never,
    { width: 110, height: 24 },
  );
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("0 installed");
  expect(frame).toContain("1 available");
  expect(frame).toContain("/ Search this collection");
  expect(frame).toContain("Enter → view plugin details");
  mounted.press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Enter installs the plugin and adds it to");
  mounted.press("return");
  await settle(rendered, () => mounted.installed.length === 1);
  expect(mounted.notifications).toContain("installed demo-plugin");
  rendered.renderer.destroy();
});

test("installed inventory and full lifecycle details live in Marketplace", async () => {
  const mounted = mount({ listings: [listing({ installed: true })], plugins: [plugin()] });
  const rendered = await openRender(
    (() => MarketplaceBrowser(mounted.host, mounted.deps)) as never,
    { width: 140, height: 30 },
  );
  await rendered.renderOnce();
  let frame = rendered.captureCharFrame();
  expect(frame).toContain("1 active");
  expect(frame).toContain("Active · current Extension Profile");
  expect(frame).not.toContain("1 available");
  mounted.press("return");
  await rendered.renderOnce();
  frame = rendered.captureCharFrame();
  expect(frame).toContain("python3 -B ./providers/server.py plans");
  expect(frame).toContain("plans:review");
  expect(frame).toContain("active with this plugin");
  mounted.press("e");
  expect(mounted.configured).toEqual(["demo-plugin"]);
  mounted.press("u");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Update demo-plugin?");
  mounted.press("y");
  await settle(rendered, () => mounted.updated.length === 1);
  rendered.renderer.destroy();
});

test("installed plugin details render the complete publisher and presentation metadata", async () => {
  const mounted = mount({
    plugins: [
      plugin({
        shortDescription: "Short summary",
        longDescription: "Long description for operators.",
        author: {
          name: "Atlas Labs",
          email: "plugins@atlas.example",
          url: "https://atlas.example/team",
        },
        developerName: "Atlas Plugin Team",
        license: "MIT",
        homepage: "https://atlas.example/plugin",
        repository: "https://github.com/atlas/plugin",
        keywords: ["charts", "maps"],
        category: "Productivity",
        capabilities: ["Read", "Write"],
        websiteURL: "https://atlas.example",
        privacyPolicyURL: "https://atlas.example/privacy",
        termsOfServiceURL: "https://atlas.example/terms",
        brandColor: "#336699",
        composerIcon: "./assets/icon.png",
        logo: "./assets/logo.svg",
        screenshots: ["./assets/screen.png"],
        defaultPrompt: ["Draw a chart"],
      }),
    ],
  });
  const rendered = await openRender(
    (() => MarketplaceBrowser(mounted.host, mounted.deps)) as never,
    { width: 150, height: 60 },
  );
  await rendered.renderOnce();
  mounted.press("return");
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();

  expect(frame).toContain("Atlas Labs <plugins@atlas.example>");
  expect(frame).toContain("https://github.com/atlas/plugin");
  expect(frame).toContain("https://atlas.example/privacy");
  expect(frame).toContain("Draw a chart");
  rendered.renderer.destroy();
});

test("uninstall immediately replaces the active row with its available listing", async () => {
  const [plugins, setPlugins] = createSignal([plugin()]);
  const mounted = mount({
    listings: [listing({ installed: true })],
    plugins,
    uninstall: async (value) => {
      setPlugins([]);
      return `uninstalled ${value.name}`;
    },
  });
  const rendered = await openRender(
    (() => MarketplaceBrowser(mounted.host, mounted.deps)) as never,
    { width: 100, height: 24 },
  );
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("1 active · 1 installed");
  mounted.press("return");
  await rendered.renderOnce();
  mounted.press("d");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Uninstall demo-plugin?");
  mounted.press("y");
  await settle(
    rendered,
    () =>
      rendered.captureCharFrame().includes("0 installed") &&
      !rendered.captureCharFrame().includes("Uninstalling demo-plugin"),
  );
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("1 available");
  expect(frame).toContain("Enter → view plugin details");
  expect(frame).not.toContain("Active · current Extension Profile");
  rendered.renderer.destroy();
});

test("locally installed plugins remain manageable without a marketplace listing", async () => {
  const mounted = mount({
    plugins: [
      plugin({
        name: "local-only",
        displayName: "Local Only",
        installSource: undefined,
        updateable: false,
      }),
    ],
  });
  const rendered = await openRender(
    (() => MarketplaceBrowser(mounted.host, mounted.deps)) as never,
    { width: 100, height: 24 },
  );
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Local Only");
  mounted.press("return");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("inventory  global/agents");
  expect(rendered.captureCharFrame()).not.toContain("u update");
  mounted.press("u");
  await rendered.renderOnce();
  expect(mounted.updated).toEqual([]);
  expect(rendered.captureCharFrame()).not.toContain("Update local-only?");
  rendered.renderer.destroy();
});

test("local and npm installations do not offer an update action", async () => {
  for (const installSource of ["local:/plugins/local-only", "npm:@scope/local-only@1.0.0"]) {
    const mounted = mount({
      plugins: [plugin({ name: "local-only", installSource, updateable: false })],
    });
    const rendered = await openRender(
      (() => MarketplaceBrowser(mounted.host, mounted.deps)) as never,
      { width: 100, height: 24 },
    );
    await rendered.renderOnce();
    mounted.press("return");
    await rendered.renderOnce();
    expect(rendered.captureCharFrame()).not.toContain("u update");
    mounted.press("u");
    await rendered.renderOnce();
    expect(mounted.updated).toEqual([]);
    rendered.renderer.destroy();
  }
});

test("unavailable entries open an explanation instead of installing", async () => {
  const mounted = mount({
    listings: [
      listing({
        source: "./plugins/demo-plugin",
        installable: false,
      }),
    ],
  });
  const rendered = await openRender(
    (() => MarketplaceBrowser(mounted.host, mounted.deps)) as never,
    { width: 80, height: 24 },
  );
  await rendered.renderOnce();
  mounted.press("return");
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("This source cannot be installed by the current host");
  expect(mounted.installed).toEqual([]);
  rendered.renderer.destroy();
});

test("installation progress is animated in the footer until the operation settles", async () => {
  let release!: () => void;
  const pending = new Promise<string>((resolve) => {
    release = () => resolve("installed demo-plugin");
  });
  const mounted = mount({ listings: [listing()], install: () => pending });
  const rendered = await openRender(
    (() => MarketplaceBrowser(mounted.host, mounted.deps)) as never,
    { width: 80, height: 24 },
  );
  await rendered.renderOnce();
  mounted.press("return");
  await rendered.renderOnce();
  mounted.press("return");
  await rendered.renderOnce();
  const pendingFrame = rendered.captureCharFrame();
  expect(pendingFrame).toContain("Installing demo-plugin");
  expect(pendingFrame.trimEnd().split("\n").at(-1)).toContain("Installing demo-plugin");
  release();
  await settle(rendered, () => !rendered.captureCharFrame().includes("Installing demo-plugin"));
  rendered.renderer.destroy();
});

test("source failures stay visible while a populated catalog remains usable", async () => {
  const mounted = mount({
    listings: [listing()],
    sources: [{ url: "https://example.invalid/broken.git", error: "clone failed" }],
  });
  const rendered = await openRender(
    (() => MarketplaceBrowser(mounted.host, mounted.deps)) as never,
    { width: 110, height: 24 },
  );
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("broken.git: clone failed");
  expect(frame).toContain("Demo Plugin");
  rendered.renderer.destroy();
});

test("empty catalogs distinguish loading from a settled empty result", async () => {
  const loading = mount({ loading: true });
  let rendered = await openRender((() => MarketplaceBrowser(loading.host, loading.deps)) as never, {
    width: 80,
    height: 20,
  });
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("fetching marketplaces");
  expect(rendered.captureCharFrame()).not.toContain("No plugins in this collection");
  rendered.renderer.destroy();

  const empty = mount({ loading: false });
  rendered = await openRender((() => MarketplaceBrowser(empty.host, empty.deps)) as never, {
    width: 80,
    height: 20,
  });
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("No plugins in this collection");
  expect(rendered.captureCharFrame()).toContain("Use left and right to browse another marketplace");
  rendered.renderer.destroy();
});

test("search and the retained row window handle a large mixed catalog", async () => {
  const listings = Array.from({ length: 196 }, (_, index) =>
    listing({
      name: `plugin-${String(index).padStart(3, "0")}`,
      displayName: `Plugin ${String(index).padStart(3, "0")}`,
      description: index === 82 ? "unique observability bridge" : `Listing ${index}`,
    }),
  );
  const mounted = mount({ listings });
  const rendered = await openRender(
    (() => MarketplaceBrowser(mounted.host, mounted.deps)) as never,
    { width: 80, height: 24 },
  );
  await rendered.renderOnce();
  mounted.press("end");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("Plugin 195");
  mounted.press("/");
  await rendered.renderOnce();
  await rendered.mockInput.typeText("observability bridge");
  mounted.press("return");
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain("Plugin 082");
  expect(frame).not.toContain("Plugin 195");
  rendered.renderer.destroy();
});

test("marketplace sources and direct Git installs stay available in the unified surface", async () => {
  const mounted = mount({});
  const rendered = await openRender(
    (() => MarketplaceBrowser(mounted.host, mounted.deps)) as never,
    { width: 110, height: 24 },
  );
  await rendered.renderOnce();
  mounted.press("right");
  mounted.press("right");
  mounted.press("right");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("[Add Marketplace]");
  mounted.press("return");
  await rendered.renderOnce();
  await rendered.mockInput.typeText("https://example.invalid/catalog.git");
  mounted.press("return");
  await rendered.renderOnce();
  expect(mounted.added).toEqual(["https://example.invalid/catalog.git"]);

  mounted.press("g");
  await rendered.renderOnce();
  mounted.press("return");
  await rendered.renderOnce();
  await rendered.mockInput.typeText("https://example.invalid/plugin.git");
  mounted.press("return");
  await settle(rendered, () => mounted.installedUrls.length === 1);
  expect(mounted.installedUrls).toEqual(["agents:https://example.invalid/plugin.git"]);
  rendered.renderer.destroy();
});

test("left and right browse exact marketplace collections while up and down stay in the plugin list", async () => {
  const source: MarketplaceSource = {
    url: "https://example.invalid/marketplace.git",
    marketplace: {
      name: "demo-market",
      displayName: "Demo Market",
      plugins: [],
      notes: [],
    },
  };
  const mounted = mount({
    listings: [listing()],
    plugins: [plugin({ name: "local-only", displayName: "Local Only", scope: "workspace" })],
    sources: [source],
  });
  const rendered = await openRender(
    (() => MarketplaceBrowser(mounted.host, mounted.deps)) as never,
    { width: 120, height: 24 },
  );
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("[All]");
  mounted.press("right");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("[Installed (1)]");
  expect(rendered.captureCharFrame()).toContain("Local Only");
  mounted.press("right");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("[Demo Market]");
  expect(rendered.captureCharFrame()).toContain("Demo Plugin");
  expect(rendered.captureCharFrame()).not.toContain("Local Only");
  mounted.press("right");
  await rendered.renderOnce();
  expect(rendered.captureCharFrame()).toContain("[Workspace (1)]");
  expect(rendered.captureCharFrame()).toContain("Local Only");
  rendered.renderer.destroy();
});
