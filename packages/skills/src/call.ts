import type { SkillResource } from "./types.ts";
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
import { MAX_SKILL_RESOURCE_FILE_BYTES } from "./limits.ts";

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
 * Render the trailing "Bundled resources" hint listing a skill's resources and
 * how to fetch one; empty when the skill bundles none.
 */
function renderResourceList(resources: readonly SkillResource[]): string {
  if (resources.length === 0) return "";
  const lines = resources.map((r) => `- ${r.rel} (${r.kind})`).join("\n");
  return (
    `\n\nBundled resources (call ${READ_SKILL_RESOURCE_TOOL_NAME} with name, the exact ` +
    `resource path, and offset=0):\n${lines}`
  );
}

function validateResourceChunk(
  chunk: ReturnType<NonNullable<SkillsProvider["readResourceChunk"]>>,
  requestedOffset: number,
  maxChars: number,
): string | undefined {
  if (!Number.isSafeInteger(chunk.offset) || chunk.offset !== requestedOffset) {
    return "provider returned a mismatched resource offset";
  }
  if (
    !Number.isSafeInteger(chunk.totalBytes) ||
    chunk.totalBytes < 0 ||
    chunk.totalBytes > MAX_SKILL_RESOURCE_FILE_BYTES ||
    chunk.offset > chunk.totalBytes
  ) {
    return "provider returned an invalid resource size";
  }
  if (chunk.text.length > maxChars) return "provider exceeded the resource character bound";
  const decodedEnd = chunk.offset + Buffer.byteLength(chunk.text, "utf8");
  if (decodedEnd > chunk.totalBytes) return "provider returned text past the resource size";
  if (chunk.nextOffset !== undefined) {
    if (
      !Number.isSafeInteger(chunk.nextOffset) ||
      chunk.nextOffset <= chunk.offset ||
      chunk.nextOffset > chunk.totalBytes
    ) {
      return "provider returned an invalid resource continuation offset";
    }
    if (chunk.nextOffset !== decodedEnd) {
      return "provider returned a continuation offset that does not match its text";
    }
    if (decodedEnd === chunk.totalBytes) {
      return "provider returned a redundant continuation offset at the resource end";
    }
  } else if (decodedEnd !== chunk.totalBytes) {
    return "provider omitted a required resource continuation offset";
  }
  return undefined;
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

  const body = content.body.length > 0 ? content.body : "(this skill has an empty body)";
  const executionHint =
    content.executionRoot === undefined
      ? ""
      : `Package execution root: ${content.executionRoot}\n` +
        "Run bundled helpers through the normal shell tool so its command guard applies. " +
        "When a native sandbox is active, the package root is mounted read-only.\n";
  return ok(
    `Skill '${content.name}' — ${content.description}\n\n` +
      `Skill directory: ${content.dir}\n` +
      "Resolve bundled relative paths from that directory.\n" +
      executionHint +
      "\n" +
      `${body}${renderResourceList(content.resources)}`,
  );
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
      const invalidChunk = validateResourceChunk(chunk, offset, maxChars);
      if (invalidChunk !== undefined) throw new Error(invalidChunk);
      const continuation =
        chunk.nextOffset === undefined
          ? ""
          : `\n\n[resource continues; call ${READ_SKILL_RESOURCE_TOOL_NAME} with the same name ` +
            `and resource and offset=${String(chunk.nextOffset)}]`;
      return ok(
        `Resource '${resource}' of skill '${name}' (bytes ${String(chunk.offset)}-${String(
          chunk.nextOffset ?? chunk.totalBytes,
        )} of ${String(chunk.totalBytes)}):\n\n${chunk.text}${continuation}`,
      );
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
  const end = Math.min(maxChars, text.length);
  const continuation =
    end < text.length
      ? "\n\n[resource truncated; this provider does not support byte-offset continuation]"
      : "";
  return ok(
    `Resource '${resource}' of skill '${name}' (characters 0-${String(end)} of ${String(
      text.length,
    )}):\n\n${text.slice(0, end)}${continuation}`,
  );
}
