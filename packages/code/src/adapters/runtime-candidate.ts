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
  repository: string;
  protocol_revision: string;
  platforms: string[];
  artifact_image: string;
  runtime_image: string;
}

/** Reject stable tags, ambiguous RC numbers, and shell or URL metacharacters. */
export function candidateVersion(tag: string): string {
  const match = TAG.exec(tag);
  if (match?.[1] === undefined) throw new Error("expected a candidate tag such as v0.2.0-rc.1");
  return match[1];
}

/** Validate the complete source-install contract before downloading code or selecting an image. */
export function parseRuntimeCandidate(value: unknown, tag: string): RuntimeCandidate {
  const version = candidateVersion(tag);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("candidate manifest must be an object");
  }
  const item = value as Record<string, unknown>;
  const keys = [
    "schema",
    "channel",
    "installation",
    "tag",
    "version",
    "source_revision",
    "repository",
    "protocol_revision",
    "platforms",
    "artifact_image",
    "runtime_image",
  ];
  if (
    Object.keys(item).length !== keys.length ||
    keys.some((key) => !(key in item)) ||
    item.schema !== 1 ||
    item.channel !== "candidate" ||
    item.installation !== "source-v1" ||
    item.tag !== tag ||
    item.version !== version ||
    item.repository !== CANDIDATE_REPOSITORY ||
    typeof item.source_revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(item.source_revision) ||
    typeof item.protocol_revision !== "string" ||
    !/^[1-9]\d*$/u.test(item.protocol_revision) ||
    JSON.stringify(item.platforms) !== JSON.stringify(["linux/amd64", "linux/arm64"]) ||
    typeof item.runtime_image !== "string" ||
    !/^ghcr\.io\/getclarvis\/clarvis-runtime-candidate@sha256:[a-f0-9]{64}$/u.test(
      item.runtime_image,
    ) ||
    typeof item.artifact_image !== "string" ||
    !/^ghcr\.io\/getclarvis\/clarvis-runtime-candidate-artifact@sha256:[a-f0-9]{64}$/u.test(
      item.artifact_image,
    )
  )
    throw new Error(
      "candidate manifest is not an installable source-v1 candidate or has invalid identity",
    );
  return item as unknown as RuntimeCandidate;
}
