import { CodedError } from "@clarvis/capability";
import { planProviderConfigSchema, type PlanProviderConfig } from "./provider-config.ts";
import type { PlanStore } from "./store.ts";

/** A selected store plus stable continuation identity. */
export interface ResolvedPlanStore {
  key: string;
  providerKind: string;
  store: PlanStore;
}

/** Resolves the built-in Markdown store for one canonical owner. */
export interface PlanFactory {
  storeFor(owner: string): Promise<ResolvedPlanStore>;
  evictOwner?(owner: string): void;
}

export interface CreatePlanFactoryOptions {
  loadProvider: () => PlanProviderConfig | undefined;
  markdownStoreFor: (owner: string) => PlanStore;
}

/** Invalid or inaccessible provider settings. */
export class PlanProviderUnavailableError extends CodedError {
  readonly code = "plan_provider_unavailable" as const;
}

/** A continuation names a different provider than the built-in Markdown store. */
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

/** Build one owner-scoped Markdown store and keep it stable until owner eviction. */
export function createPlanFactory(options: CreatePlanFactoryOptions): PlanFactory {
  const stores = new Map<string, ResolvedPlanStore>();
  return {
    storeFor(owner): Promise<ResolvedPlanStore> {
      return Promise.resolve().then(() => {
        let selected: unknown;
        try {
          selected = options.loadProvider() ?? { kind: "markdown" };
        } catch {
          throw new PlanProviderUnavailableError("plan provider settings could not be read");
        }
        if (!planProviderConfigSchema.safeParse(selected).success) {
          throw new PlanProviderUnavailableError(
            "unsupported or invalid plan provider configuration",
          );
        }
        const existing = stores.get(owner);
        if (existing !== undefined) return existing;
        const resolved = {
          key: "markdown",
          providerKind: "markdown",
          store: options.markdownStoreFor(owner),
        };
        stores.set(owner, resolved);
        return resolved;
      });
    },
    evictOwner(owner): void {
      stores.delete(owner);
    },
  };
}
