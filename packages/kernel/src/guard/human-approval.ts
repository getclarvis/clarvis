import { canonicalJudgeJson, type JudgeJson } from "@clarvis/judge";
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
  const pending = new Map<
    GuardSessionAllowlist | undefined,
    Map<string, Promise<{ allowed: boolean; persisted: boolean }>>
  >();
  return {
    covers(request) {
      return (
        !options.signal?.aborted &&
        request.escalate !== "human" &&
        request.shell !== undefined &&
        options.allowlist()?.covers(request.shell) === true
      );
    },
    ask(request) {
      const scope = options.allowlist();
      const key = canonicalJudgeJson(JSON.parse(JSON.stringify(request)) as JudgeJson);
      let requests = pending.get(scope);
      if (requests === undefined) {
        requests = new Map();
        pending.set(scope, requests);
      }
      const existing = requests.get(key);
      if (existing !== undefined) return existing;
      const operation = (async () => {
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
      })();
      requests.set(key, operation);
      const retire = () => {
        if (requests.get(key) === operation) requests.delete(key);
        if (requests.size === 0 && pending.get(scope) === requests) pending.delete(scope);
      };
      void operation.then(retire, retire);
      return operation;
    },
  };
}
