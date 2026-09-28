# Agents and extensions

Agent Profiles are Markdown definitions in `<global>/agents/` or `<workspace>/.clarvis/agents/`; their grants still meet the run's immutable ceiling. Extension Profile definitions live in each scope's `extension-profiles/` directory. `builtin:default` discovers valid standalone skills from the standard user and workspace roots automatically. A custom Extension Profile selects exact installed plugin and standalone skill identities. A definition on disk is not selected merely because it exists for a custom profile. Workspace settings, Agent Profiles, shared prompts and repository plugins can be withheld by workspace trust; a standalone skill file alone does not trigger workspace approval.

Standalone skills use `SKILL.md`; plugins may contribute skills and other capabilities. Workflow definitions live in each scope's `workflows/` directory and follow their own parser and activation path. Use the Extensions interface to inspect installed identities, selected membership, and trust state. A skill written during a run is not injected into that run's captured catalog. The next run can discover a new skill after a safe catalog refresh; `builtin:default` includes valid standalone skills automatically, while a custom profile requires the skill's exact identity to be selected. Do not ask the operator for workspace trust merely because a standalone skill was created. If the effective state actually reports `unapproved`, `changed`, or a missing skill, name that observed state and the affected surface. Changes to selected profile, provider or placement can report reconnect required; do not describe a saved file as already active in the current run.

A `WORKFLOW.md` without `control` keeps fixed `rounds` and optional `repeat`. For an authored
manager-controlled workflow, use `control: manager`, `objective`, `completion.criteria` (1–16
entries with unique `id` and `description`, optionally `requires_completed_stages`), `stages`
(1–16 declared `once` entries with `id`, `type`, `title` and relative `brief`), and
`max_dispatches` (1–16). Do not combine these with `rounds` or `repeat`; built-ins remain fixed.
`run_workflow` still asks for one human preflight, but approval opens at `awaiting_manager`
without starting a leader. Inspect `workflow_status` for criteria and admitted evidence refs;
pass `evidence_ref` to read bounded detail. `workflow_decide` with current `session_id`,
`revision`, `reason` and `decision: complete` needs one evidence-backed assessment per criterion
and a disposition for each known leader failure. `dispatch` supplies a declared `stage_id` and
`gap` for one leader; `stop` supplies `remaining_gaps` and does not claim sufficiency. Evidence
provided by the user is not proof that Clarvis ran a test. A failed optional leader remains in
the operational record even if the manager judges the objective sufficient. Invalid or stale
decisions do not start work; after the dispatch cap, complete or stop remains possible.
