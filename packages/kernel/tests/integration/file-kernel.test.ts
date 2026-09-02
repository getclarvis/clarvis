import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, it, expect } from "bun:test";
import { loadEnv } from "@clarvis/capability";
import {
  createFileKernel,
  createKernelEnvironment,
  resolveSecretEnvironment,
} from "../../src/bootstrap.ts";
import {
  globalPaths,
  ownerSegment,
  workspacePaths,
  workspaceScopeKey,
  workspaceStatePaths,
} from "@clarvis/paths";
import { discoverGitWorkspace } from "../../src/git-workspace.ts";
import { recordingLogger } from "../helpers/logger.ts";

/** Write a fixture file, creating the scope subdirectory it now lives in. */
function seedFile(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function seedWorkspace(): string {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "clarvis-fk-")));
  mkdirSync(join(ws, ".clarvis", "agents"), { recursive: true });
  writeFileSync(
    join(ws, ".clarvis", "settings.json"),
    JSON.stringify({
      default_model: "anthropic/x",
      providers: [{ name: "anthropic", kind: "anthropic" }],
    }),
  );
  writeFileSync(
    join(ws, ".clarvis", "agents", "coder.md"),
    `---\nmodel: anthropic/x\ndescription: writes code\n---\n\nYou are a coder.\n`,
  );
  return ws;
}

/** Plant a trace file directly, dated `ageDays` in the past. */
function seedTrace(traceDir: string, owner: string, id: string, ageDays: number): string {
  const ownerDir = join(traceDir, ownerSegment(owner));
  mkdirSync(ownerDir, { recursive: true });
  const startedAt = Date.now() - ageDays * 86_400_000;
  const file = join(ownerDir, `${startedAt}.${ownerSegment(id)}.json`);
  writeFileSync(file, JSON.stringify({ id, owner_key_name: owner, started_at: startedAt }));
  return file;
}

describe("createFileKernel", () => {
  it("rejects incomplete multi-owner store wiring before boot", async () => {
    const ws = seedWorkspace();
    const base = {
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      globalDir: join(ws, "global"),
      ownershipMode: "multi" as const,
    };
    await expect(createFileKernel(base)).rejects.toThrow("requires planStoreFor");
    await expect(
      createFileKernel({
        ...base,
        memory: true,
        planStoreFor: () => {
          throw new Error("not reached");
        },
      }),
    ).rejects.toThrow("requires memoryStoreFor");

    await expect(
      createFileKernel({
        workspaceRoot: ws,
        env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
        globalDir: join(ws, "invalid-owner-cache-global"),
        ownerCache: { maxOwners: 0 },
      }),
    ).rejects.toThrow("maxOwners");
  });

  it("projects explicit loop builtin switches without enabling host capabilities", async () => {
    const ws = seedWorkspace();
    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces"),
      globalDir: join(ws, "global"),
      builtins: {
        tools: false,
        skills: false,
        hooks: false,
        tasks: false,
      },
    });

    expect(await kernel.skills.list()).toEqual([]);
    await kernel.close();
  });

  it("assembles real deps and serves settings + agents read from disk", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-fk-"));
    mkdirSync(join(ws, ".clarvis", "agents"), { recursive: true });
    writeFileSync(
      join(ws, ".clarvis", "settings.json"),
      JSON.stringify(
        { default_model: "anthropic/x", providers: [{ name: "anthropic", kind: "anthropic" }] },
        null,
        2,
      ),
    );
    writeFileSync(
      join(ws, ".clarvis", "agents", "coder.md"),
      `---\nmodel: anthropic/x\ndescription: writes code\n---\n\nYou are a coder.\n`,
    );

    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces"),
      globalDir: join(ws, "global"),
    });

    const settings = await kernel.config.getSettings();
    expect(settings.merged.default_model).toBe("anthropic/x");
    expect(settings.sources.find((s) => s.scope === "workspace")?.exists).toBe(true);

    /* The agent file was placed on disk rather than authored through the config
       service, which is indistinguishable from arriving with a clone — so it is
       withheld until approved, and its prompt cannot reach a run before then.
       `coder` is a name Clarvis ships, so the question is not whether the agent
       is listed — it always is — but whether the repository's file overlays it.
       Before approval it must not, and the listed agent must still be the one
       Clarvis ships. */
    const listedBefore = (await kernel.listAgents()).find((a) => a.name === "coder");
    expect(listedBefore?.scope).toBe("builtin");
    expect(listedBefore?.overlay).toBeUndefined();
    expect(listedBefore?.description).not.toBe("writes code");
    expect(settings.workspace_trust?.state).toBe("unapproved");

    await kernel.config.approveWorkspace();
    const listedAfter = (await kernel.listAgents()).find((a) => a.name === "coder");
    expect(listedAfter?.scope).toBe("workspace");
    expect(listedAfter?.overlay).toMatchObject({ scope: "workspace", status: "applied" });
    expect(listedAfter?.description).toBe("writes code");

    const doc = await kernel.config.getAgent("workspace", "coder");
    expect(doc.frontmatter.description).toBe("writes code");
    expect(doc.body.trim()).toBe("You are a coder.");

    await kernel.close();
  });

  /**
   * `createFileKernel` builds the plan data plane while assembling the engine's
   * deps and has to hand it to the kernel separately — the kernel's control
   * plane (`plans.list/read/setRetention/delete`) and the run's own store are
   * two consumers of one factory. When the two were wired independently the run
   * kept writing plan files while every control-plane call rejected with
   * `capability_disabled`, which reads to a user as "planning is off" on a
   * workspace where planning is plainly on.
   */
  it("serves the plans control plane, not just the run's writer", async () => {
    const ws = seedWorkspace();
    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces"),
      globalDir: join(ws, "global"),
    });

    const page = await kernel.plans.list({});
    expect(page.plans).toEqual([]);

    await kernel.close();
  });
});

