import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { callTool, cleanup, makeConfig, makeWorkspace, write } from "../helpers/fixtures.ts";
import { resolveReadableTextPath } from "../../src/lib/state-artifacts.ts";
import { readRawFile } from "../../src/lib/files.ts";
import { readTextFile } from "../../src/lib/textfile.ts";

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) cleanup(r);
  roots = [];
});

/** A workspace plus a state root that is a genuine sibling, not a subdirectory. */
function workspaceWithState(): { root: string; stateRoot: string; spill: string } {
  const root = makeWorkspace();
  const stateRoot = mkdtempSync(path.join(tmpdir(), "clarvis-state-"));
  roots.push(root, stateRoot);
  const spill = path.join(stateRoot, "local", "toolout-12345678.txt");
  mkdirSync(path.dirname(spill), { recursive: true });
  writeFileSync(spill, "spilled line one\nspilled line two\n");
  return { root, stateRoot, spill };
}

describe("exact output artifact admission", () => {
  it("lets read_file open a pinned spill", async () => {
    const { root, stateRoot, spill } = workspaceWithState();
    const res = await callTool("read_file", { path: spill }, makeConfig(root, { stateRoot }));

    expect(res.isError).toBe(false);
    expect(res.text).toContain("spilled line one");
  });

  it("lets read_files open one too, so a batch read is not the odd one out", async () => {
    const { root, stateRoot, spill } = workspaceWithState();
    write(root, "inside.txt", "workspace line\n");

    const res = await callTool(
      "read_files",
      { paths: [spill, path.join(root, "inside.txt")] },
      makeConfig(root, { stateRoot }),
    );

    expect(res.isError).toBe(false);
    expect(res.text).toContain("spilled line one");
    expect(res.text).toContain("workspace line");
  });

  it("reads an ordinary external file through Host authority", async () => {
    const { root, stateRoot } = workspaceWithState();
    const outside = mkdtempSync(path.join(tmpdir(), "clarvis-outside-"));
    roots.push(outside);
    const target = path.join(outside, "secret.txt");
    writeFileSync(target, "not yours\n");

    const res = await callTool("read_file", { path: target }, makeConfig(root, { stateRoot }));

    expect(res.isError).toBe(false);
    expect(res.text).toContain("not yours");
  });

  it("refuses history, legacy sidecars, and the state directory", async () => {
    const { root, stateRoot } = workspaceWithState();
    const config = makeConfig(root, { stateRoot });
    for (const name of ["prompt-history", "monitor-old.json"]) {
      const target = path.join(stateRoot, "local", name);
      writeFileSync(target, "private\n");
      const result = await callTool("read_file", { path: target }, config);
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain("private\n");
    }
    expect(
      (await callTool("read_file", { path: path.join(stateRoot, "local") }, config)).isError,
    ).toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses a spill-shaped symlink", async () => {
    const { root, stateRoot, spill } = workspaceWithState();
    const linked = path.join(stateRoot, "local", "toolout-abcdef12.txt");
    symlinkSync(spill, linked);
    const result = await callTool("read_file", { path: linked }, makeConfig(root, { stateRoot }));
    expect(result.isError).toBe(true);
  });

  it("rejects a replacement after the generic spill was admitted", async () => {
    const { root, stateRoot, spill } = workspaceWithState();
    const config = makeConfig(root, { stateRoot });
    const admitted = resolveReadableTextPath(spill, config);
    renameSync(spill, `${spill}.old`);
    writeFileSync(spill, "replacement\n");
    await expect(
      readTextFile(admitted.target, spill, 1000, admitted.options),
    ).rejects.toMatchObject({ code: "path_escape" });
  });

  it("binds host-owned artifact reads to the selected root after opening", async () => {
    const { root, spill } = workspaceWithState();
    const artifactRoot = path.join(root, "reports");
    mkdirSync(artifactRoot);
    const artifact = path.join(artifactRoot, "result.txt");
    writeFileSync(artifact, "reported\n");
    expect(
      await readRawFile(artifact, artifact, 1024, undefined, {
        expectedArtifactRoot: artifactRoot,
      }),
    ).toEqual(Buffer.from("reported\n"));
    await expect(
      readRawFile(spill, spill, 1024, undefined, { expectedArtifactRoot: artifactRoot }),
    ).rejects.toMatchObject({ code: "path_escape" });
  });

  it("does not extend the allowance to a tool that mutates", async () => {
    const { root, stateRoot, spill } = workspaceWithState();

    const res = await callTool(
      "write_file",
      { path: spill, content: "overwritten" },
      makeConfig(root, { stateRoot }),
    );

    expect(res.isError).toBe(true);
  });
});
