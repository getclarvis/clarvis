import { describe, expect, it } from "../bun-test.ts";
import { buildSystemSections } from "../../src/runtime/subagents/build-subagent-input.ts";

describe("the environment system-prompt section", () => {
  it("names the workspace root, the platform and the shell", () => {
    const [section] = buildSystemSections({ workspaceRoot: "/ws", platform: "linux" });
    expect(section).toContain("/ws");
    expect(section).toContain("linux");
    expect(section).toContain("sh -c");
  });

  it("distinguishes darwin from linux, which nothing used to", () => {
    const [linux] = buildSystemSections({ workspaceRoot: "/ws", platform: "linux" });
    const [darwin] = buildSystemSections({ workspaceRoot: "/ws", platform: "darwin" });
    expect(linux).not.toBe(darwin);
    expect(darwin).toContain("darwin");
  });

  it("keeps the environment section first, ahead of the shared prompt and profile prompt", () => {
    const sections = buildSystemSections({
      workspaceRoot: "/ws",
      sharedPrompt: "SHARED",
      profilePrompt: "PERSONA",
      platform: "linux",
    });
    expect(sections[0]).toContain("# Environment");
    expect(sections[1]).toBe("SHARED");
    expect(sections[2]).toBe("PERSONA");
  });

  it("keeps capability sections last", () => {
    const sections = buildSystemSections({
      workspaceRoot: "/ws",
      sharedPrompt: "SHARED",
      profilePrompt: "PERSONA",
      capabilitySections: ["# Skills"],
      platform: "linux",
    });
    expect(sections[3]).toBe("# Skills");
  });

  it("still accepts basePrompt as an alias of the profile prompt", () => {
    const sections = buildSystemSections({
      workspaceRoot: "/ws",
      sharedPrompt: "SHARED",
      basePrompt: "PERSONA",
      platform: "linux",
    });
    expect(sections[1]).toBe("SHARED");
    expect(sections[2]).toBe("PERSONA");
  });

  it("contributes nothing when the run has no workspace root", () => {
    expect(buildSystemSections({ profilePrompt: "PERSONA", platform: "linux" })).toEqual([
      "PERSONA",
    ]);
  });
});
