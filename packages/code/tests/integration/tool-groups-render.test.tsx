import { expect, test } from "bun:test";
import { For } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import { computeToolGroups } from "../../src/views/tool-groups.ts";
import type { NodeStatus, TranscriptNode } from "../../src/adapters/store.ts";
import type { LegacyCollapsibleNode } from "../helpers/transcript-fixtures.ts";

let seq = 0;
function glob(pattern: string, status: NodeStatus = "ok"): LegacyCollapsibleNode {
  return {
    key: `n${seq++}`,
    kind: "tool_call",
    status,
    text: "",
    mcpName: "clarvis",
    toolName: "glob",
    args: { pattern },
    result: "(no matches)",
    error: status === "error" ? "boom" : null,
    collapsed: status !== "running",
  };
}
function reasoning(text: string): LegacyCollapsibleNode {
  return { key: `a${seq++}`, kind: "reasoning", status: "ok", text };
}
function shell(
  command: string,
  outcome: "allowed" | "denied",
  answerer: "policy" | "judge",
): LegacyCollapsibleNode {
  return {
    key: `s${seq++}`,
    kind: "tool_call",
    status: outcome === "allowed" ? "ok" : "error",
    text: "",
    toolName: "shell",
    args: { command, cwd: "/workspace" },
    error: outcome === "denied" ? "denied" : null,
    collapsed: true,
    guard: { mode: "auto", outcome, answerer },
  };
}

async function frame(nodes: TranscriptNode[], expand: boolean): Promise<string> {
  const groups = computeToolGroups(nodes);
  const t = await openRender(
    () => (
      <box flexDirection="column">
        <For each={nodes}>
          {(node) => (
            <BlockView node={node} forceExpand={() => expand} group={() => groups.get(node.key)} />
          )}
        </For>
      </box>
    ),
    { width: 100, height: 60 },
  );
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("collapsed: a batch folds to one `tool xN` head listing each member's signature", async () => {
  const nodes = [glob("a.ts"), glob("b.ts"), glob("c.ts"), glob("d.ts")];
  const out = await frame(nodes, false);
  expect(out).toContain("clarvis:glob");
  expect(out).toContain("x4");
  expect(out).toContain("(b.ts)");
  expect(out).toContain("(d.ts)");
  expect(out.split("clarvis:glob").length - 1).toBe(1);
  expect(out).not.toContain("(no matches)");
});

test("collapsed: a long batch elides signature lines past the cap", async () => {
  const nodes = Array.from({ length: 9 }, (_, i) => glob(`f${i}.ts`));
  const out = await frame(nodes, false);
  expect(out).toContain("x9");
  expect(out).toContain("(f5.ts)");
  expect(out).not.toContain("(f6.ts)");
  expect(out).toContain("… +3 lines");
});

test("collapsed: grouped shell signatures retain each auto-guard verdict", async () => {
  const nodes = [
    shell("git diff --check", "allowed", "policy"),
    shell("git restore --worktree -- .", "denied", "judge"),
  ];
  const out = await frame(nodes, false);
  expect(out).toContain("shell x2 · 1 failed");
  expect(out).toContain("git diff --check");
  expect(out).toContain("auto-guard approved · policy");
  expect(out).toContain("git restore --worktree -- .");
  expect(out).toContain("auto-guard denied · judge");
  expect(out).not.toContain("denied\n");
});

test("collapsed: a guarded failure survives after the ordinary signature cap", async () => {
  const nodes = [
    ...Array.from({ length: 6 }, (_, index) => shell(`echo ${index}`, "allowed", "policy")),
    shell("git reset --hard", "denied", "judge"),
  ];
  const out = await frame(nodes, false);

  expect(out).toContain("git reset --hard");
  expect(out).toContain("auto-guard denied · judge");
  expect(out).toContain("… +1 line");
});

test("expanded (Ctrl+O): the `xN` count header is dropped and each call renders in full", async () => {
  const nodes = [glob("a.ts"), glob("b.ts"), glob("c.ts")];
  const out = await frame(nodes, true);
  expect(out).not.toContain("x3");
  expect(out.split("clarvis:glob").length - 1).toBe(3);
  expect(out).toContain("a.ts");
  expect(out).toContain("b.ts");
  expect(out).toContain("c.ts");
});

test("a model message splits the batch, and failed members stay hidden until expansion", async () => {
  const nodes = [
    glob("a.ts"),
    glob("b.ts", "error"),
    reasoning("let me look closer"),
    glob("c.ts"),
    glob("d.ts"),
  ];
  const out = await frame(nodes, false);
  expect(out).toContain("x2 · 1 failed");
  expect(out).toContain("x2");
  expect(out).not.toContain("x4");
  expect(out).toContain("let me look closer");
  expect(out).not.toContain("b.ts");
  expect(out).not.toContain("boom");
  expect(out).toContain("(a.ts)");
  expect(out.split("clarvis:glob").length - 1).toBe(2);

  const expanded = await frame(nodes, true);
  expect(expanded).toContain("b.ts");
  expect(expanded).toContain("boom");
});

test("a generic composing batch has one compact progress row and no empty signatures", async () => {
  const nodes: TranscriptNode[] = [
    {
      key: "read-1",
      kind: "tool_call",
      status: "running",
      text: "",
      toolName: "read_file",
      inputChars: 120,
    },
    {
      key: "read-2",
      kind: "tool_call",
      status: "running",
      text: "",
      toolName: "read_file",
      inputChars: 240,
    },
  ];

  const out = await frame(nodes, false);
  expect(out).toContain("read_file");
  expect(out).toContain("x2");
  expect(out).toContain("receiving arguments… 360 chars");
  expect(out).not.toContain("()\n");
});
