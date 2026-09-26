import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentExecutionResolver } from "@clarvis/loop/host";
import type { ExecuteRunArgs, ExecuteRunOutcome } from "@clarvis/loop";
import type { ConfigStore } from "../config/config-store.ts";
import {
  resolveIsolationSettings,
  type ResolvedIsolationSettings,
} from "../config/isolation-settings.ts";

/** A private, owner-scoped snapshot of the global execution preference. */
export interface IsolationService {
  bind(owner: string, executionId: string, settings?: ResolvedIsolationSettings): void;
  inherit(owner: string, parentExecutionId: string, executionId: string): void;
  release(owner: string, executionId: string): void;
  resolveExecution: AgentExecutionResolver;
  availability: () => "available" | "unavailable" | "unverified";
}

/** Bind an internal run that bypasses the public run service for its entire execution. */
export async function executeWithIsolationBinding(
  service: IsolationService | undefined,
  args: ExecuteRunArgs,
  execute: (args: ExecuteRunArgs) => Promise<ExecuteRunOutcome>,
): Promise<ExecuteRunOutcome> {
  if (service === undefined) return execute(args);
  const body = args.rawBody;
  const executionId =
    typeof body === "object" && body !== null && "execution_id" in body
      ? body.execution_id
      : undefined;
  if (typeof executionId !== "string" || executionId.length === 0) {
    throw new Error("internal run isolation binding requires an execution id");
  }
  service.bind(args.owner, executionId);
  try {
    return await execute(args);
  } finally {
    service.release(args.owner, executionId);
  }
}

/** Bind each admitted tree before tool activation; a missing identity is never a global lookup. */
export function createIsolationService(options: {
  store: ConfigStore;
  workspaceRoot: string;
  globalRoot: string;
  homeRoot?: string;
  productRoot?: string;
}): IsolationService {
  const bindings = new Map<string, ResolvedIsolationSettings>();
  const availabilityByNetwork = new Map<
    ResolvedIsolationSettings["network"],
    "available" | "unavailable"
  >();
  const key = (owner: string, executionId: string): string => `${owner}\0${executionId}`;
  const readGlobal = (): ResolvedIsolationSettings =>
    resolveIsolationSettings(options.store.readSettings().scopes.global?.isolation);
  return {
    availability: () => availabilityByNetwork.get(readGlobal().network) ?? "unverified",
    bind(owner, executionId, settings = readGlobal()) {
      const identity = key(owner, executionId);
      if (bindings.has(identity)) throw new Error("isolation binding already exists");
      bindings.set(identity, { ...settings });
    },
    inherit(owner, parentExecutionId, executionId) {
      const parent = bindings.get(key(owner, parentExecutionId));
      if (!parent) throw new Error("parent isolation binding is missing");
      this.bind(owner, executionId, parent);
    },
    release(owner, executionId) {
      bindings.delete(key(owner, executionId));
    },
    async resolveExecution(ctx, scratchRoot) {
      const settings = bindings.get(key(ctx.owner, ctx.executionId));
      if (!settings) throw new Error("run isolation binding is missing");
      if (settings.mode === "host") return {};
      const [{ createExecutionPolicy, BubblewrapBackend, SeatbeltBackend }, tools] =
        await Promise.all([import("@clarvis/sandbox"), import("@clarvis/tools")]);
      const policy = createExecutionPolicy({
        id: createHash("sha256").update(key(ctx.owner, ctx.executionId)).digest("hex").slice(0, 32),
        mode: "sandbox",
        workspaceRoot: options.workspaceRoot,
        globalRoot: options.globalRoot,
        ...(options.homeRoot === undefined ? {} : { homeRoot: options.homeRoot }),
        workspaceAccess: settings.workspace,
        network: settings.network,
        temporaryWriteRoots: [scratchRoot],
        installationRoots: [
          dirname(realpathSync(process.execPath)),
          ...(existsSync(tools.sandboxWorkerRoot) ? [tools.sandboxWorkerRoot] : []),
          ...(options.productRoot && existsSync(options.productRoot) ? [options.productRoot] : []),
        ],
      });
      const backend =
        process.platform === "darwin" ? new SeatbeltBackend() : new BubblewrapBackend();
      const sandbox = new tools.SandboxToolExecutor(policy, backend, scratchRoot);
      return {
        executionPolicy: policy,
        sandboxBackend: backend,
        executionPort: new tools.CoordinatedToolExecutor(sandbox, true, (ready) => {
          availabilityByNetwork.set(settings.network, ready ? "available" : "unavailable");
        }),
      };
    },
  };
}
