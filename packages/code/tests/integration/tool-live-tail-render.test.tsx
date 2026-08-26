import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import type { LegacyCollapsibleNode } from "../helpers/transcript-fixtures.ts";

function bashNode(overrides: Partial<LegacyCollapsibleNode>): LegacyCollapsibleNode {
  return {
    key: "t0",
    kind: "tool_call",
    status: "running",
    text: "",
    mcpName: "shell",
    toolName: "",
    args: { command: "bun test" },
    error: null,
    ...overrides,
  };
}

async function frame(node: TranscriptNode, width = 100): Promise<string> {
  const t = await openRender(() => <BlockView node={node} />, { width, height: 30 });
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("a running tool renders the last 5 lines of its live output under the header", async () => {
  const liveOutput = Array.from({ length: 7 }, (_, i) => `tail-${i + 1}`).join("\n") + "\n";
  const out = await frame(bashNode({ liveOutput }));
  expect(out).toContain("shell");
  expect(out).toContain("tail-3");
  expect(out).toContain("tail-7");
  expect(out).not.toContain("tail-1");
  expect(out).not.toContain("tail-2");
});

test("a long tail line truncates to the row instead of wrapping", async () => {
  const out = await frame(bashNode({ liveOutput: "start-" + "x".repeat(80) + "-END\n" }), 40);
  const rows = out.split("\n").filter((row) => row.includes("xx"));
  expect(rows).toHaveLength(1);
});

test("the tail never renders once the call has closed", async () => {
  const out = await frame(
    bashNode({
      status: "ok",
      liveOutput: "stale-tail-line\n",
      result: JSON.stringify({ exit_code: 0, stdout: "done", stderr: "" }),
      collapsed: true,
    }),
  );
  expect(out).not.toContain("stale-tail-line");
  expect(out).toContain("shell");
});
