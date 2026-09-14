import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

test("Container-only local actions fail before host shell or durable handoff effects", () => {
  const source = readFileSync("src/run-host.ts", "utf8");
  const bang = source.indexOf(
    'if (deps.runtimeKind?.() === "container")',
    source.indexOf("function runBangCommand"),
  );
  const shell = source.indexOf("runBash(", source.indexOf("function runBangCommand"));
  expect(bang).toBeGreaterThan(-1);
  expect(shell).toBeGreaterThan(bang);

  const background = source.indexOf(
    'if (deps.runtimeKind?.() === "container")',
    source.indexOf("async function backgroundCurrentRun"),
  );
  const handoff = source.indexOf("hosting.detach", source.indexOf("function backgroundCurrentRun"));
  expect(background).toBeGreaterThan(-1);
  expect(handoff).toBeGreaterThan(background);
  expect(source).toContain('deps.runtimeKind?.() !== "container" && runActive()');
});

test("Container submission keeps native Plans and Memory fields while refusing Tasks explicitly", () => {
  const source = readFileSync("src/adapters/kernel-run-client.ts", "utf8");
  expect(source).toContain("plans:");
  expect(source).toContain("memory:");
  expect(source).toContain("Tasks is unavailable in Isolation Container");
  expect(source).not.toContain("delete request.plans");
  expect(source).not.toContain("delete request.memory");
});
