/** A rule verdict before approval policy and host requirements are applied. */
export type RuleDecision = "allow" | "prompt" | "forbidden";

/** A literal argv prefix; each position may have several literal alternatives. */
export type CommandPattern = readonly (string | readonly string[])[];

/** One validated operator or host rule. */
export interface ExecutionRule {
  id: string;
  pattern: CommandPattern;
  decision: RuleDecision;
  justification?: string;
  match?: readonly (readonly string[])[];
  not_match?: readonly (readonly string[])[];
}

/** A source identity remains distinct even when two files reuse the same rule ID. */
export interface RuleSource {
  layer: "global" | "workspace" | "host";
  file: string;
  digest: string;
  rules: readonly ExecutionRule[];
}

/** Versioned on-disk rule document. */
export interface RuleDocument {
  version: 1;
  rules: ExecutionRule[];
}

/** A trusted executable resolution supplied by the eventual host. */
export interface ExecutableIdentity {
  path: string;
  trusted: boolean;
}

/** Resolution must use the same cwd and PATH as execution. */
export type ExecutableResolver = (
  command: string,
  context: { cwd: string; path: string | undefined },
) => ExecutableIdentity | undefined;

/** The source and rule responsible for a match. */
export interface RuleMatch {
  id: string;
  source: string;
  layer: RuleSource["layer"];
  digest: string;
  decision: RuleDecision;
}

/** An independently classified shell segment. */
export interface SegmentEvaluation {
  argv: string[];
  decision: RuleDecision;
  origin: "rule" | "heuristic" | "fallback";
  reason: string;
  matches: RuleMatch[];
}

/** Why the analyzer did not prove a complete segment decomposition. */
export type AnalysisLimit = "none" | "bytes" | "depth" | "syntax";

/** Deterministic result; prompt and forbidden have distinct meanings. */
export interface ExecutionEvaluation {
  decision: RuleDecision;
  reason: string;
  analysis_limit: AnalysisLimit;
  segments: SegmentEvaluation[];
  matches: RuleMatch[];
  all_segments_explicitly_allowed: boolean;
}
