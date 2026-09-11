import { z } from "zod";
import type { RuntimeStatus } from "@clarvis/protocol";

/** One runtime vocabulary with field bounds supplied by its disk or transport boundary. */
export function runtimeStatusSchema(fields: {
  identifier: z.ZodString;
  text: z.ZodString;
}): z.ZodType<RuntimeStatus> {
  return z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("native"),
      host_platform: fields.identifier,
      isolation: z.enum(["host", "sandbox"]),
      lifecycle: z.enum(["ready", "fallback"]),
      fallback_from: z.enum(["docker", "podman"]).optional(),
    }),
    z.strictObject({
      kind: z.literal("container"),
      engine: z.enum(["docker", "podman"]),
      host_platform: fields.identifier,
      guest_platform: z.literal("linux"),
      network: z.enum(["none", "internet", "outbound"]),
      generation: fields.identifier.optional(),
      engine_version: fields.text.optional(),
      image_digest: fields.text.optional(),
      runtime_protocol_revision: fields.text.optional(),
      lifecycle: z.enum([
        "cold",
        "inspecting",
        "preparing",
        "starting",
        "ready",
        "stopping",
        "stopped",
        "disconnected",
        "failed",
      ]),
    }),
  ]);
}
