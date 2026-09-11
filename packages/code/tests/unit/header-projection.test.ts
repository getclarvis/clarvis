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
    isolation: "sandbox",
    review: "off",
    memoryConfigured: true,
    memory: "on",
    plans: { mode: "on", retention: "discard", configured: true },
    connection: { phase: "ready" },
    doctorDirty: false,
    workspace: "/work/acme/demo",
    ...overrides,
  };
}

test("header shows Podman as isolation without appending placement to the workspace", () => {
  const plan = projectHeader(baseInput({ isolation: "podman" }));
  expect(plan.status.find((chip) => chip.key === "isolation")?.text).toContain("Podman");
  expect(plan.workspace.text).not.toContain("[");
});

test("header identifies Docker independently from command review", () => {
  const status = projectHeader(baseInput({ isolation: "docker", review: "auto" })).status;
  expect(status.find((chip) => chip.key === "isolation")?.text).toContain("Docker");
  expect(status.find((chip) => chip.key === "review")?.text).toContain("Auto");
});

test("header owns workspace identity rather than the full path", () => {
  const plan = projectHeader(baseInput());
  expect(plan.regime).toBe("one-line");
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

test("the header states model, isolation, review and memory independently", () => {
  const status = projectHeader(baseInput()).status;
  expect(status.map((chip) => chip.key)).toEqual(["model", "isolation", "review", "memory"]);
  expect(status[0]!.text).toContain("grok-4.5");
  expect(status[1]!.text).toContain("Isolation: Sandbox");
  expect(status[2]!.text).toContain("Review: Off");
  expect(status[3]!.text).toContain("Memory: on");
});

test("configuration joins the identity run rather than floating past the gap", () => {
  const plan = projectHeader(baseInput({ width: 140 }));
  for (const chip of plan.status) expect(chip.text.startsWith("  ·  ")).toBe(true);
  expect(plan.identity!.text + plan.status.map((chip) => chip.text).join("")).toBe(
    "  ·  coder  ·  x-ai/grok-4.5  ·  Isolation: Sandbox  ·  Review: Off  ·  Memory: on",
  );
});

test("the field after the flexible gap carries no separator of its own", () => {
  const plan = projectHeader(
    baseInput({
      width: 140,
      sandboxUnavailable: true,
      connection: { phase: "failed", detail: "closed" },
    }),
  );
  expect(plan.exception!.text.startsWith("  ·  ")).toBe(false);
  expect(plan.urgent!.text.startsWith("  ·  ")).toBe(true);
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

test("the status zone sheds wording before it sheds facts", () => {
  const at = (width: number): string[] =>
    projectHeader(baseInput({ width })).status.map((chip) => chip.text.replace(/^\s*·\s*/, ""));
  expect(at(200).join(" ")).toContain("x-ai/grok-4.5");
  expect(at(84).join(" ")).not.toContain("x-ai/");
  expect(at(84).join(" ")).toContain("grok-4.5");
  expect(at(84).join(" ")).toContain("Sandbox");
  expect(at(84).join(" ")).toContain("Off");
  expect(at(84).join(" ")).not.toContain("mem on");
  const tight = at(72).join(" ");
  expect(tight).toContain("grok-4.5");
  expect(tight).not.toContain("Sandbox");
  const narrow = at(60).join(" ");
  expect(narrow).toContain("grok-4.5");
  expect(narrow).not.toContain("Sandbox");
  expect(at(48)).toEqual([]);
  expect(at(30)).toEqual([]);
});

test("connection failure remains actionable in the stable header", () => {
  const plan = projectHeader(baseInput({ connection: { phase: "failed", detail: "closed" } }));
  expect(plan.urgent?.text).toContain("failed");
});

test("Host isolation is stated once and marked as the warning it is", () => {
  const wide = projectHeader(baseInput({ width: 120, isolation: "host" }));
  expect(wide.status.find((chip) => chip.key === "isolation")!.text).toContain("Host");
  expect(wide.status.find((chip) => chip.key === "isolation")!.color).toBe(tokens.warn);
  expect(wide.exception).toBeUndefined();
  expect(projectHeader(baseInput({ width: 72, isolation: "host" })).exception).toBeUndefined();
});

test("sandbox failure outranks other configuration warnings", () => {
  const plan = projectHeader(
    baseInput({ isolation: "host", sandboxUnavailable: true, doctorDirty: true }),
  );
  expect(plan.exception?.text).toContain("Sandbox unavailable");
});

test("floor mode drops secondary identity", () => {
  expect(projectHeader(baseInput({ width: 20, floor: true })).identity).toBeUndefined();
});
