import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const dockerfile = readFileSync(`${root}/packages/server/Dockerfile`, "utf8");
const workspaces = (
  JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as {
    workspaces: string[];
  }
).workspaces;

describe("server image build context", () => {
  it("copies every workspace manifest before the frozen install", () => {
    for (const workspace of workspaces) {
      expect(dockerfile).toContain(`COPY ${workspace}/package.json`);
    }
  });

  it("keeps Docker exclusions at the repository-root build context", () => {
    const ignore = readFileSync(`${root}/.dockerignore`, "utf8");
    expect(ignore).toContain("**/node_modules");
    expect(ignore).toContain("**/.clarvis");
    expect(ignore).toContain("**/keys.json");
  });

  it("builds the library graph without bundling the unrelated terminal client", () => {
    expect(dockerfile).toContain("RUN bun run build:packages");
    expect(dockerfile).not.toContain("RUN bun run build\n");
  });
});
