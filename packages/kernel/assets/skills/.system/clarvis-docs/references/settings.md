# Settings and supported changes

Read the existing global and workspace settings before editing. The host validates the complete document when loading settings or handling a Settings-interface update; a direct file-tool edit has no configuration review before it is written. Unknown top-level keys are rejected when loaded. Preserve unrelated keys and structure; make only the requested change and check the effective configuration afterward. Use any validation error to correct a rejected field. If a requested key is not documented here or visible in the Settings interface, do not invent its spelling or value: explain the gap and use the Settings interface when it exposes the operation.

Common supported fields are `default_model` (a `provider/model` token), `default_reasoning_effort` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`), `providers` (an array), `budget`, and `sandbox`. A provider entry has a `name` using lowercase letters, digits, `_` or `-`, and a `kind`: `openai-compatible`, `openai`, `anthropic`, `google`, `openai-codex`, or `xai-grok`. An `openai-compatible` provider needs `base_url`; `api_key_env` names an environment variable, never the key value. Optional `models` is keyed by model ID and can declare `context_window_tokens`, `max_output_tokens`, `capabilities`, `reasoning_efforts`, and `prompt_cache`. Do not claim a model or provider is usable merely because the entry parses; credentials, model availability and provider connection are separate checks.

For example, a request to use a configured provider's model can change only `"default_model": "provider/model"`. Native isolation uses a `sandbox` block whose `type` is `native`, with optional `enabled`,
`availability` (`required` or `optional`), `filesystem` (`workspace-write` or
`workspace-read-only`), and `network` (`host` or `none`). It applies to shell commands and file
tools. Sandbox can read host-visible files but writes only to admitted roots. A saved provider or isolation change may need reconnect before it affects a run.

Credential values belong to provider login or the private credential store, not agent-authored `settings.json`. Operator Settings, workspace trust, Extension Profile selection, and other administrative controls have their own host interfaces. If the user asks for one scope, do not silently edit another.
