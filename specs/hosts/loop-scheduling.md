# Conversation prompt scheduling

## Ownership and scope

`/loop` registers a user-authored recurring prompt in the live terminal host. Registrations belong to
the current conversation, owner, workspace and TUI process. They are held only in memory. Closing
the TUI forgets them; reopening or resuming persisted conversation history does not restore timers.
Each admitted occurrence is a normal conversation turn with a new execution id, ordinary context
continuation, run budgets, tools, isolation and human elicitation. A model response never registers,
changes or completes a recurring job by implication.

Production: `createLoopController` in
[controller.ts](../../packages/code/src/features/loop/controller.ts), `registerLoopCommands` in
[commands.ts](../../packages/code/src/features/loop/commands.ts), and the interactive composition and
`closeWorkspace` in [runtime.tsx](../../packages/code/src/runtime.tsx).
Test: `registration, list and cancellation use no model and keep one cancellable wakeup` and
`clear invalidates registrations and disposal drops timers without pretending a run has closed` in
[loop-controller.test.ts](../../packages/code/tests/unit/loop-controller.test.ts).

## Command contract

```text
/loop 5m check the test results
/loop 90m --max-runs 8 -- review PR 123
/loop cron "*/5 * * * *" check the deploy
/loop cron "0 9 * * 1-5" --tz America/Recife -- prepare the summary
/loop
/loop list
/loop show <id>
/loop pause <id>
/loop resume <id>
/loop cancel <id>
/loop cancel <id> --running
```

Empty arguments and `list` open help and the current conversation's registrations. Creation requires
a nonblank prompt; malformed input reports an error and preserves the composer for correction. No
model call or additional confirmation is involved in creating, inspecting or controlling a job.

Durations are positive integers with `m`, `h` or `d`, at least one minute, within safe integer and
date ranges. `90m` stays ninety minutes. Cron requires one quoted expression with exactly five
numeric fields: minute, hour, day of month, month, weekday. The accepted dialect is `*`, lists,
ascending ranges and positive steps within field bounds; Sunday is 0 or 7. Seconds, years, names,
macros and library-specific extensions are rejected. Restricted day of month and weekday combine
with OR. Numeric-start steps such as `5/10` continue from the start through the field's maximum.
The adapter normalizes validated fields to the library's dialect, retaining bare wildcard semantics.
An expression without a future occurrence is rejected.

`--max-runs` takes a positive safe integer, default 20. `--tz` is cron-only and resolves to an explicit
IANA timezone when the job is created. Without it, the current system timezone is resolved and
captured once. Changing the system timezone does not change an existing cron job. Options must
precede `--`. Without options, the remaining text is the prompt. Exactly one separating whitespace
character after the schedule or `--` is consumed; the remaining prompt, including trailing spaces
and newlines, is preserved. Cron accepts single or double quotes; only the matching quote and
backslash may be escaped inside that argument. Prompt text is never shell-expanded or re-parsed as
a slash command, shell command, skill invocation or saved prompt reference.

Production: `parseLoopCommand` in [parser.ts](../../packages/code/src/features/loop/parser.ts),
`loopInterval`, `loopTimezone` and `createLoopCalendar` in
[loop-schedule.ts](../../packages/code/src/core/loop-schedule.ts), and `parseSlashCommand` in
[autocomplete.ts](../../packages/code/src/views/input/autocomplete.ts).
Test: the duration, literal-tail, options, quoting, UTF-8 payload and cron dialect cases in
[loop-schedule.test.ts](../../packages/code/tests/unit/loop-schedule.test.ts), and
`/loop keeps invalid input for correction and presents the exact prompt without submitting a turn`
in [app-shell-render.test.tsx](../../packages/code/tests/integration/app-shell-render.test.tsx).

## Time and bounded admission

An interval first becomes eligible one full duration after registration. Later intervals start
after the preceding occurrence's result, stored reconciliation and physical closure have settled.
For example, a five-minute job created at 10:00 is due at 10:05; if it starts at 10:16 and finishes
at 10:18, it is next due at 10:23. Elapsed time measures intervals; the wall clock supplies display
timestamps. Cron remains a calendar schedule. Missed calendar times coalesce into one pending
occurrence representing the latest eligible instant. DST gaps are skipped; repeated local minutes
use only their first occurrence, including zones with half-hour transitions. Previously observed
cron instants form a high-water mark that survives pause/resume, so a backwards clock adjustment
cannot replay them.

