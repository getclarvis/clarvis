import { expect, test } from "bun:test";
import {
  knownPlanProviderKey,
  providerPluginOptions,
  validateMemoryProviderDraft,
  validatePlanProviderDraft,
} from "../../src/adapters/capability-providers.ts";
import type { PluginView } from "../../src/adapters/plugins.ts";

function plugin(
  name: string,
  over: Partial<PluginView> & { offers?: ("memory" | "plans")[] } = {},
): PluginView {
  const { offers = ["plans"], ...rest } = over;
  return {
    name,
    scope: "global",
    source: "clarvis",
    dir: `/plugins/${name}`,
    enabled: true,
    contributions: {
      agents: [],
      brokenAgents: [],
      skills: [],
      servers: [],
      hooks: 0,
      capabilityExecutables: offers.map((capability) => ({
        capability,
        command: "python3",
        args: ["server.py", capability],
        platformOverride: false,
      })),
      executables: [],
    },
    ...rest,
  };
}

test("plugin options require installation, enablement and an executable offer", () => {
  const options = providerPluginOptions(
    [
      plugin("broken", { error: "bad manifest" }),
      plugin("disabled", { enabled: false }),
      plugin("ready"),
      plugin("no-offer", { offers: ["memory"] }),
    ],
    "plans",
    "missing",
  );
  expect(Object.fromEntries(options.map((option) => [option.name, option.gate]))).toEqual({
    broken: "broken",
    disabled: "disabled",
    missing: "not_installed",
    ready: "ready",
  });
});

test("provider keys are static for markdown and plugin selections", () => {
  expect(knownPlanProviderKey()).toBe("markdown");
  expect(knownPlanProviderKey({ kind: "plugin", plugin: "linear" })).toBe("plugin:linear");
  expect(
    knownPlanProviderKey({ kind: "executable", command: "python3", args: ["server.py"] }),
  ).toBeUndefined();
});

test("direct executable drafts validate argv and timeout", () => {
  expect(
    validatePlanProviderDraft({ provider: { kind: "executable", command: "" } }),
  ).toMatchObject({ field: "command" });
  expect(
    validatePlanProviderDraft({
      provider: { kind: "executable", command: "python3", timeout_ms: 0 },
    }),
  ).toMatchObject({ field: "timeout_ms" });
  expect(
    validateMemoryProviderDraft({
      provider: { kind: "executable", command: "python3", args: ["-B", "server.py"] },
    }),
  ).toBeNull();
  expect(
    validatePlanProviderDraft({
      provider: {
        kind: "executable",
        command: "python3",
        args: ["valid", 7] as unknown as string[],
      },
    }),
  ).toMatchObject({ field: "args" });
});

test("plan and memory budgets reject every out-of-range setting", () => {
  expect(validatePlanProviderDraft({ pending_task_nudges: -1 })).toMatchObject({
    field: "pending_task_nudges",
  });
  expect(validateMemoryProviderDraft({ budgets: { seed_chars: 499 } })).toMatchObject({
    field: "budgets.seed_chars",
  });
  expect(validateMemoryProviderDraft({ budgets: { digest_tokens: 499 } })).toMatchObject({
    field: "budgets.digest_tokens",
  });
  expect(validateMemoryProviderDraft({ budgets: { max_index_ops: 0 } })).toMatchObject({
    field: "budgets.max_index_ops",
  });
});

test("memory keeps file and MCP vocabulary validation", () => {
  expect(validateMemoryProviderDraft({ provider: { kind: "file", paths: [] } })).toMatchObject({
    field: "paths",
  });
  expect(
    validateMemoryProviderDraft({
      provider: {
        kind: "mcp",
        server: "knowledge",
        tools: {
          list_memories: "list",
          read_memory: "read",
          grep_memories: "grep",
          query_memories: "query",
          write_memory: "write",
        },
      },
    }),
  ).toMatchObject({ field: "tools.write_memory" });
});
