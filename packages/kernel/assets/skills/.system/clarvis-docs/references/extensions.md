# Agents and extensions

Agent Profiles are Markdown definitions in `<global>/agents/` or `<workspace>/.clarvis/agents/`; their grants still meet the run's immutable ceiling. Extension Profile definitions live in each scope's `extension-profiles/` directory. `builtin:default` discovers valid standalone skills from the standard user and workspace roots automatically. A custom Extension Profile selects exact installed plugin and standalone skill identities. A definition on disk is not selected merely because it exists for a custom profile. Workspace settings, Agent Profiles, shared prompts and repository plugins can be withheld by workspace trust; a standalone skill file alone does not trigger workspace approval.

Standalone skills use `SKILL.md`; plugins may contribute skills and other capabilities. Workflow definitions live in each scope's `workflows/` directory and follow their own parser and activation path. Use the Extensions interface to inspect installed identities, selected membership, and trust state. A skill written during a run is not injected into that run's captured catalog. The next run can discover a new skill after a safe catalog refresh; `builtin:default` includes valid standalone skills automatically, while a custom profile requires the skill's exact identity to be selected. Do not ask the operator for workspace trust merely because a standalone skill was created. If the effective state actually reports `unapproved`, `changed`, or a missing skill, name that observed state and the affected surface. Changes to selected profile, provider or placement can report reconnect required; do not describe a saved file as already active in the current run.

A `WORKFLOW.md` without `control` keeps fixed `rounds` and optional `repeat`. For an authored
manager-controlled workflow, use `control: manager`, `objective`, `completion.criteria` (1–16
entries with unique `id` and `description`, optionally `requires_completed_stages`), `stages`
(1–16 declared `once`, `each(<stage>.<field>)` or `all(<stage>.<field>)` entries with `id`,
`type`, `title` and relative `brief`, optionally `replicas: { min, max }` up to 8), and
`max_dispatches` (1–16). Do not combine these with `rounds` or `repeat`. The shipped `audit`,
`implement` and `research` workflows use manager control with an eight-dispatch limit. Their
preflight previews selectable stages and replica ranges: audit verify admits 2–3 replicas,
research and implement verify admit two; implement build is mutating with one. These are options,
not a required discovery→review→verify sequence. An operator-authored same-name fixed document
replaces the complete built-in definition and keeps its fixed preflight and rounds.
`run_workflow` still asks for one human preflight, but approval opens at `awaiting_manager`
without starting a leader. Inspect `workflow_status` for criteria, admitted evidence refs and
eligible candidates (up to 16 per `page`); pass `evidence_ref` or `item_ref` for bounded detail.
`workflow_decide` with current `session_id`,
`revision`, `reason` and `decision: complete` needs one evidence-backed assessment per criterion
and a disposition for each known leader failure. `dispatch` supplies a declared `stage_id`, `gap`,
`source_invocation_id` for sourced stages, and every current candidate as selected `items`
(`item_ref`, `replicas`), `skipped` (`item_ref`, `reason`), `deferred` (`item_ref`, `gap`) or
`covered` (`item_ref`, completed `invocation_id`). A failed later source attempt requires
`acknowledge_failed_source: true` to reuse an earlier completed result. The approved replica range,
profile, accept rule, dependencies and cumulative leader budget are enforced before starting any
part of the batch. `stop` supplies `remaining_gaps` and does not claim sufficiency. Evidence
provided by the user is not proof that Clarvis ran a test. A failed optional leader remains in
the operational record even if the manager judges the objective sufficient. Invalid or stale
decisions do not start work; after the dispatch cap, complete or stop remains possible. Repeating
completed items needs a new gap; no stage or repeat starts automatically.
Before dispatch, check the objective and admitted evidence. Complete without a leader only when
that evidence actually supports the deliverable and any required validation. An assertion that a
file changed or a test passed is not proof of its execution. If a blocking gap is treatable,
select justified items/replicas and account for every candidate; otherwise stop with limitations.
A leader's `needs_verification` suggestion does not prevent choosing another consequential finding.
For verdict stages, `accepted` means the refutation threshold matched; `rejected` is not
confirmation. Failed or partial implementation needs inspection of its effects before a sufficient
claim. Deterministic tests do not establish how a particular model will judge these cases.
