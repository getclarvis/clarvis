import { expect, test } from "bun:test";
import { saveWarningsNote } from "../../src/features/issues.ts";

test("save warning summaries distinguish one warning from several", () => {
  const warning = { field: "model", level: "warn" as const, message: "model is inherited" };
  expect(saveWarningsNote([warning])).toContain("1 warning: model is inherited");
  expect(saveWarningsNote([warning, { ...warning, field: "grants" }])).toContain("2 warnings:");
});
