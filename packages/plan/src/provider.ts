import { createHash } from "node:crypto";
import {
  CapabilityExecutableRpcError,
  CodedError,
  capabilityExecutableDeclarationSchema,
  type CapabilityExecutableDeclaration,
  type CapabilityExecutablePort,
} from "@clarvis/capability";

import { PLAN_CURSOR_TAGS, decodePlanCursor, encodePlanCursor } from "./cursor.ts";
import { digestText, newPlan, renderPlan, specDigest } from "./format.ts";
import { planProviderConfigSchema, type PlanProviderConfig } from "./provider-config.ts";
import {
  InvalidPlanError,
  PlanConflictError,
  PlanNotFoundError,
  PlanSealedError,
} from "./repository.ts";
import { applyPlanRevisions, nextRevision } from "./revisions.ts";
import { planDocumentSchema, type PlanDocument } from "./schemas.ts";
import type { PlanCas, PlanStore } from "./store.ts";
import { isPlanSealed, sealedRevisionMessage } from "./transitions.ts";

/** Executable declaration supplied by an installed, enabled plugin. */
export interface PlanPluginPort {
  locate(
    plugin: string,
  ): { root: string; declaration: CapabilityExecutableDeclaration } | { error: string };
}

/** A selected store plus stable continuation and diagnostic identities. */
export interface ResolvedPlanStore {
  key: string;
  providerKind: string;
  store: PlanStore;
}

/** Resolves the currently selected provider for one canonical owner. */
export interface PlanFactory {
  storeFor(owner: string): Promise<ResolvedPlanStore>;
  /** Forget every inactive cached provider resolution for one owner. */
  evictOwner?(owner: string): void;
}

/** Construction inputs for {@link createPlanFactory}. */
export interface CreatePlanFactoryOptions {
  workspaceRoot: string;
  loadProvider: () => PlanProviderConfig | undefined;
  markdownStoreFor: (owner: string) => PlanStore;
  executablePort?: CapabilityExecutablePort;
  pluginPort?: PlanPluginPort;
}

/** A selected provider could not be safely resolved or constructed. */
export class PlanProviderUnavailableError extends CodedError {
  readonly code = "plan_provider_unavailable" as const;
}

/** A continuation names a different provider from the one now selected. */
export class PlanProviderMismatchError extends CodedError {
  readonly code = "plan_provider_mismatch" as const;

  constructor(previous: string | undefined, selected: string) {
    super(
      `Cannot continue an unfinished plan from provider '${previous ?? "unknown"}' with ` +
        `selected provider '${selected}'.`,
      { previous_provider_key: previous ?? null, selected_provider_key: selected },
    );
  }
}

function unavailable(
  condition: string,
  details: Record<string, unknown>,
  cause?: unknown,
): PlanProviderUnavailableError {
  let causeMessage = "unknown error";
  if (cause instanceof Error) causeMessage = cause.message;
  else if (typeof cause === "string") causeMessage = cause;
  else {
    try {
      causeMessage = JSON.stringify(cause) ?? causeMessage;
    } catch {
      // Diagnostic rendering must never replace the provider error it describes.
    }
  }
  const suffix = cause === undefined ? "" : `: ${causeMessage}`;
  return new PlanProviderUnavailableError(`${condition}${suffix}`, { condition, ...details });
}

function expectedSpecDigest(expected: PlanCas | PlanDocument): string {
  return "specDigest" in expected ? expected.specDigest : expected.spec_digest;
}

function casOf(value: PlanCas | PlanDocument): PlanCas {
  return {
    revision: value.revision,
    digest: value.digest,
    specDigest: expectedSpecDigest(value),
  };
}

function seal(document: PlanDocument): PlanDocument {
  const parsed = planDocumentSchema.parse(document);
  const source = renderPlan(parsed);
  return { ...parsed, digest: digestText(source), spec_digest: specDigest(parsed) };
}

function documentOf(value: unknown): PlanDocument {
  const parsed = planDocumentSchema.safeParse(value);
  if (!parsed.success)
    throw new InvalidPlanError(`provider returned an invalid plan: ${parsed.error.message}`);
  return parsed.data;
}

