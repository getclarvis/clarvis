import type { WorkflowDefinition } from "../artifact.ts";

/** The audit workflow Clarvis ships without materializing configuration files. */
export const AUDIT_WORKFLOW = {
  name: "audit",
  description:
    "Map a subject, review it through independent lenses, verify consequential findings adversarially, close coverage gaps, and leave every additional pass to an explicit Admiral decision.",
  args: ["subject"],
  rounds: [
    {
      id: "discover",
      type: "discovery",
      profile: "explorer",
      over: { kind: "once" },
      title: "Map audit scope",
      brief: `Map {{args.subject}} before anything fans out.

Inspect the subject directly. Return independent \`work_items\` with short \`title\` labels,
self-contained \`goal\` briefs, read \`files\` and \`mutation: false\`. Declare real prerequisite
\`dependencies\` and unobserved facts in \`unknowns\`. Decompose the audit; do not invent findings.`,
      fanout: 1,
    },
    {
      id: "review",
      type: "findings",
      profile: "explorer",
      over: { kind: "each", source: "discover.work_items" },
      title: "{{item.title}}",
      brief: `Review this part of {{args.subject}}: {{item.goal}}

Work only within the scope named above. This is read-only: do not modify the workspace.

Ground findings in observed evidence, cited as \`path:line\` or an exact source. Set
\`needs_verification: true\` for consequential or uncertain claims, and calibrate \`confidence\` to
the evidence. Record sampled, skipped or unreadable areas in \`coverage_gaps\`.`,
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
      brief: `Independently test this claim about {{args.subject}}:

Finding id: {{item.id}}
{{item.claim}}

Supporting evidence offered: {{item.evidence}}
Claimed impact: {{item.impact}}

Inspect evidence and seek counterevidence using available read-only tools. Copy the finding id into
\`finding_id\`. Return \`confirmed\` for independent supporting evidence, \`refuted\` for contradictory
evidence, or \`inconclusive\` when evidence is insufficient. Distinguish source analysis from an
executed reproduction. Do not modify the workspace.`,
      fanout: 3,
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
      when: "review.coverage_gaps",
    },
  ],
  repeat: {
    rounds: ["review", "verify"],
    until: "no_new",
    dedupe_by: ["claim", "evidence"],
    dry_rounds: 2,
    max_rounds: 4,
  },
  synthesis: `# Synthesis

Lead with supported findings, their impact and checkable evidence. The rule is
\`threshold(verdict, refuted, 2)\`: \`verify.accepted\` contains refuted claims; exclude them.
\`verify.rejected\` means not refuted, not confirmed. Separate supported findings from inconclusive
claims; missing or failed verifiers are not confirmation. Include coverage gaps, skipped rounds and
budget-limited work rather than claiming an exhaustive audit.`,
  dir: "builtin:audit",
} satisfies WorkflowDefinition;
