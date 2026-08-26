import { afterEach, describe, it, expect } from "bun:test";
import type { Principal } from "../../src/auth/principals.ts";
import type { RolePermissions } from "../../src/auth/auth-config.ts";
import { TOOL_NAMES } from "../../src/mcp/tools.ts";
import { createFakeRunHost } from "../helpers/fake-run-host.ts";
import { closeOpenHarnesses, makeHarness, payloadOf } from "../helpers/harness.ts";

afterEach(closeOpenHarnesses);

/** A principal carrying the given role permissions. */
function principal(role: string, permissions: Partial<RolePermissions> = {}): Principal {
  return {
    clientId: "svc",
    owner: "acme",
    role,
    permissions: {
      agents: "*",
      guardConfirmations: "deny",
      mayImpersonateOwner: false,
      ...permissions,
    },
  };
}

describe("the agent allowlist", () => {
  it("requires a named allowed agent and rejects omitted or foreign names before start", async () => {
    const host = createFakeRunHost(() => ({}));
    const harness = await makeHarness({
      host,
      principal: principal("service", { agents: ["support"] }),
    });

    const refused = payloadOf(
      await harness.client.callTool({ name: TOOL_NAMES.run, arguments: { prompt: "go" } }),
    );
    expect(refused).toMatchObject({ error: { code: "forbidden" } });
    expect(host.started).toHaveLength(0);

    const foreign = payloadOf(
      await harness.client.callTool({
        name: TOOL_NAMES.run,
        arguments: { prompt: "go", agent: "root" },
      }),
    );
    expect(foreign).toMatchObject({
      error: {
        code: "forbidden",
        message: "role 'service' may not run agent 'root'",
        details: { role: "service", agents: ["support"] },
      },
    });
    expect(host.started).toHaveLength(0);

    const allowed = payloadOf(
      await harness.client.callTool({
        name: TOOL_NAMES.run,
        arguments: { prompt: "go", agent: "support" },
      }),
    );
    expect(allowed).toMatchObject({ status: "completed" });
    expect(host.started).toHaveLength(1);

    await harness.close();
  });

  it("leaves an unrestricted role exactly as it was without authentication", async () => {
    const host = createFakeRunHost(() => ({}));
    const harness = await makeHarness({ host, principal: principal("user") });

    const out = payloadOf(
      await harness.client.callTool({
        name: TOOL_NAMES.run,
        arguments: { prompt: "go", agent: "anything" },
      }),
    );
    expect(out).toMatchObject({ status: "completed" });

    await harness.close();
  });
});

describe("the per-role run cap", () => {
  it("narrows the server's per-owner cap but cannot widen it", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = createFakeRunHost(() => ({ holdUntil: held }));
    const harness = await makeHarness({
      host,
      limits: { maxRunsPerOwner: 4 },
      principal: principal("service", { maxRuns: 1 }),
    });

    void harness.client
      .callTool({ name: TOOL_NAMES.run, arguments: { prompt: "a", execution_id: "r1" } })
      .catch(() => undefined);
    await harness.waitForMessage(
      (message) => (message.data as { type?: string }).type === "run_accepted",
    );

    const second = payloadOf(
      await harness.client.callTool({
        name: TOOL_NAMES.run,
        arguments: { prompt: "b", execution_id: "r2" },
      }),
    );
    expect(second).toMatchObject({
      error: { code: "resource_exhausted", details: { scope: "owner", limit: 1 } },
    });

    release();
    await harness.close();
  });
});
