import type { GoalService } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";

/** Headless hosts do not acquire conversation authority by exposing the common client facade. */
export function unavailableGoalService(
  reason = "Goals require an authenticated conversation host",
): GoalService {
  const refuse = async (): Promise<never> => {
    throw kernelError("unsupported", reason);
  };
  return {
    availability: async () => ({ available: false, reason }),
    get: refuse,
    control: refuse,
    receipt: refuse,
    subscribe: refuse,
  };
}
