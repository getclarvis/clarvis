import type { TranscriptNode } from "../adapters/store.ts";
import { toolLabel } from "../adapters/tool-identity.ts";
import { formatToolCall } from "./tools/signature.ts";
import { guardReviewLabel } from "../core/transcript/index.ts";
import { projectTranscriptToolDisplay } from "../core/transcript/index.ts";

/** The document prelude, separated so interactive export can write it once. */
export function transcriptMarkdownHeader(title?: string): string {
  return `# ${title ?? "Clarvis transcript"}\n`;
}

/**
 * Render transcript nodes one at a time, keeping export memory proportional to
 * the largest node rather than to the entire session.
 */
export function* renderTranscriptMarkdownChunks(
  nodes: readonly TranscriptNode[],
): Generator<string> {
  for (const n of nodes) {
    if (n.kind === "user") yield `\n## You\n\n${n.text}\n`;
    else if (n.kind === "assistant") yield `\n## Assistant\n\n${n.text}\n`;
    else if (n.kind === "reasoning") yield `\n> ${n.text.replace(/\n/g, "\n> ")}\n`;
    else if (n.kind === "tool_call") {
      const name = toolLabel(n.mcpName, n.toolName);
      const sig = n.signature ?? formatToolCall(n.mcpName ?? "", n.toolName ?? "", n.args ?? {});
      const guard = guardReviewLabel(n);
      yield `\n- \`${name}${sig}\` — ${n.status}${guard ? ` — ${guard}` : ""}\n`;
      const display = projectTranscriptToolDisplay(n);
      if (display.hasArguments) {
        yield `\n  Bounded arguments:\n\n  \`\`\`json\n${display.argumentsText
          .split("\n")
          .map((line) => `  ${line}`)
          .join(
            "\n",
          )}\n  \`\`\`${display.truncated ? "\n\n  _Argument projection shortened._" : ""}\n`;
      }
    } else if (n.kind === "run") yield `\n_(${n.reason ?? n.status})_\n\n---\n`;
  }
}

/**
 * Renders a transcript's nodes as a plain Markdown document.
 *
 * @param nodes - The transcript nodes to render, in display order.
 * @param title - Optional document title; defaults to `"Clarvis transcript"`.
 * @returns The rendered Markdown, as a single string with `\n` line breaks.
 */
export function renderTranscriptMarkdown(nodes: readonly TranscriptNode[], title?: string): string {
  return transcriptMarkdownHeader(title) + [...renderTranscriptMarkdownChunks(nodes)].join("");
}
