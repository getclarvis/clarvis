import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, chmod, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { workspacePaths, workspaceStatePaths } from "@clarvis/paths";

import { createToolSpill } from "../../src/runtime/context/tool-spill.ts";
import type { Logger } from "@clarvis/capability";

const modeBitsEnforced = process.platform !== "win32" && process.getuid?.() !== 0;

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "clarvis-spill-"));
  roots.add(root);
  return root;
}

const roots = new Set<string>();

afterEach(async () => {
  const created = [...roots];
  roots.clear();
  await Promise.all(
    created.flatMap((root) => [
      rm(root, { recursive: true, force: true }),
      rm(workspaceStatePaths(root).root, { recursive: true, force: true }),
    ]),
  );
});

describe("createToolSpill", () => {
  it("writes the full text and returns an absolute path", async () => {
    const root = await workspace();
    const spill = createToolSpill(root);
    const text = "X".repeat(5000);

    const named = await spill(text);

    expect(named).toBeDefined();
    expect(path.isAbsolute(named!)).toBe(true);
    expect(path.basename(named!).startsWith("toolout-")).toBe(true);
    expect(named!.endsWith(".txt")).toBe(true);
    expect(await readFile(named!, "utf8")).toBe(text);
  });

  it.if(modeBitsEnforced)("writes the spill owner-only", async () => {
    const root = await workspace();
    const named = await createToolSpill(root)("body");

    expect((await stat(named!)).mode & 0o777).toBe(0o600);
  });

  /**
   * The whole point of the move: an oversized tool result is generated
   * bookkeeping, and a user's working tree is not where it belongs.
   */
  it("writes nothing at all inside the working tree", async () => {
    const root = await workspace();
    const named = await createToolSpill(root)("body");

    expect(named!.startsWith(workspacePaths(root).root)).toBe(false);
    expect(named!.startsWith(workspaceStatePaths(root).localDir)).toBe(true);
    await expect(stat(workspacePaths(root).clarvisDir)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  /**
   * The name has to come from the shared vocabulary, not be re-spelled here:
   * a sweeper that reads the convention from one place and a writer that spells
   * it in another is exactly how shell spills once went uncollected.
   */
  it("writes the name the paths vocabulary defines", async () => {
    const root = await workspace();
    const named = await createToolSpill(root)("body");
    const paths = workspaceStatePaths(root);
    const base = path.basename(named!);
    expect(named!).toBe(paths.toolOutputSpill(base.slice(8, -4)));
  });

  it("creates the state directory on first write and reuses it after", async () => {
    const root = await workspace();
    const spill = createToolSpill(root);

    const first = await spill("one");
    const second = await spill("two");

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(path.dirname(second!)).toBe(path.dirname(first!));
    expect(await readFile(second!, "utf8")).toBe("two");
  });

  it("returns undefined and warns when the write fails, without throwing", async () => {
    const root = await workspace();
    const dir = workspaceStatePaths(root).localDir;
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o500);

    const warned: unknown[] = [];
    const ignore: Logger["debug"] = () => {};
    const logger: Logger = {
      debug: ignore,
      info: ignore,
      warn: (fields: unknown) => warned.push(fields),
      error: ignore,
    };
    const spill = createToolSpill(root, logger);

    const named = await spill("body");
    const enforced = (await readdir(dir)).length === 0;
    await chmod(dir, 0o700);

    if (!enforced) return;
    expect(named).toBeUndefined();
    expect(warned).toHaveLength(1);
  });
});
