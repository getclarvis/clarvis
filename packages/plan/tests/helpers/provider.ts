import {
  CapabilityExecutableRpcError,
  type CapabilityExecutablePort,
  type CapabilityExecutableSessionInput,
} from "@clarvis/capability";

import {
  createPlanFactory,
  createPlanStore,
  type PlanDocument,
  type PlanStore,
} from "../../src/index.ts";
import { createInMemoryPlanRepository } from "../../src/testing.ts";

export function markdownStore(): PlanStore {
  return createPlanStore({ repository: createInMemoryPlanRepository() });
}

function rpcError(code: string, message: string): CapabilityExecutableRpcError {
  return new CapabilityExecutableRpcError(message, -32000, { code });
}

export function executablePort(
  seen: CapabilityExecutableSessionInput[] = [],
): CapabilityExecutablePort {
  const stores = new Map<string, Map<string, PlanDocument>>();
  return {
    async session(input) {
      seen.push(input);
      const documents = stores.get(input.owner ?? "") ?? new Map<string, PlanDocument>();
      stores.set(input.owner ?? "", documents);
      return {
        providerKind: "fixture-executable",
        async request(method, params) {
          const id = typeof params.id === "string" ? params.id : undefined;
          switch (method) {
            case "plans/create": {
              const document = structuredClone(params.document) as PlanDocument;
              documents.set(document.id, document);
              return structuredClone(document);
            }
            case "plans/read": {
              const document = id === undefined ? undefined : documents.get(id);
              if (document === undefined) throw rpcError("plan_not_found", `Plan not found: ${id}`);
              return structuredClone(document);
            }
            case "plans/list": {
              const input = (params.input ?? {}) as {
                status?: string;
                retention?: string;
                cursor?: string;
                limit?: number;
              };
              const filtered = [...documents.values()]
                .filter(
                  (document) => input.status === undefined || document.status === input.status,
                )
                .filter(
                  (document) =>
                    input.retention === undefined || document.retention === input.retention,
                )
                .sort((left, right) => right.created_at.localeCompare(left.created_at));
              const offset = input.cursor === undefined ? 0 : Number(input.cursor);
              const limit = Math.max(1, Math.min(100, input.limit ?? 20));
              const plans = filtered
                .slice(offset, offset + limit)
                .map((document) => structuredClone(document));
              return {
                plans,
                ...(offset + plans.length < filtered.length
                  ? { next_cursor: String(offset + plans.length) }
                  : {}),
              };
            }
            case "plans/write": {
              const current = id === undefined ? undefined : documents.get(id);
              if (current === undefined) throw rpcError("plan_not_found", `Plan not found: ${id}`);
              const expected = params.expected as {
                revision: number;
                digest: string;
                specDigest: string;
              };
              if (
                current.revision !== expected.revision ||
                current.digest !== expected.digest ||
                current.spec_digest !== expected.specDigest
              ) {
                throw rpcError("plan_conflict", "Plan changed since it was read");
              }
              const document = structuredClone(params.document) as PlanDocument;
              documents.set(id!, document);
              return structuredClone(document);
            }
            case "plans/reconcile": {
              const document = id === undefined ? undefined : documents.get(id);
              if (document === undefined) throw rpcError("plan_not_found", `Plan not found: ${id}`);
              return structuredClone(document);
            }
            case "plans/delete":
              return id === undefined ? false : documents.delete(id);
            default:
              throw new Error(`unexpected method ${method}`);
          }
        },
        async close() {},
      };
    },
  };
}

export function executableFactory(port: CapabilityExecutablePort = executablePort()) {
  return createPlanFactory({
    workspaceRoot: "/workspace",
    loadProvider: () => ({
      kind: "executable",
      command: "python3",
      args: ["-B", "server.py", "plans"],
      env: {},
      timeout_ms: 30_000,
    }),
    markdownStoreFor: markdownStore,
    executablePort: port,
  });
}
