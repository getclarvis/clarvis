import { z } from "zod";
import type {
  KernelTransport,
  LocalHostService,
  LocalHostStatus,
  LocalHostBrowserRequest,
} from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import { createServiceProxy, OPERATIONS } from "./operations.ts";

const text = z.string().max(4096);
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const runtime = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("native"),
      host_platform: text,
      isolation: z.enum(["host", "sandbox"]),
      lifecycle: z.enum(["ready", "fallback"]),
      fallback_from: z.enum(["docker", "podman"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("container"),
      engine: z.enum(["docker", "podman"]),
      host_platform: text,
      guest_platform: z.literal("linux"),
      network: z.enum(["none", "internet", "outbound"]),
      generation: text.optional(),
      engine_version: text.optional(),
      image_digest: text.optional(),
      runtime_protocol_revision: text.optional(),
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
    })
    .strict(),
]);
const status = z
  .object({
    host_generation: z.string().min(1).max(256),
    runtime,
    runtime_notice: z.object({ sequence, message: text }).strict().optional(),
    extension_drift: z
      .object({
        sequence,
        kind: z.enum(["skill", "plugin_runtime"]),
        name: text,
        source: text.optional(),
      })
      .strict()
      .optional(),
    restart_requested: z.boolean(),
  })
  .strict();
const browser = z
  .object({
    id: z.string().uuid(),
    url: z
      .string()
      .max(16_384)
      .url()
      .refine((value) => {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && !parsed.username && !parsed.password;
      }),
    expires_at: sequence,
  })
  .strict()
  .nullable();

/** Decode bounded operator responses before exposing them to a browser or TUI projection. */
export function createLocalHostClient(
  transport: KernelTransport,
  generation: string,
): LocalHostService {
  const service = createServiceProxy<LocalHostService>(transport, OPERATIONS.localHost);
  return {
    ...service,
    async inspect(): Promise<LocalHostStatus> {
      const decoded = status.safeParse(await service.inspect());
      if (!decoded.success || decoded.data.host_generation !== generation)
        throw kernelError("unavailable", "invalid local host status");
      return decoded.data;
    },
    async takeBrowserRequest(): Promise<LocalHostBrowserRequest | null> {
      const decoded = browser.safeParse(await service.takeBrowserRequest());
      if (!decoded.success) throw kernelError("unavailable", "invalid local browser handoff");
      return decoded.data;
    },
  };
}
