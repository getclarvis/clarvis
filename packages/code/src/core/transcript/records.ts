import { projectTranscriptToolDisplay, transcriptDisplayText } from "./index.ts";
import type { TranscriptNode, TranscriptToolNode } from "./types.ts";

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/** Build the bounded, owned node snapshot that committed history is allowed to retain. */
export function snapshotTranscriptNode(
  node: TranscriptNode,
  toolArguments: Record<string, unknown> | undefined = node.kind === "tool_call"
    ? node.args
    : undefined,
): TranscriptNode {
  if (node.kind === "tool_call") {
    const display = projectTranscriptToolDisplay(node, toolArguments);
    const base = { ...node };
    delete base.args;
    delete base.result;
    delete base.diff;
    delete base.error;
    delete base.liveOutput;
    delete base.inputChars;
    delete base.inputComplete;
    delete base.dehydrated;
    delete base.hydrationNotice;
    return deepFreeze({
      ...base,
      text: transcriptDisplayText(node),
      ...(display.arguments === undefined ? {} : { args: display.arguments }),
      ...(display.result === undefined ? {} : { result: display.result }),
      ...(display.diff === undefined ? {} : { diff: display.diff }),
      ...(display.error === undefined ? {} : { error: display.error }),
      guard: node.guard === undefined ? undefined : { ...node.guard },
      mutation:
        node.mutation === undefined || node.mutation === null
          ? node.mutation
          : { ...node.mutation },
    } satisfies TranscriptToolNode);
  }
  if (node.kind === "plan") {
    return deepFreeze({
      ...node,
      text: transcriptDisplayText(node),
      tasks: node.tasks?.map((task) => ({ ...task })),
    });
  }
  return deepFreeze({ ...node, text: transcriptDisplayText(node) });
}
