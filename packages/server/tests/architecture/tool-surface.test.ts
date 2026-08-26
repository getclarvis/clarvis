import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_NAMES } from "../../src/mcp/tools.ts";
import { createFakeRunHost } from "../helpers/fake-run-host.ts";
import { makeHarness } from "../helpers/harness.ts";

describe("tool surface", () => {
  it("boots the backing kernel with local-only capabilities disabled", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/bin.ts"), "utf8");
    expect(source).toMatch(/createFileKernel\(\{[\s\S]*?builtins:\s*\{\s*tasks:\s*false\s*\}/u);
    expect(source).toMatch(/createFileKernel\(\{[\s\S]*?subscriptions:\s*false/u);
    expect(source).not.toContain("tasks.provider");
  });

  it("lists exactly the four clarvis_* tools", async () => {
    const h = await makeHarness({ host: createFakeRunHost(() => ({})) });
    const listed = (await h.client.listTools()).tools.map((t) => t.name).sort();
    expect(listed).toEqual(
      [TOOL_NAMES.cancel, TOOL_NAMES.respond, TOOL_NAMES.run, TOOL_NAMES.steer].sort(),
    );
    await h.close();
  });

  it("omits caller-controlled policy and local-only task fields", async () => {
    const h = await makeHarness({ host: createFakeRunHost(() => ({})) });
    const run = (await h.client.listTools()).tools.find((t) => t.name === TOOL_NAMES.run);
    const input = run?.inputSchema as { properties?: Record<string, unknown> };
    const output = run?.outputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(input.properties ?? {})).not.toContain("guard_mode");
    expect(Object.keys(input.properties ?? {})).not.toContain("guard_judge");
    expect(Object.keys(input.properties ?? {})).not.toContain("prompt_cache_key");
    expect(Object.keys(input.properties ?? {})).not.toContain("prompt_cache_ttl");
    expect(Object.keys(input.properties ?? {})).not.toContain("task");
    expect(Object.keys(output.properties ?? {})).not.toContain("active_task");
    await h.close();
  });
});
