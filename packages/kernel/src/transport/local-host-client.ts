import { z } from "zod";
import type {
  KernelTransport,
  LocalHostService,
  LocalHostStatus,
  LocalHostBrowserRequest,
} from "@clarvis/protocol";
import { runtimeStatusSchema } from "../runtime/status-schema.ts";
import { kernelError } from "../core/errors.ts";
import { createServiceProxy, OPERATIONS } from "./operations.ts";

const text = z.string().max(4096);
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const runtime = runtimeStatusSchema({ identifier: text, text });
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
