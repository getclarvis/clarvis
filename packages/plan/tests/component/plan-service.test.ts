import { describe, expect, spyOn, test } from "bun:test";
import {
  InvalidPlanError,
  PlanConflictError,
  PlanNotFoundError,
  PlanNotTerminalError,
  PlanService,
  createPlanStore,
  type PlanStore,
} from "../../src/index.ts";
import { createEditablePlanRepository, type EditablePlanRepository } from "../helpers/store.ts";

function fixture(): {
  repository: EditablePlanRepository;
  store: PlanStore;
} {
  const repository = createEditablePlanRepository();
  return {
    repository,
    store: createPlanStore({ repository }),
  };
}

describe("plan control-plane service", () => {
  test("retention never deletes and delete accepts only terminal plans", async () => {
    const { store } = fixture();
    const service = new PlanService(store);
    const created = await store.create({
      title: "Managed",
      objective: "Test",
      tasks: [{ title: "One" }],
      createdByRun: "run-1",
    });
    expect((await service.list()).plans).toHaveLength(1);

    const discard = await service.setRetention(created.id, "discard");
    expect((await service.read(created.id)).retention).toBe("discard");
    await expect(service.delete(created.id)).rejects.toBeInstanceOf(PlanNotTerminalError);

    const terminal = await store.update(discard.id, discard, (plan) => {
      plan.status = "cancelled";
    });
    expect(await service.delete(terminal.id)).toEqual({ id: terminal.id, deleted: true });
    await expect(store.read(terminal.id)).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  test("delete removes a corrupt/unparseable plan so a broken plan is recoverable", async () => {
    const { repository, store } = fixture();
    const service = new PlanService(store);
    const created = await store.create({
      title: "Will break",
      objective: "o",
      tasks: [{ title: "One" }],
      createdByRun: "run-1",
    });
    const source = repository.source(created.id)!;
    const frontmatter = source.slice(0, source.indexOf("\n---\n") + 5);
    repository.poke(created.id, `${frontmatter}\nthe body is mangled\n`);

    await expect(store.read(created.id)).rejects.toBeInstanceOf(InvalidPlanError);
    expect(await service.delete(created.id)).toEqual({ id: created.id, deleted: true });
    await expect(store.read(created.id)).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  test("delete passes the status-bearing read as its CAS baseline", async () => {
    const { store } = fixture();
    const created = await store.create({
      title: "Race",
      objective: "o",
      tasks: [{ title: "One" }],
      createdByRun: "run-1",
    });
    const terminal = await store.update(created.id, created, (plan) => {
      plan.status = "cancelled";
    });
    const remove = store.delete.bind(store);
    const deleteSpy = spyOn(store, "delete").mockImplementation(async (id, expected) => {
      expect(expected).toEqual(terminal);
      await store.update(id, terminal, (plan) => {
        plan.retention = "discard";
      });
      return remove(id, expected);
    });
    try {
      await expect(new PlanService(store).delete(created.id)).rejects.toBeInstanceOf(
        PlanConflictError,
      );
      expect((await store.read(created.id)).retention).toBe("discard");
    } finally {
      deleteSpy.mockRestore();
    }
  });
});
