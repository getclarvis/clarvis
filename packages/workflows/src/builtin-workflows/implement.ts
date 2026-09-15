import type { WorkflowDefinition } from "../artifact.ts";

/** The implementation workflow Clarvis ships without materializing configuration files. */
export const IMPLEMENT_WORKFLOW = {
  name: "implement",
  description:
    "Decompose a change, implement the parts in a safe order with no overlapping writes, then review the result and verify the review.",
  args: ["goal"],
  rounds: [
    {
      id: "plan",
      type: "discovery",
      profile: "planner",
      over: { kind: "once" },
      title: "Plan implementation",
      brief: `Plan this change without modifying the workspace:

{{args.goal}}

Read the code and applicable workspace instructions. Return separable \`work_items\`, each with a
short \`title\`, a self-contained \`goal\` and validation criteria. Declare every file read or changed,
set \`mutation\` for writes, and use \`dependencies\` for prerequisites. These declarations schedule
conflicts within this batch; an unscoped writer runs alone. Record unresolved scope-changing
questions in \`unknowns\`.`,
      fanout: 1,
    },
    {
      id: "build",
      type: "findings",
      profile: "coder",
      over: { kind: "each", source: "plan.work_items" },
      title: "{{item.title}}",
      brief: `Implement this part of the change:

{{item.goal}}

The overall goal is: {{args.goal}}

Respect the appended file scope and existing edits; scheduling does not isolate the workspace
from unrelated work. If completion needs a broader scope, report the blocker instead of expanding it.
Follow workspace conventions and use available tools for the relevant checks. Report actual commands
and outcomes, changed files in \`findings\`, and unfinished work in \`coverage_gaps\`.
Set \`needs_verification\` for unverified claims. Do not commit, push or rewrite repository history.`,
      fanout: 1,
    },
    {
      id: "review",
      type: "findings",
      profile: "explorer",
      over: { kind: "once" },
      title: "Review implementation",
      brief: `Review the change that was just made for this goal:

{{args.goal}}

What the build leaders reported doing: {{state.build.findings}}

Check the reports against current files and available diff evidence. Prioritize correctness,
invariants, affected callers and missing tests. Cite findings as \`path:line\` and mark consequential
claims \`needs_verification: true\`. This is read-only: use only exposed read tools; do not assume
command execution is available. Put checks you could not run and areas not reviewed in
\`coverage_gaps\`. Report problems; do not fix them.`,
      fanout: 1,
    },
    {
      id: "verify",
      type: "verdict",
      profile: "explorer",
      over: {
        kind: "each",
        source: "review.findings",
        where: { field: "needs_verification" },
      },
      title: "{{item.title}}",
      brief: `Independently test this review finding about the change made for {{args.goal}}:

Finding id: {{item.id}}
{{item.claim}}

Evidence offered: {{item.evidence}}
Claimed impact: {{item.impact}}

Inspect the code and look for counterevidence using available read-only tools. Copy the finding id
into \`finding_id\`. Return \`confirmed\` only with independent supporting evidence, \`refuted\` with
contradictory evidence, or \`inconclusive\` if evidence is insufficient. Distinguish static analysis
from executed reproduction; unavailable checks are a limitation, not confirmation. Do not modify
the workspace.`,
      fanout: 2,
      accept: { kind: "threshold", field: "verdict", value: "refuted", count: 2 },
    },
  ],
  synthesis: `# Synthesis

Report verified changes, affected files, actual checks and remaining work. Failed, cancelled or
budget-exhausted leaders may leave partial edits; inspect the workspace, since failure does not roll
back writes. Do not label partial work complete.
\`verify.accepted\` means the refutation threshold matched; exclude those refuted claims.
\`verify.rejected\` means not refuted, not confirmed. Separate supported defects from inconclusive
claims and unavailable checks. Include coverage gaps and work blocked by failed dependencies.`,
  dir: "builtin:implement",
} satisfies WorkflowDefinition;
