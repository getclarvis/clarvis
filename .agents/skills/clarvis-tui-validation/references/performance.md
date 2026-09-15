# Performance investigations

Use [SKILL.md](../SKILL.md) for shared provenance, PTY, authorization, and cleanup. Measure the
stages implicated by the request. Startup, extension cost, OAuth, and retention are independent
investigations; combine them only for a full audit or a request spanning them.

## Select authority and measurements

Start with [code-performance.md](../../../../specs/hosts/code-performance.md) and the owning
benchmark implementation. Read [code-bootstrap.md](../../../../specs/hosts/code-bootstrap.md) for
input/boot changes; [extension-profiles.md](../../../../specs/hosts/extension-profiles.md) and
[plugins.md](../../../../specs/hosts/plugins.md) for contribution cost;
[mcp-client.md](../../../../specs/foundations/mcp-client.md) for connection/OAuth waits. Read the
owning package README when investigating its implementation. Reuse already-read material.

Build the artifact once when needed, smoke it, and preserve it across a controlled comparison.
Record machine/load/power policy, runtime versions, dimensions, sampling settings, and fixture
identity. Use compatible conditions for comparisons; do not run CPU-heavy suites concurrently with
timing or resource measurements. Historical known-issue experiments can narrow the investigation;
repeat them only if changed inputs or new evidence justify it.

## Startup

```bash
BENCH_N=7 bun run bench:code --arm=bundle
```

Read the current tooling's controls and thresholds before interpreting results. Keep its
environmental guards enabled. If `--force` is useful for local diagnosis, label that sample
untrusted. Report min/median/max for each emitted stage: `version`, `shell`, `startupReady`, `paint`,
and `ready`. Startup-composer availability and complete-app readiness answer different questions;
neither establishes run-host readiness or time to first provider/tool activity.

When startup handoff is implicated, submit a unique task before full hydration and verify it starts
once the run host is ready without a second Enter. Exercise the no-provider draft handoff and
shutdown/fatal-retry paths affected by the change. Those are correctness checks beside the timing
sample, not reasons to rerun unrelated integrations.

## Extension cost and real-run latency

Compare a clean profile with a pinned representative extension-heavy profile using the same
artifact, workspace, model, effort, task, and cache conditions. Scope the inventory to the request;
installing every available marketplace plugin is not a default requirement. Record exact plugin
and standalone skill identities, revisions, resource sizes, declared MCPs, and cold/warm state.

Correlate individual and combined snapshot durations, kernel readiness, admission, first
model/tool activity, and completion. Begin with existing debug diagnostics; temporary
instrumentation must be confined to the investigation and removed or intentionally shipped with
its own validation. Look for repeated filesystem walks/parsing/hashing when cost tracks inventory
size. A real-run comparison exercises the skill, MCP, or Clarvis subagent paths relevant to that
profile; no fixed subagent count is required for an unrelated startup regression.

Preserve current snapshot semantics when optimizing. Initial pinning and capture verification bind
bounded bytes, exact qualified identities, effective sidecar metadata, and admitted resource paths.
After capture, asynchronous monitors withdraw affected skills/process contributions. A changed
skill is withheld after its drift notice while unaffected skills and the next run remain usable;
reconnect captures the changed content. Run admission must not regain synchronous skill walks or
hashes. Selection/trust changes have their own contract and must not be conflated with file drift.
Use `withdraws plugin skill drift without rejecting the next run` in
`packages/kernel/tests/integration/file-kernel.test.ts` and the owning spec's focused tests.

Exercise manifest, sidecar, resource, and executable drift when those paths changed, waiting for the
documented notice before asserting withdrawal. If memory indexing is involved, verify its host
ownership and fresh Extension Profile lease after foreground settlement. Do not add every drift
variant to a measurement-only task.

## OAuth and connection waits

When MCP/OAuth latency is in scope, use a controlled pending-auth fixture first. An unanswered
authorization must leave other tools and runs usable; retain connection/admission bounds, share
one pending flow, degrade promptly at capacity, preserve terminal failures, and close without
waiting for a human callback. Use the current MCP tests to pin these cases.

If live browser/account behavior is requested and authorized, leave one flow pending while work
continues, then complete it only when the scenario requires token persistence and later reuse.
Record the real-provider result separately from the fixture. Ordinary startup measurements do not
require opening browsers or changing an account.

## Retention and instability

For overlays or a full audit, run `bun run bench:code-overlays` and report the tooling's sizes,
sample/cycle counts, ownership deltas, and environment-qualified memory slopes. For long-run
retention, also run bounded idle and active complete-turn/navigation cycles with diagnostics and
external process-tree RSS/PSS where available, CPU, listeners, queues, and child-process counts.
A zero renderer-owner delta does not by itself prove bounded process memory.

Use an external watchdog for hangs. Inspect frame sequences for redraw loops, scroll jumps, or
input starvation, and associate samples with the workload and first bad checkpoint.

## Validate the explanation

Choose the smallest measured stage that explains the regression. Clean and heavy `shell` changes
suggest entrypoint/renderer cost; heavy-only snapshot cost suggests contributions; fast composer
with delayed run suggests handoff/admission; OAuth-only delay suggests connection acquisition.
Call a limit upstream-owned only with a minimal attributable experiment.

After a fix, run the owning checks and repeat invalidated measurements and PTY checkpoints on the
final artifact. Reuse compatible successful evidence; the enclosing full audit or release preflight
does not need a second build or benchmark. Report the measured cause, comparison conditions,
trusted/untrusted status, stage values, correctness verdicts, and remaining gaps.
