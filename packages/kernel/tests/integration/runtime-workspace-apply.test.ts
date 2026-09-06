import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOME_ENV, workspaceStatePaths } from "@clarvis/paths";

import {
  applyRuntimeWorkspaceReview,
  prepareRuntimeWorkspace,
  recoverRuntimeWorkspaceApply,
  reviewRuntimeWorkspace,
  setRuntimeState,
  settleRuntimeWorkspace,
} from "../../src/index.ts";

const rootsToRemove: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-apply-"));
  rootsToRemove.push(root);
  return root;
}

afterEach(async () => {
  for (const root of rootsToRemove.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const source = await temporaryRoot();
  const home = await temporaryRoot();
  const roots = { env: { [HOME_ENV]: join(home, "state-home") } };
  await writeFile(join(source, "modify"), "before");
  await writeFile(join(source, "delete"), "delete me");
  const prepared = await prepareRuntimeWorkspace({
    runtimeId: "runtime-1",
    ownerId: "owner",
    project: { id: "project" },
    workspace: { id: "workspace", projectId: "project", label: "ws", kind: "primary" },
    sourceWorkspaceRoot: source,
    roots,
  });
  await setRuntimeState(source, "runtime-1", "active", roots);
  return { source, roots, retained: prepared.record.retainedWorkspaceRoot };
}

describe("runtime workspace review and apply", () => {
  test("returns no review for an unchanged run", async () => {
    const { source, roots } = await fixture();
    expect(await reviewRuntimeWorkspace(source, "runtime-1", roots)).toBeNull();
  });

  test("applies the exact all-file review and advances both baselines", async () => {
    const { source, roots, retained } = await fixture();
    await writeFile(join(retained, "modify"), "after");
    await chmod(join(retained, "modify"), 0o755);
    await rm(join(retained, "delete"));
    await writeFile(join(retained, "added"), "new");
    await symlink("added", join(retained, "linked"));
    const review = await reviewRuntimeWorkspace(source, "runtime-1", roots);
    expect(review).not.toBeNull();

    const record = await applyRuntimeWorkspaceReview(source, "runtime-1", review!, roots);

    expect(await readFile(join(source, "modify"), "utf8")).toBe("after");
    expect((await lstat(join(source, "modify"))).mode & 0o777).toBe(0o755);
    expect(
      await lstat(join(source, "delete")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await readFile(join(source, "added"), "utf8")).toBe("new");
    expect((await lstat(join(source, "linked"))).isSymbolicLink()).toBe(true);
    expect(record.baselineDigest).toBe(review!.current.digest);
    expect(await reviewRuntimeWorkspace(source, "runtime-1", roots)).toBeNull();
  });

  test("preserves a concurrent host edit and retains the guest copy", async () => {
    const { source, roots, retained } = await fixture();
    await writeFile(join(retained, "modify"), "guest");
    const review = await reviewRuntimeWorkspace(source, "runtime-1", roots);
    await writeFile(join(source, "modify"), "host");

    await expect(
      applyRuntimeWorkspaceReview(source, "runtime-1", review!, roots),
    ).rejects.toMatchObject({
      code: "host_conflict",
    });
    expect(await readFile(join(source, "modify"), "utf8")).toBe("host");
    expect(await readFile(join(retained, "modify"), "utf8")).toBe("guest");
  });

  test("refuses stale review when guest bytes change after inspection", async () => {
    const { source, roots, retained } = await fixture();
    await writeFile(join(retained, "modify"), "reviewed");
    const review = await reviewRuntimeWorkspace(source, "runtime-1", roots);
    await writeFile(join(retained, "modify"), "after review");

    await expect(
      applyRuntimeWorkspaceReview(source, "runtime-1", review!, roots),
    ).rejects.toMatchObject({
      code: "stale_review",
    });
    expect(await readFile(join(source, "modify"), "utf8")).toBe("before");
  });

  test("rolls every earlier path back when a later operation fails", async () => {
    const { source, roots, retained } = await fixture();
    await writeFile(join(retained, "modify"), "guest modification");
    await writeFile(join(retained, "added"), "guest addition");
    const review = await reviewRuntimeWorkspace(source, "runtime-1", roots);
    let operations = 0;

    await expect(
      applyRuntimeWorkspaceReview(source, "runtime-1", review!, roots, undefined, {
        beforeOperation() {
          operations += 1;
          if (operations === 2) throw new Error("injected apply interruption");
        },
      }),
    ).rejects.toMatchObject({ code: "apply_failed" });

    expect(await readFile(join(source, "modify"), "utf8")).toBe("before");
    expect(
      await lstat(join(source, "added")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await readFile(join(retained, "modify"), "utf8")).toBe("guest modification");
  });

  test("recovers a mutation whose durable journal was interrupted mid-operation", async () => {
    const { source, roots, retained } = await fixture();
    await writeFile(join(retained, "modify"), "guest modification");
    const review = await reviewRuntimeWorkspace(source, "runtime-1", roots);
    const paths = workspaceStatePaths(source, roots);
    const transaction = paths.runtimeTransactionDir("runtime-1", review!.changeSet.id);
    await mkdir(join(transaction, "backup"), { recursive: true });
    await writeFile(join(transaction, "backup", "modify"), "before");
    await writeFile(join(source, "modify"), "partially applied");
    await writeFile(
      paths.runtimeJournalFile("runtime-1"),
      JSON.stringify({
        version: 1,
        runtimeId: "runtime-1",
        changeSetId: review!.changeSet.id,
        phase: "applying",
        baselineDigest: review!.changeSet.baselineDigest,
        currentDigest: review!.changeSet.currentDigest,
        operations: [{ path: "modify", action: "write", hadBaseline: true }],
        applied: [],
        currentOperation: "modify",
      }),
    );

    expect(await recoverRuntimeWorkspaceApply(source, "runtime-1", roots)).toBe(true);
    expect(await readFile(join(source, "modify"), "utf8")).toBe("before");
    expect(await recoverRuntimeWorkspaceApply(source, "runtime-1", roots)).toBe(false);
  });

  test("finishes an interrupted settlement instead of rolling applied bytes back", async () => {
    const { source, roots, retained } = await fixture();
    await writeFile(join(retained, "modify"), "accepted");
    const review = await reviewRuntimeWorkspace(source, "runtime-1", roots);
    await writeFile(join(source, "modify"), "accepted");
    const paths = workspaceStatePaths(source, roots);
    await mkdir(paths.runtimeTransactionDir("runtime-1", review!.changeSet.id), {
      recursive: true,
    });
    await writeFile(
      paths.runtimeJournalFile("runtime-1"),
      JSON.stringify({
        version: 1,
        runtimeId: "runtime-1",
        changeSetId: review!.changeSet.id,
        phase: "settling",
        baselineDigest: review!.changeSet.baselineDigest,
        currentDigest: review!.changeSet.currentDigest,
        operations: [{ path: "modify", action: "write", hadBaseline: true }],
        applied: ["modify"],
      }),
    );

    expect(await recoverRuntimeWorkspaceApply(source, "runtime-1", roots)).toBe(true);
    expect(await readFile(join(source, "modify"), "utf8")).toBe("accepted");
    expect(await reviewRuntimeWorkspace(source, "runtime-1", roots)).toBeNull();
  });

  test("raises one typed all-change request and applies only its host acceptance", async () => {
    const { source, roots, retained } = await fixture();
    await writeFile(join(retained, "modify"), "accepted through elicitation");
    await writeFile(join(retained, "added"), "new");
    const requests: unknown[] = [];

    const result = await settleRuntimeWorkspace(
      source,
      "runtime-1",
      async (request) => {
        requests.push(request);
        return { action: "accept" };
      },
      { roots },
    );

    expect(result).toMatchObject({ action: "accepted" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: "workspace_merge",
      detail: {
        baseline_revision: expect.stringMatching(/^sha256:/),
        content_digest: expect.stringMatching(/^sha256:/),
        changes: [
          expect.objectContaining({ path: "added", action: "add" }),
          expect.objectContaining({ path: "modify", action: "modify" }),
        ],
      },
    });
    expect(await readFile(join(source, "modify"), "utf8")).toBe("accepted through elicitation");
  });

  test.each(["decline", "cancel"] as const)(
    "%s retains the complete guest change set without writing the host",
    async (action) => {
      const { source, roots, retained } = await fixture();
      await writeFile(join(retained, "modify"), "pending guest bytes");
      const result = await settleRuntimeWorkspace(source, "runtime-1", async () => ({ action }), {
        roots,
      });

      expect(result.action).toBe(action === "cancel" ? "cancelled" : "declined");
      expect(await readFile(join(source, "modify"), "utf8")).toBe("before");
      expect(await readFile(join(retained, "modify"), "utf8")).toBe("pending guest bytes");
    },
  );
});
