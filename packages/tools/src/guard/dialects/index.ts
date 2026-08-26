import { currentShellFlavor, type ShellFlavor } from "../../lib/platform.ts";
import type { ShellDialect } from "../dialect.ts";
import { posixDialect } from "./posix.ts";
import { powershellDialect } from "./powershell.ts";

/**
 * The dialect that parses a given shell syntax.
 *
 * @param flavor - the syntax to parse.
 * @returns the matching {@link ShellDialect}.
 */
export function dialectFor(flavor: ShellFlavor): ShellDialect {
  return flavor === "powershell" ? powershellDialect : posixDialect;
}

/**
 * The dialect matching the shell this host actually runs commands through.
 *
 * @param platform - the host platform; injectable so either dialect is testable
 *   from either host. Defaults to `process.platform`.
 * @returns the {@link ShellDialect} for this host.
 * @remarks
 * Both this and the executor's shell resolution derive from the same
 * {@link currentShellFlavor} call. That is what makes "analyze one dialect, run
 * another" unrepresentable rather than merely discouraged - a state that would
 * produce no error and no failing test, just a guard ruling on a language
 * nobody is running.
 */
export function currentDialect(platform?: NodeJS.Platform): ShellDialect {
  return dialectFor(currentShellFlavor(platform));
}

export { posixDialect, powershellDialect };
