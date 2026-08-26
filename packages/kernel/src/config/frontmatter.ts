import { splitAgentFrontmatter } from "@clarvis/loop/host";

/**
 * Split agent markdown into its parsed YAML frontmatter and its body.
 *
 * A thin, null-safe wrapper over the loop's `splitAgentFrontmatter`: a document
 * with no frontmatter yields an empty `data` object rather than `null`, so callers
 * never branch on absence.
 *
 * @param raw - the raw agent markdown (optional `---` frontmatter block + body).
 * @param mode - parse strictness; `"lenient"` (the default) tolerates malformed
 *   frontmatter, `"strict"` surfaces it.
 * @returns the parsed frontmatter `data` (empty when absent) and the trailing
 *   markdown `body`.
 */
export function parseAgentFrontmatter(
  raw: string,
  mode: "strict" | "lenient" = "lenient",
): { data: Record<string, unknown>; body: string } {
  const { data, body } = splitAgentFrontmatter(raw, mode);
  return { data: (data ?? {}) as Record<string, unknown>, body };
}
