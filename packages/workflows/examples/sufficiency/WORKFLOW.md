---
name: sufficiency
description: Answer a question with explicit evidence-based completion.
control: manager
args: [question]
objective: "Answer {{args.question}} with verifiable evidence and state any limits."
completion:
  criteria:
    - id: supported-answer
      description: The answer cites admissible evidence and states remaining uncertainty.
stages:
  - id: inspect
    type: findings
    profile: explorer
    over: once
    title: Investigate the gap
    brief: briefs/inspect.md
max_dispatches: 2
---

Report the answer, cited evidence references, and limitations. Preserve operational failures separately from the assessment of the objective.
