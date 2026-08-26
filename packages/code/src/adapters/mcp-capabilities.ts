import type { MCPStatus, PlansMode, ToolTransport } from "@clarvis/protocol";
import { mcpServerSettingsSchema } from "@clarvis/kernel/config";
import { CONTROL_PLANE_TOOL_NAMES } from "@clarvis/kernel/policy";
import type { MessageContent, ContentPart } from "@clarvis/protocol";

export { mcpServerSettingsSchema };

/** An MCP server's connection status, plus `"declared"` for a configured but never-connected server. */
export type ServerStatus = MCPStatus | "declared";

/** A tool as reported live by a connected MCP server. */
export interface LiveTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface ArgSpec {
  name: string;
  description?: string;
  required?: boolean;
}
/** A prompt as reported live by a connected MCP server, or synthesized for a skill. */
export interface LivePrompt {
  name: string;
  description?: string;
  arguments?: ArgSpec[];
  /**
   * For a skill, the name it asks to be shown under; absent when it asks for
   * none. Presentation only — the slash command stays keyed by `name`.
   */
  displayName?: string;
  /** For a skill, the agent it declared for itself; absent when it names none. */
  agent?: string;
  /** Trusted automatic Plans policy projected for a kernel-owned skill. */
  plansMode?: PlansMode;
}

/** One message returned by resolving a prompt (`getPrompt`). */
export interface PromptMessage {
  role: "user" | "assistant";
  content: MessageContent;
}

/** An MCP server as declared in settings (`mcpServers`), before any live connection. */
export interface McpServerDecl {
  name: string;
  type: ToolTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  shared?: boolean;
  resources?: boolean;
}

/**
 * Parse the settings `mcpServers` record into declared server entries, silently
 * dropping any value that fails {@link mcpServerSettingsSchema}.
 *
 * @param record - the raw `mcpServers` settings value, if present.
 */
export function parseMcpServers(record: Record<string, unknown> | undefined): McpServerDecl[] {
  if (!record) return [];
  const out: McpServerDecl[] = [];
  for (const [name, value] of Object.entries(record)) {
    const parsed = mcpServerSettingsSchema.safeParse(value);
    if (parsed.success) out.push({ name, ...parsed.data });
  }
  return out;
}

const CONTROL_PLANE_TOOLS = new Set(CONTROL_PLANE_TOOL_NAMES);

const TOOL_SEP = ".";
const PROMPT_SEP = ":";

/** The origin a raw tool/prompt name was classified into, plus its server (if downstream) and local name. */
export interface Classified {
  origin: "control-plane" | "downstream" | "profile-prompt" | "skill";
  server?: string;
  local: string;
}

/**
 * Classify a raw MCP-facing tool or prompt name by its separator-prefixed
 * origin: a known control-plane tool, a `server<sep>local` downstream
 * capability, a profile-name prompt, or (for prompts with no separator that
 * don't name a profile) a skill.
 *
 * @param name - the raw tool or prompt name as reported by the MCP client.
 * @param kind - which separator to split on (`.` for tools, `:` for prompts).
 * @param profiles - known profile names, to distinguish a profile prompt from a skill.
 */
export function classifyCapability(
  name: string,
  kind: "tool" | "prompt",
  profiles: readonly string[] = [],
): Classified {
  if (kind === "tool" && CONTROL_PLANE_TOOLS.has(name))
    return { origin: "control-plane", local: name };
  const sep = kind === "tool" ? TOOL_SEP : PROMPT_SEP;
  const i = name.indexOf(sep);
  if (i > 0) return { origin: "downstream", server: name.slice(0, i), local: name.slice(i + 1) };
  if (kind === "prompt")
    return profiles.includes(name)
      ? { origin: "profile-prompt", local: name }
      : { origin: "skill", local: name };
  return { origin: "downstream", local: name };
}

/** One MCP server (or the control-plane pseudo-server) as reconciled for display. */
export interface ServerNode {
  name: string;
  origin: "control-plane" | "downstream";
  status: ServerStatus;
  type?: ToolTransport;
  decl?: McpServerDecl;
  tools: LiveTool[];
  prompts: LivePrompt[];
}

/** The display name of the control-plane pseudo-server node. */
export const BACKEND_NAME = "kernel";

/**
 * Reconcile declared servers against a live tool/prompt listing into the
 * {@link ServerNode} tree the UI renders: a control-plane node carrying
 * skill prompts, plus one downstream node per server (declared, connected, or
 * both), sorted by name.
 *
 * @param decls - servers declared in settings.
 * @param tools - live tools from the connected client.
 * @param prompts - live prompts from the connected client.
 * @param backend - the control plane's own connection status.
 * @param profiles - known profile names, passed through to {@link classifyCapability}.
 */
