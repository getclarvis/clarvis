# Clarvis TUI product E2E report template

Use this structure for a complete audit. Keep evidence paths relative to the retained run directory
when practical and remove secrets from every excerpt.

## Verdict

- Overall: `pass`, `fail`, `blocked`, or `incomplete`
- Highest severity:
- Source round:
- Final-bundle round:
- Unverified external or native surfaces:

## Provenance

| Field                   | Value |
| ----------------------- | ----- |
| Branch / full commit    |       |
| Worktree state          |       |
| Source launch           |       |
| Bundle build and launch |       |
| Bun / OpenTUI           |       |
| OS / architecture       |       |
| Terminal / color mode   |       |
| Dimensions tested       |       |
| Isolated `CLARVIS_HOME` |       |
| Disposable workspaces   |       |
| Fixture revisions       |       |

## Coverage ledger

| Scenario ID | Artifact             | Verdict                                 | Evidence                                   | Defect / limitation |
| ----------- | -------------------- | --------------------------------------- | ------------------------------------------ | ------------------- |
|             | `source` or `bundle` | `pass`, `fail`, `blocked`, `unverified` | snapshots, frames, diagnostics, state diff |                     |

Every applicable matrix ID must appear. Add discovered scenarios rather than hiding them under an
existing broad row.

## Defects

| ID  | Severity  | User impact | Reproduction           | Expected / observed | Evidence | Stability                             |
| --- | --------- | ----------- | ---------------------- | ------------------- | -------- | ------------------------------------- |
|     | `P0`-`P3` |             | numbered exact actions |                     |          | deterministic / intermittent and rate |

For each P0/P1 include the smallest fixture, first bad checkpoint, whether it reproduces in source
and bundle, persisted-state impact, recovery, and any environment dependency. Separate product
assertion failures from known runtime crashes or sandbox/socket restrictions.

## Journey evidence

For every failed, intermittent, performance-sensitive, or visually significant scenario record:

- Preconditions and owned fixture state
- Exact action sequence
- Stable wait tokens
- Initial, transition, and final text snapshots
- First meaningful, transition, and settled screenshots
- Frame range for motion, flicker, scroll, or root replacement
- Diagnostics sequence and state before/after
- Process exit, child-process cleanup, and resource observations
- Verdict and rationale

## Performance and soak

| Measurement                   | Environment | Samples/cycles | Min | Median | Max/slope | Verdict |
| ----------------------------- | ----------- | -------------- | --- | ------ | --------- | ------- |
| Launcher/module graph         |             |                |     |        |           |         |
| Startup shell/composer        |             |                |     |        |           |         |
| Complete app                  |             |                |     |        |           |         |
| Extension Profile / kernel    |             |                |     |        |           |         |
| First activity / complete run |             |                |     |        |           |         |
| Overlay ownership / memory    |             |                |     |        |           |         |
| Idle and active process tree  |             |                |     |        |           |         |

Do not merge startup-composer and complete-app readiness into one number. State whether samples were
trusted, what environmental guard applied, and which limits came from the current tooling.

## Limitations and cleanup

- External accounts, provider calls, OAuth browser flows and physical terminals not exercised
- OS/platform surfaces not exercised
- Fixture boundary that remains synthetic
- Interrupted or environmentally blocked commands with exact failure signature
- PTYs and child processes stopped
- Temporary state removed or exact retained paths and reason
- No user credentials or normal Clarvis state changed
- No commit or publication action unless explicitly authorized

## Conclusion

State whether every applicable matrix row has an explicit verdict, whether any P0/P1 remains
untriaged, whether critical paths passed against the final bundle, and the highest-value next action.
