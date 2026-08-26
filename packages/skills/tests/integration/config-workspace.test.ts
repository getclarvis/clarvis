import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { resolveConfig } from "@clarvis/skills";
import { StartupError } from "../../src/config.ts";
import { cleanup, makeWorkspace } from "../helpers/fixtures.ts";
import { recordingLogger } from "../helpers/logging.ts";

describe("resolveConfig", () => {
  it("resolves relative roots against the workspace, not the cwd", () => {
    const ws = makeWorkspace();
    try {
      const config = resolveConfig({
        home: "/home/u",
        cwd: "/cwd",
        workspace: ws,
        roots: [{ path: "skills" }],
      });
      expect(config.roots[0]?.path).toBe(path.join(ws, "skills"));
    } finally {
      cleanup(ws);
    }
  });

  it("accepts an existing workspace directory", () => {
    const ws = makeWorkspace();
    try {
      expect(resolveConfig({ workspace: ws, roots: [{ path: "/x" }] }).workspaceDir).toBe(ws);
    } finally {
      cleanup(ws);
    }
  });

  it("throws StartupError for a workspace that does not exist", () => {
    expect(() =>
      resolveConfig({ workspace: "/no/such/workspace/xyz", roots: [{ path: "/x" }] }),
    ).toThrow(StartupError);
  });

  it("records the errno behind an unusable workspace, which the thrown message hides", () => {
    const recorder = recordingLogger();
    expect(() =>
      resolveConfig({
        workspace: "/no/such/workspace/xyz",
        roots: [{ path: "/x" }],
        logger: recorder.logger,
      }),
    ).toThrow(StartupError);

    const [record] = recorder.events("skills.workspace.unreadable");
    expect(record?.level).toBe("debug");
    expect(record?.fields["cause"]).toEqual(expect.any(String));
  });

  it("throws StartupError for a workspace that is a file, not a directory", () => {
    const ws = makeWorkspace();
    try {
      const file = path.join(ws, "afile");
      writeFileSync(file, "x");
      expect(() => resolveConfig({ workspace: file, roots: [{ path: "/x" }] })).toThrow(
        /not a directory/,
      );
    } finally {
      cleanup(ws);
    }
  });
});
