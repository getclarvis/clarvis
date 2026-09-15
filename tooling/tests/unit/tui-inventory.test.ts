import { describe, expect, test } from "bun:test";
import { inspectTuiInventory } from "../../lib/tui-inventory.ts";

const rows = [
  ["INV-01", "Artifact identity"],
  ["CMD-01", "`/help`"],
  ["CMD-24", "Dynamic skill commands"],
  ["CMD-25", "Dynamic MCP prompts"],
  ["SET-01", "Providers"],
  ["SAFE-09", "Docker"],
  ["NATIVE-01", "Physical terminal"],
] as const;

function matrix(padded: boolean): string {
  return rows
    .map(([id, body]) => `| ${("`" + id + "`").padEnd(padded ? 16 : id.length + 2)} | ${body} |`)
    .join("\n");
}

function inspect(
  source: string,
  overrides: { commandSources?: string[]; settingsSource?: string } = {},
) {
  return inspectTuiInventory({
    matrix: source,
    commandSources: ['{ slash: "/help" }'],
    settingsSource: '{ label: "Providers" }',
    ...overrides,
  });
}

describe("static TUI inventory", () => {
  test("counts every table row regardless of padding and ignores prose mentions", () => {
    const result = inspect(matrix(true) + "\nSee `SAFE-09` and `NATIVE-01`.\n");
    expect(result).toEqual(inspect(matrix(false)));
    expect(result.scenarioIds).toEqual(rows.map(([id]) => id));
    expect(result.commands).toEqual(["/help"]);
    expect(result.settings).toEqual(["Providers"]);
  });

  test("rejects duplicate scenario rows even when their column padding differs", () => {
    expect(() => inspect(matrix(true) + "\n| `INV-01` | Repeated |\n")).toThrow(
      "duplicate scenario IDs: INV-01",
    );
  });

  test("reports missing and stale command and Settings registrations", () => {
    expect(() => inspect(matrix(true), { commandSources: ['{ slash: "/new" }'] })).toThrow(
      "public slash command inventory drifted; missing: /new; stale: /help",
    );
    expect(() => inspect(matrix(true), { settingsSource: '{ label: "Theme" }' })).toThrow(
      "Settings panel inventory drifted; missing: Theme; stale: Providers",
    );
  });

  test("requires dynamic commands to have scenario rows, not just prose mentions", () => {
    const source = matrix(true)
      .split("\n")
      .filter((line) => !line.includes("`CMD-25`"))
      .join("\n");
    expect(() => inspect(source + "\nTODO `CMD-25`\n")).toThrow(
      "missing dynamic command scenario: CMD-25",
    );
  });

  test("normalizes documented arguments and repeated registrations to one public command", () => {
    expect(
      inspect(matrix(true).replace("`/help`", "`/help` and `/help topics`"), {
        commandSources: ['{ slash: "/help" }', '{ slash: "/help" }'],
      }).commands,
    ).toEqual(["/help"]);
  });
});
