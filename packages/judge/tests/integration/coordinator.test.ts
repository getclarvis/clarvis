import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEnv,
  ProviderError,
  type LLMCallParams,
  type LLMCallResult,
} from "@clarvis/capability";
import { JudgeArchitectureError } from "../../src/errors.ts";
import { createTestRunInfrastructure } from "@clarvis/loop/testing";
import {
  createJudgeCoordinator,
  type JudgeCoordinator,
  type JudgeCoordinatorOptions,
} from "../../src/coordinator.ts";

const answer = (args: unknown): LLMCallResult => ({
  toolCalls: [{ id: "call", name: "judge_step", arguments: args }],
  usage: { input_tokens: 10, output_tokens: 2, cached_tokens: 0, cache_write_tokens: 0 },
});
const command = { action: "decide_command", decision: "allow" };
const caseInput = { currentCase: { command: "same" } };
const context = () => ({
  snapshot: () => ({ revision: 1 }),
  isCurrent: () => true,
  validateReceipt: () => true,
});

async function fixture(
  call: (params: LLMCallParams) => Promise<LLMCallResult>,
  run: (coordinator: JudgeCoordinator, options: JudgeCoordinatorOptions) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "judge-coordinator-"));
  const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
  const infrastructure = createTestRunInfrastructure({ env, workspaceRoot: root });
  const base = { call };
  const options: JudgeCoordinatorOptions = {
    owner: "owner",
    workExecutionId: "work",
    sessionId: "session",
    executionBaseLlm: base,
    promptCacheTtl: "1h",
    model: "anthropic/test",
    providers: [{ name: "anthropic", kind: "anthropic" }],
    timeoutMs: 1000,
    maxRetries: 0,
    createServices: () => ({ ...infrastructure, env, llm: base }),
  };
  const coordinator = createJudgeCoordinator(options);
  try {
    await run(coordinator, options);
  } finally {
    await coordinator.close();
    await infrastructure.connections.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
}

test("eight concurrent command reviews share inference, then reuse an isolated receipt", async () => {
  let calls = 0;
  await fixture(
    async () => {
      calls++;
      return answer(command);
    },
    async (coordinator) => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => coordinator.reviewCommand(caseInput, context())),
      );
      expect(calls).toBe(1);
      expect(new Set(results.map((result) => result.executionId)).size).toBe(1);
      for (const result of results) expect(result.kind).toBe("reviewed");
      if (results[0]!.kind === "reviewed") results[0]!.receipt.decision = "deny";
      const cached = await coordinator.reviewCommand(caseInput, context());
      expect(cached).toMatchObject({
        kind: "reviewed",
        cacheHit: true,
        attempts: 0,
        receipt: { decision: "allow" },
      });
      expect(calls).toBe(1);
      await coordinator.reviewCommand(caseInput, {
        ...context(),
        snapshot: () => ({ revision: 2 }),
      });
      await coordinator.reviewCommand({ currentCase: { command: "different" } }, context());
      expect(calls).toBe(3);
    },
  );
});

test("uncertainty and host-rejected receipts are not cached", async () => {
  let calls = 0;
  await fixture(
    async () => {
      calls++;
      return answer({ ...command, decision: calls <= 2 ? "unsure" : "allow" });
    },
    async (coordinator) => {
      for (let index = 0; index < 2; index++)
        expect((await coordinator.reviewCommand(caseInput, context())).kind).toBe("reviewed");
      for (let index = 0; index < 2; index++)
        expect(
          await coordinator.reviewCommand(caseInput, {
            ...context(),
            validateReceipt: () => false,
          }),
        ).toMatchObject({ kind: "failed", failureKind: "invalid_response" });
      expect(calls).toBe(10);
    },
  );
});

test("stale context stops admission and invalidates an in-flight receipt", async () => {
  let current = false;
  let calls = 0;
  await fixture(
    async () => {
      calls++;
      current = false;
      return answer(command);
    },
    async (coordinator) => {
      const bound = { ...context(), isCurrent: () => current };
      expect((await coordinator.reviewCommand(caseInput, bound)).kind).toBe("stale");
      expect(calls).toBe(0);
      current = true;
      expect((await coordinator.reviewCommand(caseInput, bound)).kind).toBe("stale");
      expect(calls).toBe(1);
    },
  );
});

test("compile caches only the validated decide under the installed snapshot", async () => {
  let revision = 0;
  let calls = 0;
  const envelope = { version: 1 as const, revision: 1, objectives: [], grants: [], exclusions: [] };
  const transition = { envelope, revision: 1, transition_token: "installed" };
  await fixture(
    async () => {
      calls++;
      return answer(
        calls === 1
          ? { action: "compile_authority", candidate: { ...envelope, revision: 0 } }
          : {
              action: "decide_effects",
              decision: "allow",
              revision: 1,
              transition_token: "installed",
              relation: "none",
              grant_ids: [],
            },
      );
    },
    async (coordinator) => {
      const common = {
        snapshot: () => ({ revision }),
        isCurrent: () => true,
        validateReceipt: () => true,
      };
      const first = await coordinator.reviewEffects(caseInput, {
        ...common,
        binding: {
          kind: "compile_effects",
          async validateAndInstall() {
            revision = 1;
            return transition;
          },
        },
      });
      expect(first.kind).toBe("reviewed");
      expect(calls).toBe(2);
      const second = await coordinator.reviewEffects(caseInput, {
        ...common,
        binding: { kind: "effects", transition },
      });
      expect(second).toMatchObject({ kind: "reviewed", cacheHit: true, attempts: 0 });
      expect(calls).toBe(2);
    },
  );
});

