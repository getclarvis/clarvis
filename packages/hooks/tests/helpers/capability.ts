import {
  createCapabilityServices,
  loadEnv,
  type HookConfig,
  type RunCapabilityContext,
  type RunRequest,
} from "@clarvis/capability";

export const CONFIG = (over: Partial<HookConfig> & { event: HookConfig["event"] }): HookConfig => ({
  command: "x",
  ...over,
});

export function request(over: Partial<RunRequest> = {}): RunRequest {
  return {
    messages: [],
    servers: [],
    profiles: [],
    entry: "lead",
    budget: { on_exceed: "stop" },
    providers: [],
    ...over,
  };
}

export function context(over: Partial<RunCapabilityContext> = {}): RunCapabilityContext {
  return {
    owner: "o",
    request: request(),
    requestParam: () => undefined,
    entryGrants: [],
    env: loadEnv({}),
    workspaceRoot: "/ws",
    llm: {
      async call() {
        throw new Error("unused test LLM");
      },
    },
    emit: () => undefined,
    services: createCapabilityServices(),
    executionId: "execution",
    ...over,
  };
}
