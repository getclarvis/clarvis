import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentTools } from "@clarvis/tools";
import { probeSandbox } from "@clarvis/tools/sandbox";
import { createShellGuard } from "../../src/guard/shell-guard.ts";

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "Guard review admits the same external reads for shell and file tools in a native Sandbox",
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-guard-file-parity-"));
    const reviews: string[] = [];
    const tools = createAgentTools({
      workspaceRoot: workspace,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
      guard: createShellGuard({ placement: "contained", allowedCommands: ["cat"] }),
      elicit: async (request) => {
        reviews.push(request.tool);
        return true;
      },
    });
    try {
      const file = await tools.callTool("read_file", { path: "/etc/os-release" });
      const stat = await tools.callTool("file_stat", { path: "/etc/hostname" });
      const shell = await tools.callTool("shell", { command: "cat /etc/os-release" });
      expect(file.isError).toBe(false);
      expect(stat.isError).toBe(false);
      expect(shell.isError).toBe(false);
      expect(reviews).toEqual(["read_file", "file_stat", "shell"]);
    } finally {
      await tools.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux" || probeSandbox().mode === "unavailable")(
  "Auto reviews shell and file-tool removal of the same bounded workspace tree without a human prompt",
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-guard-delete-parity-"));
    const target = join(workspace, "probe");
    let shellReviews = 0;
    let fileReviews = 0;
    const prepare = () => {
      mkdirSync(target);
      writeFileSync(join(target, "entry.txt"), "temporary");
    };
    const tools = createAgentTools({
      workspaceRoot: workspace,
      sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
      guard: createShellGuard({ placement: "contained", allowHostJudge: true }),
      elicit: async (request) => {
        expect(request.tool).toBe("shell");
        expect(request.escalate).toBeUndefined();
        shellReviews++;
        return { allowed: true, answerer: "judge" };
      },
      reviewMutation: async (operations, commit) => {
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({ type: "rmtree", path: target });
        fileReviews++;
        await commit();
      },
    });
    try {
      prepare();
      const shell = await tools.callTool("shell", { command: "rm -rf ./probe" });
      expect(shell.isError).toBe(false);
      expect(existsSync(target)).toBe(false);
      prepare();
      const file = await tools.callTool("remove", { path: "probe", recursive: true });
      expect(file.isError).toBe(false);
      expect(existsSync(target)).toBe(false);
      expect({ shellReviews, fileReviews }).toEqual({ shellReviews: 1, fileReviews: 1 });
    } finally {
      await tools.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
