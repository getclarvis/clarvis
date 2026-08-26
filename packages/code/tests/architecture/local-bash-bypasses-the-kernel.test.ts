/**
 * The `!` escape hatch reaches no kernel and no guard, and that must stay checkable.
 *
 * @remarks The bypass is deliberate: the command is something the user typed and
 * submitted at their own prompt, so there is no approval to obtain from the
 * person already asking for it. But it is an absence, and an absence is exactly
 * what gets undone by a well-meaning edit — someone wiring a `GuardContext`
 * through "for consistency" would turn a user's own shell into an agent-facing
 * surface with an approval dialog, or worse, make the guard's coverage look
 * broader than it is.
 *
 * The module's own docstring already states the property. This is the half that
 * fails when it stops being true. It also pins the diagnostic rule the same
 * docstring carries: the command's text is never among the logged fields,
 * because it is whatever the user typed — up to and including a credential.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "adapters",
  "local-shell.ts",
);

const source = (): string => readFileSync(MODULE, "utf8");

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

/** Non-comment lines of the module. */
const code = (): string[] =>
  source()
    .split("\n")
    .filter((line) => !isComment(line));

describe("runLocalBash goes nowhere near the kernel", () => {
  it("reads the module it means to check", () => {
    expect(source()).toContain("export function runLocalBash");
    expect(code().length).toBeGreaterThan(40);
  });

  it.each([
    ["a kernel client", /\bKernelClient\b|\brunClient\b|\bkernel\s*\.\w/],
    ["the guard", /\bGuardContext\b|\bguard\b/i],
    ["shell analysis", /\banalyzeCommand\b|\bcurrentDialect\b|\bShellDialect\b/],
    ["the protocol", /@clarvis\/protocol/],
  ])("never mentions %s in code", (_label, pattern) => {
    expect(code().filter((line) => pattern.test(line))).toEqual([]);
  });

  /**
   * The one `@clarvis/kernel` import is deliberate and is not a kernel *call*:
   * `./local` is the host process/shell adapter surface — `killTree`,
   * `ownProcessGroup`, `resolveShell`, `shellArgs` — which is exactly what keeps
   * `!` from diverging from the shell the agent's own commands run through.
   */
  it("imports the kernel only for its host adapters, never a client entrypoint", () => {
    const kernelImports = code().filter((line) => line.includes("@clarvis/kernel"));
    expect(kernelImports).toHaveLength(1);
    expect(kernelImports[0]).toContain("@clarvis/kernel/local");
  });

  it("never logs the command text, whatever field it might be tempted into", () => {
    const emitted = code().filter((line) => line.includes("diagnosticEvent("));
    expect(emitted.length).toBeGreaterThan(0);
    const window = source();
    const exitCall = window.slice(window.indexOf('diagnosticEvent("shell.local.exit"'));
    const fields = exitCall.slice(0, exitCall.indexOf("});"));
    expect(fields).not.toContain("command");
    expect(fields).not.toContain("cmd");
  });

  it("still uses the shared shell resolver, so it does not diverge from the agent's host", () => {
    expect(source()).toContain("resolveShell");
    expect(source()).toContain("shellArgs");
  });
});
