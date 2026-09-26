import { createHash } from "node:crypto";
import { analyzeShell } from "./shell-analysis.ts";
import { isDangerousArgv, isDangerousShell } from "./heuristics.ts";
import { canRequestApproval, type ApprovalPolicy } from "./approval-policy.ts";
import type {
  CommandPattern,
  ExecutionEvaluation,
  ExecutionRule,
  ExecutableResolver,
  RuleDecision,
  RuleDocument,
  RuleMatch,
  RuleSource,
  SegmentEvaluation,
} from "./types.ts";

const rank: Record<RuleDecision, number> = { allow: 0, prompt: 1, forbidden: 2 };

/** Validate a versioned rule file before it is evaluated or persisted. */
export function parseRuleDocument(value: unknown): RuleDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("rule document must be an object");
  const doc = value as Record<string, unknown>;
  if (
    doc.version !== 1 ||
    !Array.isArray(doc.rules) ||
    Object.keys(doc).some((key) => key !== "version" && key !== "rules")
  ) {
    throw new Error("rule document version or fields are invalid");
  }
  const ids = new Set<string>();
  const rules = doc.rules.map((raw: unknown) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Error("rule must be an object");
    const rule = raw as Record<string, unknown>;
    if (
      typeof rule.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(rule.id) ||
      ids.has(rule.id)
    )
      throw new Error("rule id is invalid or duplicated");
    ids.add(rule.id);
    if (
      !Array.isArray(rule.pattern) ||
      rule.pattern.length === 0 ||
      rule.pattern.some((part: unknown, index: number) =>
        typeof part === "string"
          ? index === 0 && part.length === 0
          : !Array.isArray(part) ||
            part.length === 0 ||
            part.some(
              (choice: unknown) =>
                typeof choice !== "string" || (index === 0 && choice.length === 0),
            ),
      )
    ) {
      throw new Error(`rule ${rule.id}: invalid argv prefix`);
    }
    if (rule.decision !== "allow" && rule.decision !== "prompt" && rule.decision !== "forbidden")
      throw new Error(`rule ${rule.id}: invalid decision`);
    if (
      Object.keys(rule).some(
        (key) =>
          !["id", "pattern", "decision", "justification", "match", "not_match"].includes(key),
      )
    )
      throw new Error(`rule ${rule.id}: unknown field`);
    if (rule.justification !== undefined && typeof rule.justification !== "string")
      throw new Error(`rule ${rule.id}: invalid justification`);
    for (const key of ["match", "not_match"] as const) {
      const examples = rule[key];
      if (
        examples !== undefined &&
        (!Array.isArray(examples) ||
          examples.some(
            (example: unknown) =>
              !Array.isArray(example) || example.some((arg: unknown) => typeof arg !== "string"),
          ))
      )
        throw new Error(`rule ${rule.id}: invalid ${key}`);
    }
    const parsed = rule as unknown as ExecutionRule;
    for (const example of parsed.match ?? [])
      if (!prefixMatches(parsed.pattern, example))
        throw new Error(`rule ${rule.id}: match example does not match`);
    for (const example of parsed.not_match ?? [])
      if (prefixMatches(parsed.pattern, example))
        throw new Error(`rule ${rule.id}: not_match example matches`);
    return parsed;
  });
  return { version: 1, rules };
}

