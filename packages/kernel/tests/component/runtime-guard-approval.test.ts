import { describe, expect, it } from "bun:test";
import type { Elicit, GuardElicit } from "@clarvis/loop";
import { analyzeShell, posixDialect } from "@clarvis/tools/guard";
import { createGuardHumanApproval } from "../../src/guard/human-approval.ts";
import { createGuardSessionAllowlist } from "../../src/guard/guard-elicit.ts";
import {
  createGuestGuardApproval,
  createHostGuardApprovalGrant,
} from "../../src/runtime/guard-approval-bridge.ts";
import type { GuestExecutionBridge } from "../../src/runtime/execution-worker.ts";
import { fixture, input } from "../helpers/hosted-registry.ts";

const request = (command = "printf consent-check"): Parameters<GuardElicit>[0] => ({
  tool: "shell",
  args: { command },
  shell: analyzeShell(command, posixDialect),
});

describe("host-owned guard consent", () => {
  for (const placement of ["native", "guest"] as const) {
    it.each(["detach", "takeover", "disconnect", "close_session"] as const)(
      `${placement} loses cached approval on %s and asks again after reacquisition`,
      async (transition) => {
        const f = fixture();
        const first = f.registry.connect("operator");
        const second = f.registry.connect("operator");
        let view = await first.service.start(input());
        if (transition === "disconnect" || transition === "close_session") {
          await first.service.detach(f.handoff(view));
          view = await first.service.attach({
            execution_id: "run-1",
            host_generation: "host-generation",
            control: "acquire",
          });
        }
        const signal = new AbortController().signal;
        let questions = 0;
        const options = {
          elicit: (async () => {
            questions++;
            return { action: "accept", content: { decision: "allow_session" } };
          }) satisfies Elicit,
          allowlist: () => f.registry.guardAllowlistFor({ owner: "owner", executionId: "run-1" }),
          workspaceRoot: "/workspace",
        };
        const grant = createHostGuardApprovalGrant(options);
        const bridge: GuestExecutionBridge = {
          model: async () => {
            throw new Error("no model calls");
          },
          capability: (_id, call) => {
            expect(grant.validateArguments(call.arguments)).toBe(true);
            return grant.invoke(call.arguments, signal);
          },
          event: async () => {},
          checkpoint: async () => {},
        };
        const authority =
          placement === "native"
            ? createGuardHumanApproval(options)
            : createGuestGuardApproval(bridge, signal);
        try {
          const old = options.allowlist()!;
          expect(await authority.ask(request())).toEqual({ allowed: true, persisted: true });
          expect(await authority.covers(request())).toBe(true);
          expect(questions).toBe(1);
          if (transition === "detach") await first.service.detach(f.handoff(view));
          if (transition === "takeover")
            await second.service.attach({
              execution_id: "run-1",
              host_generation: "host-generation",
              control: "takeover",
            });
          if (transition === "disconnect") await first.close();
          if (transition === "close_session") await first.service.closeSession("session-1");
          expect(old.covers(request().shell!)).toBe(false);
          expect(await authority.covers(request())).toBe(false);
          if (transition !== "takeover") {
            await second.service.attach({
              execution_id: "run-1",
              host_generation: "host-generation",
              control: "acquire",
            });
          }
          expect(await authority.ask(request())).toEqual({ allowed: true, persisted: true });
          expect(questions).toBe(2);
          expect(await authority.covers(request())).toBe(true);
        } finally {
          f.finish();
          await f.registry.close();
        }
      },
    );
  }

  it.each(["allow", "allow_session"])(
    "rejects a retired controller's late %s across the bridge",
    async (decision) => {
      let scope = createGuardSessionAllowlist();
      const prior = scope;
      const pending = Promise.withResolvers<Awaited<ReturnType<Elicit>>>();
      const grant = createHostGuardApprovalGrant({
        elicit: () => pending.promise,
        allowlist: () => scope,
        workspaceRoot: "/workspace",
      });
      const answer = grant.invoke(
        { operation: "ask", tool: "shell", args: request().args },
        new AbortController().signal,
      );
      prior.revoke();
      scope = createGuardSessionAllowlist();
      pending.resolve({ action: "accept", content: { decision } });
      expect(await answer).toEqual({ allowed: false, persisted: false });
      expect(prior.covers(request().shell!)).toBe(false);
      expect(scope.covers(request().shell!)).toBe(false);
    },
  );

  it("derives the recorded command from displayed POSIX arguments and refuses forged facts", async () => {
    const scope = createGuardSessionAllowlist();
    const grant = createHostGuardApprovalGrant({
      elicit: async () => ({ action: "accept", content: { decision: "allow_session" } }),
      allowlist: () => scope,
      workspaceRoot: "/workspace",
    });
    const signal = new AbortController().signal;
    const args = { operation: "ask", tool: "shell", args: request().args };
    expect(grant.validateArguments({ ...args, shell: request("rm dangerous").shell })).toBe(false);
    expect(await grant.invoke(args, signal)).toEqual({ allowed: true, persisted: true });
    expect(scope.covers(request().shell!)).toBe(true);
    expect(scope.covers(request("rm dangerous").shell!)).toBe(false);
    expect(await grant.invoke({ ...args, operation: "covers", escalate: "human" }, signal)).toBe(
      false,
    );
  });
});
