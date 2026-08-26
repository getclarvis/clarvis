import type { WorkflowDefinition } from "../artifact.ts";

/** The research workflow Clarvis ships without materializing configuration files. */
export const RESEARCH_WORKFLOW = {
  name: "research",
  description:
    "Break a question into independent lines of enquiry, sweep them in parallel, verify the load-bearing claims, and keep going while each pass still finds something new.",
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

Your job is to find the independent lines of enquiry, not to answer the question.

- Establish what is actually being asked, and what an answer would have to contain to count.
- Return one \`work_item\` per line of enquiry that could be pursued without waiting for another.
  Give each a short \`title\` for the operator and keep the complete instruction in \`goal\`. Give each
  a distinct angle — by subsystem, by source, by time period, by the kind of evidence it would
  produce. Five items that are the same search worded differently are waste.
- List in \`files\` whatever each item would need to read; set \`mutation: false\`. This is read-only.
- Put what you could not determine into \`unknowns\` — including whether the question is answerable
  at all from what is available.`,
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

Stay on your line. Another leader is covering the others, and two leaders answering the same
sub-question is not redundancy, it is waste.

- Go to primary evidence. Do not answer from what the naming or the documentation implies.
- Return one \`finding\` per thing you actually established, cited as \`path:line\` or as the source you
  read. A claim you cannot cite does not go in.
- Set \`needs_verification: true\` on anything load-bearing for the final answer, anything surprising,
  and anything you could not fully confirm.
- Set \`confidence\` on the strength of the evidence, not on how plausible the conclusion feels.
- Record in \`coverage_gaps\` what you sampled, skipped, or could not reach. This is what keeps the
  final answer from overclaiming.
- Do not modify the workspace.`,
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
      brief: `Try to REFUTE this claim, made while researching {{args.question}}:

{{item.claim}}

Evidence offered: {{item.evidence}}
Why it was said to matter: {{item.impact}}

Attack the claim. A researcher's conclusion nobody tried to break is a hypothesis.

- Go to the evidence yourself, and look for what would make the claim false: a counter-example, a
  source that says otherwise, a case the claim does not cover.
- Return \`refuted\` when you found it, and name it.
- Return \`confirmed\` only when you independently reached the same conclusion from the evidence.
- Return \`inconclusive\` when you could not reach the evidence. That is the honest answer and it is
  why the value exists — a verification round where everything comes back \`confirmed\` by default is
  decorative.
- Do not modify the workspace.`,
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

You are the completeness critic. Your question is not "what did we find?" but "what would make this
answer wrong?"

- Which of these gaps actually threaten the answer, and which are harmless? Say which, and why.
- What angle was never tried at all — a source nobody read, a subsystem nobody looked at, a period
  nobody covered?
- What is being assumed rather than established?
- Where a gap turns out to hide something real, return it as a finding with cited evidence, exactly
  as an investigation round would; it becomes the next pass's work.
- Leave in \`coverage_gaps\` what genuinely remains unknown. This is the caveat the final answer has
  to carry, so make it accurate rather than reassuring.
- Do not modify the workspace.`,
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

Answer the question. Do not narrate the research.

- Lead with the answer, then the evidence it rests on. If the evidence does not support an answer,
  say that instead of assembling one.
- Every claim you keep must cite where it came from. A claim \`verify\` refuted is gone — not a
  caveat, not a "some sources suggest".
- Distinguish what you established from what you inferred. The reader cannot tell them apart from
  the prose, and the difference is usually what matters.
- State what remains unknown, using the critic round's gaps. A confident answer to a question the
  research did not actually settle is the failure mode here.`,
  dir: "builtin:research",
} satisfies WorkflowDefinition;
