import { expect, test } from "bun:test";
import { createConfigService, createMemoryConfigStore } from "@clarvis/kernel/config";
import type { AgentRecord } from "@clarvis/kernel/config";
import {
  createAgentsStore,
  findAgentConflicts,
  loadAgentFiles,
  loadAgentFilesSnapshot,
} from "../../src/adapters/agents-store.ts";

function record(scope: AgentRecord["scope"], name: string, model: string): AgentRecord {
  return {
    name,
    scope,
    frontmatter: { description: `${name} in ${scope}`, model },
    body: `You are ${name} (${scope}).`,
    model,
  };
}

test("loadAgentFiles: an agent named in two roots appears once (workspace wins)", async () => {
  const config = createConfigService(
    createMemoryConfigStore({
      agents: [
        record("global", "coder", "openrouter/global-model"),
        record("workspace", "coder", "openrouter/workspace-model"),
        record("global", "explorer", "openrouter/global-model"),
      ],
    }),
  );

  const files = await loadAgentFiles(config);

  const coders = files.filter((f) => f.name === "coder");
  expect(coders).toHaveLength(1);
  expect(coders[0]!.scope).toBe("workspace");
  expect(coders[0]!.frontmatter.model).toBe("openrouter/workspace-model");
  /* `coder` and `explorer` are names Clarvis ships, so what the two roots hold
     are customizations of them — the list is the shipped fleet, in the shipped
     order, with the workspace's `coder` in effect. */
  expect(files.map((f) => f.name)).toEqual(["marshall", "admiral", "coder", "explorer", "planner"]);
});

test("findAgentConflicts: reports a name present in both scopes, excludes a non-colliding one", async () => {
  const config = createConfigService(
    createMemoryConfigStore({
      agents: [
        record("global", "coder", "openrouter/global-model"),
        record("workspace", "coder", "openrouter/workspace-model"),
        record("global", "explorer", "openrouter/global-model"),
      ],
    }),
  );

  const conflicts = findAgentConflicts(await config.listAgents());
  expect(conflicts).toEqual(["coder"]);
});

test("createAgentsStore seeded from loadAgentFilesSnapshot reports a pre-existing conflict before any reload()", async () => {
  const config = createConfigService(
    createMemoryConfigStore({
      agents: [
        record("global", "coder", "openrouter/global-model"),
        record("workspace", "coder", "openrouter/workspace-model"),
        record("global", "explorer", "openrouter/global-model"),
      ],
    }),
  );

  const snapshot = await loadAgentFilesSnapshot(config);
  const store = createAgentsStore(config, snapshot.files, snapshot.conflicts);

  expect(store.conflicts()).toEqual(["coder"]);
});

test("createAgentsStore without initial conflicts starts empty until reload() (documents the seed contract)", async () => {
  const config = createConfigService(
    createMemoryConfigStore({
      agents: [
        record("global", "coder", "openrouter/global-model"),
        record("workspace", "coder", "openrouter/workspace-model"),
      ],
    }),
  );

  const store = createAgentsStore(config, await loadAgentFiles(config));
  expect(store.conflicts()).toEqual([]);
  await store.reload();
  expect(store.conflicts()).toEqual(["coder"]);
});

test("AgentsStore delegates shared prompt reads and mutations to config", async () => {
  const config = createConfigService(createMemoryConfigStore());
  const store = createAgentsStore(config, []);

  expect((await store.sharedPrompt()).source).toBe("builtin");
  expect(
    (await store.writeSharedPrompt("global", { mode: "replace", body: "Team rules" })).source,
  ).toBe("global");
  expect((await store.sharedPrompt()).prompt).toBe("Team rules");
  await store.deleteSharedPrompt("global");
  expect((await store.sharedPrompt()).source).toBe("builtin");
});

test("AgentsStore.rename rejects across scopes", async () => {
  const config = createConfigService(
    createMemoryConfigStore({
      agents: [
        record("global", "explorer", "openrouter/global-model"),
        record("workspace", "coder", "openrouter/workspace-model"),
      ],
    }),
  );
  const store = createAgentsStore(config, await loadAgentFiles(config));

  await expect(store.rename("coder", "explorer", "workspace")).rejects.toMatchObject({
    code: "conflict",
  });
});

test("AgentsStore.read classifies a transported not_found error structurally", async () => {
  const transported = Object.assign(new Error("agent not found over stdio"), {
    code: "not_found" as const,
  });
  const config = {
    ...createConfigService(createMemoryConfigStore()),
    getAgent: async () => {
      throw transported;
    },
  };
  const store = createAgentsStore(config, []);

  expect(await store.read("missing", "workspace")).toBeNull();
});

test("findAgentConflicts: a shipped name customized in both scopes is still reported", () => {
  /* The kernel resolves a shipped name to one row, so the losing scope arrives
     on `overlay.shadowed`. Reading only `scope` here would have made a real
     cross-scope duplicate invisible for exactly the five names most likely to
     have one. */
  expect(
    findAgentConflicts([
      {
        name: "marshall",
        scope: "workspace",
        overlay: { scope: "workspace", status: "applied", shadowed: ["global"] },
      },
      { name: "planner", scope: "builtin" },
      { name: "mine", scope: "global" },
    ]),
  ).toEqual(["marshall"]);
});

test("findAgentConflicts: a shipped agent with a single customization is not a conflict", () => {
  expect(
    findAgentConflicts([
      { name: "marshall", scope: "global", overlay: { scope: "global", status: "applied" } },
      { name: "coder", scope: "builtin" },
    ]),
  ).toEqual([]);
});

test("loadAgentFiles: a refused customization is carried to the editor as an overlay", async () => {
  const config = createConfigService(
    createMemoryConfigStore({
      agents: [
        {
          name: "marshall",
          scope: "global",
          frontmatter: {},
          body: "mine",
          malformed: "bad yaml",
        },
      ],
    }),
  );

  const marshall = (await loadAgentFiles(config)).find((f) => f.name === "marshall")!;
  expect(marshall.scope).toBe("builtin");
  expect(marshall.overlay).toEqual({ scope: "global", status: "rejected", reason: "bad yaml" });
  expect(marshall.body).toContain("You are `marshall`");
});