describe("createFileKernel — key reconciliation", () => {
  it("resolves keyfile secrets without mutating process.env", async () => {
    const ws = seedWorkspace();
    const globalDir = join(ws, "global");
    mkdirSync(globalDir, { recursive: true });
    seedFile(
      globalPaths(globalDir).keysFile,
      JSON.stringify({
        CLARVIS_FK_AUTO_FROM_FILE: "auto-from-file",
        CLARVIS_FK_ENV_WINS: "file-loses",
        CLARVIS_FK_KEYFILE_WINS: "file-wins",
      }),
    );

    const before = { ...process.env };
    const base = createKernelEnvironment({
      CLARVIS_LOG_LEVEL: "silent",
      CLARVIS_FK_ENV_WINS: "env-wins",
      CLARVIS_FK_KEYFILE_WINS: "env-stale",
      CLARVIS_FK_STALE_LEFTOVER: "stale-leftover",
    });
    const sources = {
      CLARVIS_FK_ENV_WINS: "env",
      CLARVIS_FK_KEYFILE_WINS: "keyfile",
      CLARVIS_FK_FORCE_ENV_UNSET: "env",
      CLARVIS_FK_STALE_LEFTOVER: "keyfile",
    } as const;
    const resolved = resolveSecretEnvironment(
      base,
      {
        CLARVIS_FK_AUTO_FROM_FILE: "auto-from-file",
        CLARVIS_FK_ENV_WINS: "file-loses",
        CLARVIS_FK_KEYFILE_WINS: "file-wins",
      },
      sources,
    );
    expect(resolved.values.CLARVIS_FK_AUTO_FROM_FILE).toBe("auto-from-file");
    expect(resolved.values.CLARVIS_FK_ENV_WINS).toBe("env-wins");
    expect(resolved.values.CLARVIS_FK_KEYFILE_WINS).toBe("file-wins");
    expect(resolved.values.CLARVIS_FK_FORCE_ENV_UNSET).toBeUndefined();
    expect(resolved.values.CLARVIS_FK_STALE_LEFTOVER).toBeUndefined();

    const kernel = await createFileKernel({
      workspaceRoot: ws,
      environment: base,
      traceDir: join(ws, "traces"),
      globalDir,
      keySources: sources,
    });
    expect(process.env).toEqual(before);
    await kernel.close();
  });

  it("constructs concurrent kernels with distinct immutable credential environments", async () => {
    const firstWorkspace = seedWorkspace();
    const secondWorkspace = seedWorkspace();
    const before = { ...process.env };
    const [first, second] = await Promise.all([
      createFileKernel({
        workspaceRoot: firstWorkspace,
        environment: createKernelEnvironment({
          CLARVIS_LOG_LEVEL: "silent",
          CLARVIS_CONCURRENT_KEY: "first",
        }),
        traceDir: join(firstWorkspace, "traces"),
        globalDir: join(firstWorkspace, "global"),
      }),
      createFileKernel({
        workspaceRoot: secondWorkspace,
        environment: createKernelEnvironment({
          CLARVIS_LOG_LEVEL: "silent",
          CLARVIS_CONCURRENT_KEY: "second",
        }),
        traceDir: join(secondWorkspace, "traces"),
        globalDir: join(secondWorkspace, "global"),
      }),
    ]);

    expect(first.workspace.path).toBe(firstWorkspace);
    expect(second.workspace.path).toBe(secondWorkspace);
    expect(process.env).toEqual(before);

    await Promise.all([first.close(), second.close()]);
  });
});

