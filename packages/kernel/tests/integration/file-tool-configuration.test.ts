import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentToText, loadEnv, NOOP_LOGGER, OPERATOR_AUTHORITY_PORT } from "@clarvis/capability";
import { installAuthorityEnvelope } from "../../src/guard/operator-authority.ts";
import { executeRun } from "@clarvis/loop";
import { MockLLM } from "@clarvis/loop/testing";
import { configurationRoots, globalPaths, workspacePaths } from "@clarvis/paths";
import { createFileKernel } from "../../src/bootstrap.ts";
import { tools as nativeFileTools } from "@clarvis/tools";
import { effectReviewInput, withHostValidatedEffectReview } from "../helpers/effect-review-llm.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("validates operational settings from write_file before one host review", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-file-settings-"));
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
    }),
  );
  const target = workspacePaths(workspaceRoot).settingsFile;
  const valid = JSON.stringify({ default_model: "anthropic/test" });
  const agent = new MockLLM({
    script: [
      { toolCalls: [{ name: "write_file", arguments: { path: target, content: "{" } }] },
      { toolCalls: [{ name: "write_file", arguments: { path: target, content: valid } }] },
      { text: "Finished." },
    ],
  });
  const kernel = await createFileKernel({
    workspaceRoot,
    globalDir,
    logger: NOOP_LOGGER,
    env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" }),
    subscriptions: false,
    builtins: { hooks: false, tasks: false },
    executeRun: (args) => executeRun({ ...args, deps: { ...args.deps, llm: agent } }),
  });
  try {
    let prompts = 0;
    const run = await kernel.runs.start({
      agent: "marshall",
      guard_mode: "on",
      messages: [{ role: "user", content: "Write valid local settings." }],
    });
    run.onElicit((request) => {
      prompts++;
      expect(request.kind).toBe("configuration_review");
      expect(request.prompt).toContain(target);
      void run.respond({ id: request.id, action: "accept", content: { decision: "allow" } });
    });
    const events = Array.fromAsync(run.events);
    expect(await run.done).toMatchObject({ status: "completed" });
    await events;
    await run.closed;
    expect(prompts).toBe(1);
    expect(readFileSync(target, "utf8")).toBe(valid);
    expect(nativeFileTools).toHaveLength(20);
    const offered = agent.calls[0]!.tools.map((tool) => tool.wireName);
    expect(offered.filter((name) => nativeFileTools.some((tool) => tool.name === name))).toEqual(
      nativeFileTools.map((tool) => tool.name),
    );
    expect(offered).not.toContain("configure_clarvis");
    expect(
      agent.calls[0]!.messages.map((message) => contentToText(message.content)).join("\n"),
    ).not.toContain("Configuration roots:");
  } finally {
    await kernel.close();
  }
});

