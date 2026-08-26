import { ValidationError } from "@clarvis/capability";
import { deriveRunShape, type RunShape } from "./run-shape.ts";
import type { ParsedRunRequest } from "./request-schema.ts";

export function rejectDuplicateServerNames(data: ParsedRunRequest): void {
  const names = new Set<string>();
  for (const server of data.servers) {
    if (names.has(server.name)) {
      throw new ValidationError(
        "duplicate_server_name",
        `Duplicate server name '${server.name}' in servers[]`,
        { name: server.name },
      );
    }
    names.add(server.name);
  }
}

/**
 * Reject a request whose `profiles[]` reuses a name.
 *
 * @throws {@link ValidationError} (`duplicate_profile_name`) on the first repeat.
 */
export function rejectDuplicateProfileNames(data: ParsedRunRequest): void {
  const names = new Set<string>();
  for (const profile of data.profiles) {
    if (names.has(profile.name)) {
      throw new ValidationError(
        "duplicate_profile_name",
        `Duplicate profile name '${profile.name}' in profiles[]`,
        { name: profile.name },
      );
    }
    names.add(profile.name);
  }
}

/**
 * Resolve the {@link RunShape} for `entry`, requiring it to name a real profile.
 *
 * @returns the derived {@link RunShape} (see {@link deriveRunShape}).
 * @throws {@link ValidationError} (`unknown_profile`) when `entry` is not a
 *   registered profile name.
 */
export function requireEntryShape(data: ParsedRunRequest): RunShape {
  const shape = deriveRunShape(data);
  if (shape === undefined) {
    throw new ValidationError(
      "unknown_profile",
      `entry '${data.entry}' is not a registered profile. Profiles: ${data.profiles.map((p) => p.name).join(", ")}.`,
      { name: data.entry },
    );
  }
  return shape;
}

/**
 * Validate the entry agent's spawn topology: every `can_spawn` name exists and
 * `default_spawn` is within `can_spawn`.
 *
 * @throws {@link ValidationError} (`unknown_profile`) on the first violation.
 */
export function requireKnownSpawnTargets(data: ParsedRunRequest, shape: RunShape): void {
  const profileNames = new Set(data.profiles.map((p) => p.name));
  const { entry } = shape;
  const canSpawn = entry.can_spawn ?? [];
  for (const name of canSpawn) {
    if (!profileNames.has(name)) {
      throw new ValidationError(
        "unknown_profile",
        `entry.can_spawn references unknown profile '${name}'. Profiles: ${[...profileNames].join(", ")}.`,
        { name },
      );
    }
  }
  if (entry.default_spawn !== undefined && !canSpawn.includes(entry.default_spawn)) {
    throw new ValidationError(
      "unknown_profile",
      `entry.default_spawn '${entry.default_spawn}' must be one of can_spawn: ${canSpawn.join(", ") || "(none)"}.`,
      { name: entry.default_spawn },
    );
  }
}

/**
 * Enforce the `budget.on_exceed`-conditional requirements.
 *
 * @remarks For `stop`: `total_token_limit` and an `iteration_limit` on every
 *   running agent are required, and `max_escalations` is forbidden. For
 *   `escalate`: the entry must carry some escalatable bound (a token limit or its
 *   own iteration_limit).
 * @throws {@link ValidationError} (`invalid_token_limit`,
 *   `invalid_iteration_limit`, or `invalid_budget_mode`) on the first violation.
 */
