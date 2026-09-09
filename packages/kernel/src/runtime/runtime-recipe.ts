import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { sanitizeErrorMessage } from "@clarvis/capability";
import { acquireLocalLease, globalPaths, type RootOptions } from "@clarvis/paths";

import type { DockerCommandResult, DockerControl, DockerRunOptions } from "./docker-backend.ts";
import { RUNTIME_PROTOCOL_LABEL, RUNTIME_PROTOCOL_REVISION } from "./protocol-revision.ts";
import type { RuntimeSettingsBlock } from "./settings.ts";
import { RuntimeLaunchError } from "./types.ts";

const RECIPE_SCHEMA = "1";
const MAX_RECIPE_BYTES = 1024 * 1024;
const BUILD_TIMEOUT_MS = 30 * 60 * 1_000;
const LABEL_PREFIX = "io.clarvis.runtime.recipe";
const PROXY_ARGUMENTS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "FTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "ftp_proxy",
  "no_proxy",
  "all_proxy",
] as const;

type DockerRuntimeSettings = Extract<RuntimeSettingsBlock, { backend: "docker" }>;
type RuntimeRecipe = NonNullable<DockerRuntimeSettings["recipe"]>;

interface CapturedRecipe {
  readonly bytes: Uint8Array;
  readonly digest: string;
}

interface ImageInspect {
  readonly id: string;
  readonly labels: Readonly<Record<string, unknown>>;
}

