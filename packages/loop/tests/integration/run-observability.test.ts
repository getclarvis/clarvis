import { afterEach, describe, expect, it } from "../bun-test.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, type Capability } from "@clarvis/capability";
import { buildExecuteRunDeps } from "../../src/runtime/build-run-deps.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { recordingLogger } from "../helpers/logging.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  messages: [{ role: "user", content: "go" }],
  servers: [],
  profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 2 }],
  entry: "solo",
  budget: { on_exceed: "stop", total_token_limit: 1_000 },
  ...extra,
});

describe("run.composed", () => {
  it("states, once, what the run was assembled from", async () => {
    const logger = recordingLogger();
    const capability: Capability = {
      name: "widgets",
      reservedWireNames: ["widget_do", "widget_undo"],
      forRun: () => ({ name: "widgets", forAgent: () => null, seedBlock: () => "seed" }),
    };
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }] }),
      mcpFactory: mockMCPFactory({}),
      logger,
      capabilities: [capability],
    });

    const result = await harness.run(body());
    expect(result.status).toBe("completed");

    const composed = logger.of("run.composed");
    expect(composed).toHaveLength(1);
    expect(composed[0]?.level).toBe("info");
    expect(composed[0]?.fields).toMatchObject({
      capabilities: ["widgets"],
      builtins: { tools: false, skills: false, hooks: false },
      tools: [],
      mcp_servers: [],
      entry_agent: "solo",
      model: "anthropic/x",
      mode: "subagent-only",
      seed_blocks: 1,
    });
  });

  it("carries the run's correlation on every line the run produces", async () => {
    const logger = recordingLogger();
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }] }),
      mcpFactory: mockMCPFactory({}),
      logger,
    });

    const result = await harness.run(body());
    const [composed] = logger.of("run.composed");
    expect(composed?.fields).toMatchObject({
      execution_id: result.execution_id,
      owner_key_name: harness.owner,
      mode: "subagent-only",
    });
  });

  it("reports each capability's activation, with its declared tool count", async () => {
    const logger = recordingLogger();
    const capability: Capability = {
      name: "widgets",
      reservedWireNames: ["widget_do", "widget_undo"],
      forRun: () => ({ name: "widgets", forAgent: () => null }),
    };
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }] }),
      mcpFactory: mockMCPFactory({}),
      logger,
      capabilities: [capability],
    });

    await harness.run(body());

    const [activated] = logger.of("capability.activated");
    expect(activated?.level).toBe("debug");
    expect(activated?.fields).toMatchObject({
      capability: "widgets",
      tools: 2,
      has_seed_block: false,
    });
    expect(typeof activated?.fields.duration_ms).toBe("number");
  });

  it("says nothing at a level that discards it", async () => {
    const logger = recordingLogger("warn");
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }] }),
      mcpFactory: mockMCPFactory({}),
      logger,
      capabilities: [
        { name: "widgets", forRun: () => ({ name: "widgets", forAgent: () => null }) },
      ],
    });

    await harness.run(body());
    expect(logger.of("run.composed")).toHaveLength(0);
    expect(logger.of("capability.activated")).toHaveLength(0);
  });

  it("runs at all with no logger wired", async () => {
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }] }),
      mcpFactory: mockMCPFactory({}),
    });
    expect((await harness.run(body())).status).toBe("completed");
  });
});

describe("optional_package", () => {
  const env = () => loadEnv({ CLARVIS_LOG_LEVEL: "silent" });

  it("separates a built-in that was switched off from one that loaded", async () => {
    const logger = recordingLogger();
    const built = await buildExecuteRunDeps({
      env: env(),
      logger,
      workspaceRoot: process.cwd(),
      builtins: { tools: false, skills: true, hooks: false },
    });
    try {
      const outcomes = logger
        .of("optional_package")
        .map((line) => `${String(line.fields.feature)}:${String(line.fields.outcome)}`);
      expect(logger.of("optional_package")[0]?.level).toBe("debug");
      expect(outcomes).toContain("tools:disabled");
      expect(outcomes).toContain("hooks:disabled");
      expect(outcomes).toContain("skills:loaded");
      expect(logger.of("optional_package").map((line) => line.fields.package)).toContain(
        "@clarvis/skills",
      );
    } finally {
      await built.dispose();
    }
  });

  it("reports the hooks package loading when the host supplies its port", async () => {
    const logger = recordingLogger();
    const built = await buildExecuteRunDeps({
      env: env(),
      logger,
      workspaceRoot: process.cwd(),
      builtins: { tools: false, skills: false },
      resolveHooks: () => [],
    });
    try {
      const outcomes = logger
        .of("optional_package")
        .map((line) => `${String(line.fields.feature)}:${String(line.fields.outcome)}`);
      expect(outcomes).toContain("hooks:loaded");
      expect(built.deps.capabilities?.map((capability) => capability.name)).toContain("hooks");
    } finally {
      await built.dispose();
    }
  });

  it("reports a skill-root provider that throws, without failing the deps", async () => {
    const logger = recordingLogger();
    const built = await buildExecuteRunDeps({
      env: env(),
      logger,
      workspaceRoot: join(tmpdir(), "clarvis-observability-roots-ws"),
      builtins: { tools: false, hooks: false },
      extraSkillRoots: () => {
        throw new Error("roots provider exploded");
      },
    });
    try {
      expect(built.skills!.listSkills()).toEqual([]);
      const [line] = logger.of("skills.roots_unavailable");
      expect(line?.level).toBe("debug");
      expect(line?.fields.cause).toBe("roots provider exploded");
    } finally {
      await built.dispose();
    }
  });

  it("routes a malformed discovered skill through the structured warning sink", async () => {
    const logger = recordingLogger();
    const root = join(tmpdir(), `clarvis-malformed-skills-${String(process.pid)}`);
    mkdirSync(join(root, "broken"), { recursive: true });
    writeFileSync(join(root, "broken", "SKILL.md"), "---\nname: broken\n");
    const built = await buildExecuteRunDeps({
      env: env(),
      logger,
      workspaceRoot: process.cwd(),
      builtins: { tools: false, hooks: false },
      extraSkillRoots: [{ path: root, source: "test" }],
    });
    try {
      expect(built.skills!.listSkills().some((skill) => skill.name === "broken")).toBe(false);
      const [line] = logger.of("skills.discovery_warning");
      expect(line?.level).toBe("warn");
      expect(String(line?.fields.warning)).toContain("SKILL.md");
    } finally {
      await built.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies both logged and discarded MCP server-stderr policies", async () => {
    const server = {
      name: "stderr-fixture",
      transport: "stdio" as const,
      command: process.execPath,
      args: [fileURLToPath(new URL("../fixtures/mcp-stderr-server.ts", import.meta.url))],
    };

    for (const policy of ["log", "off"] as const) {
      const logger = recordingLogger();
      const built = await buildExecuteRunDeps({
        env: loadEnv({ CLARVIS_LOG_LEVEL: "debug", CLARVIS_MCP_SERVER_STDERR: policy }),
        logger,
        workspaceRoot: process.cwd(),
        builtins: { tools: false, skills: false, hooks: false },
      });
      try {
        const lease = await built.deps.connections.acquire({ server, owner: "test" });
        await lease.release();
        if (policy === "log") {
          expect(logger.of("mcp.server.stderr")[0]?.fields.server_output).toContain(
            "fixture diagnostic",
          );
        } else {
          expect(logger.of("mcp.server.stderr")).toHaveLength(0);
        }
      } finally {
        await built.dispose();
      }
    }
  });
});
