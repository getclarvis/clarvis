import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutGitRepositoryEnvironment } from "@clarvis/kernel/local";
import { gitCloneAsync, validateGitUrl } from "../../src/adapters/plugin-install.ts";
import { recordDiagnostics } from "../helpers/recording-diagnostics.ts";

const made: string[] = [];
afterEach(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("validateGitUrl: rejects a URL that git would read as a flag", () => {
  expect(() => validateGitUrl("--upload-pack=/bin/sh")).toThrow(/read by git as a flag/);
});

test("validateGitUrl: rejects git's ext:: transport, which runs a command", () => {
  expect(() => validateGitUrl("ext::sh -c whoami")).toThrow(/ext:: transport/);
});

test("validateGitUrl: rejects cleartext transports — an MITM could swap the code", () => {
  for (const url of ["http://github.com/o/r", "git://github.com/o/r"]) {
    expect(() => validateGitUrl(url)).toThrow(/unauthenticated cleartext/);
  }
});

test("validateGitUrl: refuses a local path in its own words — a marketplace may list one", () => {
  for (const url of ["./plugins/beside", "../beside", "~/beside", "/opt/beside", "C:\\beside"]) {
    expect(() => validateGitUrl(url)).toThrow(/installs a plugin from git/);
  }
});

test("validateGitUrl: rejects shapes that are neither a known transport nor ssh", () => {
  for (const url of ["", "not a url", "javascript:alert(1)"]) {
    expect(() => validateGitUrl(url)).toThrow();
  }
});

test("validateGitUrl: accepts https, ssh, and file:// (local plugin development)", () => {
  expect(validateGitUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
  expect(validateGitUrl("  https://github.com/o/r  ")).toBe("https://github.com/o/r");
  expect(validateGitUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  expect(validateGitUrl("ssh://git@github.com/o/r.git")).toBe("ssh://git@github.com/o/r.git");
  expect(validateGitUrl("file:///tmp/my-plugin")).toBe("file:///tmp/my-plugin");
});

test("a clone cannot inherit repository routing from the process that launched Clarvis", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-plugin-install-env-"));
  made.push(root);
  const source = join(root, "source");
  const checkout = join(root, "checkout");
  mkdirSync(source);
  const environment = withoutGitRepositoryEnvironment(process.env);
  for (const args of [
    ["init", "--quiet", source],
    ["-C", source, "config", "user.email", "tests@clarvis.dev"],
    ["-C", source, "config", "user.name", "Clarvis Tests"],
  ]) {
    expect(spawnSync("git", args, { env: environment }).status).toBe(0);
  }
  writeFileSync(join(source, "README.md"), "fixture\n");
  for (const args of [
    ["-C", source, "add", "README.md"],
    ["-C", source, "commit", "--quiet", "-m", "fixture"],
  ]) {
    expect(spawnSync("git", args, { env: environment }).status).toBe(0);
  }

  const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = join(root, "parent", name);
  try {
    await expect(gitCloneAsync(`file://${source}`, checkout)).resolves.toBeUndefined();
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  expect(spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], { env: environment }).status).toBe(
    0,
  );
});

test("a refused clone records the argv, the exit code and git's own output", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-plugin-install-"));
  made.push(root);
  const recording = recordDiagnostics();
  try {
    await expect(
      gitCloneAsync(`file://${join(root, "no-such-repository")}`, join(root, "into")),
    ).rejects.toThrow(/git clone failed/);
  } finally {
    recording.uninstall();
  }

  const failure = recording.first("plugin.install.failed");
  expect(failure?.level).toBe("error");
  expect(failure?.details.phase).toBe("exit");
  expect(failure?.details.subcommand).toBe("clone");
  expect(String(failure?.details.argv0)).toContain("git");
  expect(failure?.details.exit_code).not.toBe(0);
  // `stderr_tail`, never `stderr`: a field named exactly `stderr` is withheld
  // by the sink's content classifier and would arrive as "[redacted]".
  expect(String(failure?.details.stderr_tail).length).toBeGreaterThan(0);
});