/** Hash exact source bytes so rule identities change with their file. */
export function ruleDigest(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Reject broad prefix suggestions when an operator chooses to remember an allow. */
export function canSuggestRememberedAllow(pattern: CommandPattern): boolean {
  const head = pattern[0];
  if (pattern.length < 2 || typeof head !== "string") return false;
  const executable = head.split("/").at(-1) ?? "";
  if (
    ["sh", "bash", "zsh", "env", "sudo", "node", "nodejs", "bun"].includes(executable) ||
    /^python(?:\d+(?:\.\d+)?)?$/.test(executable)
  )
    return false;
  if (executable === "rm") return false;
  return true;
}

function prefixMatches(pattern: CommandPattern, argv: readonly string[]): boolean {
  return (
    pattern.length <= argv.length &&
    pattern.every((part, index) =>
      typeof part === "string" ? part === argv[index] : part.includes(argv[index]!),
    )
  );
}

function matchesRule(
  rule: ExecutionRule,
  argv: readonly string[],
  resolver: ExecutableResolver | undefined,
  cwd: string,
  path: string | undefined,
): boolean {
  const resolved = resolver?.(argv[0] ?? "", { cwd, path });
  if (prefixMatches(rule.pattern, argv)) {
    return rule.decision !== "allow" || resolver === undefined || resolved?.trusted === true;
  }
  const first = rule.pattern[0];
  if (typeof first !== "string" || !first.includes("/") || resolver === undefined) return false;
  return (
    resolved?.trusted === true && prefixMatches(rule.pattern, [resolved.path, ...argv.slice(1)])
  );
}

/** Evaluate one shell action without performing it or selecting its reviewer. */
export function evaluateCommand(options: {
  command: string;
  sources?: readonly RuleSource[];
  approval_policy: ApprovalPolicy;
  backend_available: boolean;
  restricted: boolean;
  override_requested?: boolean;
  host_disables_allows?: boolean;
  cwd: string;
  path?: string;
  resolve_executable?: ExecutableResolver;
}): ExecutionEvaluation {
  const analysis = analyzeShell(options.command);
  const allArgv = analysis.limit === "none" ? analysis.segments : [["sh", "-c", options.command]];
  const segments: SegmentEvaluation[] = allArgv.map((argv) => {
    const matches: RuleMatch[] = [];
    for (const source of options.sources ?? [])
      for (const rule of source.rules) {
        if (matchesRule(rule, argv, options.resolve_executable, options.cwd, options.path)) {
          matches.push({
            id: rule.id,
            source: source.file,
            layer: source.layer,
            digest: source.digest,
            decision: rule.decision,
          });
        }
      }
    const strongest = matches.reduce<RuleDecision | undefined>(
      (result, match) =>
        result === undefined || rank[match.decision] > rank[result] ? match.decision : result,
      undefined,
    );
    const explicit =
      strongest === "allow" && options.host_disables_allows === true ? undefined : strongest;
    const dangerous =
      analysis.limit === "none" ? isDangerousArgv(argv) : isDangerousShell(options.command);
    let decision: RuleDecision;
    let origin: SegmentEvaluation["origin"];
    let reason: string;
    if (explicit !== undefined) {
      decision = explicit;
      origin = "rule";
      reason = `rule_${explicit}`;
    } else if (dangerous) {
      decision = "prompt";
      origin = "heuristic";
      reason = "forced_rm";
    } else {
      decision =
        options.approval_policy === "untrusted" && options.backend_available ? "prompt" : "allow";
      origin = "fallback";
      reason = decision === "prompt" ? "untrusted" : "ordinary_command";
    }
    return { argv, decision, origin, reason, matches };
  });
  const winning = segments.reduce<SegmentEvaluation>(
    (current, segment) => (rank[segment.decision] > rank[current.decision] ? segment : current),
    segments[0]!,
  );
  let decision = winning.decision;
  let reason = winning.reason;
  if (decision !== "forbidden" && options.override_requested && options.restricted) {
    decision = "prompt";
    reason = "sandbox_override";
  }
  if (decision === "prompt") {
    const category = reason.startsWith("rule_") ? "rules" : "sandbox_approval";
    if (!canRequestApproval(options.approval_policy, category)) {
      decision = "forbidden";
      reason = `approval_disabled_${category}`;
    }
  }
  if (decision === "prompt" && options.approval_policy === "never") {
    decision = "forbidden";
    reason = "approval_disabled_sandbox_approval";
  }
  if (decision === "forbidden" && winning.decision !== "forbidden" && reason === "sandbox_override")
    reason = "approval_disabled_sandbox_approval";
  return {
    decision,
    reason,
    analysis_limit: analysis.limit,
    segments,
    matches: segments.flatMap((segment) => segment.matches),
    all_segments_explicitly_allowed:
      decision === "allow" &&
      analysis.limit === "none" &&
      segments.every((segment) => segment.origin === "rule" && segment.decision === "allow"),
  };
}
