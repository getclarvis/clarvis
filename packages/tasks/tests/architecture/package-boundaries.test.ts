import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const PACKAGE = join(import.meta.dir, "..", "..");
const ROOT = join(PACKAGE, "..", "..");

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.[cm]?[jt]sx?$/u.test(entry.name)
        ? [path]
        : [];
  });
}

function matchingLines(root: string, pattern: RegExp): string[] {
  return sourceFiles(root).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        pattern.test(line)
          ? [`${relative(ROOT, file).split(sep).join("/")}:${String(index + 1)}`]
          : [],
      ),
  );
}

describe("Tasks package boundaries", () => {
  it("depends only on the capability contract and zod", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["@clarvis/capability", "zod"]);
  });

  it("does not reach the engine, host, protocol, MCP client, UI, or product SDKs", () => {
    expect(
      matchingLines(
        join(PACKAGE, "src"),
        /from\s+["'](?:@clarvis\/(?:loop|kernel|protocol|mcp-client|code)|[^"']*(?:jira|trello|linear)[^"']*)["']/iu,
      ),
    ).toEqual([]);
  });

  it("keeps the loop unaware of Tasks wire names and implementation", () => {
    expect(
      matchingLines(
        join(ROOT, "packages", "loop", "src"),
        /@clarvis\/tasks|\b(?:list_tasks|read_task|create_task|assign_task|comment_task|start_task|block_task|submit_task_for_review|complete_task|reopen_task)\b/u,
      ),
    ).toEqual([]);
  });

  it("keeps protocol and Code on DTOs rather than the domain package", () => {
    expect(matchingLines(join(ROOT, "packages", "protocol", "src"), /@clarvis\/tasks/u)).toEqual(
      [],
    );
    expect(matchingLines(join(ROOT, "packages", "code", "src"), /@clarvis\/tasks/u)).toEqual([]);
  });

  it("binds the narrow server port to MCP acquisition in one kernel adapter", () => {
    const files = sourceFiles(join(ROOT, "packages", "kernel", "src"));
    const adapters = files
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return source.includes("TaskServerPort") && source.includes("connections.acquire");
      })
      .map((file) => relative(ROOT, file).split(sep).join("/"));
    expect(adapters).toEqual(["packages/kernel/src/tasks/task-server-port.ts"]);
  });
});
