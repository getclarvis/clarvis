export { analyzeShell, dangerCandidates } from "./shell-analysis.ts";
export { isDangerousArgv, isDangerousShell } from "./heuristics.ts";
export {
  parseApprovalPolicy,
  canRequestApproval,
  type ApprovalPolicy,
  type ApprovalCategory,
} from "./approval-policy.ts";
export {
  parseRuleDocument,
  ruleDigest,
  canSuggestRememberedAllow,
  evaluateCommand,
} from "./policy.ts";
export type {
  RuleDecision,
  CommandPattern,
  ExecutionRule,
  RuleSource,
  RuleDocument,
  ExecutableIdentity,
  ExecutableResolver,
  RuleMatch,
  SegmentEvaluation,
  AnalysisLimit,
  ExecutionEvaluation,
} from "./types.ts";
