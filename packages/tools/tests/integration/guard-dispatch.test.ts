import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { workspaceStatePaths } from "@clarvis/paths";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  exists,
  write,
  lines,
  posixShell,
} from "../helpers/fixtures.ts";
import { touchesOutside } from "../../src/guard/index.ts";
import { buildGuardContext } from "../../src/guard/context.ts";
import type { Guard, Elicit } from "../../src/guard/types.ts";

let root: string;
beforeEach(() => {
  root = makeWorkspace();
});
afterEach(() => cleanup(root));

const writeArgs = { path: "f.txt", content: "hi" };

describe("dispatch guard hook", () => {
  it("runs the tool unchanged when no guard is configured", async () => {
    const r = await callTool("write_file", writeArgs, makeConfig(root));
    expect(r.isError).toBe(false);
    expect(exists(root, "f.txt")).toBe(true);
  });

  it("allows the call when the guard returns allow", async () => {
    const guard: Guard = () => ({ verdict: "allow" });
    const r = await callTool("write_file", writeArgs, makeConfig(root, { guard }));
    expect(r.isError).toBe(false);
    expect(exists(root, "f.txt")).toBe(true);
  });

  it("denies the call and never runs the handler", async () => {
    const guard: Guard = () => ({ verdict: "deny", reason: "nope" });
    const r = await callTool("write_file", writeArgs, makeConfig(root, { guard }));
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("denied");
    expect(r.json.message).toBe("nope");
    expect(exists(root, "f.txt")).toBe(false);
  });

  it("denies an ask when no elicit handler is configured", async () => {
    const guard: Guard = () => ({ verdict: "ask" });
    const r = await callTool("write_file", writeArgs, makeConfig(root, { guard }));
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("denied");
    expect(exists(root, "f.txt")).toBe(false);
  });

  it("resolves an ask through the elicit handler", async () => {
    const guard: Guard = () => ({ verdict: "ask", reason: "confirm" });

    const yes = vi.fn<Elicit>(() => true);
    const rYes = await callTool("write_file", writeArgs, makeConfig(root, { guard, elicit: yes }));
    expect(rYes.isError).toBe(false);
    expect(exists(root, "f.txt")).toBe(true);
    expect(yes).toHaveBeenCalledTimes(1);
    expect(yes.mock.calls[0]?.[0]).toMatchObject({ tool: "write_file", reason: "confirm" });

    cleanup(root);
    root = makeWorkspace();
    const no: Elicit = () => false;
    const rNo = await callTool("write_file", writeArgs, makeConfig(root, { guard, elicit: no }));
    expect(rNo.isError).toBe(true);
    expect(rNo.json.error).toBe("denied");
    expect(rNo.json.message).toBe("command review did not approve: confirm");
    expect(exists(root, "f.txt")).toBe(false);
  });

  it("returns the final auto-guard verdict and answerer with the tool result", async () => {
    const guard: Guard = () => ({ verdict: "ask", reason: "review", mode: "auto" });
    const approved = await callTool(
      "write_file",
      writeArgs,
      makeConfig(root, {
        guard,
        elicit: () => ({ allowed: true, answerer: "judge" }),
      }),
    );
    expect(approved.guard).toEqual({ mode: "auto", outcome: "allowed", answerer: "judge" });

    cleanup(root);
    root = makeWorkspace();
    const denied = await callTool(
      "write_file",
      writeArgs,
      makeConfig(root, {
        guard,
        elicit: () => ({ allowed: false, answerer: "judge" }),
      }),
    );
    expect(denied.guard).toEqual({ mode: "auto", outcome: "denied", answerer: "judge" });
  });

  it("fails closed when the guard throws", async () => {
    const guard: Guard = () => {
      throw new Error("boom");
    };
    const r = await callTool("write_file", writeArgs, makeConfig(root, { guard }));
    expect(r.isError).toBe(true);
    expect(exists(root, "f.txt")).toBe(false);
  });

  it("composes with helpers: deny bash that escapes, allow one that does not", async () => {
    const guard: Guard = (ctx) =>
      touchesOutside(ctx) ? { verdict: "deny" } : { verdict: "allow" };
    const config = makeConfig(root, { guard });

    const denied = await callTool("shell", { command: "cat /etc/passwd" }, config);
    expect(denied.isError).toBe(true);
    expect(denied.json.error).toBe("denied");

    const allowed = await callTool("shell", { command: "echo hi" }, config);
    expect(allowed.isError).toBe(false);
    expect(lines(allowed.json.stdout)).toBe("hi\n");
  });

  it("keeps spills readable without granting an unsandboxed shell write path", async () => {
    const guard: Guard = (ctx) =>
      touchesOutside(ctx) ? { verdict: "deny" } : { verdict: "allow" };
    const config = makeConfig(root, { guard, maxShellOutputBytes: 64 });
    const produced = await callTool(
      "shell",
      { command: "for i in $(seq 1 200); do echo line$i; done; echo needle" },
      { ...config, guard: undefined },
    );
    const spill = /full output written to (\S+)/.exec(produced.text)?.[1];
    expect(spill).toBeDefined();

    const admitted = await callTool("read_file", { path: spill }, config);
    expect(admitted.isError).toBe(false);
    expect(admitted.text).toContain("needle");

    const shellRead = await callTool("shell", { command: `grep -n needle ${spill}` }, config);
    expect(shellRead.isError).toBe(true);
    const overwrite = await callTool("shell", { command: `printf changed > ${spill}` }, config);
    expect(overwrite.isError).toBe(true);
    expect(readFileSync(spill!, "utf8")).toContain("needle");

    const sandboxed = makeConfig(root, {
      guard,
      sandbox: { type: "native", readOnlyPaths: [] },
    });
    expect(
      touchesOutside(buildGuardContext("shell", { command: `grep -n needle ${spill}` }, sandboxed)),
    ).toBe(false);

    const state = workspaceStatePaths(root);
    mkdirSync(state.localDir, { recursive: true });
    writeFileSync(state.promptHistoryFile, "needle\n");
    const refused = await callTool(
      "shell",
      { command: `grep -n needle ${state.promptHistoryFile}` },
      config,
    );
    expect(refused.isError).toBe(true);
    expect(refused.json.error).toBe("denied");
  });

  it.skipIf(!posixShell)(
    "allows POSIX null-device redirection without widening another absolute path",
    async () => {
      const guard: Guard = (ctx) =>
        touchesOutside(ctx) ? { verdict: "deny" } : { verdict: "allow" };
      const config = makeConfig(root, { guard });

      const discarded = await callTool(
        "shell",
        { command: "echo hidden >/dev/null 2>&1 || true" },
        config,
      );
      expect(discarded.isError).toBe(false);

      const refused = await callTool("shell", { command: "cat /etc/passwd" }, config);
      expect(refused.isError).toBe(true);
      expect(refused.json.error).toBe("denied");
    },
  );

  it("treats the configured run temporary root as confined without widening generic /tmp", async () => {
    const temporaryRoot = makeWorkspace();
    try {
      write(temporaryRoot, "result.txt", "needle\n");
      const guard: Guard = (ctx) =>
        touchesOutside(ctx) ? { verdict: "deny" } : { verdict: "allow" };
      const config = makeConfig(root, { guard, temporaryRoots: [temporaryRoot] });

      const admitted = await callTool("grep", { pattern: "needle", path: temporaryRoot }, config);
      expect(admitted.isError).toBe(false);

      const genericTmp = await callTool("grep", { pattern: "needle", path: "/tmp" }, config);
      expect(genericTmp.isError).toBe(true);
      expect(genericTmp.json.error).toBe("denied");
    } finally {
      cleanup(temporaryRoot);
    }
  });

  it("guards move/copy by both endpoints — denies an escaping destination", async () => {
    const guard: Guard = (ctx) =>
      touchesOutside(ctx) ? { verdict: "deny" } : { verdict: "allow" };
    const config = makeConfig(root, { guard });
    write(root, "a.txt", "x");

    const inside = await callTool("move", { source: "a.txt", destination: "b.txt" }, config);
    expect(inside.isError).toBe(false);
    expect(exists(root, "b.txt")).toBe(true);

    write(root, "c.txt", "y");
    const escaping = await callTool(
      "copy",
      { source: "c.txt", destination: "../leak.txt" },
      config,
    );
    expect(escaping.isError).toBe(true);
    expect(escaping.json.error).toBe("denied");
  });
});
