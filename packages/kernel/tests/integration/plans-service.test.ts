import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "bun:test";
import {
  PlanProviderUnavailableError,
  createFilePlanRepository,
  createPlanStore,
  type PlanStore,
} from "@clarvis/plan";
import { createPlansService } from "../../src/plans/plans-service.ts";
import { KernelException } from "../../src/core/errors.ts";

function makeStore(): PlanStore {
  const ws = mkdtempSync(join(tmpdir(), "clarvis-plans-svc-"));
  return createPlanStore({
    repository: createFilePlanRepository({
      workspaceRoot: ws,
      root: join(ws, ".clarvis", "plans"),
    }),
  });
}

function serviceFor(store: PlanStore) {
  return createPlansService({
    resolve: async () => ({ key: "markdown", providerKind: "markdown", store }),
  });
}

describe("createPlansService", () => {
  describe("without a store", () => {
    const service = createPlansService();

    it("rejects list with capability_disabled", async () => {
      await expect(service.list()).rejects.toMatchObject({
        code: "capability_disabled",
      });
    });

    it("rejects read with capability_disabled", async () => {
      await expect(service.read("p1")).rejects.toBeInstanceOf(KernelException);
      await expect(service.read("p1")).rejects.toMatchObject({ code: "capability_disabled" });
    });

    it("rejects setRetention with capability_disabled", async () => {
      await expect(service.setRetention("p1", "keep")).rejects.toMatchObject({
        code: "capability_disabled",
      });
    });

    it("rejects delete with capability_disabled", async () => {
      await expect(service.delete("p1")).rejects.toMatchObject({
        code: "capability_disabled",
      });
    });
  });

  describe("with a store", () => {
    it("read projects a plan onto its wire DTO, including markdown", async () => {
      const store = makeStore();
      const service = serviceFor(store);
      const created = await store.create({
        title: "My plan",
        objective: "do the thing",
        tasks: [{ title: "one" }],
        createdByRun: "run-1",
      });

      const found = await service.read(created.id);
      expect(found.id).toBe(created.id);
      expect(found.title).toBe("My plan");
      expect(found.status).toBe("active");
      expect(found.path).toBeDefined();
      expect(found.markdown).toContain("My plan");
      expect(found.markdown).toContain("do the thing");
      expect(found.approved_spec_revision).toBeUndefined();
    });

    it("read includes approved_spec_revision when set", async () => {
      const store = makeStore();
      const service = serviceFor(store);
      const created = await store.create({
        title: "Reviewed plan",
        objective: "obj",
        tasks: [{ title: "one" }],
        createdByRun: "run-1",
        review: true,
      });
      const approved = await store.update(created.id, created, (doc) => {
        doc.approved_spec_revision = doc.spec_revision;
      });

      const found = await service.read(approved.id);
      expect(found.approved_spec_revision).toBe(approved.spec_revision);
    });

    it("read throws when the plan does not exist", async () => {
      const service = serviceFor(makeStore());
      await expect(service.read("does-not-exist")).rejects.toThrow(/Plan not found/);
    });

    it("list returns dtos and paginates via next_cursor", async () => {
      const store = makeStore();
      const service = serviceFor(store);
      for (let i = 0; i < 3; i++) {
        await store.create({
          title: `Plan ${i}`,
          objective: "obj",
          tasks: [{ title: "one" }],
          createdByRun: "run-1",
        });
      }

      const page1 = await service.list({ limit: 2 });
      expect(page1.plans).toHaveLength(2);
      expect(page1.next_cursor).toBeDefined();

      const page2 = await service.list({ limit: 2, cursor: page1.next_cursor });
      expect(page2.plans.length).toBeGreaterThan(0);
      expect(page2.next_cursor).toBeUndefined();
    });

    it("list reports a foreign cursor as invalid_request, not as an internal defect", async () => {
      const service = serviceFor(makeStore());

      await expect(service.list({ cursor: "pm1:some-other-backends-id" })).rejects.toMatchObject({
        code: "invalid_request",
      });
    });

    it("setRetention updates the plan and bumps its revision", async () => {
      const store = makeStore();
      const service = serviceFor(store);
      const created = await store.create({
        title: "Plan",
        objective: "obj",
        tasks: [{ title: "one" }],
        createdByRun: "run-1",
        retention: "keep",
      });

      const updated = await service.setRetention(created.id, "discard");
      expect(updated.retention).toBe("discard");
      expect(updated.revision).toBe(created.revision + 1);
    });

    it("delete removes a terminal plan", async () => {
      const store = makeStore();
      const service = serviceFor(store);
      const created = await store.create({
        title: "Plan",
        objective: "obj",
        tasks: [{ title: "one" }],
        createdByRun: "run-1",
      });
      await store.update(created.id, created, (doc) => {
        doc.status = "completed";
      });

      const result = await service.delete(created.id);
      expect(result).toEqual({ id: created.id, deleted: true });
      await expect(service.read(created.id)).rejects.toThrow(/Plan not found/);
    });

    it("delete refuses a still-live plan", async () => {
      const store = makeStore();
      const service = serviceFor(store);
      const created = await store.create({
        title: "Plan",
        objective: "obj",
        tasks: [{ title: "one" }],
        createdByRun: "run-1",
      });

      await expect(service.delete(created.id)).rejects.toThrow(/only terminal plans/);
    });

    it("delete on an already-gone plan reports deleted: false", async () => {
      const service = serviceFor(makeStore());
      const result = await service.delete("never-existed");
      expect(result).toEqual({ id: "never-existed", deleted: false });
    });
  });

  describe("dynamic resolution", () => {
    it("resolves exactly once for each service operation", async () => {
      const store = makeStore();
      const created = await store.create({
        title: "Resolution",
        objective: "count it",
        tasks: [{ title: "one" }],
        createdByRun: "run-1",
      });
      await store.update(created.id, created, (plan) => {
        plan.status = "completed";
      });
      let resolutions = 0;
      const service = createPlansService({
        resolve: async () => {
          resolutions += 1;
          return { key: "markdown", providerKind: "markdown", store };
        },
      });

      await service.list();
      expect(resolutions).toBe(1);
      await service.read(created.id);
      expect(resolutions).toBe(2);
      await service.setRetention(created.id, "discard");
      expect(resolutions).toBe(3);
      await service.delete(created.id);
      expect(resolutions).toBe(4);
    });

    it("maps provider resolution failures to unavailable with sanitized details", async () => {
      const service = createPlansService({
        resolve: async () => {
          throw new PlanProviderUnavailableError("token='secret-value'", {
            plugin: "fixture",
            nested: { authorization: "Bearer secret-value" },
          });
        },
      });
      try {
        await service.list();
        throw new Error("expected unavailable");
      } catch (error) {
        expect(error).toMatchObject({
          code: "unavailable",
          details: {
            plugin: "fixture",
            nested: { authorization: "Bearer [redacted]" },
          },
        });
        expect((error as Error).message).not.toContain("secret-value");
      }
    });

    it("maps ordinary resolution failures and non-Error throws to unavailable", async () => {
      for (const failure of [new Error("transport failed"), "provider vanished"]) {
        const service = createPlansService({
          resolve: async () => {
            throw failure;
          },
        });
        await expect(service.list()).rejects.toMatchObject({
          code: "unavailable",
          message: failure instanceof Error ? failure.message : failure,
        });
      }
    });
  });
});
