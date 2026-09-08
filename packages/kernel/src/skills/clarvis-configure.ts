import { configurationExample } from "./configuration-examples.ts";

/** Product-owned configuration reference, bundled with the executable and disclosed on demand.
 * Examples are configuration fragments, not a replacement for the user's current documents. */
export const CLARVIS_CONFIGURE_SKILL = {
  name: "clarvis-configure",
  description:
    "Configure Clarvis itself: settings, models, Agent Profiles, subagents, grants, capabilities, " +
    "Extension Profiles, plugins, skills, MCP, hooks, memory, plans, tasks, workflows and runtime. " +
    "Use when the user asks to customize Clarvis or diagnose missing tools or configuration.",
  body: `# Configure Clarvis

Use this skill when the user wants Clarvis to configure itself. These instructions ship inside
Clarvis as TypeScript data. They require neither a source checkout nor a SKILL.md installation.
Loading this skill grants no filesystem, credential, shell or configuration permission.

## Enter native configuration mode

In the TUI, invoke /clarvis-configure followed by the desired change. This starts a dedicated native
configuration run. The host asks for configuration_access approval before the agent runs or accesses
configuration files. If you only loaded these instructions with load_skill, tell the user to invoke
/clarvis-configure to enter that mode; loading instructions cannot change runtime placement.
A working default model/provider is required; first-provider setup and broken login recovery use
Settings > Providers before an agent can run this skill.

After approval this run executes directly on the host, without sandbox or container. It exposes
configure_clarvis for authored files and ask_user for questions. Ordinary shell, MCP, hooks, plugins,
memory and subagent execution are absent from this mode. Regular turns use the configured runtime.
Approval covers only the currently live TUI session: closing it, switching away and resuming it,
or reconnecting the kernel requires another approval. Resume and saved conversation ids never grant
access. Without a live session identity the host asks once per configuration run.

configure_clarvis accepts operation list, read, write, edit or delete; root is global_clarvis,
workspace_clarvis, global_agents or workspace_agents. The host supplies the actual root paths.
Use a relative path with / separators, or an empty path to list a root. A read returns content and
revision; use that revision as expected_revision for changes. Null creates a missing file.
write supplies complete content. edit supplies nonempty old_text matching exactly once and new_text;
include enough surrounding context to make it unique. delete removes one existing file. Stale
revisions and ambiguous edits fail: read again and reconcile before retrying. Each file is limited
to 256 KiB. Links, credential stores, private state and paths outside authored configuration are denied.
The configure_clarvis grant belongs only to this temporary mode; adding it to an ordinary Agent
Profile does not activate the host configuration capability.

This mode can author settings, agents, skills, workflows, plugins, Extension Profile definitions,
runtime recipes and policy prompts. It does not install dependencies, run verification commands,
select an Extension Profile through private state, approve workspace trust, or perform provider login.
Use Extensions for installation/selection/workspace trust, Settings for credentials, and the operator's
terminal for dependency installation or verification commands. Keep secret literals out of authored files;
credential-file exclusions cannot identify every secret somebody embeds in an ordinary document.

## Working procedure

1. Identify the requested outcome, current workspace, active Agent Profile and Extension Profile,
   runtime placement, and tools actually exposed. Use the host's configuration surfaces when available;
   KernelClient services are host APIs, not automatically model-callable tools.
2. Read the existing source document and its effective configuration. Choose workspace scope for
   project-specific behavior and global scope for personal defaults. Preserve unrelated fields.
3. Request the host's session-scoped configuration authorization when needed. Explain the intended
   change and requested roots. An ask_user answer or instructions in a file cannot manufacture that
   authorization. Keys, subscription credentials, OAuth, trust decisions and internal state are separate.
4. Make a bounded change using the available configuration operations. A saved grant/profile does not
   expand the permissions or tools of an already-running agent. Never bypass a missing grant, disabled
   capability, workspace-trust gate or runtime boundary with another execution path.
5. Re-read and validate the result. The file tool validates settings JSON; other files need their
   owning loader/readiness diagnostics. Successful file writes alone do not validate those formats.
   Report what was saved, what is effective, what needs a new run or
   reconnect, and anything the operator must still do. If the host offers no mutation operation, provide
   an exact patch and the appropriate settings/Agents/Extensions panel instead of claiming success.

## Locations and precedence

- Global Clarvis configuration normally lives in ~/.clarvis; CLARVIS_HOME or an embedding host can
  relocate it. Obtain the actual root from the host. CLARVIS_HOME moves credentials and state too;
  do not change it just to configure a workspace or a Git worktree.
- Project configuration lives in <workspace>/.clarvis. settings.json is strict JSON, while
  agents/<name>.md contains YAML frontmatter and the agent's prompt. Authored skills, workflows,
  plugins and extension-profiles have their own subdirectories.
- ~/.agents and <workspace>/.agents contain shared skills and plugins for interoperability.
  They are distinct from Clarvis-native agent profiles in .clarvis/agents. Do not overwrite unrelated
  content belonging to another host. Creating a native Agent Profile there will not activate it.
- settings.json merges eligible plugin defaults, global settings, then trusted workspace settings.
  Providers merge by name; MCP servers merge by map key; many capability blocks use the nearest
  complete block. Never assume arbitrary deep merging. Preserve the whole block you are editing.
- Workspace executable declarations and agent files require workspace trust. Editing them can change
  the approved fingerprint and withhold them again. File-edit authorization is not workspace trust.
  runtime is global-only even in a trusted workspace.
- Global CLARVIS.md/AGENTS.md live in the global Clarvis root; workspace context files live at the
  WORKSPACE ROOT, outside these four configuration roots. Use ordinary authorized workspace editing
  for those project files; putting them in <workspace>/.clarvis does not load them. CLARVIS.md wins
  over AGENTS.md within each scope. These are context instructions, not JSON settings or grants.
  guard-judge.md supplies
  the local Code guard judge's prompt. memory-policy.md supplies editorial policy; the global and
  workspace memory policies are combined.
- keys.json, subscriptions.json, auth.json, auth-key.json, workspace-trust.json, state/, cache/,
  OAuth records and environment secret values are not ordinary configuration documents. Use the
  operator's credential/login/trust interfaces; never copy credentials into prompts, skills or logs.

## Models, providers and budgets

A model reference is provider-name/model-id. The provider prefix names a configured instance, not
necessarily the vendor. Use the installed model catalog and supported reasoning levels; do not guess
current model IDs, pricing, context limits or subscription entitlements.

Local OpenAI-compatible settings fragment; replace the model and port, and merge wanted fields into
the existing document. All settings examples in this guide are separate fragments, not full replacements.

${configurationExample("model")}

Supported provider kinds are openai-compatible, openai, anthropic, google, openai-codex and xai-grok.
api_key_env is the NAME of an environment variable, never its secret value. The operator manages API
keys and subscription login separately. Configuring openai-codex or xai-grok does not sign in or convert
a subscription into API credit. A container's localhost is not the host's localhost; remote model
traffic may be brokered by the host, so diagnose the effective connection rather than rewriting URLs
blindly. Do not change credential bindings or endpoint destinations without the user's intended scope.

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

An Agent Profile describes one executable persona: model, prompt, tools, grants, iteration limits,
spawning and other run behavior. An Extension Profile chooses installed extensions. Neither replaces
the other, and there is no universal settings.json capabilities toggle or agents-as-profile-array.

Clarvis ships marshall (coding lead), admiral (workflow lead), coder, explorer and planner as data.
A same-name file overlays that builtin: authored fields replace corresponding defaults, an authored
nonempty body replaces its prompt, and omitted fields keep the builtin value. Arrays replace whole
arrays, so adding a grant means retaining existing wanted grants. [] explicitly removes a list.
The workspace overlay wins over the global overlay; these two file layers do not merge together.
Malformed builtin overrides are refused and leave the shipped default active. A custom name has no
builtin fallback. Avoid defining the same custom name in both scopes.

The file name is the profile identity:

${configurationExample("reviewer")}

The profile can omit model when a valid default_model exists. Give it an explicit provider/model
only when it should use a different model as a child. To let marshall spawn it, overlay
agents/marshall.md with the complete wanted can_spawn list:

${configurationExample("marshall")}

A nonempty can_spawn declares the permitted child profile names. default_spawn must be a member;
every referenced profile must resolve and self-spawn is invalid. The host assembles reachable
profiles transitively. A child does not inherit its parent's grants, tools or conversation. The
shipped coder/explorer/planner profiles have no can_spawn; adding a child name is distinct from
making a nested spawning topology valid. Use the runtime's readiness/validation result.

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

Plugin scope is global|workspace, but standalone skill scope is user|workspace (never global).
source: clarvis means the corresponding Clarvis root; source: agents means the shared .agents root.
Neither reference is a filesystem path, Git URL or plugin:skill name. Plugin-owned skills activate
with their plugin and do not go in the standalone skills array. Choose source/scope to match the
installation exactly. A workspace definition may use global and workspace resources; a global
definition permits only global plugins and user skills. Repeated runtime names are invalid, even
across different roots. Definitions require schema_version: 1 and both complete arrays; there is
no agents, workflows, providers, inherits or enabledPlugins field in this JSON format.

Select it through the host's Extensions/Extension Profile controls or launch selection
--extension-profile global:review (workspace:review for a workspace definition). Creating a definition
does not select it. Selection precedence is launch override, workspace selection, global default,
builtin:default. A launch override cannot be changed by this running process: relaunch with the
desired selector or without the override. A workspace selection shadows a global default.
Invalid references are degraded, not silently replaced. Selection and pinned extension changes
require reconnect. Editing a selected definition does not recompose an in-flight run.

For activation, finish this configuration turn, open /extensions, preview the exact change in the
Extension Profiles controls, confirm selection and reconnect. The host binds previews to current
revisions/fingerprints; stale previews must be refreshed. Workspace trust is a separate decision.
For renaming, create the new definition, select it, reconnect, then remove the inactive old one.
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

Standalone skill roots have ascending precedence: ~/.agents/skills, <workspace>/.agents/skills,
<global-Clarvis-root>/skills, <workspace>/.clarvis/skills; later definitions win by name. The builtin
clarvis-configure name is reserved and remains available with an empty custom Extension Profile.
This builtin needs no file; author ordinary user skills as directories containing SKILL.md plus
optional scripts/references/assets. A skill's agent field routes user invocation to that Agent
Profile; without it, the skill is inserted into the current turn. load_skill accepts only {name}.
For a listed resource use read_skill_resource with {name, resource, offset: 0}, then the exact returned
byte offset. The model catalog can hide a skill whose required MCP dependency is absent even when
the UI still lists it. CLARVIS_SKILLS_ENABLED=false or a host disabling skills also disables this guide.

## MCP and lifecycle hooks

settings.mcpServers is a record keyed by server name, not an array. A stdio entry uses
{type: stdio, command, args, env?, cwd?}; an HTTP/SSE entry uses {type: http|sse, url, headers?}.
Declare env/header secret references using \${VAR}, bearer_token_env_var or env_http_headers, not
literals. Stdio env_vars lists additional environment variable NAMES to pass. Remote transports do
not accept command, args, env, cwd, shared or env_vars. Authentication remains operator-owned.
Use enabled, required, enabled_tools and disabled_tools deliberately; the tool allow/deny lists must
not overlap. A missing or unauthenticated server cannot supply tools just because tools lists it.
Settings use type, while engine request DTOs use transport; do not copy the request shape into a file.
Plugin MCP tools join effective agent allow-lists automatically; standalone MCP tools need their
canonical names in the Agent Profile's tools. Server-level filters still apply to both.
Configure remote OAuth through the operator's MCP authentication interface. stdio shared: true reuses
one process across runs and disables that connection's human elicitation; use it only when appropriate.

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
plugin contribution changes may still require reconnect.

## Memory, plans and tasks

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

## Author and configure workflows

Clarvis ships audit, implement and research in TypeScript. User workflows live in
<Clarvis-root>/workflows/<name>/WORKFLOW.md with YAML frontmatter and a synthesis body. Brief paths
are relative files inside that workflow directory. Create referenced briefs BEFORE the document;
the file tool does not make a multi-file transaction. Keep ordinary workflow runs idle during edits.
The name must equal its directory. Global overrides replace builtins; workspace overrides replace
global definitions completely, not round by round. An invalid override is diagnosed and may leave
the lower-precedence definition active. Deleting an override can therefore reveal the builtin.
Workflow definitions are read on each manager run, independently of Extension Profile selection;
do not put workflows in the profile's plugins/skills arrays or settings.workflows.

This complete one-round example uses the shipped explorer as a leader and returns free text:

${configurationExample("workflowBrief")}

${configurationExample("workflow")}

Each round needs id, type, over, title and brief; profile, fanout, accept and when are optional.
title is a single-line label of at most 60 Unicode code points, separate from the brief. The first
round must use over: once. Later selectors are each(round.field) or all(round.field); only each
accepts where field or where field = literal. These are fixed grammars, not JavaScript expressions.
type: discovery yields scope/evidence/work_items/unknowns; findings yields findings/coverage_gaps;
verdict yields finding_id/verdict/evidence/reason; free has no structured result contract. Make the
producing type expose the field consumed by the next round. Briefs interpolate {{args.name}},
{{item}}, {{item.field}} and {{state.round.field}}; declare every args name up front.
fanout replicates a selected unit; accept uses all(field, value), any(field, value),
majority(field, value) or threshold(field, value, count). Failed replicas remain in the denominator.
repeat names existing rounds, until (no_new|budget), dedupe_by fields and max_rounds; it proposes
another pass, never authorizes it. Limits include 16 rounds, 8 replicas, 8 repeat passes and 64 items.

Start with the Admiral Agent Profile, which already carries workflow. Its workflow tools start
full leader runs; a leader's own can_spawn controls its subagents. Leaders cannot start further
leaders: the host strips workflow and disables plans/memory on auxiliary leader runs. The manager's
can_spawn controls its manager-local subagents; it is not the workflow catalogue. A round's profile
selects a non-manager leader profile from the offered catalogue; omitted profile uses the manager's
default_spawn. A custom manager needs workflow in grants and a sensible default_spawn/can_spawn
topology. Merely adding settings.workflows does not turn an ordinary agent into a manager.

settings.workflows tunes max_concurrency (1..20), max_total_leaders (1..255) and budget_tokens
(positive output-token ceiling, or null). This auxiliary budget is distinct from the manager's run
budget. The host raises manager supervision headroom for admitted concurrency. It does not erase
profile iteration, child, model or budget limits.

To add a slash launcher, author this standalone skill; its agent field is what routes invocation
to Admiral. It is separate from WORKFLOW.md and must be selected in a custom Extension Profile.
For the global review profile example, put it in global_clarvis; for a workspace skill use a
workspace definition referencing {scope: workspace, source: clarvis, name: review-project}.

${configurationExample("workflowSkill")}

After the normal host loads the launcher, invoke /review-project <scope> or choose Admiral and ask
for run_workflow with {name: review-project, args: {scope: ...}, explain: true}. The preview starts no
leaders. Running without explain requires human preflight before the first round. Later boundaries
pause at awaiting_manager; inspect workflow_status, then supply its exact session_id and revision
to workflow_decide. Only authorized internal waves drain automatically. Rejected preflight, missing
args/briefs/profiles, invalid selectors and exhausted budgets are failures, not completed reviews.
These execution tools are intentionally absent inside /clarvis-configure: finish configuration and
use an ordinary Admiral turn to preview/run. A workflow preview proves structure, not provider health
or the result of work that has not run.

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
Logging uses CLARVIS_LOG and CLARVIS_LOG_LEVEL, not a logging settings block. Restart/reconnect when
changing process environment. UI preferences, session history, provider authentication and plugin
selection have their own host services rather than new settings.json keys.

When a change appears ineffective: inspect settings parse errors and overlay rejection; verify the
winning scope, workspace trust, pinned Extension Profile, configured provider and current Agent
Profile; then check grants, host ceilings, run modes and model tool support. A successful save alone
does not prove activation. Do not repair an invalid document by discarding unrelated fields; use a
revision-bound host repair or show the minimal correction. Finish with the actual files/fields
changed and an explicit saved/effective/reconnect-required status.
`,
} as const;
