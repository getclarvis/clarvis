import {
  agentFrontmatterSchema,
  DEFAULT_ENTRY_AGENT,
  isBuiltinAgent,
  profileReadinessIssues,
  type AgentFrontmatter,
  type ReadinessIssue,
} from "@clarvis/kernel/config";
import { loadEnv } from "@clarvis/kernel/bootstrap";
import type { AgentDoc, AgentOverlay, AgentWrite, Scope } from "@clarvis/protocol";
import { zodIssueSummary } from "./zod-summary.ts";

/** The shipped Lead profile Code enters when no explicit profile was selected. */
export const DEFAULT_AGENT_NAME = DEFAULT_ENTRY_AGENT;

/** Whether an agent name belongs to the profile fleet shipped with Clarvis. */
export function isShippedAgent(name: string): boolean {
  return isBuiltinAgent(name);
}

/**
 * Converts a kernel {@link AgentDoc} into the editor's {@link AgentFile} shape.
 *
 * @remarks
 * A frontmatter that fails {@link agentFrontmatterSchema} is not rejected: the
 * file comes back with an empty `frontmatter` and its `invalid` summary set,
 * so the editor can still open and show the file rather than losing it. A
 * blank body whose frontmatter carries `base_prompt` promotes that field back
 * into the body (the inverse of {@link normalizeAgentWrite}'s demotion).
 *
 * A key the schema does not name is not an error and is not dropped: it is
 * carried into the editor's `frontmatter` so {@link normalizeAgentWrite} can
 * write it back out unchanged.
 */
export function docToAgentFile(doc: AgentDoc, overlay?: AgentOverlay): AgentFile {
  const scope = doc.scope;
  const tag = overlay === undefined ? {} : { overlay };
  if (doc.malformed !== undefined)
    return {
      name: doc.name,
      scope,
      frontmatter: {},
      body: doc.body.trim(),
      invalid: doc.malformed,
      ...tag,
    };
  const parsed = agentFrontmatterSchema.safeParse(doc.frontmatter);
  if (!parsed.success)
    return {
      name: doc.name,
      scope,
      frontmatter: {},
      body: doc.body.trim(),
      invalid: zodIssueSummary(parsed.error),
      ...tag,
    };
  const trimmed = doc.body.trim();
  if (!trimmed && parsed.data.base_prompt) {
    const { base_prompt, ...rest } = parsed.data;
    return { name: doc.name, scope, frontmatter: rest, body: base_prompt, ...tag };
  }
  return { name: doc.name, scope, frontmatter: parsed.data, body: trimmed, ...tag };
}

/**
 * Converts an editor {@link AgentFile} into the {@link AgentWrite} the kernel
 * accepts.
 *
 * @throws {@link Error} when `file.frontmatter` fails {@link agentFrontmatterSchema}.
 * @remarks A non-empty body drops any `base_prompt` frontmatter key, since the
 *   body itself is now the prompt. Every other key survives, including one the
 *   schema does not name — an editor save must not be the thing that strips a
 *   field the file was authored with.
 */
export function normalizeAgentWrite(file: AgentFile): AgentWrite {
  const parsed = agentFrontmatterSchema.safeParse(file.frontmatter);
  if (!parsed.success)
    throw new Error(`invalid agent frontmatter: ${zodIssueSummary(parsed.error)}`);
  const fm: Record<string, unknown> = { ...parsed.data };
  const body = file.body.trim();
  if (body) delete fm.base_prompt;
  return { frontmatter: fm, body };
}

export type { AgentFrontmatter };

/** An agent as the editor works with it: parsed frontmatter plus body, or an `invalid` summary if the frontmatter didn't parse. */
export interface AgentFile {
  name: string;
  /**
   * The layer this agent came from. `"builtin"` means Clarvis ships it and no
   * config file overlays it — there is no document on disk to edit, so a save
   * writes a new overlay into the scope the panel is pointed at.
   */
  scope: Scope | "builtin";
  frontmatter: AgentFrontmatter;
  body: string;
  invalid?: string;
  /** For a shipped agent a config file overlays: what that file did. */
  overlay?: AgentOverlay;
}

/** An {@link AgentFile} that lives in a writable config scope. */
export type StoredAgentFile = AgentFile & { scope: Scope };

/** Whether two frontmatter values are the same declaration. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Build the smallest overlay that turns `base` into `draft`.
 *
 * @param draft - the edited agent, as the panel holds it.
 * @param base - the agent Clarvis ships under the same name.
 * @returns the {@link AgentWrite} to persist, carrying only the frontmatter keys
 *   whose value actually changed and a body only when the prompt changed.
 * @throws {@link Error} when the draft's frontmatter fails
 *   {@link agentFrontmatterSchema}.
 * @remarks Writing the whole document instead would put a 26 KB copy of a
 *   shipped prompt in the user's configuration directory the moment they nudged
 *   an iteration limit — and freeze it there, since a copy stops tracking the
 *   default it was taken from. A minimal overlay keeps the customization to what
 *   the user actually chose and lets every other field keep improving.
 *
 *   An empty result is meaningful: the draft matches the shipped agent, so there
 *   is nothing to persist.
 */
