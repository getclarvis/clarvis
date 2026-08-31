import { expect, test } from "bun:test";
import {
  lifecycleLabel,
  markerText,
  scopedUsageText,
  settingSummary,
  uiLifecycle,
} from "../../src/ui/presentation.ts";
import {
  planMetaText,
  transcriptDisplayText,
  transcriptDisplayTextChars,
  TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS,
  TRANSCRIPT_MOUNTED_TEXT_SHORTENED_NOTICE,
  TRANSCRIPT_PROSE_RELEASED_DISPLAY,
} from "../../src/core/transcript/presenters.ts";
import type { TranscriptNode } from "../../src/core/transcript/types.ts";

test("internal lifecycle variants converge on canonical product vocabulary", () => {
  expect(lifecycleLabel(uiLifecycle("awaiting_approval"))).toBe("Needs approval");
  expect(lifecycleLabel(uiLifecycle("in_progress"))).toBe("Running");
  expect(lifecycleLabel(uiLifecycle("done"))).toBe("Completed");
  expect(lifecycleLabel(uiLifecycle("cancelled"))).toBe("Canceled");
});

test("ASCII markers keep cursor, value, expansion and lifecycle meanings textual", () => {
  const markers = [
    markerText("cursor", true),
    markerText("current", true),
    markerText("checked", true),
    markerText("collapsed", true),
    markerText("running", true),
    markerText("completed", true),
    markerText("failed", true),
    markerText("canceled", true),
    markerText("dirty", true),
    markerText("inherited", true),
    markerText("read-only", true),
  ];
  expect(new Set(markers).size).toBe(markers.length);
});

test("marker projection covers unchecked, waiting, file and Unicode variants", () => {
  expect(markerText("unselected", true)).toBe("( )");
  expect(markerText("unchecked", true)).toBe("[ ]");
  expect(markerText("expanded", true)).toBe("[-]");
  expect(markerText("waiting", true)).toBe("[wait]");
  expect(markerText("file", true)).toBe("[file]");
  expect(markerText("collapsed", false)).not.toBe("[+]");
  expect(markerText("expanded", false)).not.toBe("[-]");
  expect(markerText("running", false, "spinner")).toBe("spinner");
  expect(markerText("failed", false)).not.toBe("[error]");
  expect(markerText("canceled", false)).not.toBe("[canceled]");
  expect(markerText("dirty", false)).toBe("~");
});

test("setting summaries explain inheritance and when a change applies", () => {
  expect(
    settingSummary({
      label: "Model",
      configured: "inherit",
      effective: "anthropic/sonnet",
      source: "global",
      applies: "next run",
      mutation: "staged",
    }),
  ).toBe("anthropic/sonnet · from global · next run");
  expect(
    settingSummary({
      label: "Runtime",
      configured: "bun",
      effective: "node",
      source: "provider",
      applies: "now",
      mutation: "read-only",
    }),
  ).toBe("node · configured bun · provider · now");
  expect(
    settingSummary({
      label: "Memory",
      configured: "on",
      effective: "on",
      source: "workspace",
      applies: "next run",
      mutation: "staged",
    }),
  ).toBe("on · workspace · next run");
});

test("usage is labelled by owner and never uses a bare token arrow", () => {
  const value = scopedUsageText({
    owner: "Agent",
    input: 12_400,
    output: 820,
    cacheHitPercent: 80.6,
  });
  expect(value).toBe("Agent  In 12k · Out 820 · Cache hit 81%");
  expect(value).not.toContain("→");
});

test("usage projection covers context, elapsed, iterations, cost and compact count bands", () => {
  expect(
    scopedUsageText({
      owner: "Workflow",
      input: 1_250_000,
      output: 9_800,
      used: 12_400,
      limit: 100_000,
      percent: 12.4,
      iterations: 1,
      elapsed: "4m12s",
      cost: 1.2345,
    }),
  ).toBe(
    "Workflow  In 1.3M · Out 9.8k · Context 12k / 100k · Context 12% · 1 iteration · 4m12s · $1.234",
  );
  expect(scopedUsageText({ owner: "Run", iterations: 2, cost: 0.5 }, true)).toBe("Run");
});

test("plan summaries distinguish completed and failed execution outcomes", () => {
  expect(planMetaText({ tasks: [], planStatus: "completed", revision: 1 })).toContain("Completed");
  expect(planMetaText({ tasks: [], planStatus: "failed", revision: 1 })).toContain("Failed");
  expect(
    planMetaText({ tasks: [], planStatus: "active", planRemoved: true, revision: 2 }),
  ).toContain("Unavailable");
  const discarded = planMetaText({
    tasks: [{ id: "t1", title: "Done", status: "done" }],
    planStatus: "completed",
    planRemoved: true,
    planDiscarded: true,
    revision: 2,
  });
  expect(discarded).toContain("1/1 completed");
  expect(discarded).toContain("History discarded");
});

test("released prose presents persistence recovery instead of a truncation message", () => {
  const node: TranscriptNode = {
    key: "released",
    kind: "assistant",
    status: "ok",
    text: "[misleading old copy: reopen the session]",
    textTruncated: true,
    proseReleased: true,
  };
  expect(transcriptDisplayText(node)).toBe(TRANSCRIPT_PROSE_RELEASED_DISPLAY);
  expect(transcriptDisplayText(node)).toContain("/export");
  expect(transcriptDisplayText(node)).not.toContain("reopen");
  expect(transcriptDisplayTextChars(node)).toBe(TRANSCRIPT_PROSE_RELEASED_DISPLAY.length);
});

test("one pathological text node is shortened to the mounted OpenTUI ceiling", () => {
  const node: TranscriptNode = {
    key: "giant",
    kind: "subagent",
    status: "ok",
    text: "x".repeat(TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS + 100),
  };
  const displayed = transcriptDisplayText(node);
  expect(displayed).toHaveLength(TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS);
  expect(displayed).toEndWith(TRANSCRIPT_MOUNTED_TEXT_SHORTENED_NOTICE);
  expect(transcriptDisplayTextChars(node)).toBe(TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS);
});
