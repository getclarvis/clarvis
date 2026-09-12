import { expect, test } from "bun:test";
import {
  renderTranscriptMarkdown,
  renderTranscriptMarkdownChunks,
  transcriptMarkdownHeader,
} from "../../src/views/transcript-markdown.ts";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import { effectReviewExplanation } from "../../src/core/transcript/effect-review.ts";

test("renderTranscriptMarkdown: prose, quoted reasoning, tool signature (builtin label), run rule", () => {
  const nodes: TranscriptNode[] = [
    { key: "u", kind: "user", status: "ok", text: "hello" },
    { key: "r", kind: "reasoning", status: "ok", text: "think\nmore" },
    {
      key: "t",
      kind: "tool_call",
      status: "ok",
      text: "",
      mcpName: "edit_file",
      toolName: "",
      args: { path: "a.ts" },
    },
    { key: "a", kind: "assistant", status: "ok", text: "done" },
    { key: "run", kind: "run", status: "ok", text: "", reason: "completed" },
  ];
  const md = renderTranscriptMarkdown(nodes, "T");
  expect(md).toContain("# T");
  expect(md).toContain("## You");
  expect(md).toContain("> think\n> more");
  expect(md).toContain("`edit_file(");
  expect(md).toContain("## Assistant");
  expect(md).toContain("_(completed)_");
  expect(transcriptMarkdownHeader("T") + [...renderTranscriptMarkdownChunks(nodes)].join("")).toBe(
    md,
  );
});

test("renderTranscriptMarkdown: records auto-guard approval and denial with the answerer", () => {
  const shell = (outcome: "allowed" | "denied"): TranscriptNode => ({
    key: outcome,
    kind: "tool_call",
    status: outcome === "allowed" ? "ok" : "error",
    text: "",
    toolName: "shell",
    args: { command: "bun test" },
    guard: {
      mode: "auto",
      outcome,
      answerer: "judge",
      effect_id: "git.commit",
      relation: "direct",
      failure_kind: "timeout",
    },
  });
  const md = renderTranscriptMarkdown([shell("allowed"), shell("denied")]);
  expect(md).toContain("auto-guard approved · judge");
  expect(md).toContain("auto-guard denied · judge");
  expect(md).toContain("git.commit · direct · timeout");
});

test("effect receipt presentation uses closed facts, one-based segments and bounded diagnostics", () => {
  expect(effectReviewExplanation({})).toEqual([]);
  expect(
    effectReviewExplanation({
      effect: {
        id: "git.commit\nforged instruction",
        class: "local_mutation",
        attestation: "complete",
      },
      analysis: {
        reviewability: "judgeable",
        issues: [
          { segmentIndex: -1, kind: "command_substitution", impact: "value" },
          { segmentIndex: 1, kind: "dynamic_path", impact: "path" },
        ],
      },
      authority: { revision: 1, relation: "bounded_prerequisite", within_scope: true },
      reviewer: { status: "unsure", attempts: 2 },
    }),
  ).toEqual([
    "unknown · complete attestation",
    "Segment 2: dynamic path · path",
    "Within authorized outcome · bounded prerequisite",
    "Reviewer unsure after 2 attempts",
  ]);
  expect(effectReviewExplanation({ reviewer: { status: "failed", failure_kind: "auth" } })).toEqual(
    ["Reviewer auth"],
  );
});

test("renderTranscriptMarkdown: exports bounded arguments omitted by the compact signature", () => {
  const md = renderTranscriptMarkdown([
    {
      key: "custom",
      kind: "tool_call",
      status: "error",
      text: "",
      mcpName: "custom",
      toolName: "mutate",
      args: { visible: "a", critical_tail: "must remain auditable" },
      error: "invalid request",
    },
  ]);

  expect(md).toContain("Bounded arguments");
  expect(md).toContain('"critical_tail": "must remain auditable"');
});
