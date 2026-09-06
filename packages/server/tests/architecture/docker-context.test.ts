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

  it("allowlists the repository-root build context and re-excludes credentials", () => {
    const ignore = readFileSync(`${root}/.dockerignore`, "utf8");
    expect(ignore.split(/\r?\n/u)[0]).toBe("**");
    for (const included of [
      "!package.json",
      "!bun.lock",
      "!packages/**",
      "!tooling/runtime/guest-entry.ts",
      "!third-party/bun/LICENSE.md",
    ]) {
      expect(ignore).toContain(included);
    }
    for (const excluded of [
      "**/node_modules",
      "**/.clarvis",
      "**/keys.json",
      "**/subscriptions.json",
      "**/.env",
      "**/.npmrc",
      "**/.ssh",
      "**/*.pem",
      "**/*.key",
    ]) {
      expect(ignore).toContain(excluded);
    }
  });

  it("builds the library graph without bundling the unrelated terminal client", () => {
    expect(dockerfile).toContain("RUN bun run build:packages");
    expect(dockerfile).not.toContain("RUN bun run build\n");
  });

  it("scales the image run budget with the 200-iteration soft limit", () => {
    expect(dockerfile).toContain("CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT=8000000");
    expect(dockerfile).toContain("CLARVIS_ITERATION_CEILING=200");
  });
});
