import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import type { Interaction } from "../../src/keys/interaction.ts";
import { createViewHost } from "../../src/views/config/view-host.tsx";
import { McpBrowser } from "../../src/views/config/McpBrowser.tsx";
import { schemaArgRows, type ServerNode } from "../../src/adapters/mcp-capabilities.ts";
import { createFakeKeymap } from "../helpers/fake-keymap.ts";

const fakeKeymap = createFakeKeymap;

const NODES: ServerNode[] = [
  {
    name: "kernel",
    origin: "control-plane",
    status: "connected",
    type: "stdio",
    tools: [],
    prompts: [],
  },
  {
    name: "workspace-fs",
    origin: "downstream",
    status: "connected",
    type: "stdio",
    tools: [
      {
        name: "read_files",
        description: "Read files from the workspace",
        inputSchema: {
          properties: {
            paths: { type: "array", description: "workspace-relative paths" },
            max_bytes: { type: "number" },
          },
          required: ["paths"],
        },
      },
    ],
    prompts: [{ name: "review", description: "Review the diff" }],
  },
  {
    name: "ghost-server",
    origin: "downstream",
    status: "declared",
    type: "stdio",
    tools: [],
    prompts: [],
  },
];

function mount() {
  const { keymap, press } = fakeKeymap();
  const notes: string[] = [];
  const edits: (string | undefined)[] = [];
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const deps = {
    nodes: () => NODES,
    refresh: async () => {},
    editConfig: (server?: string) => edits.push(server),
    notify: (m: string) => notes.push(m),
  };
  return { host, deps, press, notes, edits };
}

test("L0 shows sections, a status legend and the read-only badge", async () => {
  const { host, deps } = mount();
  const t = await openRender((() => McpBrowser(host, deps)) as never, { width: 110, height: 28 });
  await t.renderOnce();
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("backend");
  expect(frame).toContain("downstream (aggregated by the kernel)");
  expect(frame).toContain("ghost-server");
  expect(frame).toContain("Read-only");
  expect(frame).toContain("✓ connected   ⚠ lost   ✗ unavailable   ○ declared");
  expect(frame).toContain("[e] where to edit");
  expect(frame).toContain("[^r] refresh");
  t.renderer.destroy();
});

test("a refresh that never settles shows the loading hint, not an empty list", async () => {
  const { keymap } = fakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const deps = {
    nodes: () => [] as ServerNode[],
    refresh: () => new Promise<void>(() => {}),
    editConfig: () => {},
    notify: () => {},
  };
  const t = await openRender((() => McpBrowser(host, deps)) as never, { width: 110, height: 28 });
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("loading…");
  expect(frame).not.toContain("no MCP servers");
  t.renderer.destroy();
});

