import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/core.ts";
import { resolveConfig, type ToolActionAuthorization } from "../../src/config.ts";
import { prepareToolAction } from "../../src/execution/action.ts";

function fixture(granted: boolean) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-action-"));
  const requests: Parameters<ToolActionAuthorization["authorize"]>[0][] = [];
  let executed = 0;
  const config = resolveConfig({
    workspaceRoot,
    actionIdentity: { owner: "owner", executionId: "run" },
    actionAuthorization: {
      policyRevision: "policy",
      revision: () => 0,
      async authorize(request) {
        requests.push(request);
        return {
          granted,
          fingerprint: "decision",
          evidence: {
            reason: granted ? "allow" : "blocked",
            decision: granted ? "allow" : "forbidden",
            source: "host",
            requestedProfile: "host",
            effectiveProfile: "host",
            executionStarted: false,
          },
        };
      },
      valid: () => true,
    },
    executionPort: {
      async execute() {
        executed++;
        return "executed";
      },
    },
  });
  const hooks = { actionCallId: "call", actionActor: "lead" };
  return {
    workspaceRoot,
    config,
    requests,
    hooks,
    executed: () => executed,
    close: () => rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

test("a denied final file action never reaches its executor", async () => {
  const f = fixture(false);
  try {
    const result = await dispatch(
      "write_file",
      { path: "out.txt", content: "x" },
      f.config,
      undefined,
      f.hooks,
    );
    expect(result.isError).toBe(true);
    expect(f.executed()).toBe(0);
    expect(f.requests[0]?.identity).toMatchObject({
      owner: "owner",
      executionId: "run",
      actor: "lead",
      callId: "call",
    });
  } finally {
    f.close();
  }
});

test("a patch presents every resolved target after schema validation", async () => {
  const f = fixture(true);
  try {
    const patch =
      "*** Begin Patch\n*** Add File: one.txt\n+a\n*** Add File: two.txt\n+b\n*** End Patch";
    const result = await dispatch("apply_patch", { patch }, f.config, undefined, f.hooks);
    expect(result.isError).toBe(false);
    expect(f.requests[0]?.paths).toEqual([
      join(f.workspaceRoot, "one.txt"),
      join(f.workspaceRoot, "two.txt"),
    ]);
    expect(f.executed()).toBe(1);
  } finally {
    f.close();
  }
});

test("an invalid shell readiness pattern is rejected before review", async () => {
  const f = fixture(true);
  try {
    const result = await dispatch(
      "shell",
      { command: "echo hi", ready_when: "[" },
      f.config,
      undefined,
      f.hooks,
    );
    expect(result.isError).toBe(true);
    expect(f.requests).toEqual([]);
    expect(f.executed()).toBe(0);
  } finally {
    f.close();
  }
});

test("steering during review requires a fresh authorization before execution", async () => {
  const f = fixture(true);
  let revision = 0;
  const seen: number[] = [];
  const policies: string[] = [];
  let policy = "policy";
  const authority = f.config.actionAuthorization!;
  const config = {
    ...f.config,
    actionAuthorization: {
      ...authority,
      get policyRevision() {
        return policy;
      },
      revision: () => revision,
      async authorize(request: Parameters<ToolActionAuthorization["authorize"]>[0]) {
        seen.push(request.authorizationRevision);
        policies.push(request.policyRevision);
        if (seen.length === 1) {
          revision++;
          policy = "new-policy";
        }
        return {
          granted: true,
          fingerprint: "decision",
          evidence: {
            reason: "allow",
            decision: "allow",
            source: "reviewer",
            requestedProfile: "host" as const,
            effectiveProfile: "host" as const,
            executionStarted: false,
          },
        };
      },
      valid(request: Parameters<ToolActionAuthorization["authorize"]>[0]) {
        return request.authorizationRevision === revision && request.policyRevision === policy;
      },
    },
  };
  try {
    const result = await dispatch(
      "write_file",
      { path: "out.txt", content: "x" },
      config,
      undefined,
      f.hooks,
    );
    expect(result.isError).toBe(false);
    expect(seen).toEqual([0, 1]);
    expect(policies).toEqual(["policy", "new-policy"]);
    expect(f.executed()).toBe(1);
  } finally {
    f.close();
  }
});

test("shell permission deltas are validated before an action is presented", async () => {
  const f = fixture(true);
  try {
    await expect(
      prepareToolAction(
        "shell",
        {
          command: "echo hi",
          execution_permissions: {
            mode: "with_additional_permissions",
          },
        },
        f.config,
      ),
    ).rejects.toThrow("Additional permissions require");
    await expect(
      prepareToolAction(
        "shell",
        {
          command: "echo hi",
          execution_permissions: {
            mode: "with_additional_permissions",
            write_roots: ["relative"],
          },
        },
        f.config,
      ),
    ).rejects.toThrow("existing absolute directory");
    const host = await prepareToolAction(
      "shell",
      {
        command: "echo hi",
        execution_permissions: {
          mode: "require_escalated",
        },
      },
      f.config,
    );
    expect(host.permissions).toEqual({ host: true });
    expect(host.cwd).toBe(f.workspaceRoot);
    const extra = await prepareToolAction(
      "shell",
      {
        command: "echo hi",
        execution_permissions: {
          mode: "with_additional_permissions",
          write_roots: [f.workspaceRoot],
          network: "enabled",
        },
      },
      f.config,
    );
    expect(extra.permissions).toEqual({ writeRoots: [f.workspaceRoot], network: "enabled" });
    expect((await prepareToolAction("shell_session", {}, f.config)).reason).toBe(
      "owned session control",
    );
  } finally {
    f.close();
  }
});

test("file actions report resolved paths and required write roots", async () => {
  const f = fixture(true);
  try {
    const inside = await prepareToolAction("write_file", { path: "new.txt" }, f.config);
    expect(inside.paths).toEqual([join(f.workspaceRoot, "new.txt")]);
    const readOnly = {
      ...f.config,
      executionPolicy: {
        mode: "sandbox" as const,
        workspaceAccess: "read-only" as const,
        homeRoot: f.workspaceRoot,
        globalRoot: f.workspaceRoot,
        readOnlyPaths: [] as string[],
      },
    } as unknown as typeof f.config;
    const outside = await prepareToolAction("write_file", { path: "new.txt" }, readOnly);
    expect(outside.permissions?.writeRoots).toContain(f.workspaceRoot);
    expect(
      (await prepareToolAction("read_file", { path: "new.txt" }, readOnly)).permissions,
    ).toBeUndefined();
    const outsideRoot = mkdtempSync(join(tmpdir(), "clarvis-outside-"));
    try {
      symlinkSync(outsideRoot, join(f.workspaceRoot, "link"));
      const linked = await prepareToolAction("write_file", { path: "link" }, f.config);
      expect(linked.paths).toContain(outsideRoot);
      const external = await prepareToolAction(
        "write_file",
        { path: join(outsideRoot, "new.txt") },
        f.config,
      );
      expect(external.permissions?.writeRoots).toContain(outsideRoot);
      const metadata = await prepareToolAction(
        "write_file",
        { path: join(outsideRoot, "new.txt") },
        {
          ...readOnly,
          executionPolicy: { ...readOnly.executionPolicy!, readOnlyPaths: [outsideRoot] },
        },
      );
      expect(metadata.permissions?.writeRoots).toContain(outsideRoot);
      const temporary = await prepareToolAction(
        "write_file",
        { path: join(outsideRoot, "temp.txt") },
        {
          ...f.config,
          temporaryRoots: [outsideRoot],
        },
      );
      expect(temporary.permissions).toBeUndefined();
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  } finally {
    f.close();
  }
});

test("executor sees a live grant and reports the physical start", async () => {
  const f = fixture(true);
  const phases: string[] = [];
  const config = {
    ...f.config,
    actionAuthorization: {
      ...f.config.actionAuthorization!,
      recordAttempt: (_request: unknown, phase: string) => {
        phases.push(phase);
      },
    },
    executionPort: {
      async execute(_tool: unknown, _args: unknown, current: typeof f.config) {
        expect(current.actionValid?.()).toBe(true);
        current.actionStarted?.("host");
        return "executed";
      },
    },
  } as typeof f.config;
  try {
    expect(
      (await dispatch("write_file", { path: "out.txt", content: "x" }, config, undefined, f.hooks))
        .isError,
    ).toBe(false);
    expect(phases).toEqual(["admitted", "started", "settled"]);
  } finally {
    f.close();
  }
});

test("a steering interruption retries tool authorization with the latest policy", async () => {
  const f = fixture(true);
  let revision = 0;
  let calls = 0;
  const config = {
    ...f.config,
    actionAuthorization: {
      ...f.config.actionAuthorization!,
      get policyRevision() {
        return String(revision);
      },
      revision: () => revision,
      async authorize(request: Parameters<ToolActionAuthorization["authorize"]>[0]) {
        calls++;
        if (calls === 1) {
          revision++;
          throw new Error("steered");
        }
        expect(request.policyRevision).toBe("1");
        return {
          granted: true,
          fingerprint: "ok",
          evidence: {
            reason: "approved",
            decision: "allow",
            source: "reviewer",
            requestedProfile: "host" as const,
            effectiveProfile: "host" as const,
            executionStarted: false,
          },
        };
      },
      valid: () => true,
    },
  } as typeof f.config;
  try {
    expect(
      (await dispatch("write_file", { path: "out.txt", content: "x" }, config, undefined, f.hooks))
        .isError,
    ).toBe(false);
    expect(calls).toBe(2);
  } finally {
    f.close();
  }
});
