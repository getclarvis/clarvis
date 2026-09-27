import { expect, test } from "../helpers/bun-test.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStreamMetrics } from "#src/stream-metrics.ts";

test("file-backed metrics and the environment selector flush on a real child exit", () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-llm-metrics-"));
  try {
    const path = join(root, "metrics.jsonl");
    const metrics = createStreamMetrics(path, "loop");
    metrics.count("direct");
    metrics.dispose();
    expect(readFileSync(path, "utf8")).toContain('"direct":1');

    const selected = join(root, "selected.jsonl");
    const moduleUrl = new URL("../../src/stream-metrics.ts", import.meta.url).href;
    const script = `const { streamMetrics } = await import(${JSON.stringify(moduleUrl)}); streamMetrics("env-test").count("delta", 2);`;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("CLARVIS_")),
    ) as Record<string, string>;
    const disabled = Bun.spawnSync([process.execPath, "-e", script], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(disabled.exitCode).toBe(0);
    expect(existsSync(selected)).toBe(false);
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...env, CLARVIS_STREAM_DEBUG: selected },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    expect(readFileSync(selected, "utf8")).toContain('"delta":2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
