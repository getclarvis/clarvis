import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { MCPStatus } from "@clarvis/protocol";
import {
  createMcpCapabilities,
  type McpClientCaps,
  type McpEffects,
} from "../../src/adapters/mcp-capabilities-bridge.ts";
import type { LivePrompt, LiveTool, McpServerDecl } from "../../src/adapters/mcp-capabilities.ts";
import type { Commands } from "../../src/keys/commands.ts";
import { recordDiagnostics } from "../helpers/recording-diagnostics.ts";

function fakeClient(over: Partial<McpClientCaps> & { status?: MCPStatus } = {}): McpClientCaps {
  return {
    listTools: over.listTools ?? (async () => []),
    listPrompts: over.listPrompts ?? (async () => []),
    getPrompt: over.getPrompt ?? (async () => []),
    connectionStatus: over.connectionStatus ?? (() => over.status ?? "connected"),
  };
}

function fakeCommands(): {
  commands: Pick<Commands, "promptCommand" | "skillCommand">;
  registered: string[];
  disposed: string[];
} {
  const registered: string[] = [];
  const disposed: string[] = [];
  const commands = {
    promptCommand: (server: string, prompt: { name: string }, _run: () => void) => {
      const key = `${server}:${prompt.name}`;
      registered.push(key);
      return () => disposed.push(key);
    },
    skillCommand: (local: string, _prompt: { name: string }, _run: () => void) => {
      registered.push(local);
      return () => disposed.push(local);
    },
  } as unknown as Pick<Commands, "promptCommand" | "skillCommand">;
  return { commands, registered, disposed };
}

const effects: McpEffects = {
  submitPromptTurn: () => {},
  submitSkillRun: () => {},
  activeProfile: () => "answerer",
  openMcpServers: () => {},
  collectArgs: async () => null,
};

test("refresh: backend-only node when there are no live caps", async () => {
  await createRoot(async (dispose) => {
    const { commands } = fakeCommands();
    const caps = createMcpCapabilities({
      client: fakeClient({ status: "connected" }),
      commands,
      effects,
      declared: () => [],
      profiles: () => [],
    });
    await caps.refresh();
    expect(caps.nodes().map((n) => n.name)).toEqual(["kernel"]);
    expect(caps.nodes()[0]!.status).toBe("connected");
    dispose();
  });
});

test("refresh: a declared server surfaces as a 'declared' node", async () => {
  await createRoot(async (dispose) => {
    const { commands } = fakeCommands();
    const decls: McpServerDecl[] = [{ name: "git", type: "stdio", command: "git-mcp" }];
    const caps = createMcpCapabilities({
      client: fakeClient({ status: "connected" }),
      commands,
      effects,
      declared: () => decls,
      profiles: () => [],
    });
    await caps.refresh();
    expect(caps.nodes().find((n) => n.name === "git")!.status).toBe("declared");
    dispose();
  });
});

test("profile-prompts register no commands (the 12 picker owns them)", async () => {
  await createRoot(async (dispose) => {
    const { commands, registered } = fakeCommands();
    const prompts: LivePrompt[] = [{ name: "answerer" }];
    const caps = createMcpCapabilities({
      client: fakeClient({ status: "connected", listPrompts: async () => prompts }),
      commands,
      effects,
      declared: () => [],
      profiles: () => ["answerer"],
    });
    await caps.refresh();
    expect(registered).toEqual([]);
    dispose();
  });
});

test("bridge registers a bare skill command for a non-profile bare prompt; it shows on the backend node", async () => {
  await createRoot(async (dispose) => {
    const { commands, registered } = fakeCommands();
    const prompts: LivePrompt[] = [
      { name: "review-diff", description: "Review a diff." },
      { name: "answerer" },
    ];
    const caps = createMcpCapabilities({
      client: fakeClient({ status: "connected", listPrompts: async () => prompts }),
      commands,
      effects,
      declared: () => [],
      profiles: () => ["answerer"],
    });
    await caps.refresh();
    expect(registered).toEqual(["review-diff"]);
    const backend = caps.nodes().find((n) => n.name === "kernel")!;
    expect(backend.prompts.map((p) => p.name)).toEqual(["review-diff"]);
    dispose();
  });
});

