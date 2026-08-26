import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveConfig, StartupError } from "../../src/config.ts";
import { cleanup, makeWorkspace, write } from "../helpers/fixtures.ts";

const noProbe = () => false;

describe("runtime config", () => {
  let root: string;

  beforeEach(() => {
    root = makeWorkspace();
  });

  afterEach(() => {
    cleanup(root);
  });

  it("resolves the documented programmatic defaults", () => {
    const config = resolveConfig({
      workspaceRoot: root,
      probeRipgrep: noProbe,
    });

    expect(config).toMatchObject({
      workspaceRoot: root,
      maxOutputBytes: 131072,
      maxShellOutputBytes: 16384,
      maxFileBytes: 20_000_000,
      maxImageBytes: 5_000_000,
      maxTraversalEntries: 50_000,
      maxMutationBytes: 64 * 1024 * 1024,
      maxDiffInputBytes: 8 * 1024 * 1024,
      maxToolMetaBytes: 256 * 1024,
      shellTimeoutMs: 120000,
      shellTimeoutMaxMs: 600000,
      monitorReadyTimeoutMs: 30000,
      maxMonitors: 32,
      regexScanBudgetMs: 5000,
      ripgrepAvailable: false,
      readOnly: false,
      confineToWorkspace: true,
      temporaryRoots: [],
      gitMetadataPaths: [],
    });
  });

  it("honours every caller-facing runtime override", () => {
    const guard = () => Promise.resolve({ verdict: "allow" as const });
    const elicit = () => Promise.resolve(true);
    const config = resolveConfig({
      workspaceRoot: root,
      readOnly: true,
      confineToWorkspace: false,
      maxOutputBytes: 4096,
      maxShellOutputBytes: 2048,
      maxFileBytes: 8192,
      maxImageBytes: 4096,
      maxTraversalEntries: 123,
      maxMutationBytes: 16_384,
      maxDiffInputBytes: 8_192,
      maxToolMetaBytes: 4_096,
      shellTimeoutMs: 5000,
      shellTimeoutMaxMs: 9000,
      monitorReadyTimeoutMs: 750,
      maxMonitors: 4,
      regexScanBudgetMs: 250,
      probeRipgrep: () => true,
      guard,
      elicit,
      secretEnvNames: ["TOKEN"],
    });

    expect(config).toMatchObject({
      readOnly: true,
      confineToWorkspace: false,
      maxOutputBytes: 4096,
      maxShellOutputBytes: 2048,
      maxFileBytes: 8192,
      maxImageBytes: 4096,
      maxTraversalEntries: 123,
      maxMutationBytes: 16_384,
      maxDiffInputBytes: 8_192,
      maxToolMetaBytes: 4_096,
      shellTimeoutMs: 5000,
      shellTimeoutMaxMs: 9000,
      monitorReadyTimeoutMs: 750,
      maxMonitors: 4,
      regexScanBudgetMs: 250,
      ripgrepAvailable: true,
      guard,
      elicit,
      secretEnvNames: ["TOKEN"],
    });
  });

  it("requires an existing workspace directory", () => {
    expect(() => resolveConfig({ workspaceRoot: "" })).toThrow(
      "No workspace root: options.workspaceRoot is required.",
    );
    expect(() => resolveConfig({ workspaceRoot: `${root}/missing` })).toThrow(
      /Workspace root does not exist/,
    );
    expect(() => resolveConfig({ workspaceRoot: write(root, "file.txt", "x") })).toThrow(
      /Workspace root is not a directory/,
    );
  });

  it("requires every temporary root to be an existing directory", () => {
    expect(() =>
      resolveConfig({ workspaceRoot: root, temporaryRoots: [`${root}/missing`] }),
    ).toThrow(/Temporary root does not exist/);
    expect(() =>
      resolveConfig({ workspaceRoot: root, temporaryRoots: [write(root, "scratch.txt", "x")] }),
    ).toThrow(/Temporary root is not a directory/);
  });

  it("rejects invalid numeric limits and an inverted shell timeout range", () => {
    for (const options of [
      { maxOutputBytes: 100 },
      { maxShellOutputBytes: 100 },
      { maxFileBytes: 100 },
      { maxImageBytes: 100 },
      { maxTraversalEntries: 0 },
      { maxMutationBytes: 100 },
      { maxDiffInputBytes: 100 },
      { maxToolMetaBytes: 100 },
      { shellTimeoutMs: 0 },
      { shellTimeoutMaxMs: 0 },
      { monitorReadyTimeoutMs: 0 },
      { maxMonitors: 0 },
      { regexScanBudgetMs: 0 },
    ]) {
      expect(() =>
        resolveConfig({ workspaceRoot: root, probeRipgrep: noProbe, ...options }),
      ).toThrow(StartupError);
    }
    expect(() =>
      resolveConfig({
        workspaceRoot: root,
        shellTimeoutMs: 9000,
        shellTimeoutMaxMs: 5000,
        probeRipgrep: noProbe,
      }),
    ).toThrow(/shellTimeoutMaxMs/);
    expect(() =>
      resolveConfig({
        workspaceRoot: root,
        shellTimeoutMs: Number.MAX_SAFE_INTEGER + 1,
        probeRipgrep: noProbe,
      }),
    ).toThrow(StartupError);
  });

  it("treats a throwing capability probe as unavailable", () => {
    const throwingProbe = (): boolean => {
      throw new Error("probe boom");
    };
    const config = resolveConfig({
      workspaceRoot: root,
      probeRipgrep: throwingProbe,
    });
    expect(config.ripgrepAvailable).toBe(false);
  });

  it("can run the real capability probes", () => {
    const config = resolveConfig({ workspaceRoot: root });
    expect(typeof config.ripgrepAvailable).toBe("boolean");
  });
});
