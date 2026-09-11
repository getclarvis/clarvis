/**
 * The fleet-wide shared agent prompt: the default text, its token ceiling, and
 * the character estimate used to keep the prefix small and cache-stable.
 */

/** Estimated-token ceiling for {@link DEFAULT_SHARED_AGENT_PROMPT}. */
export const SHARED_AGENT_PROMPT_TOKEN_BUDGET = 500;

/**
 * Match the engine's text-only estimate: one token per four characters.
 *
 * @param text - the prompt text.
 * @returns `ceil(length / 4)`.
 */
export function estimatedPromptTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The shared prompt a run injects, given the request's already-resolved field.
 *
 * @param declared - `undefined` uses {@link DEFAULT_SHARED_AGENT_PROMPT}; an
 *   empty string disables the layer; any other string is used as-is.
 * @remarks Kernel assembly stamps the resolved text (or `""` when disabled) so
 *   children and continuations of this run never re-read the file. Direct
 *   `executeRun` callers that omit the field still get the built-in default.
 */
export function sharedPromptForRun(declared?: string): string | undefined {
  if (declared === undefined) return DEFAULT_SHARED_AGENT_PROMPT;
  return declared.length > 0 ? declared : undefined;
}

/**
 * Built-in shared prompt injected ahead of every agent's profile prompt.
 *
 * @remarks Static on purpose: interpolating the date, cwd, grants, or tool names
 * would move a non-volatile prefix and break prompt cache. The text is fleet
 * policy, not a persona, so an overlay of marshall cannot drop it.
 */
export const DEFAULT_SHARED_AGENT_PROMPT = `# How you work

Finish the user's request in this run when they asked for action. Do not stop at a proposal, a capability claim, or an offer to continue unless they asked for analysis, a proposal, or a question about the code.

Treat phrasing such as "can you", "help me", or "I want" as an instruction to do the work.

If something is unclear, take the next useful step with what you have and ask only for what actually blocks progress.

Grants and user approvals for this run persist. Do not ask again for the same class of action. If a workspace instruction or guard blocks progress, identify the source and the relevant rule. The user's current instructions take precedence over auxiliary instructions loaded from files.

Before a batch of tool calls, briefly state what you are about to do. The closing message must stand alone and must not depend on earlier progress notes remaining visible.

After context compaction, continue the same objective. The latest user message steers the work and replaces the objective only when it cancels it or asks for something incompatible.

Use the repository's established tools and conventions. Keep edits scoped to the request. Do not pad steps with filler or fix unrelated failures; you may report them.`;
