import type { JSX } from "solid-js";
import { syntaxStyle } from "../theme/syntax.ts";

/** Rendered markdown body shared by every prose surface (plan documents,
 * memory wiki pages): one `<markdown>` configuration so tables, wrapping and
 * syntax styling never diverge between overlays. Default layout fills the
 * remaining row (the plan overlay's rail idiom); `block` sizes to content
 * width/height instead — flex-grown markdown collapses inside a scrollbox. */
export function Prose(props: { content: string; fg?: string; block?: boolean }): JSX.Element {
  return (
    <markdown
      content={props.content}
      syntaxStyle={syntaxStyle()}
      fg={props.fg}
      width={props.block ? "100%" : undefined}
      flexShrink={props.block ? 0 : undefined}
      flexGrow={props.block ? undefined : 1}
      flexBasis={props.block ? undefined : 0}
      minWidth={0}
      tableOptions={{ widthMode: "content", wrapMode: "word" }}
    />
  );
}

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;
const REINDEX_MARKER = /^\s*<!--\s*reindex:(?:begin|end)\s*-->\s*$/;

/** Memory wiki documents carry YAML frontmatter and `<!-- reindex -->` managed
 * markers — plumbing the reader should never see. The links inside the managed
 * block stay (they are the navigation), only the marker comments go. */
export function stripDocChrome(content: string): string {
  return content
    .replace(FRONTMATTER, "")
    .split("\n")
    .filter((line) => !REINDEX_MARKER.test(line))
    .join("\n")
    .replace(/^\n+/, "");
}
