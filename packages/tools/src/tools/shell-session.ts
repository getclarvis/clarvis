import { constants as osConstants } from "node:os";
import type { ExecutionSession } from "../lib/execution-session.ts";
import type { ToolDef } from "./types.ts";

const MAX_YIELD_MS = 30_000;

function exitCode(session: ExecutionSession): number | null {
  if (session.running) return null;
  if (session.exitCode !== null) return session.exitCode;
  if (session.signal !== null) return 128 + (osConstants.signals[session.signal] ?? 0);
  return null;
}

/** A bounded view of one run-owned session; the cursor is independent for both pipes. */
export function shellSessionView(
  session: ExecutionSession,
  cursor: string | undefined,
  limit: number,
): Record<string, unknown> {
  const page = session.readStreams(cursor, limit);
  return {
    running: session.running,
    session_id: session.id,
    exit_code: exitCode(session),
    signal: session.signal,
    timed_out: session.timedOut,
    ready: session.ready,
    termination_confirmed: session.terminationConfirmed,
    stdout: page.stdout.text,
    stderr: page.stderr.text,
    next_cursor: page.nextCursor,
    stdout_omitted_bytes: page.stdout.omittedBefore,
    stderr_omitted_bytes: page.stderr.omittedBefore,
    stdout_truncated: page.stdout.omittedBefore > 0 || page.stdout.more,
    stderr_truncated: page.stderr.omittedBefore > 0 || page.stderr.more,
  };
}

/** Poll, stop or list sessions admitted by the caller's run and agent identity. */
export const shellSession: ToolDef = {
  name: "shell_session",
  description:
    "Poll output from, stop, or list this agent's run-owned shell sessions. Poll with the returned " +
    "next_cursor to continue; an expired cursor reports omitted bytes. Stop reports physical " +
    "termination confirmation. Sessions end with the run.",
  bounded: true,
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["poll", "stop", "list"] },
      session_id: { type: "string", description: "Opaque ID returned by shell." },
      cursor: { type: "string", description: "Opaque next_cursor returned by a previous poll." },
      yield_time_ms: {
        type: "integer",
        minimum: 0,
        maximum: MAX_YIELD_MS,
        description: "For poll, wait up to this many ms for new output or exit. Default 0.",
      },
    },
    required: ["action"],
    allOf: [
      {
        if: { properties: { action: { enum: ["poll", "stop"] } } },
        then: { required: ["session_id"] },
      },
      {
        if: { properties: { action: { const: "stop" } } },
        then: { not: { anyOf: [{ required: ["cursor"] }, { required: ["yield_time_ms"] }] } },
      },
      {
        if: { properties: { action: { const: "list" } } },
        then: {
          not: {
            anyOf: [
              { required: ["session_id"] },
              { required: ["cursor"] },
              { required: ["yield_time_ms"] },
            ],
          },
        },
      },
    ],
  },
  async handler(args, config, signal) {
    const action = args.action as "poll" | "stop" | "list";
    if (action === "list") {
      const sessions = config.sessionManager.listSessions(config.sessionAgent).map((session) => ({
        session_id: session.id,
        running: session.running,
        exit_code: exitCode(session),
        ready: session.ready,
        timed_out: session.timedOut,
      }));
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
    const cursor = args.cursor as string | undefined;
    const yieldMs = (args.yield_time_ms as number | undefined) ?? 0;
    await session.waitForChange(cursor, yieldMs, signal);
    return JSON.stringify(shellSessionView(session, cursor, config.maxOutputBytes));
  },
};