There is one cancellable host wakeup, capped at thirty seconds for re-evaluation, one pending
occurrence per job and one admitted automatic occurrence per host. Overdue jobs use their first
pending eligibility and a stable sequence for fair ordering; coalescing updates the represented
cron time without moving that pending job behind later arrivals. Waking after delayed timer delivery
does not replay every missed occurrence. Timers are unreferenced and disposed with the host.

The bounds are ten live (`scheduled` or `paused`) jobs per conversation, one hundred retained jobs
across the TUI, and 64 KiB of UTF-8 prompt text per job. At the host cap, the oldest terminal job
without an active run can be evicted; live registrations are never silently removed. The attempt
limit counts each admitted reservation, including preparation failure. A busy refusal does not
count. Reaching the limit after success completes the job; a failed final attempt stays visibly
paused and cannot resume beyond the limit.

Production: `LoopClock`, `systemLoopClock` and `createLoopCalendar` in
[loop-schedule.ts](../../packages/code/src/core/loop-schedule.ts), and `arm`, `tick`, `scheduleWake`,
`settle` and `create` in [controller.ts](../../packages/code/src/features/loop/controller.ts).
Test: elapsed-time, calendar coalescing, backwards clock, fair ordering, bounded retention and
attempt-limit cases in [loop-controller.test.ts](../../packages/code/tests/unit/loop-controller.test.ts);
DST and timezone cases in [loop-schedule.test.ts](../../packages/code/tests/unit/loop-schedule.test.ts).
The calendar adapter wraps the pinned MIT-licensed Croner dependency without giving it a callback or
timer. It restricts the product dialect, verifies returned local dates and selects the first UTC
instant of repeated local minutes. Its bundled license text is retained in
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

## Turn ownership and interaction priority

`RunHost.scheduledBinding(true)` may materialize a conversation id without a user turn or model call.
`submitScheduledTurn` checks that binding and reserves synchronously before the first asynchronous
preparation step. It returns an admitted receipt (`executionId`, completion promise, scoped cancel)
or an explicit deferred/refused result. The scheduler never consumes `RunHandle.events` itself.

Human submissions already received, another reservation, session loading, active runs, stored
reconciliation, physically open handles, local shell commands and outstanding compaction all block
automatic admission. Draft text, attachments, autocomplete, overlays, a too-small terminal and
pending elicitation also defer it. These interaction gates do not approve or answer anything.
A human message arriving after reservation waits for preparation, then follows normal interactive
semantics, including steer once the handle is live. A scheduled occurrence always starts through
the common turn preparation path and never steers. Automatic preparation errors never restore or
overwrite a human draft.

The completion receipt waits for both semantic reconciliation and every physical handle owned by
the occurrence, including a normal continuation-unavailable fallback. Cancellation acknowledgement
alone cannot release this ownership. On the hosted backend, this includes the terminal index commit,
admission release and acknowledgement of the consumed controlled result; long recurring jobs can
reclaim completed foreground entries. Production: `driveHandle` in
[kernel-run-client.ts](../../packages/code/src/adapters/kernel-run-client.ts) and `commitTerminal` in
[registry.ts](../../packages/kernel/src/hosting/registry.ts). Test:
[kernel-run-client.test.ts](../../packages/code/tests/component/kernel-run-client.test.ts) and the
forty-turn reclamation case in
[hosted-registry.test.ts](../../packages/kernel/tests/component/hosted-registry.test.ts).
A scoped cancellation targets only that occurrence's last
handle, even when a later human turn owns interactive controls. Session and binding validity are
rechecked after asynchronous preparation and history recovery, preventing stale launches. Late
settlement or steering failure from an outgoing conversation cannot alter the new draft, status or
elicitation.

Production: `scheduledBinding`, `scheduledBusy`, `submitScheduledTurn`, `submitTurn`,
`submitPreparedTurn`, `runManaged` and `cancelCurrentRun` in
[run-host.ts](../../packages/code/src/run-host.ts); `ensureIdentity` in
[session.ts](../../packages/code/src/adapters/session.ts); interaction gates in
[App.tsx](../../packages/code/src/views/App.tsx).
Test: scheduled reservation, human preparation/steer races, closure/reconciliation ordering,
cancellation ownership, stale callbacks and compaction cases in
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts); identity-only creation in
[session.test.ts](../../packages/code/tests/component/session.test.ts); the complete loop controls,
draft, attachment, dialog and elicitation case in
[app-shell-render.test.tsx](../../packages/code/tests/integration/app-shell-render.test.tsx).

