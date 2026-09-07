# Full product audit

Apply the shared artifact, PTY, isolation, and evidence rules in [SKILL.md](../SKILL.md) once.
Use this mode when the user requests broad product coverage. A completed inventory means every
scenario has a disposition; it does not mean every scenario passed E2E.

## Maintain the inventory

Read [coverage-matrix.md](coverage-matrix.md) and reconcile the relevant surface with current source:

- `packages/code/src/app/commands.tsx`, `packages/code/src/keys/commands.ts`,
  `packages/code/src/views/App.tsx`, and dynamic skill/MCP prompt registrations;
- `packages/code/src/views/config/hub-items.ts` and its concrete settings/domain views;
- `packages/code/src/cli-args.ts`, `packages/code/src/app/layout.ts`, keymaps, and input/transcript
  implementations;
- the owning README/specs and tests for configuration, capabilities, failures, and recovery.

Run the static check from the repository root:

```bash
bun .agents/skills/clarvis-tui-validation/scripts/check-live-inventory.ts
```

It checks registered slash commands, Settings panel names, dynamic-command rows, and duplicate
scenario IDs, including padded Markdown cells. It does not cover every dynamic registration or
prove any journey executed. Manually reconcile the remaining surfaces. Derive totals from parsed
rows, never a saved count or a list of every ID mentioned in prose.

When documentation synchronization or a behavior change changes a covered surface, update the
relevant matrix rows in the same iteration. Change the main skill only when its workflow changes,
and [the report template](report-template.md) only when its evidence schema changes. Static
maintenance needs no build, PTY, or provider call unless the task separately requests execution.

## Plan once, reuse fixtures

Read [the report template](report-template.md). Give every matrix ID a row with required proof,
fixture, actions, stable waits, artifact, evidence, verdict, and remaining gap. Split substantial
subcases when only some can be exercised. Mark genuinely unavailable platforms/integrations with
the exact reason; an available but unattempted journey remains an incomplete requirement.

Inventory existing harnesses and already-valid evidence before running suites. Prefer repository
fixtures for scripted streams, errors, elicitation, delayed/stale responses, state corruption,
Tasks mutations, MCP pools, extension drift, and ownership races. Reuse compatible fixtures across
scenarios, preserving intentional persistence; reset when state would contaminate the next case.
Implement a missing harness only within the task's authorization.

Group checks by shared setup while keeping separate assertions and verdicts. One tool-rich run can
support several rows if each row has observable evidence. A passing package suite supplies only the
assertions it actually executed. Name the test and its proof boundary instead of assigning a whole
feature a green E2E verdict from the suite total.

## Execute and close gaps

Start with boot, input, submission, cancellation, and shutdown, then exercise the matrix's stateful
commands, settings, capabilities, extensions, and isolation flows. Include failure, recovery,
stale-completion, persisted-scope conflicts, and navigation/resize interruptions where required.
Reuse the shared skill's frame checks rather than running a second visual audit.

Use [performance.md](performance.md) for the matrix's startup, extension comparison, overlay, and
process-resource scenarios. Reuse its measurements in this report. A full audit requires those
scenarios or explicit gaps; a focused mode does not automatically require them.

Run source diagnosis as needed, then build once after relevant fixes and repeat the critical path
and fixed defects on the final bundle. Keep same-input earlier passes; rerun dependents invalidated
by a change. No fix is verified by an artifact built before it.

Real-account requests must include the specified provider/account/model in actual runs. Use
fixtures to extend race and failure coverage, with separate verdicts. Before classifying a local
scenario as blocked, exercise safe available alternatives within scope. Record attempted commands
and the prerequisite that is missing. Hardware, browser, OAuth, and other platform canaries retain
their own proof boundaries.

For container scenarios, consult the current
[runtime contract](../../../../specs/hosts/isolated-agent-runtime.md) and use test-owned workspace,
recipe, image, and generation identities. Assert effective placement independently, exercise host
bridges, steer/cancel/follow-up, persistent mise state, loopback preview, and classified fallback.
Distinguish a guest service response from an unrelated host listener. Record cleanup alongside the
test that created each resource.

## Assess the result

Use P0 for data loss, corruption, secret/trust escape, or duplicate destructive effects; P1 for a
blocked routine workflow, crash, hang, lost input, or wrong persistent state; P2 for material
latency, visual instability, misleading feedback, or a broken secondary route; P3 for minor polish.
Link reproducible findings to scenario IDs and keep fixes within the user's scope.

Report executed passes/failures, partial proof, blocked/unverified cases, and justified exclusions
separately. The audit is complete only when required available journeys have been exercised,
findings are triaged, and final-artifact checks and cleanup are recorded. An explicit ledger of
unattempted cases is useful progress, not completion. Do not label mixed proof as “all E2E passed.”
