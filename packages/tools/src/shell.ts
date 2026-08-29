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
 * There is deliberately no configuration surface. A configurable shell plus a
 * configurable analyzer flavor makes "analyze one dialect, run another"
 * expressible, and that state produces no error and no failing test - the guard
 * simply stops seeing what it is ruling on. `cmd.exe` is likewise unsupported:
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

/**
 * Wrap `command` so its exit status lands in the file named by `$MON_EXIT`.
 *
 * @param command - the raw command text to wrap.
 * @param flavor - the syntax to emit the wrapper in.
 * @returns the wrapped command.
 * @remarks
 * POSIX installs an `EXIT` trap. PowerShell uses `try`/`finally`, which is safe
 * in the two ways that matter: `exit N` inside a `try` still runs the `finally`
 * before terminating, and a `try` block is not a new variable scope, so wrapping
 * does not change what the command itself means.
 *
 * `$?` is read first, and tested *before* `$LASTEXITCODE`. `$LASTEXITCODE` is
 * sticky for the whole payload - once any native command has run it stays set -
 * so testing it first would make `git status; Write-Output ok` report git's
 * status rather than the payload's. The consequence of this ordering is that a
 * pure-cmdlet command reports only `0` or `1`, because PowerShell gives cmdlet
 * failures no richer status; native commands keep their real exit codes.
 *
 * Both wrappers write to a `.tmp` sibling and rename it onto `$MON_EXIT`, rather
 * than writing the exit file in place: a plain `>`/`WriteAllText` truncates the
 * destination before it writes the content, so a poller reading exactly then
 * would see the file exist with no parseable code yet - a race that made
 * `readExitState` misreport a still-live process as exited with an unknown
 * code. A same-directory rename is atomic on both platforms, so a reader only
 * ever observes the file absent or fully written.
 *
 * Neither wrapper survives a *parse* error in `command` (nothing runs at all) or
 * a forced kill. Both then leave no exit file, which the monitor already reports
 * as an unknown exit code.
 */
export function exitCaptureWrapper(command: string, flavor: ShellFlavor): string {
  if (flavor === "posix") {
    return (
      `trap 'printf "%s" "$?" > "$MON_EXIT.tmp" && mv -f "$MON_EXIT.tmp" "$MON_EXIT"' EXIT\n` +
      `${command}\n`
    );
  }
  return [
    "try {",
    command,
    "} finally {",
    "$__clarvisExit = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }",
    '$__clarvisExitTmp = "$env:MON_EXIT.tmp"',
    '[IO.File]::WriteAllText($__clarvisExitTmp, "$__clarvisExit", ' +
      "(New-Object System.Text.UTF8Encoding $false))",
    "Move-Item -Force $__clarvisExitTmp $env:MON_EXIT",
    "}",
    "",
  ].join("\n");
}

export { currentShellFlavor };
export type { ShellFlavor };
