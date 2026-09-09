import { readHostedSnapshot } from "@clarvis/kernel";
import type { KernelClient, RunHandle, StartRunParams } from "@clarvis/protocol";
import { redactPreview, uuidv7 } from "./session-store.ts";

/**
 * Admit print mode through the advertised host service and present its snapshot plus live tail as
 * ordinary events. The caller drains events and waits for physical closure before closing its
 * connection. Failed admission is never retried through the connection-owned runs service.
 */
export async function startHeadlessRun(
  kernel: Pick<KernelClient, "hosting" | "project" | "workspace"> & {
    runs: Pick<KernelClient["runs"], "start">;
    sessions: Pick<KernelClient["sessions"], "get" | "save">;
  },
  params: StartRunParams & { execution_id: string },
  prompt: string,
): Promise<RunHandle> {
  const hosting = kernel.hosting;
  if (hosting === undefined) return kernel.runs.start(params);
  const id = uuidv7();
  const now = Date.now();
  await kernel.sessions.save({
    id,
    revision: 0,
    title: redactPreview(prompt, { max: 80 }),
    project_id: kernel.project.id,
    workspace: kernel.workspace.id,
    created_at: now,
    updated_at: now,
    ...(params.agent === undefined ? {} : { agent_profile: params.agent }),
    turns: [],
    totals: { input: 0, output: 0, cached: 0 },
  });
  const canonical = await kernel.sessions.get(id);
  if (canonical?.revision === undefined)
    throw new Error("The host did not confirm the new conversation revision.");
  const attachment = await hosting.start({
    session_id: id,
    session_revision: canonical.revision,
    kind: "conversation",
    user_preview: redactPreview(prompt),
    params,
  });
  return {
    ...attachment.handle,
    events: {
      async *[Symbol.asyncIterator]() {
        for await (const frame of readHostedSnapshot(hosting, attachment.snapshot))
          yield frame.event;
        for await (const frame of attachment.handle.events) yield frame.event;
      },
    },
  };
}
