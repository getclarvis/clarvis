import { describe, expect, it } from "bun:test";
import {
  operationFromRaw,
  parseGitLsFilesZ,
  parseGitNumstatZ,
  parseGitRawZ,
  parseGitUnmergedZ,
} from "../../src/workspace/git-raw-parser.ts";

describe("git NUL parsers", () => {
  it("parses raw additions, deletions and renames", () => {
    const raw =
      ":100644 000000 7898192 0000000 D\0file.txt\0:100644 100644 1275430 1275430 R100\0file.txt\0renamed.txt\0";
    expect(parseGitRawZ(raw)).toEqual([
      {
        oldMode: "100644",
        newMode: "000000",
        oldSha: "7898192",
        newSha: "0000000",
        status: "D",
        oldPath: "file.txt",
        newPath: "file.txt",
      },
      {
        oldMode: "100644",
        newMode: "100644",
        oldSha: "1275430",
        newSha: "1275430",
        status: "R100",
        oldPath: "file.txt",
        newPath: "renamed.txt",
      },
    ]);
    expect(operationFromRaw(parseGitRawZ(raw)[1]!)).toBe("renamed");
  });

  it("parses numstat including rename and binary records", () => {
    expect(parseGitNumstatZ("0\t1\tfile.txt\0")).toEqual([
      { oldPath: "file.txt", newPath: "file.txt", additions: 0, deletions: 1 },
    ]);
    expect(parseGitNumstatZ("0\t0\t\0file.txt\0renamed.txt\0")).toEqual([
      { oldPath: "file.txt", newPath: "renamed.txt", additions: 0, deletions: 0 },
    ]);
    expect(parseGitNumstatZ("-\t-\tbin.png\0")).toEqual([
      { oldPath: "bin.png", newPath: "bin.png", additions: null, deletions: null },
    ]);
  });

  it("parses unmerged stages and untracked paths", () => {
    expect(
      parseGitUnmergedZ(
        "100644 abc 1\tc.txt\0" + "100644 def 2\tc.txt\0" + "100644 ghi 3\tc.txt\0",
      ),
    ).toEqual(["c.txt"]);
    expect(parseGitLsFilesZ("new.txt\0sub/weird name.txt\0")).toEqual([
      "new.txt",
      "sub/weird name.txt",
    ]);
    expect(parseGitRawZ("garbage\0:100644 100644 abc def R100\0old.txt\0")).toEqual([]);
    expect(parseGitNumstatZ("not-a-numstat\0")).toEqual([]);
    expect(parseGitUnmergedZ("100644 abc\0")).toEqual([]);
  });
});
