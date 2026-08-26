import {
  POSIX_DEFAULT_ALLOWED_COMMANDS,
  WINDOWS_DEFAULT_ALLOWED_COMMANDS,
} from "@clarvis/kernel/local";

/** Return the command-review allowlist Code seeds for the selected platform. */
export function defaultAllowedCommands(platform: NodeJS.Platform): string[] {
  return [
    ...(platform === "win32" ? WINDOWS_DEFAULT_ALLOWED_COMMANDS : POSIX_DEFAULT_ALLOWED_COMMANDS),
  ];
}