test("invoking a skill command calls getPrompt with the BARE name and submits a `/name`-labelled turn", async () => {
  await createRoot(async (dispose) => {
    const calls: string[] = [];
    let submittedDisplay: string | undefined;
    let submittedBody: unknown;
    let submittedSkill: unknown;
    const skillRun = new Map<string, (args: string) => void | Promise<void>>();
    const commands = {
      promptCommand: () => () => {},
      skillCommand: (
        local: string,
        _spec: { name: string },
        run: (args: string) => void | Promise<void>,
      ) => {
        skillRun.set(local, run);
        return () => {};
      },
    } as unknown as Pick<Commands, "promptCommand" | "skillCommand">;
    const caps = createMcpCapabilities({
      client: fakeClient({
        status: "connected",
        listPrompts: async () => [{ name: "review-diff", plansMode: "off" }],
        getPrompt: async (name: string) => {
          calls.push(name);
          return [{ role: "user", content: "the full skill body" }];
        },
      }),
      commands,
      effects: {
        ...effects,
        submitPromptTurn: (messages, display, skill) => {
          submittedBody = messages[0]?.content;
          submittedDisplay = display;
          submittedSkill = skill;
        },
      },
      declared: () => [],
      profiles: () => [],
    });
    await caps.refresh();
    await skillRun.get("review-diff")!("");
    expect(calls).toEqual(["review-diff"]);
    expect(submittedDisplay).toBe("/review-diff");
    expect(submittedBody).toBe("the full skill body");
    expect(submittedSkill).toEqual({ name: "review-diff", plansMode: "off" });
    dispose();
  });
});

test("a skill naming an agent dispatches a run on it (not a lead prompt turn), and reports that agent", async () => {
  await createRoot(async (dispose) => {
    const gotPrompt: string[] = [];
    let ranName: string | undefined;
    let ranTask: string | undefined;
    let ranAgent: string | undefined;
    const skillRun = new Map<string, (args: string) => void | Promise<void>>();
    const commands = {
      promptCommand: () => () => {},
      skillCommand: (
        local: string,
        _spec: { name: string },
        run: (args: string) => void | Promise<void>,
      ) => {
        skillRun.set(local, run);
        return () => {};
      },
    } as unknown as Pick<Commands, "promptCommand" | "skillCommand">;
    const caps = createMcpCapabilities({
      client: fakeClient({
        status: "connected",
        listPrompts: async () => [{ name: "commit", agent: "coder" }, { name: "review-diff" }],
        getPrompt: async (name: string) => {
          gotPrompt.push(name);
          return [{ role: "user", content: "body" }];
        },
      }),
      commands,
      effects: {
        ...effects,
        submitSkillRun: (name, task, agent) => {
          ranName = name;
          ranTask = task;
          ranAgent = agent;
        },
      },
      declared: () => [],
      profiles: () => [],
    });
    await caps.refresh();
    expect(caps.skillAgent("commit")).toBe("coder");
    expect(caps.skillAgent("review-diff")).toBeUndefined();
    await skillRun.get("commit")!("");
    expect(ranName).toBe("commit");
    expect(ranTask).toBe("");
    expect(ranAgent).toBe("coder");
    expect(gotPrompt).toEqual([]);
    await skillRun.get("review-diff")!("");
    expect(gotPrompt).toEqual(["review-diff"]);
    dispose();
  });
});

test("a skill that vanishes stops reporting an agent", async () => {
  await createRoot(async (dispose) => {
    const { commands } = fakeCommands();
    let prompts: LivePrompt[] = [{ name: "commit", agent: "coder" }];
    const caps = createMcpCapabilities({
      client: fakeClient({ status: "connected", listPrompts: async () => prompts }),
      commands,
      effects,
      declared: () => [],
      profiles: () => [],
    });
    await caps.refresh();
    expect(caps.skillAgent("commit")).toBe("coder");
    prompts = [];
    await caps.refresh();
    expect(caps.skillAgent("commit")).toBeUndefined();
    dispose();
  });
});

test("re-list diffs skill commands: a vanished skill is disposed, a new one registered", async () => {
  await createRoot(async (dispose) => {
    const { commands, registered, disposed } = fakeCommands();
    let prompts: LivePrompt[] = [{ name: "review-diff" }];
    const caps = createMcpCapabilities({
      client: fakeClient({ status: "connected", listPrompts: async () => prompts }),
      commands,
      effects,
      declared: () => [],
      profiles: () => [],
    });
    await caps.refresh();
    expect(registered).toEqual(["review-diff"]);
    prompts = [{ name: "explain-error" }];
    await caps.refresh();
    expect(disposed).toEqual(["review-diff"]);
    expect(registered).toEqual(["review-diff", "explain-error"]);
    dispose();
  });
});

