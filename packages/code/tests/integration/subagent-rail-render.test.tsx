import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import type { TranscriptNode } from "../../src/adapters/store.ts";

async function frame(node: TranscriptNode): Promise<string[]> {
  const t = await openRender(() => <BlockView node={node} forceExpand={() => true} />, {
    width: 60,
    height: 10,
  });
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out.split("\n");
}

const subagentTool: TranscriptNode = {
  key: "t1",
  kind: "tool_call",
  status: "ok",
  text: "",
  mcpName: "shell",
  toolName: "",
  args: { command: "ls" },
  result: '{"exit_code":0,"stdout":"one\\ntwo","stderr":""}',
  subagentOrder: 1,
  agentLabel: "verify tests",
};

test("subagent blocks carry a continuous │ rail down every content row", async () => {
  const rows = await frame(subagentTool);
  const content = rows.filter((r) => r.trim().length > 0);
  expect(content.length).toBeGreaterThan(2);
  for (const row of content) {
    expect(row[0]).toBe("│");
  }
});

test("Lead blocks have no rail — the lead is not a subagent", async () => {
  const rows = await frame({ ...subagentTool, key: "t2", subagentOrder: undefined });
  for (const row of rows) {
    expect(row[0] ?? " ").not.toBe("│");
  }
});
