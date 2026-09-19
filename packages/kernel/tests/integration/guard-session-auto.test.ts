import { JUDGE_PORT } from "@clarvis/judge";
import { judgePort } from "../helpers/judge-port.ts";
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  createCapabilityServices,
  OPERATOR_AUTHORITY_PORT,
  type RunCapabilityContext,
} from "@clarvis/capability";
import { buildGuardContext, posixDialect, type GuardContext } from "@clarvis/tools/guard";
import { createGuardResolver } from "../../src/guard/resolver.ts";
import { createGuardSessionAllowlist } from "../../src/guard/guard-elicit.ts";
import { createOperatorAuthorityRuntime } from "../../src/guard/operator-authority.ts";

test("Auto sends ordinary and unsandbox asks to the Judge and still denies listed commands", async () => {
  const root = resolve(".");
  const allowlist = createGuardSessionAllowlist();
  let questions = 0;
  let reviews = 0;
  let denied: string[] = [];
  const resolver = createGuardResolver({
    loadSettings: () => ({
      effect_review: { on_unsure: "ask" },
      guard: { type: "shell", mode: "auto", denied_commands: denied },
    }),
    sessionAllowlistFor: () => allowlist,
  });
  const services = createCapabilityServices();
  services.provide(
    OPERATOR_AUTHORITY_PORT,
    createOperatorAuthorityRuntime({
      owner: "owner",
      executionId: "run",
      seed: {
        binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
        evidence: [
          { id: "operator", source: "start", text: "Install packages", execution_id: "run" },
        ],
      },
    }).reader,
  );
  services.provide(
    JUDGE_PORT,
    judgePort(async () => {
      reviews++;
      return {
        kind: "reviewed",
        receipt: { action: "decide_command", decision: reviews === 1 ? "allow" : "deny" },
        elapsedMs: 0,
        attempts: 1,
        cacheHit: false,
      };
    }),
  );
  const ctx = {
    services,
    owner: "owner",
    executionId: "run",
    workspaceRoot: root,
    env: {},
    requestParam: () => undefined,
    request: {},
    llm: {
      call: async () => {
        throw new Error("Unknown effects must not call the reviewer");
      },
    },
    elicit: async () => {
      questions++;
      return { action: "accept", content: { decision: "allow_session" } };
    },
  } as unknown as RunCapabilityContext;
  const runtime = (await resolver(ctx))!;
  const call = (escalated = false) =>
    buildGuardContext(
      "shell",
      {
        command: "npm install",
        ...(escalated ? { sandbox_permissions: "require_escalated" } : {}),
      },
      {
        workspaceRoot: root,
        stateRoot: resolve(root, "state"),
        temporaryRoots: [],
        skillExecutionRoots: [],
        ...(escalated ? { sandbox: { type: "native" } } : {}),
      } as unknown as GuardContext["config"],
      posixDialect,
    );
  const current = call();
  const decision = await runtime.guard!(current);
  expect(decision.verdict).toBe("ask");
  expect(
    await runtime.elicit!({
      tool: "shell",
      args: current.args,
      shell: current.shell,
      ...decision,
    }),
  ).toMatchObject({ allowed: true, answerer: "judge" });
  const escalated = call(true);
  const host = await runtime.guard!(escalated);
  expect(host.matched).toBe("host_command");
  expect(host).not.toHaveProperty("escalate");
  expect(
    await runtime.elicit!({
      tool: "shell",
      args: escalated.args,
      shell: escalated.shell,
      ...host,
    }),
  ).toMatchObject({ allowed: false, answerer: "judge" });
  expect(questions).toBe(0);
  expect(reviews).toBe(2);
  denied = ["npm install"];
  expect(await (await resolver(ctx))!.guard!(call())).toMatchObject({
    verdict: "deny",
    matched: "deny_list",
  });
  expect(questions).toBe(0);
});