it("writes and reads admitted global configuration through ordinary file tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-global-file-tools-"));
  temporary.push(root);
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "global");
  const homeDir = join(root, "home");
  mkdirSync(workspaceRoot);
  mkdirSync(globalDir);
  mkdirSync(homeDir);
  writeFileSync(
    globalPaths(globalDir).settingsFile,
    JSON.stringify({
      default_model: "anthropic/test",
      providers: [{ name: "anthropic", kind: "anthropic" }],
    }),
  );
  const target = join(globalDir, "shared-agent.md");
  const sharedTarget = join(
    configurationRoots({ workspaceRoot, globalDir, home: homeDir }).global_agents,
    "plugins/example/README.md",
  );
  const agent = new MockLLM({
    script: [
      {
        toolCalls: [
          { name: "write_file", arguments: { path: target, content: "Global guide.\n" } },
        ],
      },
      { toolCalls: [{ name: "read_file", arguments: { path: target } }] },
      {
        toolCalls: [
          {
            name: "edit_file",
            arguments: { path: target, old_string: "Global guide.", new_string: "Global review." },
          },
        ],
      },
      { toolCalls: [{ name: "read_file", arguments: { path: target } }] },
      {
        toolCalls: [
          {
            name: "write_file",
            arguments: { path: sharedTarget, content: "Shared plugin guide.\n" },
          },
        ],
      },
      { toolCalls: [{ name: "read_file", arguments: { path: sharedTarget } }] },
      { text: "Finished." },
    ],
  });
  const kernel = await createFileKernel({
    workspaceRoot,
    globalDir,
    configurationHome: homeDir,
    logger: NOOP_LOGGER,
    env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
    subscriptions: false,
    builtins: { hooks: false, tasks: false },
    executeRun: (args) => executeRun({ ...args, deps: { ...args.deps, llm: agent } }),
  });
  try {
    let prompts = 0;
    const reviewedPrompts: string[] = [];
    const run = await kernel.runs.start({
      agent: "coder",
      guard_mode: "on",
      messages: [{ role: "user", content: "Write and read a global guide." }],
    });
    run.onElicit((request) => {
      prompts++;
      expect(request.kind).toBe("configuration_review");
      reviewedPrompts.push(request.prompt);
      void run.respond({ id: request.id, action: "accept", content: { decision: "allow" } });
    });
    const events = Array.fromAsync(run.events);
    expect(await run.done).toMatchObject({ status: "completed" });
    await events;
    await run.closed;
    expect(prompts).toBe(3);
    expect(reviewedPrompts[0]).toContain(`write ${target}`);
    expect(reviewedPrompts[1]).toContain(`edit ${target}`);
    expect(reviewedPrompts[2]).toContain(`write ${sharedTarget}`);
    expect(readFileSync(target, "utf8")).toBe("Global review.\n");
    expect(readFileSync(sharedTarget, "utf8")).toBe("Shared plugin guide.\n");
    expect(
      agent.calls
        .at(-1)
        ?.messages.some(
          (message) =>
            message.role === "tool" && contentToText(message.content).includes("Global review."),
        ),
    ).toBe(true);
  } finally {
    await kernel.close();
  }
});

it("reuses session consent for the same file-tool effect and asks for a new target", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-file-session-consent-"));
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
    }),
  );
  const first = join(workspacePaths(workspaceRoot).clarvisDir, "shared-agent.md");
  const second = workspacePaths(workspaceRoot).guardJudgeFile;
  const agent = new MockLLM({
    script: [
      { toolCalls: [{ name: "write_file", arguments: { path: first, content: "First.\n" } }] },
      { toolCalls: [{ name: "write_file", arguments: { path: first, content: "Second.\n" } }] },
      { toolCalls: [{ name: "write_file", arguments: { path: second, content: "Third.\n" } }] },
      { text: "Finished." },
    ],
  });
  const kernel = await createFileKernel({
    workspaceRoot,
    globalDir,
    logger: NOOP_LOGGER,
    env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
    subscriptions: false,
    builtins: { hooks: false, tasks: false },
    executeRun: (args) => executeRun({ ...args, deps: { ...args.deps, llm: agent } }),
  });
  try {
    let prompts = 0;
    const run = await kernel.runs.start({
      agent: "coder",
      guard_mode: "on",
      messages: [{ role: "user", content: "Update the local guidance and Judge guidance." }],
    });
    run.onElicit((request) => {
      prompts++;
      expect(request.kind).toBe("configuration_review");
      void run.respond({
        id: request.id,
        action: "accept",
        content: { decision: prompts === 1 ? "allow_session" : "allow" },
      });
    });
    const events = Array.fromAsync(run.events);
    expect(await run.done).toMatchObject({ status: "completed" });
    await events;
    await run.closed;
    expect(prompts).toBe(2);
    expect(readFileSync(first, "utf8")).toBe("Second.\n");
    expect(readFileSync(second, "utf8")).toBe("Third.\n");
  } finally {
    await kernel.close();
  }
});

