import { dangerCandidates } from "./shell-analysis.ts";

/** Initial POSIX danger signal: forced rm of at least one path. */
export function isDangerousArgv(argv: readonly string[], depth = 0): boolean {
  if (depth >= 8 || argv.length === 0) return false;
  const base = argv[0]?.split("/").at(-1);
  if (base === "env") {
    let index = 1;
    while (index < argv.length) {
      const part = argv[index];
      if (part === "-u" || part === "--unset") {
        index += 2;
      } else if (
        part?.includes("=") ||
        part === "--" ||
        part === "-i" ||
        part?.startsWith("--unset=")
      ) {
        index++;
      } else {
        break;
      }
    }
    return isDangerousArgv(argv.slice(index), depth + 1);
  }
  if (base === "sudo") {
    let index = 1;
    while (argv[index]?.startsWith("-")) {
      const option = argv[index++];
      if (
        [
          "-u",
          "-g",
          "-h",
          "-p",
          "-C",
          "-r",
          "-t",
          "--user",
          "--group",
          "--host",
          "--prompt",
        ].includes(option ?? "")
      )
        index++;
    }
    return isDangerousArgv(argv.slice(index), depth + 1);
  }
  if (base === "trap") return argv.slice(1).some((part) => isDangerousShell(part, depth + 1));
  if (
    (base === "sh" || base === "bash" || base === "zsh") &&
    (argv[1] === "-c" || argv[1] === "-lc") &&
    argv[2] !== undefined
  ) {
    return isDangerousShell(argv[2], depth + 1);
  }
  if (base !== "rm") return false;
  let force = false;
  let path = false;
  let operands = false;
  for (const arg of argv.slice(1)) {
    if (!operands && arg === "--") {
      operands = true;
    } else if (!operands && arg === "--force") {
      force = true;
    } else if (!operands && /^-[^-]/.test(arg)) {
      if (arg.slice(1).includes("f")) force = true;
    } else {
      path = true;
    }
  }
  return force && path;
}

/** A permissive risk extractor cannot grant explicit allow. */
export function isDangerousShell(command: string, depth = 0): boolean {
  if (depth >= 8) return false;
  return dangerCandidates(command).some((argv) => isDangerousArgv(argv, depth + 1));
}
