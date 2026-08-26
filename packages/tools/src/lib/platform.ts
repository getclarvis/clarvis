/**
 * Which shell syntax a host speaks.
 *
 * @remarks
 * This selects two things at once: the transport the executor invokes a command
 * through, and the dialect the guard's analyzer parses it with. They must never
 * disagree - a guard that analyzes POSIX while PowerShell runs produces no error
 * and no failing test, it just decides wrong. Both therefore derive from a
 * single {@link currentShellFlavor} call rather than reading the platform
 * independently.
 */
export type ShellFlavor = "posix" | "powershell";

/**
 * The shell flavor this host speaks, derived from the platform.
 *
 * @param platform - the host platform; injectable so both branches are testable
 *   from either host. Defaults to `process.platform`.
 * @returns `"powershell"` on Windows, `"posix"` everywhere else.
 * @remarks
 * Deliberately not configurable. A `shell` setting plus an analyzer `flavor`
 * setting would make "analyze one dialect, run another" expressible; deriving
 * both from one function makes that state unrepresentable rather than merely
 * discouraged. Windows PowerShell 5.1 is an operating-system component present
 * on every Windows 10 (1607+), 11 and Server 2016+ install, so assuming it is
 * there costs the user no installation.
 */
export function currentShellFlavor(platform: NodeJS.Platform = process.platform): ShellFlavor {
  return platform === "win32" ? "powershell" : "posix";
}
