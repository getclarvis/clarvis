import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  cleanDevelopmentState,
  clearDevelopmentTempWorkspaces,
  createEmptyDevelopmentWorkspace,
  DEVELOPMENT_LAUNCHER_MARKER,
  developmentInstallHelp,
  installDevelopmentLauncher,
  parseDevelopmentInstallArgs,
  uninstallDevelopmentLauncher,
} from "../../tooling/development-install.ts";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clarvis-develop-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("development install arguments keep cleaning and removal explicit", () => {
  expect(parseDevelopmentInstallArgs([])).toEqual({ mode: "install", clear: false });
  expect(parseDevelopmentInstallArgs(["--clear"])).toEqual({ mode: "install", clear: true });
  expect(parseDevelopmentInstallArgs(["--clear-only"])).toEqual({
    mode: "clear-only",
    clear: false,
  });
  expect(parseDevelopmentInstallArgs(["--uninstall"])).toEqual({
    mode: "uninstall",
    clear: false,
  });
  expect(() => parseDevelopmentInstallArgs(["--wat"])).toThrow("unknown option");
  expect(() => parseDevelopmentInstallArgs(["--uninstall", "--clear"])).toThrow(
    "--clear is available only",
  );
  expect(developmentInstallHelp()).toContain("clarvis-develop --clear");
  expect(developmentInstallHelp()).toContain("clarvis-develop --empty-workspace");
});

test("managed launcher runs the checkout source while preserving the caller workspace", async () => {
  const root = await temporaryRoot();
  const repository = join(root, "checkout with spaces");
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  const emptyWorkspace = join(root, "empty-workspace");
  const fakeBun = join(root, "fake-bun");
  const log = join(root, "invocation.log");
  const clearLog = join(root, "clear.log");
  await mkdir(join(repository, "packages", "code", "src"), { recursive: true });
  await mkdir(join(repository, "packages", "code", "tooling"), { recursive: true });
  await mkdir(workspace);
  await mkdir(emptyWorkspace);
  const canonicalWorkspace = await realpath(workspace);
  await writeFile(join(repository, "packages", "code", "src", "cli.ts"), "");
  await writeFile(join(repository, "packages", "code", "tooling", "development-install.ts"), "");
  await writeFile(
    fakeBun,
    [
      "#!/bin/sh",
      'if [ "${2-}" = "--clear-only" ]; then printf clear > "$FAKE_CLEAR_LOG"; exit 0; fi',
      'if [ "${2-}" = "--create-empty-workspace" ]; then printf "%s\\n" "$FAKE_WORKSPACE"; exit 0; fi',
      'printf \'cwd=%s\\nsource=%s\\nentry=%s\\narg=%s\\n\' "$PWD" "${CLARVIS_CODE_SOURCE-}" "$1" "$2" > "$FAKE_LOG"',
      "",
    ].join("\n"),
  );
  await chmod(fakeBun, 0o755);

  const launcher = await installDevelopmentLauncher({
    repository,
    bun: fakeBun,
    binDirectory: bin,
  });
  const child = spawnSync(launcher, ["--version"], {
    cwd: workspace,
    env: { ...process.env, FAKE_LOG: log },
  });
  expect(child.status).toBe(0);
  expect(await readFile(log, "utf8")).toBe(
    `cwd=${canonicalWorkspace}\nsource=1\nentry=${repository}/packages/code/src/cli.ts\narg=--version\n`,
  );
  expect(await readFile(launcher, "utf8")).toContain(DEVELOPMENT_LAUNCHER_MARKER);

  await rm(log);
  const cleared = spawnSync(launcher, ["--clear"], {
    cwd: workspace,
    env: { ...process.env, FAKE_CLEAR_LOG: clearLog },
  });
  expect(cleared.status).toBe(0);
  expect(await readFile(clearLog, "utf8")).toBe("clear");
  await expect(lstat(log)).rejects.toMatchObject({ code: "ENOENT" });

  await rm(clearLog);
  const isolated = spawnSync(launcher, ["--clear", "--empty-workspace", "--version"], {
    cwd: workspace,
    env: {
      ...process.env,
      FAKE_CLEAR_LOG: clearLog,
      FAKE_LOG: log,
      FAKE_WORKSPACE: emptyWorkspace,
    },
  });
  expect(isolated.status).toBe(0);
  expect(await readFile(clearLog, "utf8")).toBe("clear");
  expect(await readFile(log, "utf8")).toBe(
    `cwd=${emptyWorkspace}\nsource=1\nentry=${repository}/packages/code/src/cli.ts\narg=--version\n`,
  );
});

