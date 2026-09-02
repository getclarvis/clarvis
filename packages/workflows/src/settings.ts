/**
 * The settings.json contract for the workflow-manager capability, owned by the
 * package that implements it.
 *
 * @remarks This block used to live inside `@clarvis/loop`, purely so the engine's
 * settings schema could spread it without gaining a dependency on a package that
 * sits above it. It moved here once the schema learned to accept blocks
 * registered at runtime: a capability now declares its own settings, and a host
 * registers the declaration before it parses `settings.json`. Unlike the
 * built-in capabilities, `workflows` is **not** constructed in `build-run-deps`
 * — it needs a per-workflow context (semaphore, ledger, leader assembler) that
 * only the host's workflow service can supply, so this block exists only to bound
 * that service's fan-out.
 *
 * @remarks Manager designation is a per-profile concern, not a block here: only
 *   an agent profile carrying the `workflow` {@link import("@clarvis/capability").Grant | Grant}
 *   becomes a manager. This block is not an on/off switch; it supplies the live,
 *   cumulative and token bounds the fan-out runs under.
 */
import { z } from "zod";
import type { CapabilitySettingsSpec } from "@clarvis/capability";
import { AGENTS_MAX_LIVE_CHILDREN } from "@clarvis/supervision";

/** Registry name of the workflow-manager capability. */
export const WORKFLOWS_CAPABILITY_NAME = "workflows";

/**
 * The highest tree-wide leader concurrency an operator may configure.
 *
 * @remarks Bounded by what the supervision registry can hold, not by taste: a
 * leader occupies a live-child slot for as long as it runs, so a concurrency an
 * operator can set but the registry cannot admit does not fan out further — it
 * queues the excess behind a ceiling nothing reports. The gap between this and
 * {@link AGENTS_MAX_LIVE_CHILDREN} is {@link MANAGER_REGISTRY_HEADROOM}.
 */
export const WORKFLOWS_MAX_CONCURRENCY = 20;

/** Absolute cumulative leader ceiling accepted by the settings contract. */
export const WORKFLOWS_MAX_TOTAL_LEADERS = 255;

/**
 * Live-child slots a manager needs on top of its running leaders.
 *
 * @remarks Three things claim a slot that is not a running leader: each dispatch
 * session's baton (the one handle held unsettled across a batch boundary so the
 * finish gate cannot see zero live children), a leader that finished but whose
 * handle the baton logic has not settled yet, and an ad-hoc `run_leader` still
 * queued for a permit. Four covers the shapes a manager actually produces while
 * keeping the derived ceiling under the registry's own.
 *
 * The fourth slot is margin, and it is free in both directions that matter.
 * Under-provisioning fails *silently* — the semaphore admits a leader the
 * registry then refuses, which is precisely the unreported queueing
 * {@link WORKFLOWS_MAX_CONCURRENCY} exists to prevent — while over-provisioning
 * costs nothing, because the derived ceiling is clamped to
 * {@link AGENTS_MAX_LIVE_CHILDREN} regardless. At the maximum concurrency the
 * total is 24 against a registry ceiling of 32, so the margin never brings the
 * clamp into play.
 */
const MANAGER_REGISTRY_HEADROOM = 4;

/**
 * The live-children ceiling a manager run needs to actually reach a given leader
 * concurrency.
 *
 * @param maxConcurrency - the tree-wide leader concurrency the manager runs under.
 * @returns the `agents.max_live_children` floor for that manager's run request,
 *   clamped to {@link AGENTS_MAX_LIVE_CHILDREN}.
 * @remarks A host must apply this, or raising `max_concurrency` buys nothing: the
 *   semaphore would admit the leaders and the registry would refuse to register
 *   them. At the default concurrency this returns exactly the supervision
 *   default, so an unconfigured workspace is unaffected.
 */
export function managerLiveChildrenFloor(maxConcurrency: number): number {
  const concurrency = Number.isFinite(maxConcurrency) ? Math.max(1, Math.floor(maxConcurrency)) : 1;
  return Math.min(AGENTS_MAX_LIVE_CHILDREN, concurrency + MANAGER_REGISTRY_HEADROOM);
}

/**
 * The product defaults for the `workflows` block, in one place so the settings
 * schema and any host that mints a block cannot drift apart. The block is pure
 * fan-out tuning: whether a run is a workflow is decided solely by the `workflow`
 * grant on its entry agent profile, not by any field here.
 */
export const WORKFLOWS_DEFAULTS = {
  max_concurrency: 4,
  max_total_leaders: 32,
  budget_tokens: 640_000_000,
} as const;

/** The `workflows:` settings block: `max_concurrency` (the leader-wide live
 * cap), `max_total_leaders` (the cumulative registration cap), and
 * `budget_tokens` (an optional output-token ceiling summed across leader runs;
 * `null` means unbounded). Manager designation is not a field here — it is the
 * `workflow` grant on the entry agent profile. */
const workflowsConfigSchema = z
  .object({
    max_concurrency: z
      .number()
      .int()
      .positive()
      .max(WORKFLOWS_MAX_CONCURRENCY)
      .default(WORKFLOWS_DEFAULTS.max_concurrency),
    max_total_leaders: z
      .number()
      .int()
      .positive()
      .max(WORKFLOWS_MAX_TOTAL_LEADERS)
      .default(WORKFLOWS_DEFAULTS.max_total_leaders),
    budget_tokens: z.number().int().positive().nullable().default(WORKFLOWS_DEFAULTS.budget_tokens),
  })
  .strict();

/** The `workflows` block of settings.json. */
export const WORKFLOWS_SETTINGS_FIELDS = {
  workflows: workflowsConfigSchema
    .optional()
    .describe(
      "Workflow-manager fan-out tuning (max_concurrency, max_total_leaders, budget_tokens). A run is a workflow when " +
        "its entry agent profile carries the 'workflow' grant — there is no separate on/off switch.",
    ),
};
/**
 * Registration entry for the workflows block: last scope wins, not
 * plugin-contributable. Unlike the loop-built capabilities, `workflows` exposes
 * **no** per-run request param — the capability is constructed by the host's
 * workflow service (from this settings block plus its start params), never by the
 * loop from a run-request field.
 */
export const workflowsSettingsSpec: CapabilitySettingsSpec = {
  key: "workflows",
  schema: workflowsConfigSchema,
  merge: "lastWins",
  pluginContributable: false,
};

/** The `workflows` block of `settings.json`, as validated by {@link workflowsSettingsSpec}.
 *
 * @remarks The *input* shape: a settings file is authored, so every field with a
 * schema default is optional on disk even though it is present once parsed. */
export type WorkflowsSettingsBlock = z.input<typeof workflowsConfigSchema>;
