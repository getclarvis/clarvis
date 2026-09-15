import type { PlanRef, RunDetail, RunEvent, RunResult } from "@clarvis/protocol";

function resultToContent(result: RunResult | undefined): string | null {
  if (!result || !("result" in result)) return null;
  const value = result.result;
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Build the text a lead agent sees for a `/skill` run it dispatched: the skill
 * run's textual result, or — if the run was interrupted before producing one — a
 * {@link buildRecoveredContext} salvage, or else a bare status line.
 *
 * @param name - the skill's name, for the digest's tag line.
 * @param agent - the agent the skill declared and therefore ran on; naming it is
 *   the only way the reader can tell whose profile produced the result.
 * @param envelope - the live run's result, if the run just finished.
 * @param stored - the persisted run detail, as a fallback source for `envelope`/salvage.
 */
export function buildSkillRunDigest(
  name: string,
  agent: string,
  envelope: RunResult | undefined,
  stored: RunDetail | null,
  selectedPlanProviderKey?: string,
): string {
  const execId = envelope?.execution_id ?? stored?.execution_id;
  const tag = `[/${name} → ${agent}${execId ? `, exec ${execId}` : ""}]`;
  const source: RunResult | undefined = envelope ?? stored?.result;
  const raw = resultToContent(source);
  const salvaged =
    raw ??
    (stored
      ? buildRecoveredContext(stored.events, stored.plan_ref, selectedPlanProviderKey)
      : null);
  const body = salvaged;
  if (body == null || body.trim().length === 0) {
    const status = envelope?.status ?? stored?.status ?? "completed";
    return `${tag} ${status} with no textual result.`;
  }
  return `${tag}\n${body}`;
}

/**
 * Salvage from an interrupted run: what the next turn must not re-ask or redo.
 *
 * The plan is NOT reconstructed from events — plan documents never enter the
 * trace. The persisted `plan_ref` names its provider and stable id, so the
 * salvage points at the provider's authoritative current state instead of
 * trusting a stale snapshot.
 */
export function buildRecoveredContext(
  events: RunEvent[],
  planRef?: PlanRef,
  selectedPlanProviderKey?: string,
): string | null {
  const sections: string[] = [];

  const decisions = events.filter(
    (e): e is Extract<RunEvent, { type: "elicitation_resolved" }> =>
      e.type === "elicitation_resolved" &&
      e.outcome === "accept" &&
      typeof e.answer === "string" &&
      e.answer.length > 0,
  );
  if (decisions.length > 0) {
    const lines = decisions.map((d) => `  • ${d.question.trim()} → ${d.answer!.trim()}`);
    sections.push("Decisions already confirmed (do not re-ask):\n" + lines.join("\n"));
  }

  if (planRef !== undefined && planRef.status !== "completed") {
    const locator = planRef.path ? `\n  Locator: ${planRef.path}` : "";
    const providerMismatch =
      selectedPlanProviderKey !== undefined && selectedPlanProviderKey !== planRef.provider_key;
    sections.push(
      `Plan left ${planRef.status} at revision ${planRef.final_revision}.\n` +
        `  Provider: ${planRef.provider_key}\n` +
        `  ID: ${planRef.id}` +
        locator +
        "\n  " +
        (providerMismatch
          ? `The currently selected provider is ${selectedPlanProviderKey}. Select ${planRef.provider_key} again before read_plan can return this document to the selected provider's history scope; do not open another document as if it were the active plan.`
          : `Read id ${planRef.id} with read_plan before acting — the provider's document is authoritative and may have changed.`),
    );
  }

  if (sections.length === 0) return null;
  return (
    "[Recovered context — the previous run was interrupted before finishing. Reconstructed from its " +
    "trace so you can continue rather than restart.]\n\n" +
    sections.join("\n\n") +
    "\n\nResume from here: keep these decisions, honor the plan and each task's status, and do not " +
    "repeat questions that are already answered above."
  );
}
