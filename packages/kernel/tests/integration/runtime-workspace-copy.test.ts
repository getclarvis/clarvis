import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENTS_DIR, CLARVIS_DIR, GIT_DIR } from "@clarvis/paths";

import {
  captureRuntimeWorkspace,
  diffRuntimeWorkspace,
  scanRuntimeWorkspace,
  WorkspaceCopyError,
} from "../../src/index.ts";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-copy-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("runtime workspace capture", () => {
  test("captures dirty and untracked bytes while excluding host control inventories", async () => {
    const source = await temporaryRoot();
    const state = await temporaryRoot();
    const destination = join(state, "runtime", "workspace");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "src", "dirty.ts"), "dirty\n");
    await writeFile(join(source, "untracked.txt"), "untracked\n");
    for (const excluded of [GIT_DIR, CLARVIS_DIR, AGENTS_DIR]) {
      await mkdir(join(source, excluded), { recursive: true });
      await writeFile(join(source, excluded, "secret"), "host-only");
    }

    const baseline = await captureRuntimeWorkspace(source, destination);

    expect(baseline.entries.map((entry) => entry.path)).toEqual([
      join("src", "dirty.ts"),
      "untracked.txt",
    ]);
    expect(await readFile(join(destination, "src", "dirty.ts"), "utf8")).toBe("dirty\n");
    for (const excluded of [GIT_DIR, CLARVIS_DIR, AGENTS_DIR]) {
      expect(
        await lstat(join(destination, excluded)).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    }
  });

  test("preserves executable modes and confined symlinks without hardlinking files", async () => {
    const source = await temporaryRoot();
    const state = await temporaryRoot();
    const destination = join(state, "workspace");
    await writeFile(join(source, "tool"), "#!/bin/sh\n");
    await chmod(join(source, "tool"), 0o755);
    await symlink("tool", join(source, "tool-link"));

    await captureRuntimeWorkspace(source, destination);

    expect((await lstat(join(destination, "tool"))).mode & 0o777).toBe(0o755);
    expect((await lstat(join(destination, "tool"))).ino).not.toBe(
      (await lstat(join(source, "tool"))).ino,
    );
    expect((await lstat(join(destination, "tool-link"))).isSymbolicLink()).toBe(true);
  });

  test("refuses escaping links, hardlinks, special roots and bounded overflows", async () => {
    const source = await temporaryRoot();
    const outside = await temporaryRoot();
    const state = await temporaryRoot();
    await writeFile(join(outside, "outside"), "x");
    await symlink(join(outside, "outside"), join(source, "escape"));
    await expect(captureRuntimeWorkspace(source, join(state, "one"))).rejects.toMatchObject({
      code: "unsafe_symlink",
    });

    await rm(join(source, "escape"));
    await symlink("missing", join(source, "broken"));
    await expect(captureRuntimeWorkspace(source, join(state, "broken"))).rejects.toMatchObject({
      code: "unsafe_symlink",
    });

    await rm(join(source, "broken"));
    await writeFile(join(source, "a"), "x");
    await link(join(source, "a"), join(source, "b"));
    await expect(captureRuntimeWorkspace(source, join(state, "two"))).rejects.toMatchObject({
      code: "unsupported_entry",
    });

    await rm(join(source, "b"));
    await expect(
      scanRuntimeWorkspace(source, { maxEntries: 1, maxFileBytes: 0, maxTotalBytes: 1 }),
    ).rejects.toBeInstanceOf(WorkspaceCopyError);
  });

  test("detects complete added, modified and deleted changes independently of guest reports", async () => {
    const source = await temporaryRoot();
    const state = await temporaryRoot();
    const destination = join(state, "workspace");
    await writeFile(join(source, "keep"), "before");
    await writeFile(join(source, "delete"), "gone");
    const baseline = await captureRuntimeWorkspace(source, destination);
    await writeFile(join(destination, "keep"), "after");
    await writeFile(join(destination, "add"), "new");
    await rm(join(destination, "delete"));

    const current = await scanRuntimeWorkspace(destination);
    const changes = diffRuntimeWorkspace(baseline, current);

    expect(changes.added.map((entry) => entry.path)).toEqual(["add"]);
    expect(changes.modified.map((entry) => entry.path)).toEqual(["keep"]);
    expect(changes.deleted.map((entry) => entry.path)).toEqual(["delete"]);
    expect(changes.currentDigest).not.toBe(changes.baselineDigest);
  });

  test("never writes into an existing destination or a path nested with the source", async () => {
    const source = await temporaryRoot();
    const destination = await temporaryRoot();
    await expect(captureRuntimeWorkspace(source, destination)).rejects.toMatchObject({
      code: "destination_exists",
    });
    await expect(captureRuntimeWorkspace(source, join(source, "copy"))).rejects.toMatchObject({
      code: "invalid_root",
    });
    await expect(scanRuntimeWorkspace(join(source, "missing"))).rejects.toMatchObject({
      code: "invalid_root",
    });
  });
});
