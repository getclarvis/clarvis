import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

import { pathsLogger } from "./diag.ts";

/** Whether a path names a regular executable file. */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find the first executable with this name in PATH. */
export function executableOnPath(command: string, path = process.env.PATH): string | undefined {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = resolve(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

const resolved = new Map<string, string>();

/** Resolve a command once, leaving an unknown name for the OS to reject at spawn. */
export function resolveCommand(command: string): string {
  let hit = resolved.get(command);
  if (hit === undefined) {
    hit = executableOnPath(command) ?? command;
    resolved.set(command, hit);
    pathsLogger().debug(
      { event: "paths.command_resolved", command, resolved: hit, found: hit !== command },
      "resolved a command against PATH; an unfound command is left for the OS to reject at spawn",
    );
  }
  return hit;
}
