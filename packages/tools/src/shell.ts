import { currentShellFlavor, type ShellFlavor } from "./lib/platform.ts";
import { executableOnPath } from "@clarvis/paths";

/** The resolved host shell: what to spawn, and which syntax it speaks. */
export interface ShellSpec {
  readonly flavor: ShellFlavor;
  /** The executable to spawn: `sh`, an absolute `pwsh.exe`, or the 5.1 path. */
  readonly file: string;
}

/**
 * Injectable seams for {@link resolveShell}, so both Windows branches are
 * exercisable from a POSIX host.
 */
export interface ShellDeps {
  platform?: NodeJS.Platform;
  /** Executable lookup; defaults to {@link executableOnPath}. */
  lookup?: (command: string) => string | undefined;
  /** `%SystemRoot%`; defaults to the environment, then `C:\Windows`. */
  systemRoot?: string;
}

/**
 * Windows PowerShell 5.1's location beneath `%SystemRoot%`.
 *
 * @remarks An operating-system component: present on every Windows 10 (1607+),
 *   11 and Server 2016+ install, neither user-installable nor user-removable.
 *   Looked up by absolute path rather than through `PATH`, which is the more
 *   robust of the two.
 */
const WINDOWS_POWERSHELL_TAIL = "System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * Force UTF-8 on both directions of the native-command boundary, without a BOM.
 *
 * @remarks
 * `pwsh` 7 is UTF-8 already, but `powershell.exe` 5.1 uses the machine's
 * OEM/ANSI codepage, so non-ASCII output arrives as mojibake against the `utf8`
 * stream encoding the command tools set. `[Console]::OutputEncoding` governs
 * both how native output is decoded and how redirected stdout is written;
 * `$OutputEncoding` governs text piped into a native command's stdin.
 *
 * The encoder is constructed explicitly rather than taken from
 * `[Text.Encoding]::UTF8`, which is a `UTF8Encoding(true)` and would prepend a
 * byte-order mark to stdout - breaking every assertion on exact output.
 */
const POWERSHELL_PREAMBLE =
  "$OutputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false";

let cachedShell: ShellSpec | undefined;

function computeShell(deps: ShellDeps): ShellSpec {
  const flavor = currentShellFlavor(deps.platform ?? process.platform);
  if (flavor === "posix") return { flavor, file: "sh" };
  const lookup =
    deps.lookup ?? ((command) => executableOnPath(command, process.env.PATH, "win32", ".EXE"));
  const pwsh = lookup("pwsh");
  if (pwsh !== undefined) return { flavor, file: pwsh };
  const systemRoot = deps.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  return { flavor, file: `${systemRoot}\\${WINDOWS_POWERSHELL_TAIL}` };
}

/**
 * The shell this host runs commands through, derived from `process.platform`.
 *
 * @param deps - test seams. When omitted the result is memoized process-wide,
 *   exactly as the native sandbox probe memoizes its own; an injected call is never
 *   cached and never poisons the cache.
 * @returns the executable to spawn and the syntax it speaks.
 * @remarks
 * PowerShell 7's `pwsh.exe` is preferred when present - faster start, UTF-8 by
 * default - and only `.EXE` is considered, because a `pwsh.cmd` shim could not
 * be spawned directly.
 *
 * There is deliberately no configuration surface. `cmd.exe` is unsupported:
 * it has no `-EncodedCommand` equivalent, so every command would have to survive
 * its non-composable quoting, and it offers no dependable exit status across a
 * chained command.
 */
export function resolveShell(deps?: ShellDeps): ShellSpec {
  if (deps === undefined) return (cachedShell ??= computeShell({}));
  return computeShell(deps);
}

/**
 * The base64 UTF-16LE payload for PowerShell's `-EncodedCommand`, carrying the
 * UTF-8 preamble ahead of the command.
 *
 * @param command - the raw command text.
 * @returns the encoded payload.
 * @remarks
 * Because the whole payload is base64, no character of the command is seen by
 * the Windows command-line tokenizer: quoting, escaping and metacharacter
 * mangling stop being a category of bug rather than being handled carefully.
 * `ExecutionPolicy` does not apply - it governs `.ps1` script files, not
 * commands supplied through `-Command` or `-EncodedCommand`.
 */
export function encodePowerShellCommand(command: string): string {
  return Buffer.from(`${POWERSHELL_PREAMBLE}\n${command}`, "utf16le").toString("base64");
}

/**
 * The argv, after the executable, that runs `command` under `shell`.
 *
 * @param shell - the resolved host shell.
 * @param command - the raw command text.
 * @returns the arguments to pass to {@link ShellSpec.file}.
 * @remarks
 * `-NoProfile` keeps a user's profile script from changing what a command means,
 * and `-NonInteractive` makes a prompt an error rather than a hang. Neither
 * `-ExecutionPolicy Bypass` nor `$ErrorActionPreference = 'Stop'` is set: the
 * first would widen what runs beyond the machine's own policy for any `.ps1` the
 * payload invokes, and the second would abort a payload on a non-terminating
 * error, diverging from `sh -c` where only the last command's status matters.
 */
export function shellArgs(shell: ShellSpec, command: string): string[] {
  if (shell.flavor === "posix") return ["-c", command];
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(command)];
}

export { currentShellFlavor };
export type { ShellFlavor };
