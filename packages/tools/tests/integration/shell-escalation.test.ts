import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTool, cleanup, makeConfig, makeWorkspace } from "../helpers/fixtures.ts";

describe("shell sandbox_permissions", () => {
  let root: string;

  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => cleanup(root));

  it("rejects require_escalated without justification", async () => {
    const result = await callTool(
      "shell",
      { command: "echo hi", sandbox_permissions: "require_escalated" },
      makeConfig(root),
    );
    expect(result.isError).toBe(true);
    expect(result.json.error).toBe("invalid_input");
  });

  it("asks a human before a sandboxed require_escalated spawn and runs only after allow", async () => {
    let spawned = 0;
    let elicitCalls = 0;
    const result = await callTool(
      "shell",
      {
        command: "echo escalated",
        sandbox_permissions: "require_escalated",
        justification: "sandbox blocked the host socket",
      },
      makeConfig(root, {
        sandbox: { type: "native", availability: "required" },
        guard: (ctx) => {
          spawned += 1;
          expect(ctx.sandboxPermissions).toBe("require_escalated");
          expect(ctx.justification).toBe("sandbox blocked the host socket");
          return {
            verdict: "ask",
            escalate: "human",
            reason: ctx.justification,
            mode: "on",
          };
        },
        elicit: () => {
          elicitCalls += 1;
          expect(spawned).toBe(1);
          return true;
        },
      }),
    );
    expect(elicitCalls).toBe(1);
    expect(result.isError).toBe(false);
    expect(result.json.exit_code).toBe(0);
    expect(String(result.json.stdout)).toContain("escalated");
  });

  it("reviews an escalated yielded command once and does not review its session operations", async () => {
    const file = join(root, "approved-session.cjs");
    writeFileSync(file, "process.stdout.write('READY\\n'); setInterval(() => {}, 1000);");
    const invocation = `"${process.execPath}" "${file}"`;
    let reviews = 0;
    let approvals = 0;
    const config = makeConfig(root, {
      sandbox: { type: "native", availability: "required" },
      guard: () => {
        reviews++;
        return { verdict: "ask", escalate: "human", reason: "approved command", mode: "on" };
      },
      elicit: () => {
        approvals++;
        return true;
      },
    });
    try {
      const started = await callTool(
        "shell",
        {
          command: process.platform === "win32" ? `& ${invocation}` : invocation,
          sandbox_permissions: "require_escalated",
          justification: "approved command",
          ready_when: "READY",
          yield_time_ms: 5000,
        },
        config,
      );
      expect(started.json).toMatchObject({ running: true, ready: true });
      const sessionId = started.json.session_id as string;
      expect(
        (await callTool("shell_session", { action: "poll", session_id: sessionId }, config)).json
          .stdout,
      ).toContain("READY");
      expect(
        (await callTool("shell_session", { action: "stop", session_id: sessionId }, config)).json
          .termination_confirmed,
      ).toBe(true);
      expect(reviews).toBe(1);
      expect(approvals).toBe(1);
    } finally {
      await config.sessionManager.close();
    }
  });

  it("does not extra-prompt on Isolation Host when the field is present", async () => {
    let elicitCalls = 0;
    const result = await callTool(
      "shell",
      {
        command: "echo host",
        sandbox_permissions: "require_escalated",
        justification: "not needed on host",
      },
      makeConfig(root, {
        guard: () => ({ verdict: "allow" }),
        elicit: () => {
          elicitCalls += 1;
          return true;
        },
      }),
    );
    expect(elicitCalls).toBe(0);
    expect(result.isError).toBe(false);
    expect(String(result.json.stdout)).toContain("host");
  });

  it("rejects require_escalated in an isolated container placement", async () => {
    let elicited = false;
    const result = await callTool(
      "shell",
      {
        command: "echo should-not-run",
        sandbox_permissions: "require_escalated",
        justification: "need host git",
      },
      makeConfig(root, {
        allowHostEscalation: false,
        elicit: () => {
          elicited = true;
          return true;
        },
      }),
    );
    expect(elicited).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.json.error).toBe("denied");
    expect(String(result.json.message)).toContain("Isolated container runs cannot reach the host");
  });

  it("denies git credential and gh auth token on shell", async () => {
    for (const command of ["git credential fill", "gh auth token"]) {
      const result = await callTool("shell", { command }, makeConfig(root));
      expect(result.isError).toBe(true);
      expect(result.json.error).toBe("denied");
    }
  });

  it("denies git helper execution options on sandboxed and unsandboxed shell", async () => {
    for (const sandbox of [
      undefined,
      { type: "native" as const, availability: "required" as const },
    ]) {
      const result = await callTool(
        "shell",
        { command: "git ls-remote --upload-pack=printf SHOULD_NOT_RUN ." },
        makeConfig(root, sandbox === undefined ? {} : { sandbox }),
      );
      expect(result.isError).toBe(true);
      expect(result.json.error).toBe("denied");
    }
  });
});