function mapRpcError(error: unknown, id?: string): never {
  if (!(error instanceof CapabilityExecutableRpcError)) throw error;
  switch (error.domainCode) {
    case "plan_not_found":
      throw new PlanNotFoundError(id ?? "unknown");
    case "plan_conflict": {
      const reason =
        typeof error.data === "object" &&
        error.data !== null &&
        (error.data as { reason?: unknown }).reason === "locked"
          ? "locked"
          : "cas";
      throw new PlanConflictError(error.message, reason);
    }
    case "plan_sealed":
      throw new PlanSealedError(error.message);
    case "plan_invalid":
      throw new InvalidPlanError(error.message);
    default:
      throw error;
  }
}

function declarationKey(prefix: string, declaration: CapabilityExecutableDeclaration): string {
  const json = JSON.stringify(declaration);
  return `${prefix}:${createHash("sha256").update(json).digest("hex")}`;
}

function executableStore(options: {
  owner: string;
  workspaceRoot: string;
  cwd: string;
  declaration: CapabilityExecutableDeclaration;
  port: CapabilityExecutablePort;
}): PlanStore {
  const call = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const session = await options.port.session({
      capability: "plans",
      workspace: options.workspaceRoot,
      cwd: options.cwd,
      declaration: options.declaration,
      owner: options.owner,
    });
    return session.request(method, { owner: options.owner, ...params });
  };

  const write = async (
    id: string,
    expected: PlanCas | PlanDocument,
    document: PlanDocument,
  ): Promise<PlanDocument> => {
    try {
      return documentOf(
        await call("plans/write", { id, document: seal(document), expected: casOf(expected) }),
      );
    } catch (error) {
      return mapRpcError(error, id);
    }
  };

  return {
    async create(input) {
      const proposed = seal(newPlan(input));
      try {
        return documentOf(await call("plans/create", { document: proposed }));
      } catch (error) {
        return mapRpcError(error, proposed.id);
      }
    },
    async read(id) {
      try {
        return documentOf(await call("plans/read", { id }));
      } catch (error) {
        return mapRpcError(error, id);
      }
    },
    async list(input = {}) {
      const forwarded =
        input.cursor === undefined
          ? input
          : { ...input, cursor: decodePlanCursor(PLAN_CURSOR_TAGS.provider, input.cursor) };
      try {
        const value = await call("plans/list", { input: forwarded });
        if (typeof value !== "object" || value === null) {
          throw new InvalidPlanError("provider returned an invalid plans/list result");
        }
        const result = value as { plans?: unknown; next_cursor?: unknown };
        const plans = planDocumentSchema.array().safeParse(result.plans);
        if (!plans.success)
          throw new InvalidPlanError(`provider returned invalid plans: ${plans.error.message}`);
        if (result.next_cursor !== undefined && typeof result.next_cursor !== "string") {
          throw new InvalidPlanError("provider returned a non-string next_cursor");
        }
        return {
          plans: plans.data,
          ...(typeof result.next_cursor === "string"
            ? { next_cursor: encodePlanCursor(PLAN_CURSOR_TAGS.provider, result.next_cursor) }
            : {}),
        };
      } catch (error) {
        return mapRpcError(error);
      }
    },
    async update(id, expected, mutate, updateOptions = {}) {
      const current = await this.read(id);
      if (
        current.revision !== expected.revision ||
        current.digest !== expected.digest ||
        current.spec_digest !== expectedSpecDigest(expected)
      ) {
        throw new PlanConflictError("Plan changed since it was read", "cas");
      }
      const draft = structuredClone(current);
      const changed = mutate(draft) ?? draft;
      const next = nextRevision(current, changed, {
        structural: updateOptions.structural === true,
        now: updateOptions.now ?? new Date(),
      });
      return write(id, expected, next);
    },
    async reconcile(id, known, now) {
      try {
        return documentOf(
          await call("plans/reconcile", {
            id,
            known: casOf(known),
            ...(now !== undefined ? { now: now.toISOString() } : {}),
          }),
        );
      } catch (error) {
        return mapRpcError(error, id);
      }
    },
    async revise(id, expected, operation, now) {
      const current = await this.read(id);
      if (
        current.revision !== expected.revision ||
        current.digest !== expected.digest ||
        current.spec_digest !== expectedSpecDigest(expected)
      ) {
        throw new PlanConflictError("Plan changed since it was read", "cas");
      }
      if (isPlanSealed(current)) throw new PlanSealedError(sealedRevisionMessage(current.id));
      const applied = applyPlanRevisions(
        structuredClone(current),
        Array.isArray(operation) ? operation : [operation],
      );
      const next = nextRevision(current, applied.document, {
        structural: applied.structural,
        now: now ?? new Date(),
      });
      return write(id, expected, next);
    },
    async delete(id, expected) {
      try {
        if (expected !== undefined) {
          const current = await this.read(id);
          if (
            current.revision !== expected.revision ||
            current.digest !== expected.digest ||
            current.spec_digest !== expectedSpecDigest(expected)
          ) {
            throw new PlanConflictError("Plan changed since it was read", "cas");
          }
        }
        const result = await call("plans/delete", { id });
        if (typeof result !== "boolean") {
          throw new InvalidPlanError("plans/delete must return a boolean");
        }
        return result;
      } catch (error) {
        return mapRpcError(error, id);
      }
    },
  };
}