test.each(["auth", "quota", "transient", "client"] as const)(
  "provider %s stays a classified failure",
  async (kind) => {
    await fixture(
      async () => {
        throw new ProviderError("private text", { kind });
      },
      async (coordinator) => {
        expect(await coordinator.reviewCommand(caseInput, context())).toMatchObject({
          kind: "failed",
          failureKind: kind === "transient" ? "transport" : kind === "client" ? "admission" : kind,
        });
      },
    );
  },
);

test("host validation fault propagates and is never a cached uncertainty", async () => {
  const fault = new Error("structural host fault");
  await fixture(
    async () => answer(command),
    async (coordinator) => {
      const bound = {
        ...context(),
        validateReceipt() {
          throw fault;
        },
      };
      await expect(coordinator.reviewCommand(caseInput, bound)).rejects.toBe(fault);
      expect((await coordinator.reviewCommand(caseInput, context())).kind).toBe("reviewed");
    },
  );
});

test("retirement aborts the active child and prevents future inference", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  await fixture(
    async (params) => {
      calls++;
      started();
      await new Promise<void>((resolve) => {
        if (params.signal?.aborted) resolve();
        else params.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return answer(command);
    },
    async (coordinator) => {
      const pending = coordinator.reviewCommand(caseInput, context());
      await ready;
      await coordinator.close();
      expect(await pending).toMatchObject({ kind: "failed", failureKind: "cancelled" });
      expect(await coordinator.reviewCommand(caseInput, context())).toMatchObject({
        kind: "failed",
        failureKind: "cancelled",
        attempts: 0,
      });
      expect(calls).toBe(1);
    },
  );
});

test("missing effective model is admission failure with no inference", async () => {
  await fixture(
    async () => {
      throw new Error("must not infer");
    },
    async (_coordinator, options) => {
      const missing = createJudgeCoordinator({ ...options, model: undefined });
      try {
        expect(await missing.reviewCommand(caseInput, context())).toMatchObject({
          kind: "failed",
          failureKind: "admission",
          attempts: 0,
        });
      } finally {
        await missing.close();
      }
    },
  );
});

test("cached receipts are revalidated and discarded when the host no longer accepts them", async () => {
  let calls = 0;
  await fixture(
    async () => {
      calls++;
      return answer(command);
    },
    async (coordinator) => {
      await coordinator.reviewCommand(caseInput, context());
      expect(
        await coordinator.reviewCommand(caseInput, { ...context(), validateReceipt: () => false }),
      ).toMatchObject({ kind: "failed", failureKind: "invalid_response" });
      await coordinator.reviewCommand(caseInput, context());
      expect(calls).toBe(2);
      let checks = 0;
      expect(
        (
          await coordinator.reviewCommand(caseInput, {
            ...context(),
            isCurrent: () => ++checks === 1,
          })
        ).kind,
      ).toBe("stale");
    },
  );
});

test.each(["stale", "invalid"] as const)(
  "a coalesced caller still applies its own %s fence",
  async (mode) => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = true;
    await fixture(
      async () => {
        await waiting;
        return answer(command);
      },
      async (coordinator) => {
        const first = coordinator.reviewCommand(caseInput, context());
        const second = coordinator.reviewCommand(caseInput, {
          ...context(),
          isCurrent: () => current,
          validateReceipt: () => mode !== "invalid",
        });
        if (mode === "stale") current = false;
        release();
        expect((await first).kind).toBe("reviewed");
        expect((await second).kind).toBe(mode === "stale" ? "stale" : "failed");
      },
    );
  },
);

test.each(["invalid", "rate_limit", "unknown", "timeout"] as const)(
  "coordinator classifies %s without storing a receipt",
  async (kind) => {
    await fixture(
      async (params) => {
        if (kind === "rate_limit") throw new ProviderError("private", { status: 429 });
        if (kind === "unknown") throw new Error("private provider error");
        if (kind === "timeout")
          await new Promise<void>((resolve) => {
            params.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        return kind === "invalid" ? answer({ action: "wrong" }) : answer(command);
      },
      async (coordinator, options) => {
        const selected =
          kind === "timeout" ? createJudgeCoordinator({ ...options, timeoutMs: 1 }) : coordinator;
        try {
          expect(await selected.reviewCommand(caseInput, context())).toMatchObject({
            kind: "failed",
            failureKind: kind === "invalid" ? "invalid_response" : kind,
          });
        } finally {
          if (selected !== coordinator) await selected.close();
        }
      },
    );
  },
);

test("a host adapter architecture fault cannot become an unsure failure", async () => {
  const error = new JudgeArchitectureError();
  await fixture(
    async () => {
      throw error;
    },
    async (coordinator) => {
      await expect(coordinator.reviewCommand(caseInput, context())).rejects.toBe(error);
    },
  );
});

test("retirement during host validation cannot publish or cache an allow", async () => {
  await fixture(
    async () => answer(command),
    async (coordinator) => {
      let closing: Promise<void> | undefined;
      const outcome = await coordinator.reviewCommand(caseInput, {
        ...context(),
        validateReceipt() {
          closing = coordinator.close();
          return true;
        },
      });
      expect(outcome).toMatchObject({ kind: "failed", failureKind: "cancelled" });
      await closing;
    },
  );
});

test("caller mutation cannot rekey an in-flight receipt onto a different case", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await fixture(
    async () => {
      calls++;
      if (calls === 1) await waiting;
      return answer(command);
    },
    async (coordinator) => {
      const input = { currentCase: { command: "original" } };
      const pending = coordinator.reviewCommand(input, context());
      input.currentCase.command = "different";
      release();
      await pending;
      expect(
        await coordinator.reviewCommand({ currentCase: { command: "original" } }, context()),
      ).toMatchObject({ cacheHit: true });
      expect(await coordinator.reviewCommand(input, context())).toMatchObject({ cacheHit: false });
      expect(calls).toBe(2);
    },
  );
});
