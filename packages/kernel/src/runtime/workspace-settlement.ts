import type { ElicitRawResult } from "@clarvis/loop";
import type {
  WorkspaceMergeChangeDetail,
  WorkspaceMergeElicitationDetail,
} from "@clarvis/protocol";
import type { RootOptions } from "@clarvis/paths";

import type { HostElicitationParams } from "../runs/elicit-bridge.ts";
import {
  applyRuntimeWorkspaceReview,
  reviewRuntimeWorkspace,
  type WorkspaceApplyControl,
} from "./workspace-apply.ts";
import type { RuntimeRecord } from "./runtime-store.ts";
import type { WorkspaceManifestEntry, WorkspaceScanLimits } from "./workspace-copy.ts";

/** Trusted host channel used to suspend terminal settlement for a merge decision. */
export type HostWorkspaceMergeElicit = (
  params: HostElicitationParams,
  opts?: { signal?: AbortSignal },
) => Promise<ElicitRawResult>;

/** Outcome retained by the host independently of a guest completion report. */
export type RuntimeWorkspaceSettlement =
  | { readonly action: "unchanged" }
  | { readonly action: "accepted"; readonly changeSetId: string; readonly record: RuntimeRecord }
  | { readonly action: "declined" | "cancelled"; readonly changeSetId: string };

function projectChange(
  action: WorkspaceMergeChangeDetail["action"],
  entry: WorkspaceManifestEntry,
): WorkspaceMergeChangeDetail {
  return {
    path: entry.path,
    action,
    type: entry.type,
    mode: entry.mode,
    ...(entry.type === "file"
      ? { size: entry.size, digest: entry.digest }
      : { target: entry.target }),
  };
}

/** Ask exactly once for every modifying run and apply only an accepted exact review. */
export async function settleRuntimeWorkspace(
  sourceWorkspaceRoot: string,
  runtimeId: string,
  elicit: HostWorkspaceMergeElicit,
  options: {
    readonly roots?: RootOptions;
    readonly limits?: WorkspaceScanLimits;
    readonly signal?: AbortSignal;
    readonly applyControl?: WorkspaceApplyControl;
  } = {},
): Promise<RuntimeWorkspaceSettlement> {
  const review = await reviewRuntimeWorkspace(
    sourceWorkspaceRoot,
    runtimeId,
    options.roots,
    options.limits,
  );
  if (review === null) return { action: "unchanged" };
  const detail: WorkspaceMergeElicitationDetail = {
    change_set_id: review.changeSet.id,
    baseline_revision: review.changeSet.baselineDigest,
    content_digest: review.changeSet.currentDigest,
    changes: [
      ...review.changeSet.added.map((entry) => projectChange("add", entry)),
      ...review.changeSet.modified.map((entry) => projectChange("modify", entry)),
      ...review.changeSet.deleted.map((entry) => projectChange("delete", entry)),
    ],
  };
  const result = await elicit(
    {
      kind: "workspace_merge",
      prompt: "Merge all reviewed isolated-workspace changes into the host workspace?",
      schema: {
        type: "object",
        properties: { decision: { type: "string", enum: ["merge"] } },
        required: ["decision"],
        additionalProperties: false,
      },
      detail,
    },
    { signal: options.signal },
  );
  if (result.action === "decline") {
    return { action: "declined", changeSetId: review.changeSet.id };
  }
  if (result.action === "cancel") {
    return { action: "cancelled", changeSetId: review.changeSet.id };
  }
  const record = await applyRuntimeWorkspaceReview(
    sourceWorkspaceRoot,
    runtimeId,
    review,
    options.roots,
    options.limits,
    options.applyControl,
  );
  return { action: "accepted", changeSetId: review.changeSet.id, record };
}
