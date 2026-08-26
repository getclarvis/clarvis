import { expect, test } from "bun:test";
import { presentAgentsEvent, type AgentsEvent } from "../../src/features/agents/events.ts";

test("save_blocked reports the blocking reason as an error", () => {
  const note = presentAgentsEvent({ type: "save_blocked", message: "missing model" });
  expect(note.message).toContain("missing model");
  expect(note.tone).toBe("error");
});

test("save_failed reports the underlying error text", () => {
  const note = presentAgentsEvent({ type: "save_failed", error: new Error("disk full") });
  expect(note.message).toBe("save failed: disk full");
  expect(note.tone).toBe("error");
});

test("saved without a warning reports success", () => {
  const note = presentAgentsEvent({ type: "saved", name: "builder", scope: "global" });
  expect(note.message).toBe("saved agent 'builder' (global)");
  expect(note.tone).toBe("success");
});

test("saved with a warning surfaces it instead, toned as warn", () => {
  const note = presentAgentsEvent({
    type: "saved",
    name: "builder",
    scope: "workspace",
    warning: "no provider declares this model",
  });
  expect(note.message).toBe("no provider declares this model");
  expect(note.tone).toBe("warn");
});

test("forked reports source and target names with scope", () => {
  const note = presentAgentsEvent({
    type: "forked",
    source: "builder",
    name: "builder-copy",
    scope: "workspace",
  });
  expect(note.message).toContain("builder");
  expect(note.message).toContain("builder-copy");
  expect(note.message).toContain("workspace");
  expect(note.tone).toBe("success");
});

test("fork_failed reports the underlying error text", () => {
  const note = presentAgentsEvent({ type: "fork_failed", error: new Error("locked") });
  expect(note.message).toBe("fork failed: locked");
  expect(note.tone).toBe("error");
});

test("already_exists names the agent and scope, toned as warn", () => {
  const note = presentAgentsEvent({ type: "already_exists", name: "builder", scope: "global" });
  expect(note.message).toBe("agent 'builder' already exists (global)");
  expect(note.tone).toBe("warn");
});

test("create_failed reports the underlying error text", () => {
  const note = presentAgentsEvent({ type: "create_failed", error: "quota exceeded" });
  expect(note.message).toBe("create failed: quota exceeded");
  expect(note.tone).toBe("error");
});

test("renamed reports old and new names", () => {
  const note = presentAgentsEvent({ type: "renamed", oldName: "builder", newName: "coder" });
  expect(note.message).toContain("builder");
  expect(note.message).toContain("coder");
  expect(note.tone).toBe("success");
});

test("rename_failed reports the underlying error text", () => {
  const note = presentAgentsEvent({ type: "rename_failed", error: new Error("name taken") });
  expect(note.message).toBe("rename failed: name taken");
  expect(note.tone).toBe("error");
});

test("delete_failed reports the underlying error text", () => {
  const note = presentAgentsEvent({ type: "delete_failed", error: new Error("in use") });
  expect(note.message).toBe("delete failed: in use");
  expect(note.tone).toBe("error");
});

test("deleted names the agent and scope, toned as success", () => {
  const note = presentAgentsEvent({ type: "deleted", name: "builder", scope: "global" });
  expect(note.message).toBe("deleted 'builder' (global)");
  expect(note.tone).toBe("success");
});

test("every AgentsEvent variant is handled (exhaustiveness canary)", () => {
  const events: AgentsEvent[] = [
    { type: "save_blocked", message: "x" },
    { type: "save_failed", error: "x" },
    { type: "saved", name: "a", scope: "global" },
    { type: "forked", source: "a", name: "b", scope: "global" },
    { type: "fork_failed", error: "x" },
    { type: "already_exists", name: "a", scope: "global" },
    { type: "create_failed", error: "x" },
    { type: "renamed", oldName: "a", newName: "b" },
    { type: "rename_failed", error: "x" },
    { type: "delete_failed", error: "x" },
    { type: "deleted", name: "a", scope: "global" },
  ];
  for (const event of events) {
    const note = presentAgentsEvent(event);
    expect(typeof note.message).toBe("string");
    expect(note.message.length).toBeGreaterThan(0);
  }
});
