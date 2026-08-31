import { expect, test } from "bun:test";
import {
  isMutationTool,
  isTranscriptExternalOrchestrationTool,
  MUTATION_TOOLS,
  toolDisplayLabel,
  toolIdentity,
  toolLabel,
} from "../../src/adapters/tool-identity.ts";

test("toolIdentity: whichever slot holds the name (builtin vs namespaced)", () => {
  expect(toolIdentity("edit_file", "")).toBe("edit_file");
  expect(toolIdentity("server", "tool")).toBe("tool");
  expect(toolIdentity(undefined, undefined)).toBe("");
});

test("toolDisplayLabel translates orchestration internals but preserves MCP identity", () => {
  expect(toolDisplayLabel(undefined, "await_agents")).toBe("Wait for agents");
  expect(toolDisplayLabel(undefined, "delegate_task")).toBe("Delegate task");
  expect(toolDisplayLabel(undefined, "run_workflow")).toBe("Run workflow");
  expect(toolDisplayLabel(undefined, "run_round")).toBe("Run workflow rounds");
  expect(toolDisplayLabel(undefined, "run_work_items")).toBe("Run work items");
  expect(toolDisplayLabel("github", "search_code")).toBe("github:search_code");
});

test("transcript orchestration identity matches only bare builtins, never an MCP leaf collision", () => {
  expect(isTranscriptExternalOrchestrationTool("await_agents", "")).toBe(true);
  expect(isTranscriptExternalOrchestrationTool("await_agents", undefined)).toBe(true);
  expect(isTranscriptExternalOrchestrationTool("server", "await_agents")).toBe(false);
  expect(isTranscriptExternalOrchestrationTool("server_await_agents", undefined)).toBe(false);
});

test("toolLabel: server:tool for namespaced, bare name for builtins — never a dangling colon", () => {
  expect(toolLabel("server", "tool")).toBe("server:tool");
  expect(toolLabel("edit_file", "")).toBe("edit_file");
  expect(toolLabel(undefined, undefined)).toBe("");
});

test("toolLabel: a tool named before its server is known renders bare, never `undefined:name`", () => {
  // The composing placeholder `tool_input_delta` creates knows the tool's name
  // and nothing else — the server/tool split arrives with `tool_call_started`.
  expect(toolLabel(undefined, "create_plan")).toBe("create_plan");
  expect(toolLabel("", "write_file")).toBe("write_file");
});

test("isMutationTool resolves through the same identity rule", () => {
  expect(isMutationTool("edit_file", "")).toBe(true);
  expect(isMutationTool("server", "edit_file")).toBe(true);
  expect(isMutationTool("read_file", "")).toBe(false);
});

test("memory writes count as mutations, memory reads do not — 'rewrote PROFILE.md' must not group as a read", () => {
  expect(isMutationTool("write_memory", "")).toBe(true);
  expect(isMutationTool("edit_memory", "")).toBe(true);
  expect(isMutationTool("delete_memory", "")).toBe(true);
  expect(isMutationTool("read_memory", "")).toBe(false);
  expect(isMutationTool("list_memories", "")).toBe(false);
  expect(isMutationTool("grep_memories", "")).toBe(false);
});

test("MUTATION_TOOLS pins the registry-derived members — a registry change must be reviewed", () => {
  expect([...MUTATION_TOOLS].sort()).toEqual(
    [
      "write_file",
      "edit_file",
      "multi_edit",
      "apply_patch",
      "host_vcs",
      "replace",
      "move",
      "copy",
      "mkdir",
      "remove",
      "write_memory",
      "edit_memory",
      "delete_memory",
    ].sort(),
  );
});