## Configuration and lifecycle

Bindings capture session id and live generation, owner, workspace, Agent Profile and a hash of the
effective execution configuration. Runtime composition includes settings, resolved profiles and
agent records; RunHost includes the current guard/judge, memory, plan provider/policy, task binding
and Extension Profile identity. Only the fingerprint and a readable agent/model label are retained
in the job. Current runtime permission checks still apply to every ordinary run.

| Event | Registration behavior | Current execution |
| --- | --- | --- |
| Pause | Increment revision, discard pending work, remove next due time | May finish |
| Resume | Require no active occurrence and remaining attempts; revalidate and capture current binding; calculate a future due time | Never replay an old occurrence |
| Cancel | End registration and discard pending work | May finish |
| Cancel with `--running` | End registration and record cancellation request/ACK/failure | Request cancellation only of its owned execution; await physical closure |
| Switch or reopen conversation | Pause old registrations and invalidate callbacks; show them paused on return | Normal RunHost teardown |
| Clear/delete conversation | Cancel its registrations, including an inactive conversation's jobs | Normal RunHost teardown for the selected conversation |
| Agent/configuration or task binding changes | Pause with a visible reason; resume explicitly | Existing run retains normal ownership |
| Connection or runtime safety gate fails | Pause; reconnect alone does not resume | Unknown result requires inspection |
| Failure, budget exhaustion, cancellation or unknown reconciliation/closure | Pause; no automatic retry of possible partial effects | Normal run lifecycle |
| TUI closes | Stop wakeups, invalidate and forget registrations | Normal application teardown |

Production: binding composition and reconnect/delete/close hooks in
[runtime.tsx](../../packages/code/src/runtime.tsx), `teardownRuns` in
[run-host.ts](../../packages/code/src/run-host.ts), and lifecycle methods in
[controller.ts](../../packages/code/src/features/loop/controller.ts).
Test: the binding/lifetime, failure and cancel matrices in
[loop-controller.test.ts](../../packages/code/tests/unit/loop-controller.test.ts), and late
preparation, Ctrl-C, reconciliation and cancellation cases in
[run-host.test.ts](../../packages/code/tests/component/run-host.test.ts).

## Presentation and coupling

Creation and explicit resume open details showing id, exact prompt, conversation, agent/model,
schedule/timezone, attempt limit and next eligibility. Details also show pending or active
occurrences, scheduled versus actual admission time, execution id, cancellation outcome, last result
and accumulated measured usage. Missing token or price data remains unknown; a later successful
run does not turn an unknown aggregate into an invented zero. List/detail updates are separate
from transcript publication. Occurrence notices append to the matching live conversation generation;
no existing prompt or committed transcript row is rewritten and no automatic admission requests
the human-submit scroll-to-tail action. Normal run messages and traces persist; registration
metadata and live scheduling notices are not a new persisted scheduler ledger.

Production: `LoopView` in [view.tsx](../../packages/code/src/features/loop/view.tsx), `turnCompletion`
in [run-host.ts](../../packages/code/src/run-host.ts), `settle` in
[controller.ts](../../packages/code/src/features/loop/controller.ts), and the notice callback in
[runtime.tsx](../../packages/code/src/runtime.tsx).
Test: visible details and in-place controls in
[app-shell-render.test.tsx](../../packages/code/tests/integration/app-shell-render.test.tsx), usage
aggregation in [loop-controller.test.ts](../../packages/code/tests/unit/loop-controller.test.ts), and
unavailable reconciliation/usage in [run-host.test.ts](../../packages/code/tests/component/run-host.test.ts).

This feature belongs to `@clarvis/code`. It adds no kernel/protocol scheduling service, persisted
session schema or path, agent scheduling tool, workflow scheduler, external-task dispatcher or
cross-process exclusion. Two independent TUIs can independently schedule equivalent prompts. The
normal contracts remain [code-run-host.md](code-run-host.md), [sessions.md](sessions.md),
[protocol.md](protocol.md), [code-input-and-overlays.md](code-input-and-overlays.md),
[code-keyboard.md](code-keyboard.md) and [code-transcript-stability.md](code-transcript-stability.md).
