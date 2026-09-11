import type { Elicit, GuardElicit } from "@clarvis/loop";
import { createGuardElicit, type GuardSessionAllowlist } from "./guard-elicit.ts";

/** Human consent authority, queried for every command without caching permission in its caller. */
export interface GuardHumanApproval {
  covers(request: Parameters<GuardElicit>[0]): boolean | Promise<boolean>;
  ask(request: Parameters<GuardElicit>[0]): Promise<{ allowed: boolean; persisted: boolean }>;
}

/**
 * Use the current interactive scope for lookup and capture it for each question. A response from
 * a retired controller cannot approve work or populate its replacement's command allowlist.
 */
export function createGuardHumanApproval(options: {
  elicit: Elicit;
  allowlist: () => GuardSessionAllowlist | undefined;
  workspaceRoot: string;
  signal?: AbortSignal;
}): GuardHumanApproval {
  return {
    covers(request) {
      return (
        !options.signal?.aborted &&
        request.escalate !== "human" &&
        request.shell !== undefined &&
        options.allowlist()?.covers(request.shell) === true
      );
    },
    async ask(request) {
      const scope = options.allowlist();
      const before = request.shell !== undefined && scope?.covers(request.shell) === true;
      const answer = await createGuardElicit(options.elicit, {
        allowlist: scope,
        workspaceRoot: options.workspaceRoot,
        signal: options.signal,
      })(request);
      if (options.signal?.aborted || scope !== options.allowlist()) {
        return { allowed: false, persisted: false };
      }
      const allowed = answer === true || (typeof answer === "object" && answer.allowed);
      const after = request.shell !== undefined && scope?.covers(request.shell) === true;
      return { allowed, persisted: allowed && after && !before };
    },
  };
}
