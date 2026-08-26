/**
 * The settings.json / run-request contract for the agent-supervision capability.
 *
 * @remarks Kept dep-free of the capability itself, like every other `*-settings`
 * module, so the settings schema stays composable from one place. There is no
 * on/off field: the surface follows from what the run *spawns*, not from a
 * request flag — a run whose entry agent cannot delegate never sees the tools at
 * all. Every field here bounds a cost the parent's own process pays.
 */
import { z } from "zod";
import type { CapabilitySettingsSpec } from "@clarvis/capability";

/** Registry name of the agent-supervision capability. */
export const AGENTS_CAPABILITY_NAME = "agents";

/** Absolute per-child ceilings shared by schema and programmatic buffers. */
export const AGENTS_MAX_BUFFER_LINES = 10_000;
export const AGENTS_MAX_BUFFER_BYTES = 8_388_608;

/** Absolute ceiling on retained activity-buffer payload in one registry. */
export const AGENTS_MAX_TOTAL_BUFFER_BYTES = 33_554_432;

/**
 * Absolute ceiling on children that may be live in one registry at once.
 *
 * @remarks Named rather than spelled twice: the schema bound and the registry's
 * own clamp have to be the same number, or a value settings accept is silently
 * lowered at construction. It is also what a host sizing a fan-out against this
 * registry must clamp its own derived ceiling to — see `@clarvis/workflows`,
 * whose leader concurrency has to fit underneath it.
 */
export const AGENTS_MAX_LIVE_CHILDREN = 32;

/**
 * The hard ceiling on retained (finished) children a registry keeps for polling.
 *
 * @remarks Named for the same reason as {@link AGENTS_MAX_LIVE_CHILDREN}: the
 * schema bound and the registry's own clamp have to be the same number, and they
 * were the bare literal `64` in both places, one line below a call that already
 * used the named live-children ceiling.
 */
export const AGENTS_MAX_RETAINED_CHILDREN = 64;

/**
 * The product defaults for the `agents` block, in one place so the settings
 * schema, the run-request param and the registry cannot drift apart.
 *
 * @remarks The buffer bounds protect the *parent's* memory, which is where a
 * noisy child (a shell loop) would otherwise grow without limit; the ceilings on
 * live children, notices and consecutive failures protect its *context*, which
 * is the resource delegation exists to conserve in the first place.
 *
 * Two of these are not free choices but consequences of the others:
 *
 * - `max_live_children` × `buffer_bytes` is the worst-case retained payload, so
 *   the default 8 sits a factor of four inside `max_total_buffer_bytes`, while
 *   the hard {@link AGENTS_MAX_LIVE_CHILDREN} of 32 is exactly where 1 MiB per
 *   child meets the 32 MiB aggregate. Raising one without the other does not
 *   buy fan-out; it only moves which bound trips first.
 * - `max_notices_per_iteration` equals `max_live_children`, which is the
 *   smallest value at which one iteration can still carry news from every live
 *   child. Below it, a parent with a full fan-out loses individual updates:
 *   `takeNotices` keeps the first `cap` and replaces the remainder with a count
 *   pointing at `agent_list`, so the information is recoverable but only by
 *   spending another call on it.
 *
 * The rest are bracketed rather than derived. `await_timeout_ms` is generous
 * because expiry is not a failure — `await_agents` returns `woke_on: "timeout"`
 * with `still_running`, and the engine's wait already breaks early on a user
 * steer — so the cost of it being too long is one wasted iteration,
 * while too short is a stream of them. `max_consecutive_failed_children` is 3 on
 * the ordinary "twice may be luck" reading; `finish_nudges` is 2 because the
 * first nudge tells the parent something it may not have known and the second
 * establishes it is not going to act on it.
 */
export const AGENTS_DEFAULTS = {
  buffer_lines: 2000,
  buffer_bytes: 1_048_576,
  max_total_buffer_bytes: AGENTS_MAX_TOTAL_BUFFER_BYTES,
  poll_max_bytes: 65_536,
  await_timeout_ms: 120_000,
  max_live_children: 8,
  max_retained_children: AGENTS_MAX_RETAINED_CHILDREN,
  max_notices_per_iteration: 8,
  max_consecutive_failed_children: 3,
  finish_nudges: 2,
} as const;

/** The `agents:` block: per-child buffer bounds, the poll page size, the default
 * `await_agents` timeout, and the ceilings that keep a fan-out from consuming the
 * parent it reports to. */
const agentsConfigSchema = z
  .object({
    buffer_lines: z
      .number()
      .int()
      .positive()
      .max(AGENTS_MAX_BUFFER_LINES)
      .default(AGENTS_DEFAULTS.buffer_lines),
    buffer_bytes: z
      .number()
      .int()
      .positive()
      .max(AGENTS_MAX_BUFFER_BYTES)
      .default(AGENTS_DEFAULTS.buffer_bytes),
    max_total_buffer_bytes: z
      .number()
      .int()
      .positive()
      .max(AGENTS_MAX_TOTAL_BUFFER_BYTES)
      .default(AGENTS_DEFAULTS.max_total_buffer_bytes),
    poll_max_bytes: z.number().int().positive().max(65_536).default(AGENTS_DEFAULTS.poll_max_bytes),
    await_timeout_ms: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .default(AGENTS_DEFAULTS.await_timeout_ms),
    max_live_children: z
      .number()
      .int()
      .positive()
      .max(AGENTS_MAX_LIVE_CHILDREN)
      .default(AGENTS_DEFAULTS.max_live_children),
    max_retained_children: z
      .number()
      .int()
      .positive()
      .max(AGENTS_MAX_RETAINED_CHILDREN)
      .default(AGENTS_DEFAULTS.max_retained_children),
    max_notices_per_iteration: z
      .number()
      .int()
      .positive()
      .default(AGENTS_DEFAULTS.max_notices_per_iteration),
    max_consecutive_failed_children: z
      .number()
      .int()
      .nonnegative()
      .default(AGENTS_DEFAULTS.max_consecutive_failed_children),
    finish_nudges: z.number().int().nonnegative().default(AGENTS_DEFAULTS.finish_nudges),
  })
  .strict();

/** The `agents` block of settings.json (spread into settingsSchema). */
export const AGENTS_SETTINGS_FIELDS = {
  agents: agentsConfigSchema
    .optional()
    .describe(
      "Bounds on supervising background children (per-child and aggregate buffer, poll page " +
        "size, await timeout, and the live-children / notice / consecutive-failure ceilings). " +
        "There is no on/off switch: the tools appear only for a run whose entry agent can spawn.",
    ),
};

/** The per-run override of the `agents` block. */
export const AGENTS_REQUEST_PARAMS = {
  agents: agentsConfigSchema
    .partial()
    .optional()
    .describe("Per-run override of the agents supervision bounds; merged over the settings block."),
};

/**
 * Registration entry for the agents block: last scope wins, not
 * plugin-contributable — a plugin must not be able to raise a ceiling that
 * exists to protect the run it is running inside.
 */
export const agentsSettingsSpec: CapabilitySettingsSpec = {
  key: AGENTS_CAPABILITY_NAME,
  schema: agentsConfigSchema,
  merge: "lastWins",
  pluginContributable: false,
  requestParams: AGENTS_REQUEST_PARAMS,
};
