import { describe, expect, it } from "bun:test";

import { withoutGitRepositoryEnvironment } from "../../src/git-environment.ts";

describe("withoutGitRepositoryEnvironment", () => {
  it("removes Git's complete repository-local environment and preserves transport inputs", () => {
    const localNames = [
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_CONFIG",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      "GIT_OBJECT_DIRECTORY",
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_IMPLICIT_WORK_TREE",
      "GIT_GRAFT_FILE",
      "GIT_INDEX_FILE",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_REPLACE_REF_BASE",
      "GIT_PREFIX",
      "GIT_SHALLOW_FILE",
      "GIT_COMMON_DIR",
      "GIT_CEILING_DIRECTORIES",
    ];
    const source = Object.fromEntries(localNames.map((name) => [name, `/parent/${name}`]));
    source.PATH = "/bin";
    source.GIT_SSH_COMMAND = "ssh -F config";

    expect(withoutGitRepositoryEnvironment(source)).toEqual({
      PATH: "/bin",
      GIT_SSH_COMMAND: "ssh -F config",
    });
  });

  it("uses platform environment-name semantics without mutating the source", () => {
    const source = { Git_Dir: "/parent/.git", PATH: "/bin" };

    expect(withoutGitRepositoryEnvironment(source)).toEqual(
      process.platform === "win32" ? { PATH: "/bin" } : source,
    );
    expect(source).toEqual({ Git_Dir: "/parent/.git", PATH: "/bin" });
  });
});
