/** The source repository is the sole publisher of installable development candidates. */
export const CANDIDATE_REPOSITORY = "getclarvis/clarvis";
const TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-rc\.([1-9]\d*)$/u;

export interface RuntimeCandidate {
  schema: 1;
  channel: "candidate";
  installation: "source-v1";
  tag: string;
  version: string;
  source_revision: string;
  repository: typeof CANDIDATE_REPOSITORY;
  kernel_wire_version: 11;
  broker_version: 1;
  channel_version: 1;
  targets: readonly ["linux-x64", "linux-arm64"];
  runtime: {
    schema_version: 2;
    version: string;
    source_revision: string;
    targets: Record<"linux-x64" | "linux-arm64", RuntimeCandidateTarget>;
  };
}

interface RuntimeCandidateTarget {
  base: { image: string; digest: `sha256:${string}`; abi: "clarvis-linux-glibc-v1" };
  artifact: { asset: string; sha256: string; size: number };
  kernel_wire_version: 11;
  broker_version: 1;
  channel_version: 1;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validTarget(value: unknown, target: "linux-x64" | "linux-arm64"): boolean {
  const root = record(value);
  const base = record(root?.base);
  const artifact = record(root?.artifact);
  return (
    root !== undefined &&
    base !== undefined &&
    artifact !== undefined &&
    Object.keys(root).sort().join(",") ===
      "artifact,base,broker_version,channel_version,kernel_wire_version" &&
    Object.keys(base).sort().join(",") === "abi,digest,image" &&
    Object.keys(artifact).sort().join(",") === "asset,sha256,size" &&
    typeof base.image === "string" &&
    /^[a-z0-9][a-z0-9._:/-]*$/u.test(base.image) &&
    typeof base.digest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(base.digest) &&
    base.abi === "clarvis-linux-glibc-v1" &&
    artifact.asset === `clarvis-kernel-${target}.tar.gz` &&
    typeof artifact.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
    typeof artifact.size === "number" &&
    Number.isSafeInteger(artifact.size) &&
    artifact.size > 0 &&
    artifact.size <= 512 * 1024 * 1024 &&
    root.kernel_wire_version === 11 &&
    root.broker_version === 1 &&
    root.channel_version === 1
  );
}

/** Reject stable tags, ambiguous RC numbers, and shell or URL metacharacters. */
export function candidateVersion(tag: string): string {
  const match = TAG.exec(tag);
  if (match?.[1] === undefined) throw new Error("expected a candidate tag such as v0.2.0-rc.1");
  return match[1];
}

/** Validate source identity and the embedded base/artifact release mapping. */
export function parseRuntimeCandidate(value: unknown, tag: string): RuntimeCandidate {
  const version = candidateVersion(tag);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("candidate manifest must be an object");
  const item = value as Record<string, unknown>;
  const keys = [
    "schema",
    "channel",
    "installation",
    "tag",
    "version",
    "source_revision",
    "repository",
    "kernel_wire_version",
    "broker_version",
    "channel_version",
    "targets",
    "runtime",
  ];
  const runtime = item.runtime as Record<string, unknown> | undefined;
  const runtimeTargets = runtime?.targets as Record<string, unknown> | undefined;
  if (
    Object.keys(item).sort().join(",") !== keys.sort().join(",") ||
    item.schema !== 1 ||
    item.channel !== "candidate" ||
    item.installation !== "source-v1" ||
    item.tag !== tag ||
    item.version !== version ||
    item.repository !== CANDIDATE_REPOSITORY ||
    typeof item.source_revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(item.source_revision) ||
    item.kernel_wire_version !== 11 ||
    item.broker_version !== 1 ||
    item.channel_version !== 1 ||
    JSON.stringify(item.targets) !== JSON.stringify(["linux-x64", "linux-arm64"]) ||
    runtime === undefined ||
    Object.keys(runtime).sort().join(",") !== "schema_version,source_revision,targets,version" ||
    runtime.schema_version !== 2 ||
    runtime.version !== version ||
    runtime.source_revision !== item.source_revision ||
    runtimeTargets === undefined ||
    Object.keys(runtimeTargets).sort().join(",") !== "linux-arm64,linux-x64" ||
    !validTarget(runtimeTargets["linux-x64"], "linux-x64") ||
    !validTarget(runtimeTargets["linux-arm64"], "linux-arm64")
  )
    throw new Error("candidate manifest has invalid source or Container runtime identity");
  return item as unknown as RuntimeCandidate;
}
