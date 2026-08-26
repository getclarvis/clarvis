import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import type { RunEvent } from "@clarvis/protocol";
import { createTranscriptStore, type TranscriptNode } from "../../src/adapters/store.ts";
import { applyRunEvent, runEvent } from "../helpers/run-events.ts";
import { BlockView } from "../../src/views/blocks.tsx";

const ev = runEvent;

function drive(stream: RunEvent[]): TranscriptNode[] {
  return createRoot(() => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    for (const event of stream) applyRunEvent(sink, event, "live");
    return store.nodes;
  });
}

async function frame(node: TranscriptNode): Promise<string> {
  const t = await openRender(() => <BlockView node={node} />, { width: 60, height: 6 });
  await t.renderOnce();
  const out = t.captureCharFrame();
  t.renderer.destroy();
  return out;
}

test("run_ended stamps elapsedMs from the protocol event timestamps", () => {
  const nodes = drive([
    ev({ type: "run_started", at: 1_000 }),
    ev({ type: "run_ended", status: "completed", at: 135_000, reason: "completed" }),
  ]);
  const run = nodes.find((n) => n.kind === "run");
  expect(run?.elapsedMs).toBe(134_000);
});

test("the run node renders concise completion chrome with elapsed", async () => {
  const out = await frame({
    key: "r",
    kind: "run",
    status: "ok",
    text: "",
    reason: "done",
    elapsedMs: 134_000,
  });
  expect(out).toContain("── ✓ Completed · 2m14s");
  expect(out).not.toContain("Next:");
  expect(out).not.toMatch(/[↑↓]\d/);
});

test("a thinking node shows exactly one glyph before the label", async () => {
  const out = await frame({ key: "t", kind: "thinking", status: "running", text: "" });
  // thinkingDots() is driven by a process-wide spinner frame, so the ellipsis
  // width varies ("...", ".. ", ".  "). Assert the stable label + one spinner
  // glyph, not a frozen animation frame.
  expect(out).toMatch(/thinking\.*/);
  expect(out).toMatch(/[-\\|/\u2800-\u28ff]\s+thinking/);
  expect(out).not.toContain("✦");
});

test("a failed run states its verdict and offers only actions that exist", async () => {
  const out = await frame({
    key: "r",
    kind: "run",
    status: "error",
    text: "",
    reason: "provider_error",
    elapsedMs: 22_000,
  });
  expect(out).toContain("✗ Failed · 22s");
  /* The hint used to recommend inspecting an error the product had nothing to
     show and retrying with a key that performs no retry. */
  expect(out).not.toContain("inspect the error");
  expect(out).toContain("send a follow-up to try again");
});

test("a canceled run is named as canceled, not failed", async () => {
  const out = await frame({
    key: "r",
    kind: "run",
    status: "error",
    text: "",
    reason: "canceled by the user",
    elapsedMs: 3_000,
  });
  expect(out).toContain("Canceled");
  expect(out).not.toContain("Failed");
});