test("launcher installation updates only its own regular file", async () => {
  const root = await temporaryRoot();
  const bin = join(root, "bin");
  const launcher = join(bin, "clarvis-develop");
  await mkdir(bin);
  await writeFile(launcher, "unrelated\n");
  await expect(
    installDevelopmentLauncher({ repository: root, bun: process.execPath, binDirectory: bin }),
  ).rejects.toThrow("unmanaged launcher");
  expect(await readFile(launcher, "utf8")).toBe("unrelated\n");

  const unrelated = join(root, "unrelated-target");
  await writeFile(unrelated, "keep\n");
  await rm(launcher);
  await symlink(unrelated, launcher);
  await expect(
    installDevelopmentLauncher({ repository: root, bun: process.execPath, binDirectory: bin }),
  ).rejects.toThrow("non-regular launcher");
  expect(await readFile(unrelated, "utf8")).toBe("keep\n");

  await rm(launcher);
  await writeFile(launcher, `${DEVELOPMENT_LAUNCHER_MARKER}\nold\n`);
  await installDevelopmentLauncher({ repository: root, bun: process.execPath, binDirectory: bin });
  expect(await readFile(launcher, "utf8")).toContain(`repository='${root}'`);
  expect(await uninstallDevelopmentLauncher(bin)).toBe(true);
  await expect(lstat(launcher)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await uninstallDevelopmentLauncher(bin)).toBe(false);
});

test("clean removes only a real global-state directory below home", async () => {
  const home = await temporaryRoot();
  const state = join(home, ".clarvis");
  await mkdir(state);
  await writeFile(join(state, "settings.json"), "secret");
  expect(await cleanDevelopmentState(state, home)).toBe(true);
  await expect(lstat(state)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await cleanDevelopmentState(state, home)).toBe(false);

  const outside = await temporaryRoot();
  await writeFile(join(outside, "keep"), "yes");
  await symlink(outside, state, "dir");
  await expect(cleanDevelopmentState(state, home)).rejects.toThrow("linked global state");
  expect(await readFile(join(outside, "keep"), "utf8")).toBe("yes");
  await expect(cleanDevelopmentState(home, home)).rejects.toThrow("outside the user home");
  await expect(cleanDevelopmentState(outside, home)).rejects.toThrow("outside the user home");
});

test("empty workspaces are always new and clear removes only the authenticated root", async () => {
  const parent = await temporaryRoot();
  const root = join(parent, "clarvis-development-temp");
  const first = await createEmptyDevelopmentWorkspace(root);
  const second = await createEmptyDevelopmentWorkspace(root);
  expect(first).not.toBe(second);
  expect((await lstat(first)).isDirectory()).toBe(true);
  expect((await lstat(second)).isDirectory()).toBe(true);
  expect(await readdir(first)).toEqual([]);
  expect(await readdir(second)).toEqual([]);
  await writeFile(join(first, "workspace-state"), "test");
  expect(await clearDevelopmentTempWorkspaces(root)).toBe(true);
  await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await clearDevelopmentTempWorkspaces(root)).toBe(false);

  await mkdir(root);
  await expect(clearDevelopmentTempWorkspaces(root)).rejects.toThrow("invalid marker");
  expect((await lstat(root)).isDirectory()).toBe(true);

  await rm(root, { recursive: true });
  const outside = join(parent, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "yes");
  await symlink(outside, root, "dir");
  await expect(clearDevelopmentTempWorkspaces(root)).rejects.toThrow(
    "unmanaged temporary-workspace root",
  );
  expect(await readFile(join(outside, "keep"), "utf8")).toBe("yes");
});

test("the POSIX entry delegates to the typed installer", async () => {
  const source = await readFile(
    join(import.meta.dir, "..", "..", "..", "..", "dev-install.sh"),
    "utf8",
  );
  expect(source.startsWith("#!/bin/sh\nset -eu\n")).toBe(true);
  expect(source).toContain('packages/code/tooling/development-install.ts" "$@"');
  expect(source).not.toContain("rm -rf");
});
