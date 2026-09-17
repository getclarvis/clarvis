import type { ElicitRequest } from "@clarvis/loop";

/** Split one preserved POSIX assignment without losing equals signs in its value. */
function environmentFact(assignment: string): { name: string; value: string; assignment: string } {
  const separator = assignment.indexOf("=");
  return {
    name: separator < 0 ? assignment : assignment.slice(0, separator),
    value: separator < 0 ? "" : assignment.slice(separator + 1),
    assignment,
  };
}

export function callFacts(req: ElicitRequest, evidence: unknown, reviewContext?: unknown): string {
  return JSON.stringify({
    operator_evidence: evidence,
    ...(reviewContext === undefined ? {} : { review_context: reviewContext }),
    call: {
      tool: req.tool,
      args: req.args,
      guard_reason: req.reason,
      segments: req.shell?.segments.map((segment) => ({
        source: segment.command,
        normalized: segment.normalized,
        argv: segment.argv,
        executable: segment.argv[0] ?? null,
        parameters: segment.argv.slice(1),
        environment: segment.envAssignments.map(environmentFact),
        decidable: segment.decidable,
        analysis_issues: segment.analysisIssues,
      })),
      analysis_issues: req.shell?.analysisIssues,
      paths: req.shell?.paths,
      placement: req.placement,
      network: req.network,
      matched: req.matched,
      within_workspace: req.within_workspace,
      touches_outside: req.touches_outside,
      dangerous: req.dangerous,
    },
  });
}
