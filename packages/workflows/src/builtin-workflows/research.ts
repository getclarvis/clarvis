import type { WorkflowDefinition } from "../artifact.ts";

/** The research workflow Clarvis ships without materializing configuration files. */
export const RESEARCH_WORKFLOW = {
  name: "research",
  description:
    "Answer a question from evidence, choosing only useful lines of enquiry and optional verification.",
  args: ["question"],
  control: "manager",
  objective:
    "Answer {{args.question}} from evidence, distinguishing facts, inference and unknowns.",
  completion: {
    criteria: [
      { id: "answer", description: "The question is answered with attributable evidence." },
      {
        id: "uncertainty",
        description:
          "Inferences, contradictions, unavailable material and consequential unknowns are explicit.",
      },
      {
        id: "validation",
        description:
          "Required checks or disputed load-bearing claims are evidenced or qualified, not confirmed by default.",
      },
    ],
  },
  maxDispatches: 8,
  rounds: [],
  stages: [
    {
      id: "frame",
      type: "discovery",
      profile: "explorer",
      over: { kind: "once" },
      title: "Frame research question",
      brief: `Frame an unresolved part of this question when existing evidence does not suffice:

{{args.question}}

Define what an adequate answer requires, then return independent lines of enquiry in \`work_items\`.
Each needs a short \`title\`, self-contained \`goal\`, read \`files\`, real \`dependencies\` and
\`mutation: false\`. Avoid duplicate searches. Record unavailable evidence in \`unknowns\`;
framing does not answer the question.`,
      fanout: 1,
    },
    {
      id: "investigate",
      type: "findings",
      profile: "explorer",
      over: { kind: "each", source: "frame.work_items" },
      title: "{{item.title}}",
      brief: `Pursue this line of enquiry:

{{item.goal}}

It is one part of the question: {{args.question}}

Stay on your line with read-only tools.

Use primary evidence and cite each finding as \`path:line\` or an exact source. Set
\`needs_verification: true\` for consequential or uncertain claims; calibrate \`confidence\`.
Record sampled, skipped or unavailable material in \`coverage_gaps\`.
Do not modify the workspace.`,
      fanout: 1,
    },
    {
      id: "verify",
      type: "verdict",
      profile: "explorer",
      over: { kind: "each", source: "investigate.findings" },
      title: "{{item.title}}",
      brief: `Independently test this claim, made while researching {{args.question}}:

Finding id: {{item.id}}
{{item.claim}}

Evidence offered: {{item.evidence}}
Why it was said to matter: {{item.impact}}

Seek counterexamples with read-only tools. Copy the id to \`finding_id\`. Return \`confirmed\` for
independent support, \`refuted\` for contradiction or \`inconclusive\` for insufficient evidence.
Cite observations; do not confirm by default or modify the workspace.`,
      fanout: 1,
      replicas: { min: 2, max: 2 },
      accept: { kind: "threshold", field: "verdict", value: "refuted", count: 2 },
    },
    {
      id: "critic",
      type: "findings",
      profile: "explorer",
      over: { kind: "all", source: "investigate.coverage_gaps" },
      title: "Challenge research gaps",
      brief: `These are the gaps the investigation of {{args.question}} left behind:

{{item}}

Identify which gaps or untested assumptions could change the answer. Inspect them with available
read-only tools; report newly supported findings with evidence and keep unresolved gaps in
\`coverage_gaps\`. Explain whether another pass could resolve them. Do not modify the workspace.`,
      fanout: 1,
    },
  ],
  synthesis: `# Synthesis

Answer from cited evidence, separating established facts, inferences and unknowns. If the evidence
cannot settle the question, say so. \`verify.accepted\` contains claims meeting the refutation
threshold; exclude them. \`verify.rejected\` means not refuted, not confirmed: preserve uncertainty
when verification was inconclusive or unavailable. Cite selected work, omitted or deferred lines,
reported coverage gaps, required checks and the limits of the answer.`,
  dir: "builtin:research",
} satisfies WorkflowDefinition;
