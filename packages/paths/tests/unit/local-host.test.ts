import { describe, expect, test } from "bun:test";
import { basename, dirname, join, relative, resolve } from "node:path";
import { localHostPaths, type LocalHostPathOptions } from "../../src/index.ts";

const base: LocalHostPathOptions = {
  workspaceRoot: resolve("/work/repository"),
  globalDir: resolve("/operator/config"),
  owner: "alice",
  operatorId: "account-1000",
  endpointRootCandidates: [resolve("/tmp")],
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

  test("the first compatible candidate preserves the current endpoint format", () => {
    const preferred = resolve("/short-host-root");
    const paths = localHostPaths({
      ...base,
      endpointRootCandidates: [preferred, resolve("/other")],
    });
    expect(dirname(paths.endpointDirectory!)).toBe(preferred);
    expect(basename(paths.endpointDirectory!)).toMatch(/^clv-[a-f0-9]{12}$/);
    expect(paths.endpoint).toBe(join(paths.endpointDirectory!, paths.identity.slice(0, 32)));
  });

  test("falls back when the first complete endpoint exceeds the byte budget", () => {
    const paths = localHostPaths({
      ...base,
      endpointRootCandidates: [join("/tmp", "a".repeat(100)), "/tmp"],
    });
    expect(dirname(paths.endpointDirectory!)).toBe(resolve("/tmp"));
    expect(Buffer.byteLength(paths.endpoint, "utf8")).toBeLessThanOrEqual(100);
  });

  test("measures multibyte roots in UTF-8 bytes", () => {
    const multibyte = join("/tmp", "é".repeat(30));
    expect(multibyte.length).toBeLessThan(100);
    const paths = localHostPaths({
      ...base,
      endpointRootCandidates: [multibyte, "/tmp"],
    });
    expect(dirname(paths.endpointDirectory!)).toBe(resolve("/tmp"));
  });

  test("deduplicates normalized candidates without changing the endpoint", () => {
    const repeated = localHostPaths({
      ...base,
      endpointRootCandidates: ["/tmp", "/tmp/../tmp", "/other"],
    });
    const unique = localHostPaths({ ...base, endpointRootCandidates: ["/tmp", "/other"] });
    expect(repeated.endpoint).toBe(unique.endpoint);
  });

  test("long roots and hostile ids never become socket names or escaping paths", () => {
    const paths = localHostPaths({
      ...base,
      globalDir: join(base.globalDir, "a".repeat(500)),
      workspaceRoot: join(base.workspaceRoot, "..", "workspace-" + "b".repeat(500)),
      owner: "../../owner/" + "c".repeat(500),
      operatorId: "../../account/" + "d".repeat(500),
      endpointRootCandidates: ["/tmp"],
    });
    expect(Buffer.byteLength(paths.endpoint)).toBeLessThanOrEqual(100);
    const projection = paths.projectionFile("../../generation", "../../run/" + "x".repeat(1000));
    expect(relative(paths.root, projection)).toMatch(/^projections[/\\][a-f0-9]{64}\.jsonl$/);
    expect(paths.projectionFile("a", "b")).not.toBe(paths.projectionFile("a/b", ""));
  });

  test("Windows uses a named pipe independent of filesystem path length", () => {
    const current = localHostPaths({ ...base, platform: "win32" });
    const paths = localHostPaths({
      ...base,
      platform: "win32",
      endpointRootCandidates: ["", "x".repeat(200), "\0"],
    });
    expect(paths.endpoint).toBe(`\\\\.\\pipe\\clarvis-${paths.identity}`);
    expect(paths.endpoint).toBe(current.endpoint);
    expect(paths.endpointDirectory).toBeUndefined();
    expect(paths.projectionFile("generation", "execution")).toMatch(
      /[/\\]projections[/\\][a-f0-9]{64}\.jsonl$/,
    );
  });

  test("rejects invalid explicit candidate lists before constructing a POSIX path", () => {
    for (const endpointRootCandidates of [[], [""], ["/tmp\0secret"]]) {
      expect(() => localHostPaths({ ...base, endpointRootCandidates })).toThrow(
        "endpoint root candidates",
      );
    }
  });

  test("fails explicitly without disclosing candidates when no endpoint fits", () => {
    const secret = "private-root-name";
    expect(() =>
      localHostPaths({
        ...base,
        endpointRootCandidates: [join("/tmp", secret, "a".repeat(100))],
      }),
    ).toThrow("no local host socket endpoint candidate fits within 100 UTF-8 bytes (1 candidates)");
    try {
      localHostPaths({
        ...base,
        endpointRootCandidates: [join("/tmp", secret, "a".repeat(100))],
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  test("missing identity fails explicitly", () => {
    expect(() => localHostPaths({ ...base, operatorId: "" })).toThrow("identities");
    expect(() => localHostPaths({ ...base, owner: "" })).toThrow("identities");
  });
});