test("bridge registers downstream prompt commands; nodes strip the namespace", async () => {
  await createRoot(async (dispose) => {
    const { commands, registered } = fakeCommands();
    const tools: LiveTool[] = [{ name: "git.diff", inputSchema: {} }];
    const prompts: LivePrompt[] = [
      { name: "git:commit-msg", arguments: [{ name: "diff", required: true }] },
    ];
    const caps = createMcpCapabilities({
      client: fakeClient({
        status: "connected",
        listTools: async () => tools,
        listPrompts: async () => prompts,
      }),
      commands,
      effects,
      declared: () => [],
      profiles: () => ["answerer"],
    });
    await caps.refresh();
    expect(registered).toEqual(["git:commit-msg"]);
    const git = caps.nodes().find((n) => n.name === "git")!;
    expect(git.tools.map((t) => t.name)).toEqual(["diff"]);
    expect(git.prompts.map((p) => p.name)).toEqual(["commit-msg"]);
    dispose();
  });
});

test("re-list diffs prompt commands: a vanished prompt is disposed, a new one registered", async () => {
  await createRoot(async (dispose) => {
    const { commands, registered, disposed } = fakeCommands();
    let prompts: LivePrompt[] = [{ name: "git:commit-msg" }];
    const caps = createMcpCapabilities({
      client: fakeClient({ status: "connected", listPrompts: async () => prompts }),
      commands,
      effects,
      declared: () => [],
      profiles: () => [],
    });
    await caps.refresh();
    expect(registered).toEqual(["git:commit-msg"]);
    prompts = [{ name: "git:review" }];
    await caps.refresh();
    expect(disposed).toEqual(["git:commit-msg"]);
    expect(registered).toEqual(["git:commit-msg", "git:review"]);
    dispose();
  });
});

test("a lost/unavailable backend does not query caps", async () => {
  await createRoot(async (dispose) => {
    const { commands } = fakeCommands();
    let listed = false;
    const caps = createMcpCapabilities({
      client: fakeClient({
        status: "unavailable",
        listTools: async () => {
          listed = true;
          return [];
        },
      }),
      commands,
      effects,
      declared: () => [{ name: "git", type: "stdio", command: "git-mcp" }],
      profiles: () => [],
    });
    await caps.refresh();
    expect(listed).toBe(false);
    expect(caps.nodes()[0]!.status).toBe("unavailable");
    expect(caps.nodes().find((n) => n.name === "git")!.status).toBe("declared");
    dispose();
  });
});

test("a skill's typed arguments reach the kernel: as getPrompt's task, and as a skill run's task", async () => {
  await createRoot(async (dispose) => {
    const promptArgs: unknown[] = [];
    let skillRunTask: string | undefined;
    let submittedDisplay: string | undefined;
    const skillRun = new Map<string, (args: string) => void | Promise<void>>();
    const commands = {
      promptCommand: () => () => {},
      skillCommand: (
        local: string,
        _spec: { name: string },
        run: (args: string) => void | Promise<void>,
      ) => {
        skillRun.set(local, run);
        return () => {};
      },
    } as unknown as Pick<Commands, "promptCommand" | "skillCommand">;
    const caps = createMcpCapabilities({
      client: fakeClient({
        status: "connected",
        listPrompts: async () => [{ name: "spec" }, { name: "commit", agent: "coder" }],
        getPrompt: async (_name: string, args: unknown) => {
          promptArgs.push(args);
          return [{ role: "user", content: "body" }];
        },
      }),
      commands,
      effects: {
        ...effects,
        submitPromptTurn: (_messages, display) => {
          submittedDisplay = display;
        },
        submitSkillRun: (_name, task) => {
          skillRunTask = task;
        },
      },
      declared: () => [],
      profiles: () => [],
    });
    await caps.refresh();

    await skillRun.get("spec")!("add SSO to the admin app");
    expect(promptArgs).toEqual([{ task: "add SSO to the admin app" }]);
    expect(submittedDisplay).toBe("/spec add SSO to the admin app");

    await skillRun.get("commit")!("only the staged files");
    expect(skillRunTask).toBe("only the staged files");

    dispose();
  });
});

