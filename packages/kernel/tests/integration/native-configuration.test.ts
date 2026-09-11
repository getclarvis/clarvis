import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { executeRun } from "@clarvis/loop";
import { MockLLM } from "@clarvis/loop/testing";
import { globalPaths, workspacePaths } from "@clarvis/paths";
import { createFileKernel } from "../../src/bootstrap.ts";
import { settingsDocumentRevision } from "../../src/config/config-store.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("elicits before native configuration, edits through the real loop, and preserves ordinary Docker placement", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-native-configuration-"));
  temporary.push(root);
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "global");
  mkdirSync(workspaceRoot);
  mkdirSync(globalDir);
  writeFileSync(
    globalPaths(globalDir).settingsFile,
    JSON.stringify({
      default_model: "anthropic/test",
      providers: [{ name: "anthropic", kind: "anthropic" }],
      runtime: { backend: "docker", fallback: "fail" },
    }),
  );
  writeFileSync(globalPaths(globalDir).keysFile, JSON.stringify({}));
  const path = "agents/reviewer.md";
  const content = "---\ngrants: [read_workspace]\n---\nReview carefully.\n";
  const changed = content.replace("carefully", "thoroughly");
  const operation = (arguments_: Record<string, unknown>) => ({
    toolCalls: [{ name: "configure_clarvis", arguments: arguments_ }],
  });
  const llm = new MockLLM({
    script: [
      operation({ operation: "read", root: "global_clarvis", path: "keys.json" }),
      operation({
        operation: "write",
        root: "workspace_clarvis",
        path,
        content,
        expected_revision: null,
      }),
      operation({ operation: "read", root: "workspace_clarvis", path }),
      operation({
        operation: "edit",
        root: "workspace_clarvis",
        path,
        expected_revision: settingsDocumentRevision(content),
        old_text: "carefully",
        new_text: "thoroughly",
      }),
      { text: "Reviewer configured. Workspace trust is a separate operator action." },
      operation({
        operation: "write",
        root: "workspace_clarvis",
        path: "agents/auditor.md",
        content: "---\ngrants: [read_workspace]\n---\nAudit only.\n",
        expected_revision: null,
      }),
      { text: "The configuration session remains authorized." },
    ],
  });
  let nativeRuns = 0;
  let containerStarts = 0;
  const placements: string[] = [];
  const kernel = await createFileKernel({
    workspaceRoot,
    globalDir,
    defaultModel: "anthropic/test",
    logger: NOOP_LOGGER,
    env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
    subscriptions: false,
    defaultOwner: "operator",
    builtins: { tools: false, hooks: false, tasks: false },
    onRuntimePlacement: ({ status }) =>
      placements.push(status.kind === "native" ? status.isolation : status.engine),
    executeRun: async (args) => {
      expect(placements.at(-1)).toBe("host");
      nativeRuns++;
      return executeRun({ ...args, deps: { ...args.deps, llm } });
    },
    runtimeFactory: {
      create: async () => {
        containerStarts++;
        throw new Error("normal-runtime-reached");
      },
    },
  });
  try {
    const start = () =>
      kernel.runs.start({
        messages: [],
        agent: "admiral",
        skill: { name: "clarvis-configure", task: "Create a reviewer" },
        configuration_session_id: "live-tui-instance",
      });
    let approvals = 0;
    const first = await start();
    const firstEvents = Array.fromAsync(first.events);
    first.onElicit((request) => {
      approvals++;
      expect(request.kind).toBe("configuration_access");
      expect(nativeRuns).toBe(0);
      expect(containerStarts).toBe(0);
      expect(existsSync(workspacePaths(workspaceRoot).agentsDir)).toBe(false);
      void first.respond({
        id: request.id,
        action: "accept",
        content: { answer: "allow_session" },
      });
    });
    const [result, events] = await Promise.all([first.done, firstEvents]);
    expect(result.status).toBe("completed");
    expect(result.result).toContain("Reviewer configured");
    expect(nativeRuns).toBe(1);
    expect(containerStarts).toBe(0);
    expect(placements.at(-1)).toBe("docker");
    expect(readFileSync(join(workspacePaths(workspaceRoot).clarvisDir, path), "utf8")).toBe(
      changed,
    );
    expect((await kernel.config.getSettings()).workspace_trust?.state).toBe("trusted");
    expect(
      events
        .filter(
          (event): event is Extract<(typeof events)[number], { type: "tool_call" }> =>
            event.type === "tool_call" &&
            (event.tool === "configure_clarvis" || event.server === "configure_clarvis"),
        )
        .map((event) => event.agent),
    ).toEqual(["lead", "lead", "lead", "lead"]);
    expect(
      events
        .filter(
          (event): event is Extract<(typeof events)[number], { type: "tool_call" }> =>
            event.type === "tool_call" &&
            (event.tool === "configure_clarvis" || event.server === "configure_clarvis"),
        )
        .map((event) => ({ arguments: event.arguments, result: event.result })),
    ).toEqual([
      {
        arguments: { operation: "read", root: "global_clarvis", path: "keys.json" },
        result: "This path is outside authored configuration access.",
      },
      {
        arguments: { operation: "write", root: "workspace_clarvis", path },
        result: "Write completed.",
      },
      {
        arguments: { operation: "read", root: "workspace_clarvis", path },
        result: "Read completed.",
      },
      {
        arguments: { operation: "edit", root: "workspace_clarvis", path },
        result: "Edit completed.",
      },
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "delegation_created" ||
          event.type === "delegation_started" ||
          event.type === "delegation_completed" ||
          event.type === "delegation_failed",
      ),
    ).toBe(false);
    expect(events.some((event) => "agent" in event && event.agent === "subagent")).toBe(false);
    expect(events.find((event) => event.type === "run_started")).toMatchObject({
      lead_model: "anthropic/test",
    });
    expect(events.find((event) => event.type === "run_started")).not.toHaveProperty(
      "subagent_model",
    );
    const stored = await kernel.runs.get(first.execution_id);
    expect(JSON.stringify(stored)).not.toContain("live-tui-instance");
    expect(JSON.stringify(stored)).not.toContain("Review carefully.");
    expect(
      stored?.events
        .filter(
          (event): event is Extract<typeof event, { type: "tool_call" }> =>
            event.type === "tool_call" &&
            (event.tool === "configure_clarvis" || event.server === "configure_clarvis"),
        )
        .map((event) => event.agent),
    ).toEqual(["lead", "lead", "lead", "lead"]);
    expect(stored?.events.some((event) => "agent" in event && event.agent === "subagent")).toBe(
      false,
    );
    expect(stored?.result?.usage?.by_agent?.map((agent) => agent.role)).not.toContain("subagent");
    writeFileSync(
      join(workspacePaths(workspaceRoot).clarvisDir, path),
      changed.replace("thoroughly", "externally"),
    );
    expect((await kernel.config.getSettings()).workspace_trust?.state).toBe("changed");
    const second = await start();
    second.onElicit(() => {
      approvals++;
    });
    expect(await second.done).toMatchObject({ status: "completed" });
    expect((await kernel.config.getSettings()).workspace_trust?.state).toBe("changed");
    expect(approvals).toBe(1);
    kernel.nativeConfiguration.retireSession("operator", "live-tui-instance");
    const retired = await start();
    retired.onElicit((request) => {
      approvals++;
      void retired.respond({ id: request.id, action: "decline" });
    });
    const retiredResult = await retired.done;
    expect(retiredResult.error?.message).toContain("not approved");
    expect(retiredResult.status).toBe("failed");
    expect(approvals).toBe(2);
    expect(nativeRuns).toBe(2);
    const resumed = await kernel.runs.start({
      messages: [],
      skill: { name: "clarvis-configure" },
      configuration_session_id: "resumed-instance",
    });
    resumed.onElicit((request) => {
      approvals++;
      void resumed.respond({ id: request.id, action: "decline" });
    });
    expect((await resumed.done).status).toBe("failed");
    expect(nativeRuns).toBe(2);
    const ordinary = await kernel.runs.start({
      messages: [{ role: "user", content: "Continue normal work" }],
      agent: "coder",
    });
    expect((await ordinary.done).status).toBe("failed");
    expect(containerStarts).toBe(1);
    expect(nativeRuns).toBe(2);
  } finally {
    await kernel.close();
  }
});