describe("createFileKernel — memory settings loader", () => {
  it("leaves memory unconfigured when settings carry no memory block", async () => {
    const ws = seedWorkspace();
    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces"),
      globalDir: join(ws, "global"),
      memory: true,
    });

    await expect(kernel.memory.health()).rejects.toMatchObject({
      details: { memory_code: "MEMORY_NOT_CONFIGURED" },
    });

    await kernel.close();
  });

  it("resolves memory settings (model + providers) from merged config when memory is enabled", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-fk-"));
    mkdirSync(join(ws, ".clarvis", "agents"), { recursive: true });
    writeFileSync(
      join(ws, ".clarvis", "settings.json"),
      JSON.stringify({
        default_model: "anthropic/x",
        providers: [{ name: "anthropic", kind: "anthropic" }],
        memory: { enabled: true },
      }),
    );

    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces"),
      globalDir: join(ws, "global"),
      memory: true,
    });

    const health = await kernel.memory.health();
    expect(health.totals.documents).toBe(0);

    await kernel.close();
  });
});

describe("createFileKernel — skills roots from plugins", () => {
  it("resolves plugin skill roots (none enabled) when listing skills", async () => {
    const ws = seedWorkspace();
    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces"),
      globalDir: join(ws, "global"),
    });

    const skills = await kernel.skills.list();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.every((s) => typeof s.name === "string")).toBe(true);

    await kernel.close();
  });

  it("withdraws plugin skill drift without rejecting the next run", async () => {
    const ws = seedWorkspace();
    const globalDir = join(ws, "global");
    const pluginDir = join(globalPaths(globalDir).pluginsDir, "handbook");
    const skillFile = join(pluginDir, "skills", "guide", "SKILL.md");
    seedFile(
      globalPaths(globalDir).settingsFile,
      JSON.stringify({
        enabledPlugins: [{ scope: "global", source: "clarvis", name: "handbook" }],
      }),
    );
    seedFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "handbook" }));
    seedFile(skillFile, "---\nname: guide\ndescription: first\n---\n\nfirst\n");

    let reportDrift!: (notice: { name: string }) => void;
    const drift = new Promise<{ name: string }>((resolve) => {
      reportDrift = resolve;
    });
    const logger = recordingLogger();
    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces"),
      globalDir,
      onExtensionProfileDrift: (notice) => {
        if (notice.kind === "skill") reportDrift(notice);
      },
      logger,
    });
    try {
      expect((await kernel.skills.list()).some((skill) => skill.name === "guide")).toBe(true);
      expect(logger.events("kernel.extension_profile.skill_watch_unavailable")).toEqual([]);
      const discoveriesBeforeRun = logger.events("skills.discovered").length;
      const unreadableBeforeRun = logger.events("skill.dir_unreadable").length;

      writeFileSync(skillFile, "---\nname: guide\ndescription: second\n---\n\nsecond\n");
      const notice = await Promise.race([
        drift,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("skill drift watcher did not fire")), 2_000),
        ),
      ]);
      expect(notice.name).toBe("guide");
      expect((await kernel.skills.list()).some((skill) => skill.name === "guide")).toBe(false);

      const handle = await kernel.runs.start({
        messages: [{ role: "user", content: "hi" }],
        agent: "coder",
      });
      await handle.done;
      await handle.closed;
      expect(logger.events("skills.discovered").slice(discoveriesBeforeRun)).toEqual([]);
      expect(logger.events("skill.dir_unreadable").slice(unreadableBeforeRun)).toEqual([]);
    } finally {
      await kernel.close();
    }
  });

  it("refreshes repository plugin bytes before recording workspace approval", async () => {
    const ws = seedWorkspace();
    const globalDir = join(ws, "global");
    const pluginManifest = join(workspacePaths(ws).pluginsDir, "runner", "plugin.json");
    seedFile(pluginManifest, JSON.stringify({ name: "runner", version: "one" }));
    const first = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces-first"),
      globalDir,
    });
    expect((await first.config.getSettings()).workspace_trust?.state).toBe("unapproved");
    writeFileSync(pluginManifest, JSON.stringify({ name: "runner", version: "two" }));
    expect((await first.config.approveWorkspace()).workspace_trust?.state).toBe("trusted");
    await first.close();

    const reconnected = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces-second"),
      globalDir,
    });
    try {
      expect((await reconnected.config.getSettings()).workspace_trust?.state).toBe("trusted");
    } finally {
      await reconnected.close();
    }
  });

  it("atomically adds and revokes plugin skills when workspace trust recomposes", async () => {
    const ws = seedWorkspace();
    const globalDir = join(ws, "global");
    const pluginDir = join(workspacePaths(ws).pluginsDir, "handbook");
    seedFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "handbook" }));
    seedFile(
      join(pluginDir, "skills", "guide", "SKILL.md"),
      "---\nname: guide\ndescription: guide\n---\n\nTrusted guide.\n",
    );
    seedFile(
      join(workspacePaths(ws).extensionProfilesDir, "project.json"),
      JSON.stringify({
        schema_version: 1,
        plugins: [{ scope: "workspace", source: "clarvis", name: "handbook" }],
        skills: [],
      }),
    );
    seedFile(
      workspaceStatePaths(ws, { env: { CLARVIS_HOME: globalDir } }).extensionProfileSelectionFile,
      JSON.stringify({
        schema_version: 1,
        extension_profile: { scope: "workspace", name: "project" },
      }),
    );

    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces"),
      globalDir,
    });
    try {
      expect((await kernel.skills.list()).some((skill) => skill.name === "guide")).toBeFalse();
      await kernel.config.approveWorkspace();
      expect((await kernel.skills.list()).some((skill) => skill.name === "guide")).toBeTrue();
      expect((await kernel.skills.getPrompt("guide"))[0]?.content).toContain("Trusted guide.");
      await kernel.config.revokeWorkspace();
      expect((await kernel.skills.list()).some((skill) => skill.name === "guide")).toBeFalse();
      await expect(kernel.skills.getPrompt("guide")).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await kernel.close();
    }
  });
});

