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
): Record<string, unknown> {
  const page = session.readStreams(cursor, limit);
  const snapshot = session.snapshot();
  return {
    phase: snapshot.phase,
    running: snapshot.running,
    session_id: session.id,
    exit_code: exitCode(snapshot),
    signal: snapshot.signal,
    timed_out: snapshot.timedOut,
    ready: snapshot.ready,
    termination_confirmed: snapshot.terminationConfirmed,
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
      cursor: {
        type: "string",
        description: "Opaque next_cursor returned by a previous poll; omit on the first poll.",
      },
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
    ],
  },
  async handler(args, config, signal) {
    const action = args.action as "poll" | "stop" | "list";
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
    const cursor = args.cursor === "" ? undefined : (args.cursor as string | undefined);
    const yieldMs = (args.yield_time_ms as number | undefined) ?? 0;
    await session.waitForChange(cursor, yieldMs, signal);
    return JSON.stringify(shellSessionView(session, cursor, config.maxOutputBytes));
  },
};
