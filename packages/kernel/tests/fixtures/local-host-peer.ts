import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectOrLaunchLocalKernel } from "../../src/hosting/launcher.ts";

const [workspaceRoot, globalDir] = process.argv.slice(2) as [string, string];
const { client } = await connectOrLaunchLocalKernel({
  workspaceRoot,
  globalDir,
  owner: "operator",
  artifactId: "process-fixture",
  command: [process.execPath, join(import.meta.dir, "local-host-process.ts")],
  environment: {
    ...process.env,
    CLARVIS_AGENT_TOOLS_ENABLED: "0",
    CLARVIS_AGENT_TOOLS_MAX_GRANT: "read",
  },
});
await client.sessions.save({
  id: "conversation",
  title: "Survive the client process",
  project_id: client.project.id,
  workspace: client.workspace.id,
  created_at: 1,
  updated_at: 1,
  turns: [],
  totals: { input: 0, output: 0, cached: 0 },
});
const session = (await client.sessions.get("conversation"))!;
const attachment = await client.hosting!.start({
  session_id: session.id,
  session_revision: session.revision!,
  kind: "conversation",
  user_preview: "Continue after this process exits",
  params: {
    execution_id: "process-run",
    agent: "solo",
    messages: [{ role: "user", content: "Complete the task." }],
  },
});
const outcome = attachment.handle.done.then(
  () => "result",
  () => "disconnected",
);
const [run] = await client.hosting!.list();
const receipt = await client.hosting!.detach({
  execution_id: run!.execution_id,
  host_generation: run!.host_generation,
  control_epoch: run!.control_epoch,
  revision: run!.revision,
  operation_id: "process-handoff",
});
await writeFile(
  join(workspaceRoot, "handoff.json"),
  JSON.stringify({
    receipt,
    clientPid: process.pid,
  }),
);
await client.close();
await outcome;
