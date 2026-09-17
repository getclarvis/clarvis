import { JUDGE_PORT } from "@clarvis/judge";
import { judgePort } from "../helpers/judge-port.ts";
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createCapabilityServices, type RunCapabilityContext } from "@clarvis/capability";
import { buildGuardContext, posixDialect, type GuardContext } from "@clarvis/tools/guard";
import { createGuardResolver } from "../../src/guard/resolver.ts";
import { createGuardSessionAllowlist } from "../../src/guard/guard-elicit.ts";

test("Auto reuses exact human session consent but still denies listed commands and asks for escalation", async () => {
  const root = resolve(".");
  const allowlist = createGuardSessionAllowlist();
  let questions = 0;
  let denied: string[] = [];
  const resolver = createGuardResolver({
    loadSettings: () => ({
      effect_review: { on_unsure: "ask" },
      guard: { type: "shell", mode: "auto", denied_commands: denied },
    }),
    sessionAllowlistFor: () => allowlist,
  });
  const services = createCapabilityServices();
  services.provide(JUDGE_PORT, judgePort());
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
      return {
        action: "accept",
        content: { decision: questions === 1 ? "allow_session" : "deny" },
      };
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
  for (const answerer of ["human", "session_allowlist"]) {
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
    ).toMatchObject({ allowed: true, answerer });
  }
  expect(questions).toBe(1);
  const escalated = call(true);
  const decision = await runtime.guard!(escalated);
  expect(decision.matched).toBe("host_command");
  expect(
    await runtime.elicit!({
      tool: "shell",
      args: escalated.args,
      shell: escalated.shell,
      ...decision,
    }),
  ).toMatchObject({ allowed: false, answerer: "human" });
  expect(questions).toBe(2);
  denied = ["npm install"];
  expect(await (await resolver(ctx))!.guard!(call())).toMatchObject({
    verdict: "deny",
    matched: "deny_list",
  });
  expect(questions).toBe(2);
});
