# When configuration is rejected or pending

1. For an invalid settings document, inspect the exact validation error, check the supported fields in the settings reference and the Settings interface, then correct the requested scope and retry the file operation. Do not move the same bytes to another path.
2. For untrusted workspace configuration, inspect the workspace trust status through the operator Settings surface. Only the operator's existing trust control can approve the specific executable inputs; editing a file or loading this skill cannot do it.
3. For a selected profile mismatch, inspect the effective Extension Profile and its exact standalone skill or plugin references. A standalone skill in a custom profile may be inactive because it was not selected or belongs to a different scope. Repository plugin contributions and other executable workspace inputs may be withheld by workspace trust; a standalone skill file alone does not require that approval.
4. For a disabled capability, compare the entry agent's grants and immutable ceiling with the selected runtime placement. An unavailable `load_skill` or file tool cannot be restored by skill text.
5. For a write that succeeded but is not effective, check whether the result says refresh pending or reconnect required. A captured run keeps its old skill/resources; a later safe snapshot can see a refreshed catalog. Provider, placement or profile changes may need reconnect.
6. For a denied file or shell action, distinguish execution authorization from settings validation. Inspect the denial and effective Sandbox policy; configuration metadata has no write exemption. Use the supported approval control for an eligible new attempt. A missing Sandbox backend requires fixing the backend or an explicit allowed Host choice, never an automatic retry on Host. An uncertain outcome requires checking for effects before retrying.

Goal tools, Memory tools, skill reads, `ask_user`, built-in workflow
results and generated workflow titles ignore extra fields. A validation error on these operations
requires checking the expected fields, their types, bounds and meaning. Extra fields do not grant
permissions or change session ownership, budgets or evidence. Settings, external tools and custom
result schemas retain their own validation rules.

Goal Steward reviews are routed by their verdict: `achieved` accepts the report, `needs_work`
returns work to the main agent, and `needs_evidence` asks that agent for clarification. The optional
message explains the decision; missing or unusable commentary receives generic guidance. Extra
fields and auxiliary assessments do not block a recognized verdict. A missing or unsupported verdict
gets one correction; repeated invalid output is reported as an unusable result, not a transit failure.
Cancellation, changed Goal state, required human acceptance and consumption limits remain host checks.
