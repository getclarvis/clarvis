import { RuntimeLaunchError, type ContainerControl } from "./types.ts";
import { CONTAINER_BASE_ABI } from "../hosting/container-contract.ts";

/** A local development tag or release-manifest-pinned Container base reference. */
export interface ContainerBaseImageSelection {
  readonly reference: string;
  readonly pull: boolean;
}

const LOCAL_IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?$/u;
const PINNED_IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u;
const PREFIXED_IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const UNPREFIXED_IMAGE_ID = /^[a-f0-9]{64}$/u;

/**
 * Canonicalize a complete local OCI image ID.
 *
 * @remarks Docker inspect typically already prefixes `sha256:`. Podman inspect of a
 * locally built image often returns the same 64 lowercase hex digits without that
 * prefix. Short IDs, tags, and manifest digests stay rejected.
 */
export function canonicalLocalImageId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (PREFIXED_IMAGE_ID.test(value)) return value;
  return UNPREFIXED_IMAGE_ID.test(value) ? `sha256:${value}` : undefined;
}

function imageIdentity(source: string): { id: string; abi: string; revision: string } | undefined {
  try {
    const parsed = JSON.parse(source) as unknown;
    const item: unknown = Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed;
    if (typeof item !== "object" || item === null) return undefined;
    const image = item as { Id?: unknown; Config?: unknown };
    const id = typeof image.Id === "string" ? canonicalLocalImageId(image.Id) : undefined;
    const config =
      typeof image.Config === "object" && image.Config !== null
        ? (image.Config as Record<string, unknown>)
        : undefined;
    const labels =
      typeof config?.Labels === "object" && config.Labels !== null
        ? (config.Labels as Record<string, unknown>)
        : undefined;
    const abi = labels?.["io.clarvis.base.abi"];
    const revision = labels?.["io.clarvis.base.revision"];
    return id !== undefined && typeof abi === "string" && typeof revision === "string"
      ? { id, abi, revision }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Inspect and admit an immutable local base before any preparer may execute from it. */
export async function inspectContainerBaseImage(input: {
  readonly reference: string;
  readonly control: ContainerControl;
  readonly engine: "Docker" | "Podman";
  readonly signal?: AbortSignal;
}): Promise<string> {
  const inspected = await input.control.run(["image", "inspect", input.reference], input.signal);
  if (inspected.exitCode !== 0)
    throw new RuntimeLaunchError("operational_failure", "Clarvis Container base is not installed");
  const identity = imageIdentity(inspected.stdout);
  if (identity === undefined)
    throw new RuntimeLaunchError(
      "handshake_mismatch",
      `${input.engine} returned an invalid Container base identity`,
    );
  if (identity.abi !== CONTAINER_BASE_ABI || !/^[a-f0-9]{64}$/u.test(identity.revision))
    throw new RuntimeLaunchError(
      "handshake_mismatch",
      "Container base identity or ABI did not match admission",
    );
  return identity.id;
}

/** Resolve a persisted digest or inspect the selected engine's image on first use. */
export async function resolveContainerImageDigest(input: {
  readonly configured: string | undefined;
  readonly control: ContainerControl;
  readonly resolveImage?: (signal?: AbortSignal) => Promise<ContainerBaseImageSelection>;
  readonly engine: "Docker" | "Podman";
  readonly signal?: AbortSignal;
}): Promise<string> {
  if (input.configured !== undefined) {
    const configured = canonicalLocalImageId(input.configured);
    if (configured === undefined)
      throw new RuntimeLaunchError(
        "invalid_launch_spec",
        "Configured Container base image id is invalid",
      );
    const admitted = await inspectContainerBaseImage({
      reference: configured,
      control: input.control,
      engine: input.engine,
      signal: input.signal,
    });
    if (admitted !== configured)
      throw new RuntimeLaunchError(
        "handshake_mismatch",
        "Configured Container base image id did not match engine inspection",
      );
    return admitted;
  }
  let selected: ContainerBaseImageSelection;
  try {
    selected =
      (await input.resolveImage?.(input.signal)) ??
      ({ reference: "clarvis-base:local", pull: false } as const);
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "runtime_image_integrity"
    ) {
      throw new RuntimeLaunchError(
        "invalid_launch_spec",
        "Clarvis Container base identity could not be verified",
        { cause },
      );
    }
    throw new RuntimeLaunchError(
      "operational_failure",
      "Clarvis Container base could not be resolved",
      { cause },
    );
  }
  if (
    (selected.pull && !PINNED_IMAGE.test(selected.reference)) ||
    (!selected.pull && !LOCAL_IMAGE.test(selected.reference))
  ) {
    throw new RuntimeLaunchError(
      "operational_failure",
      "Clarvis Container base reference is invalid",
    );
  }
  if (selected.pull) {
    const pulled = await input.control.run(["pull", selected.reference], input.signal, {
      timeoutMs: 15 * 60_000,
    });
    if (pulled.exitCode !== 0) {
      throw new RuntimeLaunchError("operational_failure", "Clarvis Container base download failed");
    }
  }
  return inspectContainerBaseImage({
    reference: selected.reference,
    control: input.control,
    engine: input.engine,
    signal: input.signal,
  });
}
