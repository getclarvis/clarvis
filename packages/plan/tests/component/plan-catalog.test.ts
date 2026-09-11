import { expect, it } from "bun:test";
import { createCapabilityServices, createComputeClock } from "@clarvis/capability";
import {
  createPlansCapability,
  createPlansCatalogCapability,
  PLAN_PORT,
} from "../../src/capability/index.ts";
import { createPlanStore } from "../../src/store.ts";
import { createInMemoryPlanRepository } from "../../src/testing.ts";
import { fakeAgentBuildContext, fakeRunCapabilityContext } from "../helpers/context.ts";

it.each(["off", "on", "review"] as const)(
  "preserves the %s planning catalog and delegation schema without owning plan state",
  async (mode) => {
    const ordinary = createPlansCapability({
      factory: {
        storeFor: async () => ({
          key: "markdown",
          providerKind: "markdown",
          store: createPlanStore({ repository: createInMemoryPlanRepository() }),
        }),
      },
      defaultPendingTaskNudges: 3,
      defaultElicitWaitMs: 30000,
    });
    const projection = createPlansCatalogCapability();
    const view = () => fakeRunCapabilityContext({ requestParam: () => ({ mode }) });
    expect(projection.reservedWireNames).toEqual(ordinary.reservedWireNames);
    expect(projection.toolEffects).toEqual(ordinary.toolEffects);
    expect(projection.requiresUserInput?.(view())).toBe(ordinary.requiresUserInput?.(view()));
    const sourceCtx = view();
    const passCtx = view();
    const source = await ordinary.forRun(sourceCtx);
    const pass = await projection.forRun(passCtx);
    if (mode === "off") {
      expect(source).toBeNull();
      expect(pass).toBeNull();
      expect(passCtx.services.get(PLAN_PORT)).toBeUndefined();
      return;
    }
    const scope = {
      agent: "lead" as const,
      entry: true,
      grants: [],
      clock: createComputeClock(60000),
      elicit: async () => ({ action: "decline" as const }),
    };
    const sourceBuild = fakeAgentBuildContext();
    const passBuild = fakeAgentBuildContext();
    const sourceContribution = source!.forAgent(scope)!.attach(sourceBuild);
    const passContribution = pass!.forAgent(scope)!.attach(passBuild);
    expect(passContribution.tools).toEqual(sourceContribution.tools);
    const passPort = passCtx.services.get(PLAN_PORT)!.forAgent(passBuild)!;
    expect(passPort.augmentDelegateTask()).toEqual(
      sourceCtx.services.get(PLAN_PORT)!.forAgent(sourceBuild)!.augmentDelegateTask(),
    );
    expect(pass!.forAgent({ ...scope, entry: false })).toBeNull();
    expect(passCtx.services.get(PLAN_PORT)!.forAgent(fakeAgentBuildContext())).toBeUndefined();
    expect(pass!.lifecycle).toBeUndefined();
    expect(pass).not.toHaveProperty("finalizeRun");
    expect(pass).not.toHaveProperty("onRunEnd");
    expect(passContribution.gates).toBeUndefined();
    expect(passContribution.hooks).toBeUndefined();
    expect(passContribution.anchor).toBeUndefined();
    expect(await passPort.beforeSpawn("t1")).toMatchObject({ kind: "refuse" });
    expect(await passPort.markSpawned("t1")).toBe(false);
    expect(await passPort.markFailed("t1", "error")).toBe(false);
    expect(await passPort.markReturned?.("t1", "summary")).toBe(false);
    passPort.noteSpawned("t1");
    expect(passPort.openTasks()).toEqual([]);
    expect(passPort.getTask("t1")).toBeUndefined();
    for (const tool of passContribution.tools!) {
      const call = { id: `call-${tool.wireName}`, name: tool.wireName, arguments: {} };
      const handler = passContribution.handlers!.find((handler) => handler.matches(call))!;
      expect(await handler.handle(call, 0)).toMatchObject({
        kind: "result",
        progress: false,
        text: expect.stringContaining("not available"),
      });
    }
  },
);

it("does not inspect or reconcile carried state when attaching the catalog projection", async () => {
  const ctx = fakeRunCapabilityContext({
    services: createCapabilityServices(),
    priorState: new Proxy(
      {},
      {
        get: () => {
          throw new Error("Source state accessed");
        },
      },
    ),
  });
  const pass = await createPlansCatalogCapability().forRun(ctx);
  expect(
    pass!.forAgent({ agent: "lead", entry: true, grants: [] })!.attach(fakeAgentBuildContext())
      .tools,
  ).toHaveLength(5);
});
