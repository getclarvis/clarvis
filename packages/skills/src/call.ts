import type { LLMToolCall, TracePort } from "@clarvis/capability";
import type { AgentRole, ToolArgValidate } from "@clarvis/capability";
import { openCallEnvelope } from "@clarvis/capability";
import {
  LOAD_SKILL_TOOL_NAME,
  READ_SKILL_RESOURCE_TOOL_NAME,
  SKILL_RESOURCE_MAX_CHARS,
  loadSkillTool,
  readSkillResourceTool,
  type SkillsProvider,
} from "./tool.ts";
import {
  formatSkillBody,
  formatSkillResourceChunk,
  formatSkillResourceLegacy,
} from "./disclosure.ts";

/**
 * The result of a skill tool call: model-facing `text` and whether it is an error.
 */
export interface LoadSkillCallResult {
  text: string;
  error: boolean;
}

/** Comma-joined names of the available skills, or `(none)`, for error messages. */
function availableNames(skills: SkillsProvider): string {
  const names = skills.listSkills().map((s) => s.name);
  return names.length > 0 ? names.join(", ") : "(none)";
}

/**
 * Execute a `load_skill` call after validating its exact name-only contract.
 *
 * @param args.call - the raw call whose `arguments` carry only `name`.
 * @param args.skills - the provider that lists and loads skill bodies.
 * @param args.trace - trace sink for the tool-call lifecycle.
 * @param args.agent - the calling agent's role.
 * @param args.subagentInstanceId - present when a sub-agent makes the call.
 * @param args.iteration - the loop iteration issuing the call.
 * @returns a {@link LoadSkillCallResult}; an unknown skill or body read failure
 *   yields an `error` result rather than a throw.
 */
export function handleLoadSkillCall(args: {
  call: LLMToolCall;
  skills: SkillsProvider;
  trace: TracePort;
  agent: AgentRole;
  subagentInstanceId?: string;
  iteration: number;
  validateArgs?: ToolArgValidate;
}): LoadSkillCallResult {
  const { call, skills } = args;
  const envelope = openCallEnvelope({
    call,
    name: LOAD_SKILL_TOOL_NAME,
    trace: args.trace,
    agent: args.agent,
    ...(args.subagentInstanceId !== undefined
      ? { subagentInstanceId: args.subagentInstanceId }
      : {}),
    iteration: args.iteration,
    schema: loadSkillTool.inputSchema,
    ...(args.validateArgs !== undefined ? { validate: args.validateArgs } : {}),
  });
  const fail = (msg: string): LoadSkillCallResult => ({ text: envelope.fail(msg), error: true });
  const ok = (text: string): LoadSkillCallResult => ({ text: envelope.ok(text), error: false });

  if (envelope.invalid !== null) return fail(envelope.invalid);
  const { name } = call.arguments as { name: string };
  envelope.start();

  let content: ReturnType<SkillsProvider["loadSkill"]>;
  try {
    content = skills.loadSkill(name);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return fail(`could not load skill '${name}': ${reason}`);
  }
  if (content === undefined) {
    return fail(`unknown skill '${name}'. Available skills: ${availableNames(skills)}.`);
  }

  return ok(formatSkillBody(content));
}

/**
 * Execute `read_skill_resource` against one exact relative resource path.
 *
 * @param args.call - the raw call carrying required `name`, `resource`, and byte `offset`.
 * @param args.skills - the provider that resolves the admitted resource.
 * @param args.trace - trace sink for the tool-call lifecycle.
 * @param args.agent - the calling agent's role.
 * @param args.subagentInstanceId - present when a sub-agent makes the call.
 * @param args.iteration - the loop iteration issuing the call.
 * @param args.maxResourceChars - per-page decoded character cap.
 * @returns a {@link LoadSkillCallResult}; invalid paths, unavailable skills and
 *   provider failures are non-throwing tool errors.
 */
export function handleReadSkillResourceCall(args: {
  call: LLMToolCall;
  skills: SkillsProvider;
  trace: TracePort;
  agent: AgentRole;
  subagentInstanceId?: string;
  iteration: number;
  maxResourceChars?: number;
  validateArgs?: ToolArgValidate;
}): LoadSkillCallResult {
  const { call, skills } = args;
  const requestedMaxChars = args.maxResourceChars ?? SKILL_RESOURCE_MAX_CHARS;
  const maxChars =
    Number.isFinite(requestedMaxChars) && requestedMaxChars >= 2
      ? Math.min(Math.trunc(requestedMaxChars), SKILL_RESOURCE_MAX_CHARS)
      : SKILL_RESOURCE_MAX_CHARS;
  const envelope = openCallEnvelope({
    call,
    name: READ_SKILL_RESOURCE_TOOL_NAME,
    trace: args.trace,
    agent: args.agent,
    ...(args.subagentInstanceId !== undefined
      ? { subagentInstanceId: args.subagentInstanceId }
      : {}),
    iteration: args.iteration,
    schema: readSkillResourceTool.inputSchema,
    ...(args.validateArgs !== undefined ? { validate: args.validateArgs } : {}),
  });
  const fail = (msg: string): LoadSkillCallResult => ({ text: envelope.fail(msg), error: true });
  const ok = (text: string): LoadSkillCallResult => ({ text: envelope.ok(text), error: false });

  if (envelope.invalid !== null) return fail(envelope.invalid);
  const { name, resource, offset } = call.arguments as {
    name: string;
    resource: string;
    offset: number;
  };
  envelope.start();
  if (!skills.listSkills().some((skill) => skill.name === name)) {
    return fail(`unknown skill '${name}'. Available skills: ${availableNames(skills)}.`);
  }
  if (skills.readResourceChunk !== undefined) {
    try {
      const chunk = skills.readResourceChunk(name, resource, offset, maxChars);
      return ok(formatSkillResourceChunk(name, resource, chunk, offset, maxChars));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return fail(`could not read resource '${resource}' of skill '${name}': ${reason}`);
    }
  }
  if (offset !== 0) {
    return fail(
      `could not continue resource '${resource}' of skill '${name}': this provider does not ` +
        "support byte-offset resource pages.",
    );
  }
  let text: string;
  try {
    text = skills.readResource(name, resource);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return fail(`could not read resource '${resource}' of skill '${name}': ${reason}`);
  }
  return ok(formatSkillResourceLegacy(name, resource, text, maxChars));
}
