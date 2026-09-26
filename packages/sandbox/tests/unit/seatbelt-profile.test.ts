import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createExecutionPolicy, seatbeltProfile } from "../../src/index.ts";

test("Seatbelt profile escapes paths and keeps read-only workspace writes closed", () => {
  const root = mkdtempSync(join(tmpdir(), 'clarvis-sandbox-"profile-'));
  try {
    mkdirSync(join(root, ".clarvis", "workflows"), { recursive: true });
    writeFileSync(join(root, ".clarvis", "settings.json"), "{}");
    const policy = createExecutionPolicy({
      id: "profile",
      mode: "sandbox",
      workspaceRoot: root,
      homeRoot: root,
      globalRoot: join(root, ".clarvis"),
      workspaceAccess: "read-only",
      network: "disabled",
    });
    const profile = seatbeltProfile(policy);
    expect(profile).toContain(
      `(allow file-read* (require-all (subpath "/") ` +
        `(require-not (literal ${JSON.stringify(policy.globalRoot)})) ` +
        `(require-not (subpath ${JSON.stringify(policy.globalRoot)})) ` +
        `(require-not (literal "/dev")) (require-not (subpath "/dev"))))`,
    );
    expect(profile).not.toContain(
      `(allow file-read* file-write* (subpath ${JSON.stringify(policy.workspaceRoot)}))`,
    );
    expect(profile).not.toContain(
      `(deny file-write* (subpath ${JSON.stringify(policy.workspaceRoot)}))`,
    );
    expect(profile).not.toContain("(allow network*)");
    expect(profile).toContain('(allow file-read* file-write* (literal "/dev/null"))');
    expect(profile).toContain(
      '(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))',
    );
    expect(profile).toContain("(allow signal (target self))");
    expect(profile).toContain("(deny system-socket (socket-domain AF_UNIX))");
    const globalDeny = profile.indexOf(
      `(require-not (subpath ${JSON.stringify(policy.globalRoot)}))`,
    );
    const workflowAllow = profile.indexOf(
      `(allow file-read* file-write* (subpath ${JSON.stringify(policy.workflowsRoot)}))`,
    );
    expect(globalDeny).toBeGreaterThan(0);
    expect(workflowAllow).toBeGreaterThan(globalDeny);
    expect(profile).toContain(
      `(allow file-read-metadata (literal ${JSON.stringify(policy.globalRoot)}))`,
    );
    expect(profile).toContain(
      `(allow file-read-metadata (literal ${JSON.stringify(dirname(policy.workspaceRoot))}))`,
    );
    expect(
      profile.indexOf(
        `(allow file-read* file-write* (literal ${JSON.stringify(policy.settingsFile)}))`,
      ),
    ).toBeGreaterThan(globalDeny);
    expect(profile).toContain(
      `(deny file-read* file-write* (subpath ${JSON.stringify(join(policy.homeRoot, ".ssh"))}))`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Seatbelt temporary grants exclude a private global root and read-only workspace", () => {
  const root = mkdtempSync(join("/tmp", "clarvis-seatbelt-temp-policy-"));
  try {
    const workspace = join(root, "workspace");
    const global = join(root, "home", ".clarvis");
    mkdirSync(workspace);
    mkdirSync(global, { recursive: true });
    const policy = createExecutionPolicy({
      id: "temporary-precedence",
      mode: "sandbox",
      workspaceRoot: workspace,
      workspaceAccess: "read-only",
      homeRoot: join(root, "home"),
      globalRoot: global,
    });
    const temporaryGrant = seatbeltProfile(policy)
      .split("\n")
      .find((line) =>
        line.startsWith('(allow file-read* file-write* (require-all (subpath "/tmp")'),
      );
    expect(temporaryGrant).toContain(
      `(require-not (literal ${JSON.stringify(policy.globalRoot)}))`,
    );
    expect(temporaryGrant).toContain(
      `(require-not (literal ${JSON.stringify(policy.workspaceRoot)}))`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
