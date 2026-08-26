/** Runtime fixtures for tests that intentionally execute a real loop pass. */
import type { ExecuteRunDeps } from "@clarvis/loop";
import {
  createTestRunInfrastructure,
  MockLLM,
  type MockLLMScriptStep,
} from "@clarvis/loop/testing";
import { loadEnv } from "@clarvis/capability";

import type { IndexerRuntime } from "../../src/types.ts";

/**
 * An {@link IndexerRuntime} driving a real `executeRun` over a scripted model.
 *
 * @remarks This is the harness the indexer suites run on now that a pass IS a
 * run: the four `GenerateFn` doubles this file used to export could only answer
 * one completion, which is exactly the shape the redesign removed. `MockLLM`
 * comes from the engine because it is the one that can emit tool calls, which is
 * how the indexer edits the tree at all.
 */
export function fakeIndexerRuntime(
  script: MockLLMScriptStep[],
  over: { owner?: string; workspaceRoot?: string } = {},
): { runtime: IndexerRuntime; llm: MockLLM } {
  const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
  const llm = new MockLLM({ script });
  const workspaceRoot = over.workspaceRoot ?? process.cwd();
  const infrastructure = createTestRunInfrastructure({ env, workspaceRoot });
  const deps: ExecuteRunDeps = {
    ...infrastructure,
    env,
    llm,
  };
  return {
    runtime: {
      owner: over.owner ?? "o",
      deps,
      modelRef: "anthropic/x",
      providers: [{ name: "anthropic", kind: "anthropic" }],
    },
    llm,
  };
}

/** One `write_memory` tool call, as a scripted step. */
export function writeStep(path: string, content: string): MockLLMScriptStep {
  return { toolCalls: [{ name: "write_memory", arguments: { path, content } }] };
}

/** One `edit_memory` tool call, as a scripted step. */
export function editStep(path: string, oldString: string, newString: string): MockLLMScriptStep {
  return {
    toolCalls: [
      { name: "edit_memory", arguments: { path, old_string: oldString, new_string: newString } },
    ],
  };
}
