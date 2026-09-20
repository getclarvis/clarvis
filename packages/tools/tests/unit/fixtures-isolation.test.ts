import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { cleanup, makeConfig, makeWorkspace } from "../helpers/fixtures.ts";

test("tool fixtures keep machine-local state outside the workspace and away from the operator", async () => {
  const workspace = makeWorkspace();
  const external = await mkdtemp(join(tmpdir(), "clarvis-tools-fixture-external-"));
  try {
    const sentinel = join(external, "settings.json");
    await writeFile(sentinel, "operator-sentinel\n", { mode: 0o600 });
    const config = makeConfig(workspace);
    expect(relative(workspace, config.statePaths!.root)).toMatch(/^\.\./);
    expect(relative(workspace, config.statePaths!.plansLockDir)).toMatch(/^\.\./);
    await mkdir(config.statePaths!.plansLockDir, { recursive: true });
    expect(await Bun.file(join(config.statePaths!.plansLockDir, "fixture.lock")).exists()).toBe(
      false,
    );
    expect(await Bun.file(sentinel).text()).toBe("operator-sentinel\n");
  } finally {
    cleanup(workspace);
    await rm(external, { recursive: true, force: true });
  }
});
