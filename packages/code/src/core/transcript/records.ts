import { projectTranscriptToolDisplay, transcriptDisplayText } from "./index.ts";
import type { TranscriptNode, TranscriptToolNode } from "./types.ts";

function frozenCopy<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing as T;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(frozenCopy(item, seen));
    return Object.freeze(copy) as T;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = frozenCopy(item, seen);
  return Object.freeze(copy) as T;
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
    return frozenCopy({
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
    return frozenCopy({
      ...node,
      text: transcriptDisplayText(node),
      tasks: node.tasks?.map((task) => ({ ...task })),
    });
  }
  return frozenCopy({ ...node, text: transcriptDisplayText(node) });
}
