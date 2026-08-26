import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { withoutGitRepositoryEnvironment } from "@clarvis/paths";
import { callTool, cleanup, makeConfig, makeWorkspace } from "../helpers/fixtures.ts";

function initializeRepository(root: string): void {
  const env = withoutGitRepositoryEnvironment(process.env);
  for (const args of [
    ["init", "--quiet", "--initial-branch=main"],
    ["config", "user.name", "Clarvis Test"],
    ["config", "user.email", "test@clarvis.invalid"],
    ["commit", "--quiet", "--allow-empty", "-m", "initial"],
  ]) {
    expect(Bun.spawnSync(["git", ...args], { cwd: root, env }).exitCode).toBe(0);
  }
}

describe("host_vcs", () => {
  let root: string;

  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => cleanup(root));

  it("fails closed when no approval guard is installed", async () => {
    const result = await callTool(
      "host_vcs",
      { program: "git", args: ["ls-remote", "."] },
      makeConfig(root),
    );
    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({
      error: "denied",
      message: "host_vcs requires command review",
    });
  });

  it("passes the exact argv through an approval before running on the host", async () => {
    let request: Record<string, unknown> | undefined;
    const result = await callTool(
      "host_vcs",
      { program: "git", args: ["ls-remote", "."] },
      makeConfig(root, {
        guard: () => ({ verdict: "ask", reason: "host command" }),
        elicit: (candidate) => {
          request = candidate as unknown as Record<string, unknown>;
          return true;
        },
      }),
    );
    expect(request).toMatchObject({
      tool: "host_vcs",
      args: { program: "git", args: ["ls-remote", "."], command: "git ls-remote ." },
      reason: "host command",
    });
    expect(result.isError).toBe(false);
    expect(result.json.exit_code).toBeNumber();
  });

  it("runs a non-VCS executable through exact argv after approval", async () => {
    const result = await callTool(
      "host_vcs",
      {
        program: process.execPath,
        args: ["-e", "process.stdout.write('host fallback')"],
      },
      makeConfig(root, { guard: () => ({ verdict: "allow" }) }),
    );
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ exit_code: 0, stdout: "host fallback" });
  });

  it("inherits ordinary host environment while withholding configured secrets", async () => {
    const publicName = "CLARVIS_HOST_FALLBACK_TEST";
    const secretName = "CLARVIS_HOST_FALLBACK_SECRET";
    const previousPublic = process.env[publicName];
    const previousSecret = process.env[secretName];
    process.env[publicName] = "available";
    process.env[secretName] = "withheld";
    try {
      const result = await callTool(
        "host_vcs",
        {
          program: process.execPath,
          args: [
            "-e",
            `process.stdout.write(String(process.env.${publicName}) + ":" + String(process.env.${secretName}))`,
          ],
        },
        makeConfig(root, {
          guard: () => ({ verdict: "allow" }),
          secretEnvNames: [secretName],
        }),
      );
      expect(result.isError).toBe(false);
      expect(result.json.stdout).toBe("available:undefined");
    } finally {
      if (previousPublic === undefined) delete process.env[publicName];
      else process.env[publicName] = previousPublic;
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
    }
  });

  it("refuses direct credential output even after approval", async () => {
    for (const [program, args] of [
      ["gh", ["auth", "token"]],
      ["git", ["credential", "fill"]],
    ] as const) {
      const result = await callTool(
        "host_vcs",
        { program, args },
        makeConfig(root, { guard: () => ({ verdict: "allow" }) }),
      );
      expect(result.isError).toBe(true);
      expect(result.json.error).toBe("denied");
    }
  });

  it("refuses Git arguments and remote helpers that can execute host programs", async () => {
    for (const args of [
      ["ls-remote", "--upload-pack=printf SHOULD_NOT_RUN", "."],
      ["ls-remote", "--upload-p=printf SHOULD_NOT_RUN", "."],
      ["push", "--exec=printf SHOULD_NOT_RUN", "."],
      ["fetch", "ext::printf SHOULD_NOT_RUN"],
    ]) {
      const result = await callTool(
        "host_vcs",
        { program: "git", args },
        makeConfig(root, { guard: () => ({ verdict: "allow" }) }),
      );
      expect(result.isError).toBe(true);
      expect(result.json.error).toBe("denied");
    }
  });

  it("uses cwd rather than repository-local Git variables inherited from its parent", async () => {
    initializeRepository(root);
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = `${root}/missing-git-dir`;
    try {
      const result = await callTool(
        "host_vcs",
        { program: "git", args: ["push", "--dry-run", ".", "HEAD:refs/heads/copy"] },
        makeConfig(root, { guard: () => ({ verdict: "allow" }) }),
      );
      expect(result.isError).toBe(false);
      expect(result.json.exit_code).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it("confines cwd to the selected workspace", async () => {
    const result = await callTool(
      "host_vcs",
      { program: "git", args: ["ls-remote", "."], cwd: ".." },
      makeConfig(root, { guard: () => ({ verdict: "allow" }) }),
    );
    expect(result.isError).toBe(true);
    expect(result.json.error).toBe("path_escape");
  });

  it("kills commands whose captured host output exceeds the configured bound", async () => {
    initializeRepository(root);
    const env = withoutGitRepositoryEnvironment(process.env);
    for (let index = 0; index < 64; index += 1) {
      expect(
        Bun.spawnSync(["git", "branch", `long-host-output-${String(index).padStart(3, "0")}`], {
          cwd: root,
          env,
        }).exitCode,
      ).toBe(0);
    }

    const result = await callTool(
      "host_vcs",
      { program: "git", args: ["ls-remote", "."] },
      makeConfig(root, {
        guard: () => ({ verdict: "allow" }),
        maxShellOutputBytes: 1024,
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.json.error).toBe("output_limit");
  });
});
