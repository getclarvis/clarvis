import { expect, test } from "bun:test";
import type { WorkspaceEntry, WorkspaceService } from "@clarvis/protocol";
import { createImageLoader, createWorkspaceFiles } from "../../src/adapters/workspace-files.ts";

function fakeFiles(
  files: string[],
  images: Record<string, { mime: string; data: string }> = {},
  listGate: Promise<void> = Promise.resolve(),
): WorkspaceService {
  return {
    listFiles: async (): Promise<WorkspaceEntry[]> => {
      await listGate;
      return files.map((path) => ({ path, kind: "file" }));
    },
    readFile: async (path) => ({ path, content: "" }),
    readImage: async (path) => {
      const hit = images[path];
      if (!hit) throw Object.assign(new Error("not found"), { code: "not_found" });
      return { path, mime: hit.mime, data: hit.data };
    },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("createWorkspaceFiles snapshots the service's file list (populates after the async prime)", async () => {
  const gate = deferred();
  const getFiles = createWorkspaceFiles(fakeFiles(["src/a.ts", "top.md"], {}, gate.promise));
  gate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const list = getFiles();
  expect(list).toContain("src/a.ts");
  expect(list).toContain("top.md");
});

test("a replaced workspace accessor cannot be repopulated by the previous late listing", async () => {
  const oldGate = deferred();
  const nextGate = deferred();
  let current = createWorkspaceFiles(fakeFiles(["old/secret.ts"], {}, oldGate.promise));
  expect(current()).toEqual([]);
  current = createWorkspaceFiles(fakeFiles(["new/current.ts"], {}, nextGate.promise));
  nextGate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  oldGate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(current()).toEqual(["new/current.ts"]);
});

test("createImageLoader maps readImage to a protocol image part", async () => {
  const load = createImageLoader(fakeFiles([], { "shot.png": { mime: "image/png", data: "B64" } }));
  expect(await load("shot.png")).toEqual({ type: "image", mime: "image/png", data: "B64" });
});

test("createImageLoader returns null when the file can't be read (kept out of the turn)", async () => {
  const load = createImageLoader(fakeFiles([]));
  expect(await load("missing.png")).toBeNull();
});

test("createImageLoader does not turn operational image failures into silent absence", async () => {
  const files = fakeFiles([]);
  files.readImage = async () => {
    throw Object.assign(new Error("image exceeds backend limit"), { code: "resource_exhausted" });
  };
  await expect(createImageLoader(files)("huge.png")).rejects.toThrow("image exceeds backend limit");
});
