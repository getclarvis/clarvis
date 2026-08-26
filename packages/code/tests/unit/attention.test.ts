import { expect, test } from "bun:test";
import { createAttention, type AttentionRenderer } from "../../src/core/attention.ts";

function fakeRenderer(capabilities: AttentionRenderer["capabilities"]): {
  renderer: AttentionRenderer;
  notifications: { message: string; title?: string }[];
  titles: string[];
  emit: (event: "focus" | "blur") => void;
} {
  const listeners = new Map<string, (() => void)[]>();
  const notifications: { message: string; title?: string }[] = [];
  const titles: string[] = [];
  const renderer: AttentionRenderer = {
    capabilities,
    triggerNotification: (message, title) => {
      notifications.push({ message, title });
      return true;
    },
    setTerminalTitle: (title) => void titles.push(title),
    on: (event, listener) => {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
    },
  };
  return {
    renderer,
    notifications,
    titles,
    emit: (event) => listeners.get(event)?.forEach((fn) => fn()),
  };
}

test("a headless/test renderer (no detected capabilities) no-ops on every cue", () => {
  const { renderer, notifications, titles } = fakeRenderer(null);
  const attention = createAttention(renderer);
  attention.notify("run completed");
  attention.setTitle("running");
  attention.setTitle(null);
  expect(notifications).toEqual([]);
  expect(titles).toEqual([]);
});

test("notify rides the notifications capability and defaults to the clarvis title", () => {
  const off = fakeRenderer({ notifications: false });
  createAttention(off.renderer).notify("run completed");
  expect(off.notifications).toEqual([]);

  const on = fakeRenderer({ notifications: true });
  const attention = createAttention(on.renderer);
  attention.notify("run completed");
  attention.notify("Clarvis needs approval: rm -rf build", "clarvis");
  expect(on.notifications).toEqual([
    { message: "run completed", title: "clarvis" },
    { message: "Clarvis needs approval: rm -rf build", title: "clarvis" },
  ]);
});

test("the terminal title mirrors app state and restores to the bare app name", () => {
  const { renderer, titles } = fakeRenderer({ notifications: true });
  const attention = createAttention(renderer);
  attention.setTitle("running");
  attention.setTitle("waiting for approval");
  attention.setTitle(null);
  expect(titles).toEqual(["clarvis — running", "clarvis — waiting for approval", "clarvis"]);
});

test("away(): blur/focus are authoritative when the terminal tracks focus", () => {
  const { renderer, emit } = fakeRenderer({ notifications: true, focus_tracking: true });
  const attention = createAttention(renderer);
  expect(attention.away()).toBe(false);
  emit("blur");
  expect(attention.away()).toBe(true);
  emit("focus");
  expect(attention.away()).toBe(false);
});

test("away(): without focus tracking the terminal decides — always worth offering", () => {
  const { renderer } = fakeRenderer({ notifications: true, focus_tracking: false });
  expect(createAttention(renderer).away()).toBe(true);
});
