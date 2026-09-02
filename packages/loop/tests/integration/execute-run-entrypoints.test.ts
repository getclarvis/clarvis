import { describe, it, expect, vi } from "../bun-test.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { loadEnv } from "@clarvis/capability";
import { createConnectionManager } from "@clarvis/mcp-client";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { executeRun, type ExecuteRunDeps } from "../../src/runtime/execute-run.ts";
import type { TraceStore } from "@clarvis/trace";
import type { ToolsLogger } from "@clarvis/tools";
import type { PathsLogger } from "@clarvis/paths";
import {
  buildExecuteRunDeps,
  createHostExtensionAdmission,
  createHostModelCallAdmission,
} from "../../src/runtime/build-run-deps.ts";
import {
  createAgentToolsCapability,
  type GuardResolver,
} from "../../src/runtime/capabilities/tools.ts";
import { createAskUserCapability } from "../../src/runtime/capabilities/ask-user.ts";
import { createHooksCapability } from "@clarvis/hooks/capability";
import { createLogger } from "../../src/logger.ts";
import { ProviderError } from "@clarvis/capability";
import type { RunRequest } from "@clarvis/capability";

const REQUEST: RunRequest = {
  messages: [{ role: "user", content: "hi" }],
  servers: [],
  providers: [{ name: "anthropic", kind: "anthropic" }],
  profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
  entry: "solo",
  budget: { on_exceed: "stop", total_token_limit: 1000 },
};

function answerLLM(): MockLLM {
  return new MockLLM({
    script: [{ text: "done", usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0 } }],
  });
}

function stubDeps(
  llm: MockLLM,
  traceStore: TraceStore,
  resolveGuard?: GuardResolver,
): ExecuteRunDeps {
  const env = loadEnv({ CLARVIS_MCP_CONNECT_TIMEOUT_MS: "2000", CLARVIS_LOG_LEVEL: "silent" });
  return {
    env,
    llm,
    connections: createConnectionManager({
      workspace: process.cwd(),
      factory: mockMCPFactory({}),
      connectTimeoutMs: env.CLARVIS_MCP_CONNECT_TIMEOUT_MS,
      callTimeoutMs: env.CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS,
    }),
    traceStore,
    workspaceRoot: process.cwd(),
    capabilities: [
      createAgentToolsCapability(resolveGuard !== undefined ? { resolveGuard } : undefined),
      createAskUserCapability(),
    ],
  };
}