describe("createFileKernel — guard settings loader", () => {
  it("resolves guard settings from live config at run start (a run whose model call fails fast, unguarded)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "clarvis-fk-"));
    mkdirSync(join(ws, ".clarvis", "agents"), { recursive: true });
    writeFileSync(
      join(ws, ".clarvis", "settings.json"),
      JSON.stringify({
        default_model: "anthropic/x",
        providers: [
          {
            name: "anthropic",
            kind: "anthropic",
            api_key_env: "CLARVIS_FK_UNSET_TEST_KEY",
            headers: { Authorization: "Bearer ${CLARVIS_FK_HEADER_KEY}" },
            models: {
              x: {
                context_window_tokens: 1_000,
                headers: { "X-Model-Key": "${CLARVIS_FK_MODEL_HEADER_KEY}" },
              },
            },
          },
        ],
        guard: { type: "shell", mode: "off" },
      }),
    );
    writeFileSync(
      join(ws, ".clarvis", "agents", "coder.md"),
      `---\nmodel: anthropic/x\ndescription: writes code\n---\n\nYou are a coder.\n`,
    );
    delete process.env.CLARVIS_FK_UNSET_TEST_KEY;

    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(ws, "traces"),
      globalDir: join(ws, "global"),
    });

    const handle = await kernel.runs.start({
      messages: [{ role: "user", content: "hi" }],
      agent: "coder",
    });
    for await (const _ of handle.events) void _;
    const result = await handle.done;

    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("CLARVIS_FK_HEADER_KEY");
    expect(result.error?.message).toContain("CLARVIS_FK_MODEL_HEADER_KEY");

    await kernel.close();
  });
});

