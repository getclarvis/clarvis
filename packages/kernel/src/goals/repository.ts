import type { GoalRepository } from "@clarvis/goal";
import type { SessionService } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import type { HostedSessionTransactions } from "../hosting/sessions.ts";
import { goalStateFromSession, goalStateToDto, validateSessionGoalState } from "./session-state.ts";

/** Reuse the private session transaction; goal state has no separate file or authoritative cache. */
export function createGoalRepository(
  sessions: Pick<SessionService, "get">,
  transactions: HostedSessionTransactions,
): GoalRepository {
  return {
    async read(sessionId) {
      const session = await sessions.get(sessionId);
      if (session === null) throw kernelError("not_found", "goal conversation does not exist");
      return goalStateFromSession(session);
    },
    transact(sessionId, mutation) {
      return transactions.transact(sessionId, (session) => {
        const { state, result } = mutation(goalStateFromSession(session));
        session.goal_state = goalStateToDto(state);
        validateSessionGoalState(session);
        return { session, result };
      });
    },
  };
}