it("uses an accepted ask_user authorization in the following configuration review", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-elicited-configuration-"));
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
      guard: { type: "shell", mode: "auto" },
    }),
  );
  const skillRoot = join(workspaceRoot, ".agents/skills/review-docs");
  const target = join(skillRoot, "references/coverage-matrix.md");
  mkdirSync(join(skillRoot, "references"), { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    "---\nname: review-docs\ndescription: Review documentation coverage.\n---\nReview it.\n",
  );
  const original = "SAFE-09 pending\nSAFE-10 pending\nSAFE-11 pending\n";
  const updated = "SAFE-09 covered\nSAFE-10 covered\nSAFE-11 covered\n";
  writeFileSync(target, original);
  const agent = new MockLLM({
    script: [
      {
        toolCalls: [
          {
            name: "ask_user",
            arguments: {
              question: "Authorize updating SAFE-09 through SAFE-11 in the coverage matrix?",
              options: ["Authorize the three lines", "Do not update"],
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "edit_file",
            arguments: {
              path: target,
              old_string: original,
              new_string: updated,
            },
          },
        ],
      },
      { text: "Coverage updated." },
    ],
  });
  const reviewed = withHostValidatedEffectReview(agent);
  let reviewerEvidence: Array<Record<string, unknown>> | undefined;
  const reviewerRevisions: Array<{ snapshot: number; installed?: number }> = [];
  const kernel = await createFileKernel({
    workspaceRoot,
    globalDir,
    logger: NOOP_LOGGER,
    env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
    subscriptions: false,
    builtins: { hooks: false, tasks: false },
    executeRun: (args) =>
      executeRun({
        ...args,
        deps: {
          ...args.deps,
          capabilities: [
            ...(args.deps.capabilities ?? []),
            {
              name: "prior-outcome-fixture",
              required: true,
              forRun(ctx) {
                const authority = ctx.services.get(OPERATOR_AUTHORITY_PORT)!;
                const state = authority.snapshot();
                expect(
                  installAuthorityEnvelope(authority, {
                    version: 1,
                    revision: state.revision,
                    objectives: [
                      {
                        id: "inspect-only",
                        summary: "Inspect the documentation coverage",
                        target_digests: [],
                        evidence_ids: state.evidence.map((entry) => entry.id),
                      },
                    ],
                    grants: [],
                    exclusions: [],
                  }),
                ).toBe(true);
                return { name: "prior-outcome-fixture", forAgent: () => ({ attach: () => ({}) }) };
              },
            },
          ],
          llm: {
            async call(params) {
              if (
                params.agentInstanceId === "judge" &&
                params.tools?.[0]?.wireName === "judge_step"
              ) {
                const input = effectReviewInput(params);
                reviewerEvidence = input.snapshot.operator_evidence;
                reviewerRevisions.push({
                  snapshot: input.snapshot.authority.revision,
                  installed: input.transition?.revision,
                });
              }
              return reviewed.call(params);
            },
          },
        },
      }),
  });
  try {
    const run = await kernel.runs.start({
      agent: "marshall",
      messages: [{ role: "user", content: "Inspect the remaining documentation coverage." }],
      guard_mode: "auto",
    });
    let questions = 0;
    run.onElicit((request) => {
      questions++;
      expect(request.kind).toBe("ask_user");
      void run.respond({
        id: request.id,
        action: "accept",
        content: { response: "Authorize the three lines" },
      });
    });
    const events = Array.fromAsync(run.events);
    expect(await run.done).toMatchObject({ status: "completed" });
    await events;
    await run.closed;
    expect(questions).toBe(1);
    expect(readFileSync(target, "utf8")).toBe(updated);
    expect(reviewerRevisions).toHaveLength(2);
    expect(reviewerRevisions[0]!.installed).toBeUndefined();
    expect(reviewerRevisions[1]!.snapshot).toBe(reviewerRevisions[0]!.snapshot);
    expect(reviewerRevisions[1]!.installed).toBeGreaterThan(reviewerRevisions[0]!.snapshot);
    expect(reviewerEvidence?.at(-1)).toMatchObject({
      source: "ask_user",
      prompt: "Authorize updating SAFE-09 through SAFE-11 in the coverage matrix?",
      text: "Authorize the three lines",
    });
  } finally {
    await kernel.close();
  }
});

