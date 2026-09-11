import { describe, expect, it } from "bun:test";
import { loadEnv, type Elicit } from "@clarvis/capability";
import type { ExecuteRunDeps, ExecuteRunOutcome } from "@clarvis/loop";
import type { StartRunParams } from "@clarvis/protocol";
import { configurationRoots } from "@clarvis/paths";
import { createNativeConfigurationRuns } from "../../src/configuration/native-configuration.ts";
import { createMemoryConfigStore } from "../../src/config/memory-config-store.ts";
import { withBuiltinSkills } from "../../src/skills/builtin-skills.ts";
import type { RunExecutorArgs } from "../../src/runs/run-service.ts";

const approved: Elicit = async () => ({ action: "accept", content: { answer: "allow_session" } });
function fixture(
  options: {
    execute?: (args: RunExecutorArgs) => Promise<ExecuteRunOutcome>;
    onActivity?: (active: boolean) => void;
  } = {},
) {
  const calls: RunExecutorArgs[] = [];
  const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
  const deps = {
    env,
    capabilities: [
      { name: "ask-user" },
      { name: "tools" },
      { name: "hooks" },
      { name: "workflows" },
    ],
  } as ExecuteRunDeps;
  const mode = createNativeConfigurationRuns({
    skills: withBuiltinSkills(undefined),
    roots: configurationRoots({ workspaceRoot: "/workspace", globalDir: "/operator" }),
    store: createMemoryConfigStore({ settings: { global: { default_model: "anthropic/test" } } }),
    onActivity: options.onActivity,
    nativeExecuteRun: async (args) => {
      calls.push(args);
      if (options.execute !== undefined) return options.execute(args);
      return { executionId: "test", response: {} } as ExecuteRunOutcome;
    },
  });
  let id = 0;
  const run = (
    params: Partial<StartRunParams> = {},
    elicit: Elicit | undefined = approved,
    owner = "owner",
    externalSignal?: AbortSignal,
  ) =>
    mode.execute(
      {
        execution_id: `test-${++id}`,
        messages: [],
        skill: { name: "clarvis-configure", task: "Create a reviewer" },
        configuration_session_id: "live-session",
        ...params,
      },
      {
        owner,
        deps,
        ...(elicit === undefined ? {} : { elicit }),
        ...(externalSignal === undefined ? {} : { externalSignal }),
      },
    );
  return { calls, mode, run };
}

