import { RuntimeLaunchError, type ContainerControl } from "./types.ts";

/** A local development tag or release-manifest-pinned image reference. */
export interface RuntimeImageSelection {
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

function imageId(source: string): string | undefined {
  try {
    const parsed = JSON.parse(source) as unknown;
    const item: unknown = Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed;
    if (typeof item !== "object" || item === null) return undefined;
    const id = (item as { Id?: unknown }).Id;
    return typeof id === "string" ? canonicalLocalImageId(id) : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a persisted digest or inspect the selected engine's image on first use. */
export async function resolveContainerImageDigest(input: {
  readonly configured: string | undefined;
  readonly control: ContainerControl;
  readonly resolveImage?: (signal?: AbortSignal) => Promise<RuntimeImageSelection>;
  readonly engine: "Docker" | "Podman";
  readonly signal?: AbortSignal;
}): Promise<string> {
  if (input.configured !== undefined) return input.configured;
  let selected: RuntimeImageSelection;
  try {
    selected =
      (await input.resolveImage?.(input.signal)) ??
      ({ reference: "clarvis-runtime:development", pull: false } as const);
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "runtime_image_integrity"
    ) {
      throw new RuntimeLaunchError(
        "invalid_launch_spec",
        "Clarvis runtime image identity could not be verified",
        { cause },
      );
    }
    throw new RuntimeLaunchError(
      "operational_failure",
      "Clarvis runtime image could not be resolved",
      { cause },
    );
  }
  if (
    (selected.pull && !PINNED_IMAGE.test(selected.reference)) ||
    (!selected.pull && !LOCAL_IMAGE.test(selected.reference))
  ) {
    throw new RuntimeLaunchError(
      "operational_failure",
      "Clarvis runtime image reference is invalid",
    );
  }
  if (selected.pull) {
    const pulled = await input.control.run(["pull", selected.reference], undefined, {
      timeoutMs: 15 * 60_000,
    });
    if (pulled.exitCode !== 0) {
      throw new RuntimeLaunchError("operational_failure", "Clarvis runtime image download failed");
    }
  }
  const inspected = await input.control.run(["image", "inspect", selected.reference]);
  if (inspected.exitCode !== 0) {
    throw new RuntimeLaunchError("operational_failure", "Clarvis runtime image is not installed");
  }
  const digest = imageId(inspected.stdout);
  if (digest === undefined) {
    throw new RuntimeLaunchError(
      "operational_failure",
      `${input.engine} returned an invalid runtime image id`,
    );
  }
  return digest;
}
