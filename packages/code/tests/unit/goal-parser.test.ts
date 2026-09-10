import { describe, expect, it } from "bun:test";
import { parseGoalCommand } from "../../src/features/goal/parser.ts";
import { goalDraftAction } from "../../src/features/goal/draft.ts";

describe("goal command grammar", () => {
  it("distinguishes controls from literal objectives without shell expansion", () => {
    expect(parseGoalCommand(" ")).toEqual({ kind: "show" });
    for (const kind of ["edit", "resume", "cancel", "clear"] as const)
      expect(parseGoalCommand(kind)).toEqual({ kind });
    expect(parseGoalCommand("pause")).toEqual({ kind: "pause", running: false });
    expect(parseGoalCommand("pause --running")).toEqual({ kind: "pause", running: true });
    expect(parseGoalCommand("-- pause the deployment")).toEqual({
      kind: "create",
      objective: "pause the deployment",
    });
    expect(parseGoalCommand("Build $(literal)\nwith `text`")).toEqual({
      kind: "create",
      objective: "Build $(literal)\nwith `text`",
    });
  });

  it.each([
    "--",
    "--running",
    "pause now",
    "pause --running extra",
    "edit task",
    "clear --running",
    "resume --",
    "cancel all",
    "x".repeat(16385),
  ])("refuses malformed or oversized command %s", (input) => {
    expect(() => parseGoalCommand(input)).toThrow();
  });
});

describe("goal review validation", () => {
  it("rejects an invalid objective, criterion count or numeric limit before host mutation", () => {
    const draft = {
      kind: "create" as const,
      expectedRevision: 0,
      binding: null,
      objective: "Verify the change",
      criteria: [],
      limits: {},
    };
    expect(() => goalDraftAction({ ...draft, objective: " " })).toThrow("objective");
    expect(() =>
      goalDraftAction({
        ...draft,
        criteria: Array.from({ length: 33 }, (_, index) => ({
          id: `criterion-${index}`,
          kind: "qualitative" as const,
          description: "Verify",
        })),
      }),
    ).toThrow("32 criteria");
    expect(() =>
      goalDraftAction({ ...draft, limits: { max_no_progress_checkpoints: 1.5 } }),
    ).toThrow("whole positive");
    expect(() => goalDraftAction({ ...draft, limits: { max_auto_continuations: -1 } })).toThrow(
      "whole positive",
    );
  });
});
