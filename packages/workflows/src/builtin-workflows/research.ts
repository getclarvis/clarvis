import type { WorkflowDefinition } from "../artifact.ts";

/** The research workflow Clarvis ships without materializing configuration files. */
export const RESEARCH_WORKFLOW = {
  name: "research",
  description:
    "Break a question into independent lines of enquiry, sweep them in parallel, verify the load-bearing claims, and propose another pass only while it could still add something new.",
  args: ["question"],
  rounds: [
    {
      id: "frame",
      type: "discovery",
      profile: "explorer",
      over: { kind: "once" },
      title: "Frame research question",
      brief: `Frame this question before anything fans out:

{{args.question}}

Define what an adequate answer requires, then return independent lines of enquiry in \`work_items\`.
Each needs a short \`title\`, self-contained \`goal\`, read \`files\`, real \`dependencies\` and
\`mutation: false\`. Avoid duplicated searches. Record \`unknowns\`, including unavailable evidence
needed to answer the question. This round frames the research; it does not answer it.`,
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

Stay on your assigned line and use only available read-only tools.

Use primary evidence and cite each finding as \`path:line\` or an exact source. Set
\`needs_verification: true\` for consequential or uncertain claims and calibrate \`confidence\`
to the evidence. Record sampled, skipped or unavailable material in \`coverage_gaps\`.
Do not modify the workspace.`,
      fanout: 1,
    },
    {
      id: "verify",
      type: "verdict",
      profile: "explorer",
      over: {
        kind: "each",
        source: "investigate.findings",
        where: { field: "needs_verification" },
      },
      title: "{{item.title}}",
      brief: `Independently test this claim, made while researching {{args.question}}:

Finding id: {{item.id}}
{{item.claim}}

Evidence offered: {{item.evidence}}
Why it was said to matter: {{item.impact}}

Inspect primary evidence and seek counterexamples using available read-only tools. Copy the
finding id into \`finding_id\`. Return \`confirmed\` for independent supporting evidence, \`refuted\`
for contradictory evidence, or \`inconclusive\` if evidence is insufficient. Cite what you observed;
do not confirm by default or modify the workspace.`,
      fanout: 2,
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
      when: "investigate.coverage_gaps",
    },
  ],
  repeat: {
    rounds: ["investigate", "verify"],
    until: "no_new",
    dedupe_by: ["claim"],
    dry_rounds: 2,
    max_rounds: 3,
  },
  synthesis: `# Synthesis

Answer from cited evidence, separating established facts, inferences and unknowns. If the evidence
cannot settle the question, say so. \`verify.accepted\` contains claims meeting the refutation
threshold; exclude them. \`verify.rejected\` means not refuted, not confirmed: preserve uncertainty
when verification was inconclusive or unavailable. Include reported coverage gaps and skipped rounds.`,
  dir: "builtin:research",
} satisfies WorkflowDefinition;
