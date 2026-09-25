/** Native sandbox settings for the built-in coding tools. */
import { z } from "zod";
import type { CapabilitySettingsSpec } from "@clarvis/capability";
import { INPUT_LIMITS } from "../../validation/input-limits.ts";

const boundedSandboxList = z
  .array(z.string().min(1).max(INPUT_LIMITS.pathChars))
  .max(INPUT_LIMITS.sandboxListEntries);

const sandboxSchema = z
  .object({
    type: z.literal("native"),
    enabled: z.boolean().optional(),
    availability: z.enum(["required", "optional"]).optional(),
    filesystem: z.enum(["workspace-write", "workspace-read-only"]).optional(),
    network: z.enum(["host", "none"]).optional(),
    pass_env: boundedSandboxList.optional(),
    toolchains: z
      .object({
        mode: z.enum(["auto", "manual"]).optional(),
        include: boundedSandboxList.optional(),
        exclude: boundedSandboxList.optional(),
        extra_paths: boundedSandboxList.optional(),
        excluded_paths: boundedSandboxList.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe("Optional native sandbox for shell on Linux and macOS.");

/** The validated `sandbox` settings block (the inferred shape of `sandboxSchema`). */
export type SandboxSettings = z.infer<typeof sandboxSchema>;
/** {@link SandboxSettings} plus the host-resolved concrete path lists (read-only
 * extra paths and discovered toolchain roots) that {@link resolveSandboxHostPolicy}
 * fills in for the runtime. */
export type ResolvedSandboxSettings = SandboxSettings & {
  resolved_read_only_paths?: string[];
  resolved_runtime_paths?: string[];
};

export const AGENT_TOOLS_SETTINGS_FIELDS = {
  sandbox: sandboxSchema.optional(),
};

export const SANDBOX_PLUGIN_FIELDS = {
  sandbox: z
    .undefined({ error: "a plugin may not contribute 'sandbox'; declare it in settings.json" })
    .optional(),
};

/**
 * Registration entry that merges the `sandbox` block across settings scopes:
 * scalar fields take the last defined value, while `pass_env` and the toolchain
 * path lists union (with `excluded_paths` subtracted from `extra_paths`). Not
 * plugin-contributable — a plugin may not weaken the workspace sandbox.
 */
export const sandboxSettingsSpec: CapabilitySettingsSpec = {
  key: "sandbox",
  schema: sandboxSchema,
  merge: (scopes) => {
    const values = scopes.map((scope) => scope.value as SandboxSettings);
    const distinct = (lists: (string[] | undefined)[]): string[] | undefined => {
      const out = [...new Set(lists.flatMap((list) => list ?? []))];
      if (out.length > INPUT_LIMITS.sandboxListEntries) {
        throw new Error(
          `merged sandbox list exceeds ${String(INPUT_LIMITS.sandboxListEntries)} entries`,
        );
      }
      return out.length > 0 ? out : undefined;
    };
    const last = <K extends keyof SandboxSettings>(key: K): SandboxSettings[K] | undefined => {
      let value: SandboxSettings[K] | undefined;
      for (const item of values) if (item[key] !== undefined) value = item[key];
      return value;
    };
    const toolchains = values
      .map((value) => value.toolchains)
      .filter((value) => value !== undefined);
    const lastToolchain = <K extends keyof NonNullable<SandboxSettings["toolchains"]>>(
      key: K,
    ): NonNullable<SandboxSettings["toolchains"]>[K] | undefined => {
      let value: NonNullable<SandboxSettings["toolchains"]>[K] | undefined;
      for (const item of toolchains) if (item[key] !== undefined) value = item[key];
      return value;
    };
    const excludedPaths = distinct(toolchains.map((item) => item.excluded_paths));
    const excluded = new Set(excludedPaths ?? []);
    const extraPaths = distinct(toolchains.map((item) => item.extra_paths))?.filter(
      (path) => !excluded.has(path),
    );
    const mergedToolchains = {
      ...(lastToolchain("mode") !== undefined ? { mode: lastToolchain("mode") } : {}),
      ...(lastToolchain("include") !== undefined ? { include: lastToolchain("include") } : {}),
      ...(distinct(toolchains.map((item) => item.exclude)) !== undefined
        ? { exclude: distinct(toolchains.map((item) => item.exclude)) }
        : {}),
      ...(extraPaths !== undefined && extraPaths.length > 0 ? { extra_paths: extraPaths } : {}),
      ...(excludedPaths !== undefined ? { excluded_paths: excludedPaths } : {}),
    };
    return {
      type: "native" as const,
      ...(last("enabled") !== undefined ? { enabled: last("enabled") } : {}),
      ...(last("availability") !== undefined ? { availability: last("availability") } : {}),
      ...(last("filesystem") !== undefined ? { filesystem: last("filesystem") } : {}),
      ...(last("network") !== undefined ? { network: last("network") } : {}),
      ...(distinct(values.map((value) => value.pass_env)) !== undefined
        ? { pass_env: distinct(values.map((value) => value.pass_env)) }
        : {}),
      ...(Object.keys(mergedToolchains).length > 0 ? { toolchains: mergedToolchains } : {}),
    };
  },
  pluginContributable: false,
  pluginForbiddenReason: "a plugin may not contribute 'sandbox'; declare it in settings.json",
};
