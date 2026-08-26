import type { ProjectRef, WorkspaceRef } from "@clarvis/protocol";

export function kernelIdentity(
  workspaceRoot: string,
  workspaceId = "ws_test",
  projectId = "prj_test",
): {
  project: ProjectRef;
  workspace: WorkspaceRef;
} {
  const project: ProjectRef = { id: projectId, label: "Test project" };
  return {
    project,
    workspace: {
      id: workspaceId,
      projectId: project.id,
      label: "Primary",
      kind: "primary",
      path: workspaceRoot,
    },
  };
}
