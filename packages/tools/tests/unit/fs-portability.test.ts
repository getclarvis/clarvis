import { describe, expect, it } from "bun:test";
import path from "node:path";
import { installationRoot, managerOf, systemExecutableRoots } from "../../src/sandbox.ts";

describe("install layout detection — Windows separators", () => {
  const WIN_ROOTS = ["C:\\Windows", "C:\\Program Files"];

  it("recognizes a mise install through backslashes", () => {
    const p = "C:\\Users\\me\\AppData\\Local\\mise\\installs\\node\\22.0.0\\bin\\node.exe";
    expect(managerOf(p, path.win32, WIN_ROOTS)).toBe("mise");
    expect(installationRoot(p, path.win32, WIN_ROOTS)).toBe(
      "C:\\Users\\me\\AppData\\Local\\mise\\installs\\node\\22.0.0",
    );
  });

  it("returns the install root in native separators, not the matched form", () => {
    const p = "C:\\Users\\me\\.pyenv\\versions\\3.12.1\\bin\\python.exe";
    expect(installationRoot(p, path.win32, WIN_ROOTS)).toBe(
      "C:\\Users\\me\\.pyenv\\versions\\3.12.1",
    );
  });

  it("classifies an executable under a Windows system root as the platform's own", () => {
    const p = "C:\\Program Files\\dotnet\\dotnet.exe";
    expect(managerOf(p, path.win32, WIN_ROOTS)).toBe("system");
    // The <root>/bin/<command> layout does not hold here, so the grandparent
    // fallback would claim "C:\Program Files" as an install root.
    expect(installationRoot(p, path.win32, WIN_ROOTS)).toBeUndefined();
  });

  it("falls back to the grandparent for an unrecognized custom layout", () => {
    const p = "D:\\tools\\mylang-1.2\\bin\\mylang.exe";
    expect(managerOf(p, path.win32, WIN_ROOTS)).toBe("custom");
    expect(installationRoot(p, path.win32, WIN_ROOTS)).toBe("D:\\tools\\mylang-1.2");
  });

  it("keeps POSIX layouts working unchanged", () => {
    const p = "/home/me/.nvm/versions/node/v22.0.0/bin/node";
    expect(managerOf(p, path.posix, ["/usr", "/bin"])).toBe("nvm");
    expect(installationRoot(p, path.posix, ["/usr", "/bin"])).toBe(
      "/home/me/.nvm/versions/node/v22.0.0",
    );
  });
});

describe("systemExecutableRoots", () => {
  it("returns the POSIX filesystem roots off Windows", () => {
    expect(systemExecutableRoots("linux")).toEqual(["/usr", "/bin", "/sbin", "/usr/local"]);
  });

  it("returns the Windows install roots on Windows", () => {
    const roots = systemExecutableRoots("win32");
    expect(roots).toHaveLength(3);
    expect(roots.every((r) => /^[A-Za-z]:\\/.test(r))).toBe(true);
  });
});
