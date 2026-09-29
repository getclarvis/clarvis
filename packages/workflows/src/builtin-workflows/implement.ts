import type { WorkflowDefinition } from "../artifact.ts";

/** The implementation workflow Clarvis ships without materializing configuration files. */
export const IMPLEMENT_WORKFLOW = {
  name: "implement",
  description:
    "Deliver a change with evidence of required validation, choosing useful work explicitly.",
  args: ["goal"],
  control: "manager",
  objective:
    "Deliver {{args.goal}} with required validation and no undisclosed blocking or partial effects.",
  completion: {
    criteria: [
      {
        id: "delivery",
        description:
          "Requested behavior and affected files are supported by inspected workspace evidence, not a manager claim.",
      },
      {
        id: "validation",
        description:
          "User- and workspace-required tests and checks have actual outcomes or the result remains insufficient.",
      },
      {
        id: "effects",
        description:
          "Partial writes, failed work, unknown effects and blocking gaps are inspected and resolved or explicitly prevent completion.",
      },
    ],
  },
  maxDispatches: 8,
  rounds: [],
  stages: [
    {
      id: "plan",
      type: "discovery",
      profile: "planner",
      over: { kind: "once" },
      title: "Plan implementation",
      brief: `Plan this change without modifying the workspace:

{{args.goal}}

Read code and workspace instructions. Return \`work_items\` with short \`title\`,
self-contained \`goal\` and validation criteria. Declare read/changed files, \`mutation\` for writes
and real \`dependencies\`; unscoped writers run alone. Record scope-changing \`unknowns\`.`,
      fanout: 1,
      replicas: { min: 1, max: 8 },
    },
    {
      id: "build",
      type: "findings",
      profile: "coder",
      over: { kind: "each", source: "plan.work_items" },
      mutation: true,
      title: "{{item.title}}",
      brief: `Implement this part of the change:

{{item.goal}}

Overall goal: {{args.goal}}

Respect file scope and existing edits; scheduling does not isolate unrelated work. Report broader
needs as blockers. Follow workspace conventions and run relevant checks. Record actual commands and
outcomes, changed files in \`findings\`, unfinished work in \`coverage_gaps\`, and unverified claims
with \`needs_verification\`. Do not commit, push or rewrite history.`,
      fanout: 1,
      replicas: { min: 1, max: 1 },
    },
    {
      id: "review",
      type: "findings",
      profile: "explorer",
      over: { kind: "all", source: "build.findings" },
      title: "Review implementation",
      brief: `Review the change for this goal:

{{args.goal}}

Build reports: {{item}}

Check reports against files and diff. Prioritize correctness, invariants, callers and tests. Cite
findings as \`path:line\` and mark consequential claims \`needs_verification: true\`. Use read-only
tools; do not assume commands are available. Record unavailable checks and unreviewed scope in
\`coverage_gaps\`. Report problems; do not fix them.`,
      fanout: 1,
      replicas: { min: 1, max: 8 },
    },
    {
      id: "verify",
      type: "verdict",
      profile: "explorer",
      over: { kind: "each", source: "review.findings" },
      title: "{{item.title}}",
      brief: `Independently test this review finding about the change made for {{args.goal}}:

Finding id: {{item.id}}
{{item.claim}}

Evidence offered: {{item.evidence}}
Claimed impact: {{item.impact}}

Seek counterevidence with read-only tools. Copy the id to \`finding_id\`. Return \`confirmed\` only
with independent support, \`refuted\` with contradiction or \`inconclusive\` for insufficient evidence.
Distinguish static analysis from reproduction; unavailable checks are not confirmation. Do not
modify the workspace.`,
      fanout: 1,
      replicas: { min: 2, max: 8 },
      accept: { kind: "threshold", field: "verdict", value: "refuted", count: 2 },
    },
  ],
  synthesis: `# Synthesis

Report verified changes, affected files, actual checks and remaining work. Failed, cancelled or
budget-exhausted leaders may leave partial edits; inspect the workspace, since failure does not roll
back writes. Do not label partial work complete.
\`verify.accepted\` means the refutation threshold matched; exclude those refuted claims.
\`verify.rejected\` means not refuted, not confirmed. Separate supported defects from inconclusive
claims and unavailable checks. Cite the actual selected work, skipped/deferred items, required
validation, coverage gaps and work blocked by failed dependencies.`,
  dir: "builtin:implement",
} satisfies WorkflowDefinition;
