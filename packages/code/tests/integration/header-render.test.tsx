import { createSignal } from "solid-js";
import { expect, test } from "bun:test";
import { openRender } from "../helpers/tracked-render.ts";
import { HeaderRows } from "../../src/views/HeaderRows.tsx";
import { projectHeader, type HeaderInput } from "../../src/views/header-projection.ts";

function baseInput(over: Partial<HeaderInput> = {}): HeaderInput {
  return {
    width: 140,
    floor: false,
    agentName: "coder",
    model: "openrouter/x-ai/grok-4.5",
    safetyPreset: "isolated",
    guardMode: "off",
    memoryConfigured: true,
    memory: "on",
    plans: { mode: "on", retention: "discard", configured: true },
    connection: { phase: "ready" },
    doctorDirty: false,
    workspace: "/work/clarvis_bench/demo_01",
    ...over,
  };
}

async function frame(input: HeaderInput): Promise<string[]> {
  const t = await openRender(
    () => (
      <box flexDirection="column" width={input.width} height={5}>
        <HeaderRows plan={() => projectHeader(input)} />
        <text>{"-".repeat(input.width)}</text>
        <text>BODY</text>
      </box>
    ),
    { width: input.width, height: 5 },
  );
  await t.renderOnce();
  const rows = t.captureCharFrame().split("\n");
  t.renderer.destroy();
  return rows;
}

test("header is one line carrying identity and the run's governing configuration", async () => {
  const rows = await frame(baseInput());
  expect(rows[0]).toContain("demo_01");
  expect(rows[0]).toContain("coder");
  expect(rows[0]).toContain("grok-4.5");
  expect(rows[0]).toContain("Safety: isolated");
  expect(rows[0]).toContain("Memory: on");
  expect(rows[0]).not.toContain("plans:");
  expect(rows[1]).toContain("----------");
  expect(rows[2]).toContain("BODY");
});

test("memory off is stated, not merely absent", async () => {
  const rows = await frame(baseInput({ memory: "off" }));
  expect(rows[0]).toContain("Memory: off");
});

test("urgent connection state remains visible on the stable header", async () => {
  const rows = await frame(
    baseInput({
      connection: { phase: "failed", detail: "offline" },
    }),
  );
  expect(rows[0]).toContain("backend connect failed");
});

test("run lifecycle labels never enter the stable header row", async () => {
  const rows = await frame(baseInput());
  expect(rows[0]).not.toContain("Running");
  expect(rows[0]).not.toContain("Canceled");
  expect(rows[0]).not.toContain("Failed");
  expect(rows[1]).toContain("----------");
});

test("exceptional safety appears only when there is room", async () => {
  const wide = await frame(baseInput({ width: 140, sandboxUnavailable: true }));
  expect(wide[0]).toContain("Sandbox unavailable");
  const compact = await frame(baseInput({ width: 48, sandboxUnavailable: true }));
  expect(compact[0]).not.toContain("Sandbox unavailable");
  expect(compact[0]!.trimEnd().length).toBeLessThanOrEqual(48);
});

test("reactive connection updates replace the urgent host state in place", async () => {
  const [connection, setConnection] = createSignal<HeaderInput["connection"]>({ phase: "ready" });
  const t = await openRender(
    () => (
      <HeaderRows plan={() => projectHeader(baseInput({ width: 90, connection: connection() }))} />
    ),
    { width: 90, height: 3 },
  );
  await t.renderOnce();
  expect(t.captureCharFrame()).not.toContain("connect failed");
  setConnection({ phase: "failed", detail: "offline" });
  await t.renderOnce();
  const out = t.captureCharFrame();
  expect(out).toContain("connect failed");
  expect(out.split("\n").filter((row) => row.includes("Clarvis"))).toHaveLength(1);
  t.renderer.destroy();
});

test("the audited width matrix keeps one bounded identity row", async () => {
  for (const width of [24, 36, 48, 71, 72, 99, 100, 119, 120, 124, 160, 200]) {
    const rows = await frame(
      baseInput({
        width,
        sandboxUnavailable: true,
      }),
    );
    expect(rows[0]).toContain("Clarvis");
    expect(rows[0]!.length).toBeLessThanOrEqual(width);
    expect(rows.filter((row) => row.includes("Clarvis"))).toHaveLength(1);
    if (width < 100) expect(rows[0]).not.toContain("Sandbox unavailable");
  }
});
