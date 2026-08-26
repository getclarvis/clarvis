import type { RunRequest } from "@clarvis/capability";

export interface RunShape {
  entry: RunRequest["profiles"][number];
  isLead: boolean;
  softMode: boolean;
  userInputEnabled: boolean;
  askUserGranted: boolean;
  humanParkLikely: boolean;
}

export function deriveRunShape(
  request: RunRequest,
  capabilityNeedsHuman = false,
): RunShape | undefined {
  const entry = request.profiles.find((profile) => profile.name === request.entry);
  if (entry === undefined) return undefined;
  const grants = entry.grants ?? [];
  const isLead = (entry.can_spawn?.length ?? 0) > 0;
  const softMode = request.budget.on_exceed === "escalate";
  const askUserGranted = grants.includes("ask_user");
  return {
    entry,
    isLead,
    softMode,
    userInputEnabled: askUserGranted || capabilityNeedsHuman || softMode,
    askUserGranted,
    humanParkLikely: (askUserGranted || capabilityNeedsHuman) && request.elicit_wait_ms !== 0,
  };
}
