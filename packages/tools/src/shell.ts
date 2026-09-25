/** The host shell used for coding commands. */
export interface ShellSpec {
  readonly flavor: "posix";
  readonly file: "sh";
}

const HOST_SHELL: ShellSpec = { flavor: "posix", file: "sh" };

/** Resolve the shell used for coding commands. */
export function resolveShell(): ShellSpec {
  return HOST_SHELL;
}

/** Build arguments for a command run through the host shell. */
export function shellArgs(_shell: ShellSpec, command: string): string[] {
  return ["-c", command];
}
