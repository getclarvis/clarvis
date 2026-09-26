import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createExecutionPolicy, SandboxSetupError, SeatbeltBackend } from "@clarvis/sandbox";
import { resolveConfig } from "../../src/config.ts";
import { ToolError } from "../../src/errors.ts";
import { CoordinatedToolExecutor } from "../../src/execution/coordinator.ts";
import type { ToolExecutionPort } from "../../src/execution/port.ts";
import type { ToolDef } from "../../src/tools/types.ts";

const tool: ToolDef = {
  name: "write_file",
  description: "test operation",
  inputSchema: { type: "object" },
  async handler() {
    return "host result";
  },
};

test("an unavailable sandbox falls back once and is cached for the run", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-coordinator-"));
  try {
    let attempts = 0;
    const sandbox: ToolExecutionPort = {
      async execute() {
        attempts++;
        if (attempts === 1) throw new SandboxSetupError("sandbox_unavailable", "missing backend");
        return "sandbox result";
      },
    };
    const coordinator = new CoordinatedToolExecutor(sandbox, true);
    const config = resolveConfig({ workspaceRoot: root });
    expect(await coordinator.execute(tool, {}, config)).toMatchObject({
      content: "host result",
      meta: { requested_mode: "sandbox", effective_mode: "host", sandbox_fallback: true },
    });
    const cached = await coordinator.execute(tool, {}, config);
    expect(cached).toMatchObject({
      content: "host result",
      meta: { requested_mode: "sandbox", effective_mode: "host", sandbox_fallback: true },
    });
    expect((cached as { meta?: { attempts?: unknown[] } }).meta?.attempts).toHaveLength(1);
    expect(attempts).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session control stays host-owned without a sandbox execution claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-coordinator-"));
  try {
    let sandboxCalls = 0;
    const sandbox: ToolExecutionPort = {
      async execute() {
        sandboxCalls++;
        return "sandbox result";
      },
    };
    const control = { ...tool, name: "shell_session" };
    const result = await new CoordinatedToolExecutor(sandbox, true).execute(
      control,
      {},
      resolveConfig({ workspaceRoot: root }),
    );
    expect(result).toBe("host result");
    expect(sandboxCalls).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an uncertain operation is never replayed on Host", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-coordinator-"));
  try {
    let attempts = 0;
    const sandbox: ToolExecutionPort = {
      async execute() {
        attempts++;
        throw new ToolError("outcome_unknown", "worker died", { execution_started: true });
      },
    };
    const coordinator = new CoordinatedToolExecutor(sandbox, true);
    const config = resolveConfig({ workspaceRoot: root });
    await expect(coordinator.execute(tool, {}, config)).rejects.toMatchObject({
      code: "outcome_unknown",
      message: "worker died",
    });
    await expect(coordinator.execute(tool, {}, config)).rejects.toMatchObject({
      code: "outcome_unknown",
      message: "worker died",
    });
    expect(attempts).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a policy denial on a read retries once on Host", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-coordinator-"));
  try {
    let attempts = 0;
    const read: ToolDef = { ...tool, name: "read_file" };
    const sandbox: ToolExecutionPort = {
      async execute() {
        attempts++;
        throw new ToolError("sandbox_denied", "denied", { execution_started: true });
      },
    };
    const observed: boolean[] = [];
    const result = await new CoordinatedToolExecutor(sandbox, true, (available) => {
      observed.push(available);
    }).execute(read, {}, resolveConfig({ workspaceRoot: root }));
    expect(result).toMatchObject({
      content: "host result",
      meta: { effective_mode: "host", fallback_reason: "sandbox_denied" },
    });
    expect(attempts).toBe(1);
    expect(observed).toEqual([true]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shell denial issues a one-use Host continuation for the same agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-coordinator-"));
  try {
    const shell: ToolDef = { ...tool, name: "shell" };
    const firstAgent = {};
    const secondAgent = {};
    let attempts = 0;
    const sandbox: ToolExecutionPort = {
      async execute() {
        attempts++;
        throw new ToolError("sandbox_denied", "denied after start", { execution_started: true });
      },
    };
    const coordinator = new CoordinatedToolExecutor(sandbox, true);
    const config = { ...resolveConfig({ workspaceRoot: root }), sessionAgent: firstAgent };
    let token = "";
    try {
      await coordinator.execute(shell, {}, config);
    } catch (error) {
      expect(error).toMatchObject({
        code: "sandbox_denied",
        fields: {
          recovery_strategy: "host_recovery",
          execution_started: true,
        },
      });
      token = (error as ToolError).fields.recovery_token as string;
    }
    expect(token).not.toBe("");
    await expect(
      coordinator.execute(
        shell,
        {
          execution_strategy: "host_recovery",
          recovery_token: token,
        },
        { ...config, sessionAgent: secondAgent },
      ),
    ).rejects.toMatchObject({ code: "denied" });
    const recovery = await coordinator.execute(
      shell,
      {
        execution_strategy: "host_recovery",
        recovery_token: token,
      },
      config,
    );
    expect(recovery).toMatchObject({
      meta: { effective_mode: "host", fallback_reason: "agent_recovery" },
    });
    expect((recovery as { meta?: { attempts?: unknown[] } }).meta?.attempts).toHaveLength(1);
    await expect(
      coordinator.execute(
        shell,
        {
          execution_strategy: "host_recovery",
          recovery_token: token,
        },
        config,
      ),
    ).rejects.toMatchObject({ code: "denied" });
    expect(attempts).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aborting an admitted mutation does not block a later operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-coordinator-"));
  try {
    let attempts = 0;
    const sandbox: ToolExecutionPort = {
      async execute() {
        attempts++;
        throw new ToolError("aborted", "worker stopped", { execution_started: true });
      },
    };
    const coordinator = new CoordinatedToolExecutor(sandbox, true);
    const config = resolveConfig({ workspaceRoot: root });
    await expect(coordinator.execute(tool, {}, config)).rejects.toMatchObject({ code: "aborted" });
    await expect(coordinator.execute(tool, {}, config)).rejects.toMatchObject({ code: "aborted" });
    expect(attempts).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only the exact settings write may recover from an OS permission denial", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-coordinator-"));
  try {
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    mkdirSync(workspace);
    mkdirSync(home);
    const policy = createExecutionPolicy({
      id: "settings-recovery",
      mode: "sandbox",
      workspaceRoot: workspace,
      homeRoot: home,
      globalRoot: join(home, ".clarvis"),
    });
    mkdirSync(policy.globalRoot, { recursive: true });
    const homeAlias = join(root, "home-alias");
    symlinkSync(home, homeAlias);
    const settingsAlias = join(homeAlias, ".clarvis", "settings.json");
    expect(resolve(realpathSync(dirname(settingsAlias)), basename(settingsAlias))).toBe(
      policy.settingsFile,
    );
    const config = { ...resolveConfig({ workspaceRoot: workspace }), executionPolicy: policy };
    for (const errno of ["EACCES", "EPERM"]) {
      const sandbox: ToolExecutionPort = {
        async execute() {
          throw new ToolError("io_error", "sandbox denied staging", { errno_code: errno });
        },
      };
      const coordinator = new CoordinatedToolExecutor(sandbox, true);
      const recovered = await coordinator.execute(tool, { path: settingsAlias }, config);
      expect(recovered).toMatchObject({
        content: "host result",
        meta: {
          execution_mode: "host",
          sandbox_fallback: true,
          execution_diagnostic: {
            mode: "host",
            backend: "host",
            policyId: policy.id,
            executionStarted: true,
          },
        },
      });
      await expect(
        coordinator.execute(tool, { path: join(root, "other.json") }, config),
      ).rejects.toMatchObject({ code: "io_error" });
    }
    rmSync(policy.globalRoot, { recursive: true });
    const missingParent: ToolExecutionPort = {
      async execute() {
        throw new ToolError("io_error", "sandbox denied staging", { errno_code: "EPERM" });
      },
    };
    expect(
      await new CoordinatedToolExecutor(missingParent, true).execute(
        tool,
        { path: settingsAlias },
        config,
      ),
    ).toMatchObject({ meta: { effective_mode: "host", fallback_reason: "atomic_settings" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a single-file read-only workspace denial retries once on Host", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-coordinator-"));
  try {
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    mkdirSync(workspace);
    mkdirSync(home);
    const policy = createExecutionPolicy({
      id: "readonly-recovery",
      mode: "sandbox",
      workspaceRoot: workspace,
      workspaceAccess: "read-only",
      homeRoot: home,
    });
    let attempts = 0;
    const sandbox: ToolExecutionPort = {
      async execute() {
        attempts++;
        throw new ToolError("sandbox_denied", "read-only mount", {
          path: join(workspace, "new.txt"),
          errno_code: "EROFS",
        });
      },
    };
    const config = { ...resolveConfig({ workspaceRoot: workspace }), executionPolicy: policy };
    const coordinator = new CoordinatedToolExecutor(sandbox, true);
    expect(await coordinator.execute(tool, { path: "new.txt" }, config)).toMatchObject({
      content: "host result",
      meta: { effective_mode: "host", fallback_reason: "readonly_workspace" },
    });
    expect(attempts).toBe(1);
    await expect(
      coordinator.execute({ ...tool, name: "apply_patch" }, {}, config),
    ).rejects.toMatchObject({ code: "sandbox_denied" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Seatbelt read-only denial recovers only for a workspace file outside explicit denies", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-coordinator-"));
  try {
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    mkdirSync(workspace);
    mkdirSync(home);
    const workspaceAlias = join(root, "workspace-alias");
    symlinkSync(workspace, workspaceAlias);
    const denied = join(workspace, "private.txt");
    const policy = createExecutionPolicy({
      id: "seatbelt-readonly-recovery",
      mode: "sandbox",
      workspaceRoot: workspace,
      workspaceAccess: "read-only",
      homeRoot: home,
      denies: [denied],
    });
    const sandbox: ToolExecutionPort = {
      async execute(_tool, args) {
        throw new ToolError("sandbox_denied", "Seatbelt denied write", {
          path: args.path,
          errno_code: "EPERM",
        });
      },
    };
    const config = {
      ...resolveConfig({ workspaceRoot: workspaceAlias }),
      executionPolicy: policy,
      sandboxBackend: new SeatbeltBackend(),
    };
    const coordinator = new CoordinatedToolExecutor(sandbox, true);
    expect(await coordinator.execute(tool, { path: "allowed.txt" }, config)).toMatchObject({
      meta: { effective_mode: "host", fallback_reason: "readonly_workspace" },
    });
    await expect(coordinator.execute(tool, { path: "private.txt" }, config)).rejects.toMatchObject({
      code: "sandbox_denied",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful sandbox result is marked and close forwards to the port", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-coordinator-"));
  try {
    let closed = false;
    const sandbox: ToolExecutionPort = {
      async execute() {
        return { content: "sandbox result", meta: { detail: "kept" } };
      },
      async close() {
        closed = true;
      },
    };
    const coordinator = new CoordinatedToolExecutor(sandbox, false);
    const config = resolveConfig({ workspaceRoot: root });
    expect(await coordinator.execute(tool, {}, config)).toMatchObject({
      content: "sandbox result",
      meta: { detail: "kept", execution_mode: "sandbox", sandbox_fallback: false },
    });
    await coordinator.close();
    expect(closed).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup failure without authorization is not retried on Host", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-coordinator-"));
  try {
    const sandbox: ToolExecutionPort = {
      async execute() {
        throw new SandboxSetupError("sandbox_setup_failed", "bad mount");
      },
    };
    const coordinator = new CoordinatedToolExecutor(sandbox, false);
    const config = resolveConfig({ workspaceRoot: root });
    await expect(coordinator.execute(tool, {}, config)).rejects.toBeInstanceOf(SandboxSetupError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an authorized Host fallback reports a failed command as Host execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-coordinator-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const policy = createExecutionPolicy({
      id: "host-command-recovery",
      mode: "sandbox",
      workspaceRoot: workspace,
      homeRoot: root,
    });
    const shellTool: ToolDef = {
      ...tool,
      name: "shell",
      async handler() {
        return JSON.stringify({
          running: false,
          exit_code: 9,
          signal: null,
          stdout: "",
          stderr: "ordinary command failure",
        });
      },
    };
    const sandbox: ToolExecutionPort = {
      async execute() {
        throw new SandboxSetupError("sandbox_unavailable", "native boundary unavailable");
      },
    };
    const result = await new CoordinatedToolExecutor(sandbox, true).execute(
      shellTool,
      {},
      { ...resolveConfig({ workspaceRoot: workspace }), executionPolicy: policy },
    );
    expect(result).toMatchObject({
      meta: {
        execution_mode: "host",
        sandbox_fallback: true,
        execution_diagnostic: {
          mode: "host",
          backend: "host",
          policyId: policy.id,
          executionStarted: true,
          failure: "command_failed",
          exitCode: 9,
          stderr: "ordinary command failure",
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
