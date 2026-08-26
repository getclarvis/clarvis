import { loadEnv, ValidationError, type EnvConfig, type RunRequest } from "@clarvis/capability";
import { parseRunRequest } from "../../src/validation/request/parsing.ts";
import type { ParsedRunRequest } from "../../src/validation/request/request-schema.ts";

export const REQUEST_ENV: EnvConfig = loadEnv({});

export const VALID_REQUEST: RunRequest = {
  messages: [{ role: "user", content: "hi" }],
  servers: [],
  profiles: [
    {
      name: "solo",
      model: "anthropic/model",
      tools: [],
      iteration_limit: 5,
    },
  ],
  entry: "solo",
  providers: [{ name: "anthropic", kind: "anthropic" }],
  budget: { on_exceed: "stop", total_token_limit: 1_000 },
};

export function parsedRequest(over: Partial<RunRequest> = {}): ParsedRunRequest {
  return parseRunRequest({ ...VALID_REQUEST, ...over });
}

export function validationCode(run: () => unknown): string {
  try {
    run();
    return "no_error";
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return error.code;
  }
}
