import { describe, expect, test } from "bun:test";

import { buildDigest, renderDigest } from "../../src/digest.ts";
import { run, toolCall } from "../helpers/fixtures.ts";

describe("digest", () => {
  test("captures commands, errors paired with a later success, and files touched", () => {
    const snapshot = run({
      tool_calls: [
        toolCall({ arguments: { command: "bun run build" }, error: "type error in store.ts" }),
        toolCall({ arguments: { command: "bun run build" }, error: null }),
        toolCall({ tool_name: "write", arguments: { file_path: "src/store.ts" }, error: null }),
      ],
    });
    const digest = buildDigest(snapshot);
    expect(digest.commands.map((c) => c.command)).toContain("bun run build");
    expect(digest.errors[0]?.error).toContain("type error");
    expect(digest.errors[0]?.followed_by_success).toBeDefined();
    expect(digest.files_touched).toContain("src/store.ts");
  });

  test("renderDigest emits stats and hard-caps the output length", () => {
    const digest = buildDigest(run());
    const text = renderDigest(digest, 60);
    expect(text).toContain("## Stats");
    expect(text.length).toBeLessThanOrEqual(60);
  });

  test("handles non-serializable arguments and renders every populated section", () => {
    const circular: Record<string, unknown> = { command: "bun test" };
    circular.self = circular;
    const snapshot = run({
      status: "failed",
      started_at: 20,
      ended_at: 10,
      steering: ["keep the exact command"],
      tool_calls: [
        toolCall({
          tool_name: "bash",
          arguments: circular,
          error: "command failed",
          started_at: 20,
          ended_at: 10,
        }),
        toolCall({ tool_name: "bash", arguments: circular, error: "failed again" }),
        toolCall({
          tool_name: "write",
          arguments: {
            path: "a",
            file_path: "b",
            file: "c",
            target: "d",
            source: "e",
            destination: "f",
          },
        }),
      ],
    });

    const digest = buildDigest(snapshot);
    const text = renderDigest(digest, 10_000);

    expect(digest.commands[0]).toMatchObject({ command: "bun test", ok: false, duration_ms: 0 });
    expect(digest.errors).toHaveLength(2);
    expect(digest.errors.every((entry) => entry.args_excerpt === "{}")).toBeTrue();
    expect(digest.errors.every((entry) => entry.followed_by_success === undefined)).toBeTrue();
    expect(digest.retries).toEqual([{ key: "bash\0{}", count: 2 }]);
    expect(digest.files_touched).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(digest.stats.duration_ms).toBe(0);
    for (const heading of [
      "## Stats",
      "## Errors",
      "## User steering",
      "## Commands",
      "## Repeated identical calls",
      "## Files touched",
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("ERR (0ms) bun test");
  });
});
