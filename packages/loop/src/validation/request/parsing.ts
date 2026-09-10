import type { z } from "zod";
import type { CapabilityRegistry, ErrorCode } from "@clarvis/capability";
import { ValidationError } from "@clarvis/capability";
import { runRequestSchema, type ParsedRunRequest } from "./request-schema.ts";

type ZodIssue = z.core.$ZodIssue;

function classifyIssue(issue: ZodIssue): ErrorCode {
  const path = issue.path.join(".");
  const top = issue.path[0];

  if (top === "execution_id" || top === "continue_from") {
    return "invalid_execution_id";
  }

  if (top === "session_id" || top === "agent_instance_id") {
    return "invalid_prompt_cache_key";
  }

  if (top === "prompt_cache_ttl") {
    return "invalid_prompt_cache_ttl";
  }

  if (top === "messages") {
    if (issue.path.length === 1) {
      if (issue.code === "too_small" || issue.code === "invalid_type") {
        return "messages_empty";
      }
    }
    return "invalid_message_format";
  }

  if (top === "profiles") {
    if (path.endsWith(".model") && issue.code !== "invalid_type") return "invalid_model_format";
    if (path.endsWith(".iteration_limit")) return "invalid_iteration_limit";
    return "invalid_profile";
  }

  if (top === "entry") {
    return "unknown_profile";
  }

  if (top === "elicit_wait_ms") {
    return "invalid_elicit_wait";
  }

  if (top === "budget") {
    if (path.endsWith(".on_exceed")) return "invalid_on_exceed";
    if (path.endsWith(".total_token_limit")) return "invalid_token_limit";
    if (path.endsWith(".timeout_ms")) return "invalid_timeout";
    if (path.endsWith(".max_escalations")) return "invalid_max_escalations";
    return "invalid_budget_mode";
  }

  if (top === "servers") {
    return "invalid_server_config";
  }

  if (top === "providers") {
    return "invalid_provider_config";
  }

  return "invalid_message_format";
}

function pickFirstIssue(issues: readonly ZodIssue[]): ZodIssue {
  return issues[0]!;
}

/**
 * Structurally parse a raw body with {@link runRequestSchema}, throwing a coded
 * error on the first failure.
 *
 * @param raw - the untrusted request body.
 * @returns the parsed, structurally-valid {@link ParsedRunRequest}.
 * @throws {@link ValidationError} classified via {@link classifyIssue}, carrying
 *   the first issue's message and path.
 */
/**
 * Build the request schema a host actually validates against: the engine's own
 * fields plus the per-run params its registered capabilities declared.
 *
 * @param registry - the capability registry the host filled at boot; omit for
 *   the engine's fields alone.
 * @returns the schema, strict over the union of both.
 * @throws {@link Error} when a registered spec's param collides with one the
 *   engine already owns. `.extend()` is last-wins, so the collision would
 *   silently replace the built-in field's schema for the whole host.
 * @remarks The counterpart of `settingsSchemaFor` on the request side, and it
 *   exists for the same reason: a capability shipped in its own package must be
 *   able to take a per-run parameter without the engine declaring it, while a
 *   typo in any other key is still rejected rather than silently carried. Its
 *   absence is what kept a capability's param a field the engine had to spell out.
 */
function runRequestSchemaFor(registry?: CapabilityRegistry): typeof runRequestSchema {
  const specs = registry?.specs() ?? [];
  let schema = runRequestSchema;
  for (const spec of specs) {
    if (spec.requestParams === undefined) continue;
    for (const key of Object.keys(spec.requestParams)) {
      if (key in runRequestSchema.shape) {
        throw new Error(
          `capability request param '${key}' collides with a built-in request field; ` +
            "a registered capability must declare a param the engine does not already own.",
        );
      }
    }
    schema = schema.extend(spec.requestParams) as unknown as typeof runRequestSchema;
  }
  return schema;
}

export function parseRunRequest(raw: unknown, registry?: CapabilityRegistry): ParsedRunRequest {
  const parsed = runRequestSchemaFor(registry).safeParse(raw);
  if (!parsed.success) {
    const issue = pickFirstIssue(parsed.error.issues);
    const code = classifyIssue(issue);
    throw new ValidationError(code, issue.message, { path: issue.path });
  }
  return {
    ...parsed.data,
    servers: parsed.data.servers.filter((server) => server.enabled !== false),
  };
}
