import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxSetupError } from "@clarvis/sandbox";
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clarvis-coordinator-"));
  return {
    config: resolveConfig({ workspaceRoot: root }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a prelaunch setup failure never grants Host to this or a later call", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const sandbox: ToolExecutionPort = {
      async execute() {
        calls++;
        throw new SandboxSetupError("sandbox_unavailable", "missing backend");
      },
    };
    const availability: boolean[] = [];
    const coordinator = new CoordinatedToolExecutor(sandbox, (ready) => availability.push(ready));
    await expect(coordinator.execute(tool, {}, f.config)).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
    await expect(coordinator.execute(tool, {}, f.config)).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
    expect(calls).toBe(1);
    expect(availability).toEqual([false]);
  } finally {
    f.close();
  }
});

test("a denial and an uncertain outcome are returned without replay", async () => {
  const f = fixture();
  try {
    for (const code of ["sandbox_denied", "outcome_unknown"] as const) {
      let calls = 0;
      const coordinator = new CoordinatedToolExecutor({
        async execute() {
          calls++;
          throw new ToolError(code, code, { execution_started: true });
        },
      });
      await expect(coordinator.execute(tool, {}, f.config)).rejects.toMatchObject({ code });
      expect(calls).toBe(1);
    }
  } finally {
    f.close();
  }
});

test("shell_session controls only an owned session and never probes sandbox", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const coordinator = new CoordinatedToolExecutor({
      async execute() {
        calls++;
        return "sandbox";
      },
    });
    const result = await coordinator.execute({ ...tool, name: "shell_session" }, {}, f.config);
    expect(result).toBe("host result");
    expect(calls).toBe(0);
  } finally {
    f.close();
  }
});

test("file mutations remain serialized under the sandbox", async () => {
  const f = fixture();
  try {
    let active = 0;
    let peak = 0;
    const sandbox: ToolExecutionPort = {
      async execute() {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return "sandbox";
      },
    };
    const coordinator = new CoordinatedToolExecutor(sandbox);
    await Promise.all([
      coordinator.execute(tool, {}, f.config),
      coordinator.execute(tool, {}, f.config),
    ]);
    expect(peak).toBe(1);
  } finally {
    f.close();
  }
});
