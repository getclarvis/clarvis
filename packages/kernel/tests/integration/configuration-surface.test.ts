import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentToText, loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { executeRun } from "@clarvis/loop";
import { MockLLM } from "@clarvis/loop/testing";
import { globalPaths } from "@clarvis/paths";
import { createFileKernel } from "../../src/bootstrap.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("an empty profile has no configuration guide, slash route or dollar expansion", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-config-surface-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "global");
  mkdirSync(workspaceRoot);
  const paths = globalPaths(globalDir);
  mkdirSync(paths.extensionProfilesDir, { recursive: true });
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
  const llm = new MockLLM({ script: [{ text: "No installed guide." }] });
  const kernel = await createFileKernel({
    workspaceRoot,
    globalDir,
    logger: NOOP_LOGGER,
    env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
    extensionProfileSelector: "global:empty",
    subscriptions: false,
    builtins: { hooks: false, tasks: false },
    executeRun: (args) => executeRun({ ...args, deps: { ...args.deps, llm } }),
  });
  try {
    expect(await kernel.skills.list()).toEqual([]);
    await expect(kernel.skills.getPrompt("clarvis-configure")).rejects.toMatchObject({
      code: "not_found",
    });
    const missing = await kernel.runs.start({
      agent: "coder",
      skill: { name: "clarvis-configure", task: "Change settings" },
      messages: [{ role: "user", content: "Change settings" }],
    });
    const missingEvents = Array.fromAsync(missing.events);
    expect(await missing.done).toMatchObject({ status: "failed", error: { code: "not_found" } });
    await missingEvents;
    await missing.closed;
    expect(llm.calls).toHaveLength(0);
    const run = await kernel.runs.start({
      agent: "coder",
      messages: [{ role: "user", content: "$clarvis-configure inspect settings" }],
    });
    const events = Array.fromAsync(run.events);
    expect(await run.done).toMatchObject({ status: "completed" });
    await events;
    await run.closed;
    const rendered = llm.calls[0]!.messages.map((message) => contentToText(message.content)).join(
      "\n",
    );
    expect(rendered).toContain("$clarvis-configure inspect settings");
    expect(rendered).not.toContain("# Configure Clarvis");
  } finally {
    await kernel.close();
  }
});
