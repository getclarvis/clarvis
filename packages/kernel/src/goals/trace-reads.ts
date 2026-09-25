import { createHash } from "node:crypto";
import { isBuiltinTraceEvent, type TraceEvent } from "@clarvis/capability";

interface CompleteRead {
  tool: "read_file" | "read_files";
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
          tool,
          paths: [args.path],
          result: event.result,
          ...(event.result_digest === undefined ? {} : { resultDigest: event.result_digest }),
        });
    } else if (tool === "read_files") {
      const args = event.arguments as { paths?: unknown };
      if (
        Array.isArray(args.paths) &&
        args.paths.length <= 64 &&
        args.paths.every((path) => typeof path === "string")
      )
        observations.push({
          tool,
          paths: args.paths,
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
  if (observation.tool === "read_file")
    return observation.resultDigest === undefined
      ? observation.result === body
      : observation.resultDigest === createHash("sha256").update(body).digest("hex");
  const section = `==> ${path} <==\n${body}`;
  return (
    observation.result === section ||
    observation.result.startsWith(`${section}\n\n`) ||
    observation.result.endsWith(`\n\n${section}`) ||
    observation.result.includes(`\n\n${section}\n\n`)
  );
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
  const batchMatches = new Map<CompleteRead, boolean>();
  const matchesBatch = async (observation: CompleteRead) => {
    if (observation.tool !== "read_files" || observation.resultDigest === undefined) return false;
    const known = batchMatches.get(observation);
    if (known !== undefined) return known;
    const sections: string[] = [];
    try {
      for (const path of observation.paths) {
        const body = rendered((await readCurrent(path)).content);
        if (body === undefined) return false;
        sections.push(`==> ${path} <==\n${body}`);
      }
    } catch {
      batchMatches.set(observation, false);
      return false;
    }
    const matches =
      createHash("sha256").update(sections.join("\n\n")).digest("hex") === observation.resultDigest;
    batchMatches.set(observation, matches);
    return matches;
  };
  const artifacts: Array<{ path: string; digest: string }> = [];
  for (const requested of paths) {
    const current = await readCurrent(requested);
    let matched = false;
    for (const observation of reads) {
      if (
        observation.paths.includes(requested) &&
        (exactRead(observation, requested, current.content) || (await matchesBatch(observation)))
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
