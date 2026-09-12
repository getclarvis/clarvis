import { expect, test } from "bun:test";
import {
  inheritOperatorAuthority,
  type OperatorAuthorityState,
} from "../../src/operator-authority.ts";

test("inherits detached bounded grants and excludes retry authority requiring a shared counter", () => {
  const state: OperatorAuthorityState = {
    version: 1,
    binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
    status: "active",
    revision: 2,
    evidence: [{ id: "operator", source: "start", text: "Commit", execution_id: "run" }],
    envelope: {
      version: 1,
      revision: 2,
      objectives: [],
      grants: [
        {
          id: "a",
          effect_id: "git.commit",
          relation: "direct",
          target_digests: ["repo"],
          constraints: {},
          evidence_ids: ["operator"],
        },
        {
          id: "b",
          effect_id: "github.actions.rerun_failed",
          relation: "bounded_prerequisite",
          target_digests: ["repo"],
          constraints: {},
          evidence_ids: ["operator"],
        },
      ],
      exclusions: [],
    },
  };
  const reader = { snapshot: () => structuredClone(state) };
  expect(inheritOperatorAuthority(undefined, "parent")).toBeUndefined();
  const seed = inheritOperatorAuthority(reader, "parent")!;
  expect(seed.evidence[0]?.source).toBe("inherited");
  expect(seed.parent_run_id).toBe("parent");
  expect(seed.ceiling?.grants.map((grant) => grant.id)).toEqual(["a"]);
  expect(seed.consumed_effects).toEqual([]);
  state.consumed_effects = ["used"];
  expect(inheritOperatorAuthority(reader, "parent")?.consumed_effects).toEqual(["used"]);
  state.revision++;
  expect(inheritOperatorAuthority(reader, "parent")).toBeUndefined();
  state.status = "revoked";
  expect(inheritOperatorAuthority(reader, "parent")).toBeUndefined();
});
