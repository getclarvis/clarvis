import { agentFrontmatterSchema } from "@clarvis/loop/host";
import type { Scope } from "@clarvis/protocol";
import { readBuiltinAgent, type BuiltinAgent } from "./builtin-agents/index.ts";
import type { AgentOverlay, AgentRecord } from "./config-store.ts";

/** The frontmatter keys lifted onto an {@link AgentRecord} as a convenience projection. */
function liftProjection(
  frontmatter: Record<string, unknown>,
): Pick<AgentRecord, "model" | "description"> {
  return {
    ...(typeof frontmatter.model === "string" ? { model: frontmatter.model } : {}),
    ...(typeof frontmatter.description === "string"
      ? { description: frontmatter.description }
      : {}),
  };
}

/**
 * Project a shipped agent into the {@link AgentRecord} shape every consumer reads.
 *
 * @param builtin - the shipped agent.
 * @returns a record at `scope: "builtin"`, carrying a defensive copy of the
 *   frontmatter so a consumer that mutates what it reads cannot corrupt the
 *   process-wide fleet.
 */
export function builtinAgentRecord(builtin: BuiltinAgent): AgentRecord {
  const frontmatter = { ...builtin.frontmatter };
  return {
    name: builtin.name,
    scope: "builtin",
    frontmatter,
    body: builtin.body,
    ...liftProjection(frontmatter),
  };
}

/**
 * Why an overlay file cannot be applied, or `undefined` when it can.
 *
 * @remarks Two ways to fail, deliberately treated alike: YAML that did not parse
 *   (the record's `malformed`, whose frontmatter is then the lenient `{}` rather
 *   than anything the author wrote), and frontmatter that parsed but does not
 *   satisfy {@link agentFrontmatterSchema}. Applying either would mean running an
 *   agent assembled from fields the user did not successfully declare.
 */
function overlayRejection(file: AgentRecord): string | undefined {
  if (file.malformed !== undefined) return file.malformed;
  const parsed = agentFrontmatterSchema.safeParse(file.frontmatter);
  if (parsed.success) return undefined;
  const issue = parsed.error.issues[0];
  return issue === undefined
    ? "frontmatter is not a valid agent definition"
    : `${issue.path.join(".") || "frontmatter"}: ${issue.message}`;
}

/**
 * Merge a valid overlay file over the shipped agent, field by field.
 *
 * @param builtin - the record for the shipped agent.
 * @param file - the overlay, already known to satisfy the frontmatter schema.
 * @returns the effective record, at the overlay's own scope.
 * @remarks The frontmatter merge is shallow and last-wins, so a file declaring
 *   one key changes one field and inherits the rest — including improvements to
 *   the shipped default it never has to be edited to receive. A key the overlay
 *   sets to an empty list is a removal, not an omission, which is how a grant or
 *   a `can_spawn` edge is taken away.
 *
 *   The prompt is resolved from *either* channel the overlay may use: a non-empty
 *   markdown body, or a `base_prompt` in its frontmatter. Reading only the body
 *   would have let a `base_prompt`-only overlay inherit the builtin's prompt and
 *   silently discard the one the user wrote. Whichever channel supplied it, the
 *   result lands in `body` and `base_prompt` is dropped from the merged
 *   frontmatter — the body *is* the prompt, the same normalization an editor
 *   save performs.
 */
function mergeOverlay(builtin: AgentRecord, file: AgentRecord): AgentRecord {
  const { base_prompt: overlayBasePrompt, ...overlayFrontmatter } = file.frontmatter;
  const frontmatter = { ...builtin.frontmatter, ...overlayFrontmatter };
  delete frontmatter.base_prompt;
  const overlayBody = file.body.trim();
  const prompt =
    overlayBody.length > 0
      ? overlayBody
      : typeof overlayBasePrompt === "string" && overlayBasePrompt.trim().length > 0
        ? overlayBasePrompt.trim()
        : builtin.body;
  return {
    name: builtin.name,
    scope: file.scope,
    frontmatter,
    body: prompt,
    ...liftProjection(frontmatter),
  };
}

/** The config-scope files that may overlay a shipped agent, highest precedence first. */
export interface AgentOverlayLayers {
  workspace?: AgentRecord | null;
  global?: AgentRecord | null;
}

/**
 * Resolve the agent that will actually run for `name`.
 *
 * @param name - the agent name, unqualified.
 * @param layers - the config-scope files found for that name, if any.
 * @returns the effective {@link AgentRecord}, or `null` when neither a file nor a
 *   shipped agent exists.
 * @remarks Three outcomes, in the order they are decided:
 *
 * - **No shipped agent.** The file wins outright, workspace over global, exactly
 *   as before builtins existed. A malformed file stays malformed: tolerance is
 *   possible only where there is a default to fall back *to*, and inventing one
 *   for a user's own agent would run something they never wrote.
 * - **Shipped agent, no file.** The shipped agent, unmodified.
 * - **Shipped agent and a file.** The file is validated first. Valid, it merges
 *   (see {@link mergeOverlay}); invalid, the shipped agent stands whole and the
 *   returned record carries the reason on {@link AgentOverlay.reason}. This is
 *   the property that keeps a host runnable: a typo in an overlay costs the
 *   user their customization, never their fleet.
 */
export function resolveEffectiveAgent(
  name: string,
  layers: AgentOverlayLayers = {},
): AgentRecord | null {
  const builtin = readBuiltinAgent(name);
  const file = layers.workspace ?? layers.global ?? null;
  if (builtin === undefined) return file;

  const record = builtinAgentRecord(builtin);
  if (file === null) return record;

  const shadowed: readonly Scope[] | undefined =
    layers.workspace != null && layers.global != null ? ["global"] : undefined;
  const rejection = overlayRejection(file);
  const overlay: AgentOverlay = {
    scope: file.scope as Scope,
    status: rejection === undefined ? "applied" : "rejected",
    ...(rejection === undefined ? {} : { reason: rejection }),
    ...(shadowed === undefined ? {} : { shadowed }),
  };
  return rejection === undefined
    ? { ...mergeOverlay(record, file), overlay }
    : { ...record, overlay };
}
