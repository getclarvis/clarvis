import { describe, expect, it } from "bun:test";
import {
  currentShellFlavor,
  encodePowerShellCommand,
  exitCaptureWrapper,
  resolveShell,
  shellArgs,
  type ShellSpec,
} from "../../src/shell.ts";

const POSIX: ShellSpec = { flavor: "posix", file: "sh" };
const WINDOWS: ShellSpec = { flavor: "powershell", file: "powershell.exe" };

/** Decode an `-EncodedCommand` payload back to the text PowerShell will run. */
function decode(payload: string): string {
  return Buffer.from(payload, "base64").toString("utf16le");
}

describe("currentShellFlavor", () => {
  it("maps win32 to powershell and everything else to posix", () => {
    expect(currentShellFlavor("win32")).toBe("powershell");
    expect(currentShellFlavor("linux")).toBe("posix");
    expect(currentShellFlavor("darwin")).toBe("posix");
    expect(currentShellFlavor("freebsd")).toBe("posix");
  });
});

describe("resolveShell", () => {
  it("resolves sh on a POSIX host", () => {
    expect(resolveShell({ platform: "linux" })).toEqual({ flavor: "posix", file: "sh" });
  });

  it("prefers pwsh when it is on PATH", () => {
    const spec = resolveShell({
      platform: "win32",
      lookup: (c) => (c === "pwsh" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : undefined),
    });
    expect(spec).toEqual({
      flavor: "powershell",
      file: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    });
  });

  it("falls back to Windows PowerShell 5.1 by absolute path", () => {
    const spec = resolveShell({
      platform: "win32",
      lookup: () => undefined,
      systemRoot: "D:\\Windows",
    });
    expect(spec.flavor).toBe("powershell");
    expect(spec.file).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("defaults SystemRoot to C:\\Windows when the environment does not name one", () => {
    const spec = resolveShell({
      platform: "win32",
      lookup: () => undefined,
      systemRoot: undefined,
    });
    expect(spec.file.startsWith("C:\\Windows\\")).toBe(true);
  });

  it("memoizes the host answer but never caches an injected one", () => {
    expect(resolveShell()).toBe(resolveShell());
    const injected = resolveShell({ platform: "win32", lookup: () => undefined });
    expect(injected.flavor).toBe("powershell");
    const defaultLookup = resolveShell({ platform: "win32", systemRoot: "D:\\Windows" });
    expect(defaultLookup.flavor).toBe("powershell");
    expect(resolveShell().flavor).toBe(currentShellFlavor());
  });
});

describe("shellArgs", () => {
  it("passes a POSIX command through as sh -c", () => {
    expect(shellArgs(POSIX, "echo ok")).toEqual(["-c", "echo ok"]);
  });

  it("uses a non-interactive, profile-free encoded invocation on Windows", () => {
    const args = shellArgs(WINDOWS, "echo ok");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(args).toHaveLength(4);
  });

  it("keeps every shell metacharacter out of the command line", () => {
    const nasty = `Write-Output "a & b | c ; d \` e" & rm -rf /`;
    const payload = shellArgs(WINDOWS, nasty)[3]!;
    expect(payload).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(decode(payload).endsWith(`\n${nasty}`)).toBe(true);
  });

  it("round-trips non-ASCII text through the UTF-16LE payload", () => {
    const command = "Write-Output 'héllo — 世界 🎉'";
    expect(decode(encodePowerShellCommand(command)).endsWith(`\n${command}`)).toBe(true);
  });

  it("forces BOM-less UTF-8 on both stream directions before running anything", () => {
    const preamble = decode(encodePowerShellCommand("echo ok")).split("\n")[0]!;
    expect(preamble).toContain("[Console]::OutputEncoding");
    expect(preamble).toContain("$OutputEncoding");
    // `[Text.Encoding]::UTF8` is a UTF8Encoding(true) and would prepend a BOM to
    // stdout, breaking every assertion on exact output.
    expect(preamble).toContain("New-Object System.Text.UTF8Encoding $false");
    expect(preamble).not.toContain("[Text.Encoding]::UTF8");
  });
});

describe("exitCaptureWrapper", () => {
  it("installs an EXIT trap on POSIX", () => {
    expect(exitCaptureWrapper("bun test", "posix")).toBe(
      `trap 'printf "%s" "$?" > "$MON_EXIT.tmp" && mv -f "$MON_EXIT.tmp" "$MON_EXIT"' EXIT\n` +
        `bun test\n`,
    );
  });

  it("wraps the command in try/finally on PowerShell", () => {
    const w = exitCaptureWrapper("bun test", "powershell");
    expect(w.startsWith("try {\n")).toBe(true);
    expect(w).toContain("\nbun test\n");
    expect(w).toContain("$env:MON_EXIT");
    expect(w).toContain("UTF8Encoding $false");
  });

  it("embeds the command verbatim, applying no escaping of its own", () => {
    const command = 'Write-Output "}" ; Get-Item `x`';
    expect(exitCaptureWrapper(command, "powershell")).toContain(`\n${command}\n`);
  });

  it("tests $? before $LASTEXITCODE", () => {
    // $LASTEXITCODE is sticky for the whole payload: once any native command has
    // run it stays set, so testing it first would make `git status; Write-Output ok`
    // report git's status rather than the payload's. Reversing these is the most
    // likely way for a later simplification to silently break exit reporting.
    const w = exitCaptureWrapper("bun test", "powershell");
    expect(w.indexOf("$?")).toBeLessThan(w.indexOf("$LASTEXITCODE"));
  });
});
