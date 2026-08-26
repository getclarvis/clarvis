import { describe, expect, it } from "../bun-test.ts";
import { buildSystemSections } from "../../src/runtime/subagents/build-subagent-input.ts";

/**
 * Before this section carried a platform, the **only** signal of the host OS
 * anywhere in a run was the wording inside the `shell` tool's own description,
 * and that wording only varies on Windows — so on a POSIX host the model was
 * told nothing and had to infer the platform from path separators.
 */
describe("the environment system-prompt section", () => {
  it("names the workspace root, the platform and the shell", () => {
    const [section] = buildSystemSections({ workspaceRoot: "/ws", platform: "linux" });
    expect(section).toContain("/ws");
    expect(section).toContain("linux");
    expect(section).toContain("sh -c");
  });

  it("tells a Windows host it is PowerShell, and not cmd.exe", () => {
    const [section] = buildSystemSections({ workspaceRoot: "C:\\ws", platform: "win32" });
    expect(section).toContain("win32");
    expect(section).toContain("PowerShell");
    expect(section).toContain("not cmd.exe");
    expect(section).not.toContain("sh -c");
  });

  it("distinguishes darwin from linux, which nothing used to", () => {
    const [linux] = buildSystemSections({ workspaceRoot: "/ws", platform: "linux" });
    const [darwin] = buildSystemSections({ workspaceRoot: "/ws", platform: "darwin" });
    expect(linux).not.toBe(darwin);
    expect(darwin).toContain("darwin");
  });

  it("keeps the environment section first, ahead of the profile's base prompt", () => {
    const sections = buildSystemSections({
      workspaceRoot: "/ws",
      basePrompt: "PERSONA",
      platform: "linux",
    });
    expect(sections[0]).toContain("# Environment");
    expect(sections[1]).toBe("PERSONA");
  });

  it("contributes nothing when the run has no workspace root", () => {
    expect(buildSystemSections({ basePrompt: "PERSONA", platform: "linux" })).toEqual(["PERSONA"]);
  });
});
