import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import type { SessionMeta } from "../../src/adapters/session-store.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { SessionsHub } from "../../src/views/config/SessionsHub.tsx";
import type { SessionCatalogItem } from "../../src/views/config/SessionsHub.tsx";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const fakeKeymap = createFakeKeymap;

function session(id: string, title: string): SessionMeta {
  return {
    id,
    title,
    workspace: "/ws",
    owner: "u",
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    totals: { input: 0, output: 0, cached: 0 },
  };
}

function mount(opts: { sessions?: SessionMeta[]; catalog?: SessionCatalogItem[] } = {}) {
  const { keymap, press } = fakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: (name: string) => calls.push("dispatch:" + name),
  });
  const calls: string[] = [];
  const resumed: string[] = [];
  const deleted: string[] = [];
  const deps = {
    sessions: () => opts.sessions ?? [],
    ...(opts.catalog === undefined ? {} : { catalog: async () => opts.catalog! }),
    now: () => 1_000_000,
    statusLine: () => "gpt-5 · 3 turns",
    resume: (id: string) => resumed.push(id),
    delete: async (item: SessionCatalogItem) => {
      deleted.push(`${item.workspaceId}:${item.meta.id}`);
    },
  };
  return { host, press, calls, resumed, deleted, deps };
}

test("renders the status line header and each session's row", async () => {
  const { host, deps } = mount({
    sessions: [session("a", "fix the bug"), session("b", "add tests")],
  });
  const t = await openRender((() => SessionsHub(host, deps)) as never, { width: 110, height: 24 });
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("gpt-5");
  expect(frame).toContain("fix the bug");
  expect(frame).toContain("add tests");
  t.renderer.destroy();
});

test("no sessions yet shows the empty hint", async () => {
  const { host, deps } = mount();
  const t = await openRender((() => SessionsHub(host, deps)) as never, { width: 110, height: 24 });
  await t.renderOnce();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("no sessions yet");
  t.renderer.destroy();
});

test("activating the selected row resumes it", async () => {
  const { host, press, resumed, deps } = mount({
    sessions: [session("a", "fix the bug"), session("b", "add tests")],
  });
  const t = await openRender((() => SessionsHub(host, deps)) as never, { width: 110, height: 24 });
  await t.renderOnce();
  await t.renderOnce();
  press("down");
  press("return");
  expect(resumed).toEqual(["b"]);
  t.renderer.destroy();
});

test("[n] dispatches app.clear and [x] dispatches session.export", async () => {
  const { host, press, calls, deps } = mount({ sessions: [session("a", "fix the bug")] });
  const t = await openRender((() => SessionsHub(host, deps)) as never, { width: 110, height: 24 });
  await t.renderOnce();
  await t.renderOnce();
  press("n");
  press("x");
  expect(calls).toEqual(["dispatch:app.clear", "dispatch:session.export"]);
  t.renderer.destroy();
});

test("[d] asks for confirmation before deleting", async () => {
  const { host, press, deleted, deps } = mount({ sessions: [session("a", "fix the bug")] });
  const t = await openRender((() => SessionsHub(host, deps)) as never, { width: 110, height: 24 });
  await t.renderOnce();
  await t.renderOnce();
  press("d");
  expect(host.pendingConfirm()?.message).toContain("fix the bug");
  expect(deleted).toEqual([]);
  t.renderer.destroy();
});

test("deleting a non-first row keeps a row marked", async () => {
  // The list shrank under the cursor and the selection index was left past the
  // end, so after a delete collapsed onto the sole remaining row nothing was
  // marked at all.
  const rows: SessionCatalogItem[] = ["a", "b"].map((id, index) => ({
    meta: { ...session(id, `session ${id}`), updatedAt: 1_000 - index },
    workspaceId: "ws",
    workspaceLabel: "",
    available: true,
  }));
  const { host, press, deleted, deps } = mount({ catalog: rows });
  const t = await openRender((() => SessionsHub(host, deps)) as never, { width: 110, height: 24 });
  await t.renderOnce();
  await Promise.resolve();
  await t.renderOnce();
  press("down");
  press("d");
  expect(host.pendingConfirm()).not.toBeNull();
  press("y");
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await t.renderOnce();
  }
  expect(deleted).toHaveLength(1);
  const frame = t.captureCharFrame();
  expect(frame).toContain("session a");
  expect(frame).not.toContain("session b");
  t.renderer.destroy();
});

test("an unavailable workspace session cannot be deleted", async () => {
  const item: SessionCatalogItem = {
    meta: session("gone", "retained audit"),
    workspaceId: "ws_removed",
    workspaceLabel: "Removed",
    available: false,
  };
  const { host, press, deleted, deps } = mount({ catalog: [item] });
  const t = await openRender((() => SessionsHub(host, deps)) as never, {
    width: 110,
    height: 24,
  });
  await t.renderOnce();
  await Promise.resolve();
  await t.renderOnce();
  press("d");
  expect(host.pendingConfirm()).toBeNull();
  expect(deleted).toEqual([]);
  t.renderer.destroy();
});
