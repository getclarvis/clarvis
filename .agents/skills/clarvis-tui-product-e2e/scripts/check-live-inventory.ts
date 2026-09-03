import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repo = resolve(process.argv[2] ?? process.cwd());
const matrixPath = resolve(
  repo,
  ".agents/skills/clarvis-tui-product-e2e/references/coverage-matrix.md",
);

async function text(path: string): Promise<string> {
  return readFile(resolve(repo, path), "utf8");
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

function assertSame(label: string, live: ReadonlySet<string>, covered: ReadonlySet<string>): void {
  const missing = difference(live, covered);
  const stale = difference(covered, live);
  if (missing.length === 0 && stale.length === 0) return;

  const parts = [label + " inventory drifted"];
  if (missing.length > 0) parts.push("missing: " + missing.join(", "));
  if (stale.length > 0) parts.push("stale: " + stale.join(", "));
  throw new Error(parts.join("; "));
}

const matrix = await readFile(matrixPath, "utf8");
const commandSources = await Promise.all(
  [
    "packages/code/src/app/commands.tsx",
    "packages/code/src/keys/commands.ts",
    "packages/code/src/views/App.tsx",
  ].map(text),
);
const liveCommands = new Set(
  commandSources.flatMap((source) =>
    [...source.matchAll(/slash:\s*"(\/[^"\n]+)"/g)].map((match) => match[1]!),
  ),
);

const commandRows = [...matrix.matchAll(/^\| `CMD-\d+` \| (.+) \|$/gm)].map((match) => match[1]!);
const coveredCommands = new Set(
  commandRows.flatMap((row) =>
    [...row.matchAll(/`(\/[^`]+)`/g)].map((match) => match[1]!.trim().split(/\s+/)[0]!),
  ),
);
assertSame("public slash command", liveCommands, coveredCommands);

const settingsSource = await text("packages/code/src/views/config/hub-items.ts");
const liveSettings = new Set(
  [...settingsSource.matchAll(/label:\s*"([^"\n]+)"/g)].map((match) => match[1]!),
);
const coveredSettings = new Set(
  [...matrix.matchAll(/^\| `SET-\d+` \| ([^|]+?)\s*\|$/gm)].map((match) => match[1]!.trim()),
);
assertSame("Settings panel", liveSettings, coveredSettings);

const scenarioIds = [...matrix.matchAll(/^\| `([A-Z]+-\d+)` \|/gm)].map((match) => match[1]!);
const duplicateIds = [
  ...new Set(scenarioIds.filter((id, index) => scenarioIds.indexOf(id) !== index)),
];
if (duplicateIds.length > 0) {
  throw new Error("duplicate scenario IDs: " + duplicateIds.sort().join(", "));
}

for (const required of ["CMD-24", "CMD-25"]) {
  if (!scenarioIds.includes(required))
    throw new Error("missing dynamic command scenario: " + required);
}

console.log(
  "Static TUI checklist check passed: " +
    liveCommands.size +
    " registered public commands represented, " +
    liveSettings.size +
    " registered Settings panels represented, " +
    scenarioIds.length +
    " unique scenario IDs. No E2E scenarios were executed.",
);
