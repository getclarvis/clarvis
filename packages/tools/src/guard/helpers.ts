import type {
  GuardContext,
  GuardRiskFinding,
  GuardRiskOperandUncertainty,
  ShellFacts,
} from "./types.ts";

const DYNAMIC_OPERAND = /[$`*?{}]|\$\(/;
const POWERSHELL_FORCE = /^-F(?:o(?:r(?:ce?)?)?)?$/i;
const POWERSHELL_RECURSIVE = /^-R(?:e(?:c(?:u(?:r(?:se?)?)?)?)?)?$/i;

function commandName(normalized: string): string {
  const head = normalized.split(" ", 1)[0] ?? "";
  const base = head.replaceAll("\\", "/").split("/").pop() ?? head;
  return base.replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

function posixForce(arg: string): boolean {
  return arg === "--force" || /^-[^-]*f[^-]*$/.test(arg);
}

function posixRecursive(arg: string): boolean {
  return arg === "--recursive" || /^-[^-]*[rR][^-]*$/.test(arg);
}

function optionEnd(arg: string): boolean {
  return arg === "--" || arg === "--%";
}

function operandUncertainty(
  operands: string[],
  issues: ShellFacts["analysisIssues"],
): GuardRiskOperandUncertainty {
  if (operands.length === 0) return "unparsed";
  if (
    operands.some((operand) => DYNAMIC_OPERAND.test(operand)) ||
    issues.some(
      (issue) =>
        issue.impact === "path" ||
        issue.kind === "parameter_expansion" ||
        issue.kind === "command_substitution" ||
        issue.kind === "process_substitution" ||
        issue.kind === "opaque_path" ||
        issue.kind === "dynamic_path",
    )
  )
    return "dynamic";
  return "none";
}

function forcedRemovalFinding(
  segmentIndex: number,
  argv: readonly string[],
  issues: ShellFacts["analysisIssues"],
  force: (arg: string) => boolean,
  recursive: (arg: string) => boolean,
): GuardRiskFinding | undefined {
  const options: string[] = [];
  const operands: string[] = [];
  let end = false;
  for (const arg of argv.slice(1)) {
    if (end) {
      operands.push(arg);
      continue;
    }
    if (optionEnd(arg)) {
      end = true;
      continue;
    }
    if (arg.startsWith("-")) options.push(arg);
    else operands.push(arg);
  }
  if (!options.some(force)) return undefined;
  const segmentIssues = issues.filter((issue) => issue.segmentIndex === segmentIndex);
  return {
    segmentIndex,
    kind: "forced_removal",
    recursive: options.some(recursive),
    operands,
    operand_uncertainty: operandUncertainty(operands, segmentIssues),
  };
}

/**
 * Identify narrow high-risk command forms in already-normalized argv.
 *
 * Reports forced `rm`/`Remove-Item` and `sudo` per segment. Only options before
 * `--` or `--%` count; long options merely containing `f` do not. This is a
 * review fact, not a complete danger detector or an approval policy.
 */
export function commandRiskFindings(shell: ShellFacts): GuardRiskFinding[] {
  const findings: GuardRiskFinding[] = [];
  for (const [segmentIndex, segment] of shell.segments.entries()) {
    const name = commandName(segment.normalized);
    if (name.toLowerCase() === "sudo") {
      findings.push({ segmentIndex, kind: "privilege_elevation" });
      continue;
    }
    const removal =
      name === "rm" || name === "Remove-Item"
        ? forcedRemovalFinding(
            segmentIndex,
            segment.argv,
            segment.analysisIssues,
            name === "Remove-Item" ? (arg) => POWERSHELL_FORCE.test(arg) : posixForce,
            name === "Remove-Item" ? (arg) => POWERSHELL_RECURSIVE.test(arg) : posixRecursive,
          )
        : undefined;
    if (removal !== undefined) findings.push(removal);
  }
  return findings;
}

/**
 * Whether any segment is a forced removal or privilege elevation.
 *
 * @remarks Derived from {@link commandRiskFindings}. Presence is not a human-only
 *   policy: Kernel decides which findings restrict the answering channel.
 */
export function isDangerousCommand(shell: ShellFacts): boolean {
  return commandRiskFindings(shell).length > 0;
}

/**
 * Whether every path the call touches is provably inside the workspace.
 *
 * @param ctx - the guard context to inspect.
 * @returns `true` only when the analysis is decidable, at least one path was
 *   resolved, and all resolved paths sit within the workspace root.
 * @remarks
 * Conservative on purpose: an {@link ShellFacts.undecidable | undecidable}
 * command or a call with no resolved paths returns `false`, so a guard built on
 * this never grants a blanket allow to something it could not fully analyze.
 */
export function withinWorkspace(ctx: GuardContext): boolean {
  if (ctx.shell?.undecidable) return false;
  if (ctx.paths.length === 0) return false;
  return ctx.paths.every((p) => p.withinWorkspace);
}

/**
 * Whether any path the call touches resolves outside the workspace.
 *
 * @param ctx - the guard context to inspect.
 * @returns `true` if at least one resolved path escapes the workspace root.
 * @remarks Not the negation of {@link withinWorkspace}: a call with no paths
 *   (or one that is undecidable) is neither fully inside nor touching outside,
 *   so both predicates return `false`.
 */
export function touchesOutside(ctx: GuardContext): boolean {
  return ctx.paths.some((p) => !p.withinWorkspace);
}
