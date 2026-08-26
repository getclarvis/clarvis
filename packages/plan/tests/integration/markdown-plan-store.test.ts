import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  PlanConflictError,
  createFilePlanRepository,
  createPlanStore,
  type PlanStore,
} from "@clarvis/plan";

import { createTempWorkspace, type TempWorkspace } from "../helpers/temp.ts";

const workspaces: TempWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.cleanup()));
});

async function fixture(): Promise<{ dir: string; store: PlanStore }> {
  const workspace = await createTempWorkspace("clarvis-plan-");
  workspaces.push(workspace);
  return {
    dir: workspace.dir,
    store: createPlanStore({
      repository: createFilePlanRepository({ workspaceRoot: workspace.dir }),
    }),
  };
}

describe("plan store — Markdown effects", () => {
  test("independent stores contending on the on-disk lock all succeed", async () => {
    const { dir } = await fixture();
    const input = {
      title: "Same",
      objective: "Test",
      tasks: [{ title: "One" }],
      createdByRun: "run-1",
      now: new Date("2026-07-25T12:34:56Z"),
    };

    const stores = Array.from({ length: 24 }, () =>
      createPlanStore({ repository: createFilePlanRepository({ workspaceRoot: dir }) }),
    );
    const created = await Promise.all(stores.map((store) => store.create(input)));

    expect(new Set(created.map((plan) => plan.id)).size).toBe(stores.length);
    expect(new Set(created.map((plan) => plan.path)).size).toBe(stores.length);
    expect((await stores[0]!.list({ limit: 100 })).plans).toHaveLength(stores.length);
  });

  test("enforces CAS and reconciles valid external edits", async () => {
    const { dir, store } = await fixture();
    const created = await store.create({
      title: "CAS",
      objective: "Test",
      tasks: [{ title: "One" }],
      createdByRun: "run-1",
    });
    const updated = await store.update(created.id, created, (plan) => {
      plan.notes = "progress";
    });
    await expect(store.update(created.id, created, () => {})).rejects.toBeInstanceOf(
      PlanConflictError,
    );
    const absolutePath = join(dir, updated.path!);
    const source = await readFile(absolutePath, "utf8");
    await writeFile(absolutePath, source.replace("## Context\n\n", "## Context\n\nExternal edit"));
    const reconciled = await store.reconcile(updated.id, updated);
    expect(reconciled.revision).toBe(updated.revision + 1);
    expect(reconciled.spec_revision).toBe(updated.spec_revision + 1);
    expect(reconciled.context).toBe("External edit");
  });
});
