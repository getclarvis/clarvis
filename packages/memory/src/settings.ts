/**
 * The `settings.json` / run-request contract for the memory capability.
 *
 * @remarks This module is what a host registers on its {@link CapabilitySettingsSpec}
 * registry so the `memory:` block and the per-run `memory` param are accepted —
 * the engine never declares either. It used to live inside `@clarvis/loop`
 * (`runtime/capabilities/memory-settings.ts`) purely so the engine's settings
 * schema could spread it statically, which forced the block's zod shape and this
 * capability's name to exist twice and be pinned equal by a drift test. It moved
 * here once the schema learned to accept blocks registered at runtime, the same
 * route `@clarvis/plan` and `@clarvis/workflows` already take.
 *
 * Deliberately narrow: it imports the block's schema from `./schemas.ts` rather
 * than restating it, and pulls in nothing else from the package. `./capability`
 * reaches the whole facade, and {@link MEMORY_CAPABILITY_NAME} /
 * {@link MEMORY_INGEST_EVENT} are needed on a host's hot event-mapping path — so
 * the two names live here, where reading them costs one small module.
 */
import { z } from "zod";
import type { CapabilitySettingsSpec } from "@clarvis/capability";
import { memoryConfigSchema } from "./schemas.ts";

/** Registry name of the memory capability, and the `capability` field of every event it emits. */
export const MEMORY_CAPABILITY_NAME = "memory";

/** CapabilityEvent kind carrying a `MemoryIngestNotice` as `detail`. */
export const MEMORY_INGEST_EVENT = "ingest";

/**
 * Per-run memory override: `off` runs with no seed block, no wiki tools and no
 * post-run ingestion; default (absent) is `on` whenever memory is configured on
 * the host. Memory is a single global on/off, never gated per owner or profile.
 */
const memoryField = z
  .enum(["on", "off"], { error: "memory must be 'on' or 'off'" })
  .optional()
  .describe(
    "Per-run memory override. 'off' runs as if the host configured no memory: no seed " +
      "block, no navigation tools, no post-run ingestion. Default 'on' — memory is active " +
      "for every run whenever it is configured on the host (global activation, not gated " +
      "per owner or per profile).",
  );

/** The `memory` block of settings.json, added to a host's schema by {@link memorySettingsSpec}. */
export const MEMORY_SETTINGS_FIELDS = {
  memory: memoryConfigSchema
    .optional()
    .describe(
      "Execution memory (@clarvis/memory): a workspace-local markdown wiki " +
        "(<ws>/.clarvis/memory) the agent reads and edits as a semantic pyramid. " +
        "Injects the compiled PROFILE as an <memory> block plus read/write wiki tools, and folds finished " +
        "runs into it via a per-run indexer. Absent = memory off. `model` names the " +
        "indexer model and defaults to default_model.",
    ),
};

/** Per-run memory params, added to the run request (and the mcp slim tool). */
export const MEMORY_REQUEST_PARAMS = {
  memory: memoryField,
};

/**
 * The block as a host may write it — pre-defaults, so `enabled` is optional.
 *
 * @remarks `z.input`, not `z.infer`: the parsed type marks `enabled` required
 * because the schema defaults it, which would misdescribe a settings file that
 * legitimately omits it.
 */
export type MemorySettingsBlock = z.input<typeof memoryConfigSchema>;

/**
 * Registration entry for the memory block: last scope wins, not
 * plugin-contributable, and passes the `memory` run param through.
 */
export const memorySettingsSpec: CapabilitySettingsSpec = {
  key: MEMORY_CAPABILITY_NAME,
  schema: memoryConfigSchema,
  merge: "lastWins",
  pluginContributable: false,
  requestParams: MEMORY_REQUEST_PARAMS,
};