describe("createFileKernel — trace retention", () => {
  it("leaves every trace alone when the TTL is explicitly disabled", async () => {
    const ws = seedWorkspace();
    const traceDir = join(ws, "traces");
    const old = seedTrace(traceDir, "alice", "ancient", 400);

    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_TRACE_TTL_DAYS: "0" }),
      traceDir,
      globalDir: join(ws, "global"),
    });

    expect(existsSync(old)).toBe(true);
    await kernel.close();
  });

  it("prunes traces past the TTL on the first sweep and keeps fresher ones", async () => {
    const ws = seedWorkspace();
    const traceDir = join(ws, "traces");
    const stale = seedTrace(traceDir, "alice", "stale", 10);
    const fresh = seedTrace(traceDir, "alice", "fresh", 1);

    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_TRACE_TTL_DAYS: "5" }),
      traceDir,
      globalDir: join(ws, "global"),
    });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    await kernel.close();
  });
});

/** Plant an orphan journal — a run whose process died before it could persist. */
function seedJournal(
  traceDir: string,
  owner: string,
  id: string,
  ageHours: number,
  extraEvents: readonly Record<string, unknown>[] = [],
): string {
  const ownerDir = join(traceDir, ownerSegment(owner));
  mkdirSync(ownerDir, { recursive: true });
  const startedAt = Date.now() - ageHours * 3_600_000;
  const file = join(ownerDir, `${startedAt}.${ownerSegment(id)}.jsonl`);
  const header = {
    v: 1,
    id,
    owner_key_name: owner,
    started_at: startedAt,
    request: {
      messages: [{ role: "user", content: "x" }],
      servers: [],
      entry: "solo",
      profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 1 }],
      providers: [{ name: "anthropic", kind: "anthropic" }],
      budget: { on_exceed: "stop", total_token_limit: 1 },
    },
  };
  const iteration = {
    type: "lead_iteration",
    iteration: 1,
    started_at: startedAt,
    ended_at: startedAt + 10,
    model: "anthropic/x",
    input_tokens: 123,
    output_tokens: 7,
    cached_tokens: 0,
    cache_write_tokens: 0,
    cache_read_ratio: 0,
    response: "partial",
  };
  writeFileSync(
    file,
    `${[header, iteration, ...extraEvents].map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
  const old = new Date(startedAt);
  utimesSync(file, old, old);
  return file;
}

describe("createFileKernel — journal recovery at boot", () => {
  /**
   * Awaited, not fired and forgotten: a client lists runs the moment the kernel
   * is up, so an unawaited pass would race that listing and the recovered run
   * could simply be absent from it.
   */
  it("recovers an orphaned journal before serving, and consumes it", async () => {
    const ws = seedWorkspace();
    const traceDir = join(ws, "traces");
    const journal = seedJournal(traceDir, "alice", "exec-dead", 3);

    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir,
      globalDir: join(ws, "global"),
    });

    const record = `${journal.slice(0, -".jsonl".length)}.json`;
    expect(existsSync(record)).toBe(true);
    expect(existsSync(journal)).toBe(false);

    const stored = JSON.parse(readFileSync(record, "utf8")) as {
      status: string;
      total_input_tokens: number;
      final_context?: unknown;
    };
    expect(stored.status).toBe("interrupted");
    expect(stored.total_input_tokens).toBe(123);
    expect(stored.final_context).toBeUndefined();

    await kernel.close();
  });

  it("preserves and rehydrates workflow-owned contributed events from an orphan journal", async () => {
    const ws = seedWorkspace();
    const traceDir = join(ws, "traces");
    const globalDir = join(ws, "global");
    const identity = await discoverGitWorkspace(ws);
    const owner = workspaceScopeKey("alice", identity.project.id, identity.workspace.id);
    const persistedEdge = {
      type: "workflow_run_started",
      run_id: "leader-1",
      parent_run_id: "exec-workflow",
      started_at: 7,
      task: "inspect",
      profile: "researcher",
    };
    const journal = seedJournal(traceDir, owner, "exec-workflow", 3, [persistedEdge]);

    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir,
      globalDir,
    });

    const record = `${journal.slice(0, -".jsonl".length)}.json`;
    const stored = JSON.parse(readFileSync(record, "utf8")) as {
      trace: { events: Record<string, unknown>[] };
    };
    expect(stored.trace.events).toContainEqual(persistedEdge);

    const detail = await kernel.forOwner("alice").runs.get("exec-workflow");
    expect(detail.events).toContainEqual({
      type: "workflow_run_started",
      at: 7,
      run_id: "leader-1",
      parent_run_id: "exec-workflow",
      profile: "researcher",
      title: "inspect",
      task: "inspect",
    });

    await kernel.close();
  });

  /**
   * REGRESSION: recovery used to run *after* `cleanup.start()`, whose immediate
   * sweep aged journals on the same orphan grace that makes them recoverable.
   * With a TTL configured the sweep deleted precisely the journals recovery
   * existed to read, so crash recovery was inert for every operator who set one
   * — invisible in tests only because the TTL defaults to 0.
   */
  it("recovers an orphaned journal even with trace retention enabled", async () => {
    const ws = seedWorkspace();
    const traceDir = join(ws, "traces");
    const journal = seedJournal(traceDir, "alice", "exec-ttl", 3);

    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_TRACE_TTL_DAYS: "30" }),
      traceDir,
      globalDir: join(ws, "global"),
    });

    const record = `${journal.slice(0, -".jsonl".length)}.json`;
    expect(existsSync(record)).toBe(true);
    expect(existsSync(journal)).toBe(false);
    await kernel.close();
  });

  it("leaves a journal younger than the orphan grace alone", async () => {
    const ws = seedWorkspace();
    const traceDir = join(ws, "traces");
    const journal = seedJournal(traceDir, "alice", "exec-young", 0);

    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir,
      globalDir: join(ws, "global"),
    });

    expect(existsSync(journal)).toBe(true);
    await kernel.close();
  });

  /**
   * Recovery is a best-effort improvement over having lost the run entirely.
   * Refusing to boot because the pass itself failed would turn a degraded
   * outcome into a total one — so a throw is logged and swallowed, not fatal.
   */
  it("boots when the trace store cannot even be scanned", async () => {
    const ws = seedWorkspace();
    const traceDir = join(ws, "traces");
    writeFileSync(traceDir, "this is a file, not a directory");

    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir,
      globalDir: join(ws, "global"),
    });

    const settings = await kernel.config.getSettings();
    expect(settings.merged.default_model).toBe("anthropic/x");
    await kernel.close();
  });

  it("boots normally when the journal is unreadable", async () => {
    const ws = seedWorkspace();
    const traceDir = join(ws, "traces");
    const ownerDir = join(traceDir, ownerSegment("alice"));
    mkdirSync(ownerDir, { recursive: true });
    const bad = join(ownerDir, `${Date.now() - 7_200_000}.${ownerSegment("exec-bad")}.jsonl`);
    writeFileSync(bad, "{ truncated");
    const old = new Date(Date.now() - 7_200_000);
    utimesSync(bad, old, old);

    const kernel = await createFileKernel({
      workspaceRoot: ws,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      traceDir,
      globalDir: join(ws, "global"),
    });

    expect(existsSync(bad)).toBe(false);
    expect(existsSync(`${bad.slice(0, -".jsonl".length)}.jsonl.corrupt`)).toBe(true);
    await kernel.close();
  });
});

describe("kernel boot is no longer dark", () => {
  it("reports what it started with, which capabilities composed, and when it is ready", async () => {
    const ws = seedWorkspace();
    const logger = recordingLogger();
    const kernel = await createFileKernel({
      workspaceRoot: ws,
      globalDir: join(ws, "global"),
      defaultModel: "anthropic/x",
      memory: false,
      logger,
    });
    try {
      const started = logger.events("kernel.boot.started")[0];
      expect(started).toMatchObject({
        workspace_root: ws,
        ownership_mode: "single",
        memory_enabled: false,
        default_model: "anthropic/x",
      });
      expect(logger.events("kernel.config.scopes")[0]).toMatchObject({
        workspace_present: true,
        global_present: false,
        plugin_scopes: 0,
      });
      const composed = Object.fromEntries(
        logger
          .events("kernel.capability.composed")
          .map((event) => [event.capability, event.enabled]),
      );
      expect(composed).toMatchObject({
        hooks: true,
        plans: true,
        memory: false,
        tasks: true,
      });
      const ready = logger.events("kernel.boot.ready")[0];
      expect(typeof ready?.duration_ms).toBe("number");
      expect(ready?.recovered_runs).toBe(0);
      expect(String(ready?.capabilities)).toContain("memory");
      expect(logger.events("kernel.capabilities.registered")[0]?.specs).toContain("plans");
    } finally {
      await kernel.close();
    }
  });

  it("records a host-disabled capability as disabled", async () => {
    const ws = seedWorkspace();
    const logger = recordingLogger();
    const kernel = await createFileKernel({
      workspaceRoot: ws,
      globalDir: join(ws, "global"),
      builtins: { tasks: false, hooks: false },
      logger,
    });
    try {
      const composed = Object.fromEntries(
        logger
          .events("kernel.capability.composed")
          .map((event) => [event.capability, [event.enabled, event.reason]]),
      );
      expect(composed.tasks).toEqual([false, "host_disabled"]);
      expect(composed.hooks).toEqual([false, "host_disabled"]);
    } finally {
      await kernel.close();
    }
  });

  it("does not report hooks enabled for a kernel whose runs will load none", async () => {
    // The loop requires builtins.hooks, CLARVIS_HOOKS_ENABLED and a resolver to
    // agree; reporting the first conjunct alone announced hooks for a kernel
    // that would run none.
    const ws = seedWorkspace();
    const logger = recordingLogger();
    const kernel = await createFileKernel({
      workspaceRoot: ws,
      globalDir: join(ws, "global"),
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_HOOKS_ENABLED: "false" }),
      logger,
    });
    try {
      const hooks = logger
        .events("kernel.capability.composed")
        .find((event) => event.capability === "hooks");
      expect([hooks?.enabled, hooks?.reason]).toEqual([false, "env_disabled"]);
    } finally {
      await kernel.close();
    }
  });
});
