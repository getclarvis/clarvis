import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionPolicy, seatbeltProfile } from "../../src/index.ts";

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
      temporaryWriteRoots: [scratch],
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
