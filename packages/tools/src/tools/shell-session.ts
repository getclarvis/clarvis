import { constants as osConstants } from "node:os";
import type { ExecutionSession } from "../lib/execution-session.ts";
import type { ToolDef } from "./types.ts";

const MAX_YIELD_MS = 30_000;

function exitCode(snapshot: ReturnType<ExecutionSession["snapshot"]>): number | null {
  if (snapshot.running) return null;
  if (snapshot.exitCode !== null) return snapshot.exitCode;
  if (snapshot.signal !== null) return 128 + (osConstants.signals[snapshot.signal] ?? 0);
  return null;
}

/** A bounded view of one run-owned session; the cursor is independent for both pipes. */
export function shellSessionView(
  session: ExecutionSession,
  cursor: string | undefined,
  limit: number,
  tail = false,
): Record<string, unknown> {
  const page = tail ? session.readTail(limit) : session.readStreams(cursor, limit);
  return {
    ...shellSessionStatus(session),
    stdout: page.stdout.text,
    stderr: page.stderr.text,
    next_cursor: page.nextCursor,
    has_more: page.stdout.more || page.stderr.more,
    stdout_omitted_bytes: page.stdout.omittedBefore,
    stderr_omitted_bytes: page.stderr.omittedBefore,
    stdout_truncated:
      page.stdout.omittedBefore > 0 ||
      page.stdout.more ||
      (tail && Number(session.outputInfo().stdout_bytes) > Buffer.byteLength(page.stdout.text)),
    stderr_truncated:
      page.stderr.omittedBefore > 0 ||
      page.stderr.more ||
      (tail && Number(session.outputInfo().stderr_bytes) > Buffer.byteLength(page.stderr.text)),
  };
}

/** Status and log locations without consuming or formatting output. */
function shellSessionStatus(session: ExecutionSession): Record<string, unknown> {
  const snapshot = session.snapshot();
  return {
    ...session.outputInfo(),
    phase: snapshot.phase,
    running: snapshot.running,
    session_id: session.id,
    exit_code: exitCode(snapshot),
    signal: snapshot.signal,
    timed_out: snapshot.timedOut,
    ready: snapshot.ready,
    termination_confirmed: snapshot.terminationConfirmed,
    ...(snapshot.keepAlive
      ? {
          keep_alive: true,
          command_status: snapshot.commandStatus,
          command_exit_code: snapshot.commandExitCode ?? null,
          command_signal: snapshot.commandSignal ?? null,
        }
      : {}),
  };
}

/** Poll, stop or list sessions admitted by the caller's run and agent identity. */
export const shellSession: ToolDef = {
  name: "shell_session",
  description:
    "Inspect this agent's run-owned shell sessions without rerunning commands. Poll batches output for the requested wait (default 10 seconds), returning early only on completion or cancellation. " +
    "Use status for metadata only, tail for recent output, or read with next_cursor for earlier log pages. stdout_log/stderr_log are plain-text files usable with read_file, tail or rg; inspect failures there before retrying a command. " +
    "Logs are capped at 16 MiB per stream; log_truncated reports incomplete capture. Stop confirms physical termination. Logs end with the run or session eviction.",
  bounded: true,
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["poll", "read", "tail", "status", "stop", "list"] },
      session_id: { type: "string", description: "Opaque ID returned by shell." },
      cursor: {
        type: "string",
        description:
          "Opaque next_cursor from a previous page. For read, omit to start at the beginning of the retained log.",
      },
      yield_time_ms: {
        type: "integer",
        minimum: 0,
        maximum: MAX_YIELD_MS,
        description:
          "For poll, accumulate output for this many ms, returning early only on completion or cancellation. Default 10000. Use 0 for an immediate check.",
      },
    },
    required: ["action"],
    allOf: [
      {
        if: { properties: { action: { enum: ["poll", "read", "tail", "status", "stop"] } } },
        then: { required: ["session_id"] },
      },
    ],
  },
  async handler(args, config, signal) {
    const action = args.action as "poll" | "read" | "tail" | "status" | "stop" | "list";
    if (action === "list") {
      const sessions = config.sessionManager.listSessions(config.sessionAgent).map((session) => {
        const snapshot = session.snapshot();
        return {
          session_id: session.id,
          phase: snapshot.phase,
          running: snapshot.running,
          exit_code: exitCode(snapshot),
          ready: snapshot.ready,
          timed_out: snapshot.timedOut,
          ...(snapshot.keepAlive
            ? {
                keep_alive: true,
                command_status: snapshot.commandStatus,
                command_exit_code: snapshot.commandExitCode ?? null,
                command_signal: snapshot.commandSignal ?? null,
              }
            : {}),
        };
      });
      return JSON.stringify({ sessions });
    }
    const session = config.sessionManager.getSession(
      args.session_id as string,
      config.sessionAgent,
    );
    if (action === "stop") {
      const confirmed = await session.stop();
      return JSON.stringify({
        session_id: session.id,
        stopped: confirmed,
        termination_confirmed: confirmed,
        status: confirmed ? "stopped" : "termination_unconfirmed",
      });
    }
    if (action === "status") {
      return JSON.stringify(shellSessionStatus(session));
    }
    const cursor = args.cursor === "" ? undefined : (args.cursor as string | undefined);
    const yieldMs = (args.yield_time_ms as number | undefined) ?? 10_000;
    if (action === "poll") await session.waitForChange(cursor, yieldMs, signal);
    return JSON.stringify(
      shellSessionView(session, cursor, Math.min(config.maxOutputBytes, 8192), action === "tail"),
    );
  },
};
