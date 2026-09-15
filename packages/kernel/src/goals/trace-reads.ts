import { createHash } from "node:crypto";
import { isBuiltinTraceEvent, type TraceEvent } from "@clarvis/capability";

interface CompleteRead {
  tool: "read_file" | "read_files";
  paths: string[];
  result: string;
}

function completeReads(trace: readonly TraceEvent[]): CompleteRead[] {
  const observations: CompleteRead[] = [];
  for (const event of trace) {
    if (!isBuiltinTraceEvent(event) || event.type !== "tool_call" || event.error !== null) continue;
    const tool = event.tool_name ? `${event.mcp_name}.${event.tool_name}` : event.mcp_name;
    if (tool === "read_file") {
      const args = event.arguments as { path?: unknown; offset?: unknown; limit?: unknown };
      if (
        typeof args.path === "string" &&
        args.offset === undefined &&
        args.limit === undefined &&
        !event.result.includes("continue with offset=")
      )
        observations.push({ tool, paths: [args.path], result: event.result });
    } else if (tool === "read_files") {
      const args = event.arguments as { paths?: unknown };
      if (
        Array.isArray(args.paths) &&
        args.paths.every((path) => typeof path === "string") &&
        !event.result.includes("more file(s) not shown") &&
        !event.result.includes("use read_file for the rest")
      )
        observations.push({ tool, paths: args.paths, result: event.result });
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
  if (observation.tool === "read_file") return observation.result === body;
  const section = `==> ${path} <==\n${body}`;
  return (
    observation.result === section ||
    observation.result.startsWith(`${section}\n\n`) ||
    observation.result.endsWith(`\n\n${section}`) ||
    observation.result.includes(`\n\n${section}\n\n`)
  );
}

/** Bind model-reported inspected paths to complete successful reads and current confined bytes. */
export async function verifyTraceInspectedArtifacts(options: {
  trace: readonly TraceEvent[];
  paths: readonly string[];
  readFile(path: string): Promise<{ path: string; content: string }>;
}): Promise<Array<{ path: string; digest: string }>> {
  const paths = [...new Set(options.paths)];
  if (paths.length !== options.paths.length || paths.length > 32)
    throw new Error("Goal verifier inspected paths must be bounded and unique");
  const reads = completeReads(options.trace);
  const artifacts: Array<{ path: string; digest: string }> = [];
  for (const requested of paths) {
    const current = await options.readFile(requested);
    if (!reads.some((observation) => exactRead(observation, requested, current.content)))
      throw new Error("Goal verifier path was not read completely in its own trace");
    artifacts.push({
      path: current.path,
      digest: createHash("sha256").update(current.content).digest("hex"),
    });
  }
  return artifacts;
}

/** Revalidate a previously inspected snapshot without accepting replacement bytes. */
export async function verificationArtifactsCurrent(
  artifacts: readonly { path: string; digest: string }[],
  readFile: (path: string) => Promise<{ path: string; content: string }>,
): Promise<boolean> {
  for (const artifact of artifacts) {
    try {
      const current = await readFile(artifact.path);
      if (createHash("sha256").update(current.content).digest("hex") !== artifact.digest)
        return false;
    } catch {
      return false;
    }
  }
  return true;
}