it("makes an agent-authored standalone skill available on the next run without workspace approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-inert-skill-refresh-"));
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
    }),
  );
  const target = join(workspacePaths(workspaceRoot).skillsDir, "local-check/SKILL.md");
  const skill =
    "---\nname: local-check\ndescription: Check local fixtures.\n---\nCheck fixtures.\n";
  const agent = new MockLLM({
    script: [
      { toolCalls: [{ name: "write_file", arguments: { path: target, content: skill } }] },
      { text: "Created." },
      { toolCalls: [{ name: "load_skill", arguments: { name: "local-check" } }] },
      { text: "Used." },
    ],
  });
  const llm = withHostValidatedEffectReview(agent);
  const kernel = await createFileKernel({
    workspaceRoot,
    globalDir,
    logger: NOOP_LOGGER,
    env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
    subscriptions: false,
    builtins: { hooks: false, tasks: false },
    executeRun: (args) => executeRun({ ...args, deps: { ...args.deps, llm } }),
  });
  try {
    expect((await kernel.extensionProfiles.current()).id).toBe("builtin:default");
    expect((await kernel.config.getSettings()).workspace_trust?.state).toBe("inert");
    let prompts = 0;
    for (const message of ["Create the local skill.", "Use the local skill."]) {
      const run = await kernel.runs.start({
        agent: "coder",
        messages: [{ role: "user", content: message }],
        guard_mode: "auto",
      });
      run.onElicit((request) => {
        prompts++;
        void run.respond({ id: request.id, action: "accept", content: { decision: "allow" } });
      });
      const events = Array.fromAsync(run.events);
      expect(await run.done).toMatchObject({ status: "completed" });
      await events;
      await run.closed;
    }
    expect(prompts).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(skill);
    expect((await kernel.config.getSettings()).workspace_trust?.state).toBe("inert");
    expect((await kernel.extensionProfiles.current()).standalone_skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: { scope: "workspace", source: "clarvis", name: "local-check" },
          active: true,
        }),
      ]),
    );
    expect((await kernel.skills.list()).map((item) => item.name)).toContain("local-check");
    expect(
      agent.calls
        .at(-1)
        ?.messages.map((item) => contentToText(item.content))
        .join("\n"),
    ).toContain("Check fixtures.");
  } finally {
    await kernel.close();
  }
});

it.each(["auto", "on", "off"] as const)(
  "creates, loads and edits through ordinary file tools under %s without activation prompts",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-direct-configuration-"));
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
        guard: { type: "shell", mode: "auto" },
      }),
    );
    const content = "---\ngrants: [read_workspace]\n---\nReview tests.\n";
    const skill =
      "---\nname: review-tests\ndescription: Review local tests.\n---\nCheck assertions and fixtures.\n";
    const agent = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              name: "write_file",
              arguments: {
                path: join(workspacePaths(workspaceRoot).clarvisDir, "agents/reviewer.md"),
                content,
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "write_file",
              arguments: {
                path: join(
                  workspacePaths(workspaceRoot).clarvisDir,
                  "skills/review-tests/SKILL.md",
                ),
                content: skill,
              },
            },
          ],
        },
        { text: "Reviewer ready." },
        { toolCalls: [{ name: "load_skill", arguments: { name: "review-tests" } }] },
        { text: "Skill used." },
        {
          toolCalls: [
            {
              name: "edit_file",
              arguments: {
                path: join(workspacePaths(workspaceRoot).skillsDir, "review-tests/SKILL.md"),
                old_string: "Check assertions and fixtures.",
                new_string: "Check assertions, fixtures and cancellation.",
              },
            },
          ],
        },
        { text: "Skill updated." },
        { toolCalls: [{ name: "load_skill", arguments: { name: "review-tests" } }] },
        { text: "Updated skill used." },
      ],
    });
    const llm = withHostValidatedEffectReview(agent);
    const kernel = await createFileKernel({
      workspaceRoot,
      globalDir,
      logger: NOOP_LOGGER,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      subscriptions: false,
      builtins: { hooks: false, tasks: false },
      executeRun: (args) => executeRun({ ...args, deps: { ...args.deps, llm } }),
    });
    try {
      const run = await kernel.runs.start({
        agent: "coder",
        messages: [
          {
            role: "user",
            content: "Create a local read-only agent reviewer and a review-tests skill for tests.",
          },
        ],
        guard_mode: mode,
      });
      let prompts = 0;
      run.onElicit((request) => {
        prompts++;
        expect(request.kind).toBe("configuration_review");
        void run.respond({ id: request.id, action: "accept", content: { decision: "allow" } });
      });
      const events = Array.fromAsync(run.events);
      const result = await run.done;
      await events;
      await run.closed;
      expect(result).toMatchObject({ status: "completed" });
      expect(prompts).toBe(mode === "on" ? 2 : 0);
      expect(
        readFileSync(join(workspacePaths(workspaceRoot).agentsDir, "reviewer.md"), "utf8"),
      ).toBe(content);
      expect((await kernel.config.getSettings()).workspace_trust?.state).toBe("trusted");
      expect((await kernel.skills.list()).map((item) => item.name)).toContain("review-tests");
      for (const content of [
        "Use the review-tests skill.",
        "Improve the review-tests skill to check cancellation too.",
        "Use the updated review-tests skill.",
      ]) {
        const next = await kernel.runs.start({
          agent: "coder",
          messages: [{ role: "user", content }],
          guard_mode: mode,
        });
        next.onElicit((request) => {
          prompts++;
          expect(request.kind).toBe("configuration_review");
          void next.respond({ id: request.id, action: "accept", content: { decision: "allow" } });
        });
        const drained = Array.fromAsync(next.events);
        expect(await next.done).toMatchObject({ status: "completed" });
        await drained;
        await next.closed;
      }
      const disclosed = (index: number) =>
        agent.calls[index]!.messages.map((message) => contentToText(message.content)).join("\n");
      expect(disclosed(4)).toContain("Check assertions and fixtures.");
      expect(disclosed(8)).toContain("Check assertions, fixtures and cancellation.");
      expect(prompts).toBe(mode === "on" ? 3 : 0);
    } finally {
      await kernel.close();
    }
  },
);

