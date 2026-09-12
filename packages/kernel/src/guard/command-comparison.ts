import { resolve } from "node:path";
import {
  analyzeShell,
  currentDialect,
  posixDialect,
  resolveCandidate,
  type GuardContext,
  type PathFact,
} from "@clarvis/tools/guard";

/** Comparison-only POSIX directory handling; original normalized session keys remain untouched. */
export interface CommandComparison {
  paths: PathFact[];
  commands: Array<string | undefined>;
}

/** Only a straight `&&` chain has an unambiguous directory for the next segment. */
function sequential(ctx: GuardContext): boolean {
  if (typeof ctx.args.command !== "string" || ctx.shell === undefined) return false;
  let rest = ctx.args.command.trim();
  for (const [index, segment] of ctx.shell.segments.entries()) {
    if (index > 0) {
      if (!rest.startsWith("&&")) return false;
      rest = rest.slice(2).trimStart();
    }
    if (!rest.startsWith(segment.command)) return false;
    rest = rest.slice(segment.command.length).trimStart();
  }
  return rest.length === 0;
}

/**
 * Resolve literal `cd` and Git `-C` operands against the call's directory, using the tools path
 * boundary. Unsupported control flow retains ordinary matching rather than guessing its cwd.
 * Extra path facts participate in denial even when a bare directory was missed by the analyzer.
 */
export function commandComparison(ctx: GuardContext): CommandComparison {
  const paths = [...ctx.paths];
  const commands: Array<string | undefined> =
    ctx.shell?.segments.map((segment) =>
      segment.argv.length === 0 && segment.envAssignments.length > 0
        ? undefined
        : segment.normalized,
    ) ?? [];
  if (ctx.shell === undefined || currentDialect().flavor !== "posix" || !sequential(ctx)) {
    return { paths, commands };
  }
  const root = ctx.config.workspaceRoot;
  let cwd = typeof ctx.args.cwd === "string" ? resolve(root, ctx.args.cwd) : root;
  const pathAt = (raw: string, base: string): PathFact => ({
    ...resolveCandidate(raw.startsWith("~") ? raw : resolve(base, raw), root, { shell: true }),
    raw,
  });
  for (const [index, segment] of ctx.shell.segments.entries()) {
    if (cwd !== root) {
      paths.push(
        ...analyzeShell(segment.command, posixDialect).paths.map((raw) => pathAt(raw, cwd)),
      );
    }
    if (segment.argv.length === 0 && segment.envAssignments.length > 0) {
      commands[index] = undefined;
      continue;
    }
    const [head, operand] = segment.argv;
    if (
      head === "cd" &&
      segment.argv.length === 2 &&
      operand !== undefined &&
      !operand.startsWith("-") &&
      !/[$*?[\]{}]/.test(operand)
    ) {
      const path = pathAt(operand, cwd);
      paths.push(path);
      if (path.withinWorkspace && segment.decidable && segment.envAssignments.length === 0) {
        commands[index] = undefined;
        cwd = path.resolved;
      }
    } else if (head === "git") {
      let at = 1;
      let gitCwd = cwd;
      while (segment.argv[at] === "-C" && segment.argv[at + 1] !== undefined) {
        const raw = segment.argv.at(at + 1)!;
        if (/[$*?[\]{}]/.test(raw)) break;
        const path = pathAt(raw, gitCwd);
        paths.push(path);
        if (!path.withinWorkspace) break;
        gitCwd = path.resolved;
        at += 2;
      }
      if (at > 1) commands[index] = [head, ...segment.argv.slice(at)].join(" ");
    }
  }
  return { paths, commands };
}
