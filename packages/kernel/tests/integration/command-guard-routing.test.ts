import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  createCapabilityServices,
  OPERATOR_AUTHORITY_PORT,
  type RunCapabilityContext,
} from "@clarvis/capability";
import { JUDGE_PORT } from "@clarvis/judge";
import { buildGuardContext, posixDialect, type GuardContext } from "@clarvis/tools/guard";
import { createGuardResolver, type GuardSettings } from "../../src/guard/resolver.ts";
import { createGuardSessionAllowlist } from "../../src/guard/guard-elicit.ts";
import { createOperatorAuthorityRuntime } from "../../src/guard/operator-authority.ts";
import { judgePort } from "../helpers/judge-port.ts";

const workspace = resolve(".");

/** One reviewed command case, as the private Judge protocol received it. */
interface ReviewedCase {
  call: { tool: string; args: { command?: string }; matched?: string; placement?: string };
}

function context(command: string, escalated = false): GuardContext {
  return buildGuardContext(
    "shell",
    { command, ...(escalated ? { sandbox_permissions: "require_escalated" } : {}) },
    {
      workspaceRoot: workspace,
      stateRoot: resolve(workspace, ".state"),
      temporaryRoots: [],
      skillExecutionRoots: [],
      ...(escalated ? { sandbox: { type: "native" } } : {}),
    } as unknown as GuardContext["config"],
    posixDialect,
  );
}

/**
 * Compose the production resolver over a semantic-port spy.
 *
 * @remarks The spy counts effect reviews so a routing regression fails loudly: the command guard
 * must never reach the effect path, and no effect classification may sit between the policy and
 * `reviewCommand`.
 */
function harness(options: { guard?: GuardSettings["guard"]; rollout?: "shadow" | "local" } = {}) {
  const services = createCapabilityServices();
  const allowlist = createGuardSessionAllowlist();
  const reviews: ReviewedCase[] = [];
  const effectReviews: string[] = [];
  let prompts = 0;
  services.provide(
    OPERATOR_AUTHORITY_PORT,
    createOperatorAuthorityRuntime({
      owner: "owner",
      executionId: "run",
      seed: {
        binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
        evidence: [
          { id: "operator", source: "start", text: "Ship the change", execution_id: "run" },
        ],
      },
    }).reader,
  );
  services.provide(
    JUDGE_PORT,
    judgePort(
      async (input) => {
        reviews.push(input.currentCase as unknown as ReviewedCase);
        return {
          kind: "reviewed",
          receipt: { action: "decide_command", decision: "allow" },
          elapsedMs: 0,
          attempts: 1,
          cacheHit: false,
        };
      },
      async (input) => {
        effectReviews.push(input.consumer ?? "unknown");
        return {
          kind: "reviewed",
          receipt: {
            action: "decide_effects",
            decision: "allow",
            relation: "direct",
            grant_ids: [],
            revision: 0,
            transition_token: "unexpected",
          },
          elapsedMs: 0,
          attempts: 1,
          cacheHit: false,
        };
      },
    ),
  );
  const resolver = createGuardResolver({
    loadSettings: () => ({
      guard: options.guard,
      ...(options.rollout === undefined ? {} : { effect_review: { rollout: options.rollout } }),
      providers: [{ name: "anthropic", kind: "anthropic" }],
      defaultModel: "anthropic/test",
    }),
    sessionAllowlistFor: () => allowlist,
  });
  const ctx = {
    services,
    owner: "owner",
    executionId: "run",
    workspaceRoot: workspace,
    env: {},
    requestParam: () => undefined,
    request: { guard_mode: "auto" },
    elicit: async () => {
      prompts++;
      return { action: "accept", content: { decision: "allow" } };
    },
    llm: {
      async call() {
        throw new Error("the resolver must use the semantic port, never a direct provider");
      },
    },
  } as unknown as RunCapabilityContext;
  return {
    resolve: async () => (await resolver(ctx))!,
    reviews,
    effectReviews,
    allowlist,
    prompts: () => prompts,
  };
}

async function elicit(
  runtime: Awaited<ReturnType<ReturnType<typeof harness>["resolve"]>>,
  call: GuardContext,
) {
  const decision = await runtime.guard!(call);
  const answer = await runtime.elicit!({
    tool: "shell",
    args: call.args,
    shell: call.shell,
    ...decision,
  });
  return { decision, answer };
}

