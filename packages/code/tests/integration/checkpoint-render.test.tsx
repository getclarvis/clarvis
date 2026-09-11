import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { RunEvent } from "@clarvis/protocol";
import { createTranscriptStore } from "../../src/adapters/store.ts";
import { BlockView } from "../../src/views/blocks.tsx";
import { applyRunEvent } from "../helpers/run-events.ts";
import { openRender } from "../helpers/tracked-render.ts";

test.each(["live", "replay"] as const)(
  "renders a %s checkpoint distinctly from final completion",
  async (source) => {
    const { store, sink, dispose } = createRoot((dispose) => {
      const store = createTranscriptStore();
      return { store, sink: store.openRun("stage"), dispose };
    });
    try {
      applyRunEvent(sink, { type: "run_started", at: 0 }, source);
      applyRunEvent(
        sink,
        { type: "run_ended", at: 5, status: "completed", disposition: "checkpoint" },
        source,
      );
      const node = store.nodes.find((item) => item.kind === "run")!;
      expect(node).toMatchObject({ status: "ok", disposition: "checkpoint" });
      const view = await openRender(() => <BlockView node={node} />, { width: 100, height: 10 });
      try {
        await view.renderOnce();
        expect(view.captureCharFrame()).toContain("Checkpoint saved");
        expect(view.captureCharFrame()).not.toContain("Completed");
        sink.beginReconcile();
        applyRunEvent(sink, { type: "run_started", at: 0 }, "replay");
        applyRunEvent(
          sink,
          { type: "run_ended", at: 5, status: "completed", disposition: "checkpoint" },
          "replay",
        );
        sink.endReconcile();
        expect(store.nodes.find((item) => item.kind === "run")).toBe(node);
        await view.renderOnce();
        expect(view.captureCharFrame()).toContain("Checkpoint saved");
      } finally {
        view.renderer.destroy();
      }
    } finally {
      dispose();
    }
  },
);

test.each([
  { status: "completed", reason: "completed", label: "Completed" },
  { status: "failed", reason: "error", disposition: "checkpoint", label: "Failed" },
  { status: "cancelled", reason: "cancelled", disposition: "checkpoint", label: "Canceled" },
] as const)("keeps $status independent of checkpoint presentation", async ({ label, ...ended }) => {
  const { node, dispose } = createRoot((dispose) => {
    const store = createTranscriptStore();
    const sink = store.openRun("stage");
    applyRunEvent(sink, { type: "run_started", at: 0 }, "replay");
    applyRunEvent(sink, { type: "run_ended", at: 5, ...ended } satisfies RunEvent, "replay");
    return { node: store.nodes.find((item) => item.kind === "run")!, dispose };
  });
  try {
    const view = await openRender(() => <BlockView node={node} />, { width: 100, height: 10 });
    try {
      await view.renderOnce();
      expect(view.captureCharFrame()).toContain(label);
      expect(view.captureCharFrame()).not.toContain("Checkpoint saved");
    } finally {
      view.renderer.destroy();
    }
  } finally {
    dispose();
  }
});
