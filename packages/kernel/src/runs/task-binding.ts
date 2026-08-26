import { taskRunStateV2Schema } from "@clarvis/tasks/capability";
import { TASKS_CAPABILITY_NAME } from "@clarvis/tasks/settings";
import type { ActiveTaskBindingDto } from "@clarvis/protocol";

/** Project only the stable task binding from the capability-owned persisted state. */
export function taskBindingFromCapabilityState(
  capabilityState: Record<string, unknown> | undefined,
): ActiveTaskBindingDto | undefined {
  const parsed = taskRunStateV2Schema.safeParse(capabilityState?.[TASKS_CAPABILITY_NAME]);
  if (!parsed.success) return undefined;
  const state = parsed.data;
  return {
    id: state.taskId,
    provider_key: state.providerKey,
    mode: state.mode,
  };
}
