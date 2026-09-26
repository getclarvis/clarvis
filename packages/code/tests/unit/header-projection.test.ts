import { expect, test } from "bun:test";
import { projectHeader, type HeaderInput } from "../../src/views/header-projection.ts";
import { tokens } from "../../src/theme/tokens.ts";

function baseInput(overrides: Partial<HeaderInput> = {}): HeaderInput {
  return {
    width: 140,
    version: "0.0.4-beta",
    floor: false,
    agentName: "coder",
    model: "openrouter/x-ai/grok-4.5",
    memory: "on",
    isolation: "sandbox",
    approval: "manual",
    plans: { mode: "on", retention: "discard", configured: true },
    connection: { phase: "ready" },
    doctorDirty: false,
    workspace: "/work/acme/demo",
    ...overrides,
  };
}

test("header owns workspace identity rather than the full path", () => {
  const plan = projectHeader(baseInput());
  expect(plan.regime).toBe("wrapped");
  expect(plan.workspace.text).toContain("demo");
  expect(plan.workspace.text).not.toContain("/work/acme");
  expect(plan.identity?.text).toContain("coder");
  expect(plan.version.text).toBe("v0.0.4-beta");
});

test("an eligible update adds a persistent compact marker without replacing the installed version", () => {
  const plan = projectHeader(baseInput({ updateAvailable: true }));
  expect(plan.version.text).toBe("↑ v0.0.4-beta");
  expect(plan.version.color).toBe(tokens.accent);
});

test("the header states model, memory, isolation and approval independently", () => {
  const status = projectHeader(baseInput()).status;
  expect(status.map((chip) => chip.key)).toEqual(["model", "memory", "isolation", "approval"]);
  expect(status[0]!.text).toContain("grok-4.5");
  expect(status[1]!.text).toContain("Memory: on");
  expect(status[2]!.text).toContain("Isolation: sandbox");
  expect(status[3]!.text).toContain("Approval: manual");
});

test("configuration joins the identity run rather than floating past the gap", () => {
  const plan = projectHeader(baseInput({ width: 140 }));
  for (const chip of plan.status) expect(chip.text.startsWith("  ·  ")).toBe(true);
  expect(plan.identity!.text + plan.status.map((chip) => chip.text).join("")).toBe(
    "  ·  coder  ·  x-ai/grok-4.5  ·  Memory: on  ·  Isolation: sandbox  ·  Approval: manual",
  );
});

test("the field after the flexible gap carries no separator of its own", () => {
  const plan = projectHeader(
    baseInput({
      width: 140,
      doctorDirty: true,
    }),
  );
  expect(plan.exception!.text.startsWith("  ·  ")).toBe(false);
  expect(plan.urgent).toBeUndefined();
  const onlyUrgent = projectHeader(
    baseInput({ width: 140, connection: { phase: "failed", detail: "closed" } }),
  );
  expect(onlyUrgent.exception).toBeUndefined();
  expect(onlyUrgent.urgent!.text.startsWith("  ·  ")).toBe(false);
});

test("memory reports off only when it is off; inert stays configured", () => {
  const label = (memory: HeaderInput["memory"]): string =>
    projectHeader(baseInput({ memory })).status.find((chip) => chip.key === "memory")!.text;
  expect(label("on")).toContain("Memory: on");
  expect(label("inert")).toContain("Memory: on");
  expect(label("off")).toContain("Memory: off");
});

test("all widths retain the complete run configuration", () => {
  for (const width of [24, 48, 60, 72, 84, 200]) {
    const status = projectHeader(baseInput({ width })).status;
    expect(status.map((field) => field.key)).toEqual(["model", "memory", "isolation", "approval"]);
    expect(status.map((field) => field.text).join(" ")).toContain("Memory: on");
    expect(status.map((field) => field.text).join(" ")).toContain("Isolation: sandbox");
    expect(status.map((field) => field.text).join(" ")).toContain("Approval: manual");
  }
});

test("connection failure remains actionable in the stable header", () => {
  const plan = projectHeader(baseInput({ connection: { phase: "failed", detail: "closed" } }));
  expect(plan.urgent?.text).toContain("failed");
});

test("floor mode drops secondary identity", () => {
  expect(projectHeader(baseInput({ width: 20, floor: true })).identity).toBeUndefined();
});
