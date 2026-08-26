import { describe, expect, it } from "../bun-test.ts";
import type { GateVerdict, LifecycleHook, Logger, PreFinalizeContext } from "@clarvis/capability";
import {
  buildPreFinalizeGate,
  fireObservers,
  runVerdictHooks,
  type VerdictSweep,
} from "../../src/runtime/loop/lifecycle-hooks.ts";

function hook(verdict: () => GateVerdict | Promise<GateVerdict>): LifecycleHook {
  return { preFinalize: async () => verdict() };
}

function logger(): Logger & { warnings: unknown[][] } {
  const warnings: unknown[][] = [];
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => void warnings.push(args),
    error: () => {},
  };
}

function sweep(
  hooks: readonly LifecycleHook[] | undefined,
  onThrow: "deny" | "ignore" = "deny",
  log?: Logger,
  timeoutMs?: number,
) {
  const context: PreFinalizeContext = { agent: "lead", mode: "text", text: "done" };
  return runVerdictHooks(
    hooks,
    (entry) => (entry.preFinalize === undefined ? undefined : () => entry.preFinalize!(context)),
    {
      onThrow,
      onThrowWarn: "hook failed",
      ...(log !== undefined ? { logger: log } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
  );
}

describe("runVerdictHooks", () => {
  it("aborts a pending hook with the signal reason", async () => {
    const controller = new AbortController();
    const pending = runVerdictHooks(
      [hook(() => new Promise<GateVerdict>(() => undefined))],
      (entry) => () => entry.preFinalize!({ agent: "lead", mode: "text", text: "done" }),
      {
        onThrow: "deny",
        onThrowWarn: "hook failed",
        signal: controller.signal,
      },
    );
    controller.abort(new Error("run cancelled"));

    await expect(pending).resolves.toMatchObject({
      denied: { message: "the hook itself failed (run cancelled)", fromThrow: true },
    });
  });

  it("collects advice in hook order and ignores hooks without the selected method", async () => {
    await expect(
      sweep([
        hook(() => ({ kind: "advise", message: "first" })),
        {},
        hook(async () => ({ kind: "pass" })),
        hook(() => ({ kind: "advise", message: "second" })),
      ]),
    ).resolves.toEqual({ denied: null, advise: ["first", "second"] });
    await expect(sweep(undefined)).resolves.toEqual({ denied: null, advise: [] });
  });

  it("short-circuits on the first explicit denial", async () => {
    let reached = false;
    const result = await sweep([
      hook(() => ({ kind: "advise", message: "before" })),
      hook(() => ({ kind: "deny", message: "blocked" })),
      hook(() => {
        reached = true;
        return { kind: "pass" };
      }),
    ]);

    expect(result).toEqual({
      denied: { message: "blocked", fromThrow: false },
      advise: ["before"],
    });
    expect(reached).toBe(false);
  });

  const throwPolicies: Array<["deny" | "ignore", VerdictSweep]> = [
    ["deny", { denied: { message: "the hook itself failed (boom)", fromThrow: true }, advise: [] }],
    ["ignore", { denied: null, advise: ["survived"] }],
  ];

  it.each(throwPolicies)(
    "applies the %s throw policy and logs the failure",
    async (onThrow, expected) => {
      const log = logger();
      const result = await sweep(
        [
          hook(() => {
            throw new Error("boom");
          }),
          hook(() => ({ kind: "advise", message: "survived" })),
        ],
        onThrow,
        log,
      );

      expect(result).toEqual(expected);
      expect(log.warnings).toEqual([
        [{ event: "hook.verdict_failed", err: "boom" }, "hook failed"],
      ]);
    },
  );

  it("fails closed within the wall budget when an extension promise never settles", async () => {
    const result = await sweep(
      [hook(() => new Promise<GateVerdict>(() => undefined))],
      "deny",
      undefined,
      5,
    );
    expect(result.denied?.fromThrow).toBe(true);
    expect(result.denied?.message).toContain("timed out after 5ms");
  });
});

describe("buildPreFinalizeGate", () => {
  it("fast-accepts only when no hook owns preFinalize", () => {
    const without = buildPreFinalizeGate({
      hooks: [{}],
      agent: "lead",
      appendNote: () => {},
    });
    const withHook = buildPreFinalizeGate({
      hooks: [hook(() => ({ kind: "pass" }))],
      agent: "lead",
      appendNote: () => {},
    });

    expect(without.fastAcceptOk?.()).toBe(true);
    expect(withHook.fastAcceptOk?.()).toBe(false);
  });

  it("builds the submit context and appends advice without blocking", async () => {
    const contexts: PreFinalizeContext[] = [];
    const notes: string[] = [];
    const gate = buildPreFinalizeGate({
      hooks: [
        {
          async preFinalize(context) {
            contexts.push(context);
            return { kind: "advise", message: "add tests" };
          },
        },
      ],
      agent: "subagent",
      subagentInstanceId: "worker-1",
      appendNote: (note) => notes.push(note),
    });

    await expect(gate.check({ mode: "submit", value: { name: "Ada" } })).resolves.toEqual({
      kind: "pass",
    });
    expect(contexts).toEqual([
      {
        agent: "subagent",
        subagentInstanceId: "worker-1",
        mode: "submit",
        value: { name: "Ada" },
      },
    ]);
    expect(notes).toEqual(["[advisor] add tests"]);
  });

  it.each([
    [
      "explicit denial",
      hook(() => ({ kind: "deny", message: "tests are red" })),
      "[runtime: finalize rejected by a workspace hook: tests are red]",
    ],
    [
      "throw",
      hook(() => {
        throw new Error("boom");
      }),
      "[runtime: finalize rejected — the hook itself failed (boom)]",
    ],
  ])("turns %s into an unbounded nudge", async (_label, lifecycle, note) => {
    const gate = buildPreFinalizeGate({
      hooks: [lifecycle],
      agent: "lead",
      appendNote: () => {},
    });

    await expect(gate.check({ mode: "text", text: "done" })).resolves.toEqual({
      kind: "nudge",
      unbounded: true,
      note,
    });
  });
});

describe("fireObservers", () => {
  it("notifies matching hooks in order with the same context", async () => {
    const seen: Array<[string, unknown]> = [];
    const context = { mode: "subagent-only" as const, entry: "solo", subagentModel: "p/m" };
    const hooks: LifecycleHook[] = [
      { onRunStart: async (received) => void seen.push(["one", received]) },
      {},
      { onRunStart: async (received) => void seen.push(["two", received]) },
    ];

    await fireObservers(hooks, "onRunStart", context);

    expect(seen).toEqual([
      ["one", context],
      ["two", context],
    ]);
  });

  it("isolates a throwing observer, logs it, and continues", async () => {
    const log = logger();
    let survivor = false;
    const context = { mode: "subagent-only" as const, entry: "solo", subagentModel: "p/m" };

    await fireObservers(
      [
        {
          onRunStart: async () => {
            throw new Error("observer boom");
          },
        },
        { onRunStart: async () => void (survivor = true) },
      ],
      "onRunStart",
      context,
      log,
    );

    expect(survivor).toBe(true);
    expect(log.warnings).toEqual([
      [
        { event: "hook.observer_failed", hook_event: "onRunStart", err: "observer boom" },
        "observer hook threw; ignored",
      ],
    ]);
  });

  it("detaches a stuck observer and continues to later hooks", async () => {
    const seen: string[] = [];
    const context = { mode: "subagent-only" as const, entry: "solo", subagentModel: "p/m" };
    await fireObservers(
      [
        { onRunStart: () => new Promise<void>(() => undefined) },
        { onRunStart: async () => void seen.push("survivor") },
      ],
      "onRunStart",
      context,
      undefined,
      { timeoutMs: 5 },
    );
    expect(seen).toEqual(["survivor"]);
  });
});