test("overlapping refreshes are single-flight and coalesce into one trailing response", async () => {
  await createRoot(async (disposeRoot) => {
    const { commands, registered } = fakeCommands();
    const pending: Array<(prompts: LivePrompt[]) => void> = [];
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const caps = createMcpCapabilities({
      client: fakeClient({
        listPrompts: () =>
          new Promise<LivePrompt[]>((resolve) => {
            calls += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            pending.push((prompts) => {
              active -= 1;
              resolve(prompts);
            });
          }),
      }),
      commands,
      effects,
      declared: () => [],
      profiles: () => [],
    });

    const first = caps.refresh();
    const queued = Array.from({ length: 1_000 }, () => caps.refresh());
    expect(calls).toBe(1);
    expect(active).toBe(1);

    pending.shift()!([{ name: "stale-skill" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    expect(active).toBe(1);
    expect(maxActive).toBe(1);

    pending.shift()!([{ name: "new-skill" }]);
    await Promise.all([first, ...queued]);

    expect(registered).toEqual(["new-skill"]);
    expect(caps.nodes()[0]!.prompts.map((prompt) => prompt.name)).toEqual(["new-skill"]);
    caps.dispose();
    disposeRoot();
  });
});

test("a never-settling MCP refresh does not accumulate physical requests", async () => {
  await createRoot(async (disposeRoot) => {
    const { commands } = fakeCommands();
    let promptCalls = 0;
    const caps = createMcpCapabilities({
      client: fakeClient({
        listPrompts: () => {
          promptCalls += 1;
          return new Promise<LivePrompt[]>(() => {});
        },
      }),
      commands,
      effects,
      declared: () => [],
      profiles: () => [],
      refreshSlowMs: 1,
    });

    for (let index = 0; index < 1_000; index += 1) void caps.refresh();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(promptCalls).toBe(1);
    caps.dispose();
    disposeRoot();
  });
});

test("a skill's display name reaches the command it registers", async () => {
  await createRoot(async (disposeRoot) => {
    const specs: LivePrompt[] = [];
    const caps = createMcpCapabilities({
      client: fakeClient({
        listPrompts: async () => [
          { name: "commit", description: "Short line.", displayName: "Commit Message" },
        ],
      }),
      commands: {
        promptCommand: () => () => {},
        skillCommand: (_local, spec) => {
          specs.push(spec);
          return () => {};
        },
      },
      effects,
      declared: () => [],
      profiles: () => [],
    });

    await caps.refresh();
    expect(specs).toEqual([
      {
        name: "commit",
        description: "Short line.",
        arguments: undefined,
        displayName: "Commit Message",
      },
    ]);
    caps.dispose();
    disposeRoot();
  });
});

test("changed metadata for the same skill replaces its command and closure", async () => {
  await createRoot(async (disposeRoot) => {
    const registered: string[] = [];
    const disposed: string[] = [];
    const runs = new Map<string, (args: string) => void | Promise<void>>();
    let prompts: LivePrompt[] = [{ name: "commit", description: "lead" }];
    let skillRunTask = "";
    const caps = createMcpCapabilities({
      client: fakeClient({ listPrompts: async () => prompts }),
      commands: {
        promptCommand: () => () => {},
        skillCommand: (local, _spec, run) => {
          registered.push(local);
          runs.set(local, run);
          return () => disposed.push(local);
        },
      },
      effects: {
        ...effects,
        submitSkillRun: (_name, task) => {
          skillRunTask = task;
        },
      },
      declared: () => [],
      profiles: () => [],
    });

    await caps.refresh();
    prompts = [{ name: "commit", description: "runs on coder", agent: "coder", plansMode: "off" }];
    await caps.refresh();
    await runs.get("commit")!("staged files");

    expect(registered).toEqual(["commit", "commit"]);
    expect(disposed).toEqual(["commit"]);
    expect(skillRunTask).toBe("staged files");
    expect(caps.skillAgent("commit")).toBe("coder");
    caps.dispose();
    disposeRoot();
  });
});

test("dispose unregisters commands and invalidates a refresh still in flight", async () => {
  await createRoot(async (disposeRoot) => {
    const { commands, registered, disposed } = fakeCommands();
    let resolvePrompts!: (prompts: LivePrompt[]) => void;
    const caps = createMcpCapabilities({
      client: fakeClient({
        listPrompts: () =>
          new Promise<LivePrompt[]>((resolve) => {
            resolvePrompts = resolve;
          }),
      }),
      commands,
      effects,
      declared: () => [],
      profiles: () => [],
    });

    const refresh = caps.refresh();
    caps.dispose();
    caps.dispose();
    resolvePrompts([{ name: "too-late" }]);
    await refresh;

    expect(registered).toEqual([]);
    expect(disposed).toEqual([]);
    expect(caps.nodes()).toEqual([]);
    disposeRoot();
  });
});

test("a listing that fails degrades to empty and says which half went missing", async () => {
  const recording = recordDiagnostics();
  try {
    await createRoot(async (dispose) => {
      const { commands } = fakeCommands();
      const caps = createMcpCapabilities({
        client: fakeClient({
          status: "connected",
          listTools: () => Promise.reject(new Error("tools listing refused")),
          listPrompts: () => Promise.reject(new Error("prompts listing refused")),
        }),
        commands,
        effects,
        declared: () => [],
        profiles: () => [],
      });
      await caps.refresh();
      expect(caps.nodes().map((n) => n.name)).toEqual(["kernel"]);
      dispose();
    });
  } finally {
    recording.uninstall();
  }

  const surfaces = recording.of("mcp.list.failed").map((record) => record.details.surface);
  expect(new Set(surfaces)).toEqual(new Set(["tools", "prompts"]));
  expect(recording.first("mcp.list.failed")?.level).toBe("warn");
});
