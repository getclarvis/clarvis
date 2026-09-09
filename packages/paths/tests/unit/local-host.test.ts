import { describe, expect, test } from "bun:test";
import { join, relative, resolve } from "node:path";
import { localHostPaths, type LocalHostPathOptions } from "../../src/index.ts";

const base: LocalHostPathOptions = {
  workspaceRoot: resolve("/work/repository"),
  globalDir: resolve("/operator/config"),
  owner: "alice",
  operatorId: "account-1000",
  temporaryRoot: resolve("/tmp"),
  platform: "linux",
};

describe("local host paths", () => {
  test("each authority and checkout selects an independent stable namespace", () => {
    const original = localHostPaths(base);
    expect(localHostPaths({ ...base }).identity).toBe(original.identity);
    for (const field of ["workspaceRoot", "globalDir", "owner", "operatorId"] as const) {
      const changed = localHostPaths({ ...base, [field]: `${base[field]}-other` });
      expect(changed.identity).not.toBe(original.identity);
      expect(changed.root).not.toBe(original.root);
      expect(changed.endpoint).not.toBe(original.endpoint);
    }
    expect(original.root).toBe(join(base.globalDir, "state", "hosts", original.identity));
    expect(relative(base.workspaceRoot, original.root).startsWith("..")).toBe(true);
  });

  test("long HOME and hostile ids never become socket names or escaping paths", () => {
    const paths = localHostPaths({ ...base, globalDir: join(base.globalDir, "a".repeat(500)) });
    expect(Buffer.byteLength(paths.endpoint)).toBeLessThanOrEqual(100);
    const projection = paths.projectionFile("../../generation", "../../run/" + "x".repeat(1000));
    expect(relative(paths.root, projection)).toMatch(/^projections[/\\][a-f0-9]{64}\.jsonl$/);
    expect(paths.projectionFile("a", "b")).not.toBe(paths.projectionFile("a/b", ""));
  });

  test("Windows uses a named pipe independent of filesystem path length", () => {
    const paths = localHostPaths({ ...base, platform: "win32", temporaryRoot: "x".repeat(200) });
    expect(paths.endpoint).toBe(`\\\\.\\pipe\\clarvis-${paths.identity}`);
    expect(paths.endpointDirectory).toBeUndefined();
  });

  test("overlong Unix temporary paths and missing identity fail explicitly", () => {
    expect(() => localHostPaths({ ...base, temporaryRoot: join("/tmp", "a".repeat(100)) })).toThrow(
      "exceeds 100 bytes",
    );
    expect(() => localHostPaths({ ...base, operatorId: "" })).toThrow("identities");
    expect(() => localHostPaths({ ...base, owner: "" })).toThrow("identities");
  });
});
