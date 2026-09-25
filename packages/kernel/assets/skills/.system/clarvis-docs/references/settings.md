# Settings and supported changes

Read the existing global and workspace settings before editing. The host validates the complete document when loading settings or handling a Settings-interface update; a direct file-tool edit has no configuration review before it is written. Unknown top-level keys are rejected when loaded. Preserve unrelated keys and structure; make only the requested change and check the effective configuration afterward. Use any validation error to correct a rejected field. If a requested key is not documented here or visible in the Settings interface, do not invent its spelling or value: explain the gap and use the Settings interface when it exposes the operation.

Common supported fields are `default_model` (a `provider/model` token), `default_reasoning_effort`
(`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`), `providers` (an array), and `budget`.
Execution Memory starts off in a fresh installation. The TUI's Ctrl+X M picker saves one
on/off choice in global `memory.enabled`; it applies across workspaces and restarts. Workspace
`memory` blocks may configure the wiki provider and budgets but cannot change activation.
When Memory is on, its indexer uses the model selected by the run, with no separate memory model.
A provider entry has a `name` using lowercase letters, digits, `_` or `-`, and a `kind`:
`openai-compatible`, `openai`, `anthropic`, `google`, `openai-codex`, or `xai-grok`.
An `openai-compatible` provider needs `base_url`; `api_key_env` names an environment variable,
never the key value. Optional `models` is keyed by model ID and can declare
`context_window_tokens`, `max_output_tokens`, `capabilities`, `reasoning_efforts`, and
`prompt_cache`. Credentials, model availability and provider connection are separate checks.
A provider change may need reconnect before it affects a run.

Credential values belong to provider login or the private credential store, not agent-authored `settings.json`. Operator Settings, workspace trust, Extension Profile selection, and other administrative controls have their own host interfaces. If the user asks for one scope, do not silently edit another.
