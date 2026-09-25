import { z } from "zod";
import type { RuntimeStatus } from "@clarvis/protocol";

/** Validate the host-reported native runtime placement at disk and transport boundaries. */
export function runtimeStatusSchema(fields: {
  identifier: z.ZodString;
  text: z.ZodString;
}): z.ZodType<RuntimeStatus> {
  return z.strictObject({
    kind: z.literal("native"),
    host_platform: fields.identifier,
    lifecycle: z.literal("ready"),
  });
}
