import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectTuiInventory } from "../../../../tooling/lib/tui-inventory.ts";

const repo = resolve(process.argv[2] ?? process.cwd());
const [matrix, settingsSource, ...commandSources] = await Promise.all(
  [
    ".agents/skills/clarvis-tui-validation/references/coverage-matrix.md",
    "packages/code/src/views/config/hub-items.ts",
    "packages/code/src/app/commands.tsx",
    "packages/code/src/keys/commands.ts",
    "packages/code/src/views/App.tsx",
  ].map((path) => readFile(resolve(repo, path), "utf8")),
);
const inventory = inspectTuiInventory({
  matrix: matrix!,
  settingsSource: settingsSource!,
  commandSources,
});

console.log(
  `Static TUI checklist check passed: ${inventory.commands.length} registered public commands represented, ` +
    `${inventory.settings.length} registered Settings panels represented, ` +
    `${inventory.scenarioIds.length} unique scenario IDs. No E2E scenarios were executed.`,
);
