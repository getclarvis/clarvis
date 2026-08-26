# How Clarvis works

> Understand the few objects Clarvis uses so you can choose the right agent, follow delegated work,
> and keep long-running projects organized.

## Start with the operator loop

Clarvis is a terminal workspace around an agent run. You choose the workspace, agent, model, and
safety posture; describe an outcome; review any decisions that require you; and inspect the result.
The agent may read files, call tools, propose changes, delegate bounded work, or ask you a question,
but you remain responsible for the goal and the boundary.

```text
workspace -> session -> run -> lead agent -> tools and sub-agents -> result
```

A **workspace** is the project directory Clarvis is operating on. It determines which project files,
workspace configuration, and session history are in scope.

A **session** is the durable conversation for that workspace. It keeps the transcript and usage
across multiple turns. `/sessions` opens session history, `/export` writes the complete persisted
transcript, and `/clear` archives the current session before starting a fresh one.

A **run** is the active execution that follows one submitted task. While it is active, new input
steers that work instead of creating a competing run. `/status` shows the current agent, model, run
state, token usage, and cost.

## Agents define how work is done

An agent profile combines instructions with its model, reasoning effort, tool grants, budget, and
delegation policy. The active profile becomes the lead for the next run. Use `/agent` to switch it,
or `/settings/agents` to inspect and configure agents by scope.

The lead owns the final response. When delegation is available, it can send a planned task to a
sub-agent or spawn independent bounded work. Each child has its own profile, context, tools, and
budget. Results flow back to the parent; the activity view and transcript show who owns each branch,
its current state, and its completion result.

Delegation is useful when work can proceed independently. It is not free parallelism: every child
uses model context and tools, so the lead should delegate a clear objective and avoid duplicating the
same investigation.

## Workflows make orchestration reusable

A workflow describes a repeatable manager-and-agent arrangement for work that has a stable shape.
Use one when the same coordination pattern should be available again, rather than asking a lead to
invent the structure in every session.

Type `/workflow` to browse current and previous workflow runs and inspect their manager-to-agent
trees. Workflow definitions live in built-in, global, or workspace catalogs and are selected when
Admiral starts a workflow. A workflow organizes execution; the session transcript still records
what happened, and ordinary safety controls still apply to every tool call.

## Context is smaller than the transcript

The persisted session is the durable record. The model context is the bounded working set sent to a
model call. Clarvis may fold older transcript content out of the live view and compact older context
so an active session can continue without sending everything again.

Use `/compact` when you want to request that deliberately. Add a short preservation instruction when
specific decisions must survive:

```text
/compact preserve the accepted API shape and the unresolved Windows failure
```

Compaction does not replace the persisted transcript. Use `/export` when you need the complete
record, including material no longer mounted in the live view.

## Follow one run from start to finish

1. Clarvis resolves the effective global and workspace configuration.
2. You select the lead agent and safety posture for the next run.
3. Your task starts a run inside the current session.
4. The lead reasons, calls allowed tools, and optionally delegates work.
5. Clarvis pauses for required command, plan, or user decisions.
6. Child results return to their parent, and the lead produces the final response.
7. Events and transcript content remain associated with the workspace session for resume or export.

If the effective configuration cannot start safely, `/doctor` explains the blocking check and offers
the relevant repair surface.

## See also

- [Getting started](/getting-started)
- [Daily use](/guide/daily-use)
- [Agents](/guide/agents)
- [Workflows](/guide/workflows)
- [Scopes and workspace trust](/explanation/scopes-and-trust)
