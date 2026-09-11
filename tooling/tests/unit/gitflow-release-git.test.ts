import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withoutGitRepositoryEnvironment } from "@clarvis/paths";

const automation = resolve("tooling/release/gitflow.ts");

test("signed candidate sequence and final merge tag survive retries without rewriting refs", () => {
  const directory = mkdtempSync(join(tmpdir(), "clarvis-gitflow-"));
  const checkout = join(directory, "source");
  const remote = join(directory, "remote.git");
  const key = join(directory, "signing-key");
  const eventPath = join(directory, "event.json");
  const inheritedEnv = {
    ...process.env,
    GIT_DIR: join(directory, "unrelated.git"),
    GIT_WORK_TREE: join(directory, "unrelated-worktree"),
    GIT_INDEX_FILE: join(directory, "unrelated-index"),
  };
  const run = (argv: string[], cwd = directory, env: NodeJS.ProcessEnv = inheritedEnv) => {
    const result = Bun.spawnSync(argv, {
      cwd,
      env: withoutGitRepositoryEnvironment(env),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const git = (...args: string[]) => run(["git", ...args], checkout);
  const repository = { full_name: "getclarvis/clarvis" };
  const invoke = (eventName: string, payload: unknown) => {
    writeFileSync(eventPath, JSON.stringify(payload));
    return run([process.execPath, automation, "publish"], checkout, {
      ...inheritedEnv,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
    });
  };
  try {
    run(["git", "init", "--bare", remote]);
    run(["git", "init", "--initial-branch=main", checkout]);
    run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key]);
    writeFileSync(join(directory, "allowed"), `bot ${run(["ssh-keygen", "-y", "-f", key])}\n`);
    git("config", "user.name", "Test Bot");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "gpg.format", "ssh");
    git("config", "user.signingkey", key);
    git("config", "gpg.ssh.allowedSignersFile", join(directory, "allowed"));
    git("remote", "add", "origin", remote);
    writeFileSync(join(checkout, "package.json"), '{"version":"0.1.1"}\n');
    git("add", ".");
    git("commit", "-m", "published baseline");
    git("push", "origin", "main");
    git("switch", "-c", "release/0.2.0");
    writeFileSync(join(checkout, "package.json"), '{"version":"0.2.0"}\n');
    git("commit", "-am", "prepare release");
    const first = git("rev-parse", "HEAD");
    const event = {
      repository,
      action: "opened",
      pull_request: {
        state: "open",
        base: { ref: "main" },
        head: { ref: "release/0.2.0", sha: first, repo: repository },
      },
    };
    invoke("pull_request", event);
    expect(git("rev-parse", "v0.2.0-rc.1^{commit}")).toBe(first);
    expect(invoke("pull_request", event)).toContain("already exists");
    writeFileSync(join(checkout, "fix.txt"), "stabilization\n");
    git("add", ".");
    git("commit", "-m", "stabilize");
    const head = git("rev-parse", "HEAD");
    invoke("pull_request", {
      ...event,
      action: "synchronize",
      pull_request: { ...event.pull_request, head: { ...event.pull_request.head, sha: head } },
    });
    expect(git("rev-parse", "v0.2.0-rc.2^{commit}")).toBe(head);
    git("switch", "main");
    git("merge", "--no-ff", "release/0.2.0", "-m", "release promotion");
    const merged = git("rev-parse", "HEAD");
    git("push", "origin", "main");
    const promotion = {
      repository,
      action: "closed",
      pull_request: {
        merged: true,
        base: { ref: "main" },
        head: { ref: "release/0.2.0", sha: head, repo: repository },
        merge_commit_sha: merged,
      },
    };
    invoke("pull_request", promotion);
    expect(git("rev-parse", "v0.2.0^{commit}")).toBe(merged);
    expect(invoke("pull_request", promotion)).toContain("already exists");
    expect(git("ls-remote", "origin", "refs/tags/v0.2.0^{}")).toContain(merged);
    git("verify-tag", "v0.2.0");
    git("commit", "--allow-empty", "-m", "later main");
    git("push", "origin", "main");
    git("checkout", "--detach", merged);
    expect(() => invoke("pull_request", promotion)).toThrow("main has advanced");
    expect(git("rev-parse", "v0.2.0-rc.1^{commit}")).toBe(first);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
