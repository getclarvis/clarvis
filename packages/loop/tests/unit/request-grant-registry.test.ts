import { describe, expect, it } from "../bun-test.ts";
import { createCapabilityRegistry } from "@clarvis/capability";
import {
  BUILTIN_GRANT_NAMES,
  requireKnownGrants,
} from "../../src/validation/request/grant-registry.ts";
import { parsedRequest, validationCode, VALID_REQUEST } from "../helpers/request.ts";

describe("request grant registry", () => {
  it("accepts every built-in grant from one canonical list", () => {
    const data = parsedRequest({
      profiles: [{ ...VALID_REQUEST.profiles[0]!, grants: [...BUILTIN_GRANT_NAMES] }],
    });
    expect(() => requireKnownGrants(data)).not.toThrow();
  });

  it("rejects an undeclared grant and admits a capability declaration", () => {
    const data = parsedRequest({
      profiles: [{ ...VALID_REQUEST.profiles[0]!, grants: ["manage_widgets"] }],
    });
    expect(validationCode(() => requireKnownGrants(data))).toBe("invalid_profile");

    const registry = createCapabilityRegistry();
    registry.registerGrant({ name: "manage_widgets", entryCanSpawn: true });
    expect(() => requireKnownGrants(data, registry)).not.toThrow();
  });
});