it.each(["deny", "drift", "steer"] as const)(
  "does not mutate operational settings after %s during concrete human review",
  async (decision) => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-direct-review-"));
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
      }),
    );
    const target = workspacePaths(workspaceRoot).settingsFile;
    mkdirSync(join(target, ".."), { recursive: true });
    const concurrent = JSON.stringify({ default_model: "anthropic/concurrent" });
    const agent = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              name: "write_file",
              arguments: {
                path: target,
                content: JSON.stringify({ default_model: "anthropic/requested" }),
              },
            },
          ],
        },
        { text: "Change was not applied." },
      ],
    });
    const kernel = await createFileKernel({
      workspaceRoot,
      globalDir,
      logger: NOOP_LOGGER,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      subscriptions: false,
      builtins: { hooks: false, tasks: false },
      executeRun: (args) => executeRun({ ...args, deps: { ...args.deps, llm: agent } }),
    });
    try {
      const run = await kernel.runs.start({
        agent: "coder",
        guard_mode: "on",
        messages: [
          { role: "user", content: "Change the workspace default model to anthropic/requested." },
        ],
      });
      let prompts = 0;
      run.onElicit((request) => {
        prompts++;
        expect(request.kind).toBe("configuration_review");
        expect(request.prompt).toContain("settings.json");
        expect(existsSync(target)).toBe(false);
        if (decision === "drift") writeFileSync(target, concurrent);
        if (decision === "steer")
          void run
            .steer("Do not change settings. Revoke this pending write.")
            .catch(() => undefined);
        void run.respond({
          id: request.id,
          action: "accept",
          content: {
            decision: decision === "deny" ? "deny" : "allow",
          },
        });
      });
      const events = Array.fromAsync(run.events);
      expect(await run.done).toMatchObject({ status: "completed" });
      await events;
      await run.closed;
      expect(prompts).toBe(1);
      if (decision !== "drift") expect(existsSync(target)).toBe(false);
      else expect(readFileSync(target, "utf8")).toBe(concurrent);
      const transcript = agent.calls[1]!.messages.map((message) =>
        contentToText(message.content),
      ).join("\n");
      expect(transcript).toContain(
        decision === "deny"
          ? "not approved"
          : decision === "steer"
            ? "authority changed during review"
            : "revision conflict",
      );
    } finally {
      await kernel.close();
    }
  },
);

