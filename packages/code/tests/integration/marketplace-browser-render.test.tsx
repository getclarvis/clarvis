import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { MarketplaceBrowser } from "../../src/views/config/MarketplaceBrowser.tsx";
import type { MarketplaceListing, MarketplaceSource } from "../../src/adapters/marketplace.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const LISTING: MarketplaceListing = {
  name: "demo-plugin",
  source: "https://example.invalid/demo.git",
  description: "demo listing",
  installable: true,
  notes: [],
  marketplace: "demo-market",
  installed: false,
};

const LOCAL_LISTING: MarketplaceListing = {
  name: "beside-plugin",
  source: "./plugins/beside-plugin",
  description: "a listing that lives beside its catalog",
  installable: false,
  notes: ["listing 'beside-plugin' names a local source"],
  marketplace: "demo-market",
  installed: false,
};

function mount(opts: {
  listings?: MarketplaceListing[];
  sources?: MarketplaceSource[];
  loading?: boolean;
  install?: (listing: MarketplaceListing) => void;
}) {
  const harness = createFakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap: harness.keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const deps = {
    listings: () => opts.listings ?? [],
    sources: () => opts.sources ?? [],
    loading: () => opts.loading ?? false,
    install: opts.install ?? (() => {}),
    refresh: () => {},
    addSource: () => {},
  };
  return { host, deps, press: harness.press };
}

test("the footer projects install, movement and refresh from the active keymap", async () => {
  const { host, deps } = mount({ listings: [LISTING] });
  const t = await openRender((() => MarketplaceBrowser(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("[^r] refresh");
  expect(frame).toContain("[↵] install");
  expect(frame).toContain("] move");
  t.renderer.destroy();
});

test("a broken source is a persistent banner above a still-populated offer list", async () => {
  const { host, deps } = mount({
    listings: [LISTING],
    sources: [{ url: "https://example.invalid/broken.git", error: "clone failed" }],
  });
  const t = await openRender((() => MarketplaceBrowser(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  await t.renderOnce();
  const rows = t.captureCharFrame().split("\n");
  const banner = rows.findIndex((r) => r.includes("broken.git: clone failed"));
  const listing = rows.findIndex((r) => r.includes("demo-plugin"));
  expect(banner).toBeGreaterThanOrEqual(0);
  expect(listing).toBeGreaterThan(banner);
  t.renderer.destroy();
});

test("an empty catalog shows loading during the fetch and the empty hint only after it", async () => {
  const fetching = mount({ loading: true });
  let t = await openRender((() => MarketplaceBrowser(fetching.host, fetching.deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  let frame = t.captureCharFrame();
  expect(frame).toContain("loading…");
  expect(frame).not.toContain("No marketplace configured");
  t.renderer.destroy();

  const settled = mount({ loading: false });
  t = await openRender((() => MarketplaceBrowser(settled.host, settled.deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  frame = t.captureCharFrame();
  expect(frame).toContain("No marketplace configured");
  expect(frame).not.toContain("loading…");
  t.renderer.destroy();
});

test("an installed listing says so, and activating it installs nothing twice", async () => {
  let installs = 0;
  const { host, deps, press } = mount({
    listings: [{ ...LISTING, installed: true }],
    install: () => {
      installs += 1;
    },
  });
  const t = await openRender((() => MarketplaceBrowser(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("already installed");
  press("return");
  expect(installs).toBe(0);
  t.renderer.destroy();
});

test("a listing this host cannot fetch from says so instead of offering an install", async () => {
  const { host, deps } = mount({ listings: [LOCAL_LISTING] });
  const t = await openRender((() => MarketplaceBrowser(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("cannot be installed from here");
  expect(frame).not.toContain("enabling and approval are still required");
  t.renderer.destroy();
});

test("activating a listing this host cannot fetch from installs nothing", async () => {
  let installs = 0;
  const { host, deps, press } = mount({
    listings: [LOCAL_LISTING],
    install: () => {
      installs += 1;
    },
  });
  const t = await openRender((() => MarketplaceBrowser(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  await t.renderOnce();
  press("return");
  expect(installs).toBe(0);
  t.renderer.destroy();
});

test("activating an installable listing still installs it", async () => {
  let installs = 0;
  const { host, deps, press } = mount({
    listings: [LISTING],
    install: () => {
      installs += 1;
    },
  });
  const t = await openRender((() => MarketplaceBrowser(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  await t.renderOnce();
  press("return");
  expect(installs).toBe(1);
  t.renderer.destroy();
});

test("a foreign catalog's display name and category render as presentation rows", async () => {
  const { host, deps } = mount({
    listings: [
      { ...LISTING, displayName: "Demo Plugin", category: "productivity", notes: ["a note"] },
    ],
  });
  const t = await openRender((() => MarketplaceBrowser(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("Demo Plugin");
  expect(frame).toContain("category productivity");
  expect(frame).toContain("a note");
  t.renderer.destroy();
});

test("the detail rows anchor directly under the content-sized list", async () => {
  const { host, deps } = mount({ listings: [LISTING] });
  const t = await openRender((() => MarketplaceBrowser(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  await t.renderOnce();
  const rows = t.captureCharFrame().split("\n");
  const listing = rows.findIndex((r) => r.includes("demo-plugin  demo-market"));
  const detail = rows.findIndex((r) => r.includes("demo listing"));
  expect(listing).toBeGreaterThanOrEqual(0);
  expect(detail).toBe(listing + 2);
  t.renderer.destroy();
});

test("an all-unusable catalog says so once at the top instead of only per row", async () => {
  const m = mount({
    listings: [
      { ...LOCAL_LISTING, name: "one" },
      { ...LOCAL_LISTING, name: "two" },
    ],
  });
  const t = await openRender((() => MarketplaceBrowser(m.host, m.deps)) as never, {
    width: 140,
    height: 24,
  });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("2 listings");
  expect(frame).toContain("none can be installed from here");
  t.renderer.destroy();
});

test("a marketplace can be added by URL from the view itself", async () => {
  const added: string[] = [];
  const m = mount({});
  const deps = { ...m.deps, addSource: (url: string) => added.push(url) };
  const t = await openRender((() => MarketplaceBrowser(m.host, deps)) as never, {
    width: 140,
    height: 24,
  });
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("add marketplace");

  m.press("a");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("marketplace git URL");
  /* The level's verb keys must be released while the editor is open, or [a]
     swallows every 'a' the user types into the URL. */
  await t.mockInput.typeText("https://example.invalid/catalog.git");
  m.press("return");
  await t.renderOnce();
  expect(added).toEqual(["https://example.invalid/catalog.git"]);
  t.renderer.destroy();
});
