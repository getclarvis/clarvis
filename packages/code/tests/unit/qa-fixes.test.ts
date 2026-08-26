import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { padColumn, truncateEnd, truncateStart } from "../../src/views/truncate.ts";
import { createTranscriptStore } from "../../src/adapters/store.ts";
import { runOutcomeLabel } from "../../src/features/run/status-presenter.ts";
import { mapProviderIssues } from "../../src/features/issues.ts";

test("padColumn always leaves a gap, so a label cannot run into its description", () => {
  // `sessions > Export transcriptWrite the transcript to a file`, at full width.
  expect(padColumn("short", 10)).toBe("short     ");
  expect(padColumn("exactly-22-characters!", 22)).toBe("exactly-22-characters! ");
  expect(padColumn("a-label-longer-than-the-column", 10)).toBe("a-label-longer-than-the-column ");
  expect(padColumn(undefined, 4)).toBe("    ");
});

test("truncate helpers survive a config field the user has cleared", () => {
  // Clearing the Provider name threw a TypeError out of the render pass and
  // painted a raw stack trace permanently over the UI.
  expect(truncateEnd(undefined, 13)).toBe("");
  expect(truncateStart(null, 13)).toBe("");
  expect(truncateEnd("", 13)).toBe("");
});

test("a failed run leaves its cause in the transcript", () => {
  createRoot((dispose) => {
    const store = createTranscriptStore();
    store.openRun("exec_1");
    store.appendRunFailure("exec_1", { code: "invalid_profile", message: "bad grant" });
    const errors = store.nodes.filter((node) => node.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.text).toBe("invalid_profile: bad grant");
    // A second report of the same run does not duplicate the block.
    store.appendRunFailure("exec_1", { code: "invalid_profile", message: "bad grant" });
    expect(store.nodes.filter((node) => node.kind === "error")).toHaveLength(1);
    dispose();
  });
});

test("a run that completed is not labelled Failed by what happened afterwards", () => {
  // Memory indexing fails after the answer is delivered, and both the header
  // and the footer read the whole composed line.
  expect(runOutcomeLabel("completed")).toBe("Completed");
  expect(runOutcomeLabel("completed  ·  memory index failed — run not learned")).toBe("Completed");
  expect(runOutcomeLabel("failed — provider refused the key")).toBe("Failed");
  expect(runOutcomeLabel("cancelled  ·  memory: nothing to record")).toBe("Canceled");
  expect(runOutcomeLabel("running")).toBeUndefined();
});

test("provider issues scope to a provider whose name is empty rather than to none", () => {
  const check = {
    ok: false as const,
    issues: [
      { field: "name", provider: "", message: "provider name is required" },
      { field: "base_url", provider: "other", message: "needs an http(s) base_url" },
    ],
  };
  expect(mapProviderIssues(check, "").map((issue) => issue.field)).toEqual(["name"]);
  expect(mapProviderIssues(check, undefined)).toHaveLength(2);
});
