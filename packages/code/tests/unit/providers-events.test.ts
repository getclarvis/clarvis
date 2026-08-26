import { expect, test } from "bun:test";
import { presentProvidersEvent, type ProvidersEvent } from "../../src/features/providers/events.ts";

test("key_staged points at the pending save", () => {
  const note = presentProvidersEvent({ type: "key_staged", envVar: "ACME_API_KEY" });
  expect(note.message).toContain("ACME_API_KEY");
  expect(note.message).toContain("save to reconnect");
  expect(note.tone).toBeUndefined();
});

test("source_staged reports the chosen source and its meaning", () => {
  const note = presentProvidersEvent({
    type: "source_staged",
    envVar: "ACME_API_KEY",
    source: "env",
    meaning: "shell env only (keys.json ignored)",
  });
  expect(note.message).toContain("ACME_API_KEY: env");
  expect(note.message).toContain("shell env only (keys.json ignored)");
  expect(note.message).toContain("saves on ^s");
});

test("model_added reports id and resolved context window", () => {
  const note = presentProvidersEvent({ type: "model_added", id: "gpt-x", contextWindow: 128000 });
  expect(note.message).toBe("added gpt-x — ctx 128000");
});

test("validation_failed surfaces the first issue's message as an error", () => {
  const note = presentProvidersEvent({
    type: "validation_failed",
    issue: { field: "base_url", provider: "acme", message: "needs an http(s) base_url" },
  });
  expect(note.message).toContain("needs an http(s) base_url");
  expect(note.tone).toBe("error");
});

test("key_save_failed reports the env var and underlying error text", () => {
  const note = presentProvidersEvent({
    type: "key_save_failed",
    envVar: "ACME_API_KEY",
    error: new Error("permission denied"),
  });
  expect(note.message).toBe("key save failed for ACME_API_KEY: permission denied");
  expect(note.tone).toBe("error");
});

test("source_save_failed reports the env var and underlying error text", () => {
  const note = presentProvidersEvent({
    type: "source_save_failed",
    envVar: "ACME_API_KEY",
    error: new Error("read-only fs"),
  });
  expect(note.message).toBe("source save failed for ACME_API_KEY: read-only fs");
  expect(note.tone).toBe("error");
});

test("saved without reconnecting omits the reconnect clause", () => {
  const note = presentProvidersEvent({ type: "saved", scope: "global", reconnecting: false });
  expect(note.message).toBe("saved global providers");
  expect(note.tone).toBe("success");
});

test("saved while reconnecting appends the reconnect clause", () => {
  const note = presentProvidersEvent({ type: "saved", scope: "workspace", reconnecting: true });
  expect(note.message).toContain("saved workspace providers");
  expect(note.message).toContain("reconnecting backend");
  expect(note.tone).toBe("success");
});

test("every ProvidersEvent variant is handled (exhaustiveness canary)", () => {
  const events: ProvidersEvent[] = [
    { type: "key_staged", envVar: "X" },
    { type: "source_staged", envVar: "X", source: "auto", meaning: "m" },
    { type: "model_added", id: "m", contextWindow: 1 },
    { type: "validation_failed", issue: { field: "name", provider: "p", message: "bad" } },
    { type: "key_save_failed", envVar: "X", error: "e" },
    { type: "source_save_failed", envVar: "X", error: "e" },
    { type: "saved", scope: "global", reconnecting: false },
  ];
  for (const event of events) {
    const note = presentProvidersEvent(event);
    expect(typeof note.message).toBe("string");
    expect(note.message.length).toBeGreaterThan(0);
  }
});
