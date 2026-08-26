import { describe, expect, it, vi } from "bun:test";

import type { Memory, MemoryJobSettlement } from "../../src/index.ts";

import {
  enqueueFinishedRun,
  translateDrainSettlement,
  type MemoryIngestNotice,
} from "../../src/ingest.ts";
import type { Logger } from "@clarvis/capability";
import { makeExecutionRecord } from "../helpers/fixtures.ts";

function nonGitWorkspace(): string {
  return "/workspace";
}

const noWorkspaceState = async (): Promise<undefined> => undefined;

describe("translateDrainSettlement", () => {
  it("retry_wait maps to a bare 'queued' notice", () => {
    const job: MemoryJobSettlement = { run_id: "r1", outcome: "retry_wait" };
    expect(translateDrainSettlement(job)).toEqual({ execution_id: "r1", phase: "queued" });
  });

  it("failed carries the job's note as error when present", () => {
    const job: MemoryJobSettlement = { run_id: "r2", outcome: "failed", note: "model unreachable" };
    expect(translateDrainSettlement(job)).toEqual({
      execution_id: "r2",
      phase: "failed",
      error: "model unreachable",
    });
  });

  it("failed with no note omits the error field entirely", () => {
    const job: MemoryJobSettlement = { run_id: "r3", outcome: "failed" };
    const notice = translateDrainSettlement(job);
    expect(notice).toEqual({ execution_id: "r3", phase: "failed" });
    expect("error" in notice).toBe(false);
  });

  it("blocked carries the job's note as note when present", () => {
    const job: MemoryJobSettlement = {
      run_id: "r4",
      outcome: "blocked",
      note: "no model configured",
    };
    expect(translateDrainSettlement(job)).toEqual({
      execution_id: "r4",
      phase: "blocked",
      note: "no model configured",
    });
  });

  it("blocked with no note omits the note field entirely", () => {
    const job: MemoryJobSettlement = { run_id: "r5", outcome: "blocked" };
    const notice = translateDrainSettlement(job);
    expect(notice).toEqual({ execution_id: "r5", phase: "blocked" });
    expect("note" in notice).toBe(false);
  });

  it("completed with any of written/deleted/reindexed set reports 'done' with defaulted counts", () => {
    const job: MemoryJobSettlement = { run_id: "r6", outcome: "completed", reindexed: true };
    expect(translateDrainSettlement(job)).toEqual({
      execution_id: "r6",
      phase: "done",
      written: 0,
      deleted: 0,
      reindexed: true,
    });
  });

  it("completed with all three counts set reports them verbatim", () => {
    const job: MemoryJobSettlement = {
      run_id: "r7",
      outcome: "completed",
      written: 3,
      deleted: 1,
      reindexed: false,
    };
    expect(translateDrainSettlement(job)).toEqual({
      execution_id: "r7",
      phase: "done",
      written: 3,
      deleted: 1,
      reindexed: false,
    });
  });

  it("completed with none of written/deleted/reindexed set (the already-indexed shortcut) reports skipped", () => {
    const job: MemoryJobSettlement = { run_id: "r8", outcome: "completed" };
    expect(translateDrainSettlement(job)).toEqual({
      execution_id: "r8",
      phase: "done",
      skipped: true,
    });
  });

  it("completed also forwards a note alongside the done/skipped shape", () => {
    const job: MemoryJobSettlement = { run_id: "r9", outcome: "completed", note: "no-snapshot" };
    expect(translateDrainSettlement(job)).toEqual({
      execution_id: "r9",
      phase: "done",
      skipped: true,
      note: "no-snapshot",
    });
  });

  it("an unrecognized outcome falls through the default branch exactly like 'completed'", () => {
    const job = { run_id: "r10", outcome: "mystery" } as unknown as MemoryJobSettlement;
    expect(translateDrainSettlement(job)).toEqual({
      execution_id: "r10",
      phase: "done",
      skipped: true,
    });
  });
});

