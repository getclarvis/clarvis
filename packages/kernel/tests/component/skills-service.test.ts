import { describe, it, expect } from "bun:test";
import type { SkillsProvider } from "@clarvis/loop";
import { createSkillsService } from "../../src/skills/skills-service.ts";

type Skill = {
  name: string;
  description: string;
  userInvocable: boolean;
  metadata: unknown;
  body?: string;
  scope?: "user" | "workspace";
  source?: string;
  presentation?: unknown;
  catalogSuppressed?: boolean;
};

function provider(skills: Skill[]): SkillsProvider {
  return {
    listSkills: () => skills as never,
    loadSkill: (name) => {
      const s = skills.find((k) => k.name === name);
      return s ? ({ ...s, body: s.body ?? "" } as never) : undefined;
    },
    readResource: (name, rel) => `${name}/${rel}`,
  };
}

describe("createSkillsService", () => {
  it("returns [] when skills are disabled (no provider)", async () => {
    const svc = createSkillsService({ skills: undefined });
    expect(await svc.list()).toEqual([]);
  });

  it("lists only user-invocable skills and reports the agent each one names", async () => {
    const svc = createSkillsService({
      skills: provider([
        {
          name: "review",
          description: "review as persona",
          userInvocable: true,
          metadata: { agent: "reviewer" },
        },
        { name: "explain", description: "explain code", userInvocable: true, metadata: {} },
        { name: "internal", description: "not for humans", userInvocable: false, metadata: {} },
      ]),
    });
    expect(await svc.list()).toEqual([
      {
        name: "review",
        description: "review as persona",
        agent: "reviewer",
        arguments: [{ name: "task", required: false }],
      },
      {
        name: "explain",
        description: "explain code",
        arguments: [{ name: "task", required: false }],
      },
    ]);
  });

  it("omits the agent for a skill whose field is blank or not a string", async () => {
    const svc = createSkillsService({
      skills: provider([
        { name: "blank", description: "blank", userInvocable: true, metadata: { agent: "   " } },
        { name: "wrong", description: "wrong", userInvocable: true, metadata: { agent: true } },
        {
          name: "nested",
          description: "nested",
          userInvocable: true,
          metadata: { metadata: { agent: "reviewer" } },
        },
      ]),
    });
    expect((await svc.list()).map((s) => s.agent)).toEqual([undefined, undefined, undefined]);
  });

  it("projects the trusted Plans mode with the scanned skill provenance", async () => {
    const seen: { name: string; source?: string }[] = [];
    const svc = createSkillsService({
      skills: provider([
        {
          name: "speckit-plan",
          description: "plan",
          userInvocable: true,
          metadata: {},
          scope: "workspace",
          source: "plugin:speckit-clarvis",
        },
      ]),
      skillPlansMode: (skill) => {
        seen.push(skill);
        return "off";
      },
    });
    expect(await svc.list()).toMatchObject([
      {
        name: "speckit-plan",
        plansMode: "off",
        provenance: { scope: "workspace", source: "plugin:speckit-clarvis" },
      },
    ]);
    expect(seen).toEqual([{ name: "speckit-plan", source: "plugin:speckit-clarvis" }]);
  });

  it("renders a skill prompt message with the task as the target", async () => {
    const svc = createSkillsService({
      skills: provider([
        {
          name: "explain",
          description: "explain code",
          userInvocable: true,
          metadata: {},
          body: "STEP 1: read it",
        },
      ]),
    });
    const [msg] = await svc.getPrompt("explain", { task: "the auth module" });
    expect(msg!.role).toBe("user");
    const text = msg!.content as string;
    expect(text).toContain('The user invoked the "explain" skill.');
    expect(text).toContain("STEP 1: read it");
    expect(text).toContain("the auth module");
  });

  it("falls back to the no-target sentence when neither a task nor a placeholder is given", async () => {
    const svc = createSkillsService({
      skills: provider([
        { name: "explain", description: "d", userInvocable: true, metadata: {}, body: "do it" },
      ]),
    });
    const [msg] = await svc.getPrompt("explain");
    const text = msg!.content as string;
    expect(text).toContain("Target:");
    expect(text).toContain("(no explicit target");
  });

  describe("argument placeholders", () => {
    const withBody = (body: string) =>
      createSkillsService({
        skills: provider([
          { name: "spec", description: "write a spec", userInvocable: true, metadata: {}, body },
        ]),
      });

    const render = async (body: string, task?: string): Promise<string> => {
      const [msg] = await withBody(body).getPrompt("spec", task === undefined ? {} : { task });
      return msg!.content as string;
    };

    it("substitutes $ARGUMENTS in place and appends no Target block", async () => {
      const text = await render("Build a spec for $ARGUMENTS now.", "add SSO");
      expect(text).toContain("Build a spec for add SSO now.");
      expect(text).not.toContain("Target:");
      expect(text).not.toContain("$ARGUMENTS");
    });

    it("substitutes {{args}} identically", async () => {
      const text = await render("Build a spec for {{args}} now.", "add SSO");
      expect(text).toContain("Build a spec for add SSO now.");
      expect(text).not.toContain("Target:");
      expect(text).not.toContain("{{args}}");
    });

    it("replaces every occurrence, not only the first", async () => {
      const text = await render("$ARGUMENTS / $ARGUMENTS / $ARGUMENTS", "x");
      expect(text).toContain("x / x / x");
      expect(text).not.toContain("$ARGUMENTS");
    });

    it("inserts a task containing $-substitution patterns verbatim", async () => {
      const body = "Write a spec for $ARGUMENTS now.";
      expect(await render(body, "add $$ handling")).toContain(
        "Write a spec for add $$ handling now.",
      );
      expect(await render(body, "explain $& in sed")).toContain(
        "Write a spec for explain $& in sed now.",
      );
      expect(await render(body, "fix $` quoting")).toContain(
        "Write a spec for fix $` quoting now.",
      );
      expect(await render(body, "the $' form")).toContain("Write a spec for the $' form now.");
    });

    it("does not re-substitute a placeholder that the task itself contains", async () => {
      const text = await render("$ARGUMENTS and again {{args}}.", "literally {{args}} here");
      expect(text).toContain("literally {{args}} here and again literally {{args}} here.");
    });

    it("renders an absent task as the empty string rather than the fallback sentence", async () => {
      const text = await render("Consider [$ARGUMENTS] if not empty.");
      expect(text).toContain("Consider [] if not empty.");
      expect(text).not.toContain("Target:");
      expect(text).not.toContain("(no explicit target");
    });

    it("still appends Target when the body carries no placeholder", async () => {
      const text = await render("Just do the thing.", "the auth module");
      expect(text).toContain("Target:");
      expect(text).toContain("the auth module");
    });
  });

  it("describes the task argument with the skill's argument-hint", async () => {
    const svc = createSkillsService({
      skills: provider([
        {
          name: "spec",
          description: "d",
          userInvocable: true,
          metadata: { "argument-hint": "Describe the feature you want to specify" },
        },
        { name: "plain", description: "d", userInvocable: true, metadata: {} },
        {
          name: "blank",
          description: "d",
          userInvocable: true,
          metadata: { "argument-hint": "  " },
        },
        { name: "wrong", description: "d", userInvocable: true, metadata: { "argument-hint": 7 } },
      ]),
    });
    const byName = new Map((await svc.list()).map((s) => [s.name, s]));
    expect(byName.get("spec")!.arguments).toEqual([
      { name: "task", required: false, description: "Describe the feature you want to specify" },
    ]);
    expect(byName.get("plain")!.arguments).toEqual([{ name: "task", required: false }]);
    expect(byName.get("blank")!.arguments).toEqual([{ name: "task", required: false }]);
    expect(byName.get("wrong")!.arguments).toEqual([{ name: "task", required: false }]);
  });

  it("attributes a skill to its scope, root source and frontmatter author", async () => {
    const svc = createSkillsService({
      skills: provider([
        {
          name: "speckit-specify",
          description: "d",
          userInvocable: true,
          scope: "workspace",
          source: "agents",
          metadata: { metadata: { author: "github-spec-kit", source: "templates/spec.md" } },
        },
        {
          name: "mine",
          description: "d",
          userInvocable: true,
          scope: "user",
          source: "clarvis",
          metadata: {},
        },
      ]),
    });
    const byName = new Map((await svc.list()).map((s) => [s.name, s]));
    expect(byName.get("speckit-specify")!.provenance).toEqual({
      scope: "workspace",
      source: "agents",
      author: "github-spec-kit",
    });
    expect(byName.get("mine")!.provenance).toEqual({ scope: "user", source: "clarvis" });
    expect(byName.get("mine")!.provenance).not.toHaveProperty("author");
  });

  it("projects a skill's presentation metadata onto the summary", async () => {
    const svc = createSkillsService({
      skills: provider([
        {
          name: "notes",
          description: "d",
          userInvocable: true,
          metadata: {},
          presentation: {
            displayName: "Release Notes",
            shortDescription: "Notes from a commit range.",
            icons: { light: "assets/light.svg", dark: "assets/dark.svg" },
            color: "#3b82f6",
            starterPrompt: "Draft the notes.",
          },
        },
      ]),
    });
    expect((await svc.list())[0]!.presentation).toEqual({
      displayName: "Release Notes",
      shortDescription: "Notes from a commit range.",
      icons: { light: "assets/light.svg", dark: "assets/dark.svg" },
      color: "#3b82f6",
      starterPrompt: "Draft the notes.",
    });
  });

  it("refuses an icon path a provider supplied that would leave the skill directory", async () => {
    const svc = createSkillsService({
      skills: provider(
        ["/etc/shadow", "../../secrets.png", "a/../../b.svg", "C:/win.ico", "..\\up.svg"].map(
          (light, index) => ({
            name: `escaper-${String(index)}`,
            description: "d",
            userInvocable: true,
            metadata: {},
            presentation: { icons: { light, dark: "assets/ok.svg" } },
          }),
        ),
      ),
    });

    for (const summary of await svc.list()) {
      expect(summary.presentation?.icons?.light).toBeUndefined();
      expect(summary.presentation?.icons?.dark).toBe("assets/ok.svg");
    }
  });

  it("drops presentation fields a provider supplied in an unusable shape", async () => {
    const svc = createSkillsService({
      skills: provider([
        {
          name: "partial",
          description: "d",
          userInvocable: true,
          metadata: {},
          presentation: {
            displayName: 7,
            shortDescription: "   ",
            icons: ["a"],
            color: "#abc",
          },
        },
        { name: "listy", description: "d", userInvocable: true, metadata: {}, presentation: [] },
        { name: "none", description: "d", userInvocable: true, metadata: {} },
        {
          name: "empty",
          description: "d",
          userInvocable: true,
          metadata: {},
          presentation: { icons: { light: 1 } },
        },
      ]),
    });
    const byName = new Map((await svc.list()).map((s) => [s.name, s]));
    expect(byName.get("partial")!.presentation).toEqual({ color: "#abc" });
    expect(byName.get("listy")!).not.toHaveProperty("presentation");
    expect(byName.get("none")!).not.toHaveProperty("presentation");
    expect(byName.get("empty")!).not.toHaveProperty("presentation");
  });

  it("lists a skill that is withheld from the model's catalog", async () => {
    // The two axes are independent: catalog suppression hides an entry from the
    // listing injected into a run, never from the user's own slash listing.
    const svc = createSkillsService({
      skills: provider([
        {
          name: "quiet",
          description: "d",
          userInvocable: true,
          catalogSuppressed: true,
          metadata: {},
        },
      ]),
    });
    expect((await svc.list()).map((s) => s.name)).toEqual(["quiet"]);
  });

  it("rejects getPrompt for an unknown or non-invocable skill", async () => {
    const svc = createSkillsService({
      skills: provider([
        { name: "internal", description: "x", userInvocable: false, metadata: {} },
      ]),
    });
    await expect(svc.getPrompt("nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(svc.getPrompt("internal")).rejects.toMatchObject({ code: "not_found" });
  });
});
