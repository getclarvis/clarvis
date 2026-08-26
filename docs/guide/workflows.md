# Workflows

> Turn repeatable multi-agent work into a reviewed sequence of focused rounds with explicit inputs
> and bounded fan-out.

## Use a built-in workflow

Clarvis includes `audit`, `implement`, and `research`. Select Admiral through `/agent`, then ask for
the workflow by name:

```text
Use the audit workflow to review the authentication changes. Explain the work and cost before
running it.
```

Clarvis presents a workflow review before any leader starts. Approve it only after checking the
rounds, selected agents, and expected fan-out.

::: warning
Workflow execution always needs an interactive review. Headless print mode can explain a workflow
but cannot approve and run it.
:::

## Author a workflow

Create this structure:

```text
.clarvis/workflows/release-review/
├── WORKFLOW.md
└── briefs/
    └── inspect.md
```

Add `.clarvis/workflows/release-review/WORKFLOW.md`:

```md
---
name: release-review
description: Review a release target through one evidence-gathering leader.
args:
  - target
rounds:
  - id: inspect
    title: Review {{args.target}}
    type: free
    profile: explorer
    over: once
    brief: briefs/inspect.md
---

Summarize the review for a human. Lead with blockers, then risks, then evidence that the target is
ready.
```

Add `.clarvis/workflows/release-review/briefs/inspect.md`:

```md
Review {{args.target}} for release readiness.

Inspect manifests, release notes, public documentation, and the checks that cover the changed
surface. Return concrete blockers and risks with repository paths. Do not modify the workspace.
```

The workflow directory and frontmatter `name` must match. The first round must use `over: once`.
Brief paths are relative to the workflow directory.

## Run your workflow

Select Admiral and ask:

```text
Use the release-review workflow for target 0.0.1-beta. Explain its cost before running it.
```

Arguments such as `target` are required when declared. `/workflow` is the run-history and agent-tree
browser; it is not a workflow-definition editor or launcher.

## Add more rounds

Each round declares:

- a unique `id`;
- a `type`: `discovery`, `findings`, `verdict`, or `free`;
- an optional agent `profile`;
- an `over` selector;
- a short `title`; and
- a relative `brief` path.

Selectors are intentionally small:

- `once` runs one leader;
- `each(scan.items)` runs one leader per item;
- `each(scan.items where needs_verification)` filters truthy items;
- `each(scan.items where severity = high)` filters by value; and
- `all(scan.items)` sends the full collection to one leader.

Use `fanout` only for genuinely independent copies of a round. Repeated rounds can stop after no new
results or at a configured budget boundary.

## Control workflow resources

Optional settings apply to the whole workflow tree:

```json
{
  "workflows": {
    "max_concurrency": 4,
    "budget_tokens": 262144
  }
}
```

The concurrency default is `4` and the maximum is `20`. The token budget defaults to `262144`; use
`null` only when you intentionally want no workflow token ceiling.

::: warning Beta budget limitation
A manager model call reserves up to its maximum output multiplied by all configured attempts while
it is in flight. With a large-output model, that reservation can temporarily consume the remaining
workflow budget, refuse a concurrent leader, and cause the rest of a `run_work_items` batch to be
skipped. Before relying on fan-out, set `budget_tokens` high enough to leave headroom beyond that
reservation and verify every expected leader in `/workflow`; use `over: once` when that cannot be
guaranteed.
:::

Workspace workflows replace same-named global or built-in workflows as a whole. A malformed
override is ignored, leaving the valid lower-precedence definition available.

## See also

- [Agents](/guide/agents)
- [Daily use](/guide/daily-use)
- [Scopes and workspace trust](/explanation/scopes-and-trust)
- [Troubleshooting](/operations/troubleshooting)
