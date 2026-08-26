import type { SkillResource } from "./types.ts";
import type { LLMToolCall, TracePort } from "@clarvis/capability";
import type { AgentRole, ToolArgValidate } from "@clarvis/capability";
import { openCallEnvelope } from "@clarvis/capability";
import {
  LOAD_SKILL_TOOL_NAME,
  SKILL_RESOURCE_MAX_CHARS,
  loadSkillTool,
  type SkillsProvider,
} from "./tool.ts";

/**
 * The result of a `load_skill` call: the model-facing `text` (the skill body,
 * a resource's contents, or an error note) and whether it represents an `error`.
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
  return `\n\nBundled resources (call load_skill again with resource=<path> to read one):\n${lines}`;
}

/** Whether a provider supplied a path that means "load this skill's main body". */
function isSkillBodyResource(name: string, resource: string): boolean {
  const normalized = resource.replaceAll("\\", "/");
  if (["", ".", "./", "/", "SKILL.md", "./SKILL.md"].includes(normalized)) return true;
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  return segments.at(-1) === "SKILL.md" && segments.at(-2) === name;
}

/**
 * Execute a `load_skill` call: validate arguments, then return either the named
 * skill's full body (plus a resource listing) or, when `resource` is given, that
 * bundled file's contents.
 *
 * @param args.call - the raw call whose `arguments` carry `name` and optional
 *   `resource`.
 * @param args.skills - the provider that lists/loads skills and resolves resource
 *   paths.
 * @param args.trace - trace sink for the tool-call lifecycle.
 * @param args.agent - the calling agent's role.
 * @param args.subagentInstanceId - present when a sub-agent makes the call.
 * @param args.iteration - the loop iteration issuing the call.
 * @param args.maxResourceChars - resource read cap; defaults to
 *   {@link SKILL_RESOURCE_MAX_CHARS}, beyond which the text is truncated with a
 *   marker.
 * @returns a {@link LoadSkillCallResult}; an unknown skill, an unresolvable
 *   resource, or a read failure each yield an `error` result rather than a throw.
 * @remarks Synchronous: the provider owns resource confinement and reading.
 */
export function handleLoadSkillCall(args: {
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
  const maxChars = args.maxResourceChars ?? SKILL_RESOURCE_MAX_CHARS;
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
  const { name, resource: rawResource } = call.arguments as { name: string; resource?: string };
  // Some providers materialize an optional string as a directory sentinel or repeat the
  // catalog path to the skill's own SKILL.md. Neither addresses a bundled resource: both mean
  // the tool's primary operation, loading the skill body.
  const trimmedResource = rawResource?.trim();
  const resource =
    trimmedResource !== undefined && !isSkillBodyResource(name, trimmedResource)
      ? trimmedResource
      : undefined;
  envelope.start();

  if (resource !== undefined) {
    if (!skills.listSkills().some((skill) => skill.name === name)) {
      return fail(`unknown skill '${name}'. Available skills: ${availableNames(skills)}.`);
    }
    let text: string;
    try {
      text = skills.readResource(name, resource);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return fail(`could not read resource '${resource}' of skill '${name}': ${reason}`);
    }
    const capped =
      text.length > maxChars
        ? `${text.slice(0, maxChars)}\n\n[resource truncated at ${maxChars} characters]`
        : text;
    return ok(`Resource '${resource}' of skill '${name}':\n\n${capped}`);
  }

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
  return ok(
    `Skill '${content.name}' — ${content.description}\n\n${body}${renderResourceList(content.resources)}`,
  );
}
