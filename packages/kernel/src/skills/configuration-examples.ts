/** Authored examples embedded verbatim in the builtin guide and exercised through real loaders. */
export const CONFIGURATION_EXAMPLES = {
  model: {
    path: "settings.json",
    language: "json",
    content: `{
  "providers": [{
    "name": "local", "kind": "openai-compatible",
    "base_url": "http://127.0.0.1:11434/v1",
    "models": {"example-model": {
      "context_window_tokens": 32768, "max_output_tokens": 4096,
      "capabilities": ["tool_calling"]
    }}
  }],
  "default_model": "local/example-model",
  "budget": {"total_token_limit": 100000, "on_exceed": "stop"}
}`,
  },
  reviewer: {
    path: "agents/reviewer.md",
    language: "yaml",
    content: `---
description: Review a bounded change and report actionable findings.
grants: [read_workspace, use_skills]
tools: []
iteration_limit: 20
---
Read the delegated brief and relevant files. Report verified findings with evidence and remaining
uncertainty. Do not edit files. Return a concise result to the parent.`,
  },
  marshall: {
    path: "agents/marshall.md",
    language: "yaml",
    content: `---
can_spawn: [coder, explorer, planner, reviewer]
default_spawn: coder
---`,
  },
  extensionProfile: {
    path: "extension-profiles/review.json",
    language: "json",
    content: `{
  "schema_version": 1,
  "description": "Review tools and the workflow launcher",
  "plugins": [{"scope": "global", "source": "clarvis", "name": "review-tools"}],
  "skills": [{"scope": "user", "source": "clarvis", "name": "review-project"}]
}`,
  },
  plugin: {
    path: "plugins/review-tools/plugin.json",
    language: "json",
    content: `{
  "name": "review-tools",
  "description": "Local review extension",
  "version": "1.0.0"
}`,
  },
  extensions: {
    path: "settings.json",
    language: "json",
    content: `{
  "marketplaces": ["https://example.invalid/clarvis-marketplace.git"],
  "enabledPlugins": [{"scope": "global", "source": "clarvis", "name": "review-tools"}]
}`,
  },
  mcp: {
    path: "settings.json",
    language: "json",
    content: `{
  "mcpServers": {
    "docs": {
      "type": "http", "url": "https://example.invalid/mcp",
      "bearer_token_env_var": "DOCS_API_TOKEN", "enabled_tools": ["search"]
    },
    "tasks": {"type": "stdio", "command": "example-tasks-server", "args": []}
  }
}`,
  },
  hooks: {
    path: "settings.json",
    language: "json",
    content: `{
  "hooks": [{
    "event": "pre_finalize", "type": "command", "command": "bun run check",
    "timeout_ms": 60000, "on_failure": "deny"
  }]
}`,
  },
  capabilities: {
    path: "settings.json",
    language: "json",
    content: `{
  "memory": {"enabled": true, "provider": {"kind": "wiki"}},
  "plans": {"mode": "review", "retention": "keep", "provider": {"kind": "markdown"}},
  "goals": {"max_net_tokens": 100000, "max_auto_continuations": 8, "max_no_progress_checkpoints": 3},
  "tasks": {
    "provider": {"kind": "mcp", "server": "tasks", "protocol": "clarvis.tasks.v2"},
    "writes": "disabled"
  },
  "workflows": {"max_concurrency": 2, "max_total_leaders": 8, "budget_tokens": 100000},
  "agents": {"max_live_children": 8}
}`,
  },
  workflowBrief: {
    path: "workflows/review-project/briefs/review.md",
    language: "text",
    content: `Review {{args.scope}} using the available read tools. Report concrete evidence,
findings and unverified areas. Do not modify files or claim checks that were not run.`,
  },
  workflow: {
    path: "workflows/review-project/WORKFLOW.md",
    language: "yaml",
    content: `---
name: review-project
description: Review a requested scope with an independent leader.
args: [scope]
rounds:
  - id: review
    type: free
    profile: explorer
    over: once
    title: Review the requested scope
    brief: briefs/review.md
---
Synthesize the leader's evidence, actionable findings and remaining uncertainty.`,
  },
  workflowSkill: {
    path: "skills/review-project/SKILL.md",
    language: "yaml",
    content: `---
name: review-project
description: Run the review-project workflow for the requested scope.
agent: admiral
---
Use the user's invocation text as args.scope; ask for scope if it is absent.
Call run_workflow with name review-project, args containing scope, and explain true first.
Then call it without explain to request human preflight. Inspect workflow_status and use the
current session_id and revision with workflow_decide at any checkpoint. Report actual outcomes.`,
  },
  runtime: {
    path: "settings.json",
    language: "json",
    content: `{
  "runtime": {"backend": "docker"},
  "guard": {"type": "shell", "mode": "on"}
}`,
  },
} as const;

/** Render the same filename and bytes validated by the configuration guidance regression suite. */
export function configurationExample(name: keyof typeof CONFIGURATION_EXAMPLES): string {
  const example = CONFIGURATION_EXAMPLES[name];
  return `Example ${example.path}:\n\n\`\`\`${example.language}\n${example.content}\n\`\`\``;
}
