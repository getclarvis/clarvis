import { describe, expect, it } from "../bun-test.ts";
import {
  rejectDuplicateProfileNames,
  rejectDuplicateServerNames,
  requireEntryShape,
  requireKnownSpawnTargets,
} from "../../src/validation/request/identity-rules.ts";
import { parsedRequest, validationCode, VALID_REQUEST } from "../helpers/request.ts";

describe("request identity and topology rules", () => {
  it("accepts a unique, resolvable topology", () => {
    const data = parsedRequest();
    expect(() => rejectDuplicateServerNames(data)).not.toThrow();
    expect(() => rejectDuplicateProfileNames(data)).not.toThrow();
    expect(() => requireKnownSpawnTargets(data, requireEntryShape(data))).not.toThrow();
  });

  it("owns duplicate server and profile names", () => {
    const duplicateServers = parsedRequest({
      servers: [
        { name: "fs", transport: "stdio", command: "a" },
        { name: "fs", transport: "stdio", command: "b" },
      ],
    });
    expect(validationCode(() => rejectDuplicateServerNames(duplicateServers))).toBe(
      "duplicate_server_name",
    );

    const duplicateProfiles = parsedRequest({
      profiles: [VALID_REQUEST.profiles[0]!, { ...VALID_REQUEST.profiles[0]! }],
    });
    expect(validationCode(() => rejectDuplicateProfileNames(duplicateProfiles))).toBe(
      "duplicate_profile_name",
    );
  });

  it("requires entry to resolve", () => {
    expect(validationCode(() => requireEntryShape(parsedRequest({ entry: "missing" })))).toBe(
      "unknown_profile",
    );
  });

  it.each([
    ["unknown can_spawn", { can_spawn: ["missing"] }],
    ["default outside can_spawn", { can_spawn: ["worker"], default_spawn: "other" }],
  ])("rejects %s", (_label, entryFields) => {
    const profiles = [
      { ...VALID_REQUEST.profiles[0]!, name: "lead", ...entryFields },
      { ...VALID_REQUEST.profiles[0]!, name: "worker" },
      { ...VALID_REQUEST.profiles[0]!, name: "vision" },
      { ...VALID_REQUEST.profiles[0]!, name: "other" },
    ];
    const data = parsedRequest({ entry: "lead", profiles });
    expect(validationCode(() => requireKnownSpawnTargets(data, requireEntryShape(data)))).toBe(
      "unknown_profile",
    );
  });
});
