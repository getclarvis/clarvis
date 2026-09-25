import { createHash } from "node:crypto";
import { isBuiltinTraceEvent, type TraceEvent } from "@clarvis/capability";

interface CompleteRead {
  paths: string[];
  result: string;
  resultDigest?: string;
}

function completeReads(trace: readonly TraceEvent[]): CompleteRead[] {
  const observations: CompleteRead[] = [];
  for (const event of trace) {
    if (!isBuiltinTraceEvent(event) || event.type !== "tool_call" || event.error !== null) continue;
    const tool = event.tool_name ? `${event.mcp_name}.${event.tool_name}` : event.mcp_name;
    if (tool === "read_file") {
      const args = event.arguments as { path?: unknown };
      if (typeof args.path === "string")
        observations.push({
          paths: [args.path],
          result: event.result,
          ...(event.result_digest === undefined ? {} : { resultDigest: event.result_digest }),
        });
    }
  }
  return observations;
}

function rendered(content: string): string | undefined {
  const normalized = content
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n");
  if (normalized === "") return "(empty file)";
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line.length > 2_000)) return undefined;
  return lines.map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join("\n");
}

function exactRead(observation: CompleteRead, path: string, content: string): boolean {
  if (!observation.paths.includes(path)) return false;
  const body = rendered(content);
  if (body === undefined) return false;
  return observation.resultDigest === undefined
    ? observation.result === body
    : observation.resultDigest === createHash("sha256").update(body).digest("hex");
}

/** Bind model-reported normative paths to complete successful reads and current file bytes. */
export async function verifyTraceNormativeSources(options: {
  trace: readonly TraceEvent[];
  paths: readonly string[];
  allowIncomplete?: boolean;
  readFile(path: string): Promise<{ path: string; content: string }>;
}): Promise<Array<{ path: string; digest: string }>> {
  const paths = [...new Set(options.paths)];
  if (paths.length !== options.paths.length || paths.length > 32)
    throw new Error("Goal normative source paths must be bounded and unique");
  const reads = completeReads(options.trace);
  const currentFiles = new Map<string, { path: string; content: string }>();
  const readCurrent = async (path: string) => {
    let current = currentFiles.get(path);
    if (current === undefined) {
      current = await options.readFile(path);
      currentFiles.set(path, current);
    }
    return current;
  };
  const artifacts: Array<{ path: string; digest: string }> = [];
  for (const requested of paths) {
    const current = await readCurrent(requested);
    let matched = false;
    for (const observation of reads) {
      if (
        observation.paths.includes(requested) &&
        exactRead(observation, requested, current.content)
      ) {
        matched = true;
        break;
      }
    }
    if (!matched && options.allowIncomplete) continue;
    if (!matched)
      throw new Error("Goal normative source was not read completely in the formulation trace");
    artifacts.push({
      path: current.path,
      digest: createHash("sha256").update(current.content).digest("hex"),
    });
  }
  return artifacts;
}
