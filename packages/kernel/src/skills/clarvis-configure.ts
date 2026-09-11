import { configurationExample } from "./configuration-examples.ts";

/** Product-owned configuration reference, bundled with the executable and disclosed on demand.
 * Examples are configuration fragments, not a replacement for the user's current documents. */
export const CLARVIS_CONFIGURE_SKILL = {
  name: "clarvis-configure",
  description:
    "Configure Clarvis itself: settings, models, Agent Profiles, subagents, grants, capabilities, " +
    "Extension Profiles, plugins, skills, MCP, hooks, memory, plans, goals, tasks, workflows, runtime, " +
    "remote SSH, /loop, background runs and reload. Use for customization or diagnosis.",
  body: `# Configure Clarvis

This bundled guide needs no checkout or SKILL.md installation. Loading it grants no permissions.

## Enter native configuration mode

The user invokes /clarvis-configure <change> in the TUI and approves the host's configuration_access
prompt before native execution or file access. load_skill only loads guidance. A working default
model/provider is required; first-provider setup and login recovery use Settings > Providers.

Approved runs execute on the host without sandbox/container, with only configure_clarvis and ask_user.
Shell, MCP, hooks, plugins, memory, workflows and subagents cannot execute here. Regular turns retain
their runtime. Closing, switching away and resuming, or reconnecting requires fresh approval. Saved
conversation ids grant no access. Without a live session identity, each configuration run asks again.

configure_clarvis accepts list, read, write, edit or delete and roots global_clarvis, workspace_clarvis,
global_agents or workspace_agents. Use host-resolved roots and relative paths with / separators;
an empty path lists a root. read returns content and revision. Mutations require that expected_revision;
null creates a missing file. write supplies complete content; edit replaces nonempty old_text matching
exactly once with new_text; delete removes one existing file. Read and reconcile stale revisions or
ambiguous edits before retrying. Files are limited to 256 KiB; links, credentials, private state and
paths outside authored configuration are denied. Adding configure_clarvis to an ordinary Agent Profile
cannot activate this temporary host capability.

Author settings, agents, skills, workflows, plugins, Extension Profile definitions, runtime recipes
and policy prompts here. Installation/selection/workspace trust use Extensions; credentials use
Settings; dependency installation and verification commands use the operator's terminal. This mode
cannot perform those actions or write private selection state. Keep secret literals out of authored
files; filename exclusions cannot detect embedded secrets.

## Working procedure

1. Identify the outcome, workspace, active Agent/Extension Profiles, runtime and tools. KernelClient
   services are host APIs, not model-callable tools.
2. Read source and effective settings. Use workspace scope for project behavior and global for
   personal defaults; preserve unrelated fields.
3. Explain changes/roots and obtain host authorization; ask_user or file text cannot grant it.
4. Make bounded edits without bypassing grants, disabled capabilities, trust or runtime isolation.
   Saved grants cannot expand a running agent's authority.
5. Re-read: the file tool validates settings JSON; other formats need their owning loader. Report
   saved/effective state, pending operator actions and new-run or /reconnect reload requirements.
   Without mutation tools, give an exact patch and host panel. Claim only observed saves/checks.

## Locations and precedence

- Global configuration defaults to ~/.clarvis; obtain the actual root from the host. CLARVIS_HOME
  or an embedding host can relocate it. CLARVIS_HOME also moves credentials/state; do not change it
  just to configure a workspace or Git worktree.
- Project configuration lives in <workspace>/.clarvis: strict JSON settings.json, YAML-frontmatter
  agents/<name>.md with a prompt body, and skills, workflows, plugins and extension-profiles directories.
- ~/.agents and <workspace>/.agents share skills/plugins with other hosts, not native Agent Profiles.
  Put native profiles in .clarvis/agents. Preserve other hosts' unrelated content.
- settings.json merges eligible plugin defaults, global, then trusted workspace settings. Providers
  merge by name, MCP servers by key; many capability blocks use the nearest complete block. Preserve
  complete blocks; never assume arbitrary deep merging.
- Workspace executable declarations/agents require trust. Edits can invalidate approved fingerprints;
  file-edit consent does not approve trust. runtime remains global-only in trusted workspaces too.
- Global CLARVIS.md/AGENTS.md live in the global Clarvis root; project context belongs at the WORKSPACE
  ROOT, outside these four roots. Use ordinary authorized workspace editing; <workspace>/.clarvis
  context files are not loaded. CLARVIS.md wins over AGENTS.md per scope; neither grants authority.
  guard-judge.md supplies the local Code judge prompt. Global/workspace memory-policy.md editorial
  policies combine.
- keys.json, subscriptions.json, auth.json, auth-key.json, workspace-trust.json, state/, cache/,
  OAuth records and environment secret values are not ordinary configuration documents. Use the
  operator's credential/login/trust interfaces; never copy credentials into prompts, skills or logs.

## Models, providers and budgets

A model reference is provider-name/model-id: the prefix names a configured instance, not necessarily
the vendor. Use the installed catalog/reasoning levels; never guess IDs, prices, limits or entitlements.
Adapt this fragment's model/port and merge the wanted fields; preserve the rest of the file.

${configurationExample("model")}

Supported provider kinds are openai-compatible, openai, anthropic, google, openai-codex and xai-grok.
api_key_env is a variable NAME, never its secret value. Keys/login remain operator-owned; configuring
openai-codex or xai-grok neither signs in nor converts subscriptions to API credit. Container localhost
differs from host localhost, and remote traffic may use the host broker. Diagnose the connection;
change endpoints/credential bindings only within the user's intended scope.

default_model and default_reasoning_effort override the entry agent. A spawned child keeps its own
model/effort when specified and otherwise inherits the resolved defaults. default_vision_model is a
one-completion image-reading fallback, not a new child agent or a vision grant. Model capabilities
such as tool_calling and vision describe the model; they do not authorize agent tools.

settings.budget supplies run defaults. An entry profile may provide its own budget; on_exceed is
required in an agent's budget. iteration_limit, call_timeout_ms, retry.max_retries,
retry.max_retry_after_ms, reasoning_effort, compaction and orchestration belong to
the Agent Profile. Use compaction.context_fraction as high water and target_fraction as low water;
target must not exceed context. compaction.prompt_mode: none cannot be combined with a custom prompt.
Host environment ceilings still apply. Raising a profile value cannot override them.

## Agent Profiles and subagents

An Agent Profile defines a persona's model, prompt, tools, grants, limits and spawning; an Extension
Profile selects installed extensions. Neither replaces the other. settings.json has no universal
capabilities toggle or agents-as-profile-array.

Clarvis ships marshall (coding lead), admiral (workflow lead), coder, explorer and planner as data.
Same-name files overlay authored fields/nonempty prompt bodies; omissions retain builtin defaults.
Arrays replace entirely: preserve wanted grants; [] clears a list. Workspace overlays replace global
overlays without merging them. Malformed builtin overrides leave the shipped default active. Custom
names have no fallback; avoid duplicates across scopes.

The file name is the profile identity:

${configurationExample("reviewer")}

The profile can omit model when a valid default_model exists. Give it an explicit provider/model
only when it should use a different model as a child. To let marshall spawn it, overlay
agents/marshall.md with the complete wanted can_spawn list:

${configurationExample("marshall")}

can_spawn names permitted children; default_spawn must be a member. Every reference must resolve;
self-spawn is invalid. The host assembles transitive reachability. Children inherit no parental
grants, tools or conversation. Shipped coder/explorer/planner have no can_spawn; validate the whole
topology with readiness diagnostics, not just the new child's name.

spawn_subagent starts independent bounded work. delegate_task is for an existing plan task and needs
its exact task_id. Supply a self-contained brief, context, scope and expected result. Children share
the workspace; avoid conflicting edits. A background handle means started, not completed. Use
await_agents to wait, agent_list for state, agent_poll for evidence, agent_steer to redirect and
agent_stop to cancel. Review results before completing a plan task. Live children block finalization.
settings.agents tunes supervision bounds such as max_live_children, max_retained_children,
buffer_bytes and max_total_buffer_bytes; it does not create Agent Profiles.

## Grants, tools and capability activation

Use the host's known_grants vocabulary. Unknown grants are rejected. A grant names permission for
an installed capability; writing an invented grant does not install or activate anything.

| Grant | Effect and additional gates |
| --- | --- |
| read_workspace | Workspace read tools. |
| edit_workspace | Mutation tools; implies workspace read. |
| run_commands | Command tools; implies edit and read. |
| ask_user | Questions to the user; honored only for the entry agent with an elicitation channel. |
| use_skills | Skill catalog, load_skill and read_skill_resource when skills are enabled. |
| workflow | Workflow orchestration; meaningful only with the host's workflow composition. |
| tasks.read | Task discovery and reads through the configured Tasks provider. |
| tasks.create, tasks.assign, tasks.comment | Corresponding remote task writes. |
| tasks.progress, tasks.review, tasks.complete | Corresponding task lifecycle operations. |

The coding grants are capped by CLARVIS_AGENT_TOOLS_ENABLED and CLARVIS_AGENT_TOOLS_MAX_GRANT
(none/read/edit/exec). The Code product defaults to exec, while the bare loop defaults to edit.
Grant read/edit/exec implications do not disable the command guard or isolation. The tools list is
the allow-list of pooled MCP tool names such as docs.search; it does not replace coding grants.
Use discovered canonical tool identities, including plugin namespaces, instead of inventing names.

Capability activation can require ALL of: host registration; a host/env enablement flag; valid
settings and a configured provider; selection in an Extension Profile; workspace trust; an Agent
Profile grant; a per-run mode; and provider support. Diagnose the absent layer in that order.
Memory and plans do not use invented memory/plans grants. A skill itself never adds grants.

## Extension Profiles, plugins and skills

Installing a plugin adds it to inventory. Activating it chooses its exact installation. A plugin
reference is {scope: global|workspace, source: agents|clarvis, name}. builtin:default activates
enabledPlugins and the four standard skill roots. Custom Extension Profiles are complete allow-lists;
they do not inherit builtin:default's installed plugin or standalone skill selection.

The following GLOBAL definition assumes the exact global review-tools plugin and the global
review-project standalone skill shown below have been authored or installed. Inventory them first;
do not invent installation references. An empty profile instead uses plugins: [] and skills: [].

${configurationExample("extensionProfile")}

Plugin scope is global|workspace; standalone skill scope is user|workspace, never global.
source: clarvis selects a Clarvis root; source: agents selects .agents. Match the installation exactly;
references are not paths, Git URLs or plugin:skill names. Plugin skills activate with the plugin,
outside the standalone skills array. Workspace definitions can use global/workspace resources;
global definitions allow only global plugins/user skills. Repeated runtime names are invalid across
roots too. Require schema_version: 1 and both complete arrays; this JSON has no agents, workflows,
providers, inherits or enabledPlugins fields.

Select through Extensions/Extension Profiles or --extension-profile global:review at launch
(workspace:review for a workspace definition). Authoring does not select it. Precedence: launch
override, workspace selection, global default, builtin:default. Changing a launch override requires
relaunch with the desired selector or no override; workspace selection shadows global defaults.
Invalid references are degraded, not silently replaced. Selection and pinned extension changes
require /reconnect reload with an idle host. Editing a definition does not recompose an in-flight run.

For activation, finish this configuration turn, open /extensions, preview the exact change in the
Extension Profiles controls, confirm selection and use /reconnect reload. Previews bind to current
revisions/fingerprints; stale previews must be refreshed. Workspace trust is a separate decision.
For renaming, create the new definition, select it, reload, then remove the inactive old one.
For deletion, first select another definition or clear the selection; never delete an active profile
to try to fall back. builtin:default is immutable. Report authored, selected and effective separately.

Native and compatible plugins contribute agents, MCP servers, hooks, skills and capability provider
executables. Use the marketplace/plugin installation interface; a marketplace listing alone enables
nothing. Global installation is operator-owned. Workspace executable inventories require trust.
Selecting a plugin does not silently select its memory/plan provider. Its hooks activate with the
plugin as one contribution; there is no separate per-hook approval record. Workspace-owned hooks
and other executable declarations remain covered by workspace trust.

For an authored native plugin, start with its manifest and add agents/*.md, skills/<name>/SKILL.md,
inline mcpServers/hooks, or capabilityExecutables as needed. A manifest with only identity contributes
no executable feature. Native plugin agents/MCP namespaces use <plugin>:<name>. Installed foreign
layouts may instead use .clarvis-plugin/plugin.json, .claude-plugin/plugin.json or .codex-plugin/plugin.json;
preserve their dialect and read loader diagnostics for unsupported keys rather than guessing conversion.

${configurationExample("plugin")}

To browse a marketplace and activate an exact installation under builtin:default, merge these
settings after replacing the example URL. A custom Extension Profile ignores enabledPlugins.

${configurationExample("extensions")}

Skill roots in ascending precedence: ~/.agents/skills, <workspace>/.agents/skills,
<global-Clarvis-root>/skills, <workspace>/.clarvis/skills; later names win. Reserved clarvis-configure
needs no file and survives empty custom Extension Profiles. User skill directories contain SKILL.md
and optional scripts/references/assets. agent routes user invocation to that profile; otherwise it
enters the current turn. load_skill takes only {name}. read_skill_resource takes {name, resource,
offset: 0}, then the returned byte offset. Missing required MCP dependencies can hide a model catalog
entry still listed in the UI. CLARVIS_SKILLS_ENABLED=false or host opt-out also disables this guide.

## MCP and lifecycle hooks

settings.mcpServers is a record keyed by server name, not an array. A stdio entry uses
{type: stdio, command, args, env?, cwd?}; an HTTP/SSE entry uses {type: http|sse, url, headers?}.
Declare env/header secret references using \${VAR}, bearer_token_env_var or env_http_headers, not
literals. Stdio env_vars lists additional environment variable NAMES to pass. Remote transports do
not accept command, args, env, cwd, shared or env_vars. Authentication remains operator-owned.
Choose enabled, required, enabled_tools and disabled_tools deliberately; allow/deny lists cannot
overlap. tools cannot activate missing/unauthenticated servers. Settings use type, not request DTO
transport. Plugin MCP tools join agent allow-lists automatically; standalone tools need canonical
names in the profile's tools. Server filters apply to both. Remote OAuth uses operator MCP controls.
stdio shared: true reuses a process across runs and disables its human elicitation.

${configurationExample("mcp")}

hooks is an array of lifecycle declarations, not prompt text. A command handler uses type: command
and command (optionally command_windows); an MCP handler uses type: mcp_tool, server, tool and input.
Gate events pre_tool_use, post_tool_use, pre_finalize and pre_delegate_task can block. Observer
events run_start, run_end, post_compact, subagent_start, subagent_complete, model_call_error,
budget_exhausted and user_steer cannot block; on_failure: deny is invalid there. session_start adds
entry context; pre_compact adds summarization context; user_prompt_expansion observes a skill launch.
match.tool (name/glob) and match.args (regexes) apply only to tool events. Choose timeout_ms and
on_failure deliberately. The example requires a real check script in the target project.

${configurationExample("hooks")}

Executable workspace declarations remain subject to workspace trust. Do not infer approval
from a skill's allowed-tools or a plugin bootstrapSkill. Hook settings changes are read per run;
plugin contribution changes may still require /reconnect reload.

## Memory, plans, goals and tasks

- memory: {enabled: true} configures execution memory; model can select an indexer model. The host
  must compose memory, and a run's memory: off disables it. The wiki, provider and editorial policies
  are separate. Use memory tools for wiki changes rather than editing indexes or queues. Container
  agents currently receive host-mediated memory reads; post-run indexing stays on the host.
- plans: {mode: on|off|review, retention: keep|discard} controls planning. review adds human plan
  approval before execution. Plans are kept by default; do not delete them as routine cleanup.
  Memory providers are wiki, file (paths), mcp, executable or plugin; plan providers are markdown,
  executable or plugin. Their kind is never builtin. A plugin selection uses {kind: plugin, plugin:
  <installed-name>}; it also needs that plugin active and its capabilityExecutables declaration.
  An executable selection uses kind, command, args and the supported executable settings; native
  configuration only authors that declaration and never launches it to check health.
  Memory's mcp provider needs server and tools mapping list_memories, read_memory, grep_memories and
  query_memories; write_memory, edit_memory and delete_memory are optional as a complete set.
- tasks requires a provider {kind: mcp, server: <configured-name>, protocol: clarvis.tasks.v2}.
  writes defaults to disabled. A remote write additionally needs provider support, the operation's
  tasks.* grant and the required task binding/mode. An uncertain remote result must be reconciled
  instead of blindly repeated. General MCP availability alone does not implement the Tasks protocol.

Merge only the capability blocks the user wants. This Tasks example also requires the matching MCP
server above, installed with clarvis.tasks.v2 support; a fake server name cannot activate Tasks.

${configurationExample("capabilities")}

goals configures /goal creation: max_net_tokens is the total cap, inheriting the finite entry budget
once if omitted. Defaults: max_auto_continuations=8, max_no_progress_checkpoints=3; deadline_at is
optional absolute Unix milliseconds. Nearest whole block wins. Settings neither create nor edit goals;
the operator uses /goal edit for existing limits. Resume keeps spend/counts. Workflows are unsupported.

## Author and configure workflows

Clarvis ships audit, implement and research. User definitions use
<Clarvis-root>/workflows/<name>/WORKFLOW.md with YAML frontmatter and a synthesis body; name matches
the directory. Create relative brief files first because writes are not a transaction. Edit only
while idle. Global definitions replace builtins; workspace replaces global entirely. Invalid or
deleted overrides may reveal a lower layer. Managers reload definitions per run, independently of
Extension Profiles. Workflows do not belong in profile arrays or settings.workflows.

This complete one-round example uses the shipped explorer as a leader and returns free text:

${configurationExample("workflowBrief")}

${configurationExample("workflow")}

Rounds require id, type, over, title and brief; profile, fanout, accept and when are optional. Title
is one line up to 60 code points. The first round uses over: once; later selectors use each(round.field)
or all(round.field), with optional where field or where field = literal only on each. These are fixed grammars.
discovery yields scope/evidence/work_items/unknowns; findings yields findings/coverage_gaps; verdict
yields finding_id/verdict/evidence/reason; free is unstructured. Briefs interpolate {{args.name}},
{{item}}, {{item.field}} and {{state.round.field}}; declare args and expose consumed fields.
fanout replicates a selected unit; accept uses all(field, value), any(field, value),
majority(field, value) or threshold(field, value, count). Failed replicas remain in the denominator.
repeat names rounds with until (no_new|budget), dedupe_by and max_rounds; it proposes but never
authorizes another pass. Limits: 16 rounds, 8 replicas, 8 repeat passes and 64 items.

Admiral carries workflow. Its tools start leader runs; each leader's can_spawn controls children.
Leaders cannot launch leaders: the host strips workflow and auxiliary plans/memory. Manager
can_spawn controls local children, not the workflow catalogue. Round profile selects a non-manager
leader; omission uses default_spawn. Custom managers need workflow and a valid spawn topology.

settings.workflows tunes max_concurrency (1..20), max_total_leaders (1..255) and budget_tokens
(positive output-token ceiling or null). This auxiliary budget and concurrency headroom do not erase
manager/profile iteration, child, model or budget limits.

For a slash launcher, author this separate skill and select it in a custom Extension Profile. Its
agent routes to Admiral. A workspace definition references
{scope: workspace, source: clarvis, name: review-project}.

${configurationExample("workflowSkill")}

After reload, invoke /review-project <scope> or ask Admiral for run_workflow. Preview launches no
leader. Execution needs human preflight; at awaiting_manager, inspect workflow_status and pass exact
session_id/revision to workflow_decide. Only authorized waves drain automatically. Missing inputs,
invalid selectors, rejection and exhausted budgets fail. Finish /clarvis-configure first: workflow
tools are absent here, and preview proves structure rather than provider health or future results.

## Remote VPS connections

--remote <destination> --remote-workspace <absolute-path> keeps the TUI local and runs Clarvis on the
SSH host. Both flags are required and conflict with --worktree. The remote installation owns files,
sessions, settings, OAuth, capabilities, tools and runtime; local credentials/config are not copied.
VPS browser/inspection/runtime-retry/reload controls are unavailable; /reconnect starts fresh SSH.

OpenSSH encrypts/authenticates the kernel stdio stream; Clarvis opens no listener or second crypto.
SSH aliases, keys, certificates and local ssh-agent work, with port/agent/X11 forwarding disabled.
Clarvis has no --identity-file/password store and does not force StrictHostKeyChecking/BatchMode.
Verify host key/login first and unlock protected keys in ssh-agent. /dev/tty or askpass prompts are
outside the TUI contract and may fail or disturb it. The VPS sees plaintext and remains trusted.

## TUI loops, background runs and reload

These are user-operated TUI commands, outside configure_clarvis and settings.json.
Offer exact commands and finish configuration first; loading guidance or emitting slash text cannot
create schedules, hand off runs or restart the host.

- /loop 5m --max-runs 8 -- check the PR comments
- /loop cron "0 9 * * 1-5" --tz America/Recife -- prepare the summary

/loop requires a user prompt. Intervals accept positive integer m/h/d, minimum one minute; 90m means
90 minutes. First due is one interval after creation; later intervals follow full run closure.
Cron requires one quoted expression of five numeric fields with *, lists, ranges or steps; Sunday is
0/7, restricted month-day/weekday use OR. The IANA timezone is captured at creation (--tz overrides local).
DST skips missing times and
uses the first repeated time. Cron keeps calendar deadlines and coalesces missed times into one
pending occurrence. Options precede --; everything after it is literal prompt, even /quit, /loop or
!command. Without options, the remaining text is the prompt; skill/workflow dispatch does not apply.

/loop [list] lists jobs; show <id> details one. pause/cancel discard pending work but let a run finish;
cancel <id> --running requests its cancellation. resume recalculates a future due; exhausted jobs
cannot resume. Limits: 10 live/session and 20 attempts/job unless --max-runs. Busy deferrals do not
count. Normal context, tools, approval and budgets apply. Drafts, attachments, dialogs and host work
defer; timers never steer. Failure, exhausted budget, cancellation, relevant config/session change or
disconnect pauses until resume. TUI closure forgets schedules; conversation resume restores none.

/background hands off the current eligible run, exiting after host confirmation of durable continuation.
Reopen the same workspace to choose that run or a new conversation. /background list shows runs;
/attach <execution-id> attaches exactly; another controller requires explicit takeover for control.
/background cancel <execution-id> requests scoped cancellation.
An ACK does not prove physical closure. Reattach observes the same execution/context and children
without resubmitting the prompt. "continues after exit" also survives /quit; new turns use ordinary
exit policy. Native configuration and local !commands cannot detach. Questions still need a person
and retain timeouts; detach never approves them or restores configuration consent on attachment.
Detach, takeover, disconnect and conversation close revoke native and container allow_session command
approvals. Reattach needs fresh approval when asked.
Normal isolation remains. The host must stay alive: crashes/reboots do not checkpoint-resume runs.
Reconcile uncertain results before retrying. For /loop, only an admitted run can continue;
the recurring schedule ends with the TUI.

/reconnect restores the connection to the same host; /reconnect reload restarts an idle host to apply
pinned configuration. Live/background runs can block reload: report saved-but-pending and wait for idle.
Both commands reject during current conversation preparation/execution, local shell or compaction.
Reload creates a new host generation, not a continuation of a run after host restart.

## Runtime, guard, environment and diagnosis

runtime chooses native, docker or podman and is global-only. {runtime: {backend: docker}} uses the
product defaults; Podman needs explicit settings. Use only qualified images/digests and supported
network modes. none is offline; outbound permits public, host and LAN destinations; internet is
currently refused. Docker may use its configured native Sandbox fallback after an operational
startup failure; integrity/policy/recipe failures stay closed. A started run is never replayed on
the host. Runtime recipes are operator-authored scripts under global runtime-recipes.
Docker's recipe block uses name, script (the absolute path under that root) and network
(none|outbound for the build). Save a POSIX-shell script first, then bind it in global settings.

${configurationExample("runtime")}

sandbox uses type: native, enabled, availability (required|optional), filesystem
(workspace-write|workspace-read-only), network (host|none) and optional toolchains/pass_env.
guard configures command approval. guard.mode is
on, off or auto. off disables command guard evaluation. With on or auto, denied_commands wins over
allowed_commands and an automatic judge cannot override a deny. auto needs a resolved judge;
absent/unavailable judging follows the documented
human/deny policy. Never describe guard.off as turning off filesystem or container isolation.
Environment flags and host builtins switches are startup inputs, not arbitrary settings.json keys.
Logging uses CLARVIS_LOG and CLARVIS_LOG_LEVEL, not a logging settings block. Relaunch with the desired
process environment; an existing hosted generation also needs an idle reload. UI preferences,
session history, provider authentication and plugin selection have their own host services rather
than new settings.json keys.

When a change appears ineffective: inspect settings parse errors and overlay rejection; verify the
winning scope, workspace trust, pinned Extension Profile, configured provider and current Agent
Profile; then check grants, host ceilings, run modes and model tool support. A successful save alone
does not prove activation. Do not repair an invalid document by discarding unrelated fields; use a
revision-bound host repair or show the minimal correction. Finish with the actual files/fields
changed and an explicit saved/effective/reload-required status.
`,
} as const;
