import { z } from "zod";
import {
  canonicalContainerJson,
  containerConfigurationDigest,
  containerConfigurationSchema,
} from "../config/container-projection.ts";
import { kernelError, KernelException } from "../core/errors.ts";

/** Private bootstrap versions are independent of any retired worker protocol. */
export const CONTAINER_BROKER_VERSION = 1;
export const CONTAINER_CHANNEL_VERSION = 1;
export const CONTAINER_BASE_ABI = "clarvis-linux-glibc-v1";
export const CONTAINER_BOOT_TIMEOUT_MS = 30_000;
export const CONTAINER_PREPARATION_TIMEOUT_MS = 600_000;
const CONTAINER_INITIALIZE_MAX_BYTES = 8 * 1024 * 1024;
export const CONTAINER_MODEL_LEASE_MS = 24 * 60 * 60 * 1000;

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = integer.positive();
const identifier = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const digest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u)
  .transform((value) => value as `sha256:${string}`);
const pair = z.object({ provider: identifier, model: identifier }).strict();

/** A generation's public-to-guest inference authority contains no provider destination or credential. */
const containerModelLeaseSchema = z
  .object({
    leaseId: hash,
    models: z.array(pair).max(4096),
    expiresAt: positive,
    limits: z
      .object({
        maxConcurrent: positive,
        maxQueued: integer,
        tokenCeiling: positive,
        hostMaxRetries: integer,
        maxResponseBytes: positive.max(32 * 1024 * 1024),
        maxRetryAfterMs: integer,
        maxTimeoutMs: positive,
        defaultTimeoutMs: positive,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = value.models.map((model) => JSON.stringify([model.provider, model.model]));
    if (
      new Set(keys).size !== keys.length ||
      value.limits.defaultTimeoutMs > value.limits.maxTimeoutMs
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid model lease limits or catalog" });
    }
  });

/** No paths, argv, environment, authentication alternatives or extra roots are admitted. */
export const containerInitializeSchema = z
  .object({
    generation: z.uuid(),
    workspaceIdentity: z
      .object({
        project: z.object({ id: identifier, label: z.string().max(4096).optional() }).strict(),
        workspace: z
          .object({
            id: identifier,
            projectId: identifier,
            label: z.string().max(4096),
            kind: z.enum(["primary", "external_worktree"]),
            path: z.literal("/workspace"),
          })
          .strict(),
        namespace: hash,
      })
      .strict(),
    owner: z.string().refine((value) => value.trim() !== ""),
    runtime: z
      .object({
        engine: z.enum(["docker", "podman"]),
        hostPlatform: z.enum(["linux", "darwin", "win32"]),
        network: z.enum(["none", "outbound"]),
        baseDigest: digest,
        baseAbi: z.literal(CONTAINER_BASE_ABI),
      })
      .strict(),
    artifactDigest: digest,
    configDigest: digest,
    configuration: containerConfigurationSchema,
    modelLease: containerModelLeaseSchema,
  })
  .strict();

export type ContainerInitialize = z.infer<typeof containerInitializeSchema>;

/** Validate immutable identity and the complete bounded bootstrap before constructing native services. */
export function parseContainerInitialize(value: unknown, now = Date.now()): ContainerInitialize {
  try {
    canonicalContainerJson(value, CONTAINER_INITIALIZE_MAX_BYTES);
    const parsed = containerInitializeSchema.safeParse(value);
    if (!parsed.success) throw kernelError("invalid_request", "Invalid Container bootstrap");
    const input = parsed.data;
    const { project, workspace } = input.workspaceIdentity;
    const lease = input.modelLease;
    if (
      project.id !== workspace.projectId ||
      input.configuration.loopPolicy.CLARVIS_OWNER !== input.owner
    ) {
      throw kernelError("invalid_request", "Container bootstrap identity mismatch");
    }
    if (containerConfigurationDigest(input.configuration) !== input.configDigest) {
      throw kernelError("invalid_request", "Container configuration digest mismatch");
    }
    const catalog = new Set(
      input.configuration.modelCatalog.map((model) =>
        JSON.stringify([model.provider, model.model]),
      ),
    );
    if (
      lease.models.length !== catalog.size ||
      lease.models.some((model) => !catalog.has(JSON.stringify([model.provider, model.model])))
    ) {
      throw kernelError("invalid_request", "Container model lease catalog mismatch");
    }
    if (
      !Number.isSafeInteger(now) ||
      lease.expiresAt <= now ||
      lease.expiresAt - now > CONTAINER_MODEL_LEASE_MS
    ) {
      throw kernelError("unauthorized", "Container model lease is expired or invalid");
    }
    return input;
  } catch (error) {
    if (error instanceof KernelException) throw error;
    if (error instanceof RangeError)
      throw kernelError("resource_exhausted", "Container bootstrap exceeds its byte limit");
    throw kernelError("invalid_request", "Invalid Container bootstrap");
  }
}

/** Ready identity is checked by the launcher before opening Kernel and model dispatch. */
export const containerReadySchema = z
  .object({
    ready: z.literal(true),
    generation: z.uuid(),
    artifactDigest: digest,
    configDigest: digest,
    kernelWireVersion: z.literal(11),
    brokerVersion: z.literal(CONTAINER_BROKER_VERSION),
  })
  .strict();