interface RecipeIdentity {
  readonly key: string;
  readonly tag: string;
  readonly labels: Readonly<Record<string, string>>;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Host-only inputs for resolving one immutable local recipe image. */
export interface ResolveDockerRuntimeRecipeOptions {
  /** Cancel generation preparation, including a contended build lease. */
  readonly signal?: AbortSignal;
  readonly baseImageDigest: string;
  readonly recipe: RuntimeRecipe;
  readonly control: DockerControl;
  readonly roots?: RootOptions;
  readonly temporaryRoot?: string;
  /** Observes only a safe recipe name when an uncached identity needs preparation. */
  readonly onPreparation?: (name: string) => void;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function failureDetail(value: string): string {
  return sanitizeErrorMessage(value)
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseImageInspect(source: string, label: string): ImageInspect {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (cause) {
    throw new RuntimeLaunchError("runtime_recipe_failed", `${label} returned invalid JSON`, {
      cause,
    });
  }
  const root = record(Array.isArray(parsed) ? parsed[0] : parsed);
  const config = record(root?.Config);
  const labels = record(config?.Labels) ?? {};
  if (typeof root?.Id !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(root.Id)) {
    throw new RuntimeLaunchError("runtime_recipe_failed", `${label} returned an invalid image id`);
  }
  return { id: root.Id, labels };
}

async function runRecipeDocker(
  control: DockerControl,
  args: readonly string[],
  label: string,
  options?: DockerRunOptions,
): Promise<DockerCommandResult> {
  try {
    return await control.run(args, undefined, options);
  } catch (cause) {
    throw new RuntimeLaunchError("runtime_recipe_failed", `${label} could not be executed`, {
      cause,
    });
  }
}

/** Preserve a primary outcome while requiring sensitive scratch cleanup to settle. */
async function withRequiredCleanup<T>(
  work: () => Promise<T>,
  cleanup: () => Promise<void>,
  code: "runtime_recipe_invalid" | "runtime_recipe_failed",
  message: string,
): Promise<T> {
  let outcome:
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly cause: unknown };
  try {
    outcome = { ok: true, value: await work() };
  } catch (cause) {
    outcome = { ok: false, cause };
  }
  let cleanupFailure: { readonly cause: unknown } | undefined;
  try {
    await cleanup();
  } catch (cause) {
    cleanupFailure = { cause };
  }
  if (cleanupFailure !== undefined) {
    throw new RuntimeLaunchError(code, message, {
      cause: outcome.ok
        ? cleanupFailure.cause
        : new AggregateError([outcome.cause, cleanupFailure.cause]),
    });
  }
  if (!outcome.ok) throw outcome.cause;
  return outcome.value;
}

async function captureRecipe(path: string, recipeRoot: string): Promise<CapturedRecipe> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new RuntimeLaunchError(
      "runtime_recipe_invalid",
      "Docker runtime recipe script must be an absolute host path",
    );
  }
  let canonicalRoot: string;
  try {
    const rootInfo = await lstat(recipeRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("unsafe root");
    canonicalRoot = await realpath(recipeRoot);
  } catch (cause) {
    throw new RuntimeLaunchError(
      "runtime_recipe_invalid",
      "Docker runtime recipe directory is unavailable or unsafe",
      { cause },
    );
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    const pathInfo = await lstat(path);
    if (pathInfo.isSymbolicLink()) throw new Error("symbolic link");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    throw new RuntimeLaunchError(
      "runtime_recipe_invalid",
      "Docker runtime recipe script could not be opened safely",
      { cause },
    );
  }
  try {
    return await withRequiredCleanup(
      async () => {
        const before = await handle.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.size <= 0 ||
          before.size > MAX_RECIPE_BYTES
        ) {
          throw new RuntimeLaunchError(
            "runtime_recipe_invalid",
            "Docker runtime recipe script must be a single-linked non-empty regular file no larger than 1 MiB",
          );
        }
        try {
          const canonicalPath = await realpath(path);
          const linked = await stat(canonicalPath);
          if (
            !isWithin(canonicalRoot, canonicalPath) ||
            linked.dev !== before.dev ||
            linked.ino !== before.ino
          ) {
            throw new Error("outside operator recipe directory");
          }
        } catch (cause) {
          throw new RuntimeLaunchError(
            "runtime_recipe_invalid",
            "Docker runtime recipe script must resolve inside the operator recipe directory",
            { cause },
          );
        }
        const storage = Buffer.allocUnsafe(MAX_RECIPE_BYTES + 1);
        let length = 0;
        while (length < storage.byteLength) {
          const { bytesRead } = await handle.read(
            storage,
            length,
            storage.byteLength - length,
            length,
          );
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        const bytes = storage.subarray(0, length);
        const after = await handle.stat();
        if (
          bytes.byteLength > MAX_RECIPE_BYTES ||
          bytes.byteLength !== before.size ||
          after.size !== before.size ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.nlink !== 1 ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          bytes.includes(0)
        ) {
          throw new RuntimeLaunchError(
            "runtime_recipe_invalid",
            "Docker runtime recipe script changed during capture or contains invalid bytes",
          );
        }
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch (cause) {
          throw new RuntimeLaunchError(
            "runtime_recipe_invalid",
            "Docker runtime recipe script must be valid UTF-8",
            { cause },
          );
        }
        return { bytes, digest: sha256(bytes) };
      },
      () => handle.close(),
      "runtime_recipe_invalid",
      "Docker runtime recipe script could not be closed safely",
    );
  } catch (cause) {
    if (cause instanceof RuntimeLaunchError) throw cause;
    throw new RuntimeLaunchError(
      "runtime_recipe_invalid",
      "Docker runtime recipe script could not be captured safely",
      { cause },
    );
  }
}

function recipeIdentity(
  baseImageDigest: string,
  recipe: RuntimeRecipe,
  scriptDigest: string,
): RecipeIdentity {
  const builderDigest = sha256(
    JSON.stringify({ containerfile: containerfile(), proxyArguments: PROXY_ARGUMENTS }),
  );
  const key = sha256(
    JSON.stringify({
      schema: RECIPE_SCHEMA,
      builderDigest,
      baseImageDigest,
      name: recipe.name,
      network: recipe.network,
      scriptDigest,
    }),
  );
  const labels = {
    [`${LABEL_PREFIX}.base`]: baseImageDigest,
    [`${LABEL_PREFIX}.builder`]: builderDigest,
    [`${LABEL_PREFIX}.digest`]: scriptDigest,
    [`${LABEL_PREFIX}.key`]: key,
    [`${LABEL_PREFIX}.name`]: recipe.name,
    [`${LABEL_PREFIX}.schema`]: RECIPE_SCHEMA,
  };
  return {
    key,
    tag: `clarvis-runtime-recipe:${key.slice("sha256:".length)}`,
    labels,
  };
}

function validRecipeImage(image: ImageInspect, identity: RecipeIdentity): boolean {
  return (
    image.labels[RUNTIME_PROTOCOL_LABEL] === RUNTIME_PROTOCOL_REVISION &&
    Object.entries(identity.labels).every(([name, value]) => image.labels[name] === value)
  );
}

async function inspectOptionalRecipeImage(
  control: DockerControl,
  identity: RecipeIdentity,
): Promise<string | undefined> {
  const inspected = await runRecipeDocker(
    control,
    ["image", "inspect", identity.tag],
    "Docker runtime recipe image inspection",
  );
  if (inspected.exitCode !== 0) return undefined;
  const image = parseImageInspect(inspected.stdout, "Docker runtime recipe image inspection");
  if (!validRecipeImage(image, identity)) {
    throw new RuntimeLaunchError(
      "runtime_recipe_failed",
      "Docker runtime recipe cache identity did not match its content-addressed tag",
    );
  }
  return image.id;
}

function containerfile(): string {
  return `ARG CLARVIS_RUNTIME_BASE
FROM \${CLARVIS_RUNTIME_BASE}
USER root
RUN --mount=type=bind,source=recipe.sh,target=/run/clarvis-runtime-recipe.sh,readonly \\
    /bin/sh -eu /run/clarvis-runtime-recipe.sh \\
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb /var/cache/apk/*
`;
}

async function ensureBuildBaseReference(
  control: DockerControl,
  baseImageDigest: string,
): Promise<string> {
  const reference = `clarvis-runtime-recipe-base:${baseImageDigest.slice("sha256:".length)}`;
  const tagged = await runRecipeDocker(
    control,
    ["image", "tag", baseImageDigest, reference],
    "Docker runtime recipe base tagging",
  );
  if (tagged.exitCode !== 0) {
    throw new RuntimeLaunchError(
      "runtime_recipe_failed",
      "Docker could not create the private content-addressed recipe base reference",
    );
  }
  const inspected = await runRecipeDocker(
    control,
    ["image", "inspect", reference],
    "Docker runtime recipe base reference inspection",
  );
  if (inspected.exitCode !== 0) {
    throw new RuntimeLaunchError(
      "runtime_recipe_failed",
      "Docker did not retain the private content-addressed recipe base reference",
    );
  }
  const image = parseImageInspect(inspected.stdout, "Docker runtime recipe base reference");
  if (
    image.id !== baseImageDigest ||
    image.labels[RUNTIME_PROTOCOL_LABEL] !== RUNTIME_PROTOCOL_REVISION
  ) {
    throw new RuntimeLaunchError(
      "handshake_mismatch",
      "Docker runtime recipe base reference changed before build",
    );
  }
  return reference;
}

async function buildRecipeImage(
  options: ResolveDockerRuntimeRecipeOptions,
  captured: CapturedRecipe,
  identity: RecipeIdentity,
): Promise<string> {
  const baseReference = await ensureBuildBaseReference(options.control, options.baseImageDigest);
  let context: string;
  try {
    context = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), "clarvis-runtime-recipe-"));
  } catch (cause) {
    throw new RuntimeLaunchError(
      "runtime_recipe_failed",
      "Docker runtime recipe private build context could not be created",
      { cause },
    );
  }
  try {
    return await withRequiredCleanup(
      async () => {
        await chmod(context, 0o700);
        const dockerfile = join(context, "Containerfile");
        await Promise.all([
          writeFile(dockerfile, containerfile(), { mode: 0o600 }),
          writeFile(join(context, "recipe.sh"), captured.bytes, { mode: 0o400 }),
          writeFile(join(context, ".dockerignore"), "*\n!Containerfile\n!recipe.sh\n", {
            mode: 0o600,
          }),
        ]);
        const labels = Object.entries(identity.labels).flatMap(([name, value]) => [
          "--label",
          `${name}=${value}`,
        ]);
        const proxyArguments = PROXY_ARGUMENTS.flatMap((name) => ["--build-arg", `${name}=`]);
        const result = await runRecipeDocker(
          options.control,
          [
            "build",
            "--quiet",
            "--pull=false",
            `--network=${options.recipe.network === "none" ? "none" : "default"}`,
            "--build-arg",
            `CLARVIS_RUNTIME_BASE=${baseReference}`,
            ...proxyArguments,
            ...labels,
            "--tag",
            identity.tag,
            "--file",
            dockerfile,
            context,
          ],
          `Docker runtime recipe '${options.recipe.name}' build`,
          { timeoutMs: BUILD_TIMEOUT_MS },
        );
        if (result.exitCode !== 0) {
          const detail = failureDetail(result.stderr);
          throw new RuntimeLaunchError(
            "runtime_recipe_failed",
            `Docker runtime recipe '${options.recipe.name}' failed with exit code ${String(result.exitCode)}${detail.length === 0 ? "" : `: ${detail}`}`,
          );
        }
        const imageDigest = await inspectOptionalRecipeImage(options.control, identity);
        if (imageDigest === undefined) {
          throw new RuntimeLaunchError(
            "runtime_recipe_failed",
            "Docker did not retain the completed runtime recipe image",
          );
        }
        return imageDigest;
      },
      () => rm(context, { recursive: true, force: true }),
      "runtime_recipe_failed",
      "Docker runtime recipe private build context could not be removed",
    );
  } catch (cause) {
    if (cause instanceof RuntimeLaunchError) throw cause;
    throw new RuntimeLaunchError(
      "runtime_recipe_failed",
      "Docker runtime recipe private build context could not be prepared",
      { cause },
    );
  }
}

