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

/**
 * Reconciles static TUI registrations with scenario table rows, independent of Markdown padding.
 *
 * Returns inventory identities, not execution evidence. Prose mentions are not scenario rows;
 * duplicate rows and missing or stale registrations fail before a count is reported.
 */
export function inspectTuiInventory(input: {
  matrix: string;
  commandSources: readonly string[];
  settingsSource: string;
}): { commands: string[]; settings: string[]; scenarioIds: string[] } {
  const rows = [...input.matrix.matchAll(/^\|\s*`([A-Z]+-\d+)`\s*\|([^\r\n]*)/gm)].map((match) => ({
    id: match[1],
    body: match[2],
  }));
  const scenarioIds = rows.map((row) => row.id);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of scenarioIds) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new Error("duplicate scenario IDs: " + [...duplicates].sort().join(", "));
  }

  for (const required of ["CMD-24", "CMD-25"]) {
    if (!seen.has(required)) throw new Error("missing dynamic command scenario: " + required);
  }

  const liveCommands = new Set(
    input.commandSources.flatMap((source) =>
      [...source.matchAll(/slash:\s*"(\/[^"\n]+)"/g)].map((match) => match[1]),
    ),
  );
  const coveredCommands = new Set(
    rows
      .filter((row) => row.id.startsWith("CMD-"))
      .flatMap((row) =>
        [...row.body.matchAll(/`(\/[^`]+)`/g)].map((match) => match[1].trim().split(/\s+/)[0]),
      ),
  );
  assertSame("public slash command", liveCommands, coveredCommands);

  const liveSettings = new Set(
    [...input.settingsSource.matchAll(/label:\s*"([^"\n]+)"/g)].map((match) => match[1]),
  );
  const coveredSettings = new Set(
    rows.filter((row) => row.id.startsWith("SET-")).map((row) => row.body.split("|")[0].trim()),
  );
  assertSame("Settings panel", liveSettings, coveredSettings);

  return { commands: [...liveCommands].sort(), settings: [...liveSettings].sort(), scenarioIds };
}