it.each(["auto", "on", "drift"] as const)(
  "includes a created skill in a local copy of the active global profile under %s review",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-direct-membership-"));
    temporary.push(root);
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    mkdirSync(workspaceRoot);
    const paths = globalPaths(globalDir);
    mkdirSync(paths.extensionProfilesDir, { recursive: true });
    mkdirSync(join(paths.extensionProfileSelectionFile, ".."), { recursive: true });
    const definition = JSON.stringify({ schema_version: 1, plugins: [], skills: [] });
    const selection = JSON.stringify({
      schema_version: 1,
      extension_profile: { scope: "global", name: "custom" },
    });
    writeFileSync(join(paths.extensionProfilesDir, "custom.json"), definition);
    writeFileSync(paths.extensionProfileSelectionFile, selection);
    writeFileSync(
      paths.settingsFile,
      JSON.stringify({
        default_model: "anthropic/test",
        providers: [{ name: "anthropic", kind: "anthropic" }],
      }),
    );
    const content = "---\nname: new-review\ndescription: Review tests\n---\nCheck fixtures.\n";
    const agent = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              name: "write_file",
              arguments: {
                path: join(workspacePaths(workspaceRoot).skillsDir, "new-review-package/SKILL.md"),
                content,
              },
            },
          ],
        },
        { text: "Created and selected." },
        { toolCalls: [{ name: "load_skill", arguments: { name: "new-review" } }] },
        { text: "Used." },
      ],
    });
    const llm = withHostValidatedEffectReview(agent);
    const options = {
      workspaceRoot,
      globalDir,
      logger: NOOP_LOGGER,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      subscriptions: false as const,
      builtins: { hooks: false, tasks: false },
    };
    const kernel = await createFileKernel({
      ...options,
      executeRun: (args) => executeRun({ ...args, deps: { ...args.deps, llm } }),
    });
    let prompts = 0;
    try {
      const run = await kernel.runs.start({
        agent: "coder",
        guard_mode: mode === "auto" ? "auto" : "on",
        messages: [
          {
            role: "user",
            content: "Create a local new-review skill and make it available in this environment",
          },
        ],
      });
      run.onElicit((request) => {
        prompts++;
        expect(request.kind).toBe("configuration_review");
        expect(request.prompt).toContain("include_new_skill");
        if (mode === "drift")
          writeFileSync(
            join(paths.extensionProfilesDir, "custom.json"),
            JSON.stringify({ ...JSON.parse(definition), description: "External revision" }),
          );
        void run.respond({ id: request.id, action: "accept", content: { decision: "allow" } });
      });
      const events = Array.fromAsync(run.events);
      expect(await run.done).toMatchObject({ status: "completed" });
      await events;
      await run.closed;
      expect(prompts).toBe(mode === "auto" ? 0 : 1);
      if (mode === "drift") {
        expect(
          existsSync(
            join(workspacePaths(workspaceRoot).skillsDir, "new-review-package", "SKILL.md"),
          ),
        ).toBeFalse();
        expect(readFileSync(paths.extensionProfileSelectionFile, "utf8")).toBe(selection);
        expect(readFileSync(join(paths.extensionProfilesDir, "custom.json"), "utf8")).toContain(
          "External revision",
        );
        return;
      }
      expect((await kernel.skills.list()).map((skill) => skill.name)).toContain("new-review");
      const profile = await kernel.extensionProfiles.current();
      expect(profile.ref.scope).toBe("workspace");
      expect(profile.definition?.skills).toEqual([
        { scope: "workspace", source: "clarvis", name: "new-review" },
      ]);
      expect(readFileSync(paths.extensionProfileSelectionFile, "utf8")).toBe(selection);
      expect(readFileSync(join(paths.extensionProfilesDir, "custom.json"), "utf8")).toBe(
        definition,
      );
      const use = await kernel.runs.start({
        agent: "coder",
        messages: [{ role: "user", content: "Use new-review" }],
      });
      const useEvents = Array.fromAsync(use.events);
      expect(await use.done).toMatchObject({ status: "completed" });
      await useEvents;
      await use.closed;
      expect(
        agent.calls[3]!.messages.map((message) => contentToText(message.content)).join("\n"),
      ).toContain("Check fixtures.");
    } finally {
      await kernel.close();
    }
    const reopened = await createFileKernel(options);
    try {
      expect((await reopened.skills.list()).map((skill) => skill.name)).toContain("new-review");
      expect((await reopened.extensionProfiles.current()).ref.scope).toBe("workspace");
    } finally {
      await reopened.close();
    }
  },
);

