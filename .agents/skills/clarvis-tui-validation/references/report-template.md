# Full product audit report

Use for full-audit mode; focused checks need only a compact handoff. Keep evidence paths relative
to one retained run directory. Remove inapplicable sections, but retain every required scenario's
disposition and every unresolved gap. Never include credentials in evidence excerpts.

## Scope and verdict

- Requested scope, provider/model, platforms, and authorized fixes
- Overall: pass / fail / incomplete, qualified by verified scope
- Required and executed scenarios; passed, failed, partial, blocked/unverified, and justified exclusions
- Critical source/final-bundle outcome and highest-severity finding

Inventory coverage and executed E2E coverage are separate totals. A ledger with every ID filled in
does not mean every scenario was exercised. Available unattempted requirements keep the task
incomplete; partial proof does not count as a pass.

## Provenance and reusable checks

| Field                                                                        | Value |
| ---------------------------------------------------------------------------- | ----- |
| Full commit and relevant worktree changes                                    |       |
| Source command and identity                                                  |       |
| Bundle build command, flavor, identity, and launch                           |       |
| Bun/OpenTUI, OS/architecture, terminal/profile, sizes                        |       |
| Isolated home, workspaces, fixture revisions/configuration                   |       |
| For Docker: engine/context, image ID, generation, effective placement/policy |       |

| Check | Command / named test | Input/artifact identity | Exit / outcome | Evidence | Reused evidence and why still valid |
| ----- | -------------------- | ----------------------- | -------------- | -------- | ----------------------------------- |
|       |                      |                         |                |          |                                     |

## Scenario ledger

| Scenario / subcase | Required proof | Method actually exercised                                     | Artifact                | Verdict                                                       | Evidence                               | Missing proof / defect |
| ------------------ | -------------- | ------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------- | -------------------------------------- | ---------------------- |
|                    |                | static / deterministic / PTY / real account / native hardware | source / bundle / image | pass / fail / partial / blocked / unverified / not applicable | exact test, frames, diagnostics, state |                        |

Each matrix ID must appear. Split subcases when proof differs; justify exclusions and blockers.
Repeated rows may cite shared evidence if its assertions support each row. Do not infer a
checkpoint from a whole package's test total, a displayed header, or a token also present in input.
If images were not inspected, visual requirements remain unverified.

## Findings

| ID / scenario | Severity | User impact | Expected / observed | Exact reproduction | Evidence | Reproducibility                        | Fix disposition                            |
| ------------- | -------- | ----------- | ------------------- | ------------------ | -------- | -------------------------------------- | ------------------------------------------ |
|               | P0–P3    |             |                     |                    |          | deterministic / intermittent, attempts | fixed and verified / report only / blocked |

For each finding, retain the smallest fixture, initial/action/transition/settled checkpoints,
first bad frame or event, persisted-state impact, recovery, and source/bundle status. Include the
exact failing command and both attempts of any retry. Distinguish product assertions, provider
failures, runtime crashes, and environmental restrictions with evidence.

## Performance

| Stage / workload | Artifact / environment | Samples / cycles | Min | Median | Max / slope | Trusted? | Verdict / evidence |
| ---------------- | ---------------------- | ---------------- | --- | ------ | ----------- | -------- | ------------------ |
|                  |                        |                  |     |        |             |          |                    |

Keep startup composer, complete app, kernel/admission, first activity, completion, and resource soak
separate. Record cold/warm state, profile inventory, external process measurements, and the current
tooling's limits. Reuse the same sample across applicable scenario rows.

## Limitations and cleanup

- Required account/integration/platform/hardware paths unavailable, exact blocker, and alternatives attempted
- Synthetic boundaries, unattempted available work, interrupted checks, and remaining risks
- Owned PTYs, processes, listeners, Docker generations, workspace roots, and credential copies removed
- Retained evidence/cache/state paths, ownership, and reason; normal versus forced shutdown evidence
- Documentation disposition and any publication action actually authorized and performed
