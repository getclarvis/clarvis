import { describe, expect, it } from "bun:test";
import type { FieldEditor, PickItem } from "../../src/views/config/view-host.tsx";
import {
  editGoalCriterion,
  type GoalCriterionEditorDeps,
} from "../../src/features/goal/criterion-editor.ts";
import type { GoalDraft } from "../../src/features/goal/draft.ts";

interface TextRequest {
  label: string;
  current: string;
  commit(value: string): void;
}

function fixture(criteria: GoalDraft["criteria"] = []) {
  const draft: GoalDraft = {
    kind: "edit",
    expectedRevision: 1,
    binding: { sessionId: "session", generation: 1 },
    objective: "Verify",
    criteria: structuredClone(criteria),
    limits: { max_net_tokens: 1000 },
  };
  const notices: string[] = [];
  const texts: TextRequest[] = [];
  const multiline: TextRequest[] = [];
  let enumRequest:
    | {
        label: string;
        options: readonly (string | PickItem)[];
        current: string | undefined;
        commit(value: string): void;
      }
    | undefined;
  const editor = {
    start(label: string, current: string, commit: (value: string) => void) {
      texts.push({ label, current, commit });
    },
    startEnum(
      label: string,
      options: readonly (string | PickItem)[],
      current: string | undefined,
      commit: (value: string) => void,
    ) {
      enumRequest = { label, options, current, commit };
    },
    startMultiline(label: string, current: string, commit: (value: string) => void) {
      multiline.push({ label, current, commit });
    },
  } as Pick<FieldEditor, "start" | "startEnum" | "startMultiline">;
  const deps: GoalCriterionEditorDeps = {
    editor,
    draft: () => draft,
    update: (patch) => Object.assign(draft, patch),
    notify: (message) => notices.push(message),
  };
  return { draft, notices, texts, multiline, deps, enumRequest: () => enumRequest! };
}

describe("goal criterion editor", () => {
  it.each(["qualitative", "human"] as const)("adds one %s criterion", (kind) => {
    const f = fixture();
    editGoalCriterion(f.deps);
    expect(f.enumRequest().label).toBe("Criterion evidence");
    expect(f.enumRequest().options).toHaveLength(4);
    f.enumRequest().commit(kind);
    f.multiline[0]!.commit("  Verified outcome  ");
    expect(f.draft.criteria).toEqual([
      { id: expect.any(String), description: "Verified outcome", kind },
    ]);
  });

  it("builds a tool-success criterion with an optional arguments digest", () => {
    const f = fixture();
    editGoalCriterion(f.deps);
    f.enumRequest().commit("tool_success");
    f.multiline[0]!.commit("Command succeeds");
    f.texts[0]!.commit(" shell ");
    f.texts[1]!.commit("a".repeat(64));
    expect(f.draft.criteria[0]).toMatchObject({
      kind: "host",
      verification: {
        kind: "tool_success",
        tool_name: "shell",
        arguments_digest: "a".repeat(64),
      },
    });

    const withoutDigest = fixture();
    editGoalCriterion(withoutDigest.deps);
    withoutDigest.enumRequest().commit("tool_success");
    withoutDigest.multiline[0]!.commit("Command succeeds");
    withoutDigest.texts[0]!.commit("shell");
    withoutDigest.texts[1]!.commit("");
    expect(withoutDigest.draft.criteria[0]?.verification).toEqual({
      kind: "tool_success",
      tool_name: "shell",
    });
  });

  it("builds an artifact criterion and preserves existing edit defaults", () => {
    const existing = {
      id: "artifact",
      kind: "host" as const,
      description: "Old digest",
      verification: {
        kind: "artifact_digest" as const,
        path: "old.json",
        digest: "b".repeat(64),
      },
    };
    const f = fixture([existing]);
    editGoalCriterion(f.deps, 0);
    expect(f.enumRequest().current).toBe("artifact_digest");
    f.enumRequest().commit("artifact_digest");
    expect(f.multiline[0]?.current).toBe("Old digest");
    f.multiline[0]!.commit("New digest");
    expect(f.texts[0]?.current).toBe("old.json");
    f.texts[0]!.commit(" dist/result.json ");
    expect(f.texts[1]?.current).toBe("b".repeat(64));
    f.texts[1]!.commit("c".repeat(64));
    expect(f.draft.criteria[0]).toEqual({
      id: "artifact",
      kind: "host",
      description: "New digest",
      verification: {
        kind: "artifact_digest",
        path: "dist/result.json",
        digest: "c".repeat(64),
      },
    });
  });

  it("reports invalid descriptions, tool names, paths and digests without persisting", () => {
    for (const scenario of [
      "description",
      "tool",
      "tool_digest",
      "path",
      "artifact_digest",
    ] as const) {
      const f = fixture();
      editGoalCriterion(f.deps);
      if (scenario === "description") {
        f.enumRequest().commit("human");
        f.multiline[0]!.commit(" ");
      } else if (scenario === "tool" || scenario === "tool_digest") {
        f.enumRequest().commit("tool_success");
        f.multiline[0]!.commit("Command succeeds");
        f.texts[0]!.commit(scenario === "tool" ? " " : "shell");
        if (scenario === "tool_digest") f.texts[1]!.commit("BAD");
      } else {
        f.enumRequest().commit("artifact_digest");
        f.multiline[0]!.commit("Artifact matches");
        f.texts[0]!.commit(scenario === "path" ? " " : "result.json");
        if (scenario === "artifact_digest") f.texts[1]!.commit("BAD");
      }
      expect(f.draft.criteria).toEqual([]);
      expect(f.notices).toHaveLength(1);
    }
  });

  it("refuses a thirty-third criterion before opening an editor", () => {
    const f = fixture(
      Array.from({ length: 32 }, (_, index) => ({
        id: `criterion-${index}`,
        kind: "qualitative" as const,
        description: "Verified",
      })),
    );
    editGoalCriterion(f.deps);
    expect(f.notices).toEqual(["A goal can have at most 32 criteria."]);
    expect(f.enumRequest()).toBeUndefined();
  });
});
