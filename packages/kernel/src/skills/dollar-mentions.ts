/**
 * `$name` mentions in already-open user text, plus the seed messages they
 * expand to.
 *
 * @remarks
 * Slash invocation (`/name`, including `/clarvis-configure`) is a different
 * path: it either seeds a dedicated skill run or replaces the current turn
 * through `getPrompt`. A `$name` token never forks a run and never expands a
 * skill that names an `agent`. Missing, non-invocable, agent-backed, or
 * denylisted names stay literal text.
 */

import type { SkillsProvider } from "@clarvis/loop";
import { renderSkillPrompt, skillEntryAgent } from "./render-skill-prompt.ts";

/**
 * Common environment-variable names that must not be treated as skill
 * mentions when the user writes `$PATH`-style tokens.
 */
const DOLLAR_ENV_DENYLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
]);

/**
 * `$` plus a skill-shaped identifier: leading letter, then letters, digits,
 * underscores or hyphens, with a non-identifier boundary on both sides.
 */
const DOLLAR_SKILL_MENTION = /(^|[^A-Za-z0-9_])\$([A-Za-z][A-Za-z0-9_-]*)(?![A-Za-z0-9_-])/g;

/**
 * Concatenate the user-authored text of the current turn's messages.
 *
 * @param messages - protocol start/continue messages; assistant content is ignored.
 * @returns joined user text, including text parts of mixed content. Image-only
 *   messages contribute nothing.
 */
export function userMessagesText(messages: readonly { role: string; content: unknown }[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = messagePlainText(message.content);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n");
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  if (typeof part !== "object" || part === null) return false;
  const candidate: { type?: unknown; text?: unknown } = part;
  return candidate.type === "text" && typeof candidate.text === "string";
}

function messagePlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const part of content) {
    if (isTextPart(part)) chunks.push(part.text);
  }
  return chunks.join("");
}

/**
 * Collect unique `$name` skill mentions from user text, in appearance order.
 *
 * @param text - the user-authored text of the current turn.
 * @returns each distinct mention, minus denylisted environment names. Names
 *   without a leading `$` are never scanned.
 */
export function extractDollarSkillMentions(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(DOLLAR_SKILL_MENTION)) {
    const name = match[2];
    if (name === undefined || DOLLAR_ENV_DENYLIST.has(name) || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Render one `renderSkillPrompt` seed per expandable `$name` mention.
 *
 * @param text - the user-authored text of the current turn.
 * @param skills - the skills source; absent, nothing expands.
 * @param skipName - a skill already seeded by the `skill` start param.
 * @returns seeds in mention order, each skill at most once. Unknown,
 *   ambiguous, non-invocable, and agent-backed names are ignored.
 */
export function dollarSkillSeeds(
  text: string,
  skills: SkillsProvider | undefined,
  skipName?: string,
): string[] {
  if (skills === undefined) return [];
  const seeds: string[] = [];
  for (const name of extractDollarSkillMentions(text)) {
    if (skipName === name) continue;
    const listed = skills
      .listSkills()
      .filter((skill) => skill.name === name && skill.userInvocable);
    if (listed.length !== 1) continue;
    const content = skills.loadSkill(name);
    if (content === undefined || !content.userInvocable) continue;
    if (skillEntryAgent(content.metadata) !== undefined) continue;
    seeds.push(renderSkillPrompt(name, content.description, content.body));
  }
  return seeds;
}
