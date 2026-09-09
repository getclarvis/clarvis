import { expect } from "bun:test";
import type { HostedRunAttachment, RunResult, StartHostedTurnParams } from "@clarvis/protocol";
import {
  createHostedRegistry,
  type HostedRegistryOptions,
  type HostedRegistryState,
} from "../../src/hosting/registry.ts";
import { createHostedProjection, type ProjectionStorage } from "../../src/hosting/projection.ts";
import { createManagedRun, type ManagedRunContext } from "../../src/runs/managed-run.ts";

export function input(executionId = "run-1", sessionId = "session-1"): StartHostedTurnParams {
  return {
    session_id: sessionId,
    session_revision: 0,
    kind: "conversation",
    user_preview: "A hosted turn",
    params: { execution_id: executionId, messages: [{ role: "user", content: "A hosted turn" }] },
  };
}

export async function until(condition: () => boolean): Promise<void> {
  for (let step = 0; step < 300 && !condition(); step++) await Promise.resolve();
  expect(condition()).toBe(true);
}

export function fixture(
  overrides: {
    prepare?: () => Promise<void>;
    commit?: HostedRegistryOptions["commit"];
    commitIntent?: () => Promise<void>;
    reconcile?: () => Promise<void>;
    detachable?: boolean;
    maxRetainedRuns?: number;
    now?: () => number;
  } = {},
) {
  const contexts = new Map<string, ManagedRunContext>();
  const endings = new Map<string, (value: RunResult) => void>();
  const scopes: string[] = [];
  const retired: string[] = [];
  const commits: HostedRegistryState[] = [];
  const results: RunResult[] = [];
  const removed: string[] = [];
  let starts = 0;
  const registry = createHostedRegistry({
    workspaceId: "workspace",
    hostGeneration: "host-generation",
    owner: "owner",
    now: overrides.now,
    receiptLifetimeMs: 100,
    maxRetainedRuns: overrides.maxRetainedRuns,
    async prepare(value, authority) {
      scopes.push(authority.scope);
      await overrides.prepare?.();
      authority.signal.throwIfAborted();
      return {
        title: "Prepared title",
        config: { agent: "admiral", model: "test/model" },
        detachable: overrides.detachable ?? true,
        async commitIntent() {
          await overrides.commitIntent?.();
        },
        async start() {
          starts++;
          return createManagedRun({
            executionId: value.params.execution_id,
            execute(context) {
              contexts.set(context.executionId, context);
              return new Promise<RunResult>((resolve) => {
                endings.set(context.executionId, resolve);
                context.signal.addEventListener(
                  "abort",
                  () => resolve({ execution_id: context.executionId, status: "cancelled" }),
                  { once: true },
                );
              });
            },
          });
        },
        async reconcile(result) {
          await overrides.reconcile?.();
          results.push(result);
        },
      };
    },
    async projection(executionId) {
      let data = Buffer.alloc(0);
      const storage: ProjectionStorage = {
        async write(bytes, offset) {
          data = Buffer.concat([data.subarray(0, offset), bytes]);
        },
        async read(offset, count) {
          return data.subarray(offset, offset + count);
        },
        async sync() {},
        async close() {},
      };
      return createHostedProjection(storage, {
        execution_id: executionId,
        host_generation: "host-generation",
      });
    },
    async commit(state) {
      await overrides.commit?.(state);
      commits.push(state);
    },
    async removeProjection(id) {
      removed.push(id);
    },
    retireConfigurationSession: (scope) => retired.push(scope),
  });
  const handoff = (view: HostedRunAttachment, operationId = "detach-1") => ({
    execution_id: view.run.execution_id,
    host_generation: view.run.host_generation,
    control_epoch: view.run.control_epoch,
    revision: view.run.revision,
    operation_id: operationId,
  });
  return {
    registry,
    contexts,
    endings,
    scopes,
    retired,
    commits,
    results,
    removed,
    handoff,
    starts: () => starts,
    finish(id = "run-1") {
      endings.get(id)!({ execution_id: id, status: "completed", result: "done" });
    },
  };
}
