# `@clarvis/tasks`

Provider-neutral external task management for Clarvis. The package owns the
canonical task domain, strict schemas, MCP `clarvis.tasks.v2` adapter, run
capability and provider conformance harness.

It depends only on `@clarvis/capability`, `zod`, and Node built-ins. It never
imports the loop, kernel, protocol, MCP SDK, terminal UI, or a product SDK.
External systems remain authoritative; the only durable Clarvis state is the
minimal task binding and content-free uncertain-write replay metadata stored
with a run.

## Contract

The canonical domain, provider protocol, schemas, errors, MCP adapter, and conformance harness are
specified in [`tasks-domain.md`](../../specs/capabilities/tasks-domain.md). Run binding, tools,
settings, gates, and kernel composition are specified in
[`tasks-capability.md`](../../specs/capabilities/tasks-capability.md).

Public entries:

- `@clarvis/tasks` — domain/provider contracts, schemas, errors, MCP adapter and provider key;
- `@clarvis/tasks/capability` — grants, canonical model tools and run capability;
- `@clarvis/tasks/settings` — the `tasks` settings block and `task` request parameter;
- `@clarvis/tasks/testing` — provider conformance cases usable without a kernel or TUI.

## Observability

The package writes to an injected `Logger` (`@clarvis/capability`), defaulting to `NOOP_LOGGER`. The
kernel supplies `componentLogger("tasks")` to `createTasksCapability`, `createMcpTaskProvider` and
`probeMcpTaskCapabilities`. There is **no `log_level` key** in the `tasks` block and no request
parameter; verbosity is `CLARVIS_LOG_LEVEL` / `CLARVIS_LOG` only.

| Level | `event`                           | Fields                                                                                                |
| ----- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| info  | `tasks.tool.gated`                | `tool`, `gate` (`writes_disabled`/`inspect_mode`/`missing_grant`/`not_advertised`), `grant`, `intent` |
| warn  | `tasks.provider.unresolved`       | `owner`, `requested_key`, `code`, `cause`                                                             |
| debug | `tasks.provider.call` (sampled)   | `tool`, `duration_ms`, `ok`, `code`, `provider_instance_id`                                           |
| warn  | `tasks.provider.invalid_response` | `tool`, `zod_issues[]` (paths only), `outcome`                                                        |
| error | `tasks.outcome_unknown`           | `task_id`, `operation`, `idempotency_digest`, `reread_ok`, `reread_error`                             |

Never logged: `clarvis_context`, a tool's arguments, a raw provider response, the MCP declaration the
`${VAR}` credentials are interpolated into, or any task title, description or comment body. A Zod
projection failure contributes its **paths** and never its messages or inputs, because those quote the
provider's own payload.

The persisted trace is the user-facing half. `safeDetail` in `src/trace.ts` is an **allowlist**, and
the only free text on it is `message`: the provider's own stated reason, carried by
`task_operation_failed`, `task_conflict` and `task_outcome_unknown` alone — the four
non-failure kinds describe a call that did what it was asked and have nothing to explain. It is
remote-authored, so it is normalized by `sanitizeTaskText`, redacted by `sanitizeErrorMessage` (the
only pass applying the coarse high-entropy rule; a registered projector's output bypasses
`capDetail`), collapsed to one line and bounded at `TASK_TRACE_MESSAGE_MAX` (500 characters, matching
`@clarvis/trace`'s `SUMMARY_MAX`). Everything else the allowlist refuses stays refused —
`clarvis_context`, a tool's arguments, `response.data` and the provider declaration above all.

Run package checks from the repository root with:

```bash
bun --filter @clarvis/tasks build
bun --filter @clarvis/tasks typecheck
bun --filter @clarvis/tasks lint
bun --filter @clarvis/tasks test
bun --filter @clarvis/tasks test:coverage
```
