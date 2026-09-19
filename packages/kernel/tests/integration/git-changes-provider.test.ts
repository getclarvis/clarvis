import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { withoutGitRepositoryEnvironment } from "@clarvis/paths";
import { createNodeProcessRunner } from "../../src/adapters/process/node-process-runner.ts";
import { createGitChangesProvider } from "../../src/workspace/git-changes-provider.ts";
import { createWorkspaceChangesService } from "../../src/workspace/workspace-changes-service.ts";
import type {
  WorkspaceChangesContext,
  WorkspaceChangesProvider,
} from "../../src/workspace/changes-provider.ts";
import type { WorkspaceChangesAvailability } from "@clarvis/protocol";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join("/tmp", prefix));
  roots.push(dir);
  return realpathSync(dir);
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...withoutGitRepositoryEnvironment(process.env),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function initRepo(dir: string): void {
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.name", "Clarvis Test"]);
  git(dir, ["config", "user.email", "test@clarvis.invalid"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function ctx(root: string): WorkspaceChangesContext {
  return { workspaceRoot: root, workspaceId: "ws_test", projectId: "prj_test" };
}

function provider(): ReturnType<typeof createGitChangesProvider> {
  return createGitChangesProvider({ processRunner: createNodeProcessRunner() });
}

describe("GitChangesProvider", () => {
  it("reports not_applicable outside a repository", async () => {
    const root = tempDir("clarvis-changes-none-");
    const availability = await provider().probe(ctx(root));
    expect(availability.status).toBe("not_applicable");
    if (availability.status !== "not_applicable") throw new Error("expected not_applicable");
    expect(availability.reason.code).toBe("not_a_repository");
  });

  it("reports unavailable when the git executable is missing", async () => {
    const root = tempDir("clarvis-changes-nogit-");
    const availability = await createGitChangesProvider({
      processRunner: createNodeProcessRunner(),
      gitExecutable: join(root, "no-such-git"),
    }).probe(ctx(root));
    expect(availability.status).toBe("unavailable");
    if (availability.status !== "unavailable") throw new Error("expected unavailable");
    expect(availability.reason.code).toBe("executable_missing");
  });

  it("lists all, staged, unstaged and untracked without mutating the repository", async () => {
    const root = tempDir("clarvis-changes-cmp-");
    initRepo(root);
    writeFileSync(join(root, "tracked.txt"), "one\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "--quiet", "-m", "initial"]);
    writeFileSync(join(root, "tracked.txt"), "two\n");
    writeFileSync(join(root, "staged.txt"), "staged\n");
    git(root, ["add", "staged.txt"]);
    writeFileSync(join(root, "unstaged.txt"), "loose\n");
    writeFileSync(join(root, "ignored.txt"), "nope\n");
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    const before = {
      head: git(root, ["rev-parse", "HEAD"]),
      status: git(root, ["status", "--porcelain=v1", "-uall"]),
      index: git(root, ["ls-files", "-s"]),
    };
    const gitProvider = provider();
    const availability = await gitProvider.probe(ctx(root));
    expect(availability.status).toBe("available");
    if (availability.status !== "available") throw new Error("expected available");
    expect(availability.provider.default_comparison_id).toBe("all");
    expect(availability.provider.capabilities.staging).toBe(true);

    const all = await gitProvider.listChanges(ctx(root), { comparison_id: "all" });
    const staged = await gitProvider.listChanges(ctx(root), { comparison_id: "staged" });
    const unstaged = await gitProvider.listChanges(ctx(root), { comparison_id: "unstaged" });
    const names = (page: typeof all): string[] =>
      page.items.map((item) => item.new_path ?? item.old_path ?? "").sort();

    expect(names(all)).toEqual([".gitignore", "staged.txt", "tracked.txt", "unstaged.txt"]);
    expect(names(all).includes("ignored.txt")).toBe(false);
    expect(names(staged)).toEqual(["staged.txt"]);
    expect(names(unstaged)).toEqual([".gitignore", "tracked.txt", "unstaged.txt"]);
    expect(all.items.find((item) => item.new_path === "unstaged.txt")?.operation).toBe("added");
    expect(all.items.find((item) => item.new_path === "unstaged.txt")?.unstaged).toBe(true);

    const tracked = all.items.find((item) => item.new_path === "tracked.txt");
    expect(tracked).toBeDefined();
    const detail = await gitProvider.readChange(ctx(root), {
      query_id: all.query_id,
      entry_id: tracked!.id,
      comparison_id: "all",
    });
    expect(detail.status).toBe("ready");
    expect(detail.patch).toContain("+two");
    expect(detail.patch).toContain("-one");

    const untracked = all.items.find((item) => item.new_path === "unstaged.txt")!;
    const added = await gitProvider.readChange(ctx(root), {
      query_id: all.query_id,
      entry_id: untracked.id,
    });
    expect(added.status).toBe("ready");
    expect(added.patch).toContain("--- /dev/null");
    expect(added.patch).toContain("+++ b/unstaged.txt");
    expect(added.patch).toContain("+loose");

    expect(git(root, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(git(root, ["status", "--porcelain=v1", "-uall"])).toBe(before.status);
    expect(git(root, ["ls-files", "-s"])).toBe(before.index);
  });

  it("treats a staged change reverted in the worktree as empty in All", async () => {
    const root = tempDir("clarvis-changes-net-");
    initRepo(root);
    writeFileSync(join(root, "a.txt"), "base\n");
    git(root, ["add", "a.txt"]);
    git(root, ["commit", "--quiet", "-m", "initial"]);
    writeFileSync(join(root, "a.txt"), "staged\n");
    git(root, ["add", "a.txt"]);
    writeFileSync(join(root, "a.txt"), "base\n");
    const gitProvider = provider();
    const all = await gitProvider.listChanges(ctx(root), { comparison_id: "all" });
    const staged = await gitProvider.listChanges(ctx(root), { comparison_id: "staged" });
    const unstaged = await gitProvider.listChanges(ctx(root), { comparison_id: "unstaged" });
    expect(all.items).toEqual([]);
    expect(staged.items).toHaveLength(1);
    expect(unstaged.items).toHaveLength(1);
  });

  it("covers rename, empty add, binary, no commits and subdirectory confinement", async () => {
    const root = tempDir("clarvis-changes-special-");
    initRepo(root);
    mkdirSync(join(root, "pkg"));
    writeFileSync(join(root, "pkg", "keep.txt"), "keep\n");
    writeFileSync(join(root, "outside.txt"), "out\n");
    git(root, ["add", "pkg/keep.txt", "outside.txt"]);
    git(root, ["commit", "--quiet", "-m", "initial"]);
    git(root, ["mv", "pkg/keep.txt", "pkg/renamed.txt"]);
    writeFileSync(join(root, "pkg", "empty.txt"), "");
    writeFileSync(join(root, "pkg", "data.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(root, "pkg", "outside-not.txt"), "nope\n");
    const gitProvider = provider();
    const nested = ctx(join(root, "pkg"));
    const page = await gitProvider.listChanges(nested, { comparison_id: "all" });
    const names = page.items.map((item) => item.new_path ?? item.old_path ?? "").sort();
    expect(names).toEqual(["data.bin", "empty.txt", "outside-not.txt", "renamed.txt"]);
    expect(names.includes("outside.txt")).toBe(false);
    const renamed = page.items.find((item) => item.operation === "renamed");
    expect(renamed?.old_path).toBe("keep.txt");
    expect(renamed?.new_path).toBe("renamed.txt");
    const empty = page.items.find((item) => item.new_path === "empty.txt")!;
    const emptyDetail = await gitProvider.readChange(nested, {
      query_id: page.query_id,
      entry_id: empty.id,
    });
    expect(["ready", "empty"]).toContain(emptyDetail.status);
    const binary = page.items.find((item) => item.new_path === "data.bin")!;
    const binaryDetail = await gitProvider.readChange(nested, {
      query_id: page.query_id,
      entry_id: binary.id,
    });
    expect(binaryDetail.status).toBe("binary");

    const fresh = tempDir("clarvis-changes-emptyhead-");
    initRepo(fresh);
    writeFileSync(join(fresh, "first.txt"), "hello\n");
    const noCommit = await provider().listChanges(ctx(fresh), { comparison_id: "all" });
    expect(noCommit.resolved_base).toBe("empty tree");
    expect(noCommit.items.some((item) => item.new_path === "first.txt")).toBe(true);
  });

  it("reports conflicts without treating them as an ordinary patch", async () => {
    const root = tempDir("clarvis-changes-conflict-");
    initRepo(root);
    writeFileSync(join(root, "c.txt"), "base\n");
    git(root, ["add", "c.txt"]);
    git(root, ["commit", "--quiet", "-m", "base"]);
    git(root, ["checkout", "-q", "-b", "other"]);
    writeFileSync(join(root, "c.txt"), "other\n");
    git(root, ["add", "c.txt"]);
    git(root, ["commit", "--quiet", "-m", "other"]);
    git(root, ["checkout", "-q", "main"]);
    writeFileSync(join(root, "c.txt"), "main\n");
    git(root, ["add", "c.txt"]);
    git(root, ["commit", "--quiet", "-m", "main"]);
    const merge = spawnSync("git", ["merge", "other"], {
      cwd: root,
      encoding: "utf8",
      env: withoutGitRepositoryEnvironment(process.env),
    });
    expect(merge.status).not.toBe(0);
    const gitProvider = provider();
    const page = await gitProvider.listChanges(ctx(root), { comparison_id: "all" });
    const conflict = page.items.find((item) => item.operation === "conflict");
    expect(conflict).toBeDefined();
    const detail = await gitProvider.readChange(ctx(root), {
      query_id: page.query_id,
      entry_id: conflict!.id,
    });
    expect(detail.status).toBe("conflict");
    expect(detail.patch).toBeUndefined();
  });

  it("classifies safe.directory and timed-out Git probes", async () => {
    const root = tempDir("clarvis-changes-classify-");
    const safe = createGitChangesProvider({
      processRunner: {
        async run(request) {
          if (request.args.includes("--version"))
            return { exitCode: 0, stdout: "git version 2.45.0\n", stderr: "" };
          if (request.args.includes("--is-inside-work-tree")) {
            return {
              exitCode: 128,
              stdout: "",
              stderr: "fatal: detected dubious ownership in repository",
            };
          }
          return { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" };
        },
      },
      gitExecutable: "/usr/bin/git",
    });
    const availability = await safe.probe(ctx(root));
    expect(availability.status).toBe("unavailable");
    if (availability.status !== "unavailable") throw new Error("expected unavailable");
    expect(availability.reason.code).toBe("safe_directory_refused");

    const timed = createGitChangesProvider({
      processRunner: {
        async run(request) {
          if (request.args.includes("--version"))
            return { exitCode: 0, stdout: "git version 2.45.0\n", stderr: "" };
          throw new Error("process timed out");
        },
      },
      gitExecutable: "/usr/bin/git",
    });
    await expect(timed.probe(ctx(root))).rejects.toMatchObject({ code: "resource_exhausted" });
  });

  it("propagates cancellation", async () => {
    const root = tempDir("clarvis-changes-cancel-");
    initRepo(root);
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider().probe({ ...ctx(root), signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "cancelled",
    });
  });
});

describe("createWorkspaceChangesService", () => {
  it("activates a single applicable provider and refuses ambiguity", async () => {
    const fake = (
      id: string,
      status: WorkspaceChangesAvailability["status"],
    ): WorkspaceChangesProvider => ({
      id,
      probe: async () =>
        status === "available"
          ? {
              status: "available",
              provider: {
                id,
                name: id,
                workspace_identity: "ws",
                default_comparison_id: "current",
                comparisons: [{ id: "current", label: "Current", description: "fake comparison" }],
                capabilities: { staging: false, renames: false, conflicts: false },
              },
            }
          : {
              status,
              reason: { code: "not_a_repository", message: "no" },
            },
      listChanges: async () => ({
        query_id: `${id}:q`,
        comparison_id: "current",
        resolved_base: "now",
        incomplete: false,
        items: [{ id: `${id}:a`, new_path: "a.txt", operation: "modified" }],
      }),
      readChange: async () => ({
        entry_id: `${id}:a`,
        query_id: `${id}:q`,
        comparison_id: "current",
        resolved_base: "now",
        status: "ready",
        patch: "--- a/a.txt\n+++ b/a.txt\n",
      }),
    });
    const root = tempDir("clarvis-changes-svc-");
    const one = createWorkspaceChangesService({
      workspaceRoot: root,
      workspaceId: "ws",
      projectId: "prj",
      providers: [fake("alpha", "available")],
    });
    const availability = await one.availability();
    expect(availability.status).toBe("available");
    const page = await one.list();
    expect(page.items[0]?.new_path).toBe("a.txt");
    const detail = await one.read({
      query_id: page.query_id,
      entry_id: page.items[0]!.id,
    });
    expect(detail.status).toBe("ready");

    const failed = createWorkspaceChangesService({
      workspaceRoot: root,
      workspaceId: "ws",
      projectId: "prj",
      providers: [fake("gamma", "unavailable")],
    });
    expect((await failed.availability()).status).toBe("unavailable");

    const ambiguous = createWorkspaceChangesService({
      workspaceRoot: root,
      workspaceId: "ws",
      projectId: "prj",
      providers: [fake("alpha", "available"), fake("beta", "available")],
    });
    const blocked = await ambiguous.availability();
    expect(blocked.status).toBe("unavailable");
    if (blocked.status !== "unavailable") throw new Error("expected unavailable");
    expect(blocked.reason.code).toBe("ambiguous_provider");

    const empty = createWorkspaceChangesService({
      workspaceRoot: root,
      workspaceId: "ws",
      projectId: "prj",
      providers: [],
    });
    const none = await empty.availability();
    expect(none.status).toBe("unavailable");
    await expect(empty.list()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("pages, truncates, and reports a stale query", async () => {
    const root = tempDir("clarvis-git-changes-page-");
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.email", "qa@clarvis.invalid"]);
    git(root, ["config", "user.name", "Clarvis QA"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "a.txt"), "one\n");
    writeFileSync(join(root, "b.txt"), "two\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    writeFileSync(join(root, "a.txt"), `${"x".repeat(4000)}\n`);
    writeFileSync(join(root, "b.txt"), "TWO\n");
    const provider = createGitChangesProvider({
      processRunner: createNodeProcessRunner(),
      limits: { maxPatchBytes: 80, defaultPageSize: 1 },
    });
    const ctx: WorkspaceChangesContext = {
      workspaceRoot: root,
      workspaceId: "ws",
      projectId: "prj",
    };
    const first = await provider.listChanges(ctx, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).toBeDefined();
    const second = await provider.listChanges(ctx, { cursor: first.next_cursor, limit: 1 });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    await expect(provider.listChanges(ctx, { comparison_id: "unknown" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    const large = first.items.find((item) => item.new_path === "a.txt") ?? first.items[0]!;
    const truncated = await provider.readChange(ctx, {
      query_id: first.query_id,
      entry_id: large.id,
    });
    expect(["truncated", "ready", "empty"]).toContain(truncated.status);
    const stale = await provider.readChange(ctx, {
      query_id: "git:deadbeef:all:not-a-real-base",
      entry_id: large.id,
    });
    expect(stale.status).toBe("stale");
  });

  it("surfaces not_applicable providers and untracked symlink/binary special cases", async () => {
    const root = tempDir("clarvis-changes-na-");
    const onlyNa = createWorkspaceChangesService({
      workspaceRoot: root,
      workspaceId: "ws",
      projectId: "prj",
      providers: [
        {
          id: "na",
          probe: async () => ({
            status: "not_applicable",
            reason: { code: "not_a_repository", message: "no repo" },
          }),
          listChanges: async () => {
            throw new Error("should not list");
          },
          readChange: async () => {
            throw new Error("should not read");
          },
        },
      ],
    });
    const availability = await onlyNa.availability();
    expect(availability.status).toBe("not_applicable");
    await expect(onlyNa.list()).rejects.toMatchObject({ code: "unsupported" });

    const repo = tempDir("clarvis-changes-symlink-");
    initRepo(repo);
    writeFileSync(join(repo, "tracked.txt"), "base\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["commit", "-m", "base"]);
    writeFileSync(join(repo, "target.txt"), "target\n");
    const { symlinkSync } = await import("node:fs");
    symlinkSync("target.txt", join(repo, "link.txt"));
    writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 0, 255, 0, 1]));
    const gitProvider = createGitChangesProvider({
      processRunner: createNodeProcessRunner(),
      limits: { maxEntries: 2, maxPatchBytes: 40 },
    });
    const page = await gitProvider.listChanges(ctx(repo), { comparison_id: "unstaged" });
    expect(page.items.some((item) => item.new_path === "link.txt")).toBe(true);
    const link = page.items.find((item) => item.new_path === "link.txt");
    if (link === undefined) throw new Error("expected symlink");
    const detail = await gitProvider.readChange(ctx(repo), {
      query_id: page.query_id,
      entry_id: link.id,
    });
    expect(detail.status === "empty" || detail.status === "unavailable").toBe(true);
    const bin = page.items.find((item) => item.new_path === "bin.dat");
    if (bin !== undefined) {
      const binary = await gitProvider.readChange(ctx(repo), {
        query_id: page.query_id,
        entry_id: bin.id,
      });
      expect(["binary", "truncated", "ready"]).toContain(binary.status);
    }
  });
});
