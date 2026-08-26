import { z } from "zod";

import { resolveStringMapWith } from "./env-interpolate.ts";

/** Current version of the language-neutral capability executable protocol. */
export const CAPABILITY_EXECUTABLE_PROTOCOL_VERSION = 1 as const;

const executableEnvSchema = z.record(z.string(), z.string());

/** A platform-specific replacement for an executable's argv and environment. */
export const capabilityExecutablePlatformSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: executableEnvSchema.optional(),
  })
  .strict();

/** Serializable declaration shared by settings and plugin manifests. */
export const capabilityExecutableDeclarationSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: executableEnvSchema.default({}),
    platforms: z.record(z.string().min(1), capabilityExecutablePlatformSchema).optional(),
    timeout_ms: z.number().int().positive().max(600_000).default(30_000),
  })
  .strict();

/** Executables a plugin offers, keyed by the Clarvis capability name. */
export const capabilityExecutablesSchema = z.record(
  z.string().min(1),
  capabilityExecutableDeclarationSchema,
);

export type CapabilityExecutablePlatform = z.infer<typeof capabilityExecutablePlatformSchema>;
export type CapabilityExecutableDeclaration = z.infer<typeof capabilityExecutableDeclarationSchema>;

/** Declaration after platform selection and environment interpolation. */
export interface EffectiveCapabilityExecutable {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeout_ms: number;
  platform: string;
}

/** Resolve one declaration without consulting a shell or the filesystem. */
export function resolveCapabilityExecutable(
  declaration: CapabilityExecutableDeclaration,
  platform: string,
  environment: Readonly<Record<string, string | undefined>>,
): EffectiveCapabilityExecutable {
  const parsed = capabilityExecutableDeclarationSchema.parse(declaration);
  const override = parsed.platforms?.[platform];
  const envTemplates = { ...parsed.env, ...(override?.env ?? {}) };
  return {
    command: override?.command ?? parsed.command,
    args: [...(override?.args ?? parsed.args)],
    env: resolveStringMapWith(envTemplates, (name) => environment[name]),
    timeout_ms: parsed.timeout_ms,
    platform,
  };
}

/** Successful result of the mandatory `initialize` call. */
export interface CapabilityExecutableInitialization {
  protocol_version: 1;
  provider_kind: string;
  writable?: boolean;
}

/** A persistent initialized JSON-RPC session. */
export interface CapabilityExecutableSession {
  readonly providerKind: string;
  readonly writable?: boolean;
  request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

/** Input to the kernel-owned executable session pool. */
export interface CapabilityExecutableSessionInput {
  capability: string;
  workspace: string;
  cwd: string;
  declaration: CapabilityExecutableDeclaration;
  /**
   * The owner this session's work is being done for.
   *
   * @remarks Sessions are pooled on `(capability, workspace, cwd, command,
   * args, env, timeout, platform)` and **not** on this field, so two owners
   * reach the same child process. Both consumers cope with that the same way:
   * `plans` and `memory` each put `owner` in every JSON-RPC request they send,
   * so the executable can separate the work itself.
   *
   * On top of that, and only for `plans`, the kernel's session manager refuses
   * a second owner outright — "v1 allows one owner". The restriction is
   * conservatism, not a protocol limitation: the per-request `owner` is there in
   * both directions, and `memory` shares one session across owners with no such
   * check. What it costs is precise and worth knowing before relaxing or
   * spreading it: under multi-owner the second owner's plan-provider resolution
   * throws and stays unavailable for that process, because the provider memoizes
   * per owner while the pool does not. What "v2" would be is undecided — no
   * second behaviour exists anywhere in the tree to describe — so the choice
   * between deleting the check and giving `memory` one is open.
   */
  owner?: string;
}

/** Narrow process-session port consumed by capability packages. */
export interface CapabilityExecutablePort {
  session(input: CapabilityExecutableSessionInput): Promise<CapabilityExecutableSession>;
}

/** JSON-RPC error returned by a capability executable. */
export class CapabilityExecutableRpcError extends Error {
  constructor(
    message: string,
    readonly rpcCode: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CapabilityExecutableRpcError";
  }

  get domainCode(): string | undefined {
    if (typeof this.data !== "object" || this.data === null) return undefined;
    const code = (this.data as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
}
