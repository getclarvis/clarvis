import { describe, expect, it } from "bun:test";
import { resolvePosture } from "../../src/mcp/elicitation.ts";

describe("guard confirmations", () => {
  it("denies a role that may not approve, and says which of the two refused", () => {
    const posture = resolvePosture({
      clientDeclaresElicitation: true,
      requested: "await",
      allowRemoteGuardApproval: true,
      roleAllowsGuardApproval: false,
    });
    expect(posture.guard_confirmations).toBe("denied");
    expect(posture.downgrades).toContain(
      "guard approvals denied (this role may not approve guarded commands)",
    );
  });

  it("relays only when the container switch and the role both allow it", () => {
    const both = resolvePosture({
      clientDeclaresElicitation: true,
      requested: "await",
      allowRemoteGuardApproval: true,
      roleAllowsGuardApproval: true,
    });
    expect(both.guard_confirmations).toBe("relayed");

    const containerOff = resolvePosture({
      clientDeclaresElicitation: true,
      requested: "await",
      allowRemoteGuardApproval: false,
      roleAllowsGuardApproval: true,
    });
    expect(containerOff.guard_confirmations).toBe("denied");
  });

  it("behaves exactly as before when there is no principal to consult", () => {
    const posture = resolvePosture({
      clientDeclaresElicitation: true,
      requested: "await",
      allowRemoteGuardApproval: true,
    });
    expect(posture.guard_confirmations).toBe("relayed");
  });
});
