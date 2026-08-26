/**
 * The parts of the CLI surface that need the application's own modules:
 * resolving which session `--resume`/`--continue` names, and reducing a run's
 * event stream to `--print` output.
 *
 * @remarks The flag table and its renderers live in `cli-args.ts` and are
 * deliberately **not** re-exported from here - a barrel would put this file's
 * imports back on `cli.ts`'s fast path.
 */
import type { RunEvent } from "@clarvis/protocol";
import {
  listSessionsForWorkspace,
  type SessionId,
  type SessionMeta,
  type SessionStore,
} from "./adapters/session-store.ts";
import { memoryNoticeStatus, plainStatusLine } from "./core/run-status.ts";

/**
 * Resolves the session a `--resume`/`--continue` invocation targets.
 *
 * @returns The session named by `--resume`, or the workspace's most recent
 * session for `--continue`; `null` if none is found.
 */
export function resolveResumeMeta(
  store: SessionStore,
  owner: string,
  workspace: string,
  mode: { kind: "resume"; id: SessionId } | { kind: "continue" },
): SessionMeta | null {
  if (mode.kind === "resume") return store.get(mode.id);
  return listSessionsForWorkspace(store, workspace)[0] ?? null;
}

/**
 * Reduces a run's event stream to the stdout of `--print`: lead text deltas
 * stream as they arrive; when a lead iteration streamed nothing, its completed
 * response is printed whole (streaming may be unavailable on some providers).
 */
export function createPrintStream(write: (chunk: string) => void): (event: RunEvent) => void {
  let currentIteration = -1;
  let iterationPrinted = 0;
  let anyPrinted = false;
  const separate = (): void => {
    if (anyPrinted) write("\n\n");
  };
  return (event) => {
    if (event.type === "text_delta") {
      if (event.agent !== "lead" || event.channel !== "text") return;
      if (event.iteration !== currentIteration) {
        separate();
        currentIteration = event.iteration;
        iterationPrinted = 0;
      } else if (event.reset && iterationPrinted > 0) {
        write("\n");
        iterationPrinted = 0;
      }
      write(event.text);
      iterationPrinted += event.text.length;
      if (event.text.length > 0) anyPrinted = true;
    } else if (event.type === "iteration_completed") {
      if (event.agent !== "lead" || event.response.length === 0) return;
      if (event.iteration === currentIteration && iterationPrinted > 0) return;
      separate();
      write(event.response);
      currentIteration = event.iteration;
      iterationPrinted = event.response.length;
      anyPrinted = true;
    }
  };
}

/**
 * Drains a `--print` run's event stream. The kernel keeps the stream open past
 * the run's settle while a post-run memory index pass is in flight, so printing
 * only at stream exhaustion would hold the answer hostage to the index's LLM
 * calls. `transcriptDone` resolves once the transcript is complete (`run_ended`
 * seen, or the stream closing without one) — print there. `drained` resolves
 * when the stream closes: staying alive until then is what lets the index pass
 * finish, with its notices narrating the wait via `onNotice`.
 */
export function drainPrintEvents(
  events: AsyncIterable<RunEvent>,
  sink: { onEvent: (event: RunEvent) => void; onNotice: (text: string) => void },
): { transcriptDone: Promise<void>; drained: Promise<void> } {
  let sawRunEnd!: () => void;
  const runEnded = new Promise<void>((resolve) => (sawRunEnd = resolve));
  const drained = (async () => {
    try {
      for await (const event of events) {
        if (event.type === "memory_ingest") {
          sink.onNotice(plainStatusLine(memoryNoticeStatus(event.detail)));
          continue;
        }
        sink.onEvent(event);
        if (event.type === "run_ended") sawRunEnd();
      }
    } catch {
      // A failed stream still settles the run's `done` with a terminal result.
    }
  })();
  return { transcriptDone: Promise.race([runEnded, drained]), drained };
}
