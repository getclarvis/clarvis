import { createHash } from "node:crypto";
import { sanitizeText } from "@clarvis/capability";
import type { RunDetail, Session } from "@clarvis/protocol";
import type { GoalTrajectoryInput } from "@clarvis/goal";

export interface GoalTrajectoryOptions {
  max_entries?: number;
  max_bytes?: number;
  max_runs?: number;
  exclude_user_text?: string;
  exclude_execution_outputs?: string;
  source_execution_ids?: readonly string[];
  workspace_read_available: boolean;
}

interface TrajectoryEntry {
  at: number;
  execution_id: string;
  kind: "user" | "assistant" | "terminal" | "steering" | "elicitation";
  text: string;
}

const canonical = (value: unknown): string => JSON.stringify(value);

/** Project only conversation-owned semantic evidence from persisted runs. */
export async function projectGoalTrajectory(
  session: Session,
  readRun: (executionId: string) => Promise<RunDetail | null>,
  options: GoalTrajectoryOptions,
): Promise<GoalTrajectoryInput & { partial: boolean; eligible_user_messages: number }> {
  const maxEntries = Math.max(1, options.max_entries ?? 128);
  const maxBytes = Math.max(1024, options.max_bytes ?? 128 * 1024);
  const maxRuns = Math.max(1, Math.min(256, options.max_runs ?? 256));
  const byId = new Map<string, RunDetail>();
  const exactSources =
    options.source_execution_ids === undefined ? undefined : new Set(options.source_execution_ids);
  let partial = false;

  const load = async (executionId: string): Promise<void> => {
    if (byId.has(executionId)) return;
    if (byId.size >= maxRuns) {
      partial = true;
      return;
    }
    const run = await readRun(executionId);
    if (run === null) {
      partial = true;
      return;
    }
    byId.set(executionId, run);
    if (run.continue_from !== undefined) {
      if (exactSources === undefined || exactSources.has(run.continue_from))
        await load(run.continue_from);
      else partial = true;
    }
  };
  if (exactSources !== undefined) {
    for (const executionId of exactSources) await load(executionId);
  } else {
    for (const turn of session.turns) {
      if (
        turn.kind !== "conversation" ||
        turn.status === "pending" ||
        turn.execution_id === undefined
      )
        continue;
      await load(turn.execution_id);
    }
  }

  const entries: TrajectoryEntry[] = [];
  let eligibleUserMessages = 0;
  for (const run of byId.values()) {
    for (const [index, message] of run.messages.entries()) {
      if (message.role !== "user" || typeof message.content !== "string") continue;
      const text = sanitizeText(message.content).trim();
      if (text.length === 0 || text === options.exclude_user_text) continue;
      eligibleUserMessages++;
      entries.push({
        at: run.created_at + index / 1000,
        execution_id: run.execution_id,
        kind: "user",
        text,
      });
    }
    const finalAssistant = [...run.events]
      .reverse()
      .find(
        (event) =>
          event.type === "iteration_completed" &&
          event.agent === "lead" &&
          event.response_phase === "final_answer" &&
          event.response.trim().length > 0,
      );
    if (
      run.execution_id !== options.exclude_execution_outputs &&
      finalAssistant?.type === "iteration_completed"
    )
      entries.push({
        at: finalAssistant.at,
        execution_id: run.execution_id,
        kind: "assistant",
        text: sanitizeText(finalAssistant.response).trim(),
      });
    for (const [index, event] of run.events.entries()) {
      if (event.type === "steering_applied" && event.message.trim())
        entries.push({
          at: event.at + index / 1000,
          execution_id: run.execution_id,
          kind: "steering",
          text: sanitizeText(event.message).trim(),
        });
      else if (event.type === "elicitation_resolved" && event.answer?.trim())
        entries.push({
          at: event.at + index / 1000,
          execution_id: run.execution_id,
          kind: "elicitation",
          text: sanitizeText(`${event.question}\n${event.answer}`).trim(),
        });
      else if (event.type === "run_ended" && run.execution_id !== options.exclude_execution_outputs)
        entries.push({
          at: event.at + index / 1000,
          execution_id: run.execution_id,
          kind: "terminal",
          text: sanitizeText(`${event.status}${event.reason ? `: ${event.reason}` : ""}`),
        });
    }
  }
  entries.sort(
    (left, right) => left.at - right.at || left.execution_id.localeCompare(right.execution_id),
  );

  const priority: Record<TrajectoryEntry["kind"], number> = {
    steering: 0,
    user: 1,
    elicitation: 2,
    assistant: 3,
    terminal: 4,
  };
  const selected = [...entries]
    .sort((left, right) => priority[left.kind] - priority[right.kind] || right.at - left.at)
    .slice(0, maxEntries)
    .sort(
      (left, right) => left.at - right.at || left.execution_id.localeCompare(right.execution_id),
    );
  let truncated = partial || selected.length !== entries.length;
  while (selected.length > 0 && Buffer.byteLength(canonical(selected), "utf8") > maxBytes) {
    selected.shift();
    truncated = true;
  }
  const projection = canonical({
    truncated,
    omitted_entries: entries.length - selected.length,
    partial_continuation_chain: partial,
    entries: selected,
  });
  return {
    projection,
    digest: createHash("sha256").update(projection).digest("hex"),
    truncated,
    partial,
    eligible_user_messages: eligibleUserMessages,
    source_execution_ids: [...byId.values()]
      .sort(
        (left, right) =>
          left.created_at - right.created_at || left.execution_id.localeCompare(right.execution_id),
      )
      .map((run) => run.execution_id),
    workspace_read_available: options.workspace_read_available,
  };
}