test("a failed refresh is a persistent banner in the list's place, not an empty list", async () => {
  const { keymap } = fakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const deps = {
    nodes: () => [] as ServerNode[],
    refresh: () => Promise.reject(new Error("kernel unreachable")),
    editConfig: () => {},
    notify: () => {},
  };
  const t = await openRender((() => McpBrowser(host, deps)) as never, { width: 110, height: 28 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("refresh failed: kernel unreachable");
  expect(frame).not.toContain("no MCP servers");
  t.renderer.destroy();
});

test("tool detail renders the argument table instead of a JSON dump", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => McpBrowser(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("read_files — Read files from the workspace");
  expect(frame).toContain("arguments");
  expect(frame).toContain("paths");
  expect(frame).toContain("array");
  expect(frame).toContain("required");
  expect(frame).toContain("max_bytes");
  expect(frame).toContain("optional");
  expect(frame).not.toContain("input schema  {");
  expect(frame).toContain("a tool is the agent's capability");
  expect(frame).not.toContain("§");
  t.renderer.destroy();
});

test("[e] on a downstream row names the server in the edit pointer", async () => {
  const { host, deps, press, edits } = mount();
  const t = await openRender((() => McpBrowser(host, deps)) as never, { width: 110, height: 28 });
  await t.renderOnce();
  press("down");
  press("e");
  expect(edits).toEqual(["workspace-fs"]);
  t.renderer.destroy();
});

test("[e] on the control-plane row edits config with no server name", async () => {
  const { host, deps, press, edits } = mount();
  const t = await openRender((() => McpBrowser(host, deps)) as never, { width: 110, height: 28 });
  await t.renderOnce();
  press("e");
  expect(edits).toEqual([undefined]);
  t.renderer.destroy();
});

test("ctrl+r re-triggers a refresh from the server list", async () => {
  let calls = 0;
  const { keymap, press } = fakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const deps = {
    nodes: () => NODES,
    refresh: async () => {
      calls++;
    },
    editConfig: () => {},
    notify: () => {},
  };
  const t = await openRender((() => McpBrowser(host, deps)) as never, { width: 110, height: 28 });
  await t.renderOnce();
  expect(calls).toBe(1);
  press("ctrl+r");
  await t.renderOnce();
  expect(calls).toBe(2);
  t.renderer.destroy();
});

test("L1: [i] invokes a prompt row and [e] names the current server", async () => {
  const { host, deps, press, notes, edits } = mount();
  const t = await openRender((() => McpBrowser(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  press("down");
  press("i");
  await t.renderOnce();
  expect(notes).toEqual(["invoking workspace-fs:review"]);

  press("e");
  expect(edits).toEqual(["workspace-fs"]);
  t.renderer.destroy();
});

test("prompt detail renders its arguments and [i] invokes it", async () => {
  const { host, deps, press, notes } = mount();
  const t = await openRender((() => McpBrowser(host, deps)) as never, { width: 110, height: 30 });
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  press("down");
  press("return");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("review — Review the diff");
  expect(frame).toContain("no arguments");
  expect(frame).toContain("/workspace-fs:review");
  expect(frame).toContain("[i] invoke");

  press("i");
  await t.renderOnce();
  expect(notes).toEqual(["invoking workspace-fs:review"]);
  t.renderer.destroy();
});

test("the control-plane node's detail explains it is not a browsable capability", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => McpBrowser(host, deps)) as never, { width: 110, height: 28 });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("is transport/backend and is not a browsable capability.");
  t.renderer.destroy();
});

test("a declared server with no live capabilities explains why", async () => {
  const { host, deps, press } = mount();
  const t = await openRender((() => McpBrowser(host, deps)) as never, { width: 110, height: 28 });
  await t.renderOnce();
  press("down");
  press("down");
  press("return");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  expect(frame).toContain("declared in settings");
  expect(frame).toContain("capabilities appear once the server connects");
  t.renderer.destroy();
});

test("a server declaration marked shared shows the shared badge", async () => {
  const { keymap } = fakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const shared: ServerNode[] = [
    {
      name: "shared-server",
      origin: "downstream",
      status: "connected",
      type: "stdio",
      decl: { name: "shared-server", type: "stdio", shared: true },
      tools: [],
      prompts: [],
    },
  ];
  const deps = {
    nodes: () => shared,
    refresh: async () => {},
    editConfig: () => {},
    notify: () => {},
  };
  const t = await openRender((() => McpBrowser(host, deps)) as never, { width: 110, height: 28 });
  await t.renderOnce();
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("shared");
  t.renderer.destroy();
});

test("a tool with no declared properties shows 'no arguments' instead of the raw schema", async () => {
  const { keymap, press } = fakeKeymap();
  const { host } = createViewHost({
    interaction: { keymap } as unknown as Interaction,
    close: () => {},
    dispatch: () => {},
  });
  const bare: ServerNode[] = [
    {
      name: "bare-server",
      origin: "downstream",
      status: "connected",
      type: "stdio",
      tools: [{ name: "ping", description: "", inputSchema: { properties: {} } }],
      prompts: [],
    },
  ];
  const deps = {
    nodes: () => bare,
    refresh: async () => {},
    editConfig: () => {},
    notify: () => {},
  };
  const t = await openRender((() => McpBrowser(host, deps)) as never, { width: 110, height: 28 });
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  press("return");
  await t.renderOnce();
  expect(t.captureCharFrame()).toContain("no arguments");
  t.renderer.destroy();
});

test("schemaArgRows maps properties with types, required flags and descriptions", () => {
  const rows = schemaArgRows({
    properties: {
      path: { type: "string", description: "file path" },
      depth: { type: "integer" },
    },
    required: ["path"],
  });
  expect(rows).toEqual([
    { name: "path", type: "string", required: true, description: "file path" },
    { name: "depth", type: "integer", required: false, description: "" },
  ]);
  expect(schemaArgRows(undefined)).toEqual([]);
});