export function overlayAgentWrite(draft: AgentFile, base: AgentFile): AgentWrite {
  const parsed = agentFrontmatterSchema.safeParse(draft.frontmatter);
  if (!parsed.success)
    throw new Error(`invalid agent frontmatter: ${zodIssueSummary(parsed.error)}`);
  const next = { ...parsed.data } as Record<string, unknown>;
  const body = draft.body.trim();
  if (body) delete next.base_prompt;
  const baseFm = base.frontmatter as Record<string, unknown>;
  const frontmatter: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(baseFm), ...Object.keys(next)])) {
    if (!sameValue(next[key], baseFm[key])) frontmatter[key] = next[key];
  }
  return { frontmatter, body: body === base.body.trim() ? "" : body };
}

/** Whether an {@link overlayAgentWrite} result would change anything. */
export function overlayIsEmpty(write: AgentWrite): boolean {
  return Object.keys(write.frontmatter).length === 0 && write.body.length === 0;
}

/** The highest tool grant an agent may hold, ordered least to most capable. */
export type GrantTier = "none" | "read" | "edit" | "exec";

/** Environment-derived defaults and ceilings the agent editor shows/validates against. */
export interface EnvView {
  defaultModel?: string;
  budgetOnExceed: "stop" | "escalate";
  iterationDefault: number;
  iterationCeiling: number;
  tokenDefault: number;
  tokenCeiling: number;
  maxGrant: GrantTier;
  contextWindowDefault: number;
}

/**
 * Reads the `CLARVIS_*` environment defaults into an {@link EnvView}.
 *
 * @remarks Falls back to `loadEnv({})`'s defaults if `env` fails to parse,
 *   so a malformed environment still yields a usable view.
 */
export function readEnvView(env: NodeJS.ProcessEnv = process.env): EnvView {
  let cfg: ReturnType<typeof loadEnv>;
  try {
    cfg = loadEnv(env);
  } catch {
    cfg = loadEnv({});
  }
  return {
    defaultModel: env.CLARVIS_DEFAULT_MODEL,
    budgetOnExceed: cfg.CLARVIS_DEFAULT_ON_EXCEED,
    iterationDefault: cfg.CLARVIS_DEFAULT_ITERATION_LIMIT,
    iterationCeiling: cfg.CLARVIS_ITERATION_CEILING,
    tokenDefault: cfg.CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT,
    tokenCeiling: cfg.CLARVIS_TOKEN_CEILING,
    maxGrant: cfg.CLARVIS_AGENT_TOOLS_MAX_GRANT,
    contextWindowDefault: cfg.CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS,
  };
}

/**
 * The settings {@link agentReadiness} actually reads.
 *
 * @remarks Narrower than the engine's strict `SettingsFile` on purpose: the check needs the
 *   configured provider names and the default model and nothing else, so a
 *   caller holding the protocol's loose `SettingsData` can pass it directly
 *   instead of asserting a strict shape it never verified.
 */
export interface ReadinessSettings {
  default_model?: string | undefined;
  providers?: readonly { readonly name: string }[] | undefined;
}

/** Whether an agent is runnable as configured, and why not if it isn't. */
export interface ReadinessSeal {
  runnable: boolean;
  issues: ReadinessIssue[];
}

/**
 * Checks an agent's frontmatter against the registry, configured providers and
 * env defaults.
 *
 * @param knownGrants - every grant the kernel will accept, from
 *   {@link SettingsView.known_grants}. Omitted, the grant check is skipped
 *   rather than guessed: the vocabulary is the engine's built-ins plus whatever
 *   capabilities the kernel composed, so a static list here would report a
 *   capability-owned grant as unknown.
 */
export function agentReadiness(
  agent: AgentFile,
  registry: AgentFile[],
  settings: ReadinessSettings,
  env: EnvView,
  knownGrants?: readonly string[],
): ReadinessSeal {
  if (agent.invalid !== undefined) {
    // A file whose frontmatter did not parse declares nothing, so every rule
    // below would pass on the empty fallback and seal it runnable. The parse
    // failure is the only honest verdict, and it is a blocking one.
    return {
      runnable: false,
      issues: [{ code: "malformed_frontmatter", message: agent.invalid }],
    };
  }
  const issues = profileReadinessIssues({
    profile: agent.frontmatter,
    registryNames: registry.map((a) => a.name),
    providerNames: (settings.providers ?? []).map((p) => p.name),
    defaultModel: settings.default_model ?? env.defaultModel,
    ...(knownGrants === undefined ? {} : { knownGrants }),
  });
  return { runnable: issues.length === 0, issues };
}

/** The starting frontmatter + body pair a scaffolded agent begins from. */
export interface AgentTemplate {
  frontmatter: AgentFrontmatter;
  body: string;
}

/**
 * The single starting point the "new agent" flow writes.
 *
 * @remarks Deliberately one template and not a menu. It was a
 * `Record<string, AgentTemplate>` with one key that the agents controller
 * indexed by a hard-coded name, which read as a picker whose other entries had
 * not been written yet — they had not, and nothing was going to choose between
 * them: the flow's only argument is the *agent's* name, never a template's. A
 * read-only investigator is the safe floor to start from, because every grant a
 * new agent ends up with is then one the user added on purpose.
 */
export const NEW_AGENT_TEMPLATE: AgentTemplate = {
  frontmatter: {
    description: "Read-only investigator; reports findings with citations.",
    grants: ["read_workspace"],
  },
  body: "You locate code and trace behavior, then report with citations. You never edit.",
};