describe("enqueueFinishedRun", () => {
  function fakeMemory(over: { enqueue?: Memory["enqueue"] } = {}): Memory {
    const enqueue =
      over.enqueue ??
      vi.fn().mockResolvedValue({
        run_id: "exec_1",
        state: "pending",
        enqueued_at: 0,
        updated_at: 0,
        attempts: 0,
        history: [],
      });
    return { enqueue, seed: vi.fn(), index: vi.fn(), tools: [] } as unknown as Memory;
  }

  function makeLogger(): {
    logger: Logger;
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  } {
    const warn = vi.fn();
    const info = vi.fn();
    return { logger: { warn, info, error: vi.fn() } as unknown as Logger, warn, info };
  }

  it("notifies started then queued, and logs memory.run.enqueued, on success", async () => {
    const record = makeExecutionRecord({ id: "exec_ok", owner_key_name: "o" });
    const notices: MemoryIngestNotice[] = [];
    const { logger, info } = makeLogger();
    await enqueueFinishedRun({
      memory: fakeMemory(),
      record,
      workspaceRoot: nonGitWorkspace(),
      captureWorkspaceState: noWorkspaceState,
      logger,
      onNotice: (n) => notices.push(n),
    });
    expect(notices.map((n) => n.phase)).toEqual(["started", "queued"]);
    expect(notices[0]!.execution_id).toBe("exec_ok");
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "memory.run.enqueued",
        execution_id: "exec_ok",
        state: "pending",
      }),
      expect.any(String),
    );
  });

  it("never rejects: an enqueue failure is caught, logged, and reported as a failed notice", async () => {
    const record = makeExecutionRecord({ id: "exec_bad", owner_key_name: "o" });
    const notices: MemoryIngestNotice[] = [];
    const { logger, warn } = makeLogger();
    await expect(
      enqueueFinishedRun({
        memory: fakeMemory({ enqueue: vi.fn().mockRejectedValue(new Error("disk full")) }),
        record,
        workspaceRoot: nonGitWorkspace(),
        captureWorkspaceState: noWorkspaceState,
        logger,
        onNotice: (n) => notices.push(n),
      }),
    ).resolves.toBeUndefined();

    expect(notices.map((n) => n.phase)).toEqual(["started", "failed"]);
    expect(notices[1]).toMatchObject({ execution_id: "exec_bad", error: "disk full" });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "memory.run.enqueue_failed",
        execution_id: "exec_bad",
        cause: "disk full",
      }),
      expect.any(String),
    );
  });

  it("a non-Error throw is stringified for both the log cause and the notice error", async () => {
    const record = makeExecutionRecord({ id: "exec_str", owner_key_name: "o" });
    const notices: MemoryIngestNotice[] = [];
    const { logger, warn } = makeLogger();
    await enqueueFinishedRun({
      memory: fakeMemory({ enqueue: vi.fn().mockRejectedValue("plain string failure") }),
      record,
      workspaceRoot: nonGitWorkspace(),
      captureWorkspaceState: noWorkspaceState,
      logger,
      onNotice: (n) => notices.push(n),
    });

    expect(notices[1]).toMatchObject({ phase: "failed", error: "plain string failure" });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "memory.run.enqueue_failed",
        cause: "plain string failure",
      }),
      expect.any(String),
    );
  });

  it("works with no logger at all, on both the success and failure paths", async () => {
    const okRecord = makeExecutionRecord({ id: "exec_no_logger_ok", owner_key_name: "o" });
    await expect(
      enqueueFinishedRun({
        memory: fakeMemory(),
        record: okRecord,
        workspaceRoot: nonGitWorkspace(),
        captureWorkspaceState: noWorkspaceState,
      }),
    ).resolves.toBeUndefined();

    const badRecord = makeExecutionRecord({ id: "exec_no_logger_bad", owner_key_name: "o" });
    await expect(
      enqueueFinishedRun({
        memory: fakeMemory({ enqueue: vi.fn().mockRejectedValue(new Error("boom")) }),
        record: badRecord,
        workspaceRoot: nonGitWorkspace(),
        captureWorkspaceState: noWorkspaceState,
      }),
    ).resolves.toBeUndefined();
  });

  it("a throwing onNotice listener never breaks the fire-and-forget contract, on the failure path too", async () => {
    const record = makeExecutionRecord({ id: "exec_listener_throws", owner_key_name: "o" });
    await expect(
      enqueueFinishedRun({
        memory: fakeMemory({ enqueue: vi.fn().mockRejectedValue(new Error("queue exploded")) }),
        record,
        workspaceRoot: nonGitWorkspace(),
        captureWorkspaceState: noWorkspaceState,
        onNotice: () => {
          throw new Error("listener bug");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
