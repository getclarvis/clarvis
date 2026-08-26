import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { openRender } from "../helpers/tracked-render.ts";
import { MemoryPressureBanner } from "../../src/views/MemoryPressureBanner.tsx";
import type { MemoryPressureSnapshot } from "../../src/adapters/memory-pressure.ts";

const snapshot = (phase: MemoryPressureSnapshot["phase"]): MemoryPressureSnapshot => ({
  phase,
  advisory: false,
  rss: 5 * 1024 ** 3,
  heapUsed: 1,
  external: 1,
  arrayBuffers: 1,
  limitBytes: 5 * 1024 ** 3,
  warningBytes: 4 * 1024 ** 3,
  rearmBytes: 3.5 * 1024 ** 3,
  sampledAt: 1,
});

test("the real OpenTUI renderer keeps warning and recovery states visible", async () => {
  const [state, setState] = createSignal(snapshot("warning"));
  const rendered = await openRender(
    () => <MemoryPressureBanner state={state} onRecover={() => {}} />,
    { width: 72, height: 6 },
  );
  try {
    await rendered.renderOnce();
    expect(rendered.captureCharFrame()).toContain("High memory use");
    setState(snapshot("tripped"));
    await rendered.renderOnce();
    const frame = rendered.captureCharFrame();
    expect(frame).toContain("Work is blocked");
    expect(frame).toContain("/recover-memory");
  } finally {
    rendered.renderer.destroy();
  }
});
