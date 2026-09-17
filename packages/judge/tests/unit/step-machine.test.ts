import { expect, test } from "bun:test";
import type { LLMToolCall, AuthorityEnvelopeV1 } from "@clarvis/capability";
import { createJudgeStepMachine } from "../../src/step-machine.ts";
import type {
  CompiledAuthorityTransition,
  JudgeTerminalReceipt,
} from "../../src/private-protocol.ts";

const envelope: AuthorityEnvelopeV1 = {
  version: 1,
  revision: 1,
  objectives: [
    {
      id: "objective",
      summary: "bounded edit",
      target_digests: ["target"],
      evidence_ids: ["evidence"],
    },
  ],
  grants: [
    {
      id: "grant",
      effect_id: "workspace.file.write",
      relation: "direct",
      target_digests: ["target"],
      evidence_ids: ["evidence"],
      constraints: { path: "file", count: 1, bounded: true },
    },
  ],
  exclusions: [{ class: "destructive" }],
};
const transition: CompiledAuthorityTransition = {
  envelope,
  revision: 1,
  transition_token: "host-transaction",
};
const call = (args: unknown): LLMToolCall => ({ id: "call", name: "judge_step", arguments: args });
const decision: JudgeTerminalReceipt = {
  action: "decide_effects",
  decision: "allow",
  grant_ids: [],
  relation: "none",
  revision: 1,
  transition_token: "host-transaction",
};

test("command terminates on the first valid call and cannot be reused", async () => {
  const machine = createJudgeStepMachine({ kind: "command" });
  const args: JudgeTerminalReceipt = {
    action: "decide_command",
    decision: "deny",
    reason: "outside scope",
  };
  expect(await machine.accept([call(JSON.stringify(args))])).toEqual({
    kind: "completed",
    receipt: args,
  });
  expect(await machine.accept([call(args)])).toEqual({ kind: "invalid_response" });
});

test("compile installs exactly once and only its host transition enables decide", async () => {
  let installed = 0;
  const machine = createJudgeStepMachine({
    kind: "compile_effects",
    async validateAndInstall(candidate) {
      expect(candidate).toEqual(envelope);
      installed++;
      return transition;
    },
  });
  expect(
    await machine.accept([call({ action: "compile_authority", candidate: envelope })]),
  ).toEqual({ kind: "compiled", transition });
  expect(machine.stage()).toBe("effects");
  expect(await machine.accept([call(decision)])).toEqual({ kind: "completed", receipt: decision });
  expect(installed).toBe(1);
});

test.each(
  [
    undefined,
    [],
    [call(decision), call(decision)],
    [call("{")],
    [{ ...call(decision), name: "other" }],
    [call({ action: "decide_command", decision: "allow" })],
    [call({ ...decision, revision: 2 })],
    [call({ ...decision, transition_token: "model-forged" })],
    [call({ ...decision, extra: true })],
    [call({ action: "compile_authority", candidate: envelope })],
  ].map((calls) => ({ calls })),
)("effects reject malformed, foreign, duplicated and out-of-order calls %#", async ({ calls }) => {
  const machine = createJudgeStepMachine({ kind: "effects", transition });
  expect(await machine.accept(calls)).toEqual({ kind: "invalid_response" });
  expect(machine.stage()).toBe("closed");
});

test("free text cannot accompany a valid command", async () => {
  const machine = createJudgeStepMachine({ kind: "command" });
  expect(
    await machine.accept(
      [call({ action: "decide_command", decision: "allow" })],
      "extra conclusion",
    ),
  ).toEqual({ kind: "invalid_response" });
});

test("multiple compile calls do not partially install authority", async () => {
  let installs = 0;
  const machine = createJudgeStepMachine({
    kind: "compile_effects",
    async validateAndInstall() {
      installs++;
      return transition;
    },
  });
  const compile = call({ action: "compile_authority", candidate: envelope });
  expect(await machine.accept([compile, compile])).toEqual({ kind: "invalid_response" });
  expect(installs).toBe(0);
});

test.each(["close", "duplicate"] as const)(
  "%s during compile fences its late receipt without retrying the transaction",
  async (operation) => {
    let release!: (value: CompiledAuthorityTransition) => void;
    const waiting = new Promise<CompiledAuthorityTransition>((resolve) => {
      release = resolve;
    });
    let installs = 0;
    const machine = createJudgeStepMachine({
      kind: "compile_effects",
      validateAndInstall() {
        installs++;
        return waiting;
      },
    });
    const compile = call({ action: "compile_authority", candidate: envelope });
    const pending = machine.accept([compile]);
    expect(machine.stage()).toBe("pending");
    if (operation === "close") machine.close();
    else expect(await machine.accept([compile])).toEqual({ kind: "invalid_response" });
    release(transition);
    expect(await pending).toEqual({ kind: "invalid_response" });
    expect(installs).toBe(1);
  },
);

test("host failure propagates unchanged and permanently closes the case", async () => {
  const failure = new Error("host wiring failed");
  const machine = createJudgeStepMachine({
    kind: "compile_effects",
    async validateAndInstall() {
      throw failure;
    },
  });
  await expect(
    machine.accept([call({ action: "compile_authority", candidate: envelope })]),
  ).rejects.toBe(failure);
  expect(machine.stage()).toBe("closed");
});

test("inconsistent host transition fails structurally instead of becoming uncertainty", async () => {
  expect(() =>
    createJudgeStepMachine({ kind: "effects", transition: { ...transition, revision: 2 } }),
  ).toThrow();
  const machine = createJudgeStepMachine({
    kind: "compile_effects",
    async validateAndInstall() {
      return { ...transition, revision: 2 };
    },
  });
  await expect(
    machine.accept([call({ action: "compile_authority", candidate: envelope })]),
  ).rejects.toThrow();
  expect(machine.stage()).toBe("closed");
});

test("host semantic rejection ends the case without a receipt", async () => {
  const machine = createJudgeStepMachine({
    kind: "compile_effects",
    async validateAndInstall() {
      return undefined;
    },
  });
  expect(
    await machine.accept([call({ action: "compile_authority", candidate: envelope })]),
  ).toEqual({ kind: "invalid_response" });
});

test("provider-marked malformed arguments never dispatch", async () => {
  const machine = createJudgeStepMachine({ kind: "command" });
  expect(
    await machine.accept([
      { ...call({ action: "decide_command", decision: "allow" }), malformedArguments: "truncated" },
    ]),
  ).toEqual({ kind: "invalid_response" });
});