describe("native configuration consent", () => {
  it("retires one live conversation without revoking another owner's or conversation's consent", async () => {
    const f = fixture();
    let approvals = 0;
    const elicit: Elicit = async (req, opts) => {
      approvals++;
      return approved(req, opts);
    };
    await f.run({}, elicit);
    await f.run({ configuration_session_id: "other-session" }, elicit);
    await f.run({}, elicit, "other-owner");
    f.mode.retireSession("owner", "live-session");
    await f.run({ configuration_session_id: "other-session" }, elicit);
    await f.run({}, elicit, "other-owner");
    expect(approvals).toBe(3);
    await f.run({}, elicit);
    expect(approvals).toBe(4);
    f.mode.close();
  });

  it("rejects a pending approval after its live conversation was retired", async () => {
    const f = fixture();
    await expect(
      f.run({}, async (req, opts) => {
        f.mode.retireSession("owner", "live-session");
        expect(opts?.signal?.aborted).toBe(true);
        return approved(req, opts);
      }),
    ).rejects.toThrow("ended");
    expect(f.calls).toHaveLength(0);
  });

  it("aborts active native work on retirement and keeps placement active for unrelated work", async () => {
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const placement: boolean[] = [];
    let started = 0;
    const f = fixture({
      onActivity: (active) => placement.push(active),
      execute: (args) =>
        new Promise((_resolve, reject) => {
          args.externalSignal!.addEventListener(
            "abort",
            () => reject(new Error("Native configuration session has ended.")),
            { once: true },
          );
          entered[started++]!.resolve();
        }),
    });
    const first = f.run().then(
      () => undefined,
      (error: unknown) => error,
    );
    const second = f.run({ configuration_session_id: "other-session" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await Promise.all(entered.map((entry) => entry.promise));
    expect(placement).toEqual([true]);
    f.mode.retireSession("owner", "live-session");
    expect(await first).toBeInstanceOf(Error);
    expect(f.calls[0]!.externalSignal!.aborted).toBe(true);
    expect(f.calls[1]!.externalSignal!.aborted).toBe(false);
    expect(placement).toEqual([true]);
    f.mode.close();
    expect(await second).toBeInstanceOf(Error);
    expect(placement).toEqual([true, false]);
  });

  it("requires approval before native execution and narrows all execution surfaces", async () => {
    const f = fixture();
    await f.run({ agent: "admiral", continue_from: "old", guard_mode: "off" }, async (request) => {
      expect(f.calls).toHaveLength(0);
      expect(request.kind).toBe("configuration_access");
      expect(request.message).toContain("without sandbox or container");
      expect(request.message).toContain("Resume requires new approval");
      return approved(request, {});
    });
    const args = f.calls[0]!;
    expect(args.deps.capabilities?.map((cap) => cap.name)).toEqual([
      "ask-user",
      "native-configuration",
    ]);
    expect(args.capabilities).toEqual([]);
    const raw = args.rawBody as Record<string, unknown>;
    expect(raw.servers).toEqual([]);
    expect(raw.entry).toBe("clarvis-configure");
    expect(raw.continue_from).toBeUndefined();
    expect(raw.configuration_session_id).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain("live-session");
    expect(raw.profiles).toMatchObject([{ tools: [], grants: ["ask_user", "configure_clarvis"] }]);
  });

  it("reuses consent only for the same live session and owner, never a resumed nonce", async () => {
    const f = fixture();
    let approvals = 0;
    const elicit: Elicit = async (req, opts) => {
      approvals++;
      return approved(req, opts);
    };
    await f.run({}, elicit);
    await f.run({}, elicit);
    expect(approvals).toBe(1);
    await f.run({ configuration_session_id: "resumed-session" }, elicit);
    await f.run({}, elicit, "another-owner");
    expect(approvals).toBe(3);
    f.mode.retireOwner("owner");
    await f.run({}, elicit);
    expect(approvals).toBe(4);
    f.mode.close();
    await expect(f.run({}, elicit)).rejects.toThrow("ended");
  });

  it("does not reuse consent when no live session nonce was supplied", async () => {
    const f = fixture();
    let approvals = 0;
    const elicit: Elicit = async (req, opts) => {
      approvals++;
      return approved(req, opts);
    };
    await f.run({ configuration_session_id: undefined, session_id: "saved-session" }, elicit);
    await f.run({ configuration_session_id: undefined, continue_from: "old" }, elicit);
    expect(approvals).toBe(2);
  });

  it.each(["decline", "cancel", "malformed", "wrong-answer"] as const)(
    "fails closed on %s",
    async (answer) => {
      const f = fixture();
      const elicit: Elicit = async () =>
        answer === "decline" || answer === "cancel"
          ? { action: answer }
          : { action: "accept", content: answer === "malformed" ? {} : { answer: "yes" } };
      await expect(f.run({}, elicit)).rejects.toThrow("not approved");
      expect(f.calls).toHaveLength(0);
      await f.run();
      expect(f.calls).toHaveLength(1);
    },
  );

  it("rejects late approval after cancellation or host closure", async () => {
    for (const end of ["cancel", "close"] as const) {
      const f = fixture();
      const controller = new AbortController();
      await expect(
        f.run(
          {},
          async () => {
            if (end === "close") f.mode.close();
            else controller.abort();
            return { action: "accept", content: { answer: "allow_session" } };
          },
          "owner",
          controller.signal,
        ),
      ).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    }
  });

  it("coalesces simultaneous requests for one live session", async () => {
    const f = fixture();
    let approvals = 0;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const elicit: Elicit = async (req, opts) => {
      approvals++;
      await wait;
      return approved(req, opts);
    };
    const first = f.run({}, elicit);
    const second = f.run({}, elicit);
    release();
    await Promise.all([first, second]);
    expect(approvals).toBe(1);
    expect(f.calls).toHaveLength(2);
  });
});