async function resolveDockerRuntimeRecipeChecked(
  options: ResolveDockerRuntimeRecipeOptions,
): Promise<string> {
  const baseResult = await runRecipeDocker(
    options.control,
    ["image", "inspect", options.baseImageDigest],
    "Docker runtime recipe base image inspection",
  );
  if (baseResult.exitCode !== 0) {
    throw new RuntimeLaunchError(
      "runtime_recipe_failed",
      "Docker runtime recipe base image is not installed",
    );
  }
  const base = parseImageInspect(baseResult.stdout, "Docker runtime recipe base image inspection");
  if (
    base.id !== options.baseImageDigest ||
    base.labels[RUNTIME_PROTOCOL_LABEL] !== RUNTIME_PROTOCOL_REVISION
  ) {
    throw new RuntimeLaunchError(
      "handshake_mismatch",
      "Docker runtime recipe base image identity or protocol did not match admission",
    );
  }
  const captured = await captureRecipe(
    options.recipe.script,
    globalPaths(undefined, options.roots).runtimeRecipesDir,
  );
  const identity = recipeIdentity(options.baseImageDigest, options.recipe, captured.digest);
  const cached = await inspectOptionalRecipeImage(options.control, identity);
  if (cached !== undefined) return cached;
  try {
    options.onPreparation?.(options.recipe.name);
  } catch (cause) {
    throw new RuntimeLaunchError(
      "runtime_recipe_failed",
      "Docker runtime recipe preparation could not be announced",
      { cause },
    );
  }
  let lease;
  try {
    lease = await acquireLocalLease(
      globalPaths(undefined, options.roots).runtimeRecipeLeaseFile(identity.key),
      {
        staleMs: 60_000,
        waitMs: BUILD_TIMEOUT_MS,
        retryMs: 250,
        heartbeatMs: 5_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
  } catch (cause) {
    throw new RuntimeLaunchError(
      "runtime_recipe_failed",
      "Docker runtime recipe build coordination failed",
      { cause },
    );
  }
  if (lease === null) {
    throw new RuntimeLaunchError(
      "runtime_recipe_failed",
      "Docker runtime recipe build is still owned by another Clarvis process",
    );
  }
  return withRequiredCleanup(
    async () => {
      const builtByPeer = await inspectOptionalRecipeImage(options.control, identity);
      return builtByPeer ?? (await buildRecipeImage(options, captured, identity));
    },
    async () => {
      if (!(await lease.release()))
        throw new Error("runtime recipe build lease ownership was lost");
    },
    "runtime_recipe_failed",
    "Docker runtime recipe build coordination could not be released",
  );
}

/** Resolve or build one host-owned, content-addressed Docker runtime recipe. */
export async function resolveDockerRuntimeRecipe(
  options: ResolveDockerRuntimeRecipeOptions,
): Promise<string> {
  try {
    return await resolveDockerRuntimeRecipeChecked(options);
  } catch (cause) {
    if (cause instanceof RuntimeLaunchError) throw cause;
    throw new RuntimeLaunchError(
      "runtime_recipe_failed",
      "Docker runtime recipe resolution failed",
      { cause },
    );
  }
}