it.each(["allow", "deny", "drift", "invalid"] as const)(
  "reviews a complete mixed patch once and preserves every target on %s failure",
  async (decision) => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-authoring-batch-"));
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
      }),
    );
    const target = join(workspacePaths(workspaceRoot).agentsDir, "batch-review.md");
    const relativeTarget = target.slice(workspaceRoot.length + 1).replaceAll("\\", "/");
    const patch = `*** Begin Patch\n*** Add File: ordinary.txt\n+Requested content\n*** Add File: ${relativeTarget}\n+---\n+${decision === "invalid" ? "sandbox: false" : "grants: [read_workspace]"}\n+---\n+Review tests.\n*** End Patch`;
    const agent = new MockLLM({
      script: [
        { toolCalls: [{ name: "apply_patch", arguments: { patch } }] },
        { text: "Finished." },
      ],
    });
    const llm = withHostValidatedEffectReview(agent);
    const kernel = await createFileKernel({
      workspaceRoot,
      globalDir,
      logger: NOOP_LOGGER,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      subscriptions: false,
      builtins: { hooks: false, tasks: false },
      executeRun: (args) => executeRun({ ...args, deps: { ...args.deps, llm } }),
    });
    try {
      let prompts = 0;
      const run = await kernel.runs.start({
        agent: "coder",
        guard_mode: "on",
        messages: [
          {
            role: "user",
            content: "Create ordinary.txt and the read-only batch-review agent in one patch.",
          },
        ],
      });
      run.onElicit((request) => {
        prompts++;
        expect(request.kind).toBe("configuration_review");
        expect(request.prompt).toContain("ordinary.txt");
        expect(request.prompt).toContain("batch-review.md");
        if (decision === "drift")
          writeFileSync(join(workspaceRoot, "ordinary.txt"), "Concurrent bytes\n");
        void run.respond({
          id: request.id,
          action: "accept",
          content: { decision: decision === "deny" ? "deny" : "allow" },
        });
      });
      const events = Array.fromAsync(run.events);
      await run.done;
      await events;
      await run.closed;
      expect(prompts).toBe(decision === "invalid" ? 0 : 1);
      expect(existsSync(target)).toBe(decision === "allow");
      if (decision === "allow") {
        expect(readFileSync(join(workspaceRoot, "ordinary.txt"), "utf8")).toBe(
          "Requested content\n",
        );
        expect((await kernel.config.getSettings()).workspace_trust?.state).toBe("trusted");
      } else if (decision === "drift")
        expect(readFileSync(join(workspaceRoot, "ordinary.txt"), "utf8")).toBe(
          "Concurrent bytes\n",
        );
      else expect(existsSync(join(workspaceRoot, "ordinary.txt"))).toBeFalse();
    } finally {
      await kernel.close();
    }
  },
);

