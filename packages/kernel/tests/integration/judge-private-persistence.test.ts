import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, NOOP_LOGGER, ProviderError } from "@clarvis/capability";
import type { RunRequest } from "@clarvis/capability";
import { executeRun } from "@clarvis/loop";
import { createTestRunInfrastructure, MockLLM, validateBody } from "@clarvis/loop/testing";
import { createJsonTraceStore, createTraceVisibilityView } from "@clarvis/trace";
import { createJudgeTraceStore } from "../../src/guard/judge-trace-store.ts";
import { createRunService } from "../../src/runs/run-service.ts";

const sentinel = "PRIVATE_MODEL_COMMAND_AUTHORITY_SENTINEL";
const request: RunRequest = {
  execution_id: "judge-private",
  session_id: "parent-session",
  agent_instance_id: "judge",
  prompt_cache_ttl: "1h",
  messages: [{ role: "user", content: sentinel }],
  servers: [],
  entry: "judge",
  shared_prompt: "",
  profiles: [
    {
      name: "judge",
      model: "anthropic/test",
      tools: [],
      iteration_limit: 1,
      compaction: { enabled: false },
      base_prompt: sentinel,
    },
  ],
  providers: [{ name: "anthropic", kind: "anthropic", headers: { "X-Private": sentinel } }],
  budget: { on_exceed: "stop", total_token_limit: 4096 },
};

test.each(["success", "failure"] as const)(
  "ordinary engine %s writes no private payload through the Judge store",
  async (outcome) => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-judge-private-"));
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    const infrastructure = createTestRunInfrastructure({ env, workspaceRoot: root });
    const observed: string[] = [];
    const traceDir = join(root, "traces");
    const physical = createJsonTraceStore({
      dir: traceDir,
      afterInsertWrite() {
        for (const file of readdirSync(join(traceDir, "owner")))
          if (/\.(json|jsonl|summary)$/.test(file))
            observed.push(readFileSync(join(traceDir, "owner", file), "utf8"));
      },
    });
    const store = createJudgeTraceStore(physical);
    const llm = new MockLLM({
      script:
        outcome === "success"
          ? [
              {
                text: sentinel,
                reasoning: sentinel,
                usage: {
                  input_tokens: 10,
                  output_tokens: 2,
                  cached_tokens: 5,
                  cache_write_tokens: 1,
                },
              },
            ]
          : [{ throw: new ProviderError(sentinel, { kind: "quota", status: 429 }) }],
    });
    try {
      const result = await executeRun({
        owner: "owner",
        rawBody: request,
        deps: {
          ...infrastructure,
          executionVisibility: "internal",
          env,
          llm,
          traceStore: store,
          logger: NOOP_LOGGER,
          capabilities: [],
          includeEnvironmentPreamble: false,
        },
      });
      expect(result.response.status).toBe(outcome === "success" ? "completed" : "error");
      if (outcome === "success" && result.response.status === "completed")
        expect(result.response.result).toBe(sentinel);
      expect(observed.length).toBeGreaterThanOrEqual(3);
      for (const body of observed) {
        expect(body).not.toContain(sentinel);
        expect(body).not.toContain("subagent_iteration_started");
        expect(body).not.toContain("model_stream_delta");
      }
      const stored = physical.getById("owner", "judge-private")!;
      expect(stored.visibility).toBe("internal");
      expect(stored.final_context).toBeUndefined();
      expect(stored.capability_state).toBeUndefined();
      expect(stored.request.session_id).toBe("parent-session");
      expect(() => validateBody(stored.request, env)).not.toThrow();
      expect(
        createTraceVisibilityView(physical, "public").getById("owner", "judge-private"),
      ).toBeNull();
      expect(stored.response.status).toBe(result.response.status);
      expect(stored.total_cached_tokens).toBe(outcome === "success" ? 5 : 0);
      expect(store.executionIdNamespace).toBe(physical);
      await expect(
        store.insert({
          ...stored,
          trace: {
            events: [{ type: "future_private_event", occurred_at: 1, detail: { sentinel } }],
          },
        }),
      ).rejects.toThrow("Trace write projection failed.");
      expect(physical.getById("owner", "judge-private")).toEqual(stored);
      const publicStore = createTraceVisibilityView(physical, "public");
      const service = createRunService({
        owner: "owner",
        ingestGraceMs: 0,
        deps: { ...infrastructure, env, llm, traceStore: publicStore },
        assembleRunRequest: (params) => ({
          ...request,
          execution_id: params.execution_id,
          continue_from: params.continue_from,
        }),
      });
      expect(await service.list()).toMatchObject({ items: [], total: 0 });
      for (const read of [
        () => service.get("judge-private"),
        () => service.context("judge-private"),
        () => service.compact("judge-private"),
        () => service.compact("judge-private", undefined, { mechanical_target_tokens: 100 }),
        () => service.delete("judge-private"),
      ])
        await expect(read()).rejects.toMatchObject({ code: "not_found" });
      const callsBefore = llm.calls.length;
      const resumed = await service.start({
        execution_id: "public-resume",
        continue_from: "judge-private",
        messages: [{ role: "user", content: "resume" }],
      });
      expect(await resumed.done).toMatchObject({
        status: "failed",
        error: { code: "continuation_unavailable" },
      });
      await resumed.closed;
      expect(llm.calls).toHaveLength(callsBefore);
      expect(physical.getById("owner", "judge-private")).toEqual(stored);
    } finally {
      await infrastructure.connections.closeAll();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("an unknown durable event disables the private journal without persisting its payload", () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-judge-private-invalid-"));
  try {
    const store = createJudgeTraceStore(createJsonTraceStore({ dir: root }));
    const journal = store.openJournal!({
      header: {
        visibility: "internal",
        id: "judge-private",
        owner_key_name: "owner",
        started_at: 1,
        request,
      },
    });
    journal.append({ type: "future_private_event", occurred_at: 1, detail: { sentinel } });
    journal.append({ type: "run_ended", occurred_at: 2, reason: "completed" });
    journal.close();
    const lines = readFileSync(join(root, "owner", "1.judge-private.jsonl"), "utf8");
    expect(lines.trim().split("\n")).toHaveLength(1);
    expect(lines).not.toContain(sentinel);
    expect(lines).not.toContain("future_private_event");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private orphan recovery uses only projected content and remains hidden", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-judge-private-recovery-"));
  try {
    const physical = createJsonTraceStore({ dir: root });
    const store = createJudgeTraceStore(physical);
    const journal = store.openJournal!({
      header: {
        visibility: "internal",
        id: "judge-private",
        owner_key_name: "owner",
        started_at: 1,
        request,
      },
    });
    journal.append({
      type: "tool_call_started",
      agent: "subagent",
      call_id: sentinel,
      iteration_ref: 1,
      started_at: 2,
      mcp_name: "",
      tool_name: "judge_step",
      arguments: { sentinel },
    });
    journal.close();
    const age = new Date(Date.now() - 7_200_000);
    utimesSync(join(root, "owner", "1.judge-private.jsonl"), age, age);
    expect(await physical.recoverOrphans!()).toMatchObject({ recovered: 1 });
    const recovered = physical.getById("owner", "judge-private")!;
    expect(recovered).toMatchObject({ visibility: "internal", status: "interrupted" });
    expect(JSON.stringify(recovered)).not.toContain(sentinel);
    expect(() => validateBody(recovered.request, loadEnv({}))).not.toThrow();
    expect(
      createTraceVisibilityView(physical, "public").getById("owner", "judge-private"),
    ).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