describe("buildExecuteRunDeps", () => {
  it("installs @clarvis/tools' warning sink, so a tool warning cannot reach a TUI's terminal", async () => {
    const { setWarnSink, warn, NOOP_TOOLS_LOGGER } = await import("@clarvis/tools");
    const records: { level: string; fields: Record<string, unknown> }[] = [];
    const capture = (level: string) => (obj: unknown) => {
      const fields = obj as Record<string, unknown>;
      if (typeof fields.event === "string" && fields.event.startsWith("tools."))
        records.push({ level, fields });
    };
    const logger = {
      debug: capture("debug"),
      info: capture("info"),
      warn: capture("warn"),
      error: capture("error"),
    };
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    const built = await buildExecuteRunDeps({
      env,
      logger,
      workspaceRoot: process.cwd(),
      builtins: { tools: true, skills: false, hooks: false },
    });
    try {
      warn("cannot read .gitignore\n", {
        event: "tools.ignore_unreadable",
        fields: { path: "/ws/.gitignore" },
      });
      warn("internal error: boom\n", { event: "tools.internal_error", level: "error" });
      warn("unmapped errno\n", {
        event: "tools.fs_error_unmapped",
        level: "debug",
        fields: { errno_code: "EPERM" },
      });
      warn("plain\n");
      expect(records).toEqual([
        {
          level: "warn",
          fields: {
            event: "tools.ignore_unreadable",
            path: "/ws/.gitignore",
            warning: "cannot read .gitignore",
          },
        },
        {
          level: "error",
          fields: { event: "tools.internal_error", warning: "internal error: boom" },
        },
        {
          level: "debug",
          fields: {
            event: "tools.fs_error_unmapped",
            errno_code: "EPERM",
            warning: "unmapped errno",
          },
        },
        { level: "warn", fields: { event: "tools.warning", warning: "plain" } },
      ]);
      expect(NOOP_TOOLS_LOGGER.warn({}, "m")).toBeUndefined();
      const asTools: ToolsLogger = createLogger("silent");
      expect(typeof asTools.debug).toBe("function");
    } finally {
      setWarnSink(null);
      await built.dispose();
    }
  });

  it("installs @clarvis/paths' diagnostics sink, so a filesystem degradation has a channel", async () => {
    const { fsyncDir, setPathsLogger, NOOP_PATHS_LOGGER } = await import("@clarvis/paths");
    const records: Record<string, unknown>[] = [];
    const capture = (obj: unknown) => {
      records.push(obj as Record<string, unknown>);
    };
    const logger = { debug: capture, info: capture, warn: capture, error: capture };
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    const built = await buildExecuteRunDeps({
      env,
      logger,
      workspaceRoot: process.cwd(),
      builtins: { tools: false, skills: false, hooks: false },
    });
    try {
      await fsyncDir(join(process.cwd(), "clarvis-absent-directory-probe"));
      expect(records.some((r) => r.event === "paths.fsync_dir_unsupported")).toBe(true);
      const asPaths: PathsLogger = createLogger("silent");
      expect(typeof asPaths.debug).toBe("function");
      expect(NOOP_PATHS_LOGGER.debug({}, "m")).toBeUndefined();
    } finally {
      setPathsLogger(null);
      await built.dispose();
    }
  });

  it("accepts one host-owned model-call gate without closing it with one kernel", async () => {
    const env = loadEnv({
      CLARVIS_LOG_LEVEL: "silent",
      CLARVIS_MAX_CONCURRENT_MODEL_CALLS: "2",
      CLARVIS_MAX_QUEUED_MODEL_CALLS: "3",
    });
    const shared = createHostModelCallAdmission(env);
    const built = await buildExecuteRunDeps({
      env,
      logger: createLogger("silent"),
      workspaceRoot: process.cwd(),
      modelCallAdmission: shared,
      builtins: { tools: false, skills: false, hooks: false },
    });
    expect(built.modelCallAdmission).toBe(shared);
    expect(shared.snapshot()).toMatchObject({ maxActive: 2, maxQueued: 3, state: "open" });
    await built.dispose();
    expect(shared.snapshot().state).toBe("open");
    shared.close();
    expect(shared.snapshot().state).toBe("closed");
  });

  it("accepts one host-owned extension gate without closing it with one kernel", async () => {
    const env = loadEnv({
      CLARVIS_LOG_LEVEL: "silent",
      CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS: "9",
      CLARVIS_MAX_CONCURRENT_EXTENSION_RUN_END_CALLS: "3",
      CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS_PER_OPERATION: "2",
    });
    const shared = createHostExtensionAdmission(env);
    const built = await buildExecuteRunDeps({
      env,
      logger: createLogger("silent"),
      workspaceRoot: process.cwd(),
      extensionAdmission: shared,
      builtins: { tools: false, skills: false, hooks: false },
    });
    expect(built.extensionAdmission).toBe(shared);
    expect(shared.snapshot()).toMatchObject({
      maxActiveNormal: 9,
      maxActiveRunEnd: 3,
      maxActivePerOperation: 2,
      state: "open",
    });
    await built.dispose();
    expect(shared.snapshot().state).toBe("open");
    shared.close();
    expect(shared.snapshot().state).toBe("closed");
  });

  it("threads traceDir through to the resolved trace store path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-lib-"));
    const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
    const built = await buildExecuteRunDeps({
      env,
      logger: createLogger(env.CLARVIS_LOG_LEVEL),
      workspaceRoot: process.cwd(),
      traceDir: dir,
    });
    try {
      expect(built.resolved.path).toBe(dir);
    } finally {
      await built.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attaches a default skills provider (enabled by default) and omits it when disabled", async () => {
    const on = await buildExecuteRunDeps({
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      logger: createLogger("silent"),
      workspaceRoot: process.cwd(),
    });
    try {
      expect(on.skills).toBeDefined();
      expect(typeof on.skills?.listSkills).toBe("function");
      expect(Array.isArray(on.skills?.listSkills())).toBe(true);
    } finally {
      await on.dispose();
    }

    const off = await buildExecuteRunDeps({
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_SKILLS_ENABLED: "false" }),
      logger: createLogger("silent"),
      workspaceRoot: process.cwd(),
    });
    try {
      expect(off.skills).toBeUndefined();
    } finally {
      await off.dispose();
    }
  });

  it("discovers extraSkillRoots but lets an operator root override them by name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-extra-roots-"));
    const write = (root: string, name: string, body: string): void => {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(
        join(root, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`,
      );
    };
    const extra = join(dir, "plugin-skills");
    const workspace = join(dir, "ws");
    write(extra, "only-in-plugin", "from plugin");
    write(extra, "contested", "from plugin");
    write(join(workspace, ".clarvis", "skills"), "contested", "from operator");

    const built = await buildExecuteRunDeps({
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      logger: createLogger("silent"),
      workspaceRoot: workspace,
      extraSkillRoots: [{ path: extra, source: "plugin" }],
    });
    try {
      const byName = new Map(built.skills!.listSkills().map((s) => [s.name, s]));
      expect(byName.get("only-in-plugin")?.description).toBe("from plugin");
      expect(byName.get("contested")?.description).toBe("from operator");
    } finally {
      await built.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an exact empty skill-root set as an intentional empty Environment", async () => {
    const logger = createLogger("silent");
    const warnSpy = vi.spyOn(logger, "warn");
    const built = await buildExecuteRunDeps({
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      logger,
      workspaceRoot: process.cwd(),
      skillRoots: () => [],
    });
    try {
      expect(built.skills?.listSkills()).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      await built.dispose();
    }
  });

  it("keeps foreground skill access available when a function-valued root provider fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-dynamic-roots-"));
    const skillDir = join(dir, "guide");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: guide\ndescription: guide\n---\n\nGuide body.\n",
    );
    let drifted = false;
    const built = await buildExecuteRunDeps({
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      logger: createLogger("silent"),
      workspaceRoot: dir,
      skillRoots: () => {
        if (drifted) throw new Error("Environment contribution drifted");
        return [{ path: dir, include: ["guide"] }];
      },
    });
    try {
      expect(built.skills?.loadSkill("guide")?.body).toBe("Guide body.");
      drifted = true;
      expect(built.skills?.loadSkill("guide")?.body).toBe("Guide body.");
    } finally {
      await built.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disables snapshot skills without blocking deps construction when pinned roots fail", async () => {
    const logger = createLogger("silent");
    const warnSpy = vi.spyOn(logger, "warn");
    const built = await buildExecuteRunDeps({
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      logger,
      workspaceRoot: process.cwd(),
      skillRoots: {
        roots: () => {
          throw new Error("pinned roots unavailable");
        },
        observe: () => {
          throw new Error("unreachable");
        },
        available: () => true,
      },
    });
    try {
      expect(built.skills).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: "skills.discovery_failed", scope: "snapshot" }),
        expect.any(String),
      );
    } finally {
      await built.dispose();
    }
  });

  it("captures exact roots once and withdraws drifted skills without rescanning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-snapshot-roots-"));
    const skillDir = join(dir, "guide");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: guide\ndescription: guide\n---\n\nGuide body.\n",
    );
    writeFileSync(join(skillDir, "reference.md"), "reference\n");
    let rootsCalls = 0;
    let observed = 0;
    let available = true;
    const built = await buildExecuteRunDeps({
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      logger: createLogger("silent"),
      workspaceRoot: dir,
      skillRoots: {
        roots: () => {
          rootsCalls += 1;
          return [{ path: dir, include: ["guide"] }];
        },
        observe: (skills) => {
          observed += 1;
          expect(skills.map((skill) => skill.name)).toEqual(["guide"]);
        },
        available: () => available,
      },
    });
    try {
      expect(built.skills!.listSkills().map((skill) => skill.name)).toEqual(["guide"]);
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: guide\ndescription: changed\n---\n\nChanged body.\n",
      );
      expect(built.skills!.loadSkill("guide")?.body).toContain("Guide body.");
      expect(built.skills!.readResource("guide", "reference.md")).toBe("reference\n");
      expect(built.skills!.readResourceChunk!("guide", "reference.md", 0, 4).text).toBe("refe");
      writeFileSync(join(skillDir, "injected.md"), "not snapshotted\n");
      expect(() => built.skills!.readResource("guide", "injected.md")).toThrow(
        /not part of the process snapshot/,
      );
      expect(() => built.skills!.readResourceChunk!("guide", "injected.md", 0, 4)).toThrow(
        /not part of the process snapshot/,
      );
      available = false;
      expect(built.skills!.listSkills()).toEqual([]);
      expect(built.skills!.loadSkill("guide")).toBeUndefined();
      expect(() => built.skills!.readResource("guide", "reference.md")).toThrow(
        /process snapshot changed/,
      );
      expect(() => built.skills!.readResourceChunk!("guide", "reference.md", 0, 4)).toThrow(
        /process snapshot changed/,
      );
      expect(rootsCalls).toBe(1);
      expect(observed).toBe(1);
    } finally {
      await built.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-derives plugin skill roots when the provider's list changes mid-session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarvis-dyn-roots-"));
    const extra = join(dir, "plugin-skills");
    const workspace = join(dir, "ws");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(extra, "late"), { recursive: true });
    writeFileSync(
      join(extra, "late", "SKILL.md"),
      `---\nname: late\ndescription: enabled later\n---\n\nlate\n`,
    );

    let roots: { path: string; source: string }[] = [];
    const built = await buildExecuteRunDeps({
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      logger: createLogger("silent"),
      workspaceRoot: workspace,
      extraSkillRoots: () => roots,
    });
    try {
      expect(built.skills!.listSkills().some((s) => s.name === "late")).toBe(false);
      roots = [{ path: extra, source: "plugin:late" }];
      expect(built.skills!.listSkills().some((s) => s.name === "late")).toBe(true);
    } finally {
      await built.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disables skills (rather than throwing) when discovery cannot resolve the workspace", async () => {
    const built = await buildExecuteRunDeps({
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      logger: createLogger("silent"),
      workspaceRoot: join(tmpdir(), "clarvis-nonexistent-ws-xyz-987"),
    });
    try {
      expect(built.skills).toBeUndefined();
    } finally {
      await built.dispose();
    }
  });

  it("rejects a blank workspaceRoot before touching any built-in", async () => {
    await expect(
      buildExecuteRunDeps({
        env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
        logger: createLogger("silent"),
        workspaceRoot: "   ",
      }),
    ).rejects.toThrow(/workspaceRoot.*non-empty path/);
  });

  it("falls back to an unavailable skills seam (rather than throwing) when a dynamic provider's roots can't be scanned", async () => {
    const diagnostics: unknown[] = [];
    const logger = createLogger("silent");
    const debugSpy = vi.spyOn(logger, "debug").mockImplementation((...args: unknown[]) => {
      diagnostics.push(args);
    });
    const built = await buildExecuteRunDeps({
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      logger,
      workspaceRoot: join(tmpdir(), "clarvis-nonexistent-ws-dynamic-987"),
      extraSkillRoots: () => {
        throw new Error("roots provider exploded");
      },
    });
    try {
      expect(built.skills!.listSkills()).toEqual([]);
      expect(built.skills!.loadSkill("anything")).toBeUndefined();
      expect(() => built.skills!.readResource("anything", "rel")).toThrow(/skills are unavailable/);
      expect(() => built.skills!.readResourceChunk!("anything", "rel", 0, 4)).toThrow(
        /skills are unavailable/,
      );
      expect(debugSpy).toHaveBeenCalled();
      expect(diagnostics.length).toBeGreaterThan(0);
    } finally {
      await built.dispose();
    }
  });

  it("lazily builds the AI SDK provider only on first call, and its client errors surface synchronously", async () => {
    const built = await buildExecuteRunDeps({
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      logger: createLogger("silent"),
      workspaceRoot: process.cwd(),
    });
    try {
      await expect(
        built.deps.llm.call({
          model: "x",
          messages: [],
          tools: [],
          provider: "anthropic",
        }),
      ).rejects.toThrow(ProviderError);
    } finally {
      await built.dispose();
    }
  });
});

describe("executeRun as the single entry contract", () => {
  it("runs an inline request with injected deps and returns a typed outcome without closing them", async () => {
    const traceStore = createMemoryTraceStore();
    const deps = stubDeps(answerLLM(), traceStore);
    const closeAll = vi.spyOn(deps.connections, "closeAll");
    const events: unknown[] = [];
    const { executionId, response } = await executeRun({
      rawBody: REQUEST,
      owner: "local",
      deps,
      onEvent: (e) => events.push(e),
      externalSignal: new AbortController().signal,
      elicit: async () => ({ action: "decline" as const }),
    });
    expect(response.status).toBe("completed");
    expect((response as { result: unknown }).result).toBe("done");
    expect(events.length).toBeGreaterThan(0);
    expect(typeof executionId).toBe("string");
    expect(executionId.length).toBeGreaterThan(0);
    expect(closeAll).not.toHaveBeenCalled();
  });

  it("routes each run under the owner passed to the call", async () => {
    const traceStore = createMemoryTraceStore();
    const a = await executeRun({
      rawBody: REQUEST,
      owner: "acme",
      deps: stubDeps(answerLLM(), traceStore),
    });
    expect(traceStore.getById("acme", a.executionId)).not.toBeNull();

    const b = await executeRun({
      rawBody: REQUEST,
      owner: "other",
      deps: stubDeps(answerLLM(), traceStore),
    });
    expect(traceStore.getById("other", b.executionId)).not.toBeNull();
    expect(traceStore.getById("acme", b.executionId)).toBeNull();
  });

  it("forwards hooks into the run (a beforeToolUse deny reaches tool dispatch)", async () => {
    const traceStore = createMemoryTraceStore();
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "read_file", arguments: { path: "x.txt" } }] },
        { text: "ok" },
      ],
    });
    const deps = stubDeps(llm, traceStore);
    const seen: string[] = [];
    const req: RunRequest = {
      ...REQUEST,
      profiles: [
        {
          name: "solo",
          model: "anthropic/x",
          tools: [],
          grants: ["read_workspace"],
          iteration_limit: 5,
        },
      ],
    };
    const { response } = await executeRun({
      rawBody: req,
      owner: "local",
      deps,
      capabilities: [
        createHooksCapability([
          {
            beforeToolUse: async (ctx) => {
              seen.push(ctx.tool);
              return { kind: "deny", message: "blocked by test" };
            },
          },
        ]),
      ],
    });
    expect(response.status).toBe("completed");
    expect(seen).toContain("read_file");
  });

  it("forwards guard/guardElicit into the run (an `ask` verdict routes to guardElicit)", async () => {
    const traceStore = createMemoryTraceStore();
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "read_file", arguments: { path: "x.txt" } }] },
        { text: "ok" },
      ],
    });
    const seenGuard: string[] = [];
    const seenElicit: string[] = [];
    const deps = stubDeps(llm, traceStore, () => ({
      guard: (ctx) => {
        seenGuard.push(ctx.tool);
        return { verdict: "ask", reason: "confirm this read" };
      },
      elicit: (r) => {
        seenElicit.push(r.tool);
        return false;
      },
    }));
    const req: RunRequest = {
      ...REQUEST,
      profiles: [
        {
          name: "solo",
          model: "anthropic/x",
          tools: [],
          grants: ["read_workspace"],
          iteration_limit: 5,
        },
      ],
    };
    const { response } = await executeRun({
      rawBody: req,
      owner: "local",
      deps,
    });
    expect(response.status).toBe("completed");
    expect(seenGuard).toContain("read_file");
    expect(seenElicit).toContain("read_file");
  });

  it("forwards a steer source whose drained message reaches the model", async () => {
    const llm = answerLLM();
    const steerText = "also verify the null path";
    let drained = false;
    const { response } = await executeRun({
      rawBody: REQUEST,
      owner: "local",
      deps: stubDeps(llm, createMemoryTraceStore()),
      steer: {
        drain: () => {
          if (drained) return [];
          drained = true;
          return [{ content: steerText }];
        },
      },
    });
    expect(response.status).toBe("completed");
    const sawSteer = llm.calls.some((c) =>
      (c.messages as Array<{ content: unknown }>).some(
        (m) => typeof m.content === "string" && m.content.includes(steerText),
      ),
    );
    expect(sawSteer).toBe(true);
  });

  it("cancels a run when the external signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const { response } = await executeRun({
      rawBody: REQUEST,
      owner: "local",
      deps: stubDeps(answerLLM(), createMemoryTraceStore()),
      externalSignal: ac.signal,
    });
    expect(response.status).toBe("cancelled");
  });
});
