import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SetLevelRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Principal } from "../auth/principals.ts";
import { observeServerTask } from "../tasks.ts";
import type { ResolvedHost } from "../host/run-host.ts";
import {
  createConcurrencyGate,
  createLiveRunTable,
  type ConcurrencyGate,
  type LiveRunTable,
} from "../host/live-runs.ts";
import { SILENT_SERVER_LOGGERS, type ServerLoggers } from "../logging.ts";
import { handleCancelTool, handleRespondTool, handleSteerTool } from "./control-tools.ts";
import { handleRunTool, reportRunCancelled, type RunToolArgs } from "./run-tool.ts";
import {
  ackOutputShape,
  cancelInputShape,
  respondInputShape,
  runInputShape,
  runOutputShape,
  steerInputShape,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
} from "./tools.ts";

/** Limits and switches the tool handlers read. */
export interface McpServerLimits {
  maxRuns: number;
  maxRunsPerOwner: number;
  bufferMax: number;
  bufferMaxBytes: number;
  sendTimeoutMs: number;
  heartbeatMs: number;
  runMaxMs: number;
  settleGraceMs: number;
  elicitToolWaitMs: number;
  elicitRelayMs: number;
  allowRemoteGuardApproval: boolean;
}

/** Configuration for {@link buildMcpServer}. */
export interface BuildMcpServerOptions {
  resolved: ResolvedHost;
  limits: McpServerLimits;
  /** Shared across sessions so the global cap really is global. */
  gate?: ConcurrencyGate;
  version?: string;
  /**
   * The caller this session speaks for, absent without authentication.
   *
   * @remarks A function, not a value, because it is read **per tool call**
   * rather than captured once. The enrolment file is the authority and is
   * re-read on every request, so a role narrowed while a session is open must
   * narrow that session too — a captured snapshot would keep relaying guard
   * approvals and running de-listed agents until the client happened to
   * reconnect. Its role decides which agents may run, how many runs may be in
   * flight, and whether a guarded command may be approved.
   */
  getPrincipal?: () => Principal | undefined;
  /**
   * The session-bound channels, already carrying `session_id`, `owner`,
   * `owner_authenticated` and `client_id`.
   *
   * @remarks A value rather than a function, unlike {@link
   * BuildMcpServerOptions.getPrincipal}: a session's client id cannot change —
   * `serve.ts` answers a mismatched credential `403` before the session sees it
   * — so the bindings never go stale. A *role* can change, and that is reported
   * as `auth.principal.narrowed` and carried as an explicit field wherever it
   * decides something.
   */
  logger?: ServerLoggers;
}

/** An MCP server plus the lifecycle hooks a host drives it with. */
export interface McpServerBundle {
  server: McpServer;
  runs: LiveRunTable;
  /**
   * Wait for in-flight runs to settle.
   *
   * @param graceMs - how long to wait before giving up.
   * @returns `true` when everything settled inside the grace window.
   */
  drain(graceMs: number): Promise<boolean>;
  /**
   * Cancel every in-flight run — a connection's runs die with it.
   *
   * @returns how many runs were in flight.
   */
  cancelAll(reason: "session_close" | "shutdown"): number;
}

/**
 * Build the MCP server for one session.
 *
 * @param opts - the owner-bound host, limits and shared concurrency gate.
 * @returns the server and its lifecycle hooks; see {@link McpServerBundle}.
 * @remarks One session, one server, one run table. The four tools are registered
 *   on the high-level `McpServer` so input and output schemas are validated for
 *   free and the client's declared capabilities stay reachable.
 */
export function buildMcpServer(opts: BuildMcpServerOptions): McpServerBundle {
  const server = new McpServer(
    { name: "@clarvis/server", version: opts.version ?? "0.0.0" },
    { capabilities: { tools: {}, logging: {} } },
  );

  const loggers = opts.logger ?? SILENT_SERVER_LOGGERS;
  const runs = createLiveRunTable();
  const gate =
    opts.gate ??
    createConcurrencyGate({
      perOwner: opts.limits.maxRunsPerOwner,
      global: opts.limits.maxRuns,
      logger: loggers.log,
    });

  let level = "info";
  server.server.setRequestHandler(SetLevelRequestSchema, (request) => {
    level = request.params.level;
    return {};
  });

  const clientDeclaresElicitation = (): boolean =>
    server.server.getClientCapabilities()?.elicitation !== undefined;

  server.registerTool(
    TOOL_NAMES.run,
    {
      description: TOOL_DESCRIPTIONS.run,
      inputSchema: runInputShape,
      outputSchema: runOutputShape,
    },
    async (args, extra) =>
      handleRunTool(
        args as RunToolArgs,
        {
          resolved: opts.resolved,
          principal: opts.getPrincipal?.(),
          runs,
          gate,
          clientDeclaresElicitation,
          sendNotification: (notification) =>
            extra.sendNotification(
              notification as unknown as Parameters<typeof extra.sendNotification>[0],
            ),
          sendElicitRequest: async (request, signal, timeoutMs) => {
            const answered = await extra.sendRequest(
              { method: "elicitation/create", params: request } as Parameters<
                typeof extra.sendRequest
              >[0],
              z.object({
                action: z.enum(["accept", "decline", "cancel"]),
                content: z.record(z.string(), z.unknown()).optional(),
              }),
              { ...(signal !== undefined ? { signal } : {}), timeout: timeoutMs },
            );
            return answered;
          },
          getLevel: () => level,
          limits: opts.limits,
          logger: loggers,
        },
        {
          signal: extra.signal,
          ...(extra._meta?.progressToken !== undefined
            ? { progressToken: extra._meta.progressToken }
            : {}),
        },
      ),
  );

  server.registerTool(
    TOOL_NAMES.steer,
    {
      description: TOOL_DESCRIPTIONS.steer,
      inputSchema: steerInputShape,
      outputSchema: ackOutputShape,
    },
    (args) => handleSteerTool(args as Parameters<typeof handleSteerTool>[0], runs),
  );

  server.registerTool(
    TOOL_NAMES.cancel,
    {
      description: TOOL_DESCRIPTIONS.cancel,
      inputSchema: cancelInputShape,
      outputSchema: ackOutputShape,
    },
    (args) => handleCancelTool(args, runs),
  );

  server.registerTool(
    TOOL_NAMES.respond,
    {
      description: TOOL_DESCRIPTIONS.respond,
      inputSchema: respondInputShape,
      outputSchema: ackOutputShape,
    },
    (args) => Promise.resolve(handleRespondTool(args, runs)),
  );

  return {
    server,
    runs,
    async drain(graceMs): Promise<boolean> {
      const inFlight = runs.values().map((r) => r.lifecycleDone);
      if (inFlight.length === 0) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
        timer.unref?.();
      });
      const settled = await Promise.race([Promise.allSettled(inFlight).then(() => true), timeout]);
      if (timer !== undefined) clearTimeout(timer);
      return settled;
    },
    cancelAll(reason): number {
      const live = runs.values();
      for (const run of live) {
        if (run.cancelledBy === undefined) {
          run.cancelledBy = reason;
          reportRunCancelled(loggers.log, run.executionId, reason, Date.now() - run.startedAt);
        }
        observeServerTask("server_cancel_all_run", () => run.handle.cancel());
      }
      return live.length;
    },
  };
}
