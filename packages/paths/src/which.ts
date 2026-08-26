import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, resolve } from "node:path";

import { pathsLogger } from "./diag.ts";

/** The extensions Windows treats as executable when `PATHEXT` is unset. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * The names to try for `command` inside one `PATH` directory.
 *
 * @remarks
 * POSIX has exactly one candidate, the name itself. Windows will not execute an
 * extension-less file, so a bare name expands to every `PATHEXT` suffix in
 * order; a name that already carries one of those extensions is used as written
 * rather than becoming `rg.exe.EXE`.
 */
function candidateNames(
  command: string,
  platform: NodeJS.Platform,
  pathext: string | undefined,
): string[] {
  if (platform !== "win32") return [command];
  const exts = (pathext ?? DEFAULT_PATHEXT).split(";").filter(Boolean);
  const own = extname(command);
  if (own !== "" && exts.some((ext) => ext.toLowerCase() === own.toLowerCase())) return [command];
  return exts.map((ext) => `${command}${ext}`);
}

/**
 * Whether `candidate` is a file this platform would actually execute.
 *
 * @remarks
 * POSIX tests the execute bit. Windows has no such bit - `access(X_OK)` is
 * documented to behave as `F_OK` there, so the `PATHEXT` match is the real test
 * and all that remains is to confirm the entry is a regular file. Requiring a
 * regular file also fixes a POSIX-side hazard: a *directory* named like the
 * command satisfies `access(X_OK)` and would otherwise be returned as an
 * executable.
 */
function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform === "win32") return true;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first `PATH` entry holding an executable named `command`.
 *
 * @param command - the bare command name to look up.
 * @param path - the `PATH` value to search; defaults to `process.env.PATH`.
 * @param platform - host platform; injectable so Windows resolution is
 *   contract-testable from a POSIX host.
 * @param pathext - the `PATHEXT` value to expand against on Windows.
 * @returns the absolute path to the executable, or `undefined` when no `PATH`
 *   entry holds one.
 * @remarks
 * A same-named but non-executable file is skipped so the search continues into
 * later `PATH` entries. Every extension is tried within one directory before
 * moving to the next, which is the order the shell itself uses - `dirA/x.CMD`
 * wins over `dirB/x.EXE`.
 */
export function executableOnPath(
  command: string,
  path = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
  pathext = process.env.PATHEXT,
): string | undefined {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of candidateNames(command, platform, pathext)) {
      const candidate = resolve(dir, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

const resolved = new Map<string, string>();

/**
 * Memoized {@link executableOnPath}, falling back to the bare name.
 *
 * @param command - the command to resolve.
 * @returns the resolved absolute path, or `command` unchanged when the lookup
 *   finds nothing - so the OS still gets its own chance and a genuinely missing
 *   binary fails loudly at the spawn rather than silently here.
 * @remarks Resolving once and reusing the answer also keeps a probe and its
 *   later spawn from disagreeing when `PATH` changes between them.
 *
 *   The memo is also what bounds the diagnostic: `paths.command_resolved` is
 *   emitted on the miss only, so a command resolved before every spawn costs
 *   one line for the process rather than one per call.
 */
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
