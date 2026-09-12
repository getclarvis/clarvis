/**
 * Public surface of the command-approval guard: the decision vocabulary
 * ({@link Verdict}, {@link GuardDecision}), the analyzed facts a policy reasons
 * over ({@link GuardContext}, {@link ShellFacts}, {@link PathFact}, {@link Segment}),
 * the elicitation ports ({@link Guard}, {@link Elicit}, {@link ElicitRequest}),
 * the {@link analyzeShell} command analyzer and the {@link ShellDialect} front
 * ends it parses with, the {@link buildGuardContext} assembler, and the
 * {@link withinWorkspace}/{@link touchesOutside} predicates.
 */
export type {
  Verdict,
  GuardDecision,
  GuardPlacement,
  GuardCallFacts,
  GuardAnswerer,
  GuardElicitAnswer,
  GuardReview,
  Segment,
  ShellFacts,
  PathFact,
  GuardContext,
  Guard,
  ElicitRequest,
  Elicit,
} from "./types.ts";
export type { ShellDialect, Token, PathCandidate } from "./dialect.ts";
export { analyzeShell } from "./analyze-shell.ts";
export { posixDialect, powershellDialect, dialectFor, currentDialect } from "./dialects/index.ts";
export { POSIX_DEFAULT_ALLOWED_COMMANDS } from "./dialects/posix.ts";
export { WINDOWS_DEFAULT_ALLOWED_COMMANDS } from "./dialects/powershell.ts";
export { buildGuardContext } from "./context.ts";
export { resolveCandidate } from "./paths.ts";
export { withinWorkspace, touchesOutside, isDangerousCommand } from "./helpers.ts";
