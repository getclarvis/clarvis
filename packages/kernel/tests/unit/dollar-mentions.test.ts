import { describe, expect, it } from "bun:test";
import type { SkillsProvider } from "@clarvis/loop";
import {
  dollarSkillSeeds,
  extractDollarSkillMentions,
  userMessagesText,
} from "../../src/skills/dollar-mentions.ts";

describe("extractDollarSkillMentions", () => {
  it("collects unique $names in appearance order and ignores env tokens", () => {
    expect(extractDollarSkillMentions("$alpha fix the dialog")).toEqual(["alpha"]);
    expect(extractDollarSkillMentions("use $beta then $alpha and $beta again")).toEqual([
      "beta",
      "alpha",
    ]);
    expect(extractDollarSkillMentions("$PATH $HOME $clarvis-configure")).toEqual([
      "clarvis-configure",
    ]);
    expect(extractDollarSkillMentions("echo $USER in $TMPDIR")).toEqual([]);
  });

  it("requires a $ prefix, a letter start, and an identifier boundary", () => {
    expect(extractDollarSkillMentions("alpha without a dollar")).toEqual([]);
    expect(extractDollarSkillMentions("cost is $1 and $2")).toEqual([]);
    expect(extractDollarSkillMentions("foo$alpha stays literal")).toEqual([]);
    expect(extractDollarSkillMentions("($opentui) and $skill_name-v2.")).toEqual([
      "opentui",
      "skill_name-v2",
    ]);
  });
});

describe("userMessagesText", () => {
  it("joins user text parts and ignores assistant and image-only content", () => {
    expect(
      userMessagesText([
        { role: "assistant", content: "$alpha should not expand" },
        { role: "user", content: [{ type: "image", data: "AA==" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "$beta " },
            { type: "image", data: "x" },
          ],
        },
        { role: "user", content: "then $gamma" },
      ]),
    ).toBe("$beta \nthen $gamma");
  });
});

describe("dollarSkillSeeds", () => {
  type FakeSkill = {
    name: string;
    description: string;
    body: string;
    userInvocable: boolean;
    metadata: unknown;
  };

  function provider(skills: FakeSkill[]): SkillsProvider {
    return {
      listSkills: () => skills as never,
      loadSkill: (name) => (skills.find((skill) => skill.name === name) as never) ?? undefined,
      readResource: (name, rel) => `${name}/${rel}`,
    };
  }

  const alpha: FakeSkill = {
    name: "alpha",
    description: "the alpha skill",
    body: "ALPHA BODY",
    userInvocable: true,
    metadata: {},
  };

  it("renders a user-invocable skill without an agent and skips the rest", () => {
    const seeds = dollarSkillSeeds(
      "$alpha $missing $PATH $clarvis-configure $hidden",
      provider([
        alpha,
        {
          name: "clarvis-configure",
          description: "configure",
          body: "CONFIG BODY",
          userInvocable: true,
          metadata: { agent: "clarvis-configure" },
        },
        {
          name: "hidden",
          description: "internal",
          body: "HIDDEN",
          userInvocable: false,
          metadata: {},
        },
      ]),
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toContain("--- SKILL ---");
    expect(seeds[0]).toContain("ALPHA BODY");
    expect(seeds[0]).toContain('The user invoked the "alpha" skill.');
  });

  it("does not duplicate a skill already seeded by the start param", () => {
    expect(dollarSkillSeeds("$alpha fix the dialog", provider([alpha]), "alpha")).toEqual([]);
  });

  it("returns nothing without a skills source", () => {
    expect(dollarSkillSeeds("$alpha", undefined)).toEqual([]);
  });
});
