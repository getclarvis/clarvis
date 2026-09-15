import { z } from "zod";
import type { RuntimeStatus } from "@clarvis/protocol";

/** One runtime vocabulary with field bounds supplied by its disk or transport boundary. */
export function runtimeStatusSchema(fields: {
  identifier: z.ZodString;
  text: z.ZodString;
}): z.ZodType<RuntimeStatus> {
  const generation = fields.identifier.regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  const digest = fields.text.regex(/^sha256:[a-f0-9]{64}$/u);
  const namespace = fields.identifier.regex(/^[a-f0-9]{64}$/u);
  return z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("native"),
      host_platform: fields.identifier,
      isolation: z.enum(["host", "sandbox"]),
      lifecycle: z.literal("ready"),
    }),
    z.discriminatedUnion("lifecycle", [
      z.strictObject({
        kind: z.literal("container"),
        engine: z.enum(["docker", "podman"]),
        host_platform: fields.identifier,
        guest_platform: z.literal("linux"),
        network: z.enum(["none", "outbound"]),
        generation,
        engine_version: fields.text.optional(),
        image_digest: digest,
        artifact_digest: digest,
        base_abi: z.literal("clarvis-linux-glibc-v1"),
        broker_version: z.literal(1),
        channel_version: z.literal(1),
        state_namespace: namespace,
        lifecycle: z.literal("ready"),
      }),
      z.strictObject({
        kind: z.literal("container"),
        engine: z.enum(["docker", "podman"]),
        host_platform: fields.identifier,
        guest_platform: z.literal("linux"),
        network: z.enum(["none", "outbound"]),
        generation: generation.optional(),
        engine_version: fields.text.optional(),
        image_digest: digest.optional(),
        artifact_digest: digest.optional(),
        base_abi: z.literal("clarvis-linux-glibc-v1").optional(),
        broker_version: z.literal(1).optional(),
        channel_version: z.literal(1).optional(),
        state_namespace: namespace.optional(),
        lifecycle: z.enum([
          "cold",
          "inspecting",
          "preparing",
          "starting",
          "stopping",
          "stopped",
          "disconnected",
          "failed",
        ]),
      }),
    ]),
  ]);
}
