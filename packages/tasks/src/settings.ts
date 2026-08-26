import type { CapabilitySettingsSpec } from "@clarvis/capability";
import { z } from "zod";

export const TASKS_CAPABILITY_NAME = "tasks";
export const TASKS_PROTOCOL = "clarvis.tasks.v2";

export const activeTaskRequestSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    provider_key: z.string().trim().min(1).max(512).optional(),
    mode: z.enum(["inspect", "work"]).default("inspect"),
  })
  .strict();

export type ActiveTaskRequest = z.input<typeof activeTaskRequestSchema>;
export type ResolvedActiveTaskRequest = z.output<typeof activeTaskRequestSchema>;

export const tasksConfigSchema = z
  .object({
    provider: z
      .object({
        kind: z.literal("mcp"),
        server: z.string().trim().min(1).max(512),
        protocol: z.literal(TASKS_PROTOCOL),
      })
      .strict(),
    default_container: z.string().trim().min(1).max(512).optional(),
    /**
     * Whether the run may change anything in the remote task system.
     *
     * @remarks Off by default, unlike every other capability Clarvis ships,
     * because a write here leaves the machine: a transitioned ticket, a claimed
     * task or a submitted review is visible to a team and is not undone by
     * discarding the run. Memory and plans write inside a
     * workspace the operator can inspect and revert; this one cannot make that
     * promise, so enabling it has to be a decision someone made rather than one
     * they inherited.
     *
     * It is only the first of three gates — the provider must advertise the
     * operation and a model call additionally needs the matching grant — so
     * defaulting it on would not by itself permit a write. It is off anyway,
     * because the other two are properties of the *provider* and the *agent*,
     * and this is the only one that is a property of the operator.
     */
    writes: z.enum(["disabled", "enabled"]).default("disabled"),
  })
  .strict();

export type TasksSettingsBlock = z.input<typeof tasksConfigSchema>;
export type ResolvedTasksSettingsBlock = z.output<typeof tasksConfigSchema>;

/**
 * The `tasks:` settings block.
 *
 * @remarks `merge: "lastWins"` rather than a deep merge, and that follows from
 * `provider` being an identity rather than a bag of options: a workspace naming
 * its own MCP server must replace the global one whole, since a field-by-field
 * merge could pair a workspace's `server` with a global `protocol` — or, worse,
 * leave `writes: "enabled"` from a global scope attached to a provider the
 * operator never enabled writes for. The block is small and every field is
 * meaningful only alongside the others, so taking the nearest scope entire is
 * the reading that cannot produce a configuration nobody wrote.
 */
export const tasksSettingsSpec: CapabilitySettingsSpec = {
  key: TASKS_CAPABILITY_NAME,
  schema: tasksConfigSchema,
  merge: "lastWins",
  pluginContributable: false,
  requestParams: {
    task: activeTaskRequestSchema
      .optional()
      .describe("Bind this run to one external task. The current workspace remains implicit."),
  },
};
