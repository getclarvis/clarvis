import { expect, it } from "bun:test";
import { loadEnv } from "@clarvis/capability";
import { runtimeLoopPolicy } from "../../src/runtime/loop-policy.ts";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuestLoopExecutor } from "../../src/runtime/guest-loop-executor.ts";
import type { GuestExecutionBridge } from "../../src/runtime/execution-worker.ts";

it("the guest loop executes without a host Guard approval bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-guest-consent-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const signal = new AbortController().signal;
  let modelCalls = 0;
  const bridge: GuestExecutionBridge = {
    async model() {
      modelCalls++;
      const result =
        modelCalls <= 2
          ? {
              toolCalls: [
                {
                  id: `shell-${modelCalls}`,
                  name: "shell",
                  arguments: { command: "printf approved >> consent.txt" },
                },
              ],
            }
          : { text: "finished" };
      return {
        events: [
          {
            type: "result",
            result: {
              ...result,
              usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 },
            },
          },
        ],
        outputBytes: 128,
      };
    },
    capability: () => Promise.reject(new Error("guest shell must not request host approval")),
    event: async () => {},
    checkpoint: async () => {},
  };
  try {
    const result = await createGuestLoopExecutor({
      workspaceRoot,
      scratchRoot: join(root, "scratch"),
    }).execute(
      "run-1",
      {
        owner: "owner",
        modelLeaseId: "lease",
        toolPolicy: { enabled: true, confine: true, maxGrant: "exec" },
        loopPolicy: runtimeLoopPolicy(loadEnv({})),
        rawBody: {
          execution_id: "run-1",
          messages: [{ role: "user", content: "Exercise the two controlled test commands." }],
          servers: [],
          profiles: [
            {
              name: "solo",
              model: "test/model",
              tools: [],
              grants: ["run_commands"],
              iteration_limit: 4,
            },
          ],
          entry: "solo",
          providers: [{ name: "test", kind: "anthropic" }],
          budget: { on_exceed: "stop", total_token_limit: 1_000 },
        },
      },
      bridge,
      signal,
    );
    expect(result).toMatchObject({ response: { status: "completed" } });
    expect(await readFile(join(workspaceRoot, "consent.txt"), "utf8")).toBe("approvedapproved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
