import type {
  ListWorkspaceChangesRequest,
  ReadWorkspaceChangeRequest,
  WorkspaceChangesAvailability,
  WorkspaceChangesCallOptions,
  WorkspaceChangesService,
} from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import type { WorkspaceChangesContext, WorkspaceChangesProvider } from "./changes-provider.ts";

/** Construction options for the public workspace-changes façade. */
export interface WorkspaceChangesServiceOptions {
  workspaceRoot: string;
  workspaceId: string;
  projectId: string;
  providers: readonly WorkspaceChangesProvider[];
}

function asAbortSignal(signal: WorkspaceChangesCallOptions["signal"]): AbortSignal | undefined {
  return signal as AbortSignal | undefined;
}

type ActiveProvider = {
  kind: "active";
  provider: WorkspaceChangesProvider;
  availability: Extract<WorkspaceChangesAvailability, { status: "available" }>;
};

type BlockedAvailability = {
  kind: "blocked";
  availability: WorkspaceChangesAvailability;
};

/**
 * Compose registered change providers into the public Protocol service.
 *
 * Selection is deterministic: a single applicable provider is activated; two or
 * more applicable providers are an error rather than first-wins; operational
 * failure is never reported as a clean tree.
 */
export function createWorkspaceChangesService(
  options: WorkspaceChangesServiceOptions,
): WorkspaceChangesService {
  const context = (signal?: AbortSignal): WorkspaceChangesContext => ({
    workspaceRoot: options.workspaceRoot,
    workspaceId: options.workspaceId,
    projectId: options.projectId,
    ...(signal === undefined ? {} : { signal }),
  });

  const resolve = async (signal?: AbortSignal): Promise<ActiveProvider | BlockedAvailability> => {
    if (options.providers.length === 0) {
      return {
        kind: "blocked",
        availability: {
          status: "unavailable",
          reason: { code: "no_provider", message: "no change provider is configured" },
        },
      };
    }
    const ctx = context(signal);
    const rows = await Promise.all(
      options.providers.map(async (provider) => ({
        provider,
        availability: await provider.probe(ctx),
      })),
    );
    const available = rows.filter(
      (
        row,
      ): row is {
        provider: WorkspaceChangesProvider;
        availability: ActiveProvider["availability"];
      } => row.availability.status === "available",
    );
    const only = available[0];
    if (available.length === 1 && only !== undefined) return { kind: "active", ...only };
    if (available.length > 1) {
      return {
        kind: "blocked",
        availability: {
          status: "unavailable",
          reason: {
            code: "ambiguous_provider",
            message: "multiple change providers apply; select one explicitly",
          },
        },
      };
    }
    const notApplicable = rows.find((row) => row.availability.status === "not_applicable");
    if (notApplicable !== undefined)
      return { kind: "blocked", availability: notApplicable.availability };
    return {
      kind: "blocked",
      availability: rows[0]?.availability ?? {
        status: "unavailable",
        reason: { code: "no_provider", message: "no change provider is configured" },
      },
    };
  };

  const requireActive = async (signal?: AbortSignal): Promise<ActiveProvider> => {
    const resolved = await resolve(signal);
    if (resolved.kind === "active") return resolved;
    const availability = resolved.availability;
    throw kernelError(
      availability.status === "not_applicable" ? "unsupported" : "unavailable",
      availability.status === "available"
        ? "change provider is unavailable"
        : availability.reason.message,
    );
  };

  return {
    async availability(call) {
      const resolved = await resolve(asAbortSignal(call?.signal));
      return resolved.availability;
    },
    async list(request, call) {
      const active = await requireActive(asAbortSignal(call?.signal));
      return active.provider.listChanges(context(asAbortSignal(call?.signal)), request ?? {});
    },
    async read(request: ReadWorkspaceChangeRequest, call) {
      const active = await requireActive(asAbortSignal(call?.signal));
      return active.provider.readChange(context(asAbortSignal(call?.signal)), request);
    },
  };
}

export type { ListWorkspaceChangesRequest };
