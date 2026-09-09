import { describe, expect, test } from "bun:test";
import { localHostSpawnOptions, parseLocalHostArguments } from "../../src/hosting/launcher.ts";

describe("local host bootstrap arguments", () => {
  test("keeps operator paths literal and rejects missing, repeated or unknown flags", () => {
    expect(parseLocalHostArguments(["--workspace", "ordinary-stdio"])).toBeNull();
    const args = [
      "--local-host",
      "--workspace",
      "/workspace with spaces",
      "--global-dir",
      "/global",
      "--owner",
      "operator",
      "--artifact-id",
      "artifact",
    ];
    expect(parseLocalHostArguments(args)).toEqual({
      workspaceRoot: "/workspace with spaces",
      globalDir: "/global",
      defaultOwner: "operator",
      artifactId: "artifact",
    });
    for (const invalid of [
      args.slice(0, -1),
      [...args, "--owner", "another"],
      [...args, "--command", "anything"],
      ["--local-host"],
    ])
      expect(() => parseLocalHostArguments(invalid)).toThrow();
  });
  test("selects detached stdio-free process policies explicitly for each supported OS", () => {
    for (const platform of ["linux", "darwin"] as const)
      expect(localHostSpawnOptions(platform)).toEqual({ detached: true, stdio: "ignore" });
    expect(localHostSpawnOptions("win32")).toEqual({
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    expect(() => localHostSpawnOptions("aix")).toThrow("unsupported");
  });
});
