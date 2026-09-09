import { expect, it } from "bun:test";
import { loadEnv } from "@clarvis/capability";
import { runtimeLoopPolicy } from "../../src/runtime/loop-policy.ts";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuestLoopExecutor } from "../../src/runtime/guest-loop-executor.ts";
import { createHostGuardApprovalGrant } from "../../src/runtime/guard-approval-bridge.ts";
import type { GuestExecutionBridge } from "../../src/runtime/execution-worker.ts";
import { fixture, input } from "../helpers/hosted-registry.ts";

it("the real guest loop consults revoked host consent before repeating an approved command", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-guest-consent-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const f = fixture();
  const operator = f.registry.connect("operator");
  const view = await operator.service.start(input());
  const signal = new AbortController().signal;
  let detached = false;
  let questions = 0;
  let modelCalls = 0;
  const grant = createHostGuardApprovalGrant({
    elicit: async () => {
      questions++;
      return detached
        ? { action: "cancel" }
        : { action: "accept", content: { decision: "allow_session" } };
    },
    allowlist: () => f.registry.guardAllowlistFor({ executionId: "run-1", owner: "owner" }),
    workspaceRoot,
  });
  const bridge: GuestExecutionBridge = {
    async model() {
      modelCalls++;
      if (modelCalls === 2) {
        await operator.service.detach(f.handoff(view));
        detached = true;
      }
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
    capability: (_id, call, callSignal) => {
      expect(call.method).toBe(grant.method);
      expect(grant.validateArguments(call.arguments)).toBe(true);
      return grant.invoke(call.arguments, callSignal ?? signal);
    },
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
        guardSettings: { guard: { mode: "on", allowed_commands: [], denied_commands: [] } },
        rawBody: {
          execution_id: "run-1",
          guard_mode: "on",
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
    expect(questions).toBe(2);
    expect(await readFile(join(workspaceRoot, "consent.txt"), "utf8")).toBe("approved");
  } finally {
    f.finish();
    await f.registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
