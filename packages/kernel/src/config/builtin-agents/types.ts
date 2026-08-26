/**
 * One agent profile Clarvis ships as data.
 *
 * @remarks The shape mirrors what {@link AgentRecord} carries for a file-backed
 *   agent — parsed frontmatter plus the markdown body — so a builtin joins the
 *   same resolution as a `global`, `workspace` or plugin agent rather than
 *   travelling a path of its own. `frontmatter` is the already-parsed object
 *   because there is no YAML to parse: nothing here was ever a file.
 */
export interface BuiltinAgent {
  /** The agent name, which is also the name a config file must use to overlay it. */
  name: string;
  /** The frontmatter fields, as {@link agentFrontmatterSchema} would have parsed them. */
  frontmatter: Record<string, unknown>;
  /** The markdown body, i.e. the agent's system prompt. */
  body: string;
}
