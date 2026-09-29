import type { WorkflowDefinition } from "../artifact.ts";

/** The audit workflow Clarvis ships without materializing configuration files. */
export const AUDIT_WORKFLOW = {
  name: "audit",
  description:
    "Assess a subject against evidence and coverage; choose only the investigation and verification needed for the requested audit.",
  args: ["subject"],
  control: "manager",
  objective: "Audit {{args.subject}} with supported findings, honest coverage and explicit limits.",
  completion: {
    criteria: [
      {
        id: "findings",
        description: "Requested audit conclusions have checkable evidence and calibrated impact.",
      },
      {
        id: "coverage",
        description: "Examined, sampled and unexamined scope and consequential gaps are explicit.",
      },
      {
        id: "validation",
        description:
          "Required checks and consequential disputed claims have actual evidence or remain qualified, never presumed confirmed.",
      },
    ],
  },
  maxDispatches: 8,
  rounds: [],
  stages: [
    {
      id: "discover",
      type: "discovery",
      profile: "explorer",
      over: { kind: "once" },
      title: "Map audit scope",
      brief: `Map the unresolved scope of {{args.subject}} when existing evidence does not suffice.

Inspect directly. Return independent \`work_items\` with short \`title\`, self-contained \`goal\`,
read \`files\`, \`mutation: false\` and real \`dependencies\`. Record unobserved facts in
\`unknowns\`; do not invent findings.`,
      fanout: 1,
    },
    {
      id: "review",
      type: "findings",
      profile: "explorer",
      over: { kind: "each", source: "discover.work_items" },
      title: "{{item.title}}",
      brief: `Review this part of {{args.subject}}: {{item.goal}}

Stay in scope and do not modify the workspace.

Ground findings in observed evidence, cited as \`path:line\` or an exact source. Set
\`needs_verification: true\` for consequential or uncertain claims; calibrate \`confidence\`.
Record sampled, skipped or unreadable areas in \`coverage_gaps\`.`,
      fanout: 1,
    },
    {
      id: "verify",
      type: "verdict",
      profile: "explorer",
      over: { kind: "each", source: "review.findings" },
      title: "{{item.title}}",
      brief: `Independently test this claim about {{args.subject}}:

Finding id: {{item.id}}
{{item.claim}}

Supporting evidence offered: {{item.evidence}}
Claimed impact: {{item.impact}}

Seek counterevidence with read-only tools. Copy the id to \`finding_id\`. Return \`confirmed\` for
independent support, \`refuted\` for contradiction or \`inconclusive\` for insufficient evidence.
Distinguish source analysis from executed reproduction; do not modify the workspace.`,
      fanout: 1,
      replicas: { min: 2, max: 3 },
      accept: { kind: "threshold", field: "verdict", value: "refuted", count: 2 },
    },
    {
      id: "gaps",
      type: "findings",
      profile: "explorer",
      over: { kind: "all", source: "review.coverage_gaps" },
      title: "Close audit gaps",
      brief: `These are the coverage gaps the review of {{args.subject}} left behind:

{{item}}

Inspect consequential gaps using available read-only tools. Return newly supported findings with
cited evidence and keep unexamined areas in \`coverage_gaps\`. Explain which remaining gaps affect
the conclusions. Do not modify the workspace.`,
      fanout: 1,
    },
  ],
  synthesis: `# Synthesis

Lead with supported findings, their impact and checkable evidence. The rule is
\`threshold(verdict, refuted, 2)\`: \`verify.accepted\` contains refuted claims; exclude them.
\`verify.rejected\` means not refuted, not confirmed. Separate supported findings from inconclusive
claims; missing or failed verifiers are not confirmation. Cite the stages and items actually selected,
skipped or deferred, required checks, remaining coverage gaps and budget-limited work rather than
claiming an exhaustive audit.`,
  dir: "builtin:audit",
} satisfies WorkflowDefinition;
