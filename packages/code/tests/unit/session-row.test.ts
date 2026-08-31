import { expect, test } from "bun:test";
import { formatSessionRow, relTime } from "../../src/views/session-row.ts";
import type { SessionMeta } from "../../src/adapters/session-store.ts";

const NOW = 1_000_000_000_000;

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "0198c0ff",
    title: "fix the flaky test",
    workspace: "/ws",
    owner: "o",
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    turns: [
      { kind: "conversation", userPreview: "first", status: "done" },
      { kind: "conversation", userPreview: "second", status: "done" },
    ],
    totals: { input: 1200, output: 340, cached: 0, costUsd: 0.0312 },
    ...over,
  };
}

test("relTime speaks the picker's grammar across the ranges", () => {
  expect(relTime(NOW - 5_000, NOW)).toBe("5s ago");
  expect(relTime(NOW - 120_000, NOW)).toBe("2m ago");
  expect(relTime(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  expect(relTime(NOW - 48 * 3_600_000, NOW)).toBe("2d ago");
  expect(relTime(NOW + 5_000, NOW)).toBe("0s ago");
});

test("a session row carries id, relative time, turns, tokens, cost and title", () => {
  const row = formatSessionRow(meta(), NOW);
  expect(row).toContain("0198c0ff");
  expect(row).toContain("1m ago");
  expect(row).toContain("2 turns");
  expect(row).toContain("1.2k");
  expect(row).toContain("340");
  expect(row).toContain("$0.0312");
  expect(row).toContain("fix the flaky test");
});

test("zero tokens and no cost leave their columns blank; an untitled session says so", () => {
  const row = formatSessionRow(
    meta({ title: "", totals: { input: 0, output: 0, cached: 0 }, turns: [] }),
    NOW,
  );
  expect(row).toContain("0 turns");
  expect(row).not.toContain("$");
  expect(row).toContain("(untitled)");
});
