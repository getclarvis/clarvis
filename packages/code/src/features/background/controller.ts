import type { HostedRunReceipt, HostedRunRef, HostingService } from "@clarvis/protocol";

/** Interactive background operations; attachment observes the existing execution until it settles. */
export interface BackgroundController {
  readonly offerOnStartup: boolean;
  list(): Promise<HostedRunRef[]>;
  background(canExit?: () => boolean): Promise<void>;
  attach(id: string, control?: "observe" | "acquire" | "takeover"): Promise<void>;
  cancel(id: string): Promise<void>;
  newConversation(): void;
}

/** Compose explicit user actions without model calls, mutation retries or persisted UI authority. */
export function createBackgroundController(deps: {
  hosting(): HostingService;
  workspaceId: string;
  offerOnStartup: boolean;
  handoff(): Promise<HostedRunReceipt>;
  attach(ref: HostedRunRef, control: "observe" | "acquire" | "takeover"): Promise<void>;
  exit(receipt: HostedRunReceipt): Promise<void>;
  newConversation(): void;
}): BackgroundController {
  let handoff: Promise<void> | undefined;
  const list = async (hosting = deps.hosting()): Promise<HostedRunRef[]> =>
    (await hosting.list()).filter((ref) => ref.workspace_id === deps.workspaceId);
  const find = async (id: string, hosting = deps.hosting()): Promise<HostedRunRef> => {
    const ref = (await list(hosting)).find((entry) => entry.execution_id === id);
    if (ref === undefined) throw new Error("Hosted run not found in this workspace.");
    return ref;
  };
  return {
    offerOnStartup: deps.offerOnStartup,
    list,
    background(canExit = () => true) {
      if (handoff !== undefined) return handoff;
      const pending = (async () => {
        const receipt = await deps.handoff();
        if (!canExit())
          throw new Error("The run is in background. The TUI stayed open to preserve your input.");
        await deps.exit(receipt);
      })();
      handoff = pending;
      void pending.then(
        () => {
          if (handoff === pending) handoff = undefined;
        },
        () => {
          if (handoff === pending) handoff = undefined;
        },
      );
      return pending;
    },
    async attach(id, control) {
      const ref = await find(id);
      await deps.attach(ref, control ?? (ref.control === "other" ? "observe" : "acquire"));
    },
    async cancel(id) {
      const hosting = deps.hosting();
      const ref = await find(id, hosting);
      if (ref.control === "other")
        throw new Error(
          "Another TUI controls this run. Take control explicitly before cancelling.",
        );
      if (ref.execution_state === "unknown" || ref.execution_state === "closed")
        throw new Error("This run has no known live execution to cancel.");
      const attachment = await hosting.attach({
        execution_id: ref.execution_id,
        host_generation: ref.host_generation,
        control: "acquire",
      });
      let failure: unknown;
      try {
        await attachment.handle.cancel();
      } catch (error) {
        failure = error;
      } finally {
        const releases = await Promise.allSettled([
          hosting.releaseSnapshot(attachment.snapshot.snapshot_id),
          hosting.releaseObservation(attachment.observation_id),
        ]);
        for (const result of releases) if (result.status === "rejected") failure ??= result.reason;
        if (ref.control === "available") {
          try {
            await hosting.closeSession(ref.session_id);
          } catch (error) {
            failure ??= error;
          }
        }
      }
      if (failure !== undefined)
        throw failure instanceof Error ? failure : new Error(String(failure));
    },
    newConversation: () => deps.newConversation(),
  };
}
