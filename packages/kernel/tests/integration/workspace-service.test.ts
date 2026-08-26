import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceService } from "../../src/workspace/workspace-service.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("WorkspaceService", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "clarvis-ws-"));
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it("listFiles walks the tree, skipping noise dirs and dotdirs", async () => {
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(ws, "node_modules", "x"), { recursive: true });
    mkdirSync(join(ws, ".hidden"), { recursive: true });
    writeFileSync(join(ws, "src", "a.ts"), "a");
    writeFileSync(join(ws, "node_modules", "x", "b.ts"), "b");
    writeFileSync(join(ws, ".hidden", "c.ts"), "c");
    writeFileSync(join(ws, "top.md"), "t");

    const files = (await createWorkspaceService(ws).listFiles()).map((e) => e.path);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("top.md");
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.includes(".hidden"))).toBe(false);
  });

  it("listFiles honors prefix + limit", async () => {
    writeFileSync(join(ws, "aaa.ts"), "");
    writeFileSync(join(ws, "aab.ts"), "");
    writeFileSync(join(ws, "zzz.ts"), "");
    const files = createWorkspaceService(ws);
    expect((await files.listFiles({ prefix: "aa" })).map((e) => e.path).sort()).toEqual([
      "aaa.ts",
      "aab.ts",
    ]);
    expect((await files.listFiles({ limit: 1 })).length).toBe(1);
  });

  it("readImage reads a workspace-relative image with the right mime", async () => {
    writeFileSync(join(ws, "shot.png"), PNG);
    const img = await createWorkspaceService(ws).readImage("shot.png");
    expect(img.mime).toBe("image/png");
    expect(img.data).toBe(PNG.toString("base64"));
  });

  it("readImage recognizes every supported extension and falls back to JPEG", async () => {
    const files = createWorkspaceService(ws);
    for (const [name, mime] of [
      ["animation.GIF", "image/gif"],
      ["photo.webp", "image/webp"],
      ["bitmap.bmp", "image/bmp"],
      ["unknown.bin", "image/jpeg"],
    ] as const) {
      writeFileSync(join(ws, name), PNG);
      expect((await files.readImage(name)).mime).toBe(mime);
    }
  });

  it("rejects the workspace root and maps directories or missing images to not_found", async () => {
    const files = createWorkspaceService(ws);
    mkdirSync(join(ws, "folder"));

    await expect(files.readFile(ws)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(files.readFile("folder")).rejects.toMatchObject({ code: "not_found" });
    await expect(files.readImage("missing.png")).rejects.toMatchObject({ code: "not_found" });
  });

  it("confinement: absolute + .. escapes are rejected with invalid_request", async () => {
    const files = createWorkspaceService(ws);
    await expect(files.readImage("/etc/passwd")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(files.readFile("../secret")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("readFile 404s a missing in-workspace path", async () => {
    await expect(createWorkspaceService(ws).readFile("nope.txt")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects oversized sparse text and image files before materializing them", async () => {
    for (const name of ["huge.txt", "huge.png"]) {
      const path = join(ws, name);
      const fd = openSync(path, "w");
      try {
        truncateSync(path, 64 * 1024 * 1024);
      } finally {
        closeSync(fd);
      }
    }

    const files = createWorkspaceService(ws);
    await expect(files.readFile("huge.txt")).rejects.toMatchObject({
      code: "resource_exhausted",
    });
    await expect(files.readImage("huge.png")).rejects.toMatchObject({
      code: "resource_exhausted",
    });
  });

  it("clamps adversarial list limits instead of expanding the response", async () => {
    writeFileSync(join(ws, "one.ts"), "");
    expect(await createWorkspaceService(ws).listFiles({ limit: Number.MAX_SAFE_INTEGER })).toEqual([
      { path: "one.ts", kind: "file" },
    ]);
    expect(await createWorkspaceService(ws).listFiles({ limit: -1 })).toEqual([]);
  });
});
