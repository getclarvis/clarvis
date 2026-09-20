import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");

async function source(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

test("artifact, release and installer smoke runners keep the fixture boundary", async () => {
  const [artifact, release, installer, pty] = await Promise.all([
    source("packages/code/tooling/artifact/smoke.ts"),
    source("packages/code/tooling/release/smoke.ts"),
    source("packages/code/tooling/release/installer-smoke.ts"),
    source("packages/code/tooling/artifact/pty.ts"),
  ]);

  for (const runner of [artifact, release, installer]) {
    expect(runner).toContain("createSmokeFixture");
    expect(runner).toContain("cleanup()");
    expect(runner).not.toContain("...process.env");
  }
  expect(artifact).toContain("context: fixture");
  expect(release).toContain("fixture.environmentFor");
  expect(installer).toContain("context.environmentFor");
  expect(artifact).toContain("readOnlyRoots: [repositoryRoot]");
  expect(release).toContain("bootAndObserve");
  expect(release).toContain("verifyReleaseTree");
  expect(installer).toContain("copyFile");
  expect(installer).toContain("CLARVIS_INSTALLER_SMOKE_DISPOSABLE");
  expect(pty).toContain("registerChild");
  expect(pty).toContain("exec env -i");
  expect(pty).toContain("requireNativeSmokeConfinement");
  expect(pty).toContain("environmentFor");
});

test("related cache, Goal and preload harnesses keep their roots explicit", async () => {
  const [cache, goal, preload, auth] = await Promise.all([
    source("tooling/cache/artifact.ts"),
    source("tooling/goal/live.ts"),
    source("tooling/test-runtime/clarvis-home-preload.ts"),
    source("tooling/cache/host-auth-view.ts"),
  ]);

  expect(cache).toContain("isolatedEnvironment");
  expect(cache).toContain("isolated_cache_global_overlaps_operator_global");
  expect(cache).toContain("--use-global-oauth");
  expect(cache).not.toContain("...process.env");
  expect(goal).toContain("environmentFor");
  expect(goal).toContain("useGlobalOAuth");
  expect(goal).toContain("env: environment");
  expect(goal).toContain("auth?.cleanup");
  expect(preload).toContain("CLARVIS_TEST_HOME_HANDOFF");
  expect(preload).not.toContain('"/tmp"');
  expect(auth).toContain("host_auth_view_refuses_symlink");
  expect(auth).toContain("authentication_and_fixture_roots_must_be_distinct");
});

test("Plan repository integration fixtures put locks below their disposable workspace", async () => {
  const plan = await source("packages/plan/tests/integration/file-repository.test.ts");
  expect(plan).toContain('lockDir: join(workspaceRoot, ".plan-test-locks")');
  expect(plan).toContain('join(dir, ".plan-test-locks", `${name}.lock`)');
});
