import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { applyManualBindingEdit } from "../../src/keys/keyboard-profile.ts";
import { createTranscriptStore } from "../../src/adapters/store.ts";

const known = new Set(["safety.picker", "app.escape", "mcp.prompt.gone"]);

test("a vital action's non-shadowing issue does not block an unrelated edit", () => {
  // A hand-edited keyboard.json naming a command no longer registered reports
  // "unknown command" forever. Admitting every issue raised against a protected
  // command re-opened the trap the edited-command filter exists to avoid: the
  // user could not edit anything, and the message named a command they were not
  // editing.
  const result = applyManualBindingEdit({
    saved: { profile: "manual", bindings: { "app.escape": [] } },
    command: "safety.picker",
    keys: ["ctrl+b"],
    knownCommands: known,
  });
  expect(result.issues).toBeUndefined();
  expect(result.config?.bindings?.["safety.picker"]).toEqual(["ctrl+b"]);
});

test("a vital action's shadowing issue still blocks the edit that caused it", () => {
  const result = applyManualBindingEdit({
    saved: { profile: "manual" },
    command: "safety.picker",
    keys: ["escape"],
    knownCommands: known,
  });
  expect(result.config).toBeUndefined();
  expect(result.issues?.some((issue) => issue.shadows === "app.escape")).toBe(true);
});

test("an earlier recoverable error does not swallow the run's real cause", () => {
  // The suppression was "any error node under this run's prefix", so a run that
  // logged a transient model_error in an early iteration, retried, and then
  // failed for an unrelated reason showed only the stale one - the exact "the
  // transcript never says why" case appendRunFailure exists for.
  createRoot((dispose) => {
    const store = createTranscriptStore();
    store.openRun("exec_1");
    store.appendRunFailure("exec_1", { code: "model_error", message: "429, retrying" });
    store.appendRunFailure("exec_1", { code: "invalid_profile", message: "bad grant" });
    const errors = store.nodes.filter((node) => node.kind === "error");
    expect(errors.map((node) => node.text)).toEqual([
      "model_error: 429, retrying",
      "invalid_profile: bad grant",
    ]);
    dispose();
  });
});
