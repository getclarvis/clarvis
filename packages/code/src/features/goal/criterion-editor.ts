import type { GoalCriterion } from "@clarvis/protocol";
import type { FieldEditor, PickItem } from "../../views/config/view-host.tsx";
import type { GoalDraft } from "./draft.ts";

type CriterionFieldEditor = Pick<FieldEditor, "start" | "startEnum" | "startMultiline">;

export interface GoalCriterionEditorDeps {
  editor: CriterionFieldEditor;
  draft(): GoalDraft;
  update(patch: Partial<GoalDraft>): void;
  notify(message: string): void;
}

const KINDS: PickItem[] = [
  {
    label: "Model assessment",
    value: "qualitative",
    detail: "Qualitative; not independent verification",
  },
  { label: "Human approval", value: "human", detail: "Requires your explicit acceptance" },
  { label: "Successful tool", value: "tool_success", detail: "Host-observed tool success" },
  {
    label: "Artifact digest",
    value: "artifact_digest",
    detail: "Host checks the named artifact's SHA-256",
  },
];

/** Coordinate one criterion review while keeping evidence-kind construction outside the view. */
export function editGoalCriterion(deps: GoalCriterionEditorDeps, index?: number): void {
  const existing = index === undefined ? undefined : deps.draft().criteria[index];
  const persist = (value: GoalCriterion): void => {
    const criteria = [...deps.draft().criteria];
    if (index === undefined) criteria.push(value);
    else criteria[index] = value;
    deps.update({ criteria });
  };
  if (existing === undefined && deps.draft().criteria.length >= 32) {
    deps.notify("A goal can have at most 32 criteria.");
    return;
  }
  deps.editor.startEnum(
    "Criterion evidence",
    KINDS,
    existing?.verification?.kind ?? existing?.kind,
    (kind) => {
      deps.editor.startMultiline(
        "Criterion description",
        existing?.description ?? "",
        (description) => {
          if (!description.trim() || description.length > 4096) {
            deps.notify("Enter a description of 1 to 4096 characters.");
            return;
          }
          const base = {
            id: existing?.id ?? crypto.randomUUID(),
            description: description.trim(),
          };
          if (kind === "qualitative" || kind === "human") {
            persist({ ...base, kind });
            return;
          }
          const previous = existing?.verification;
          if (kind === "tool_success") {
            deps.editor.start(
              "Tool name",
              previous?.kind === "tool_success" ? previous.tool_name : "",
              (toolName) => {
                if (!toolName.trim()) {
                  deps.notify("Enter the tool name to verify.");
                  return;
                }
                deps.editor.start(
                  "Arguments SHA-256 (optional)",
                  previous?.kind === "tool_success" ? (previous.arguments_digest ?? "") : "",
                  (digest) => {
                    if (digest && !/^[a-f0-9]{64}$/u.test(digest)) {
                      deps.notify("Enter 64 lowercase hexadecimal characters.");
                      return;
                    }
                    persist({
                      ...base,
                      kind: "host",
                      verification: {
                        kind: "tool_success",
                        tool_name: toolName.trim(),
                        ...(digest ? { arguments_digest: digest } : {}),
                      },
                    });
                  },
                  { alwaysCommit: true },
                );
              },
              { alwaysCommit: true },
            );
            return;
          }
          deps.editor.start(
            "Workspace artifact path",
            previous?.kind === "artifact_digest" ? previous.path : "",
            (path) => {
              if (!path.trim()) {
                deps.notify("Enter an artifact path.");
                return;
              }
              deps.editor.start(
                "Artifact SHA-256",
                previous?.kind === "artifact_digest" ? previous.digest : "",
                (digest) => {
                  if (!/^[a-f0-9]{64}$/u.test(digest)) {
                    deps.notify("Enter 64 lowercase hexadecimal characters.");
                    return;
                  }
                  persist({
                    ...base,
                    kind: "host",
                    verification: { kind: "artifact_digest", path: path.trim(), digest },
                  });
                },
                { alwaysCommit: true },
              );
            },
            { alwaysCommit: true },
          );
        },
      );
    },
  );
}