export function reconcile(
  decls: McpServerDecl[],
  tools: LiveTool[],
  prompts: LivePrompt[],
  backend: MCPStatus,
  profiles: readonly string[] = [],
): ServerNode[] {
  const byServer = new Map<string, { tools: LiveTool[]; prompts: LivePrompt[] }>();
  const bucket = (server: string): { tools: LiveTool[]; prompts: LivePrompt[] } => {
    let b = byServer.get(server);
    if (!b) byServer.set(server, (b = { tools: [], prompts: [] }));
    return b;
  };
  for (const t of tools) {
    const c = classifyCapability(t.name, "tool", profiles);
    if (c.origin !== "downstream" || !c.server) continue;
    bucket(c.server).tools.push({ ...t, name: c.local });
  }
  const skillPrompts: LivePrompt[] = [];
  for (const p of prompts) {
    const c = classifyCapability(p.name, "prompt", profiles);
    if (c.origin === "skill") {
      skillPrompts.push({ ...p, name: c.local });
      continue;
    }
    if (c.origin !== "downstream" || !c.server) continue;
    bucket(c.server).prompts.push({ ...p, name: c.local });
  }

  const backendNode: ServerNode = {
    name: BACKEND_NAME,
    origin: "control-plane",
    status: backend,
    tools: [],
    prompts: skillPrompts,
  };

  const declByName = new Map(decls.map((d) => [d.name, d]));
  const names = new Set<string>([...byServer.keys(), ...declByName.keys()]);
  const downstream: ServerNode[] = [...names].sort().map((name) => {
    const live = byServer.get(name);
    const decl = declByName.get(name);
    return {
      name,
      origin: "downstream",
      status: live ? "connected" : "declared",
      type: decl?.type,
      decl,
      tools: live?.tools ?? [],
      prompts: live?.prompts ?? [],
    };
  });

  return [backendNode, ...downstream];
}

/**
 * Flatten resolved prompt messages into a single {@link MessageContent},
 * prefixing assistant-role text with `[assistant] ` and joining text parts with
 * blank lines when every part is text.
 */
export function promptMessagesToContent(messages: PromptMessage[]): MessageContent {
  const parts: ContentPart[] = [];
  const pushText = (text: string): void => {
    if (text.length > 0) parts.push({ type: "text", text });
  };
  for (const m of messages) {
    const prefix = m.role === "assistant" ? "[assistant] " : "";
    if (typeof m.content === "string") {
      pushText(prefix + m.content);
    } else {
      for (const part of m.content) {
        if (part.type === "text") pushText(prefix + part.text);
        else parts.push(part);
      }
    }
  }
  if (parts.length === 0) return "";
  if (parts.every((p) => p.type === "text"))
    return parts.map((p) => (p as { text: string }).text).join("\n\n");
  return parts;
}

/** One argument row derived from a JSON-Schema `inputSchema`, for a tool's arg-editing UI. */
export interface SchemaArgRow {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/** Flatten a JSON-Schema `inputSchema`'s top-level properties into {@link SchemaArgRow}s. */
export function schemaArgRows(inputSchema: Record<string, unknown> | undefined): SchemaArgRow[] {
  const props = (inputSchema?.properties ?? {}) as Record<
    string,
    { type?: string; description?: string }
  >;
  const required = new Set((inputSchema?.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, p]) => ({
    name,
    type: p.type ?? "any",
    required: required.has(name),
    description: p.description ?? "",
  }));
}

/**
 * Synthesize placeholder arguments for a tool's required properties (or all
 * properties, when the schema declares none required) — used to preview a call
 * before the user fills in real values.
 *
 * @param inputSchema - the tool's JSON-Schema `inputSchema`.
 * @returns a zero/false/empty/`<key>` placeholder value per required property,
 *   typed from the schema's declared `type` where known.
 */
export function synthSampleArgs(
  inputSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = (inputSchema?.properties ?? {}) as Record<string, { type?: string }>;
  const required = (inputSchema?.required as string[] | undefined) ?? Object.keys(props);
  for (const key of required) {
    const t = props[key]?.type;
    out[key] =
      t === "number" || t === "integer"
        ? 0
        : t === "boolean"
          ? false
          : t === "array"
            ? []
            : t === "object"
              ? {}
              : `<${key}>`;
  }
  return out;
}
