import type { LLMToolCall } from "@clarvis/capability";
import { LOAD_SKILL_TOOL_NAME, type SkillsProvider } from "../../src/capability.ts";
import { fakeValidateArgs } from "./capability-fakes.ts";
import { makeContent, makeInfo } from "./skill-fixtures.ts";

export const validateArgs = fakeValidateArgs;

export function fakeSkills(over: Partial<SkillsProvider> = {}): SkillsProvider {
  const table = {
    alpha: makeContent("alpha", {
      resources: [{ kind: "scripts", rel: "scripts/run.sh", path: "/x/scripts/run.sh" }],
    }),
    beta: makeContent("beta", { body: "" }),
  };
  return {
    listSkills: () => [makeInfo({ name: "alpha" }), makeInfo({ name: "beta" })],
    loadSkill: (name) => (name === "alpha" || name === "beta" ? table[name] : undefined),
    readResource: () => {
      throw new Error("not configured");
    },
    ...over,
  };
}

export function call(over: Partial<LLMToolCall> = {}): LLMToolCall {
  return { id: "c1", name: LOAD_SKILL_TOOL_NAME, arguments: {}, ...over };
}
