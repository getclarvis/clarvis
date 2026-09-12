import { basename } from "node:path";
import { ToolError } from "../errors.ts";
import { analyzeShell } from "../guard/analyze-shell.ts";
import { currentDialect } from "../guard/dialects/index.ts";
import type { ShellDialect } from "../guard/dialect.ts";

const GIT_EXECUTION_OPTIONS = ["--upload-pack", "--receive-pack", "--exec"];

function isGitExecutionOption(argument: string): boolean {
  const name = argument.split("=", 1)[0] ?? argument;
  return name.length >= 3 && GIT_EXECUTION_OPTIONS.some((option) => option.startsWith(name));
}

function executableName(program: string): string {
  return basename(program)
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

/**
 * Refuse secret-token and hidden Git-helper invocations on model command tools.
 */
function denySensitiveArgv(program: string, args: readonly string[]): void {
  const executable = executableName(program);
  const command = args[0];
  if (executable === "git" && command === "credential") {
    throw new ToolError("denied", "git credential output is unavailable to model tools");
  }
  if (executable === "gh" && command === "auth" && args[1] === "token") {
    throw new ToolError("denied", "gh auth token output is unavailable to model tools");
  }
  if (
    executable === "git" &&
    args.slice(1).some((arg) => isGitExecutionOption(arg) || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(arg))
  ) {
    throw new ToolError("denied", "git argument can execute a host program and is unavailable");
  }
}

/**
 * Apply {@link denySensitiveArgv} to each analyzed segment of a shell command.
 */
export function denySensitiveShellCommand(
  command: string,
  dialect: ShellDialect = currentDialect(),
): void {
  const facts = analyzeShell(command, dialect);
  for (const segment of facts.segments) {
    const program = segment.argv[0];
    if (program === undefined) continue;
    denySensitiveArgv(program, segment.argv.slice(1));
  }
}
