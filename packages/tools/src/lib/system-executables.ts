/** System-owned executable roots on POSIX hosts. */
const POSIX_SYSTEM_EXECUTABLE_ROOTS = ["/usr", "/bin", "/sbin", "/usr/local"];

/**
 * The prefixes below which an executable belongs to the platform rather than to
 * a version manager.
 *
 * @param platform - Host platform; injectable so Windows roots are testable
 *   from a POSIX host.
 * @returns The system executable roots for that platform.
 * @remarks Windows keeps its standard program roots because tools such as
 *   `dotnet.exe` live directly below them rather than beneath a POSIX-style
 *   `<root>/bin` directory.
 */
export function systemExecutableRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "win32") return POSIX_SYSTEM_EXECUTABLE_ROOTS;
  return [
    process.env.SystemRoot ?? "C:\\Windows",
    process.env.ProgramFiles ?? "C:\\Program Files",
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  ];
}