describe("single command-review path", () => {
  test.each([
    "git push origin main",
    "git status && git log --oneline -3 && git push origin main",
    "gh pr create --title release --body text",
    "git commit -m routine && gh pr edit 7 --title release",
  ])("sends the complete call to the Judge without an effect review: %s", async (command) => {
    const h = harness();
    const runtime = await h.resolve();
    const call = context(command);
    const { decision, answer } = await elicit(runtime, call);
    expect(decision.verdict).toBe("ask");
    expect(decision).not.toHaveProperty("effect");
    expect(decision).not.toHaveProperty("effects");
    expect(decision).not.toHaveProperty("analysis");
    expect(answer).toMatchObject({ allowed: true, answerer: "judge" });
    expect(h.reviews).toHaveLength(1);
    expect(h.reviews[0]?.call).toMatchObject({ tool: "shell", args: { command } });
    expect(h.effectReviews).toEqual([]);
    expect(h.prompts()).toBe(0);
  });

  test.each([
    "git push origin main",
    "git push --force origin main",
    "git commit -m routine",
    "git merge main",
    "git reset --hard",
    "gh pr create --title release --body text",
    "gh pr merge 7 --admin",
    "gh release create v1",
    "gh run rerun 42 --failed",
  ])("decides by policy or Judge, never by operation name: %s", async (command) => {
    const h = harness();
    const runtime = await h.resolve();
    const call = context(command);
    const { decision, answer } = await elicit(runtime, call);
    expect(decision.verdict).toBe("ask");
    expect(decision.reason ?? "").not.toContain("does not admit this effect");
    expect(decision.reason ?? "").not.toContain("was not consulted");
    expect(answer).toMatchObject({ allowed: true, answerer: "judge" });
    expect(h.reviews).toHaveLength(1);
    expect(h.effectReviews).toEqual([]);
  });

  test("reviews an unsandbox ask on its own and never inherits session consent", async () => {
    const h = harness();
    const runtime = await h.resolve();
    const ordinary = context("npm install");
    const first = await elicit(runtime, ordinary);
    expect(first.answer).toMatchObject({ allowed: true, answerer: "judge" });
    h.allowlist.record(ordinary.shell!);
    const escalated = context("npm install", true);
    const host = await runtime.guard!(escalated);
    expect(host).toMatchObject({ verdict: "ask", matched: "host_command", placement: "host" });
    expect(host).not.toHaveProperty("escalate");
    const second = await elicit(runtime, escalated);
    expect(second.answer).toMatchObject({ allowed: true, answerer: "judge" });
    expect(h.reviews).toHaveLength(2);
    expect(h.reviews[1]?.call.placement).toBe("host");
    expect(h.prompts()).toBe(0);
  });

  test("keeps a fully allow-listed command out of review", async () => {
    const h = harness({ guard: { type: "shell", allowed_commands: ["npm install"] } });
    const runtime = await h.resolve();
    const call = context("npm install");
    expect(await runtime.guard!(call)).toMatchObject({ verdict: "allow", matched: "allow_list" });
    expect(h.reviews).toEqual([]);
  });

  test("keeps a denied segment above an allow-listed composite without consulting the Judge", async () => {
    const h = harness({
      guard: { type: "shell", allowed_commands: ["git push"], denied_commands: ["git push"] },
    });
    const runtime = await h.resolve();
    expect(await runtime.guard!(context("git status && git push origin main"))).toMatchObject({
      verdict: "deny",
      matched: "deny_list",
    });
    expect(h.reviews).toEqual([]);
    expect(h.prompts()).toBe(0);
  });

  test("keeps a conservative denial for an opaque command with a non-empty deny list", async () => {
    const h = harness({ guard: { type: "shell", denied_commands: ["git push"] } });
    const runtime = await h.resolve();
    expect(await runtime.guard!(context('git commit -m "$MSG"'))).toMatchObject({
      verdict: "deny",
      matched: "undecidable",
    });
    expect(h.reviews).toEqual([]);
    expect(h.prompts()).toBe(0);
  });

  test.each(["shadow", "local"] as const)(
    "keeps command routing independent of the configuration rollout stage: %s",
    async (rollout) => {
      const h = harness({ rollout });
      const runtime = await h.resolve();
      const { answer } = await elicit(runtime, context("npm install"));
      expect(answer).toMatchObject({ allowed: true, answerer: "judge" });
      expect(h.reviews).toHaveLength(1);
      expect(h.effectReviews).toEqual([]);
    },
  );

  test("resolves Container placement and its network policy without a reviewer", async () => {
    const decisionFor = async (
      runtime: GuardSettings["runtime"],
    ): Promise<{ verdict: string; placement?: string; network?: string }> => {
      const services = createCapabilityServices();
      const resolver = createGuardResolver({ loadSettings: () => ({ runtime }) });
      const resolution = (await resolver({
        services,
        owner: "owner",
        executionId: "run",
        workspaceRoot: workspace,
        env: {},
        requestParam: () => undefined,
        request: { guard_mode: "auto" },
        llm: { call: async () => ({}) },
      } as unknown as RunCapabilityContext))!;
      return resolution.guard!(context("npm install"));
    };
    expect(await decisionFor({ backend: "podman", network: "none" })).toMatchObject({
      verdict: "ask",
      placement: "contained",
      network: "none",
    });
    expect(await decisionFor({ backend: "docker", network: "internet" })).toMatchObject({
      verdict: "ask",
      placement: "contained",
    });
  });

  test("resolves no guard and no review for mode off", () => {
    const services = createCapabilityServices();
    const resolver = createGuardResolver({
      loadSettings: () => ({ guard: { type: "shell", mode: "off" } }),
    });
    const resolution = resolver({
      services,
      owner: "owner",
      executionId: "run",
      workspaceRoot: workspace,
      env: {},
      requestParam: () => undefined,
      request: {},
      llm: { call: async () => ({}) },
    } as unknown as RunCapabilityContext);
    expect(resolution).toBeUndefined();
  });
});
