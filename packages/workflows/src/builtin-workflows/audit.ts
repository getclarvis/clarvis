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

Your job is decomposition, not judgement: find the parts a separate reviewer could take on
independently, and say honestly what you could not determine.

- Inspect the subject directly. Do not infer structure from names.
- Return \`work_items\` that are genuinely independent of each other. Give each a short \`title\` for
  the operator and keep the complete instruction in \`goal\`. List the \`files\` it would need to read,
  and set \`mutation: false\` — this is a read-only audit.
- Use \`dependencies\` only where one item's finding would change another's scope.
- Put anything you could not observe into \`unknowns\`. A guess recorded as a fact costs more than
  an admitted gap.`,
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

- Ground every finding in something you observed, cited as \`path:line\`. A claim you cannot cite is
  not a finding.
- Set \`needs_verification: true\` for anything consequential, surprising, or that you could not fully
  confirm — an independent leader will try to refute it. Setting it honestly is cheaper than being
  wrong in the final report.
- Set \`confidence\` on what you actually saw, not on how plausible the claim feels.
- List in \`coverage_gaps\` what you sampled, skipped, or could not read. This is the counterweight
  that keeps the finding list from reading as exhaustive.`,
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
      brief: `Try to REFUTE this claim about {{args.subject}}:

{{item.claim}}

Supporting evidence offered: {{item.evidence}}
Claimed impact: {{item.impact}}

You are not checking this claim, you are attacking it. A verifier asked to "confirm" confirms.

- Go to the evidence yourself. Do not reason about whether the claim sounds right.
- Return \`refuted\` when you found something that contradicts it, and say what.
- Return \`confirmed\` only when you independently reproduced the problem.
- Return \`inconclusive\` when you could not reach the evidence — that is a real answer, and it is the
  reason this field exists. Do not confirm by default.`,
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

Work out which of them actually matter, and close the ones that do.

- Go and look at what was skipped. Some gaps are harmless; say which, and why.
- For a gap that turns out to hide something, return it as a proper finding with cited evidence,
  exactly as a review round would.
- Report what remains genuinely uncovered in \`coverage_gaps\`. The point of this round is an honest
  boundary, not the appearance of completeness.`,
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

Report the findings that survived verification, and say plainly which ones did not.

- Lead with what is actually wrong and what it costs, not with how the audit was run.
- For every claim you keep, cite the evidence a reader can check — \`path:line\`, not "the parser".
- **Read the verify round the right way round.** Its rule is \`threshold(verdict, refuted, 2)\`, so
  \`verify.accepted\` is the set the rule _matched_ — the findings two independent leaders managed to
  refute. Those are dead: do not list them as caveats and do not reintroduce them as "possible
  issues". \`verify.rejected\` is what survived refutation, and that is your report.
- The coverage gaps are the honest limits of this audit. State them; an audit
  that reads as exhaustive when it sampled is worse than one that admits what it skipped.
- If a round was skipped or the budget ran out, say so, and say what that leaves unexamined.`,
  dir: "builtin:audit",
} satisfies WorkflowDefinition;
