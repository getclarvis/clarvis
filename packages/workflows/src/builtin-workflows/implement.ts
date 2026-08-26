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
      brief: `Work out how to do this, before anything is written:

{{args.goal}}

Read the code first. Do not modify anything in this round.

- Return \`work_items\` that are genuinely separable pieces of the change. Give each a short \`title\`
  for the operator and keep its complete instruction in \`goal\`.
- **\`files\` and \`mutation\` are load-bearing here, not documentation.** The runtime uses them to
  prove two items are safe to run at the same time: it holds apart any two whose files overlap when
  either of them writes. Under-declaring \`files\` does not buy parallelism — it lets two writers
  corrupt the same file.
- Set \`mutation: true\` for any item that changes the workspace, and list every file it would touch.
  An item that writes but declares no files is treated as writing everything, and will run alone.
- Use \`dependencies\` where one item genuinely cannot start until another has landed.
- Put anything that would change the plan if resolved into \`unknowns\`.`,
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

The files listed in your scope are yours for the duration of this run — the runtime has already
made sure no other leader is writing them at the same time. **Stay inside them.** Writing outside
your declared scope defeats the guarantee that made it safe to run you concurrently.

- Follow the conventions of the code you are editing: its naming, its comment density, its idioms.
- Run whatever check the package provides for what you touched (its tests, its typecheck, its lint).
  Report the command and its real outcome.
- Report what you did in \`findings\`: one entry per change, with the file cited as evidence.
- If you could not complete the item, say so and say why. Set \`needs_verification: true\` on anything
  you had to guess at. Do not report a partial change as finished.
- Do not commit, push, or otherwise touch repository history.`,
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

Read the actual diff and the actual files. The report above is a claim, not evidence — your job is
partly to check that what was reported is what happened.

- Look for correctness defects first: wrong behaviour, unhandled cases, broken invariants.
- Then look for what is missing: a case with no test, a caller that was not updated, a type that
  drifted from its fixtures.
- Run the checks yourself rather than trusting that they were run.
- Cite every finding as \`path:line\`. Set \`needs_verification: true\` on anything consequential — an
  independent leader will try to refute it before it is acted on.
- Put what you did not review into \`coverage_gaps\`.
- This round is read-only. Report problems; do not fix them.`,
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
      brief: `Try to REFUTE this review finding about the change made for {{args.goal}}:

{{item.claim}}

Evidence offered: {{item.evidence}}
Claimed impact: {{item.impact}}

You are attacking this claim, not checking it. A reviewer's finding that nobody tried to break is
worth about as much as a guess.

- Go to the code yourself. Construct the input or the state that would make the claimed failure
  happen.
- Return \`refuted\` when you found that the code already handles it, or that the reviewer misread
  it — and say exactly what they missed.
- Return \`confirmed\` only when you actually reproduced the failure.
- Return \`inconclusive\` when you could not reach the evidence. Do not confirm by default.
- Do not modify the workspace.`,
      fanout: 2,
      accept: { kind: "threshold", field: "verdict", value: "refuted", count: 2 },
    },
  ],
  synthesis: `# Synthesis

Report what was actually changed, and what state the workspace is in now.

- List the changes that landed, file by file, and the checks that were run against them.
- A work item that ended \`blocked\`, \`failed\` or \`budget_exhausted\` did **not** land. Say so
  explicitly — a partially applied change reported as done is the most expensive outcome here.
- Report the review findings that survived verification as work still to do, not as opinions.
- If the writers were serialized because their files overlapped, that is normal and not worth
  reporting. If an item was blocked because a dependency failed, that is worth reporting.`,
  dir: "builtin:implement",
} satisfies WorkflowDefinition;