/** Build a settings-sensitive, owner-scoped plan-provider resolver. */
export function createPlanFactory(options: CreatePlanFactoryOptions): PlanFactory {
  const stores = new Map<string, Promise<ResolvedPlanStore>>();
  const keysByOwner = new Map<string, Set<string>>();

  const memoized = (
    owner: string,
    key: string,
    build: () => Promise<ResolvedPlanStore>,
  ): Promise<ResolvedPlanStore> => {
    const existing = stores.get(key);
    if (existing !== undefined) return existing;
    const created = build();
    stores.set(key, created);
    const ownerKeys = keysByOwner.get(owner) ?? new Set<string>();
    ownerKeys.add(key);
    keysByOwner.set(owner, ownerKeys);
    void created.catch(() => {
      if (stores.get(key) === created) {
        stores.delete(key);
        ownerKeys.delete(key);
        if (ownerKeys.size === 0) keysByOwner.delete(owner);
      }
    });
    return created;
  };

  return {
    async storeFor(owner: string): Promise<ResolvedPlanStore> {
      let raw: unknown;
      try {
        raw = options.loadProvider() ?? { kind: "markdown" };
      } catch (error) {
        throw unavailable("plan provider settings could not be read", {}, error);
      }
      const parsed = planProviderConfigSchema.safeParse(raw);
      if (!parsed.success) {
        throw unavailable("unsupported or invalid plan provider configuration", {
          issues: parsed.error.issues,
        });
      }
      const config = parsed.data;
      if (config.kind === "markdown") {
        return memoized(owner, `markdown\0${owner}`, () =>
          Promise.resolve({
            key: "markdown",
            providerKind: "markdown",
            store: options.markdownStoreFor(owner),
          }),
        );
      }
      if (options.executablePort === undefined) {
        throw unavailable("this host cannot start plan provider executables", {
          provider: config.kind,
        });
      }

      let declaration: CapabilityExecutableDeclaration;
      let cwd: string;
      let key: string;
      let cacheKey: string;
      if (config.kind === "executable") {
        const { kind: _kind, ...candidate } = config;
        declaration = capabilityExecutableDeclarationSchema.parse(candidate);
        cwd = options.workspaceRoot;
        key = declarationKey("executable", declaration);
        cacheKey = key;
      } else {
        if (options.pluginPort === undefined) {
          throw unavailable("this host cannot resolve plugin plan providers", {
            plugin: config.plugin,
          });
        }
        const located = options.pluginPort.locate(config.plugin);
        if ("error" in located) throw unavailable(located.error, { plugin: config.plugin });
        declaration = located.declaration;
        cwd = located.root;
        key = `plugin:${config.plugin}`;
        cacheKey = declarationKey(key, declaration);
      }

      return memoized(owner, `${cacheKey}\0${owner}`, async () => {
        try {
          const session = await options.executablePort!.session({
            capability: "plans",
            workspace: options.workspaceRoot,
            cwd,
            declaration,
            owner,
          });
          return {
            key,
            providerKind: session.providerKind,
            store: executableStore({
              owner,
              workspaceRoot: options.workspaceRoot,
              cwd,
              declaration,
              port: options.executablePort!,
            }),
          };
        } catch (error) {
          throw unavailable(
            "plan provider executable could not be initialized",
            { key, owner },
            error,
          );
        }
      });
    },
    evictOwner(owner): void {
      const keys = keysByOwner.get(owner);
      if (keys === undefined) return;
      for (const key of keys) stores.delete(key);
      keysByOwner.delete(owner);
    },
  };
}
