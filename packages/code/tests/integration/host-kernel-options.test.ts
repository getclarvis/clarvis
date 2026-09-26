import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@clarvis/kernel/logger";
import {
  codeHostEnvironment,
  createCodeHostKernelOptions,
} from "../../src/adapters/host-kernel-options.ts";

describe("code host kernel options", () => {
  it("uses one tool ceiling default for launcher identity and host construction", () => {
    expect(codeHostEnvironment({ HOME: "/home/operator" })).toEqual({
      HOME: "/home/operator",
      CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec",
    });
    expect(codeHostEnvironment({ CLARVIS_AGENT_TOOLS_MAX_GRANT: "read" })).toEqual({
      CLARVIS_AGENT_TOOLS_MAX_GRANT: "read",
    });
  });

  it("shares host policy across local and remote transports without inventing identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-code-host-options-"));
    const logger = createLogger("silent");
    try {
      const base = createCodeHostKernelOptions({
        workspaceRoot: join(root, "workspace"),
        globalDir: join(root, "global"),
        logger,
        environment: {},
        runtimeNotice: () => {},
      });
      expect(base).toMatchObject({
        workspaceRoot: join(root, "workspace"),
        globalDir: join(root, "global"),
        memory: true,
        subscriptions: true,
        environment: {
          values: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
        },
        logger,
        keySources: {},
      });
      expect(base).not.toHaveProperty("defaultOwner");
      expect(base).not.toHaveProperty("extensionProfileSelector");
      expect(base).not.toHaveProperty("runtimeFactory");

      const scoped = createCodeHostKernelOptions({
        workspaceRoot: join(root, "workspace"),
        globalDir: join(root, "global"),
        defaultOwner: "owner",
        extensionProfileSelector: "global:remote",
        logger,
        environment: {
          CLARVIS_AGENT_TOOLS_MAX_GRANT: "read",
          CLARVIS_PRODUCT_ROOT: root,
        },
        runtimeNotice: () => {},
      });
      expect(scoped).toMatchObject({
        defaultOwner: "owner",
        extensionProfileSelector: "global:remote",
        systemDocsSourceRoot: root,
        environment: {
          values: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "read" },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
