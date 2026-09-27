import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openTempDir } from "../helpers/tracked-temp.ts";
import { createStreamMetrics } from "#src/adapters/stream-metrics.ts";

test("file-backed metrics append a final window and total, tolerating an unwritable path", () => {
  const root = openTempDir("clarvis-stream-metrics-");
  const path = join(root, "metrics.jsonl");
  const metrics = createStreamMetrics(path, "code");
  metrics.count("delta", 2);
  metrics.dispose();
  metrics.dispose();
  const lines = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ source: "code", counts: { delta: 2 } });
  expect(lines[1]).toMatchObject({ source: "code", totals: { delta: 2 } });

  const invalid = join(root, "missing", "metrics.jsonl");
  const failed = createStreamMetrics(invalid, "code");
  failed.count("x");
  expect(() => failed.dispose()).not.toThrow();
  expect(existsSync(invalid)).toBe(false);
});
