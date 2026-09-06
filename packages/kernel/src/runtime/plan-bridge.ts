import { randomUUID } from "node:crypto";

import type { HostCapabilityGrant } from "./authority-brokers.ts";
import type { GuestExecutionBridge } from "./execution-worker.ts";
import {
  InvalidPlanError,
  PlanConflictError,
  PlanNotFoundError,
  PlanProviderUnavailableError,
  PlanSealedError,
  planDocumentSchema,
  planRevisionOperationSchema,
  type CreatePlanInput,
  type PlanCas,
  type PlanDocument,
  type PlanFactory,
  type PlanListInput,
  type PlanListResult,
  type PlanRevisionOperation,
  type PlanStore,
} from "@clarvis/plan";

/** Exact private method used by a guest plan capability to reach its host-owned store. */
export const RUNTIME_PLANS_METHOD = "runtime.plans";
export const RUNTIME_PLANS_REVISION = "v1";

type PlanBridgeOperation =
  "resolve" | "create" | "read" | "list" | "replace" | "reconcile" | "revise" | "delete";

interface PlanBridgeRequest {
  readonly operation: PlanBridgeOperation;
  readonly input?: Record<string, unknown>;
}

type WireCreatePlanInput = Omit<CreatePlanInput, "now"> & { readonly now?: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const admitted = new Set(keys);
  return Object.keys(value).every((key) => admitted.has(key));
}

function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function cas(value: unknown): value is PlanCas {
  const input = record(value);
  return (
    input !== undefined &&
    only(input, ["revision", "digest", "specDigest"]) &&
    Number.isSafeInteger(input.revision) &&
    (input.revision as number) >= 1 &&
    typeof input.digest === "string" &&
    /^[a-f0-9]{64}$/u.test(input.digest) &&
    typeof input.specDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(input.specDigest)
  );
}

function isoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function optionalIsoDate(value: unknown): boolean {
  return value === undefined || isoDate(value);
}

function listInput(value: unknown): value is PlanListInput {
  const input = record(value);
  if (input === undefined || !only(input, ["cursor", "limit", "status", "retention"])) return false;
  return (
    (input.cursor === undefined || string(input.cursor)) &&
    (input.limit === undefined ||
      (Number.isSafeInteger(input.limit) &&
        (input.limit as number) >= 1 &&
        (input.limit as number) <= 100)) &&
    (input.status === undefined ||
      input.status === "awaiting_approval" ||
      input.status === "active" ||
      input.status === "completed" ||
      input.status === "cancelled" ||
      input.status === "failed") &&
    (input.retention === undefined || input.retention === "keep" || input.retention === "discard")
  );
}

function createInput(value: unknown): value is WireCreatePlanInput {
  const input = record(value);
  if (
    input === undefined ||
    !only(input, [
      "title",
      "objective",
      "context",
      "tasks",
      "validation",
      "retention",
      "createdByRun",
      "review",
      "now",
    ])
  ) {
    return false;
  }
  return (
    string(input.title) &&
    typeof input.objective === "string" &&
    (input.context === undefined || typeof input.context === "string") &&
    Array.isArray(input.tasks) &&
    (input.validation === undefined || Array.isArray(input.validation)) &&
    (input.retention === undefined ||
      input.retention === "keep" ||
      input.retention === "discard") &&
    string(input.createdByRun) &&
    (input.review === undefined || typeof input.review === "boolean") &&
    optionalIsoDate(input.now)
  );
}

function validPlanBridgeRequest(value: unknown): value is PlanBridgeRequest {
  const request = record(value);
  if (request === undefined || !only(request, ["operation", "input"])) return false;
  const input = record(request.input);
  switch (request.operation) {
    case "resolve":
      return request.input === undefined;
    case "create":
      return createInput(input?.value);
    case "read":
      return input !== undefined && only(input, ["id"]) && string(input.id);
    case "list":
      return input !== undefined && only(input, ["value"]) && listInput(input.value);
    case "replace":
      return (
        input !== undefined &&
        only(input, ["id", "expected", "document", "structural", "now"]) &&
        string(input.id) &&
        cas(input.expected) &&
        planDocumentSchema.safeParse(input.document).success &&
        (input.structural === undefined || typeof input.structural === "boolean") &&
        optionalIsoDate(input.now)
      );
    case "reconcile":
      return (
        input !== undefined &&
        only(input, ["id", "known", "now"]) &&
        string(input.id) &&
        cas(input.known) &&
        optionalIsoDate(input.now)
      );
    case "revise":
      return (
        input !== undefined &&
        only(input, ["id", "expected", "operation", "now"]) &&
        string(input.id) &&
        cas(input.expected) &&
        (planRevisionOperationSchema.safeParse(input.operation).success ||
          (Array.isArray(input.operation) &&
            input.operation.length > 0 &&
            input.operation.every(
              (operation) => planRevisionOperationSchema.safeParse(operation).success,
            ))) &&
        optionalIsoDate(input.now)
      );
    case "delete":
      return (
        input !== undefined &&
        only(input, ["id", "expected"]) &&
        string(input.id) &&
        (input.expected === undefined || cas(input.expected))
      );
    default:
      return false;
  }
}

function date(value: unknown): Date | undefined {
  return typeof value === "string" ? new Date(value) : undefined;
}

function toCas(value: PlanCas | PlanDocument): PlanCas {
  return {
    revision: value.revision,
    digest: value.digest,
    specDigest: "specDigest" in value ? value.specDigest : value.spec_digest,
  };
}

