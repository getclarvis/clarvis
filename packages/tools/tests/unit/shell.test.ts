import { describe, expect, it } from "bun:test";
import { resolveShell, shellArgs } from "../../src/shell.ts";

describe("host shell", () => {
  it("resolves sh with a stable identity", () => {
    expect(resolveShell()).toEqual({ flavor: "posix", file: "sh" });
    expect(resolveShell()).toBe(resolveShell());
  });

  it("passes the command as one sh -c argument", () => {
    const command = `printf '%s' 'a & b | c'`;
    expect(shellArgs(resolveShell(), command)).toEqual(["-c", command]);
  });
});
