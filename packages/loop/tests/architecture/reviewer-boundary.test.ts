import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("the engine has no reviewer configuration or product import", () => {
  const root = resolve(import.meta.dir, "../..");
  for (const file of new Bun.Glob("src/**/*.ts").scanSync(root)) {
    const source = readFileSync(resolve(root, file), "utf8");
    expect(source).not.toMatch(
      /\b(?:guard_judge|effect_review|GuardJudgeConfig|EffectReviewConfig|JudgeCapability)\b|@clarvis\/judge/,
    );
  }
  for (const file of ["api.ts", "operator-authority.ts", "index.ts"]) {
    const source = readFileSync(resolve(root, "../capability/src", file), "utf8");
    expect(source).not.toMatch(/\b(?:guard_judge|GuardJudgeConfig|EffectReviewConfig)\b/);
  }
});
