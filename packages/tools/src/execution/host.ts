import type { ToolExecutionPort } from "./port.ts";

/** Compatibility executor: invoke the existing handler in the calling process. */
export const hostToolExecutor: ToolExecutionPort = {
  execute(tool, args, config, signal, hooks) {
    return tool.handler(args, config, signal, hooks);
  },
};
