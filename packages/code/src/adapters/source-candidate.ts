/** The source repository publishes installable development candidates. */
export const CANDIDATE_REPOSITORY = "getclarvis/clarvis";
const TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-rc\.([1-9]\d*)$/u;

export interface SourceCandidate {
  schema: 1;
  channel: "candidate";
  installation: "source-v1";
  tag: string;
  version: string;
  source_revision: string;
  repository: typeof CANDIDATE_REPOSITORY;
}

/** Reject stable tags, ambiguous RC numbers, and shell or URL metacharacters. */
export function candidateVersion(tag: string): string {
  const match = TAG.exec(tag);
  if (match?.[1] === undefined) throw new Error("expected a candidate tag such as v0.2.0-rc.1");
  return match[1];
}

/** Validate the exact source identity before installing its tagged checkout. */
export function parseSourceCandidate(value: unknown, tag: string): SourceCandidate {
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
  ];
  if (
    Object.keys(item).sort().join(",") !== keys.sort().join(",") ||
    item.schema !== 1 ||
    item.channel !== "candidate" ||
    item.installation !== "source-v1" ||
    item.tag !== tag ||
    item.version !== version ||
    item.repository !== CANDIDATE_REPOSITORY ||
    typeof item.source_revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(item.source_revision)
  )
    throw new Error("candidate manifest has invalid source identity");
  return item as unknown as SourceCandidate;
}
