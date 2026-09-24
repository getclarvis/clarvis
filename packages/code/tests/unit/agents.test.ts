import { expect, test } from "bun:test";
import { grantSchema } from "@clarvis/kernel/config";
import {
  deriveAgentShape,
  GRANT_CATALOG,
  grantBadges,
  profileView,
} from "../../src/adapters/agents.ts";
import type { ProfileInfo } from "../../src/adapters/run-types.ts";

test("profileView: projects a kernel ProfileInfo (grants/canSpawn/budget travel on it)", () => {
  const profile: ProfileInfo = {
    name: "code-reviewer",
    description: "wire desc",
    canSpawn: ["explorer"],
    budget: { on_exceed: "stop", total_token_limit: 200000 },
    grants: ["read_workspace"],
  };
  const v = profileView(profile);
  expect(v.description).toBe("wire desc");
  expect(v.canSpawn).toEqual(["explorer"]);
  expect(v.grants).toEqual(["read_workspace"]);
  expect(v.budget).toEqual({ on_exceed: "stop", total_token_limit: 200000 });
});

test("profileView: absent grants → unknown; empty grants → []", () => {
  expect(profileView({ name: "u" }).grants).toBe("unknown");
  expect(profileView({ name: "e", grants: [] }).grants).toEqual([]);
  expect(profileView({ name: "e", grants: [] }).canSpawn).toEqual([]);
});

test("deriveAgentShape: isLead from can_spawn, ask from grants, soft from budget", () => {
  const lead = deriveAgentShape({ name: "r", canSpawn: ["explorer"], grants: ["read_workspace"] });
  expect(lead.isLead).toBe(true);
  expect(lead.askUserGranted).toBe(false);
  expect(lead.softMode).toBe(false);

  const planner = deriveAgentShape({
    name: "p",
    canSpawn: [],
    grants: ["ask_user"],
    budget: { on_exceed: "escalate" },
  });
  expect(planner.isLead).toBe(false);
  expect(planner.askUserGranted).toBe(true);
  expect(planner.softMode).toBe(true);

  const unknown = deriveAgentShape({ name: "u", canSpawn: [], grants: "unknown" });
  expect(unknown.askUserGranted).toBe("unknown");
});

test("grantBadges: labels, unknown, empty", () => {
  expect(grantBadges(["read_workspace", "edit_workspace", "run_commands"])).toBe("read edit exec");
  expect(grantBadges(["run_commands", "workflow"])).toBe("exec workflow");
  expect(grantBadges("unknown")).toBe("grants ?");
  expect(grantBadges([])).toBe("");
});

test("GRANT_CATALOG presents every engine-owned grant", () => {
  const offered = new Set<string>(GRANT_CATALOG.map((g) => g.id));
  expect(grantSchema.options.filter((grant) => !offered.has(grant))).toEqual([]);
});

test("GRANT_CATALOG has a non-empty label and detail per grant, and no duplicate ids", () => {
  const ids = GRANT_CATALOG.map((g) => g.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const g of GRANT_CATALOG) {
    expect(g.label.length).toBeGreaterThan(0);
    expect(g.detail.length).toBeGreaterThan(0);
  }
});

test("grantBadges drops whole grants rather than eliding inside one", () => {
  const many: Parameters<typeof grantBadges>[0] = [
    "edit_workspace",
    "read_workspace",
    "ask_user",
    "run_commands",
    "use_skills",
  ];
  const full = grantBadges(many);
  expect(full).toBe("edit read ask exec skills");

  const fitted = grantBadges(many, 32);
  expect(fitted.length).toBeLessThanOrEqual(32);
  expect(fitted).toBe("edit read ask exec skills");
  /* The defect this replaces: a middle elision left the standalone token
     "kills" on screen. Every token must be a whole grant or the +N count. */
  for (const token of fitted.split(" ")) {
    if (/^\+\d+$/.test(token)) continue;
    expect(full.split(" ")).toContain(token);
  }
  expect(fitted).not.toContain("\u2026");
});

test("grantBadges keeps everything when it already fits", () => {
  expect(grantBadges(["read_workspace", "use_skills"], 40)).toBe("read skills");
});

test("grantBadges degrades to a bare count when nothing fits", () => {
  expect(grantBadges(["read_workspace", "edit_workspace", "run_commands"], 3)).toBe("+3");
});
