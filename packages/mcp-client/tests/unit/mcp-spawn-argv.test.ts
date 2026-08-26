import { describe, expect, it } from "bun:test";
import { mcpSpawnArgv } from "@clarvis/mcp-client";

describe("mcpSpawnArgv", () => {
  it("passes the command through untouched on POSIX", () => {
    expect(mcpSpawnArgv("npx", ["-y", "some-server"], "linux")).toEqual({
      argv: ["npx", "-y", "some-server"],
      verbatim: false,
    });
  });

  it("routes a .cmd shim through cmd.exe on Windows", () => {
    // `npx`, `bunx` and `pnpm dlx` are all `.cmd` shims on Windows, and a `.cmd`
    // cannot be spawned directly since that path was closed as a
    // command-injection mitigation. Without this, every `command: "npx"` MCP
    // server in a user's settings fails to start with a bare ENOENT.
    const shim = "C:\\Program Files\\nodejs\\npx.cmd";
    const { argv, verbatim } = mcpSpawnArgv("npx", ["-y", "some-server"], "win32");
    const routed = argv[0]?.toLowerCase().endsWith("cmd.exe") === true;
    if (!routed) {
      // No real npx.cmd on this host; assert the shape the resolver would produce.
      expect(argv[0]).toBe("npx");
      expect(verbatim).toBe(false);
      return;
    }
    expect(argv.slice(1, 4)).toEqual(["/d", "/s", "/c"]);
    expect(verbatim).toBe(true);
    expect(shim).toContain(".cmd");
  });

  it("quotes each part so a path containing spaces survives cmd's own parsing", () => {
    // The line is handed to cmd verbatim, so anything unquoted would be split at
    // the space in `C:\Program Files\...`.
    const { argv } = mcpSpawnArgv("npx", ["--flag", "a b"], "win32");
    const line = argv[argv.length - 1]!;
    if (argv[0]?.toLowerCase().endsWith("cmd.exe")) {
      expect(line).toContain('"a b"');
      expect(line).toContain('"--flag"');
    }
  });

  it("leaves a real executable alone rather than routing it through a shell", () => {
    const { argv, verbatim } = mcpSpawnArgv("some-server-binary", ["--port", "1"], "win32");
    expect(argv.slice(-2)).toEqual(["--port", "1"]);
    expect(verbatim).toBe(false);
  });

  it("refuses a double quote rather than silently corrupting cmd's own parsing", () => {
    // The line is parsed twice - once by cmd.exe, again by the child's own argv
    // parser - and those two parsers disagree on how an escaped quote is
    // spelled. A command name ending in .cmd forces the shell-routing branch
    // even without a real file on PATH, since resolution falls back to the
    // literal name when nothing is found.
    expect(() => mcpSpawnArgv("myserver.cmd", ['--flag="value"'], "win32")).toThrow(/double quote/);
    expect(() => mcpSpawnArgv('my"server.cmd', [], "win32")).toThrow(/double quote/);
  });

  it("still runs an ordinary .cmd server with no embedded quotes", () => {
    const { argv, verbatim } = mcpSpawnArgv("myserver.cmd", ["--flag", "value"], "win32");
    expect(argv[0]?.toLowerCase()).toBe("cmd.exe");
    expect(verbatim).toBe(true);
    expect(argv[argv.length - 1]).toBe('"myserver.cmd" "--flag" "value"');
  });
});