/** Bind one run's exact owner to the canonical host plan provider. */
export function createHostPlansGrant(factory: PlanFactory, owner: string): HostCapabilityGrant {
  let resolved: Awaited<ReturnType<PlanFactory["storeFor"]>> | undefined;
  const provider = async () => (resolved ??= await factory.storeFor(owner));
  return {
    method: RUNTIME_PLANS_METHOD,
    revision: RUNTIME_PLANS_REVISION,
    idempotent: false,
    validateArguments: validPlanBridgeRequest,
    async invoke(value) {
      if (!validPlanBridgeRequest(value)) {
        throw Object.assign(new Error("runtime plans request is invalid"), {
          code: "invalid_request",
        });
      }
      const selected = await provider();
      const input = value.input ?? {};
      switch (value.operation) {
        case "resolve":
          return { key: selected.key, providerKind: selected.providerKind };
        case "create": {
          const raw = input.value as WireCreatePlanInput;
          const { now, ...create } = raw;
          return selected.store.create({
            ...create,
            ...(now === undefined ? {} : { now: new Date(now) }),
          });
        }
        case "read":
          return selected.store.read(input.id as string);
        case "list":
          return selected.store.list(input.value as PlanListInput);
        case "replace":
          return selected.store.update(
            input.id as string,
            input.expected as PlanCas,
            () => structuredClone(input.document as PlanDocument),
            {
              ...(input.structural === undefined
                ? {}
                : { structural: input.structural as boolean }),
              ...(date(input.now) === undefined ? {} : { now: date(input.now) }),
            },
          );
        case "reconcile":
          return selected.store.reconcile(
            input.id as string,
            input.known as PlanCas,
            date(input.now),
          );
        case "revise":
          return selected.store.revise(
            input.id as string,
            input.expected as PlanCas,
            input.operation as PlanRevisionOperation | readonly PlanRevisionOperation[],
            date(input.now),
          );
        case "delete":
          return selected.store.delete(input.id as string, input.expected as PlanCas | undefined);
      }
    },
  };
}

function mapPlanBridgeError(error: unknown, id?: string): never {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "plan_not_found") throw new PlanNotFoundError(id ?? "unknown");
  if (code === "plan_conflict") throw new PlanConflictError(message);
  if (code === "plan_sealed") throw new PlanSealedError(message);
  if (code === "plan_invalid") throw new InvalidPlanError(message);
  if (code === "plan_provider_unavailable") {
    throw new PlanProviderUnavailableError(message);
  }
  throw error;
}

function planDocument(value: unknown): PlanDocument {
  const parsed = planDocumentSchema.safeParse(value);
  if (!parsed.success)
    throw new InvalidPlanError(`host returned an invalid plan: ${parsed.error.message}`);
  return parsed.data;
}

/** Create the guest-side PlanFactory whose every data operation remains host-authoritative. */
export function createGuestPlanFactory(
  bridge: GuestExecutionBridge,
  signal?: AbortSignal,
): PlanFactory {
  const call = async (operation: PlanBridgeOperation, input?: Record<string, unknown>) => {
    try {
      return await bridge.capability(
        randomUUID(),
        {
          method: RUNTIME_PLANS_METHOD,
          revision: RUNTIME_PLANS_REVISION,
          arguments: { operation, ...(input === undefined ? {} : { input }) },
        },
        signal,
      );
    } catch (error) {
      return mapPlanBridgeError(error);
    }
  };
  let cached: Promise<Awaited<ReturnType<PlanFactory["storeFor"]>>> | undefined;
  return {
    storeFor() {
      return (cached ??= (async () => {
        const identity = record(await call("resolve"));
        if (identity === undefined || !string(identity.key) || !string(identity.providerKind)) {
          throw new PlanProviderUnavailableError("host returned an invalid plan provider identity");
        }
        const store: PlanStore = {
          async create(input) {
            return planDocument(
              await call("create", {
                value: {
                  ...input,
                  ...(input.now === undefined ? {} : { now: input.now.toISOString() }),
                },
              }),
            );
          },
          async read(id) {
            try {
              return planDocument(await call("read", { id }));
            } catch (error) {
              return mapPlanBridgeError(error, id);
            }
          },
          async list(input = {}) {
            const value = record(await call("list", { value: input }));
            const plans = planDocumentSchema.array().safeParse(value?.plans);
            if (!plans.success) throw new InvalidPlanError("host returned an invalid plan list");
            if (value?.next_cursor !== undefined && typeof value.next_cursor !== "string") {
              throw new InvalidPlanError("host returned an invalid plan cursor");
            }
            return {
              plans: plans.data,
              ...(typeof value?.next_cursor === "string" ? { next_cursor: value.next_cursor } : {}),
            } satisfies PlanListResult;
          },
          async update(id, expected, mutate, options = {}) {
            const current = await this.read(id);
            const draft = structuredClone(current);
            const changed = mutate(draft) ?? draft;
            return planDocument(
              await call("replace", {
                id,
                expected: toCas(expected),
                document: changed,
                ...(options.structural === undefined ? {} : { structural: options.structural }),
                ...(options.now === undefined ? {} : { now: options.now.toISOString() }),
              }),
            );
          },
          async reconcile(id, known, now) {
            return planDocument(
              await call("reconcile", {
                id,
                known: toCas(known),
                ...(now === undefined ? {} : { now: now.toISOString() }),
              }),
            );
          },
          async revise(id, expected, operation, now) {
            return planDocument(
              await call("revise", {
                id,
                expected: toCas(expected),
                operation,
                ...(now === undefined ? {} : { now: now.toISOString() }),
              }),
            );
          },
          async delete(id, expected) {
            const result = await call("delete", {
              id,
              ...(expected === undefined ? {} : { expected: toCas(expected) }),
            });
            if (typeof result !== "boolean")
              throw new InvalidPlanError("host returned an invalid delete result");
            return result;
          },
        };
        return { key: identity.key, providerKind: identity.providerKind, store };
      })());
    },
  };
}