it("reviews copy, rename, recursive replacement and removal without activating a second time", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-authoring-operations-"));
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
    }),
  );
  const paths = workspacePaths(workspaceRoot);
  mkdirSync(paths.clarvisDir, { recursive: true });
  const operational = JSON.stringify({ default_model: "anthropic/assertions" });
  writeFileSync(paths.settingsFile, operational);
  const source = join(paths.agentsDir, "original.md");
  const copied = join(paths.agentsDir, "copied.md");
  const moved = join(paths.agentsDir, "moved.md");
  const calls = [
    { name: "write_file", arguments: { path: source, content: "Review assertions.\n" } },
    { name: "copy", arguments: { source, destination: copied } },
    { name: "move", arguments: { source: copied, destination: moved } },
    {
      name: "replace",
      arguments: {
        path: paths.clarvisDir,
        pattern: "assertions",
        replacement: "cancellation",
        dry_run: false,
      },
    },
    { name: "remove", arguments: { path: moved } },
  ];
  const agent = new MockLLM({
    script: [...calls.map((call) => ({ toolCalls: [call] })), { text: "Finished." }],
  });
  const llm = withHostValidatedEffectReview(agent);
  const kernel = await createFileKernel({
    workspaceRoot,
    globalDir,
    logger: NOOP_LOGGER,
    env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
    subscriptions: false,
    builtins: { hooks: false, tasks: false },
    executeRun: (args) => executeRun({ ...args, deps: { ...args.deps, llm } }),
  });
  try {
    let prompts = 0;
    const run = await kernel.runs.start({
      agent: "coder",
      guard_mode: "on",
      messages: [
        {
          role: "user",
          content:
            "Create original, copy it, rename the copy, replace assertions with cancellation in both agents, and delete the renamed copy.",
        },
      ],
    });
    run.onElicit((request) => {
      prompts++;
      expect(request.kind).toBe("configuration_review");
      void run.respond({ id: request.id, action: "accept", content: { decision: "allow" } });
    });
    const events = Array.fromAsync(run.events);
    await run.done;
    await events;
    await run.closed;
    expect(
      agent.calls
        .at(-1)
        ?.messages.filter((message) => message.role === "tool")
        .map((message) => contentToText(message.content))
        .join("\n"),
    ).not.toMatch(/no matches|Failed|denied|Error/);
    expect(readFileSync(paths.settingsFile, "utf8")).toBe(
      operational.replace("assertions", "cancellation"),
    );
    expect(prompts).toBe(5);
    expect(readFileSync(source, "utf8")).toBe("Review cancellation.\n");
    expect(existsSync(copied)).toBeFalse();
    expect(existsSync(moved)).toBeFalse();
    expect((await kernel.config.getSettings()).workspace_trust?.state).toBe("trusted");
  } finally {
    await kernel.close();
  }
});

it("reviews a corrected document independently after a concrete human refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-corrected-review-"));
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
    }),
  );
  const target = join(workspacePaths(workspaceRoot).agentsDir, "reviewer.md");
  const original = "---\ngrants: [read_workspace]\n---\nReview tests and change code.\n";
  const corrected =
    "---\ngrants: [read_workspace]\n---\nReview tests and report findings without changing code.\n";
  const agent = new MockLLM({
    script: [
      ...[original, original, corrected].map((content) => ({
        toolCalls: [
          {
            name: "write_file",
            arguments: {
              path: target,
              content,
            },
          },
        ],
      })),
      { text: "Corrected reviewer ready." },
    ],
  });
  const kernel = await createFileKernel({
    workspaceRoot,
    globalDir,
    logger: NOOP_LOGGER,
    env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
    subscriptions: false,
    builtins: { hooks: false, tasks: false },
    executeRun: (args) => executeRun({ ...args, deps: { ...args.deps, llm: agent } }),
  });
  try {
    const run = await kernel.runs.start({
      agent: "coder",
      guard_mode: "on",
      messages: [
        {
          role: "user",
          content: "Create a read-only reviewer that reports test findings without changing code.",
        },
      ],
    });
    let prompts = 0;
    run.onElicit((request) => {
      prompts++;
      expect(request.kind).toBe("configuration_review");
      expect(existsSync(target)).toBe(false);
      expect(request.prompt).toContain(prompts === 1 ? "change code" : "without changing code");
      void run.respond({
        id: request.id,
        action: "accept",
        content: { decision: prompts === 1 ? "deny" : "allow" },
      });
    });
    const events = Array.fromAsync(run.events);
    expect(await run.done).toMatchObject({ status: "completed" });
    await events;
    await run.closed;
    expect(prompts).toBe(2);
    expect(readFileSync(target, "utf8")).toBe(corrected);
    expect(
      agent.calls[2]!.messages.map((message) => contentToText(message.content)).join("\n"),
    ).toContain("already refused");
    expect(
      agent.calls[1]!.messages.map((message) => contentToText(message.content)).join("\n"),
    ).toContain("not approved");
  } finally {
    await kernel.close();
  }
});
