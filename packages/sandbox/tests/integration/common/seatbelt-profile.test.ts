import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionPolicy, seatbeltProfile } from "#src/index.ts";

test("Seatbelt preserves workspace metadata and explicit read denies", () => {
  const root = mkdtempSync(join(tmpdir(), 'clarvis-sandbox-"profile-'));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const denied = join(root, "denied");
    const policy = createExecutionPolicy({
      id: "profile",
      mode: "sandbox",
      workspaceRoot: workspace,
      homeRoot: root,
      globalRoot: join(root, ".clarvis"),
      workspaceAccess: "read-write",
      network: "disabled",
      denies: [denied],
    });
    const profile = seatbeltProfile(policy);
    expect(profile).toContain('(allow file-read* (require-all (subpath "/")');
    expect(profile).toContain(
      `(deny file-write* (subpath ${JSON.stringify(join(workspace, ".git"))}))`,
    );
    expect(profile).toContain(`(deny file-read* file-write* (subpath ${JSON.stringify(denied)}))`);
    expect(profile).toContain("(allow system-socket (socket-domain AF_UNIX))");
    expect(profile).not.toContain("(allow network*)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Seatbelt read-only profile denies workspace writes while keeping scratch writable", () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-seatbelt-policy-"));
  try {
    const workspace = join(root, "workspace");
    const scratch = join(root, "scratch");
    mkdirSync(workspace);
    mkdirSync(scratch);
    const policy = createExecutionPolicy({
      id: "readonly",
      mode: "sandbox",
      workspaceRoot: workspace,
      homeRoot: root,
      workspaceAccess: "read-only",
      temporaryWriteRoots: [root, scratch],
    });
    const profile = seatbeltProfile(policy);
    expect(profile).toContain(`(require-not (literal ${JSON.stringify(workspace)}))`);
    expect(profile).toContain(
      `(allow file-read* file-write* (subpath ${JSON.stringify(scratch)}))`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Seatbelt explicit temporary policy grants only private scratch writes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clarvis-seatbelt-scratch-")));
  try {
    const workspace = join(root, "workspace");
    const scratch = join(root, "scratch");
    mkdirSync(workspace);
    mkdirSync(scratch);
    const profile = seatbeltProfile(
      createExecutionPolicy({
        id: "scratch",
        mode: "sandbox",
        workspaceRoot: workspace,
        homeRoot: root,
        workspaceAccess: "read-only",
        sharedTemporaryWrites: false,
        temporaryWriteRoots: [scratch],
      }),
    );
    const grants = profile
      .split("\n")
      .filter((line) => line.startsWith("(allow") && line.includes("file-write*"));
    expect(grants).toEqual([
      '(allow file-read* file-write* (literal "/dev/null"))',
      `(allow file-read* file-write* (subpath ${JSON.stringify(scratch)}))`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Seatbelt approved workspace grants override its preference and retain mandatory denies", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clarvis-seatbelt-grant-")));
  try {
    const workspace = join(root, "workspace");
    const alias = join(root, "alias");
    const protectedPath = join(workspace, "protected");
    mkdirSync(workspace);
    symlinkSync(workspace, alias);
    const profile = seatbeltProfile(
      createExecutionPolicy({
        id: "approved",
        mode: "sandbox",
        workspaceRoot: workspace,
        homeRoot: root,
        workspaceAccess: "read-only",
        additionalWriteRoots: [alias],
        readOnlyPaths: [protectedPath],
      }),
    );
    expect(profile).toContain(
      `(allow file-read* file-write* (subpath ${JSON.stringify(workspace)}))`,
    );
    expect(profile).toContain(`(deny file-write* (literal ${JSON.stringify(protectedPath)}))`);
    expect(profile).toContain(`(deny file-write* (subpath ${JSON.stringify(protectedPath)}))`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
