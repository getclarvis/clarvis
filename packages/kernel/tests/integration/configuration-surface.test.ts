import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentToText, loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { executeRun } from "@clarvis/loop";
import { MockLLM } from "@clarvis/loop/testing";
import { globalPaths, workspacePaths } from "@clarvis/paths";
import { createFileKernel } from "../../src/bootstrap.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("an empty profile exposes product documentation only to model tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-config-surface-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "global");
  mkdirSync(workspaceRoot);
  const paths = globalPaths(globalDir);
  const target = workspacePaths(workspaceRoot).settingsFile;
  const valid = JSON.stringify({ default_model: "anthropic/test" });
  mkdirSync(paths.extensionProfilesDir, { recursive: true });
  mkdirSync(paths.agentsDir, { recursive: true });
  writeFileSync(
    join(paths.agentsDir, "editor.md"),
    "---\ntools: []\ngrants: [read_workspace, edit_workspace]\n---\nEdit requested files.\n",
  );
  writeFileSync(
    join(paths.extensionProfilesDir, "empty.json"),
    JSON.stringify({ schema_version: 1, plugins: [], skills: [] }),
  );
  writeFileSync(
    paths.settingsFile,
    JSON.stringify({
      default_model: "anthropic/test",
      providers: [{ name: "anthropic", kind: "anthropic" }],
    }),
  );
  const llm = new MockLLM({
    script: [
      { toolCalls: [{ name: "load_skill", arguments: { name: "clarvis-docs" } }] },
      {
        toolCalls: [
          {
            name: "read_skill_resource",
            arguments: { name: "clarvis-docs", resource: "references/paths.md", offset: 0 },
          },
        ],
      },
      { toolCalls: [{ name: "read_file", arguments: { path: paths.settingsFile } }] },
      { toolCalls: [{ name: "write_file", arguments: { path: target, content: "{" } }] },
      { toolCalls: [{ name: "write_file", arguments: { path: target, content: valid } }] },
      { text: "The workspace setting is now valid." },
    ],
  });
  const kernel = await createFileKernel({
    workspaceRoot,
    globalDir,
    logger: NOOP_LOGGER,
    env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" }),
    extensionProfileSelector: "global:empty",
    subscriptions: false,
    builtins: { hooks: false },
    executeRun: (args) => executeRun({ ...args, deps: { ...args.deps, llm } }),
  });
  try {
    expect(await kernel.skills.list()).toEqual([]);
    await expect(kernel.skills.getPrompt("clarvis-docs")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(kernel.skills.getPrompt("clarvis-configure")).rejects.toMatchObject({
      code: "not_found",
    });
    const missing = await kernel.runs.start({
      agent: "editor",
      skill: { name: "clarvis-configure", task: "Change settings" },
      messages: [{ role: "user", content: "Change settings" }],
    });
    const missingEvents = Array.fromAsync(missing.events);
    expect(await missing.done).toMatchObject({ status: "failed", error: { code: "not_found" } });
    await missingEvents;
    await missing.closed;
    expect(llm.calls).toHaveLength(0);
    const systemStart = await kernel.runs.start({
      agent: "editor",
      skill: { name: "clarvis-docs", task: "Inspect settings" },
      messages: [{ role: "user", content: "Inspect settings" }],
    });
    const systemEvents = Array.fromAsync(systemStart.events);
    expect(await systemStart.done).toMatchObject({
      status: "failed",
      error: { code: "not_found" },
    });
    await systemEvents;
    await systemStart.closed;
    const run = await kernel.runs.start({
      agent: "editor",
      messages: [{ role: "user", content: "$clarvis-docs inspect settings" }],
    });
    const events = Array.fromAsync(run.events);
    expect(await run.done).toMatchObject({ status: "completed" });
    await events;
    await run.closed;
    const rendered = llm.calls[0]!.messages.map((message) => contentToText(message.content)).join(
      "\n",
    );
    expect(rendered).toContain("$clarvis-docs inspect settings");
    expect(rendered).toContain("**clarvis-docs**");
    expect(
      llm.calls[1]!.messages.map((message) => contentToText(message.content)).join("\n"),
    ).toContain("references/paths.md");
    expect(
      llm.calls[2]!.messages.map((message) => contentToText(message.content)).join("\n"),
    ).toContain("CLARVIS_HOME");
    expect(
      llm.calls[3]!.messages.map((message) => contentToText(message.content)).join("\n"),
    ).toContain("default_model");
    expect(readFileSync(target, "utf8")).toBe(valid);
    expect(rendered).not.toContain("# Configure Clarvis");
  } finally {
    await kernel.close();
  }
});
